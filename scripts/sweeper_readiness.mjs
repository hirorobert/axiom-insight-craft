#!/usr/bin/env node
/**
 * Trial balance source sweeper — fail-closed readiness check (PR #32). Prints SWEEPER_READINESS: READY or
 * SWEEPER_READINESS: NOT READY with named reasons, and exits non-zero unless READY. See
 * scripts/ci/sweeperReadiness.mjs for exactly what READY requires.
 *
 * Staging (default; CI): reads only STAGING_* and runs after scripts/ci/stagingGuard.mjs verified the target is
 * the configured STAGING project, never production.
 *
 * Owner (production, run by the owner only, after the migrations are applied and the function deployed):
 *   SWEEPER_SUPABASE_URL=https://<ref>.supabase.co SWEEPER_SUPABASE_SERVICE_ROLE_KEY=<service key> \
 *     node scripts/sweeper_readiness.mjs --owner
 *
 * The health step runs ONE real sweep (exactly what the schedule runs every 5 minutes) with a database-minted,
 * single-use ticket, then replays that ticket to prove it is refused. Keys are never printed.
 */

import { createClient } from '@supabase/supabase-js'
import { StagingGuardError, assertStagingTargetFromEnv } from './ci/stagingGuard.mjs'
import { evaluateSweeperReadiness, expectedSweeperUrl } from './ci/sweeperReadiness.mjs'

const owner = process.argv.includes('--owner')
let url, key
if (owner) {
  url = process.env.SWEEPER_SUPABASE_URL
  key = process.env.SWEEPER_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) { console.error('SWEEPER_READINESS: NOT READY [ENV_MISSING]'); process.exit(1) }
} else {
  try { assertStagingTargetFromEnv() } catch (err) {
    console.error(`sweeper readiness refused to run [${err instanceof StagingGuardError ? err.code : 'GUARD_ERROR'}]`)
    process.exit(1)
  }
  url = process.env.STAGING_SUPABASE_URL
  key = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY
}

const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

async function post(target, body) {
  try {
    const res = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, outcome: json?.outcome }
  } catch {
    return { status: 0 }
  }
}

let status = null
let health = null
const { data: statusRows, error: statusErr } = await svc.rpc('tbu_source_sweeper_status')
if (!statusErr) status = (Array.isArray(statusRows) ? statusRows[0] : statusRows) ?? null

const target = expectedSweeperUrl(url)
if (target) {
  const { data: ticket, error: mintErr } = await svc.rpc('tbu_mint_source_sweeper_ticket')
  if (!mintErr && typeof ticket === 'string') {
    const first = await post(target, { ticket })
    const replay = first.status === 200 ? await post(target, { ticket }) : undefined
    health = { first, replay }
  }
}

const result = evaluateSweeperReadiness({ projectUrl: url, status, health })
console.log(`function_url_configured=${!!status?.function_url} pg_net=${status?.pg_net_installed === true} cron_active=${status?.cron_job_active === true} schedule=${status?.cron_schedule ?? 'none'} health=${health?.first?.status ?? 'not_run'}/${health?.first?.outcome ?? '-'} replay=${health?.replay?.status ?? '-'}`)
console.log(result.ready ? 'SWEEPER_READINESS: READY' : `SWEEPER_READINESS: NOT READY [${result.reasons.join(', ')}]`)
process.exit(result.ready ? 0 : 1)
