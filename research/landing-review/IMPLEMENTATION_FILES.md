# Production files for a later, bounded implementation

**Not started.** This list scopes a future change if the owner approves D-1, D-2, D-4 and D-5 (`REVIEW.md` §5). Paths exist at baseline
`00a2653b5736e89447334e1147aa25f5308b0393` unless marked NEW. Out of scope: the authenticated journey (NORMAL), entitlements, prices,
checkout, migrations and Edge Functions.

## Change
| File | Change | Decision |
|---|---|---|
| `src/content/landing/landingContent.ts` | `LANDING_HERO.secondaryCta` → "See a sample review" (href `#sample`); add `"sample"` to `LANDING_SECTION_IDS`; add `LANDING_ILLUSTRATIVE_REVIEW` copy; a plain line per `LANDING_TRUST` item; the plans-intro addition; `LANDING_FINAL_CTA.supporting`; one `LANDING_FAQ` entry | D-1, D-2 |
| `src/components/landing/LandingHero.tsx` | secondary action to `#sample` (no longer `/plans`); show the screenshot `<figure>` only at `lg` and up | D-2, D-4 |
| `src/pages/Index.tsx` | render the new section between `SoftwareSection` and `CapacityPlans` | D-1 |
| `src/components/landing/TrustStrip.tsx` | render the plain line under each approved claim | D-1 |
| `src/content/publicClaimRegistry.ts` | register the three plain lines (for example `explanatoryWording`) inside each claim's `evidenceScope` | D-1 |
| `src/constants/copy.ts` | `NAV`: optionally add "Illustrative review" → `#sample` | D-1 (optional) |
| `index.html` | meta, `og:` and `twitter:` description (S-1); add the FAQ entry to the `FAQPage` JSON-LD | D-5, D-1 |
| `src/lib/seo/publicPages.json` | description for `/` (S-1) | D-5 |

## New
| File | Purpose |
|---|---|
| `src/components/landing/IllustrativeReview.tsx` (NEW) | The section: static markup first (readable without interaction), enhanced with the tabs, the guided evidence decisions (Record decision) and the recalculated statement equation. Port it from `research/landing-review/mockup/sample-review-mockup.html`, using the existing Tailwind tokens. |
| `src/content/landing/illustrativeReview.ts` (NEW) | The invented accounts, categories, the two held accounts with their invented evidence and evidence-supported treatment, as typed constants. Totals are asserted by a test. |
| `src/components/landing/__tests__/illustrativeReview.test.ts` (NEW) | Port regression scenarios S0–S6 (`REVIEW.md` §6): an unresolved, unrecorded or unsupported treatment never reaches the ready state; the equation is Pending until every account has a category; label, disclosure and outstanding note present; no network or upload. |

## Tests to update
| File | Why |
|---|---|
| `src/components/landing/__tests__/landingPage.test.ts` | the hero assertion "'Explore plans' first, View plans second"; the declared section order (add `sample`) |
| `src/content/landing/__tests__/faqStructuredData.test.ts` | the new FAQ entry must match the JSON-LD |
| `src/content/publicClaimRegistry.test.ts` | the new explanatory wordings |
| `src/lib/commercial/__tests__/noCheckoutClaims.test.ts` | extend the "activated by our team" scan to `index.html` metadata and `publicPages.json` (prevents R-6 recurring) |
| `src/lib/seo/publicMeta.test.ts` | only if it pins the `/` description |
| `scripts/ci/assertPublicMetadata.mjs` | none expected; re-run it |

## Acceptance (reuse this package)
- `node research/landing-review/evidence/copy-rules-check.mjs` passes on the implemented strings.
- The reflow, keyboard and no-JavaScript checks in `evidence/run-checks.mjs`, pointed at the implemented page, produce the same results as the mockup (§6 of `REVIEW.md`).
- The full release gate per `CLAUDE.md` §11.
