# Financial-statements production-readiness — release package

Branch: `codex/financial-statements-production-readiness`, one pull request into `main`.
Manifest: `docs/release/release-manifest.json` (§4). Verification results are **not** committed in this tree (a
committed result would describe a commit that does not yet exist); they are in the pull request description and the run's
final report, each tied to the exact pushed commit.

**Not done by this work, by design:** no merge, no push to `main`, no migration applied to any hosted project, no Edge
Function deployed, no production feature gate enabled, no connection to any production project. The production project
reference (`bvyivmmfjejbmqoydezk`) appears only in refusal guards. `READY_FOR_PRODUCTION_DEPLOYMENT=NO`.

## 1. What is in the release

| Area | Files |
|---|---|
| Evidence model & controlled intake (10 families incl. the cash account map; CSV, plus a secure `.xlsx` reader on the audited `fflate`; **one canonical content identity for both formats**), evidence-cell correction | `src/lib/financialEvidence/**` |
| Deterministic generation: direct cash flow, changes in equity, IPSAS cash receipts/payments, budget vs actual, notes/policies/schedules + checklist, multi-account cash perimeter (restricted cash, overdraft, ECL), **per-account cash-ledger completeness** | `src/lib/financialGeneration/**` |
| Persisted authority: the budget comparison, disclosure checklist and mapping coverage are recorded **inside** the stored report, so a version carries its own | `src/lib/financialGeneration/persistedAuthority.ts` |
| Canonical rules (rule pack 2.2.0): equity ties, schedule casting, cash-perimeter reconciliation, **`cashflow-account-rollforward`** | `src/lib/canonicalStatement/rules/**` |
| Persistence & rollout migrations (**unapplied**) | `supabase/migrations/20260919100000_…rollout_control.sql`, `…20260919110000_…persistence.sql` — reviewed line by line in `MIGRATION_REVIEW.md` |
| Typed transport, one atomic save flow, reopening / restore / read-only history, exports carrying lineage | `src/lib/financialStatementsWorkspace/**` |
| Workspace UI, hook | `src/components/financialStatements/**`, `src/hooks/useFinancialStatementsWorkspace.ts` |
| Disposable-database proof & bridge; operator SQL verifier | `scripts/db-proof/{run,serve}.mjs`, `scripts/release/verify-release-sql.mjs` |
| Release tooling: manifest, repository scans | `scripts/release/{manifestLib,build-manifest,scan-repo}.mjs` |
| Browser acceptance (non-production harness + scripted phases) | `dev-harness/**` (never in the production bundle) |
| Hosted-staging acceptance package (guarded; **not run**) | `scripts/hosted-staging/acceptance.mjs`, `HOSTED_STAGING_ACCEPTANCE.md`, `sql/06` |
| Operator SQL | `docs/release/sql/01…06` |

## 2. Migrations (apply order; SHA-256 in the manifest)

1. `20260919100000_financial_statements_rollout_control.sql`
2. `20260919110000_financial_statements_persistence.sql`

Forward-only, sort after every existing migration, touch only their own eleven tables, never modify `tax_computations`,
`account_mappings`, `engine_runs` or any sign-off table. No historical migration is edited (asserted by two tests and by
`scan-repo.mjs paths`).

## 3. Gates — required state at hand-off

| Gate | Required | Verified by |
|---|---|---|
| `FINANCIAL_STATEMENTS_WORKSPACE_ENABLED` | `false` | `workspaceGate.test.ts`, `scan-repo.mjs bundle` |
| `FINANCIAL_STATEMENT_PERSISTENCE_ENABLED` | `false` | `databaseInert.test.ts` |
| `DOCUMENT_REVIEW_ENABLED` | `false` | existing gate |
| Server rollout | default denied (and fail-closed), kill switch off | `sql/02_postcondition.sql`, `scripts/db-proof` |

## 4. The manifest: one design, no self-reference

A commit cannot contain its own hash, so a manifest committed inside the release cannot name the commit that carries it.
The release is therefore **source + one tip commit**:

* the candidate `HEAD` is the source commit plus exactly one commit that changes **only** `docs/release/release-manifest.json`;
* the manifest records the base commit (`origin/main`), the **source commit**, and the **source tree** — the git tree of the
  candidate with the manifest file removed (reproducible by anyone with `git write-tree` on a temporary index);
