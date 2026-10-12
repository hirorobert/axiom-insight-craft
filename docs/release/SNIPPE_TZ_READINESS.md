# Snippe (Tanzania mobile money, TZS): production readiness

- **Status:** the route is implemented and checked against Snippe's documentation, but it is **not launched**. It stays disabled in code: `SNIPPE_CUSTOMER_CHECKOUT_ENABLED = false` on the server and `LAUNCHED_MARKETS = ["GLOBAL"]` in the frontend.
  - **No TZS price is approved.** None is calculated from USD.
  - Nothing here enables Snippe, charges anyone or changes the hosted project.
- **The ledger is the existing one.** A Snippe payment is an ordinary `payment_checkout_intents` row (provider `SNIPPE`, `TZS`, market `TZ`). It is committed by the same `commit_verified_commercial_payment` as Polar. Its licence has source `SNIPPE_VERIFIED_PAYMENT`. There is no parallel billing system.
- **Deployment:** no migration is needed. The changed shared code is used by four Edge Functions: `commercial-create-checkout`, `commercial-payment-status`, `commercial-webhook-polar` and `commercial-webhook-snippe`.
  - Deploying them changes nothing for customers, because Snippe is still never offered on the hosted project.
  - **Do not set any `SNIPPE_*` secret** on the hosted project under this release.

## 1. The implementation against Snippe's documentation

