#!/usr/bin/env node
/**
 * Upload lifecycle — hosted staging proof (PR #32, 20260923100000).
 *
 * scripts/db-proof/uploadLifecycle.mjs proves the SQL on a throwaway local PostgreSQL. This suite
 * proves the same contract END TO END on the hosted staging project, through the paths a browser uses:
 * real Supabase Auth users and JWTs, PostgREST RPCs, RLS, and Storage (trial-balance-files).
 *
 * WRITE-CAPABLE: creates users, companies, uploads, certifications and Storage objects. It runs only
 * after scripts/ci/stagingGuard.mjs has verified the target is the configured STAGING project (never
 * production), and it reads only the STAGING_* variables. Passwords are random per run and are never
 * printed.
 *
 * Fixtures that cannot be removed by design (certified uploads — tb_certifications is append-only —
 * and the append-only lifecycle events) are left in place and reported at the end.
 *
 * ENV: STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY, STAGING_SUPABASE_SERVICE_ROLE_KEY,
 *      STAGING_SUPABASE_PROJECT_REF
 */

import { createClient } from '@supabase/supabase-js'
import { randomBytes, randomUUID } from 'node:crypto'
import { StagingGuardError, assertStagingTargetFromEnv } from './ci/stagingGuard.mjs'

try {
  assertStagingTargetFromEnv()
} catch (err) {
  const code = err instanceof StagingGuardError ? err.code : 'GUARD_ERROR'
  console.error(`upload lifecycle staging proof refused to run [${code}]`)
  process.exit(1)
}

const URL_ = process.env.STAGING_SUPABASE_URL
const ANON = process.env.STAGING_SUPABASE_ANON_KEY
const SERVICE = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY
const BUCKET = 'trial-balance-files'
const CONCURRENCY = 10
const TS = Date.now()
const PASSWORD = `${randomBytes(18).toString('base64url')}!9aZ`
const opts = { auth: { autoRefreshToken: false, persistSession: false } }
const svc = createClient(URL_, SERVICE, opts)
const anon = createClient(URL_, ANON, opts)

