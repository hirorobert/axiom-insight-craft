# Ω3-CHECKOUT — Acceptance Matrix

Design document — defines the tests that must pass on a real staging environment before Ω3-CHECKOUT is considered implemented. None of these have been run; this environment has no live Postgres/Deno connection.

**Design-correction round 1:** expanded per independent review (item 13) to cover the corrected atomic checkout-intent design, the customer-level commit lock, platform-state enforcement, product binding, the removed `marketCode` contract, and manual-renewal (not subscription) framing.

**Design-correction round 2 (this revision):** §1/§3/§4 corrected for the token-fenced lease protocol (replacing the round-1 single-RPC design) and the corrected offer-activation RPC; new §8 adds executable tests for every round-2 mechanism (item 10) — service-role auth context, direct RPC privilege attacks, live-lease races, stale-lease takeover, failed CAS, offer activation/deactivation, transient-result constraint insertion, reconciliation concurrency, selected-provider mismatch, and TZ/GLOBAL routing.

## 1. Staging acceptance — MONTHLY path

Precondition: the two USD offers exist as `is_purchasable = false` (item 12) and have been separately, explicitly activated (`is_purchasable = true`) via `admin_set_offer_purchasable` as its own audited step (`DATA_CONTRACTS.md` §4 — corrected in round 2; `admin_supersede_commercial_offer` cannot toggle an existing row's flag and is not used for this); `commercial_platform_state` is at least `SANDBOX_ONLY`; Flutterwave sandbox secrets are configured.

| Step | Action | Expected server-verifiable outcome |
|---|---|---|
| 1 | Sign up a fresh FREE user | `billing_customers` row auto-provisioned; `commercial_licences` shows FREE/ACTIVE |
| 2 | Navigate to `/pricing`, select MONTHLY | Display reads USD 49/month, sourced from `resolve_commercial_offer(PAID, MONTHLY)` (no market argument from the browser — `DATA_CONTRACTS.md` §2) once checkout is enabled here |
| 3 | Click checkout CTA | Request body is exactly `{planCode, billingInterval}` — verified by inspecting the actual network request, not just the code (§8 below); `commercial-create-checkout` returns a real Flutterwave sandbox `checkoutUrl`; `payment_checkout_intents` row created via `acquire_checkout_intent_lease` (status transitions `PROVIDER_CREATING` → `PENDING` via `persist_checkout_provider_result`'s token-CAS) with `billing_interval='MONTHLY'`, `expected_amount_minor=4900`, `currency_code='USD'` |
| 4 | Complete payment in Flutterwave sandbox | Webhook receipt inserted; Gate A passes; Gate B's independent `verifyTransaction` call confirms amount/currency/reference |
| 5 | — | `commit_verified_commercial_payment` acquires the customer-level lock, transitions licence to PAID/ACTIVE, `effective_end` = now + 1 month |
| 6 | Navigate to Settings | Plan badge "CFOClose Professional", licence status "Active", correct effective-through date, entitlements list includes `MAONO_INTELLIGENCE`/`MULTI_COMPANY`/etc.; **no language anywhere implies automatic renewal** (item 8) — copy must read as a fixed-term licence |
| 7 | Check `billing_audit_events` | Audit row documents the FREE→PAID transition |

## 2. Staging acceptance — ANNUAL path

Identical to §1 with `billingInterval='ANNUAL'`, `expected_amount_minor=49900`, `effective_end` = now + 1 year, USD 499/year displayed.

## 3. Staging acceptance — adversarial/edge cases (both intervals)

| # | Scenario | Required server-verifiable outcome |
|---|---|---|
| 1 | Duplicate webhook delivery | `ALREADY_COMMITTED`/`REPLAY`; `commercial_licences` unchanged; no second period created |
| 2 | Replay days later | Same — idempotency key is not time-bound |
| 3 | Amount mismatch (provider-side true value differs from the intent's snapshot) | `AMOUNT_MISMATCH`, no commit |
| 4 | Currency mismatch | `CURRENCY_MISMATCH`, no commit |
| 5 | Expired intent | `INTENT_EXPIRED`, no commit |
| 6 | Invalid interval value sent directly to the Edge Function (bypassing the UI) | 400/`UNKNOWN_OR_MISSING_BILLING_INTERVAL`, no offer resolution attempted |
| 7 | `marketCode` sent in the request body anyway (a client bypassing the UI, or a stale cached frontend build) | **Must be silently ignored, never honored** — the Edge Function's request-parsing must not read a `marketCode` field even if present; market remains the literal `'GLOBAL'` regardless of what the body contains. This is a new, explicit test closing item 2's requirement that market is not merely "usually GLOBAL" but structurally unreachable as a client input. |
| 8 | Existing PAID customer attempts to buy the same plan/interval again | Blocked client-side by `shouldShowUpgradeAction`, or if reached directly, results in a licence closeout+reinsert leaving the customer PAID/ACTIVE with an updated `effective_end` — never a downgrade, never a duplicate ACTIVE row |
| 9 | Existing Tanzania (TZ market, TZS currency) customer flow | Entirely unaffected — regression check |

## 4. Concurrency acceptance (item 13 — new)

| # | Scenario | Required server-verifiable outcome |
|---|---|---|
| 1 | **Simultaneous checkout creation** — fire two `commercial-create-checkout` requests for the same authenticated customer and the same offer within the same event loop tick (staging load-test harness, not two manual clicks) | Exactly one `payment_checkout_intents` row exists for the pair afterward; the winning request's response is served to whichever call actually completed the flow; the second call observes either `REUSED` (if the first had already reached `PENDING`) or `LEASE_HELD`/409 (if the first was still `PROVIDER_CREATING`) — never a second row |
| 2 | **Crash between provider creation and database persistence** — in a staging harness, forcibly kill the Edge Function process (or inject a fault) after `adapter.createCheckout()` returns successfully but before `persist_checkout_provider_result` executes | The row is left `PROVIDER_CREATING` with a live lease for up to 60 seconds (during which a concurrent attempt correctly gets `LEASE_HELD`, not a false reuse); only once the lease expires does the next attempt's staleness sweep mark it `FAILED` and create a fresh, working intent — verify no window exists where a stale or absent URL is ever served |
| 3 | **Two different successful intents for the same customer** — complete payment on a MONTHLY checkout, then before/around the same time complete payment on a separately-created ANNUAL checkout for the same customer | Both payments commit (`COMMITTED`, not `ALREADY_COMMITTED` for either — they are genuinely different transactions); `commercial_licences` shows two historical rows, non-overlapping, with the second's `effective_start` correctly chained from the first's closeout; the customer's *current* licence reflects whichever commit's lock-acquisition order was second; no exclusion-constraint error appears in any log |
| 4 | **Transient provider-verification outage and recovery** — in a staging harness, make the Flutterwave verify endpoint return a 503/timeout for one webhook delivery attempt, then allow a subsequent (Flutterwave-initiated or reconciliation-driven) attempt to succeed | The first attempt is recorded as `VERIFICATION_TRANSIENT_FAILURE` (not folded into a generic rejected bucket) and the webhook handler returns 500 (not 200) to trigger Flutterwave's redelivery; the second, successful attempt commits normally via the unchanged Gate A/B/commit path |

## 5. Platform-state acceptance (item 13 — new)

| `commercial_platform_state` | Test | Required outcome |
|---|---|---|
| `PAYMENTS_DISABLED` | Any authenticated customer calls `commercial-create-checkout` | 503, no offer resolution attempted, no intent created |
| `SANDBOX_ONLY` + sandbox provider configured + ordinary customer | Call checkout | 403 `SANDBOX_RESTRICTED` |
| `SANDBOX_ONLY` + sandbox provider configured + restricted/admin identity | Call checkout | Proceeds normally against the sandbox provider |
| `SANDBOX_ONLY` + **production** provider configured (misconfiguration test) | Call checkout as a restricted identity | 503 `PROVIDER_ENVIRONMENT_MISMATCH` — must fail closed even for an authorized caller |
| `LIVE_ACCEPTANCE` + production provider + ordinary customer | Call checkout | 403 `LIVE_ACCEPTANCE_RESTRICTED` |
| `LIVE_ACCEPTANCE` + production provider + restricted identity | Call checkout | Proceeds against the production provider |
| `CUSTOMER_PAYMENTS_ENABLED` + production provider + ordinary customer | Call checkout | Proceeds normally — this is the eventual real-launch state |
| `CUSTOMER_PAYMENTS_ENABLED` + **sandbox** provider configured (misconfiguration test) | Call checkout | 503 `PROVIDER_ENVIRONMENT_MISMATCH` |
| Platform-state row deleted or its value corrupted to something outside the 4-value vocabulary (staging fault-injection only) | Call checkout | 503 `PAYMENTS_UNAVAILABLE` — never "proceed as if enabled" |

## 6. Server-owned market and product binding acceptance (items 2 and 3 — new)

| # | Test | Required outcome |
|---|---|---|
| 1 | Inspect the actual browser network request made by `CheckoutUpgradeButton` on click | Body is exactly `{"planCode": "...", "billingInterval": "..."}` — no `marketCode` key present at all |
| 2 | Static source check: `CheckoutUpgradeButton.tsx` and `commercialRpc.ts` | No `marketCode` identifier appears anywhere in either file |
| 3 | Static source check: `commercial-create-checkout/index.ts` | The `resolve_commercial_offer` RPC call passes a literal `'GLOBAL'` string for market, never a value read from `req.json()` |
| 4 | Product binding — (requires a second `commercial_products` row in a staging-only fixture, since production has only one today) | With two products both defining a plan coded `PAID`, `resolve_commercial_offer` for a customer belonging to product B resolves product B's offer, never product A's — proving the corrected product-scoped lookup, not the prior unscoped `SELECT ... INTO` |
| 5 | Anonymous (pre-signup) `/pricing` call to `resolve_commercial_offer` | Resolves against `commercial_default_product_id()`'s single default product, without error, without requiring a `billing_customers` row to exist |

## 7. Manual-renewal disclosure acceptance (item 8 — new)

| # | Test | Required outcome |
|---|---|---|
| 1 | Full text review of every customer-visible string introduced or touched by this implementation (`/pricing`, checkout CTA, `PaymentReturn.tsx`, Settings billing panel) | No occurrence of "subscription", "auto-renew", "automatically renews", "cancel anytime" (implying provider-side cancellation), or any phrase implying the provider or CFOClose will charge the customer again without a new, manual checkout |
| 2 | Settings billing panel, once the licence's `effective_end` approaches | Copy indicates the term's end date and that continued access requires starting a new checkout — never a countdown implying an automatic charge is coming |

## 8. Privilege and round-2 mechanism acceptance (item 10 — new)

| # | Test | Required outcome |
|---|---|---|
| 1 | **Service-role auth context** — with a staging fixture, confirm `resolve_commercial_offer` called via a genuine user session (anon key + JWT) resolves `auth.uid()` correctly, and confirm `resolve_commercial_checkout_offer` called the SAME way (not via service role) still resolves correctly because it takes an explicit `p_billing_customer_id` parameter, not `auth.uid()` | Both resolve to the correct product/plan; proves the two-function split actually closes the service-role `auth.uid()`-is-NULL defect, not merely on paper |
| 2 | **Direct RPC privilege attack — `resolve_commercial_checkout_offer`** | An authenticated (non-service-role) session calling `supabase.rpc('resolve_commercial_checkout_offer', {...})` directly receives a Postgres permission-denied error, not a result |
| 3 | **Direct RPC privilege attack — `acquire_checkout_intent_lease` / `persist_checkout_provider_result` / `fail_checkout_intent_lease`** | Same — permission-denied for an authenticated, non-service-role caller for each of the three |
| 4 | **Direct RPC privilege attack — `claim_stale_checkout_intents_for_reconciliation`** | Same — permission-denied for an authenticated, non-service-role caller |
| 5 | **Direct RPC privilege attack — `commercial_default_product_id`** | Same — permission-denied; only reachable indirectly via `resolve_commercial_offer`'s internal `SECURITY DEFINER` call |
| 6 | **Live-lease race** — staging harness holds a `PROVIDER_CREATING` row's transaction open (or simulates one via a direct `INSERT` with `lease_expires_at` in the near future) and fires a second `acquire_checkout_intent_lease` call for the same customer+offer before it expires | Second call returns `LEASE_HELD`; no second row created; no theft of the first row |
| 7 | **Stale-lease takeover** — same setup, but with `lease_expires_at` already in the past | Second call's staleness sweep marks the first row `FAILED` and creates a fresh `PROVIDER_CREATING` row; verify exactly one row transitions and one is newly created |
| 8 | **Failed CAS** — call `persist_checkout_provider_result` with a `creation_token` that does not match the row's current token (simulating a superseded lease) | Returns `persisted:false`; the row's `checkout_url` is NOT set to the attempted value; confirms the Edge Function's own contract of never returning a URL in this case is backed by a real, unbypassable DB-level guarantee, not merely application discipline |
| 9 | **Offer activation** | `admin_set_offer_purchasable('CFOCLOSE-PAID-GLOBAL-USD-MONTHLY', false, true, 'staging acceptance passed')` succeeds exactly once; a second identical call (now `p_expected_current_purchasable=false` but the row is already `true`) raises `EXPECTED_STATE_MISMATCH` |
| 10 | **Offer deactivation (rollback)** | `admin_set_offer_purchasable(..., true, false, 'pausing for review')` succeeds and the offer immediately stops resolving via `resolve_commercial_checkout_offer` (`NOT_AVAILABLE`) |
| 11 | **Transient-result constraint insertion** | An `INSERT INTO payment_webhook_processing_events (..., processing_result) VALUES (..., 'VERIFICATION_TRANSIENT_FAILURE')` succeeds against the corrected `chk_pwpe_result` constraint; the four new values (`VERIFICATION_TRANSIENT_FAILURE`, `RECONCILED`, `RECONCILIATION_NO_TRANSACTION_FOUND`, `RECONCILIATION_TERMINAL_FAILURE`) are each insertable; an arbitrary fifth invented value is still rejected |
| 12 | **Reconciliation concurrency** — invoke `claim_stale_checkout_intents_for_reconciliation` twice concurrently against a staging fixture with more eligible rows than one batch size | The two calls return disjoint row sets (verified by comparing returned `id`s); no row appears in both result sets; no deadlock, no error |
| 13 | **Selected-provider mismatch** — configure only a sandbox Flutterwave key, set `commercial_platform_state` to `LIVE_ACCEPTANCE`, and attempt checkout as a restricted (admin) identity | 503 `PROVIDER_ENVIRONMENT_MISMATCH`, proving the check now inspects the actually-selected provider (the only one configured, sandbox) against the state requiring production — not an unrelated array index that could have happened to pass |
| 14 | **TZ/GLOBAL routing** — as an authenticated customer, attempt to resolve/checkout a plan for which only a TZ-market offer exists (staging fixture) | `resolve_commercial_checkout_offer` returns `NOT_AVAILABLE` (GLOBAL has no matching offer) even though a TZ offer technically exists — proving GLOBAL-only checkout is real, not merely documented; separately, `SELECT count(*) FROM commercial_offers WHERE market_code='TZ' AND is_purchasable=true` returns 0 on the actual pre-launch staging/production data, re-verified at deploy time as required by `DATA_CONTRACTS.md` §9 |

## 9. Browser acceptance (1440 / 1024 / 390 px)

| Area | Checks |
|---|---|
| `/pricing`, unauthenticated (item 10 — new) | Selecting an interval and clicking the checkout CTA routes to sign-in/signup; the chosen interval survives the round trip (e.g. via a query param or session-storage key) and is honestly re-resolved server-side post-authentication — never trusted as a locked-in price from before login |
| `/pricing`, authenticated, existing PAID/GRACE customer (item 10 — new) | Does not show an inappropriate "buy this plan" CTA for a plan/interval the customer already holds current access to — reuses `shouldShowUpgradeAction` unchanged |
| `/pricing` general | Monthly/Annual toggle switches displayed price correctly at all three widths; no layout overflow; no raw internal plan codes ever shown |
| Checkout CTA (Settings → `CheckoutUpgradeButton`) | Loading state → redirect to Flutterwave; on error, a toast is shown and the button re-enables |
| Payment return (`/billing/payment/return`) | POLLING → CONFIRMED/FAILED/CANCELLED/TIMEOUT states render correctly; no console errors |
| Settings → Plan & Billing | Correct plan name, licence status badge, effective-through date, entitlement list, manual-renewal-safe copy (§7 above) |
| **Zero stale SAFF branding on customer-visible payment surfaces (item 13, strengthened)** | Checked in this app's own pages (already true) **and, critically, on the actual Flutterwave-hosted redirect page itself** — its title/description/logo must read CFOClose, not "SAFF ERP"; the logo image must load (a live, raster URL, not the deleted `favicon.ico` path); any visible transaction metadata must not surface `SAFF_ERP_OMEGA2` or similar. This must be checked by actually completing a sandbox checkout and observing Flutterwave's page, not by reading source code alone — the source-code fix does not by itself prove Flutterwave rendered it correctly. |

## 10. What this matrix deliberately does not assert

Unchanged from the prior round: this matrix is about the new interval-aware, product-bound, platform-state-gated, atomically-concurrent surface introduced by this design — not a re-audit of the already-proven Ω2/Ω3.0 webhook security mechanisms, except where item 7's transient/definitive split specifically touches webhook *reliability* classification (§4 item 4 above).
