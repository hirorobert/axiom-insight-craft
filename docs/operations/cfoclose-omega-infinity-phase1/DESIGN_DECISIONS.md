# CFOClose Ω∞ Execution Charter — Phase 1 Design Decisions

Consolidated per the charter's evidence-pack allowance: "Documents may be
consolidated where a phase genuinely has no data or threat-model changes,
but the headings and explicit `Not applicable — reason` entries must
remain." This document therefore also carries the `DATA_CONTRACTS`,
`THREAT_AND_FAILURE_MODEL`, and `ACCEPTANCE_MATRIX` headings.

## Repository audit findings (before any edit)

| # | Charter item | Finding |
|---|---|---|
| 1 | Remove visible SAFF ERP wordmarks from Header and Footer | `Header.tsx` and `Footer.tsx` both still render `<SaffLogo variant="header" />`. `SaffLogo.tsx` routes to locked SVG files (`src/assets/brand/saff-lockup-compact.svg`, `saff-lockup-full.svg`) whose root `<svg>` element carries `role="img" aria-label="SAFF ERP"` and whose vector paths spell the "SAFF" wordmark directly — a real, unaddressed visible-and-accessible-name defect, not merely a stale comment. |
| 2 | Replace SAFF ERP metadata | `index.html` was not touched by PR #12 at all: `<title>`, `<meta name="description">`, `<meta name="author">`, `<meta name="keywords">`, `og:title`, `og:description`, `twitter:title`, `twitter:description` all still read "SAFF ERP". |
| 3 | Original CFOClose identity, no copied visual system | No copied AAA/other-association visual system was found anywhere in the diff or current source. The correction for item 1 must itself stay original — see D1. |
| 4 | Public tour order Upload → Review → Reconcile → Report → File | `ProductTour.tsx`'s `STAGES` array is ordered Upload → Review → **Report** → **Reconcile** → File — Report and Reconcile are transposed relative to the charter. |
| 5 | Unknown plan codes fail closed as "Plan unavailable" | `Settings.tsx`'s `displayPlanName()` maps *any* non-null, non-`"FREE"` code — including a genuinely unrecognized one — to `PRICING.PAID_NAME`. An unexpected server value would be misrepresented as an active paid plan instead of failing closed. |
| 6 | Never expose unknown raw entitlement codes | `Settings.tsx`'s entitlement list renders `isFeatureCode(code) ? FEATURE_DESCRIPTIONS[code] : code` — the `: code` branch prints the raw server code verbatim for anything outside the known `FEATURE_CODES` registry. |
| 7 | Label `effectiveEnd` "Effective through", not "Renews" | `Settings.tsx` renders `Renews {date}` literally. |
| 8 | Represent review-required status only from an authoritative contract | Verified by direct search: no `REVIEW_REQUIRED` (or similar) value exists in `LicenceStatus` (`entitlementContract.ts`) or anywhere in `Settings.tsx`/`useBillingSummary.ts`. **Not applicable — nothing fabricates this state today; there is nothing to correct.** Recorded here so a future addition of such a status is held to this same rule. |
| 9 | Keep paid checkout disabled | Confirmed: `Pricing.tsx` renders a locked panel (`PRICING.CHECKOUT_DISABLED_MSG`) and a `Link to="/auth"`; no payment function, checkout-creation call, or amount/interval is sent anywhere. No code path invokes checkout. No change required; re-verified, not re-implemented. |
| 10 | Tests must read real components/metadata | `omega3BrandRegression.test.ts` tests 21/22/23/24 assert against a **second, duplicated copy** of `displayPlanName` hand-written inside the test file (lines 134–137) — not the real `Settings.tsx` function — so the real function's fail-open bug (item 5) was invisible to this suite. Tests 28/29 assert only against `PRICING_SECTION.ctaHref`, never reading `Settings.tsx` or `Pricing.tsx` source at all. No test reads `index.html`, `Header.tsx`, `Footer.tsx`, `SaffLogo.tsx`, `Auth.tsx`, or `ProductTour.tsx`. |

**Additional finding, same defect class as item 1, on a public surface not literally named "Header/Footer" but touched by the same PR and sharing the identical bug:**

- `src/pages/Auth.tsx` (the public `/auth` page): the subtitle string for the login view reads `"Sign in to your SAFF ERP account"` (visible, public, customer-facing text). It also renders `<SaffLogo variant="full" />` with no `aria-label`/`decorative` override — the same locked SAFF wordmark and the same `alt="SAFF ERP"` accessible name as Header/Footer. Included in this changeset under Design Decision D1's scope (see `PHASE_BRIEF.md` for the explicit scope statement) because it is the same unresolved defect on a page PR #12 already modified, not a new surface.

## Design decisions

