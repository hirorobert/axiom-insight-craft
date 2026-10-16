# CFOClose public website: review

**Prepared:** 2026-10-16. **Status:** research only. No production code was changed, nothing was published, and no private page was created.
**Repository baseline:** `origin/main` = **`00a2653b5736e89447334e1147aa25f5308b0393`** ("Fixed unlimited capacity view", 2026-10-16T03:54:57Z).
This branch (`research/landing-review-20261016`) is cut from that commit.

Every statement below is tagged by its source:
- **[REPO]**: read from the baseline source tree.
- **[LIVE]**: observed on `https://cfoclose.com` on 2026-10-16, between 11:47 and 12:10 UTC.
- **[DEPLOY]**: about which build is served.
- **[HYP]**: a hypothesis, not established.
- **[DECIDE]**: a decision for the owner.

Raw evidence is in `evidence/` (see `README.md` for how to replay it).

---

## 1. Deployment identity [DEPLOY]

| Evidence | Result | What it establishes |
|---|---|---|
| The live `index.html` carries a host-injected `data-commit-sha` attribute | `00a2653b5736e89447334e1147aa25f5308b0393` | The hosting platform *declares* that it built this commit. This is the host's own marker, not something we verified independently. |
| The live main bundle `/assets/index-1zBFVhf0.js` contains the exact logic `00a2653` added: `capacity.answer.unlimited===!0)return"allowed"` and the `EntityCapacityNotice` early return | Present | This is independent corroboration: the change unique to that commit is in the served code. |
| Landing strings from the baseline (`LANDING_HERO.headline`, the plans intro, the registered SHA-256 claim) are in the same bundle | Present | The landing copy served matches the baseline. |
| `x-deployment-id` response header | `psr2.e7b555d5-…` (opaque) | It identifies the deployment but is not tied to a commit by us. |

**Conclusion:** the page served at the time of review is consistent with `00a2653` on both the host's marker and independent content checks.
We did **not** do a byte-identical rebuild. This review says "served" or "deployed, per the host marker", never "released".

---

## 2. Repository findings [REPO]

- **R-1 Plans.** Solo, Practice, Firm and Enterprise come from `src/lib/commercial/pricingCatalogue.ts`. What a plan row says about price and payment is decided at runtime by `planPurchaseView()` over the server's `get_public_plan_prices`.
- **R-2 No free plan, no trial.** Migration `20260925130000` retires Free. An account without a plan has entity capacity 0. `20260925140000` and `20260926160000` refuse new uploads and the processing of existing uploads without a current plan, at the database boundary.
- **R-3 Generally available capability.** Trial balance review only, in three steps (`LANDING_WORKFLOW`). Financial reporting is labelled "Pilot · by invitation" and "not independently validated" (`LANDING_PILOT`).
- **R-4 Trust copy.** The trust strip uses the three registered wordings in `src/content/publicClaimRegistry.ts`. Each has an `evidenceScope`. The SHA-256 claim's scope explicitly does *not* cover immutability or re-verification, and its prohibited wordings include "tamper-proof" and "immutable".
- **R-5 Hero actions.** "Explore plans" (`#plans`) and "View plans" (`/plans`) are pinned by `src/components/landing/__tests__/landingPage.test.ts`.
- **R-6 Metadata inconsistent with the commercial rule.** The meta description in `index.html` (also `og:description` and `twitter:description`) and `src/lib/seo/publicPages.json` (path `/`) reads "Subscriptions are activated by our team". The repository's own `src/lib/commercial/__tests__/noCheckoutClaims.test.ts` forbids "activated by our team" in rendered commercial surfaces, and the live plans show online card checkout (L-3). That test does not cover metadata, so nothing catches this.
- **R-7 Hero screenshot asset.** `public/landing/trial-balance-review.png` is 1280×900 and 102,596 bytes. It is a real-application capture with a demonstration company. It shows the checks and the reviewed state, not account mapping.

## 3. Observed live-page behaviour [LIVE]

### 3.1 Commercial (narrowed to the path actually tested)
- **L-1** The landing plan rows rendered `data-mode="online"` for Solo, Practice and Firm, with "USD 490 / 990 / 2,990 per year by card" and "Choose <plan>". Enterprise showed "Discuss Enterprise".
- **L-2** A **signed-out GET** of `/billing/checkout?plan=SOLO` showed "Create an account or sign in to continue", with **Create an account** and **Sign in**, and the text "You will return here afterwards".
- **Not tested, so not claimed:** completing sign-up, the actual return after sign-up, reaching a payment page, completing a payment, the payment provider's behaviour, or plan activation and access. L-1 and L-2 show only that the checkout entry point and its sign-up offer render. They do not show that payment or activation works.
- **L-3** The plans section showed "Paid plans start once the payment is verified…" (the online note), which is consistent with L-1.

### 3.2 Product example
- **L-4** The hero screenshot renders at **0.225 scale at 320 px** (288 px wide), **0.28 at 390 px**, and **0.534 at 1280 px** (683 px wide). The app's 13–16 px text therefore displays at about 3–4.5 px on phones and about 7–8.5 px on desktop. *(Correction to the earlier checkpoint, which called it legible on desktop.)*

