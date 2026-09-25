# PR #34 — staging-only deployment plan (P-07)

**Status: PLAN ONLY. Nothing in this document has been executed.** It needs separate, explicit authorization. It
targets **staging-replay `hplriydtdelehepgttul` only**, never production (`bvyivmmfjejbmqoydezk`). No payment
provider is activated. Only the owner or Lovable applies hosted migrations.

Preconditions:
- exact-head CI for the PR head is green;
- the three SQL files have had an independent local review;
- every disposable-PostgreSQL proof passes: `run`, `setupAuthority`, `serviceEnquiries`, `uploadLifecycle`,
  `entitlements`, `billingSuspension`, `planCapabilities`, and the `scripts/db-contract-tests` harness.

Migrations, in order (each refuses before any change if its predecessor is missing or it is already applied):
1. `20260925100000_global_capabilities_entitlements_pricing.sql`
2. `20260925110000_named_user_billing_suspension_and_invitation_lifecycle.sql`
3. `20260925120000_reporting_pack_issuance_binding.sql`
4. `20260925130000_solo_plan_no_free_plan_and_plan_feature_matrix.sql`
5. `20260925140000_workspace_capability_authorization.sql`
6. `20260925150000_can_user_act_on_workspace_minimum_grant.sql`

**Consequence to confirm before applying 130000:** there is no free plan. Every account without a current paid licence
(every account on the auto-provisioned Free licence today) becomes read-only when 130000 is applied: its data stays
readable, but it cannot create an entity, upload, prepare or issue until a plan is recorded
(`admin_ensure_billing_customer` then `admin_grant_commercial_licence(..., 'SOLO' | 'PRACTICE' | 'FIRM', ...)`). New
sign-ups cannot create a workspace until a plan is recorded (there is no checkout). List the affected accounts first
(read-only): accounts whose current licence is on the FREE plan.

Hosted apply goes through Lovable's apply journal (`drizzle/migrations`). `scripts/ci/assertMigrationAuthority.mjs`
lists these six as `PENDING_HOSTED_APPLY` and fails CI if a journal entry later diverges from its source. The one
historical divergence (MIGRATION-AUTHORITY-DRIFT-0006) is resolved forward by 20260925150000 (see §10).

## 0. Production deployment interlock (20260925130000–20260925150000)

These three migrations must NOT be applied to production until EITHER (A) checkout / payment activation exists, OR (B) an
approved manual activation procedure and the customer communication are ready. The transition they perform is
**FREE -> EXPIRED_READ_ONLY**: every open Free licence is ended and the account becomes read-only. **No plan (Solo or
any other) is granted by the migration**; a plan is only ever recorded by an explicit, audited administrator action.

Enforced, not only documented: `20260925130000` refuses (SQLSTATE 55000, before any change) on any database holding open
Free licences unless the operator sets, in the same session,
`SET cfoclose.free_retirement_approval = 'FREE_ACCOUNTS_INVENTORIED_NOTIFIED_AND_ACTIVATION_PATH_CONFIRMED';`
Setting it is the operator's attestation that steps 1–4 below are complete. Proven by `scripts/db-proof/planCapabilities.mjs`.

Production sequence (in order, each step recorded):
1. **Inventory** existing Free accounts (read-only): every account whose current licence is on the FREE plan, with its
   workspaces, members and last activity.
