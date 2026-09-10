# Ω3-CHECKOUT — Commercial Architecture Audit

Design/audit document. No source code in this file describes a change that has been made — every "MUST CHANGE" reference is a proposal, detailed further in `IMPLEMENTATION_PLAN.md`.

**Design-correction round (revision 1):** an independent review found the first draft's resolver signature invalid Postgres, its concurrency design non-atomic, its commit-locking granularity wrong, and its checkout contract carrying a client-supplied market it should not have accepted. Resolved; see `DATA_CONTRACTS.md`.

**Design-correction round 2 (this revision):** a second independent review found that revision 1's own product-scoping fix for `resolve_commercial_offer` relied on `auth.uid()`, but `commercial-create-checkout` calls every RPC through a **service-role client**, where `auth.uid()` is always `NULL` — meaning the fix would have silently never activated for its actual caller. Also found: no privilege DDL was specified for the new functions; the checkout-intent supersession design could steal a live in-flight lease; the offer-activation plan pointed at a function (`admin_supersede_commercial_offer`) that cannot do what was asked of it; `admin_upsert_commercial_offer` still has no product identifier; the webhook CHECK constraint was never given exact migration DDL; reconciliation was left as an unresolved "Edge Function or pg_cron" choice; the platform-state gate checked an arbitrary provider array index instead of the actually-selected provider; and the GLOBAL-only checkout decision's effect on Tanzania offers was understated. All resolved below and in `DATA_CONTRACTS.md` §1–9, `THREAT_AND_FAILURE_MODEL.md`, `ACCEPTANCE_MATRIX.md`, and `IMPLEMENTATION_PLAN.md`.

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

### 3a. New finding — product binding (item 3, round 1), confirmed by direct source read, corrected for service-role context (item 1, round 2)