### 3.3 Reflow and accessibility (headless Chrome via `scripts/browser-acceptance`; `evidence/results.json`)
| Check | 320 px | 390 px | 1280 px |
|---|---|---|---|
| Horizontal overflow, clipped actions, unlabelled fields (`layoutProblems`) | none | none | none |
| Smallest visible text | 10 px (section eyebrows, e.g. "Product") | 10 px | 10 px |
- **L-5 Keyboard.** All of the first 12 Tab stops show a focus indicator. **5** of them (skip link, Sign in, header "View plans", both hero actions) use the site's designed 2 px ring. **7** use the browser's default ring (the header logo and four section links, Contact, and "Choose Solo"). Classified by actual visibility: every one of the 12 stops shows a visible focus indicator. The browser-default rings are visible and usable, so they are **not defects**, only stylistically different from the site's ring. Contrast of the default ring against each background was not measured.
- **L-6** The skip link ("Skip to main content") is the first Tab stop and becomes visible on focus.

### 3.4 Technical SEO: measured facts (`evidence/seo-probe.json`; rendered values from `evidence/results.json`)
| Item | Measured |
|---|---|
| `/`: HTTP status, `lang` | 200, `en` |
| Static `<title>` | "CFOClose — Trial balance review software" |
| Rendered title, canonical and robots for `/` | same title, `https://cfoclose.com/`, `index,follow` |
| Rendered values for `/plans` | "Plans — CFOClose", `https://cfoclose.com/plans`, `index,follow`, one H1 |
| Unknown path `/this-path-does-not-exist-404-probe` | **HTTP 200** (the app shell). Renders H1 "404", `noindex,nofollow`, no canonical. Description is the home description. |
| Static canonical in `index.html` | none (by design; it is set per route at runtime: `src/components/seo/RouteMeta.tsx`) |
| Meta, OG and Twitter description | "…Subscriptions are activated by our team…" (see R-6) |
| OG image, Twitter card | `https://cfoclose.com/og-image.png`, `summary_large_image` |
| JSON-LD in the static HTML | Organization, SoftwareApplication, FAQPage (9 questions) |
| Initial HTML (before JavaScript) | 0 H1, 0 visible body text characters, no `<noscript>` |
| `robots.txt` | 200; allows `/`, disallows the signed-in areas |
| `sitemap.xml` | 200; 5 URLs: `/`, `/plans`, `/contact`, `/terms`, `/privacy` |
| `www.` and `http://` | 302 and 301 to `https://cfoclose.com/` |
| Main JS / CSS (gzip transfer) | 369,390 B (1,284,896 B uncompressed) / 20,269 B |
| Hero PNG | 102,596 B |

**Recommendations** (kept separate from the facts, each with a reason; none of them promises a ranking):
- **S-1 (correctness).** Change the meta, OG and Twitter description and `publicPages.json` so they no longer say "activated by our team" (R-6). Proposed text is in `PROPOSED_COPY.md` §7. Extend the `noCheckoutClaims` scan to metadata so the drift cannot return.
- **S-2 (hygiene).** The unknown-path 200 is mitigated by the rendered `noindex`. Returning a real 404 status would need host routing configuration; this is low priority and the owner's call.
- **S-3 (optional).** The page depends on JavaScript for all content. Major search engines render JavaScript, and the FAQ and organisation data are already in static JSON-LD. Pre-rendering is **not** recommended as part of this change. This is recorded so it is a conscious choice; it is not a defect.
- **S-4 (weight).** A 369 kB gzip entry bundle for a marketing page is a measured fact. Route-level splitting of the landing page is a possible later engineering task. No user-facing effect is claimed.
- **Not proposed:** keyword stuffing, extra landing pages, or claims about rankings, traffic, bounce or retention.

---

## 4. Hypotheses [HYP]

| # | Hypothesis | Basis | How to test |
|---|---|---|---|
| H-1 | Visitors who cannot see the product on data hesitate at the entry price. | R-2, L-4 | Plan-row reach and checkout starts before and after the illustrative review; 5–8 interviews. |
| H-2 | An HTML example is understood on a phone where the scaled screenshot is not. | L-4 | A task test at 390 px ("which account still needs a decision?"). |
| H-3 | Two pricing actions in the hero dilute intent. | R-5 | An A/B test of the secondary action if traffic allows; otherwise a judgement call, stated as such. |

The following were **not** treated as defects: the page being a React single-page app, being one page, having preview URLs, and browser autofill. A blank local render seen earlier was Vite's cold dependency optimisation.

## 5. Decisions for the owner [DECIDE]

| # | Decision | Recommendation |
|---|---|---|
| D-1 | Add the illustrative (synthetic) review section | Yes. No entitlement, price or data-path change. |
| D-2 | Secondary hero action: "See a sample review" | Yes, if D-1. One pinned test changes. |
| D-3 | A real-file free preview | Not now. See `OWNER_DECISION_real_file_preview.md`. |
| D-4 | Keep the screenshot at ≥1024 px only, or drop it | Keep on desktop as evidence it is the real product; the HTML example becomes the readable product example. |
| D-5 | Correct the metadata (S-1) | Yes. It is a correctness fix, independent of D-1. |
| D-6 | Restyle the browser-default focus rings to match the site (L-5) | Optional and stylistic only; no accessibility defect was found. |

