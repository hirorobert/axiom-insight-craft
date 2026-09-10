# Ω3-CHECKOUT — Commercial Architecture Audit

Design/audit document. No source code in this file describes a change that has been made — every "MUST CHANGE" reference is a proposal, detailed further in `IMPLEMENTATION_PLAN.md`.

**Design-correction round (this revision):** an independent review found the first draft's resolver signature invalid Postgres, its concurrency design non-atomic, its commit-locking granularity wrong, and its checkout contract carrying a client-supplied market it should not have accepted. This revision resolves each finding; see `DATA_CONTRACTS.md` for the exact corrected SQL/TypeScript, `THREAT_AND_FAILURE_MODEL.md` for the re-audited concurrency scenarios, and `IMPLEMENTATION_PLAN.md` for the updated file-change slices. This document's own §3, §4, §7, and §9 (new) are updated in place below.

## 1. System inventory (what exists today, with provenance)

### 1.1 Database — migration lineage

| Migration (live, applied) | Wave | What it created |
|---|---|---|
| `20260905093408_8fc55e64-3e06-4d26-8835-438a9243e1ef.sql` | Ω1 | `commercial_admins`, `commercial_products`, `commercial_plans`, `billing_customers`, `commercial_licences` (+ `excl_cl_no_overlapping_authoritative_periods` GiST EXCLUDE), `payment_events` (idempotency_key UNIQUE, append-only), `entitlement_overrides`, `billing_audit_events` (append-only); RPCs `_resolve_entitlement_for_owner`, `get_effective_entitlement`, `get_my_billing_summary`, `admin_grant_commercial_licence`, `admin_transition_licence_status`, `admin_grant_entitlement_override`, `admin_revoke_entitlement_override`, `admin_billing_lookup`, `provision_billing_customer_for_company` (auto-provisions FREE on company insert, hardcoded to the `'SAFF_ERP'` product — see §3a) |
| `20260905141022_f1029fbe-90d5-4aac-97e0-059eede76338.sql` | RLS1 | `is_commercial_admin()` SECURITY DEFINER helper (fixes an RLS recursion defect); rewrites 6 policies to use it |
| `20260906083524_eca6c272-4a62-4468-995b-1c70e2cd67e5.sql` | Ω2-G | `commercial_offers` (original 3-col `uq_co_current_offer`), `commercial_catalog_audit_events`, `resolve_commercial_offer(p_plan_code, p_market_code DEFAULT 'GLOBAL')` (no interval param, no product scoping — see §3a/§4), `admin_upsert_commercial_offer` (same unscoped-plan-lookup defect), `admin_list_commercial_offers`, `payment_checkout_intents` (`saff_reference` UNIQUE, `expires_at` default +1h), `payment_webhook_receipts` (immutable observation), `payment_webhook_processing_events` (immutable, one row per attempt), extends `payment_events`, `commit_verified_commercial_payment()`, `record_payment_reversal()`, `get_checkout_status()`, `admin_get_billing_detail()`; `REVOKE UPDATE, DELETE ON commercial_licences FROM authenticated` |
| `20260906120000_omega3_0_effective_history_and_platform_state.sql` | Ω3.0 | `commercial_currencies` (exponent registry), `commercial_platform_state` (singleton state machine, starts `PAYMENTS_DISABLED` — **created, but read by zero Edge Functions today**, see §3b); `effective_range`/`effective_history_protected`/`request_fingerprint` on `commercial_offers`; **drops and widens `uq_co_current_offer` to 5 columns**; adds `excl_co_no_overlapping_purchasable_periods`; `admin_supersede_commercial_offer()`; `admin_transition_platform_state()` |

No migration after Ω3.0 touches any commercial/payment table. Two source-authored duplicates for Ω1/RLS1/Ω2 are quarantined under `supabase/migrations_historical/*.sql.historical`, proven non-executable and semantically identical to the live files by `migrationCollisionGuard.test.ts`.

### 1.2 Edge Functions

