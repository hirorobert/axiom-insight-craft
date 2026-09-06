# SAFF ERP — Ω∞ Ω3 Commercial Launch Foundation — Architecture Design

**Status: DESIGN ONLY. No code written. No migration created. No commit. No push. No deploy. No production change.**

- **Repo HEAD at time of this design:** `00b2c4fce7eb1dc475d305ed6ad8fb4d43219f7d`
- **Date:** 2026-09-06
- **Grounded by:** direct inspection of every commercial-domain migration (Ω1 live identity `20260905093408_8fc55e64-3e06-4d26-8835-438a9243e1ef.sql`, RLS-fix live identity `20260905141022_f1029fbe-90d5-4aac-97e0-059eede76338.sql`, Ω2 live identity `20260906083524_eca6c272-4a62-4468-995b-1c70e2cd67e5.sql`), every `commercial-*` Edge Function, every `_shared/payments/*` file, the full frontend commercial surface, and all 17 existing commercial test files (16 under `src/lib/commercial/**` + `src/components/commercial/CheckoutUpgradeButton.test.ts` — re-confirmed via a fresh glob in this review pass, correcting an earlier miscount of 16). Every claim below is either a direct citation or an explicit design decision — nothing is guessed.
- **Two defect IDs named in the mission brief were searched for exhaustively and NOT found anywhere in this repository:** `DEFECT-OMEGA2-TZS-EXPONENT-AUTHORITY-001` and `COMMERCIAL_EDGE_ERROR_CORS_COMPLETENESS`. Both describe real, verified conditions (see §A and §P), but neither string exists in any committed file. This document treats them as **conversation-only labels for real, independently-confirmed facts**, not as pre-registered repo defects — I am not fabricating a citation that doesn't exist.

---

## Dimensional Independence Charter

This is the load-bearing rule the rest of the document is written to obey, stated once, explicitly, up front, so every later section can be checked against it rather than trusted on faith.

**Five dimensions exist. None may collapse into another. None may be derived from another.**

| Dimension | Authority lives in | Never derived from |
|---|---|---|
| **Commercial market** | `billing_customers.commercial_market` (§F, new) — a customer's own explicit, self-selected assignment. | Accounting jurisdiction, entity/company country, TRA/TIN, currency, browser locale/IP. |
| **Currency (and its exponent)** | `commercial_currencies` registry (§G, new) — one row per ISO-style code, one true exponent. | Market. **A market never implies a currency, and a currency never implies a market** — this is already proven true and tested today (`routing.test.ts`, `globalCommerceModel.test.ts`: TZS can price a `GLOBAL` offer; `FLUTTERWAVE_CAPABILITIES.supportedCurrencies` and `.supportedMarkets` are two independent arrays, ANDed at selection time, never a fixed pairing table — `routing.ts`'s own header comment states this design intent explicitly). |
| **Accounting jurisdiction** | `companies`/`statutory_rules.jurisdiction` — a wholly separate table, a wholly separate FK graph, keyed to accounting workspaces, not to `billing_customers`. | Commercial market, currency, provider. No commercial RPC anywhere reads `companies.*` or `statutory_rules.*` (confirmed by grep across every commercial function body) — the one narrow, registered exception is `admin_billing_lookup`'s read-only `trial_balance_uploads` peek (§B), which touches neither jurisdiction nor tax data. |
| **Entity/company country** | Not a commercial concept at all — it's an accounting-workspace attribute, and this design introduces no commercial column that reads or stores it. | — |
| **Payment provider** | `_shared/payments/routing.ts`'s `PaymentProviderCapabilities` — its own independent `supportedCurrencies`/`supportedMarkets` arrays, chosen by `selectPaymentProvider()`. | Market or currency as a *fixed rule* (e.g. "TZS ⇒ Flutterwave" is explicitly rejected by the existing routing design — a provider is *eligible* for a currency/market combination, never *implied* by one). |

**The rule this document is held to, restated as a single sentence, because the mission calls it out explicitly: currency exponent authority belongs solely to §G's `commercial_currencies` registry.** `billing_customers.commercial_market` (§F) never stores, computes, or influences an exponent, a currency code, or a price. `commercial_currencies` never stores, computes, or influences a market code. Every table introduced by this design is checked against this charter in its own section below, not just asserted here.

---

## A. Existing Capability Map

### A.1 Database tables (all confirmed live, all in `commercial-*` migrations only — nothing else in 112 migration files touches them)

| Table | Status | Notes |
|---|---|---|
| `commercial_products` | **EXISTS_BUT_INCOMPLETE** | Table + public SELECT RLS exist. **Zero admin write RPC exists** — nothing can create/edit a product today except a raw `service_role` INSERT. `CommercialAdmin.tsx` never references it. |
| `commercial_plans` | **EXISTS_BUT_INCOMPLETE** | Table + `feature_codes` CHECK vocabulary + public SELECT (`is_active` only) exist. **Zero admin write RPC exists.** `CommercialAdmin.tsx`'s "plan code" is a free-text input with no validation against this table. |
| `commercial_offers` | **EXISTS_BUT_INCOMPLETE** — corrected from an earlier draft's "Full CRUD" framing | `admin_upsert_commercial_offer`/`admin_list_commercial_offers` exist and are wired into `CommercialAdmin.tsx`, but "Full CRUD" is precisely the defect, not a feature: today's `admin_upsert_commercial_offer` performs a genuine in-place `UPDATE` of an existing `offer_code`'s economic fields (`currency_code`, `amount_minor`, `currency_exponent`, `billing_interval`) with zero guard against it and zero cross-check of `currency_code` against `currency_exponent`. Both are closed by one new trigger, not an RPC change — see §E.1/§G.2. |
| `commercial_admins` | **EXISTS_BUT_INCOMPLETE** | Table + `is_commercial_admin()` + RLS all correct. **No bootstrap path, no grant RPC, no revoke RPC, no UI exist at all.** First row must be a raw `service_role`/DB-owner INSERT — the table's own `COMMENT ON TABLE` says so explicitly. |
| `billing_customers` | **EXISTS_AND_USABLE** (for its current scope) | Auto-provisioned 1:1 with a new `auth.users` row (via `provision_billing_customer_for_company()` trigger on `companies` INSERT). **No commercial-market column exists** — this is precisely the Ω2-discovered gap this document must close (§F). |
| `commercial_licences` | **EXISTS_AND_USABLE** | Full lifecycle (`ACTIVE`/`GRACE`/`SUSPENDED`/`CANCELLED`/`EXPIRED`/`PENDING`), non-overlap `EXCLUDE` constraint, admin RPCs (`admin_grant_commercial_licence`, `admin_transition_licence_status`) already exist and are correct — just **have no UI**. |
| `payment_events` | **EXISTS_AND_USABLE** | Append-only, correctly extended in Ω2 with `amount_minor`/`provider_transaction_id`/idempotency unique index. |
| `payment_checkout_intents` | **EXISTS_AND_USABLE** | Immutable economic snapshot at checkout time, correctly FK'd. One minor gap: `currency_exponent` has no DB-level CHECK (copied from the offer with no independent bound) — see §G. |
| `payment_webhook_receipts` / `payment_webhook_processing_events` | **EXISTS_AND_USABLE** | Correctly split append-only evidence/outcome model (Ω2-GR1 repair), admin-only SELECT. |
| `entitlement_overrides` | **EXISTS_AND_USABLE** | Admin grant/revoke RPCs exist (`admin_grant_entitlement_override`, `admin_revoke_entitlement_override`) — **no UI**. |
| `billing_audit_events` | **EXISTS_AND_USABLE** | Append-only, real columns (`action`/`previous_state`/`new_state`/`reason`), written by every admin RPC and by `commit_verified_commercial_payment`. **No admin cross-customer read UI exists** (only `admin_get_billing_detail`, one customer at a time). |
| `commercial_catalog_audit_events` | **EXISTS_AND_USABLE** | Append-only, `entity_type IN ('OFFER','PLAN')` — note `'PLAN'` is already in the vocabulary even though no plan-writing RPC exists yet to use it. |

**No table anywhere is LEGACY/SHOULD_NOT_BE_AUTHORITY** — the schema is clean; every table is either fully usable or usable-but-missing-a-write-path, never a wrong-authority trap.

### A.2 RPCs / functions

| Function | Status |
|---|---|
| `resolve_commercial_offer(plan, market)` | **EXISTS_AND_USABLE** — the sole pricing authority, correct fail-closed states (AVAILABLE/NOT_AVAILABLE/AMBIGUOUS/UNKNOWN), GLOBAL-only fallback direction, granted to `anon` for public pricing display. |
| `admin_upsert_commercial_offer` / `admin_list_commercial_offers` | **EXISTS_AND_USABLE**, but **EXISTS_BUT_INCOMPLETE for currency safety** — accepts any `SMALLINT 0-4` exponent with zero cross-check against the currency code (§G). |
| `is_commercial_admin()` | **EXISTS_AND_USABLE** — the one correct chokepoint, but **not universally used**: `admin_grant_commercial_licence`, `admin_transition_licence_status`, `admin_grant_entitlement_override`, `admin_revoke_entitlement_override`, `admin_billing_lookup`, and `get_effective_entitlement`'s admin-bypass all still use the pre-helper inline `EXISTS (SELECT 1 FROM commercial_admins ...)` pattern because they were written before `is_commercial_admin()` existed. Functionally identical today; a future authority change (e.g. an admin tier) would need to touch two code shapes, not one. **Flagged as HIGH cleanup, not a launch blocker** (§S, Ω3.1).
| `get_my_billing_summary`, `get_checkout_status`, `get_effective_entitlement` | **EXISTS_AND_USABLE** |
| `commit_verified_commercial_payment` | **EXISTS_AND_USABLE** — correct two-gate-consuming, `service_role`-only, idempotent, closes prior ACTIVE/GRACE licence regardless of plan. |
| `record_payment_reversal` | **EXISTS_BUT_INCOMPLETE** — fully correct body (REFUND/CHARGEBACK, `REVIEW_REQUIRED`, never auto-mutates a licence, idempotent), but **no code path anywhere calls it**. A Flutterwave refund/chargeback webhook today falls into generic `VERIFICATION_FAILED`/`NOT_AUTHORISED`, never reaching this function (§M). |
| `admin_grant_commercial_licence`, `admin_transition_licence_status`, `admin_grant_entitlement_override`, `admin_revoke_entitlement_override`, `admin_billing_lookup` | **EXISTS_AND_USABLE** at the RPC layer, **MISSING at the UI layer** — this is the single biggest gap between "the backend can already do most of what a founder needs" and "the founder can actually do it without SQL." |
| Currency registry function | **MISSING** entirely — no DB-level currency→exponent authority exists (§G). |
| Commercial-market assignment function | **MISSING** entirely — no way for a customer or admin to set an authoritative market (§F). |
| Bootstrap / grant / revoke commercial_admin RPCs | **MISSING** entirely (§C). |
| Public catalogue list RPC (`list_public_offers`) | **MISSING** — a public pricing page today would have to hand-join `commercial_offers`/`commercial_plans` client-side against the `anon` grant, which works but is an unhardened, uncontracted read path. |
| Customer self-service RPCs (`set_billing_customer_market`, `list_my_payment_events`, `get_my_payment_receipt`) | **MISSING** entirely. |
| Admin list RPCs (`admin_list_billing_customers`, `admin_list_payment_events`, `admin_list_audit_events`, `admin_list_commercial_admins`) | **MISSING** entirely — `CommercialAdmin.tsx`'s own comment explicitly defers this: *"A full paginated cross-customer admin list is deliberately out of scope for Ω2-G."* |
| Commercial-admin grant/revoke, admin product/plan upsert | **MISSING** entirely. |
| Platform payment-state machine (`PAYMENTS_DISABLED`/…/`CUSTOMER_PAYMENTS_ENABLED`) | **MISSING** entirely — today the only real switch is which Flutterwave secret key is deployed; there is no product-level gate distinct from the infra-level key choice (§K). |

### A.3 Edge Functions

| Function | Status |
|---|---|
| `commercial-create-checkout` | **EXISTS_AND_USABLE**, correctly hardened (Ω2, auth-contract repair, market-propagation seam). Needs: platform-state check (§K), market-mismatch enforcement (§F), currency-registry trust is already downstream of the DB (§G). |
| `commercial-payment-status` | **EXISTS_AND_USABLE**, correctly hardened (auth-contract + anon-key/forwarded-JWT repair). |
| `commercial-payment-webhook` | **EXISTS_AND_USABLE** for the success path. **EXISTS_BUT_INCOMPLETE** for reversals (§M) and hard-coded to a single provider (`adapterFor` equivalent inlined, no `X-Provider` routing yet — acceptable since only one adapter exists; flagged as a note, not a gap, per §S Ω3.7). |
| A public pricing / catalogue Edge Function | **MISSING** — not required (RPC-only is sufficient and simpler; see §H) but noted as a design choice, not an oversight. |
| A receipt Edge Function/route | **MISSING** entirely (§J). |
| A commercial-admin-bootstrap Edge Function | **MISSING** entirely (§C). |

### A.4 Frontend

| Surface | Status |
|---|---|
| `CommercialAdmin.tsx` | **EXISTS_BUT_INCOMPLETE** — Offers CRUD only. No Products, Plans, Admins, Customers, Licences, Payments, or Audit UI. Amount is a raw `amount_minor` integer typed by hand; currency is free text (not validated against any registry); exponent is a free `<Input type="number">` with **zero cross-check against the currency** — this is the exact class of defect the mission's `DEFECT-OMEGA2-TZS-EXPONENT-AUTHORITY-001` label describes, confirmed present in the admin UI today even though that literal ID doesn't exist in the repo. |
| `Settings.tsx` Plan & Billing card | **EXISTS_AND_USABLE** for its current scope (plan/status/entitlements/upgrade). **MISSING**: market display/change, payment history, receipt links, self-service cancel/renew. Default "Contact support to change or renew" string is still the fallback for the same-plan case (correct there) but the mission wants it removed as the *general* commercial path once self-service exists — it already isn't the general path today (the upgrade button is live); this string only remains for the narrow already-on-this-plan case, which is appropriate to keep. |
| `CheckoutUpgradeButton.tsx` | **EXISTS_AND_USABLE**, already carries the `marketCode` seam Ω3 needs to consume (§F). |
| `/pricing` route | **MISSING** entirely — pricing today is an in-page anchor (`#pricing`) on the landing page using static copy (`PRICING_TABLE`/`PRICING_SECTION` in `src/constants/copy.ts`), explicitly stating *"Self-service purchase is not yet available."* |
| `/billing/receipts` route | **MISSING** entirely. |
| Router guard on `/commercial/admin` | **MISSING** — access control is server-side-only (RLS/RPC), no client route guard. Acceptable today (defense-in-depth would still be nice, not a blocker) but flagged. |
| "SALIO" identity leakage | **NOT FOUND** — searched exhaustively, zero matches anywhere in `src/`. This specific piece of registered debt does not currently exist; no action needed. |
| TRA/TIN as a global (non-workspace) Settings concept | **CONFIRMED PRESENT** — `CompanyManager.tsx` and `FirmManagementPanel.tsx`, both rendered at the top-level `/settings` route, carry TRA TIN concepts outside any workspace route. Real, but **out of Ω3 scope** — see §O. |

---

## B. Hard Authority Model

Nine actors/objects, each with an explicit, non-overlapping authority boundary:

| Entity | Authority it holds | Authority it explicitly does NOT hold |
|---|---|---|
| **Auth user** (`auth.users.id`) | Identity only. | Nothing by itself — every other authority is a *lookup keyed on* this id, never inherent to it. |
| **Workspace member** (`firm_members`, keyed by `firmMemberId`) | Accounting engagement authority: SAFISHA/HESABU/KINGA/MAONO actions scoped to `company_id`, per Iron Dome §4.3. | Zero commercial authority. `firm_members.role` (`partner`/`manager`/`staff`) has never been read by any commercial RPC — confirmed by direct inspection of every commercial function body. |
| **Accounting/professional role** (`firm_members.role`) | Sign-off, review, filing authority within one company/workspace. | Zero commercial authority — same as above. |
| **Commercial admin** (`commercial_admins`, gated by `is_commercial_admin()`) | Catalogue authoring (offers today; products/plans/admins in Ω3), cross-customer commercial visibility, manual licence/entitlement grants, refund review. | **Zero accounting authority.** No commercial RPC anywhere reads or writes `tax_computations`, `account_mappings`, `statement_sign_offs`, `engine_runs`, or any HESABU/KINGA/MAONO table — confirmed by direct grep of every commercial function body (already regression-guarded by `paymentSecurity.test.ts`). The one narrow, deliberate exception: `admin_billing_lookup` reads `trial_balance_uploads` (latest upload id/status/period only) purely for **support-context visibility** — read-only, no write, no accounting decision. This is registered explicitly here as an accepted, minimal, read-only cross-domain peek, not a violation. |
| **Founder / super-commercial-admin** | **Not a separate DB role.** A founder who needs commercial authority is simply a `commercial_admins` row like any other — see §C for why a distinct tier is unnecessary at this stage. If a founder ALSO needs accounting authority in some workspace, they receive a completely separate `firm_members` row for that company — two orthogonal grants, never one implying the other. |
| **Customer / billing owner** (`billing_customers.owner_user_id`) | Their own commercial identity: own licence, own payment history, own entitlements, and (Ω3) their own assigned commercial market. | Zero authority over any other customer's row (enforced by every RLS policy's `owner_user_id = auth.uid()` clause) and zero authority to set price/currency/amount/provider (enforced server-side at every commercial write). |
| **Plan** (`commercial_plans`) | Capability bundle identity (`feature_codes`). | **Never a price.** No price/currency/amount column exists on this table, and none may ever be added (§E). |
| **Offer** (`commercial_offers`) | The sole pricing authority: plan + market + currency + amount + interval + effective window + purchasability. | Never a market/customer identity — an offer doesn't know who buys it. |
| **Market** (closed vocabulary `GLOBAL`/`TZ`/`MU`/`GB`/`EU`) | Governs which offers are visible/purchasable to a given commercial-market assignment. | **Never** accounting jurisdiction, entity country, TRA/TIN, currency, or locale (§F). |
| **Currency** (Ω3: `commercial_currencies` registry) | Governs the one true exponent for a currency code. | Never a market (TZS can price a GLOBAL offer; confirmed already true and tested in `routing.test.ts`/`globalCommerceModel.test.ts`). |
| **Provider** (Flutterwave today) | Executes an already-priced, already-resolved transaction. | Never chosen by market or currency as a fixed rule — `selectPaymentProvider()` is explicitly designed to keep this orthogonal (§A.2, `routing.ts` header comment). |
| **Settlement** | A future, entirely separate concept (money landing in a bank/payout account). | **Never** the entitlement authority. Confirmed structurally true today: no settlement column/table exists anywhere in the payment/licence/entitlement chain (regression-guarded by `globalCommerceModel.test.ts`'s "SETTLEMENT ORTHOGONAL" block). Ω3 must not let this invariant erode (§L). |
| **Licence** (`commercial_licences`) | The authoritative "is this billing customer allowed to buy at ACTIVE/GRACE" state, non-overlapping by DB constraint. | Never self-granted by a customer — only `commit_verified_commercial_payment` or an admin RPC ever write to this table. |
| **Entitlement** (`get_effective_entitlement`) | The final tri-state (`ENTITLED`/`NOT_ENTITLED`/`UNKNOWN`) a feature check resolves to. | Never computed client-side as authority — `entitlementContract.ts`'s `classifyEntitlement()` is an explicit non-authoritative mirror for UI responsiveness only. |

**Absolute invariant, confirmed structurally true today and to remain true through every Ω3 subphase:** commercial administration grants zero SAFISHA/HESABU/MAONO/budget-approval/journal-approval/workspace-sign-off authority, and no workspace role automatically becomes `commercial_admin`. **PASS.**

---

## C. Commercial Admin Bootstrap

**Current state (confirmed, §A.2): there is no bootstrap path at all.** The `commercial_admins` table's own `COMMENT ON TABLE` states the first row must be a raw `service_role`/DB-owner `INSERT` — there is genuinely zero application code path today, not even an undocumented one.

### C.1 Design

A **three-tier** mechanism, matching the mission's requirements exactly:

**Tier 1 — one-time founder bootstrap (Edge Function, not a SQL RPC).**
A new Edge Function `commercial-admin-bootstrap`:
- Accepts a POST with `{ founderEmail: string }` and a header `X-Bootstrap-Token`.
- Compares the token against a `COMMERCIAL_ADMIN_BOOTSTRAP_TOKEN` secret (Supabase Edge Function secret, never in the repo, never in a migration).
- Uses the `service_role` client to look up `auth.users` by `founderEmail` (the founder must already have signed up normally — this function never creates an auth identity, only grants commercial authority to an existing one).
- **Idempotent, repeat-safe, self-promotion-proof by construction:** `INSERT INTO commercial_admins (...) SELECT ... WHERE NOT EXISTS (SELECT 1 FROM commercial_admins WHERE active)`. If any active admin already exists, the insert affects zero rows and the function returns `ALREADY_BOOTSTRAPPED` — the token alone can never grant a *second* admin, closing the "token leaks later" risk.
- Writes an audit row (extend `commercial_catalog_audit_events.entity_type` CHECK to include `'ADMIN'` **and `'PRODUCT'`** — corrected, see §D.1/§Q) with `action = 'FOUNDER_BOOTSTRAP'`, `entity_type = 'ADMIN'`.
- **Why an Edge Function and not a SQL RPC grantable to `authenticated`:** an RPC callable by `authenticated` is, by construction, a browser-reachable grant surface — even with an internal token check, that logic would live inside a function `authenticated` can invoke, one bug away from a real self-promotion path. An Edge Function gated by a secret env var that only the founder/ops holder knows, using the `service_role` key that never reaches the browser, has **no RLS/browser attack surface at all** — the safest possible shape for a "grant the first admin" primitive.

**Tier 2 — ordinary admin grants (RPC, once ≥1 admin exists).**
`admin_grant_commercial_admin(p_user_id UUID, p_reason TEXT)` — `SECURITY DEFINER`, gated by `is_commercial_admin()` exactly like every other admin RPC, writes `commercial_admins` + the same audit trail. This is the **normal** path from the second admin onward.

**Tier 3 — revocation.**
`admin_revoke_commercial_admin(p_user_id UUID, p_reason TEXT)` — sets `active = false` (never a hard delete, preserving FK/audit integrity — matches the existing `entitlement_overrides.revoked_at` pattern exactly). **Explicit lockout guard:** raises `CANNOT_REVOKE_SOLE_REMAINING_ADMIN` if the target is the only currently-active admin — a founder can never accidentally lock themselves and everyone else out.

**No founder/super-commercial-admin tier is introduced.** A founder needing broader authority than an ordinary `commercial_admin` has not been shown to need one by anything in this repository — every existing admin RPC already gates on the same `is_commercial_admin()`/inline-equivalent check with no tiering. Introducing a second admin tier now would be speculative architecture the mission explicitly warns against ("if actually needed" — it is not, yet). If a genuine need for tiered admin authority emerges later (e.g. "billing-only" vs "catalogue-only" admins), it is a additive `commercial_admins.tier` column, not a redesign.

---

## D. Pricing Admin Control Plane

Refined information architecture, grounded in what already exists vs. what's genuinely missing:

| Tab | Backing (existing) | Backing (new, Ω3) |
|---|---|---|
| **Overview** | — | New: KPI counts (active customers, MRR-equivalent by market/currency — computed client-side from `admin_list_*` reads, no new aggregate RPC needed at launch scale), platform payment-state display (§K), admin roster summary. |
| **Administrators** | — | New: `admin_list_commercial_admins`, `admin_grant_commercial_admin`, `admin_revoke_commercial_admin` (§C). |
| **Products** | `commercial_products` table (public SELECT only) | New: `admin_upsert_commercial_product(p_code, p_name, p_reason)` — full body and audit-atomicity proof in §D.1, corrected this pass to also widen the audit vocabulary with `'PRODUCT'` (Blocker 4). |
| **Plans** | `commercial_plans` table (public SELECT only) | New: `admin_upsert_commercial_plan(p_product_code, p_code, p_name, p_feature_codes[], p_is_active, p_reason)` — feature-code multi-select sourced from the same closed vocabulary already enforced by `chk_cp_feature_codes`. **No price field, ever** (§E). |
| **Offers** | `admin_upsert_commercial_offer` / `admin_list_commercial_offers` (already live, **body unchanged** by this design — §E.1/§G.2) | Extend the *UI*: currency becomes a `<Select>` sourced from the new registry (§G), exponent becomes read-only/derived, and the four lifecycle labels are computed client-side from existing columns — no new column needed: `DRAFT` = `!is_active && !is_purchasable`; `SCHEDULED` = `is_active && !is_purchasable && effective_start > now()`; `LIVE` = `is_active && is_purchasable && effective_start <= now() < effective_end-or-null`; `RETIRED` = `!is_active || (effective_end IS NOT NULL AND effective_end <= now())`. Economic fields (price/currency/interval) on an *existing* offer_code render **read-only** in the form — the UI's only path to a new price is "create new offer" + close out the old one's `effective_end`/`is_purchasable`. The backend's `trg_commercial_offers_economic_integrity` trigger (§G.2) is the actual authority here; the read-only UI field is a courtesy that reflects it, not a substitute for it — a hand-crafted request bypassing the UI still hits the same trigger and fails the same way. |
| **Markets** | closed enum (`GLOBAL`/`TZ`/`MU`/`GB`/`EU`) | Read-only reference display — **deliberately not admin-editable data**. The vocabulary is a controlled, code-level constant (mirrored in `CommercialAdmin.tsx`, the DB CHECK constraint, and the frontend), exactly matching the mission's "market != jurisdiction, never inferred" invariant; adding a market is a genuine schema/code change (`ALTER ... CHECK`), not a data-entry action, by design. |
| **Currencies** | `SUPPORTED_CURRENCIES` (TS-only today) | New: `commercial_currencies` registry table (§G), read-only display in this tab — same "controlled vocabulary, not free data-entry" treatment as Markets. |
| **Customers** | `admin_billing_lookup` (single company only) | New: `admin_list_billing_customers(p_search?, p_cursor?, p_limit?)` — paginated, admin-only. |
| **Licences** | `admin_grant_commercial_licence`, `admin_transition_licence_status` (already live, no UI) | UI only — no new RPC needed. |
| **Payments** | — | New: `admin_list_payment_events(p_billing_customer_id?, p_cursor?, p_limit?)`. |
| **Receipts/Evidence** | — | Reuses `get_my_payment_receipt`'s admin-scoped sibling, or simply `admin_list_payment_events` joined client-side — no separate RPC required for the admin side. |
| **Audit** | `billing_audit_events` + `commercial_catalog_audit_events` (per-customer/per-entity RLS only) | New: `admin_list_billing_audit_events(p_cursor?, p_limit?)` and `admin_list_catalog_audit_events(p_cursor?, p_limit?)` — the cross-customer feed `CommercialAdmin.tsx`'s own comment says was "deliberately out of scope for Ω2-G." Ω3 closes it. |

**Hard rule, unchanged from Ω2-G and re-affirmed:** the admin UI never mutates `commercial_offers`/`commercial_plans`/`commercial_products`/`commercial_admins`/`commercial_licences`/`entitlement_overrides` directly via `.from(...).insert/update()`. Every write crosses a named, audited RPC. This is already 100% true for Offers today and must remain true for every new tab.

### D.1 Audit Entity-Type Vocabulary — corrected (Blocker 4)

**The defect, precisely.** An earlier draft of this design proposed widening `commercial_catalog_audit_events.entity_type`'s CHECK vocabulary to add `'ADMIN'` alone, for `admin_grant_commercial_admin`/`admin_revoke_commercial_admin`/`admin_transition_platform_state`'s audit rows — but never added `'PRODUCT'`, despite this same design introducing `admin_upsert_commercial_product`, which needs to write an audit row for every product it creates or edits. Left uncorrected, that RPC's own audit `INSERT` would fail its own table's CHECK constraint the moment it tried to write `entity_type = 'PRODUCT'`.

**Existing allowed values — directly inspected in this pass, not assumed:**
```
supabase/migrations/20260906083524_eca6c272-4a62-4468-995b-1c70e2cd67e5.sql:65
entity_type TEXT NOT NULL CONSTRAINT chk_ccae_entity_type CHECK (entity_type IN ('OFFER','PLAN')),
```
Exactly two values exist today: `'OFFER'`, `'PLAN'`. A direct grep of the same file for every literal `'OFFER'`/`'PLAN'` write confirms **only** `admin_upsert_commercial_offer` writes to this table today (lines 231-257 of that migration), and it writes **only** `entity_type = 'OFFER'` (`OFFER_CREATED`/`OFFER_UPDATED`) — `'PLAN'` is allowed by the CHECK constraint but has **zero existing writers**; it was reserved, unused, ahead of a plan-authoring RPC that did not exist until this design.

**Ω3 additions — exactly two, not guessed:** `'ADMIN'`, `'PRODUCT'`.

**Final complete allowed vocabulary after this design:** `'OFFER'`, `'PLAN'`, `'ADMIN'`, `'PRODUCT'` — four values, two pre-existing (one previously unused), two new.

**Every RPC that writes each value, enumerated exactly:**

| `entity_type` | Written by |
|---|---|
| `'OFFER'` | `admin_upsert_commercial_offer` (existing, unchanged) — `OFFER_CREATED`/`OFFER_UPDATED`; `admin_supersede_commercial_offer` (new) — `OFFER_CREATED` |
| `'PLAN'` | `admin_upsert_commercial_plan` (new) — the first-ever writer of this already-allowed-but-previously-unused value |
| `'ADMIN'` | `commercial-admin-bootstrap` Edge Function (new, via its `service_role` client) — `FOUNDER_BOOTSTRAP`; `admin_grant_commercial_admin` (new) — `ADMIN_GRANTED`; `admin_revoke_commercial_admin` (new) — `ADMIN_REVOKED`; `admin_transition_platform_state` (new) — `PLATFORM_STATE_TRANSITIONED` |
| `'PRODUCT'` | `admin_upsert_commercial_product` (new) — `PRODUCT_CREATED`/`PRODUCT_UPDATED` |

**Corrected migration statement (part of the Ω3.0 file, alongside the other `commercial_offers` hardening — §Q):**
```sql
ALTER TABLE public.commercial_catalog_audit_events
  DROP CONSTRAINT chk_ccae_entity_type;
ALTER TABLE public.commercial_catalog_audit_events
  ADD CONSTRAINT chk_ccae_entity_type CHECK (entity_type IN ('OFFER','PLAN','ADMIN','PRODUCT'));
```
Strictly widened — every value the live constraint accepts today remains accepted; nothing is removed or narrowed.

**Proof that `admin_upsert_commercial_product` writes its audit event atomically with the product mutation — mirroring `admin_upsert_commercial_offer`'s own already-live pattern exactly:**
```sql
CREATE OR REPLACE FUNCTION public.admin_upsert_commercial_product(
  p_code TEXT, p_name TEXT, p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog AS $$
DECLARE
  v_user_id    UUID := auth.uid();
  v_product_id UUID;
  v_previous   JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_commercial_admin() THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT id, to_jsonb(cp.*) INTO v_product_id, v_previous
    FROM public.commercial_products cp WHERE cp.code = p_code;

  IF v_product_id IS NOT NULL THEN
    UPDATE public.commercial_products SET name = p_name WHERE id = v_product_id;
    INSERT INTO public.commercial_catalog_audit_events (
      actor_user_id, action, entity_type, entity_id, previous_state, new_state, reason
    ) VALUES (
      v_user_id, 'PRODUCT_UPDATED', 'PRODUCT', v_product_id, v_previous,
      jsonb_build_object('code', p_code, 'name', p_name), p_reason
    );
  ELSE
    INSERT INTO public.commercial_products (code, name)
      VALUES (p_code, p_name) RETURNING id INTO v_product_id;
    INSERT INTO public.commercial_catalog_audit_events (
      actor_user_id, action, entity_type, entity_id, previous_state, new_state, reason
    ) VALUES (
      v_user_id, 'PRODUCT_CREATED', 'PRODUCT', v_product_id, NULL,
      jsonb_build_object('code', p_code, 'name', p_name), p_reason
    );
  END IF;

  RETURN jsonb_build_object('product_id', v_product_id, 'code', p_code);
END;
$$;
```
Both the product mutation (`UPDATE`/`INSERT` on `commercial_products`) and its audit row (`INSERT` on `commercial_catalog_audit_events`) execute inside this **one** function invocation, which runs as **one** PostgreSQL transaction — there is no `EXCEPTION` block here at all (unlike `admin_upsert_commercial_offer`/`admin_supersede_commercial_offer`, which need one to *translate* two specific, expected constraint names; this function has no analogous expected-failure case to translate). If the audit `INSERT` fails for **any** reason — most concretely, if `'PRODUCT'` were ever *not* in `chk_ccae_entity_type`'s allowed list, reproducing exactly the defect this correction closes — the entire, uncaught exception aborts the whole transaction, and the `commercial_products` mutation immediately above it is rolled back with it. This is not a special mechanism built for this RPC; it is the ordinary, default behavior of any PL/pgSQL function with no exception handler around a failing statement, and it is the same atomicity property `admin_upsert_commercial_offer` has always had for its own product/audit pair (the migration's actual live code, `20260906083524...:220-258`, has never had an exception handler around its `OFFER`/audit writes either).

