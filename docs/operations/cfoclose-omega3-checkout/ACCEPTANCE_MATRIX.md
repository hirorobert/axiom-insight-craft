# Ω3-CHECKOUT — Acceptance Matrix

Design document — defines the tests that must pass on a real staging environment before Ω3-CHECKOUT is considered implemented. None of these have been run; this environment has no live Postgres/Deno connection.

**Design-correction round (this revision):** expanded per independent review (item 13) to cover the corrected atomic checkout-intent design, the customer-level commit lock, platform-state enforcement, product binding, the removed `marketCode` contract, and manual-renewal (not subscription) framing. Sections 1–3 are corrected in place for the new request shape; sections 6–11 are new.

## 1. Staging acceptance — MONTHLY path

Precondition: the two USD offers exist as `is_purchasable = false` (item 12) and have been separately, explicitly activated (`is_purchasable = true`) via `admin_supersede_commercial_offer` as its own audited step; `commercial_platform_state` is at least `SANDBOX_ONLY`; Flutterwave sandbox secrets are configured.

| Step | Action | Expected server-verifiable outcome |
|---|---|---|
| 1 | Sign up a fresh FREE user | `billing_customers` row auto-provisioned; `commercial_licences` shows FREE/ACTIVE |
| 2 | Navigate to `/pricing`, select MONTHLY | Display reads USD 49/month, sourced from `resolve_commercial_offer(PAID, MONTHLY)` (no market argument from the browser — `DATA_CONTRACTS.md` §2) once checkout is enabled here |
| 3 | Click checkout CTA | Request body is exactly `{planCode, billingInterval}` — verified by inspecting the actual network request, not just the code (§7 below); `commercial-create-checkout` returns a real Flutterwave sandbox `checkoutUrl`; `payment_checkout_intents` row created via `acquire_or_reuse_checkout_intent` with `billing_interval='MONTHLY'`, `expected_amount_minor=4900`, `currency_code='USD'` |
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
| 1 | **Simultaneous checkout creation** — fire two `commercial-create-checkout` requests for the same authenticated customer and the same offer within the same event loop tick (staging load-test harness, not two manual clicks) | Exactly one `payment_checkout_intents` row exists for the pair afterward; both requests receive the identical `checkoutUrl`/`saffReference`; server logs show one call returned `acquired:'NEW'` and the other `acquired:'REUSED'` from `acquire_or_reuse_checkout_intent` |
| 2 | **Crash between provider creation and database persistence** — in a staging harness, forcibly kill the Edge Function process (or inject a fault) after `adapter.createCheckout()` returns successfully but before the follow-up `UPDATE ... SET checkout_url` executes | The orphaned row is left `CREATED`/`checkout_url IS NULL`; a subsequent checkout attempt for the same customer+offer must NOT be served that stale/absent URL — it must observe the row transitioned to `FAILED` by `acquire_or_reuse_checkout_intent`'s explicit handling, and a fresh, working intent created |
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

## 8. Browser acceptance (1440 / 1024 / 390 px)

| Area | Checks |
|---|---|
| `/pricing`, unauthenticated (item 10 — new) | Selecting an interval and clicking the checkout CTA routes to sign-in/signup; the chosen interval survives the round trip (e.g. via a query param or session-storage key) and is honestly re-resolved server-side post-authentication — never trusted as a locked-in price from before login |
| `/pricing`, authenticated, existing PAID/GRACE customer (item 10 — new) | Does not show an inappropriate "buy this plan" CTA for a plan/interval the customer already holds current access to — reuses `shouldShowUpgradeAction` unchanged |
| `/pricing` general | Monthly/Annual toggle switches displayed price correctly at all three widths; no layout overflow; no raw internal plan codes ever shown |
| Checkout CTA (Settings → `CheckoutUpgradeButton`) | Loading state → redirect to Flutterwave; on error, a toast is shown and the button re-enables |
| Payment return (`/billing/payment/return`) | POLLING → CONFIRMED/FAILED/CANCELLED/TIMEOUT states render correctly; no console errors |
| Settings → Plan & Billing | Correct plan name, licence status badge, effective-through date, entitlement list, manual-renewal-safe copy (§7 above) |
| **Zero stale SAFF branding on customer-visible payment surfaces (item 13, strengthened)** | Checked in this app's own pages (already true) **and, critically, on the actual Flutterwave-hosted redirect page itself** — its title/description/logo must read CFOClose, not "SAFF ERP"; the logo image must load (a live, raster URL, not the deleted `favicon.ico` path); any visible transaction metadata must not surface `SAFF_ERP_OMEGA2` or similar. This must be checked by actually completing a sandbox checkout and observing Flutterwave's page, not by reading source code alone — the source-code fix does not by itself prove Flutterwave rendered it correctly. |

## 9. What this matrix deliberately does not assert

Unchanged from the prior round: this matrix is about the new interval-aware, product-bound, platform-state-gated, atomically-concurrent surface introduced by this design — not a re-audit of the already-proven Ω2/Ω3.0 webhook security mechanisms, except where item 7's transient/definitive split specifically touches webhook *reliability* classification (§4 item 4 above).