| Function | Role | Auth |
|---|---|---|
| `commercial-create-checkout` | Resolves offer, routes provider, creates checkout intent, calls Flutterwave | `validateAuth` (JWT), no admin requirement; **does not read `commercial_platform_state` today (§3b)** |
| `commercial-payment-webhook` | Receives provider webhook, two-gate verify, commits payment | Public endpoint, authenticated only by Gate A (verif-hash) |
| `commercial-payment-status` | Owner-scoped poll for `PaymentReturn.tsx` | `validateAuth` (JWT), calls `get_checkout_status` as the caller (anon key + forwarded bearer token, not service role) |

Shared modules: `_shared/payments/{money,contracts,routing,authority}.ts`, `_shared/payments/providers/flutterwave.ts`.

### 1.3 Frontend

- `src/pages/Pricing.tsx` — presentation only today. Displays `PRICING.MONTHLY_USD`/`ANNUAL_USD` (49/499, hardcoded display constants in `src/constants/copy.ts`), a monthly/annual toggle that only changes what is *displayed*, and a locked "Secure self-service checkout is being activated" panel. Its own header comment already anticipates this exact mission.
- `src/components/commercial/CheckoutUpgradeButton.tsx` — the one live entry point that calls `resolve_commercial_offer` (display) and `createCheckoutIntent` (checkout). Accepts an optional `marketCode` prop today — **removed under this design** (§ below, item 2).
- `src/lib/commercial/commercialRpc.ts` — sole typed RPC/HTTP boundary.
- `src/pages/billing/PaymentReturn.tsx` — polls `commercial-payment-status`; renders confirmed/failed/cancelled/timeout states from server-returned status only.
- `src/lib/commercial/billingDisplay.ts`, `entitlementContract.ts` — display/derivation helpers, fail-closed (Mission B / prior work).

### 1.4 Payment (Flutterwave)

`_shared/payments/providers/flutterwave.ts` implements `ProviderAdapter`: `createCheckout`, `verifyWebhookAuthenticity` (Gate A), `normalizeWebhook`, `verifyTransaction` (Gate B).

**Finding — stale branding in the live checkout payload, expanded to a full identity-correction requirement (item 11):** `flutterwave.ts:147-155` sends `customizations.title: 'SAFF ERP'`, `logo: 'https://cfoclose.com/favicon.ico'` (a file this repo already deleted; also wrong format — Flutterwave expects a raster image, not the SVG that replaced it), and `meta.source: 'SAFF_ERP_OMEGA2'` to Flutterwave's hosted payment page — a real CFOClose customer would see "SAFF ERP" mid-payment. The full correction (exact field values, new-reference-prefix policy distinguishing forward-only changes from historical-evidence columns that must never be renamed, and a two-phase redirect-env-var migration path if one is found at implementation time) is specified in `DATA_CONTRACTS.md` §9.

### 1.5 Tests inspected (Step 1 requirement, unchanged from the prior round)

Real production-source coverage: `edgeMoney.test.ts`, `edgeFlutterwaveGateB.test.ts`, `webhookEvidenceModel.test.ts`, `globalCommerceModel.test.ts`, `marketPropagation.test.ts` (**retired under this design** — asserts a `marketCode` propagation contract this design removes; a replacement `DISPLAY_INTERVAL == CHECKOUT_INTERVAL` guard is specified in `ACCEPTANCE_MATRIX.md`), `authContractRepair.test.ts`, `migrationCollisionGuard.test.ts`, `omega3_0FoundationMigration.test.ts`, `routing.test.ts`, `CheckoutUpgradeButton.test.ts` (several of its assertions also reference the now-removed `marketCode` prop and will need updating), `entitlementContract.test.ts`.

**Finding — shadow test suite with zero coverage of production code (unchanged):** `checkoutFlow.test.ts`, `atomicCommit.test.ts`, `paymentSecurity.test.ts`, `webhookSecurity.test.ts` import only `paymentTypes.ts`/`paymentAuthority.ts`, neither of which any production code imports. See `IMPLEMENTATION_PLAN.md` for disposition (unchanged: MAY CHANGE, not required to ship).

## 2. No implementation performed

Nothing in this document, or any other document in this package, has been applied to the repository's source, schema, or Supabase project.

## 3. The commercial-model requirements, corrected

### 3a. New finding — product binding (item 3), confirmed by direct source read

