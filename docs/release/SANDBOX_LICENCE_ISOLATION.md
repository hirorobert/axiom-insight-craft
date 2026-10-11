# DEFECT-SANDBOX-LICENCE-PRODUCTION-LEAK-001: a sandbox payment granted production access

- **Severity:** high (access control).
- **Status:** fixed in source by migration `20261031110000_sandbox_licence_isolation.sql` (batch **commercial-p3**). **Applied** on the hosted database as drizzle `0053` (hosted id 54, 2026-10-11), the registered wrapper byte for byte. The hosted preflight and postcondition outputs, and any P3-5 owner decisions, are not recorded in this repository.
- **Superseded:** `20261031100000_sandbox_licence_isolation.sql`. Its wrapper was submitted once and failed atomically with `PT422 CANCELLED_LICENCE_IMMUTABLE`; see §0. **Never submit it.**
- **Applied delta:** `COMMERCIAL_P3_LOVABLE_DELTA.md`.
- **Reported instance:** licence `ba803893-8116-454f-bea2-0f2a7c7f2603`, created by a sandbox purchase on the hosted project.

## 0. The failed submission and its correction (2026-10-11)

**What happened.** The first wrapper, `20261031100000`, was submitted to the hosted database and failed:
- error `PT422 CANCELLED_LICENCE_IMMUTABLE`, raised by `commercial_cancelled_future_licence_guard`;
- the failing statement was the containment step, `UPDATE … SET status = 'SANDBOX'`, on a sandbox licence that was already `CANCELLED` (a future licence cancelled through `admin_cancel_future_licence`);
- the wrapper is one statement in one transaction, so nothing was written and the journal stayed at **53**.

**Reproduced on real PostgreSQL** with the hosted scenario under a 53-row journal:
- an `ACTIVE` sandbox licence;
- a `CANCELLED` future sandbox licence;
- an `ACTIVE` legacy payment licence with no provable environment, shortened by a sandbox upgrade.

Submitting the superseded wrapper through the hosted executor model fails with the same error. Every row and object is unchanged, and the journal stays at 53. The proof keeps this as a permanent check.

**The guard's complete restrictions.** For a `CANCELLED` licence with a `FUTURE_LICENCE_CANCELLED` audit row, the guard refuses any change to status, plan, source, account, additional seats, start or end. It does not cover `provenance` or `provenance_evidence`. The correction therefore never changes a cancelled licence's status. It only records the provenance, which the guard allows; skipping the status change while touching any guarded column would still fail. No trigger is disabled, and no immutability is relaxed.

**Corrections in `20261031110000`.**

| Area | Superseded behaviour | Correction |
|---|---|---|
| Cancelled sandbox licence | Containment set status `SANDBOX`, which the guard refuses | Stays `CANCELLED`. Its provenance is recorded as `SANDBOX_PAYMENT`, with one `SANDBOX_PROVENANCE_RECORDED` audit row. |
| Invariant | `SANDBOX_PAYMENT` ⇔ status `SANDBOX` | `SANDBOX_PAYMENT` ⇒ `SANDBOX` or `CANCELLED`; neither grants, and neither can return to a granting status. `SANDBOX` ⇒ `SANDBOX_PAYMENT` is unchanged. |
| Provenance review | The guard allowed `REVIEW_REQUIRED` → reviewed on any write | Allowed only inside `admin_resolve_licence_provenance`, for the one licence it is reviewing, through a transaction-local setting the procedure sets and clears. A direct write is refused with `LICENCE_PROVENANCE_IS_FIXED`. Reviewing a cancelled licence as sandbox keeps it `CANCELLED`. |
| Term restoration | Extended the shortened licence in place. For a paid term this would have been refused by `commercial_annual_term_licence_guard`, because a paid term may only end earlier. | Adds a **continuation term** (source `TERM_RESTORED_AFTER_SANDBOX`) from the current end to the end recorded by the term's own grant. The original licence is never changed. See §5. |
| Manual grant | Its paid-term protection matched `*_VERIFIED_PAYMENT` sources only | Also protects `PRODUCTION_PAYMENT` provenance, so a restored paid continuation cannot be shortened (`PAID_TERM_WOULD_BE_SHORTENED`). |

**Registration.** The superseded source is quarantined byte for byte, after a comment-only notice, in `supabase/migrations_historical/20261031100000_sandbox_licence_isolation.sql.historical` (48,537 B, `c7b43ab1…`). Its wrapper is kept unchanged in `release/wrappers_historical/` (50,109 B, `36bd80c0…`). Both are pinned in `scripts/db-proof/lib/parkedMigrations.mjs` (`SUPERSEDED_SUBMISSIONS`). Neither is a registered submission form for any source, so a hosted journal entry mirroring them would fail the migration-authority guard closed. `src/lib/__tests__/supersededSubmissions.test.ts` checks all of this. The replacement is a new forward migration with its own source commit, wrapper and registered forms. No pinned bytes were replaced.

**Concurrency.** The superseded wrapper's admin calls did not run on the hosted database: it failed in its containment step and rolled back. The replacement applies from the same state.

**Note on the review setting.** The transaction-local setting stops accidental or client-side provenance writes. It is not a boundary against the table owner or the service role, which hold full rights on the table anyway. `anon` has no access to `commercial_licences`, and `authenticated` has `SELECT` only.

