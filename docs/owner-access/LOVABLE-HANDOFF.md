# Lovable executable handoff — Platform owner, access administration & entity allowances

One hand-off to apply this feature on the hosted project. Nothing here changes pricing, customer entity limits, or payment
activation. Do not provide production credentials in chat. Do not claim activation until the hosted read-back (step 5) passes.

## 1. Tested source
- **Branch:** `feature/owner-access-entity-limits-20261015`
- **PR:** **#130** — "Platform owner, access administration & entity allowances"
- **Tested head commit:** **`d09e7c9`** (its own CI is the authority)
- **CI on `d09e7c9` — all required green:** Golden Fixtures, Release Gate (full suite), Real-app E2E (local Supabase),
  Disposable-DB Contract, Supabase Migration Audit, Edge ×2, Lint/Build/Typecheck, Merge-Conflict. Staging RLS Regression is
  skipped (manual). Plus **owner-access-proof** (PostgreSQL 17): **31/31** — full-chain replay + the exact migration + the real
  policies/triggers/capability functions (directive §16).

## 2. Migration + authoritative registration
- **File:** `supabase/migrations/20261104100000_platform_owner_access_and_entity_allowance.sql`
- **SHA-256:** `095f9b3952bbc46d383cf43702a72e6b0f3b950e82cfb068963de8dcbdb332dd`
- **Status today:** authored, **PENDING hosted application** (the migration-authority parity test lists it as `pending`, never
  as drift). It is additive and forward-only; it edits no prior migration.
- **Registration (authoritative — not ad-hoc psql):** apply through the hosted **Drizzle apply journal** mechanism so the
  journal mirrors `supabase/migrations/20261104100000…` exactly (the same mechanism `scripts/ci/assertMigrationAuthority.mjs`
  proves). Verify the SHA-256 above against the applied body before and after. Once journaled, re-running
  `assertMigrationAuthority` will move it from `pending` to a mirrored entry with no drift.
- **What it changes (all additive):** `commercial_admins.authority` tier; `entitlement_overrides.unlimited` + relaxed
  `chk_eo_capacity`; extends `_entity_capacity_for_account`, `_resolve_entitlement_for_owner`, `company_entity_capacity_wall`;
  new tables `access_grant_events` (append-only) and `privileged_reauth`; the RPCs in §3. **No customer plan, price,
  entity_capacity value, or blocking path is changed** (REVIEW.md §B3; proof `CUSTOMER-UNCHANGED`).

## 3. Bootstrap — signature, prerequisites, guarantees
```sql
public.bootstrap_first_platform_owner(p_user_id UUID, p_reason TEXT) RETURNS JSONB
-- SECURITY DEFINER. REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role.
```
**Prerequisites**
1. Migration 20261104100000 applied (§2).
2. `auth.users` contains **cpahumphrey@gmail.com**, email **confirmed**; capture its immutable `id` (UUID). If absent/unverified,
   invite/confirm it first — do not fabricate an id.
3. Execute as the **service_role** (or database owner). No other role may call it.

**Call**
```sql
SELECT public.bootstrap_first_platform_owner('<VERIFIED_AUTH_USER_UUID>', 'initial platform owner');
```

**Guarantees (verified on PostgreSQL 17)**
- **Restricted to the authorized backend role:** `authenticated`/`anon`/`PUBLIC` are revoked; only `service_role` can execute it.
  (Further owners are added only via `grant_platform_owner`, which is platform-owner-only + recent-reauth.)
- **Cannot replace an existing owner:** if any active `authority='platform_owner'` row exists, it raises
  `PLATFORM_OWNER_ALREADY_EXISTS` (SQLSTATE 42501) and changes nothing. It never demotes or overwrites a current owner.
- **Safe to retry:** the write is a single transaction (`INSERT … ON CONFLICT (user_id) DO UPDATE` + one append-only audit row).
  If the first attempt rolled back, a retry establishes exactly one owner; if it had committed, the retry is cleanly rejected
  with `PLATFORM_OWNER_ALREADY_EXISTS` — never a duplicate, never a second owner, never a replacement.

## 4. Read-back verification (run after bootstrap; do not claim activation until these pass)
```sql
-- a) The exact user is the platform owner.
SELECT public.is_platform_owner('<UUID>');                       -- expect: true
-- b) Unlimited entity allowance, explicit.
SELECT (public._entity_capacity_for_account('<UUID>')) ->> 'unlimited',
       (public._entity_capacity_for_account('<UUID>')) ->> 'source';   -- expect: true, PLATFORM_OWNER_COMPLIMENTARY
-- c) Complimentary access to a released capability (no payment).
SELECT public._resolve_entitlement_for_owner('<UUID>','STATEMENT_CERTIFICATION') ->> 'status',
       public._resolve_entitlement_for_owner('<UUID>','STATEMENT_CERTIFICATION') ->> 'source';
       -- expect: ENTITLED, PLATFORM_OWNER_COMPLIMENTARY
-- d) A WITHHELD module is NOT granted (gate intact).
SELECT public._resolve_entitlement_for_owner('<UUID>','TAX_COMPUTATION') ->> 'status';   -- expect: NOT ENTITLED (UNKNOWN/…)
-- e) No payment/subscription/revenue was fabricated.
SELECT count(*) FROM public.commercial_licences cl
  JOIN public.billing_customers bc ON bc.id = cl.billing_customer_id
 WHERE bc.owner_user_id = '<UUID>' AND cl.provenance IN ('PRODUCTION_PAYMENT','SANDBOX_PAYMENT');  -- expect: 0
-- f) Exactly one audited bootstrap event.
SELECT grant_kind, source, reason FROM public.access_grant_events
 WHERE recipient_user_id = '<UUID>' AND grant_kind = 'PLATFORM_OWNER_GRANT';   -- expect: one BOOTSTRAP row
```

## 5. Deployment order
1. **Database:** apply migration 20261104100000 via the authoritative journal (§2). Verify SHA-256.
2. **Bootstrap (DB-only):** run `bootstrap_first_platform_owner('<UUID>', …)` as service_role (§3), then the read-back (§4).
3. **Edge Function:** deploy **`reauthenticate`** (`supabase/functions/reauthenticate`) — required for privileged grants
   (`config.toml` sets `[functions.reauthenticate] verify_jwt = true`). Reads work without it; writes need it.
4. **Frontend (Lovable Publish):** publishes the Access console route `/admin/access`, the owner-status line in
   Settings → Plan & access, and the workspace entity-allowance indicator. Purely additive; no existing page changes.

Order rationale: the migration must precede the Edge Function's `record_privileged_reauth` RPC and the frontend's RPC calls.
Bootstrap is DB-only and can run as soon as the migration is applied.

## 6. Recovery / safety notes
- To revoke platform ownership later: `revoke_platform_owner(p_user_id, reason, reauth_nonce)` — refuses to remove the **last
  active** platform owner. To revoke a complimentary grant: `revoke_access_grant(override_id, reason, reauth_nonce)` (effective
  immediately; no page refresh).
- This feature touches no sign-off, HESABU validation, distinct-signer, tenant-isolation, or withheld-module control, and no
  customer pricing/limit/blocking path. Rolling back the frontend/Edge Function is non-destructive; the DB objects are additive.
