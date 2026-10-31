# IPSAS mutations - authority and serialisation contract

Status: **implemented in the unapplied migration `20261207100000` (the helper) and called by `20261208100000` and `20261210100000`, proven on a disposable database by two proofs: `scripts/db-proof/ipsasAuthorityOrdering.mjs` (15 cases, authority withdrawn while a mutation waits for its locks) and `scripts/db-proof/ipsasAuthorityRaces.mjs` (41 cases, authority withdrawn after admission and before commit; added after the independent review of #229 showed that the first contract did not cover that window). Nothing is installed.** The first two sections below describe the earlier finding and its fix and are kept as history; the contract that now applies starts at "The contract (revised ...)". Applicable charter requirements: 11.3 (each authoritative save carries an authenticated actor, exact scope, expected revision and request identity; concurrent relevant changes refuse the transition), 11.4 (capability checks run server-side on every authoritative write; tests include revoked access and direct-RPC attempts).

## The finding (independent review, source-level) - CONFIRMED
`ipsas_save_preparation`, `ipsas_confirm`, `ipsas_save_grants` and `ipsas_confirm_grant` called `_ipsas_refusal` **before** acquiring their request and company-period advisory locks and did not judge authority again afterwards. A request could pass, wait behind other work, and then write after its authority had been revoked. Revocation (`revoke_member_capability`) takes a *different* lock (`workspace_member_capabilities:<company>:<person>`), so nothing ordered the two.

Executable evidence (deterministic, multi-session, no sleeps for ordering; each scenario holds the protected lock, proves the mutation is WAITING via `pg_locks`, commits the change through the normal path, releases, then inspects persisted rows with an independent connection):

| | Before (a992cad SQL) | After |
|---|---|---|
| Proof total | 4 / 15 passed | **15 / 15** |
| Revoked while waiting - save preparation / confirm / save grants / confirm grant | **recorded or confirmed with revoked authority** (outcome `recorded` / `confirmed`, row written) | `forbidden`, no row |
| Revoked while waiting - **idempotent replay** of an earlier request | revoked actor handed the stored receipt | `forbidden` |
| Membership withdrawn / rollout closed / framework changed while waiting | mutation recorded | `forbidden` / `feature_disabled` / `framework_not_ipsas_accrual` |
| Revocation vs an in-flight mutation | revoker committed immediately (no ordering) | revoker **waits** for the mutation's transaction; mutation first, then revocation |
| Transaction-long snapshot (REPEATABLE READ) | mutation proceeded | fails closed (`25000 IPSAS_AUTHORITY_ISOLATION`) |
| Contention: 8 saves + 3 confirms + 2 revocations at once | terminates | terminates, no error, no deadlock, rows account exactly for the recorded outcomes |

## The contract (revised after the independent review of #229, finding 1; this supersedes the earlier text of this section)
**Admission** is the acquisition of the locks below by `_ipsas_authorize_mutation`, followed by a fresh re-judgement of authority. It happens after the mutation's request and company-period locks and **before any replay lookup or write**, in all five mutation RPCs (preparation save, confirmation, grants save, grant confirmation, presentation save).

**Ordering guarantee.** From admission until the mutation's transaction **commits**, no withdrawal of an authority input can complete. Every writer of those inputs either *waits for the mutation's transaction*, or - when the withdrawal is already in flight - makes the mutation wait and then refuse, or makes it refuse at once with `authority_changing` (nothing persisted, safe to retry). A withdrawal that committed before admission is seen by the re-judgement and refused with the usual named outcome (`forbidden`, `feature_disabled`, `framework_not_ipsas_accrual`). So a mutation never records a write, and never produces a response, under authority that was withdrawn before its commit.

| Authority input | Writers found (inventory of every function and trigger that modifies it) | How they are ordered with an admitted mutation |
|---|---|---|
| Explicit capability grant / revocation of this person, new-membership provisioning | `grant_member_capability`, `revoke_member_capability`, `firm_members_capability_template_sync` (INSERT) | member-capability advisory key: exclusive there, shared here |
| Plan | commercial-licence writers | plan advisory key (shared here, already held from the early refusal) |
| Billing suspension, named-user seats | `_apply_named_user_selection`, `_lift_named_user_suspensions_unlimited`, `reconcile_named_user_allowance` | `cfoclose.named_user_seats:<account>`: exclusive there, shared here (taken after the plan key, the order plan writers use) |
| Framework | `set_company_reporting_framework` | `cfoclose.fr_company:<company>`: exclusive there, shared here |
| Rollout opening / closing, kill switch, beta reporting | `fs_set_company_rollout`, `fs_set_kill_switch`, `internal_beta_admin_open_reporting`, `internal_beta_admin_close_reporting` | `financial_statements_rollout:<company>` and `:kill_switch`: exclusive there, **try-locked** here and never waited for (open and close take the two keys in opposite orders, so waiting could deadlock); unavailable means `authority_changing`. Row share locks (NOWAIT) on the rollout, beta-policy and enrolment rows also order any writer that bypasses the keys |
| Membership removal, demotion, cancelled invitation | plain UPDATE / DELETE on `firm_members` (the Team panel, RPCs, cascades) and the trigger that revokes the person's capability rows | **row share locks** held to commit: the person's membership row, then its open capability rows, then the company row; the writer's UPDATE / DELETE waits |

Replays are covered (admission precedes the replay lookup). **Fail closed.** The re-judgement needs READ COMMITTED; under a stricter isolation level the helper raises `25000` rather than judge on a snapshot that cannot see what committed while it waited. `lock_timeout` (5 s, scoped to the helper) is an operational protection that turns a pathological wait into `authority_changing`; it is not what orders anything.

## Lock order and deadlock avoidance
`[plan shared, early] -> request -> company-period -> member-capability (S) -> plan (S, re-entrant) -> named-user seats (S) -> framework (S) -> rollout (try, never waits) -> membership row -> capability rows -> company row`. The row order is the order the writers' own triggers touch the same rows; the advisory order follows the plan writers' (plan then seats). The rollout keys are never waited for. A mutation therefore holds no lock a writer needs before it takes the next one in an order the writer does not also use, and the proof's contention case (mixed saves, confirmations, explicit revocations, a membership removal and a rollout closure at once) terminates without error. A deadlock the database detects would abort the transaction, persisting nothing.

## What is claimed, and what is not
- **Proven** (`scripts/db-proof/ipsasAuthorityRaces.mjs`, 41 cases, deterministic: a test-only barrier on the INSERT parks each mutation after admission; observed lock state, never a sleep, decides each ordering): every one of the five RPCs against every writer in the table above, in both orderings, plus replay, the fresh-read refusal afterwards, no partial writes and contention. On the reviewed candidate the same proof fails (membership removal, demotion, rollout closure and framework change complete while an admitted mutation is pending, and the mutation then persists). The reviewed 15-case proof `ipsasAuthorityOrdering.mjs` still passes.
- **Not a lock:** time. A licence expiring by the clock, or any clock-based condition, is not a writer; authority is judged at admission.
- **Not covered:** a new writer added later that neither takes one of these keys nor updates / deletes one of these rows. The inventory above is the repository as of this change, taken from the database's own catalogue.
- **Out of scope:** the *reader* (`ipsas_prep_context`, `ipsas_grants_context`, `ipsas_statement_review` are reads under their own snapshot and refuse as soon as a withdrawal commits), and the browser.

## Consequences for installation
`_ipsas_authorize_mutation` now depends on `_plan_write_lock(uuid)` and on the rollout, beta-policy, enrolment, membership and capability tables; the preparation transport's prerequisite list names them and refuses, changing nothing, if any is absent. The helper is a function in `20261207100000`; the grants and statement-review migrations call it. Both IPSAS transports were regenerated through their generators. Nothing here is installed.
