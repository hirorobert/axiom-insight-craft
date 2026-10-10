# CFOClose commercial launch: the one Lovable checklist

**This checklist supersedes every earlier checklist**, including `COMMERCIAL_RELEASE_LOVABLE_CHECKLIST.md` (only its §6.3–6.6 is still referenced, from B6) and the first version of this file. It covers everything not yet done on the hosted project:
- reporting r5;
- commercial c1;
- search branding;
- online payment (`commercial-p1`, `commercial-p2`).

Use only the release package named in `RELEASE.txt`, and do not mix files from an earlier package.

## How this checklist works

**It is resume-safe.**
- Start every session with **A1** (a read-only snapshot).
- Each step says when to **skip** it, based on that snapshot, and what makes it **done**.
- A step that was already done is skipped, never repeated.
- If a session stops part-way, start again at A1.

**Two separate things:**
- **Deploying the release with payments disabled** (Stages A–B). The site, the functions and the database are updated. `commercial_platform_state` stays `PAYMENTS_DISABLED`, nobody can pay online, and plans show **Request activation**.
- **Enabling customer checkout** (Stage F). This is a separate owner decision. It is allowed only after Polar has approved the merchant account (C), configuration is complete (C), sandbox verification has passed (D), and a separately authorised controlled live acceptance has passed (E).

**Launch scope (owner decision, 10 October 2026):**
- Card payments through **Polar** only.
- Mobile money (Snippe) is not launched. Do **not** set any `SNIPPE_*` secret, and do not add a TZS price.
- Enterprise and consulting are quoted separately.
- Financial reporting stays a restricted pilot.

**Rules:**
- Read-only steps report exactly what you see. Quote it; do not paraphrase.
- Every changing step needs the owner's authorisation **by step number**.
- **Never paste a secret value.** Report only whether a secret is set, by its name.
- **Never:**
  - repeat a completed reporting canary;
  - reset or delete data;
  - enable a withheld service, or add companies to the reporting rollout;
  - change the demo company's sign-off policy;
  - re-sign a report;
  - widen customer access.
- **No real charge** without the owner's explicit authorisation of that charge (Stage E).
- If anything refuses or differs from what this checklist expects, **stop and report**.

---

## Stage A — Read the hosted state (read-only, every session)

**A1. Snapshot.** Run this in the SQL editor and paste the whole output:

```sql
SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 12;
SELECT to_regclass('public.fs_signoff_policy_events') IS NOT NULL AS r5_applied,
       to_regclass('public.service_enquiry_replies')  IS NOT NULL AS c1_enquiries_applied,
       NOT has_table_privilege('authenticated', 'public.aje_lines', 'INSERT') AS c1_aje_retired_applied,
       to_regclass('public.workspace_purpose_events') IS NOT NULL AS c1_workspace_purpose_applied,
       coalesce(position('company_year_end' IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'chk_fp_dates_basis'))) > 0, false) AS c1_period_dates_applied,
       to_regprocedure('public._commercial_licence_placement(uuid,uuid,timestamp with time zone)') IS NOT NULL AS p1_applied,
       coalesce(position('BLOCKED_SEATS' IN pg_get_functiondef(to_regprocedure('public._commercial_licence_placement(uuid,uuid,timestamp with time zone)'))) > 0, false) AS p2_applied,
       (SELECT state FROM public.commercial_platform_state WHERE id = true) AS platform_state,
       (SELECT count(*) FROM public.commercial_admins WHERE active) AS active_commercial_admins,
       (SELECT count(*) FROM public.commercial_live_acceptance_allowlist WHERE active) AS live_acceptance_testers;
SELECT p.code, o.offer_code, o.market_code, o.currency_code, o.amount_minor, o.billing_interval, o.is_active, o.is_purchasable
  FROM public.commercial_plans p LEFT JOIN public.commercial_offers o ON o.plan_id = p.id ORDER BY p.code, o.market_code, o.effective_start;
```

