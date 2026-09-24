#!/usr/bin/env node
/**
 * Upload lifecycle — hosted staging proof (PR #32: 20260923100000 + 20260923120000 + 20260923130000 + trial-balance-source-signer +
 * trial-balance-storage-cleanup + trial-balance-source-sweeper + the real process-trial-balance).
 *
 * scripts/db-proof/uploadLifecycle.mjs proves the SQL on a throwaway local PostgreSQL, including a workspace owner
 * with NO firm_members row, which cannot exist on a hosted project. This suite proves the same USER-BASED
 * contract END TO END on the hosted staging project, through the paths a browser uses:
 *   - real Supabase Auth users and JWTs;
 *   - PostgREST RPCs and RLS;
 *   - Storage (trial-balance-files, workspace-scoped objects);
 *   - the deployed Edge Functions.
 *
 * WRITE-CAPABLE: it runs only after scripts/ci/stagingGuard.mjs has verified the target is the configured STAGING
 * project (never production), and it reads only the STAGING_* variables. Passwords are random per run and are
 * never printed. Append-only records (certifications, lifecycle and grant events) remain by design and are reported.
 *
 * ENV: STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY, STAGING_SUPABASE_SERVICE_ROLE_KEY,
 *      STAGING_SUPABASE_PROJECT_REF
 */

import { createClient } from '@supabase/supabase-js'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
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
const FN = (name) => `${URL_}/functions/v1/${name}`
const CONCURRENCY = 6
const TS = Date.now()
const PASSWORD = `${randomBytes(18).toString('base64url')}!9aZ`
const opts = { auth: { autoRefreshToken: false, persistSession: false } }
const svc = createClient(URL_, SERVICE, opts)
const REAL_TB = readFileSync(new URL('../KAMANGA_MEDICS_TB_2025.csv', import.meta.url))

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

