# Line-by-line review of the two new migrations

Scope: `supabase/migrations/20260919100000_financial_statements_rollout_control.sql` (202 lines, 5 functions) and
`supabase/migrations/20260919110000_financial_statements_persistence.sql` (~1,250 lines, 19 functions). Both are **new and
unapplied**, so this review edited them in place; no historical migration is modified (asserted by
`databaseInert.test.ts` and `scan-repo.mjs paths`: `git diff --name-status origin/main...HEAD -- supabase` lists exactly the
two added files). Each finding below names the executable proof; "review only" means the property is asserted by reading, not by a
test.

## Verdict per requirement

| Requirement | Result | Evidence |
|---|---|---|
| Forward-only, no destructive statement | **Met.** No `DROP`, no `ALTER` of an existing table, no data rewrite; every object is `CREATE`d new (11 tables, 24 functions, triggers, policies) | review; `persistenceMigrationContract.test.ts` |
| Ordering | **Met.** Timestamps `20260919100000` < `20260919110000`; both sort after every existing migration; rollout control first because persistence calls `fs_rollout_allows` | `audit_migrations.mjs --strict`; `migrationReplayCompatibilityGuard.test.ts`; zero-to-tip replay in `db-proof` |
| Tenant isolation | **Met.** RLS on all 11 tables. The seven history tables have one `SELECT` policy each, `company_id IN (SELECT get_member_company_ids())` (no direct `firm_members` read, which `authenticated` cannot select); the reference table's is `USING (true)`; the three rollout tables have RLS enabled and **no policy** (no client can read them; the browser learns its status only through `financial_statements_workspace_access`). An outsider, a non-accepted member and another company's owner read zero rows | `db-proof` (catalog contract + tenancy group), `saveFlow.pg.test.ts`, browser role matrix |
| Actor derived from `auth.uid()` | **Met.** No function argument accepts an actor; every client-callable writer starts with `fs_actor_member_id(company)` (session → accepted, non-viewer membership → rollout allows); the internal ingest takes the actor only from that resolver | `db-proof` "no function argument accepts an actor"; direct-RPC bypass tests (preparer, viewer, outsider, other company) |
| `search_path` | **Met.** All 24 functions `SET search_path = public, pg_temp` (or stricter); 16 are `SECURITY DEFINER`, each needed because `authenticated` has no grant on the tables it must write | grep counts; `db-proof` catalog contract |
| Grants | **Met.** Every function is `REVOKE ALL … FROM PUBLIC, anon, authenticated`; only nine are then `GRANT`ed to `authenticated`: six writers (`fs_commit_revision`, `fs_save_report_version`, `fs_save_evaluation`, `fs_append_decision`, `fs_apply_correction_group`, `fs_set_publication_state`) and three reads (`fs_report_readiness`, `fs_list_saved_versions`, `financial_statements_workspace_access`). Operator functions (`fs_set_company_rollout`, `fs_set_kill_switch`) are `service_role` only; `fs_ingest_evidence_internal`, the blocker/audit/actor helpers are not callable by any client role; tables: `SELECT` only, `TRUNCATE` impossible | `db-proof`; `hostedStagingAcceptance.test.ts` lists what a hosted run must re-verify |
| Replay / stale | **Met.** `fs_commit_revision` checks authorisation, then the expected report version, **before any write** (`PT409`); a repeated idempotency key with identical content converges on the existing rows; the same key with different content fails closed; concurrent writers with the same key converge (advisory lock) and with different keys one wins, the other is refused stale | `db-proof` revisions group (atomic, replay, stale, conflicting replay, concurrency, rollback) |
| FK deletion | **Met.** All history foreign keys are `ON DELETE RESTRICT`; deleting a company that has history fails and leaves it intact. The one `ON DELETE CASCADE` is `financial_statements_rollout_companies → companies`: an allow-list row for a company that never wrote history; cascading it away cannot lose financial data (the audit table deliberately has no FK) | `db-proof` FK + company-delete tests |
| Append-only | **Met.** `BEFORE UPDATE OR DELETE` trigger on all history tables including the audit log and the requirements reference table; raises for the table owner too; the client roles have no UPDATE/DELETE grant | `db-proof` (7 tables × 4 assertions) |
| Audit | **Met after this review.** Every accepted write leaves an attributable, immutable event: evidence ingest, revision commit, report version, decision, correction group, publication state — and, added by this review, `EVALUATION_RECORDED` for a client-called evaluation (previously the one client-callable write without one). An exact replay writes nothing new | `db-proof` audit-actions assertion |
| Rollout default deny + kill switch | **Met after this review** (see finding 1) | `db-proof` rollout group, `verify-release-sql.mjs` |
| Operator audit | **Met.** `fs_set_company_rollout` / `fs_set_kill_switch` require a reason (≥ 8 chars) and an operator label, and write `financial_statements_rollout_audit` in the same transaction; the label is recorded, never treated as authority (the function is `service_role` only) | `db-proof`, `verify-release-sql.mjs` (3 audit rows) |
| No production identifier | **Met.** The migrations contain no project reference, URL, key or role name of the hosted project | `scan-repo.mjs secrets`, `persistenceMigrationContract.test.ts` |
| Zero-to-tip replay | **Met.** Every one of the repository's migrations is replayed from an empty PostgreSQL 16 by `db-proof/run.mjs` and `serve.mjs` (the one pg_cron statement is stubbed exactly as CI does) | `db-proof` |