If `platform_state` is anything other than `PAYMENTS_DISABLED` and Stage F has not been authorised, **stop and report**.

**A2. Source and published build.**
- Confirm that Lovable's project is synced to exactly the release commit in `RELEASE.txt`.
- Open `https://cfoclose.com`, open the main script (`/assets/index-*.js`), and search it for the 40-character release commit.
- Report the commit found and the time of the last Publish.

**A3. Functions and secrets.**
- Report the deployed version and time of each function in `release/FUNCTIONS_MANIFEST.json`.
- Report, **by name only**, whether each of these is set:
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
- Also report whether any `SNIPPE_*` secret is set. None is needed, and the code never offers that route.
- `POLAR_API_BASE_URL` and `SNIPPE_API_BASE_URL` must **not** be set. They are for local tests only.
- Report whether custom SMTP is configured.

**A4. Security scanner.**
- Run the Lovable security scan and paste every finding as stated: identifier, title, severity and object.
- Never mark a finding resolved before its fix is applied and verified.

**A5. Price drift.** Compare A1's offers with the reviewed catalogue below, and report any difference as **drift**. Do not edit hosted values here.

| Plan | Entities | Included users | Annual price | Additional user |
|---|---|---|---|---|
| SOLO | 1 | 1 | USD 490.00 (**approved by the owner**) | — |
| PRACTICE | 5 | 1 | USD 990.00 (**approved**) | USD 200.00 a year, **proposed**, arranged with the team |
| FIRM | 25 | 1 | USD 2,990.00 (**approved**) | USD 200.00 a year, **proposed**, arranged with the team |
| ENTERPRISE | agreed | agreed | quoted | — |

There must be no TZS offer with `is_purchasable = true`.

---

## Stage B — Deploy the release with payments disabled *(owner authorisation per step)*

Nothing in Stage B lets anyone pay. `platform_state` stays `PAYMENTS_DISABLED` throughout.

### B1. Apply only the unapplied migrations, in this order

**General rules:**
- Submit each wrapper **byte for byte**. It checks its own size and SHA-256 before running anything. The expected hashes are in `COMMERCIAL_LAUNCH_RELEASE.md` §3.
- If a wrapper or a postcondition refuses, **stop and report**. Never edit a wrapper.
- Every wrapper refuses a second application, so a mistaken re-run changes nothing.

| # | Batch | Skip if (A1) | Steps | Done when |
|---|---|---|---|---|
| B1.1 | `reporting-r5` | `r5_applied = true` | `release/reporting-r5/preflight.sql`, then `20261024100000_fs_signoff_approval_policy.wrapper.sql`, then `release/reporting-r5/postcondition.sql` | The postcondition reports OK |
| B1.2 | `commercial-c1` | All four `c1_*_applied = true` | `release/commercial-c1/preflight.sql` (keep its output); then the **unapplied** wrappers among `20261025100000_commercial_enquiries`, `20261026100000_retire_browser_adjusting_journal_writes`, `20261027100000_workspace_purpose`, `20261028100000_period_dates_from_company`, in that order; then `release/commercial-c1/postcondition.sql` | Its counts and digests equal the preflight's |
| B1.3 | `commercial-p1` | `p1_applied = true` | `release/commercial-p1/preflight.sql` (keep its four counts and digests), then `20261029100000_payment_provider_routes.wrapper.sql`, then `release/commercial-p1/postcondition.sql` | `POSTCONDITION OK.`, with counts and digests equal to the preflight's |
| B1.4 | `commercial-p2` | `p2_applied = true` | `release/commercial-p2/preflight.sql` (keep its three counts and digests), then `20261030100000_paid_term_seat_preservation.wrapper.sql`, then `release/commercial-p2/postcondition.sql` | `POSTCONDITION OK.`, with counts and digests equal to the preflight's |

