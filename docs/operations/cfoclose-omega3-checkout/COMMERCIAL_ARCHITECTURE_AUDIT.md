# Ω3-CHECKOUT — Commercial Architecture Audit

Design/audit document. No source code in this file describes a change that has been made — every "MUST CHANGE" reference is a proposal, detailed further in `IMPLEMENTATION_PLAN.md`.

## 1. System inventory (what exists today, with provenance)

### 1.1 Database — migration lineage

| Migration (live, applied) | Wave | What it created |
|---|---|---|
| `20260905093408_8fc55e64-3e06-4d26-8835-438a9243e1ef.sql` | Ω1 | `commercial_admins`, `commercial_products`, `commercial_plans`, `billing_customers`, `commercial_licences` (+ `excl_cl_no_overlapping_authoritative_periods` GiST EXCLUDE), `payment_events` (idempotency_key UNIQUE, append-only), `entitlement_overrides`, `billing_audit_events` (append-only); RPCs `_resolve_entitlement_for_owner`, `get_effective_entitlement`, `get_my_billing_summary`, `admin_grant_commercial_licence`, `admin_transition_licence_status`, `admin_grant_entitlement_override`, `admin_revoke_entitlement_override`, `admin_billing_lookup`, `provision_billing_customer_for_company` (auto-provisions FREE on company insert) |
| `20260905141022_f1029fbe-90d5-4aac-97e0-059eede76338.sql` | RLS1 | `is_commercial_admin()` SECURITY DEFINER helper (fixes an RLS recursion defect); rewrites 6 policies to use it |
| `20260906083524_eca6c272-4a62-4468-995b-1c70e2cd67e5.sql` | Ω2-G | `commercial_offers` (original 3-col `uq_co_current_offer`), `commercial_catalog_audit_events`, `resolve_commercial_offer(p_plan_code, p_market_code DEFAULT 'GLOBAL')` (no interval param), `admin_upsert_commercial_offer`, `admin_list_commercial_offers`, `payment_checkout_intents` (`saff_reference` UNIQUE, `expires_at` default +1h), `payment_webhook_receipts` (immutable observation), `payment_webhook_processing_events` (immutable, one row per attempt), extends `payment_events`, `commit_verified_commercial_payment()`, `record_payment_reversal()`, `get_checkout_status()`, `admin_get_billing_detail()`; `REVOKE UPDATE, DELETE ON commercial_licences FROM authenticated` |
| `20260906120000_omega3_0_effective_history_and_platform_state.sql` | Ω3.0 | `commercial_currencies` (exponent registry), `commercial_platform_state` (singleton state machine, starts `PAYMENTS_DISABLED`); `effective_range`/`effective_history_protected`/`request_fingerprint` on `commercial_offers`; **drops and widens `uq_co_current_offer` to 5 columns**; adds `excl_co_no_overlapping_purchasable_periods`; `admin_supersede_commercial_offer()`; `admin_transition_platform_state()` |