**D1 — Logo replacement: new text-only wordmark, not a new icon mark.**
Alternatives considered: (a) edit the locked SVG files to swap "SAFF" glyphs for "CFOClose" glyphs; (b) commission/fabricate a new icon+wordmark graphic now; (c) render `BRAND.name` as plain text using the site's existing typography.
Rejected (a): the SVGs are explicitly documented "v3 LOCKED... do not substitute", and editing frozen brand-asset bytes as a side effect of a metadata-and-copy phase is exactly the scope-mixing the charter's change-control rules exist to prevent.
Rejected (b): originating a new visual icon mark is Phase 3's explicit deliverable ("Contracts and Original CFOClose Design System" → `CFOCLOSE_DESIGN_SYSTEM.md`, `CFOCLOSE_TOKENS.css`). Fabricating one now, without that design pass, risks producing something Phase 3 then has to throw away, and exceeds a brand/metadata phase's authority.
Chosen (c): a small new component, `CFOCloseWordmark`, renders `BRAND.name` ("CFOClose") as styled text (existing `font-bold`, `text-foreground` tokens already used throughout the site). It is not copied from, does not resemble, and does not imply affiliation with any other organization's visual system (charter item 3) — it is literally the approved brand name in the site's own type. It replaces `SaffLogo` only in `Header.tsx`, `Footer.tsx`, and `Auth.tsx`. `SaffLogo.tsx` and its assets are left completely untouched for the two authenticated-workspace call sites that remain out of Phase 1 scope.

**D2 — Plan-code fail-closed mapping.**
The authoritative plan-code vocabulary today is exactly `"FREE"` and `"PAID"` (traced to `commercial_plans.code` in the live Ω1 migration). `displayPlanName` is corrected to an explicit three-way match — `"FREE"` → `PRICING.FREE_NAME`, `"PAID"` → `PRICING.PAID_NAME`, anything else (including future/corrupted codes) → the literal string `"Plan unavailable"` the charter specifies. `null` (no billing customer) continues to mean Free, unchanged — that is an existing, correct, distinct case (no billing customer at all is not the same as an unrecognized code from one that exists).

**D3 — Entitlement-code fallback.**
Unknown codes are replaced with a generic, non-identifying customer-facing string ("Additional capability included with your plan") rather than any form of the raw code, satisfying "never expose unknown raw entitlement codes" without inventing a description for a capability this registry doesn't know about.

**D4 — `effectiveEnd` label.**
Changed the literal string from `Renews` to `Effective through`, no other change to the surrounding date-formatting logic — the charter specifies the label text only, not a change to what date is shown or how licence periods are computed.

**D5 — Metadata content vs. metadata URLs.**
Charter item 2 lists title, description, author, keywords, OG, and Twitter *text* fields. It does not list the canonical/`og:url` values. The current canonical URL (`https://axiom-insight-craft.lovable.app/`) reflects where the site is actually hosted today; changing it to `https://cfoclose.com/` would assert a domain that may not yet be configured (Phase 2's explicit job is verifying "custom domain state"). Only the human-readable text fields are corrected; the URL fields are left as accurate for the current hosting state.

**D6 — Public-tour stage reorder.**
The `STAGES` array order in `ProductTour.tsx` is corrected to Upload → Review → Reconcile → Report → File by swapping the Reconcile and Report entries (and their `label`/ordinal-prefix strings, e.g. `"03 · Reconcile"` / `"04 · Report"`). No stage content, detail copy, or mock data changes — only order and the ordinal number embedded in each stage's own label string.

**D7 — Dead, inconsistent `PIPELINE` constant.**
`copy.ts`'s exported `PIPELINE` array (`["Upload","Review","Reconcile","Report","File & Monitor"]`) is not imported or rendered anywhere in the app — confirmed by repository-wide search. It already has the charter-correct *order* but a different final label ("File & Monitor" vs. the tour's own "File"). Corrected to `"File"` for internal consistency with the actual rendered tour, since it is explicitly documented as "5 steps for public tour" and leaving two contradictory public-tour vocabularies in source is a latent-drift risk even though nothing currently renders this one.

## Data contracts — not applicable

Phase 1 introduces no new displayed or mutated value and no new authoritative
source. The one behavior change (D2) narrows what `displayPlanName` may
output for values *outside* the already-authoritative `planCode` contract;
it does not change what `useBillingSummary`/`get_my_billing_summary` return
or mean.

## Threat and failure model

- **Failure mode addressed (D2):** an unrecognized `planCode` (a future plan
  code shipped before the UI is updated, a data-integrity bug, or a
  compromised/malformed RPC response) previously rendered as "CFOClose
  Professional" — a false claim of active paid entitlement to the viewing
  user. Corrected to fail closed as "Plan unavailable", matching the
  repository's established UNKNOWN-≠-ENTITLED discipline
  (`entitlementContract.ts`'s own header docstring).
- **Failure mode addressed (D3):** an unrecognized entitlement code
  previously leaked the server's internal code string verbatim to the
  customer UI. Corrected to a generic, non-identifying label.
- **No new attack surface.** No new mutation path, no new server call, no
  new client-supplied value reaching any privileged decision. This phase is
  presentation-only, exactly as scoped.

## Acceptance matrix — not applicable (full matrix)

No authenticated workspace page changes in this phase, so a full
desktop/tablet/mobile/keyboard/state matrix (Phase 4's concern) is not
applicable here. The narrower acceptance check performed for this phase's
actual surfaces (Header/Footer/Auth wordmark, Pricing checkout-disabled
confirmation, Settings Plan & Billing states) is recorded in
`IMPLEMENTATION_REPORT.md` after implementation, together with the gate
results (lint, build, typecheck, focused/commercial/full test runs).
