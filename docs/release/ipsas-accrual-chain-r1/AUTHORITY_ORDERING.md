# IPSAS mutations - authority and serialisation contract

Status: **implemented in the unapplied migrations `20261207100000` and `20261208100000`, proven on a disposable database (`scripts/db-proof/ipsasAuthorityOrdering.mjs`, 15 cases). Nothing is installed.** Applicable charter requirements: 11.3 (each authoritative save carries an authenticated actor, exact scope, expected revision and request identity; concurrent relevant changes refuse the transition), 11.4 (capability checks run server-side on every authoritative write; tests include revoked access and direct-RPC attempts).

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

## The contract
1. **Early refusal (unchanged).** Each mutation first calls `_ipsas_refusal` - a cheap refusal that also takes the **shared plan lock** (`workspace_capability_allowed`).
2. **Mutation boundary.** It then acquires its request lock and its company-period lock (these may wait behind other work).
3. **Authority at the boundary (new).** Immediately after the boundary, and **before any replay lookup or write**, `_ipsas_authorize_mutation` (a) takes the **shared member-capability lock** for (workspace, actor) - the same key `revoke_member_capability`, `grant_member_capability` and the membership provisioning trigger take **exclusively** - and (b) judges membership, capability, plan, rollout and framework again on a **fresh statement snapshot** (READ COMMITTED), returning the same named refusals as the early check.
4. **Order of an explicit revocation and a mutation by that person is total.** Either the revocation committed before the mutation's boundary re-check - the mutation is refused - or the mutation holds the shared lock, so the revoker waits until the mutation's transaction ends - the mutation is recorded first and the revocation follows. A request can never both pass authority revoked before it reached the boundary and write.
5. **Replays are covered.** The boundary check precedes the replay lookup, so a revoked actor is refused instead of being handed the stored receipt.
6. **Plan changes** were already ordered by the existing plan lock: the mutation holds the shared plan lock from its early check, a plan change takes it exclusively and waits (proof case `order.plan-change-waits-for-an-in-flight-mutation`).
7. **Fail closed.** The re-check needs READ COMMITTED (the PostgREST and migrator default). Under a stricter isolation level the function raises `25000` rather than judging authority on a snapshot that cannot see what committed while it waited.

## Lock order and deadlock avoidance
`request -> company-period -> member-capability (shared) -> plan (shared)`. The plan lock is acquired first in practice (by the early check) and is **re-entrant** for the same session, so the later acquisition never waits behind a queued exclusive plan change - removing the early check would create a cycle (a mutation waiting on a company-period lock held by another that waits for a plan lock queued behind a plan change), which is why it is kept. The member-capability writers take only their own lock, so no cycle includes them. The contention case runs mixed saves, confirms and revocations concurrently and requires every operation to terminate without error.

## What is serialised and what is only ordered by snapshot - stated precisely
- **Serialised (one is first, the other waits):** explicit capability grants/revocations of that person; plan changes.
- **Honoured if committed before the boundary re-check, ordered after the mutation if committed later (not blocked):** membership withdrawal that does not go through the member-capability functions, rollout closure, framework change, billing suspension of a named user. These cannot invalidate an already-recorded mutation; they stop the next one. A mutation is therefore authorised by the state at its boundary re-check plus the locks above, not by a lock on every input.
- **Out of scope:** authority of the *reader* (`ipsas_prep_context` / `ipsas_grants_context` are STABLE reads under their own snapshot); the browser (`IpsasPreparation` / `GrantsPreparation` only display what the server answers).

## Consequences for installation
The helper `_ipsas_authorize_mutation(uuid,uuid,text)` is a new function in `20261207100000`; the grants migration depends on it. The staged transports were regenerated through their generators (source bytes and fingerprints changed; see `TRANSPORT.md` / `GRANTS_TRANSPORT.md`). Both are uninstalled; no applied history is edited.