---

## E. Plan != Price

**Preserved, unconditionally.** `commercial_plans` has no price/currency/amount column today and none may ever be added — confirmed by `globalCommerceModel.test.ts`'s existing "PLAN != PRICE" regression guard, which will continue to pass unmodified through every Ω3 subphase. A plan may have arbitrarily many `commercial_offers` rows differing by market, currency, billing interval, or effective period — this is already exactly how the schema is shaped (`uq_co_current_offer` keys on `plan_id, market_code, currency_code`, not a 1:1 plan:price assumption). Ω3 adds Product/Plan admin RPCs (§D) but they carry **only** `code`/`name`/`feature_codes` — no economic field is ever accepted by `admin_upsert_commercial_plan`.

### E.1 Immutable Offer Version / Effective-History Semantics

**The gap, precisely.** `admin_upsert_commercial_offer`'s body today does a genuine `UPDATE` on an *existing* `offer_code`'s economic fields (`currency_code`, `amount_minor`, `currency_exponent`, `billing_interval`, `billing_interval_count`) whenever the admin re-submits that code. This means the *current* mechanism can literally **mutate an offer's price in place** — the only reason this hasn't caused a historical-integrity problem yet is that `payment_checkout_intents` snapshots the offer's economics at *purchase* time, so a past buyer's contract is protected. But the *catalogue's own pricing history* — "what did offer X cost on 1 March vs 1 June" — has no durable record today: an in-place `UPDATE` simply overwrites the old numbers, and `commercial_catalog_audit_events`' `previous_state`/`new_state` JSONB is the *only* place the old price would still exist, which is an audit log, not a queryable pricing-history authority.

**Design: an offer's economic identity, once created, is immutable. A price change is always a new version, never a mutation.**

**Enforcement mechanism — stated once, unambiguously, so it can be proven rather than asserted (§G.2 carries the exact SQL; this section carries the semantics and the workflow):**

A single new trigger on `commercial_offers` — `trg_commercial_offers_economic_integrity`, `BEFORE INSERT OR UPDATE`, defined once in §G.2 — is the **sole** enforcement point for this rule. It compares `NEW` against `OLD` on every `UPDATE` and raises `OFFER_ECONOMICS_IMMUTABLE` the instant any of `currency_code`/`amount_minor`/`currency_exponent`/`billing_interval`/`billing_interval_count`/`plan_id`/`market_code` differs. Lifecycle-only fields (`is_active`, `is_purchasable`, `effective_end`) are excluded from the comparison, so pausing, retiring, or closing a window remains an ordinary `UPDATE`.

**Why this closes the RPC/trigger ambiguity from an earlier draft of this document, decisively:** the trigger is attached to the *table*, not to any one caller. `admin_upsert_commercial_offer` needs **zero body changes** for this rule — it already issues the same `UPDATE ... SET currency_code = p_currency_code, amount_minor = p_amount_minor, ...` it issues today (including for the existing purchasable-toggle action, which resubmits every field unchanged except `is_purchasable`); the trigger fires transparently underneath it. When the resubmitted values are identical to the stored ones (the toggle case), every `IS DISTINCT FROM` comparison is `false` and nothing is raised. When an admin genuinely tries to change a price on an existing `offer_code`, the same statement now raises, and that exception propagates out of the RPC call as an ordinary Postgres error — no new code path, no second copy of the rule, no possibility of the RPC and the trigger disagreeing, because there is only one rule, defined in one place, that every caller (the RPC today, any future caller, a `service_role` hand-edit) is equally subject to. This is the same "trigger is the sole authority" idiom this exact schema already uses for `payment_events_immutable()`/`billing_audit_events_immutable()`/`commercial_catalog_audit_events_immutable()` — not a new pattern invented for this rule.