Documentation re-read on 2026-10-11, API version `2026-01-25`: [payments](https://docs.snippe.sh/docs/2026-01-25/payments), [mobile money](https://docs.snippe.sh/docs/2026-01-25/payments/mobile-money), [webhooks](https://docs.snippe.sh/docs/2026-01-25/webhooks), [authentication](https://docs.snippe.sh/docs/2026-01-25/authentication) and [error handling](https://docs.snippe.sh/docs/2026-01-25/error-handling).

| Topic | Documented | Implementation | Change in this release |
|---|---|---|---|
| Authentication | `Authorization: Bearer <key>`; keys `snp_…`, with scopes (`collection:create`, `collection:read`). A test key used in production answers 401. | Bearer `SNIPPE_API_KEY`, server-side only. | None. **Confirm:** the key is issued with only the collection scopes. |
| Environment separation | **No sandbox host and no test-mode marker on a payment are documented.** The only host is `api.snippe.sh`. | The environment is `SNIPPE_ENVIRONMENT`, set explicitly and never defaulted. A sandbox payment records a non-granting `SANDBOX` licence (commercial-p3). | Recorded as a **blocking confirmation** (§4). Snippe's API cannot tell us whether a payment was a test, so the environment depends entirely on this deployment's configuration. |
| Amount units | TZS only; integers in the smallest unit; minimum 500; the maximum varies by account. | `currency_exponent = 0`; refuses anything other than TZS, or less than 500, before any request. | None. **Confirm:** the account's maximum. |
| Phone formats | `255XXXXXXXXX` or `+255XXXXXXXXX`, a valid Tanzanian mobile number. | Normalises `0…`, `+255…` and spaced forms to `255[67]XXXXXXXX`; anything else is refused before any request. | None. |
| Create payment | `POST /v1/payments`, `payment_type: "mobile"`; the answer carries `reference`, `status: pending`, `amount{value,currency}` and `expires_at`. | The reference is bound to the order. An answer whose amount or currency differs from the offer is never handed to the customer. | None. |
| Idempotency | `Idempotency-Key` up to 30 characters (a longer one gets 500 `PAY_001`), kept 24 hours. The same body returns the cached answer; a different body returns 422. | The key is the order reference (always 30 characters or fewer, checked before any request). One bounded retry reuses it. | **409 and 422 are now UNCERTAIN.** Either can mean a payment already exists under the key; before, they were reported as "nothing was created". |
| Status read-back | `GET /v1/payments/{reference}` returns `reference`, `status`, `amount`, `channel` and timestamps, **without `metadata`**. Statuses: `pending`, `completed`, `failed`, `voided` (cancelled), `expired`. | Every webhook is read back from Snippe (Gate B). Only completed, failed, voided and expired are final. | **The reference is now required, and a completed payment must report its amount.** Before, a missing reference was accepted, and a missing amount was filled in from the offer. |
| Webhook signature | `X-Webhook-Signature` = hex HMAC-SHA256 of `"{X-Webhook-Timestamp}.{raw body}"`, keyed with the account's signing key `whsec_…` exactly as issued. Snippe recommends 5 minutes of tolerance. | The same, compared in constant time, with a 300-second window. | **A signing key without `whsec_` leaves Snippe unconfigured** (for example, an API key pasted into the wrong setting). |
| Webhook delivery | 2xx within 30 seconds; retries at 0, 3, 6, 12 and 24 minutes, then abandoned; duplicates possible, deduplicated by event `id`. The 2026-01-01 flat format names the event in `event`. | Receipt first, then signature, duplicate check, read-back and an idempotent commit. A correctly signed stale delivery only triggers a throttled reconciliation. | **Each read-back attempt now times out after 10 seconds**, so two attempts fit in 30 seconds. **The flat `event` format is recognised.** |
| Refunds | **No refund API and no refund event are documented.** `voided` means cancelled before completion. | The adapter reports no reversals. | Recorded as a **blocking confirmation** (§4). |
| Expiry | "Payments expire after 4 hours" (payments page); "default expiry is 1 hour" (webhooks page). | The order expires locally after 1 hour, but a payment verified later still settles once (proven, §2). | None. **Confirm** which expiry applies. |
| Fees and settlement | `settlement{gross, fees, net}` appears in `payment.completed` and in list items (500 gross, 9 fees, 491 net in the example). No schedule is documented. | The gross amount is verified against the offer. Fees and net are not recorded. | None. **Confirm** the fee schedule and payout timing (§4). |

## 2. What is proven, and where

| Proof | Kind | Covers | Result |
|---|---|---|---|
| `scripts/db-proof/snippeLedger.mjs` | **Local, real PostgreSQL**, full current chain | See the list after this table | **30/30** |
| `providerAdapters.test.ts`, Snippe sections | **Mock HTTP** against the exact Edge Function files | Every change in §1; the documented status shape verifies; settlement through the real Snippe adapter commits once for a success, records failed, voided and expired, and commits nothing for pending, mismatched or unreadable answers; a sandbox adapter never settles a production order | PASS |
| `scripts/e2e/paymentJourney.mjs`, mobile money | **Mock Snippe**, real Edge Functions and local Supabase; CI only | A checkout for exactly the TZS offer; a signed `payment.completed` gives a `SANDBOX` licence; then a replay, a forged signature, a stale capture, an unknown reference and 5 concurrent deliveries each change nothing | CI (`real-app-e2e`) |
| Snippe sandbox or production | **Provider** | — | **NOT RUN.** No credentials; out of scope. |
| Hosted application | **Hosted** | — | **NOT RUN.** Nothing deployed under this release. |

The ledger proof covers:
- no TZS price exists or is purchasable until an administrator records and approves one, at exactly the amount entered;
- one licence per verified success, given to the right account only;
- failed, voided and expired payments grant nothing;
- mismatched amounts, currencies, providers or environments are refused, and nothing is written;
- 12 concurrent commits produce one licence;
- a success verified after the order's local expiry grants once;
- one attempt at a time per account across Polar and Snippe, and a Polar term followed by a Snippe term never overlap;
- renewal, upgrade and downgrade are placed correctly;
- a sandbox payment gives a `SANDBOX` licence that grants nothing;
- a refund is held for review and the administrator decides once;
- administrator placement works, and an uncertain attempt is honoured once proven;
- paid terms and paid additional users are protected, and the reporting rollout is unchanged.

Mock and local proofs show what this code and database do. They cannot show what Snippe does: that needs a provider sandbox, or a controlled live test, run by the owner.

## 3. Prices

- **No TZS price exists in the repository or the hosted migrations.** The TZ market resolves to nothing, and the public price list has no TZS.
- **The hosted database carries two legacy TZS rows** under the retired plan `PAID`: `SANDBOX-TEST-PAID-TZ` and `SANDBOX-TEST-PAID-GLOBAL`, both active and **not** purchasable. They are historical records, not prices. Release gates list them unchanged and refuse only a **purchasable** TZS/TZ offer (`docs/release/commercial-p4/purchasing_gate.sql`).
- **A TZS price exists only when a commercial administrator records an explicit amount and approves it,** with a reason, through `admin_upsert_commercial_offer`.
- **Nothing converts USD to TZS.** There is no exchange-rate logic, and a test guards against it.
- **An approved TZS price is still not offered:** the server never configures Snippe on the hosted project, and the frontend shows only `GLOBAL`.
- **Note:** the anonymous `get_public_plan_prices()` would return an approved TZS amount, because only the frontend filters by launched market. Approve a TZS price only as part of launching the route.

## 4. Confirmations required before Snippe can be enabled (owner)

Polar's merchant-of-record arrangements **do not cover Snippe.** For Snippe sales, CFOClose's own legal entity is the seller.

| # | Area | To confirm, in writing, with Snippe or the owner's advisers |
|---|---|---|
| 1 | Merchant onboarding | KYC completed for CFOClose's Tanzanian entity: eligible business type (software subscriptions), required documents, account approval and the transaction maximum. |
| 2 | Environment separation | How test and live are separated: separate accounts, keys or hosts. Whether a payment made with a test key can ever be live, and whether Snippe can mark a payment as a test. **Provider evidence so far (2026-10-11):** the documentation index lists "environments" as an Authentication topic, but the page says only that a test key used in production is refused (401). It documents no sandbox host, no key prefix per mode and no test marker on a payment. **Not confirmed.** Labelling a payment "sandbox" in our configuration is not isolation. Never configure production with a key whose mode Snippe has not confirmed in writing. |
| 3 | Settlement | The payout account (bank or mobile wallet), the schedule and any minimum. Settlement currency TZS. How a settlement report reconciles to `payment_events`. |
| 4 | Fees | The fee schedule per network (M-Pesa, Airtel Money, Mixx by Yas, Halotel), who bears it, and whether it is shown to the customer. The example shows 9 TZS on 500. |
| 5 | Refunds and reversals | **Whether Snippe can refund a mobile-money collection at all, and how.** No refund API, event or procedure is documented, so dashboard or support refunds are **not confirmed**. Also to confirm: how long a refund takes, what reference Snippe issues for it, and whether it appears in a settlement report. **CFOClose never issues a refund, and a refund completed outside CFOClose is never reported to it.** It exists in CFOClose only once an administrator records the already-completed refund with `admin_record_provider_refund` (commercial-p4, `PAYMENT_REVERSAL_AUTHORITY.md` §5): Snippe's refund reference, the evidence, the reconciled amount and an explicit licence decision, all audited. The owner still has to approve the operating procedure: who checks Snippe, how often, and what evidence is kept. |
| 6 | Disputes and chargebacks | Whether mobile-money reversals can be initiated by the network or the customer, and how they are notified. |
| 7 | Tax and invoicing | VAT registration status and rate, EFD/EFDMS receipting duties for each TZS sale, invoice content and numbering, and withholding (if any) on B2B sales. This is TRA compliance for CFOClose's own entity, and Polar does not carry it. |
| 8 | Customer terms | `/terms` and `/privacy` cover TZS mobile-money purchases: refunds, payment data processed by Snippe, and the dispute route. Legal review is still open (`LEGAL_PROFESSIONAL_REVIEW_REQUIRED_BEFORE_PAID_GO_LIVE`). |
| 9 | Operations | Snippe's webhook source IPs (if allow-listing is wanted); support contacts; what happens on an `abandoned` webhook (the customer's status page and an administrator's recovery still read back from Snippe). |
| 10 | Prices | Explicit TZS amounts for Solo, Practice and Firm, approved by the owner. These are not derived from USD. |

## 5. Registered defect found here (now fixed in source by commercial-p4, pending hosted application)

**DEFECT-PAYMENT-REVERSAL-UNBOUND-001** (medium; pre-existing, live since `20260906083524`).

`record_payment_reversal` records a refund or chargeback against an original payment event without checking that:
- the original is a confirmed payment;
- the currency matches;
- the amount does not exceed what was paid.

**Impact:**
- **Access:** none. A reversal never changes a licence, and the function is service-role only.
- **Records:** a malformed provider report could still be recorded as a wrong-currency or excessive refund.
- **Snippe:** not reachable, because Snippe reports no reversals.

**Repair:** `20261101100000_payment_reversal_authority.sql` (batch **commercial-p4**). It bounds every reversal, makes a licence decision take effect, and adds the audited Snippe refund workflow. Historical discrepancies are reported, never rewritten. Record: `PAYMENT_REVERSAL_AUTHORITY.md`; hosted steps: `COMMERCIAL_P4_LOVABLE_DELTA.md`.

## 6. Enabling later (not under this release)

1. Every confirmation in §4 is recorded.
2. The owner approves explicit TZS prices.
3. A reviewed release changes `SNIPPE_CUSTOMER_CHECKOUT_ENABLED` and `LAUNCHED_MARKETS`.
4. Sandbox acceptance runs with Snippe's sandbox or test arrangement (§4 #2), then a controlled live payment.
5. Payments open through the commercial checklist.

## 7. Remaining work

This is a **readiness** release, not launch certification. Each row says what kind of evidence exists, and what is still needed.

| Area | Code proof (local / mock) | Provider verification (Snippe) | Hosted acceptance | Owner decision |
|---|---|---|---|---|
| Adapter against the documentation (auth, TZS units, phone formats, idempotency, read-back, signature, retries) | **Done.** `providerAdapters.test.ts` | **Not run.** One sandbox or test request per behaviour, once #2 is answered | **Not run.** Deploy with Snippe disabled (readiness package S-1 to S-4) | — |
| Ledger: one licence per verified success; failed, expired, forged, duplicate, delayed and mismatched payments grant nothing; Polar and Snippe attempts; placement | **Done.** `snippeLedger.mjs` 30/30 | — | **Not run** | — |
| Webhook attacks through the real Edge Functions (replay, forged, stale, unknown, concurrent) | **Done (mock Snippe).** CI journey | **Not run.** Snippe's real signatures and retry timing | **Not run** | — |
| Test/live separation | Configuration only: a payment recorded as sandbox never grants (commercial-p3). This is **not** isolation: our label cannot make a real payment a test. | **UNRESOLVED PROVIDER PREREQUISITE.** No sandbox host, test key format or test marker on a payment is documented (§4 #2) | **Not run** | Get Snippe's written confirmation. Until then, never configure a Snippe environment whose mode Snippe has not confirmed. |
| Reversal bounds (confirmed original, currency, positive amount, cumulative, idempotency, concurrency); history reported, not rewritten | **Done.** `paymentReversalAuthority.mjs` 38/38 | — | **Pending:** commercial-p4 apply and postcondition (P4-1 to P4-6) | Decide any historical discrepancy the postcondition lists |
| Recording an externally completed Snippe refund, with evidence, reconciliation and a licence decision (records only; issues nothing) | **Done (database).** RPC proven; no screen yet | **UNRESOLVED.** Whether and how Snippe refunds at all is undocumented (§4 #5) | **Pending** with commercial-p4 | Agree a refund route with Snippe; approve the operating procedure; decide whether to build a screen |
| Licence decision after a refund takes effect | **Done.** `paymentReversalAuthority.mjs` | — | **Pending** with commercial-p4 | — |
| Merchant onboarding, settlement, fees, disputes | — | **Not run** (§4 #1, #3, #4, #6) | — | Owner, with Snippe |
| Tax and invoicing (TRA, VAT, EFD) for CFOClose's own entity | — | — | — | Owner and advisers (§4 #7); Polar's merchant of record does not cover this |
| Customer terms for TZS mobile money | — | — | — | Legal review (§4 #8) |
| TZS prices | No price exists; nothing derived from USD (proven) | — | — | Owner approves explicit amounts (§4 #10) |
| Enablement | `SNIPPE_CUSTOMER_CHECKOUT_ENABLED = false`, `LAUNCHED_MARKETS = ["GLOBAL"]` | Sandbox acceptance, then a controlled live payment | After every row above | A reviewed release |