## Findings fixed by this review (both migrations were unapplied, so edited in place)

1. **`fs_rollout_allows` could fail OPEN.** It was `NOT (SELECT kill_switch …) AND COALESCE(company enabled, false)`.
   If the singleton state row were ever missing, the subquery is `NULL`, `NOT NULL` is `NULL`, and `NULL AND true` is `NULL` — which the
   callers' `IF NOT …` treats as "not denied". It now reads
   `COALESCE((SELECT NOT kill_switch …), false) AND COALESCE((SELECT enabled …), false)`. A missing state row or a missing company
   row is a denial. Proof: `db-proof` deletes the state row inside a rolled-back transaction with the company enabled and requires
   `false`; mutating the SQL back to the old form makes that assertion fail (mutation-checked).
2. **`fs_save_evaluation` wrote without an audit event.** Now records `EVALUATION_RECORDED` when the evaluation is new (the
   `CHECK` on `financial_statement_audit_events.action` was extended in the same migration).
3. **The publication gate asserted the wrong rule id** (`financial-position-equation` instead of the real `sfp-equation`). Caught by
   the new contract test that resolves every mandatory reconciliation id against the rule pack; fixed, and the SQL gate now has a
   database assertion (an SFP-equation waiver is refused).

## Decisions that are deliberate (recorded so a reviewer does not "fix" them)

* **Publication role.** Reviewed/Final require `owner` or `partner` — stricter than the project's general sign-off rule
  (partner or manager). This is intentional for this new state machine; widening it is a product decision, not a review fix.
* **`get_member_company_ids()`** is the existing `SECURITY DEFINER` helper (accepted members plus the company owner). The new
  policies reuse it rather than introduce a second membership definition.
* **Viewer** members can read history but not write (`fs_actor_member_id` requires a non-viewer role). `financial_statements_workspace_access` also returns the caller's own role (a non-viewer row wins, as in the actor resolver) purely as a display hint so the UI can render a viewer read-only; no authority derives from it.
* **`financial_statement_framework_requirements`** is reference data readable by any signed-in user (it holds no tenant data);
  changing a framework's requirements is a new migration, never an UPDATE (the append-only trigger enforces this).

## Not verified (hosted-only)

Real GoTrue tokens, PostgREST schema-cache/grant exposure, the managed `supabase db push` path, and the realtime publication are
not exercised by any local proof. See `HOSTED_STAGING_ACCEPTANCE.md`; `HOSTED_STAGING_RESULT=BLOCKED_MISSING_STAGING_PROJECT`.
