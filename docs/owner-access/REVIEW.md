# Substantive review — migration `20261104100000` + `reauthenticate` function

Registry admission (adding the files to the inert-guard `added` set and the withholding `LATER` list) only lets CI run; it is
**not** a safety argument. This document is the substantive review. Evidence: `owner_access_proof.mjs` on PostgreSQL 17
(full-chain replay + the real functions/triggers/RLS), plus the reasoning below.

## A. Threat model
1. A non-owner (ordinary user, or a *commercial* admin) escalates to platform-owner.
2. A platform owner performs a privileged grant without a fresh credential (stolen/replayed session).
3. Complimentary access leaks across tenants, or silently fabricates revenue.
4. The change alters customer entity limits / prices / blocking (out of scope; pricing reopened).
5. The change weakens a financial control, tenant isolation, or a withheld-module gate.

## B. Migration review — change by change

### B1. `commercial_admins.authority` tier
- Additive column, default `'commercial'` → every pre-existing row keeps its exact current meaning; `is_platform_owner()`
  returns false for them. No existing `commercial_admins` check changes behaviour (they test `active`, which is unchanged).
- Write surface: `commercial_admins` grants to `authenticated` are **SELECT only** (unchanged). The column can be set to
  `'platform_owner'` **only** by `bootstrap_first_platform_owner` (service-role; refuses once one exists) and
  `grant_platform_owner` (platform-owner-only, see D). No general endpoint writes it. **Verified** by proof assertions
  *ESCALATION · commercial admin cannot grant platform-owner* and *authenticated cannot directly write
  commercial_admins.authority (permission denied)*.
- Threat 1 → closed: a commercial admin is not a platform owner, and there is no authenticated write path to the column.

### B2. `entitlement_overrides.unlimited` + relaxed `chk_eo_capacity`
- Additive boolean, default `false`; the constraint still forbids a number-and-unlimited combination and still requires a
  positive number for a numeric `ENTITY_CAPACITY`/`NAMED_USER_SEATS` override. "Unlimited" is an explicit boolean — never a
  sentinel integer (directive §10).
- No existing override row is changed (default false). An unlimited allowance can be written only by
  `owner_grant_entity_allowance` (platform-owner-only) or service-role — not by any customer path.

### B3. `_entity_capacity_for_account` — customer behaviour is byte-identical
- For any account that is **not** a platform owner and has **no** active unlimited override, the function returns exactly what
  it returned before (same licence lookup, same `FREE`/no-plan = 0, same MAX(numeric override, plan) semantics). The two new
  branches (`is_platform_owner` → unlimited; active unlimited override → unlimited) are the only additions and are gated on
  conditions no ordinary customer meets by default. **Verified**: *CUSTOMER-UNCHANGED · Solo capacity 1, not unlimited, via
  ACTIVE_LICENCE*, and *UI-AGREES · Practice 5 of 5*.
