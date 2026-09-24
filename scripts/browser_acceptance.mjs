#!/usr/bin/env node
/**
 * Staging browser acceptance (PR #32) — the authenticated UI journeys, automated and repeatable.
 *
 * Runs ONLY against the configured STAGING project (scripts/ci/stagingGuard.mjs runs before any client or browser
 * exists; production is refused by construction). It:
 *   1. verifies the tested commit (GITHUB_SHA, and the PR head when PR_NUMBER is given);
 *   2. builds the real frontend for staging with NO .env file readable, and verifies the bundle names staging and
 *      never production (scripts/browser-acceptance/stagingFrontend.mjs);
 *   3. creates disposable, run-specific identities server-side (owner, grant-only collaborator, unrelated user)
 *      with random passwords that are typed into the real sign-in form and never printed;
 *   4. drives headless Chrome (scripts/browser-acceptance/cdp.mjs) through the owner, collaborator and isolation
 *      journeys and a responsive/accessibility pass at 320/375/768/1440 px, saving screenshots as artifacts;
 *   5. proves no request reached production, cleans up (never bypassing append-only rules) and fails closed.
 *
 * ENV: STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY, STAGING_SUPABASE_SERVICE_ROLE_KEY, STAGING_SUPABASE_PROJECT_REF,
 *      ARTIFACT_DIR (default artifacts/browser-acceptance), PR_NUMBER (optional), GITHUB_SHA (in CI).
 */

import { createClient } from '@supabase/supabase-js'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StagingGuardError, assertStagingTargetFromEnv, PRODUCTION_PROJECT_REF, parseProjectRef } from './ci/stagingGuard.mjs'

try {
  assertStagingTargetFromEnv()
} catch (err) {
  console.error(`browser acceptance refused to run [${err instanceof StagingGuardError ? err.code : 'GUARD_ERROR'}]`)
  process.exit(1)
}

const { Browser } = await import('./browser-acceptance/cdp.mjs')
const { buildStagingFrontend, serveStagingFrontend } = await import('./browser-acceptance/stagingFrontend.mjs')
const { classifyRequests, layoutProblems, headerProblems } = await import('./browser-acceptance/checks.mjs')

const URL_ = process.env.STAGING_SUPABASE_URL
const ANON = process.env.STAGING_SUPABASE_ANON_KEY
const SERVICE = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY
const STAGING_REF = parseProjectRef(URL_)
const ART = path.resolve(process.env.ARTIFACT_DIR ?? 'artifacts/browser-acceptance')
const TS = `${Date.now()}-${randomBytes(3).toString('hex')}`
const BUCKET = 'trial-balance-files'
const VIEWPORTS = [[320, 720], [375, 812], [768, 1024], [1440, 900]]
const opts = { auth: { autoRefreshToken: false, persistSession: false } }
const svc = createClient(URL_, SERVICE, opts)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── results ─────────────────────────────────────────────────────────────────────────────────────
const results = []
let group = ''
const section = (n) => { group = n; console.log(`\n== ${n}`) }
function record(name, ok, detail = '') {
  results.push({ group, name, ok, detail: ok ? '' : detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`)
}
let currentPage = null
async function check(name, fn) {
  try {
    const r = await fn()
    record(name, r === true, r === true ? '' : `assertion returned ${JSON.stringify(r)}`)
  } catch (e) {
    record(name, false, String(e?.message ?? e).split('\n')[0])
    if (currentPage) {
      const slug = name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
      await currentPage.screenshot(path.join(ART, 'failures', `${slug}.png`)).catch(() => {})
      const text = await currentPage.bodyText().catch(() => '')
      const toasts = await currentPage.evaluate(() => document.querySelector('[data-sonner-toaster]')?.outerHTML ?? 'no toasts').catch(() => '')
      fs.mkdirSync(path.join(ART, 'failures'), { recursive: true })
      fs.writeFileSync(path.join(ART, 'failures', `${slug}.txt`), `${await currentPage.url().catch(() => '')}\n\n${text.slice(0, 4000)}\n\n--- toasts ---\n${String(toasts).slice(0, 3000)}`)
    }
  }
}

// ── tested commit ──────────────────────────────────────────────────────────────────────────────
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()
const TESTED_COMMIT = git('rev-parse', 'HEAD')
function assertTestedCommit() {
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== TESTED_COMMIT) throw new Error('tested commit differs from GITHUB_SHA')
  const pr = process.env.PR_NUMBER
  if (pr) {
    if (!/^\d+$/.test(pr)) throw new Error('PR_NUMBER is not a number')
    const line = git('ls-remote', 'origin', `refs/pull/${pr}/head`)
    const head = line.split(/\s+/)[0]
    if (!head || head !== TESTED_COMMIT) throw new Error(`tested commit ${TESTED_COMMIT.slice(0, 7)} differs from PR #${pr} head ${(head || 'unknown').slice(0, 7)}`)
  }
  return true
}

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────
const created = { users: [], companies: new Set(), ownerOf: new Map() }
async function makeIdentity(label) {
  const email = `browser-${label}-${TS}@test-saff.invalid`
  const password = `${randomBytes(18).toString('base64url')}!9aZ`
  const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw new Error(`createUser(${label}): ${error.message}`)
  created.users.push(data.user.id)
  const api = createClient(URL_, ANON, opts)
  const { error: signErr } = await api.auth.signInWithPassword({ email, password })
  if (signErr) throw new Error(`api sign-in(${label}): ${signErr.message}`)
  return { id: data.user.id, email, password, api }
}
const rpc = async (who, name, args) => {
  const { data, error } = await who.api.rpc(name, args)
  if (error) throw Object.assign(new Error(`${name}: ${error.message}`), { code: error.code })
  return Array.isArray(data) ? data[0] : data
}

const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), 'cfoclose-tb-'))
const VALID_TB = fs.readFileSync(new URL('../KAMANGA_MEDICS_TB_2025.csv', import.meta.url), 'utf8')
const IMBALANCE = 12345
// The same trial balance with ONE debit raised by exactly IMBALANCE: debits exceed credits by 12,345.00.
const UNBALANCED_TB = VALID_TB.replace(/^A002,([^,]*),(\d+),(\r?)$/m, (_m, name, dr, cr) => `A002,${name},${Number(dr) + IMBALANCE},${cr}`)
if (UNBALANCED_TB === VALID_TB) throw new Error('could not derive the unbalanced fixture')
let fileSeq = 0
function fixture(kind) {
  const f = path.join(FIXTURES, `${kind}-${TS}-${++fileSeq}.csv`)
  fs.writeFileSync(f, kind === 'unbalanced' ? UNBALANCED_TB : VALID_TB)
  return f
}

