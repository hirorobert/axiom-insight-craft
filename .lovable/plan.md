# Post-certification microcopy cleanup (presentation only)

Two terminology/affordance refinements. No structural, logic, data, or route changes. The certified North Star layout is untouched.

## 1. Prepare pre-flight wording

`src/components/workspace/TrialBalancePreflight.tsx` is the only surface that renders the pre-flight verdict labels.

- Section heading: "Pre-flight certification" -> "Pre-flight status"
- Verdict labels (display strings only, keyed by the unchanged backend verdict values):
  - `certified` -> "Certified" becomes "Checks passed"
  - `review` -> "Needs review" stays "Needs review"
  - `blocked` -> "Not certified" becomes "Checks failed"
  - `pending` -> "Checking" stays "Checking"

The `data-verdict` attribute, `computePreflight()`, check states, counts, headline, blocker text and the "Resolve in this trial balance" link all stay exactly as they are.

Second surface with the same wording problem, same file-local fix in `src/components/certification/CertificationHeader.tsx`:

- Console eyebrow: "Certification Console" -> "Trial balance status"
- Status chip/`Status` value for a valid run: "Certified" -> "Checks passed"

Tone classes, `toneFor()` branching, and the `blocked`/`review`/`processing` labels are unchanged, so colours and status logic are identical.

Not touched anywhere: backend verdict values, pre-flight logic, `computePreflight`, gate conditions, database, Edge Functions, routing, statement/tax/compliance semantics, and the internal `isCertifiedRun()` discard gate (function name and behaviour stay; it is not user-facing copy).

## 2. Workpaper explanation of the two machine states

One small help affordance in `src/components/AccountReviewPanel.tsx`, attached to the existing "SAFF assessment" column header (and its mobile-record equivalent label), not to individual rows.

- An icon-only button (`Info`, 3.5 units, muted) with `aria-label="What these assessments mean"`.
- Opens the existing `Popover` primitive containing two short definitions:
  - "No reliable suggestion — SAFF did not find classification evidence strong enough to defend."
  - "Conflicting evidence — review required — SAFF found competing signals and will not choose between them."
- Accessibility: Popover opens on click and on Enter/Space when focused (Radix handles focus trap and Escape), so keyboard and touch both work; a `title` attribute gives the hover affordance on pointer devices.

No new card, no per-row paragraph, no banner, no modal, no new status colour, no change to `assessment()`, to the row layout, to the save payload, or to the outcome states.

## Verification to run afterwards

`git diff --check`, `npm run build`, `bunx vitest run`, conflict-marker scan, plus a live check of the Prepare surface at 390 and 1440 to confirm the popover opens and the layout is byte-identical in structure.

## Technical notes

- Files changed: `TrialBalancePreflight.tsx`, `CertificationHeader.tsx`, `AccountReviewPanel.tsx`. Nothing else.
- `TooltipProvider` is already mounted in `App.tsx`; `Popover` is already available in `src/components/ui/popover.tsx` — no new dependency.
- Existing test selectors (`tb-preflight`, `certification-ledger`, `account-review-workbench`, `data-verdict`, `data-active-upload-id`) are all preserved.
