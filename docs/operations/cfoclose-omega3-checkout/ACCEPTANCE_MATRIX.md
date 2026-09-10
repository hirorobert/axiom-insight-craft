# Ω3-CHECKOUT — Acceptance Matrix

Design document — defines the tests that must pass on a real staging environment (project-ref, not this local repo) before Ω3-CHECKOUT is considered implemented. None of these have been run; this environment has no live Postgres/Deno connection.

## 1. Staging acceptance — MONTHLY path

Precondition: the two USD offers exist (`IMPLEMENTATION_PLAN.md` §3), `commercial_platform_state` is at least `SANDBOX_ONLY`, Flutterwave sandbox secrets are configured.

| Step | Action | Expected server-verifiable outcome |
|---|---|---|
| 1 | Sign up a fresh FREE user | `billing_customers` row auto-provisioned via `provision_billing_customer_for_company`; `commercial_licences` shows FREE/ACTIVE |
| 2 | Navigate to `/pricing`, select MONTHLY | Display reads USD 49/month, sourced from `resolve_commercial_offer(PAID, GLOBAL, MONTHLY)` — not the hardcoded `PRICING.MONTHLY_USD` constant once checkout is enabled here (see `IMPLEMENTATION_PLAN.md` §1 for whether Pricing.tsx itself calls the resolver or continues to defer to Settings/CheckoutUpgradeButton) |
| 3 | Click checkout CTA | `commercial-create-checkout` returns a real Flutterwave sandbox `checkoutUrl`; `payment_checkout_intents` row created with `billing_interval = 'MONTHLY'`, `expected_amount_minor = 4900`, `currency_code = 'USD'` |
| 4 | Complete payment in Flutterwave sandbox | Flutterwave sends webhook; `payment_webhook_receipts` row inserted; Gate A passes; Gate B's independent `verifyTransaction` call confirms amount/currency/reference |
| 5 | — | `commit_verified_commercial_payment` transitions licence to PAID/ACTIVE, `effective_end` = now + 1 month |
| 6 | Navigate to Settings | Plan badge reads "CFOClose Professional" (`displayPlanName`), licence status "Active", `{EFFECTIVE_END_LABEL}` shows the correct date, entitlements list includes `MAONO_INTELLIGENCE`/`MULTI_COMPANY`/etc. |
| 7 | Check `billing_audit_events` | An audit row exists documenting the FREE→PAID transition with the correct `action`/`previous_state`/`new_state` |

## 2. Staging acceptance — ANNUAL path

Identical to §1 with `billingInterval = 'ANNUAL'`, expecting `expected_amount_minor = 49900`, `effective_end` = now + 1 year, and Settings displaying USD 499/year.

## 3. Staging acceptance — adversarial/edge cases (both intervals)

| # | Scenario | Required server-verifiable outcome |
|---|---|---|
| 1 | Duplicate webhook delivery (resend the same Flutterwave payload) | Second delivery returns `ALREADY_COMMITTED`/`REPLAY`; `commercial_licences` unchanged; a new `payment_webhook_processing_events` row is recorded but no second licence period is created |
| 2 | Replay days later | Same as above — the idempotency key is not time-bound |
| 3 | Amount mismatch (tamper the webhook payload's `amount` field in a test harness, if the sandbox allows) | Gate B's independent provider re-fetch does not use the tampered payload amount at all — verification proceeds on the true provider-side value; a genuinely mismatched *provider-side* value must be rejected with `AMOUNT_MISMATCH` and no commit |
| 4 | Currency mismatch | Rejected with `CURRENCY_MISMATCH`, no commit |
| 5 | Expired intent (wait out `expires_at`, then attempt to pay) | `authoriseCommit` rejects `INTENT_EXPIRED`; no commit |
| 6 | Invalid interval value sent directly to the Edge Function (bypassing the UI) | 400 `INVALID_BILLING_INTERVAL`, no offer resolution attempted |
| 7 | Concurrent checkout (two tabs, same customer, same offer, near-simultaneous click) | Both tabs receive the *same* `checkoutUrl`/`saffReference` (the reuse-check in `DATA_CONTRACTS.md` §6); exactly one `payment_checkout_intents` row exists for the pair |
| 8 | Existing PAID customer attempts to buy the same plan/interval again | Either blocked by `shouldShowUpgradeAction` client-side (already proven, `CheckoutUpgradeButton.test.ts`) or, if reached directly, results in a licence closeout+reinsert that leaves the customer PAID/ACTIVE with an updated `effective_end` — never a downgrade, never a duplicate ACTIVE row (the GiST EXCLUDE constraint would reject a genuine overlap) |
| 9 | Existing Tanzania (TZ market, TZS currency) customer flow | Entirely unaffected — verify their existing offer/checkout path still resolves and commits exactly as before this design shipped (regression check, not a new scenario) |

## 4. Browser acceptance (1440 / 1024 / 390 px)

| Area | Checks |
|---|---|
| `/pricing` | Monthly/Annual toggle switches displayed price correctly at all three widths; no layout overflow; the locked "checkout being activated" panel is replaced by a real, working checkout CTA once this design ships; no raw internal plan codes (`PAID`, `FREE`) are ever shown to the customer — only `PRICING.PAID_NAME`/`FREE_NAME` (already true today, must remain true) |
| Checkout CTA (Settings → `CheckoutUpgradeButton`) | Loading state (`Loader2` spinner) → redirect to Flutterwave; on error, a toast is shown and the button re-enables (no stuck spinner) |
| Payment return (`/billing/payment/return`) | POLLING → CONFIRMED/FAILED/CANCELLED/TIMEOUT states each render correctly; ref is shown only in non-CONFIRMED states (existing, intentional — a confirmation screen should not look like a raw receipt); no console errors; no failed network requests other than the expected polling calls |
| Settings → Plan & Billing | Correct plan name, licence status badge variant (`licenceBadgeVariant`), effective-through date, entitlement list — using real, server-returned values only |
| General | No console errors or failed network requests attributable to this implementation at any of the three widths; no stale "SAFF" branding anywhere in the checkout flow, **including the Flutterwave-hosted page itself** (closes the `customizations.title`/`meta.source`/`logo` finding in `COMMERCIAL_ARCHITECTURE_AUDIT.md` §1.4 — this must be checked on the actual redirected Flutterwave page, not just this app's own pages, since that stale branding lives in a payload sent *to* Flutterwave) |

## 5. What this matrix deliberately does not assert

Per Step 12/13's own scope: no assertion here claims the underlying two-gate webhook security model needs new testing — that is already covered by `edgeFlutterwaveGateB.test.ts` and `webhookEvidenceModel.test.ts` at the unit level; this matrix is about the *new* interval-aware surface (resolver, checkout request shape, concurrency reuse-check, and the two new USD offers), not a re-audit of already-proven Ω2/Ω3.0 mechanisms.