// The browser's own upload path, run server-side for the states the UI cannot create directly (an unprocessed upload):
// reserve → signed single-object upload (deployed signer) → register. Same RPCs, same authority, same JWT.
async function unprocessedUpload(who, company, period) {
  const r = await rpc(who, 'reserve_trial_balance_source', { p_company_id: company, p_file_name: `unprocessed-${TS}.csv` })
  if (r?.outcome !== 'reserved') throw new Error(`reserve: ${r?.outcome}`)
  const { data: s, error: sErr } = await who.api.functions.invoke('trial-balance-source-signer', { body: { reservation_id: r.reservation_id } })
  if (sErr || s?.outcome !== 'signed') throw new Error('signer refused')
  const { error: upErr } = await who.api.storage.from(BUCKET).uploadToSignedUrl(s.path, s.token, new Blob([VALID_TB], { type: 'text/csv' }))
  if (upErr) throw new Error(`upload: ${upErr.message}`)
  const g = await rpc(who, 'register_trial_balance_upload', { p_reservation_id: r.reservation_id, p_file_size: VALID_TB.length, p_period_year: period, p_period_id: null, p_engagement_id: null })
  if (g?.outcome !== 'registered') throw new Error(`register: ${g?.outcome}`)
  return { id: g.upload_id, path: s.path }
}

const uploadRow = async (id) => (await svc.from('trial_balance_uploads').select('*').eq('id', id).maybeSingle()).data
const activeUpload = async (company, period) => (await svc.from('trial_balance_uploads').select('*').eq('company_id', company).eq('period_year', period)
  .in('lifecycle_state', ['active_unprocessed', 'active_processing', 'active_processed', 'blocked']).maybeSingle()).data
async function waitProcessed(company, period, { notId = null, timeout = 90000 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const u = await activeUpload(company, period)
    if (u && u.id !== notId && ['active_processed', 'blocked'].includes(u.lifecycle_state)) return u
    await sleep(1500)
  }
  throw new Error(`no processed upload for ${period} within ${timeout / 1000}s`)
}
async function objectId(p) {
  const dir = p.split('/').slice(0, -1).join('/')
  const name = p.split('/').pop()
  const { data } = await svc.storage.from(BUCKET).list(dir, { search: name })
  return (data ?? []).find((o) => o.name === name)?.id ?? null
}

// ── UI helpers ─────────────────────────────────────────────────────────────────────────────────
let ORIGIN = ''
const pages = []
async function openAs(browser, who) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  pages.push(page)
  await page.setViewport(1440, 900)
  if (who) {
    await page.goto(`${ORIGIN}/auth`)
    await page.fill('#email', who.email)
    await page.fill('#password', who.password)
    await page.click('button[type=submit]')
    await page.waitFor(() => !location.pathname.startsWith('/auth') && location.pathname !== '/', [], { label: 'leave sign-in', timeout: 45000 })
  }
  return page
}
const hasTestId = (page, id) => page.evaluate((t) => !!document.querySelector(`[data-testid="${t}"]`), id)
// What is on screen around the toast action: every toast button with its box, and what element is actually hit at
// the Undo button's centre (a covered button is exactly the defect this would reveal).
function undoDiagnostics(page) {
  return page.evaluate(() => {
    const bs = [...document.querySelectorAll('[data-sonner-toaster] button')]
    const info = bs.map((b) => { const r = b.getBoundingClientRect(); return `${b.innerText.trim() || b.getAttribute('aria-label')}@${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` })
    const undo = bs.find((b) => b.innerText.trim() === 'Undo')
    let hit = 'n/a'
    if (undo) { const r = undo.getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); hit = el ? `${el.tagName} "${(el.innerText || '').slice(0, 20)}"` : 'none' }
    return JSON.stringify({ buttons: info, hitAtUndo: hit, vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight })
  }).catch((e) => `diag failed: ${e.message}`)
}

