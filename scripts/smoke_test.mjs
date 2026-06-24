#!/usr/bin/env node
/**
 * Axiom RLS Smoke Test
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests cross-user data isolation for trial_balance_uploads, account_corrections,
 * audit_logs, and storage — covering all four RLS fixes:
 *   Fix 1  storage bucket ownership (trial-balance-files)
 *   Fix 2  DEFAULT auth.uid() / user_id spoof prevention
 *   Fix 3  company_id must belong to the authenticated user
 *   Fix 4  account_corrections upload_id must belong to the authenticated user
 *
 * CREDENTIALS NEEDED (all from Supabase Dashboard → Project Settings → API):
 *   SUPABASE_URL             →  "Project URL"
 *   SUPABASE_ANON_KEY        →  "Project API keys" → anon / public
 *   SUPABASE_SERVICE_ROLE_KEY → "Project API keys" → service_role / secret
 *                              (click the eye icon to reveal it)
 *
 * HOW TO RUN:
 *   SUPABASE_URL=https://bvyivmmfjejbmqoydezk.supabase.co \
 *   SUPABASE_ANON_KEY=<your-anon-key> \
 *   SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key> \
 *   node scripts/smoke_test.mjs
 *
 *   or with bun:
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   bun scripts/smoke_test.mjs
 *
 * The script creates two throw-away test users, runs all checks, then deletes
 * everything it created regardless of whether tests pass or fail.
 *
 * Exit code 0 = all passed. Exit code 1 = one or more failures.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createClient } from '@supabase/supabase-js'

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL           = process.env.SUPABASE_URL
const SUPABASE_ANON_KEY      = process.env.SUPABASE_ANON_KEY
const SERVICE_ROLE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error(
    'Missing environment variables.\n' +
    'Required: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY'
  )
  process.exit(1)
}

const TIMESTAMP       = Date.now()
const TEST_PASSWORD   = 'AxiomSmoke!99xZ'
const USER_A_EMAIL    = `smoke-a-${TIMESTAMP}@test-axiom.invalid`
const USER_B_EMAIL    = `smoke-b-${TIMESTAMP}@test-axiom.invalid`

// ── Clients ───────────────────────────────────────────────────────────────────
const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function anonClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// ── Result tracking ───────────────────────────────────────────────────────────
let passed = 0
let failed = 0
const findings = []   // unexpected results worth reviewing even if not a hard fail

function pass(label) {
  console.log(`  ✓  ${label}`)
  passed++
}

function fail(label, detail = '') {
  console.error(`  ✗  ${label}`)
  if (detail) console.error(`     → ${detail}`)
  failed++
}

function note(label) {
  console.warn(`  ⚠  ${label}`)
  findings.push(label)
}

function section(title) {
  console.log(`\n── ${title}`)
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
async function createUser(email) {
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,     // skip email verification for test users
  })
  if (error) throw new Error(`createUser(${email}): ${error.message}`)
  return data.user
}

async function signIn(email) {
  const client = anonClient()
  const { error } = await client.auth.signInWithPassword({
    email,
    password: TEST_PASSWORD,
  })
  if (error) throw new Error(`signIn(${email}): ${error.message}`)
  return client   // client now holds the session internally
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('═══════════════════════════════════════════════')
  console.log(' Axiom RLS Smoke Test')
  console.log(`═══════════════════════════════════════════════`)
  console.log(`User A: ${USER_A_EMAIL}`)
  console.log(`User B: ${USER_B_EMAIL}`)

  let userA, userB, clientA, clientB
  // IDs we need to track for cleanup
  let companyAId, companyBId, uploadAId, correctionAId, storagePathA, storagePathB

  try {

    // ── Create test users ─────────────────────────────────────────────────────
    section('Setup')
    userA    = await createUser(USER_A_EMAIL); pass(`created User A  (${userA.id})`)
    userB    = await createUser(USER_B_EMAIL); pass(`created User B  (${userB.id})`)
    clientA  = await signIn(USER_A_EMAIL);     pass('User A signed in')
    clientB  = await signIn(USER_B_EMAIL);     pass('User B signed in')


    // ── Seed: User A creates all her data ─────────────────────────────────────
    section('Seed — User A')

    // Company (companies table still accepts explicit user_id — not changed in Fix 2)
    const { data: companyA, error: companyAErr } = await clientA
      .from('companies')
      .insert({ name: 'Company A (smoke)', user_id: userA.id, fiscal_year_end: '12-31', currency: 'USD' })
      .select('id').single()
    if (companyAErr) throw new Error(`seed company A: ${companyAErr.message}`)
    companyAId = companyA.id
    pass(`created company A  (${companyAId})`)

    // Storage file under User A's prefix
    const csv = 'account_code,account_name,debit,credit\n1000,Cash,1000,0'
    storagePathA = `${userA.id}/smoke_${TIMESTAMP}.csv`
    const { error: uploadStorageErrA } = await clientA.storage
      .from('trial-balance-files')
      .upload(storagePathA, new Blob([csv], { type: 'text/csv' }))
    if (uploadStorageErrA) throw new Error(`seed storage A: ${uploadStorageErrA.message}`)
    pass(`uploaded storage file  (${storagePathA})`)

    // trial_balance_uploads row — user_id set by DEFAULT auth.uid()
    const { data: uploadA, error: uploadAErr } = await clientA
      .from('trial_balance_uploads')
      .insert({
        file_name: 'smoke_a.csv',
        file_path: storagePathA,
        file_size: csv.length,
        status:    'pending',
        company_id: companyAId,
      })
      .select('id').single()
    if (uploadAErr) throw new Error(`seed upload A: ${uploadAErr.message}`)
    uploadAId = uploadA.id
    pass(`created trial_balance_upload  (${uploadAId})`)

    // account_corrections row — user_id set by DEFAULT auth.uid()
    const { data: corrA, error: corrAErr } = await clientA
      .from('account_corrections')
      .insert({
        upload_id:              uploadAId,
        account_code:           '1000',
        corrected_category:     'balanceSheet',
        corrected_subcategory:  'Assets - Current',
      })
      .select('id').single()
    if (corrAErr) throw new Error(`seed correction A: ${corrAErr.message}`)
    correctionAId = corrA.id
    pass(`created account_correction  (${correctionAId})`)

    // audit_log — user_id set by DEFAULT auth.uid()
    const { error: auditAErr } = await clientA
      .from('audit_logs')
      .insert({ action: 'upload_trial_balance', entity_type: 'trial_balance_upload', entity_id: uploadAId })
    if (auditAErr) throw new Error(`seed audit log A: ${auditAErr.message}`)
    pass('wrote audit_log')


    // ── Test: cross-user read isolation ───────────────────────────────────────
    section('READ isolation — User B should see nothing of User A\'s rows')

    const { data: ubUploads, error: ubUploadsErr } = await clientB
      .from('trial_balance_uploads').select('id').eq('id', uploadAId)
    if (ubUploadsErr)          fail('trial_balance_uploads SELECT errored unexpectedly', ubUploadsErr.message)
    else if (ubUploads.length) fail('User B can read User A\'s trial_balance_upload')
    else                       pass('trial_balance_uploads — User B sees 0 rows')

    const { data: ubCorrs, error: ubCorrsErr } = await clientB
      .from('account_corrections').select('id').eq('id', correctionAId)
    if (ubCorrsErr)           fail('account_corrections SELECT errored unexpectedly', ubCorrsErr.message)
    else if (ubCorrs.length)  fail('User B can read User A\'s account_correction')
    else                      pass('account_corrections — User B sees 0 rows')

    const { data: ubAudit, error: ubAuditErr } = await clientB
      .from('audit_logs').select('id').eq('entity_id', uploadAId)
    if (ubAuditErr)            fail('audit_logs SELECT errored unexpectedly', ubAuditErr.message)
    else if (ubAudit.length)   fail('User B can read User A\'s audit_log')
    else                       pass('audit_logs — User B sees 0 rows')


    // ── Test: cross-user storage read ─────────────────────────────────────────
    section('READ isolation — storage')

    const { error: storReadErr } = await clientB.storage
      .from('trial-balance-files').download(storagePathA)
    storReadErr
      ? pass('User B blocked from downloading User A\'s storage file')
      : fail('User B can download User A\'s storage file')


    // ── Test: cross-user write isolation ──────────────────────────────────────
    section('WRITE isolation — User B cannot write into User A\'s scope')

    // Fix 3: User B attempts upload with company_id pointing at User A's company
    const { error: fix3Err } = await clientB
      .from('trial_balance_uploads')
      .insert({
        file_name:  'attacker.csv',
        file_path:  `${userB.id}/attacker.csv`,
        file_size:  0,
        status:     'pending',
        company_id: companyAId,    // ← User A's company UUID
      })
    fix3Err
      ? pass('Fix 3: User B blocked from setting company_id to User A\'s company')
      : fail('Fix 3: POLICY MISS — User B set company_id to User A\'s company')

    // Fix 2 second-layer check: User B explicitly passes user_id = User A
    const { error: auditSpoofErr } = await clientB
      .from('audit_logs')
      .insert({
        user_id: userA.id,         // ← explicit spoof; RLS WITH CHECK should reject
        action:  'login',
      })
    auditSpoofErr
      ? pass('Fix 2: User B blocked from inserting audit_log with User A\'s user_id')
      : fail('Fix 2: POLICY MISS — User B inserted audit_log with User A\'s user_id')

    // Fix 4: User B attempts to insert a correction targeting User A's upload_id.
    // The RESTRICTIVE policy "corrections_upload_ownership_insert" checks that
    // upload_id IN (SELECT id FROM trial_balance_uploads WHERE user_id = auth.uid()).
    // User A's upload does not satisfy that for User B, so this must be rejected.
    const { error: corrWriteErr } = await clientB
      .from('account_corrections')
      .insert({
        upload_id:             uploadAId,   // ← User A's upload
        account_code:          '9999',
        corrected_category:    'balanceSheet',
        corrected_subcategory: 'Equity',
      })
    corrWriteErr
      ? pass('Fix 4: User B blocked from inserting correction targeting User A\'s upload')
      : fail('Fix 4: POLICY MISS — User B inserted correction targeting User A\'s upload')

    // User B attempts to upload a file to User A's storage path (upsert = overwrite)
    const { error: storWriteErr } = await clientB.storage
      .from('trial-balance-files')
      .upload(storagePathA, new Blob(['evil'], { type: 'text/csv' }), { upsert: true })
    storWriteErr
      ? pass('User B blocked from uploading to User A\'s storage path')
      : fail('User B overwrote User A\'s storage file')


    // ── Sanity: User B can operate on their own data (no false positives) ─────
    section('Sanity — User B can create their own data')

    const { data: companyB, error: companyBErr } = await clientB
      .from('companies')
      .insert({ name: 'Company B (smoke)', user_id: userB.id, fiscal_year_end: '12-31', currency: 'USD' })
      .select('id').single()
    if (companyBErr) {
      fail('User B cannot create their own company', companyBErr.message)
    } else {
      companyBId = companyB.id
      pass(`User B created own company  (${companyBId})`)
    }

    storagePathB = `${userB.id}/smoke_${TIMESTAMP}.csv`
    const { error: storBErr } = await clientB.storage
      .from('trial-balance-files')
      .upload(storagePathB, new Blob([csv], { type: 'text/csv' }))
    storBErr
      ? fail('User B cannot upload to their own storage path', storBErr.message)
      : pass('User B uploaded to their own storage path')

    const { error: ubOwnUploadErr } = await clientB
      .from('trial_balance_uploads')
      .insert({
        file_name:  'own.csv',
        file_path:  storagePathB || `${userB.id}/own.csv`,
        file_size:  csv.length,
        status:     'pending',
        company_id: companyBId,    // ← User B's own company — should be allowed
      })
    ubOwnUploadErr
      ? fail('Fix 3 false positive: User B blocked from using their own company_id', ubOwnUploadErr.message)
      : pass('Fix 3 sanity: User B can set company_id to their own company')

    const { error: ubAuditOwnErr } = await clientB
      .from('audit_logs')
      .insert({ action: 'login' })
    ubAuditOwnErr
      ? fail('User B cannot write their own audit_log', ubAuditOwnErr.message)
      : pass('User B can write their own audit_log')

  } finally {

    // ── Cleanup (runs even if tests fail or throw) ────────────────────────────
    section('Cleanup')

    // Storage files must be removed explicitly (not cascade-deleted with the user)
    if (storagePathA) {
      await adminClient.storage.from('trial-balance-files').remove([storagePathA])
      console.log(`  deleted storage ${storagePathA}`)
    }
    if (storagePathB) {
      await adminClient.storage.from('trial-balance-files').remove([storagePathB])
      console.log(`  deleted storage ${storagePathB}`)
    }

    // audit_logs and companies don't FK-cascade from auth.users — delete explicitly
    if (userA?.id) {
      await adminClient.from('audit_logs').delete().eq('user_id', userA.id)
      await adminClient.from('companies').delete().eq('user_id', userA.id)
    }
    if (userB?.id) {
      await adminClient.from('audit_logs').delete().eq('user_id', userB.id)
      await adminClient.from('companies').delete().eq('user_id', userB.id)
    }

    // Deleting auth users cascades to trial_balance_uploads → account_corrections
    if (userA?.id) { await adminClient.auth.admin.deleteUser(userA.id); console.log('  deleted User A') }
    if (userB?.id) { await adminClient.auth.admin.deleteUser(userB.id); console.log('  deleted User B') }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════')
    if (findings.length) {
      console.warn(`\n⚠  FINDINGS (not hard failures — review before next sprint):`)
      findings.forEach(f => console.warn(`   • ${f}`))
    }
    console.log(`\nResults: ${passed} passed, ${failed} failed`)
    if (failed > 0) {
      console.error('SOME TESTS FAILED — see output above.')
      process.exit(1)
    } else {
      console.log('All tests passed.')
    }
  }
}

run().catch(err => {
  console.error('\nUnexpected error:', err.message ?? err)
  process.exit(1)
})