const created = { users: [], companies: [], objects: new Set() }

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
async function callFn(who, name, body) {
  const headers = { 'Content-Type': 'application/json', apikey: ANON }
  if (who) headers.Authorization = `Bearer ${who.token}`
  const res = await fetch(FN(name), { method: 'POST', headers, body: JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  // The HTTP status always wins: process-trial-balance also returns its own `status` field (e.g. "valid"), kept as `body`.
  return { ...json, body: json, status: res.status }
}
const cleanup = (who, body) => callFn(who, 'trial-balance-storage-cleanup', body)

// The browser path (src/lib/workspace/sourceUpload.ts): reserve → signed single-object upload → register.
async function reserveAndUpload(who, company, bytes = REAL_TB, name = 'tb.csv') {
  const r = await rpc(who, 'reserve_trial_balance_source', { p_company_id: company, p_file_name: name })
  if (r.outcome !== 'reserved') return { outcome: r.outcome }
  const s = await callFn(who, 'trial-balance-source-signer', { reservation_id: r.reservation_id })
  if (s.outcome !== 'signed') return { outcome: s.outcome, status: s.status }
  const { error } = await who.c.storage.from(BUCKET).uploadToSignedUrl(s.path, s.token, new Blob([bytes], { type: 'text/csv' }))
  if (error) return { outcome: 'upload_failed', error: error.message }
  created.objects.add(s.path)
  return { outcome: 'uploaded', reservation: r.reservation_id, path: s.path }
}
async function workspaceUpload(who, company, period, bytes) {
  const u = await reserveAndUpload(who, company, bytes)
  if (u.outcome !== 'uploaded') throw new Error(`upload: ${u.outcome}`)
  const g = await rpc(who, 'register_trial_balance_upload', { p_reservation_id: u.reservation, p_file_size: REAL_TB.length, p_period_year: period, p_period_id: null, p_engagement_id: null })
  if (g.outcome !== 'registered') throw new Error(`register: ${g.outcome}`)
  return { id: g.upload_id, path: u.path }
}
const discard = (who, id, v) => rpc(who, 'discard_trial_balance_upload', { p_upload_id: id, p_expected_version: v })
const complete = (who, op) => rpc(who, 'complete_trial_balance_discard', { p_operation_id: op })
const restore = (who, op) => rpc(who, 'restore_trial_balance_upload', { p_operation_id: op })
const cancel = (who, id, v) => rpc(who, 'cancel_trial_balance_replacement', { p_replacement_upload_id: id, p_expected_version: v })
const grant = (who, company, grantee, cap) => rpc(who, 'grant_workspace_capability', { p_company_id: company, p_grantee_user_id: grantee, p_capability: cap })
const revoke = (who, company, grantee, cap) => rpc(who, 'revoke_workspace_capability', { p_company_id: company, p_grantee_user_id: grantee, p_capability: cap })
async function retireWith(who, id, v, company, bytes = REAL_TB) {
  const u = await reserveAndUpload(who, company, bytes, 'replacement.csv')
  if (u.outcome !== 'uploaded') return { outcome: u.outcome }
  const r = await rpc(who, 'retire_trial_balance_upload', { p_old_upload_id: id, p_expected_version: v, p_reservation_id: u.reservation, p_new_file_size: bytes.length, p_reason: 'staging proof' })
  return { ...r, path: u.path }
}
const row = async (id) => (await svc.from('trial_balance_uploads').select('*').eq('id', id).maybeSingle()).data
const version = async (id) => Number((await row(id))?.version)
const activeCount = async (company, period) => {
  const { count } = await svc.from('trial_balance_uploads').select('id', { count: 'exact', head: true })
    .eq('company_id', company).eq('period_year', period)
    .in('lifecycle_state', ['active_unprocessed', 'active_processing', 'active_processed', 'blocked'])
  return count
}
const objectId = async (path) => {
  const dir = path.split('/').slice(0, -1).join('/')
  const name = path.split('/').pop()
  const { data } = await svc.storage.from(BUCKET).list(dir, { search: name })
  return (data ?? []).find((o) => o.name === name)?.id ?? null
}
const expireOp = (op) => svc.from('trial_balance_upload_operations').update({ completed_at: new Date(Date.now() - 11 * 60000).toISOString() }).eq('id', op)
const discardFully = async (who, id) => { const b = await discard(who, id, await version(id)); const c = await complete(who, b.operation_id); return { b, c } }
const process_ = (who, uploadId) => callFn(who, 'process-trial-balance', { uploadId, clientRequestId: randomUUID() })

async function main() {
  section('Fixtures (real Auth users and workspaces; no firm, no titles needed)')
  const U = {}
  for (const k of ['owner', 'collab', 'partnerTitle', 'revoked', 'unrelated', 'ownerB']) U[k] = await makeUser(k)
  const mk = async (who, name) => {
    const { data, error } = await who.c.from('companies').insert({ user_id: who.id, name }).select('id').single()
    if (error) throw new Error(`workspace: ${error.message}`)
    created.companies.push(data.id); return data.id
  }
  const A = await mk(U.owner, `Lifecycle Proof A ${TS}`)
  const B = await mk(U.ownerB, `Lifecycle Proof B ${TS}`)
  const { error: pErr } = await svc.from('firm_members').insert({ company_id: A, user_id: U.partnerTitle.id, role: 'partner', accepted_at: new Date().toISOString() })
  if (pErr) throw new Error(`partner title: ${pErr.message}`)
  await check('grants: owner grants manage_source_files (collaborator and soon-revoked user); non-owners cannot', async () =>
    (await grant(U.owner, A, U.collab.id, 'manage_source_files')).outcome === 'granted'
    && (await grant(U.owner, A, U.revoked.id, 'manage_source_files')).outcome === 'granted'
    && (await grant(U.partnerTitle, A, U.unrelated.id, 'manage_source_files')).outcome === 'forbidden')
  await check('the collaborator has NO firm_members row anywhere', async () =>
    (await svc.from('firm_members').select('id', { count: 'exact', head: true }).eq('user_id', U.collab.id)).count === 0)

  section('Normal upload: workspace-scoped, for the owner AND a granted collaborator (deployed signing function)')
  let o1, c1
  await check('owner uploads through reserve → signed upload → register; the object is workspace-scoped', async () => {
    o1 = await workspaceUpload(U.owner, A, 2031)
    const r = await row(o1.id)
    return r.file_path === o1.path && o1.path.startsWith(`workspaces/${A}/`) && r.user_id === U.owner.id
  })
  await check('a GRANTED collaborator (no firm membership) performs a normal upload', async () => {
    c1 = await workspaceUpload(U.collab, A, 2032)
    const r = await row(c1.id)
    return r.user_id === U.collab.id && c1.path.startsWith(`workspaces/${A}/`)
  })
  await check('partner title (no grant), unrelated user, other workspace owner cannot reserve', async () =>
    (await rpc(U.partnerTitle, 'reserve_trial_balance_source', { p_company_id: A, p_file_name: 'x.csv' })).outcome === 'forbidden'
    && (await rpc(U.unrelated, 'reserve_trial_balance_source', { p_company_id: A, p_file_name: 'x.csv' })).outcome === 'forbidden'
    && (await rpc(U.ownerB, 'reserve_trial_balance_source', { p_company_id: A, p_file_name: 'x.csv' })).outcome === 'forbidden')
  await check("signing function: anonymous 401; someone else's reservation 403; body with a path 400; forged id 404", async () => {
    const r = await rpc(U.owner, 'reserve_trial_balance_source', { p_company_id: A, p_file_name: 'x.csv' })
    const anon = await callFn(null, 'trial-balance-source-signer', { reservation_id: r.reservation_id })
    const other = await callFn(U.collab, 'trial-balance-source-signer', { reservation_id: r.reservation_id })
    const subst = await callFn(U.owner, 'trial-balance-source-signer', { reservation_id: r.reservation_id, path: `workspaces/${B}/x.csv` })
    const forged = await callFn(U.owner, 'trial-balance-source-signer', { reservation_id: randomUUID() })
    return anon.status === 401 && other.status === 403 && subst.status === 400 && forged.status === 404
  })
  await check('clients still cannot write into workspaces/ directly (no Storage policy was widened)', async () => {
    const { error } = await U.owner.c.storage.from(BUCKET).upload(`workspaces/${A}/${randomUUID()}/direct.csv`, new Blob(['x']))
    return !!error
  })
  await check('a revoked user is refused at signing even with an earlier reservation', async () => {
    const r = await rpc(U.revoked, 'reserve_trial_balance_source', { p_company_id: A, p_file_name: 'x.csv' })
    await revoke(U.owner, A, U.revoked.id, 'manage_source_files')
    const s = await callFn(U.revoked, 'trial-balance-source-signer', { reservation_id: r.reservation_id })
    return r.outcome === 'reserved' && s.status === 403
  })

  section('Validation through the real process-trial-balance')
  await check('owner validates the uploaded TB: processing starts and a certification drives the lifecycle', async () => {
    const p = await process_(U.owner, o1.id)
    const r = await row(o1.id)
    const { count } = await svc.from('tb_certifications').select('id', { count: 'exact', head: true }).eq('upload_id', o1.id)
    return p.status === 200 && p.body.status === 'valid' && count >= 1 && r.lifecycle_state === 'active_processed' || `http=${p.status} engine=${p.body.status} lifecycle=${r.lifecycle_state} certs=${count}`
  })
  await check('a GRANTED collaborator with NO firm membership validates through the real process-trial-balance (workspace_user actor)', async () => {
    const cv = await workspaceUpload(U.collab, A, 2038)
    const p = await process_(U.collab, cv.id)
    const r = await row(cv.id)
    const { data: runs } = await svc.from('engine_runs').select('actor_type, actor_user_id, firm_member_id').eq('source_record_id', cv.id)
    const { count: fm } = await svc.from('firm_members').select('id', { count: 'exact', head: true }).eq('user_id', U.collab.id)
    return p.status === 200 && p.body.status === 'valid' && r.lifecycle_state === 'active_processed' && fm === 0
      && runs?.length >= 1 && runs.every((x) => x.actor_type === 'workspace_user' && x.actor_user_id === U.collab.id && x.firm_member_id === null)
      || `http=${p.status} engine=${p.body.status} msg=${p.body.message} lifecycle=${r?.lifecycle_state} fm=${fm} runs=${JSON.stringify(runs)}`
  })
  await check('an unrelated user and another workspace owner are refused validation (403); the upload is untouched', async () => {
    const u = await workspaceUpload(U.owner, A, 2034)
    const a = await process_(U.unrelated, u.id)
    const b2 = await process_(U.ownerB, u.id)
    return a.status === 403 && b2.status === 403 && (await row(u.id)).lifecycle_state === 'active_unprocessed' || `unrelated=${a.status} ownerB=${b2.status}`
  })
  await check('a malformed file fails validation and is then REPLACED by the owner with a valid one', async () => {
    const bad = await workspaceUpload(U.owner, A, 2033, Buffer.from('not,a,trial,balance\n1,2\n'))
    const p = await process_(U.owner, bad.id)
    const after = await row(bad.id)
    const rep = await retireWith(U.owner, bad.id, await version(bad.id), A)
    return p.status !== 500 && p.body.status !== 'valid' && after.lifecycle_state !== 'active_unprocessed' && rep.outcome === 'replaced' && (await activeCount(A, 2033)) === 1
      || `ptb=${p.status} engine=${p.body.status} lifecycle=${after?.lifecycle_state} replace=${rep.outcome}`
  })

  section('Access bridge: a grant-only collaborator discovers and opens the granted workspace, Prepare only (their own JWT, RLS)')
  const accessOf = async (who, company) => { const { data, error } = await who.c.rpc('get_workspace_access', { p_company_id: company }); if (error) throw new Error(error.message); return data?.[0] ?? null }
  const sharedOf = async (who) => { const { data, error } = await who.c.rpc('list_shared_workspaces'); if (error) throw new Error(error.message); return (data ?? []).map((r) => r.company_id) }
  const seen = async (who, table, col, company) => (await who.c.from(table).select(col).eq(col, company)).data?.length ?? 0
  await check('the grant-only collaborator lists exactly the granted workspace and opens it with the Prepare stage only', async () => {
    const a = await accessOf(U.collab, A); const shared = await sharedOf(U.collab)
    return a?.access === 'capability' && JSON.stringify(a.stages) === '["prepare"]' && JSON.stringify(shared) === JSON.stringify([A])
      && (await accessOf(U.collab, B)) === null || `access=${JSON.stringify(a)} shared=${JSON.stringify(shared)}`
  })
  await check('they read the Prepare data of the granted workspace (uploads, certifications) and none of another workspace', async () => {
    const up = await seen(U.collab, 'trial_balance_uploads', 'company_id', A); const cert = await seen(U.collab, 'tb_certifications', 'company_id', A)
    return up > 0 && cert > 0 && (await seen(U.collab, 'trial_balance_uploads', 'company_id', B)) === 0 || `uploads=${up} certs=${cert}`
  })
  await check('nothing outside Prepare becomes readable: the companies row, engagements, periods, sign-offs, reconciliations', async () => {
    for (const [t, col] of [['companies', 'id'], ['engagements', 'company_id'], ['fiscal_periods', 'company_id'], ['statement_sign_offs', 'company_id']]) {
      const n = await seen(U.collab, t, col, A); if (n !== 0) return `${t}=${n}`
    }
    const { data } = await U.collab.c.from('safisha_reconciliations').select('id')
    return (data ?? []).length === 0
  })
  await check('the owner opens every stage; a partner TITLE without a grant gets nothing new; unrelated and anonymous get nothing', async () => {
    const o = await accessOf(U.owner, A); const p = await accessOf(U.partnerTitle, A)
    const anon = await createClient(URL_, ANON, opts).rpc('get_workspace_access', { p_company_id: A })
    return o?.access === 'owner' && o.stages.length === 7 && p?.access === 'member' && (await sharedOf(U.partnerTitle)).length === 0
      && (await accessOf(U.unrelated, A)) === null && (await sharedOf(U.unrelated)).length === 0 && !!anon.error
      || `owner=${o?.access} partner=${p?.access} anon=${!!anon.error}`
  })
  await check('revoking a grant removes discovery, access and the Prepare reads on the very next read', async () => {
    await grant(U.owner, A, U.unrelated.id, 'prepare_trial_balance')
    const before = [(await accessOf(U.unrelated, A))?.access, (await sharedOf(U.unrelated)).length, await seen(U.unrelated, 'trial_balance_uploads', 'company_id', A)]
    await revoke(U.owner, A, U.unrelated.id, 'prepare_trial_balance')
    const after = [await accessOf(U.unrelated, A), (await sharedOf(U.unrelated)).length, await seen(U.unrelated, 'trial_balance_uploads', 'company_id', A)]
    return before[0] === 'capability' && before[1] === 1 && before[2] > 0 && after[0] === null && after[1] === 0 && after[2] === 0
      || `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`
  })
  await check('still no firm_members row for the collaborator after all of the above', async () =>
    (await svc.from('firm_members').select('id', { count: 'exact', head: true }).eq('user_id', U.collab.id)).count === 0)

  section('Undo: the source is retained; any authorized user restores the exact object')
  await check("owner Undo of the COLLABORATOR's upload: same storage object, same row", async () => {
    const before = await row(c1.id); const obj = await objectId(c1.path)
    const { b, c } = await discardFully(U.collab, c1.id)
    const retained = await objectId(c1.path)
    const r = await restore(U.owner, b.operation_id)
    const after = await row(c1.id)
    return c.outcome === 'deleted_now' && retained === obj && r.outcome === 'restored' && (await objectId(c1.path)) === obj
      && after.id === before.id && after.file_path === before.file_path && after.uploaded_at === before.uploaded_at && after.user_id === U.collab.id
  })
  let u5
  await check("collaborator Undo of the OWNER's upload", async () => {
    u5 = await workspaceUpload(U.owner, A, 2035)
    const { b } = await discardFully(U.owner, u5.id)
    return (await restore(U.collab, b.operation_id)).outcome === 'restored' && !!(await row(u5.id))
  })
  await check(`repeated and concurrent Undo (${CONCURRENCY}): exactly one restores`, async () => {
    const { b } = await discardFully(U.owner, u5.id)
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => restore(i % 2 ? U.collab : U.owner, b.operation_id)))
    return out.filter((o) => o.outcome === 'restored').length === 1 && out.filter((o) => o.outcome === 'already_restored').length === CONCURRENCY - 1 && (await activeCount(A, 2035)) === 1
  })
  await check('Undo after a new active upload: explicit conflict, new upload unchanged', async () => {
    const u = await workspaceUpload(U.owner, A, 2036); const { b } = await discardFully(U.owner, u.id)
    const n = await workspaceUpload(U.collab, A, 2036); const before = JSON.stringify(await row(n.id))
    return (await restore(U.owner, b.operation_id)).outcome === 'conflict_new_active_upload' && JSON.stringify(await row(n.id)) === before
  })
  await check('expired Undo is refused; unauthorized Undo is refused', async () => {
    const u = await workspaceUpload(U.owner, A, 2037); const { b } = await discardFully(U.owner, u.id)
    const denied = (await restore(U.partnerTitle, b.operation_id)).outcome
    await expireOp(b.operation_id)
    return denied === 'forbidden' && (await restore(U.owner, b.operation_id)).outcome === 'expired'
  })

  section('Purge: only after the discard is terminal (deployed cleanup function)')
  await check('purge is refused while the discard is restorable (409 undo_window_open); the source survives', async () => {
    const u = await workspaceUpload(U.owner, A, 2040); const { b } = await discardFully(U.owner, u.id)
    const r = await cleanup(U.owner, { operation_id: b.operation_id })
    return r.status === 409 && r.outcome === 'undo_window_open' && !!(await objectId(u.path))
  })
  await check("after the window the COLLABORATOR purges the OWNER's discarded source (server deletion); repeat is idempotent", async () => {
    const u = await workspaceUpload(U.owner, A, 2041); const { b } = await discardFully(U.owner, u.id)
    await expireOp(b.operation_id)
    const listed = (await rpc(U.collab, 'list_purgeable_trial_balance_sources', { p_company_id: A }))
    const r = await cleanup(U.collab, { operation_id: b.operation_id })
    const again = await cleanup(U.collab, { operation_id: b.operation_id })
    return !!listed && r.outcome === 'completed' && !(await objectId(u.path)) && again.outcome === 'already_completed'
  })
  await check('unauthorized purge is refused (403); anonymous 401; path substitution 400; forged id 404', async () => {
    const u = await workspaceUpload(U.owner, A, 2042); const { b } = await discardFully(U.owner, u.id); await expireOp(b.operation_id)
    return (await cleanup(U.partnerTitle, { operation_id: b.operation_id })).status === 403 && (await cleanup(null, { operation_id: b.operation_id })).status === 401
      && (await cleanup(U.owner, { operation_id: b.operation_id, file_path: `workspaces/${B}/x` })).status === 400
      && (await cleanup(U.owner, { operation_id: randomUUID() })).status === 404 && !!(await objectId(u.path))
  })

  section('Replace and cancel: cross-uploader, workspace-scoped')
  await check("the collaborator replaces the owner's certified upload; the owner cancels; the collaborator's source is removed by the server", async () => {
    const before = (await svc.from('tb_certifications').select('id', { count: 'exact', head: true }).eq('upload_id', o1.id)).count
    const rep = await retireWith(U.collab, o1.id, await version(o1.id), A)
    const c = await cancel(U.owner, rep.new_upload_id, await version(rep.new_upload_id))
    const r = await cleanup(U.owner, { operation_id: c.operation_id })
    const after = (await svc.from('tb_certifications').select('id', { count: 'exact', head: true }).eq('upload_id', o1.id)).count
    return rep.outcome === 'replaced' && c.outcome === 'cancelled' && r.outcome === 'completed' && !(await objectId(rep.path))
      && after === before && (await activeCount(A, 2031)) === 1
  })

  section('Legacy uploader-folder objects stay manageable')
  await check('a legacy upload (owner folder, direct insert) is discarded, restored by the collaborator, and purged', async () => {
    const path = `${U.owner.id}/${TS}-legacy.csv`
    const { error: upErr } = await U.owner.c.storage.from(BUCKET).upload(path, new Blob([REAL_TB]))
    if (upErr) return upErr.message
    created.objects.add(path)
    const { data, error } = await U.owner.c.from('trial_balance_uploads').insert({ file_name: 'legacy.csv', file_path: path, file_size: 10, status: 'processing', user_id: U.owner.id, company_id: A, period_year: 2050 }).select('id').single()
    if (error) return error.message
    const { b } = await discardFully(U.owner, data.id)
    const r = await restore(U.collab, b.operation_id)
    const { b: b2 } = await discardFully(U.owner, data.id); await expireOp(b2.operation_id)
    const p = await cleanup(U.collab, { operation_id: b2.operation_id })
    return r.outcome === 'restored' && p.outcome === 'completed' && !(await objectId(path))
  })

  section('Scheduled sweeper: server-only, ticketed; terminal discards and abandoned reservations, never a live source')
  const sweeper = (body) => callFn(null, 'trial-balance-source-sweeper', body)
  const svcRpc = async (name, args) => { const { data, error } = await svc.rpc(name, args); if (error) throw new Error(`${name}: ${error.message}`); return data }
  await check('the sweeper refuses a forged ticket (403) and any body other than one ticket (400); nothing is deleted', async () => {
    const u = await workspaceUpload(U.owner, A, 2060); const { b } = await discardFully(U.owner, u.id); await expireOp(b.operation_id)
    const forged = await sweeper({ ticket: 'f'.repeat(64) })
    const extra = await sweeper({ ticket: await svcRpc('tbu_mint_source_sweeper_ticket'), path: u.path })
    const none = await sweeper({})
    return forged.status === 403 && extra.status === 400 && none.status === 400 && !!(await objectId(u.path))
      || `forged=${forged.status} extra=${extra.status} none=${none.status}`
  })
  await check('one database-minted ticket runs one sweep: terminal discard purged, abandoned reservation reclaimed; live and restorable sources untouched; ticket single-use', async () => {
    const live = await workspaceUpload(U.collab, A, 2061)
    const t = await workspaceUpload(U.owner, A, 2062); const { b } = await discardFully(U.owner, t.id); await expireOp(b.operation_id)
    const w = await workspaceUpload(U.owner, A, 2063); const { b: bw } = await discardFully(U.owner, w.id)
    const ab = await reserveAndUpload(U.collab, A, REAL_TB, 'abandoned.csv')
    await svc.from('trial_balance_source_reservations').update({ expires_at: new Date(Date.now() - 16 * 60000).toISOString() }).eq('id', ab.reservation)
    const ticket = await svcRpc('tbu_mint_source_sweeper_ticket')
    const r = await sweeper({ ticket })
    const again = await sweeper({ ticket })
    const op = (await svc.from('trial_balance_upload_operations').select('state').eq('id', b.operation_id).single()).data
    const res = (await svc.from('trial_balance_source_reservations').select('swept_at').eq('id', ab.reservation).single()).data
    return r.status === 200 && r.outcome === 'swept' && again.status === 403
      && op?.state === 'purged' && !(await objectId(t.path)) && !!res?.swept_at && !(await objectId(ab.path))
      && !!(await objectId(live.path)) && !!(await objectId(w.path)) && (await restore(U.owner, bw.operation_id)).outcome === 'restored'
      || `http=${r.status} tally=${JSON.stringify(r.tally)} again=${again.status} op=${op?.state} swept=${res?.swept_at}`
  })
  await check('the scheduled path end to end: tbu_run_source_sweeper() (the pg_cron entry point) dispatches through pg_net and the sweep happens', async () => {
    const cfg = await svcRpc('tbu_configure_source_sweeper', { p_function_url: FN('trial-balance-source-sweeper') })
    const t = await workspaceUpload(U.owner, A, 2064); const { b } = await discardFully(U.owner, t.id); await expireOp(b.operation_id)
    const out = await svcRpc('tbu_run_source_sweeper')
    let state = null
    for (let i = 0; i < 45 && state !== 'purged'; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      state = (await svc.from('trial_balance_upload_operations').select('state').eq('id', b.operation_id).single()).data?.state
    }
    return cfg === 'configured' && out === 'dispatched' && state === 'purged' && !(await objectId(t.path)) || `cfg=${cfg} run=${out} state=${state}`
  })

  section('Security review hardening (20260923140000): F-01 no reprocessing of history, F-02 current-authority visibility, F-04, F-05')
  const opState = async (op) => (await svc.from('trial_balance_upload_operations').select('state').eq('id', op).single()).data?.state
  const clientRetry = async (who, id) => who.c.from('trial_balance_uploads').update({ status: 'processing', processing_result: null, accounting_errors: null, is_valid: null }).eq('id', id).select('id')
  await check('F-01 superseded: process-trial-balance answers 409 not_active; the client Retry write is refused (55000); the row is unchanged; the active replacement still processes', async () => {
    const u = await workspaceUpload(U.owner, A, 2070)
    const p0 = await process_(U.owner, u.id)
    const rep = await retireWith(U.owner, u.id, await version(u.id), A)
    const before = JSON.stringify(await row(u.id))
    const p = await process_(U.owner, u.id)
    const retry = await clientRetry(U.owner, u.id)
    const after = JSON.stringify(await row(u.id))
    const p2 = await process_(U.owner, rep.new_upload_id)
    return p0.body.status === 'valid' && rep.outcome === 'replaced' && p.status === 409 && p.body.status === 'not_active' && p.body.lifecycle_state === 'superseded'
      && retry.error?.code === '55000' && before === after && p2.status === 200 && (await row(rep.new_upload_id)).lifecycle_state === 'active_processed'
      || `first=${p0.body.status} replace=${rep.outcome} ptb=${p.status}/${p.body.status}/${p.body.lifecycle_state} retry=${retry.error?.code} unchanged=${before === after} active=${p2.status}`
  })
  await check('F-01 discard_pending: process-trial-balance answers 409 and writes nothing; the discard then completes and is undone normally', async () => {
    const u = await workspaceUpload(U.owner, A, 2071)
    const b = await discard(U.owner, u.id, await version(u.id))
    const before = JSON.stringify(await row(u.id))
    const p = await process_(U.owner, u.id)
    const same = before === JSON.stringify(await row(u.id))
    const c = await complete(U.owner, b.operation_id)
    const r = await restore(U.owner, b.operation_id)
    return b.outcome === 'discard_pending' && p.status === 409 && p.body.lifecycle_state === 'discard_pending' && same && c.outcome === 'deleted_now' && r.outcome === 'restored'
      || `discard=${b.outcome} ptb=${p.status}/${p.body.lifecycle_state} same=${same} complete=${c.outcome} restore=${r.outcome}`
  })
  await check('F-04 + F-01 retired: a stale pending discard whose period was taken is retired by the sweeper (never stuck), and cannot be processed (409)', async () => {
    const u = await workspaceUpload(U.owner, A, 2072)
    const b = await discard(U.owner, u.id, await version(u.id))
    await workspaceUpload(U.collab, A, 2072)
    await svc.from('trial_balance_upload_operations').update({ created_at: new Date(Date.now() - 16 * 60000).toISOString() }).eq('id', b.operation_id)
    const done = await svcRpc('tbu_sweeper_complete', { p_kind: 'stale_discard', p_target_id: b.operation_id })
    const r = await row(u.id)
    const p = await process_(U.owner, u.id)
    return done === 'aborted' && r.lifecycle_state === 'retired' && (await activeCount(A, 2072)) === 1 && !!(await objectId(u.path))
      && p.status === 409 && p.body.lifecycle_state === 'retired' && (await complete(U.owner, b.operation_id)).outcome === 'stale_version'
      || `sweep=${done} lifecycle=${r?.lifecycle_state} ptb=${p.status}/${p.body.lifecycle_state}`
  })
  await check('F-02: a revoked collaborator immediately loses every upload of the workspace, INCLUDING the one they uploaded; owner and active grantee keep access', async () => {
    const g = await makeUser('f02revoked')
    await grant(U.owner, A, g.id, 'manage_source_files')
    const gu = await workspaceUpload(g, A, 2073)
    const own = async (who) => (await who.c.from('trial_balance_uploads').select('id').eq('id', gu.id)).data?.length ?? 0
    const anyA = async (who) => (await who.c.from('trial_balance_uploads').select('id').eq('company_id', A)).data?.length ?? 0
    const before = [await own(g), await anyA(g)]
    await revoke(U.owner, A, g.id, 'manage_source_files')
    const after = [await own(g), await anyA(g)]
    const upd = await g.c.from('trial_balance_uploads').update({ file_name: 'renamed.csv' }).eq('id', gu.id).select('id')
    const unchanged = (await row(gu.id)).file_name !== 'renamed.csv'
    const ownerSees = await own(U.owner), collabSees = await own(U.collab), unrelatedSees = await own(U.unrelated)
    const anon = createClient(URL_, ANON, opts)
    const anonSees = (await anon.from('trial_balance_uploads').select('id').eq('id', gu.id)).data?.length ?? 0
    return before[0] === 1 && before[1] > 1 && after[0] === 0 && after[1] === 0 && (upd.data ?? []).length === 0 && unchanged
      && ownerSees === 1 && collabSees === 1 && unrelatedSees === 0 && anonSees === 0
      || JSON.stringify({ before, after, upd: upd.data?.length, unchanged, ownerSees, collabSees, unrelatedSees, anonSees })
  })
  await check('F-05: the cleanup function claims the discard first; once claimed, Undo is expired; the purge is recorded', async () => {
    const u = await workspaceUpload(U.owner, A, 2074); const { b } = await discardFully(U.owner, u.id); await expireOp(b.operation_id)
    const r = await cleanup(U.owner, { operation_id: b.operation_id })
    const st = await opState(b.operation_id)
    const undo = await restore(U.owner, b.operation_id)
    return r.outcome === 'completed' && st === 'purged' && !(await objectId(u.path)) && undo.outcome === 'expired' || `cleanup=${r.status}/${r.outcome} state=${st} undo=${undo.outcome}`
  })
  await check('F-05: an object still referenced by a live upload row is never deleted (409 not_purgeable); the operation is not claimed', async () => {
    const u = await workspaceUpload(U.owner, A, 2075); const { b } = await discardFully(U.owner, u.id); await expireOp(b.operation_id)
    const { error } = await svc.from('trial_balance_uploads').insert({ file_name: 'ref.csv', file_path: u.path, file_size: 1, status: 'processing', company_id: A, period_year: 2076, user_id: U.owner.id })
    const r = await cleanup(U.owner, { operation_id: b.operation_id })
    return !error && r.status === 409 && r.outcome === 'not_purgeable' && !!(await objectId(u.path)) && (await opState(b.operation_id)) === 'completed'
      || `insert=${error?.message} cleanup=${r.status}/${r.outcome} state=${await opState(b.operation_id)}`
  })

  section('Invariants')
  await check('no company/period anywhere on staging has more than one active upload', async () => {
    const { data } = await svc.from('trial_balance_uploads').select('company_id, period_year').not('company_id', 'is', null).not('period_year', 'is', null)
      .in('lifecycle_state', ['active_unprocessed', 'active_processing', 'active_processed', 'blocked'])
    const seen = new Set(); for (const r of data ?? []) { const k = `${r.company_id}|${r.period_year}`; if (seen.has(k)) return k; seen.add(k) }
    return true
  })
  await check('audit: collaborator events carry actor_user_id, basis explicit_capability, membership NULL', async () => {
    const { data } = await svc.from('trial_balance_upload_lifecycle_events').select('*').eq('actor_user_id', U.collab.id).eq('outcome', 'applied').eq('actor_kind', 'user')
    return data?.length >= 3 && data.every((e) => e.authority_basis === 'explicit_capability' && e.actor_membership_id === null)
  })
  await check('lifecycle events are append-only even for the service role', async () => {
    const { data: e } = await svc.from('trial_balance_upload_lifecycle_events').select('id').limit(1)
    const { error } = await svc.from('trial_balance_upload_lifecycle_events').update({ reason: 'x' }).eq('id', e[0].id)
    return !!error
  })
}

async function cleanupFixtures() {
  section('Cleanup (best effort; what remains is reported)')
  const remaining = []
  for (const p of created.objects) if (await objectId(p)) remaining.push(p)
  if (remaining.length) {
    const { error } = await svc.storage.from(BUCKET).remove(remaining)
    console.log(`  storage objects removed: ${error ? 'ERROR ' + error.message : remaining.length}`)
  }
  console.log(`RESIDUAL: users=${created.users.length} workspaces=${created.companies.length} (uploads, certifications, lifecycle and grant events are kept as audit history; staging only)`)
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