2. **Record the intended status** of each: paid plan to activate (which plan, seats, effective dates) or read-only.
3. **Notify affected users** of the change and its date (the owner's approved communication).
4. **Confirm the administrative activation path**: `admin_ensure_billing_customer` then `admin_grant_commercial_licence`
   (and `admin_set_licence_additional_seats`) by a commercial administrator, tested on staging; or checkout, if activated.
5. **Apply** 20260925100000 → 20260925150000 in order, setting the approval above for 20260925130000.
6. **Verify**: every former Free account is EXPIRED_READ_ONLY (no current licence, data intact, reads work, writes
   refused); every intended paid account is activated by its audited `LICENCE_GRANTED` event and operates.
7. **Run the RLS / capability regressions** (§8) and the invariant queries (§12) against the migrated database.

## 1. Read-only preflight (no writes)

```sql
-- Migration state: all three must be absent; the product and plans must match the refusal preconditions.
SELECT to_regclass('public.commercial_capabilities')          AS m100_applied,
       to_regclass('public.named_user_billing_suspensions')   AS m110_applied,
       to_regclass('public.reporting_pack_issuance_events')   AS m120_applied;
SELECT code FROM public.commercial_plans p JOIN public.commercial_products pr ON pr.id = p.product_id AND pr.code = 'CFOCLOSE';
-- Offers that will be retired (never deleted); any open checkout intent on them.
SELECT offer_code, is_active, is_purchasable FROM public.commercial_offers;
SELECT status, count(*) FROM public.payment_checkout_intents GROUP BY 1;
-- Licences by plan and status.
SELECT cp.code, cl.status, count(*) FROM public.commercial_licences cl JOIN public.commercial_plans cp ON cp.id = cl.plan_id GROUP BY 1, 2;
```

## 2. Member and invitation inventory (read-only)

```sql
-- People per billing account (account holder + accepted members + active grants), pending invitations separately.
WITH acct AS (SELECT DISTINCT user_id AS account FROM public.companies WHERE user_id IS NOT NULL)
SELECT a.account,
       (SELECT count(DISTINCT fm.user_id) FROM public.firm_members fm JOIN public.companies c ON c.id = fm.company_id
         WHERE c.user_id = a.account AND fm.accepted_at IS NOT NULL AND fm.user_id <> a.account) AS accepted_members,
       (SELECT count(DISTINCT g.grantee_user_id) FROM public.workspace_capability_grants g JOIN public.companies c ON c.id = g.company_id
         WHERE c.user_id = a.account AND g.revoked_at IS NULL) AS grantees,
       (SELECT count(*) FROM public.firm_members fm JOIN public.companies c ON c.id = fm.company_id
         WHERE c.user_id = a.account AND fm.accepted_at IS NULL) AS pending_invitations,
       (SELECT count(*) FROM public.companies c WHERE c.user_id = a.account AND COALESCE(c.is_active, true)) AS active_entities
  FROM acct a ORDER BY 2 DESC, 3 DESC;
```

## 3. Accounts that will exceed their future allowance

Every existing account resolves to **Free** (one named user, one entity) unless it holds a current paid licence. The
legacy `PAID` plan keeps 25 entities but also has one named user. Migration `20260925110000` ends with
`reconcile_all_named_user_allowances()`. For every account whose other active people exceed its allowance, that call
records `ENTITLEMENT_LOST` suspensions for everyone except the account holder. **Nothing is deleted.** Those people lose
access until the account holder chooses who stays active, or seats are recorded. Before applying, list them (read-only):

```sql
-- After 100000 is applied (read-only), before 110000: who would be locked out.
SELECT a.account, cap->>'plan_code' AS plan, (cap->>'allowed_named_users')::int AS allowed,
       (SELECT count(*) FROM public._account_named_users(a.account, false)) AS active_now
  FROM (SELECT DISTINCT user_id AS account FROM public.companies WHERE user_id IS NOT NULL) a,
       LATERAL (SELECT public._seat_capacity_for_account(a.account) AS cap) c
 WHERE (SELECT count(*) FROM public._account_named_users(a.account, false)) > COALESCE((cap->>'allowed_named_users')::int, 1);
-- Accounts over entity capacity (existing entities stay; only new / reactivated ones are refused).
SELECT user_id, count(*) FROM public.companies WHERE COALESCE(is_active, true) GROUP BY 1 HAVING count(*) > 1;
```

The owner decides, per affected account, whether to record purchased seats (`admin_set_licence_additional_seats`) or
an override **before** step 2 of the migration order, so nobody is suspended unintentionally. This is a product
decision; the migration will not guess.

## 4. Migration order

1. `20260925100000` (capabilities, walls, catalogue, entity capacity, seat model).
2. Record any agreed seats or overrides (§3).
3. `20260925110000` (suspension, invitation lifecycle, redefinition of 19 access functions, reconcile).
4. `20260925120000` (Reporting Pack issuance binding; replaces the 4-argument `issue_reporting_pack`).
5. Record plans for the accounts that must keep operating (see the consequence above).
6. `20260925130000` (Solo, Free retired, plan × capability matrix), `20260925140000` (capability authorization,
   Close Assurance wall), `20260925150000` (minimum grant; idempotent, safe to re-apply).

Apply each migration as one transaction. Each one refuses (SQLSTATE 55000) before any change if applied twice or out of order.

## 5. Edge Function deployment order (after all three migrations)

Old function code calls `issue_reporting_pack` with four arguments, which `20260925120000` removes. So deploy the
functions and the frontend immediately after migration 3, in this order:

1. Shared-module consumers that authorize membership, which now also require an active named user:
   `kinga-tax-engine`, `generate-disclosure-notes`, `generate-management-letter`, `financial-statement-intake`,
   `comparative-assurance-engine` (new), `kinga-comparative-engine` (adapter).
2. Paid-action gates: `generate-xbrl`, `maono-compute`, `maono-risk`, `maono-decide`, `maono-cashflow`,
   `maono-root-cause`, `maono-monitor`.
3. `invite-firm-member`: reserve before email; releases the seat when the email fails.
4. Also importing changed shared modules (no behaviour change intended): `commercial-create-checkout`,
   `commercial-payment-status`. `process-trial-balance` has a type-only dependency, so redeploying it is optional.
5. The frontend (Lovable), because the export sites call the new `issue` / `consume` RPCs.

`supabase/config.toml` adds `[functions.comparative-assurance-engine] verify_jwt = false`, the same as the adapter.

## 6. Rollback / forward-fix

The migrations are forward-only. Suspension rows, issuances and their events are records, and must never be deleted.
- **Stop enforcing suspension (forward-fix migration):** drop the restrictive policy `firm_members_named_user_active`
  and the reconcile triggers, and restore the 19 access functions from their previous definitions. The proof records
  and compares them.
- **Reporting Pack:** restore the 4-argument `issue_reporting_pack` alongside the 5-argument one.
- **Walls:** drop the wall triggers.

Prefer a targeted forward fix over any rollback. Always re-run the invariant queries (§12) afterwards.

## 7. Hosted concurrency tests (staging)

Run with twelve parallel callers each, using dedicated staging fixtures only:
- simultaneous invitations against a one-seat allowance → exactly one reserved;
- simultaneous acceptance and cancellation of one invitation → exactly one outcome;
- simultaneous reactivation selections from the same roster → exactly one applied, the rest stale;
- simultaneous seals of one issuance → exactly one sealed;
- simultaneous entity creations at capacity.

## 7b. Reconciliation write wall (staging)

For a workspace whose plan has ended: matching, categorizing, scoring and resolving an existing reconciliation, direct
table writes (client and service role), `safisha_append_evidence_file`, `safisha_resolve_exception` and EFDMS inserts
are all refused (PT402 CLOSE_ASSURANCE / 42501), and the reconciliation, exception, audit, upload and finding rows are
unchanged. History remains readable.

## 8. RLS regression (staging)

Run the existing Staging RLS Regression job **after** the migrations. The CI job currently runs against the old schema.
Add cases:
- a billing-suspended member reads zero rows from `firm_members` (their own), `statement_sign_offs`, `tax_computations`
  and `get_member_company_ids()`;
- an outsider gets an identical answer;
- an active member is unaffected.

## 9. Invitation tests

- An invitation reserves a seat and shows its expiry.
- An expired invitation cannot be accepted and frees its seat.
- The account holder's cancellation frees the seat.
- Reissuing the same person refreshes one row.
- An email failure (simulate with an invalid address) releases the seat.
- An already-registered person is reserved and accepted at next sign-in.

## 10. Downgrade and reactivation tests

- A Firm account with ten active people moves to Free → only the account holder is active; nine suspended; memberships intact.
- A planned reduction via `admin_prepare_planned_reduction`, then `admin_set_licence_additional_seats` → the chosen
  person stays; an unplanned reduction is refused with `SELECTION_REQUIRED`.
- Restoring a seat reactivates nobody until `choose_active_named_users`.
- **MIGRATION-AUTHORITY-DRIFT-0006:** resolved by `20260925150000`. After applying, confirm (read-only) that
  `has_function_privilege('authenticated', 'public.can_user_act_on_workspace(uuid,uuid,text)', 'EXECUTE')` is false.

## 11. Reporting Pack issuance tests

- Free → `entitlement_required` and an audit `REFUSED` event.
- Practice → issue, then seal with the file's SHA-256 → `verify_reporting_pack` reports it official.
- Cross-user, cross-workspace, cross-period, cross-output and cross-format seals are refused.
- A second seal is refused; an expired (older than 10 minutes) issuance is refused.
- A licence expired between issue and seal is refused.

## 12. Post-apply invariant queries (must all return zero rows)

```sql
-- Active named users never exceed the allowance (or only the account holder when capacity is unknown).
SELECT a.account FROM (SELECT DISTINCT user_id AS account FROM public.companies WHERE user_id IS NOT NULL) a
 WHERE (SELECT count(*) FROM public._account_named_users(a.account, false) u
         WHERE public._account_named_user_access_active(a.account, u.named_user_id))
       > COALESCE((public._seat_capacity_for_account(a.account)->>'allowed_named_users')::int, 1);
-- No membership, grant or suspension was deleted: compare counts with the §2 inventory (equal or higher).
-- No purchasable offer exists.
SELECT id FROM public.commercial_offers WHERE is_purchasable;
SELECT id FROM public.commercial_additional_seat_prices WHERE is_purchasable;
-- Every suspension is for a non-holder and at most one is open per person per account.
SELECT account_user_id, user_id FROM public.named_user_billing_suspensions WHERE lifted_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1;
-- Every sealed issuance has a SEALED event.
SELECT i.id FROM public.reporting_pack_issuances i WHERE i.consumed_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.reporting_pack_issuance_events e WHERE e.issuance_id = i.id AND e.event = 'SEALED');
```

The staging CI job must then run against this migrated schema, not the old one.
