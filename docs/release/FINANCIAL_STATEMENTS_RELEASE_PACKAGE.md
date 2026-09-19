# Financial-statements production-readiness — release package

Branch: `codex/financial-statements-production-readiness`. Manifest: `docs/release/release-manifest.json` (built by `node scripts/release/build-manifest.mjs`; `--check` verifies it is current).

**Not done by this work, by design:** no PR, no merge, no push of `main`, no migration applied to any hosted project, no Edge Function deployed, no production feature gate enabled, no production connection of any kind. The production project reference (`bvyivmmfjejbmqoydezk`) appears only in refusal guards.

## 1. What is in the release

| Area | Files |
|---|---|
| Evidence model & controlled intake (9 families) | `src/lib/financialEvidence/**` |
| Deterministic generation (direct cash flow, changes in equity, IPSAS cash receipts/payments, budget vs actual, notes/policies/schedules + checklist) | `src/lib/financialGeneration/**` |
| Canonical rules added (rule pack v2: equity closing tie, equity profit tie, schedule casting) | `src/lib/canonicalStatement/rules/{equityTies,scheduleCasting,rulePack}.ts` |
| Persistence & rollout migrations (**unapplied**) | `supabase/migrations/20260920000000_…rollout_control.sql`, `…20260920100000_…persistence.sql` |
| Typed transport, atomic save flow, exports | `src/lib/financialStatementsWorkspace/{rpcTransport,saveFlow,supabaseFsBackend,exports}.ts` |
| Workspace UI | `src/components/financialStatements/**`, `src/hooks/useFinancialStatementsWorkspace.ts` |
| Disposable-database proof & bridge | `scripts/db-proof/{run,serve}.mjs`, `scripts/release/verify-release-sql.mjs` |
| Operator SQL | `docs/release/sql/01…05` |

## 2. Migrations (apply order; SHA-256 in the manifest)

1. `20260920000000_financial_statements_rollout_control.sql`
2. `20260920100000_financial_statements_persistence.sql`

Both are forward-only, sort after every existing migration, touch only their own nine tables, and never modify `tax_computations`, `account_mappings`, `engine_runs` or any sign-off table. Preflight/postcondition SQL and its executed proof are in `docs/release/sql` and `scripts/release/verify-release-sql.mjs`.

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

1. **Not exercised against GoTrue or a hosted Supabase project.** Identity in every proof is a simulated `auth.uid()`; hosted role grants, PostgREST exposure and the managed migration path are unverified.
2. **Intake is CSV only.** XLSX/PDF/DOCX/image inputs are refused safely; there is no document extraction, and extracted candidates can never feed a statement.
3. **No DOCX export and no XBRL/iXBRL producer.** Only the adapter contract exists; no filing readiness is claimed.
4. **Prior-period statements evidence** supplies opening cash only; comparative columns for generated statements come from a comparative trial balance or a comparative evidence batch. One comparative period is supported; comparative note columns are not generated.
5. **Closing-cash tie** needs exactly one trial-balance line reviewed as the cash account; with several the rule reports insufficient evidence rather than guessing.
6. **After a reload the session starts a fresh draft.** Saved versions stay in the database (readable through RLS) but there is no "open a saved version" UI yet; a second save appends a new version.
7. **Corrections apply to trial-balance facts only.** Evidence is corrected at source by uploading a new version.
8. **Statement-set completeness is enforced in the client**; the server enforces the finding gate, evaluation presence and role. The UI disables Reviewed/Final while completeness items remain.
9. **Print/PDF** relies on the browser's print engine; page-number margin boxes need a Chromium-class engine and were not verified in a print preview here.
10. **No load testing** beyond the enforced limits (2 MB, 20,000 rows, 40 columns).
11. The CI step that runs `db-proof` on the throwaway container was verified locally in external mode against an empty database, but has not yet run in GitHub Actions.
