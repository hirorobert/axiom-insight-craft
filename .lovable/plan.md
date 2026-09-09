# Ω3-CHECKOUT — Design Package (no code, no deploy)

Canonical source verified locally at `6ac832b03371329faa8a6738771b5523e9ef15bf`. This pass produces six design documents only. No source, migration, function, offer, licence, entitlement, secret, or deployment change.

## What the audit found (verified, not assumed)

1. **USD 49 monthly is NOT authoritative.** `commercial_offers` holds exactly two offers, both TZS (`SANDBOX-TEST-PAID-GLOBAL`, `SANDBOX-TEST-PAID-TZ`, exponent 0, amount_minor 1000), both `is_purchasable = false`. USD 49/499 exist only as frontend constants in `src/constants/copy.ts` (`PRICING.MONTHLY_USD`, `ANNUAL_USD`, `ANNUAL_FULL_USD = 588`, `ANNUAL_SAVING_USD = 89`, with a self-check that 49×12=588 and 588−499=89). Presentation only.
2. **USD 499 annual is NOT authoritative** — same reason.
3. **Interval is NOT explicit end-to-end.** `commercial_offers.billing_interval` (CHECK: ANNUAL|MONTHLY|ONE_TIME), `payment_checkout_intents.billing_interval`, and the licence period maths inside `commit_verified_commercial_payment` all already carry interval correctly. The single missing link is `resolve_commercial_offer(p_plan_code, p_market_code)` — it has **no interval parameter** and counts all currently-effective purchasable offers for plan+market. Two USD offers (monthly + annual) for PAID/GLOBAL would therefore return `AMBIGUOUS`, which `commercial-create-checkout` correctly refuses with HTTP 500. This is the exact and only structural blocker to publishing both prices.
4. **Browser cannot influence economics.** `commercial-create-checkout` accepts only `planCode` and an optional `marketCode`; amount, currency, exponent, offer id, plan id, interval and provider all come from the server-side resolution and are snapshotted into the intent. `commit_verified_commercial_payment` re-asserts amount and currency against the intent and raises on mismatch. Entitlements come from `commercial_plans.feature_codes` (PAID grants SAFISHA_CERTIFY, HESABU_EXPORT, MAONO_INTELLIGENCE, MULTI_COMPANY, MULTI_PERIOD), never from the browser.
5. **No new market table is needed.** `market_code` is a CHECK-constrained column (`GLOBAL|TZ|MU|GB|EU`) on both offers and intents, with GLOBAL fallback already implemented in the resolver. The requirement is representable today.
6. **Existing safety rails already present:** `payment_events.idempotency_key` UNIQUE; `payment_checkout_intents.saff_reference` UNIQUE; `commercial_licences` GiST EXCLUDE preventing overlapping ACTIVE/GRACE periods per customer; webhook records a raw receipt before processing, rejects invalid signature, detects REPLAY, and re-verifies with the provider API (`PROVIDER_API_VERIFY`) rather than trusting the callback; append-only processing events and `billing_audit_events`.
7. **Missing rail identified:** nothing prevents two concurrent CREATED/PENDING intents for the same customer, and there is no unique guard on `payment_events.checkout_intent_id` for a confirmed payment. Both are cheap, additive constraints.

## Minimum safe correction (to be specified in the docs, not implemented here)

- One forward migration: add an optional `p_billing_interval text DEFAULT NULL` to `resolve_commercial_offer` (interval filter applied only when supplied, so all existing callers keep today's behaviour), plus a partial unique index preventing two purchasable, currently-effective offers for the same plan+market+interval, plus the two concurrency/duplicate guards above.
- Two authoritative USD offers created through the existing controlled offer authority (`admin_upsert_commercial_offer`) — `PAID/GLOBAL/USD/4900/exp 2/MONTHLY` and `PAID/GLOBAL/USD/49900/exp 2/ANNUAL` — not a migration, not hardcoded pricing.
- Thread `billingInterval` (MONTHLY|ANNUAL) from Pricing/Settings through `createCheckoutIntent(planCode, billingInterval, marketCode?)` into the Edge Function's existing resolution call. No new architecture.

The prior Ω2 TZS exponent-0 / amount_minor 1000 evidence is treated strictly as historical sandbox test evidence. USD offers carry exponent 2; the sandbox offers stay non-purchasable and unchanged.

## Documents to be written on approval

Under `docs/operations/cfoclose-omega3-checkout/`:

1. `PHASE_BRIEF.md` — scope, freeze boundaries, public economics, stop-line before implementation.
2. `COMMERCIAL_ARCHITECTURE_AUDIT.md` — file-and-object-level audit of plans, offers, RPCs, the three Edge Functions, Flutterwave adapter, receipts/processing-events/payment-events/licences/entitlements/audit, existing commercial tests, and migration history, with the seven findings above evidenced.
3. `DATA_CONTRACTS.md` — `createCheckoutIntent(planId, billingInterval)` contract, resolver signature change, intent snapshot fields, webhook and status contracts, licence transition state machine, idempotency keys and unique constraints (existing vs required).
4. `THREAT_AND_FAILURE_MODEL.md` — every failure mode named in the mission, each marked ALREADY MITIGATED (with the exact rail) or REQUIRES WORK, including Tanzania compatibility and existing-customer compatibility (the live PAID/ACTIVE TZS customer must remain untouched).
5. `ACCEPTANCE_MATRIX.md` — staging acceptance path per case, expected observable evidence, and which cases are NOT_TESTABLE_LIVE.
6. `IMPLEMENTATION_PLAN.md` — ordered slices, files that may change, files that must not change, migration identity/replay-collision handling, rollback strategy, deployment gates.

## Key gate

Publishing USD 49/499 requires two new authoritative USD offers **and** the interval-aware resolver in the same slice — either alone produces `AMBIGUOUS` (500) or a price shown but not purchasable. No implementation until the independent Codex adversarial audit clears this design.