* `commits` lists every commit of `origin/main..source` exactly once, in order, followed by the literal sentinel `MANIFEST_TIP` for
  the tip; `commitCount` therefore equals the real count of `origin/main..HEAD`;
* `changedFiles` (name-status), every added migration's filename and **LF-normalised** SHA-256, and every release document's
  LF-normalised SHA-256 are recomputed from the repository;
* `node scripts/release/build-manifest.mjs --check` fails on **any** difference: HEAD not a manifest-only tip, source commit not
  HEAD's parent, tree differs, a commit omitted / duplicated / reordered, an inventory or hash mismatch, or anything committed after
  the manifest. Nothing reads the clock; the same repository state yields the same manifest. Tests build throw-away git repositories
  and mutate each of these (`releaseManifest.test.ts`).

Consequently `MANIFEST_SOURCE_SHA` is the tip's **parent**, while `FEATURE_SHA` = `VERIFIED_SHA` = `PUSHED_REMOTE_SHA` is the tip; the tip
changes no code, so a gate that inspects code and documents is exact at the tip.

Build artifacts (`dist/`) are not reproducible byte-for-byte (the pre-existing vite config embeds build time and commit id); the manifest
lists their names only.

## 5. Durable versioning (what a saved report is)

* **One atomic entry point.** `fs_commit_revision` writes evidence batches, the report version, its evaluation and the audit event in
  one transaction, with an idempotency key derived from content. Evidence has **no standalone write function**.
* **Authorisation, then staleness, before any write.** A stale session (expected version ≠ server) is refused before anything is written.
* **Replays converge; conflicts fail closed.** The same key and content returns the existing rows; the same key with different content is
  refused; concurrent writers converge or one wins and the other is refused stale; any failure rolls all of it back.
* **A version carries its own authority**: statements, the budget comparison, the disclosure checklist and mapping coverage are inside the
  stored document; the outputs (print, JSON, evidence, audit, CSV) and the workspace header show the **persisted** version, an unsaved
  draft is labelled exactly "Unsaved draft", and a historical view shows its own version, state, findings and checklist.
* **Reviewed/Final are server-decided** (`ACTIVATION.md` §1): a direct RPC cannot bypass the gate.

## 6. `DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001` — resolution, honestly

`safisha_transactions` is **still not** a period-complete, classified cash-movement ledger, and this release does not pretend it is.
What changed is that the workspace no longer depends on it:

* the cash flow is built from an explicit **transaction-ledger evidence family** (controlled CSV/XLSX intake, row provenance);
* the **cash account map** (explicit category and effect per account — nothing picked by position or name) defines the perimeter;
* **per-account completeness:** each cash account's ledger movement must equal its trial-balance movement between the two reviewed
  trial balances (`cashflow-account-rollforward`); offsetting errors that keep the net right are caught; ledger rows naming a non-cash or
  unknown account, a missing balance, or conflicting opening cash **fail closed** (nothing presented, nothing plugged);
* the server refuses Reviewed/Final while that authority is missing or unresolved.

What remains a limitation: the ledger is **preparer-supplied evidence**, reconciled to the trial balance; it is not independently
extracted from the bank. Two independently *derived* operating-cash-flow numbers still need a source (e.g. a complete SAFISHA ledger)
that does not exist in this repository. The project record (`CLAUDE.md` §9.1) says exactly this.

## 7. Verification commands (results: pull-request description and final report, at the exact pushed commit)

```
npx vitest run                                  # full suite
npx tsc --noEmit -p tsconfig.app.json           # typecheck
npx eslint .                                    # lint (0 errors; warnings are the pre-existing baseline)
npm run build                                   # production build
node scripts/audit_migrations.mjs --strict      # VERDICT: CLEAN
node scripts/release/build-manifest.mjs --check # manifest matches the repository exactly
node scripts/release/scan-repo.mjs nul|secrets|paths|payments|bundle
git diff --check origin/main...HEAD
DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> node scripts/db-proof/run.mjs
DB_PROOF_MODULES_DIR=<dir> DB_PROOF_SEED_FILE=<file> node scripts/db-proof/serve.mjs   # then, elsewhere:
DB_PROOF_SEED_FILE=<file> npx vitest run saveFlow.pg
DB_PROOF_MODULES_DIR=<dir> DB_PROOF_SEED_FILE=<file> node scripts/release/verify-release-sql.mjs
```