- Therefore this task introduces/changes **no** commercial entity limit, price, or customer-blocking behaviour (directive
  correction #1). The pricing decision remains open and is untouched.

### B4. `company_entity_capacity_wall` — only adds an unlimited bypass
- The sole added branch is `IF unlimited THEN RETURN NEW` — reached only when B3 resolves unlimited (platform owner or an
  explicit unlimited override). The existing advisory lock, the `determined` guard, and the numeric count/limit for every
  ordinary customer are unchanged. The concurrency guarantee is preserved (proof *CONCURRENCY · exactly one new entity at the
  limit*).

### B5. `_resolve_entitlement_for_owner` — complimentary access, scoped and release-gated
- The added branch fires only for a platform owner AND only for a capability where `capability_customer_available()` is true
  (RELEASED). Withheld modules (`TAX_COMPUTATION/COMPLIANCE_REVIEW/FILING_PREPARATION/MONITORING`) and unknown features fall
  through to the normal fail-closed path. **Verified**: *OWNER withheld modules NOT granted* and *CROSS-TENANT no leak*.
- It returns `source='PLATFORM_OWNER_COMPLIMENTARY'` with no licence, no `commercial_licences` row, no payment. **Verified**:
  *OWNER zero licences* and *DELEGATE no licence/payment for recipient* (directive: complimentary must not fabricate revenue).
- Scope: entitlement is resolved per `owner_user_id`; a platform owner's complimentary status applies to their **own**
  account only, never another tenant's (threat 3 → closed).

### B6. `access_grant_events` ledger
- Append-only (BEFORE UPDATE/DELETE trigger raises). Records recipient, scope, capability, source, allowance, expiry, actor,
  reason, timestamps. No FK on user/scope columns (mirrors `audit_logs`) so history survives later user/company removal.
  **Verified**: *HISTORY events present AND immutable*.

### B7. Grant/revoke RPCs — authority and protections
- All privileged RPCs call `_require_platform_owner_reauth` first (platform-owner + reauth). `bootstrap_first_platform_owner`
  is service-role only and refuses once a platform owner exists. `revoke_platform_owner` refuses removing the last active
  owner. **Verified**: *ESCALATION ordinary/commercial refused*, *LAST-OWNER refused*.
- `owner_grant_complimentary_access` refuses a withheld capability and the capacity codes (which have their own RPC), keeping
  **role permissions / purchased entitlements / seat allowances / entity capacity distinct** (directive scope clause).

## C. Non-waivers preserved (threat 5)
This migration does not touch `statement_sign_offs`, the `enforce_signoff_authorization` trigger, HESABU validation, the
distinct-signer rule, `firm_members`/`workspace_member_capabilities`, RLS on financial tables, or
`capability_customer_available`. A platform owner holds **no** workspace capability without an accepted membership — **verified**:
*OWNER grants NO workspace capability without membership (cannot bypass financial controls)*. Tenant isolation is unchanged.

## D. Reauthentication — server-side, expiring, bound, non-forgeable, single-use (directive §7)
- **Server-side enforced**: every privileged RPC gate (`_require_platform_owner_reauth`) runs in-database; the client cannot
  skip it. The `reauthenticate` edge function re-verifies the **password** server-side (`signInWithPassword` on the caller's
  own email, derived from the verified JWT — not a client-supplied identity) before minting anything; the password is used
  once and never logged.
- **Expires**: nonces carry `expires_at` (TTL 30–900 s, default 300); `_consume_privileged_reauth` requires `expires_at > now()`.
  **Verified**: *REAUTH an expired nonce is refused*.
- **Bound to the authenticated user**: a nonce row stores `user_id`; consumption matches on `user_id = auth.uid()`. A nonce
  minted for user A cannot be consumed by user B. **Verified**: *REAUTH nonce minted for another user cannot be used*.
- **Non-forgeable**: 256-bit CSPRNG nonce; `privileged_reauth` has RLS enabled with **no policy** and no `authenticated` grant,
  so it is invisible/unwritable to clients — only service-role (minting) and the SECURITY DEFINER consume function touch it.
- **Single-use**: consumption sets `consumed_at` and only matches `consumed_at IS NULL`. **Verified**: *REAUTH same nonce
  cannot be reused*.
- **MFA path**: if the project enables Supabase MFA, an `aal2` JWT claim satisfies the gate without a nonce; otherwise the nonce
  is mandatory. Either way the gate cannot be bypassed from the client.

## E. Residual limitations (disclosed, not hidden)
- Reauth binds to the **user** (+ single-use + short TTL), not to a specific session id. This is strong for a 5-minute
  single-use credential; binding additionally to `session_id` is a possible future hardening, noted not stubbed.
- `owner_grant_complimentary_access` can target only capabilities the `entitlement_overrides.feature_code` CHECK supports
  (the 5 commercial + 2 capacity codes). Feature-kind capabilities (e.g. `MULTI_ENTITY_REPORTING`) are covered for the owner
  by the resolver branch but are not individually grantable to third parties via an override (unchanged limitation of the
  existing override table).
- Hosted application and the owner bootstrap are out of this session's reach (see DESIGN §Owner bootstrap); nothing here is
  applied to production.

## F. Verdict
The migration is additive and least-privilege: it extends the canonical authority/entitlement/entity functions in place,
leaves every customer-facing limit/price/block unchanged, preserves all financial/tenant/withheld controls, and gates every
new privileged action behind platform-owner authority + a server-side, expiring, user-bound, single-use reauthentication. The
`reauthenticate` function verifies the password server-side and never logs it. The escalation surface is closed to ordinary
and commercial administrators. All claims above are backed by executed PostgreSQL-17 assertions in `owner_access_proof.mjs`.