async function openProcessingDetails(page) {
  await page.click({ text: 'Evidence and processing details' })
  await page.waitForText('Trial Balance Integrity', { timeout: 20000 })
}

// ── the suite ──────────────────────────────────────────────────────────────────────────────────
async function main() {
  section('Target, commit and staging frontend')
  await check('tested commit is the requested head', () => assertTestedCommit())
  const outDir = path.join(os.tmpdir(), `cfoclose-staging-dist-${TS}`)
  await check('the frontend is built for staging only: no .env read, bundle names staging, never production', async () => {
    const { ref } = await buildStagingFrontend({ supabaseUrl: URL_, publishableKey: ANON, outDir })
    return ref === STAGING_REF && STAGING_REF !== PRODUCTION_PROJECT_REF
  })
  if (results.some((r) => !r.ok)) return
  const server = await serveStagingFrontend({ outDir, port: 4173 })
  ORIGIN = server.origin
  const browser = await Browser.launch()
  try {
    await journeys(browser)
  } finally {
    await browser.close()
    await server.close()
  }
}

async function journeys(browser) {
  const O = await makeIdentity('owner')
  const K = await makeIdentity('collab')
  const X = await makeIdentity('unrelated')

  // ── OWNER ────────────────────────────────────────────────────────────────────────────────────
  section('Owner journey')
  const op = await openAs(browser, O)
  currentPage = op
  let C = null
  let Y = null
  await check('1-2. owner signs in and creates a workspace through the first-run form', async () => {
    await op.waitForText('Set up your reporting workspace')
    await op.fill('#fr-org', `Browser Acceptance ${TS}`)
    await op.click('#fr-currency')
    await op.click({ text: 'TZS — Tanzanian Shilling' })
    await op.click({ text: 'Create workspace' })
    const href = await op.waitForUrl(/\/workspace\/[0-9a-f-]{36}\/\d{4}/)
    const m = href.match(/\/workspace\/([0-9a-f-]{36})\/(\d{4})/)
    C = m[1]; Y = Number(m[2]); created.companies.add(C); created.ownerOf.set(C, O)
    return true
  })
  if (!C) return
  const base = `${ORIGIN}/workspace/${C}/${Y}`
  let firstUpload = null
  await check('3. owner chooses a service, imports, and uploads a valid trial balance', async () => {
    await op.click('[data-testid="service-FINANCIAL_STATEMENTS"]')
    await op.click('[data-testid="primary-cta"]')
    await op.waitForSelector('[data-testid="data-choice-heading"]')
    await op.click('[data-testid="primary-cta"]')
    await op.waitForUrl(/\/prepare/)
    await op.setFiles('input[type=file][multiple]', [fixture('valid')])
    await op.click({ text: 'Process 1 File' })
    firstUpload = await waitProcessed(C, Y)
    return firstUpload.lifecycle_state === 'active_processed'
  })
  await check('4. processing and certification complete, and the page shows a balanced trial balance', async () => {
    const { count } = await svc.from('tb_certifications').select('id', { count: 'exact', head: true }).eq('upload_id', firstUpload.id)
    await op.goto(`${base}/prepare`)
    await openProcessingDetails(op)
    const text = await op.bodyText()
    return count >= 1 && text.includes('Debits equal credits') || `certs=${count}`
  })
  let unbalanced = null
  await check('5-6. owner replaces it with an unbalanced file: "Out of balance" and the exact 12,345.00 difference appear', async () => {
    await op.goto(`${base}/prepare`)
    await op.waitForText('Replace trial balance')
    await op.setFiles('input[type=file]:not([multiple])', [fixture('unbalanced')])
    unbalanced = await waitProcessed(C, Y, { notId: firstUpload.id })
    await op.goto(`${base}/prepare`)
    await openProcessingDetails(op)
    const text = await op.bodyText()
    const diff = unbalanced.processing_result?.validation_report?.tb_balance_check?.difference
    return text.includes('Out of balance') && text.includes('12,345.00') && Math.abs(Number(diff)) === IMBALANCE
      || `lifecycle=${unbalanced.lifecycle_state} diff=${diff}`
  })
  await check('7. Reconcile stays locked for the invalid source', async () => {
    await op.goto(`${base}/reconcile`)
    await op.waitForText('Reconcile is locked')
    return true
  })
  await check('8. Statements stay locked', async () => {
    await op.goto(`${base}/statements`)
    await op.waitForText('is locked')
    return !(await hasTestId(op, 'stage-access-boundary'))
  })
  let replacement = null
  await check('9-10. owner replaces the invalid source; the replacement is processed and balances', async () => {
    await op.goto(`${base}/prepare`)
    await op.waitForText('Replace trial balance')
    await op.setFiles('input[type=file]:not([multiple])', [fixture('valid')])
    replacement = await waitProcessed(C, Y, { notId: unbalanced.id })
    const old = await uploadRow(unbalanced.id)
    return replacement.lifecycle_state === 'active_processed' && replacement.replaces_upload_id === unbalanced.id && old.lifecycle_state === 'superseded'
  })
  const P2 = Y - 1
  let eligible = null
  await check('11. owner discards an eligible (unprocessed) upload through the dialog', async () => {
    eligible = await unprocessedUpload(O, C, P2)
    eligible.objectId = await objectId(eligible.path)
    await op.goto(`${base.replace(`/${Y}`, `/${P2}`)}/prepare`)
    await op.click({ text: 'Discard upload' })
    await op.waitForSettled('[role=alertdialog]')
    await op.click({ text: 'Discard upload', within: '[role=alertdialog]' })
    await op.waitFor(() => /discarded/i.test(document.querySelector('[data-sonner-toaster]')?.innerText ?? ''), [], { label: 'discard toast' })
    return !(await uploadRow(eligible.id))
  })
  await check('12. Undo (the toast action) restores the exact source: same row, same stored object', async () => {
    const before = await undoDiagnostics(op)
    await op.click({ text: 'Undo', within: '[data-sonner-toaster]' }, { timeout: 12000 })
    try {
      await op.waitForText('restored.')
    } catch (e) {
      const sent = op.responses.filter((r) => r.url.includes('/rpc/restore_trial_balance_upload')).map((r) => `${r.method} ${r.status}`)
      throw new Error(`${e.message}; before=${before}; restore requests=${JSON.stringify(sent)}; after=${await undoDiagnostics(op)}; errors=${JSON.stringify(op.consoleErrors.slice(-3))}`)
    }
    const row = await uploadRow(eligible.id)
    return row?.file_path === eligible.path && (await objectId(eligible.path)) === eligible.objectId || `row=${!!row}`
  })
  await check('13. repeated Undo (the same restore call, twice at once) duplicates nothing', async () => {
    const opId = (await svc.from('trial_balance_upload_operations').select('id').eq('upload_id', eligible.id).eq('kind', 'discard')
      .order('created_at', { ascending: false }).limit(1).single()).data.id
    const again = await Promise.all([0, 1].map(() => rpc(O, 'restore_trial_balance_upload', { p_operation_id: opId })))
    const { count } = await svc.from('trial_balance_uploads').select('id', { count: 'exact', head: true }).eq('company_id', C).eq('period_year', P2)
    return again.every((a) => a.outcome === 'already_restored') && count === 1 && (await objectId(eligible.path)) === eligible.objectId
      || `outcomes=${again.map((a) => a.outcome)} count=${count}`
  })
  await check('14. direct stage routes fail closed while authorization is still loading', async () => {
    const p = op
    await p.throttle(2500)
    await p.send('Page.navigate', { url: `${base}/tax` })
    const early = await p.waitFor(() => document.body && /Checking your access|Checking what/.test(document.body.innerText) && document.body.innerText, [], { label: 'loading guard', timeout: 20000 })
    const leaked = /Compute Tax is locked|isn.t shared with you|not included in this engagement/i.test(early)
    await p.throttle(0)
    // The owner engaged Financial Statements only: once authorization settles, Tax is out of scope — never its content.
    await p.waitForText('not included in this engagement', { timeout: 30000 })
    return !leaked
  })

  // ── COLLABORATOR ─────────────────────────────────────────────────────────────────────────────
  section('Collaborator journey (explicit grant, no firm membership)')
  await check('1. owner grants manage_source_files (the real owner-only RPC, with the owner session)', async () =>
    (await rpc(O, 'grant_workspace_capability', { p_company_id: C, p_grantee_user_id: K.id, p_capability: 'manage_source_files' })).outcome === 'granted')
  await check('2. the collaborator has no firm_members row', async () =>
    (await svc.from('firm_members').select('id', { count: 'exact', head: true }).eq('user_id', K.id)).count === 0)
  const kp = await openAs(browser, K)
  currentPage = kp
  await check('3-5. collaborator signs in and lands on the shared workspace\'s Prepare Data', async () => {
    const href = await kp.waitForUrl(new RegExp(`/workspace/${C}/\\d{4}/prepare`), { timeout: 45000 })
    await kp.waitForText('Trial balance preparation')
    return !!href
  })
  await check('4. the workspace appears under "Shared with you" in the hub, and opens Prepare from there', async () => {
    await kp.click('a[aria-label="CFOClose home"]')
    await kp.waitForSelector('[data-testid="shared-workspaces-list"]')
    const listed = await kp.evaluate((n) => document.querySelector('[data-testid="shared-workspaces-list"]').innerText.includes(n), `Browser Acceptance ${TS}`)
    await kp.click(`[data-testid="open-shared-${C}"]`)
    await kp.waitForUrl(new RegExp(`/workspace/${C}/\\d{4}/prepare`))
    return listed
  })
  const Pk = Y - 2
  const kbase = `${ORIGIN}/workspace/${C}/${Pk}`
  let kUpload = null
  await check('6. collaborator uploads and validates a trial balance (recorded as a workspace_user, no membership)', async () => {
    await kp.goto(`${kbase}/prepare`)
    await kp.setFiles('input[type=file][multiple]', [fixture('valid')])
    await kp.click({ text: 'Process 1 File' })
    await kp.waitForText('validated', { timeout: 90000 })
    kUpload = await waitProcessed(C, Pk)
    const { data: runs } = await svc.from('engine_runs').select('actor_type, actor_user_id, firm_member_id').eq('source_record_id', kUpload.id)
    return kUpload.user_id === K.id && kUpload.lifecycle_state === 'active_processed' && runs?.length > 0
      && runs.every((r) => r.actor_type === 'workspace_user' && r.actor_user_id === K.id && r.firm_member_id === null)
  })
  await check('6b. the evidence gate is left to Reconcile access (not opened for the collaborator, not bypassed)', async () => {
    const u = await uploadRow(kUpload.id)
    return !(await kp.bodyText()).includes('Safisha TB Verification') && u.safisha_status !== 'clean'
  })
  await check('7a. collaborator replaces their source', async () => {
    await kp.goto(`${kbase}/prepare`)
    await kp.waitForText('Replace trial balance')
    await kp.setFiles('input[type=file]:not([multiple])', [fixture('valid')])
    const r = await waitProcessed(C, Pk, { notId: kUpload.id })
    return r.replaces_upload_id === kUpload.id && r.user_id === K.id
  })
  const Pk2 = Y - 3
  await check('7b. collaborator discards an eligible upload and Undo restores it exactly', async () => {
    const e = await unprocessedUpload(K, C, Pk2)
    const obj = await objectId(e.path)
    await kp.goto(`${ORIGIN}/workspace/${C}/${Pk2}/prepare`)
    await kp.click({ text: 'Discard upload' })
    await kp.waitForSettled('[role=alertdialog]')
    await kp.click({ text: 'Discard upload', within: '[role=alertdialog]' })
    await kp.waitFor(() => /discarded/i.test(document.querySelector('[data-sonner-toaster]')?.innerText ?? ''), [], { label: 'discard toast' })
    const gone = !(await uploadRow(e.id))
    await kp.click({ text: 'Undo', within: '[data-sonner-toaster]' }, { timeout: 12000 })
    await kp.waitForText('restored.')
    return gone && (await uploadRow(e.id))?.file_path === e.path && (await objectId(e.path)) === obj
  })
  await check('8. the Overview redirects safely to Prepare', async () => {
    await kp.goto(`${ORIGIN}/workspace/${C}/${Y}`)
    await kp.waitForUrl(new RegExp(`/workspace/${C}/${Y}/prepare$`))
    return true
  })
  await check('8b. the stage navigation offers Prepare Data only', async () => {
    const links = await kp.evaluate((c, y) => [...document.querySelectorAll('nav a')].map((a) => a.getAttribute('href')).filter((h) => h && h.startsWith(`/workspace/${c}/${y}`)), C, Y)
    return JSON.stringify(links) === JSON.stringify([`/workspace/${C}/${Y}/prepare`]) || JSON.stringify(links)
  })
  for (const [n, stage] of [['9', 'reconcile'], ['10', 'statements'], ['10b', 'statements/review'], ['11', 'tax'], ['11', 'compliance'], ['11', 'filing'], ['11', 'monitor']]) {
    await check(`${n}. ${stage} is denied by direct URL (access boundary, never the stage)`, async () => {
      await kp.goto(`${ORIGIN}/workspace/${C}/${Y}/${stage}`)
      await kp.waitForSelector('[data-testid="stage-access-boundary"]')
      return !(await kp.bodyText()).includes(' is locked')
    })
  }
  await check('12a. billing administration is denied (server refuses; nothing administrable renders)', async () => {
    await kp.goto(`${ORIGIN}/commercial/admin`)
    await kp.waitForText('NOT_A_COMMERCIAL_ADMIN', { timeout: 20000 })
    const r = kp.responses.filter((x) => x.url.includes('/rpc/admin_list_commercial_offers') && x.method !== 'OPTIONS')
    return r.length > 0 && r.every((x) => x.status >= 400)
  })
  await check('12b. grant administration is denied to the collaborator, and no scope/grant control is offered to them', async () => {
    const g = await rpc(K, 'grant_workspace_capability', { p_company_id: C, p_grantee_user_id: X.id, p_capability: 'manage_source_files' })
    await kp.goto(`${ORIGIN}/workspace/${C}/${Y}/prepare`)
    await kp.waitForText('Trial balance preparation')
    return g.outcome === 'forbidden' && !(await kp.bodyText()).includes('Manage services')
  })
  await check('13. forged workspace, upload and operation identifiers are denied', async () => {
    await kp.goto(`${ORIGIN}/workspace/${randomUUID()}/${Y}/prepare`)
    await kp.waitForSelector('[data-testid="workspace-access-denied"]')
    const { error: cleanErr, data: cleanData } = await K.api.functions.invoke('trial-balance-storage-cleanup', { body: { operation_id: randomUUID() } })
    const status = cleanErr?.context?.status
    await op.goto(`${base}/prepare?upload=${randomUUID()}`)
    await op.waitForText('Trial balance preparation')
    return (status === 404 || cleanData?.outcome === 'stale_operation') || `cleanup=${status}`
  })

  // ── RESPONSIVE AND ACCESSIBILITY (before revocation, so every role's screens exist) ─────────────
  section('Responsive and accessibility (320 / 375 / 768 / 1440)')
  const anonPage = await openAs(browser, null)
  const xp = await openAs(browser, X)
  for (const [w, h] of VIEWPORTS) {
    await check(`${w}px: no horizontal overflow, no clipped actions, labelled fields, a clear workspace header; screenshots captured`, async () => {
      // Each screen is opened the way a person reaches it and captured only once its own proof is on screen.
      const shots = [
        { p: anonPage, name: 'sign-in', open: async (p) => { await p.goto(`${ORIGIN}/auth`); await p.waitForSelector('#email') } },
        { p: op, name: 'owner-prepare', header: true, open: async (p) => { await p.goto(`${base}/prepare`); await p.waitForText('Trial balance preparation') } },
        { p: kp, name: 'collaborator-prepare', header: true, open: async (p) => { await p.goto(`${ORIGIN}/workspace/${C}/${Pk}/prepare`); await p.waitForText('Trial balance preparation') } },
        { p: kp, name: 'collaborator-stage-boundary', header: true, open: async (p) => { await p.goto(`${ORIGIN}/workspace/${C}/${Y}/tax`); await p.waitForSelector('[data-testid="stage-access-boundary"]') } },
        // Signing in / landing with exactly one shared workspace and none of their own opens its Prepare stage directly
        // (the hub's single-workspace auto-open) — this screenshot proves THAT, not the hub.
        { p: kp, name: 'collaborator-sign-in-opens-shared-prepare', header: true, open: async (p) => {
          await p.goto(`${ORIGIN}/dashboard`)
          await p.waitForUrl(new RegExp(`/workspace/${C}/\\d{4}/prepare$`))
          await p.waitForText('Trial balance preparation')
        } },
        // The hub itself, reached through the explicit hub escape (the logo): "Shared with you" lists the workspace.
        { p: kp, name: 'collaborator-hub', open: async (p) => {
          await p.goto(`${ORIGIN}/workspace/${C}/${Pk}/prepare`)
          await p.waitForText('Trial balance preparation')
          await p.click('a[aria-label="CFOClose home"]')
          await p.waitForSelector('[data-testid="shared-workspaces-list"]')
          const listed = await p.evaluate((n) => document.querySelector('[data-testid="shared-workspaces-list"]').innerText.includes(n), `Browser Acceptance ${TS}`)
          if (!listed || !/\/dashboard$/.test(new URL(await p.url()).pathname)) throw new Error('the hub did not list the shared workspace')
        } },
        { p: xp, name: 'unrelated-denied', open: async (p) => { await p.goto(`${ORIGIN}/workspace/${C}/${Y}/prepare`); await p.waitForSelector('[data-testid="workspace-access-denied"]') } },
      ]
      const problems = []
      for (const shot of shots) {
        currentPage = shot.p
        await shot.p.setViewport(w, h)
        await shot.open(shot.p)
        await sleep(400)
        for (const pr of await shot.p.evaluate(layoutProblems)) problems.push(`${shot.name}: ${pr}`)
        if (shot.header) for (const pr of await shot.p.evaluate(headerProblems)) problems.push(`${shot.name} header: ${pr}`)
        await shot.p.screenshot(path.join(ART, `${w}px`, `${shot.name}.png`))
      }
      return problems.length === 0 || problems.slice(0, 6).join(' | ')
    })
    await check(`${w}px: the discard dialog puts the safe action first (DOM, screen, focus) and is usable by keyboard — opens with Enter, keeps focus inside, closes with Escape`, async () => {
      currentPage = op
      await op.setViewport(w, h)
      await op.goto(`${base.replace(`/${Y}`, `/${P2}`)}/prepare`)
      await op.waitForText('Discard upload')
      await op.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Discard upload')?.focus())
      await op.press('Enter')
      await op.waitForSettled('[role=alertdialog]')
      // The safe action comes first: in the DOM, on screen (on top when stacked, on the left in a row), and it
      // holds the initial focus; Tab then reaches the destructive action.
      const order = await op.evaluate(() => {
        const bs = [...document.querySelectorAll('[data-testid="discard-dialog-actions"] button')]
        const keep = bs.find((b) => b.innerText.trim() === 'Keep current upload')
        const discard = bs.find((b) => b.innerText.trim() === 'Discard upload')
        if (!keep || !discard) return { ok: false, why: 'actions missing' }
        const k = keep.getBoundingClientRect(), d = discard.getBoundingClientRect()
        const domFirst = !!(keep.compareDocumentPosition(discard) & Node.DOCUMENT_POSITION_FOLLOWING)
        const stacked = Math.abs(k.left - d.left) < 2 && Math.abs(k.top - d.top) > 2
        const visualFirst = stacked ? k.bottom <= d.top + 1 : k.right <= d.left + 1
        const focusedKeep = document.activeElement === keep
        return { ok: domFirst && visualFirst && focusedKeep, why: `dom=${domFirst} visual=${visualFirst} stacked=${stacked} focusKeep=${focusedKeep}` }
      })
      await op.press('Tab')
      const tabToDiscard = await op.evaluate(() => document.activeElement?.innerText?.trim() === 'Discard upload')
      const inside = []
      for (let i = 0; i < 6; i++) { await op.press('Tab'); inside.push(await op.evaluate(() => !!document.activeElement?.closest('[role=alertdialog]'))) }
      const fits = await op.evaluate(() => { const r = document.querySelector('[role=alertdialog]').getBoundingClientRect(); return r.left >= -1 && r.right <= document.documentElement.clientWidth + 1 && r.top >= -1 })
      await op.screenshot(path.join(ART, `${w}px`, 'owner-discard-dialog.png'))
      await op.press('Escape')
      await op.waitFor(() => !document.querySelector('[role=alertdialog]'), [], { label: 'dialog closed' })
      const stillThere = !!(await uploadRow(eligible.id))
      return order.ok && tabToDiscard && inside.every(Boolean) && fits && stillThere
        || `order=${order.why} tabToDiscard=${tabToDiscard} focusInside=${inside} fits=${fits} kept=${stillThere}`
    })
  }
  for (const p of [op, kp, xp]) await p.setViewport(1440, 900)

  // ── ISOLATION ─────────────────────────────────────────────────────────────────────────────────
  section('Isolation')
  currentPage = xp
  await check('an unrelated signed-in user cannot discover the workspace', async () => {
    await xp.goto(`${ORIGIN}/dashboard`)
    await xp.waitForText('Set up your reporting workspace')
    const text = await xp.bodyText()
    return !text.includes(`Browser Acceptance ${TS}`) && !(await hasTestId(xp, 'shared-workspaces-list'))
  })
  await check('an unrelated user cannot open it by direct URL (every stage)', async () => {
    for (const s of ['', '/prepare', '/reconcile', '/statements', '/tax']) {
      await xp.goto(`${ORIGIN}/workspace/${C}/${Y}${s}`)
      await xp.waitForSelector('[data-testid="workspace-access-denied"]')
    }
    return !(await xp.bodyText()).includes(`Browser Acceptance ${TS}`)
  })
  await check('an anonymous visitor is sent to sign-in, and the access RPC refuses anonymous callers', async () => {
    currentPage = anonPage
    await anonPage.setViewport(1440, 900)
    await anonPage.goto(`${ORIGIN}/workspace/${C}/${Y}/prepare`)
    await anonPage.waitForUrl(/\/auth/)
    const { error } = await createClient(URL_, ANON, opts).rpc('get_workspace_access', { p_company_id: C })
    return !!error
  })

  // ── REVOCATION ────────────────────────────────────────────────────────────────────────────────
  section('Revocation')
  currentPage = kp
  await check('14. revoking the grant removes the workspace on the next authorization read', async () => {
    const r = await rpc(O, 'revoke_workspace_capability', { p_company_id: C, p_grantee_user_id: K.id, p_capability: 'manage_source_files' })
    await kp.goto(`${ORIGIN}/workspace/${C}/${Y}/prepare`)
    await kp.waitForSelector('[data-testid="workspace-access-denied"]')
    await kp.goto(`${ORIGIN}/dashboard`)
    await kp.waitForText('Set up your reporting workspace')
    return r.outcome === 'revoked' && !(await hasTestId(kp, 'shared-workspaces-list'))
  })
}