Run from a checkout with LF line endings (`git -c core.autocrlf=false`): a CRLF checkout fails pre-existing migration-text tests. Browser
acceptance: `E2E_SEVEN_STAGE_PROOF.md`.

## 8. Canary plan

`FINANCIAL_STATEMENTS_ACTIVATION.md` §3: one internal company first; widen after a clean watch cycle. Success criteria: no unexpected
error class, contiguous versions on every save, no `PT409` a user cannot resolve by reloading, reproducible exports.

## 9. Secret **names** (values are never in this repository)

Browser: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (public anon key, already deployed). Operator only: the target project's
service-role key, used only to run `sql/03–05` as a named operator. CI staging (existing, unchanged): `STAGING_SUPABASE_URL`,
`STAGING_SUPABASE_ANON_KEY`, `STAGING_SUPABASE_SERVICE_ROLE_KEY`, `STAGING_SUPABASE_PROJECT_REF` (a variable). The disposable-database CI job uses no secret.

## 10. Acceptance checklist for the production reviewer

- [ ] `build-manifest.mjs --check` passes; migration hashes match the files to be applied.
- [ ] `MIGRATION_REVIEW.md` re-read against the migrations (SECURITY DEFINER bodies, grants, RLS).
- [ ] Hosted staging accepted (`HOSTED_STAGING_ACCEPTANCE.md`) — currently **not run**.
- [ ] Preflight passes on the target; managed apply performed; postcondition passes.
- [ ] Ship-gate flip is its own reviewed commit.
- [ ] Canary company activated through `sql/03`, walk-through complete, audit rows present; kill switch drilled once (`sql/05`, then released).
- [ ] Legal/professional review of Terms/Privacy remains a paid-launch gate (CLAUDE.md §9.2), unrelated to this release.

## 11. Known limitations (read before accepting)

1. **Not exercised against GoTrue or a hosted Supabase project.** Identity in every local proof is a simulated `auth.uid()`
   (labelled `LOCAL_SIMULATED_IDENTITY`); hosted grants, PostgREST exposure, the managed migration path and realtime are unverified.
   `HOSTED_STAGING_RESULT=BLOCKED_MISSING_STAGING_PROJECT`. Local proof is never reported as hosted.
2. **Spreadsheet intake is `.xlsx` only, for five evidence families** (ledger, equity movements, budget, IPSAS cash, schedules); CSV for all.
   Encrypted, macro-enabled, externally linked and formula workbooks, `.xls`/`.xlsb`/`.ods`, PDF, DOCX and images are refused. There is no
   document extraction; extracted candidates never feed a statement.
3. **No DOCX export and no XBRL/iXBRL producer.** No filing readiness is claimed. Printed and exported outputs stay marked
   draft / internal preview whatever publication state the server records.
4. **One comparative period.** A comparative cash flow needs the comparative period's own opening cash (the period before it), which the
   trial balances do not contain: the comparative closing line is reported as a missing comparative (a warning), never estimated.
5. **Evidence in another currency or scale than the statements is excluded, with the reason shown** — never converted or rescaled
   (a budget in another denomination is reported as an explicit comparison gap).
6. **Restore is exact or it does not happen.** A reopened latest version becomes an editable draft only if re-composition reproduces its
   stored content hash; otherwise the draft starts fresh, says why, and saving creates a new version.
7. **A viewer** sees the saved report but the UI offers a Save that the server then refuses (read-only after the attempt); nothing is written.
8. **Multiple evidence corrections in one save** land as contiguous report versions in one atomic group (one per correction); a failure
   leaves none.
9. **Ledger authority is preparer-supplied** (§6).
10. **Print/PDF** relies on the browser's print engine; margin-box page numbers need a Chromium-class engine and were not verified in a print preview.
11. **No load testing** beyond enforced limits (2 MB / 20,000 rows / 40 columns CSV; 5 MB, 300 zip entries, 20,000 rows, 5 s processing budget for workbooks).
12. **The literal-NUL scan has one baseline finding** (`src/lib/accounting/movementSchedules.ts`, identical to `origin/main`), reported, not touched.
13. The CI step that runs `db-proof` on the throwaway container was verified locally in external mode but has not yet run in GitHub Actions.
