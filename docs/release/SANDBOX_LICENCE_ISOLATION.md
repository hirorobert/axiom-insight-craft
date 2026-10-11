# DEFECT-SANDBOX-LICENCE-PRODUCTION-LEAK-001: a sandbox payment granted production access

- **Severity:** high (access control).
- **Status:** fixed in source by migration `20261031100000_sandbox_licence_isolation.sql` (batch **commercial-p3**). Pending hosted application.
- **Applied delta:** `COMMERCIAL_P3_LOVABLE_DELTA.md`.
- **Reported instance:** licence `ba803893-8116-454f-bea2-0f2a7c7f2603`, created by a sandbox purchase on the hosted project.

## 1. Reproduction (real PostgreSQL, before any change)

`scripts/db-proof/sandboxLicenceIsolation.mjs`, group *Before the correction*. These checks run on the full migration chain without `20261031100000`.

| # | Observed |
|---|---|
| 1 | A verified **sandbox** payment created an `ACTIVE` licence with source `POLAR_VERIFIED_PAYMENT`, indistinguishable from a paid one. It granted access everywhere: the billing summary showed the plan as active, entity capacity was 1, seat capacity and capabilities came from the licence, and `create_entity` created a company. |
| 2 | Returning the platform to `PAYMENTS_DISABLED` did **not** revoke that access. |
| 3 | A sandbox **upgrade** ended a genuine term, because the placement rule ran for test money. |

## 2. Environment provenance, traced end to end

| Step | Where the environment lives | Before | After |
|---|---|---|---|
| Checkout | `payment_checkout_intents.provider_environment`. It is set at acquisition, and the platform state decides which environment may start. | Recorded | Unchanged |
| Settlement | `commit_verified_commercial_payment` checks that the provider's environment equals the intent's. | Checked, then **discarded**: the licence was `ACTIVE` either way | A sandbox payment records a **`SANDBOX`** licence and **never runs placement**. A production payment records `PRODUCTION_PAYMENT`. |
| Licence | `commercial_licences.provenance` (new) | Not recorded | `PRODUCTION_PAYMENT`, `SANDBOX_PAYMENT`, `MANUAL_GRANT`, `SYSTEM_FREE` or `REVIEW_REQUIRED` |
| Access decisions | Every consumer selects `status IN ('ACTIVE','GRACE')` | A sandbox licence was `ACTIVE` | A sandbox licence is always `SANDBOX`, enforced by the table guard |
| Order reads | `get_checkout_status`, `get_my_payments` | No environment | `provider_environment` and `grants_access`. The status page shows "Test payment received · no plan was activated"; Orders shows "Test payment · no access". |

**The invariant** is enforced at the table, independent of the platform state. A licence whose provenance is `SANDBOX_PAYMENT` is always status `SANDBOX`, and `SANDBOX` is excluded by every access decision. The guard trigger refuses any write that would break this, whoever attempts it: the service role, the table owner or `admin_transition_licence_status`. Provenance cannot change, except from `REVIEW_REQUIRED` to a reviewed value. The global `SANDBOX_ONLY` switch grants nothing.

## 3. Consumers covered

All 18 live functions that read licences were enumerated from the database itself. Each one decides access only from `ACTIVE`/`GRACE` licences, so the invariant covers them all.

| Consumer | Decides |
|---|---|
| `_account_current_plan_code`, `get_my_billing_summary`, `get_checkout_status` | Plan detection |
| `_resolve_entitlement_for_owner` | Capabilities |
| `_entity_capacity_for_account` (and through it `create_entity`) | Entity capacity |
| `_seat_capacity_for_account` | Seat capacity |
| `_commercial_licence_placement` and the commit | Renewal, upgrade and downgrade placement. Sandbox payments no longer run placement at all. |
| `admin_grant_commercial_licence` | Manual activation; it records `MANUAL_GRANT` |
| `admin_place_paid_licence` | Placement of a recorded payment. It keeps the intent's environment and refuses an intent with no proven environment. |
| `admin_*` lookups, `get_my_payments`, `_free_plan_inventory` | Display only |

## 4. Backfill: only from authoritative records

| Licence | Recorded as | Basis |
|---|---|---|
| Source `MANUAL_ADMIN_GRANT` | `MANUAL_GRANT` | Only `admin_grant_commercial_licence` writes this source. |
| Source `SYSTEM_DEFAULT_FREE` | `SYSTEM_FREE` | The retired free plan, which grants nothing. |
| Source `*_VERIFIED_PAYMENT`, linked to exactly one environment | `PRODUCTION_PAYMENT` or `SANDBOX_PAYMENT` | The `PAYMENT_CONFIRMED` event that names the licence, or the intent whose `placed_licence_id` names it; then that intent's `provider_environment`. |
| A payment licence that no record links, whose linked intent has no environment, or whose intents disagree | `REVIEW_REQUIRED` | Never assumed production. Each row records why in `provenance_evidence.basis`. |
| Anything written later by other code | `REVIEW_REQUIRED` (column default) | The three authorised writers always set provenance explicitly. |