## 1. Reproduction (real PostgreSQL, before any change)

`scripts/db-proof/sandboxLicenceIsolation.mjs`, group *Before the correction*. These checks run on the full migration chain without `20261031110000`.

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
| Access decisions | Every consumer selects `status IN ('ACTIVE','GRACE')` | A sandbox licence was `ACTIVE` | A sandbox licence is `SANDBOX`, or `CANCELLED` if already cancelled. The table guard enforces this. |
| Order reads | `get_checkout_status`, `get_my_payments` | No environment | `provider_environment` and `grants_access`. The status page shows "Test payment received · no plan was activated"; Orders shows "Test payment · no access". |

**The invariant** is enforced at the table, independent of the platform state. A licence whose provenance is `SANDBOX_PAYMENT` is status `SANDBOX`, or `CANCELLED` if it was already cancelled, which is terminal. Neither status is selected by any access decision. The guard trigger refuses any write that would break this, whoever attempts it: the service role, the table owner or `admin_transition_licence_status`. Provenance cannot change, except from `REVIEW_REQUIRED` to a reviewed value, and only inside `admin_resolve_licence_provenance` for the licence it is reviewing. The global `SANDBOX_ONLY` switch grants nothing.

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

**Review handling.** A `REVIEW_REQUIRED` licence keeps its current status: access is neither removed nor granted by assumption. It is listed by `admin_list_licence_provenance_review()`. A commercial administrator resolves it **once**, with a reason, using `admin_resolve_licence_provenance(licence, 'PRODUCTION_PAYMENT' | 'SANDBOX_PAYMENT' | 'MANUAL_GRANT', reason)`. A sandbox resolution contains the licence immediately; a cancelled licence stays `CANCELLED`. Every resolution is audited (`LICENCE_PROVENANCE_CONFIRMED` / `SANDBOX_PROVENANCE_CONFIRMED`). Resolve every such row **before opening any payment state again**.

## 5. Containment: licence `ba803893-8116-454f-bea2-0f2a7c7f2603`

1. **Automatic, audited, in the migration.** If its authoritative records prove it a sandbox payment (the preflight's sections 1–2 show this before anything is written), the licence becomes `SANDBOX`. Its id, dates, plan, source, payment event, checkout intent and every earlier audit row are unchanged. One `SANDBOX_LICENCE_CONTAINED` audit row records its previous and new state, with a system actor. A sandbox licence that is already `CANCELLED` stays `CANCELLED` and gets one `SANDBOX_PROVENANCE_RECORDED` row instead.
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

3. **If its purchase ended a genuine term:** the preflight's section 3 and the postcondition name that term. `admin_restore_term_ended_by_sandbox` restores it with a **continuation term**. The original licence is never extended, because a paid term may only end earlier.
   - **Lock and order:** it takes the account's advisory lock (the one the commit and manual grants take) and re-reads the term `FOR UPDATE`.
   - **Refusals:**
     - `TERM_ALREADY_RESTORED`: the term has been restored before; restoration happens once.
     - `TERM_NOT_PROVEN_GENUINE`: the term's provenance is not `PRODUCTION_PAYMENT` or `MANUAL_GRANT`, or it is no longer `ACTIVE`/`GRACE`. A `REVIEW_REQUIRED` legacy licence must be reviewed first.
     - `NOT_ENDED_BY_A_SANDBOX_PAYMENT`: no containment record names this term.
     - `TERM_CHANGED_SINCE_SANDBOX_PAYMENT`: the term's end no longer equals the sandbox licence's start.
     - `ORIGINAL_END_NOT_RECORDED`: the term's own grant audit row records no end. Nothing is guessed.
     - `TERM_WOULD_ALREADY_HAVE_ENDED`: the recorded end is past.
     - `RESTORED_TERM_WOULD_OVERLAP_ANOTHER_TERM`: another granting term covers the period.
   - **Result:** one `ACTIVE` licence with source `TERM_RESTORED_AFTER_SANDBOX`, from the current end to the recorded original end. It has the same plan and seats, the same provenance, and evidence naming the original term and the sandbox licence. One `TERM_RESTORED_AFTER_SANDBOX` audit row is written.

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
| `sandboxLicenceIsolation.mjs`: the reproduction; the hosted scenario under a 53-row journal through the **exact wrappers** (the superseded wrapper fails with `CANCELLED_LICENCE_IMMUTABLE` and changes nothing; the replacement with an injected late failure changes nothing; the replacement applies with exactly one journal row and refuses re-application); the documented preflight and postcondition run on that scenario (containment proven, the five history digests equal, open legacy decisions listed separately; a guessed restoration and an access function that counted sandbox licences each fail the postcondition); the gate; backfill; containment; cancelled sandbox licences (stay `CANCELLED`, grant nothing, cannot be reactivated by any write); the review-only provenance change; restoration by continuation (manual and production terms, concurrent restores with exactly one success, a changed term refused, the legacy licence refused until reviewed and then for want of a recorded grant); the invariant across every consumer, every platform state and direct writes; intact production, manual and placement terms; the paid-term guard; concurrent deliveries and replays; refunds; renewal lineage; review; reporting withholding | Local, real PostgreSQL | **45/45** |
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
