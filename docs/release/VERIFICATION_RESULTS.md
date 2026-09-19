# Verification results

Gates were run on an **LF checkout** (`git -c core.autocrlf=false worktree add --detach … HEAD`, the
representation CI uses) of commit **`e736269`**, with real exit codes and no masking pipes.
This file is not hashed in `release-manifest.json` (it records gates that ran on the manifest's own
commit, so it can only be written after it); the commits after `e736269` change this file only.

| Gate | Command | Result |
|---|---|---|
| Full suite | `npx vitest run` | exit 0 — 130 files passed, 1 skipped (env-gated); 2777 tests passed, 10 skipped (the env-gated real-PostgreSQL client tests, run separately below), 12 todo |
| Typecheck | `npx tsc --noEmit -p tsconfig.app.json` | exit 0 — 0 errors |
| Lint | `npx eslint .` | exit 0 — 0 errors, 128 warnings (all pre-existing; none in this branch's files) |
| Build | `npm run build` | exit 0 |
| Diff hygiene | `git diff --check origin/main...HEAD` | exit 0 |
| Conflict markers | `git grep` for `<<<<<<<` / `>>>>>>>` outside docs | 0 files |
| Migration audit | `node scripts/audit_migrations.mjs --strict` | exit 0 — `VERDICT: CLEAN` |
| Manifest | `node scripts/release/build-manifest.mjs --check` | exit 0 — current (source `a2af8b7`, 2 migrations, 28 commits each listed once) |
| Disposable database proof | `scripts/db-proof/run.mjs` (fresh PostgreSQL 16, every migration replayed) | exit 0 — 191/191 assertions |
| Real client ↔ real SQL | `saveFlow.pg.test.ts` against `serve.mjs` | exit 0 — 10/10 |
| Operator SQL | `scripts/release/verify-release-sql.mjs` | exit 0 — `RELEASE_SQL: ALL PASSED` |
| Production bundle scan | `dist/` | no `service_role`, no rollout/kill-switch function names, no harness/bridge, no "Internal preview", no `fflate`/workbook reader (the workspace is tree-shaken while its gate is off). The only production-project reference is the pre-existing Supabase client constant in `src/integrations`, unchanged by this branch |
| Executable payment-provider scan | files changed under payments / Flutterwave | 0 executable files; the only file touched is the test `omega3CheckoutIntervalAuthority.test.ts` (its migration-tail pin) |
| Migrations vs base | `git diff --name-status origin/main...HEAD -- supabase` | exactly 2 added migrations |

Mutation checks of the new logic (each mutant applied, the relevant suite run, the file restored):
cash perimeter and rule — 9/9 killed; report restore / read-only history / save-flow — 8/8 killed
(hash check removed, tenancy removed, recorded evaluation replaced by a recomputation, newer-evidence flag,
new-evidence-version save removed, correction batch ingested outside its group, superseded-evidence guard
removed). One mutant of the correction group (an evidence step without its batch) is behaviourally equivalent.

## Not run, and why

* **Hosted staging: `HOSTED_STAGING_RESULT=BLOCKED_MISSING_STAGING_PROJECT`.** No staging project exists. `GOTRUE_RESULT`, `POSTGREST_RESULT` and hosted `RLS_RESULT` are therefore **not run** — not passed. See `HOSTED_STAGING_ACCEPTANCE.md`.
* No production migration, function deployment, feature gate or connection of any kind.
* Print-preview page numbering (Chromium margin boxes) was not verified.
