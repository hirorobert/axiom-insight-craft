#!/usr/bin/env node
/**
 * SAFF RLS Regression Suite
 * ─────────────────────────────────────────────────────────────────────────────
 * Automated cross-tenant + cross-role isolation tests.
 *
 * Creates three throwaway users:
 *   - userA: owner of Company A
 *   - userB: owner of Company B
 *   - userV: viewer member of Company A (added via firm_members)
 *
 * Then asserts that:
 *   1. Cross-tenant SELECT returns zero rows for every sensitive table.
 *   2. Cross-tenant INSERT/UPDATE is rejected on every sensitive table.
 *   3. Storage objects under `<userA.id>/…` are unreadable/unwritable by others.
 *   4. Role gates hold: viewers cannot read AJEs, sign-offs, tax_losses,
 *      capital_allowances; preparers cannot approve AJEs or complete sign-offs.
 *   5. `maono_monitor_runs` is unreadable by any tenant user (service_role only).
 *   6. Owner path is unblocked (no false positives).
 *
 * Cleans up all created rows/users regardless of pass/fail.
 *
 * WRITE-CAPABLE: this suite creates users, companies and rows in the Supabase
 * project it targets. It therefore refuses to run unless a STAGING project is
 * explicitly configured and verified (scripts/ci/stagingGuard.mjs), and it
 * never reads the generic SUPABASE_URL / SUPABASE_*_KEY variables, so a shell
 * that happens to hold production credentials cannot point it at production.
 *
 * ENV (all required):
 *   STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY, STAGING_SUPABASE_SERVICE_ROLE_KEY,
 *   STAGING_SUPABASE_PROJECT_REF   (the explicit expected staging project reference)
 *
 * Usage:
 *   node scripts/rls_regression.mjs
 *   → exit 0 on all-pass, 1 on any failure (including a refused target).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createClient } from '@supabase/supabase-js'
import { StagingGuardError, assertStagingTargetFromEnv } from './ci/stagingGuard.mjs'

// Fail-closed guard: runs before ANY client exists, so nothing can be written to an unverified project.
try {
  assertStagingTargetFromEnv()
} catch (err) {
  const code = err instanceof StagingGuardError ? err.code : 'GUARD_ERROR'
  const message = err instanceof StagingGuardError ? err.message : 'The staging guard failed unexpectedly.'
  console.error(`RLS regression refused to run [${code}]: ${message}`)
  process.exit(1)
}

const SUPABASE_URL      = process.env.STAGING_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.STAGING_SUPABASE_ANON_KEY
const SERVICE_ROLE_KEY  = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error('Missing STAGING_SUPABASE_URL / STAGING_SUPABASE_ANON_KEY / STAGING_SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const TS         = Date.now()
const PASSWORD   = 'RlsRegression!99xZ'
const A_EMAIL    = `rls-a-${TS}@test-saff.invalid`
const B_EMAIL    = `rls-b-${TS}@test-saff.invalid`
const V_EMAIL    = `rls-v-${TS}@test-saff.invalid`

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const anon = () => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

let passed = 0, failed = 0
const failures = []
const pass = (l) => { console.log(`  ✓  ${l}`); passed++ }
const fail = (l, d = '') => { console.error(`  ✗  ${l}${d ? `\n     → ${d}` : ''}`); failed++; failures.push(l) }
const section = (t) => console.log(`\n── ${t}`)

async function createUser(email) {
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  })
  if (error) throw new Error(`createUser(${email}): ${error.message}`)
  return data.user
}

async function signIn(email) {
  const c = anon()
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`signIn(${email}): ${error.message}`)
  return c
}

/**
 * Assert that a SELECT against `table` filtered by `column`=`value` returns
 * either an RLS error or zero rows.
 */
async function assertNoRead(client, table, filter, label) {
  const q = client.from(table).select('*', { count: 'exact', head: false })
  for (const [k, v] of Object.entries(filter)) q.eq(k, v)
  const { data, error } = await q
  if (error) return pass(`${label} — read rejected (${error.code || 'err'})`)
  if (!data || data.length === 0) return pass(`${label} — read returned 0 rows`)
  fail(`${label} — read leaked ${data.length} row(s)`)
}

