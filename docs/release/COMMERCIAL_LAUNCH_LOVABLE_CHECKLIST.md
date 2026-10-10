# CFOClose commercial launch: the one Lovable checklist

**This checklist supersedes `COMMERCIAL_RELEASE_LOVABLE_CHECKLIST.md`** (PR #101 + PR #102) **and every earlier checklist.** It covers everything not yet done on the hosted project, in order:
- reporting r5;
- commercial c1;
- search branding;
- online payment, batch commercial-p1 (PRs #103, #104, #105).

Use only the release package named in `RELEASE.txt`; do not mix files from an earlier package.

**Rules for every step:**
- Read-only steps report exactly what you see. Quote it; do not paraphrase.
- Every changing step needs the owner's authorisation, **by step number**.
- **Never paste a secret value into a report.** Report only whether a secret is set, by its name.
- Do not do any of the following:
  - repeat a completed reporting canary;
  - reset data;
  - enable a withheld service;
  - change the demo company's sign-off policy;
  - re-sign a report.
- Online payment opens only through §7, one stage at a time, each stage authorised separately.
- No real charge is made without the owner's explicit authorisation of that charge.

## 1. Verify source and hosted state (read-only)

1. **Source.** Confirm that Lovable's project is synced to exactly the release commit in `RELEASE.txt`.
2. **Published build identity.** Open `https://cfoclose.com`, open the main script (`/assets/index-*.js`), and search it for the 40-character release commit. Report the commit found and the time of the last Publish.
3. **Hosted database.** Run in the SQL editor and paste the output:

   ```sql
   SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 10;
   SELECT to_regclass('public.fs_signoff_policy_events') IS NOT NULL AS r5_signoff_policy,
          to_regclass('public.service_enquiry_replies')  IS NOT NULL AS c1_enquiries,
          NOT has_table_privilege('authenticated', 'public.aje_lines', 'INSERT') AS c1_aje_retired,
          to_regclass('public.workspace_purpose_events') IS NOT NULL AS c1_workspace_purpose,
          position('company_year_end' IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'chk_fp_dates_basis'))) > 0 AS c1_period_from_company,
          to_regprocedure('public._commercial_licence_placement(uuid,uuid,timestamp with time zone)') IS NOT NULL AS p1_payment_routes,
          (SELECT state FROM public.commercial_platform_state WHERE id = true) AS platform_state;
   ```

4. **Functions and secrets.**
   - Report the deployed version and time of each of these functions:
     - `submit-service-enquiry`
     - `dispatch-enquiry-notifications`
     - `commercial-create-checkout`
     - `commercial-payment-status`
     - `commercial-webhook-polar`
     - `commercial-webhook-snippe`
     - `commercial-payment-webhook`
   - Report whether each of these is set, **by name only**:
     - `LOVABLE_API_KEY`
     - `ENQUIRY_EMAIL_ENABLED`
     - `ENQUIRY_INTERNAL_NOTIFY_TO`
     - `TURNSTILE_SECRET_KEY`
     - `TURNSTILE_EXPECTED_HOSTNAMES`
     - `ENQUIRY_CHALLENGE_MODE`
     - `SAFF_PAYMENT_REDIRECT_URL`
     - `POLAR_ENVIRONMENT`
     - `POLAR_ACCESS_TOKEN`
     - `POLAR_WEBHOOK_SECRET`
     - `POLAR_ORGANIZATION_ID`
     - `POLAR_PRODUCT_IDS`
     - `SNIPPE_ENVIRONMENT`
     - `SNIPPE_API_KEY`
     - `SNIPPE_WEBHOOK_SECRET`
   - `POLAR_API_BASE_URL` and `SNIPPE_API_BASE_URL` must **not** be set on the hosted project. They exist for local tests only; a production provider refuses them anyway.
   - Report whether custom SMTP is configured.
5. **Security scanner.** Run the Lovable security scan and paste every finding exactly as stated: identifier, title, severity and object. Never mark a finding resolved before its fix is applied and verified.
6. **Live pricing parity.** Run the query below and report every difference from the reviewed catalogue as **drift**. Do not edit hosted values.

   ```sql
   SELECT p.code, o.offer_code, o.market_code, o.currency_code, o.amount_minor, o.billing_interval, o.is_active, o.is_purchasable
     FROM public.commercial_plans p LEFT JOIN public.commercial_offers o ON o.plan_id = p.id ORDER BY p.code, o.market_code, o.effective_start;
   ```

   Reviewed catalogue (annual, 12-month term; monthly is retired). Every offer is `is_purchasable = false` until the owner approves prices (§7.3).

   | Plan | Entities | Included users | Annual (USD) | Additional user |
   |---|---|---|---|---|
   | SOLO | 1 | 1 | 490.00 | — |
   | PRACTICE | 5 | 1 | 990.00 | 200.00 / year, arranged with the team |
   | FIRM | 25 | 1 | 2,990.00 | 200.00 / year, arranged with the team |
   | ENTERPRISE | agreed | agreed | agreed | — |

## 2. Apply only the unapplied migrations, in this order *(owner authorisation)*

Apply only a batch whose §1.3 flag is `false`.
- Submit each wrapper **byte for byte**. It checks its own size and SHA-256 before running anything.
- If a wrapper refuses, stop and report. Never edit a wrapper.

1. **`reporting-r5`:**
   - run `release/reporting-r5/preflight.sql`;
   - apply `20261024100000_fs_signoff_approval_policy.wrapper.sql`;
   - run `release/reporting-r5/postcondition.sql`.
2. **`commercial-c1`:**
   - run `release/commercial-c1/preflight.sql`, and keep its output;
   - apply these four wrappers, in this order:
     - `20261025100000_commercial_enquiries.wrapper.sql`
     - `20261026100000_retire_browser_adjusting_journal_writes.wrapper.sql`
     - `20261027100000_workspace_purpose.wrapper.sql`
     - `20261028100000_period_dates_from_company.wrapper.sql`
   - run `release/commercial-c1/postcondition.sql`. Its counts and digests must equal the preflight's.
3. **`commercial-p1`** (online payment authority). It requires `platform_state = PAYMENTS_DISABLED` and refuses otherwise.
   - run `release/commercial-p1/preflight.sql`, and keep its four counts and digests;
   - apply `20261029100000_payment_provider_routes.wrapper.sql`;
   - run `release/commercial-p1/postcondition.sql`. It must report `POSTCONDITION OK.`, and its four counts and digests must equal the preflight's. The migration changes no licence, order, payment or price.

## 3. Deploy the functions from the release commit *(owner authorisation)*

| Function | Purpose | JWT verification |
|---|---|---|
| `submit-service-enquiry`, `dispatch-enquiry-notifications` | Enquiries (c1) | As before |
| `commercial-create-checkout` | Payment options (GET) and checkout creation (POST); refuses while payments are disabled | **On** (it also validates the JWT itself) |
| `commercial-payment-status` | Order status (GET) and the bounded recovery check (POST) | **On** |
| `commercial-webhook-polar` | Polar deliveries; the provider signature is the credential | **Off** (`verify_jwt = false` in `supabase/config.toml`) |
| `commercial-webhook-snippe` | Snippe deliveries; the provider signature is the credential | **Off** (`verify_jwt = false` in `supabase/config.toml`) |
| `commercial-payment-webhook` | Retired (answers 410); keep deployed | Unchanged |

Report the new version of each. With no provider secrets set, checkout answers `PAYMENT_PROVIDER_UNAVAILABLE` and the webhooks answer 503. This is the expected state until §7.

## 4. Email, operators and the first commercial administrator (configure, or record as outstanding)

- **Custom SMTP** for sign-up and confirmation email (`PRODUCTION_AUTH_SMTP_CONFIGURATION_REQUIRED`).
- **Enquiry email:** `ENQUIRY_EMAIL_ENABLED=true`, `LOVABLE_API_KEY`, and `ENQUIRY_INTERNAL_NOTIFY_TO` (an address chosen by the owner; never guessed).
- **Enquiry operators:** use `platform_staff_grant` (`docs/operations/COMMERCIAL_ADMIN_GUIDE.md` §4).
- **First commercial administrator** (operator bootstrap, once): `INSERT INTO public.commercial_admins (user_id, granted_by, active) VALUES ('<founder auth.users.id>', NULL, true);`.
  - Everything after that happens in `/commercial/admin`, signed in as that administrator: manual activation, prices, payments needing attention, and the payment state.
  - There is no more identity-claim SQL.

## 5. Publish the final integrated frontend *(owner authorisation)*

Publish from the release commit. Then repeat step 1.2; it must show the release commit.

## 6. Verify the public identity and the journeys (read-only, after Publish)

1. **Domain and social image** *(hosting settings, owner authorisation)*:
   - `https://www.cfoclose.com/terms` must answer **301** to `https://cfoclose.com/terms`. Set `cfoclose.com` as the primary domain with `www` redirecting permanently.
   - If Lovable offers no permanent option, use a Cloudflare Redirect Rule: `www.cfoclose.com/*` → `https://cfoclose.com/$1`, 301, preserving the query string.
   - Remove any custom social or preview image in Lovable → Project → Settings. Afterwards, `curl -s https://cfoclose.com/ | grep -i "og:image"` must show only `https://cfoclose.com/og-image.png`.
2. **Icons, canonicals, sitemap, robots and previews.** Run the checks in `COMMERCIAL_RELEASE_LOVABLE_CHECKLIST.md` §6.3–6.6. They are unchanged.
3. **Landing** (`https://cfoclose.com/`):
   - The hero's first button is **Explore plans**.
   - There is one product screenshot, labelled "Product screenshot · … demonstration company and figures".
   - The plans table shows "Proposed: USD 490 per year" with **Request activation**.
   - Each plan with additional users shows their charge.
   - Specialist services each say **Ask for a quote**.
   - The pilot is labelled "Pilot · by invitation".
   - At phone width (375 px) there is no sideways scrolling.
4. **Checkout while payments are disabled:**
   - signed in, `/billing/checkout?plan=SOLO` shows "Online payment is not open for this plan yet." and **Request activation**;
   - signed out, it asks to create an account or sign in.
5. **Administrator screen:**
   - `/commercial/admin` opens for the commercial administrator. Its **Online payment** tab shows `PAYMENTS_DISABLED`, and "none" for configured routes.
   - Any other signed-in account sees the refusal, including one that owns companies.
6. **Commercial journeys:**
   - A preselected activation request reaches the queue. Test this only if §3 is done, and with a test address only if authorised.
   - In the app, Reconcile shows earlier adjusting entries read-only.

## 7. Online payment, in stages *(each stage needs its own owner authorisation)*

Skip any provider whose merchant account is not approved. Its route then simply stays closed, and manual activation keeps working throughout. `docs/release/PAYMENT_PROVIDER_EVIDENCE.md` holds the provider facts and the routing rules:

| Route | Provider | Currency |
|---|---|---|
| Card | Polar | USD |
| Mobile money | Snippe | TZS |

1. **Merchant accounts (owner):**
   - **Polar:** create the sandbox organization first.
     - Create three one-time products: Solo, Practice and Firm.
     - Set the default tax behaviour to **exclusive**.
     - Add a webhook endpoint `https://<project-ref>.supabase.co/functions/v1/commercial-webhook-polar`. Use Standard Webhooks, with a secret created now, and these events: `order.paid`, `order.updated`, `order.refunded`, `refund.created`, `refund.updated`, `checkout.updated`, `checkout.expired`.
     - Later, repeat this in the production organization, after Polar's account review.
   - **Snippe:** complete KYC.
     - Set the webhook URL to `https://<project-ref>.supabase.co/functions/v1/commercial-webhook-snippe`, with a signing key.
     - Ask Snippe for test credentials; no sandbox is documented.
2. **Secrets for sandbox** (names only; values from the provider dashboards):
   - `SAFF_PAYMENT_REDIRECT_URL=https://cfoclose.com/billing/payment/return`
   - Polar:
     - `POLAR_ENVIRONMENT=sandbox`
     - `POLAR_ACCESS_TOKEN`
     - `POLAR_WEBHOOK_SECRET` (`whsec_…`)
     - `POLAR_ORGANIZATION_ID`
     - `POLAR_PRODUCT_IDS`: JSON naming the product id of each of `SOLO`, `PRACTICE` and `FIRM`
   - Snippe:
     - `SNIPPE_ENVIRONMENT=sandbox`
     - `SNIPPE_API_KEY`
     - `SNIPPE_WEBHOOK_SECRET`

   A provider counts as configured only when **all** of its settings are present. Confirm under `/commercial/admin` → **Online payment**, where the configured routes are listed.
3. **Prices (owner approval).** In `/commercial/admin` → **Prices**, approve the USD annual prices, with a reason.
   - For mobile money, first add the TZS annual prices the owner approves. They are saved as not approved; approve them separately.
   - Never invent a price.
4. **Sandbox acceptance.** In `/commercial/admin` → **Online payment**, change the state to `SANDBOX_ONLY` (typed confirmation and a reason). Then, with a test account:
   1. buy Solo by card on Polar's sandbox page, with test card 4242 4242 4242 4242;
   2. confirm that the status page shows "Payment received" and the plan active for 12 months;
   3. confirm that the order appears in `/billing/orders` and that the webhook delivery shows 2xx in Polar's dashboard;
   4. refund the order in Polar's sandbox, and confirm that `/commercial/admin` lists the refund; record a decision;
   5. if Snippe test credentials exist, repeat with mobile money.
   - `scripts/payments/providerSandboxSmoke.ts` repeats the adapter part from a terminal.
   - Report each result.
5. **Close again.** Set `PAYMENTS_DISABLED`. Switch to production:
   - `POLAR_ENVIRONMENT=production`, with the production token, organization, products and webhook secret;
   - `SNIPPE_ENVIRONMENT=production`, with the production key and signing key.
6. **Live acceptance (owner authorises any real charge).**
   1. Add an allow-listed tester, as an operator: `INSERT INTO public.commercial_live_acceptance_allowlist (user_id, reason) VALUES ('<tester auth.users.id>', '<reason>');`.
   2. Set `LIVE_ACCEPTANCE`. One authorised low-value purchase per route proves the live path.
   3. Refund it in the provider dashboard.
   4. Record it as a reviewed refund.
7. **Open to customers (owner).** Set `CUSTOMER_PAYMENTS_ENABLED`. The landing and `/plans` then show the approved prices with **Choose <plan>**. Plans without an approved price stay "Proposed" with **Request activation**.
8. **Rollback at any time.** Set `PAYMENTS_DISABLED`.
   - Checkout closes and the public plans return to activation requests.
   - Paid licences are untouched.
   - Payments already in flight still settle through their webhooks and the status page.

**Daily operation.** `/commercial/admin` → **Payments needing attention** lists:
- uncertain outcomes;
- checkouts that expired without a confirmed outcome;
- paid terms waiting for placement;
- refunds and disputes.

`COMMERCIAL_ADMIN_GUIDE.md` §5a says what to do with each.

## 8. For the owner: ask Google to recrawl

This is unchanged from `COMMERCIAL_RELEASE_LOVABLE_CHECKLIST.md` §7:
1. Search Console → Sitemaps → submit `https://cfoclose.com/sitemap.xml`.
2. In URL Inspection, request indexing for `/`, `/plans`, `/contact`, `/terms` and `/privacy`.
3. Use Removals → Outdated content only for a stale snippet.
