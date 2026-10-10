# CFOClose commercial launch: plans and online payment (closure)

- **Milestone:** *Commercial launch: plans and online payment*.
  - **Merged:** #103 (database authority, `commercial-p1`), #104 (server functions) and #105 (screens), at main `c9460b2`.
  - **The closure PR** adds `commercial-p2` and the fixes in §2.
  - The release commit, its tree and its CI runs are in `RELEASE.txt`.
- **Supersedes:** `handoff-commercial-launch-20261010.zip`, and every earlier package.
- **Not done under this release:** no hosted migration, deployment, publication, merchant account, sandbox run, live payment or charge. The platform stays `PAYMENTS_DISABLED` until the owner opens it, stage by stage (`COMMERCIAL_LAUNCH_LOVABLE_CHECKLIST.md`, Stages C–F).

## 1. Owner decisions (10 October 2026)

| Decision | How the release honours it |
|---|---|
| Annual prices approved: Solo USD 490, Practice USD 990, Firm USD 2,990 | Recorded by an administrator at checklist C3. No price is hard-coded: the site shows the server's approved amount. |
| Enterprise quoted separately | Always **Discuss Enterprise**; never sold online |
| Additional-user prices (USD 200 a year, Practice and Firm) kept, **not approved** | Shown as "proposed … arranged with our team". Never sold online, and never part of a checkout. **Outstanding owner approval** before seats could ever be sold. |
| Launch scope: Polar card payments only, conditional on merchant approval and verification | Checkout opens only at Stage F, after C4 (approval), D (sandbox) and E (controlled live) |
| No TZS prices; Snippe disabled but preserved | `SNIPPE_CUSTOMER_CHECKOUT_ENABLED = false` on the server; `LAUNCHED_MARKETS = ["GLOBAL"]` in the browser. Neither the landing, the plans nor the administrator's price form offers TZS or mobile money. The adapter and webhook remain. |
| Consulting stays enquiry and quotation | **Ask for a quote**. Also outside Polar's acceptable use (human services). |
| Financial reporting stays a restricted pilot | A purchase never touches the rollout tables. Proven in `paidTermPreservation.mjs` ("Withheld services"). |

## 2. What the closure changes

