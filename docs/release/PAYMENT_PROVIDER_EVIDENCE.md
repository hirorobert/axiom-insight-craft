# Payment providers: evidence and launch arrangement

- **Read on:** 10 October 2026, from each provider's public documentation (sources below). Polar's pages were re-read on 10 October 2026 for the launch closure. Nothing here was confirmed with either provider, and no account was opened.
- **Owner decision (10 October 2026):** the launch takes **card payments through Polar only**, conditional on Polar approving the merchant and on sandbox and controlled live verification passing.
  - No TZS price is approved, so the Snippe (mobile-money) route is **not launched**.
  - Its implementation is kept, but the server never offers it: `SNIPPE_CUSTOMER_CHECKOUT_ENABLED = false` in `supabase/functions/_shared/payments/routing.ts`, and `LAUNCHED_MARKETS = ["GLOBAL"]` in `src/lib/commercial/planOffers.ts`.
- **Not established:** that Polar will onboard the CFOClose merchant entity, or accept its offering. The owner must complete Polar's account review (§0).

## 0. Polar eligibility: what the documentation supports, and what it does not

| Question | What the documentation says | Status |
|---|---|---|
| Can a Tanzania-based business **receive payouts**? | Tanzania is in the **payout** list: "Polar uses Stripe Connect Express to issue payouts to residents or businesses in any of the countries below." This may be cross-border. | **The country is supported for payouts.** This is not approval of our entity. |
| Who can **pay**? | Every country except those under US sanctions. Customer payments go to Polar (US) as merchant of record. | Supported. |
| Is **our offering** acceptable? | Software and B2B SaaS are accepted. Human services as the primary offering are not. Prohibited: "financial advice content or services related to tax guidance", and regulated services or products. Polar may refuse in its sole discretion, and the list is not exhaustive. | **Not established.** CFOClose is accounting software that performs checks and records the user's decisions. It gives no tax advice, and professional judgement stays with the user. Whether Polar accepts that is Polar's decision at review. |
| **Consulting** and specialist services | Human services are not accepted. | **Not eligible; never sold through Polar.** They stay on enquiry and quotation. |
| **Enterprise** | — | Quoted separately; never sold through Polar. |
| What does **onboarding** require? | In **Finance → Account**: (1) submit for approval, describing the business, products and intended use; (2) the organization owner verifies their identity through Stripe Identity (passport, ID card or driver's licence, plus a selfie); (3) connect a Stripe Connect Express payout account. Polar recommends having products, the integration and a live website ready first. A review can take up to 14 days, and payouts are held until it completes. Polar also reviews continuously at sales thresholds, and monitors a 0.4% chargeback target. | **Owner action required** (all three steps). |
| Individual or company? | The review page does not distinguish. An individual may sell only where Stripe Connect Express supports that business type for their country, and the page does not say whether it does for Tanzania. | **The owner decides which legal entity sells**, and confirms it with Polar. |
| Is **accepting payments** gated on approval? | The review page names a gate for **payouts** only. | Our policy is stricter: customer checkout opens only **after** Polar approves the account (checklist Stage E). |

## 1. Facts

| | Snippe | Polar |
|---|---|---|
| **What it is** | Tanzanian payment service provider (processor). The merchant stays the seller of record. | **Merchant of record.** Polar is the legal seller to the customer and handles global sales tax, VAT and GST. The business is paid out as Polar's supplier. |
| **Merchant eligibility** | Merchant KYC with Snippe. The documentation lists no merchant criteria; Tanzanian bank and mobile payouts imply a Tanzanian business. **Not confirmed.** | Tanzania is in the **payout** country list (Stripe Connect Express, possibly cross-border). Payments are accepted from every country except those under US sanctions. Software and B2B SaaS are accepted. **Prohibited:** human or professional services as the primary offering, and "financial advice … related to tax guidance". CFOClose is software that records checks and decisions; consulting is excluded from this route by design (§3). **Account review is required; approval is at Polar's discretion.** |
| **Onboarding** | API key from the dashboard (`snp_…`); KYC. | Organization → submit for review, owner identity verification (Stripe Identity), connect the payout account. A review can take up to 14 days; payouts are held until it completes. |
| **Payment methods** | **Mobile money only:** M-Pesa, Airtel Money, Mixx by Yas, Halotel, by USSD push to the customer's phone (the customer approves with their PIN). No cards. | Cards, Apple Pay, Google Pay and Link, plus some regional methods. **No mobile money.** |
| **Currencies** | **TZS only.** Other currencies are refused (400). Minimum 500 TZS. | 130+ presentment currencies, including USD and TZS. Settlement is in USD. |
| **Hosted checkout** | Hosted payment sessions (`POST /api/v1/sessions`). Also a direct mobile-money request (`POST /v1/payments`). | Hosted checkout sessions (`POST /v1/checkouts/`), with server-set ad-hoc prices. |
| **Subscriptions / renewal** | **Not documented.** One-off payments only. | Monthly, yearly or custom intervals, or one-time products. |
| **Status check** | `GET /v1/payments/{reference}`: pending, completed, failed, voided, expired. A payment expires after 4 hours. | `GET /v1/checkouts/{id}` (open, expired, confirmed, succeeded, failed) and `GET /v1/orders?checkout_id=` (draft, pending, paid, refunded, partially_refunded, void, with net, tax and total amounts). |
| **Idempotency** | `Idempotency-Key` header, at most 30 characters, valid 24 hours. The same key with a different body is an error. | Not documented. Duplicate creation is prevented locally (§3). |
| **Webhook authentication** | HMAC-SHA256 over `{X-Webhook-Timestamp}.{raw body}`, hex, in `X-Webhook-Signature`. Reject requests older than 5 minutes. Events: `payment.completed`, `payment.failed`, `payment.voided`, `payment.expired`. 5 attempts (0, 3, 6, 12, 24 min), then abandoned. Deduplicate by event `id`. | Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`). HMAC-SHA256 over `{id}.{timestamp}.{body}` with the base64 key after `whsec_` (secrets created from 8 September 2026). 10 retries with backoff; 10-second timeout; redirects count as failures. Events include `order.paid`, `order.refunded`, `refund.created`, `checkout.expired`. |
| **Sandbox** | **Not documented.** The documentation implies test keys exist ("using test key in production" is listed as a 401 cause). | Yes: `https://sandbox-api.polar.sh`, with a separate sandbox account, organization and token. Test card 4242 4242 4242 4242. |
| **Refunds** | **Not documented.** | Merchant-initiated, full or partial (tax prorated), from the order page. Polar keeps its fees. Polar may refund within 60 days on its own, including to head off a chargeback. |
| **Disputes** | Not documented. | $15 per dispute, deducted from the balance. Polar monitors a 0.4% chargeback target and may refund early to prevent a chargeback. |
| **Fees** | Not published. The documentation's example is 1,000 on 50,000 TZS (illustrative only). | Starter plan: 5% + $0.50, plus 1.5% for non-US cards. Payout fees are passed through from Stripe: 0.25% + $0.25 per payout, and 0.25–1% currency conversion. |

## 2. What this means (written before the Polar-only decision; kept for the record)

- **Neither provider alone covers the market.** A Tanzanian firm typically pays by mobile money in TZS, which Polar does not offer. An international firm pays by card, which Snippe does not offer.
- **Polar carries the tax and compliance burden for international sales.** As merchant of record it is the legal seller. Snippe leaves the seller (CFOClose's entity) responsible for its own TRA obligations on TZS sales.
- **Renewal must not depend on a provider subscription.** Snippe has none, and the approved model is one 12-month term (`20261001120000`). Both routes therefore sell one 12-month term as a one-time payment, and renewal is a new purchase that starts when the current term ends. Nothing is charged automatically, so there is nothing to cancel.

## 3. Arrangement: one checkout, two implemented routes; **only the card route is launched**

| Route | Provider | Who | What is charged | Market and currency |
|---|---|---|---|---|
| **Card** | Polar (merchant of record) | Customers outside Tanzania, or anyone choosing to pay by card | The **USD** annual offer, plus any sales tax Polar adds as merchant of record | `GLOBAL`, USD |
| **Mobile money** *(not launched)* | Snippe | — | Nothing: no TZS price is approved | `TZ`, TZS, never offered on the hosted project |

### Routing rules

These are enforced by the server, never by the browser.

1. The customer chooses only the plan and the payment method (card or mobile money). The server maps card to the `GLOBAL` market and mobile money to `TZ`.
2. The server resolves the active, purchasable, annual offer for (plan, market). If none exists, that route is unavailable. The offer's own market must equal the route's market, so a fallback offer never crosses routes.
3. **The mobile-money route is not launched:** the server offers it only when `SNIPPE_CUSTOMER_CHECKOUT_ENABLED` is true (it is `false`). The one exception is a sandbox Snippe pointing at a loopback mock, which is possible only in local tests, because `SNIPPE_API_BASE_URL` is never set on the hosted project. An approved TZS price would not open it either.
4. The provider is selected by declared capability: Snippe supports only `TZS` in `TZ`; Polar supports only `USD` in `GLOBAL`. A provider is "configured" only when all of its server-side credentials are present (§5). No provider is ever substituted for another.
5. One open attempt per customer per product (the existing unique index). A second click returns the same attempt; it never creates a second charge.
6. **Specialist services and Enterprise are never sold through either route.** They stay on the enquiry-and-quotation path. This also keeps the Polar route inside Polar's acceptable-use policy, which excludes human services.

### Why two routes were built (before the Polar-only decision)

- **Snippe only:** card buyers outside Tanzania could not pay.
- **Polar only:** Tanzanian mobile-money buyers could not pay, and Polar's review of a Tanzania-based accounting-software seller is not assured.

Under the owner's decision, only the card route is launched. Tanzanian customers who cannot pay by card are activated by agreement (**Request activation**), as before.

## 3a. Webhook timing, retries and delayed notifications (Polar)

**Documented:**
- Standard Webhooks signatures.
- Up to 10 retries with exponential backoff; no schedule is given.
- A 10-second timeout, with a recommendation to respond within 2 seconds.
- An endpoint is disabled after 10 consecutive non-2xx responses.
- Manual redelivery from the dashboard.

**Not documented:** whether a retry or a manual redelivery carries a fresh `webhook-timestamp` and signature. A delayed retry or a redelivery may therefore arrive older than our 5-minute window.

**How CFOClose handles it** (`supabase/functions/_shared/payments/webhookEndpoint.ts`):
1. The signature is always verified. An invalid one gets a 401, and nothing else happens.
2. A **correctly signed but stale** delivery is never believed by itself. It is recorded as `STALE_TIMESTAMP`, and serves only to name the order to look at.
3. An event id already seen is a `DUPLICATE`: 200, with no provider call.
4. Otherwise the server **reads Polar's own record** of that order (`settleIntent`). It checks the organization and product, the reference, the account, the amount and the currency, then commits through the same idempotent path as every other delivery. The answer is 200 with `reconciled: true`.
5. These reads are throttled to one a minute per order, answering 202 `RECONCILIATION_THROTTLED`.

**Evidence** (end-to-end journey, mock provider): a 20-minute-old `order.paid` for an order paid silently is recovered once, giving one licence and one payment event. A replay records nothing.

Without any webhook, the customer's status page and the administrator's **Check with the provider** perform the same read.

## 3b. Refunds and disputes (Polar)

| Event | Polar documents | CFOClose records | Access |
|---|---|---|---|
| Full refund, from the order page | `order.refunded`, `refund.created`, `refund.updated`; order status `refunded`, with `refunded_amount` | **Automated:** a REFUND reversal for the amount, listed for an administrator | Unchanged until an administrator decides |
| Partial refund | Status `partially_refunded`; tax prorated | **Automated:** each reversal records only the **change** in Polar's cumulative refunded amount (for example 200.00, then 290.00; never 490.00 twice) | Unchanged until an administrator decides |
| Refund by Polar itself (within 60 days, or early to head off a chargeback) | Arrives as a refund | **Automated**, as above | Unchanged until an administrator decides |
| Dispute or chargeback | **No dispute webhook is documented.** USD 15 per dispute; 0.4% target. | **Manual:** check Polar's dashboard. `record_payment_reversal` supports `CHARGEBACK`, but no Polar event feeds it. | Decided manually by an administrator |
| Refund the customer requests in Polar's portal | Not documented | Recorded as a refund if one happens | As above |

- **Polar's "revoke benefits" option** on a refund concerns Polar benefits. CFOClose configures none, because access is CFOClose's own licence, so the option changes nothing.
- **Merchant of record** makes Polar the legal seller and responsible for sales tax. It does **not** decide whether a CFOClose licence continues after a refund. That is the owner's access policy, applied by an administrator (`docs/release/REFUNDS_DISPUTES_AND_RECOVERY.md`).

## 4. What the integration guarantees, whichever provider

- The price, currency and term come only from the server's offer. The browser sends a plan code and a payment method.
- Access is granted only by `commit_verified_commercial_payment`. That happens after the server reads the payment from the provider's API and checks the provider, environment, reference, amount and currency, and the account.
- A browser redirect, a client-supplied price, an unsigned or stale webhook, and "checkout created" are never treated as payment.
- Polar receives the server's price as an ad-hoc, tax-exclusive fixed price with discount codes disabled. Its order's net amount (after discounts, before tax) must equal the offer exactly.
- Every webhook is recorded as received before verification, with one outcome row per processing attempt.
- If a provider succeeded but local processing failed, recovery re-reads the provider. The customer's status page or a commercial administrator can trigger it, at most once per cooldown. It never creates a second charge.
- Refunds and disputes are recorded and listed for a commercial administrator's decision. A licence is never changed silently.

## 5. Owner prerequisites (outside the repository)

1. **Merchant entity:** decide which legal entity sells CFOClose through Polar, and whether as an individual or a company (§0).
2. **Polar sandbox:**
   - a separate sandbox account and organization;
   - three one-time products (Solo, Practice, Firm) with **no Polar benefits**, and tax behaviour **exclusive**;
   - a webhook endpoint with a Standard Webhooks secret;
   - an organization access token with the checkouts and orders scopes.
3. **Polar production:** the same set-up. Then, in **Finance → Account**:
   - submit for approval;
   - verify the owner's identity;
   - connect the payout account.

   Wait for approval, which can take up to 14 days.
4. **Prices:**
   - Approved by the owner on 10 October 2026, annual: Solo USD 490, Practice USD 990, Firm USD 2,990.
   - Additional named users stay **proposed**, and are not sold online.
   - Enterprise is quoted.
   - **No TZS price is approved.**
5. **Legal:** review the terms and privacy pages for paid sales (`LEGAL_PROFESSIONAL_REVIEW_REQUIRED_BEFORE_PAID_GO_LIVE`), including Polar's merchant-of-record terms and the refund policy.
6. **Snippe:** nothing for launch. Mobile money would need KYC, an approved TZS price and a code change (`SNIPPE_CUSTOMER_CHECKOUT_ENABLED`) before it could ever be offered.

## Sources (read 10 October 2026)

- **Snippe:**
  - [docs index](https://docs.snippe.sh/llms.txt)
  - [authentication](https://docs.snippe.sh/docs/2026-01-25/authentication)
  - [payments](https://docs.snippe.sh/docs/2026-01-25/payments)
  - [mobile money](https://docs.snippe.sh/docs/2026-01-25/payments/mobile-money)
  - [sessions](https://docs.snippe.sh/docs/2026-01-25/sessions)
  - [webhooks](https://docs.snippe.sh/docs/2026-01-25/webhooks)
- **Polar:**
  - [supported countries](https://polar.sh/docs/merchant-of-record/supported-countries.md)
  - [acceptable use](https://polar.sh/docs/merchant-of-record/acceptable-use/introduction.md)
  - [account reviews](https://polar.sh/docs/merchant-of-record/account-reviews.md)
  - [fees](https://polar.sh/docs/merchant-of-record/fees.md)
  - [payment methods](https://polar.sh/docs/features/checkout/payment-methods.md)
  - [products and currencies](https://polar.sh/docs/features/products.md)
  - [tax-inclusive pricing](https://polar.sh/docs/features/tax-inclusive-pricing)
  - [checkout session](https://polar.sh/docs/api-reference/checkouts/create-session.md)
  - [get checkout](https://polar.sh/docs/api-reference/checkouts/get-session.md)
  - [list orders](https://polar.sh/docs/api-reference/orders/list.md)
  - [get order](https://polar.sh/docs/api-reference/orders/get.md)
  - [refunds](https://polar.sh/docs/features/refunds.md)
  - [webhook delivery](https://polar.sh/docs/integrate/webhooks/delivery.md)
  - [webhook events](https://polar.sh/docs/integrate/webhooks/events.md)
  - [sandbox](https://polar.sh/docs/integrate/sandbox.md)
  - [merchant of record](https://polar.sh/docs/merchant-of-record/introduction.md)
