# Platform Owner, Access Administration & Entity Allowances — Design

Branch: `feature/owner-access-entity-limits-20261015` (off `main` @ `945af25`, which already contains the merged release PR #127).
Scope: extend the **existing canonical** authorization/entitlement/entity systems. No parallel permission checks.

## 0. Owner identity — VERIFICATION BLOCKED (report, do not fabricate)
Target owner: **cpahumphrey@gmail.com**. This session has **no hosted auth access** (production is not CLI-reachable;
confirmed throughout this engagement). Therefore the exact `auth.users` row — existence, `email_confirmed_at`, and the
immutable `id` (UUID) — **cannot be read back from here and is NOT asserted**. Per directive §17 ("Never claim hosted access
was granted until the hosted user ID … has been read back and verified"), the grant is delivered as an **idempotent,
parameterised bootstrap** that the owner/service-role runs with the verified UID. Provisioning action in §Owner bootstrap.

## 1. What already exists (inspection result — do NOT duplicate)
| Concern | Canonical object(s) | Notes |
|---|---|---|
| Workspace (operational) authz | `has_workspace_capability`, `workspace_capability_allowed`, `workspace_member_capabilities`; caps = prepare_close/review_close/approve_certification/issue_reporting_pack/manage_members; titles owner/partner/preparer/viewer are **templates** | Authz reads stored capability rows, never the title. |
| Commercial entitlement | `_resolve_entitlement_for_owner(owner_user_id, feature)` (the one resolver), `commercial_plan_features`, `entitlement_overrides` | Billing-account scoped (`billing_customers.owner_user_id`). |
| Entity capacity | `_entity_capacity_for_account(account)` → `company_entity_capacity_wall()` trigger on `companies` | **Already** per-account `pg_advisory_xact_lock`, idempotency index `uq_companies_creation_request`, fires on INSERT + `UPDATE OF is_active,user_id`. |
| Cross-tenant admin | `commercial_admins (user_id, active)` checked inline in every commercial admin RPC; `/commercial/admin` UI gated by it | "Never overloads `firm_members.role`." No seed. |
| Withheld modules | `capability_customer_available(cap)` → withholds `TAX_COMPUTATION, COMPLIANCE_REVIEW, FILING_PREPARATION, MONITORING` | The only withheld-list authority. Must stay gated. |
| Audit ledgers | `billing_audit_events` (append-only, billing), `audit_logs` (useAuditLog, auth.uid, §4.2 exception), `engagement_setup_events` | |
| Reauth / MFA | **none** (no `[auth]`/MFA in config.toml; no `supabase.auth.mfa/reauthenticate`) | Must be built. |

## 2. Existing (already-enforced) plan → entity allowance matrix — reported, NOT proposed
**This table is the model already present and enforced in the code on `main`; it is NOT a pricing proposal and NOT a
newly-approved charging model.** Entity-based pricing was reopened for a separate decision after the original directive, so
**this task introduces and changes NO commercial entity limit, price, or customer-blocking behaviour.** The values below are
reproduced only to (a) prove this task leaves customer enforcement byte-for-byte unchanged and (b) show that the platform
owner's unlimited allowance is layered *above* whatever the pricing decision later sets, without touching it.
Source: `commercial_plans.entity_capacity` + `_entity_capacity_for_account` (unchanged by this migration for any non-owner,
non-override account).

| Plan | entity_capacity | public | sales_mode |
|---|---|---|---|
| SOLO | **1** | yes | self_serve |
| PRACTICE | **5** | yes | self_serve |
| FIRM | **25** | yes | self_serve |
| ENTERPRISE | **NULL** = negotiated; fails closed until a numeric override | yes | contact_sales |
| PAID (legacy) | 25 | hidden | legacy |
| FREE (retired) | 1, but grants nothing | no | retired |
| no current plan | **0** | — | — |

"Unlimited" has **no** representation today (overrides must be positive ints; NULL=undetermined=fail-closed). This design
adds an **explicit** unlimited (a boolean), never a large sentinel number.

## 3. The counted unit (directive §9)
An **active legal entity = one `public.companies` row with `is_active = true`**, counted **by owning account**
(`companies.user_id`). Not users, periods (`fiscal_periods`), uploads (`trial_balance_uploads`), engagements, or branches
(no branch table exists). Membership fan-out cannot double-count: the wall counts `companies WHERE user_id = account`, so one
legal entity = one row regardless of how many `firm_members` reference it.
- **Archive** = `is_active=false` (frees capacity; financial children preserved via FKs).
- **Restore/transfer** = `UPDATE is_active|user_id` → re-checked by the wall against the destination account.
- **Hard delete** = not used by the app (soft-delete only); engagements FK is `ON DELETE RESTRICT` (history protected).

## 4. The extension (this migration `20261104100000`)
All additive; every change extends a canonical object in place.

### 4.1 Platform-owner tier on the canonical cross-tenant table
`ALTER TABLE commercial_admins ADD COLUMN authority TEXT NOT NULL DEFAULT 'commercial' CHECK (authority IN ('commercial','platform_owner'))`.
- `is_platform_owner(p_user)` = EXISTS active row with authority='platform_owner'. A platform owner is also `active` → **every
  existing `commercial_admins` check passes unchanged** (no RPC edits, no duplication). Platform-owner is the strict superset.
- This keeps ONE cross-tenant authority table; it is still walled off from `firm_members.role`/workspace accounting authority.

### 4.2 Explicit unlimited entity allowance
`ALTER TABLE entitlement_overrides ADD COLUMN unlimited BOOLEAN NOT NULL DEFAULT false`; relax `chk_eo_capacity` so
`ENTITY_CAPACITY` is EITHER `(capacity_value>0 AND NOT unlimited)` OR `(unlimited AND capacity_value IS NULL)`.
- `_entity_capacity_for_account` extended: **precedence** = platform-owner-complimentary unlimited → active unlimited override →
  MAX(numeric override, plan capacity). Returns `{determined, unlimited, capacity, source}`.
- `company_entity_capacity_wall()` extended: if the resolved capacity is **unlimited**, skip the count check entirely (still
  under the existing advisory lock). Numeric path unchanged. "Unlimited" is a boolean, not a number.

### 4.3 Complimentary access to all RELEASED capabilities (no fabricated payment/revenue)
`_resolve_entitlement_for_owner` extended: if `is_platform_owner(owner_user_id)` AND the capability maps to a customer-available
service, resolve `ENTITLED` with `source='PLATFORM_OWNER_COMPLIMENTARY'` — **no licence row, no payment, no revenue**. Withheld
capabilities (`capability_customer_available=false`) and any capability outside the released set fall through to the normal
fail-closed path. (The owner can also grant ordinary users complimentary access via the existing `entitlement_overrides`
ADMIN_OVERRIDE mechanism, which likewise fabricates no payment.)

### 4.4 Access-administration grant/revoke with full provenance (directive §6)
New append-only ledger `access_grant_events (id, recipient_user_id, billing_customer_id NULL, company_id NULL, grant_kind,
capability NULL, source, allowance JSONB, effective_start, effective_end NULL, actor_user_id, reason, created_at)` + immutability
trigger. Every new grant/revoke RPC writes one row (recipient, scope, capability, source, allowance, expiry, actor, reason,
timestamps). Existing `billing_audit_events` continues for billing lifecycle; this ledger is the access-admin audit.

### 4.5 Grant/revoke RPCs (reuse canonical checks; add protections)
- `grant_platform_owner(p_user_id, p_reason, p_reauth_nonce)` / `revoke_platform_owner(...)` — **platform-owner only**; writes
  `commercial_admins(authority='platform_owner')` + an `access_grant_events` row. **Refuses to remove the last active platform
  owner.** Bootstrap exception: if no platform owner exists yet, only `service_role` may seed the first (named UID).
- `owner_grant_complimentary_access(p_recipient, p_capability, …)`, `owner_grant_entity_allowance(p_recipient, p_capacity|unlimited, …)`
  — platform-owner only; wrap the existing `entitlement_overrides` path; audited; no payment.
- `revoke_access_grant(p_override_id|…, p_reason)` — sets `revoked_at` (entitlement checks are per-request → effective
  server-side immediately, no refresh). Audited.
- **Guards:** self-escalation refused (a non-platform-owner cannot grant platform-owner; a workspace admin's grants are confined
  to their own `company_id` via existing `manage_members`); cross-tenant grants refused; never log credentials/tokens.

### 4.6 Recent-reauthentication gate (directive §7)
New `privileged_reauth (user_id, nonce_hash, created_at, expires_at, consumed_at)`. Edge function `reauthenticate` verifies the
caller's password server-side (`signInWithPassword` on their own email) and mints a short-lived (5-min) single-use nonce; the
privileged grant RPCs require a valid unconsumed nonce and consume it. **MFA (AAL2)** is documented as a config-gated
enhancement (Supabase MFA must be enabled in the project) — the RPC additionally honours an `aal2` JWT claim when present.

### 4.7 Read RPCs for the Access console (no new authority — projections only)
`get_access_overview()` (platform-owner / commercial-admin: accounts, plans, entitlements, entity usage), `get_access_matrix()`
(roles × capabilities), `get_access_grant_history(...)`, reusing existing `get_my_entity_capacity` / `get_my_billing_summary`
for the self views. Ordinary users see only their own; workspace admins see only their workspace.

## 5. Owner grants delivered (directive §2) — mapped to mechanism
| Grant | Mechanism (canonical) | Fabricates payment? |
|---|---|---|
| Platform-owner administration | `commercial_admins.authority='platform_owner'` | no |
| Commercial administration | implied by the same active `commercial_admins` row | no |
| User invitations / role & access mgmt | platform-owner ⊇ commercial-admin + workspace `manage_members` where a member | no |
| Complimentary access to all released capabilities | `_resolve_entitlement_for_owner` platform-owner branch (released only) | **no** |
| Unlimited active entities (explicit) | platform-owner branch in `_entity_capacity_for_account` → `unlimited=true` | **no** |

## 6. Non-waivers (directive §4) — explicitly preserved
Owner access does NOT touch: tenant isolation / company membership (entitlement is per-account; owner gets nothing in another
tenant's workspace without membership), validation / sign-off / distinct-signer / immutable financial history (the just-shipped
`enforce_signoff_authorization` + existing triggers are untouched), withheld-module gates (`capability_customer_available`
unchanged), secret protection / audit logging. Owner is NOT granted silent read of all customer data — any support access must
be explicit, scoped, time-boxed and audited (future `support_access_grants`, out of this slice; noted, not stubbed).

## 7. Repository vs hosted (stated separately, directive deliverable)
- **Repository:** this branch adds the migration, the reauth edge function, the Access console UI, hooks, and a PG17 proof. CI
  must be green on the exact head.
- **Hosted:** NOTHING is applied by this session. The migration is registered/applied via the authoritative Drizzle-journal
  mechanism by the production-owning session; the owner bootstrap RPC is then run with the **verified** `cpahumphrey@gmail.com`
  UID (service-role). Effective permissions/entitlements must be read back and verified there before anything is claimed "live".

## Owner bootstrap (exact provisioning action)
1. Verify in Supabase Auth that `cpahumphrey@gmail.com` exists and is confirmed; capture the immutable `id`. If absent/unverified:
   invite/confirm it first (do not fabricate).
2. With service_role (first platform owner only): `SELECT public.bootstrap_first_platform_owner('<verified-uuid>', 'initial platform owner');`
   (idempotent; refuses if a platform owner already exists — thereafter use `grant_platform_owner`).
3. Read back: `SELECT public.is_platform_owner('<uuid>')`, the owner's `get_access_overview()`, entity capacity (unlimited), and
   confirm no `commercial_licences` payment row was created.

## 8. Access console UI (built; brand-consistent) — directive §§12–14
Route **`/admin/access`** (`src/pages/admin/AccessConsole.tsx`), server-gated by an active `commercial_admins` row. Four
DISTINCT sections (role permissions ≠ purchased entitlements ≠ usage allowances ≠ entity capacity):
- **Roles → permissions** — the operational capability template (owner/partner/preparer/viewer × the five workspace capabilities).
- **Accounts & allowances** — per account: platform-owner badge, entity capacity (number or **Unlimited**), capacity source, and complimentary/admin grants (each revocable).
- **Grant history** — the append-only `access_grant_events` ledger.
- **Delegate access** — scoped complimentary capability / entity allowance / unlimited, **reauth-gated**; states plainly that no payment/subscription/revenue is recorded. Platform-owner grant/revoke is deliberately absent here.

Owner status also surfaces in **Settings → Plan & access** (`CurrentPlanPanel`): "Platform owner · Complimentary access" + "Unlimited active entities" — no fake paid subscription. The workspace top bar shows an **entity allowance indicator**
("N of M active entities" / "Unlimited active entities" + a quiet "Manage entities" link; no gamification).

Screenshots (real component, isolated runtime, synthetic data): `docs/owner-access/screens/` —
`access-console-desktop.png` (roles matrix), `access-accounts-allowances.png` (owner status + unlimited),
`access-delegate.png` (reauth-gated grant), `access-console-mobile.png`.
