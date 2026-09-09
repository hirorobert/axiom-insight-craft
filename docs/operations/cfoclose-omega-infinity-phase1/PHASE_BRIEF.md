# CFOClose Ω∞ Execution Charter — Phase 1 Brief

## Objective

Finish the public CFOClose identity and pricing presentation already started
in PR #12 without activating checkout, per the CFOClose Ω∞ Execution
Charter, Phase 1.

## Scope

**In scope (Phase 1, this changeset only):**

- Header, Footer, and the Auth (`/auth`) public page — the third public
  surface sharing the exact same unresolved defect class as Header/Footer
  (see Design Decision D1).
- `index.html` document metadata (title, description, author, keywords,
  canonical/OG/Twitter tags — text content only, not the canonical/OG URL
  itself; see Design Decision D5).
- `src/components/ProductTour.tsx` public-tour stage order.
- `src/pages/Settings.tsx` — Plan & Billing section: plan-code display,
  entitlement-code display, `effectiveEnd` label.
- `src/lib/commercial/__tests__/omega3BrandRegression.test.ts` — replacing
  duplicated in-test logic with assertions against the real source.
- One new, original, text-only wordmark component
  (`src/components/CFOCloseWordmark.tsx`) used only on the three public
  surfaces above.

**Explicitly out of scope (deferred to later charter phases):**

- Any authenticated workspace page (`Dashboard.tsx`, `WorkspaceLayout.tsx`,
  and all seven stage workspaces) — Phase 4.
- `SaffLogo.tsx` itself and its locked SVG assets in `src/assets/brand/` —
  left untouched; still consumed by `Dashboard.tsx` and
  `WorkspaceLayout.tsx`, which are out of Phase 1 scope. A real, original
  CFOClose visual mark (icon + full design system) is Phase 3's explicit
  deliverable, not Phase 1's.
- Favicon (`public/favicon.ico`) — a binary asset change requiring design
  authority; flagged as an unresolved finding, not fixed here.
- Any DNS/custom-domain change to the canonical/OG URL — a hosting/product
  decision (Phase 2 territory), not a code text-content change.
- Migrations, Supabase configuration, Edge Functions, checkout, payment
  providers, entitlement authority (server-side), Lovable publication.

## Assumptions

- The approved base for this changeset is commit
  `990f52ab00998b24459cc743cb8f1a5d6127ab79` on
  `ci/cfoclose-global-brand-pricing` (PR #12).
- The authoritative set of currently-issued plan codes is exactly `"FREE"`
  and `"PAID"` (per `commercial_plans.code` in migration
  `20260905093408_...`, Ω1 commercial foundation, already live). Any other
  string is, by definition, unknown and must fail closed.
- No `REVIEW_REQUIRED` (or equivalent) value exists anywhere in the
  authoritative `LicenceStatus` type (`src/lib/commercial/entitlementContract.ts`)
  today. Charter item 8 is therefore a preventive rule with nothing
  currently to correct — verified by direct repository search, not assumed.
- Paid checkout was already fully disabled by PR #12 (`Pricing.tsx` renders
  a locked message and a `Link to="/auth"`, invoking no payment function).
  This audit re-confirms that fact rather than re-implementing it.

## Approved base SHA

`990f52ab00998b24459cc743cb8f1a5d6127ab79`