No migration after Ω3.0 touches any commercial/payment table (confirmed by directory listing — Ω3.0 is the newest file, verified by `omega3_0FoundationMigration.test.ts`'s own ordering test). Two source-authored duplicates for Ω1/RLS1/Ω2 are quarantined under `supabase/migrations_historical/*.sql.historical`, proven non-executable and semantically identical to the live files by `migrationCollisionGuard.test.ts`.

### 1.2 Edge Functions

| Function | Role | Auth |
|---|---|---|
| `commercial-create-checkout` | Resolves offer, routes provider, creates checkout intent, calls Flutterwave | `validateAuth` (JWT), no admin requirement |
| `commercial-payment-webhook` | Receives provider webhook, two-gate verify, commits payment | Public endpoint, authenticated only by Gate A (verif-hash) |
| `commercial-payment-status` | Owner-scoped poll for `PaymentReturn.tsx` | `validateAuth` (JWT), calls `get_checkout_status` as the caller (anon key + forwarded bearer token, not service role) |

Shared modules: `_shared/payments/{money,contracts,routing,authority}.ts`, `_shared/payments/providers/flutterwave.ts`.

### 1.3 Frontend

- `src/pages/Pricing.tsx` — presentation only. Displays `PRICING.MONTHLY_USD`/`ANNUAL_USD` (49/499, hardcoded display constants in `src/constants/copy.ts`), a monthly/annual toggle that only changes what is *displayed*, and a locked "Secure self-service checkout is being activated" panel (`PRICING.CHECKOUT_DISABLED_MSG`). It does **not** call `resolve_commercial_offer` or render `CheckoutUpgradeButton` — checkout is fully gated off at this page today. Its own header comment already states checkout will be enabled "once the interval-aware server resolver ... is completed," i.e. the current codebase already anticipated this exact mission.
- `src/components/commercial/CheckoutUpgradeButton.tsx` — the one live entry point that does call `resolve_commercial_offer` (for display) and `createCheckoutIntent` (for checkout), used from Settings, not Pricing. Accepts an optional `marketCode` prop, propagated byte-identical to both calls (`marketPropagation.test.ts`). No `billingInterval` prop exists today.
- `src/lib/commercial/commercialRpc.ts` — sole typed RPC/HTTP boundary (`callCommercialRpc`, `createCheckoutIntent`, `pollCheckoutStatus`).
- `src/pages/billing/PaymentReturn.tsx` — polls `commercial-payment-status`; renders confirmed/failed/cancelled/timeout states from server-returned status only; never grants entitlement itself.
- `src/lib/commercial/billingDisplay.ts`, `entitlementContract.ts` — display/derivation helpers, fail-closed (Mission B / prior work).

### 1.4 Payment (Flutterwave)

`_shared/payments/providers/flutterwave.ts` implements `ProviderAdapter`: `createCheckout` (Standard Hosted payment page), `verifyWebhookAuthenticity` (Gate A, constant-time `verif-hash` comparison), `normalizeWebhook`, `verifyTransaction` (Gate B, independent `GET /transactions/{id}/verify` call, with the Ω2-GR1 repair that rejects a missing/mismatched `tx_ref` with no fallback to the locally-expected reference — see `edgeFlutterwaveGateB.test.ts`).

**Finding — stale branding in the live checkout payload (HIGH, cosmetic-but-real, in scope for Step 10):** `flutterwave.ts:147-155` still sends:
```
customizations: { title: 'SAFF ERP', description: `Firm Licence — ${params.planName}`, logo: 'https://cfoclose.com/favicon.ico' },
meta: { saff_reference: params.saffReference, source: 'SAFF_ERP_OMEGA2' },
```
`title` and `meta.source` are stale SAFF-era literals — a CFOClose customer would see "SAFF ERP" on Flutterwave's hosted payment page mid-transaction. `logo` points at `https://cfoclose.com/favicon.ico`, a file this repository's own Mission B `git rm`'d (replaced by `favicon.svg`; Flutterwave's `customizations.logo` field also conventionally expects a raster image, not SVG, so this URL is doubly wrong — dead path, wrong format). This is a real, user-visible branding leak directly relevant to Step 13's "no stale SAFF branding" acceptance criterion. Flagged as **MUST CHANGE** in `IMPLEMENTATION_PLAN.md` — it does not touch pricing/verification/security logic, only presentation strings sent to the provider.

### 1.5 Tests inspected (full list, Step 1 requirement)

Real production-source coverage (imports/reads the actual deployed file):
`edgeMoney.test.ts`, `edgeFlutterwaveGateB.test.ts`, `webhookEvidenceModel.test.ts`, `globalCommerceModel.test.ts`, `marketPropagation.test.ts`, `authContractRepair.test.ts`, `migrationCollisionGuard.test.ts`, `omega3_0FoundationMigration.test.ts`, `routing.test.ts` (documented frontend mirror of the edge copy), `CheckoutUpgradeButton.test.ts`, `entitlementContract.test.ts`.

