# Hosted-staging acceptance — financial statements persistence

**Status: NOT RUN. `HOSTED_STAGING_RESULT=BLOCKED_MISSING_STAGING_PROJECT`.**
No hosted staging Supabase project is configured for this repository, and none was
invented. The local disposable-PostgreSQL proof (`scripts/db-proof`) and the local browser
E2E are **separate** from this and do not count as hosted acceptance. In particular, the
disposable proof *simulates* `auth.uid()`; it is not GoTrue and it does not exercise PostgREST.

This package is what a named operator runs, once, against a real staging project, before
anyone is asked to authorise a production migration. Nothing in it touches production, and
the guard makes that impossible by construction.

## 1. What the hosted run adds

| Concern | Local disposable proof | Hosted staging |
|---|---|---|
| Migration applies through the real managed path | replayed in a throwaway server | `supabase db push` on staging |
| JWT minted by a real GoTrue, `role=authenticated` | simulated GUC | **real** |
| PostgREST exposes exactly the intended functions/tables | bridge allowlist | **real schema cache + grants** |
| `anon` refused | role switch | **real anon key** |
| RLS through the REST endpoints | as `authenticated` | **real sessions** |
| Realtime does not publish the history tables | not applicable | manual SQL (`sql/06`) |

## 2. One-time configuration (operator)

1. Create a **dedicated, disposable** Supabase project. Never reuse the production project
   (`bvyivmmfjejbmqoydezk`). Record its 20-character project reference.
2. In the GitHub repository, use the existing protected environment **`staging`**
   (required reviewers, deployment branches limited to `main`). Add:
   * secrets `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_ANON_KEY`, `STAGING_SUPABASE_SERVICE_ROLE_KEY`
   * variable `STAGING_SUPABASE_PROJECT_REF` — the **explicit expected** reference.
   There is deliberately no default: without it the guard refuses.
3. Apply the two migrations to **staging only**, from an operator's machine (no database
   credential is stored in CI):
   ```bash
   node scripts/ci/stagingGuard.mjs          # must print "Staging target verified"
   supabase link --project-ref <STAGING_REF>  # the reference you recorded in step 1
   supabase db push                           # applies 20260919100000 then 20260919110000, in order
   ```
   Confirm `supabase migration list` shows both as applied on staging and *not* on production.

## 3. Run

```bash
STAGING_SUPABASE_URL=… STAGING_SUPABASE_ANON_KEY=… STAGING_SUPABASE_SERVICE_ROLE_KEY=… \
STAGING_SUPABASE_PROJECT_REF=… node scripts/hosted-staging/acceptance.mjs
```
(or from a `staging`-environment job once a reviewed workflow exists — none is added here,
because the CI safety tests deliberately allow only the one write-capable job).

The script fails closed before any request, reads only `STAGING_*` variables, and never
prints a URL, key, password or token.

## 4. Checks (each reported PASS / FAIL / MANUAL_PENDING — a skipped check is never a pass)

1. `GOTRUE_ADMIN_CREATE_USERS` — two confirmed users via the GoTrue admin API (no e-mail is sent).
2. `GOTRUE_PASSWORD_SIGN_IN` — real sessions issued.
3. `JWT_ROLE_CLAIMS` / `JWT_KEY_ROLES` — the session token has `role=authenticated`, `aud=authenticated`,
   `sub` = the created user, a future `exp`, an `iss` under the project URL; the anon and service keys carry their own roles.
4. `POSTGREST_ACCESS_RPC_FOR_AUTHENTICATED` — the intended RPC is reachable by `authenticated`.
5. `POSTGREST_INTERNALS_NOT_EXPOSED` — `fs_actor_member_id`, `fs_publication_blockers`, `fs_audit_event`,
   `fs_set_company_rollout`, `fs_set_kill_switch` are **refused** to `authenticated`.
6. `POSTGREST_ANON_DENIED` — the persistence RPCs are refused to `anon`.
7. `POSTGREST_HISTORY_TABLES_NOT_WRITABLE` — INSERT/UPDATE/DELETE on all ten history/rollout tables is refused.
8. `FEATURE_DEFAULT_DENIED`, `WRITE_REFUSED_WHILE_DISABLED` — a member of a non-allowlisted company is told
   `NOT_ALLOWLISTED` and a write is refused (`PT403`).
9. `SERVICE_ROLE_ENABLES_COMPANY`, `FEATURE_ENABLED_AFTER_OPERATOR_ACTION`, `AUTHENTICATED_WRITE_ROUNDTRIP` —
   only the service role can enable a company; after that the member's write succeeds.
10. `OUTSIDER_WRITE_REFUSED`, `RLS_MEMBER_READS_OWN_ROWS`, `RLS_OUTSIDER_SEES_NOTHING`, `RLS_OUTSIDER_CANNOT_LIST_VERSIONS`.
11. `REALTIME_PUBLICATION_EXCLUDES_HISTORY_TABLES` — **MANUAL**: run `docs/release/sql/06_staging_realtime_check.sql`
    in the staging SQL editor; expected zero publication rows and `relrowsecurity = true` everywhere.

## 5. Result vocabulary

| Line | Meaning |
|---|---|
| `HOSTED_STAGING_RESULT=BLOCKED_MISSING_STAGING_PROJECT` | no staging project configured; nothing ran (exit 2). **Current state.** |
| `HOSTED_STAGING_RESULT=REFUSED_<CODE>` | the guard refused the target (production, mismatch, malformed) (exit 1) |
| `HOSTED_STAGING_RESULT=FAILED` | an automated check failed (exit 1) |
| `HOSTED_STAGING_RESULT=AUTOMATED_PASS_MANUAL_REALTIME_PENDING` | every automated check passed; sign-off still needs the manual realtime output |

There is no bare `PASS`. Attach the console output and the manual SQL output to the release record.

## 6. Cleanup

History tables are append-only with `ON DELETE RESTRICT`, so the evidence row written by the
round-trip **cannot** be deleted, and the company that owns it cannot be deleted either. Cleanup
therefore (a) deactivates the acceptance company's rollout, (b) removes the auth users where the
platform allows it, and (c) prints what remains. This is why the staging project must be disposable
as a whole; the run is tagged `fsacc…` so its residue is identifiable.

## 7. What is proven offline today

`src/lib/financialStatementsWorkspace/hostedStagingAcceptance.test.ts` proves the *harness*: it
refuses to run without an explicit staging target, refuses production, never prints a secret, never
counts a manual check as passed, and — against an in-memory model of GoTrue/PostgREST/RLS — fails
with the right check named for each of nine mis-exposures. That is evidence about the script, not
about any hosted project.