const results = []
let group = ''
const section = (n) => { group = n; console.log(`\n== ${n}`) }
function record(name, ok, detail = '') {
  results.push({ group, name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`)
}
async function check(name, fn) {
  try {
    const r = await fn()
    record(name, r === true, r === true ? '' : `assertion returned ${JSON.stringify(r)}`)
  } catch (e) {
    record(name, false, String(e?.message ?? e).split('\n')[0])
  }
}

const created = { users: [], companies: [], uploads: new Set(), objects: new Set() }

async function makeUser(label) {
  const email = `lifecycle-${label}-${TS}@test-saff.invalid`
  const { data, error } = await svc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true })
  if (error) throw new Error(`createUser(${label}): ${error.message}`)
  created.users.push(data.user.id)
  const client = createClient(URL_, ANON, opts)
  const { error: signErr } = await client.auth.signInWithPassword({ email, password: PASSWORD })
  if (signErr) throw new Error(`signIn(${label}): ${signErr.message}`)
  return { id: data.user.id, c: client }
}

const rpc = async (who, name, args) => {
  const { data, error } = await who.c.rpc(name, args)
  if (error) throw Object.assign(new Error(`${name}: ${error.message}`), { code: error.code })
  return Array.isArray(data) ? data[0] : data
}
const discard = (who, id, v) => rpc(who, 'discard_trial_balance_upload', { p_upload_id: id, p_expected_version: v })
const complete = (who, op, removed) => rpc(who, 'complete_trial_balance_discard', { p_operation_id: op, p_storage_removed: removed })
const restore = (who, op, restored) => rpc(who, 'restore_trial_balance_upload', { p_operation_id: op, p_storage_restored: restored })
const retire = (who, id, v, path) => rpc(who, 'retire_trial_balance_upload', {
  p_old_upload_id: id, p_expected_version: v, p_new_file_name: 'replacement.csv', p_new_file_path: path, p_new_file_size: 64, p_reason: 'staging proof',
})
const cancel = (who, id, v) => rpc(who, 'cancel_trial_balance_replacement', { p_replacement_upload_id: id, p_expected_version: v })
const confirmCleanup = (who, op, removed) => rpc(who, 'confirm_trial_balance_storage_cleanup', { p_operation_id: op, p_storage_removed: removed })

const row = async (id) => (await svc.from('trial_balance_uploads').select('*').eq('id', id).maybeSingle()).data
const version = async (id) => Number((await row(id))?.version)
const activeCount = async (company, period) => {
  const { count } = await svc.from('trial_balance_uploads').select('id', { count: 'exact', head: true })
    .eq('company_id', company).eq('period_year', period)
    .in('lifecycle_state', ['active_unprocessed', 'active_processing', 'active_processed', 'blocked'])
  return count
}
const certCount = async (upload) => (await svc.from('tb_certifications').select('id', { count: 'exact', head: true }).eq('upload_id', upload)).count
const objectExists = async (path) => {
  const dir = path.split('/').slice(0, -1).join('/')
  const name = path.split('/').pop()
  const { data } = await svc.storage.from(BUCKET).list(dir, { search: name })
  return (data ?? []).some((o) => o.name === name)
}

const csv = (tag) => new Blob([`account_code,account_name,debit,credit\n1000,Cash ${tag},100,0\n3000,Equity,0,100\n`], { type: 'text/csv' })
async function putObject(who, path) {
  const { error } = await who.c.storage.from(BUCKET).upload(path, csv(path), { upsert: false })
  if (error) throw new Error(`storage upload ${path}: ${error.message}`)
  created.objects.add(path)
}
// The browser path (TrialBalanceUpload.tsx): Storage object first, then an authenticated insert through RLS.
async function clientUpload(who, company, period) {
  const path = `${who.id}/${TS}-${randomUUID()}.csv`
  await putObject(who, path)
  const { data, error } = await who.c.from('trial_balance_uploads').insert({
    file_name: 'tb.csv', file_path: path, file_size: 64, status: 'processing', user_id: who.id, company_id: company, period_year: period,
  }).select('id').single()
  if (error) throw Object.assign(new Error(`insert upload: ${error.message}`), { code: error.code })
  created.uploads.add(data.id)
  return { id: data.id, path }
}
// The engine path (process-trial-balance via the service role): observed hash, then commit_tb_certification.
async function certify(company, upload, period, member, { blocking = false, review = false } = {}) {
  const { error: hashErr } = await svc.from('trial_balance_uploads').update({ source_file_hash: 'staging-proof-hash' }).eq('id', upload).is('source_file_hash', null)
  if (hashErr) throw new Error(`hash: ${hashErr.message}`)
  const { data: run, error: runErr } = await svc.from('engine_runs').insert({
    company_id: company, actor_type: 'user', firm_member_id: member, function_name: 'process-trial-balance', engine_version: 'staging-proof', status: 'running', period_year: period,
  }).select('id').single()
  if (runErr) throw new Error(`engine_run: ${runErr.message}`)
  const { error } = await svc.rpc('commit_tb_certification', {
    p_engine_run_id: run.id, p_expected_function_name: 'process-trial-balance', p_upload_id: upload, p_company_id: company, p_period_year: period,
    p_source_file_hash: 'staging-proof-hash', p_normalized_input_hash: 'n', p_output_hash: 'o', p_is_blocking: blocking, p_requires_review: review,
    p_exceptions: [], p_rows_snapshot: [],
  })
  if (error) throw new Error(`commit_tb_certification: ${error.message}`)
}

async function main() {
  section('Fixtures (real Auth users, companies, memberships)')
  const U = {}
  for (const k of ['owner', 'partner', 'preparer', 'viewer', 'pending', 'outsider']) U[k] = await makeUser(k)
  const { data: coA, error: coErr } = await svc.from('companies').insert({ user_id: U.owner.id, name: `Lifecycle Proof A ${TS}` }).select('id').single()
  if (coErr) throw new Error(`company A: ${coErr.message}`)
  const { data: coB } = await svc.from('companies').insert({ user_id: U.outsider.id, name: `Lifecycle Proof B ${TS}` }).select('id').single()
  const A = coA.id
  created.companies.push(A, coB.id)
  const members = {}
  for (const [k, role, accepted] of [['partner', 'partner', true], ['preparer', 'preparer', true], ['viewer', 'viewer', true], ['pending', 'partner', false]]) {
    const { data, error } = await svc.from('firm_members').insert({ company_id: A, user_id: U[k].id, role, accepted_at: accepted ? new Date().toISOString() : null }).select('id').single()
    if (error) throw new Error(`member ${k}: ${error.message}`)
    members[k] = data.id
  }
  members.owner = (await svc.from('firm_members').select('id').eq('company_id', A).eq('role', 'owner').single()).data.id
  record('6 users signed in; company A with owner/partner/preparer/viewer/pending; company B for the outsider', true)
  const manager = await svc.from('firm_members').insert({ company_id: A, user_id: U.outsider.id, role: 'manager', accepted_at: new Date().toISOString() })
  record("a 'manager' member cannot be created: firm_members' CHECK has no manager role, so the capability's manager branch is unreachable on this schema", !!manager.error)

  section('Lifecycle columns are server-authoritative (real PostgREST)')
  const u1 = await clientUpload(U.owner, A, 2031)
  await check('a browser upload starts active_unprocessed at version 1', async () => { const r = await row(u1.id); return r.lifecycle_state === 'active_unprocessed' && Number(r.version) === 1 })
  await check('the owner cannot set lifecycle_state directly (42501)', async () => {
    const { error } = await U.owner.c.from('trial_balance_uploads').update({ lifecycle_state: 'retired' }).eq('id', u1.id)
    return error?.code === '42501'
  })
  await check('a direct client DELETE removes nothing (no DELETE policy)', async () => {
    await U.owner.c.from('trial_balance_uploads').delete().eq('id', u1.id)
    return !!(await row(u1.id))
  })
  await check('a second active upload for the same period is refused (23505 uq_one_active_upload_per_period)', async () => {
    try { await clientUpload(U.owner, A, 2031); return 'no error' } catch (e) { return e.code === '23505' }
  })

  section('Capability: owner / partner allowed; preparer, viewer, pending, cross-company, anonymous refused')
  const v1 = await version(u1.id)
  await check('anonymous cannot call the RPC (no EXECUTE)', async () => {
    const { error } = await anon.rpc('discard_trial_balance_upload', { p_upload_id: u1.id, p_expected_version: v1 })
    return !!error
  })
  for (const k of ['preparer', 'viewer', 'pending', 'outsider']) {
    await check(`${k} → 'forbidden'`, async () => (await discard(U[k], u1.id, v1)).outcome === 'forbidden')
  }
  await check('nothing changed after the refused attempts', async () => { const r = await row(u1.id); return r.lifecycle_state === 'active_unprocessed' && Number(r.version) === v1 })

  section('Unprocessed hard discard — Storage + database saga (partner, not the uploader)')
  let op1
  await check('partner begins: discard_pending with an operation id', async () => {
    const r = await discard(U.partner, u1.id, v1); op1 = r.operation_id
    return r.outcome === 'discard_pending' && !!op1
  })
  await check('a retried begin resumes the SAME operation', async () => (await discard(U.partner, u1.id, v1)).operation_id === op1)
  let partnerRemoved
  await check("Storage: the partner's remove() of the owner's file — recorded (Storage RLS decides, not the RPC)", async () => {
    const { data, error } = await U.partner.c.storage.from(BUCKET).remove([u1.path])
    partnerRemoved = !error && (data ?? []).length === 1
    console.log(`        partner remove(): error=${error ? error.message : 'none'} deleted=${(data ?? []).length} objectStillExists=${await objectExists(u1.path)}`)
    return true
  })
  await check('finalize without confirmed removal deletes nothing', async () => (await complete(U.partner, op1, false)).outcome === 'discard_pending' && !!(await row(u1.id)))
  await check('owner removes the file, finalize with removal confirmed deletes the row', async () => {
    if (!partnerRemoved) { const { error } = await U.owner.c.storage.from(BUCKET).remove([u1.path]); if (error) return error.message }
    const r = await complete(U.partner, op1, true)
    return r.outcome === 'deleted_now' && !(await row(u1.id)) && !(await objectExists(u1.path))
  })
  await check('a repeated finalize is idempotent', async () => (await complete(U.partner, op1, true)).outcome === 'already_discarded')
  await check('events carry actor_user_id AND the server-resolved actor_membership_id', async () => {
    const { data } = await svc.from('trial_balance_upload_lifecycle_events').select('*').eq('upload_id', u1.id).eq('to_state', 'discarded')
    return data?.length === 1 && data[0].actor_user_id === U.partner.id && data[0].actor_membership_id === members.partner && data[0].operation_id === op1
  })

  section('Undo — success, idempotency, conflict, expiry, stale')
  await check('Undo without the file back: storage_restore_required', async () => (await restore(U.owner, op1, false)).outcome === 'storage_restore_required')
  await check('owner re-uploads the file, Undo restores the exact original row', async () => {
    await putObject(U.owner, u1.path)
    const r = await restore(U.owner, op1, true)
    const back = await row(u1.id)
    return r.outcome === 'restored' && back?.file_path === u1.path && (await activeCount(A, 2031)) === 1
  })
  await check('a repeated Undo proves the same row: already_restored', async () => (await restore(U.owner, op1, true)).outcome === 'already_restored')
  created.uploads.add(u1.id)
  const u2 = await clientUpload(U.owner, A, 2032)
  let op2, u3
  await check('EXACT SCENARIO: discard → upload a new active file → Undo = conflict_new_active_upload; new upload unchanged', async () => {
    const b = await discard(U.owner, u2.id, await version(u2.id)); op2 = b.operation_id
    await U.owner.c.storage.from(BUCKET).remove([u2.path])
    await complete(U.owner, op2, true)
    u3 = await clientUpload(U.owner, A, 2032)
    const before = JSON.stringify(await row(u3.id))
    const r = await restore(U.owner, op2, true)
    return r.outcome === 'conflict_new_active_upload' && !(await row(u2.id)) && JSON.stringify(await row(u3.id)) === before && (await activeCount(A, 2032)) === 1
  })
  await check('the conflict is never reported as restored on retry', async () => (await restore(U.owner, op2, true)).outcome === 'conflict_new_active_upload')
  await check('preparer cannot Undo (forbidden)', async () => (await restore(U.preparer, op2, true)).outcome === 'forbidden')
  await check('an expired undo window: expired', async () => {
    const u = await clientUpload(U.owner, A, 2033)
    const b = await discard(U.owner, u.id, await version(u.id))
    await U.owner.c.storage.from(BUCKET).remove([u.path])
    await complete(U.owner, b.operation_id, true)
    const { error } = await svc.from('trial_balance_upload_operations').update({ completed_at: new Date(Date.now() - 11 * 60000).toISOString() }).eq('id', b.operation_id)
    if (error) return `backdate: ${error.message}`
    return (await restore(U.owner, b.operation_id, true)).outcome === 'expired'
  })
  await check('an unknown operation: stale_operation', async () => (await restore(U.owner, randomUUID(), true)).outcome === 'stale_operation')

  section('Certification drives lifecycle; evidence is never hard-deleted')
  const c1 = await clientUpload(U.owner, A, 2034)
  await check("engine processing start (status='validating') → active_processing", async () => {
    await svc.from('trial_balance_uploads').update({ status: 'validating' }).eq('id', c1.id)
    return (await row(c1.id)).lifecycle_state === 'active_processing'
  })
  await check('a processing upload is refused a hard discard even with a stale version (replacement_required)', async () =>
    (await discard(U.owner, c1.id, 1)).outcome === 'replacement_required')
  await check('blocking certification → blocked', async () => { await certify(A, c1.id, 2034, members.owner, { blocking: true }); return (await row(c1.id)).lifecycle_state === 'blocked' })
  await check('needs-review certification → active_processed (review stays on the certification)', async () => { await certify(A, c1.id, 2034, members.owner, { review: true }); return (await row(c1.id)).lifecycle_state === 'active_processed' })
  await check('clean certification → active_processed, and it is authoritative', async () => {
    await certify(A, c1.id, 2034, members.owner)
    const { data } = await svc.rpc('get_authoritative_certification', { p_company_id: A, p_period_year: 2034 })
    return (await row(c1.id)).lifecycle_state === 'active_processed' && data?.[0]?.upload_id === c1.id
  })

  section('Retire and replace a certified upload; cancel the replacement')
  const certsBefore = await certCount(c1.id)
  const rep1 = `${U.owner.id}/${TS}-replacement-1.csv`
  let n1
  await check('preparer cannot replace (forbidden)', async () => (await retire(U.preparer, c1.id, await version(c1.id), rep1)).outcome === 'forbidden')
  await check('owner replaces: old superseded and linked, new active_unprocessed, certifications untouched, one active', async () => {
    await putObject(U.owner, rep1)
    const r = await retire(U.owner, c1.id, await version(c1.id), rep1); n1 = r.new_upload_id
    if (n1) created.uploads.add(n1)
    const [o, n] = [await row(c1.id), await row(n1)]
    return r.outcome === 'replaced' && o.lifecycle_state === 'superseded' && o.superseded_by_upload_id === n1 && n.replaces_upload_id === c1.id
      && n.lifecycle_state === 'active_unprocessed' && o.retired_by_membership_id === members.owner && (await certCount(c1.id)) === certsBefore && (await activeCount(A, 2034)) === 1
  })
  await check('retry with the same file → same replacement; a different file → stale_version', async () =>
    (await retire(U.owner, c1.id, 1, rep1)).new_upload_id === n1 && (await retire(U.owner, c1.id, 1, `${U.owner.id}/${TS}-other.csv`)).outcome === 'stale_version')
  await check('hard discard of the unprocessed replacement → replacement_cancel_required', async () => (await discard(U.owner, n1, await version(n1))).outcome === 'replacement_cancel_required')
  await check('viewer cannot cancel (forbidden)', async () => (await cancel(U.viewer, n1, await version(n1))).outcome === 'forbidden')
  let cop
  await check('owner cancels: predecessor restored as the sole active upload, certified and authoritative again', async () => {
    const r = await cancel(U.owner, n1, await version(n1)); cop = r.operation_id
    const o = await row(c1.id)
    const { data } = await svc.rpc('get_authoritative_certification', { p_company_id: A, p_period_year: 2034 })
    return r.outcome === 'cancelled' && !(await row(n1)) && o.lifecycle_state === 'active_processed' && o.superseded_by_upload_id === null
      && (await activeCount(A, 2034)) === 1 && (await certCount(c1.id)) === certsBefore && data?.[0]?.upload_id === c1.id
  })
  await check('Storage cleanup: pending until confirmed; removal then confirm → completed; confirm again → already_completed', async () => {
    const pending = (await confirmCleanup(U.owner, cop, false)).outcome
    const { error } = await U.owner.c.storage.from(BUCKET).remove([rep1])
    const done = (await confirmCleanup(U.owner, cop, !error)).outcome
    const again = (await confirmCleanup(U.owner, cop, true)).outcome
    return pending === 'storage_cleanup_pending' && done === 'completed' && again === 'already_completed' && !(await objectExists(rep1))
  })
  await check('retrying the cancel is idempotent (already_cancelled, same operation)', async () => { const r = await cancel(U.owner, n1, 1); return r.outcome === 'already_cancelled' && r.operation_id === cop })
  await check('a processed replacement cannot be cancelled or hard-deleted; it must itself be retired', async () => {
    const p2 = `${U.owner.id}/${TS}-replacement-2.csv`; await putObject(U.owner, p2)
    const r = await retire(U.owner, c1.id, await version(c1.id), p2); created.uploads.add(r.new_upload_id)
    await svc.from('trial_balance_uploads').update({ status: 'validating' }).eq('id', r.new_upload_id)
    const v = await version(r.new_upload_id)
    const c = await cancel(U.owner, r.new_upload_id, v)
    const d = await discard(U.owner, r.new_upload_id, v)
    const p3 = `${U.owner.id}/${TS}-replacement-3.csv`; await putObject(U.owner, p3)
    const again = await retire(U.owner, r.new_upload_id, v, p3); created.uploads.add(again.new_upload_id)
    return c.outcome === 'replacement_processed' && d.outcome === 'replacement_required' && again.outcome === 'replaced' && (await activeCount(A, 2034)) === 1
  })

  section(`Concurrency — ${CONCURRENCY} simultaneous HTTP requests`)
  await check(`${CONCURRENCY} concurrent discard begins converge on ONE operation`, async () => {
    const u = await clientUpload(U.owner, A, 2040); const v = await version(u.id)
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => discard(U.owner, u.id, v)))
    return new Set(out.map((o) => o.operation_id)).size === 1 && out.every((o) => o.outcome === 'discard_pending')
  })
  await check(`${CONCURRENCY} concurrent replaces with the SAME file → exactly one replacement`, async () => {
    const u = await clientUpload(U.owner, A, 2041); await certify(A, u.id, 2041, members.owner)
    const v = await version(u.id); const p = `${U.owner.id}/${TS}-same.csv`; await putObject(U.owner, p)
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => retire(U.owner, u.id, v, p)))
    out.forEach((o) => o.new_upload_id && created.uploads.add(o.new_upload_id))
    return new Set(out.map((o) => o.new_upload_id)).size === 1 && out.every((o) => o.outcome === 'replaced') && (await activeCount(A, 2041)) === 1
  })
  await check(`${CONCURRENCY} concurrent replaces with DIFFERENT files → one winner, the rest stale_version`, async () => {
    const u = await clientUpload(U.owner, A, 2042); await certify(A, u.id, 2042, members.owner)
    const v = await version(u.id)
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => retire(U.owner, u.id, v, `${U.owner.id}/${TS}-f${i}.csv`)))
    out.forEach((o) => o.new_upload_id && created.uploads.add(o.new_upload_id))
    return out.filter((o) => o.outcome === 'replaced').length === 1 && out.filter((o) => o.outcome === 'stale_version').length === CONCURRENCY - 1 && (await activeCount(A, 2042)) === 1
  })

  section('Global invariants on staging')
  await check('no company/period anywhere on staging has more than one active upload', async () => {
    const { data } = await svc.from('trial_balance_uploads').select('company_id, period_year').not('company_id', 'is', null).not('period_year', 'is', null)
      .in('lifecycle_state', ['active_unprocessed', 'active_processing', 'active_processed', 'blocked'])
    const seen = new Set(); for (const r of data ?? []) { const k = `${r.company_id}|${r.period_year}`; if (seen.has(k)) return k; seen.add(k) }
    return true
  })
  await check('lifecycle events are append-only even for the service role', async () => {
    const { data } = await svc.from('trial_balance_upload_lifecycle_events').select('id').limit(1)
    const { error } = await svc.from('trial_balance_upload_lifecycle_events').update({ reason: 'x' }).eq('id', data[0].id)
    return !!error
  })
  await check('clients cannot read the operation records', async () => {
    const { data, error } = await U.owner.c.from('trial_balance_upload_operations').select('id')
    return !!error || (data ?? []).length === 0
  })
}

async function cleanup() {
  section('Cleanup (best effort; what remains is reported)')
  if (created.objects.size) {
    const { error } = await svc.storage.from(BUCKET).remove([...created.objects])
    console.log(`  storage objects removed: ${error ? 'ERROR ' + error.message : created.objects.size + ' requested'}`)
  }
  let leftUploads = 0
  for (const id of created.uploads) if (await row(id)) leftUploads++
  const { count: certs } = await svc.from('tb_certifications').select('id', { count: 'exact', head: true }).in('company_id', created.companies)
  const { count: events } = await svc.from('trial_balance_upload_lifecycle_events').select('id', { count: 'exact', head: true }).in('company_id', created.companies)
  for (const c of created.companies) await svc.from('companies').update({ is_active: false }).eq('id', c)
  console.log(`RESIDUAL: users=${created.users.length} companies=${created.companies.length} (soft-deleted) uploads=${leftUploads} certifications=${certs ?? '?'} lifecycle_events=${events ?? '?'} (append-only by design; staging only)`)
}

let ok = false
try {
  await main()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n──────────────────────────────────────────\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`)
  ok = failed.length === 0
  console.log(ok ? 'UPLOAD_LIFECYCLE_STAGING: ALL PASSED' : 'UPLOAD_LIFECYCLE_STAGING: FAILED')
} catch (e) {
  console.error(`FATAL: ${String(e?.message ?? e).split('\n')[0]}`)
} finally {
  try { await cleanup() } catch (e) { console.error(`cleanup error: ${e?.message ?? e}`) }
}
process.exit(ok ? 0 : 1)