**What the batches require and change:**
- **p1 and p2** require `PAYMENTS_DISABLED` and refuse otherwise.
- **p1 and p2** change no licence, order, payment or price.
- **p2** changes only where a paid term is placed: an upgrade no longer ends paid additional named users automatically.

If B1.2 stopped part-way through, a re-run of A1 shows which c1 wrappers remain.

### B2. Deploy the functions from the release commit

**Skip** a function whose deployed version already matches the release commit (A3).

| Function | Purpose | JWT verification |
|---|---|---|
| `submit-service-enquiry`, `dispatch-enquiry-notifications` | Enquiries (c1) | As before |
| `commercial-create-checkout` | Payment options and checkout creation; refuses while payments are disabled | **On** |
| `commercial-payment-status` | Order status, and the provider recovery check | **On** |
| `commercial-webhook-polar` | Polar deliveries; the signature is the credential; stale-but-signed deliveries are reconciled with Polar | **Off** (`verify_jwt = false` in `supabase/config.toml`) |
| `commercial-webhook-snippe` | Deployed for completeness. The route is not launched, and without `SNIPPE_*` secrets it answers 503. | **Off** |
| `commercial-payment-webhook` | Retired (410). Keep it deployed. | Unchanged |

`release/FUNCTIONS_MANIFEST.json` lists every file each function deploys, with its SHA-256.

**Done when** each function reports a new version. With no Polar secrets set, checkout answers `PAYMENT_PROVIDER_UNAVAILABLE` and the webhooks answer 503. That is expected.

### B3. Email

Configure each item, or record it as outstanding (owner):
- **Custom SMTP** for sign-up and confirmation email (`PRODUCTION_AUTH_SMTP_CONFIGURATION_REQUIRED`).
- **Enquiry email:**
  - `ENQUIRY_EMAIL_ENABLED=true`;
  - `LOVABLE_API_KEY`;
  - `ENQUIRY_INTERNAL_NOTIFY_TO`, an address the owner chooses (never guessed).

**Skip** whatever A3 already shows as set.

### B4. Administrator enrolment

- **Enquiry operators:** `platform_staff_grant` (`docs/operations/COMMERCIAL_ADMIN_GUIDE.md` §4).
- **First commercial administrator.** **Skip** if A1 shows `active_commercial_admins >= 1`. Otherwise, the operator bootstrap, once:

  ```sql
  INSERT INTO public.commercial_admins (user_id, granted_by, active) VALUES ('<founder auth.users.id>', NULL, true);
  ```

  Everything after that happens in `/commercial/admin`, signed in as that administrator.

Owning companies never makes anyone an administrator.

### B5. Publish the frontend

**Skip** if A2 already shows the release commit. Otherwise Publish, then repeat A2: it must show the release commit.

### B6. Verify the deployed release (read-only)

1. **Domain, social image, icons, canonicals, sitemap, robots and previews:**
   - `https://www.cfoclose.com/terms` must answer **301** to `https://cfoclose.com/terms`.
   - `curl -s https://cfoclose.com/ | grep -i "og:image"` shows only `https://cfoclose.com/og-image.png`.
   - The checks in `COMMERCIAL_RELEASE_LOVABLE_CHECKLIST.md` §6.3–6.6 pass.
   - Changing hosting settings needs the owner's authorisation.
2. **Landing** (`https://cfoclose.com/`):
   - The first hero button is **Explore plans**.
   - There is one labelled product screenshot.
   - Each plan shows **Request activation**. The price reads "Proposed: USD 490 per year" until C3, and "USD 490 per year" after it.
   - **No TZS price and no mention of mobile money appear anywhere.**
   - Specialist services say **Ask for a quote**.
   - The pilot is labelled "Pilot · by invitation".
   - At 375 px there is no sideways scrolling.
3. **Checkout while disabled:**
   - signed in, `/billing/checkout?plan=SOLO` shows "Online payment is not open for this plan yet." with **Request activation**;
   - signed out, it asks the visitor to sign in.
