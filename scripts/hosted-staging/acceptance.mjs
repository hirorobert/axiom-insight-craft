#!/usr/bin/env node
/**
 * Hosted-staging acceptance for the financial-statements persistence layer.
 *
 * WHAT THIS PROVES THAT THE DISPOSABLE-DATABASE PROOF CANNOT: that a real GoTrue mints
 * real JWTs, that a real PostgREST exposes exactly the intended functions and tables to
 * the `anon` and `authenticated` roles, and that Row Level Security holds through that
 * stack. The disposable proof (scripts/db-proof) simulates auth.uid(); it is NOT GoTrue.
 *
 * WRITE-CAPABLE. It creates users and a company in the project it targets, so it is
 * fail-closed exactly like scripts/rls_regression.mjs: the target must be the EXPLICITLY
 * configured staging project (scripts/ci/stagingGuard.mjs) and never production; it reads
 * only STAGING_* variables; it never prints a URL, key, password or token.
 *
 * HONEST RESULT. Exactly one HOSTED_STAGING_RESULT line is printed:
 *   BLOCKED_MISSING_STAGING_PROJECT   no staging project is configured — nothing ran (exit 2)
 *   REFUSED_<CODE>                    the guard refused the target (exit 1)
 *   FAILED                            at least one automated check failed (exit 1)
 *   AUTOMATED_PASS_MANUAL_REALTIME_PENDING
 *                                     every automated check passed; the realtime publication
 *                                     check needs SQL a human runs (docs/release/sql/06) (exit 0)
 * There is no bare PASS: a skipped or manual check is never counted as passed.
 *
 * CLEANUP. The history tables are append-only with ON DELETE RESTRICT, so the rows the
 * write round-trip creates cannot be deleted, by design. Cleanup therefore deactivates the
 * company's rollout and removes the auth users where the platform allows it, and reports
 * what remains. Use a staging project that is disposable as a whole.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { StagingGuardError, assertStagingTargetFromEnv } from '../ci/stagingGuard.mjs'

export const INTERNAL_FUNCTIONS = [
  ['fs_actor_member_id', { p_company_id: '00000000-0000-0000-0000-000000000000' }],
  ['fs_publication_blockers', { p_company_id: '00000000-0000-0000-0000-000000000000', p_report_id: 'x', p_version: 1 }],
  ['fs_audit_event', { p_company_id: '00000000-0000-0000-0000-000000000000', p_report_id: 'x', p_action: 'X', p_detail: {}, p_actor: '00000000-0000-0000-0000-000000000000' }],
  ['fs_set_company_rollout', { p_company_id: '00000000-0000-0000-0000-000000000000', p_enabled: true, p_reason: 'should be refused', p_operator_label: 'x' }],
  ['fs_set_kill_switch', { p_engaged: true, p_reason: 'should be refused', p_operator_label: 'x' }],
  ['fs_ingest_evidence_internal', { p_actor: '00000000-0000-0000-0000-000000000000', p_evidence_batch_id: 'x', p_company_id: '00000000-0000-0000-0000-000000000000', p_reporting_period_id: 'FY2025', p_evidence_type: 'BUDGET', p_period_role: 'CURRENT', p_series_key: 'x', p_schema_version: '1', p_source_file_name: null, p_content_hash: '0'.repeat(64), p_currency: 'TZS', p_scale: 2, p_batch_document: {}, p_validation_status: 'VALID', p_diagnostics: [], p_expected_previous_batch_id: null }],
]
const HISTORY_TABLES = [
  'financial_evidence_batches',
  'financial_statement_reports',
  'financial_statement_evaluations',
  'financial_statement_reviewer_decisions',
  'financial_statement_correction_groups',
  'financial_statement_publications',
  'financial_statement_audit_events',
  'financial_statements_rollout_companies',
  'financial_statements_rollout_state',
  'financial_statements_rollout_audit',
  'financial_statement_framework_requirements',
]

export const BLOCKED_CODES = new Set(['URL_MISSING', 'EXPECTED_REF_MISSING'])

const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
export function jwtClaims(token) {
  const parts = typeof token === 'string' ? token.split('.') : []
  if (parts.length !== 3) return null
  try { return JSON.parse(b64(parts[1])) } catch { return null }
}

/** Runs every check. `fetchImpl` is injected so the logic is testable without a network. */
export async function runAcceptance({ env, fetchImpl = fetch, log = () => {} }) {
  const url = env.STAGING_SUPABASE_URL.replace(/\/+$/, '')
  const anonKey = env.STAGING_SUPABASE_ANON_KEY
  const serviceKey = env.STAGING_SUPABASE_SERVICE_ROLE_KEY
  const run = `fsacc${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
  const results = []
  const record = (id, ok, detail = '') => { results.push({ id, status: ok ? 'PASS' : 'FAIL', detail }); log(`${ok ? '  ✓' : '  ✗'}  ${id}${detail ? ` — ${detail}` : ''}`) }
  const cleanup = { users: [], companyId: null, rolloutEnabled: false }

  const call = async (method, path, { key = anonKey, bearer = key, body, headers = {} } = {}) => {
    const res = await fetchImpl(`${url}${path}`, { method, headers: { apikey: key, authorization: `Bearer ${bearer}`, 'content-type': 'application/json', prefer: 'return=representation', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    let json = null
    try { json = await res.json() } catch { /* empty or non-JSON body */ }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json }
  }
  const rpcAs = (fn, args, token) => call('POST', `/rest/v1/rpc/${fn}`, { bearer: token, body: args })
  const rpcAnon = (fn, args) => call('POST', `/rest/v1/rpc/${fn}`, { body: args })
  const rpcService = (fn, args) => call('POST', `/rest/v1/rpc/${fn}`, { key: serviceKey, body: args })

  try {
    // 1 — GoTrue admin: create confirmed users (no e-mail is sent).
    const users = {}
    let created = true
    for (const role of ['partner', 'outsider']) {
      const email = `${run}-${role}@example.com`
      const password = randomBytes(18).toString('base64url')
      const r = await call('POST', '/auth/v1/admin/users', { key: serviceKey, body: { email, password, email_confirm: true } })
      if (!r.ok || !r.json?.id) { created = false; break }
      users[role] = { id: r.json.id, email, password }
      cleanup.users.push(r.json.id)
    }
    record('GOTRUE_ADMIN_CREATE_USERS', created, created ? 'two confirmed users created' : 'user creation failed')
    if (!created) return finish()

    // 2 — password sign-in mints a real session.
    for (const role of Object.keys(users)) {
      const r = await call('POST', '/auth/v1/token?grant_type=password', { body: { email: users[role].email, password: users[role].password } })
      users[role].token = r.json?.access_token ?? null
    }
    record('GOTRUE_PASSWORD_SIGN_IN', !!users.partner.token && !!users.outsider.token, 'access tokens issued')
    if (!users.partner.token || !users.outsider.token) return finish()

    // 3 — the tokens carry the claims PostgREST authorises on.
    const c = jwtClaims(users.partner.token)
    const now = Math.floor(Date.now() / 1000)
    const claimsOk = !!c && c.role === 'authenticated' && c.aud === 'authenticated' && c.sub === users.partner.id && typeof c.exp === 'number' && c.exp > now && typeof c.iss === 'string' && c.iss.startsWith(url)
    record('JWT_ROLE_CLAIMS', claimsOk, claimsOk ? 'role/aud/sub/exp/iss as expected' : 'claims do not match the issued session')
    const anonClaims = jwtClaims(anonKey)
    const svcClaims = jwtClaims(serviceKey)
    record('JWT_KEY_ROLES', (anonClaims === null || anonClaims.role === 'anon') && (svcClaims === null || svcClaims.role === 'service_role'), 'the anon and service keys carry their own roles (opaque keys are not decoded)')

    // 4 — the intended surface is exposed to `authenticated`, and the outsider is denied.
    const out = await rpcAs('financial_statements_workspace_access', { p_company_id: '00000000-0000-0000-0000-000000000000' }, users.outsider.token)
    record('POSTGREST_ACCESS_RPC_FOR_AUTHENTICATED', out.ok && out.json?.enabled === false, `an unknown-company caller is answered {enabled:false} (${out.status})`)

    // 5 — internal and operator functions are not callable by an authenticated user.
    const leaked = []
    for (const [fn, args] of INTERNAL_FUNCTIONS) {
      const r = await rpcAs(fn, args, users.partner.token)
      if (r.ok) leaked.push(fn)
    }
    record('POSTGREST_INTERNALS_NOT_EXPOSED', leaked.length === 0, leaked.length === 0 ? `${INTERNAL_FUNCTIONS.length} internal/operator functions refused for authenticated` : `EXPOSED: ${leaked.join(', ')}`)

    // 6 — anon can call none of the persistence surface.
    const anonOpen = []
    for (const [fn, args] of [['fs_save_report_version', {}], ['fs_list_saved_versions', { p_company_id: '00000000-0000-0000-0000-000000000000', p_period_year: 2025 }], ['financial_statements_workspace_access', { p_company_id: '00000000-0000-0000-0000-000000000000' }]]) {
      const r = await rpcAnon(fn, args)
      if (r.ok) anonOpen.push(fn)
    }
    record('POSTGREST_ANON_DENIED', anonOpen.length === 0, anonOpen.length === 0 ? 'anon is refused on the persistence RPCs' : `OPEN TO ANON: ${anonOpen.join(', ')}`)

    // 7 — history tables cannot be written or altered through the REST table endpoints.
    const writable = []
    for (const t of HISTORY_TABLES) {
      const ins = await call('POST', `/rest/v1/${t}`, { bearer: users.partner.token, body: {} })
      const upd = await call('PATCH', `/rest/v1/${t}?company_id=neq.00000000-0000-0000-0000-000000000000`, { bearer: users.partner.token, body: { created_at: '1970-01-01T00:00:00Z' } })
      const del = await call('DELETE', `/rest/v1/${t}?company_id=neq.00000000-0000-0000-0000-000000000000`, { bearer: users.partner.token })
      const touched = (r) => r.ok && Array.isArray(r.json) && r.json.length > 0
      if (ins.ok || touched(upd) || touched(del)) writable.push(t)
    }
    record('POSTGREST_HISTORY_TABLES_NOT_WRITABLE', writable.length === 0, writable.length === 0 ? `${HISTORY_TABLES.length} tables refuse insert/update/delete for authenticated` : `WRITABLE: ${writable.join(', ')}`)

    // 8 — a company exists for the partner; the feature is default-denied for it.
    const co = await call('POST', '/rest/v1/companies', { bearer: users.partner.token, body: { name: `${run} acceptance`, user_id: users.partner.id, fiscal_year_end: '12-31', currency: 'TZS' } })
    const companyId = Array.isArray(co.json) ? co.json[0]?.id : co.json?.id
    if (!co.ok || !companyId) { record('COMPANY_CREATED_BY_PARTNER', false, `company creation failed (${co.status})`); return finish() }
    cleanup.companyId = companyId
    record('COMPANY_CREATED_BY_PARTNER', true, 'a throwaway company was created')
    const denied = await rpcAs('financial_statements_workspace_access', { p_company_id: companyId }, users.partner.token)
    record('FEATURE_DEFAULT_DENIED', denied.ok && denied.json?.enabled === false && denied.json?.reason === 'NOT_ALLOWLISTED', 'a member of a company that is not allowlisted is told NOT_ALLOWLISTED')
    // Evidence is accepted ONLY inside an atomic revision (evidence + report version + evaluation + audit event).
    const revisionArgs = (id) => {
      const reportId = `${run}-${randomUUID()}`
      const contentHash = randomBytes(32).toString('hex')
      return {
        p_company_id: companyId, p_report_id: reportId, p_expected_report_version: 0, p_idempotency_key: `${run}-${randomUUID()}`, p_period_year: 2025, p_provenance_origin: 'TRIAL_BALANCE_DERIVED',
        p_report_document: { reportIdentity: { reportId, companyId, reportVersion: 1 }, acceptance: run }, p_content_hash: contentHash,
        p_evidence: [{ evidenceBatchId: id, reportingPeriodId: 'FY2025', evidenceType: 'TRANSACTION_LEDGER', periodRole: 'CURRENT', seriesKey: 'acceptance', schemaVersion: '1', sourceFileName: 'ledger.csv', contentHash, currency: 'TZS', scale: 2, batchDocument: { rows: [{ amount: '1.00', memo: 'acceptance' }] }, validationStatus: 'VALID', diagnostics: [], expectedPreviousBatchId: null }],
        p_evidence_batch_ids: [id], p_evaluation: { evaluationRunId: `${run}-${randomUUID()}`, rulePackId: 'acceptance', rulePackVersion: '1', engineVersion: '1', inputHash: contentHash, findings: [] },
      }
    }
    const legacy = await rpcAs('fs_ingest_evidence_batch', { p_company_id: companyId }, users.partner.token)
    record('NO_STANDALONE_EVIDENCE_WRITE', !legacy.ok, `the standalone evidence writer does not exist for clients (${legacy.status})`)
    const blocked = await rpcAs('fs_commit_revision', revisionArgs(`eb-${randomUUID()}`), users.partner.token)
    record('WRITE_REFUSED_WHILE_DISABLED', !blocked.ok && /FEATURE_DISABLED|PT403/.test(JSON.stringify(blocked.json ?? {})), `a write is refused while the company is not allowlisted (${blocked.status})`)

    // 9 — operator enables the company (service role only); the same write now succeeds, and only for the member.
    const enable = await rpcService('fs_set_company_rollout', { p_company_id: companyId, p_enabled: true, p_reason: `hosted staging acceptance ${run}`, p_operator_label: 'staging-acceptance' })
    cleanup.rolloutEnabled = enable.ok
    record('SERVICE_ROLE_ENABLES_COMPANY', enable.ok, 'the operator function works for service_role')
    const enabled = await rpcAs('financial_statements_workspace_access', { p_company_id: companyId }, users.partner.token)
    record('FEATURE_ENABLED_AFTER_OPERATOR_ACTION', enabled.ok && enabled.json?.enabled === true, 'access now reports enabled')
    const batchId = `eb-${randomUUID()}`
    const wrote = await rpcAs('fs_commit_revision', revisionArgs(batchId), users.partner.token)
    record('AUTHENTICATED_WRITE_ROUNDTRIP', wrote.ok, `the member stored an evidence version inside an atomic revision (${wrote.status})`)
    const outsiderWrite = await rpcAs('fs_commit_revision', revisionArgs(`eb-${randomUUID()}`), users.outsider.token)
    record('OUTSIDER_WRITE_REFUSED', !outsiderWrite.ok, `a non-member cannot write to the company (${outsiderWrite.status})`)

    // 10 — RLS through PostgREST: the member reads it back, the outsider sees nothing.
    const mine = await call('GET', `/rest/v1/financial_evidence_batches?evidence_batch_id=eq.${batchId}`, { bearer: users.partner.token })
    const theirs = await call('GET', `/rest/v1/financial_evidence_batches?evidence_batch_id=eq.${batchId}`, { bearer: users.outsider.token })
    record('RLS_MEMBER_READS_OWN_ROWS', mine.ok && Array.isArray(mine.json) && mine.json.length === 1, 'the member reads the stored evidence back through PostgREST')
    record('RLS_OUTSIDER_SEES_NOTHING', !theirs.ok || (Array.isArray(theirs.json) && theirs.json.length === 0), 'the outsider reads zero rows')
    const listOutsider = await rpcAs('fs_list_saved_versions', { p_company_id: companyId, p_period_year: 2025 }, users.outsider.token)
    record('RLS_OUTSIDER_CANNOT_LIST_VERSIONS', !listOutsider.ok, `saved-version listing is refused to a non-member (${listOutsider.status})`)

    // 11 — realtime: cannot be observed through PostgREST. It is a manual SQL check and is NEVER counted as passed.
    results.push({ id: 'REALTIME_PUBLICATION_EXCLUDES_HISTORY_TABLES', status: 'MANUAL_PENDING', detail: 'run docs/release/sql/06_staging_realtime_check.sql and attach the output' })
    log('  •  REALTIME_PUBLICATION_EXCLUDES_HISTORY_TABLES — MANUAL_PENDING (run docs/release/sql/06_staging_realtime_check.sql)')
  } catch (e) {
    record('ACCEPTANCE_RUN_COMPLETED', false, e instanceof Error ? e.message.replace(/eyJ[\w-]{10,}/g, '[token]') : 'unexpected error')
  }
  return finish()

  async function finish() {
    // Cleanup: deactivate the rollout, remove auth users where allowed. Append-only history rows remain by design.
    const notes = []
    if (cleanup.companyId && cleanup.rolloutEnabled) {
      const off = await rpcService('fs_set_company_rollout', { p_company_id: cleanup.companyId, p_enabled: false, p_reason: `hosted staging acceptance ${run} cleanup`, p_operator_label: 'staging-acceptance' })
      notes.push(off.ok ? 'rollout deactivated' : 'ROLLOUT NOT DEACTIVATED')
    }
    for (const id of cleanup.users) {
      const r = await call('DELETE', `/auth/v1/admin/users/${id}`, { key: serviceKey })
      notes.push(r.ok ? 'user removed' : 'user retained (referenced by immutable history)')
    }
    const failed = results.some((r) => r.status === 'FAIL')
    const manual = results.some((r) => r.status === 'MANUAL_PENDING')
    const overall = failed ? 'FAILED' : manual ? 'AUTOMATED_PASS_MANUAL_REALTIME_PENDING' : 'FAILED'
    return { overall, results, cleanup: notes, run }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let ref = null
  try {
    assertStagingTargetFromEnv()
    ref = true
  } catch (err) {
    const code = err instanceof StagingGuardError ? err.code : 'GUARD_ERROR'
    if (BLOCKED_CODES.has(code)) {
      console.log('HOSTED_STAGING_RESULT=BLOCKED_MISSING_STAGING_PROJECT')
      console.log('No staging Supabase project is configured, so no hosted check ran. Local disposable-database proof is separate and does not count as hosted acceptance.')
      process.exit(2)
    }
    console.error(`Hosted acceptance refused to run [${code}]`)
    console.log(`HOSTED_STAGING_RESULT=REFUSED_${code}`)
    process.exit(1)
  }
  void ref
  const summary = await runAcceptance({ env: process.env, log: (l) => console.log(l) })
  console.log(`cleanup: ${summary.cleanup.join('; ') || 'nothing to clean'}; append-only history rows created by the round-trip remain by design`)
  console.log(`HOSTED_STAGING_RESULT=${summary.overall}`)
  process.exit(summary.overall === 'FAILED' ? 1 : 0)
}