// ── cleanup (never bypasses append-only protections) ──────────────────────────────────────────────
async function listAll(prefix) {
  const out = []
  const { data } = await svc.storage.from(BUCKET).list(prefix, { limit: 1000 })
  for (const e of data ?? []) {
    const p = `${prefix}/${e.name}`
    if (e.id) out.push(p); else out.push(...await listAll(p))
  }
  return out
}
async function cleanup() {
  section('Fixture cleanup')
  const report = { storageRemoved: 0, storageRemaining: 0, grantsRevoked: 0, companiesDeactivated: 0, usersSoftDeleted: 0, retained: [] }
  for (const c of created.companies) {
    // Temporary grants are revoked through the owner-only RPC with the owner's own session — the service role never
    // edits grant rows, so the grant audit trail stays intact.
    const owner = created.ownerOf.get(c)
    const { data: grants } = await svc.from('workspace_capability_grants').select('grantee_user_id, capability').eq('company_id', c).is('revoked_at', null)
    for (const g of grants ?? []) {
      const r = owner ? await rpc(owner, 'revoke_workspace_capability', { p_company_id: c, p_grantee_user_id: g.grantee_user_id, p_capability: g.capability }).catch(() => null) : null
      if (r?.outcome === 'revoked') report.grantsRevoked++
    }
    const { count: stillActive } = await svc.from('workspace_capability_grants').select('id', { count: 'exact', head: true }).eq('company_id', c).is('revoked_at', null)
    if (stillActive) report.retained.push(`active grant x${stillActive} (could not revoke)`)
    const objs = await listAll(`workspaces/${c}`)
    if (objs.length) {
      const { error } = await svc.storage.from(BUCKET).remove(objs)
      if (!error) report.storageRemoved += objs.length
    }
    report.storageRemaining += (await listAll(`workspaces/${c}`)).length
    const { error: deactErr } = await svc.from('companies').update({ is_active: false }).eq('id', c)
    if (!deactErr) report.companiesDeactivated++
  }
  for (const u of created.users) {
    const legacy = await listAll(u)
    if (legacy.length) { await svc.storage.from(BUCKET).remove(legacy); report.storageRemoved += legacy.length }
    report.storageRemaining += (await listAll(u)).length
    const { error } = await svc.auth.admin.deleteUser(u, true)
    if (!error) report.usersSoftDeleted++
    else report.retained.push(`user ${u.slice(0, 8)} (${error.message})`)
  }
  report.retained.push('uploads, certifications, engine runs, lifecycle and grant events (append-only audit history; companies soft-deleted)')
  fs.mkdirSync(ART, { recursive: true })
  fs.writeFileSync(path.join(ART, 'cleanup.json'), JSON.stringify(report, null, 2))
  console.log(`  storage removed=${report.storageRemoved} remaining=${report.storageRemaining} companies deactivated=${report.companiesDeactivated} users soft-deleted=${report.usersSoftDeleted}`)
  return report
}

