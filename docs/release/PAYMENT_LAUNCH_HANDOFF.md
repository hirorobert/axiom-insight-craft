# CFOClose payment launch: the definitive handoff (Polar card payments)

- **Written:** 13 October 2026.
- **Corrected the same day** with the owner's report that onboarding, price approval and the tester designation are complete (§1a). The remaining work is the p5 deployment, the historical-charge reconciliation, controlled live acceptance and the final launch authorisation (§7).
- **Replaces** every earlier payment handoff as the description of what remains. It does not replace the step-by-step checklist (`COMMERCIAL_LAUNCH_LOVABLE_CHECKLIST.md`): it says where the launch stands, and in which order the remaining checklist stages run.
- **Nothing in this handoff was done on the hosted project by Claude.** No migration was applied, no function deployed, nothing published, no secret set, no price approved, no charge or refund made, and no provider enabled. Payments stay `PAYMENTS_DISABLED` until the owner opens them stage by stage.

## 1. Where things stand, by kind of evidence

| Kind | What it is | State |
|---|---|---|
| **Repository** | The code and migrations on `main` | Complete for the Polar card launch. Release commit `d83542f77ec614fb5f801ac1e87ebe34a0aa1d5f` (§2). |
| **Hosted** | What the live database and functions actually run | Hosted journal **55** (commercial-p4 applied as `0054`, recorded in this repository by PR #116). **commercial-p5 is not applied.** The p5 functions are not deployed, and the release is not published. P5-1 checks this again before anything changes. |
| **Provider** | What Polar or Snippe actually did | **No production payment and no refund has been completed** (owner's statement, 13 October 2026). This repository's payment evidence uses mock providers only. |
| **Owner** | Decisions and accounts only the owner can make | **Reported complete** (§1a): Polar merchant onboarding, production configuration, the USD price approval and the tester designation. **Open:** the controlled live charge and refund authorisations, and the final launch authorisation (§9). |

**Mock and local tests are not live acceptance.** They prove what this code and database do with documented provider behaviour, nothing about Polar's real behaviour or the hosted project.

### 1a. Hosted and owner evidence: source, date and how far it is verified

| Item | Source and date | Kind |
|---|---|---|
| Polar merchant onboarding (approval, identity verification, payout account) complete | The owner, in this session, **13 October 2026**, referring to later hosted reports | **Reported completion.** Not independently verified. |
| Polar production configuration (`POLAR_*` secrets set by name) complete | The same | **Reported completion.** Not independently verified. |
| Approved USD prices (Solo 490, Practice 990, Firm 2,990) recorded on the hosted project | The same | **Reported completion.** Not independently verified. |
| Live-acceptance tester designated: **cfoclose@gmail.com** | The owner, 13 October 2026 | **Reported completion** (the designation). Whether the account is allow-listed and active is read at step 3 (§7) before the charge. |
| No production payment or refund completed | The owner, 13 October 2026 | Owner's statement |
| Earlier state: no `POLAR_*` secrets, merchant not approved, prices not approved, allow-list empty | The owner's hosted report for release `9ac3456`, 10 October 2026 | Hosted report. **Superseded** by the rows above. |

**The later hosted reports were not available when this handoff was written.** They were named as attached, but none reached the repository or this session. Their file names, dates and verbatim results must be added here when they are provided.

**Independently verified** means the evidence can be read from the hosted project or the provider, not only from someone's statement. The read-only checks are:
- P5-1 for the database state;
- `/commercial/admin` → **Online payment**, showing the card route configured in **production**;
- **Prices**, showing the three USD offers approved;
- the allow-list row for the tester's account.

Polar's merchant approval can only be verified in Polar's dashboard. Each of these checks is recorded at step 3 (§7). Completed onboarding, price approval and tester designation are **not repeated**.

**Not covered by the owner's statement:**
- Polar sandbox verification (checklist Stage D);
- the legal review of the terms and privacy pages for paid sales;
- custom SMTP.

This repository has no evidence of any of the three. The owner did not list them as remaining work. Their status is to be recorded with the later hosted reports. This handoff does not assume them complete.

## 2. Release and CI identities

| Item | Value |
|---|---|
| Release commit (deploy and Publish this) | `d83542f77ec614fb5f801ac1e87ebe34a0aa1d5f` (`main`, merge of PR #118) |
| Release tree | `f48230a8fed945d8b92854e5ae27b9aee2c5aaf1`, identical to the tested head's tree |
| Tested head | `d2a7e3d471ba1c1bde7e0f0a7a758762293743e6`. The merge was locked to it (`--match-head-commit`). Parents: `84ce10c` + `d2a7e3d`. Branch `fix/checkout-supersession` is preserved. |
| Exact-head CI | Run `38379736651`, attempt 1. Every required job passed (Staging RLS Regression is manual and skipped by design). |
| Final-main CI | Run `38384677790`, attempt 1, on `d83542f`. Every required job passed. |
| Includes | The business-email release `004a055` and the commercial-p4r correction `6378bfe`. Both are ancestors of the release commit. |
| Payments in the release | `SNIPPE_CUSTOMER_CHECKOUT_ENABLED = false` and `LAUNCHED_MARKETS = ["GLOBAL"]`. Card through Polar is the only route the code can offer. |

**Proof results in the final-main and exact-head logs.** Real PostgreSQL, mock provider:

| Proof | Result |
|---|---|
| Verified charge outcomes | 26/26 |
| commercial-p5 wrapper, with the read-only postcondition | ALL PASSED (32) |
| Payment providers | 43/43 |
| Snippe ledger | 30/30 |
| Payment reversal authority | 38/38 |
| Paid-term preservation | 18/18 |
| Sandbox licence isolation | 45/45 |
| p4 hosted baseline | 19/19 |
| Payment journey: real Edge Functions, mock Polar and Snippe, 1280 and 375 px | 53/53 |

The Snippe ledger log contains a `pg` client deprecation warning with a stack trace. It is a warning, not a failure.

**After the release commit.** The PR that adds this handoff changes only documentation and one proof script: it adds four live-acceptance checks to `paymentProviders.mjs`, which pass 47/47 locally. It changes no frontend, Edge Function or migration file. Publishing either commit runs the same application. The deployment instruction still names `d83542f`.

## 3. The deployment package (commercial-p5)

| Item | Value |
|---|---|
| Archive | `handoff-commercial-p5-20261013.zip`, 3,649,791 bytes |
| SHA-256 | `55975ea75aa61cdede7374a94dff40da06d3e90a56676ae461f9ad8adec5947b` |
| Wrapper (the only migration) | `release/wrappers/20261102100000_verified_charge_outcomes.wrapper.sql`, 47,281 bytes, SHA-256 `a215cc20994f91c57fe0774401decd21a8129013a6fecb1e70ae3cf1567b57ea`, the registered submission form |
| Enclosed source | `20261102100000_verified_charge_outcomes.sql`, source commit `82659bb` |
| Edge Functions | `commercial-payment-status`, `commercial-webhook-polar`, `commercial-webhook-snippe`: 31 files, each with its SHA-256 at the release commit, in `release/FUNCTIONS_MANIFEST.json` |
| Fresh-extraction verification | All 20 files match their checksums. 10 of 10 repository files are byte-identical to the release commit. The wrapper and source equal the forms registered at the release commit. The journal at the release commit is 55. Exactly one wrapper is in the package, and no earlier migration. Snippe is disabled. The instruction states what "supersedes" means. Result: **VERIFIED: no problems**. A tampered copy fails, on both the checksum and the wording check. |

**"Supersedes" means:**
- **It includes the earlier application changes.** The release commit contains everything from the business-email release, the p4r package and every earlier package.
- **It replaces their deployment instructions.** Deploy and Publish only from `d83542f`.
- **It repeats no migration.** commercial-p4 and everything before it stay applied. Apply only the p5 wrapper.

### The one Lovable instruction

Steps P5-1 to P5-7 are in `LOVABLE_INSTRUCTION.md` in the package. In order:

1. **P5-1 (read-only).**
   - Expect `journal_rows = 55`, `p5_applied = false`.
   - Record `platform_state`. It must still be `PAYMENTS_DISABLED`.
2. **P5-2 (read-only).** Run the preflight and report all of it:
   - exposure;
   - historical dropped charges (section 1b);
   - the digests.
3. **P5-3 (owner authorisation).** Apply the wrapper byte for byte, once. Expect journal 56.
4. **P5-4 (read-only).** The postcondition must read `POSTCONDITION OK.`, and its digests must equal P5-2's. **Preservation:** the migration writes no row, and every earlier migration, historical offer, paid term, seat and audit row is unchanged.
5. **P5-5 (owner authorisation, only after P5-4).** Deploy the three Edge Functions from `d83542f`.
6. **P5-6 (owner authorisation, only after P5-4).** Publish `d83542f`.
7. **P5-7 (read-only).** Check that:
   - the journal is 56 and `platform_state` is unchanged;
   - **Charges needing a decision** shows on `/commercial/admin`;
   - mobile money is unavailable at checkout.

The two legacy TZS offers under the retired `PAID` plan (`95dc943c…`, `68d35bb6…`) are preserved as active, **not purchasable**, historical rows. No step touches them.

## 4. What the release guarantees about every verified charge

Every guarantee below is proven against real PostgreSQL in CI, with a mock provider.

| Requirement | Result | Evidence |
|---|---|---|
| Every verified charge is recorded exactly once, with either a valid placement or an OPEN recovery case | PASS | `verifiedChargeOutcomes.mjs` |
| Late payment on an intent CFOClose closed, with nothing replacing it: placed | PASS | same |
| Late payment after a replacement started, or contradicting a non-success the provider reported: a recovery case, never placed | PASS | same; CI journey with real functions |
| Replacement race (20 rounds): placed, or a recovery case. Never both, never neither. | PASS | same |
| Two distinct successful charges on one intent: one term, plus an OPEN case for the second | PASS | same |
| Duplicate notifications: 8 concurrent under one key plus 4 under others give one event and one case; redelivery gives `ALREADY_COMMITTED` | PASS | same; CI journey |
| A refund binds to the exact provider transaction, including two charges on one intent | PASS | same; `providerAdapters.test.ts` |
| Recovery decisions are authorised and audited. **Additional term** needs a production payment, no refund, the customer's recorded agreement (10+ characters) and the current placement rule (an open-ended agreement or reduced seats refuse). **Refunded** needs refunds recorded in full. **Test payment closed** is for sandbox only. | PASS | same; screen tests |
| An unintended second charge never silently becomes a renewal | PASS | same |
| A failed, malformed or unavailable administrator read shows an error or "not available" with Retry, never an empty queue; the other sections stay | PASS (mock server answers) | `paymentScreens.test.ts` |

**Historical dropped charges: DISCOVERABLE, NOT RECOVERED.** Before p5, a charge on a closed intent could be answered `DUPLICATE` and dropped.
- **Discovery:** P5-2 section 1b lists webhook deliveries answered `DUPLICATE` whose provider transaction has no payment event.
- **Charges whose webhook never reached CFOClose** appear only in the provider's records.
- **Nothing recovers them automatically.** In-app verification accepts only open orders.

Section 7, step 2, reconciles them by hand.

## 5. "Choose a plan → secure checkout": verification against the server

The browser never decides availability. `get_public_plan_prices` decides what the plan cards say. `commercial-create-checkout` (GET) decides which routes the checkout page offers. `acquire_checkout_attempt`, through `assert_platform_state_permits`, refuses any attempt the platform state does not permit.

| Server state or case | Expected | Result | Evidence |
|---|---|---|---|
| `PAYMENTS_DISABLED` | Plans show the approved or "Proposed" price with **Request activation**. Checkout says online payment is not open and offers the activation request. The server refuses any attempt and writes nothing. | **PASS** | CI journey (fresh account); `paymentScreens.test.ts` "no open route"; `paymentProviders.mjs` Matrix |
| `SANDBOX_ONLY` | Never advertised publicly. Sandbox route only, labelled test mode. A sandbox payment grants nothing. | **PASS** | CI journey; `sandboxLicenceIsolation.mjs` |
| `LIVE_ACCEPTANCE`: the server rule | Only an **active** allow-listed account starts a checkout, and only in production. Any other account, or a deactivated entry, is refused with nothing written. A client cannot add itself to the list. | **PASS** (real PostgreSQL; new in this handoff) | `paymentProviders.mjs` Matrix, 4 checks |
| `LIVE_ACCEPTANCE`: the pages | The public plans still say **Request activation**. The tester opens `/billing/checkout?plan=SOLO` directly and sees the production card route. Any other account sees "not open". | Code reviewed; **NOT RUN** end to end | The CI stack has only a sandbox Polar configuration. This is checklist Stage E, step 3. |
| `CUSTOMER_PAYMENTS_ENABLED` | Solo, Practice and Firm show the approved USD price, "by card" and **Choose <plan>**, which leads to `/billing/checkout?plan=…`. | **PASS** (cards and links); production checkout **NOT RUN** | CI journey "Public plans when online payment is open"; `noCheckoutClaims.test.ts`; production route at Stage F |
| Existing customers | A signed-in visitor to `/` goes to their workspace. Checkout states the placement: a renewal starts when the current term ends, a downgrade at renewal, an upgrade now (unused time is not refunded automatically). Paid additional users are disclosed, and an upgrade over them goes to the team. | **PASS** | `paymentScreens.test.ts`; CI journey |
| Enterprise and specialist services | **Discuss Enterprise** or **Ask for a quote**, leading to the enquiry. Never a checkout. | **PASS** | `noCheckoutClaims.test.ts`; `planPurchaseView`; services handler checks |
| Hero CTAs and plan-table actions | The hero's primary action is **Explore plans**, leading to the plan cards, which carry the state-dependent action (**Choose <plan>** only while the server reports payment open). Tests enforce the hero's two actions. | **PASS** | `landingPage.test.ts`; `noCheckoutClaims.test.ts` |
| Header CTA | Always **Request activation**, whatever the server state. | **Implemented as intended; does not establish the purchase requirement** (§5a) | `Header.tsx`, `CTA.primary` in `src/constants/copy.ts` |
| Selected plan through sign-in | Signed out on `/billing/checkout?plan=PRACTICE`, the visitor signs in and returns to that checkout. Only the plan code is remembered, for one use. On another device the plan is chosen again. | **PASS** | CI journey "return from plan selection" |
| States | Loading; options unavailable; provider unavailable; uncertain outcome ("do not pay again"); earlier attempt still under review; pending; failed, expired or cancelled; received; scheduled; refunded; another account's order. Each at 1280 and 375 px. | **PASS** (mock provider) | `paymentScreens.test.ts`; CI journey |
| Interface changes grant nothing | Signing in, administrator status, `create_entity` without a plan, another account's company and a browser-supplied field are all refused by the server. | **PASS** | CI journey; `omega4AcquisitionHardening.test.ts`; Matrix checks |

### 5a. The header's "Request activation" (separate from the payment deployment)

The site header's primary action is **Request activation** in every server state, including `CUSTOMER_PAYMENTS_ENABLED`.
- **This is an intentional implementation choice:** `CTA.primary` in `src/constants/copy.ts`, rendered by `src/components/Header.tsx` on desktop and in the mobile menu. Manual activation remains available to everyone.
- **It is not proof that the public purchase experience meets the "Choose a plan → secure checkout" requirement.** When checkout is open, the header still points to the enquiry route. The purchase path is reached through the hero's **Explore plans**, the **Plans** navigation link (landing page only) or `/pricing`, then the plan card's **Choose <plan>**. No test, and no acceptance evidence, shows that a visitor using the header finds the purchase path.
- **Status: open product question, recorded here only.** Whether the header should offer the plans or the checkout while payment is open is for a later, separately reviewed change. It does **not** reopen or block the p5 deployment or the controlled live acceptance, and nothing in this release changes it.

**No defect was found in the purchase journey's server authority, states or routes.** The one gap was verification: the live-acceptance rule was checked only by reading its source text. It is now proven against a real database (4 checks).

## 6. Acceptance matrix

**Status key:**
- **PASS:** proven, with the kind of evidence named.
- **FAIL:** none.
- **NOT RUN:** needs hosted or provider access, or an authorisation not given.
- **OWNER ACTION REQUIRED:** a decision or account only the owner can complete.

| # | Check | Kind | Status |
|---|---|---|---|
| 1 | Release integrity: SHA, tree, exact-head and final-main CI | CI | PASS |
| 2 | Package verified on a fresh extraction | Local | PASS |
| 3 | Every verified charge recorded exactly once, placed or a visible case (§4) | Real PostgreSQL, mock provider | PASS |
| 4 | Late payments, replacement races, distinct second charges, duplicate notifications | Real PostgreSQL, CI journey | PASS |
| 5 | Exact-charge refund binding; authorised recovery decisions; agreement plus the placement rule for an additional term | Real PostgreSQL, screen tests | PASS |
| 6 | Administrator read failures visible, never an empty queue | Screen tests (mock) | PASS |
| 7 | Purchase journey for each server state (§5) | CI journey, real PostgreSQL | PASS, except rows 8 and 9 |
| 8 | `LIVE_ACCEPTANCE` pages with a production configuration | Hosted, provider | NOT RUN (§7, step 3) |
| 9 | Production checkout under `CUSTOMER_PAYMENTS_ENABLED` | Hosted, provider | NOT RUN (Stage F) |
| 10 | Hosted journal at 55 with p4 applied and p5 unapplied | Hosted | Recorded earlier; **fresh check at P5-1** (Lovable) |
| 11 | p5 applied and postcondition OK, with preservation | Hosted | NOT RUN (P5-3, P5-4) |
| 12 | Functions deployed; release published | Hosted | NOT RUN (P5-5, P5-6) |
| 13 | Historical dropped charges reconciled with Polar's records | Hosted, provider | NOT RUN (§7, step 2) |
| 14 | Polar merchant onboarding (approval, identity, payout account) | Provider | **Reported complete** by the owner, 13 Oct 2026 (§1a). Not independently verified; the Polar dashboard check is recorded at §7, step 3. |
| 15 | Polar production configuration | Hosted | **Reported complete** (§1a). The `/commercial/admin` read is recorded at §7, step 3. |
| 16 | USD prices approved on the hosted project | Hosted | **Reported complete** (§1a). The **Prices** read is recorded at §7, step 3. |
| 17 | Polar sandbox verification | Provider (test money) | No evidence in this repository; to be recorded with the later hosted reports (§1a) |
| 18 | Controlled live acceptance: one charge, then a refund | Provider (real money) | NOT RUN. **No production payment or refund has been completed.** Needs authorisation per charge and per refund (§7). |
| 19 | Legal review of terms and privacy for paid sales | External | No evidence in this repository (§1a) |
| 20 | Custom SMTP | Hosted | No evidence in this repository (§1a) |
| 21 | Designated live-acceptance buyer | Owner | **Designated:** cfoclose@gmail.com (owner, 13 Oct 2026). Allow-list membership is read at §7, step 3. |
| 21a | Header CTA against the purchase requirement (§5a) | Product | OWNER ACTION REQUIRED (a later, separate decision; not a deployment blocker) |
| 22 | Snippe: anything beyond the disabled implementation | Provider, owner | NOT RUN, disabled (§8) |
| 23 | Decision to open public checkout | Owner | OWNER ACTION REQUIRED (§9) |
| 24 | Independent accounting validation of the reporting pilot | External | NOT RUN (unchanged; outside this launch) |

## 7. The remaining Polar launch procedure

What remains, as the owner reported on 13 October 2026, is:
1. the p5 deployment;
2. the historical-charge reconciliation;
3. controlled live acceptance, including its refund and access resolution;
4. the final launch authorisation.

Onboarding, price approval and the tester designation are reported complete and are **not repeated**. Each step below needs the evidence named before the next one starts. Stage letters refer to `COMMERCIAL_LAUNCH_LOVABLE_CHECKLIST.md`.

| Step | What | Who | Evidence required |
|---|---|---|---|
| 1 | **Deploy p5:** P5-1 to P5-7 (§3) | Lovable, with owner authorisation for P5-3, P5-5 and P5-6 | The P5-1 and P5-2 outputs; journal 56; `POSTCONDITION OK.` with equal digests; deployed file hashes against the manifest; the P5-7 checks |
| 2 | **Reconcile historical dropped charges.** List every *succeeded* order in Polar's dashboard for the production organization, and the sandbox one for completeness. Match each to a `payment_events` row by provider transaction id. Include every row from P5-2 section 1b. | Owner and Lovable, read-only | A list of unmatched charges, or "none". For each one, the owner chooses: refund it in Polar, then record it; or arrange an additional term **with the customer's written agreement**. Never re-run verification on a closed order. |
| 3 | **Controlled live acceptance (Stage E).** First, read-only and without repeating anything: `/commercial/admin` → **Online payment** lists the card route in **production**; **Prices** shows the three USD offers approved; the allow-list row for cfoclose@gmail.com's account is **active**; Polar's dashboard shows the account approved. Then set `LIVE_ACCEPTANCE`, confirm a non-listed account is refused, and make **one** real Solo purchase as cfoclose@gmail.com through `/billing/checkout?plan=SOLO`. | Owner authorisation **for this specific charge**, given after the disclosure below | The four read-only results; the refusal for the other account; the buyer's status page, order and licence; Polar's order id and the **actual** total charged |
| 4 | **Refund and access resolution.** Refund that charge in Polar. Confirm the refund is listed against **that exact transaction**. End the licence and record **licence ended**. Deactivate the allow-list entry. Set `PAYMENTS_DISABLED`. | Owner authorisation **for this specific refund**; administrator | The refund recorded against the transaction; access ended and audited; the platform disabled; the **actual** fees Polar retained |
| 5 | **Final launch authorisation (Stage F):** the owner's decision in §9, then `CUSTOMER_PAYMENTS_ENABLED` | **Owner decision** | The recorded decision; the landing and `/plans` show the prices with **Choose <plan>**; a daily watch of **Payments needing attention** |

> **Before the one real payment (step 3), present this to the owner and get a concrete authorisation:**
> - **Designated buyer:** cfoclose@gmail.com, the owner's designation of 13 October 2026. That account is the only one allow-listed.
> - **Plan and price:** Solo, USD 490.00, one 12-month term.
> - **Exact tax-inclusive total: UNRESOLVED until Polar's checkout shows it.** Polar, as merchant of record, adds any sales tax, VAT or GST for the buyer's location. The buyer confirms the total on Polar's page before paying. No figure is invented here.
> - **Non-refundable costs: UNRESOLVED until verified with Polar or shown on the actual order.**
>   - The only figures available are Polar's published fees as read on 10 October 2026, not verified:
>     - 5% + USD 0.50 on the transaction: about USD 25.00 on USD 490, plus 5% of any tax;
>     - plus 1.5% for a non-US card: about USD 7.35 more.
>   - Polar keeps its fees when a charge is refunded.
>   - A dispute would cost USD 15 more.
>   - Payout fees (0.25% + USD 0.25, and 0.25–1% currency conversion) apply only if a payout is made.
> - **Refund:** a separate, concrete owner authorisation, then the refund in Polar's dashboard (step 4).

## 8. Snippe: honest readiness status

| Layer | State |
|---|---|
| **Implemented** | The adapter (create payment, status read-back, signed webhooks, the flat event format, 10-second read-back timeouts, 409 and 422 treated as uncertain). The ledger is shared with Polar. A sandbox payment never grants. Externally completed refunds can be recorded (`admin_record_provider_refund`, p4). |
| **Deployed** | The webhook function is deployed. With no `SNIPPE_*` secret it answers 503 (last hosted report). The code never offers the route: `SNIPPE_CUSTOMER_CHECKOUT_ENABLED = false`, `LAUNCHED_MARKETS = ["GLOBAL"]`. |
| **Configured** | Nothing. No `SNIPPE_*` secret is set. `SNIPPE_API_BASE_URL` must never be set on the hosted project. |
| **Tested** | Mock and local only: `snippeLedger.mjs` 30/30; the adapter tests; the CI journey's 5 webhook-abuse checks with mock Snippe. **No request has ever reached Snippe.** |

**The exact settings the adapter reads** (`supabase/functions/_shared/payments/routing.ts`):

| Setting | Rule |
|---|---|
| `SNIPPE_ENVIRONMENT` | `sandbox` or `production`. This is **CFOClose's own label**, not a Snippe setting. Snippe documents no sandbox host and no test marker on a payment, so this label alone never makes a real payment a test. |
| `SNIPPE_API_KEY` | Sent as `Authorization: Bearer`. The adapter enforces no prefix. Snippe's documentation shows keys as `snp_…` with collection scopes. |
| `SNIPPE_WEBHOOK_SECRET` | Must start with `whsec_`, as Snippe documents and issues it. Otherwise Snippe stays unconfigured. |
| `SUPABASE_URL` | Builds the webhook address `…/functions/v1/commercial-webhook-snippe` |
| `SAFF_PAYMENT_REDIRECT_URL` | Shared with Polar. Without it, no provider is configured. |
| `SNIPPE_API_BASE_URL` | Local tests only (loopback). Never on the hosted project. |

**Missing before Snippe could ever be enabled:**
- merchant approval (KYC for CFOClose's Tanzanian entity, and the transaction maximum);
- test and live separation confirmed by Snippe in writing;
- a refund mechanism (none is documented);
- settlement account, schedule and fees;
- customer terms covering TZS mobile money (legal review);
- the seller's own obligations: TRA, VAT registration, EFD/EFDMS receipting, invoicing and any withholding. **Polar's merchant of record does not cover Snippe sales.**
- owner-approved explicit TZS prices. **None is approved. None is converted from USD.**

**Questions for Snippe** (one list, to send by the owner):
1. Is CFOClose's Tanzanian entity, selling a software subscription, eligible? Which KYC documents are needed, and what is our per-transaction maximum?
2. How are test and live separated: separate accounts, keys or hosts? Can a payment made with a test key ever be live, and can a payment be identified as a test through the API?
3. Can a completed mobile-money collection be refunded? By API, dashboard or support? How long does it take, what reference do you issue, and does it appear in settlement reports?
4. What is the fee per network (M-Pesa, Airtel Money, Mixx by Yas, Halotel), and who bears it?
5. What are the settlement account options, the schedule and any minimum? How does a settlement report identify each payment reference?
6. Can a network or customer reverse a completed payment? How would we be notified?
7. Which expiry applies to a payment request: 4 hours or 1 hour?
8. Which scopes should the API key carry? Do you publish webhook source IP addresses?

**Steps for a later, separately authorised activation:**
1. Record every answer above in writing.
2. The owner approves explicit TZS prices, and the advisers confirm TRA, VAT and EFD handling.
3. A reviewed release changes `SNIPPE_CUSTOMER_CHECKOUT_ENABLED` and `LAUNCHED_MARKETS`.
4. Run Snippe's confirmed test arrangement, then one authorised controlled live payment.
5. Open the route through the checklist.

**Snippe does not block the Polar launch.** Nothing in §7 depends on it.

## 9. The decision needed to open public checkout

Open public card checkout only when **all** of these are true for release `d83542f`, or a later release that supersedes it:
1. commercial-p5 is applied with `POSTCONDITION OK.`, and the functions and frontend are deployed (§7, step 1).
2. The historical reconciliation shows no unresolved charge (step 2).
3. The step 3 read-only checks confirm what was reported complete: the production card route, the approved USD prices, the active tester and Polar's approval.
4. Controlled live acceptance passed, including the refund and the access resolution (steps 3 and 4), with the actual total and retained fees recorded.
5. The owner has confirmed the status of the items §1a lists as not covered (sandbox verification, legal review, custom SMTP), and accepts any that remain open.

The header's "Request activation" (§5a) is a separate product question. It is not a condition of this decision unless the owner makes it one.

> **Owner decision to record:** "I authorise CFOClose to set `CUSTOMER_PAYMENTS_ENABLED` for Polar card payments of the Solo, Practice and Firm annual plans at USD 490, 990 and 2,990, for release `<commit>`, effective `<date>`." It is recorded with typed confirmation and the reason in `/commercial/admin` → **Online payment**.

**Rollback** at any time: set `PAYMENTS_DISABLED`. Checkout closes, paid licences are untouched, and payments already in flight still settle.
