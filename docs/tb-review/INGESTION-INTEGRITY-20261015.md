# Trial balance ingestion integrity — first implementation batch

Base: `2ce3ba617744b76ae6927d423dfe92d81b441db9`.
Scope: deterministic source interpretation and truthful recorded-check presentation.
No migration, pricing change, entitlement change, payment activation or new AI provider.
This batch does not complete the subsequent upload-first journey redesign.

## Reproduced defects and repairs

Six regression assertions failed before the repair, covering printed binary XLS interpretation and fabricated check passes.

- `NATURAL ACCOUNT` now identifies the account-code column. Equal descriptions with different codes remain separate accounts.
- A sparse row containing recognised ISO currency labels only in amount columns is recorded as metadata. Labels conflicting with selected currency block processing. Mixed rows are not silently discarded.
- An unlabelled debit/credit control row is recognised only after accounts, with both numeric values, no other populated columns and only recognised footer/blank rows afterwards. It is compared against independently summed account rows. Unknown intervening rows remain blocking errors.
- Printed control mismatch and account imbalance are separate findings; neither generates a balancing entry.
- Recorded processing steps can withhold a displayed pass but never grant certification. Missing, duplicated, malformed, failed and not-reached steps cannot supply a pass. Existing ledger failures remain failures.
- The workspace summary and preparation screen receive the same stored progress. The result presentation also applies the constraint defensively. A contradictory certification cannot produce a Reviewed headline.
- File-read wording no longer claims every amount was totalled when only file reading completed.

Parser version: `tb-ingest-3.1.0`. Existing characterization digests are preserved; their comparison normalises only the intentional version-string change. All monetary arithmetic, refusal rules and lineage outputs in that corpus remain pinned.

## Privacy and source verification

The supplied original workbook was checked privately against the repaired core: 249 account identities, one printed control row, every source row accounted for, and the independently checked debit/credit difference reproduced. The only issue with compatible explicit year/currency context was the genuine imbalance.

Neither the original file, its source cells, its actual amounts, nor the uploaded derivative fixture ZIP is committed. Regression workbooks are generated at runtime from invented identities and amounts. This verification does not confirm company ownership, period start, framework, classifications or accounting compliance.

## Verification

Local checks: full Vitest suite; the real TrialBalanceChecks component rendered with stopped processing; production build; application TypeScript; ESLint; package-manager authority; migration authority; jurisdiction pack isolation; public metadata; Deno checking of shared ingestion/source/layout modules.

The test suite has existing skipped database tests and TODO tests; green does not mean those executed. Whole-handler Deno checking could not download remote imports in this environment (connection refused); the existing CI Deno jobs must check the final head. Authenticated browser E2E and full database proofs must likewise pass in CI. No production access or deployment is established by local tests.

Three migration-order registry failures were reproduced on untouched base main. Their explicit lists now include the already-existing `20261105100000_checkout_open_session_conflict.sql` (service-role-only checkout acquisition; no service entitlement grants). Its SQL is unchanged. The historical release document retains historical identities and adds the unreleased layout-assist dependency closure, without claiming deployment.

## Release and recovery

1. Require green CI against this exact PR head, including handler Deno, database proofs and real-app E2E. Reconcile any new main changes before integration.
2. Merge through the supported review process. No hosted schema migration is required by this batch.
3. Generate deployment identities with `node scripts/release/functionClosure.mjs process-trial-balance trial-balance-layout layout-assist`. All three depend on the changed shared core; coordinate their deployment with the frontend. Do not enable layout-assist or any withheld module.
4. Use the authorised deployment process, then verify installed versions and an authenticated synthetic upload. Confirm a stopped check remains unreviewed and a clean supported upload proceeds normally.
5. Existing financial evidence, fingerprints and signed reports are not rewritten. Old blocked uploads need an explicit authorised reprocess to obtain repaired results. Do not silently reprocess historical signed work.
6. If post-deploy verification fails, pause affected ingestion and use the supported release rollback. Preserve records and financial guards. Do not restore false-green presentation or treat an older result as a newly validated one.

## Remaining phases

- Upload-first Home and inline confirmation: inspect present setup actions, authoritative period contracts, entitlement boundary and approved draft retention; reuse existing parser and write authority.
- Results and professional review report: explicit completed/not-run coverage, source-to-result traceability, distinct account/control arithmetic and classification decisions.
- AI-assisted records-to-draft-TB: first establish what is already implemented; supported inputs only, evidence-backed suggestions, deterministic arithmetic, explicit human acceptance, bounded cost and privacy. No automatic plugs or unsupported compliance claims.

These phases are not represented as completed or deployed by this batch.
