# Financial-statements production-readiness — release package

Branch: `codex/financial-statements-production-readiness`. Manifest: `docs/release/release-manifest.json` (built by `node scripts/release/build-manifest.mjs`; `--check` verifies it is current).

**Not done by this work, by design:** no PR, no merge, no push of `main`, no migration applied to any hosted project, no Edge Function deployed, no production feature gate enabled, no production connection of any kind. The production project reference (`bvyivmmfjejbmqoydezk`) appears only in refusal guards.

## 1. What is in the release

| Area | Files |
|---|---|
| Evidence model & controlled intake (10 families incl. cash account map; CSV, plus a secure `.xlsx` reader on the audited `fflate`), evidence-cell correction | `src/lib/financialEvidence/**` |
| Deterministic generation (direct cash flow, changes in equity, IPSAS cash receipts/payments, budget vs actual, notes/policies/schedules + checklist, **multi-account cash perimeter with ECL reconciliation**) | `src/lib/financialGeneration/**` |
| Canonical rules added (rule pack 2.1.0: equity closing tie, equity profit tie, schedule casting, cash-flow closing-cash reconciliation v2) | `src/lib/canonicalStatement/rules/{equityTies,scheduleCasting,cashPerimeterReconciliation,rulePack}.ts` |
| Persistence & rollout migrations (**unapplied**) | `supabase/migrations/20260919100000_…rollout_control.sql`, `…20260919110000_…persistence.sql` |
| Typed transport, atomic save flow (incl. multi-evidence correction groups), reopening / restore / read-only history, exports | `src/lib/financialStatementsWorkspace/{rpcTransport,saveFlow,savedVersions,supabaseFsBackend,exports}.ts` |
| Workspace UI | `src/components/financialStatements/**`, `src/hooks/useFinancialStatementsWorkspace.ts` |
| Disposable-database proof & bridge | `scripts/db-proof/{run,serve}.mjs`, `scripts/release/verify-release-sql.mjs` |
| Hosted-staging acceptance package (guarded; **not run**) | `scripts/hosted-staging/acceptance.mjs`, `docs/release/HOSTED_STAGING_ACCEPTANCE.md`, `docs/release/sql/06` |
| Operator SQL | `docs/release/sql/01…06` |

## 2. Migrations (apply order; SHA-256 in the manifest)

1. `20260919100000_financial_statements_rollout_control.sql`
2. `20260919110000_financial_statements_persistence.sql`

Both are forward-only, sort after every existing migration, touch only their own eleven tables, and never modify `tax_computations`, `account_mappings`, `engine_runs` or any sign-off table. Preflight/postcondition SQL and its executed proof are in `docs/release/sql` and `scripts/release/verify-release-sql.mjs`.

## 3. Gates — final-state checklist

| Gate | Required at hand-off | Verified by |
|---|---|---|
| `FINANCIAL_STATEMENTS_WORKSPACE_ENABLED` | `false` | `workspaceGate.test.ts`, production bundle scan |
| `FINANCIAL_STATEMENT_PERSISTENCE_ENABLED` | `false` | `databaseInert.test.ts` |
| `DOCUMENT_REVIEW_ENABLED` | `false` | existing gate |
| Server rollout | default denied, kill switch off | `sql/02_postcondition.sql`, `scripts/db-proof` |

## 3a. Verification commands and results

The commands and their actual exit codes are recorded in the final report of the run that produced this branch. Re-run them from a checkout with LF line endings (`git -c core.autocrlf=false`), because a CRLF checkout fails the 32 pre-existing `omega3_0` migration tests that read migration text.

```
npm test                                   # full suite
npx tsc --noEmit -p tsconfig.app.json      # typecheck (0 errors at hand-off)
npx eslint .                               # lint
npm run build                              # production build
node scripts/audit_migrations.mjs --strict # must print VERDICT: CLEAN
node scripts/release/build-manifest.mjs --check
DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> node scripts/db-proof/run.mjs
DB_PROOF_MODULES_DIR=<dir> node scripts/db-proof/serve.mjs   # then: DB_PROOF_SEED_FILE=<seed path printed by serve.mjs> npx vitest run saveFlow.pg
DB_PROOF_MODULES_DIR=<dir> node scripts/release/verify-release-sql.mjs
```

`db-proof/run.mjs` also runs in CI (job `db-contract-tests`, fresh database on the throwaway container).

### Recorded results

The recorded results (real exit codes, LF checkout, no masking pipes) are in `docs/release/VERIFICATION_RESULTS.md`. That file is deliberately **not** hashed in the manifest: it records gates that ran on the manifest's own commit, so it can only be written after it.

