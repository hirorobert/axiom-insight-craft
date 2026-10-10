# Consolidated Lovable checklist: the CFOClose commercial release

This checklist covers the commercial candidate (PR #101) and its search-branding follow-up (PR #102), published together. It supersedes `COMMERCIAL_C1_LOVABLE_CHECKLIST.md`; that file's read-only queries are reused below.

**Rules for every step:**
- Read-only steps report exactly what you see. Quote it; do not paraphrase.
- Every changing step needs the owner's authorisation, **by step number**.
- Do not do any of the following:
  - repeat a completed reporting canary;
  - reset data;
  - enable a withheld service;
  - change the demo company's sign-off policy;
  - re-sign a report;
  - activate checkout.

## 1. Verify source and hosted state (read-only)

1. **Source.** The release commit is `main` at the merge of PR #102 (stated in the release package's `RELEASE.txt`). Confirm that Lovable's project is synced to exactly that commit.
2. **Published build identity.** Open `https://cfoclose.com`, open the main script (`/assets/index-*.js`), and search it for the 40-character release commit (the build embeds `VITE_GIT_SHA`). Report the commit found and the time of the last Publish.
3. **Hosted database.** Run in the SQL editor and paste the output:

   ```sql
   SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 10;
   SELECT to_regclass('public.fs_signoff_policy_events') IS NOT NULL AS r5_signoff_policy,
          to_regclass('public.service_enquiry_replies')  IS NOT NULL AS c1_enquiries,
          NOT has_table_privilege('authenticated', 'public.aje_lines', 'INSERT') AS c1_aje_retired,
          to_regclass('public.workspace_purpose_events') IS NOT NULL AS c1_workspace_purpose,
          position('company_year_end' IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'chk_fp_dates_basis'))) > 0 AS c1_period_from_company;
   ```

4. **Functions and secrets.**
   - Report the deployed version and time of `submit-service-enquiry` and `dispatch-enquiry-notifications`.
   - Report whether each of these is set, **by name only** (never paste a value): `LOVABLE_API_KEY`, `ENQUIRY_EMAIL_ENABLED`, `ENQUIRY_INTERNAL_NOTIFY_TO`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_EXPECTED_HOSTNAMES`, `ENQUIRY_CHALLENGE_MODE`.
   - Report whether custom SMTP is configured.
5. **Security scanner.** Run the Lovable security scan and paste every finding **exactly** as stated: identifier, title, severity and object.
   - The client write policies on `adjusting_journal_entries` and `aje_lines` are expected to clear only after step 2.
   - Never mark a finding resolved before its fix is applied and verified.
6. **Live pricing parity.** Run the query below and report every difference from the reviewed catalogue as **drift**. Do not edit hosted values. No offer may be purchasable.

   ```sql
   SELECT p.code, p.is_active, o.offer_code, o.currency_code, o.amount_minor, o.billing_interval, o.is_active, o.is_purchasable
     FROM public.commercial_plans p LEFT JOIN public.commercial_offers o ON o.plan_id = p.id ORDER BY p.code, o.effective_start;
   ```

   | Plan | Entities | Included users | Monthly (USD) | Annual (USD) | Additional user |
   |---|---|---|---|---|---|
   | SOLO | 1 | 1 | 49.00 | 490.00 | — |
   | PRACTICE | 5 | 1 | 99.00 | 990.00 | 20.00 / month, 200.00 / year |
   | FIRM | 25 | 1 | 299.00 | 2,990.00 | 20.00 / month, 200.00 / year |
   | ENTERPRISE | agreed | agreed | agreed | agreed | — |

## 2. Apply only the unapplied migrations, in the reviewed order *(owner authorisation)*

Apply only a batch whose step 1.3 flag is `false`.
- Submit each wrapper **byte for byte**. It checks its own size and SHA-256 before running anything.
- If a wrapper refuses, stop and report. Never edit a wrapper.

1. **`reporting-r5`:**
   - run `release/reporting-r5/preflight.sql`;
   - apply `20261024100000_fs_signoff_approval_policy.wrapper.sql`;
   - run `release/reporting-r5/postcondition.sql`.
2. **`commercial-c1`:**
   - run `release/commercial-c1/preflight.sql`, and keep its counts and digests;
   - apply the four wrappers, in this order:
     - `20261025100000_commercial_enquiries.wrapper.sql`
     - `20261026100000_retire_browser_adjusting_journal_writes.wrapper.sql`
     - `20261027100000_workspace_purpose.wrapper.sql`
     - `20261028100000_period_dates_from_company.wrapper.sql`
   - run `release/commercial-c1/postcondition.sql`. Its counts and digests must equal the preflight's.

## 3. Deploy the two enquiry functions *(owner authorisation)*

Deploy `submit-service-enquiry` and `dispatch-enquiry-notifications` from the release commit. Report the new versions.

## 4. Email and operator prerequisites (configure, or record as outstanding)

- **Custom SMTP** for sign-up and confirmation email (`PRODUCTION_AUTH_SMTP_CONFIGURATION_REQUIRED`).
- **Enquiry email:** `ENQUIRY_EMAIL_ENABLED=true`, `LOVABLE_API_KEY`, and `ENQUIRY_INTERNAL_NOTIFY_TO` (an address chosen by the owner; never guessed).
- **Operators:** enrol them following `docs/operations/COMMERCIAL_ADMIN_GUIDE.md`.
  - Enquiry staff use `platform_staff_grant`.
  - The commercial administrator is a first `commercial_admins` row.
  - No blanket tenant access and no account deletion.
- **Real-mailbox test:** run it only when the owner authorises it. Report the reply status exactly: *Queued*, *Sending*, *Accepted*, *Delivered*, *Bounced* or *Failed*. *Accepted* is not proof of delivery.

Anything not done here is recorded as outstanding in the report, with its owner.

## 5. Publish the final integrated frontend *(owner authorisation)*

Publish from the release commit. Then repeat step 1.2; it must show the release commit.

## 6. Verify the public identity and the commercial journeys (read-only, after Publish)

1. **Domain.**
   - `https://www.cfoclose.com/terms` must answer **301** with `Location: https://cfoclose.com/terms`. Today it answers **302**.
   - In Lovable → Project → Settings → **Domains**, set `cfoclose.com` as the **primary** domain with `www` redirecting permanently.
   - If Lovable offers no permanent-redirect option, record that, and configure a Cloudflare **Redirect Rule** (`www.cfoclose.com/*` → `https://cfoclose.com/$1`, **301**, preserve the query string), if the domain's DNS is in your Cloudflare account. Report which was done.
2. **Social image.**
   - In Lovable → Project → Settings, **remove any custom social share image / preview image**, so the host stops injecting `og:image` from `r2.dev`.
   - Then `curl -s https://cfoclose.com/ | grep -i "og:image"` must show only `https://cfoclose.com/og-image.png`.
3. **Icons.** Each of these must return **200**, with the CFOClose navy icon showing a white "C" over two gold rules:
   - `https://cfoclose.com/favicon.ico`
   - `/favicon-32x32.png`
   - `/apple-touch-icon.png`
   - `/site.webmanifest`
   - `/og-image.png`
   `/favicon.svg` must return 404 (removed).
4. **Canonicals.**
   - Open each of `/`, `/plans`, `/contact`, `/terms` and `/privacy`. Run `document.querySelector('link[rel=canonical]').href` in the browser console; it must be the page's own `https://cfoclose.com/...` URL, and `document.title` must be distinct.
   - `/pricing` must show the canonical `https://cfoclose.com/plans`.
   - `/dashboard` must show no canonical, and a robots value of `noindex,nofollow`.
5. **Sitemap and robots.** `https://cfoclose.com/sitemap.xml` must list exactly `/`, `/plans`, `/contact`, `/terms` and `/privacy` on `https://cfoclose.com`. `robots.txt` must end with `Sitemap: https://cfoclose.com/sitemap.xml`.
6. **Previews.** On a Lovable preview URL, the robots value in the console must be `noindex,nofollow`.
7. **Commercial journeys.** Check each of the following on the live site:
   - the landing page: "Request activation", the manual-activation note beside the plans, and specialist services shown as enquiries;
   - `/plans`: Request activation, with no checkout;
   - `/contact`: a preselected activation request reaches the queue (only if step 3 is done; use a test address only if the owner authorises it);
   - signed-in: Reconcile shows earlier adjusting entries read-only;
   - the account home is grouped by company.

## 7. For the owner: ask Google to recrawl (Search Console)

Google keeps old titles, the old "SAFF ERP" name and old icons until it recrawls. That takes days to weeks and cannot be forced from code.

1. Open **Google Search Console** and select the **Domain** property `cfoclose.com`. If it does not exist, add it and verify with the DNS TXT record Google shows.
2. **Sitemaps** → submit `https://cfoclose.com/sitemap.xml`. If an old sitemap is listed, remove it.
3. **URL Inspection** → enter `https://cfoclose.com/` → **Test live URL**. Confirm the title, canonical and indexability, then **Request indexing**. Repeat for `/plans`, `/contact`, `/terms` and `/privacy`.
4. **Removals → Outdated content.** If an old SAFF ERP snippet persists for a URL that now shows different content, submit that URL. It refreshes the snippet; it does not remove the page.
5. **Favicon.** Google refreshes favicons on its own schedule after recrawling the homepage. No separate request exists; step 3 for `/` is the one action.
6. Repeat steps 2–3 in **Bing Webmaster Tools** (it can import from Search Console), if used.