`commercial_plans` carries `UNIQUE (product_id, code)` (`20260905093408...sql:68`), **not** a global uniqueness on `code` alone. `commercial_products` has exactly one seeded row today (`code = 'SAFF_ERP'`, `:312`), so the gap has never manifested — but two functions resolve a plan by `code` with **no product scoping at all**:

- `resolve_commercial_offer` (Ω2-G, `:117`): `SELECT id INTO v_plan_id FROM public.commercial_plans WHERE code = p_plan_code AND is_active;`
- `admin_upsert_commercial_offer` (Ω2-G, `:215`): `SELECT id INTO v_plan_id FROM public.commercial_plans WHERE code = p_plan_code;`

A bare `SELECT ... INTO` in PL/pgSQL without `STRICT` does not raise on multiple matches — it silently binds to one, unordered. If a second product were ever created with its own `PAID` plan code, both functions above would non-deterministically resolve to whichever product's plan Postgres happened to return first. The correct, already-established precedent in the **same migration** is `admin_grant_commercial_licence` (`:573-580`), which resolves `v_product_id` from `billing_customers.product_id` first, then scopes the plan lookup to it. **Corrected `resolve_commercial_offer` now follows this precedent** (`DATA_CONTRACTS.md` §1) — resolving the caller's product from their own `billing_customers` row when authenticated, and from a new, single, explicitly-named `commercial_default_product_id()` helper (not a second guessing mechanism — it names the exact hardcoded lookup `provision_billing_customer_for_company` already performs) for the anonymous/pre-signup case. `admin_upsert_commercial_offer`'s identical defect is a **MUST CHANGE** carried into `IMPLEMENTATION_PLAN.md` alongside the resolver fix, since it is the same bug in a sibling function.

### 3b. New finding — `commercial_platform_state` is created but never enforced (item 4)

Confirmed by direct source read of `commercial-create-checkout/index.ts` in the prior audit round and re-confirmed here: the function never queries `commercial_platform_state` at all. The Ω3.0 singleton state machine (`PAYMENTS_DISABLED → SANDBOX_ONLY → LIVE_ACCEPTANCE → CUSTOMER_PAYMENTS_ENABLED`) exists in the database, starts at `PAYMENTS_DISABLED`, and today has **zero effect on runtime behavior** — the Edge Function would happily process a real checkout regardless of the singleton's value, because nothing reads it. This is not a defect in Ω3.0 itself (it was scoped there as schema-only, per that migration's own "bare, Ω3.0-scoped implementation" note, confirmed in the prior audit round) — it is a genuine, previously-unaddressed gap in this design's own scope: the platform-state gate is the mechanism this whole design relies on to let the team exercise SANDBOX_ONLY/LIVE_ACCEPTANCE flows before real customer traffic, and until it is wired in, `commercial_platform_state`'s value is decorative. The exact gate contract is specified in `DATA_CONTRACTS.md` §2 and §10 (the full state × environment × identity matrix).

### 3c. Corrected requirements table