**Finding — shadow test suite with zero coverage of production code (HIGH, test-coverage gap):** `checkoutFlow.test.ts`, `atomicCommit.test.ts`, `paymentSecurity.test.ts`, `webhookSecurity.test.ts` (all under `src/lib/commercial/payments/__tests__/`) import exclusively from `src/lib/commercial/payments/paymentTypes.ts` and `paymentAuthority.ts` — two modules confirmed (by repo-wide grep) to be imported **only by these four test files**, never by any Edge Function or by `commercialRpc.ts`/`CheckoutUpgradeButton.tsx`. `paymentTypes.ts` defines its own `PaymentProviderAdapter`/`CreateCheckoutResult`/`CommitResult` shapes that have already drifted from the real `_shared/payments/contracts.ts` (e.g. `CreateCheckoutResult` there carries `providerReference`/`expiresAt`; the real `CreateCheckoutResult` in `contracts.ts` carries `providerRef` only, no `expiresAt`). These 61 tests pass today and would keep passing after an arbitrary regression in the real Edge Functions, because they never touch them. This is exactly the duplicated-logic anti-pattern this codebase's own house convention (evident in `edgeMoney.test.ts`'s and `webhookEvidenceModel.test.ts`'s doc comments) exists to prevent, and it was not caught because these four files predate that convention being applied to the payments module. **Recommendation, not performed in this pass:** either delete these four files (their genuine intent — documenting the Iron Dome invariants — is better served by `COMMERCIAL_AUTHORITY_INVARIANTS` staying as a comment, not an executable contract with independent types) or repoint them at the real `_shared/payments/*` modules the way `edgeMoney.test.ts` does. Tracked as a **MAY CHANGE** item in `IMPLEMENTATION_PLAN.md`, not required to unblock Ω3-CHECKOUT, but should not be mistaken for real regression coverage when reasoning about "is the resolver/checkout change tested."

Entitlement/feature-registry: `entitlementContract.test.ts`, `featureRegistry.test.ts`, `rlsRecursionGuard.test.ts` (not re-read line-by-line this pass; their contracts were already exercised and cross-checked against `entitlementContract.ts`, which this pass did read in full via the imports in `entitlementContract.test.ts`).

## 2. No implementation performed

Nothing in this document, or any other document in this package, has been applied to the repository's source, schema, or Supabase project. All code blocks are quotations of existing source or proposed future source, never a diff that was actually run.

## 3. The 16 commercial-model requirements (A–P), proven against real source

