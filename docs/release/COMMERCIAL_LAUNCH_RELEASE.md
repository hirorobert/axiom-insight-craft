# CFOClose commercial launch: plans and online payment

- **Milestone:** *Commercial launch: plans and online payment*. The three PRs are dependency-ordered:
  1. **#103:** database authority for payment (`commercial-p1`).
  2. **#104:** server functions, which are the provider adapters, the verified webhooks and the shared settlement path.
  3. **#105:** customer and administrator screens, the landing refinement and the end-to-end journey.
- **Builds on:** release `1e4d4d0` (PRs #101, #102), whose package `handoff-commercial-c1-20261010.zip` this release **supersedes**.
- **Not done:** no hosted migration, deployment, publication, provider account, sandbox run, price approval or charge. The platform stays `PAYMENTS_DISABLED` until the owner opens it, stage by stage (`COMMERCIAL_LAUNCH_LOVABLE_CHECKLIST.md` §7).

## 1. The customer journey

1. **Understand the product.** The landing hero carries:
   - one proposition;
   - one genuine, labelled screenshot;
   - the statement that the software performs the checks and records the decisions, while professional judgement stays with the user.

   The import formats are stated (CSV and XLSX exports, with no accounting-system integration).
2. **Choose a plan.** The plans show entities, included named users, the additional-user charge and a 12-month term with no automatic renewal.
   - An **approved** price, with online payment open, shows that price and **Choose <plan>**.
   - Otherwise the plan shows **Proposed** and **Request activation**, preselected with the plan.
3. **Create an account or sign in.** The plan is remembered (only its code), and the customer returns to its checkout after confirming their email.
4. **Pay through an eligible provider.**
   - **Card:** Polar, merchant of record, USD.
   - **Mobile money:** Snippe, M-Pesa / Airtel / Mixx / Halotel, TZS.
   - The server chooses the price, the currency, the term and the provider. The browser sends a plan and a route.
5. **Server-authorised access.** Access starts only after the server has verified the payment with the provider.
   - The first verification is by signed webhook. The status page's bounded recovery check is the fallback.
   - Verification checks the merchant, the order, the account, the amount, the currency and the status.
   - The commit is atomic and replay-safe.
6. **Start a trial-balance review.** The status page's next action does exactly that.

Specialist consulting stays on **Ask for a quote**, preselected for the service. It is never part of a plan.

## 2. What changes

| Layer | Change |
|---|---|
| Database (`20261029100000`, batch `commercial-p1`) | SNIPPE/POLAR identifiers; the placement rule (renewal, downgrade at renewal, upgrade now, review); the commit accepts only final outcomes and never applies a second transaction to a paid intent; paid-term placement by an administrator; manual activation never shortens a paid term; recovery claims by an administrator; a billing record at checkout; customer and administrator reads; the public price read. Refuses unless `PAYMENTS_DISABLED`; refuses a second application. |
| Edge Functions | Polar and Snippe adapters (fetch only, no SDK); Standard Webhooks and HMAC verification with a 5-minute window; one settlement path for webhooks and recovery; two webhook endpoints; checkout routing by route (card → GLOBAL/USD → Polar; mobile money → TZ/TZS → Snippe), without crossing routes and only where the platform state permits. |
| Customer UI | Landing, plans, `/billing/checkout`, the status page, `/billing/orders`. |
| Administrator UI | `/commercial/admin`: payments needing attention, accounts and manual activation, prices, the online-payment state. |

## 3. Migration batch `commercial-p1`

- **Wrapper:** `release/wrappers/20261029100000_payment_provider_routes.wrapper.sql`. It encloses the source exactly as committed at `21387d52d432359eb46d34e6160b4876eeb42f63`:
  - payload 49,007 bytes, SHA-256 `3b1b14d93bb2ee7ef21d416a89d5fa3490848f4bce53827979d0290d76e42818`;
  - wrapper 50,575 bytes, SHA-256 `407e056d63f0083137bceb4dbb10c27beafba11c326701589ef838549d8b6627`.
  - Both registered submission forms are pinned in `scripts/ci/releaseJournal.mjs`.
- **Order:** after `reporting-r5` and `commercial-c1`.
- **Preflight:** `release/commercial-p1/preflight.sql` (read-only). It requires c1 and `PAYMENTS_DISABLED`, refuses if p1 is already applied, and records four counts and digests: licences, intents, payment events, offers.
- **Postcondition:** `release/commercial-p1/postcondition.sql` (read-only). It checks:
  - the identifiers and the placement rule;
  - the paid-term guard;
  - the scoping of every new function (server-only functions run for no client role; administrator functions run for authenticated callers only);
  - that the public read is open to everyone;
  - that payments are still disabled.

  The same four counts and digests must match the preflight's.

## 4. Function deployment manifest

| Function | Files (all under `supabase/functions/`) | JWT | Reads secrets |
|---|---|---|---|
| `commercial-create-checkout` | `commercial-create-checkout/index.ts`, `_shared/auth.ts`, `_shared/correlationId.ts`, `_shared/payments/{contracts,routing,http,webhookSignature}.ts`, `_shared/payments/providers/{polar,snippe}.ts` | on | `SAFF_PAYMENT_REDIRECT_URL`, `POLAR_*`, `SNIPPE_*`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| `commercial-payment-status` | `commercial-payment-status/index.ts`, `_shared/auth.ts`, `_shared/correlationId.ts`, `_shared/payments/{contracts,routing,http,webhookSignature,settle}.ts`, `_shared/payments/providers/*` | on | as above, plus `SUPABASE_ANON_KEY` |
| `commercial-webhook-polar` | `commercial-webhook-polar/index.ts`, `_shared/payments/webhookEndpoint.ts` (and the shared modules above) | **off** | `POLAR_*`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| `commercial-webhook-snippe` | `commercial-webhook-snippe/index.ts`, `_shared/payments/webhookEndpoint.ts` (and the shared modules above) | **off** | `SNIPPE_*`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| `commercial-payment-webhook` | unchanged (retired, 410) | unchanged | none |
| `submit-service-enquiry`, `dispatch-enquiry-notifications` | unchanged from c1 | unchanged | unchanged |

## 5. Configuration (names only; values come from the provider dashboards and are never committed)

| Name | Required for | Value / rule |
|---|---|---|
| `SAFF_PAYMENT_REDIRECT_URL` | Any provider | `https://cfoclose.com/billing/payment/return` (https; loopback http only in local tests). Without it, no provider is configured. |
| `POLAR_ENVIRONMENT` | Polar | `sandbox` or `production`. Never defaulted: any other value disables Polar. |
| `POLAR_ACCESS_TOKEN` | Polar | An organization access token for that environment (scope: checkouts and orders). |
| `POLAR_WEBHOOK_SECRET` | Polar | The endpoint's `whsec_…` secret. Secrets created from 8 September 2026 use Standard Webhooks. |
| `POLAR_ORGANIZATION_ID` | Polar | A UUID. The verified order's product must belong to it. |
| `POLAR_PRODUCT_IDS` | Polar | JSON object with `SOLO`, `PRACTICE` and `FIRM`, each a product UUID (one-time products). |
| `SNIPPE_ENVIRONMENT` | Snippe | `sandbox` or `production`. |
| `SNIPPE_API_KEY` | Snippe | `snp_…` |
| `SNIPPE_WEBHOOK_SECRET` | Snippe | The webhook signing key. |
| `POLAR_API_BASE_URL`, `SNIPPE_API_BASE_URL` | Local tests only | **Never set on the hosted project.** They are accepted only for a sandbox provider pointing at loopback. |

A provider is offered only when **all** of its settings are present and valid. A partial configuration is treated as none.

## 6. Provider eligibility

The full facts, dated 10 October 2026, are in `docs/release/PAYMENT_PROVIDER_EVIDENCE.md`. In brief:
- **Polar** is a merchant of record. It accepts software and B2B SaaS, and excludes human services and "financial advice … related to tax guidance". It pays out to Tanzania through Stripe Connect Express. Its account review can take up to 14 days.
- **Snippe** offers TZS mobile money only, through Tanzanian merchant KYC. It documents no sandbox, refunds or recurring billing.
- **Neither provider has confirmed that it will onboard the merchant.**

## 7. Verification

| Area | Kind | Evidence | Result |
|---|---|---|---|
| Payment authority on PostgreSQL. It covers 43 assertions:<br>• refusal unless disabled; re-application refused;<br>• provider identifiers; the platform matrix;<br>• one licence per verified payment, under replay and 8 concurrent deliveries;<br>• amount, currency, provider, environment and non-final mismatches;<br>• FAILED, CANCELLED and EXPIRED, each with a late success refused; an uncertain outcome honoured;<br>• renewal, downgrade at renewal, upgrade now; unplaceable payments recorded once and placed;<br>• manual activation versus paid;<br>• refund review;<br>• cross-account and role denial; company ownership is not administration;<br>• billing record under concurrency;<br>• withheld capabilities (Consolidation, multi-entity for Solo);<br>• the public price read. | **Local**, real PostgreSQL | `scripts/db-proof/paymentProviders.mjs` | PASS 43/43 (local; CI on #103) |
| Self-checking wrapper `commercial-p1` | Local and CI, real PostgreSQL | `RELEASE_BATCH=commercial-p1 scripts/db-proof/selfCheckingWrappers.mjs` | PASS 32/32 |
| Existing proofs, re-run because the commit and the manual grant changed: `annualTerm` 91, `planCapabilities` 112, `entitlements` 67, `billingSuspension` 52 | Local, real PostgreSQL | — | PASS |
| Adapters, signatures, routing and settlement against recorded provider HTTP | **Mock** | `providerAdapters.test.ts` | PASS 54/54 |
| Checkout, status and administrator screens (jsdom, axe) | **Mock** server answers | `paymentScreens.test.ts` | PASS 21/21 |
| Real application on a local stack: admin opens sandbox and approves prices; card and mobile-money purchases; signed webhooks with replay, bad signature, stale timestamp, unknown checkout and 5 concurrent deliveries; expiry and a new attempt; refund review; manual activation and the paid-term guard; cross-account denial; 1280 and 375 px | **Local** app, database and functions; **mock** providers | `scripts/e2e/paymentJourney.mjs` (CI job `real-app-e2e`) | *see `RELEASE.txt` (final-main CI)* |
| Provider sandbox (Polar sandbox; Snippe test keys) | **Sandbox** | `scripts/payments/providerSandboxSmoke.ts` | **NOT RUN.** No sandbox credentials exist in this environment. The owner runs it (checklist §7.4). |
| Hosted application, live payments | **Hosted** | Checklist §6 and §7 | **NOT RUN** (not authorised) |

**Defined handling, and what is not implemented:**
- **Disputes:**
  - Polar is the merchant of record and handles disputes itself; it may refund early to prevent a chargeback. A refund arrives as a reversal and is reviewed by the administrator. No separate dispute event is documented.
  - Snippe documents no disputes.
  - `record_payment_reversal` supports `CHARGEBACK` for a provider that reports one.
- **Renewal** is a new 12-month purchase that starts when the current term ends. No provider subscription exists, so nothing renews or needs cancelling.
- **Partial refunds** are recorded at their amount for review.

## 8. Remaining external prerequisites and owner decisions

1. **Merchant entity and accounts.**
   - Decide which legal entity sells.
   - Complete Polar's review and Snippe's KYC. Approval is at each provider's discretion.
2. **Prices.**
   - Confirm that the USD annual prices are approved (490 / 990 / 2,990).
   - Decide whether to approve TZS prices for mobile money. None exist, and none were invented.
3. **Legal review** of the terms and privacy pages for paid sales, including Polar's merchant-of-record terms (`LEGAL_PROFESSIONAL_REVIEW_REQUIRED_BEFORE_PAID_GO_LIVE`).
4. **Tax.** For TZS sales through Snippe, CFOClose's entity is the seller; its TRA obligations are the owner's to confirm.
5. **Custom SMTP**, the enquiry email secrets, and the enrolment of staff and the first commercial administrator.
6. **Owner-authorised hosted steps**, in this order: r5, c1, p1 → function deploys → Publish → the staged opening of payments.
7. **Independent accounting validation** of the reporting pilot. This is unchanged; the reporting pilot is not part of this release.
