# Financial-statements workspace — controlled activation

Status: **designed, implemented and proven on disposable databases; nothing is applied to, deployed to or enabled on any hosted project.**

## 1. Design: the server decides, and the default is "no"

| Layer | What it is | Who can change it | Default |
|---|---|---|---|
| Ship gate (browser code) | `FINANCIAL_STATEMENTS_WORKSPACE_ENABLED`, `FINANCIAL_STATEMENT_PERSISTENCE_ENABLED` — plain source constants | A reviewed commit only. No `VITE_*`, no `localStorage`, no URL, no cookie, no environment file feeds them (asserted by `workspaceGate.test.ts`). | `false` |
| Server rollout | `financial_statements_rollout_companies.enabled` per company | Only `fs_set_company_rollout(...)`, callable by `service_role` only | every company **denied** |
| Kill switch | `financial_statements_rollout_state.kill_switch` | Only `fs_set_kill_switch(...)`, `service_role` only | not engaged |
| Audit | `financial_statements_rollout_audit` | Written by the two functions above; UPDATE/DELETE rejected by trigger even for the table owner | empty |

Every persistence write function (`fs_ingest_evidence_batch`, `fs_save_report_version`, `fs_save_evaluation`, `fs_append_decision`, `fs_apply_correction_group`, `fs_set_publication_state`) calls `fs_actor_member_id(company)`, which requires **all** of: an authenticated session (`auth.uid()`), an accepted non-viewer membership of that company, and `fs_rollout_allows(company)` (kill switch off **and** company allowlisted). A caller who fails the last check receives `PT403 FEATURE_DISABLED`; the UI shows "Saving is not enabled for this company". Reads stay governed by RLS, so history remains readable after a company is deactivated or the kill switch is engaged.

The browser learns its own status only through `financial_statements_workspace_access(company)`, which answers `ENABLED | NOT_A_MEMBER | KILL_SWITCH | NOT_ALLOWLISTED`. The client treats anything other than an explicit `enabled: true` as a denial. There is no client-side way to turn the feature on for a company the server has not allowlisted.

## 2. Preconditions (all must be true before any activation)

1. `docs/release/FINANCIAL_STATEMENTS_RELEASE_PACKAGE.md` checklist complete and the release manifest verified.
2. Migrations `20260920000000` and `20260920100000` applied **through the project's reviewed, managed process** (this repository does not apply them), then `docs/release/sql/02_postcondition.sql` passes.
3. The ship gates flipped in a separate, reviewed commit (only after step 2), deployed by the normal frontend path.
4. A named operator and an on-call owner for the canary window.

## 3. Runbook

1. **Preflight** — run `sql/01_preflight.sql` read-only on the target. It must print `PREFLIGHT OK`.
2. **Apply** the two migrations (managed process). Run `sql/02_postcondition.sql`: it must print `POSTCONDITION OK` — default denied, zero companies enabled, kill switch off, least privilege.
3. **Canary company** — run `sql/03_activate_company.sql` for exactly one internal company (operator name and ticket id are mandatory and audited). Have a partner and a preparer of that company complete: upload evidence → generate → save → conflict check (two tabs) → review → mark Reviewed → export.
4. **Watch** — `SELECT * FROM financial_statements_rollout_audit ORDER BY seq DESC;` and `SELECT count(*) FROM financial_statement_reports;`. Expected error classes in logs: `PT403` (not allowlisted), `42501` (viewer/non-member), `PT409` (stale/replay). Anything else is an incident.
5. **Widen** in steps of one company or one small cohort, re-running the watch step each time.
6. **Rollback / stop** — see §4.

## 4. Stopping and rollback

| Situation | Action | Effect |
|---|---|---|
| One company misbehaves | `sql/04_deactivate_company.sql` | That company's writes stop at once (PT403); its saved history stays readable and intact |
| Anything suspicious anywhere | `sql/05_kill_switch.sql` | Every company's writes stop at once; reads unaffected; release with `fs_set_kill_switch(false, …)` |
| Frontend defect | Flip the ship gates back to `false` in a reviewed commit and redeploy | The workspace stops rendering; server state untouched |
| Data-model defect | **Forward-only**: ship a new migration. History tables are append-only and `ON DELETE RESTRICT`; nothing here is dropped or rewritten to roll back | Saved versions are never lost |

No step above deletes history, and none needs a database restore.

## 5. Evidence that this behaves as designed

* `scripts/db-proof/run.mjs` — 154 assertions on a real PostgreSQL 16, replayed from zero: default-denied rollout, kill switch, audit immutability, tenancy, RLS, stale/replay/conflicting replay, concurrent writers, atomic correction-group rollback, finalisation gate, exact money/JSON round trip.
* `src/lib/financialStatementsWorkspace/saveFlow.pg.test.ts` — the real TypeScript client against the real SQL through a loopback bridge (server-derived reviewer, contiguous versions, stale refusal, viewer/outsider/not-allowlisted denial).
* `scripts/release/verify-release-sql.mjs` — executes the preflight, postcondition and operator scripts and checks the audit trail.
* Browser E2E on the non-production harness (see the release package for what was and was not covered).

## 6. Not covered here (state this in any acceptance review)

* The proofs use a **simulated** `auth.uid()` (the same GUC mechanism PostgREST uses), not GoTrue-issued JWTs. The real Supabase Auth → PostgREST → `auth.uid()` path is standard but was not exercised.
* Nothing was applied to a hosted Supabase project, so the managed migration path, hosted role grants and hosted PostgREST exposure are unverified.