**Unchanged:** entitlements, prices, terms, checkout, the claim registry's approved wordings, and the pilot status.

## 6. The illustrative review mockup (proposal)

`mockup/sample-review-mockup.html` is self-contained and makes no network request.

**Behaviour**
- The hero's secondary action is **"See a sample review"**. The section heading is "Explore an illustrative trial balance review", and the section is labelled **"Illustrative example — invented data"**.
- **The checks are split into two kinds.**
  - *Arithmetic checks* run on import and pass: file read, valid amounts, debits equal credits. The balance line says plainly that it "says nothing yet about how accounts are classified".
  - The *statement equation* depends on classification. It shows **Pending**, with a plain reason, while any account has no category. Once every account has one it is **recalculated from the current categories**, with figures, and explained as holding whenever the totals balance and every account has a category: it does not show that the categories are right.
- **Guided resolution with invented evidence.** Each of the two held accounts shows invented supporting evidence (a loan note; a ledger detail of customer overpayments) and three treatments.
  - Selecting a treatment records nothing; only **Record decision** records one, so moving through options by keyboard is never logged.
  - Each recorded decision is compared with the invented evidence. An unsupported one is recorded, labelled as not supported, and keeps the sample not reviewed.
  - The page says plainly that this comparison belongs to the illustration: **CFOClose records decisions; it does not check them against evidence**. No validation capability is claimed for the product.
- **The illustrated ready state** (step 3 and "Reviewed (illustrative)") requires all of these: the arithmetic checks passed, every account has a category, and both recorded decisions match the evidence. Changing a decision back to an unsupported one locks step 3 again.
- **Reviewer notes** (the proposed changes, the new lines that need registry entries, the illustration-only comparison) sit in a separate, clearly marked area above the proposed page. The customer-facing view contains no annotations and no "NEW" markers.
- **Accessibility:** native radio groups with legends; buttons; a locked step 3 that is focusable and announces why (`aria-disabled`, `aria-describedby`); `role="status"` and polite live regions; a skip link; and a visible 3 px focus ring.
- **Static fallback:** without JavaScript all three steps, the 14 mapped accounts, both held accounts with their evidence and the explanation render as plain HTML. The radios are disabled, the equation shows Pending, and nothing is shown as reviewed.

**Test results** (`evidence/results.json`, `evidence/screenshots/`; `run-checks.mjs` exits 1 if any regression scenario fails)
| Check | Result |
|---|---|
| Reflow at 320, 390 and 1280 px | 0 overflow, 0 clipped actions, 0 unlabelled fields; smallest text 12 px |
| Console errors / network requests | 0 / 0 |
| Tab order | skip → nav (2) → hero actions (2) → step tab → panel → Continue → end of document; every stop shows a visible focus indicator (radios included) |
| Arrow key to locked step 3 | focus moves, the panel stays closed, the reason is announced |

**Regression scenarios** (all decisions made by keyboard only: Space and ArrowDown on the radio group, Enter on Record decision)
| # | Scenario | Ready state | Equation |
|---|---|---|---|
| S0 | Both held, nothing decided | not reached; End cannot open step 3 | Pending |
| S1 | One supported decision recorded, one unresolved | not reached | Pending |
| S1b | Both supported treatments selected but **not recorded** | not reached | Pending |
| S2 | Both recorded, both unsupported by the evidence | not reached | Holds (recalculated) |
| S3 | One supported, one unsupported | not reached | Holds |
| S4 | Both supported (after one earlier unsupported decision) | **reached**; step 3 opens; the log shows all three decisions in order | Holds |
| S5 | From S4, a supported decision is changed to an unsupported one | **lost**; step 3 locks again | Holds |
| S6 | Reset | not reached; log cleared | Pending |

**Mutation check** (run once by hand; the mockup was restored afterwards):
- Removing the evidence comparison from the ready rule made S2, S3, S5 and S6 fail.
- Removing the completeness guard from the equation made S0, S1, S1b and S6 fail.

So the scenarios detect both defect classes. **No JavaScript (320 and 1280 px):** 3/3 panels visible, 14 mapped rows and 2 held cards, radios disabled, equation Pending, ready state not shown, reviewer notes outside `<main>`, no layout problems.

## 7. Authenticated screenshots: handoff inconsistencies (for NORMAL; not repaired here)

See `HANDOFF_NORMAL.md`. In short: an account-level suggestion appears in the trial-balance status line; the noun used for the thing being reported on differs between pages; `.xls` is accepted but publicly unmentioned; and the seat wording differs. **The screenshots' build differs from the reviewed baseline, and its exact identity is unverified**: two of their strings do not exist at `00a2653`.

Brand casing ("CFOCLOSE" against "CFOClose") varies. It is recorded only; no brand change is authorised.
