# Payment providers: evidence and recommended arrangement

- **Read on:** 10 October 2026, from each provider's public documentation (sources below). Nothing here was confirmed with either provider, and no account was opened.
- **Not established:** that either provider will onboard the CFOClose merchant entity. Both need an account review: Snippe through KYC, Polar through its first payout review. The owner must complete both.

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

## 2. What this means

- **Neither provider alone covers the market.** A Tanzanian firm typically pays by mobile money in TZS, which Polar does not offer. An international firm pays by card, which Snippe does not offer.
- **Polar carries the tax and compliance burden for international sales.** As merchant of record it is the legal seller. Snippe leaves the seller (CFOClose's entity) responsible for its own TRA obligations on TZS sales.
- **Renewal must not depend on a provider subscription.** Snippe has none, and the approved model is one 12-month term (`20261001120000`). Both routes therefore sell one 12-month term as a one-time payment, and renewal is a new purchase that starts when the current term ends. Nothing is charged automatically, so there is nothing to cancel.

## 3. Recommended arrangement: one checkout, two routes, each with one role

| Route | Provider | Who | What is charged | Market and currency |
|---|---|---|---|---|
| **Card** | Polar (merchant of record) | Customers outside Tanzania, or anyone choosing to pay by card | The **USD** annual offer, plus any sales tax Polar adds as merchant of record | `GLOBAL`, USD |
| **Mobile money** | Snippe | Customers paying from a Tanzanian mobile-money wallet | The **TZS** annual offer | `TZ`, TZS |

### Routing rules

These are enforced by the server, never by the browser.

1. The customer chooses only the plan and the payment method (card or mobile money). The server maps card to the `GLOBAL` market and mobile money to `TZ`.
2. The server resolves the active, purchasable, annual offer for (plan, market). If none exists, that route is unavailable. **No TZS offer exists today, so the mobile-money route stays unavailable until the owner approves TZS prices** and a commercial administrator records them (`admin_upsert_commercial_offer`, audited).
3. The provider is selected by declared capability: Snippe supports only `TZS` in `TZ`; Polar supports only `USD` in `GLOBAL`. A provider is "configured" only when all of its server-side credentials are present (§5). No provider is ever substituted for another.
4. One open attempt per customer per product (the existing unique index). A second click returns the same attempt; it never creates a second charge.
5. **Specialist services and Enterprise are never sold through either route.** They stay on the enquiry-and-quotation path. This also keeps the Polar route inside Polar's acceptable-use policy, which excludes human services.

### Why not one provider

- **Snippe only:** card buyers outside Tanzania could not pay.
- **Polar only:** Tanzanian mobile-money buyers could not pay, and Polar's review of a Tanzania-based accounting-software seller is not assured.

With both, each route has one role and the routing is total and unambiguous. If either provider declines the merchant, its route simply stays unconfigured, and the other route and manual activation still work.

## 4. What the integration guarantees, whichever provider

- The price, currency and term come only from the server's offer. The browser sends a plan code and a payment method.
- Access is granted only by `commit_verified_commercial_payment`. That happens after the server reads the payment from the provider's API and checks the provider, environment, reference, amount and currency, and the account.
- A browser redirect, a client-supplied price, an unsigned or stale webhook, and "checkout created" are never treated as payment.
- Polar receives the server's price as an ad-hoc, tax-exclusive fixed price with discount codes disabled. Its order's net amount (after discounts, before tax) must equal the offer exactly.
- Every webhook is recorded as received before verification, with one outcome row per processing attempt.
- If a provider succeeded but local processing failed, recovery re-reads the provider. The customer's status page or a commercial administrator can trigger it, at most once per cooldown. It never creates a second charge.
- Refunds and disputes are recorded and listed for a commercial administrator's decision. A licence is never changed silently.

## 5. Owner prerequisites (outside the repository)

1. **Merchant entity:** decide which legal entity sells (and for Snippe, invoices) CFOClose.
2. **Snippe:** complete KYC; create the API key and the webhook signing key; ask Snippe for test credentials (no sandbox is documented).
3. **Polar:** create the organization (sandbox first); add one one-time product per plan (Solo, Practice, Firm); set default tax behaviour to **exclusive**; submit for review; complete identity verification and connect the payout account.
4. **Prices:**
   - Confirm that the USD annual prices are approved (Solo 490, Practice 990, Firm 2,990). The site labels them "Proposed" until an offer is made purchasable.
   - Approve TZS annual prices if the mobile-money route is wanted. None exist, and none will be invented.
5. **Legal:** review the terms and privacy pages for paid sales (`LEGAL_PROFESSIONAL_REVIEW_REQUIRED_BEFORE_PAID_GO_LIVE`), including Polar's merchant-of-record terms.

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