/**
 * Assert that an INSERT is rejected (either RLS error or 0-row insert).
 */
async function assertNoWrite(client, table, row, label) {
  const { data, error } = await client.from(table).insert(row).select()
  if (error) return pass(`${label} — insert rejected (${error.code || 'err'})`)
  if (!data || data.length === 0) return pass(`${label} — insert returned 0 rows`)
  fail(`${label} — insert accepted (${data.length} row)`, JSON.stringify(row))
}

async function run() {
  console.log('═══════════════════════════════════════════════')
  console.log(' SAFF RLS Regression Suite')
  console.log('═══════════════════════════════════════════════')

  let userA, userB, userV, cA, cB, cV
  let companyAId, companyBId, uploadAId, ajeAId, ssoAId
  let storagePathA
  let completedAllChecks = false

  try {
    // ─── Setup ──────────────────────────────────────────────────────────────
    section('Setup')
    userA = await createUser(A_EMAIL); pass(`created owner A (${userA.id})`)
    userB = await createUser(B_EMAIL); pass(`created owner B (${userB.id})`)
    userV = await createUser(V_EMAIL); pass(`created viewer V (${userV.id})`)
    cA = await signIn(A_EMAIL); pass('A signed in')
    cB = await signIn(B_EMAIL); pass('B signed in')
    cV = await signIn(V_EMAIL); pass('V signed in')

    // Companies (owner-membership auto-created via create_owner_firm_member trigger)
    const seedCompany = async (client, name, ownerId) => {
      const { data, error } = await client.from('companies').insert({
        name, user_id: ownerId, fiscal_year_end: '12-31', currency: 'TZS',
      }).select('id').single()
      if (error) throw new Error(`seed company ${name}: ${error.message}`)
      return data.id
    }
    companyAId = await seedCompany(cA, `Co A ${TS}`, userA.id); pass(`co A ${companyAId}`)
    companyBId = await seedCompany(cB, `Co B ${TS}`, userB.id); pass(`co B ${companyBId}`)

    // Add V to Co A as viewer (service role bypasses RLS, accepted_at set)
    const { error: memberErr } = await admin.from('firm_members').insert({
      company_id: companyAId, user_id: userV.id, role: 'viewer', accepted_at: new Date().toISOString(),
    })
    if (memberErr) throw new Error(`add viewer: ${memberErr.message}`)
    pass('V added to Co A as viewer')

    // Seed a TB upload + AJE + sign-off under Co A (owner A)
    const csv = 'account_code,account_name,debit,credit\n1000,Cash,1000,0'
    storagePathA = `${userA.id}/rls_${TS}.csv`
    const { error: storErr } = await cA.storage.from('trial-balance-files')
      .upload(storagePathA, new Blob([csv], { type: 'text/csv' }))
    if (storErr) throw new Error(`seed storage: ${storErr.message}`)
    pass('seed storage file')

    // user_id is required: it is the sole PERMISSIVE INSERT policy's WITH CHECK
    // ("Users can insert their own uploads" — auth.uid() = user_id). The separate
    // RESTRICTIVE company-ownership policy is ANDed on top, not a substitute for it.
    // Matches the real upload path (src/components/TrialBalanceUpload.tsx: user_id: user!.id).
    const { data: up, error: upErr } = await cA.from('trial_balance_uploads').insert({
      file_name: 'rls.csv', file_path: storagePathA, file_size: csv.length,
      status: 'pending', company_id: companyAId, user_id: userA.id,
    }).select('id').single()
    if (upErr) throw new Error(`seed upload: ${upErr.message}`)
    uploadAId = up.id; pass(`seed upload ${uploadAId}`)

    // Column set matches the live schema (information_schema.columns), not the table's original
    // design — entry_date/reference/total_debit/total_credit do not exist on this table; the real
    // columns are period_year/aje_number/aje_type/source/auto_generated (all NOT NULL).
    const { data: aje, error: ajeErr } = await cA.from('adjusting_journal_entries').insert({
      company_id: companyAId, upload_id: uploadAId, period_year: 2025,
      aje_number: `RLS-${TS}`, description: 'regression', aje_type: 'correction',
      source: 'cpa_manual', auto_generated: false, status: 'draft', created_by: userA.id,
    }).select('id').single()
    if (ajeErr) throw new Error(`seed aje: ${ajeErr.message}`)
    ajeAId = aje.id; pass(`seed aje ${ajeAId}`)

    // statement_type does not exist on this table; upload_id is NOT NULL and was missing.
    const { data: sso, error: ssoErr } = await cA.from('statement_sign_offs').insert({
      company_id: companyAId, period_year: 2025, upload_id: uploadAId, status: 'draft',
    }).select('id').single()
    if (ssoErr) throw new Error(`seed sso: ${ssoErr.message}`)
    ssoAId = sso.id; pass(`seed sso ${ssoAId}`)

    // ─── 1. Cross-tenant SELECT isolation ──────────────────────────────────
    section('Cross-tenant reads (B must see none of A)')
    const tenantTables = [
      ['trial_balance_uploads',      { id: uploadAId }],
      ['adjusting_journal_entries',  { id: ajeAId }],
      ['statement_sign_offs',        { id: ssoAId }],
      ['companies',                  { id: companyAId }],
      ['account_corrections',        { upload_id: uploadAId }],
      ['tax_losses',                 { company_id: companyAId }],
      ['capital_allowances',         { company_id: companyAId }],
      ['findings',                   { company_id: companyAId }],
      ['evidence_requests',          { company_id: companyAId }],
      ['maono_insights',             { company_id: companyAId }],
      ['board_packs',                { company_id: companyAId }],
      ['variance_runs',              { company_id: companyAId }],
      ['variance_alerts',            { company_id: companyAId }],
      ['safisha_reconciliations',    { company_id: companyAId }],
      ['safisha_exceptions',         { company_id: companyAId }],
      ['firm_members',               { company_id: companyAId }],
      ['ingestion_batches',          { company_id: companyAId }],
      ['canonical_financial_records',{ company_id: companyAId }],
    ]
    for (const [tbl, filt] of tenantTables) {
      await assertNoRead(cB, tbl, filt, `B → ${tbl}`)
    }

    // ─── 2. Cross-tenant WRITE isolation ───────────────────────────────────
    section('Cross-tenant writes (B cannot target Co A)')
    // user_id: userB.id makes this a self-consistent insert attempt (B genuinely acting as
    // themselves) that is rejected ONLY because company_id targets A's company — isolating
    // exactly the cross-tenant invariant this assertion's own label claims to test. Without it,
    // this would pass for the wrong reason (the missing-user_id PERMISSIVE-policy gap fixed
    // above), not because of the RESTRICTIVE company-ownership policy.
    await assertNoWrite(cB, 'trial_balance_uploads', {
      file_name: 'evil.csv', file_path: `${userB.id}/evil.csv`, file_size: 1,
      status: 'pending', company_id: companyAId, user_id: userB.id,
    }, 'B → tb_upload with A.company_id')

    // Column set matches the live schema — see the seed insert above for why.
    await assertNoWrite(cB, 'adjusting_journal_entries', {
      company_id: companyAId, period_year: 2024, aje_number: 'X',
      description: 'x', aje_type: 'correction', source: 'cpa_manual',
      auto_generated: false, status: 'draft', created_by: userB.id,
    }, 'B → aje with A.company_id')

    // statement_type does not exist; upload_id is NOT NULL. Deliberately points at A's OWN upload
    // (uploadAId) — B has no upload of their own here — so this still isolates the company_id
    // dimension: the FK to trial_balance_uploads is satisfiable, only the company boundary is not.
    await assertNoWrite(cB, 'statement_sign_offs', {
      company_id: companyAId, period_year: 2024, upload_id: uploadAId, status: 'draft',
    }, 'B → sign_off with A.company_id')

    await assertNoWrite(cB, 'findings', {
      company_id: companyAId, finding_type: 'manual', severity: 'low',
      title: 'X', period_start: '2025-01-01', period_end: '2025-12-31',
      exposure_amount_tzs: 0, source_detail: 'rls regression', status: 'open',
      response_pack_ready: false, created_by: userB.id,
    }, 'B → finding with A.company_id')

    // ─── 3. Storage isolation ───────────────────────────────────────────────
    section('Storage isolation')
    const { error: dlErr } = await cB.storage.from('trial-balance-files').download(storagePathA)
    dlErr ? pass('B blocked from downloading A file') : fail('B downloaded A file')

    const { error: ovErr } = await cB.storage.from('trial-balance-files')
      .upload(storagePathA, new Blob(['x']), { upsert: true })
    ovErr ? pass('B blocked from overwriting A file') : fail('B overwrote A file')

    // ─── 4. Role gates within Co A ─────────────────────────────────────────
    section('Role gates — viewer V in Co A cannot access privileged tables')
    // Viewer should NOT see AJE, sign-off, tax_losses, capital_allowances
    await assertNoRead(cV, 'adjusting_journal_entries', { id: ajeAId }, 'V → aje')
    await assertNoRead(cV, 'statement_sign_offs',       { id: ssoAId }, 'V → sso')
    await assertNoRead(cV, 'tax_losses',                { company_id: companyAId }, 'V → tax_losses')
    await assertNoRead(cV, 'capital_allowances',        { company_id: companyAId }, 'V → cap_allowances')

    // Viewer cannot insert AJE — column set matches the live schema, see the seed insert above.
    await assertNoWrite(cV, 'adjusting_journal_entries', {
      company_id: companyAId, upload_id: uploadAId, period_year: 2025, aje_number: 'V-X',
      description: 'x', aje_type: 'correction', source: 'cpa_manual',
      auto_generated: false, status: 'draft', created_by: userV.id,
    }, 'V → aje insert')

    // Viewer cannot sign off
    const { error: ssoWriteErr } = await cV.from('statement_sign_offs')
      .update({ preparer_signed_at: new Date().toISOString(), preparer_id: userV.id })
      .eq('id', ssoAId).select()
    // Update on unreadable row returns 0 rows silently — assert nothing changed
    const { data: ssoAfter } = await admin.from('statement_sign_offs')
      .select('preparer_signed_at').eq('id', ssoAId).single()
    ssoAfter?.preparer_signed_at
      ? fail('V mutated sign_off preparer_signed_at')
      : pass('V blocked from signing off (unchanged)')

    // ─── 5. Service-role-only table ────────────────────────────────────────
    section('Service-role-only tables')
    await assertNoRead(cA, 'maono_monitor_runs', { }, 'owner A → maono_monitor_runs')
    await assertNoRead(cV, 'maono_monitor_runs', { }, 'viewer V → maono_monitor_runs')

    // ─── 6. Sanity: owner A retains full access ────────────────────────────
    section('Sanity — owner A can still read own data')
    const check = async (tbl, filt, label) => {
      const q = cA.from(tbl).select('id')
      for (const [k, v] of Object.entries(filt)) q.eq(k, v)
      const { data, error } = await q
      if (error) fail(`${label} — owner blocked: ${error.message}`)
      else if (!data.length) fail(`${label} — owner sees 0 rows`)
      else pass(`${label} — owner sees ${data.length}`)
    }
    await check('trial_balance_uploads',     { id: uploadAId }, 'A → own tb_upload')
    await check('adjusting_journal_entries', { id: ajeAId },    'A → own aje')
    await check('statement_sign_offs',       { id: ssoAId },    'A → own sso')
    await check('companies',                 { id: companyAId },'A → own company')

    completedAllChecks = true
  } finally {
    // ─── Cleanup ────────────────────────────────────────────────────────────
    // Every step below checks its own error instead of relying on a single try/catch around the
    // whole block — a swallowed error here previously let this section print "cleanup complete"
    // while a company + its owner firm_member row were silently left behind (trg_prevent_last_owner_delete
    // refuses to delete a company's sole owner row; hard-deleting companyA/B is therefore never
    // possible while their auto-created owner membership exists — this is a genuine, permanent
    // product invariant, not something this script bypasses). The correct removal path is the
    // product's own soft-delete (companies.is_active = false), matching how a real company is
    // retired; anything that CAN be hard-deleted (child financial rows, the viewer's non-owner
    // membership, audit logs, the non-owning viewer's auth user) still is.
    section('Cleanup')
    const cleanupIssues = []
    const noteIssue = (label, error) => { if (error) cleanupIssues.push(`${label}: ${error.message}`) }

    if (storagePathA) {
      const { error } = await admin.storage.from('trial-balance-files').remove([storagePathA])
      noteIssue('remove storage object', error)
    }
    if (companyAId) {
      noteIssue('delete sign_offs (Co A)', (await admin.from('statement_sign_offs').delete().eq('company_id', companyAId)).error)
      noteIssue('delete aje (Co A)', (await admin.from('adjusting_journal_entries').delete().eq('company_id', companyAId)).error)
      noteIssue('delete uploads (Co A)', (await admin.from('trial_balance_uploads').delete().eq('company_id', companyAId)).error)
      // Only the non-owner membership can be hard-deleted; the owner row stays with the company.
      noteIssue('delete viewer membership (Co A)', (await admin.from('firm_members').delete().eq('company_id', companyAId).neq('role', 'owner')).error)
      noteIssue('deactivate Co A', (await admin.from('companies').update({ is_active: false }).eq('id', companyAId)).error)
    }
    if (companyBId) {
      noteIssue('deactivate Co B', (await admin.from('companies').update({ is_active: false }).eq('id', companyBId)).error)
    }
    for (const [label, u] of [['A', userA], ['B', userB], ['V', userV]]) {
      if (!u?.id) continue
      noteIssue(`delete audit_logs (${label})`, (await admin.from('audit_logs').delete().eq('user_id', u.id)).error)
      // A and B remain the sole owner of their (now inactive) company and cannot be deleted for
      // the same reason the company cannot be hard-deleted — expected, not a cleanup failure.
      if (label === 'V') {
        const { error } = await admin.auth.admin.deleteUser(u.id)
        noteIssue('delete user V', error)
      }
    }

    if (cleanupIssues.length === 0) {
      console.log('  cleanup complete')
    } else {
      console.warn('  cleanup incomplete — retained by design (owner accounts A/B tied to their now-inactive companies) or genuine failures:')
      for (const issue of cleanupIssues) console.warn(`    • ${issue}`)
    }

    console.log('\n═══════════════════════════════════════════════')
    console.log(`Results: ${passed} passed, ${failed} failed`)
    if (!completedAllChecks) {
      // A setup/assertion step threw before the suite reached its end. This finally block is
      // running while that original exception is still in flight — neither process.exit() NOR
      // return/throw may appear anywhere in this branch: in JavaScript, any completion of a
      // finally block other than falling off its end (a return, a throw, or process.exit()
      // terminating synchronously) silently DISCARDS a pending exception from the try block. Only
      // a message is printed here; control must fall through so run().catch() below still receives
      // and reports the real error and sets exit code 1. The partial pass count above is not a
      // verdict, so no success/failure message is printed for it either.
      console.error('\nSuite did not complete — a step threw before every check ran. See the error below.')
    } else if (failed > 0) {
      console.error('\nFAILURES:')
      failures.forEach(f => console.error(`  • ${f}`))
      process.exitCode = 1
    } else {
      console.log('All RLS regression checks passed.')
    }
  }
}

run().catch(err => {
  console.error('\nUnexpected error:', err.message ?? err)
  process.exit(1)
})