| # | Requirement | Status | Evidence |
|---|---|---|---|
| A | USD 49/month and USD 499/year must be authoritative server-side offers | **NOT MET TODAY, corrected seeding policy** | Both USD offers must be created **non-purchasable** (`is_purchasable = false`) at seed time; activation is a separate, later, explicitly audited admin operation gated on staging acceptance — see `DATA_CONTRACTS.md` §5. This corrects the prior round's implicit assumption that seeding and activation were one step. |
| B | Frontend never authoritative for price/currency/amount_minor/provider/entitlement/licence state | **MET, and now stricter** | The browser-supplied surface is now smaller than before: `{planCode, billingInterval}` only — `marketCode` is removed entirely (item 2), not merely defaulted. Market is a server-side literal `'GLOBAL'`. |
| C | Billing interval explicit end-to-end (MONTHLY/ANNUAL) | **Resolver fix now syntactically valid** | The corrected 3-arg signature places `p_billing_interval` before the defaulted `p_market_code`, avoiding the invalid-Postgres ordering the prior draft proposed; NULL/invalid interval is handled by an explicit `IF` in the function body, never a `NOT NULL` parameter annotation (not valid syntax) and never a silent default. |
| D | Server resolves exact offer | **MET (mechanism), now also product-scoped** | See §3a. |
| E | Monthly/annual must never resolve ambiguously | **Structurally prevented at storage (§5, unchanged), resolver-level fix now product-safe too** | |
| — | **Launch product framing (item 8, new requirement)** | **Corrected** | This design ships a **prepaid term licence with manual renewal** — a successful payment buys a fixed period (`effective_start` → `effective_end`), full stop. Nothing in this design implements, claims, or implies automatic recurring billing, automatic renewal, or provider-initiated subscription cancellation. `commit_verified_commercial_payment`'s existing period-closeout logic is period arithmetic on a term licence, not subscription-cycle management — this was always true of the underlying schema (`commercial_licences.effective_start/effective_end`, no `next_billing_date`/`subscription_id`/`cancel_at_period_end` column exists anywhere in the schema), but the prior draft's prose occasionally used "renewal" in a way that could be misread as automatic; every reference to "renewal" in this package now means **the customer manually initiating a new checkout for a new term**, and `IMPLEMENTATION_PLAN.md` records recurring billing as an explicit, later, separate phase. |
| — | **Pricing truth (item 9, new requirement)** | **Corrected** | The DB commercial offer is the sole authority; `/pricing` must render the resolved server amount for the selected interval, not a static constant, once checkout is enabled there. A static-constant/DB mismatch must **disable checkout and raise an acceptance failure** — never silently display one number and charge another. See `IMPLEMENTATION_PLAN.md` §5 for the exact parity-check mechanism, and note the prior round's speculative `list_purchasable_commercial_offers()` function is **withdrawn** (no proven caller). |
| — | **Public /pricing authentication behavior (item 10, new requirement)** | **Newly specified** | See `DATA_CONTRACTS.md`-adjacent design in `IMPLEMENTATION_PLAN.md` §1 and `ACCEPTANCE_MATRIX.md` item 10: an unauthenticated interval selection routes to sign-in/signup with the chosen interval preserved safely (a UI preference carried via a query param or session storage key, never trusted as a price — the authenticated resolver call re-resolves the real price regardless of what was carried through); an authenticated user's own billing state (`get_my_billing_summary`) gates whether an inappropriate purchase CTA (already-PAID/GRACE) is shown, reusing the existing `shouldShowUpgradeAction` logic unchanged. |
| F–P | (Checkout snapshot immutability, provider callback non-authority, webhook Gates A/B, licence activation authority, FREE/PAID/Tanzania non-regression, sandbox-offer non-purchasability, uniqueness/exclusion constraints) | **Unchanged from the prior audit round — still MET**, re-verified against the corrected design and found not to regress it | The corrected resolver, atomic checkout-intent design, and customer-level commit lock (§4, §6 below) touch none of the mechanisms these requirements depend on. |

## 4. Resolver contract — corrected signature and deployment discipline

The prior round's *conceptual* recommendation (require interval explicitly; add a separate read-only listing function for interval-independent needs) is **partially retained and partially corrected**:

