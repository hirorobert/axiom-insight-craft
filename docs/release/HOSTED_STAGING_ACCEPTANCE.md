# Hosted-staging acceptance — financial statements persistence

```
HOSTED_STAGING_RESULT=BLOCKED_MISSING_STAGING_PROJECT
GOTRUE_RESULT=NOT_RUN   POSTGREST_RESULT=NOT_RUN   HOSTED_RLS_RESULT=NOT_RUN
REALTIME_RESULT=NOT_RUN MANAGED_MIGRATION_RESULT=NOT_RUN
READY_FOR_PRODUCTION_DEPLOYMENT=NO
```

No hosted staging Supabase project is configured for this repository and none was invented. No
production secret is accepted anywhere in this package. The local disposable-PostgreSQL proof
(`scripts/db-proof`) and the local browser proof are **separate** from this: they *simulate*
`auth.uid()`, they are not GoTrue, and they do not exercise PostgREST. They never count as hosted
acceptance.

## The one setup checklist (a named operator, once)

- [ ] **Project.** Create a dedicated, disposable Supabase project. It must **not** be the production
      project (`bvyivmmfjejbmqoydezk`). Record its 20-character reference.
- [ ] **GitHub environment `staging`** (the existing protected one). Add secrets `STAGING_SUPABASE_URL`,
      `STAGING_SUPABASE_ANON_KEY`, `STAGING_SUPABASE_SERVICE_ROLE_KEY`, and the variable
      `STAGING_SUPABASE_PROJECT_REF` (the explicit expected reference — there is deliberately no default).
- [ ] **Guard.** `node scripts/ci/stagingGuard.mjs` prints `Staging target verified`.
- [ ] **Migrate staging only** from an operator machine: `supabase link --project-ref <STAGING_REF>` then
      `supabase db push` (applies `20260919100000` then `20260919110000`); `supabase migration list` shows both on
      staging and neither on production.
- [ ] **Run** `STAGING_SUPABASE_URL=… STAGING_SUPABASE_ANON_KEY=… STAGING_SUPABASE_SERVICE_ROLE_KEY=…
      STAGING_SUPABASE_PROJECT_REF=… node scripts/hosted-staging/acceptance.mjs`, and run
      `docs/release/sql/06_staging_realtime_check.sql` in the staging SQL editor.
- [ ] **Attach** the console output and the SQL output to the release record.

## What the run checks

Each check reports `PASS`, `FAIL` or `MANUAL_PENDING`; a skipped check is never a pass. The script fails closed
before any request, reads only `STAGING_*` variables and never prints a URL, key, password or token.

| Area | Checks |
|---|---|
| GoTrue | `GOTRUE_ADMIN_CREATE_USERS`, `GOTRUE_PASSWORD_SIGN_IN`, `JWT_ROLE_CLAIMS`, `JWT_KEY_ROLES` (real `role=authenticated`, `aud`, `sub`, `exp`, `iss`) |
| PostgREST exposure | `POSTGREST_ACCESS_RPC_FOR_AUTHENTICATED`; `POSTGREST_INTERNALS_NOT_EXPOSED` (actor resolver, blocker function, audit writer, internal evidence ingest, operator functions refused); `NO_STANDALONE_EVIDENCE_WRITE`; `POSTGREST_ANON_DENIED`; `POSTGREST_HISTORY_TABLES_NOT_WRITABLE` (eleven tables) |
| Rollout | `FEATURE_DEFAULT_DENIED`, `WRITE_REFUSED_WHILE_DISABLED`, `SERVICE_ROLE_ENABLES_COMPANY`, `FEATURE_ENABLED_AFTER_OPERATOR_ACTION`, `AUTHENTICATED_WRITE_ROUNDTRIP` (a revision commit) |
| Hosted RLS | `OUTSIDER_WRITE_REFUSED`, `RLS_MEMBER_READS_OWN_ROWS`, `RLS_OUTSIDER_SEES_NOTHING`, `RLS_OUTSIDER_CANNOT_LIST_VERSIONS` |
| Realtime | `REALTIME_PUBLICATION_EXCLUDES_HISTORY_TABLES` — **manual** (`sql/06`): zero publication rows, `relrowsecurity = true` everywhere |

Result lines: `BLOCKED_MISSING_STAGING_PROJECT` (nothing ran, exit 2 — the current state), `REFUSED_<CODE>` (guard refused
the target), `FAILED`, `AUTOMATED_PASS_MANUAL_REALTIME_PENDING`. There is no bare `PASS`.

## Residue

History tables are append-only with `ON DELETE RESTRICT`, so the round-trip's evidence row (and the company that owns
it) cannot be deleted. The run is tagged `fsacc…` and the staging project must be disposable as a whole.

## What is proven offline today

`src/lib/financialStatementsWorkspace/hostedStagingAcceptance.test.ts` proves the *script*: it refuses to run without an
explicit staging target, refuses production, never prints a secret, never counts a manual check as passed, and — against an
in-memory model of GoTrue/PostgREST/RLS — fails with the right check named for each mis-exposure. That is evidence about
the script, not about any hosted project.