`commercial_plans` carries `UNIQUE (product_id, code)` (`20260905093408...sql:68`), **not** a global uniqueness on `code` alone. `commercial_products` has exactly one seeded row today (`code = 'SAFF_ERP'`, `:312`), so the gap has never manifested — but **three** functions resolve a plan by `code` with **no product scoping at all** (the third confirmed only in round 2's re-review):

- `resolve_commercial_offer` (Ω2-G, `:117`): `SELECT id INTO v_plan_id FROM public.commercial_plans WHERE code = p_plan_code AND is_active;`
- `admin_upsert_commercial_offer` (Ω2-G, `:215`): `SELECT id INTO v_plan_id FROM public.commercial_plans WHERE code = p_plan_code;`
- `admin_supersede_commercial_offer` (Ω3.0, `:475`): `SELECT id INTO v_plan_id FROM public.commercial_plans WHERE code = p_plan_code;` — the identical defect, newly confirmed this round, flagged but explicitly left out of this design's own scope (`DATA_CONTRACTS.md` §5) since fixing it touches a much larger, already-shipped, fingerprint-idempotency-sensitive function for a bug with no live impact today.

A bare `SELECT ... INTO` in PL/pgSQL without `STRICT` does not raise on multiple matches — it silently binds to one, unordered. The correct, already-established precedent in the Ω1 migration is `admin_grant_commercial_licence` (`:573-580`), which resolves `v_product_id` from `billing_customers.product_id` first, then scopes the plan lookup to it.

**Round 1's fix was itself defective, and round 2 corrects it:** round 1's `resolve_commercial_offer` resolved product via `auth.uid()`. But `commercial-create-checkout` — the function's only real checkout-adjacent caller — invokes every RPC through `createClient(SUPABASE_URL, SERVICE_KEY)` (`commercial-create-checkout/index.ts:92`, confirmed by direct read this round), and **`auth.uid()` is always `NULL` inside a database call made via a service-role client**, regardless of which customer triggered the request. Round 1's fallback (`IF v_product_id IS NULL THEN v_product_id := commercial_default_product_id()`) would therefore fire on *every single checkout*, silently reintroducing exactly the ambiguity the fix was meant to close — the round-1 design would have looked correct in isolation and failed exactly at its one real call site.

**Corrected in round 2 by splitting into two functions** (`DATA_CONTRACTS.md` §1): `resolve_commercial_offer` (§1a) keeps the `auth.uid()`-based lookup, but is now documented and scoped as **display-only**, correct precisely because the frontend calls it directly with the user's own forwarded session (where `auth.uid()` genuinely works) — never from a service-role context. A new function, `resolve_commercial_checkout_offer` (§1b), is **service-role-only** (`REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role`) and takes an explicit `p_billing_customer_id`, which `commercial-create-checkout` derives itself from the already-validated `user.id` (via `validateAuth`, then an ordinary `billing_customers` table lookup by `owner_user_id` — a step the function already performed for a different purpose, now moved earlier and reused). This is the general pattern item 1 asks for: **never rely on `auth.uid()` inside a function whose real caller uses a service-role client; derive identity from the already-validated JWT and pass it explicitly.**

### 3b. New finding — `commercial_platform_state` is created but never enforced (item 4, round 1), enforcement corrected for provider-selection ordering and identity mechanism (items 8, round 2)

Confirmed by direct source read of `commercial-create-checkout/index.ts`: the function never queries `commercial_platform_state` at all. The Ω3.0 singleton state machine (`PAYMENTS_DISABLED → SANDBOX_ONLY → LIVE_ACCEPTANCE → CUSTOMER_PAYMENTS_ENABLED`) exists in the database, starts at `PAYMENTS_DISABLED`, and today has **zero effect on runtime behavior**. This is not a defect in Ω3.0 itself (scoped there as schema-only) — it is a gap this design closes.

**Round 1's gate design had two confirmed defects, both corrected in round 2:**
1. **Wrong provider checked.** Round 1 read `getConfiguredProviders()[0].environment` to decide whether the current provider environment matched the platform state — but the provider that will actually process a given checkout is whatever `selectPaymentProvider(offer, getConfiguredProviders())` returns for *that specific offer*, which need not be index `[0]` (especially once a second adapter, e.g. Stripe, is ever configured — `routing.ts`'s own design goal). Checking the wrong array element means the gate could pass or fail based on an entirely unrelated provider's environment. **Corrected:** the platform-state gate is now split into two parts — Part A (provider-independent: `PAYMENTS_DISABLED`, missing/invalid row) runs immediately after auth; Part B (provider-environment mismatch, restricted-identity) runs *after* `selectPaymentProvider` has determined the real provider for this offer, and checks that provider's own capability entry (`getConfiguredProviders().find(p => p.provider === provider)`), never a fixed index. See `DATA_CONTRACTS.md` §2.
2. **Restricted-identity mechanism left as an open choice ("a hardcoded allowlist or `is_commercial_admin()`").** Item 8 requires committing to one and specifying it fully. **Chosen: query the existing `commercial_admins` table directly** (the same table `is_commercial_admin()` itself reads), using the already-validated `user.id` from `validateAuth` — not `is_commercial_admin()` itself, because that helper reads `auth.uid()` internally and would suffer the identical service-role-context defect as item 1's `resolve_commercial_offer` bug (`auth.uid()` is `NULL` under the service-role client `commercial-create-checkout` uses). No new table, no new function, no parallel allowlist — the same identity data `is_commercial_admin()` protects everywhere else, read the one way that is actually valid from this call site. See `DATA_CONTRACTS.md` §2, step 5.

The exact gate contract (both parts) and the full state × environment × identity matrix are specified in `DATA_CONTRACTS.md` §2 and §10.

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
| M | Existing Tanzania functionality must remain intact | **CORRECTED — narrowed, not simply "MET"** | Tanzania's accounting/workspace functionality (SAFISHA, HESABU, KINGA, EFDMS, TZ compliance) is completely untouched by this design — MET without qualification. Tanzania's **commercial checkout** functionality is a different claim: round 1 asserted "nothing in this design touches TZ-specific offers," which is true at the schema level but overclaimed the *behavioral* effect — round 2's server-owned-GLOBAL-market decision (`DATA_CONTRACTS.md` §9) makes TZ-market checkout categorically unreachable through `commercial-create-checkout`, regardless of any offer's `is_purchasable` flag. This is **not a regression** only because both existing TZ-market offers are already non-purchasable today (re-verified this round) and this fact must be re-proven at deployment time (`ACCEPTANCE_MATRIX.md` §9), not merely asserted from this design pass's snapshot. |
| F–L, N–P | (Checkout snapshot immutability, provider callback non-authority, webhook Gates A/B, licence activation authority, FREE/PAID non-regression, sandbox-offer non-purchasability, uniqueness/exclusion constraints) | **Unchanged — still MET**, re-verified against both correction rounds and found not to regress | The corrected resolver split, lease-fenced checkout-intent design, and customer-level commit lock touch none of the mechanisms these requirements depend on. |

## 4. Resolver contract — corrected signature and deployment discipline

The prior round's *conceptual* recommendation (require interval explicitly; add a separate read-only listing function for interval-independent needs) is **partially retained and partially corrected**:

- **Retained:** interval must be a required parameter — the reasoning (exactly one caller in the repository, an optional param is a permanent ambiguity foot-gun once dual pricing ships) still holds.
- **Corrected — parameter ordering:** the prior draft placed the new required `p_billing_interval` *after* the already-defaulted `p_market_code`, which Postgres rejects outright (`CREATE FUNCTION` requires every parameter after the first defaulted one to also carry a default). The corrected signature is `resolve_commercial_offer(p_plan_code TEXT, p_billing_interval TEXT, p_market_code TEXT DEFAULT 'GLOBAL')` — required parameters first, defaulted parameter last.
- **Corrected — no `NOT NULL` in the parameter list:** the prior draft's prose annotated the interval parameter as `TEXT NOT NULL`, which is not valid `CREATE FUNCTION` syntax (parameters cannot carry a `NOT NULL` constraint; only table columns can). The corrected function instead validates `p_billing_interval IS NULL OR ... NOT IN (...)` as the **first statement in the function body**, returning an explicit `UNKNOWN`/`UNKNOWN_OR_MISSING_BILLING_INTERVAL` result — fail-closed, but via ordinary PL/pgSQL control flow, not invalid syntax.
- **Corrected — overload awareness:** `CREATE OR REPLACE FUNCTION` does not replace a function when the parameter type list changes; it adds a second, overloaded entry. The 2-arg `resolve_commercial_offer(TEXT, TEXT)` remains live and callable (still granted to `anon, authenticated`) unless explicitly revoked and dropped. This is corrected with an explicit `REVOKE ALL ... ; DROP FUNCTION ...` step, sequenced strictly **after** the Edge Function that calls the new 3-arg overload has been confirmed deployed (`DATA_CONTRACTS.md` §1's three-phase deployment order) — never bundled into the same migration as the new function's creation, to avoid a window where either the old overload is gone before the new caller is live, or the new caller expects behavior the old overload's ambiguous 2-arg semantics would have masked.
- **Withdrawn:** the prior round's proposed `list_purchasable_commercial_offers()` read-only function is removed from this design entirely — no caller was ever proven for it (item 9, round 1).
- **Split in round 2 (item 1):** what was one function in round 1 is now two — `resolve_commercial_offer` (display, `auth.uid()`-based, correct because its real caller forwards a genuine session) and `resolve_commercial_checkout_offer` (checkout, service-role-only, takes an explicit `p_billing_customer_id` the Edge Function derives itself). Both still resolve product before plan (closing §3a's cross-product ambiguity), but via the trust-context-appropriate mechanism for each. Exact privilege DDL for both, and for every other new function this design introduces, is specified in `DATA_CONTRACTS.md` (item 2, round 2) — nothing is left as "grant TBD."

## 5. Offer uniqueness — audit, unchanged from the prior round, now paired with non-purchasable seeding

Ω3.0's 5-column `uq_co_current_offer` and `excl_co_no_overlapping_purchasable_periods` already support one MONTHLY + one ANNUAL PAID/GLOBAL/USD offer with no ambiguity — this finding is unchanged and re-confirmed. What changes under this correction round is **when** the two new rows become chargeable: they are created `is_purchasable = false` (item 12) and activated only via a later, separately-audited `admin_set_offer_purchasable` call (§4, round 2 — not `admin_supersede_commercial_offer`, which cannot toggle an existing row's flag) once every staging gate in `ACCEPTANCE_MATRIX.md` passes — so the uniqueness/exclusion constraints protect a non-purchasable row from day one of its existence, with zero window where a half-configured offer could be accidentally charged against.

## 6. Concurrency — corrected to a fully atomic, database-enforced design, further corrected to a lease/fencing protocol in round 2

See `THREAT_AND_FAILURE_MODEL.md` for the complete, re-audited scenario table. Summary of what changed across both rounds:
- **Round 1 (item 5, initial):** the original Edge-Function-level `SELECT`-then-`INSERT` reuse check was replaced with a single atomic RPC using a transaction-scoped advisory lock.
- **Round 2 (item 3): round 1's single-RPC design was itself insufficient** — its advisory lock is released the instant that one RPC's transaction commits, but the actual Flutterwave HTTP call happens afterward, in the Edge Function's own code, with no lock held. A second invocation for the same customer+offer arriving during that unlocked window could observe a `CREATED`/no-URL row and (under round 1's design) treat it as safely supersedable even though the original request might still succeed a moment later. **Corrected to a token-fenced lease protocol** (`DATA_CONTRACTS.md` §3): a short-TTL `PROVIDER_CREATING` status with a `creation_token`/`lease_expires_at` pair; a live (unexpired) lease is never stolen, only a genuinely expired one is superseded; the provider result is persisted via a token-based compare-and-swap that returns an explicit `persisted:false` on any fencing conflict, and the Edge Function is required to never hand a checkout URL to the customer when that happens — closing the exact "steal a live lease" and "return a URL after failed CAS" failure modes item 3 named.
- **Payment commit (item 6, round 1):** `commit_verified_commercial_payment`, previously assessed as needing no change, is **corrected to MUST CHANGE** — it gains a customer-level (not merely intent-level) advisory lock, acquired before re-reading the customer's current licence state, so two different successful payments for the same customer are strictly serialized. Unchanged by round 2.

## 7. Payment authority chain — full trace, corrected for the platform-state gate, product binding, and customer-level commit lock

```
Browser (CheckoutUpgradeButton)
  → sends { planCode, billingInterval }   [no price, no currency, no amount, no market — item 2, round 1]
  ↓
commercial-create-checkout (Edge Function, service-role client throughout)
  1. validateAuth(authHeader, CORS_HEADERS)                          — reject unauthenticated (401)
  2. Platform-state gate PART A (round 2): PAYMENTS_DISABLED / missing-or-invalid row → fail closed,
     before anything else (DATA_CONTRACTS.md §10 matrix)
  3. Resolve billing_customer_id from the VALIDATED user.id via an ordinary table SELECT (item 1,
     round 2) — never via auth.uid(), which is NULL under this function's service-role client
  4. Restricted-acceptance-identity check (item 8, round 2): direct commercial_admins lookup by the
     validated user.id — the one, fully-specified mechanism, not a hedge between two options
  5. supabase.rpc('resolve_commercial_checkout_offer', {p_billing_customer_id, p_plan_code,
     p_billing_interval, p_market_code:'GLOBAL'})  — the NEW, service-role-only checkout resolver
     (item 1, round 2), product-scoped via the explicit billing_customer_id, never auth.uid();
     GLOBAL is a server literal, never a TZ/MU/GB/EU fallback for checkout (item 9, round 2)
  6. UNKNOWN(404) / NOT_AVAILABLE(402) / AMBIGUOUS(500, never guessed) / AVAILABLE → proceed
  7. selectPaymentProvider(offer, getConfiguredProviders())           — routing, never re-prices
  8. Platform-state gate PART B (round 2, corrected): checks the CAPABILITY ENTRY for the provider
     selectPaymentProvider() actually chose — never a fixed array index — for an environment
     mismatch against the current platform state
  9. acquire_checkout_intent_lease(...) RPC (item 3, round 2)        — token-fenced lease acquire;
     REUSED short-circuits to an existing usable checkout_url; LEASE_HELD (409) means a live,
     unexpired concurrent attempt is in flight and is never stolen; NEW proceeds to step 10
  10. adapter.createCheckout(...)                                    — Flutterwave hosted page,
     with corrected CFOClose branding (item 11, round 1); amount NOT in the returned URL
  11. persist_checkout_provider_result(...) RPC (item 3, round 2)    — token-based CAS; on a failed
     CAS the checkout URL is NEVER returned to the browser, even though it may be a real, live,
     now-orphaned Flutterwave session (harmless — see DATA_CONTRACTS.md §3's orphan-session note)
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
Reconciliation (item 7; round 1 left "Edge Function or pg_cron" unresolved — round 2 commits to ONE
  mechanism, design-only, not implemented): pg_cron triggers commercial-payment-reconcile every 5
  minutes via pg_net; it claims stale PENDING intents through claim_stale_checkout_intents_for_
  reconciliation (FOR UPDATE SKIP LOCKED — two concurrent runs claim disjoint batches, never block
  or double-process), with exponential backoff (2^attempt minutes, capped) and a terminal-failure
  cap (8 attempts) that escalates to an audit row and a structured log line (this codebase has no
  external alerting provider wired yet — stated honestly, not invented). Each claimed row is
  verified via a NEW adapter method, verifyTransactionByReference, then committed through the
  IDENTICAL authoriseCommit + commit_verified_commercial_payment path a webhook would use — never a
  lesser-authority shortcut. Full design: DATA_CONTRACTS.md §7.
  ↓
Licence transition committed → get_effective_entitlement / _resolve_entitlement_for_owner reflect it
  ↓
PaymentReturn.tsx polls commercial-payment-status → get_checkout_status (owner-scoped, caller's own JWT)
```

**Bypass-point analysis:** unchanged conclusion from the prior round — no point in this chain accepts untrusted input as authoritative, and the corrected design narrows the browser's influence further (no market, product resolved server-side) rather than widening it anywhere.

## 8. Security / RLS audit, with exact privilege DDL for every new function (item 2, round 2)

Unchanged foundations, re-verified against both correction rounds: `REVOKE UPDATE, DELETE ON commercial_licences FROM authenticated`; append-only triggers on the evidence/audit tables; `admin_*` functions remain `is_commercial_admin()`-gated with a required reason; `commercial_platform_state` remains `authenticated`-SELECT-only, admin-write-only.

**Every new function this design introduces, with its exact grant (no function is left with an implicit or TBD privilege):**

| Function | Grant | Why |
|---|---|---|
| `resolve_commercial_offer(TEXT,TEXT,TEXT)` | `anon, authenticated` | Public catalogue display — read-only, returns no chargeable side effect |
| `resolve_commercial_checkout_offer(UUID,TEXT,TEXT,TEXT)` | **`service_role` only** | Checkout authority — takes a caller-derived `billing_customer_id`; must never be reachable by a customer directly supplying an arbitrary id |
| `commercial_default_product_id()` | **`service_role` only** (internal helper; `resolve_commercial_offer`'s `SECURITY DEFINER` context can still call it without a separate grant to `anon`/`authenticated`) | Not a customer-facing capability in its own right |
| `acquire_checkout_intent_lease(...)` | **`service_role` only** | Item 2's own named example — mutates checkout-intent state; must never be callable by an authenticated customer directly, only via the Edge Function that has already run auth/platform-state/offer-resolution first |
| `persist_checkout_provider_result(...)` | **`service_role` only** | Token-CAS write path; a customer holding a stolen/guessed token must never be able to call this directly even if they somehow obtained a token value |
| `fail_checkout_intent_lease(...)` | **`service_role` only** | Same reasoning |
| `commit_verified_commercial_payment`, `record_payment_reversal` | `service_role` only | Unchanged from Ω2-G |
| `admin_set_offer_purchasable(...)` (item 4, round 2) | `authenticated`, gated by internal `is_commercial_admin()` check | Same pattern as every other `admin_*` function — an ordinary authenticated user can call it, but the internal check rejects non-admins; this is intentionally NOT `service_role`-only, since real human admins invoke it directly, not through a service-role Edge Function |
| `admin_upsert_commercial_offer(...)`, new 12-arg overload (item 5, round 2) | `authenticated`, `is_commercial_admin()`-gated | Same pattern; old 11-arg overload `REVOKE`d and `DROP`ped in Phase C once the new one is confirmed live |
| `claim_stale_checkout_intents_for_reconciliation(INT)` (item 7, round 2) | **`service_role` only** | Called exclusively by the `commercial-payment-reconcile` Edge Function, itself invoked by `pg_cron`/`pg_net` with a service-role or dedicated cron secret — never customer-reachable |

**Privilege tests required (item 2's own "define exact signatures and privilege tests" instruction), specified fully in `ACCEPTANCE_MATRIX.md` §10:** for every `service_role`-only function above, a direct `supabase.rpc(...)` call using an ordinary authenticated user's session (not service role) must fail with a Postgres permission-denied error, not merely "not be used" by any current frontend code path — the grant itself, not application discipline, is what this design relies on.
