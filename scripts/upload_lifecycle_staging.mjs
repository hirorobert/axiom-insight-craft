#!/usr/bin/env node
/**
 * Upload lifecycle — hosted staging proof (PR #32, 20260923100000 + trial-balance-storage-cleanup).
 *
 * scripts/db-proof/uploadLifecycle.mjs proves the SQL on a throwaway local PostgreSQL, including a workspace
 * owner with NO firm_members row. That case cannot exist on a hosted project: company creation always
 * creates the owner's membership, and a trigger protects the last owner. This suite proves the same USER-BASED
 * contract END TO END on the hosted staging project, through the paths a browser uses: real Supabase Auth users
 * and JWTs, PostgREST RPCs, RLS, Storage (trial-balance-files) and the deployed trial-balance-storage-cleanup
 * Edge Function.
 *
 * WRITE-CAPABLE: it creates users, workspaces, uploads, certifications, grants and Storage objects. It runs only
 * after scripts/ci/stagingGuard.mjs has verified that the target is the configured STAGING project (never
 * production), and it reads only the STAGING_* variables. Passwords are random per run and are never printed.
 * Append-only records (certifications, lifecycle and grant events) remain by design and are reported.
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
const CLEANUP_FN = `${URL_}/functions/v1/trial-balance-storage-cleanup`
const CONCURRENCY = 6
const TS = Date.now()
const PASSWORD = `${randomBytes(18).toString('base64url')}!9aZ`
const opts = { auth: { autoRefreshToken: false, persistSession: false } }
const svc = createClient(URL_, SERVICE, opts)

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
  const { data: s, error: signErr } = await client.auth.signInWithPassword({ email, password: PASSWORD })
  if (signErr) throw new Error(`signIn(${label}): ${signErr.message}`)
  return { id: data.user.id, c: client, token: s.session.access_token }
}

const rpc = async (who, name, args) => {
  const { data, error } = await who.c.rpc(name, args)
  if (error) throw Object.assign(new Error(`${name}: ${error.message}`), { code: error.code })
  return Array.isArray(data) ? data[0] : data
}
const discard = (who, id, v) => rpc(who, 'discard_trial_balance_upload', { p_upload_id: id, p_expected_version: v })
const restore = (who, op) => rpc(who, 'restore_trial_balance_upload', { p_operation_id: op })
const retire = (who, id, v, path) => rpc(who, 'retire_trial_balance_upload', {
  p_old_upload_id: id, p_expected_version: v, p_new_file_name: 'replacement.csv', p_new_file_path: path, p_new_file_size: 64, p_reason: 'staging proof',
})
const cancel = (who, id, v) => rpc(who, 'cancel_trial_balance_replacement', { p_replacement_upload_id: id, p_expected_version: v })
const grant = (who, company, grantee, cap) => rpc(who, 'grant_workspace_capability', { p_company_id: company, p_grantee_user_id: grantee, p_capability: cap })
const revoke = (who, company, grantee, cap) => rpc(who, 'revoke_workspace_capability', { p_company_id: company, p_grantee_user_id: grantee, p_capability: cap })
/** The deployed Edge Function, called exactly as the browser calls it. */
async function cleanup(who, body) {
  const headers = { 'Content-Type': 'application/json', apikey: ANON }
  if (who) headers.Authorization = `Bearer ${who.token}`
  const res = await fetch(CLEANUP_FN, { method: 'POST', headers, body: JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, outcome: json.outcome ?? null }
}

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
  if (error) throw new Error(`storage upload: ${error.message}`)
  created.objects.add(path)
}
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
async function certify(company, upload, period, { blocking = false, review = false } = {}) {
  const { error: hashErr } = await svc.from('trial_balance_uploads').update({ source_file_hash: 'staging-proof-hash' }).eq('id', upload).is('source_file_hash', null)
  if (hashErr) throw new Error(`hash: ${hashErr.message}`)
  const { data: run, error: runErr } = await svc.from('engine_runs').insert({
    company_id: company, actor_type: 'system', firm_member_id: null, function_name: 'process-trial-balance', engine_version: 'staging-proof', status: 'running', period_year: period,
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
  section('Fixtures (real Auth users and workspaces; no firm, no titles needed)')
  const U = {}
  for (const k of ['owner', 'collab', 'partnerTitle', 'revoked', 'unrelated', 'ownerB']) U[k] = await makeUser(k)
  const mk = async (who, name) => {
    const { data, error } = await who.c.from('companies').insert({ user_id: who.id, name }).select('id').single()
    if (error) throw new Error(`company: ${error.message}`)
    created.companies.push(data.id); return data.id
  }
  const A = await mk(U.owner, `Lifecycle Proof A ${TS}`)
  const B = await mk(U.ownerB, `Lifecycle Proof B ${TS}`)
  const X = await mk(U.unrelated, `Lifecycle Proof X ${TS}`)
  // A title with no grant: must confer nothing.
  const { error: pErr } = await svc.from('firm_members').insert({ company_id: A, user_id: U.partnerTitle.id, role: 'partner', accepted_at: new Date().toISOString() })
  if (pErr) throw new Error(`partner title: ${pErr.message}`)
  record('owner created the workspace through RLS; a partner-titled member exists without any grant', true)
  await check('the collaborator has NO firm_members row anywhere', async () =>
    (await svc.from('firm_members').select('id', { count: 'exact', head: true }).eq('user_id', U.collab.id)).count === 0)

  section('Grants — owner only, idempotent, one active grant, fail closed')
  await check('owner grants manage_source_files to the collaborator and to the soon-revoked user', async () =>
    (await grant(U.owner, A, U.collab.id, 'manage_source_files')).outcome === 'granted' && (await grant(U.owner, A, U.revoked.id, 'manage_source_files')).outcome === 'granted')
  await check('a repeated grant is idempotent (already_granted)', async () => (await grant(U.owner, A, U.collab.id, 'manage_source_files')).outcome === 'already_granted')
  await check('non-owners cannot grant (collaborator, partner title, other workspace owner)', async () =>
    (await grant(U.collab, A, U.unrelated.id, 'manage_source_files')).outcome === 'forbidden'
    && (await grant(U.partnerTitle, A, U.unrelated.id, 'manage_source_files')).outcome === 'forbidden'
    && (await grant(U.ownerB, A, U.ownerB.id, 'manage_source_files')).outcome === 'forbidden')
  await check('unknown capability fails closed', async () => (await grant(U.owner, A, U.collab.id, 'delete_everything')).outcome === 'invalid_capability')
  await check('clients cannot write grants directly', async () => {
    const { error } = await U.owner.c.from('workspace_capability_grants').insert({ company_id: A, grantee_user_id: U.unrelated.id, capability: 'review_close', granted_by_user_id: U.owner.id })
    return !!error
  })
  await check('exactly one active manage_source_files grant for the collaborator', async () =>
    (await svc.from('workspace_capability_grants').select('id', { count: 'exact', head: true }).eq('company_id', A).eq('grantee_user_id', U.collab.id).is('revoked_at', null)).count === 1)

  section('Owner source-file lifecycle through the deployed Edge Function')
  const o1 = await clientUpload(U.owner, A, 2031)
  let op1
  await check('owner begins a discard', async () => { const r = await discard(U.owner, o1.id, 1); op1 = r.operation_id; return r.outcome === 'discard_pending' && !!op1 })
  await check('anonymous call to the Edge Function is refused (401)', async () => (await cleanup(null, { operation_id: op1 })).status === 401)
  await check('path substitution: a body carrying a file_path is refused (400) and nothing is deleted', async () => {
    const r = await cleanup(U.owner, { operation_id: op1, file_path: `${U.ownerB.id}/anything.csv` })
    return r.status === 400 && r.outcome === 'invalid_request' && (await objectExists(o1.path))
  })
  await check('a forged operation id resolves to nothing (404 stale_operation)', async () => {
    const r = await cleanup(U.owner, { operation_id: randomUUID() })
    return r.status === 404 && r.outcome === 'stale_operation'
  })
  await check('unrelated user, other-workspace owner and partner-title member are forbidden (403); the file stays', async () =>
    (await cleanup(U.unrelated, { operation_id: op1 })).status === 403 && (await cleanup(U.ownerB, { operation_id: op1 })).status === 403
    && (await cleanup(U.partnerTitle, { operation_id: op1 })).status === 403 && (await objectExists(o1.path)))
  await check('the owner completes: file deleted by the server, row deleted, 200 completed', async () => {
    const r = await cleanup(U.owner, { operation_id: op1 })
    return r.status === 200 && r.outcome === 'completed' && !(await objectExists(o1.path)) && !(await row(o1.id))
  })
  await check('repeated completion is idempotent (already_completed)', async () => (await cleanup(U.owner, { operation_id: op1 })).outcome === 'already_completed')
  await check('Undo: owner puts the file back; the server sees it and restores the exact row', async () => {
    const { error } = await U.owner.c.storage.from(BUCKET).upload(o1.path, csv('restore'), { upsert: true })
    if (error) return error.message
    const r = await restore(U.owner, op1)
    return r.outcome === 'restored' && (await row(o1.id))?.file_path === o1.path && (await restore(U.owner, op1)).outcome === 'already_restored'
  })

  section('Collaboration — only what is explicitly granted')
  await check('the partner-TITLED member (no grant) is denied the RPC', async () => (await discard(U.partnerTitle, o1.id, await version(o1.id))).outcome === 'forbidden')
  let op2
  await check("the GRANTED collaborator (no firm membership) discards the OWNER's upload and completes it via the Edge Function", async () => {
    const r = await discard(U.collab, o1.id, await version(o1.id)); op2 = r.operation_id
    const c = await cleanup(U.collab, { operation_id: op2 })
    return r.outcome === 'discard_pending' && c.status === 200 && c.outcome === 'completed' && !(await objectExists(o1.path)) && !(await row(o1.id))
  })
  await check('audit: actor_user_id = collaborator, basis explicit_capability, capability manage_source_files, membership NULL', async () => {
    const { data } = await svc.from('trial_balance_upload_lifecycle_events').select('*').eq('operation_id', op2).eq('outcome', 'applied')
    return data?.length >= 2 && data.every((e) => e.actor_user_id === U.collab.id && e.authority_basis === 'explicit_capability' && e.authority_capability === 'manage_source_files' && e.actor_membership_id === null)
  })
  await check('denials are audited too (partner-title attempt recorded with outcome denied)', async () =>
    (await svc.from('trial_balance_upload_lifecycle_events').select('id', { count: 'exact', head: true }).eq('actor_user_id', U.partnerTitle.id).eq('outcome', 'denied')).count >= 1)
  const base = await clientUpload(U.owner, A, 2032)
  await certify(A, base.id, 2032)
  const collabFile = `${U.collab.id}/${TS}-collab-replacement.csv`
  let rep
  await check('the collaborator replaces a certified upload with a file in THEIR OWN folder; certifications untouched', async () => {
    await putObject(U.collab, collabFile)
    const before = await certCount(base.id)
    const r = await retire(U.collab, base.id, await version(base.id), collabFile); rep = r.new_upload_id
    if (rep) created.uploads.add(rep)
    return r.outcome === 'replaced' && (await row(base.id)).lifecycle_state === 'superseded' && (await certCount(base.id)) === before && (await activeCount(A, 2032)) === 1
  })
  await check("the OWNER cancels the collaborator's replacement and the Edge Function removes the COLLABORATOR's file", async () => {
    const c = await cancel(U.owner, rep, await version(rep))
    const r = await cleanup(U.owner, { operation_id: c.operation_id })
    return c.outcome === 'cancelled' && r.outcome === 'completed' && !(await objectExists(collabFile))
      && (await row(base.id)).lifecycle_state === 'active_processed' && (await activeCount(A, 2032)) === 1
  })
  await check('replace refuses a path outside the caller\'s own folder', async () => {
    const foreign = `${U.owner.id}/${TS}-owner-file.csv`; await putObject(U.owner, foreign)
    return (await retire(U.collab, base.id, await version(base.id), foreign)).outcome === 'forbidden'
  })
  await check('REVOKED: the revoked user is denied on the very next call, by the RPC and by the Edge Function', async () => {
    const u = await clientUpload(U.owner, A, 2033)
    const b = await discard(U.revoked, u.id, 1)
    const rv = await revoke(U.owner, A, U.revoked.id, 'manage_source_files')
    const r = await discard(U.revoked, u.id, 2)
    const c = await cleanup(U.revoked, { operation_id: b.operation_id })
    return b.outcome === 'discard_pending' && rv.outcome === 'revoked' && r.outcome === 'forbidden' && c.status === 403 && (await objectExists(u.path))
  })
  await check('cross-workspace: the collaborator has nothing in workspace B', async () => {
    const b1 = await clientUpload(U.ownerB, B, 2034)
    return (await discard(U.collab, b1.id, 1)).outcome === 'forbidden'
  })

  section('A forged row can never redirect a deletion; no unrelated object is deleted')
  const victimPath = `${U.ownerB.id}/${TS}-victim.csv`
  await check("an attacker's own-workspace row pointing at another user's file: discard completes, the victim file is untouched", async () => {
    await putObject(U.ownerB, victimPath)
    const { data, error } = await U.unrelated.c.from('trial_balance_uploads').insert({
      file_name: 'x', file_path: victimPath, file_size: 1, status: 'processing', user_id: U.unrelated.id, company_id: X, period_year: 2040,
    }).select('id').single()
    if (error) return error.message
    created.uploads.add(data.id)
    const b = await discard(U.unrelated, data.id, 1)
    const r = await cleanup(U.unrelated, { operation_id: b.operation_id })
    return b.file_path === null && r.outcome === 'completed' && (await objectExists(victimPath))
  })

  section('Edge Function concurrency and missing objects')
  await check(`${CONCURRENCY} concurrent completions: exactly one completes, the rest already_completed; file gone`, async () => {
    const u = await clientUpload(U.owner, A, 2041)
    const b = await discard(U.owner, u.id, 1)
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => cleanup(U.owner, { operation_id: b.operation_id })))
    return out.filter((o) => o.outcome === 'completed').length === 1 && out.filter((o) => o.outcome === 'already_completed').length === CONCURRENCY - 1 && !(await objectExists(u.path))
  })
  await check('missing object (already removed by its uploader): the Edge Function still completes', async () => {
    const u = await clientUpload(U.owner, A, 2042)
    const b = await discard(U.owner, u.id, 1)
    await U.owner.c.storage.from(BUCKET).remove([u.path])
    const r = await cleanup(U.owner, { operation_id: b.operation_id })
    return r.outcome === 'completed' && !(await row(u.id))
  })
  await check('the database accepts no client claim: completing directly while the file exists stays pending', async () => {
    const u = await clientUpload(U.owner, A, 2043)
    const b = await discard(U.owner, u.id, 1)
    const r = await rpc(U.owner, 'complete_trial_balance_discard', { p_operation_id: b.operation_id })
    return r.outcome === 'discard_pending' && !!(await row(u.id)) && (await objectExists(u.path))
  })

  section('Undo conflict and lifecycle invariants')
  await check('EXACT SCENARIO: discard → upload a new active file → Undo = conflict; new upload unchanged', async () => {
    const u = await clientUpload(U.owner, A, 2050)
    const b = await discard(U.owner, u.id, 1)
    await cleanup(U.owner, { operation_id: b.operation_id })
    const n = await clientUpload(U.owner, A, 2050)
    const before = JSON.stringify(await row(n.id))
    await U.owner.c.storage.from(BUCKET).upload(u.path, csv('back'), { upsert: true })
    const r = await restore(U.owner, b.operation_id)
    return r.outcome === 'conflict_new_active_upload' && JSON.stringify(await row(n.id)) === before && (await activeCount(A, 2050)) === 1
  })
  await check('certification drives lifecycle: blocking → blocked; clean → active_processed', async () => {
    const u = await clientUpload(U.owner, A, 2051)
    await certify(A, u.id, 2051, { blocking: true }); const a = (await row(u.id)).lifecycle_state
    await certify(A, u.id, 2051); const b = (await row(u.id)).lifecycle_state
    return a === 'blocked' && b === 'active_processed' && (await discard(U.owner, u.id, 1)).outcome === 'replacement_required'
  })
  await check('the owner cannot set lifecycle_state directly (42501)', async () => {
    const { error } = await U.owner.c.from('trial_balance_uploads').update({ lifecycle_state: 'retired' }).eq('id', base.id)
    return error?.code === '42501'
  })
  await check('no company/period anywhere on staging has more than one active upload', async () => {
    const { data } = await svc.from('trial_balance_uploads').select('company_id, period_year').not('company_id', 'is', null).not('period_year', 'is', null)
      .in('lifecycle_state', ['active_unprocessed', 'active_processing', 'active_processed', 'blocked'])
    const seen = new Set(); for (const r of data ?? []) { const k = `${r.company_id}|${r.period_year}`; if (seen.has(k)) return k; seen.add(k) }
    return true
  })
  await check('lifecycle and grant events are append-only even for the service role', async () => {
    const { data: e } = await svc.from('trial_balance_upload_lifecycle_events').select('id').limit(1)
    const { error: e1 } = await svc.from('trial_balance_upload_lifecycle_events').update({ reason: 'x' }).eq('id', e[0].id)
    const { data: g } = await svc.from('workspace_capability_grant_events').select('id').limit(1)
    const { error: e2 } = await svc.from('workspace_capability_grant_events').delete().eq('id', g[0].id)
    return !!e1 && !!e2
  })
  await check('the unrelated victim object still exists at the end of the run', async () => objectExists(victimPath))
}

async function cleanupFixtures() {
  section('Cleanup (best effort; what remains is reported)')
  const remaining = []
  for (const p of created.objects) if (await objectExists(p)) remaining.push(p)
  if (remaining.length) {
    const { error } = await svc.storage.from(BUCKET).remove(remaining)
    console.log(`  storage objects removed: ${error ? 'ERROR ' + error.message : remaining.length}`)
  }
  let leftUploads = 0
  for (const id of created.uploads) if (await row(id)) leftUploads++
  console.log(`RESIDUAL: users=${created.users.length} workspaces=${created.companies.length} uploads=${leftUploads} (certifications, lifecycle and grant events are append-only by design; staging only)`)
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
  try { await cleanupFixtures() } catch (e) { console.error(`cleanup error: ${e?.message ?? e}`) }
}
process.exit(ok ? 0 : 1)