| Area | Defect or gap found | Change | Regression coverage |
|---|---|---|---|
| Paid-term preservation (`commercial-p2`, migration `20261030100000`) | An upgrade ended the current term at once, **silently ending its paid additional named users** | The placement rule returns `BLOCKED_SEATS` for an upgrade over additional users. The payment is recorded once and the term waits for an administrator. Renewal and downgrade report the current term's seats, which continue until it ends. | `scripts/db-proof/paidTermPreservation.mjs` (17 assertions); wrapper proof; `paymentScreens.test.ts` |
| Delayed Polar notifications | A correctly signed delivery older than 5 minutes was dropped, relying on the customer or an administrator to recover the order | Such a delivery now reconciles: duplicate check by event id, then a read of Polar's own order, then the same idempotent commit. At most one read a minute per order. The body is never trusted, and a bad signature still gets 401. | `providerAdapters.test.ts`; E2E "delayed notification" (20 minutes old) |
| Partial refunds | Polar reports the order's **cumulative** refunded amount. A partial refund followed by a full one recorded the full amount again. | Each reversal records only the change since the reversals already recorded. A redelivery records nothing. | `providerAdapters.test.ts`; E2E partial-then-full refund recorded as 200.00 then 290.00 |
| Polar-only availability | The server would offer mobile money once a TZS price existed, and the price form defaulted to TZS | Snippe is gated off in code, the browser shows only launched markets, and the price form defaults to GLOBAL/USD with a Polar-only note | `providerAdapters.test.ts` owner-decision test; `landingPage.test.ts`; `noCheckoutClaims.test.ts` |
| Approved price while checkout is closed | Showed "Proposed" | Shows the approved amount with **Request activation**: no dead button and no invented price | `landingPage.test.ts`; `noCheckoutClaims.test.ts` |
| Copy | The FAQ and guides mentioned mobile money | Card through Polar only | `landingPage.test.ts`; documents |
| Account home (owner's screenshots of `cfoclose.com/dashboard` and `/plans`, 10 October 2026) | The screenshots are this candidate's code rendering hosted data, not an older build. "Proposed" prices are the configuration-dependent fallback: no offer is approved on the hosted project yet. Confirmed gaps: (1) no single next action; (2) a disabled "Start Trial balance review" button; (3) "No active plan" stated three times; (4) company creation only through Settings; (5) `/plans`, checkout and orders used the public header, and the footer offered "Sign in" to a signed-in person; (6) a fresh account without a plan was silently redirected to `/plans`. | `deriveAccountNextAction` (pure) chooses **one** primary action from the plan, capacity, company, period and review-permission reads. Blocked actions state their prerequisite instead of showing a disabled button. The missing plan is said once. "Add a company" opens the existing `create_entity` form on the home when capacity permits. `AccountShell` is the one signed-in frame (Home, Plans, Orders, Settings, Sign out) for the home, plans, checkout and orders. A fresh account stays on the home with "Choose a plan to begin". | `accountNextAction.test.ts`; `EngagementHub.unavailable.test.ts`; `Dashboard.test.ts`; `TrialBalanceSurfaces.test.ts`; E2E "Fresh account" group |

## 3. Migration inventory

**Hosted state is authoritative:** run checklist **A1**.
- Claude has no hosted access.
- No evidence has been received that any batch below is applied.
- Every batch is idempotent: each refuses a second application.

| Order | Batch | Wrapper (`release/wrappers/`) | Bytes | SHA-256 | Source commit | Status |
|---|---|---|---|---|---|---|
| 1 | reporting-r5 | `20261024100000_fs_signoff_approval_policy.wrapper.sql` | 15,105 | `74d6cd987a0063809414f336b17bd7afd3199ce3349f9b5ee3e7b1cf8e11487e` | `5358aef` | Pending (verify at A1) |
| 2 | commercial-c1 | `20261025100000_commercial_enquiries.wrapper.sql` | 19,613 | `577cfa4c84399a22f50a9dfc52af2cfa68d09592c54a0440a41c3b39e46d8e90` | `0158258` | Pending |
| 3 | commercial-c1 | `20261026100000_retire_browser_adjusting_journal_writes.wrapper.sql` | 6,182 | `7ed2cee1836489a169f5193aa935291ecc9bceea5872f0b11aadc94c089c8934` | `0158258` | Pending |
| 4 | commercial-c1 | `20261027100000_workspace_purpose.wrapper.sql` | 7,192 | `44daa7f7aa1305789cf1e342ddf49aae1e423dafc3a2213d1498ea91c06f2f2f` | `0158258` | Pending |
| 5 | commercial-c1 | `20261028100000_period_dates_from_company.wrapper.sql` | 11,708 | `c2c3afed5cb93b225b466f3e5d0ecfba2ab2a701a94c0e50035006e6b0569529` | `0158258` | Pending |
| 6 | commercial-p1 | `20261029100000_payment_provider_routes.wrapper.sql` | 50,575 | `407e056d63f0083137bceb4dbb10c27beafba11c326701589ef838549d8b6627` | `21387d5` | Pending |
| 7 | commercial-p2 | `20261030100000_paid_term_seat_preservation.wrapper.sql` | 18,799 | `46fdfc422df34a812f5fb5b6b0ca84b06a9c051e6b29828d3d547ae230c68a5d` | `c950fc1` | Pending (new in this closure) |

- **p2 payload:** 17,223 bytes, SHA-256 `d98f4535c27d83a0d0d50a72fcae067ad692a8f5356a5dbbd6d6897cb582df7c`. Both registered submission forms are pinned in `scripts/ci/releaseJournal.mjs`.
- **Preflight and postcondition:** `release/<batch>/preflight.sql` and `postcondition.sql`, all read-only.
- **p2 preflight** refuses unless p1 is applied and payments are disabled, and refuses if p2 is already applied. It records three counts and digests (licences, intents, payment events).
- **p2 postcondition** checks the placement rule, the commit, the scoping (service role only), and that payments are still disabled. Its digests must equal the preflight's.

## 4. Function deployment

`release/FUNCTIONS_MANIFEST.json` names every file each function deploys, with its SHA-256 at the release commit.

| Function | JWT | Reads secrets | Changed in the closure |
|---|---|---|---|
| `commercial-create-checkout` | on | `SAFF_PAYMENT_REDIRECT_URL`, `POLAR_*`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (`SNIPPE_*` are read but never offered) | Yes (shared routing) |
| `commercial-payment-status` | on | as above, plus `SUPABASE_ANON_KEY` | Yes (settlement) |
| `commercial-webhook-polar` | **off** | `POLAR_*`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Yes (delayed-notification recovery) |
| `commercial-webhook-snippe` | **off** | `SNIPPE_*` (unset: 503) | Shared modules only |
| `commercial-payment-webhook` | unchanged | none | No (retired, 410) |
| `submit-service-enquiry`, `dispatch-enquiry-notifications` | unchanged | unchanged | No |

## 5. Configuration names

Names only; never commit values.

| Name | Rule |
|---|---|
| `SAFF_PAYMENT_REDIRECT_URL` | `https://cfoclose.com/billing/payment/return` |
| `POLAR_ENVIRONMENT` | `sandbox` or `production`. Never defaulted. |
| `POLAR_ACCESS_TOKEN` | Organization token for that environment, with the checkouts and orders scopes |
| `POLAR_WEBHOOK_SECRET` | `whsec_…` (Standard Webhooks) |
| `POLAR_ORGANIZATION_ID` | UUID |
| `POLAR_PRODUCT_IDS` | `{"SOLO":…,"PRACTICE":…,"FIRM":…}`, one-time products with no Polar benefits |
| `SNIPPE_*` | **Do not set.** The route is not launched. |
| `POLAR_API_BASE_URL`, `SNIPPE_API_BASE_URL` | **Never on the hosted project.** For local tests only. |

## 6. Merchant eligibility, email and administrators

- **Merchant:** `PAYMENT_PROVIDER_EVIDENCE.md` §0 and §5.
  - Tanzania is a Polar **payout** country, which is not an approval.
  - Software is accepted.
  - Human services and tax advice are not, so consulting is never sold through Polar.
  - Onboarding needs three steps: approval, the owner's identity verification, and the payout account. It can take up to 14 days.
- **Email:**
  - custom SMTP (`PRODUCTION_AUTH_SMTP_CONFIGURATION_REQUIRED`);
  - enquiry email (`ENQUIRY_EMAIL_ENABLED`, `LOVABLE_API_KEY`, `ENQUIRY_INTERNAL_NOTIFY_TO`).

  See checklist B3.
- **Administrators:**
  - one commercial administrator by operator bootstrap (B4);
  - enquiry operators by `platform_staff_grant`;
  - live-acceptance testers by allow-list (E2).

## 7. Refunds, disputes and recovery

See `REFUNDS_DISPUTES_AND_RECOVERY.md`:
- **Automated:** settlement, delayed-notification recovery, and the recording of refunds as change amounts.
- **Manual:** placement review, uncertain outcomes, the access decision on every refund, and disputes. Polar documents no dispute webhook.
- **Unsupported:** automatic pro-rata refunds; automatic access changes on refund or dispute (by design).

## 8. Verification matrix

**Kinds of evidence:**
- **Mock** means recorded provider HTTP, or a local mock provider.
- **Local** means a real PostgreSQL, or the real app and functions on a local stack.
- None of this is evidence of Polar's real behaviour or of the hosted project.

| # | Check | Kind | Evidence | Result |
|---|---|---|---|---|
| 1 | Release integrity: release commit, tree, exact-head and final-main CI | CI | `RELEASE.txt`, `evidence/ci/` | **PASS** (see `RELEASE.txt`) |
| 2 | Payment authority (43 assertions) | Local, real PostgreSQL | `paymentProviders.mjs` | **PASS** (CI) |
| 3 | Paid-term preservation (17 assertions): seats, renewal, downgrade, upgrade, 6 concurrent deliveries plus a replay, manual-versus-payment races, withheld pilot, bystander intact | Local, real PostgreSQL | `paidTermPreservation.mjs` | **PASS** (local and CI) |
| 4 | Self-checking wrappers p1 and p2 | Real PostgreSQL | `selfCheckingWrappers.mjs` | **PASS** (CI) |
| 5 | Adapters, signatures, stale recovery, refund change amounts, Polar-only routing | **Mock** | `providerAdapters.test.ts` | **PASS** |
| 6 | Screens: checkout (incl. the seats note and `BLOCKED_SEATS`), status, administrator | **Mock** server answers (jsdom, axe) | `paymentScreens.test.ts` | **PASS** |
| 7 | End-to-end journey: purchase, signed webhooks (replay, bad signature, stale), **delayed notification recovered once**, partial then full refund, expiry, manual activation, cross-account denial, landing without TZS or mobile money, 1280 and 375 px | Local app and functions; **mock** Polar | `paymentJourney.mjs` (CI `real-app-e2e`), `evidence/payments-e2e/` | **PASS** (CI) |
| 7a | Fresh account, desktop and mobile:<br>• no company, engagement, demonstration data or privilege;<br>• one next step;<br>• one frame;<br>• keyboard;<br>• back and refresh;<br>• a failed plan read recovered by Try again;<br>• return from plan selection;<br>• server refusal of `create_entity` without a plan, of another account's company and of the administrator screen;<br>• after a manual activation, a company created from the home | Local app, database and functions | `paymentJourney.mjs` group "Fresh account" (CI `real-app-e2e`) | **PASS** (CI) |
| 7b | The same on the **hosted** project with a genuinely fresh account | Hosted | Checklist B6 | **NOT RUN.** Claude does not create accounts on the hosted service. The owner or Lovable runs it after Publish; NBAA's existing account is not used for it. |
| 8 | Polar eligibility from current documentation | Desk research | `PAYMENT_PROVIDER_EVIDENCE.md` §0 | **OWNER ACTION REQUIRED.** The country is supported for payouts; entity and offering are not approved. |
| 9 | Polar sandbox verification | **Sandbox** | Checklist Stage D | **NOT RUN.** No sandbox credentials exist. |
| 10 | Controlled live acceptance | Live | Checklist Stage E | **NOT RUN.** Not authorised; needs merchant approval. Real cost: USD 490 plus tax; Polar fees are not returned on refund. |
| 11 | Hosted migrations r5, c1, p1, p2 applied | Hosted | Checklist B1 | **NOT RUN** (Lovable, with owner authorisation) |
| 12 | Function deployment and Publish | Hosted | Checklist B2, B5 | **NOT RUN** (Lovable) |
| 13 | Custom SMTP and enquiry email | Hosted | Checklist B3 | **OWNER ACTION REQUIRED** |
| 14 | First commercial administrator | Hosted | Checklist B4 | **OWNER ACTION REQUIRED** |
| 15 | Legal review of terms and privacy for paid sales | External | Checklist C5 | **OWNER ACTION REQUIRED** |
| 16 | Additional-user price approval | Owner | §1 | **OWNER ACTION REQUIRED** (only if seats are ever sold online) |
| 17 | Independent accounting validation of the reporting pilot | External | — | **NOT RUN** (unchanged; not part of this release) |
| 18 | Polar dispute notifications | Provider | `PAYMENT_PROVIDER_EVIDENCE.md` §3b | **Not supported by Polar's documentation.** Handled manually. |

**No production readiness is claimed.** Mock and local evidence prove the implementation's handling of documented behaviour. Customer checkout stays closed until Stages C–E pass and the owner decides Stage F.