Browser E2E (non-production harness, real UI → real transport → disposable PostgreSQL through the loopback bridge; **simulated identity, not GoTrue**) covers all **seven** stages (Sources, Structure, Statements, Notes & Policies, Validate, Professional Review, Final Outputs) — see `docs/release/E2E_SEVEN_STAGE_PROOF.md` for the exact scenario and observed results (desktop and 375 px).

## 4. Canary plan

See `FINANCIAL_STATEMENTS_ACTIVATION.md` §3. One internal company first; widen only after a clean watch cycle. Success criteria: zero unexpected error classes, every save produces contiguous versions, no `PT409` that a user could not resolve by reloading, exports reproducible.

## 5. Secret **names** used (values are never in this repository)

Browser: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (public anon key, already deployed). Operator only: the target project's service-role key, used only to run `sql/03–05` as a named operator. CI staging (existing, unchanged): `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_SERVICE_ROLE_KEY`, `STAGING_SUPABASE_PROJECT_REF`. The new CI step uses no secret.

## 6. Acceptance checklist for the production reviewer

- [ ] Manifest `--check` passes; migration hashes match the files to be applied.
- [ ] Reviewed the two migrations line by line (SECURITY DEFINER bodies, grants, RLS).
- [ ] Preflight passes on the target; managed apply performed; postcondition passes.
- [ ] Ship-gate flip is its own reviewed commit.
- [ ] Canary company activated through `sql/03`, walk-through complete, audit rows present.
- [ ] Kill switch drilled once (`sql/05`, then released) before widening.
- [ ] Legal/professional review of Terms/Privacy is unrelated to this release but remains a paid-launch gate (CLAUDE.md §9.2).

## 7. Known limitations (read before accepting)

1. **Not exercised against GoTrue or a hosted Supabase project.** Identity in every local proof is a simulated `auth.uid()`; hosted role grants, PostgREST exposure and the managed migration path are unverified. `HOSTED_STAGING_RESULT=BLOCKED_MISSING_STAGING_PROJECT` — no staging project exists; the runbook and guarded script are in `HOSTED_STAGING_ACCEPTANCE.md`. Local disposable-database proof is separate from hosted proof and is never reported as it.
2. **Spreadsheet intake is `.xlsx` only, for five evidence families** (ledger, equity movements, budget, IPSAS cash, schedules) and CSV for all. Encrypted, macro-enabled, externally linked and formula workbooks, `.xls`/`.xlsb`/`.ods`, PDF, DOCX and images are refused; there is no document extraction and extracted candidates can never feed a statement.
3. **No DOCX export and no XBRL/iXBRL producer.** Only the adapter contract exists; no filing readiness is claimed.
4. **Prior-period statements evidence** supplies opening cash only; comparative columns for generated statements come from a comparative trial balance or a comparative evidence batch. One comparative period is supported; comparative note columns are not generated.
5. **One cash account map serves both periods.** The perimeter reconciliation is exact and unplugged, but restricted cash is disclosed as a total with its accounts, not as narrative; an account absent from a comparative trial balance leaves the comparative perimeter unestablished (a warning), never guessed.
6. **Restore is exact or it does not happen.** A reopened latest version becomes an editable draft only if re-composition reproduces its stored content hash; otherwise the draft starts fresh, says why, and saving creates a new version. Evidence stored after the saved version is applied to the draft and shown as unsaved.
7. **Budget evidence is not part of the stored report document.** Budget-only changes do not produce a new report version, and a historical view shows the statements as stored but cannot re-derive the budget-versus-actual comparison. The print header shows the effective report's internal version, not the stored version number.
8. **Evidence corrections** apply to the latest version of an evidence series that is already saved (an unsaved batch is simply replaced in the draft, since nothing durable exists to correct); trial-balance figures keep their own fact-correction command. Only one cell is corrected per step; a corrected value must pass the same intake contract as an upload.
9. **The independence limitation in `DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001` is unchanged**: the cash-flow closing figure is reconciled to the reviewed cash perimeter, but two independently derived operating-cash-flow numbers still need a period-complete classified cash-movement ledger that does not exist here.
10. **Print/PDF** relies on the browser's print engine; page-number margin boxes need a Chromium-class engine and were not verified in a print preview here (the print document's content was verified in the browser).
11. **No load testing** beyond the enforced limits (2 MB / 20,000 rows / 40 columns for CSV; 5 MB, 300 zip entries, 20,000 rows for workbooks).
12. **Artifact hashes in the manifest identify one build; they are not a reproducibility proof.** The pre-existing vite config embeds the build time and the HEAD commit id, so rebuilding changes them. The manifest's migration and document hashes are exact and are what `--check` verifies.
13. The CI step that runs `db-proof` on the throwaway container was verified locally in external mode against an empty database, but has not yet run in GitHub Actions.