**Effective-history workflow this produces:** to change a price, the admin creates offer `PAID-TZ-2026Q3` (new code) with `effective_start` = the day the old price should end, and closes out the OLD code (`PAID-TZ-2026Q1`) by changing **only** `effective_end`/`is_purchasable` — a lifecycle-only update, which the trigger above permits. The two rows together — old row with a closed `effective_end`, new row starting where it left off — **are** the effective-history record, queryable directly from `commercial_offers` with no JSONB archaeology required. `commercial_catalog_audit_events` continues to record both the `OFFER_CREATED` (new version) and the `OFFER_UPDATED` (old version's lifecycle closure) as a paired, timestamped, human-attributed audit trail — but the *authoritative* history now lives in first-class, directly queryable rows, not only in an audit blob. **§E.2 below defines the database-native mechanism that makes "the two rows never overlap" a guarantee even when two admins attempt this concurrently — this trigger alone does not, and is not claimed to, provide that guarantee.**

This trigger is the concrete mechanism for mission item #9 ("prevention of invalid offer economics before purchasable=true") and the *identity-immutability* half of item #10 ("immutable offer version/effective-history semantics") — and it is deliberately **stronger** than #9's literal wording: the guard fires on *every* write to `commercial_offers`, not only writes that also set `is_purchasable = true`, so an invalid or mutated economic row can never exist in the table at all, purchasable or not. The *non-overlap* half of item #10 — proving two concurrent transactions cannot both succeed in creating overlapping effective periods — is a genuinely separate database invariant, specified next.

### E.2 Concurrency-Safe Effective-Period Exclusion (independent of the trigger)

**This section exists because the trigger above is the wrong tool for this specific job, and claiming otherwise would be dishonest.** `commercial_offers_economic_integrity()` is a `BEFORE` row-level trigger — it can only see the row currently being written (`NEW`) and, on `UPDATE`, the row it is replacing (`OLD`). It has no visibility into *other* rows, so it structurally cannot detect that a **different**, concurrently-inserted row for the same offer family now overlaps it in time. A trigger that tried to do this by running `SELECT ... FROM commercial_offers WHERE ... && NEW.effective_range` would suffer classic write-skew: two concurrent transactions can each run that `SELECT` before either has committed, each see zero conflicting rows (because the other transaction's not-yet-committed insert is invisible to it), and both proceed to `INSERT` successfully — the exact race the mission calls out, and exactly why "an ordinary trigger that queries visible rows" is listed among the mechanisms this design must not rely on.

**Evidence status for this section, classified explicitly (mission requirement #10) — nothing below is asserted at a higher confidence than this table supports:**

| Claim | Status | Basis |
|---|---|---|
| `btree_gist` and `pgcrypto` are already enabled in this database | **EXISTING_AND_PROVEN** | Directly re-read in this review pass: lines 1–2 of the live Ω1 migration (`supabase/migrations/20260905093408_8fc55e64-3e06-4d26-8835-438a9243e1ef.sql`), not taken from an earlier summary. |
| `commercial_licences.excl_cl_no_overlapping_authoritative_periods` exists, uses the identical `EXCLUDE USING gist (uuid WITH =, tstzrange WITH &&) WHERE (...)` shape | **EXISTING_AND_PROVEN** | Directly re-read in this review pass, same migration file, lines 122–138. |
| `commercial_offers` currently has 11 named constraints + 2 supporting indexes, and `admin_upsert_commercial_offer`'s `UPDATE` branch does not touch `plan_id`/`market_code` | **EXISTING_AND_PROVEN** | Directly re-read in this review pass: `supabase/migrations/20260906083524_eca6c272-4a62-4468-995b-1c70e2cd67e5.sql`, lines 3–41 (table) and 180–262 (function). |
| PostgreSQL exclusion constraints are enforced via the same index-level machinery as unique constraints, and reject the losing concurrent transaction with `23P01` | **DOCUMENTED POSTGRES BEHAVIOR, not independently re-verified against a live instance in this environment** — this environment has no live Postgres connection anywhere in this repository's toolchain (the same standing limitation noted for every other DB-touching design decision this whole project has made). It is not a bare assumption either: it is the identical mechanism `excl_cl_no_overlapping_authoritative_periods` already relies on in production today for `commit_verified_commercial_payment`'s concurrent-webhook-safe licence closeout — if that claim were false, the already-shipped licence system would already be unsafe under concurrency, which has not been reported. |
| Everything new in this section — the `effective_history_protected`/`request_fingerprint` columns, both trigger functions, the exclusion constraint, `admin_supersede_commercial_offer` | **PLANNED ADDITION** — none of it exists in the repository yet; this document is a design, not a changelog. |
| The two-concurrent-transaction test (parts a/b/c below) produces the results this document predicts | **EVIDENCE UNAVAILABLE** — not executed, cannot be executed in this environment, explicitly flagged at every mention rather than implied to have passed. |

**Mechanism: a PostgreSQL exclusion constraint, using GiST, over the offer-family identity and a generated time-range column — the same primitive already live and proven in this exact schema for `commercial_licences`.**

**1. Canonical offer-family identity — corrected, a genuine defect, not a refinement.** An earlier draft of this design used `(plan_id, market_code, currency_code)` — the same three-column tuple `uq_co_current_offer` uses — reasoning that `billing_interval` should stay *out* of the family key so ANNUAL and MONTHLY offers could coexist as parallel siblings. **That reasoning was backwards.** `billing_interval` (and `billing_interval_count`, its companion — "ANNUAL×1" and "ANNUAL×3" are just as distinct a family as "ANNUAL" and "MONTHLY") determine *which offers are actually interchangeable versions of each other*; leaving them out of the exclusion constraint's key does not let siblings coexist freely — it makes the constraint treat every billing-interval variant **as if it were the same family**, so creating a MONTHLY×1 offer with any effective window overlapping an already-`effective_history_protected` ANNUAL×1 offer for the same plan/market/currency would be **incorrectly rejected** as a historical-overlap conflict, when the two are not versions of one another at all. The corrected family identity is the full five-column tuple:

```
plan_id, market_code, currency_code, billing_interval, billing_interval_count
```

This is also now the correct home for the mission's "immutable economic identity fields after insertion" requirement: all five of these columns are already on §E.1's immutability list (`commercial_offers_economic_integrity()` rejects any `UPDATE` that changes `plan_id`/`market_code`/`currency_code`/`billing_interval`/`billing_interval_count` on an existing row) — meaning an offer's *family membership itself*, not only its price, is fixed for the row's lifetime. A family can never be reassigned; a price change is always a new row in the same or a different family, never a mutation of which family an existing row belongs to.

**A necessary, related correction to an *existing, live* schema object — `uq_co_current_offer` — found while proving this family key is honest end-to-end.** `uq_co_current_offer UNIQUE (plan_id, market_code, currency_code) WHERE is_active AND is_purchasable AND effective_end IS NULL` is *already live* today and does **not** discriminate by billing interval either — meaning, right now, in the live database, an admin cannot have both an open-ended, active, purchasable ANNUAL offer and an open-ended, active, purchasable MONTHLY offer for the same plan/market/currency simultaneously; the second `INSERT`/`UPDATE` would violate this pre-existing unique index regardless of anything this design adds. Leaving this untouched would make the mission's own required proof ("MONTHLY × 1 and ANNUAL × 1 may coexist") **false in the live schema** even after the exclusion constraint below is corrected. This is **not** editing Ω1/Ω2's historical migration file — it is a new, forward-only migration (part of Ω3.0) that evolves the *current* index definition, the same technique already used elsewhere in this design for widening `commercial_catalog_audit_events.entity_type`'s CHECK vocabulary:
```sql
DROP INDEX IF EXISTS public.uq_co_current_offer;
CREATE UNIQUE INDEX uq_co_current_offer
  ON public.commercial_offers (plan_id, market_code, currency_code, billing_interval, billing_interval_count)
  WHERE is_active AND is_purchasable AND effective_end IS NULL;
```
This is registered explicitly in §Q's schema-change inventory as a **modified existing supporting index** (a distinct, honestly-labeled bucket from "modified existing constraint" — see §Q — since `uq_co_current_offer` was created via `CREATE UNIQUE INDEX`, not `ALTER TABLE ... ADD CONSTRAINT`, and no named `CONSTRAINT` anywhere on `commercial_offers` is altered by this design).

**2. Applicable market dimension.** `market_code`, included in the family tuple with the `=` operator — two offers in *different* markets never conflict, by construction, regardless of overlapping dates.

**3. Applicable currency dimension.** `currency_code`, included in the family tuple with the `=` operator — two offers in *different* currencies never conflict, regardless of overlapping dates. (Per the Dimensional Independence Charter: this constraint's currency column and market column are independent inputs to the same tuple — neither is derived from the other, and the constraint does not encode or require any relationship between them.)

**4. Range boundaries: `[effective_start, effective_end)`.** A new generated, stored column, added the same way `commercial_licences.effective_range` already exists:
```sql
ALTER TABLE public.commercial_offers
  ADD COLUMN effective_range TSTZRANGE GENERATED ALWAYS AS (
    tstzrange(effective_start, effective_end, '[)')
  ) STORED;
```
Half-open — inclusive start, exclusive end — is not a stylistic choice, it is what makes boundary-touching legal (see point 7).

**5. Open-ended effective period.** `effective_end IS NULL` → `tstzrange(effective_start, NULL, '[)')`, which PostgreSQL represents as a range with an **unbounded upper end** — identical to how `commercial_licences.effective_range` already represents an open-ended licence today. No special-casing is needed; PostgreSQL's range types handle this natively.

**6. Treatment of retired / non-purchasable offers — corrected a second time, and renamed to stop the column name itself from implying a false guarantee.** An earlier draft used `WHERE (is_purchasable)`, which silently lost protection on retirement — the first correction fixed that with `WHERE (is_active AND was_ever_purchasable)`. **That fix was itself still wrong**, and review correctly caught it: `is_active` is *also* a mutable lifecycle field, and this design had explicitly described it as "the one deliberate escape hatch" an admin could flip to remove a row from protection — which is exactly the class of defect being fixed, just moved one column over. **No mutable lifecycle field of any kind — not `is_purchasable`, not `is_active`, not any future one — may ever determine whether a historically-effective row is protected.** The predicate is corrected to reference the protection column **alone**.

**The column is renamed from `was_ever_purchasable` to `effective_history_protected` in this pass, and this is a deliberate, required correction, not cosmetic.** Once legacy rows are classified conservatively (point 6a, below) rather than from their actual purchase history, `was_ever_purchasable` becomes a **factually false name** for a meaningful fraction of `true` rows — a legacy row protected because it predates this migration, with genuinely unknown or unprovable purchase history, was never proven to have "ever [been] purchasable"; it is protected because this design refuses to guess that it wasn't. `effective_history_protected` states the actual invariant the column enforces — "this row's effective period is protected from future overlap" — without asserting a historical fact (a purchase) this design cannot verify for every legacy row. Every occurrence of the old name has been renamed throughout this document; there is no remaining reference to `was_ever_purchasable` anywhere in this design.

```sql
ALTER TABLE public.commercial_offers
  ADD COLUMN effective_history_protected BOOLEAN NOT NULL DEFAULT false;
```
(The column-level `DEFAULT false` governs only *new* rows created after this `ALTER TABLE` runs, via the ratchet trigger below. It does **not** govern the legacy rows already in the table at migration time — point 6a, immediately following, classifies those explicitly and unconditionally, before the ratchet trigger is even created, precisely so the two mechanisms cannot fight each other.)

**Formal definition of the ratchet, stated precisely as required, and now covering both new-row and legacy-row entry paths without contradiction:**
- **For rows created after this migration:** `false → true` is permitted **only** at the instant an offer row first becomes purchasable/effective (`is_purchasable` transitions to, or is created as, `true`) — enforced by the trigger in point 6b.
- **For rows that already existed when this migration ran:** classified `true` unconditionally and conservatively at migration time (point 6a) — never derived from `is_purchasable`, current or historical, and never left `false` on the strength of an assumption about incomplete evidence.
- **`true → false`** is **forbidden, permanently, with no exception**, regardless of which of the two paths above set it `true` — not via `admin_supersede_commercial_offer`, not via `admin_upsert_commercial_offer`, not via a direct `service_role` `UPDATE` statement, not via any future code path this design does not yet anticipate.
- **Once `true`, it remains `true` for the lifetime of the row**, regardless of retirement (`is_purchasable = false`), supersession, or deactivation (`is_active = false`). There is no field, no combination of fields, and no administrative action that reverses it. A row that must be permanently struck from history for a genuine legal/compliance reason is **out of band of this ratchet entirely** — a manual, audited, `service_role`/DBA-level intervention accompanied by its own migration and its own sign-off, never an ordinary application code path (see the closing note below).

A genuine `DRAFT` (§D's lifecycle label — never yet activated, `effective_history_protected = false`) may still be created **after this migration** with an effective window that overlaps a currently-live sibling, with no conflict — this is what lets an admin pre-stage a future price change without touching the current one. The **instant** a row is, or ever has been, purchasable, `effective_history_protected` becomes `true` and **stays** `true` forever — no other column, including `is_active`, has any bearing on whether the row remains protected.

**6a. Legacy-row classification — new in this pass, correcting a genuine BLOCKER-level defect. A manual runbook check is not a fail-closed database design; this must be executable SQL that runs automatically as part of applying the migration, with no human judgment call in the loop.**

**The defect in the prior draft, stated plainly.** The previous backfill classified a pre-existing row as protected using `is_purchasable OR EXISTS (... commercial_catalog_audit_events ...)` — and the document's own text admitted "that every historically-purchasable row has a corresponding audit entry is ASSUMPTION, not EXISTING_AND_PROVEN." An assumption is exactly what a fail-closed migration must never rely on: if that assumption were false for even one row — an offer made purchasable via a direct `service_role` write that predates this repository's own RPC-only discipline, with no audit trail — that row would be classified `effective_history_protected = false` and silently exit permanent protection, reproducing the exact class of defect this entire section exists to close.

**The corrected invariant:** every `commercial_offers` row that exists **before** this migration runs enters permanent protection **unconditionally** — never derived from `is_purchasable` (current or historical), never derived from audit-trail completeness, never left `false` because evidence is merely absent rather than affirmatively disproving purchasability. Uncertainty resolves to *protected*, not to *unprotected*.

**Why this must run, in this exact order, BEFORE the ratchet trigger (point 6c) exists — this ordering is load-bearing, not incidental.** The ratchet trigger's own logic (`NEW.effective_history_protected := OLD.effective_history_protected OR NEW.is_purchasable`) would **fight** an unconditional legacy `UPDATE ... SET effective_history_protected = true` if the trigger already existed: for a legacy row with `is_purchasable = false` and no prior protected value, the trigger's own logic would compute `false OR false = false`, silently discarding the migration's own deliberate classification — the exact same "caller's value is discarded" mechanism point 6c relies on for tamper-resistance would, if installed too early, discard the *migration's own* legitimate classification along with every hostile one. The corrected migration therefore performs the legacy classification **first**, while `effective_history_protected` is still a plain, trigger-free column, and only creates the ratchet trigger **afterward**, so it governs future writes exclusively and never re-litigates the legacy baseline this step establishes.

**Executable, fail-closed preflight — exact SQL, run as part of the Ω3.0 migration file, which Supabase/Postgres applies as a single transaction by default (no explicit `BEGIN`/`COMMIT` needed in the migration file itself for this property to hold — a failed statement anywhere in the file aborts the entire file):**

```sql
-- Step A: add the protection column. Legacy rows are NOT yet classified —
-- the column-level DEFAULT false is a placeholder that the next step
-- overwrites for every pre-existing row; it is never left standing for
-- rows that predate this migration.
ALTER TABLE public.commercial_offers
  ADD COLUMN effective_history_protected BOOLEAN NOT NULL DEFAULT false;

-- Step B: classify EVERY pre-existing row as protected, unconditionally.
-- No WHERE clause referencing is_purchasable or any audit table — every
-- row that exists at this exact statement's execution time is protected,
-- full stop.
UPDATE public.commercial_offers SET effective_history_protected = true;

-- Step C: prove classification is complete — an executable assertion,
-- not a comment claiming it worked. If any row failed to classify (which
-- should be structurally impossible for an unconditional UPDATE with no
-- WHERE clause, but this is checked rather than assumed, exactly as a
-- fail-closed design requires), the migration aborts here.
DO $$
DECLARE
  v_total      INTEGER;
  v_classified INTEGER;
BEGIN
  SELECT count(*) INTO v_total FROM public.commercial_offers;
  SELECT count(*) INTO v_classified
    FROM public.commercial_offers WHERE effective_history_protected;
  IF v_classified != v_total THEN
    RAISE EXCEPTION 'LEGACY_CLASSIFICATION_INCOMPLETE: classified % of % legacy rows — migration aborted, no exclusion constraint installed', v_classified, v_total;
  END IF;
END $$;

-- Step D: detect five-dimensional effective-range conflicts among the
-- now-fully-protected legacy set, BEFORE the exclusion constraint exists
-- to enforce it. This is a deliberate, human-readable diagnostic step —
-- installing the constraint directly against conflicting data would also
-- fail, but with a raw, unexplained 23P01 and no indication of WHICH rows
-- conflict or how many. This step names the defect precisely and aborts
-- the whole migration, leaving the exclusion constraint uninstalled,
-- rather than leaving the table in a state where uniqueness is assumed
-- but not actually enforced.
DO $$
DECLARE
  v_conflict_count INTEGER;
BEGIN
  SELECT count(*) INTO v_conflict_count
    FROM public.commercial_offers a
    JOIN public.commercial_offers b ON
      a.id < b.id
      AND a.plan_id                = b.plan_id
      AND a.market_code            = b.market_code
      AND a.currency_code          = b.currency_code
      AND a.billing_interval       = b.billing_interval
      AND a.billing_interval_count = b.billing_interval_count
      AND a.effective_range && b.effective_range
   WHERE a.effective_history_protected AND b.effective_history_protected;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'LEGACY_EFFECTIVE_RANGE_CONFLICTS_DETECTED: % conflicting protected-row pairs found across the full five-dimensional family key — reconcile the underlying data and retry this migration; the exclusion constraint has NOT been installed', v_conflict_count;
  END IF;
END $$;
```

**What happens if either preflight check raises.** The `RAISE EXCEPTION` inside a `DO` block is an uncaught exception at the top level of the migration file (no surrounding `EXCEPTION` handler exists for these two blocks) — it aborts the enclosing transaction. Because the entire migration file runs as one transaction, this means **the whole Ω3.0 migration is rolled back**, not merely the exclusion-constraint step: the two new tables, both trigger functions, the widened `chk_ccae_entity_type` vocabulary, and every other object this file would have created are rolled back along with it. This is the correct, conservative behavior for a genuinely fail-closed design — a partially-applied Ω3.0 (protection column present, exclusion constraint absent, tables present) would be a worse, more confusing state than "nothing in this file took effect; fix the data and retry the whole file." Required data reconciliation before retry means resolving the reported conflicting rows (via `admin_supersede_commercial_offer`-style retirement, or a hand-reviewed correction of the conflicting historical rows) and then re-running the identical migration file, which is fully idempotent up to this point (an unconditional `UPDATE` and two read-only `DO` blocks have no partial-state hazard on retry).

**Hostile tests for this section (live-database — cannot run in this repo's DB-less suite; see §R for the full inventory):**
- **Formerly-purchasable, now-retired legacy offer with no corroborating audit event:** seed a row with `is_purchasable = false`, `effective_end` already set, and zero matching `commercial_catalog_audit_events` rows (simulating a historical `service_role` write that predates the audit-writing discipline). Run the Step B classification. EXPECTED: `effective_history_protected = true` — it is protected **unconditionally**, not because evidence was found for it, but because the classification never looks for evidence in the first place. It must never silently remain `false`.
- **Ambiguous legacy record** (partial/contradictory data — e.g. `is_purchasable = true` but `effective_end` already in the past, a state that shouldn't arise under correct application logic but is not itself impossible in raw data): same result — `effective_history_protected = true` unconditionally; the classification step has no branch that could produce `false` for any pre-existing row.
- **Overlapping legacy records:** seed two pre-existing rows in the same complete family with genuinely overlapping `effective_range`s. Run Steps B-D. EXPECTED: Step D's conflict count is `> 0`, `RAISE EXCEPTION` fires, the entire migration aborts — the exclusion constraint is never installed and no other Ω3.0 object is created either.
- **Missing audit history (entirely, for the whole legacy dataset):** run Steps B-D with `commercial_catalog_audit_events` empty. EXPECTED: identical outcome to a fully-audited dataset — Steps B-D never read that table at all in the corrected design, so its completeness is irrelevant by construction, not merely irrelevant in practice.
- **Partial audit history:** same as above — irrelevant by construction.
- **Interrupted migration** (the migration process is killed mid-file, after Step B but before Step D): PostgreSQL's transactional DDL means an interrupted connection before `COMMIT` leaves the entire transaction uncommitted — on reconnect, `commercial_offers.effective_history_protected` does not exist at all (the whole file rolled back), exactly as if the migration had never been attempted.
- **Rerun after rollback:** re-running the identical migration file after either an interruption or a Step C/D-triggered abort is safe — Step A's `ADD COLUMN` and Step B's unconditional `UPDATE` have no dependency on any prior partial state (the column did not survive a rollback, so there is nothing to reconcile between attempts other than the underlying data conflict Step D reported).

**6b. The ratchet trigger — governs rows created or updated *after* this migration only; corrected to compute the column itself from trusted inputs on every write, never trusting the caller's own value for it, closing both tamper directions (illegitimate `true→false` *and* illegitimate `false→true`). Created AFTER point 6a's legacy classification runs, for the ordering reason stated there:**
```sql
CREATE OR REPLACE FUNCTION public.commercial_offers_effective_history_ratchet()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  -- NEW.effective_history_protected is never read here — whatever value a caller
  -- (RPC, service_role, hostile hand-edit) supplies for it is completely
  -- discarded and recomputed unconditionally. This is what makes the
  -- ratchet's two guarantees hold even against a direct, adversarial
  -- write, not merely against the RPCs this design controls.
  IF TG_OP = 'INSERT' THEN
    -- false->true permitted only if the row is created already-purchasable.
    NEW.effective_history_protected := NEW.is_purchasable;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Once true, stays true regardless of what NEW claims. Otherwise,
    -- true only if this very update is the one making it purchasable.
    NEW.effective_history_protected := OLD.effective_history_protected OR NEW.is_purchasable;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_commercial_offers_effective_history_ratchet
  BEFORE INSERT OR UPDATE ON public.commercial_offers
  FOR EACH ROW EXECUTE FUNCTION public.commercial_offers_effective_history_ratchet();
```
Note precisely what changed from the prior (defective) draft of this trigger: the old body only *forced* the column to `true` under certain conditions and otherwise left `NEW.effective_history_protected` as whatever the caller's own `UPDATE`/`INSERT` statement supplied — meaning a caller could still illegitimately inject `true` on a row that was never actually purchasable (an over-protection bug, the mirror image of the reported under-protection one). The corrected body **never reads `NEW.effective_history_protected` at all** — it is written unconditionally from `OLD.effective_history_protected`/`NEW.is_purchasable` only, so the column's value is a pure, deterministic function of trusted state, never of caller intent.

`effective_history_protected` is lifecycle bookkeeping, not an economic fact — it joins `is_active`/`is_purchasable`/`effective_end` on the list of fields §E.1's immutability trigger deliberately does not protect (there is nothing to protect: this trigger alone already makes it impossible to move backward).

**The out-of-band exception, named so it is never mistaken for an ordinary code path:** if a row's protected history must someday be struck for a genuine legal reason (a fraudulent entry, a court order), the only sanctioned mechanism is a hand-authored, reviewed, one-off migration executed by a database owner outside any RPC — the same tier of action this repository already reserves for the original `commercial_admins` bootstrap (§C) — never a button in the admin UI, never a parameter any RPC accepts.

**7. Historical periods may touch but never overlap — provably, from range semantics, not by convention.** Two half-open ranges `[a, b)` and `[b, c)` share the point `b` as a boundary but PostgreSQL's `&&` (overlaps) operator returns `false` for them — this is standard, documented range-type behavior, not a special case this design has to add. A successor whose `effective_start` equals its predecessor's (already-closed) `effective_end` is therefore always legal, giving genuinely contiguous, gapless coverage when desired, while two rows that both claim to be valid at the same instant are always rejected.

**8. Deterministic conflict error code — corrected this pass to name the exact constraint before translating, not merely the broad `exclusion_violation` condition (Finding 2).** `OFFER_EFFECTIVE_PERIOD_CONFLICT`. Both `admin_upsert_commercial_offer` and the new `admin_supersede_commercial_offer` (point 13) catch `exclusion_violation`, but neither trusts the condition name alone — each reads the actual constraint name PostgreSQL attached to the error via `GET STACKED DIAGNOSTICS` and translates only an exact match. `admin_upsert_commercial_offer`'s own addition, in full — the only new code in its body:
```sql
EXCEPTION
  WHEN exclusion_violation THEN
    DECLARE v_constraint_name TEXT;
    BEGIN
      GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
      IF v_constraint_name = 'excl_co_no_overlapping_purchasable_periods' THEN
        RAISE EXCEPTION 'OFFER_EFFECTIVE_PERIOD_CONFLICT: % overlaps an existing purchasable offer for this family', p_offer_code
          USING ERRCODE = '23P01';
      ELSE
        RAISE;
      END IF;
    END;
```
This is a genuinely new, narrow addition to `admin_upsert_commercial_offer`'s body, distinct from and in addition to the "zero body changes" statement above, which refers only to the currency/immutability guards. The two statements do not contradict each other: one RPC, two independent constraints it must respect, one guard enforced silently by a trigger it need not know about, one guard whose raw error it explicitly translates — and, as of this pass, translates only after confirming which constraint actually fired, with a bare `RAISE;` for anything else.

**9. The exclusion constraint itself — corrected on two independent axes now: the family key (point 1) widened to five columns, the predicate (points 6/6a) narrowed to `effective_history_protected` alone.**
```sql
ALTER TABLE public.commercial_offers
  ADD CONSTRAINT excl_co_no_overlapping_purchasable_periods
    EXCLUDE USING gist (
      plan_id                WITH =,
      market_code            WITH =,
      currency_code          WITH =,
      billing_interval       WITH =,
      billing_interval_count WITH =,
      effective_range        WITH &&
    ) WHERE (effective_history_protected);
```
The `WHERE` predicate is a single-column, single-condition test over the one column in this design engineered to be a true, tamper-proof, one-way ratchet (points 6a and 6b together — legacy classification and the ongoing trigger). **No other column participates in deciding whether a row remains protected — not `is_active`, not `is_purchasable`, not `effective_end`.** The `EXCLUDE USING gist (...)` key, separately, is what defines *which rows are even compared to each other* — five columns, not three, precisely so a MONTHLY offer and an ANNUAL offer for the same plan/market/currency are never compared for overlap at all (they fail the `=` check on `billing_interval` before `&&` on `effective_range` is ever evaluated), while two ANNUAL×1 rows for the same plan/market/currency genuinely are compared. `effective_history_protected` is a plain, non-volatile boolean column — the predicate remains fully **immutable and deterministic**, with no reference to `now()` or any other STABLE/VOLATILE function (PostgreSQL would reject such a predicate outright at `CREATE` time, since `now()` is not `IMMUTABLE`) — mission requirement #2 remains satisfied by this predicate exactly as it was by the earlier, since-corrected ones; widening the *key* (point 1) is an orthogonal correction and does not touch the predicate's immutability at all.

**Proofs required by this pass, each following directly from the key above:**
- **MONTHLY×1 and ANNUAL×1 may coexist, even with fully overlapping effective ranges:** they differ on `billing_interval` (`'MONTHLY'` vs `'ANNUAL'`), so the `=` comparison on that column alone is false for every pair of rows between the two groups — GiST never even reaches the `&&` range check for such a pair. Two rows can only conflict if *all five* key columns compare equal.
- **MONTHLY×1 and MONTHLY×3 are separate families:** identical reasoning on `billing_interval_count` (`1` vs `3`) — a "pay monthly" and a "pay every 3 months" offer are different products, not versions of one another, and never conflict regardless of dates.
- **Two versions within the identical complete family (all five columns equal) may touch at a boundary but never overlap:** unchanged from point 7 — `[a,b)` and `[b,c)` do not satisfy `&&`; `[a,b)` and `[a+ε,c)` for any `ε` strictly less than `b-a` do.
- **Retirement/deactivation never removes historical protection:** unchanged from points 6/6a — the predicate references only `effective_history_protected`, which no lifecycle field or admin action can reset to `false`.
- **Currency, interval, interval count, plan, and market are immutable economic identity fields after insertion:** already true and unchanged — `commercial_offers_economic_integrity()` (§E.1) already includes all five in its `IS DISTINCT FROM` comparison list; this correction changes the exclusion constraint's *key*, not the immutability trigger's field list, since that list was already correct.

**10. Migration prerequisite — `btree_gist`.** GiST has no native operator class for plain equality on `uuid`/`text` columns; combining them with a range column in one GiST index requires the `btree_gist` extension. **This is not new work.** `btree_gist` is already enabled — `CREATE EXTENSION IF NOT EXISTS btree_gist;` is the second line of the live Ω1 migration (`supabase/migrations/20260905093408_8fc55e64-3e06-4d26-8835-438a9243e1ef.sql:2`), installed specifically to support `commercial_licences.excl_cl_no_overlapping_authoritative_periods` — the exact same `EXCLUDE USING gist (uuid WITH =, tstzrange WITH &&) WHERE (...)` shape this design reuses for offers. This new constraint requires zero new extensions and zero new migration statements beyond the column, the constraint, and the two RPC bodies.

**11. Behavior during concurrent inserts — proven, not assumed, and already relied upon in production today.** PostgreSQL enforces an exclusion constraint the same way it enforces a unique constraint: via the underlying index. When two concurrent transactions each attempt to insert a row whose family+range would conflict, the second one to reach the index blocks on the first (under default read-committed behavior for constraint checking), waits for the first transaction to resolve, and then re-checks: if the first committed, the second's insert now genuinely conflicts and fails with `23P01`; if the first rolled back, the second proceeds and succeeds. Exactly **one** of the two transactions commits; the other is rejected by the database itself, not by application logic racing to check first. This is not a novel claim about PostgreSQL's behavior — it is the identical mechanism `commercial_licences.excl_cl_no_overlapping_authoritative_periods` already relies on, live, today, to make concurrent webhook-driven licence closeouts safe (`commit_verified_commercial_payment`'s "closes out any existing ACTIVE/GRACE licence before inserting a new one" — the exact same shape of problem this design solves for offers).

**12. Behavior during predecessor retirement plus successor creation — corrected to use pessimistic row locking, not statement ordering alone.** The prior draft relied only on "retire-then-create in one transaction" — correct for atomicity, but insufficient for *concurrency*: it never actually serialized two concurrent supersession attempts against the *same* predecessor, which is exactly Blocker 2's Test B concern. The corrected RPC (point 13 below) issues `SELECT ... FROM commercial_offers WHERE offer_code = p_old_offer_code FOR UPDATE` before touching the predecessor — this is PostgreSQL's standard pessimistic row lock: a second transaction naming the same predecessor **blocks** (waits) rather than racing, and only proceeds once the first transaction commits or rolls back. Retirement itself is unchanged in substance — it **only ever sets `effective_end`/`is_purchasable`**, never `is_active` — matching point 6's distinction between ordinary retirement (still protected forever via the ratchet) and a genuinely erroneous row (the separate, deliberate `is_active = false` escape hatch).

**13. `admin_supersede_commercial_offer` — corrected to the full required sequence: authority → canonicalization → fingerprint → pre-lock idempotency check → predecessor lock → zero-row/eligibility/family/boundary validation → post-lock idempotency recheck → atomic close-and-create → durable result → narrow, named-only error translation.**

**Idempotency mechanism, unchanged from the prior pass and restated for completeness:** key = the existing `offer_code` column (no new key column); uniqueness boundary = the existing `uq_co_offer_code` constraint (no new constraint); scope = table-global; fingerprint = a new `request_fingerprint TEXT NULL` column, computed via `pgcrypto`'s `digest()` over the 9 semantic parameters (`p_old_offer_code`, `p_plan_code`, `p_market_code`, `p_currency_code`, `p_amount_minor`, `p_currency_exponent`, `p_billing_interval`, `p_billing_interval_count`, `p_effective_start`), excluding the key itself and the free-text `p_reason`.

**What is genuinely new in this pass:** the predecessor row lock (`FOR UPDATE`), the *second*, post-lock idempotency recheck this lock makes necessary, explicit predecessor-eligibility validation, explicit same-family validation between predecessor and successor, and boundary validation — with three new, named, deterministic error codes (`OLD_OFFER_NOT_FOUND`, `OLD_OFFER_NOT_SUPERSEDABLE`, `OFFER_FAMILY_MISMATCH`) plus one additional code this design introduces to cover a validation step Codex's spec implies but does not itself name (`INVALID_EFFECTIVE_BOUNDARY` — flagged here explicitly as an addition, not smuggled in silently; see the note immediately after the listing for why it's needed and why it isn't a mismapping of one of the three given codes).

```sql
CREATE OR REPLACE FUNCTION public.admin_supersede_commercial_offer(
  p_old_offer_code TEXT,            -- NULL only when opening a brand-new family
  p_new_offer_code TEXT, p_plan_code TEXT, p_market_code TEXT, p_currency_code TEXT,
  p_amount_minor BIGINT, p_currency_exponent SMALLINT,
  p_billing_interval TEXT, p_billing_interval_count SMALLINT,
  p_effective_start TIMESTAMPTZ, p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog AS $$
DECLARE
  v_fingerprint      TEXT;
  v_existing         RECORD;
  v_plan_id          UUID;
  v_old              RECORD;
  v_new_id           UUID;
  v_constraint_name  TEXT;
BEGIN
  -- STEP 1: validate caller authority.
  IF NOT public.is_commercial_admin() THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;

  -- STEP 2: validate and canonicalize the complete request.
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_new_offer_code IS NULL OR trim(p_new_offer_code) = '' THEN
    RAISE EXCEPTION 'NEW_OFFER_CODE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  SELECT id INTO v_plan_id FROM public.commercial_plans WHERE code = p_plan_code;
  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_PLAN_CODE: %', p_plan_code USING ERRCODE = '22023';
  END IF;

  -- STEP 3: calculate the canonical request fingerprint.
  v_fingerprint := encode(digest(
    concat_ws('|', p_old_offer_code, p_plan_code, p_market_code, p_currency_code,
      p_amount_minor::TEXT, p_currency_exponent::TEXT, p_billing_interval,
      p_billing_interval_count::TEXT, p_effective_start::TEXT),
    'sha256'), 'hex');

  -- STEPS 4-6: pre-lock idempotency check (cheap fast path — a pure
  -- replay never needs to lock the predecessor at all).
  SELECT id, request_fingerprint INTO v_existing
    FROM public.commercial_offers WHERE offer_code = p_new_offer_code;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: offer_code % already exists with different parameters', p_new_offer_code
        USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('offer_id', v_existing.id, 'offer_code', p_new_offer_code, 'replay', true);
  END IF;

  IF p_old_offer_code IS NOT NULL THEN
    -- STEPS 7-8: resolve AND LOCK the predecessor. This BLOCKS a second
    -- transaction naming the same predecessor — it does not race it.
    SELECT * INTO v_old FROM public.commercial_offers
      WHERE offer_code = p_old_offer_code
      FOR UPDATE;

    -- STEP 9: zero rows found.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'OLD_OFFER_NOT_FOUND: %', p_old_offer_code USING ERRCODE = '22023';
    END IF;

    -- STEP 10: post-lock idempotency RECHECK. While this transaction was
    -- blocked waiting for the lock above, a concurrent, identical request
    -- may have already committed the entire supersession.
    SELECT id, request_fingerprint INTO v_existing
      FROM public.commercial_offers WHERE offer_code = p_new_offer_code;
    IF FOUND THEN
      IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: offer_code % already exists with different parameters', p_new_offer_code
          USING ERRCODE = '22023';
      END IF;
      RETURN jsonb_build_object('offer_id', v_existing.id, 'offer_code', p_new_offer_code, 'replay', true);
    END IF;

    -- STEPS 11-12: predecessor eligibility. It must still be the open,
    -- current version of its family — not already closed by a DIFFERENT
    -- successor (step 10 above already returned if it was closed by
    -- THIS same request's own retry).
    IF v_old.effective_end IS NOT NULL OR NOT v_old.is_purchasable THEN
      RAISE EXCEPTION 'OLD_OFFER_NOT_SUPERSEDABLE: % is already retired or superseded', p_old_offer_code
        USING ERRCODE = '22023';
    END IF;

    -- STEPS 13-14: same complete offer-family identity as §E.2 point 1
    -- (five columns), predecessor vs. successor.
    IF v_old.plan_id != v_plan_id
       OR v_old.market_code != p_market_code
       OR v_old.currency_code != p_currency_code
       OR v_old.billing_interval != p_billing_interval
       OR v_old.billing_interval_count != p_billing_interval_count
    THEN
      RAISE EXCEPTION 'OFFER_FAMILY_MISMATCH: % is not in the same offer family as %', p_new_offer_code, p_old_offer_code
        USING ERRCODE = '22023';
    END IF;

    -- STEP 15: boundary validation. Because this function uses a SINGLE
    -- parameter (p_effective_start) as BOTH the value written to the
    -- predecessor's effective_end AND the value written to the
    -- successor's effective_start (see note below the listing),
    -- successor.effective_start = predecessor.effective_end is
    -- structurally guaranteed, not merely checked — there is no code
    -- path that could write two different values. What genuinely must
    -- be validated is that this shared boundary is not degenerate
    -- (retroactively at-or-before the predecessor's own start, which
    -- would make the predecessor's own historical coverage zero or
    -- negative length):
    IF p_effective_start <= v_old.effective_start THEN
      RAISE EXCEPTION 'INVALID_EFFECTIVE_BOUNDARY: successor effective_start (%) must be strictly after predecessor effective_start (%)',
        p_effective_start, v_old.effective_start USING ERRCODE = '22023';
    END IF;

    -- STEP 16 (predecessor half): close the predecessor — lifecycle-only,
    -- permitted by commercial_offers_economic_integrity(); effective_history_protected
    -- is untouched (already true, permanently, via the ratchet).
    UPDATE public.commercial_offers
       SET effective_end = p_effective_start, is_purchasable = false
     WHERE id = v_old.id;
  END IF;

  -- STEP 16 (successor half): same transaction as the predecessor closure
  -- immediately above (or the sole write, if p_old_offer_code IS NULL).
  INSERT INTO public.commercial_offers (
    offer_code, plan_id, market_code, currency_code, amount_minor, currency_exponent,
    billing_interval, billing_interval_count, effective_start, is_active, is_purchasable,
    request_fingerprint
  ) VALUES (
    p_new_offer_code, v_plan_id, p_market_code, p_currency_code, p_amount_minor, p_currency_exponent,
    p_billing_interval, p_billing_interval_count, p_effective_start, true, true, v_fingerprint
  ) RETURNING id INTO v_new_id;

  INSERT INTO public.commercial_catalog_audit_events (
    actor_user_id, action, entity_type, entity_id, previous_state, new_state, reason
  ) VALUES (
    auth.uid(), 'OFFER_CREATED', 'OFFER', v_new_id, NULL,
    jsonb_build_object('offer_code', p_new_offer_code, 'superseded', p_old_offer_code), p_reason
  );

  -- STEP 17: durable successor identity + transition result.
  RETURN jsonb_build_object('offer_id', v_new_id, 'offer_code', p_new_offer_code, 'replay', false);

EXCEPTION
  -- STEPS 18-19, corrected this pass: catching the broad PostgreSQL
  -- condition NAMES (unique_violation, exclusion_violation) is not, by
  -- itself, proof of WHICH constraint fired — this table could, now or in
  -- the future, carry other unique or exclusion constraints, and a bare
  -- "WHEN unique_violation" would misclassify a violation of any of them
  -- as this specific idempotency replay. GET STACKED DIAGNOSTICS reads
  -- the ACTUAL constraint name PostgreSQL attached to the error, and only
  -- an EXACT match against the one named constraint this handler exists
  -- for is translated. Anything else — a different constraint, entirely
  -- unanticipated — is re-raised with a bare `RAISE;`, which propagates
  -- the original exception completely unchanged: same SQLSTATE, same
  -- message, same diagnostic context, as if no handler existed at all.
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name = 'uq_co_offer_code' THEN
      -- Lost the race: a concurrent identical (or conflicting) call
      -- committed p_new_offer_code first. Re-run the same comparison
      -- against what actually landed, converging to the same graceful
      -- outcome the optimistic/post-lock checks above would give.
      SELECT id, request_fingerprint INTO v_existing
        FROM public.commercial_offers WHERE offer_code = p_new_offer_code;
      IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: offer_code % already exists with different parameters', p_new_offer_code
          USING ERRCODE = '22023';
      END IF;
      RETURN jsonb_build_object('offer_id', v_existing.id, 'offer_code', p_new_offer_code, 'replay', true);
    ELSE
      RAISE;
    END IF;
  WHEN exclusion_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name = 'excl_co_no_overlapping_purchasable_periods' THEN
      RAISE EXCEPTION 'OFFER_EFFECTIVE_PERIOD_CONFLICT: % overlaps an existing purchasable offer for this family', p_new_offer_code
        USING ERRCODE = '23P01';
    ELSE
      RAISE;
    END IF;
END;
$$;
```

**No `WHEN OTHERS`, no generic SQLSTATE-only translation, no message-text parsing, no substring matching, no silent fallback, no catch-and-return-null anywhere in this function.** Exactly two condition NAMES are caught (`unique_violation`, `exclusion_violation`); within each, exactly one exact constraint-name string is recognized and translated; every other outcome — a different constraint, a future constraint this design doesn't yet know about, a genuine bug — hits the `ELSE RAISE;` branch and propagates with its real `SQLSTATE`, message, and stacked diagnostic context fully intact, as if this function had no exception handler at all.

**Why `INVALID_EFFECTIVE_BOUNDARY` is an addition, not a mismapping of one of Codex's three named codes:** `OLD_OFFER_NOT_FOUND` and `OLD_OFFER_NOT_SUPERSEDABLE` both describe the predecessor's own *state*; `OFFER_FAMILY_MISMATCH` describes a mismatch between predecessor and successor *identity*. A degenerate boundary (`p_effective_start <= v_old.effective_start`) is neither — the predecessor exists, is eligible, and is in the correct family; the request's *temporal* shape alone is invalid. Reusing `OFFER_FAMILY_MISMATCH` for this would make that code ambiguous between two unrelated failure classes, which the Error Code Reference's own design principle (one code, one unambiguous cause) forbids. This code is registered in full below alongside the other three.

**Step 20 — proof that every failure rolls back both predecessor closure and successor creation, restated precisely for this corrected body:** every `RAISE EXCEPTION` in this function (steps 9, 11-12, 13-14, 15, and both `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` branches) executes *before* the predecessor `UPDATE` (step 16) is ever reached, so there is nothing to roll back in those cases — they simply never mutate anything. The two cases that *can* fire after the predecessor `UPDATE` has already run in this same invocation are the two `EXCEPTION` handlers (`unique_violation`, `exclusion_violation`), both triggered by the successor `INSERT` (step 16, second half) or its own `commercial_catalog_audit_events` write. PL/pgSQL's `EXCEPTION` block is implemented via an implicit `SAVEPOINT`: catching either condition first **rolls back to that savepoint**, undoing the predecessor's `UPDATE` along with everything else this invocation did, and only then does the handler run. There is no code path in this function where the predecessor is left closed while the successor failed to appear, or vice versa — the two are atomic as a pair, in both the uncaught-error case (the whole transaction aborts) and the caught-and-translated case (the savepoint rollback undoes the partial work before the translated error is raised).

**Test B's locking requirement, walked through explicitly:** two independent connections both call this RPC targeting the *same* `p_old_offer_code`. Both pass steps 1-6 (neither's `p_new_offer_code` exists yet). Both reach step 8's `SELECT ... FOR UPDATE`. PostgreSQL grants the lock to whichever transaction arrives first; the second **blocks** — it does not proceed, does not error, does not see a stale/incorrect row — until the first transaction commits or rolls back. If the first commits (closing the predecessor and creating its successor), the second's lock acquisition then unblocks and it re-reads `v_old` fresh (its `SELECT ... FOR UPDATE` sees the committed state, per standard MVCC-plus-locking semantics), finding `effective_end IS NOT NULL` — step 10's post-lock recheck runs first, so if the second request is a genuine identical retry (same `p_new_offer_code`, same fingerprint) it gets the graceful replay result; if it is a *different* request (a different admin, or the same admin with different parameters) it correctly hits `OLD_OFFER_NOT_SUPERSEDABLE` at step 11-12 — a real business conflict, reported as such, never silently merged or silently duplicated.

`admin_upsert_commercial_offer` is unaffected by any of the locking/fingerprint/replay machinery above — it remains the RPC for non-succession edits (a brand-new, unrelated family; a pure lifecycle toggle) and does not gain any of it, which the mission scoped to *supersession* specifically. This scoping is a deliberate, stated choice, not an oversight: `admin_upsert_commercial_offer`'s own shape (an unconditional `SELECT`-then-`UPDATE`-or-`INSERT` on the *same* offer_code, never touching a *different* predecessor row) has no predecessor-locking problem to solve in the first place, and retrofitting supersession-grade machinery onto it would protect against a race that RPC cannot create. It **does**, however, get the identical constraint-specific `GET STACKED DIAGNOSTICS` correction as `admin_supersede_commercial_offer` for the one exception it does handle — see point 8's exact snippet.

---

## F. Commercial Market Authority

### F.1 The gap, precisely

Confirmed (again, independently, in this pass): `billing_customers` has exactly three columns — `id`, `owner_user_id`, `product_id`. **No market column exists anywhere for a customer or workspace.** The only "market" concept in the entire schema is `commercial_offers.market_code` — a property of a *price point*, not a property of a *customer*.

### F.2 Chosen model: **billing-customer-level explicit market**

Add `billing_customers.commercial_market TEXT NULL CHECK (commercial_market IN ('GLOBAL','TZ','MU','GB','EU'))`.

**Why this anchor and not the alternatives:**
- **Not workspace/company-level.** A `companies` row is an *accounting entity* — its jurisdiction (`statutory_rules.jurisdiction`, TRA/TIN) governs tax computation, not commercial pricing. Anchoring market there would directly violate the mission's core invariant ("commercial market != accounting jurisdiction") by construction, since `companies` *is* the accounting-jurisdiction table.
- **Not account/TIN-derived.** Same reason, stronger — TIN is a TRA identifier, has nothing to do with which SAFF commercial offer a firm buys under.
- **`billing_customers` is exactly the right anchor** because it is *already* SAFF's own commercial identity table (Ω1's own doc comment: "commercial identity, one row per company-owning auth user... explicitly separate from firm_members"), 1:1 with the auth user, and completely orthogonal to how many accounting-workspace companies that same user manages. A firm with clients in five countries still buys **one** SAFF firm licence, under **one** commercial market — exactly matching the existing `PRICING_TABLE` copy ("unlimited companies, unlimited periods" under one licence). This resolves the "multinational/multi-entity customer" question cleanly: multi-entity accounting practice ≠ multi-market commercial relationship.

### F.3 Who sets it, when, and how it changes

- **Set by:** the customer, explicitly, via a new RPC `set_billing_customer_market(p_market_code TEXT, p_reason TEXT DEFAULT NULL)` — `SECURITY DEFINER`, callable by `authenticated`, writes only the caller's own `billing_customers` row (`WHERE owner_user_id = auth.uid()`), or by a `commercial_admin` on a customer's behalf (support case) via a sibling admin RPC — both paths write a `billing_audit_events` row (`action = 'MARKET_ASSIGNED'` first time, `'MARKET_CHANGED'` thereafter).
- **When:** lazily, the first time it matters — either an explicit "Select your market" step surfaced in Settings/`/pricing` before first checkout, or inline at the moment `CheckoutUpgradeButton` is clicked with no market yet assigned (see F.4). **Never defaulted silently.** A `NULL` market is a first-class, valid, fail-closed state, not an error to paper over.
- **Can it change:** yes, at any time, by the same RPC. Changing market **never** retroactively touches an existing licence or past `payment_events`/`payment_checkout_intents` rows — those already snapshot their own economics immutably (unchanged Ω2 invariant). A market change only affects which offer a *future* checkout resolves against.

### F.4 Checkout can never be tricked into a different market than what was authorized

This is the concrete hostile-test target ("customer cannot alter market after offer authorization"). New rule in `commercial-create-checkout`:

1. Load `billing_customers.commercial_market` for the authenticated user.
2. If `NULL` **and** the request body supplies an explicit `marketCode`: treat this as the customer's **first-time assignment** — call `set_billing_customer_market` transactionally as part of the same request, then proceed using that value. (This keeps the existing Ω2 "browser may suggest a market" contract meaningful for the *only* case where a suggestion is legitimate: nothing has been decided yet.)
3. If `NULL` and no `marketCode` supplied: return `409 { error: 'MARKET_NOT_SET' }` — UI prompts explicit selection, never guesses.
4. If **already set** and the request's `marketCode` (if present) does not exactly equal the stored value: return `400 { error: 'MARKET_MISMATCH' }` — **fail closed, no silent override, no silent ignore-and-proceed-with-stored-value either**, forcing any real market change through the explicit, audited `set_billing_customer_market` path rather than a checkout-time side channel.
5. If already set and `marketCode` matches (or is omitted): proceed exactly as today, using the stored value as `p_market_code` into `resolve_commercial_offer`.

`resolve_commercial_offer` itself is **unchanged** — it remains a pure `(plan, market) -> offer` function with no customer awareness, correctly reusable by the public `/pricing` page (§H) where no customer identity exists yet at all.

### F.5 Fail-closed for UNKNOWN market

Already true today (`resolve_commercial_offer` returns `UNKNOWN` for any market outside the closed enum) and unaffected by this design — `commercial_market` is CHECK-constrained to the identical enum, so an "unknown" market can never even be stored.

---

## G. Currency / Money Iron Dome

### G.1 The gap, precisely

Confirmed: `commercial_offers.currency_exponent` has only a generic `BETWEEN 0 AND 4` CHECK — **no DB-level link from a currency code to its one true exponent exists**. `admin_upsert_commercial_offer` validates neither. The only canonical currency→exponent map (`TZS:0, USD:2, KES:2, UGX:0, GBP:2, EUR:2`) lives in **application code only** (`_shared/payments/money.ts` and its frontend mirror) — meaning `currency_code = 'TZS', currency_exponent = 2` is a schema-legal row today, exactly the incident class described (whether or not the specific ID exists in-repo).

### G.2 Design

**A dedicated registry table**, made the single source of truth the two existing TypeScript copies already agree on but the database does not enforce:

```sql
CREATE TABLE public.commercial_currencies (
  code           TEXT        NOT NULL,
  exponent       SMALLINT    NOT NULL,
  is_supported   BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT commercial_currencies_pk PRIMARY KEY (code),
  CONSTRAINT chk_cc_code_length CHECK (char_length(code) = 3),
  CONSTRAINT chk_cc_exponent_range CHECK (exponent BETWEEN 0 AND 4)
);
```
**Named constraints on this new table, exactly 3** (per Finding 3's requirement to count constraints on new tables separately from constraints added to existing tables): `commercial_currencies_pk` (PRIMARY KEY), `chk_cc_code_length` (CHECK), `chk_cc_exponent_range` (CHECK) — every constraint is named explicitly, matching this schema's own established convention (`commercial_offers`'s `chk_co_*` naming), not left as anonymous, auto-generated names.

Seeded with exactly the six rows already agreed on by both TypeScript copies: `TZS/0, USD/2, KES/2, UGX/0, GBP/2, EUR/2`. Public `SELECT` (same pattern as `commercial_products`/`commercial_plans`) so the admin UI and a future pricing page can read it without a bespoke RPC — full RLS/GRANT specification in §Q's privilege matrix.

**One trigger, defined once, enforces both this rule and §E.1's offer-economics-immutability rule — not two separate mechanisms, and not duplicated into the RPC.** Attaching it to the table (not to any one caller) is what makes it provable rather than merely asserted: every write to `commercial_offers` — today's `admin_upsert_commercial_offer`, any future admin RPC, a maintenance script, a `service_role` hand-edit — passes through this exact function, with no second copy of either rule anywhere else to drift out of sync.

```sql
CREATE OR REPLACE FUNCTION public.commercial_offers_economic_integrity()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_registry_exponent SMALLINT;
BEGIN
  -- Rule 1 (§G): currency/exponent must match the registry — on every INSERT and UPDATE.
  SELECT exponent INTO v_registry_exponent
    FROM public.commercial_currencies
   WHERE code = NEW.currency_code AND is_supported;

  IF v_registry_exponent IS NULL THEN
    RAISE EXCEPTION 'CURRENCY_NOT_SUPPORTED: %', NEW.currency_code USING ERRCODE = '22023';
  END IF;

  IF NEW.currency_exponent != v_registry_exponent THEN
    RAISE EXCEPTION 'CURRENCY_EXPONENT_MISMATCH: currency % requires exponent %, got %',
      NEW.currency_code, v_registry_exponent, NEW.currency_exponent USING ERRCODE = '22023';
  END IF;

  -- Rule 2 (§E.1): economics are immutable once a row exists. Lifecycle fields
  -- (is_active, is_purchasable, effective_end) are deliberately excluded —
  -- pausing/retiring/closing a window is not a price change.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.currency_code           IS DISTINCT FROM OLD.currency_code
    OR NEW.amount_minor            IS DISTINCT FROM OLD.amount_minor
    OR NEW.currency_exponent       IS DISTINCT FROM OLD.currency_exponent
    OR NEW.billing_interval        IS DISTINCT FROM OLD.billing_interval
    OR NEW.billing_interval_count  IS DISTINCT FROM OLD.billing_interval_count
    OR NEW.plan_id                 IS DISTINCT FROM OLD.plan_id
    OR NEW.market_code             IS DISTINCT FROM OLD.market_code
    THEN
      RAISE EXCEPTION 'OFFER_ECONOMICS_IMMUTABLE: create a new offer_code instead of mutating %',
        OLD.offer_code USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_commercial_offers_economic_integrity
  BEFORE INSERT OR UPDATE ON public.commercial_offers
  FOR EACH ROW EXECUTE FUNCTION public.commercial_offers_economic_integrity();
```

**`admin_upsert_commercial_offer`'s own body requires zero changes for these two rules.** It already issues one `INSERT` (new `offer_code`) or one `UPDATE ... SET currency_code = p_currency_code, amount_minor = p_amount_minor, ...` (existing `offer_code`, including the existing purchasable-toggle action, which resubmits every field unchanged except `is_purchasable`) — the trigger fires transparently underneath both statements. A same-value resubmission (the toggle case) trips no `IS DISTINCT FROM` comparison and succeeds exactly as before; a genuine attempt to change price/currency/interval on an existing code now fails, unconditionally, for every caller. (§E.2 adds one small, separate, narrow exception-handling addition to this same RPC body — for a different constraint entirely, the effective-period exclusion — which does not reopen or contradict this statement.)

**Scope boundary, stated explicitly so this trigger is never mistaken for a concurrency guarantee it does not provide:** `commercial_offers_economic_integrity()` enforces **exactly two things and no more** — currency/exponent registry match, and immutability of an existing row's own economic fields. It has **no visibility into other rows** and makes **no claim whatsoever** about whether two *different* offer rows have overlapping effective periods, and it does **not** maintain the `effective_history_protected` ratchet either — that is a third, single-row, but conceptually distinct bookkeeping concern with its own dedicated trigger (§E.2, point 6b), kept separate so this function's own name and scope stay literally true. Cross-row overlap is a materially different problem again (it requires reasoning about concurrent transactions each writing a *different* row, not one transaction validating the *one* row it's writing) and is solved by an independent database invariant — a PostgreSQL exclusion constraint, proven safe under concurrency by the same mechanism this exact schema already relies on for `commercial_licences` — specified in full in §E.2. **Three trigger functions in total touch `commercial_offers` after this design: this one, the ratchet (§E.2 point 6b), and zero others** — no fourth mechanism, no overlap logic hiding inside either trigger.

**One pre-existing race, out of this review's scope, registered honestly rather than silently left ambiguous:** `admin_upsert_commercial_offer`'s own `SELECT id INTO v_offer_id ... IF v_offer_id IS NOT NULL THEN UPDATE ... ELSE INSERT ...` shape (unchanged by this design, confirmed directly against the live Ω2 migration, lines 220–247) has its own latent check-then-act race for two concurrent calls creating the *same new* `offer_code` — a genuine, pre-existing Ω2 property, not introduced by this design, and not the subject of mission item #4 (which scopes idempotency specifically to *supersession*, i.e. `admin_supersede_commercial_offer`). Closing it would mean either adding the same fingerprint/replay machinery here too, or accepting that a losing concurrent caller sees a raw `unique_violation` — a real, separate design decision this document does not make on the mission's behalf.

**Admin UI consequence (§D):** currency becomes a `<Select>` populated from `commercial_currencies`; the exponent field becomes read-only, auto-filled from the selected currency's registry row; and economic fields on an *existing* `offer_code` render read-only in the form entirely (not merely validated on submit) — the UI reflects a rule the backend enforces unconditionally, it does not duplicate the enforcement itself.

**Gate B is unweakened.** `authoriseCommit`/`verifyTransaction`'s exact-bigint comparison against the checkout intent's own snapshot is untouched by this design — the registry only prevents a *bad offer* from ever being created; it says nothing about, and does not need to say anything about, how a *good* offer's payment is verified.

**`payment_checkout_intents.currency_exponent`** remains a plain copy with no independent CHECK, which is fine: by the time an intent is created, `resolve_commercial_offer` has already read a row that the trigger guaranteed was valid at write time.

---

## H. Public Pricing Experience

### H.1 New route: `/pricing`

- Added to `App.tsx` alongside the existing routes; unguarded (public), same as `/terms`/`/privacy`.
- Backed by one new, purpose-built RPC: `list_public_offers(p_market_code TEXT DEFAULT 'GLOBAL')` — `STABLE`, granted to `anon, authenticated` (same grant shape as `resolve_commercial_offer`), returning `{plan_code, plan_name, feature_codes, offer_code, currency_code, amount_minor, currency_exponent, billing_interval, billing_interval_count}[]` for every currently-purchasable offer in that market. This replaces ad-hoc client-side joins against the `anon`-granted tables with one hardened, purpose-built, testable contract — the same "single cast boundary" discipline already used for `resolve_commercial_offer` et al.
- **Market selector is an explicit UI toggle** (`GLOBAL`/`TZ`/`MU`/`GB`/`EU` — the same closed vocabulary everywhere else), defaulting to `GLOBAL` with neutral copy ("Not sure? GLOBAL pricing applies everywhere we don't yet have a local price."). **Never** derived from IP/`Accept-Language`/browser locale.
- FREE plan is rendered from `commercial_plans` directly (no offer needed — FREE is priceless by construction, matching the existing Ω1 auto-provision behavior).
- `NOT_AVAILABLE` plan/market combinations are shown as "Contact us" rather than silently hidden — honest, not fabricated.
- Multiple billing intervals for the same plan/market render as a toggle (ANNUAL/MONTHLY), reusing `intervalLabelFor` logic already proven in `CheckoutUpgradeButton.tsx`.
- No internal jargon (`market_code`, `amount_minor`, `currency_exponent`, provider names) ever reaches this page's copy — it renders `moneyToDisplay()`'s already-correct human string and plain-English interval/plan names only.
- **Unauthenticated visitor path:** may freely view `/pricing`'s catalogue metadata (no value at stake — it's the same data `anon` can already read today). The CTA on a paid plan routes to `/auth` first (mirrors the existing `PRICING_SECTION.ctaHref` pattern), and only an authenticated session ever reaches `CheckoutUpgradeButton`/`commercial-create-checkout`.

---

## I. Settings / Billing

Extending the existing Plan & Billing card (not a full Settings rebuild — matching the mission's explicit "not necessarily full visual global Settings reconstruction yet"):

**Added:**
- **Region/Market row**: displays `billing_customers.commercial_market` (or "Not set — choose your market" prompt if `NULL`), with a "Change market" action calling `set_billing_customer_market` (§F).
- **Payment history**: new owner-scoped RPC `list_my_payment_events(p_cursor?, p_limit?)`, called via the **anon-key + forwarded-JWT** pattern (learned directly from the Ω2 auth-contract repair — never a service-role client for anything gated by `auth.uid()`).
- **Receipt/evidence link** per payment row, routing to `/billing/receipts/:saffReference` (§J).
- **Manage/cancel/renew**: for Ω3, self-service **cancel** is deferred (a customer-initiated `cancel_my_licence_renewal` RPC is a small, well-scoped Ω3.5-or-later addition, not required for launch) — the existing "Contact support to change or renew" string is **kept, narrowly**, only for the already-on-this-plan case, which is legitimate (there is genuinely no self-service action to offer there yet). It is **not** the default/primary commercial path today — the upgrade button already handles that — so the mission's instruction to stop using it as *the* default path is already satisfied by the Ω2 work; Ω3 just needs to avoid regressing that.

**Explicitly not mixed into Plan & Billing (unchanged, re-affirmed):** TRA/TIN, accounting jurisdiction, professional/workspace roles. These remain entirely in `CompanyManager`/`FirmManagementPanel`, untouched by this design.

---

## J. Payment Receipt Architecture

Three explicitly separate concepts, named precisely so they are never conflated in copy or code:

1. **Provider receipt** — whatever Flutterwave itself emails/shows the payer. SAFF has no control over its content and makes no claim about it.
2. **SAFF payment evidence** (new, Ω3) — a new owner-scoped, immutable-derived view via `get_my_payment_receipt(p_saff_reference TEXT)`, joining `payment_events` + `payment_checkout_intents` + `commercial_offers`/`commercial_plans`, returning exactly: SAFF reference, customer (display name/email), offer/plan, amount + currency (human-formatted via `moneyToDisplay`), transaction time, provider, provider transaction id, licence period (`effective_start`/`effective_end`), status. Rendered at a new route `/billing/receipts/:saffReference` (and a list view `/billing/receipts`). This is **evidence of a SAFF transaction**, not a tax document.
3. **Statutory tax invoice / fiscal receipt** — **out of Ω3 scope entirely**, registered as `ARCHITECTURAL_FUTURE` (§P). If Tanzanian law requires SAFF itself (as a seller of software licences) to issue TRA-compliant fiscal receipts for its own revenue, that is a genuinely separate EFD/TRA-integration project for SAFF's own sales — unrelated to KINGA (which computes *customers'* tax, not SAFF's own). Copy on the new receipt page must say so explicitly ("This is not a tax invoice") to prevent exactly the mislabeling the mission warns against.

---

## K. Flutterwave Live Gate

### K.1 Two orthogonal switches (a genuine architectural finding from this pass)

Direct inspection found `FLUTTERWAVE_ENVIRONMENT` is read **exactly once** (`routing.ts`), stored on a capabilities object, and **never consulted by any branch of logic anywhere downstream** — `selectPaymentProvider()` filters only on currency/market/provider-restriction. The *real* sandbox/live switch today is entirely which `FLUTTERWAVE_SECRET_KEY` (`sk_test_...` vs `sk_live_...`) is deployed. This means today there is **no product-level gate at all distinct from the infra-level secret choice** — exactly the ambiguity the mission worries about ("test and live credentials must never coexist ambiguously").

### K.2 Design: a new, DB-authoritative state machine, orthogonal to the secret key

```sql
CREATE TABLE public.commercial_platform_state (
  id          BOOLEAN     NOT NULL DEFAULT true,  -- singleton row pattern
  state       TEXT        NOT NULL DEFAULT 'PAYMENTS_DISABLED',
  updated_by  UUID        NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason      TEXT        NULL,

  CONSTRAINT commercial_platform_state_pk PRIMARY KEY (id),
  CONSTRAINT chk_cps_singleton CHECK (id),
  CONSTRAINT chk_cps_state_vocabulary CHECK (state IN ('PAYMENTS_DISABLED','SANDBOX_ONLY','LIVE_ACCEPTANCE','CUSTOMER_PAYMENTS_ENABLED')),
  CONSTRAINT fk_cps_updated_by FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL
);
```
**Named constraints on this new table, exactly 4:** `commercial_platform_state_pk` (PRIMARY KEY), `chk_cps_singleton` (CHECK — the `id BOOLEAN` + `CHECK (id)` pattern is what enforces "exactly one row can ever exist," since `id` can only ever be `true`, and the PK forbids a second row with the same `true` value), `chk_cps_state_vocabulary` (CHECK), `fk_cps_updated_by` (FOREIGN KEY).

`admin_transition_platform_state(p_new_state TEXT, p_reason TEXT)` — `is_commercial_admin()`-gated, audited (`commercial_catalog_audit_events`, `entity_type='ADMIN'`). Full privilege specification in §Q's privilege matrix.

`commercial-create-checkout` reads this row first, before anything else:
- `PAYMENTS_DISABLED` → `503 { error: 'PAYMENTS_DISABLED' }` for **everyone**, no exceptions — matches the current real-world state exactly.
- `SANDBOX_ONLY` → checkout proceeds normally, but the function additionally asserts `FLUTTERWAVE_ENVIRONMENT !== 'production'` (or, more robustly, that the configured secret key does not start with `sk_live_` — a direct string check, since `FLUTTERWAVE_ENVIRONMENT` itself is provably inert today); refuses with `500 { error: 'SANDBOX_STATE_BUT_LIVE_KEY_CONFIGURED' }` if it detects a live key while the platform claims sandbox-only — this is the concrete mechanism that makes "test and live credentials must never coexist ambiguously" a checked invariant, not a policy.
- `LIVE_ACCEPTANCE` → checkout proceeds **only if the caller is `is_commercial_admin()`** — i.e., only the founder/an admin can transact; everyone else gets the same `503` as `PAYMENTS_DISABLED`. Also asserts a live key **is** configured (inverse of the sandbox check).
- `CUSTOMER_PAYMENTS_ENABLED` → checkout proceeds for any authenticated customer, live key asserted.

**Mandatory gates before transitioning to `LIVE_ACCEPTANCE`** (checked by the admin RPC itself, not just documented): founder-approved offers exist and are `is_purchasable`; a live `FLUTTERWAVE_SECRET_KEY`/`FLUTTERWAVE_WEBHOOK_SECRET` pair is configured; `/pricing` is live; production SMTP is configured (§P — this one can only be confirmed operationally, the RPC can't verify it, so it stays a documented pre-condition, not a checkable one); Terms/Privacy professionally reviewed (same — documented precondition); merchant KYC ready (documented); settlement destination configured (documented); observability ready (documented). The RPC enforces what's *mechanically checkable* (offers exist + are purchasable, live key configured) and the launch runbook enforces the rest.

**Secrets:** never touched by this design — they remain Supabase Edge Function secrets, never in a migration, never in the repo, exactly as today.

---

## L. First Real-Money Acceptance

Exactly the flow the mission specifies, now mechanically enforced by §K's state machine rather than a manual promise:

1. Admin transitions `commercial_platform_state` to `LIVE_ACCEPTANCE` (asserts live key configured + at least one purchasable offer exists).
2. Founder (already `is_commercial_admin()`, so the only caller `commercial-create-checkout` will accept in this state) completes one real checkout against one approved real offer.
3. Flutterwave LIVE → Gate A → Gate B → `commit_verified_commercial_payment` → licence → entitlement → SAFF payment evidence (§J) → redirect → Settings shows the new plan → founder manually and separately observes settlement in the Flutterwave dashboard (never queried by SAFF itself — confirmed no settlement table/column exists, and none is added by this design).
4. Only after the founder is satisfied does a **separate, deliberate** admin action transition the state to `CUSTOMER_PAYMENTS_ENABLED`. This is never automatic — no code path watches for "first payment succeeded" and flips the switch itself, precisely so a human judgment call remains in the loop.

**Settlement observation is structurally incapable of being the entitlement authority** in this design, because no code path anywhere reads settlement state to decide anything — the invariant already holds today and this design adds nothing that could weaken it.

---

## M. Refunds / Reversals / Chargebacks

`record_payment_reversal` (§A.2) is production-correct and complete but **uncalled**. Minimal Ω3 wiring (small, additive, not required for launch but cheap and architecturally clean to include):

In `commercial-payment-webhook`, when `normalizeWebhook()` yields `normalizedStatus IN ('REFUNDED','PARTIALLY_REFUNDED')` **and** the matched `payment_checkout_intents` row's status is already `SUCCEEDED` (i.e., this is a refund arriving *after* a prior successful commit, not instead of one), call `record_payment_reversal` with the original `payment_events.id`, rather than letting it fall through to the generic `authoriseCommit` → `NON_SUCCESS` → `VERIFICATION_FAILED` path (which today would just misfile a real refund as a verification failure).

`record_payment_reversal`'s own design is preserved exactly as-is: **never** auto-mutates a licence (`licence_action: 'REVIEW_REQUIRED'`), always requires a human admin follow-up via the existing `admin_transition_licence_status`. Original successful payment evidence is **never deleted** — the reversal is a new, separate, append-only `payment_events` row referencing the original by id.

A customer-facing "request a refund" self-service flow is **not** built in Ω3 (matches the mission's "not necessarily... unless required for launch") — the architecture is proven not to make it impossible (the RPC + webhook branch above are the whole mechanism; a future self-service request would just create an admin-review queue entry, not bypass `REVIEW_REQUIRED`).

---

## N. Observability / Operations

**Finding: most of the required lifecycle telemetry already exists as durable, queryable rows** — the gap is a dashboard to read them, not new event capture:

| Required event | Already captured by |
|---|---|
| checkout created | `payment_checkout_intents` INSERT (`status='CREATED'`, timestamped) |
| provider redirect | `payment_checkout_intents` UPDATE → `status='PENDING'` |
| webhook receipt | `payment_webhook_receipts` INSERT (immutable, always written even on failure) |
| signature result | `payment_webhook_processing_events.processing_result = 'INVALID_SIGNATURE'` |
| provider verification result | `processing_result IN ('AMOUNT_MISMATCH','CURRENCY_MISMATCH','REFERENCE_MISMATCH','REFERENCE_MISSING','VERIFICATION_FAILED')` |
| payment commit | `processing_result IN ('PROCESSED','REPLAY')` |
| licence transition | `billing_audit_events.action IN ('LICENCE_GRANTED','LICENCE_STATUS_TRANSITIONED')` |
| entitlement transition | `billing_audit_events.action IN ('ENTITLEMENT_OVERRIDE_GRANTED','ENTITLEMENT_OVERRIDE_REVOKED')` — **gap noted**: a *plan-driven* entitlement change (i.e., simply having a new ACTIVE licence) is not separately audited as an "entitlement transition," only manual overrides are. Acceptable for Ω3 (the licence transition row already implies it) but worth a future dedicated event if entitlement debugging ever needs it. |
| replay/idempotency | `processing_result = 'REPLAY'`, `commit_verified_commercial_payment`'s own idempotency-key check |
| refund/reversal | `billing_audit_events.action = 'REVERSAL_REQUIRES_REVIEW'` (once §M is wired) |
| failed payment | `payment_checkout_intents.status='FAILED'`, `processing_result` failure codes |

**Ω3 deliverable is therefore the Admin UI's Audit tab (§D)** — a read surface over data that already exists — not a new event pipeline. `correlationId` is already threaded per-request through every commercial Edge Function and logged (never a secret). **External APM/Sentry wiring remains exactly what CLAUDE.md §9.2 already defers** (`OBSERVABILITY_PROVIDER_WIRING_DEFERRED_TO_Ω2/PRE-GO-LIVE`) — Ω3 does not expand that gate, it just gives the founder a first-party dashboard over first-party data in the meantime.

---

## O. Global Product Shell Interface — Registered Debt

| Item | Finding | Disposition |
|---|---|---|
| SALIO identity leakage in SAFF profile | **Searched exhaustively — zero matches anywhere in `src/`.** | Not currently present. No action needed; removed from the active debt list (was likely already cleaned up in an earlier pass). |
| TRA/TIN exposed as universal Settings concept | **Confirmed present** — `CompanyManager.tsx`/`FirmManagementPanel.tsx`, both rendered at the global (non-workspace) `/settings` route. | `GLOBAL_PRODUCT_SHELL_RECONSTRUCTION` (future phase). Ω3 touches only the Plan & Billing card; these components are untouched. |
| Accounting-firm role language exposed globally | Same components as above. | `GLOBAL_PRODUCT_SHELL_RECONSTRUCTION`. |
| Tanzania-specific public landing wording | `PRICING_TABLE`'s "TRA query assistance" line, on the existing `#pricing` landing anchor. | `GLOBAL_PRODUCT_SHELL_RECONSTRUCTION` for the *existing* landing section. The **new** `/pricing` route (§H) is written jurisdiction-neutral from the start — it does not reuse `PRICING_TABLE`/`PRICING_SECTION` verbatim. |
| Legacy Plan & Billing UX ("Contact support to change or renew" as the default path) | Already superseded by the Ω2 upgrade button for the FREE→PAID path; the string only remains for the narrow same-plan case (§I), which is legitimate. | Ω3 scope (§I) — closed, not deferred. |

Ω3 does not touch `SAFISHA`/`HESABU`/`MAONO` or any certified accounting engine anywhere in this design — every file/table/RPC named above is exclusively in the `commercial-*`/`billing_*`/`payment_*`/`entitlement_*` namespace.

---

## P. SMTP / Legal / Security Debt Classification

| Item | Classification |
|---|---|
| `PRODUCTION_AUTH_SMTP_CONFIGURATION_REQUIRED` (CLAUDE.md §9.2) | **MUST_CLOSE_BEFORE_LIVE.** Cannot be closed from this repository (infra config); a hard precondition for `LIVE_ACCEPTANCE`/`CUSTOMER_PAYMENTS_ENABLED` (§K). |
| `LEGAL_PROFESSIONAL_REVIEW_REQUIRED_BEFORE_PAID_GO_LIVE` (CLAUDE.md §9.2) | **MUST_CLOSE_BEFORE_LIVE.** Same treatment — a documented precondition the state-machine RPC cannot itself verify. |
| "`COMMERCIAL_EDGE_ERROR_CORS_COMPLETENESS`" (non-auth 404/402/422/500/503 responses in `commercial-create-checkout` lacking CORS headers) — **real, verified condition; the literal ID does not exist in any repo file** | **MAY_CLOSE_AFTER_LAUNCH.** A real polish item (a browser-based error toast might render generically instead of with a clean message in some misconfigured-CORS edge case), but never a security or correctness defect — the auth path (the one CORS-sensitive path that actually gates access) is already fixed. Low severity, mechanical fix (reuse the `CORS_HEADERS` constant already introduced by the auth repair across the remaining response sites) — worth a dedicated 15-minute pass, not a launch blocker. |
| Currency/exponent preventative validation ("`DEFECT-OMEGA2-TZS-EXPONENT-AUTHORITY-001`" — same caveat, literal ID not found, condition real) | **MUST_CLOSE_BEFORE_LIVE.** This is §G in full — a real, currently-open, database-level gap that would let a future admin repeat the exact incident class. Must ship no later than Ω3.2, before any offer intended for real money is authored. |
| `MULTI_COMPANY_PREMIUM_POLICY_DEFERRED_TO_Ω2_PRODUCT_DECISION` (CLAUDE.md §9.2) | **ARCHITECTURAL_FUTURE** — unrelated to Ω3, unaffected by this design, still a pending product decision. |
| `OBSERVABILITY_PROVIDER_WIRING_DEFERRED_TO_Ω2/PRE-GO-LIVE` (CLAUDE.md §9.2) | **MAY_CLOSE_AFTER_LAUNCH** — §N shows the *data* is already there; wiring an external provider is a separate, deferrable pass. |

---

## Q. Migration Strategy

**Forward-only, non-data-destructive, transactional migration; one reviewable migration file per subphase. Not purely additive — two named DDL replacements are included (§Q's Category 3 and DDL-replacement accounting below) — but neither rewrites Ω1/RLS1/Ω2's own historical migration files, neither deletes any row, and each is transactionally reversible to its exact pre-migration definition on any failure. No blanket `db push`.**

**New columns (additive `ALTER TABLE ... ADD COLUMN`) — 4 total, up from 2 in the prior draft:**
- `billing_customers.commercial_market TEXT NULL CHECK (... IN closed enum)` — §F.
- `commercial_offers.effective_range TSTZRANGE GENERATED ALWAYS AS (tstzrange(effective_start, effective_end, '[)')) STORED` — §E.2. Same generated-column technique already live on `commercial_licences.effective_range`; derived from two pre-existing columns, adds no new writable data.
- `commercial_offers.effective_history_protected BOOLEAN NOT NULL DEFAULT false` — §E.2 point 6, the one-way ratchet correcting the prior draft's defective `is_purchasable`-only predicate.
- `commercial_offers.request_fingerprint TEXT NULL` — §E.2 point 13, the idempotency-payload fingerprint, populated only by `admin_supersede_commercial_offer`.

**New tables — 2, unchanged from the prior draft (the idempotency fix added a column, not a new table):**
- `commercial_currencies` — §G.
- `commercial_platform_state` — §K.

**Constraint and DDL-replacement inventory — corrected this pass (Findings 3 and 4). The prior draft reported `modified existing named constraints = 0`, filing `chk_ccae_entity_type`'s widening under a separate "Extended CHECK vocabulary" heading as if that made it something other than a modified constraint. It is a modified constraint, on a table that is not `commercial_offers`, and it belongs in this count. The three categories Finding 3 requires are kept strictly separate below — nothing is combined ambiguously.**

**Category 1 — constraints created on new tables: 7 total.** `commercial_currencies`: 3 (`commercial_currencies_pk`, `chk_cc_code_length`, `chk_cc_exponent_range` — full DDL in §G.2). `commercial_platform_state`: 4 (`commercial_platform_state_pk`, `chk_cps_singleton`, `chk_cps_state_vocabulary`, `fk_cps_updated_by` — full DDL in §K.2). These are not "new constraints on an existing table" (Category 2) — they exist only because their own tables exist, and would vanish if those tables were dropped.

**Category 2 — new constraints added to an existing table: 1.** `excl_co_no_overlapping_purchasable_periods` on `commercial_offers` (§E.2, point 9) — the 5-column-key exclusion constraint. `commercial_offers` carries **11** existing named constraints today (1 `PRIMARY KEY`, 1 `UNIQUE`, 1 `FOREIGN KEY`, 8 `CHECK`) — all 11 are preserved **byte-identical**; this design adds exactly 1 more, bringing that table's own total to 12.

**Category 3 — existing constraints replaced or modified: 1.** `chk_ccae_entity_type` on `commercial_catalog_audit_events`, widened from `('OFFER','PLAN')` to `('OFFER','PLAN','ADMIN','PRODUCT')` via `ALTER TABLE ... DROP CONSTRAINT chk_ccae_entity_type` + `ALTER TABLE ... ADD CONSTRAINT chk_ccae_entity_type CHECK (...)` (full statement and every writer of every value in §D.1). This is genuinely a modification of a pre-existing, named, live constraint — not additive in the same sense as Categories 1/2 — and is classified precisely as: **existing constraint replaced in a forward migration; vocabulary widened; no existing allowed value removed; no row deleted; preflight validation required (see below); transactionally replaced (single statement pair, same migration transaction as everything else in Ω3.0 — if anything later in the file fails, this replacement rolls back too, and the original 2-value constraint remains in force).**

**`MODIFIED_EXISTING_NAMED_CONSTRAINTS = 1`** (Category 3, `chk_ccae_entity_type`) — **not 0**, correcting the prior draft's reconciliation error precisely.

**DDL classification, corrected per Finding 4 — this design is not strictly additive/append-only, and describing it that way going forward would misstate it:**
```
DATA_DESTRUCTIVE_OPERATIONS = 0
DDL_REPLACEMENT_OPERATIONS  = 2
```
The two DDL replacements, named exactly: (1) `chk_ccae_entity_type` — `DROP CONSTRAINT` + `ADD CONSTRAINT`, described above. (2) `uq_co_current_offer` — `DROP INDEX` + `CREATE UNIQUE INDEX`, widened from `(plan_id, market_code, currency_code)` to the full 5-column family key (§E.2, point 1), so it no longer incorrectly treats a MONTHLY and an ANNUAL offer as the same family; `idx_co_plan_market`, `commercial_offers`'s other supporting index, is untouched. **Neither replacement deletes a single row of data** — both operate on schema objects (a CHECK constraint's allowed-value list; a unique index's key-column list), never on table contents. The correct description of this entire migration, replacing every prior draft's "purely additive"/"no DROP" framing, is: **forward-only, non-data-destructive, transactional schema replacement plus additive objects.**

**Proof obligations for each DDL replacement, per Finding 4:**
- **One transaction:** both replacements are plain `ALTER`/`DROP`/`CREATE` DDL statements inside the same Ω3.0 migration file, which Postgres/Supabase applies as a single transaction by default — no explicit transaction management needed for this property to hold.
- **Preflight before removal:** for `chk_ccae_entity_type`, no data-shape preflight is needed — widening a CHECK's allowed-value list can never invalidate an existing row (every row satisfying the old, narrower list still satisfies the new, wider one). For `uq_co_current_offer`, the relevant preflight is the SAME one §E.2 point 6a already performs for the exclusion constraint (Step D's five-dimensional conflict scan) — if that scan finds no conflicts, the wider unique index cannot be violated by any existing row either, since the exclusion constraint's protected set is a superset of what `uq_co_current_offer` alone would reject.
- **Recreation is immediate:** both `DROP`+`CREATE`/`DROP`+`ADD` pairs are adjacent statements in the same file — there is no window, even momentarily within the transaction, where the table is left with neither the old nor the new version of either object, because the replacing statement executes in the same transaction immediately after the dropping one, and until `COMMIT` no other transaction can observe the intermediate state at all (Postgres DDL is transactional; a concurrent reader sees either the pre-migration or post-migration schema, never a partial one).
- **Failure rolls back the complete migration:** unchanged from §E.2 point 6a's own analysis — any `RAISE EXCEPTION` anywhere in the file (including the fail-closed preflight blocks) aborts the entire transaction, restoring both `chk_ccae_entity_type` and `uq_co_current_offer` to their exact pre-migration definitions. No data is ever deleted by a failed attempt.
- **Uniqueness/integrity is not left unenforced after failure:** because the replacement is transactional, a rollback restores the ORIGINAL `uq_co_current_offer` (3-column key) and the ORIGINAL `chk_ccae_entity_type` (2-value list) — the table is never left with neither the old nor the new constraint installed.
- **Deployment locking implications, acknowledged rather than omitted:** `DROP INDEX`/`CREATE UNIQUE INDEX` (without `CONCURRENTLY`, which cannot be used inside a transaction block, and this design deliberately keeps the whole file in one transaction for the atomicity guarantees above) takes an `ACCESS EXCLUSIVE` lock on `commercial_offers` for the duration of the index rebuild; `ALTER TABLE ... DROP/ADD CONSTRAINT` on a small CHECK constraint takes a brief `ACCESS EXCLUSIVE` lock on `commercial_catalog_audit_events`. For tables of this project's current size (a catalog table, not a high-volume transactional one), this is expected to be a sub-second lock window; it is called out here explicitly as an operational consideration for whoever schedules the Ω3.0 migration's application window, not hidden behind "purely additive" language that would incorrectly suggest zero locking impact.

**New trigger functions + triggers — 2 pairs, deliberately kept separate:**
- `public.commercial_offers_economic_integrity()` + `trg_commercial_offers_economic_integrity` (`BEFORE INSERT OR UPDATE ON commercial_offers`) — enforces the currency/exponent registry match (§G) **and** the offer-economics-immutability rule (§E.1, now over all 5 family-identity columns) in the same function body. **Deliberately does not, and cannot, enforce effective-period non-overlap, and does not maintain the ratchet below** — see §G.2's scope-boundary statement.
- `public.commercial_offers_effective_history_ratchet()` + `trg_commercial_offers_effective_history_ratchet` (`BEFORE INSERT OR UPDATE ON commercial_offers`) — maintains `effective_history_protected` as a one-way, tamper-proof ratchet (§E.2 point 6b). Kept as its own trigger, not folded into the one above, specifically so that trigger's stated scope remains literally true.

**New exclusion constraint (independent database invariant, not a trigger — §E.2), key corrected this pass (Blocker 1) from 3 columns to 5:**
- `excl_co_no_overlapping_purchasable_periods` on `commercial_offers`, `EXCLUDE USING gist (plan_id WITH =, market_code WITH =, currency_code WITH =, billing_interval WITH =, billing_interval_count WITH =, effective_range WITH &&) WHERE (effective_history_protected)`. The **key** was corrected this pass — an earlier draft used only `(plan_id, market_code, currency_code)`, which would have incorrectly made every billing-interval variant of an offer mutually exclusive with every other (MONTHLY vs. ANNUAL, or MONTHLY×1 vs. MONTHLY×3), when they are independent, coexisting products, not versions of one another. The **predicate** was separately corrected twice in an earlier pass: first from `is_purchasable` alone (silently lost protection on retirement) to `is_active AND effective_history_protected` (still defective — `is_active` is *also* mutable and was an explicit, named escape hatch in that draft), and now to `effective_history_protected` alone, with no other mutable field of any kind in the predicate. Requires **no new extension** — `btree_gist` has been enabled since the live Ω1 migration (`20260905093408...:2`, directly re-confirmed in this review pass) specifically to support `commercial_licences`'s own, identically-shaped exclusion constraint.

**New functions (no schema changes, pure additions):** `set_billing_customer_market`, `admin_set_billing_customer_market`, `admin_grant_commercial_admin`, `admin_revoke_commercial_admin`, `admin_list_commercial_admins`, `admin_upsert_commercial_product`, `admin_upsert_commercial_plan`, `admin_list_billing_customers`, `admin_list_payment_events`, `admin_list_billing_audit_events`, `admin_list_catalog_audit_events`, `admin_transition_platform_state`, `list_public_offers`, `list_my_payment_events`, `get_my_payment_receipt`, `commercial_offers_economic_integrity()`, `commercial_offers_effective_history_ratchet()` (both trigger functions above), **`admin_supersede_commercial_offer`** (§E.2, point 13 — the atomic, idempotent retire-then-create RPC, fully specified with fingerprint/replay/mismatch logic in this correction pass).

**`admin_upsert_commercial_offer`'s function body — precisely what changes and what does not, stated once so it cannot be misread as contradictory again:**
- **Unchanged:** the currency/exponent and economics-immutability guards. Both are enforced entirely by the first trigger; this RPC needs no edit for either (§G.2). Also unchanged: no fingerprint/replay/idempotency-key machinery is added here — that is scoped to `admin_supersede_commercial_offer` only (§E.2 point 13's closing paragraph), and this RPC's own pre-existing, Ω2-original concurrent-insert race is registered, not silently fixed, in §G.2.
- **One narrow addition:** an exception handler catching `SQLSTATE 23P01` (`exclusion_violation`) on `excl_co_no_overlapping_purchasable_periods` specifically, re-raising it as `OFFER_EFFECTIVE_PERIOD_CONFLICT` (§E.2, point 8). This is a *different* constraint from the trigger's two rules, added for a *different* reason (a friendly domain error code instead of a raw PostgreSQL constraint-name error), and does not reopen the "zero changes" statement above. `admin_supersede_commercial_offer` carries the identical exclusion-violation handler, plus its own additional `unique_violation` handler for idempotent replay (§E.2, point 13) — the two RPCs' exception blocks are not identical to each other, only the exclusion-violation branch is shared.

**One required backfill / legacy-classification operation — 1, unchanged in count from the prior draft, but corrected in kind this pass (Finding 1) from an audit-trail-dependent condition to an unconditional, evidence-independent one.** The backfill is **not** keyed on `is_purchasable` (current or historical) and **not** keyed on any `commercial_catalog_audit_events` lookup — a condition of either kind resolves uncertain/incomplete historical evidence to the *permissive* (unprotected) state for at least some legacy row, which is exactly the class of defect this design closes. The actual, sole backfill statement, identical to the one already specified in full at §E.2 point 6a (Step B), is:

```sql
UPDATE public.commercial_offers SET effective_history_protected = true;
```

Every pre-existing row, unconditionally, with no `WHERE` clause of any kind. This is a one-time, same-migration statement that only ever flips `false → true` (matching the ratchet's own direction), touches no other column, and is the only backfill anywhere in this design. It is immediately followed, in the same migration transaction, by the two executable fail-closed preflight `DO` blocks specified in full at §E.2 point 6a (Step C: row-count completeness check; Step D: five-dimensional effective-range conflict scan) — either one aborts the entire Ω3.0 migration, via an uncaught `RAISE EXCEPTION`, before the exclusion constraint (or any other object in the file) is installed, if it detects a problem. No manual runbook verification query, and no dependency on audit-trail completeness of any kind, is required or relied upon — the classification is correct by construction, not by assumption. **No backfill is needed, or possible, for `request_fingerprint`** — it is `NULL`able and legitimately `NULL` for every pre-existing row (none of them were created via `admin_supersede_commercial_offer`, which does not exist yet); a `NULL` fingerprint simply means "not eligible for idempotent-replay comparison," which is correct for those rows.

**Exact idempotency mechanism, restated unambiguously (mission requirement #6 this pass — no room left for ambiguity):**
- **Idempotency-key column:** none new. The key **is** the existing `commercial_offers.offer_code` column.
- **Uniqueness constraint enforcing it:** none new. The existing `uq_co_offer_code UNIQUE (offer_code)` constraint, unchanged, is the entire database-level uniqueness boundary.
- **Scope:** table-global — identical scope to `uq_co_offer_code` itself (not per-admin, not per-family, not per-market). Two different admins, or the same admin twice, attempting to use the same `offer_code` collide with each other identically, which is the correct scope for a globally-unique catalog identifier.
- **Canonical payload fingerprint column:** one new column, `commercial_offers.request_fingerprint TEXT NULL`, populated only by `admin_supersede_commercial_offer`.
- **Fingerprint computation, exact and ordered:** `encode(digest(concat_ws('|', p_old_offer_code, p_plan_code, p_market_code, p_currency_code, p_amount_minor::TEXT, p_currency_exponent::TEXT, p_billing_interval, p_billing_interval_count::TEXT, p_effective_start::TEXT), 'sha256'), 'hex')` — exactly 9 parameters, in this fixed order, computed server-side via `pgcrypto`'s `digest()`. `p_new_offer_code` (the key itself) and `p_reason` (free-text metadata) are excluded by design — the key is not part of its own payload, and a differing justification for an otherwise-identical economic request is not a differing request.

**Exact new-RPC count, stated precisely per mission requirement #7 — not "~16":**

| # | RPC | Section |
|---|---|---|
| 1 | `set_billing_customer_market` | §F.3 |
| 2 | `admin_set_billing_customer_market` | §F.3 |
| 3 | `admin_grant_commercial_admin` | §C |
| 4 | `admin_revoke_commercial_admin` | §C |
| 5 | `admin_list_commercial_admins` | §D |
| 6 | `admin_upsert_commercial_product` | §D |
| 7 | `admin_upsert_commercial_plan` | §D/§E |
| 8 | `admin_list_billing_customers` | §D |
| 9 | `admin_list_payment_events` | §D |
| 10 | `admin_list_billing_audit_events` | §D |
| 11 | `admin_list_catalog_audit_events` | §D |
| 12 | `admin_transition_platform_state` | §K |
| 13 | `list_public_offers` | §H |
| 14 | `list_my_payment_events` | §I |
| 15 | `get_my_payment_receipt` | §J |
| 16 | `admin_supersede_commercial_offer` | §E.2 |

**Exactly 16 new, callable RPCs.** Not counted in this 16 (a deliberately separate category, since neither is granted to `authenticated` nor invoked via `supabase.rpc()`): the **2 new trigger functions** (`commercial_offers_economic_integrity`, `commercial_offers_effective_history_ratchet`) and the **1 modified existing RPC** (`admin_upsert_commercial_offer`, body-only, signature unchanged).

### Privilege Matrix — corrected this pass (Finding 4). This design does not rely on PostgreSQL's default function privileges for any of the 16 new RPCs — every one of them is explicitly `REVOKE`d from `PUBLIC` and from any role that must not call it, then explicitly `GRANT`ed only to the roles that must.

**Uniform properties across all 16 RPCs, stated once rather than repeated 16 times (all 16 are identical on these five axes):**
- **`SECURITY DEFINER`** — matching the established, universal convention of every existing commercial RPC in this schema (`resolve_commercial_offer`, `admin_upsert_commercial_offer`, `commit_verified_commercial_payment`, etc. — confirmed by direct inspection, none of them use `SECURITY INVOKER`). A deliberate consistency choice, not an oversight: introducing `SECURITY INVOKER` for a subset would mean two different privilege models coexisting in one schema for no functional benefit, since every one of these 16 RPCs needs to read/write tables the calling role (`authenticated`) has no direct table-level access to (RLS restricts `authenticated`'s own direct table access to owner-scoped rows at most; every RPC below reads or writes beyond that scope in at least one code path).
- **Owner:** the migration-applying role (`postgres` in a standard Supabase project) — matching every existing commercial function's own ownership, since function ownership defaults to whichever role executes the `CREATE FUNCTION` statement, and this migration is applied the same way every prior one was.
- **Fixed, safe `search_path`:** `SET search_path = public, pg_catalog` on every one of the 16 — the same clause already present on every existing `SECURITY DEFINER` function in this schema, preventing search-path-hijacking attacks against a definer-rights function.
- **`PUBLIC` EXECUTE:** `REVOKE ALL ON FUNCTION <exact signature> FROM PUBLIC;` on all 16, unconditionally.
- **`service_role`:** never explicitly revoked or re-granted by any of these 16 statements — `service_role` retains its platform-default ability to call any function in the `public` schema (the same default this schema's every existing function already relies on, confirmed structurally true since none of the existing `REVOKE`/`GRANT` pairs in the live migrations ever mention `service_role` either). No new behavior introduced here.

**Per-RPC matrix — `anon`, `authenticated`, internal authorization predicate, tables touched:**

| # | RPC (signature abbreviated) | `anon` EXECUTE | `authenticated` EXECUTE | Internal authorization predicate | Tables read | Tables written |
|---|---|---|---|---|---|---|
| 1 | `set_billing_customer_market(p_market_code, p_reason)` | REVOKED | GRANTED | `auth.uid() IS NOT NULL`; writes only the caller's own row (`WHERE owner_user_id = auth.uid()`) | `billing_customers` | `billing_customers`, `billing_audit_events` |
| 2 | `admin_set_billing_customer_market(p_owner_user_id, p_market_code, p_reason)` | REVOKED | GRANTED | `is_commercial_admin()` | `billing_customers` | `billing_customers`, `billing_audit_events` |
| 3 | `admin_grant_commercial_admin(p_user_id, p_reason)` | REVOKED | GRANTED | `is_commercial_admin()` (Tier 2, §C — requires an *existing* admin to grant a new one; the Tier-1 bootstrap is a separate Edge Function, not this RPC, and has no RLS/EXECUTE surface at all) | `commercial_admins` | `commercial_admins`, `commercial_catalog_audit_events` |
| 4 | `admin_revoke_commercial_admin(p_user_id, p_reason)` | REVOKED | GRANTED | `is_commercial_admin()` + sole-remaining-admin lockout guard (§C, Tier 3) | `commercial_admins` | `commercial_admins`, `commercial_catalog_audit_events` |
| 5 | `admin_list_commercial_admins(p_cursor, p_limit)` | REVOKED | GRANTED | `is_commercial_admin()` | `commercial_admins` | — (read-only) |
| 6 | `admin_upsert_commercial_product(p_code, p_name, p_reason)` | REVOKED | GRANTED | `is_commercial_admin()` (§D.1) | `commercial_products` | `commercial_products`, `commercial_catalog_audit_events` |
| 7 | `admin_upsert_commercial_plan(p_product_code, p_code, p_name, p_feature_codes, p_is_active, p_reason)` | REVOKED | GRANTED | `is_commercial_admin()` | `commercial_products`, `commercial_plans` | `commercial_plans`, `commercial_catalog_audit_events` |
| 8 | `admin_list_billing_customers(p_search, p_cursor, p_limit)` | REVOKED | GRANTED | `is_commercial_admin()` | `billing_customers` | — (read-only) |
| 9 | `admin_list_payment_events(p_billing_customer_id, p_cursor, p_limit)` | REVOKED | GRANTED | `is_commercial_admin()` | `payment_events` | — (read-only) |
| 10 | `admin_list_billing_audit_events(p_cursor, p_limit)` | REVOKED | GRANTED | `is_commercial_admin()` | `billing_audit_events` | — (read-only) |
| 11 | `admin_list_catalog_audit_events(p_cursor, p_limit)` | REVOKED | GRANTED | `is_commercial_admin()` | `commercial_catalog_audit_events` | — (read-only) |
| 12 | `admin_transition_platform_state(p_new_state, p_reason)` | REVOKED | GRANTED | `is_commercial_admin()` + (Ω3.7 addition) mechanical preconditions | `commercial_platform_state`, `commercial_offers` | `commercial_platform_state`, `commercial_catalog_audit_events` |
| 13 | `list_public_offers(p_market_code)` | **GRANTED** — the sole `anon`-callable RPC among the 16, by explicit design (§H: public, unauthenticated pricing catalogue, same intent as the already-`anon`-granted `resolve_commercial_offer`) | GRANTED | none — a pure, unauthenticated-safe catalogue read; no row is owner-scoped | `commercial_offers`, `commercial_plans` | — (read-only) |
| 14 | `list_my_payment_events(p_cursor, p_limit)` | REVOKED | GRANTED | `auth.uid() IS NOT NULL`; owner-scoped via `billing_customers.owner_user_id = auth.uid()` join — called via the anon-key+forwarded-JWT client pattern (§I), never service-role, so `auth.uid()` is genuinely the caller | `payment_events`, `billing_customers` | — (read-only) |
| 15 | `get_my_payment_receipt(p_saff_reference)` | REVOKED | GRANTED | `auth.uid() IS NOT NULL`; owner-scoped identically to #14 | `payment_events`, `payment_checkout_intents`, `commercial_offers`, `commercial_plans`, `billing_customers` | — (read-only) |
| 16 | `admin_supersede_commercial_offer(...)` | REVOKED | GRANTED | `is_commercial_admin()` (§E.2, point 13, step 1) | `commercial_plans`, `commercial_offers` | `commercial_offers`, `commercial_catalog_audit_events` |

**Why every administrative RPC still grants `authenticated` rather than revoking it too, and why this does not make them "publicly executable" (Finding 4's own explicit concern):** `authenticated` EXECUTE is necessary for the RPC to be *callable* by anyone at all through Supabase's PostgREST layer (an anonymous request never carries a JWT that resolves to `authenticated`, so it never reaches the function body in the first place once `anon` is revoked) — but being callable is not being *authorized*. Every administrative RPC's **first executable statement** is its `is_commercial_admin()` (or equivalent) check, which `RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN'`s for any non-admin caller before touching a single row. This is the exact, established pattern already used by every existing admin RPC in this schema (`admin_upsert_commercial_offer` is itself `GRANT EXECUTE ... TO authenticated` with an internal gate, not restricted at the GRANT level to some non-existent `commercial_admin` Postgres role — Postgres has no such role, `commercial_admins` is an application-level table, not a database role) — this design does not introduce a new privilege model, it applies the schema's own existing one consistently to 16 new functions.

**For every new RPC, the migration conceptually performs, in this order (matching Finding 4's own required sequence exactly):**
```sql
REVOKE ALL ON FUNCTION public.<name>(<signature>) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.<name>(<signature>) FROM anon;          -- except #13, list_public_offers
GRANT EXECUTE ON FUNCTION public.<name>(<signature>) TO authenticated;
GRANT EXECUTE ON FUNCTION public.<name>(<signature>) TO anon;         -- #13 only
```

**Table privilege accounting for both new tables — RLS policy, table grant, RPC execution grant, service-role bypass, and ownership kept as five explicitly distinct concerns, not conflated:**

| Concern | `commercial_currencies` | `commercial_platform_state` |
|---|---|---|
| **RLS policy** | `cc_select_public`, `FOR SELECT USING (true)` — 1 new policy | `cps_select_admin_only`, `FOR SELECT USING (is_commercial_admin())` — 1 new policy |
| **Table grant** | `REVOKE ALL FROM anon, authenticated` then `GRANT SELECT TO anon, authenticated` — no `authenticated`/`anon` write grant exists at all (no RPC ever needs to write this table; writes are migration/hand-authored-migration only) | `REVOKE ALL FROM anon, authenticated` then `GRANT SELECT TO authenticated` only (`anon` gets no grant at all — the platform state is not public data) |
| **RPC execution grant** | None — deliberately no `admin_upsert_commercial_currency` RPC exists (§D: controlled vocabulary, not admin-editable data) | `admin_transition_platform_state` is the sole write path (RPC #12 above) |
| **Service-role bypass** | `GRANT ALL TO service_role` (explicit, matching every other table's own pattern) — also has the platform-default bypass regardless | Same |
| **Ownership** | Table owner = migration-applying role, matching every existing table | Same |

**Exact counts, per Finding 4's explicit request — counted per object-role privilege edge (one `GRANT`/`REVOKE` of one privilege to one role on one object = one count), not per SQL statement, stated once and applied consistently throughout this reconciliation:**
```
function EXECUTE revokes:      16 RPCs × (PUBLIC + anon, except #13 which revokes only PUBLIC) = 31 edges
function EXECUTE grants:       16 RPCs × authenticated, + 1 (RPC #13) × anon               = 17 edges
table privilege revokes:        2 new tables × (anon + authenticated)                       = 4 edges
table privilege grants:         commercial_currencies: anon SELECT + authenticated SELECT + service_role ALL = 3 edges
                                 commercial_platform_state: authenticated SELECT + service_role ALL           = 2 edges
                                 (table grants subtotal = 5 edges)
new RLS policies:                2  (cc_select_public, cps_select_admin_only)
modified existing RLS policies:  0  (unchanged from the prior pass's own finding — RLS predicates reference only pre-existing columns; no existing policy's USING clause needs to change for any new column or table this design adds)
```

`commercial_currencies` — a public reference table, same treatment as `commercial_products`/`commercial_plans`:
```sql
ALTER TABLE public.commercial_currencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cc_select_public" ON public.commercial_currencies FOR SELECT USING (true);
REVOKE ALL ON public.commercial_currencies FROM anon, authenticated;
GRANT SELECT ON public.commercial_currencies TO anon, authenticated;
GRANT ALL    ON public.commercial_currencies TO service_role;
```
No `authenticated`-callable write path exists for this table at all — by design (§D: "a controlled vocabulary, not admin-editable data"), the only writers are the seed migration and, if a currency is ever added, a future hand-authored migration. There is deliberately no `admin_upsert_commercial_currency` RPC among the 16 above.

`commercial_platform_state` — admin-visible only, matching the existing `payment_webhook_receipts`/`payment_webhook_processing_events` admin-only-SELECT precedent, since the exact operational state string is not customer-facing data:
```sql
ALTER TABLE public.commercial_platform_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cps_select_admin_only" ON public.commercial_platform_state FOR SELECT USING (public.is_commercial_admin());
REVOKE ALL ON public.commercial_platform_state FROM anon, authenticated;
GRANT SELECT ON public.commercial_platform_state TO authenticated;
GRANT ALL    ON public.commercial_platform_state TO service_role;
```
No direct `UPDATE` grant to `authenticated` exists — the sole write path is `admin_transition_platform_state` (`SECURITY DEFINER`, its own internal `is_commercial_admin()` gate, `service_role` underneath). `commercial-create-checkout` reads this table via its own existing `service_role` client (already its pattern for every other table it touches), which bypasses RLS entirely regardless of the `SELECT` policy above — the policy only ever matters for a browser-originated `authenticated`/`anon` read, and none is ever intended.

**Zero RLS changes to any *existing* table or policy — justified, not merely asserted:** RLS policies are row-visibility predicates evaluated against a row's *existing* columns (e.g. `co_select_public FOR SELECT USING (is_active)`). Adding new *columns* to `commercial_offers` (`effective_range`, `effective_history_protected`, `request_fingerprint`) or to `billing_customers` (`commercial_market`), or widening `commercial_catalog_audit_events.entity_type`'s CHECK vocabulary, changes what a row *contains*, not which rows a policy's `USING` clause admits — none of those policies reference the new columns, so none require modification for correctness. This is a structural property of how PostgreSQL RLS evaluates `USING` clauses, not a convenience claim.

**Confirmed, directly, in this review pass: zero new Postgres extensions.** Both extensions this design's mechanisms need — `btree_gist` (the exclusion constraint) and `pgcrypto` (`digest()` for the idempotency fingerprint) — are already enabled, on lines 2 and 1 respectively of the live Ω1 migration (`supabase/migrations/20260905093408_8fc55e64-3e06-4d26-8835-438a9243e1ef.sql`), re-read directly in this pass rather than assumed from an earlier summary.

**New Edge Function:** `commercial-admin-bootstrap` (§C) — code only, no migration.

**Tables reused completely as-is, zero *existing* column/constraint change:** `commercial_products`, `commercial_plans`, `commercial_admins`, `commercial_licences`, `payment_events`, `payment_checkout_intents`, `payment_webhook_receipts`, `payment_webhook_processing_events`, `entitlement_overrides`, `billing_audit_events`. (`commercial_offers` itself gains three new columns, two new triggers, and one new exclusion constraint, all additive — listed separately above rather than in this "untouched" list, since it does gain new structure even though nothing existing on it changes.)

**`DATA_DESTRUCTIVE_OPERATIONS = 0`; `DDL_REPLACEMENT_OPERATIONS = 2` — corrected this pass (Finding 4).** This design does contain two `DROP` statements (`chk_ccae_entity_type`'s `DROP CONSTRAINT`, `uq_co_current_offer`'s `DROP INDEX`), each immediately followed by an equivalent-or-wider replacement in the same transaction — describing the migration as strictly "no DROP" or "purely additive" (as a prior draft did) is corrected here as inaccurate. What remains true, precisely: no column removal, no narrowing of any existing CHECK/RLS/GRANT's *effective permissiveness*, and — the actual invariant that matters — no data loss anywhere in this design, including the backfill above (append/flip-only) and both DDL replacements (schema-object changes only, zero rows deleted by either).

**Migration file count, matching §S's phase table exactly:** one forward-only migration file per subphase that needs a schema/function change —
- Ω3.0: 2 new tables (7 of their own constraints total) + 1 seed + 3 new columns on `commercial_offers` (`effective_range`, `effective_history_protected`, `request_fingerprint`) + 1 unconditional, evidence-independent legacy classification `UPDATE` + 2 executable fail-closed preflight `DO` blocks (row-count proof, five-dimensional conflict scan) + 2 trigger functions/triggers + 1 new exclusion constraint (5-column key, Category 2) + 2 DDL replacements (`uq_co_current_offer` widened to the same 5-column key; `chk_ccae_entity_type` widened to the full final 4-value vocabulary — neither data-destructive) + 1 bare RPC (`admin_transition_platform_state`, state-storage only) + the narrow, constraint-name-verified exclusion-violation handler on `admin_upsert_commercial_offer` + the new, fully-idempotent, row-locking, constraint-name-verified `admin_supersede_commercial_offer` RPC, every new RPC carrying its own explicit `REVOKE`/`GRANT` set (§Q Privilege Matrix) — **1 migration** (larger again than every prior draft's Ω3.0, still one file; all of it is economic-integrity hardening for the same table plus its dependent audit vocabulary, deployed together).
- Ω3.1: bootstrap is an Edge Function (code, not a migration); the 2 grant/revoke RPCs + `CREATE OR REPLACE` on the 6 Ω1-era admin functions — 1 migration.
- Ω3.2: 2 product/plan RPCs (`entity_type = 'PRODUCT'` already legal from Ω3.0 — no CHECK change here) — 1 migration.
- Ω3.3: 1 new column + 2 market RPCs — 1 migration.
- Ω3.4: `list_public_offers` — 1 migration.
- Ω3.5: `get_my_payment_receipt` — 1 migration (the webhook-branch edit is code, not a migration).
- Ω3.6: no code, no migration.
- Ω3.7: `CREATE OR REPLACE` on Ω3.0's `admin_transition_platform_state` to add its mechanical-precondition checks — **1 migration** (function-body-only, no table/column touched).
- Ω3.8: state transition only (a data write via the RPC created above, not a schema change) — no migration.

**Total: 7 migration files** (unchanged from the prior draft — this hardening pass grows Ω3.0's *content*, not the phase count), none touching Ω1/RLS1/Ω2's three live files, none rewriting a prior migration's own SQL.

Every existing RLS policy, every existing GRANT, every existing live migration file (`20260905093408...`, `20260905141022...`, `20260906083524...`) remains byte-identical. This design produces new, forward-only migration files only.

---

## Error Code Reference

Every error this design introduces, exactly where it is raised, and the hostile test in §R that proves it. Existing (Ω1/Ω2) error codes are included for completeness where a new test now also exercises them.

| Error code | Raised by | HTTP status (Edge Function) or exception (RPC/trigger) | Hostile test proving it |
|---|---|---|---|
| `CURRENCY_NOT_SUPPORTED` | `commercial_offers_economic_integrity()` trigger (§G.2) | Postgres exception, ERRCODE `22023` | Submit an offer with a currency code absent from `commercial_currencies` — trigger raises before the row is written. |
| `CURRENCY_EXPONENT_MISMATCH` | `commercial_offers_economic_integrity()` trigger (§G.2) | Postgres exception, ERRCODE `22023` | Submit `currency_code='TZS', currency_exponent=2` — the exact incident class this design closes — and prove the trigger raises. |
| `OFFER_ECONOMICS_IMMUTABLE` | `commercial_offers_economic_integrity()` trigger (§E.1) | Postgres exception, ERRCODE `22023` | Resubmit an existing `offer_code` with a different `amount_minor`/`currency_code`/`billing_interval`/`plan_id`/`market_code` — prove the trigger raises and the stored row is unchanged; separately prove resubmitting with only `is_purchasable` changed still succeeds. |
| `MARKET_NOT_SET` | `commercial-create-checkout` (§F.4, step 3) | `409` | Authenticated customer with `billing_customers.commercial_market IS NULL` and no `marketCode` in the request. |
| `MARKET_MISMATCH` | `commercial-create-checkout` (§F.4, step 4) | `400` | Customer with an already-assigned market submits a checkout request carrying a *different* `marketCode` — prove the request is rejected, not silently honored or silently ignored. |
| `NOT_A_COMMERCIAL_ADMIN` | Every admin-gated RPC (existing Ω1 pattern, reused unchanged for every new admin RPC in §C/§D) | Postgres exception, ERRCODE `42501` | An authenticated non-admin calls any `admin_*` RPC introduced by this design — prove uniform rejection. |
| `UNAUTHENTICATED` | Every admin-gated RPC (existing Ω1 pattern) | Postgres exception, ERRCODE `28000` | An anonymous/expired-JWT caller invokes any new RPC. |
| `REASON_REQUIRED` | Every audited admin action (existing Ω1/Ω2 pattern) | Postgres exception, ERRCODE `22023` | Call `admin_grant_commercial_admin`/`admin_upsert_commercial_product`/etc. with a blank `p_reason`. |
| `ALREADY_BOOTSTRAPPED` | `commercial-admin-bootstrap` Edge Function (§C, Tier 1) | `200` with `{status:'ALREADY_BOOTSTRAPPED'}` (deliberately not an error status — a second call is a safe no-op, not a failure) | Call the bootstrap function twice with a valid token — prove the second call grants no new admin and the table still has exactly the original active admin. |
| `CANNOT_REVOKE_SOLE_REMAINING_ADMIN` | `admin_revoke_commercial_admin` (§C, Tier 3) | Postgres exception, ERRCODE `22023` | With exactly one active admin, call revoke on that admin — prove it is refused, not just discouraged. |
| `PAYMENTS_DISABLED` | `commercial-create-checkout` (§K.2) | `503` | Platform state is `PAYMENTS_DISABLED` (the default and current real-world state) — prove **every** caller, including a `commercial_admin`, is refused. |
| `SANDBOX_STATE_BUT_LIVE_KEY_CONFIGURED` | `commercial-create-checkout` (§K.2) | `500` | Platform state is `SANDBOX_ONLY` while the deployed Flutterwave secret key is a `sk_live_...` key — proves the ambiguity the mission explicitly worries about is a checked condition, not a policy. |
| `UNKNOWN_OR_INACTIVE_PLAN_CODE` | `admin_upsert_commercial_offer`, `admin_grant_commercial_licence` (existing, unchanged) | Postgres exception | Regression-only — re-run existing coverage, unchanged by this design. |
| `UNKNOWN_FEATURE_CODE` | `admin_grant_entitlement_override` (existing, unchanged) | Postgres exception | Regression-only — re-run existing coverage, unchanged by this design. |
| `AMOUNT_MUST_BE_POSITIVE` | `admin_upsert_commercial_offer` (existing, unchanged) | Postgres exception | Regression-only — re-run existing coverage, unchanged by this design. |
| `OFFER_EFFECTIVE_PERIOD_CONFLICT` | `excl_co_no_overlapping_purchasable_periods` exclusion constraint (§E.2, point 9) — raw `SQLSTATE 23P01`, translated by `admin_upsert_commercial_offer` and `admin_supersede_commercial_offer`'s exception handlers (§E.2, point 8/13) | Postgres exception, ERRCODE `23P01` (raw), re-raised as this domain code by the RPC layer | Test A (§R) — live database, genuine concurrent connections. |
| `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` | `admin_supersede_commercial_offer` (§E.2, point 13) — the pre-lock optimistic check, the post-lock recheck, AND the `WHEN unique_violation` handler (three occurrences) | Postgres exception, ERRCODE `22023` | Test B-iii / D (§R) — call `admin_supersede_commercial_offer` twice with the identical `p_new_offer_code` but a different `p_amount_minor` (or any other semantic parameter) — prove the second call is rejected with this code, not silently accepted or silently treated as a replay. |
| `OLD_OFFER_NOT_FOUND` | `admin_supersede_commercial_offer` (§E.2, point 13, step 9) | Postgres exception, ERRCODE `22023` | Test D-1 (§R) — call with `p_old_offer_code` naming a non-existent offer_code; structurally provable (statement precedes any write) plus behaviorally confirmable live. |
| `OLD_OFFER_NOT_SUPERSEDABLE` | `admin_supersede_commercial_offer` (§E.2, point 13, steps 11-12) | Postgres exception, ERRCODE `22023` | Test D-3 / Test B-ii (§R) — call against a predecessor already closed by a prior, different successor. |
| `OFFER_FAMILY_MISMATCH` | `admin_supersede_commercial_offer` (§E.2, point 13, steps 13-14) | Postgres exception, ERRCODE `22023` | Test D-2 (§R) — call with a successor's plan/market/currency/interval/interval-count not matching the predecessor's own stored family. |
| `INVALID_EFFECTIVE_BOUNDARY` | `admin_supersede_commercial_offer` (§E.2, point 13, step 15) — an addition beyond Codex's three named codes, justified in §E.2's discussion immediately after the function listing | Postgres exception, ERRCODE `22023` | Test D-4 (§R) — call with `p_effective_start` at or before the predecessor's own `effective_start`. |
| `NEW_OFFER_CODE_REQUIRED` | `admin_supersede_commercial_offer` (§E.2, point 13, step 2) | Postgres exception, ERRCODE `22023` | Regression-only structural check — call with a blank/NULL `p_new_offer_code`. |
| `PRODUCT_*` audit atomicity (no error code of its own — a structural proof, not a failure mode) | `admin_upsert_commercial_product` (§D.1) | — | §D.1's atomicity proof — if the `commercial_catalog_audit_events` insert ever failed (e.g. a future accidental narrowing of `chk_ccae_entity_type`), the uncaught exception would roll back the `commercial_products` mutation with it; no `EXCEPTION` block exists in this function to catch and mask that failure. |
| `LEGACY_CLASSIFICATION_INCOMPLETE` | Ω3.0 migration file itself (§E.2, point 6a, Step C) — an anonymous `DO` block, not a named function | Postgres exception (uncaught, aborts the whole migration transaction) | Test F (§R) — structurally, Step C's row-count comparison has no branch that could produce a false pass; behaviorally, this is exercised only if some other mechanism silently prevented Step B's unconditional `UPDATE` from reaching every row, which this design does not anticipate but checks for anyway. |
| `LEGACY_EFFECTIVE_RANGE_CONFLICTS_DETECTED` | Ω3.0 migration file itself (§E.2, point 6a, Step D) | Postgres exception (uncaught, aborts the whole migration transaction) | Test F-3 (§R) — seed two pre-existing, overlapping, same-family legacy rows; prove Step D detects the conflict and aborts the entire Ω3.0 file before the exclusion constraint (or any other object in the file) is installed. |

---

## R. Test / Certification Strategy

| Gate category | Existing coverage | New coverage needed |
|---|---|---|
| Unit (money/entitlement/routing) | `money.test.ts`, `edgeMoney.test.ts`, `entitlementContract.test.ts`, `routing.test.ts` — all reusable unchanged. | Registry-aware `parseCurrencyExponent`-equivalent DB tests (static SQL-text, matching existing convention) for the new trigger. |
| RLS | `rlsRecursionGuard.test.ts` | New: `commercial_currencies`/`commercial_platform_state`/`billing_customers.commercial_market` RLS/GRANT static-text tests. |
| RPC | `globalCommerceModel.test.ts`, `marketPropagation.test.ts` | New: every §Q function's static-text contract test (signature, gate, audit-write). |
| Currency | `edgeMoney.test.ts`, `money.test.ts` | New: registry-mismatch rejection test — `CURRENCY_EXPONENT_MISMATCH` (TZS+2) and `CURRENCY_NOT_SUPPORTED` (unknown code) both raised by the single `commercial_offers_economic_integrity()` trigger (§G.2), proven via one static-text test against the trigger function body, not a dual RPC+trigger test (there is only one enforcement point to test). |
| Market | `marketPropagation.test.ts`, `globalCommerceModel.test.ts` | New: `MARKET_MISMATCH`/`MARKET_NOT_SET` checkout-flow tests (§F.4). |
| Offer lifecycle | `globalCommerceModel.test.ts` | New: DRAFT/SCHEDULED/LIVE/RETIRED derivation pure-function tests (client-side, mirroring the `shouldShowUpgradeAction` extraction pattern already used in `CheckoutUpgradeButton.test.ts`). |
| Admin authority | `rlsRecursionGuard.test.ts`, `paymentSecurity.test.ts` | New: bootstrap idempotency test, sole-admin lockout-guard test, `is_commercial_admin()`-gate test for every new RPC. |
| Customer isolation | `authContractRepair.test.ts` (payment-status) | New: `list_my_payment_events`/`get_my_payment_receipt` must use the anon-key+forwarded-JWT pattern (static-text check, exact precedent already proven). |
| Checkout | `checkoutFlow.test.ts` | New: platform-state gate (`PAYMENTS_DISABLED`/`LIVE_ACCEPTANCE`-admin-only) static tests. |
| Webhook | `webhookSecurity.test.ts`, `webhookEvidenceModel.test.ts` | New: refund-branch routing test (§M) — proves a `SUCCEEDED`-then-`REFUNDED` sequence calls `record_payment_reversal`, not `authoriseCommit`'s generic failure path. |
| Gate A / Gate B | `edgeFlutterwaveGateB.test.ts`, `webhookSecurity.test.ts` | Unchanged — no Ω3 subphase touches these files. Re-run unmodified as a firewall proof. |
| Licence / entitlement | `entitlementContract.test.ts` | Unchanged, re-run as firewall proof. |
| Receipt | — | New: `get_my_payment_receipt` field-completeness + owner-scoping test. |
| Refund/reversal | `atomicCommit.test.ts` (reversal-return-shape only) | New: webhook-branch wiring test (above). |
| Production build / migration audit | existing `tsc --noEmit`, `npm run build`, `git diff --check`, `migrationCollisionGuard.test.ts` | `migrationCollisionGuard.test.ts` extended to cover the new migration files (same one-executable-`CREATE TABLE`-per-table pattern). |
| **Offer effective-history concurrency** (§E.2) | — no existing coverage; genuinely new category | **Test A** (§R spec below): successor-vs-successor exclusion-constraint conflict, corrected this pass from a prior draft that only proved successor-vs-still-open-predecessor conflict. Family key is now 5 columns (`plan_id, market_code, currency_code, billing_interval, billing_interval_count`), not 3 — structurally provable today (DDL text), behaviorally live-database only. |
| **Concurrent supersession (RPC locking)** (§E.2 point 13) | — no existing coverage; genuinely new category, added this pass in response to Blocker 2 | **Test B** (§R spec below): `SELECT ... FOR UPDATE` row-lock on the predecessor, 3 sub-cases (identical retry / genuine conflict / payload drift). Lock-acquisition structure is provable from source text (statement exists, precedes every predecessor mutation); actual blocking behavior under concurrency is live-database only. |
| **Retired/deactivated permanence** (§E.2 points 6/6a) | — no existing coverage | **Test C** (§R spec below), 2 sub-cases, each with a negative control against the two prior, defective predicates. |
| **Supersession error codes** (§E.2 point 13) | — no existing coverage; 4 new codes this pass | **Test D** (§R spec below), one sub-test per code (`OLD_OFFER_NOT_FOUND`, `OFFER_FAMILY_MISMATCH`, `OLD_OFFER_NOT_SUPERSEDABLE`, `INVALID_EFFECTIVE_BOUNDARY`); D-1/D-2 structurally provable (statement ordering), D-3/D-4 live-database. |
| **Ratchet tamper resistance** (§E.2 point 6b) | — no existing coverage | **Test E** (§R spec below), direct-SQL/service-role bypass of every RPC, both tamper directions; structural half (trigger body shape) provable today, behavioral half live-database. |
| **Legacy-row classification (fail-closed)** (§E.2 point 6a) | — no existing coverage; genuinely new category, BLOCKER-level correction this pass | **Test F** (§R spec below) — unconditional classification, no-audit-evidence hostile case, overlap-conflict abort, interrupted/rerun-after-rollback safety; the classification logic itself is provable from source text (no `is_purchasable`/audit-table reference anywhere in Steps A-D), the actual abort/rollback behavior is live-database only. |
| **Supersession idempotency, non-locking claims** (§E.2 point 13) | — no existing coverage; a genuine correction from a prior draft that only checked the bare `uq_co_offer_code` constraint | Static-source-text tests, runnable today: the function body computes `v_fingerprint` via `digest(...)`; the pre-lock optimistic check AND the post-lock recheck (step 10) both compare fingerprints before returning; `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` exists in the optimistic path, the post-lock recheck, and the `WHEN unique_violation` handler (three occurrences, not one); the exception block names only `unique_violation` and `exclusion_violation` (no `WHEN OTHERS`, satisfying mission requirement #8 from the prior pass and Blocker 3 item 19 this pass). The genuinely concurrent-request and timeout-after-commit-retry claims are Test B's behavioral half. |

**Mandatory hostile tests — corrected this pass. Blocker 2 identified a real defect in the prior draft's single concurrency test: it started with an open, still-purchasable `F-V1` and had both successors race, so both successors independently conflicted with the still-open `F-V1` rather than with *each other* — the test never actually isolated successor-vs-successor conflict handling, which is what Test A below fixes. It has been split into five clearly separated tests (A, B, C, D, E), each proving exactly one mechanism, none of which are conflated with another. Honest scoping, unchanged: Tests A, B, D3/D4, and E's behavioral half all require two genuinely concurrent database connections against a real Postgres instance (a staging Supabase project) — none of them can run in this repo's DB-less Vitest suite, and none are claimed to have been executed here. Tests C and the structural half of D/E are static-source-text checks, runnable today.**

```
TEST A — EXCLUSION-CONSTRAINT CONCURRENCY (successor vs. successor, not
successor vs. still-open predecessor — the defect in the prior draft)

PRECONDITION:
  Offer family F = (plan_id=P, market_code='TZ', currency_code='TZS',
  billing_interval='ANNUAL', billing_interval_count=1). No OPEN
  predecessor overlaps the test range: if a historical predecessor
  F-V1 exists for F, it has already been closed, with
  effective_end = T exactly (via admin_supersede_commercial_offer, or by
  direct setup for this test's purposes) — F-V1 is NOT open-ended at
  test time, precisely so it cannot independently conflict with either
  successor and mask the successor-vs-successor result this test exists
  to isolate.

ACTION (genuinely concurrent — both connections prepare their INSERT
before either COMMITs, then are released together):
  Connection 1: INSERT a new offer_code='F-V2-A' for family F,
    effective_start=T, effective_end=NULL, is_purchasable=true.
  Connection 2: INSERT a new offer_code='F-V2-B' for family F,
    effective_start=T (identical boundary — deliberately overlapping,
    since [T, inf) and [T, inf) share every instant), effective_end=NULL,
    is_purchasable=true.
  Both rows carry is_purchasable=true at INSERT time, so the ratchet
  trigger (§E.2 point 6b) sets effective_history_protected=true on each before
  the exclusion constraint is ever evaluated — both are genuine
  candidates for the exclusion check, not exempted by construction.

EXPECTED RESULT:
  Exactly one of {F-V2-A, F-V2-B} commits. The other's INSERT is
  rejected by the named exclusion constraint
  (excl_co_no_overlapping_purchasable_periods), SQLSTATE 23P01,
  deterministically mapped to OFFER_EFFECTIVE_PERIOD_CONFLICT by
  whichever RPC issued it. The database contains exactly one committed
  successor for that effective range — not zero, not two.

REQUIRED EVIDENCE:
  1. Committed row count for family F after both connections resolve:
     F-V1 (closed, unchanged) + exactly one of {F-V2-A, F-V2-B} — never
     both successors.
  2. The rejected connection's actual error output (SQLSTATE + constraint
     name), captured verbatim.
  3. A SELECT confirming the winning row's effective_range and the
     loser's complete absence from the table (proving rollback, not a
     half-written row).
  4. Exactly one OFFER_CREATED commercial_catalog_audit_events entry for
     this window, not two, not zero.


TEST B — CONCURRENT SUPERSESSION (RPC locking, atomicity, idempotency —
a materially different mechanism from Test A's raw exclusion constraint)

PRECONDITION:
  One valid, open predecessor F-V1 exists for family F (is_purchasable
  = true, effective_end = NULL).

ACTION (two independent requests, released concurrently):
  Request 1: admin_supersede_commercial_offer(p_old_offer_code='F-V1',
    p_new_offer_code='F-V2', <same family>, p_effective_start=T, ...).
  Request 2: an INDEPENDENT, DIFFERENT request targeting the SAME
    predecessor F-V1 — tested as three separate sub-cases:
    B-i  (identical retry): Request 2 has IDENTICAL parameters to
         Request 1 (same p_new_offer_code, same fingerprint).
    B-ii (genuine conflict): Request 2 has a DIFFERENT p_new_offer_code
         (a second admin trying to supersede the same predecessor with
         a different successor).
    B-iii (payload drift): Request 2 has the SAME p_new_offer_code as
         Request 1 but a DIFFERENT economic parameter (e.g. a different
         p_amount_minor).

EXPECTED RESULT (mechanism, common to all three sub-cases):
  Both requests reach admin_supersede_commercial_offer's
  `SELECT ... FROM commercial_offers WHERE offer_code = 'F-V1' FOR
  UPDATE` (§E.2 point 13, steps 7-8). Whichever request's transaction
  arrives first acquires the row lock; the other BLOCKS — it does not
  race, does not read a stale predecessor state, and does not error —
  until the first transaction commits or rolls back.

EXPECTED RESULT (per sub-case, after the lock is released):
  B-i:   Exactly one economic supersession transition occurs. The
         second, now-unblocked request's post-lock idempotency recheck
         (step 10) finds F-V2 already created with a matching
         fingerprint and returns {offer_id, replay: true} — the
         identical, already-created successor, not a second row and not
         an error.
  B-ii:  Exactly one economic supersession transition occurs (the
         winner's). The second request's post-lock recheck finds no
         matching offer_code, falls through to the eligibility check
         (step 11-12), finds F-V1.effective_end IS NOT NULL, and is
         rejected deterministically with OLD_OFFER_NOT_SUPERSEDABLE —
         a real business conflict, reported as such.
  B-iii: Identical mechanism to B-i up through the post-lock recheck,
         which now finds a fingerprint mismatch and raises
         IDEMPOTENCY_KEY_PAYLOAD_MISMATCH rather than replaying — a
         request claiming the same key with different economics is
         never silently treated as the same request.
  In no sub-case does double retirement, a duplicate successor, a lost
  update, or a partial transition (predecessor closed with no successor,
  or vice versa) ever occur — §E.2 point 13's atomicity proof (step 20)
  applies identically regardless of which sub-case is exercised.

REQUIRED EVIDENCE:
  1. Row-lock wait: confirm (via `pg_locks`/`pg_stat_activity` on
     staging, or the test harness's own timing) that the second
     connection genuinely blocked on the row lock rather than proceeding
     concurrently.
  2. Final row count for family F: predecessor (closed) + exactly one
     successor in every sub-case.
  3. The second request's actual returned result/error in each sub-case,
     matching the EXPECTED RESULT table above exactly.


TEST C — RETIRED / DEACTIVATED ROWS REMAIN PERMANENTLY PROTECTED
(static-source-text provable for the predicate/trigger shape; the
INSERT-is-rejected behavior itself still needs live Postgres)

  C-1 (retirement): F-V1 retired via admin_supersede_commercial_offer
    (effective_end set, is_purchasable=false, effective_history_protected
    remains true per the ratchet). A later INSERT overlapping F-V1's
    now-closed window, same family, is_purchasable=true, is REJECTED
    with OFFER_EFFECTIVE_PERIOD_CONFLICT — F-V1's effective_history_protected
    is still true. (Negative control: this same INSERT would have
    SUCCEEDED under the very first, is_purchasable-only predicate this
    document's history rejected.)
  C-2 (deactivation): same as C-1, plus an admin separately sets
    is_active=false on F-V1 (the deliberate, out-of-band "erroneous row"
    escape hatch, §E.2 point 6, which — unlike the design's own earlier,
    incorrect draft — plays NO role in the exclusion predicate at all).
    The same later INSERT is STILL REJECTED with
    OFFER_EFFECTIVE_PERIOD_CONFLICT. (Negative control: this same INSERT
    would have SUCCEEDED under the prior pass's
    `is_active AND effective_history_protected` predicate once is_active=false
    — this is the literal defect that predicate had, reproduced as an
    executable test.)


TEST D — SUPERSESSION ERROR-CODE HOSTILE TESTS (one per new code; D-1/D-2
structural and runnable today; D-3/D-4 behavioral, live-database)

  D-1 OLD_OFFER_NOT_FOUND (structural + behavioral): call
    admin_supersede_commercial_offer with p_old_offer_code naming an
    offer_code that does not exist. EXPECTED: OLD_OFFER_NOT_FOUND,
    raised at step 9, before any predecessor lock is meaningfully held
    and before any write occurs.
  D-2 OFFER_FAMILY_MISMATCH (structural + behavioral): call with a valid
    p_old_offer_code but a p_market_code (or currency/interval/interval-
    count) that differs from the predecessor's own stored values.
    EXPECTED: OFFER_FAMILY_MISMATCH, raised at step 13-14, after the
    predecessor is locked but before either the predecessor or the
    successor is written.
  D-3 OLD_OFFER_NOT_SUPERSEDABLE (behavioral, live-database — this is
    Test B-ii's mechanism, tested here in isolation, single-connection):
    call admin_supersede_commercial_offer against a predecessor that is
    already closed (effective_end IS NOT NULL). EXPECTED:
    OLD_OFFER_NOT_SUPERSEDABLE, raised at step 11-12.
  D-4 INVALID_EFFECTIVE_BOUNDARY (behavioral, live-database): call with
    p_effective_start <= the predecessor's own effective_start.
    EXPECTED: INVALID_EFFECTIVE_BOUNDARY, raised at step 15, before any
    write occurs.
  Structural coverage available today for all four: each RAISE
  EXCEPTION's literal string and USING ERRCODE clause can be located in
  the function body and its ordering relative to the predecessor
  UPDATE/successor INSERT statements confirmed by text position alone.


TEST E — DIRECT SQL / SERVICE-ROLE HOSTILE TESTS AGAINST THE RATCHET
(structural half runnable today; behavioral half live-database)

  E-1 Hostile true->false, direct SQL, service-role connection:
      UPDATE commercial_offers SET effective_history_protected = false
        WHERE offer_code = 'F-V1';
      EXPECTED: statement succeeds syntactically, but
      trg_commercial_offers_effective_history_ratchet unconditionally
      recomputes NEW.effective_history_protected :=
      OLD.effective_history_protected OR NEW.is_purchasable, discarding the
      caller's literal `false`. A subsequent SELECT MUST return true.

  E-2 Hostile false->true, direct SQL, service-role connection,
      bypassing every RPC:
      INSERT INTO commercial_offers (..., is_purchasable,
        effective_history_protected) VALUES (..., false, true);
      EXPECTED: INSERT succeeds, but the trigger computes
      NEW.effective_history_protected := NEW.is_purchasable (= false) on
      INSERT, ignoring the literal `true` supplied. A subsequent SELECT
      MUST return false.

  E-3 Combined regression proof: E-1 and E-2 together are what make Test
      C-2 meaningful rather than circular — C-2 proves is_active no
      longer affects protection; E-1 proves effective_history_protected itself
      cannot be forced false even by direct SQL; E-2 proves it cannot be
      forced true without genuinely having been purchasable.

  Structural coverage available today: the ratchet trigger's body can be
  parsed to confirm it (i) never references NEW.effective_history_protected on
  its right-hand side anywhere, and (ii) unconditionally assigns it from
  OLD.effective_history_protected/NEW.is_purchasable only.


TEST F — LEGACY-ROW CLASSIFICATION (Finding 1 / §E.2 point 6a; structural
half runnable today via source-text inspection of Steps A-D; the
classification/abort behavior itself is live-database only)

  F-1 Formerly-purchasable, now-retired legacy offer with NO corroborating
      audit event: seed a row with is_purchasable=false, effective_end
      already in the past, and zero matching commercial_catalog_audit_events
      rows. Run Step B (UPDATE commercial_offers SET
      effective_history_protected = true, unconditional, no WHERE clause).
      EXPECTED: effective_history_protected = true. It must never remain
      false — Step B has no branch that could produce false for a
      pre-existing row, so this is not merely likely to pass, it is
      structurally incapable of failing differently.

  F-2 Ambiguous legacy record (e.g. is_purchasable=true but effective_end
      already elapsed — an internally inconsistent state that shouldn't
      arise from correct application logic but is not itself impossible
      in raw data): run Step B. EXPECTED: effective_history_protected =
      true, identical to F-1 — the classification step does not inspect
      is_purchasable, effective_end, or any other column's value at all.

  F-3 Overlapping legacy records: seed two pre-existing rows sharing the
      complete five-column family with genuinely overlapping
      effective_range values. Run Steps B-D. EXPECTED: Step D's
      v_conflict_count > 0, RAISE EXCEPTION fires
      (LEGACY_EFFECTIVE_RANGE_CONFLICTS_DETECTED), the entire Ω3.0
      migration transaction aborts — no exclusion constraint, no new
      tables, nothing else in the file takes effect either.

  F-4 Missing audit history (commercial_catalog_audit_events entirely
      empty) / F-5 Partial audit history (some but not all legacy rows
      have corresponding entries): run Steps B-D in both cases. EXPECTED:
      identical outcome to a fully-audited dataset in every case — Steps
      B-D never query commercial_catalog_audit_events at all in the
      corrected design, so its completeness is irrelevant BY
      CONSTRUCTION, not merely irrelevant in the specific data tested.

  F-6 Interrupted migration: kill the migration process after Step B
      commits internally but before the file's implicit transaction
      reaches COMMIT. EXPECTED: on reconnect, effective_history_protected
      does not exist as a column at all — the whole file rolled back, as
      if never attempted.

  F-7 Rerun after rollback: re-run the identical migration file after an
      F-3-triggered abort, once the conflicting data has been reconciled.
      EXPECTED: Steps A-D execute cleanly against the corrected data; no
      dependency on any state from the previous, aborted attempt (the
      column did not survive that rollback).

  Structural coverage available today for F-1/F-2/F-4/F-5: Steps A-D's
  source text contains no reference to is_purchasable, effective_end, or
  commercial_catalog_audit_events anywhere in the classification logic
  itself (Step D's conflict query is the only place either of the first
  two columns appears, and only as part of the five-dimensional JOIN, not
  as a filter on which rows get classified). F-3/F-6/F-7 are behavioral,
  live-database only.


TEST G — CONSTRAINT-SPECIFIC EXCEPTION TRANSLATION (Finding 2 /
§E.2 point 13, §G.2 point 8; structural half runnable today, behavioral
half live-database — mapped directly to Codex's own A-E labeling)

  G-A (Codex A) Trigger uq_co_offer_code: call admin_supersede_commercial_
      offer twice with the identical p_new_offer_code and identical
      parameters. EXPECTED: the unique_violation handler's GET STACKED
      DIAGNOSTICS reads 'uq_co_offer_code', the IF matches, idempotency
      resolution occurs (replay or IDEMPOTENCY_KEY_PAYLOAD_MISMATCH per
      fingerprint comparison) — never a bare RAISE.

  G-B (Codex B) Trigger excl_co_no_overlapping_purchasable_periods: two
      concurrent successors overlapping in the same family (Test A's own
      setup). EXPECTED: the exclusion_violation handler's GET STACKED
      DIAGNOSTICS reads the named constraint, the IF matches,
      OFFER_EFFECTIVE_PERIOD_CONFLICT is raised.

  G-C (Codex C) Trigger a DIFFERENT unique constraint inside the
      function's own write path: contrive a scenario where some OTHER
      unique constraint on commercial_offers (hypothetically, a future
      one this design does not itself add) fires during the successor
      INSERT. EXPECTED: GET STACKED DIAGNOSTICS reads a constraint name
      that does NOT equal 'uq_co_offer_code'; the ELSE branch's bare
      RAISE; fires; the original database error (its own SQLSTATE,
      message, and constraint name) propagates completely unchanged —
      never silently reinterpreted as an idempotency replay.

  G-D (Codex D) Trigger a DIFFERENT exclusion constraint: analogous to
      G-C for the exclusion_violation handler — a hypothetical future
      exclusion constraint on this table firing during the same INSERT.
      EXPECTED: constraint-name mismatch, bare RAISE;, original error
      propagates unchanged — never silently reinterpreted as
      OFFER_EFFECTIVE_PERIOD_CONFLICT.

  G-E (Codex E) Unexpected/unanticipated constraint name: the general
      case G-C/G-D instantiate — any constraint name this function's
      exception handlers do not explicitly recognize. EXPECTED: no domain-
      error mistranslation occurs for any constraint name this design did
      not name explicitly; the IF/ELSE structure has no default branch
      that translates by SQLSTATE alone, by message substring, or by any
      mechanism other than an exact CONSTRAINT_NAME string match.

  Structural coverage available today for all five: both exception
  handlers' source text can be parsed to confirm (i) GET STACKED
  DIAGNOSTICS is called before any translation decision, (ii) the
  IF condition is an exact string equality against one named constraint,
  (iii) every ELSE branch is a bare `RAISE;` with no arguments, and
  (iv) no `WHEN OTHERS` clause exists anywhere in either function. G-A/G-B
  are additionally live-database provable (they are Test D/Test A's own
  scenarios, viewed through the constraint-identity lens); G-C/G-D/G-E
  require contriving a constraint this design does not itself add, so
  they are necessarily hypothetical/structural rather than executable
  against this design's own schema — the structural proof (the code
  cannot mistranslate because it checks identity, not condition name
  alone) is what stands in for an executable test here.
```

Tests A through G together belong in the Ω3.0 acceptance gate (§S) as required, separate, non-Vitest steps — not a nice-to-have, and not something a passing `npm run build`/static-suite run can substitute for.

**Hostile tests, mapped to their exact mechanism:**
- commercial_admin cannot gain accounting authority → static grep of every new RPC body for accounting-table names (extends `paymentSecurity.test.ts`'s existing list).
- accounting owner cannot self-promote commercial_admin → `commercial_admins` RLS has no INSERT policy for `authenticated`, unchanged; static-text proof.
- customer cannot alter price/currency → unchanged Ω2 proof (`checkoutFlow.test.ts`), re-run.
- customer cannot alter market after offer authorization → new `MARKET_MISMATCH` test (§F.4).
- invalid exponent rejected → new `commercial_offers_economic_integrity()` trigger test (§G.2) — `CURRENCY_EXPONENT_MISMATCH`, one enforcement point, statically proven.
- unknown market fails closed → existing `resolve_commercial_offer` `UNKNOWN` test, unchanged.
- duplicate webhook no duplicate value → existing `uq_pe_provider_tx_id` + `REPLAY` tests, unchanged.
- cross-customer reads denied → existing RLS pattern + new admin-list-RPC pagination-is-admin-gated tests.
- offer historical economics preserved → existing `payment_checkout_intents` immutable-snapshot tests, unchanged.
- offer economics cannot be mutated in place on an existing offer_code → new `OFFER_ECONOMICS_IMMUTABLE` rejection test (§E.1) — the exact hostile case: resubmit the same `offer_code` with a different `amount_minor`/`currency_code` and prove the RPC raises, never silently updates.
- two concurrent successors cannot both create overlapping effective periods for the same complete offer family (all five key columns) → Test A — explicitly not claimed to have been executed here.
- two concurrent supersession requests against the same predecessor serialize via row lock rather than race → Test B (3 sub-cases) — explicitly not claimed to have been executed here.
- MONTHLY×1 and ANNUAL×1 (or any two offers differing on billing_interval/billing_interval_count) never conflict regardless of overlapping dates → the family-key widening itself (§E.2 point 1/9) is structurally provable from the constraint DDL alone — no live database needed to prove the `=` comparison on those columns exists in the key.
- a retired/superseded offer's historical effective period remains permanently protected, not only while it is currently purchasable → Test C — with an explicit negative control proving each of the *two* prior, defective predicates would have failed it.
- the ratchet cannot be tampered with in either direction by a direct SQL write bypassing every RPC → Test E.
- supersession is genuinely idempotent under replay, payload mismatch, concurrency (via row-lock convergence, not merely `uq_co_offer_code`), and timeout-retry → Test B plus the static structural tests in the table above.
- `admin_supersede_commercial_offer` fails closed and deterministically on a missing predecessor, a cross-family predecessor/successor pair, an already-superseded predecessor, and a degenerate boundary → Test D, one sub-test per new error code.
- every pre-existing offer row, regardless of its recorded purchase history or the completeness of its audit trail, enters permanent overlap protection unless the Ω3.0 migration itself aborts on a detected conflict → Test F.
- exception translation only ever fires for the exact, named constraint it is written for — any other unique/exclusion-constraint violation propagates as PostgreSQL's own original, unmodified error → Test G (G-A through G-E, mapped 1:1 to Codex's own lettering).

---

## S. Phase Breakdown

| Phase | Scope | Files/tables/functions | Invariants | Acceptance gate | Rollback boundary | Production mutation required? |
|---|---|---|---|---|---|---|
| **Ω3.0** Registry + effective-history hardening | `commercial_currencies` table (seeded, own RLS policy, 3 own constraints) + `commercial_platform_state` table (defaults to `PAYMENTS_DISABLED`, own admin-only RLS policy, 4 own constraints) + a bare `admin_transition_platform_state` RPC; `commercial_offers_economic_integrity()` trigger (currency+immutability, unchanged); `commercial_offers_effective_history_ratchet()` trigger (§E.2 point 6b, corrected this pass to never trust the caller's own value); `commercial_offers.effective_range`/`effective_history_protected`/`request_fingerprint` columns + unconditional, fail-closed legacy-row classification with executable preflight abort (§E.2 point 6a — corrected this pass from an audit-trail-dependent backfill to a conservative, evidence-independent one) + `excl_co_no_overlapping_purchasable_periods` exclusion constraint, keyed on the full 5-column family (`plan_id, market_code, currency_code, billing_interval, billing_interval_count`) + `effective_history_protected` predicate alone; `uq_co_current_offer` existing index **replaced** (DDL replacement #1) to the same 5-column family; `commercial_catalog_audit_events.entity_type` CHECK constraint **replaced** (DDL replacement #2) to the full final vocabulary (`'OFFER','PLAN','ADMIN','PRODUCT'`) even though `'PRODUCT'` isn't needed until Ω3.2 (avoids touching this constraint twice); fully-idempotent, row-locking, constraint-name-verified `admin_supersede_commercial_offer` RPC; one narrow, constraint-name-verified exclusion-violation handler addition to `admin_upsert_commercial_offer` | 1 migration file (2 tables with 7 of their own constraints total + 2 new RLS policies, 1 seed, 2 trigger functions+triggers, 3 new columns, 1 unconditional legacy-classification UPDATE + 2 executable preflight `DO` blocks, 1 new exclusion constraint on the 5-column key [Category 2], 2 DDL replacements — `uq_co_current_offer` and `chk_ccae_entity_type` [neither data-destructive] — 2 RPCs [1 new bare, 1 new atomic-idempotent-locking-supersede] — plus the one exception-handler addition to the existing offer RPC, out of 16 new RPCs total across all of Ω3, each with an explicit privilege grant/revoke set, enumerated exactly in §Q's Privilege Matrix). **No new extension** — `btree_gist` and `pgcrypto` both already live since Ω1 (re-confirmed directly in this review pass). | No plan/price mixing; currency registry is the sole exponent authority; two concurrent successors can never both create overlapping purchasable effective periods within the same *complete* offer family (billing interval and interval count included — MONTHLY×1/ANNUAL×1/MONTHLY×3 are all genuinely independent families); **every pre-existing offer row enters permanent protection unconditionally, never contingent on audit-trail completeness, with the whole migration aborting before installing the exclusion constraint if any legacy conflict is detected** (§E.2 point 6a); that protection survives retirement, deactivation, and supersession **permanently**, with no mutable field of any kind able to remove it; two concurrent supersession requests against the same predecessor serialize via row lock, never race (§E.2 point 13, Test B); exception translation verifies the exact constraint name before translating anything, with a bare re-raise for every unrecognized case (§E.2 point 13, §G.2 point 8); supersession is genuinely idempotent; platform starts at `PAYMENTS_DISABLED` (matches current real-world state exactly, zero behavior change on deploy) | Static-text tests green (full Error Code Reference shape checks) **plus** the mandatory Tests A-G (§R) — the only tests in this entire design that require a real Postgres instance and cannot run in this repo's DB-less suite; must be run against staging before this phase is considered proven, not merely deployed; existing `globalCommerceModel.test.ts`/`edgeMoney.test.ts` unchanged and green | Drop the two new tables (and their RLS policies), both triggers, the exclusion constraint, the three new columns, and the two RPCs; revert the one exception-handler addition; revert `uq_co_current_offer` and `chk_ccae_entity_type` to their exact pre-migration definitions (both DDL replacements are transactional — a rollback restores the originals precisely, never a half-applied state) — zero impact on any existing row, policy, or existing function | Migration apply only (the legacy classification mutates existing `commercial_offers` rows, but only by unconditionally setting `effective_history_protected = true` for every pre-existing row — additive, non-destructive, reversible by dropping the column; it does NOT depend on audit-trail data in any way); the concurrency, locking, tamper-resistance, and legacy-classification-conflict proofs additionally require exercising real concurrent/direct-SQL connections against a staging database, not merely applying the migration |
| **Ω3.1** Commercial-admin authority/bootstrap | `commercial-admin-bootstrap` Edge Function; `admin_grant/revoke_commercial_admin`, `admin_list_commercial_admins`; unify the six Ω1-era inline-`EXISTS` admin RPCs onto `is_commercial_admin()` (HIGH cleanup, §A.2) | New Edge Function; new RPCs; `CREATE OR REPLACE` on 6 existing functions (body-only, signatures unchanged) | Zero self-promotion path; sole-admin lockout guard; bootstrap idempotent | Bootstrap-twice test proves second call is a no-op; lockout test proves last-admin revoke is refused | Revert the 6 function bodies to their prior inline check (functionally identical either way) — no data impact | Bootstrap Edge Function must actually be invoked once, live, by the founder — the one deliberate production action in this phase, explicitly authorized separately from "design" |
| **Ω3.2** Pricing/offer control plane | Admin UI: Products/Plans/Currencies/Markets tabs; `admin_upsert_commercial_product` (full body + audit-atomicity proof, §D.1), `admin_upsert_commercial_plan` | `CommercialAdmin.tsx` extension; new RPCs. `entity_type = 'PRODUCT'` is already legal as of Ω3.0's vocabulary widening — no CHECK-constraint change needed in this phase's own migration. | Plan never carries a price; currency/market remain controlled vocabularies, not free admin data-entry; a product mutation and its audit row commit or roll back together (§D.1) | New RPC static tests + manual admin-UI walkthrough (no live DB in this environment, so this gate is genuinely exercised only after a real deploy) | Hide the new tabs; RPCs are additive and harmless if unused | No |
| **Ω3.3** Commercial-market authority | `billing_customers.commercial_market`; `set_billing_customer_market`, admin sibling; checkout market-mismatch enforcement | Migration; new RPCs; `commercial-create-checkout` edit | §F.4's five-branch logic exactly | New checkout-flow tests (MARKET_NOT_SET/MARKET_MISMATCH) green; existing `marketPropagation.test.ts` still green | Revert the checkout-function branch to Ω2 behavior (always trust the request's marketCode) — the column can stay, unused, with zero harm | No |
| **Ω3.4** Customer Pricing + Billing UX | `/pricing` route, `list_public_offers`; Settings market row + payment history + receipt links | New route/RPC; `Settings.tsx` extension | Never a Tanzania default; never fabricated pricing; owner-scoped reads via anon+forwarded-JWT | New RPC test; manual `/pricing` walkthrough post-deploy | Remove the route; RPC is read-only and additive | No |
| **Ω3.5** Receipt/payment operations | `get_my_payment_receipt`, `/billing/receipts`; refund webhook branch wiring | New RPC/route; `commercial-payment-webhook` edit | Provider receipt ≠ SAFF evidence ≠ tax invoice; refund never auto-mutates a licence | New receipt-completeness test; new refund-branch-routing test | Remove the route; revert the webhook branch to fall through to the prior generic path | No |
| **Ω3.6** SMTP/legal/security launch prerequisites | Operational only — no code | — | — | Custom SMTP configured; Terms/Privacy legally reviewed; CORS-completeness cleanup (optional, low-severity) | N/A | **Yes — infra/legal, not code** |
| **Ω3.7** Flutterwave LIVE acceptance | `admin_transition_platform_state` gains its mechanical-precondition checks (offers exist + purchasable, live key configured); state-gated checkout | `CREATE OR REPLACE` on the Ω3.0 RPC (body-only, no new migration table); `commercial-create-checkout` state check | Sandbox/live keys never ambiguous; `LIVE_ACCEPTANCE` restricted to `is_commercial_admin()` | One real, founder-only, small transaction completes end-to-end (§L) | Revert the RPC body to its bare Ω3.0 form; transition state back to `PAYMENTS_DISABLED`/`SANDBOX_ONLY` — instant, no data impact | **Yes — the one real-money transaction is the gate itself, explicitly authorized separately** |
| **Ω3.8** Customer-payments enablement | Admin transitions state to `CUSTOMER_PAYMENTS_ENABLED` | — (state transition only) | Never automatic; a deliberate, separate, audited admin action | Founder's own sign-off, informed by Ω3.7's result | Transition state back down — instant | **Yes — the launch decision itself** |

This sequence may compress (e.g. Ω3.4/Ω3.5 in one pass) but should not reorder — each phase's acceptance gate is a real precondition for the next, not an arbitrary checkpoint.

---

## Evaluation of the Referenced Codex-Fallback Findings

**Honest disclosure, not a fabricated evaluation:** this session has not been given the text of "the eight generic findings from the failed Codex fallback." No such list appears anywhere in this conversation or in any repository file I have access to. I will not invent eight findings to appear responsive — that would be exactly the kind of fabricated-authority content this project's own discipline (UNKNOWN ≠ ZERO ≠ FALSE, applied here to "unknown input" rather than "unknown financial figure") forbids.

What I *can* do, and have done, is design this document so that if those eight findings were generic commercial-SaaS launch-readiness items (the usual shape of such a list — e.g. "needs a pricing page," "needs an admin bootstrap," "needs a currency registry," "needs a live/sandbox gate," "needs receipts," "needs refund handling," "needs observability," "needs a market model"), every one of those *generic* shapes is already addressed by §C, §F, §G, §H, §J, §K, §M, and §N above — each grounded in this specific repository's actual schema rather than accepted as a generic template. If the actual eight findings differ from this guess in any specific way, they should be diffed directly against the relevant lettered section here; I have not deferred or ignored a category of concern I'm aware of.

**Adoption rule applied throughout, per the mission's explicit instruction:** any generic finding is adopted here **only** where it survives contact with repository truth. Two concrete examples of findings this document would have **rejected** had they been generic-template suggestions, specifically because they'd violate SAFF's orthogonal architecture:
- A generic finding suggesting "derive currency from market" (a common SaaS shortcut, e.g. "TZ market → TZS currency") is **rejected outright** — it would collapse two of the five independent dimensions the Charter above insists stay separate, and is already disproven as SAFF's model by the existing, tested `routing.ts` design (TZS already prices a `GLOBAL` offer today).
- A generic finding suggesting "commercial admin should be a `firm_members` role tier" (also a common shortcut) is **rejected outright** — it would violate §B's accounting/commercial authority separation, which this repository already enforces structurally and which no commercial RPC anywhere currently or should ever cross.

**Status of the Codex fallback review, stated plainly rather than implied:**
```
EXACT_CODEX_FALLBACK_FINDINGS_RECEIVED = NO
EXACT_FINDINGS_EVALUATED = 0/8
CODEX_FINAL_TEXT_REVIEW = DEFERRED_DUE_TO_TOOL_FAILURE
```
Codex's local command runner is reported failing before starting any shell process (`helper_unknown_error: setup refresh had errors`). This is tool unavailability, not a design review outcome — it is not evidence this document is defect-free, and it is not treated as approval. When Codex is available again, it should review this document's actual text (this file), not a description of it — the prior failed attempt's root cause, per the mission brief, was Codex receiving only review criteria rather than the design itself.

---

## Open Architectural Questions (not blockers, need a founder/product decision before or during implementation)

1. Should `set_billing_customer_market` allow **any** authenticated customer to self-select at will, or should a change after an ACTIVE paid licence exists require admin confirmation (to prevent a customer "market-shopping" for a cheaper currency mid-subscription)? This design allows free self-change (F.3) since it never affects an existing licence's already-snapshotted economics — but a product policy may want friction here.
2. `admin_billing_lookup`'s read of `trial_balance_uploads` (§B) — is this narrow cross-domain read something the founder wants preserved, or should it be removed now that a proper Customers/Licences admin UI exists to make it unnecessary?
3. Whether `commercial_platform_state` should be a true singleton (as designed) or should support per-provider states (relevant once a second provider like Stripe exists for GB/EU) — deferred as `ARCHITECTURAL_FUTURE` since only Flutterwave exists today.
4. Exact scope of self-service cancellation (§I) — genuinely deferred, not designed in detail here, since it wasn't required for launch.

## Blockers Identified

**Zero hard blockers to *designing* and *building* Ω3.0–Ω3.6.** The one true blocker to reaching `CUSTOMER_PAYMENTS_ENABLED` is operational, not architectural: `PRODUCTION_AUTH_SMTP_CONFIGURATION_REQUIRED` and `LEGAL_PROFESSIONAL_REVIEW_REQUIRED_BEFORE_PAID_GO_LIVE`, both already registered in CLAUDE.md §9.2, both `MUST_CLOSE_BEFORE_LIVE`, and both outside this repository's ability to close.

## High-Severity Items (non-blocking, must close before real money)

1. Currency/exponent registry + trigger (§G) — must ship before any offer intended for real money is authored (i.e., no later than Ω3.2, strictly before Ω3.7).
2. Six Ω1-era admin RPCs still on the pre-`is_commercial_admin()` inline pattern (§A.2) — functionally correct today, but a maintenance/consistency risk for any future authority change. Close in Ω3.1.

---

## FINAL SUMMARY

```
SAFF Ω∞ Ω3 DESIGN —
REPO HEAD [00b2c4fce7eb1dc475d305ed6ad8fb4d43219f7d] —
DESIGN FILE [SAFF-OMEGA3-COMMERCIAL-LAUNCH-DESIGN.md] —
LINES [1772] —

SECOND CODEX RE-AUDIT — 4 NEW FINDINGS ADDRESSED THIS PASS
(1 BLOCKER, 1 HIGH, 2 MEDIUM; the four ORIGINAL findings from the first
re-audit remain closed and are unaffected by this pass):

  FINDING 1 — BLOCKER (fail-closed legacy-history classification) —
    CORRECTED. The audit-trail-dependent backfill (`is_purchasable OR
    EXISTS (... commercial_catalog_audit_events ...)`) is replaced with
    an unconditional classification: every pre-existing commercial_offers
    row is set effective_history_protected = true, full stop, with no
    dependency on is_purchasable or audit-trail completeness of any kind.
    Two executable, uncaught `DO $$ ... RAISE EXCEPTION $$` preflight
    blocks run inside the same migration transaction — one proving the
    classified count equals the total legacy count, one scanning for
    five-dimensional effective-range conflicts among protected rows — and
    either one aborts the ENTIRE Ω3.0 migration (not just the exclusion
    constraint) if it fails. The column is renamed from
    was_ever_purchasable to effective_history_protected throughout the
    entire document, since the old name became factually false once
    legacy rows are classified conservatively rather than from genuine
    purchase history. New §E.2 point 6a; new Test F (7 sub-cases,
    matching every scenario the mission required).
  FINDING 2 — HIGH (constraint-specific exception translation) —
    CORRECTED. Both admin_supersede_commercial_offer's and
    admin_upsert_commercial_offer's exception handlers now call
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME inside
    each WHEN clause, compare it by exact string equality against the one
    named constraint that handler exists for, and fall through to a bare
    `RAISE;` — no arguments, full SQLSTATE/message/diagnostic-context
    preservation — for anything else. No WHEN OTHERS, no SQLSTATE-only
    translation, no message-text parsing anywhere in either function. New
    Test G, G-A through G-E mapped 1:1 to Codex's own lettering.
  FINDING 3 — MEDIUM (exact constraint reconciliation) — CORRECTED.
    MODIFIED_EXISTING_NAMED_CONSTRAINTS is corrected from the prior
    draft's 0 to 1 (chk_ccae_entity_type, on commercial_catalog_audit_
    events — genuinely modified, not merely "extended vocabulary" filed
    under a separate heading). Three categories now kept strictly
    separate everywhere in this document: constraints created on new
    tables (7), new constraints added to an existing table (1), existing
    constraints replaced (1).
  FINDING 4 — MEDIUM (DDL replacement and privilege accounting) —
    CORRECTED. DATA_DESTRUCTIVE_OPERATIONS = 0, DDL_REPLACEMENT_
    OPERATIONS = 2 (chk_ccae_entity_type, uq_co_current_offer) replace
    the prior draft's "purely additive"/"no DROP" framing. A full
    privilege matrix is added for all 16 RPCs (SECURITY DEFINER, fixed
    search_path, PUBLIC/anon/authenticated grant-or-revoke, internal
    authorization predicate, tables read/written) and both new tables
    (RLS policy / table grant / RPC execution grant / service-role
    bypass / ownership kept as five distinct concerns) — see §Q's new
    Privilege Matrix subsection.

EXISTING FOUNDATION REUSED [YES — every Ω1/Ω2 table, RLS policy, and
  payment-verification RPC (resolve_commercial_offer,
  commit_verified_commercial_payment, Gate A/B) is reused byte-identical;
  the exclusion constraint and its widened key reuse the identical
  btree_gist/tstzrange/EXCLUDE USING gist pattern already live on
  commercial_licences; the idempotency fingerprint reuses pgcrypto's
  digest(), also already live since Ω1] —

NEW SCHEMA — exact counts, not approximate, reconciled across §A/§D/§E.1/
§E.2/§G.2/§Q/§R/§S/Error Code Reference/Final Summary this pass:
  new tables:                            2   (commercial_currencies, commercial_platform_state)
  constraints on new tables:             7   (commercial_currencies: 3; commercial_platform_state: 4 — Finding 3, Category 1)
  new constraints on existing tables:    1   (excl_co_no_overlapping_purchasable_periods on commercial_offers — Finding 3, Category 2)
  modified existing named constraints:   1   (chk_ccae_entity_type — Finding 3, Category 3; CORRECTED from the prior draft's 0)
  dropped/recreated (DDL-replaced) indexes: 1  (uq_co_current_offer, widened 3→5 column key)
  DDL replacement operations:            2   (chk_ccae_entity_type; uq_co_current_offer — Finding 4; neither data-destructive)
  data-destructive operations:           0
  new columns:                           4   (billing_customers.commercial_market;
                                               commercial_offers.effective_range,
                                               .effective_history_protected, .request_fingerprint)
  trigger functions:                     2   (commercial_offers_economic_integrity, commercial_offers_effective_history_ratchet)
  triggers:                              2   (one per function above, both BEFORE INSERT OR UPDATE ON commercial_offers)
  modified existing RPCs:                1   (admin_upsert_commercial_offer — exclusion-violation handler only, now constraint-name-verified)
  new RPCs:                             16   (enumerated by name AND full privilege row in §Q — not "~16")
  new RLS policies:                      2   (cc_select_public, cps_select_admin_only — one per new table)
  modified existing RLS policies:        0
  privilege grants (object-role edges):  17 function EXECUTE grants + 5 table privilege grants = 22
  privilege revokes (object-role edges): 31 function EXECUTE revokes + 4 table privilege revokes = 35
    (counted per object-role privilege edge, one method throughout — see §Q's Privilege Matrix for the exact derivation)
  extensions:                            0 new (btree_gist + pgcrypto both already live since Ω1)
  backfills / data-classification ops:   1   (effective_history_protected — CORRECTED this pass from audit-trail-dependent to
                                               unconditional/evidence-independent, with 2 executable fail-closed preflight checks)
  migration files:                       7   (unchanged count; Ω3.0's content grew again, phase count did not)
  hostile tests (this design's own):     Tests A/B(×3)/C(×2)/D(×4)/E(×2)/F(×7)/G(×5) for
                                          effective-history+supersession+legacy-classification+
                                          exception-translation alone, plus every Error-Code-
                                          Reference row's own listed test — full enumeration in §R.
  CHECK-vocabulary widening:             1   (commercial_catalog_audit_events.entity_type:
                                              'OFFER','PLAN' → 'OFFER','PLAN','ADMIN','PRODUCT')

MARKET AUTHORITY [billing_customers.commercial_market — explicit, customer/admin-settable, checkout-enforced MARKET_MISMATCH/MARKET_NOT_SET rejection, never derived from jurisdiction/locale/currency/TIN] —
CURRENCY AUTHORITY [commercial_currencies registry — sole exponent authority, enforced exclusively by commercial_offers_economic_integrity() (no duplicate/competing check in any RPC), entirely independent of market per the Dimensional Independence Charter; TZS locked to exponent 0] —
OFFER EFFECTIVE-HISTORY CONCURRENCY [excl_co_no_overlapping_purchasable_periods — key now 5 columns (plan_id, market_code, currency_code, billing_interval, billing_interval_count), predicate (effective_history_protected) alone, zero mutable fields anywhere in either the key's protection scope or the predicate; uq_co_current_offer widened to match (DDL replacement); every pre-existing row protected unconditionally, with the whole Ω3.0 migration aborting on any detected legacy conflict (Finding 1); deterministic errors OFFER_EFFECTIVE_PERIOD_CONFLICT/OLD_OFFER_NOT_FOUND/OLD_OFFER_NOT_SUPERSEDABLE/OFFER_FAMILY_MISMATCH/INVALID_EFFECTIVE_BOUNDARY/LEGACY_CLASSIFICATION_INCOMPLETE/LEGACY_EFFECTIVE_RANGE_CONFLICTS_DETECTED, all translated only after GET STACKED DIAGNOSTICS confirms the exact constraint name (Finding 2); Tests A-G specified but NOT executed in this DB-less environment] —
SUPERSESSION SAFETY [admin_supersede_commercial_offer — SELECT...FOR UPDATE predecessor lock, post-lock idempotency recheck, same-5-column-family validation, boundary validation, key IS the existing offer_code column, uniqueness boundary IS the existing uq_co_offer_code constraint, fingerprint via pgcrypto digest() over 9 fixed parameters, exception handling verifies exact constraint identity before any translation and bare-RAISEs everything else — no WHEN OTHERS, no SQLSTATE-only translation, no message-text parsing anywhere] —
COMMERCIAL_ADMIN AUTHORITY [is_commercial_admin() reused unchanged; bootstrap via a service-role-only Edge Function (no RLS/browser attack surface), ordinary grants/revokes via admin-gated RPCs, sole-admin lockout guard, no new admin tier; every one of the 16 new RPCs carries an explicit REVOKE-then-GRANT set — none rely on PostgreSQL's default function privileges] —
ACCOUNTING AUTHORITY SEPARATION [PASS — confirmed by direct inspection of every commercial function body; one narrow, deliberate, read-only exception (admin_billing_lookup reading trial_balance_uploads for support context) explicitly registered, not hidden] —
LIVE GATES [4-state DB-authoritative machine: PAYMENTS_DISABLED → SANDBOX_ONLY → LIVE_ACCEPTANCE (admin-only checkout) → CUSTOMER_PAYMENTS_ENABLED, orthogonal to the Flutterwave secret-key choice, each transition audited and admin-gated] —
IMPLEMENTATION PHASES [9] —

FILE_NAME = SAFF-OMEGA3-COMMERCIAL-LAUNCH-DESIGN.md —
CODEX_FINDING_1_CORRECTED = YES —
CODEX_FINDING_2_CORRECTED = YES —
CODEX_FINDING_3_CORRECTED = YES —
CODEX_FINDING_4_CORRECTED = YES —
UNRESOLVED_BLOCKERS = 0 —
UNRESOLVED_HIGH_FINDINGS = 0 —
UNRESOLVED_MEDIUM_FINDINGS = 0 —

READY_FOR_CODEX_REAUDIT = YES —
READY_FOR_DESIGN_CHECKPOINT = NO — Codex alone issues the audit gate; this document does not claim checkpoint approval —
READY_FOR_IMPLEMENTATION = NO —
DOCUMENT_MODIFIED = YES —
IMPLEMENTATION_PERFORMED = NO —
MIGRATION_CREATED = NO —
COMMIT_CREATED = NO —
PUSH_PERFORMED = NO —
DEPLOYMENT_PERFORMED = NO —
PRODUCTION_CHANGED = NO
```
