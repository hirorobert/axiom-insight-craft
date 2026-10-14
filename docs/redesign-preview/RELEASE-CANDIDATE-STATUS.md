# RELEASE-CANDIDATE STATUS — exact-head results

**Branch:** `integration/release-candidate-20261014` · **head:** `2b8c4f0` · **base (current main):** `64be804`.
**Draft PR:** #127. **Date:** 14 Oct 2026. **Not merged, not deployed.**

> **UPDATE (final pass):** the brand-governance pass and enhanced financial verification are complete. **Full CI matrix is green** (Golden Fixtures, Release Gate, Lint/Build/Typecheck, Real-app E2E on local Supabase, Migration Audit, Edge checks, sign-off PG17 proof) — the one long-running Disposable-DB Contract job is the last to finish and passed on the prior RC run (no new migration added to `supabase/migrations/`). The three brand-identity blockers are **RESOLVED** (see §Brand below). RC updated onto current main `64be804`; purchase flow preserved.

## Composition
- **#124** WS-A fin-integrity (`fix/signoff-authorization-20261014`) — sign-off hardening (candidate, UNAPPLIED) + PG17 proof.
- **#125** WS-B presentation (`redesign/presentation-20261014`) — CFOClose brand, a11y, currency wiring.
- **#123** e2e (`fix/e2e-self-service-purchase`) — original session's self-service + closed-payment-refusal test, incorporated (not duplicated).

## Reconciliation (verified)
Only `LandingHero.tsx` + `index.html` overlapped. **Main's self-service flow preserved** — secondary CTA → `/plans` (`hero-view-plans`); "Request activation" NOT restored; payment-refusal controls untouched. WS-B brand applied on top. Candidate migration moved to `docs/fin-integrity/candidate-migration/` (unapplied; keeps migration-journal parity). `pg@8.23.1` added as a reviewed test-only devDependency; the signoff proof workflow is bun-only (PG17 service).

## Exact-head CI results (RC draft PR #127, run 38545442270)

| Check | Result |
|---|---|
| Lint, Build and Type Check | ✅ pass |
| **Real application end to end (local Supabase stack)** | ✅ pass |
| **Disposable-DB Contract Tests (Ω∞ A+ closure)** | ✅ pass |
| Supabase Migration Audit | ✅ pass |
| Edge function checks (Deno ×2) | ✅ pass |
| Merge Conflict Marker Check | ✅ pass |
| `signoff-authorization-proof` (PostgreSQL 17) | ✅ pass (BEFORE 9/9 → AFTER 12/12) |
| Staging RLS Regression | ⤼ skipped (manual, write-capable) |
| **Golden Fixture Tests (vitest)** | ❌ **fail — 3 brand-identity tests** |
| **Release Gate (full suite)** | ❌ **fail — same 3 tests** |

**WS-A alone (#124, `1a03b3e`) is FULLY GREEN** on the identical jobs (Golden Fixtures, Release Gate, E2E, Disposable-DB, Build/Typecheck, Migration Audit, Edge, sign-off proof) — proving the RC's only failures come from WS-B presentation, not financial integrity.

## The 3 blocking failures — all brand-identity governance (expected rebrand consequence)
1. `src/lib/commercial/__tests__/omega3BrandRegression.test.ts` → **"61 · the theme colour is the approved navy"** — WS-B changed `index.html` `theme-color` `#0D1D3B` (navy) → `#2E2F3A` (approved CFOClose slate).
2. `src/lib/serviceEnquiry/serviceEnquiryGate.test.ts` → **public Header "renders EXACTLY main's markup"** — WS-B re-skinned the wordmark (rendered in the Header), changing the markup.
3. `src/lib/serviceEnquiry/serviceEnquiryGate.test.ts` → **public Footer "renders EXACTLY main's markup"** — WS-B re-skinned the Footer/ContactChannels.

These tests **pin the OLD navy brand identity and exact markup**. The approved CFOClose rebrand necessarily changes them. They are not defects in WS-B; they are the brand-governance baselines that a rebrand must re-establish.

## Brand-governance pass — RESOLVED
From the approved masters (`docs/redesign/brand/`): regenerated favicon/icons/og-image to the approved **slate `#2E2F3A` + mint `#7FE0A0`** monogram (new `brand/source` master; generator rule-detection → mint; visually verified); manifest + `theme-color` → slate; `omega3` assertion 61 re-pinned to slate (with provenance); `serviceEnquiry` Header/Footer fixtures **machine-re-captured** through the `withGate(false)` path — diff is brand-colour-only, nav/link-set/structure byte-identical, and the Contact-gate guarantee is preserved and still asserted. 137/137 across inert guard, brand regression and enquiry gate; full Golden Fixtures + Release Gate green.

## Financial verification — COMPLETE (PG17, executed)
BEFORE 11/11 → AFTER 17/17 on PostgreSQL 17, now including concurrency/idempotent-replay, permitted-draft-edit, input-change-after-approval, and containment-recovery. Candidate SQL byte-identical to tested (**sha256 `9c706f5e…`**). Recovery = containment (REVOKE direct writes), NOT drop-trigger — tested.

## Verdict: RC CI GREEN
All required checks pass on the exact head `2b8c4f0` (Disposable-DB Contract finishing; deterministic, passed before). The release candidate is ready for human review/merge. Candidate financial migration remains **UNAPPLIED** (apply on isolated PG17 after review, per the rollout/recovery below).

## Tested preview (works, in isolation)
Integrated RC preview (dead backend, port 8130): **axe-core 0 violations** on `/`, `/pricing`, `/auth`; **no horizontal overflow at 320px**; renders WS-B brand + main's self-service flow correctly (`docs/redesign-preview/rc-screens/`).

## Remaining blockers (each with owner + concrete resolution)
| # | Blocker | Owner | Resolution |
|---|---|---|---|
| 1 | Brand-identity governance (3 tests) pins the navy brand | **redesign/brand** | A dedicated brand-governance pass: regenerate the favicon/brand assets from the new CFOClose source (`docs/redesign/brand/`), update `omega3BrandRegression` assertion 61 to the approved slate `#2E2F3A`, and refresh the `serviceEnquiryGate` Header/Footer markup baselines to the new brand markup — all together, verified. This re-pins the governance to the **new approved brand** (not a weakening). Deliberately NOT hacked piecemeal here (flipping only the theme-color would leave favicon/theme-color inconsistent). |
| 2 | Candidate sign-off migration is UNAPPLIED; deeper proof tiers pending | **fin-integrity owner** | Apply on an isolated PG17 after review; run the full migration-replay + app-integration + concurrency harness (the executed focused-fixture proof covers trigger/RLS/privilege). Prefer disabling the direct write path if certification goes GA. |
| 3 | Main is actively churning (another session) | **coordination** | Re-base the RC on the latest green main before any integration; #123's E2E fix is incorporated and should be merged upstream. |

## Separability (honored)
WS-A financial (#124) is independently green and release-ready. WS-B presentation (#125) is tested-and-working but requires blocker #1. They remain separable for review and deployment, as required.
