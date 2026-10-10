# Lovable checklist: commercial candidate (PR #101)

This is one bounded checklist. Sections A–E are **read-only**: report exactly what you see, quoting it and never paraphrasing. Section F changes the hosted system. **Do not perform F until the owner authorises each step by name.** Merging the PR, applying migrations, deploying functions and publishing are four separate actions.

## A. Live-build identity (read-only)

1. Open the published site. In the browser's developer tools, open the main script (`/assets/index-*.js`). Search it for the 40-character merge commit of PR #101 (the build embeds `VITE_GIT_SHA`).
2. Report the published commit SHA you find and the time of the last Publish. If it is not the merge commit, the live site is **not** this candidate. Say so; do not publish to fix it.

## B. Hosted configuration facts (read-only)

Run in the SQL editor and paste the results:

```sql
-- B1. The migration journal head (the newest ten entries).
SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 10;
-- B2. Which batches are already applied (each is expected to be false before Section F).
SELECT to_regclass('public.fs_signoff_policy_events') IS NOT NULL AS r5_signoff_policy,
       to_regclass('public.service_enquiry_replies')  IS NOT NULL AS c1_enquiries,
       NOT has_table_privilege('authenticated', 'public.aje_lines', 'INSERT') AS c1_aje_retired,
       to_regclass('public.workspace_purpose_events') IS NOT NULL AS c1_workspace_purpose;
-- B3. The commercial administrators and enquiry staff, by account id only (no other data).
SELECT user_id, active FROM public.commercial_admins;
SELECT user_id, staff_role, is_active FROM public.platform_staff_members;
```

Also report, from the Supabase dashboard:
- The deployed version and deploy time of `submit-service-enquiry` and `dispatch-enquiry-notifications`.
- **Whether each of these secrets is set, by name only (never paste a value):** `LOVABLE_API_KEY`, `ENQUIRY_EMAIL_ENABLED`, `ENQUIRY_INTERNAL_NOTIFY_TO`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_EXPECTED_HOSTNAMES`, `ENQUIRY_CHALLENGE_MODE`.
- Authentication → Email settings: whether custom SMTP is configured (`PRODUCTION_AUTH_SMTP_CONFIGURATION_REQUIRED`).

## C. Security scanner findings (read-only)

Run the Lovable security scan and paste **every finding exactly as the scanner states it**: identifier, title, severity and the object named. Do not summarise or merge findings. For orientation only:
- This candidate removes the client INSERT/UPDATE policies on `adjusting_journal_entries` and `aje_lines` (`20261026100000`). A finding about those policies is expected to clear **only after** F2.
- Do not mark any finding resolved before the change that addresses it is applied and verified.

## D. Live pricing parity (read-only)

```sql
SELECT p.code, p.name, p.is_active, o.offer_code, o.market_code, o.currency_code, o.amount_minor, o.currency_exponent,
       o.billing_interval, o.billing_interval_count, o.is_active AS offer_active, o.is_purchasable, o.effective_start, o.effective_end
  FROM public.commercial_plans p LEFT JOIN public.commercial_offers o ON o.plan_id = p.id
 ORDER BY p.code, o.effective_start;
```

Compare with the reviewed catalogue (`src/lib/commercial/pricingCatalogue.ts`; USD, shown on the site as *proposed*):

| Plan | Entities | Named users included | Monthly | Annual | Additional named user |
|---|---|---|---|---|---|
| SOLO | 1 | 1 | 49.00 | 490.00 | — |
| PRACTICE | 5 | 1 | 99.00 | 990.00 | 20.00 / month, 200.00 / year |
| FIRM | 25 | 1 | 299.00 | 2,990.00 | 20.00 / month, 200.00 / year |
| ENTERPRISE | agreed | agreed | agreed | agreed | — |

Report every difference as **drift**. Do not edit the hosted values: the reviewed catalogue is the source of truth, and drift is corrected through a reviewed change. **No offer may be purchasable**: checkout is not activated, and activation is manual.

## E. Email delivery (read-only until authorised)

1. Report the B secrets status and whether custom SMTP is configured.
2. Do **not** send a real email until the owner authorises the real-mailbox test (`docs/operations/SERVICE_ENQUIRY_PHASE1.md`). When authorised, report the status shown beside the reply in `/admin/enquiries`, using exactly these words: *Queued*, *Sending*, *Accepted*, *Delivered*, *Bounced*, *Failed*. *Accepted* is not proof of delivery.

## F. Changes, each only on the owner's explicit authorisation

The batches are applied in this order. Every step has a read-only preflight before it and a read-only postcondition after it.

1. **Statement sign-off policy (batch `reporting-r5`):**
   - run `docs/release/reporting-r5/preflight.sql`;
   - apply `release/wrappers/20261024100000_fs_signoff_approval_policy.wrapper.sql`;
   - run `docs/release/reporting-r5/postcondition.sql`.
2. **Commercial candidate (batch `commercial-c1`):**
   - run `docs/release/commercial-c1/preflight.sql`, and keep its counts and digests;
   - apply, in order:
     - `release/wrappers/20261025100000_commercial_enquiries.wrapper.sql`
     - `release/wrappers/20261026100000_retire_browser_adjusting_journal_writes.wrapper.sql`
     - `release/wrappers/20261027100000_workspace_purpose.wrapper.sql`
   - run `docs/release/commercial-c1/postcondition.sql`. Its counts and digests must equal the preflight's.
   - Submit each wrapper **byte for byte**. It checks its own size and SHA-256 and refuses any altered copy before running a statement. If it refuses, stop and report; do not edit the file.
3. **Deploy** `submit-service-enquiry` and `dispatch-enquiry-notifications` from the merge commit.
4. **Publish** the frontend from the merge commit, then repeat A.

Not part of this checklist:
- enabling withheld services;
- changing the demo company's sign-off policy;
- re-signing any report;
- resetting test data;
- activating checkout.