**Review handling.** A `REVIEW_REQUIRED` licence keeps its current status: access is neither removed nor granted by assumption. It is listed by `admin_list_licence_provenance_review()`. A commercial administrator resolves it **once**, with a reason, using `admin_resolve_licence_provenance(licence, 'PRODUCTION_PAYMENT' | 'SANDBOX_PAYMENT' | 'MANUAL_GRANT', reason)`. A sandbox resolution contains the licence immediately. Every resolution is audited (`LICENCE_PROVENANCE_CONFIRMED` / `SANDBOX_PROVENANCE_CONFIRMED`). Resolve every such row **before opening any payment state again**.

## 5. Containment: licence `ba803893-8116-454f-bea2-0f2a7c7f2603`

1. **Automatic, audited, in the migration.** If its authoritative records prove it a sandbox payment (the preflight's sections 1–2 show this before anything is written), the licence becomes `SANDBOX`. Its id, dates, plan, source, payment event, checkout intent and every earlier audit row are unchanged. One `SANDBOX_LICENCE_CONTAINED` audit row records its previous and new state, with a system actor.
2. **If the preflight shows it `REVIEW_REQUIRED`** (no authoritative link), contain it explicitly:

   ```sql
   -- In the SQL editor, as the commercial administrator (replace the UUID):
   BEGIN;
   SELECT set_config('request.jwt.claims', '{"sub":"<commercial admin auth.users.id>","role":"authenticated"}', true);
   SET LOCAL ROLE authenticated;
   SELECT public.admin_resolve_licence_provenance('ba803893-8116-454f-bea2-0f2a7c7f2603', 'SANDBOX_PAYMENT',
          'Sandbox test purchase on the hosted project (DEFECT-SANDBOX-LICENCE-PRODUCTION-LEAK-001)');
   COMMIT;
   ```

3. **If its purchase ended a genuine term:** the preflight's section 3 and the postcondition name that term. Restore it to the end recorded by its own grant, once, audited. The restore is refused if the term has changed since.

   ```sql
   BEGIN;
   SELECT set_config('request.jwt.claims', '{"sub":"<commercial admin auth.users.id>","role":"authenticated"}', true);
   SET LOCAL ROLE authenticated;
   SELECT public.admin_restore_term_ended_by_sandbox('<ended licence id>', 'Restore the term a sandbox upgrade ended');
   COMMIT;
   ```

Nothing is deleted. No payment is fabricated, and no row is changed without its audit record.

## 6. Proof

| Proof | Kind | Result |
|---|---|---|
| `sandboxLicenceIsolation.mjs`: the reproduction, the gate, backfill, containment and restore, the invariant across every consumer and every platform state and against direct writes, intact production/manual/placement terms, the paid-term guard, concurrent deliveries and replays, refunds, renewal lineage, review, and reporting withholding | Local, real PostgreSQL | **29/29** |
| `selfCheckingWrappers.mjs` with `RELEASE_BATCH=commercial-p3` | Local, real PostgreSQL | **32/32** |
| `paymentProviders.mjs` 43/43, `paidTermPreservation.mjs` 18/18, `annualTerm.mjs` 91/91. These now exercise placement with **production** payments, because sandbox payments no longer place. | Local, real PostgreSQL | PASS |
| Status page "Test payment received" (jsdom, axe) | Mock server answers | PASS |
| End-to-end journey: card and mobile-money test payments show "Test payment received" with a `SANDBOX` licence and no plan; Orders shows "Test payment · no access"; manual activation after a test payment applies | Local app, mock providers | CI (`real-app-e2e`) |

## 7. Withholding, verified against current code

Financial reporting is withheld by the **reporting rollout**, not by any tax gate. `fs_rollout_allows(company)` requires the rollout's kill switch to be off **and** the company to be enrolled, and it fails closed. Every financial-statements RPC returns `feature_disabled` when it is false. The member-facing `financial_statements_workspace_access(company)` applies the same rule.

The proof shows two cases (§6):
- for a genuine production buyer, and for a genuine term holder who also made sandbox Firm purchases, `fs_rollout_allows` is `false` and workspace access is disabled;
- a sandbox-only buyer cannot even create a company, because the capacity wall refuses.

A purchase never writes to the rollout tables; `paidTermPreservation.mjs` checks this byte for byte.