4. **Administrator screen:**
   - `/commercial/admin` opens for the administrator.
   - **Online payment** shows `PAYMENTS_DISABLED`, and "none" for configured routes.
   - **Prices** says card payments through Polar only.
   - Any other account is refused, including one that owns companies.
5. **Account home with a genuinely fresh account** (sign up with a new test address; never use or change NBAA's account):
   - `/dashboard` shows "Your engagements" with **one** next step, "Choose a plan to begin", whose button is **View plans**.
   - No company, engagement or demonstration data is shown, and there is no disabled button.
   - The header reads Home, Plans, Orders, Settings, Sign out on `/dashboard`, `/plans` and `/billing/orders`, and no "Sign in" link appears.
   - At 375 px there is no sideways scrolling.
   - Report a screenshot of each page.
6. **NBAA's existing account** (read-only; do not change it): the home shows one next step, "Choose a plan to start new work". The NBAA 2026 row says "Starts once a plan is active." and has no disabled button. Its records are listed as kept.
7. **Journeys:**
   - A preselected activation request reaches the queue. Use a test address, and only if authorised.
   - Reconcile shows earlier adjusting entries read-only.

**Stage B is complete** when B1–B5 are done or skipped and B6 passes. The release is now deployed **with payments disabled**. Stop here unless the owner authorises Stage C.

---

## Stage C — Merchant and configuration *(owner)*

Nothing in Stage C opens checkout.

**C1. Polar sandbox** (owner, in Polar):
1. Create a separate sandbox account and organization at `https://sandbox.polar.sh`.
2. Create three **one-time** products, Solo, Practice and Firm, with **no Polar benefits** and tax behaviour **exclusive**.
3. Add a webhook endpoint at `https://<project-ref>.supabase.co/functions/v1/commercial-webhook-polar`:
   - with a Standard Webhooks secret created now;
   - with these events: `order.paid`, `order.updated`, `order.refunded`, `refund.created`, `refund.updated`, `checkout.updated`, `checkout.expired`.
4. Create an organization access token with the checkouts and orders scopes.

**C2. Sandbox secrets.** Set them by name; the values come from Polar's sandbox dashboard:
- `SAFF_PAYMENT_REDIRECT_URL=https://cfoclose.com/billing/payment/return`
- `POLAR_ENVIRONMENT=sandbox`
- `POLAR_ACCESS_TOKEN`
- `POLAR_WEBHOOK_SECRET` (`whsec_…`)
- `POLAR_ORGANIZATION_ID`
- `POLAR_PRODUCT_IDS`, as JSON: `{"SOLO":"…","PRACTICE":"…","FIRM":"…"}`

**Skip** any already set (A3). **Done when** `/commercial/admin` → **Online payment** lists the card route as configured, in sandbox. A partial configuration counts as none.

**C3. Approve the USD prices** (administrator, recording the owner's decision of 10 October 2026).
- In `/commercial/admin` → **Prices**, approve the three GLOBAL/USD annual offers at exactly the A5 amounts, with a reason.
- **Skip** any offer that A1 already shows `is_purchasable = true` at that amount.
- Never add a TZS price, and never approve an additional-user price.
- This shows the price publicly with **Request activation**. It does not open checkout.

**C4. Polar production account** (owner, in Polar's production organization):
1. Repeat C1 in production.
2. In **Finance → Account**:
   - submit the business for approval;
   - complete the owner's identity verification;
   - connect the Stripe Connect Express payout account.
3. Decide which legal entity sells (`PAYMENT_PROVIDER_EVIDENCE.md` §0).

**Done when** Polar reports the account **approved**. A review can take up to 14 days. Until then, Stages E and F are blocked.

**C5. Legal review** of the terms and privacy pages for paid sales, including the refund policy (`LEGAL_PROFESSIONAL_REVIEW_REQUIRED_BEFORE_PAID_GO_LIVE`). This must be done before Stage F.

---

## Stage D — Sandbox verification *(owner authorisation; test money only)*

**Requires:** C1–C3 complete.

**Skip** Stage D if a signed sandbox report for this release commit already exists.

1. In `/commercial/admin` → **Online payment**, set `SANDBOX_ONLY`, with typed confirmation and a reason.
2. With a test account that is a member of the sandbox organization (sandbox emails go only to members):
   1. Buy Solo with test card 4242 4242 4242 4242. The status page shows "Payment received", with 12 months. The order appears in `/billing/orders`. Polar's dashboard shows the delivery answered 2xx.
   2. **Delayed notification:** in Polar's sandbox dashboard, **redeliver** that `order.paid` some minutes later. It must answer 200 (`DUPLICATE`), with no second payment or licence. Report the status Polar shows.
   3. **Partial, then full refund** in Polar's sandbox. `/commercial/admin` lists two refunds whose amounts add up to the price. Record a decision on each (§2.2 of `REFUNDS_DISPUTES_AND_RECOVERY.md`).
   4. **Renewal:** buy Solo again on the same account. The new term starts exactly when the current one ends.
   5. **Check with the provider** on any order: no change, no charge.
3. Optionally run `scripts/payments/providerSandboxSmoke.ts` from a terminal with the sandbox secrets.
4. Set `PAYMENTS_DISABLED` again.

**Done when** each result above is reported as PASS, and the state is back to `PAYMENTS_DISABLED`. If anything fails, stop: Stages E and F are blocked.

---

## Stage E — Controlled live acceptance *(separate owner authorisation, including each charge)*

**Requires:**
- Polar has **approved** the production account (C4);
- D has passed;
- C5 is done, or the owner explicitly accepts it is outstanding for the test charge only.

1. Switch the secrets to production:
   - `POLAR_ENVIRONMENT=production`;
   - the production `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_ORGANIZATION_ID` and `POLAR_PRODUCT_IDS`.

   Confirm that **Online payment** lists the card route in production.
2. Allow-list one tester (operator SQL). **Skip** if A1 shows the tester already active:

   ```sql
   INSERT INTO public.commercial_live_acceptance_allowlist (user_id, reason) VALUES ('<tester auth.users.id>', '<reason>');
   ```

3. Set `LIVE_ACCEPTANCE`. Only allow-listed testers can pay, and every other account still sees **Request activation**. Confirm this with a non-allow-listed account.
4. **One** owner-authorised real purchase: the tester opens `/billing/checkout?plan=SOLO` directly (the public plans still say **Request activation**) and pays USD 490 plus any tax Polar adds. Confirm the status page, the order and the licence.
5. Refund it in Polar. Confirm it is listed, end the licence under **Accounts**, and record **licence ended**.
6. Set `PAYMENTS_DISABLED` again, and report.

**Done when** steps 4–5 are reported as PASS. Polar's fees on the test charge are not returned on refund; that is a real cost (`PAYMENT_PROVIDER_EVIDENCE.md` §1).

---

## Stage F — Enable customer checkout *(separate owner decision)*

**Requires:** C4 approved, C5 done, D passed and E passed, all for this release commit.

1. Set `CUSTOMER_PAYMENTS_ENABLED`, with typed confirmation and a reason.
2. The landing and `/plans` now show "USD 490 per year by card" with **Choose Solo**, and likewise for Practice and Firm. Enterprise and consulting stay quoted.
3. Watch **Payments needing attention** daily (`docs/operations/COMMERCIAL_ADMIN_GUIDE.md` §5a).

**Rollback at any time:** set `PAYMENTS_DISABLED`.
- Checkout closes, and plans return to **Request activation**.
- Paid licences are untouched.
- Payments already in flight still settle through their webhooks and the status page.

---

## Stage G — For the owner: ask Google to recrawl

This is unchanged:
1. Search Console → Sitemaps → submit `https://cfoclose.com/sitemap.xml`.
2. In URL Inspection, request indexing for `/`, `/plans`, `/contact`, `/terms` and `/privacy`.