- **Retained:** interval must be a required parameter — the reasoning (exactly one caller in the repository, an optional param is a permanent ambiguity foot-gun once dual pricing ships) still holds.
- **Corrected — parameter ordering:** the prior draft placed the new required `p_billing_interval` *after* the already-defaulted `p_market_code`, which Postgres rejects outright (`CREATE FUNCTION` requires every parameter after the first defaulted one to also carry a default). The corrected signature is `resolve_commercial_offer(p_plan_code TEXT, p_billing_interval TEXT, p_market_code TEXT DEFAULT 'GLOBAL')` — required parameters first, defaulted parameter last.
- **Corrected — no `NOT NULL` in the parameter list:** the prior draft's prose annotated the interval parameter as `TEXT NOT NULL`, which is not valid `CREATE FUNCTION` syntax (parameters cannot carry a `NOT NULL` constraint; only table columns can). The corrected function instead validates `p_billing_interval IS NULL OR ... NOT IN (...)` as the **first statement in the function body**, returning an explicit `UNKNOWN`/`UNKNOWN_OR_MISSING_BILLING_INTERVAL` result — fail-closed, but via ordinary PL/pgSQL control flow, not invalid syntax.
- **Corrected — overload awareness:** `CREATE OR REPLACE FUNCTION` does not replace a function when the parameter type list changes; it adds a second, overloaded entry. The 2-arg `resolve_commercial_offer(TEXT, TEXT)` remains live and callable (still granted to `anon, authenticated`) unless explicitly revoked and dropped. This is corrected with an explicit `REVOKE ALL ... ; DROP FUNCTION ...` step, sequenced strictly **after** the Edge Function that calls the new 3-arg overload has been confirmed deployed (`DATA_CONTRACTS.md` §1's three-phase deployment order) — never bundled into the same migration as the new function's creation, to avoid a window where either the old overload is gone before the new caller is live, or the new caller expects behavior the old overload's ambiguous 2-arg semantics would have masked.
- **Withdrawn:** the prior round's proposed `list_purchasable_commercial_offers()` read-only function is removed from this design entirely — no caller was ever proven for it (item 9).
- **New, tied to item 3:** the corrected resolver also resolves the caller's product via `billing_customers.product_id` (authenticated) or `commercial_default_product_id()` (anonymous), closing the cross-product ambiguity defect independently confirmed in §3a.

## 5. Offer uniqueness — audit, unchanged from the prior round, now paired with non-purchasable seeding

Ω3.0's 5-column `uq_co_current_offer` and `excl_co_no_overlapping_purchasable_periods` already support one MONTHLY + one ANNUAL PAID/GLOBAL/USD offer with no ambiguity — this finding is unchanged and re-confirmed. What changes under this correction round is **when** the two new rows become chargeable: they are created `is_purchasable = false` (item 12) and activated only via a later, separately-audited `admin_supersede_commercial_offer` call once every staging gate in `ACCEPTANCE_MATRIX.md` passes — so the uniqueness/exclusion constraints protect a non-purchasable row from day one of its existence, with zero window where a half-configured offer could be accidentally charged against.

## 6. Concurrency — corrected to a fully atomic, database-enforced design

See `THREAT_AND_FAILURE_MODEL.md` for the complete, re-audited scenario table. Summary of what changed:
- **Checkout-intent acquisition (item 5):** the prior round's Edge-Function-level `SELECT`-then-`INSERT` reuse check is **replaced** with a single atomic RPC (`acquire_or_reuse_checkout_intent`, `DATA_CONTRACTS.md` §6) using a transaction-scoped advisory lock keyed on `(billing_customer_id, offer_id)`, a deterministic in-function staleness sweep, explicit handling of a CREATED-row-without-a-URL (the crash-recovery case), and a two-step Edge Function protocol (commit the intent row first, call the provider second, record the URL third) so a crash between provider-link creation and DB persistence leaves a safely-supersedable row rather than an ambiguous one.
- **Payment commit (item 6):** `commit_verified_commercial_payment`, previously assessed as needing no change, is **corrected to MUST CHANGE** — it gains a customer-level (not merely intent-level) advisory lock, acquired before re-reading the customer's current licence state, so two different successful payments for the same customer are strictly serialized rather than racing to close out the same licence row concurrently. This removes the only path by which a genuinely-verified provider charge could hit the GiST exclusion constraint and be left in an undefined state — the failure mode is now structurally unreachable, not merely caught after the fact.

## 7. Payment authority chain — full trace, corrected for the platform-state gate, product binding, and customer-level commit lock

```
Browser (CheckoutUpgradeButton)
  → sends { planCode, billingInterval }   [no price, no currency, no amount, no market — see item 2]
  ↓
commercial-create-checkout (Edge Function)
  1. validateAuth(authHeader, CORS_HEADERS)                          — reject unauthenticated (401)
  2. Platform-state gate (NEW, item 4): read commercial_platform_state; fail closed on
     PAYMENTS_DISABLED / missing-or-invalid row / provider-environment mismatch / a restricted
     state reached by a non-restricted identity (DATA_CONTRACTS.md §10 matrix)
  3. supabase.rpc('resolve_commercial_offer', {p_plan_code, p_billing_interval, p_market_code:'GLOBAL'})
     — server resolves the ONE authoritative offer, product-scoped via the caller's own
       billing_customers row (item 3); browser input never reaches pricing or product selection
  4. UNKNOWN(404) / NOT_AVAILABLE(402) / AMBIGUOUS(500, never guessed) / AVAILABLE → proceed
  5. selectPaymentProvider(offer, getConfiguredProviders())           — routing, never re-prices
  6. acquire_or_reuse_checkout_intent(...) RPC (NEW, item 5)          — atomic acquire/reuse,
     advisory-locked per (billing_customer, offer); REUSED short-circuits to the existing
     checkout_url; NEW proceeds to step 7
  7. adapter.createCheckout(...)                                     — Flutterwave hosted page,
     with corrected CFOClose branding (item 11); amount NOT in the returned URL
  8. UPDATE payment_checkout_intents SET checkout_url, status='PENDING' (narrow, guarded UPDATE —
     the second half of the two-step protocol that makes crash recovery well-defined)
  ↓
Flutterwave hosted checkout (outside this system's trust boundary)
  ↓
commercial-payment-webhook (Edge Function, public endpoint) — UNCHANGED by this design except the
  Gate B transient/definitive split (item 7):
  1. INSERT payment_webhook_receipts (immutable, BEFORE any verification)
  2. Gate A: adapter.verifyWebhookAuthenticity(rawBody, headers)
  3. adapter.normalizeWebhook(rawBody)
  4. load intent by saff_reference; application-level replay pre-check (fast path, not the safety net)
  5. Gate B: adapter.verifyTransaction(...) — definitive mismatch/forgery still rejected outright;
     a transient network/5xx failure now returns a distinct, RETRIABLE outcome (500 to Flutterwave,
     triggering its own redelivery) instead of being folded into the same bucket as a genuine mismatch
  6. authoriseCommit(intent, transaction)                             — 3rd layer, unchanged
  7. commit_verified_commercial_payment(...) RPC (service_role, SECURITY DEFINER)
     — idempotency_key check FIRST; SELECT...FOR UPDATE on the intent row; NEW: customer-level
       advisory lock (item 6) acquired before re-reading and closing out the current licence;
       re-validates status/expiry/amount/currency; closes out any existing ACTIVE/GRACE period
       (this term licence's manual-renewal closeout, not a subscription-cycle operation — item 8);
       inserts the new licence period; records billing_audit_events
  8. record processing outcome → payment_webhook_processing_events (append-only)
  ↓
Reconciliation (NEW, item 7, design-only — not implemented): a scheduled job periodically checks
  for PENDING intents with no corresponding payment_events row past a threshold, and feeds any
  discovered paid-but-uncommitted transaction through the SAME two-gate verification and the SAME
  commit_verified_commercial_payment RPC — never a lesser-authority shortcut.
  ↓
Licence transition committed → get_effective_entitlement / _resolve_entitlement_for_owner reflect it
  ↓
PaymentReturn.tsx polls commercial-payment-status → get_checkout_status (owner-scoped, caller's own JWT)
```

**Bypass-point analysis:** unchanged conclusion from the prior round — no point in this chain accepts untrusted input as authoritative, and the corrected design narrows the browser's influence further (no market, product resolved server-side) rather than widening it anywhere.

## 8. Security / RLS audit

Unchanged from the prior round — re-verified against the corrected design and found not to regress: `REVOKE UPDATE, DELETE ON commercial_licences FROM authenticated`; append-only triggers on the five evidence/audit tables; `commit_verified_commercial_payment`/`record_payment_reversal` remain service-role-only (the new customer-level lock is internal to the function body, not a new grant); `resolve_commercial_offer` remains `anon, authenticated` (still read-only/STABLE, still returns only public catalogue facts); `admin_*` functions remain `is_commercial_admin()`-gated with a required reason; `commercial_platform_state` remains `authenticated`-SELECT-only, admin-write-only. The new `acquire_or_reuse_checkout_intent` RPC (item 5) is `SECURITY DEFINER`, callable only from `commercial-create-checkout` (service-role invocation, not granted to `anon`/`authenticated` directly) — it performs no action an authenticated customer's own request wouldn't already be entitled to trigger indirectly through the Edge Function, but is not itself a customer-callable RPC, consistent with `commit_verified_commercial_payment`'s existing service-role-only pattern.