| # | Requirement | Status | Evidence |
|---|---|---|---|
| A | USD 49/month and USD 499/year must be authoritative server-side offers | **NOT MET TODAY** | `commercial_offers` holds exactly the two TZS sandbox rows seeded by Ω2-G (`SANDBOX-TEST-PAID-GLOBAL`, `SANDBOX-TEST-PAID-TZ`, both `is_purchasable = false`). USD 49/499 exist only as `PRICING.MONTHLY_USD`/`ANNUAL_USD` display constants in `src/constants/copy.ts`. Closing this requires the controlled data-seed operation in `IMPLEMENTATION_PLAN.md` §3, not a schema change. |
| B | Frontend never authoritative for price/currency/amount_minor/provider/entitlement/licence state | **MET** | `commercial-create-checkout/index.ts` parses only `{planCode, marketCode}` from the body (proven by `marketPropagation.test.ts`'s parse-block assertion `not.toMatch(/amount\|currency\|price/i)`); `CheckoutUpgradeButton.tsx` calls `createCheckoutIntent(planCode, marketCode)` with no amount argument (`CheckoutUpgradeButton.test.ts` "Test 3"); entitlement is resolved server-side only via `get_effective_entitlement`/`_resolve_entitlement_for_owner`. |
| C | Billing interval explicit end-to-end (MONTHLY/ANNUAL) | **PARTIALLY MET, gap identified** | `commercial_offers.billing_interval` and `payment_checkout_intents.billing_interval` both exist and are snapshotted correctly once an offer resolves. The break is `resolve_commercial_offer` itself — see §4. |
| D | Server resolves exact offer | **MET (mechanism), blocked by C** | `resolve_commercial_offer` is the sole resolution path; `commit_verified_commercial_payment` re-derives nothing from `commercial_offers`, only from the intent's own snapshot (`globalCommerceModel.test.ts`). |
| E | Monthly/annual must never resolve ambiguously | **NOT MET TODAY, but the fix is narrow** | With two live USD offers (monthly+annual) for the same plan+market, `resolve_commercial_offer` counts both and returns `AMBIGUOUS` — see §4. The uniqueness layer that would let ambiguity happen at the *storage* level is already closed (§5). |
| F | Checkout intent snapshots authoritative economics | **MET** | `payment_checkout_intents` columns `expected_amount_minor`, `currency_code`, `currency_exponent`, `billing_interval`, `billing_interval_count`, `commercial_offer_id` are populated once, at creation, from the resolved offer; `commit_verified_commercial_payment` validates against `v_intent.*`, never re-reading `commercial_offers` (`globalCommerceModel.test.ts` §"CHECKOUT ECONOMIC SNAPSHOT"). |
| G | Provider callbacks never independently authorize entitlement | **MET** | `PaymentReturn.tsx` only polls server state; `COMMERCIAL_AUTHORITY_INVARIANTS.NEVER_BROWSER_CALLBACK_ENTITLEMENT` documents this (though see the shadow-test finding in §1.5 — the invariant is real, its *test* is not evidence). |
| H | Webhook authenticity independently verified | **MET** | Gate A — `verifyWebhookAuthenticity`, constant-time `verif-hash` comparison, `flutterwave.ts:74-92`. |
| I | Provider transaction details independently verified against the intent | **MET** | Gate B — `verifyTransaction` calls Flutterwave's own `GET /transactions/{id}/verify`, never trusts the webhook payload's own claims; plus `authoriseCommit()` (a third layer) and the RPC's own re-check (a fourth) — see §7. |
| J | Licence activation only via authoritative server-side commit path | **MET** | `commit_verified_commercial_payment` is the sole writer of `commercial_licences` post-payment; `REVOKE UPDATE, DELETE ON commercial_licences FROM authenticated` (Ω2-G) blocks any direct browser mutation. |
| K | Existing FREE customers remain FREE unless authoritative payment commits | **MET** | `provision_billing_customer_for_company` grants FREE only; no code path upgrades a licence outside `commit_verified_commercial_payment`. |
| L | Existing PAID customers must not accidentally downgrade | **MET (mechanism), needs a concurrency guard for renewal edge cases** | `commit_verified_commercial_payment` closes out any existing ACTIVE/GRACE licence "regardless of plan" before inserting the new one (`globalCommerceModel.test.ts` — the lookup does not filter by `plan_id`, closing a real pre-Ω2-G bug). Renewal-while-ACTIVE/GRACE concurrency is analyzed in `THREAT_AND_FAILURE_MODEL.md`. |
| M | Existing Tanzania functionality must remain intact | **MET, verify unchanged in this pass** | Nothing in this design touches `market_code = 'TZ'` handling, SAFISHA/HESABU/KINGA, or TZ-specific Flutterwave payment methods (`mobilemoneytzania`, currency-gated in `flutterwave.ts:135`). |
| N | Existing TZS sandbox/test offers must not accidentally become purchasable | **MET** | Both existing TZS rows are `is_purchasable = false`; nothing in the proposed implementation slice (§ below, and `IMPLEMENTATION_PLAN.md`) touches them — new USD offers are separate rows. |
| O | Public pricing presentation and authoritative offers must not drift | **NOT MET TODAY, closable without new architecture** | `Pricing.tsx` hardcodes `PRICING.MONTHLY_USD`/`ANNUAL_USD` = 49/499 as *display* constants with a code comment asserting they "match" `commercial_offers` — but no offer exists yet to match, so the assertion is currently unverifiable. Once the two USD offers exist, this becomes a manual-sync risk (constants vs. DB), not a structural one; see `IMPLEMENTATION_PLAN.md` §5 for the recommended mitigation (a build-time or admin-surfaced parity check), which is explicitly **not** "hardcode economics in the frontend" (forbidden by Step 11) nor a new architecture. |
| P | (Ambiguity/uniqueness at the constraint level) | **MET** | See §5 — Ω3.0's 5-column `uq_co_current_offer` + `excl_co_no_overlapping_purchasable_periods`. |

## 4. Resolver contract — critical analysis of the proposed optional-parameter change

Plan.md proposes: `resolve_commercial_offer(p_plan_code, p_market_code DEFAULT 'GLOBAL', p_billing_interval TEXT DEFAULT NULL)` — filter by interval only when supplied, "so all existing callers keep today's behaviour."

**This pass does not accept that proposal.** Answering the mission's 7 sub-questions directly:

1. **Does an optional param leave unsafe legacy callers?** There are zero "legacy" callers in the sense of external/frozen consumers — `resolve_commercial_offer` has exactly **one** caller in the entire repository: `commercial-create-checkout/index.ts`, which this same implementation slice will update anyway. "Preserve today's behaviour for existing callers" is solving a problem that does not exist here, at the cost of leaving a permanently-ambiguous default in the function's public signature.
2. **Can a caller omit interval and get an ambiguous resolution?** Yes, by construction, under the plan.md proposal — once two USD offers are live, any caller (a future admin tool, a future "show current price" widget, a copy-pasted call) that forgets the third argument silently reverts to counting both intervals together and returns `AMBIGUOUS` unpredictably. An optional parameter that changes the function's *safety*, not just its output shape, depending on whether a caller remembers a rarely-required argument is a foot-gun that grows more dangerous exactly as the catalog grows (three intervals, a one-time plan, etc.).
3. **Should interval be mandatory?** Yes, once dual-interval purchasable offers exist for the same plan+market. Recommendation below.
4. **Which callers invoke the resolver today?** One: `commercial-create-checkout`. Confirmed by repo-wide search — no other Edge Function, RPC, or frontend file calls `resolve_commercial_offer`.
5. **What happens to every caller after the change?** With a required parameter, the sole caller (`commercial-create-checkout`) is updated in the same slice to thread `billingInterval` from its own request body (itself threaded from `Pricing.tsx`'s interval toggle / `CheckoutUpgradeButton`'s new prop). No caller is left behind because there is exactly one, and it moves in lockstep.
6. **Do admin/read-only callers legitimately need interval-independent resolution?** Yes — a legitimate future need exists: "what offers currently exist for this plan+market, regardless of interval" (e.g. an admin catalogue view, or a Pricing page that wants to show both prices at once without one call per interval). This is a **different question** than "resolve the one offer I am about to charge someone for," and conflating them in one overloaded function is exactly the ambiguity risk in point 2.
7. **Does an overloaded/compatibility function create ambiguity?** Yes — a single function whose meaning changes based on argument count is worse for a future reader than two clearly-named functions.

**Recommendation:**
- Change `resolve_commercial_offer`'s signature to `resolve_commercial_offer(p_plan_code TEXT, p_market_code TEXT DEFAULT 'GLOBAL', p_billing_interval TEXT NOT NULL)` — i.e. **interval becomes a required, no-default parameter**, positioned last to keep `p_market_code`'s existing default usable. (Postgres `CREATE OR REPLACE FUNCTION` on a function with a new required parameter changes its identity/signature; since there is one caller, updated in the same slice, this is safe. This is a MUST-CHANGE item, detailed with exact SQL shape in `DATA_CONTRACTS.md`.)
- Add a second, explicitly-named function for the legitimate interval-independent need identified in sub-question 6: `list_purchasable_commercial_offers(p_plan_code TEXT, p_market_code TEXT DEFAULT 'GLOBAL') RETURNS SETOF ...` — returns every currently-effective purchasable offer for the plan+market, across all intervals, with **no single-offer resolution logic and no AMBIGUOUS/AVAILABLE discriminant** (it is a list, not a decision). Checkout code must never call this function to resolve a chargeable offer. This function does not exist today and is a genuinely new, narrowly-scoped addition — not a redesign.
- `AMBIGUOUS` remains reachable only as a genuine data-integrity signal (two purchasable offers for the identical 5-column family, which the Ω3.0 constraints already prevent at the storage layer — see §5) rather than as the routine behavior of an interval-naive caller.

## 5. Offer uniqueness — audit, correcting plan.md

**Claim under test:** can the schema support one MONTHLY + one ANNUAL PAID/GLOBAL/USD offer without ambiguity?

**Proven yes, already, by Ω3.0** (migration `20260906120000`, predates this mission and postdates the commit plan.md was generated against):
- `uq_co_current_offer` was dropped (3-column: `plan_id, market_code, currency_code`) and recreated as a **5-column** unique index: `(plan_id, market_code, currency_code, billing_interval, billing_interval_count)`. A MONTHLY row and an ANNUAL row for the same plan/market/currency differ on `billing_interval` and are both permitted; two MONTHLY rows for the same plan/market/currency collide and are rejected.
- `excl_co_no_overlapping_purchasable_periods` — a GiST EXCLUDE constraint over the same 5 columns plus `effective_range` (a generated `tstzrange`), guarded by `WHERE (effective_history_protected)` — additionally prevents two *historically overlapping* offers in the same family, closing the gap a plain unique index alone would leave (a unique index only rejects exact duplicates at a point in time; it does not prevent two overlapping date ranges for the same family, e.g. superseding an offer before its predecessor's range ends).
- Both are proven by direct source-text assertion in `omega3_0FoundationMigration.test.ts` ("DDL replacements", "Test C") and cross-checked in this pass by direct reading of the migration file.
- Effective-date behavior: the ratchet trigger (`commercial_offers_effective_history_ratchet`) unconditionally recomputes `effective_history_protected` from `is_purchasable`, discarding any caller-supplied value — so the exclusion constraint's protection cannot be bypassed by an admin RPC caller supplying a false value for that column.
- Historical/Tanzania offers: unaffected — the legacy-row classification step (Ω3.0 §4, "Step B") is an unconditional `UPDATE ... SET effective_history_protected = true` with no `WHERE` clause, executed with a proof-of-completeness assertion (`LEGACY_CLASSIFICATION_INCOMPLETE`) and a conflict-detection assertion (`LEGACY_EFFECTIVE_RANGE_CONFLICTS_DETECTED`) that would have aborted the migration at deploy time had any conflict existed. It shipped clean, meaning the two existing TZS sandbox rows are provably conflict-free under the new 5-column key.
- Migration-collision risk: none — `admin_upsert_commercial_offer`'s exception handler (Ω3.0, `WHEN exclusion_violation`) translates a constraint violation on the new 5-column key into a domain-specific error via `GET STACKED DIAGNOSTICS ... = CONSTRAINT_NAME`, not a raw duplicate-key crash, and does so by exact constraint name (no `WHEN OTHERS`, no message-text parsing) — so creating the two USD offers (§ implementation plan) through this RPC will fail loudly and specifically if a family collision exists, rather than silently succeeding or crashing generically.

**Conclusion: Step 5 requires no new migration.** The implementation plan's only offer-related migration work is a data-seed operation (creating the two USD rows through the existing `admin_upsert_commercial_offer` RPC) plus the resolver signature change in §4 — never a new constraint.

## 6. (Concurrency — see `THREAT_AND_FAILURE_MODEL.md` for the full 14-scenario audit; summary only)

`commit_verified_commercial_payment`'s `SELECT ... FOR UPDATE` lock on the checkout-intent row is the true safety net for webhook-race scenarios; the webhook handler's own `intent.status === 'SUCCEEDED'` pre-check is a fast-path optimization, not the guarantee. `payment_events.idempotency_key` UNIQUE (keyed on `sha256Hex('WEBHOOK:${provider}:${providerTransactionId}:${intentId}')`) is a second, independent layer. `admin_supersede_commercial_offer`'s lock-then-recheck-fingerprint pattern is the correct template for any new concurrency-sensitive RPC this design introduces. Full scenario-by-scenario analysis, and the recommendation for the one genuinely open gap (concurrent CREATED/PENDING intents per customer), is in `THREAT_AND_FAILURE_MODEL.md`.

## 7. Payment authority chain — full trace, bypass-point analysis

```
Browser (CheckoutUpgradeButton / future Pricing checkout CTA)
  → sends { planCode, marketCode, billingInterval }  [no price, no currency, no amount]
  ↓
commercial-create-checkout (Edge Function)
  1. validateAuth(authHeader, CORS_HEADERS)                          — reject unauthenticated (401)
  2. supabase.rpc('resolve_commercial_offer', {p_plan_code, p_market_code, p_billing_interval})
     — server resolves the ONE authoritative offer; browser input never reaches pricing
  3. UNKNOWN(404) / NOT_AVAILABLE(402) / AMBIGUOUS(500, never guessed) / AVAILABLE → proceed
  4. selectPaymentProvider(offer, getConfiguredProviders())           — routing, never re-prices
  5. INSERT payment_checkout_intents  — snapshots offer_id, plan_id, market_code, expected_amount_minor,
     currency_code, currency_exponent, billing_interval, billing_interval_count, saff_reference (UNIQUE), expires_at
  6. adapter.createCheckout(...)                                     — Flutterwave hosted page, amount NOT in the returned URL
  ↓
Flutterwave hosted checkout (outside this system's trust boundary)
  ↓
commercial-payment-webhook (Edge Function, public endpoint)
  1. INSERT payment_webhook_receipts (immutable, BEFORE any verification)  — durable evidence even of a forged/garbage POST
  2. Gate A: adapter.verifyWebhookAuthenticity(rawBody, headers)      — constant-time verif-hash check; fail → INVALID_SIGNATURE, 200 (no retry flood)
  3. adapter.normalizeWebhook(rawBody)                                — parse only, no trust yet
  4. load intent by saff_reference; application-level replay pre-check (fast path, NOT the safety net)
  5. Gate B: adapter.verifyTransaction(txId, expectedMinor, expectedCurrency, saffRef)
     — INDEPENDENT call to Flutterwave's own GET /transactions/{id}/verify;
       rejects on missing/mismatched tx_ref (no fallback to the locally-expected reference),
       amount mismatch (bigint, no float), currency mismatch
  6. authoriseCommit(intent, transaction)                             — 3rd layer: re-checks intent status open/not-expired,
       transaction SUCCEEDED, amount equality, reference match
  7. commit_verified_commercial_payment(...) RPC (service_role, SECURITY DEFINER)
     — 4th layer: idempotency_key check FIRST (ALREADY_COMMITTED short-circuit, no mutation),
       SELECT ... FOR UPDATE on the intent row, re-validates status/expiry/amount/currency again,
       RAISE EXCEPTION on any mismatch, closes out any existing ACTIVE/GRACE licence (any plan),
       inserts the new licence period, records billing_audit_events
  8. record processing outcome → payment_webhook_processing_events (append-only, one row per attempt)
  ↓
Licence transition committed → get_effective_entitlement / _resolve_entitlement_for_owner reflect it
  ↓
PaymentReturn.tsx polls commercial-payment-status → get_checkout_status (owner-scoped, caller's own JWT)
  → displays confirmed plan/effective_end ONLY from server state, never from the redirect URL's own query params
```

**Bypass-point analysis:** no point in this chain accepts untrusted input as authoritative. Every dollar amount and currency code is independently re-derived or re-verified at four separate points (offer resolution → intent snapshot → Gate B independent provider call → `authoriseCommit` → the RPC's own re-check), and the two economically-relevant client inputs (`planCode`, `marketCode`, and — after this design ships — `billingInterval`) are used only to *select which server-known offer to charge*, never to state a price. The one input class that is genuinely browser-supplied and load-bearing is `planCode`/`marketCode`/`billingInterval` themselves: an attacker who requests a different `planCode` than the UI shows only reaches a *different, still-authoritative* offer (or `NOT_AVAILABLE`/`UNKNOWN`) — never an attacker-chosen price. This is the intended and correct behavior, not a bypass.

## 8. Security / RLS audit

- `commercial_licences`: `REVOKE UPDATE, DELETE ON commercial_licences FROM authenticated` (Ω2-G) — a normal authenticated browser session cannot directly flip a licence to ACTIVE/PAID under any circumstance; the only writer is `commit_verified_commercial_payment` (SECURITY DEFINER, service-role-invoked from the webhook function).
- `payment_events`, `payment_webhook_receipts`, `payment_webhook_processing_events`, `billing_audit_events`, `commercial_catalog_audit_events`: each has a `BEFORE UPDATE OR DELETE` trigger that unconditionally `RAISE EXCEPTION`s — append-only, provable by direct migration read and by `webhookEvidenceModel.test.ts`.
- `commit_verified_commercial_payment`, `record_payment_reversal`: service-role only (invoked from Edge Functions with the service key), never exposed to `authenticated`/`anon` directly — confirmed by the absence of a `GRANT EXECUTE ... TO authenticated` for these functions in the Ω2-G migration (only `admin_*` and `resolve_commercial_offer`/`get_checkout_status`/`get_my_billing_summary` carry `authenticated`/`anon` grants).
- `resolve_commercial_offer`: `authenticated` + `anon` may call it (needed for a logged-out Pricing page to show a real price) — safe, because it is read-only (`STABLE`) and returns only public catalogue facts, never a chargeable side effect.
- `admin_upsert_commercial_offer`, `admin_supersede_commercial_offer`, `admin_transition_platform_state`: all gated by `is_commercial_admin()` and require a non-blank `p_reason`, auditable via `commercial_catalog_audit_events`.
- `commercial_platform_state`: `SELECT` granted to `authenticated` only (never `anon`); no `authenticated` write grant at all — only the admin RPC can transition it.
- Direct-manipulation check: no RLS policy or grant anywhere in the four migrations allows an ordinary authenticated user to `INSERT`/`UPDATE` `commercial_licences`, `payment_events`, or `payment_checkout_intents` to a SUCCEEDED/PAID state, or to `UPDATE` `commercial_offers.amount_minor` (protected additionally by the Ω3.0 economic-integrity trigger's post-creation immutability of economic fields). **A normal authenticated browser cannot manufacture PAID/ACTIVE/ENTITLED/SUCCESSFUL-PAYMENT state or a cheaper checkout** under the schema and grants as they exist today.