// ── run ───────────────────────────────────────────────────────────────────────────────────────────
let ok = false
let cleanupReport = null
try {
  await main()
} catch (e) {
  record('suite completed without a fatal error', false, String(e?.message ?? e).split('\n')[0])
}
try {
  cleanupReport = await cleanup()
} catch (e) {
  record('fixture cleanup', false, String(e?.message ?? e).split('\n')[0])
}
section('Production and cleanup verdicts')
const allRequests = pages.flatMap((p) => p.requests)
const net = classifyRequests(allRequests, STAGING_REF)
record(`no request reached production (${allRequests.length} requests observed)`, net.production.length === 0, `${net.production.length} production request(s)`)
record('every Supabase request targeted the staging project', net.otherSupabase.length === 0, net.otherSupabase.slice(0, 3).join(', '))
record('cleanup left zero storage objects and no unexpected active grant', !!cleanupReport && cleanupReport.storageRemaining === 0
  && !cleanupReport.retained.some((r) => r.startsWith('active grant')), JSON.stringify(cleanupReport))
const shots = fs.existsSync(ART) ? fs.readdirSync(ART, { recursive: true }).filter((f) => String(f).endsWith('.png') && !String(f).startsWith('failures')) : []
record(`screenshots captured (${shots.length})`, shots.length >= VIEWPORTS.length * 8, `${shots.length} screenshot(s)`)

const failed = results.filter((r) => !r.ok)
fs.mkdirSync(ART, { recursive: true })
fs.writeFileSync(path.join(ART, 'results.json'), JSON.stringify({ testedCommit: TESTED_COMMIT, stagingRef: STAGING_REF, results, requestsObserved: allRequests.length, productionRequests: net.production.length }, null, 2))
console.log(`\n──────────────────────────────────────────\nTESTED_COMMIT=${TESTED_COMMIT}\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`)
ok = failed.length === 0
console.log(ok ? 'BROWSER_ACCEPTANCE: ALL PASSED' : 'BROWSER_ACCEPTANCE: FAILED')
process.exit(ok ? 0 : 1)
