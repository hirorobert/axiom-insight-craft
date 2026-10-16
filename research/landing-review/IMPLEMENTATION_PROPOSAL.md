# Landing-page implementation proposal (bounded)

**Status:** proposal for approval. No production file has been edited.
- **Reference:** the accepted mockup (`mockup/sample-review-mockup.html` at `dbba12f`), with the wording correction recorded at `dec0f7b`.
- **Base:** `origin/main` **`00a2653b5736e89447334e1147aa25f5308b0393`**, unchanged since this review began (re-checked 2026-10-16).
- **Isolation:** a new branch, for example `feat/landing-sample-first`, cut from that base. It is kept separate from frozen candidate **`f57b944`** (PR #139 head, `integration/candidate-20261016`) and its launch QA (PR #144). Nothing from `research/landing-review/**` is copied in.

This file supersedes the scope in `IMPLEMENTATION_FILES.md`.

---

## 1. Scope

### In scope (the five accepted elements)
1. **Sample-first hero, concise copy.**
   - Supporting sentence: "Check your trial balance, review account classifications, and keep a traceable record of your decisions."
   - The primary action becomes **See a sample review** (`#sample`). **View plans** stays secondary (`/plans`), under its existing `SERVICE_ENQUIRY_SURFACES.contactRoute` condition, unchanged.
   - The product screenshot shows at `lg` and up only. Below that, the sample is the product example.
2. **Compact sample summary with expandable details.**
   - It opens with **Balanced · 2 accounts need your review.** and the label **Illustrative example — invented data**.
   - Two native `<details>` disclosures: *Checks* (arithmetic run on import; the statement equation **Pending** until every account has a category, then recalculated and explained) and *All 16 accounts*.
3. **Read-only completed example.** An in-page view (`#completed-example`) showing the two supplied decisions ("Example reviewer (invented)", date, invented basis), the recalculated equation and the remaining limitations. It holds no recording controls and never changes the visitor's state.
4. **Optional guided decisions.**
   - "Try the two decisions" expands in place. Selecting records nothing; only **Record decision** records.
   - The adjacent label reads **Guided example—not automated evidence checking.**
   - Outcomes read "Recorded: <category>." plus the guided-example comparison. The disclosure line stays: "CFOClose records decisions; it does not check them against evidence."
   - The ready state needs both recorded decisions to match the invented evidence.
   - **Wording correction carried forward:** "The credit balance suggests the company owes the director. The supporting terms help determine its classification."
5. **Responsive layout and existing accessibility behaviour.** Use the existing Tailwind tokens, breakpoints and focus styles. Keep: the skip link; native radios with legends; `aria-expanded` on the try toggle; `role="status"` and polite live regions; focus moved to the heading when the completed view opens; keyboard-only operation; and the static (no-JavaScript) readability of every region.

### Preserved unchanged
- **Production navigation:** `Header.tsx` and the `NAV` items Product, Plans, Questions and Expert help; Contact (`headerContactLink`); **Sign in**; the header "View plans"; and the mobile menu with its keyboard tests.
- **Commercial:** pricing (`CapacityPlans`, `planPurchaseView`, `get_public_plan_prices`), entitlements, checkout, plan terms, the pilot label and footer disclosures (`LANDING_PILOT`, `COMMERCIAL_NOTICE`, `LANDING_FOOTER_NOTE`).
- **Claims:** the three trust claims stay verbatim (`TrustStrip`, `publicClaimRegistry`).
- **Other sections:** `SoftwareSection`, `LandingFAQ`, `SpecialistServices`, `LandingFinalCTA` and `Footer` are untouched.

### Deferred (separate, each needs its own approval)
| Item | Why it is separate |
|---|---|
| Trust-strip plain-language lines | New public wording; each needs a claim-registry entry first. |
| Plans-intro sentence "There is no free plan…" | Changes commercial copy. |
| FAQ entry "Can I see how CFOCLOSE works…" | Changes the FAQ JSON-LD in `index.html`. |
| Final-band supporting change | Commercial copy; it also touches a pinned test. |
| Metadata correctness fix S-1 ("activated by our team") | A correctness fix on `index.html` and `publicPages.json`. Recommended as its own small PR, independent of this one. |
| The sample's fingerprint explanation | Explanatory wording around a registered claim. Omitted from the production sample unless it is registered. |

### Not carried over
The research scaffolding, reviewer notes, the plan-table placeholder (the live `CapacityPlans` stays), `window.__sample` test hooks, the inline styles and the mockup's own colour tokens.

---

## 2. Exact production files (at `00a2653`)

### Change
| File | Change |
|---|---|
| `src/content/landing/landingContent.ts` | `LANDING_HERO.supporting` → new sentence; `primaryCta` → `{ label: "See a sample review", href: "#sample" }`; `secondaryCta` → `{ label: "View plans" }` (link stays `/plans` in the component); add `"sample"` and `"completed-example"` to `LANDING_SECTION_IDS`; add `LANDING_SAMPLE_COPY` (headings, lead line, labels, disclosure text, limitations). The module stays data only. |
| `src/components/landing/LandingHero.tsx` | Swap the action roles: primary to `#sample`, secondary "View plans" to `/plans` under the existing `contactRoute` condition. Wrap the screenshot `<figure>` in `hidden lg:block`. Keep the test ids: `hero-explore-plans` is renamed `hero-sample`; `hero-view-plans` is kept. |
| `src/pages/Index.tsx` | Render `<IllustrativeReview />` between `<SoftwareSection />` (line 75) and `<CapacityPlans />` (line 76). No new router route, so `publicPages.json`, `sitemap.xml` and `RouteMeta` are untouched. |

### New
| File | Purpose |
|---|---|
| `src/components/landing/IllustrativeReview.tsx` | The section: the summary, the two disclosures, the optional try region and the read-only completed view, with hash-driven view switching (`#completed-example`) and focus management. It reads no clock, no storage and no network (enforced by the existing landing-source scan). |
| `src/components/landing/illustrativeReviewModel.ts` | A pure, clock-free model: the mapped accounts, the two held accounts with their evidence-supported treatment, `equation()`, `isReady()`, and a reducer for select, record and reset. The completed example's supplied decisions are constants this reducer never writes. |
| `src/components/landing/__tests__/illustrativeReview.test.ts` | Ports S0–S6 (on the reducer) and C1–C3 (on the reducer plus static markup); see §4. |

**Clock:** the mockup timestamps the visitor's decisions, but production must not, because the existing landing test forbids `new Date(` and `Date.now`. The visitor log lists decisions in order, as "Sample reviewer (you)", without times. The completed example's supplied date is a static string.

### Tests that must change (existing)
| File | Change |
|---|---|
| `src/components/landing/__tests__/landingPage.test.ts` | The hero assertion "'Explore plans' first, View plans second" becomes sample first, plans second. The pinned supporting-sentence regex becomes the new sentence. The declared section order adds `sample` after `product`. The in-page anchor check now covers `#sample` and `#completed-example`. |
| `src/content/publicClaimRegistry.test.ts` | Add `IllustrativeReview.tsx` and `illustrativeReviewModel.ts` to `LANDING_FILES`, so the prohibited-wording scans cover the new copy. The approved-claim checks are unchanged. |

### Read-only dependencies (imported, not edited)
| File | Used for |
|---|---|
| `src/components/ui/button.tsx` | Buttons |
| `src/components/CFOCloseWordmark.tsx` | `BRAND_SLATE` and `BRAND_MINT` (hero, as today) |
| `src/lib/serviceEnquiry/serviceEnquiryGate.ts` | The existing `contactRoute` condition on "View plans" |
| `src/index.css`, `tailwind.config.ts` | Existing tokens; no change expected |

---

## 3. Shared-file dependencies and collision check

| Shared file | Other consumers | Risk |
|---|---|---|
| `landingContent.ts` | Every landing section, `faqStructuredData.ts` (FAQ only), `landingPage.test.ts`, `publicClaimRegistry.test.ts` | Additive except the hero fields. The FAQ is untouched, so the JSON-LD in `index.html` is unaffected. |
| `Index.tsx` | Auth redirect, checkout-plan resume, service intent | Only the section list changes. The redirect logic is not touched. |
| `LandingHero.tsx` | `landingPage.test.ts` test ids | Test ids are updated in the same PR. |
| `Header.tsx` and `copy.ts` `NAV` | Every public page | **Not edited.** Optionally a "Sample review" nav item could be added later; not proposed now. |

**Collision check, run 2026-10-16:**
- **Frozen candidate `f57b944`** (126 files vs `00a2653`): **no overlap** with any file above, nor with `Header.tsx`, `Footer.tsx`, `copy.ts`, `index.html`, `src/lib/seo/**`, `index.css` or `tailwind.config.ts`.
- **All 18 open PRs**, including #139, #144, #136 (phase-2 journey) and #142/#141/#143: **no overlap**.
- **Remote branches updated since 2026-10-12:** none touch landing, header, footer, copy, SEO or styles.
- **Local branches updated since 2026-10-12:** none touch them.
- **The uncommitted changes in the main checkout** (`feat/workspace-ux-hardening`): none touch them.

---

## 4. Required checks

### Unit (vitest, node environment, no DOM)
- **Model (S0–S6):** nothing decided, one recorded, selected but not recorded, both unsupported, one unsupported, reverted after ready, and reset all leave `isReady()` false. Only both-supported is true. `equation()` returns null until every account has a category.
- **Isolation (C2/C3):** the completed example's supplied decisions are constants, never written by the reducer. The visitor's state is unchanged by viewing them, and a visitor's decision never appears in the supplied set.
- **Static markup (`renderToStaticMarkup`):**
  - the lead line, the invented-data label, the guided label inside both fieldsets and the corrected director sentence are present;
  - the completed view contains no `input`, `select`, `textarea` or `button`, names "Example reviewer (invented)" and lists the limitations;
  - no outcome or status text contains "validated", "verified", "correct" or "approved".
- **Existing:** `landingPage.test.ts` (updated), `publicClaimRegistry.test.ts` (extended), `noCheckoutClaims.test.ts`, `faqStructuredData.test.ts`, `enterpriseGateOff.test.ts`, `publicMeta.test.ts`, all unchanged and passing.

### Copy
- `node research/landing-review/evidence/copy-rules-check.mjs`, run against the implemented strings (the 36 in `proposed-strings.json`, less the deferred ones).

### Browser, on the built page (fresh evidence; the mockup screenshots do not count)
- Reflow at 320, 390 and 1280 px, including the open try region and the completed view: no overflow, no clipped actions, no unlabelled fields.
- Keyboard: tab order, a visible focus indicator at every stop, the disclosures, the try toggle, recording by keyboard, and focus on the completed heading. S0–S6 and C1–C3 replayed in the browser.
- The no-JavaScript render of the sample and the completed view.
- Customer screenshots at 390 px and desktop.
- **Harness:** `research/landing-review/evidence/run-checks.mjs` adapted to take the preview URL instead of the mockup path, using the existing `scripts/browser-acceptance` driver. The adaptation lives in the research package or in `scripts/browser-acceptance`, decided at implementation time.

### Release gate (`CLAUDE.md` §11) and CI
- `bun install --frozen-lockfile`
- `bunx tsc --noEmit -p tsconfig.app.json`
- `bun run lint`
- `bun run test`
- `bun run build`
- `node scripts/ci/assertPackIsolation.mjs dist`
- `node scripts/ci/assertSingleLockfile.mjs`
- `node scripts/ci/assertPublicMetadata.mjs`
- The PR's CI release gate, through a draft PR, never `workflow_dispatch`.

---

## 5. Out of scope
Pricing, entitlements, checkout, plan terms, the claim registry's approved wording, the pilot status, `Header.tsx` and navigation, the FAQ, metadata, the authenticated journey (NORMAL's), any migration or Edge Function, publication and integration into `f57b944`.

## 6. Approval needed
1. The in-scope list in §1, including the hero screenshot shown at `lg` and up only.
2. The deferred items stay deferred. Separately, decide whether to raise S-1 (metadata) as its own small PR now.
3. Where the browser-harness adaptation lives (§4).
