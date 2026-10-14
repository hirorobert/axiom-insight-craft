# WORKSTREAM B — VISUAL RESULT

**Worktree:** `D:\DevStorage\Temp\claude\cfoclose-visual-20261014` · **branch:** `redesign/presentation-20261014` · **base:** `dfd4098` (current origin/main). **Date:** 14 Oct 2026.
**Scope honoured:** presentation only. No financial logic, API contract, pricing, entitlement, feature gate, or data-lifecycle change. No merge/deploy. Isolated preview on port **8120** against a **dead backend** (`.env.local` → `127.0.0.1:1`); synthetic/illustrative data only.

## 1. Deliverables
- **Mockups (all six screens):** `docs/redesign-preview/mockups/cfoclose-mockups.html` — also published as a viewable Artifact: **https://claude.ai/code/artifact/c7687440-bf9e-4ffa-8f7d-2b59039ee06c**. Theme-aware (light/dark), synthetic entity "Mto Holdings Ltd · FY2026", trust-tier legend, states labelled per frame. Screens 3–6 (first-run+ingestion, TB validation+resolution, mapping/review, statements+sign-off) are the gated/authenticated flows that cannot be screenshotted from the live app; screen 6 is explicitly labelled **FUTURE / PILOT**.
- **Implemented preview (real re-skin of the shipping app):** CFOClose brand tokens + customer-facing fixes, below.
- **Before/after screenshots** (identical fixtures, viewport-accurate via puppeteer + system Chrome): `docs/redesign-preview/screens/` — `before|after-{landing,pricing,auth}-{1440,390}.png`.

## 2. Brand token system (the core change)
`src/index.css` `:root` rethemed from the off-brand **"NAVY TRUST"** palette to **CFOClose** (brand rules), **preserving every token NAME** so all components re-skin without edits:

| Token | Before (navy) | After (CFOClose) | Contrast (measured) |
|---|---|---|---|
| `--foreground` | navy #0f1b3d | slate-900 **#2E2F3A** | 13.3:1 on white |
| `--primary` / `--info` | deep navy | finance green **#247D52** | 5.1:1 on white |
| `--success` | emerald #0d7a5f | finance green **#247D52** | 5.1:1 |
| `--destructive` | institutional red | danger **#B42318** | 6.6:1 |
| `--warning` *(new)* | — (was decorative `--gold`) | ochre **#9A6700** | 4.9:1 |
| `--muted-foreground` | navy-grey | **#5C5E6B** | 6.4:1 |
| `--ring` (focus) | navy | green-700 | visible focus |
| `--radius` | `0rem` | **`0.125rem` (2px)** | brief §4 |
| **`.dark`** | broken (rendered white) | **real slate dark surface**: bg #24252E, card #2E2F3A, text #F5F5F5, accent **mint #7FE0A0** | mint 8.3:1 on slate |

Also: `tailwind.config.ts` registers the new `warning` color and flattens the radius scale to a consistent 2px hairline; `body` gains `font-optical-sizing:auto` (Inter Display behaviour at ≥32px); `tabular-nums` retained. Mint is used **only** on dark surfaces (too faint on white, per brief).

## 3. Shared components re-skinned
- **`CFOCloseWordmark.tsx`** — the hardcoded navy/gold constants (`BRAND_NAVY`/`BRAND_GOLD`) replaced with brand `BRAND_SLATE`/`BRAND_PAPER`/`BRAND_GREEN`/`BRAND_MINT`. On light: slate letters + **green** double rule; on the slate panel: light letters + **mint** rule. The double rule ("balanced and final") is preserved.
- **`LandingHero.tsx` / `LandingFinalCTA.tsx`** — dark panels now **slate** (were navy); eyebrow + CTA now **mint** (were gold), with slate button text.
- **`index.html`** — `theme-color` navy → slate `#2E2F3A`.

## 4. Customer-facing fixes (presentation/correctness, no logic change)
- **Legacy-brand leak removed:** `AccountReviewPanel.tsx` — two user-visible "SAFF …" strings → "CFOClose …" (the multi-line JSX that the existing brand-regression guard failed to catch).
- **Currency mislabel fixed:** `ValidationReport.tsx` hardcoded a `TZS ` prefix on every amount regardless of the workspace's functional currency. Now an optional `currencyCode` prop; absent → amounts render **without** a wrong currency label (no USD/EUR workspace mislabelled as TZS). No figure/calculation changed.
- **Accessibility:** password show/hide toggles in `Auth.tsx` given `aria-label`/`aria-pressed` (fixed a critical `button-name` violation); reduced-opacity muted labels (`text-muted-foreground/55` & `/70`, failing AA at 2.4–3.3:1) brought to full-opacity muted (6.4:1) in customer-facing **Footer, landing sections, ContactChannels**.

## 5. Verification (evidence)
- **Automated accessibility (axe-core 4, WCAG 2.0/2.1 A+AA):** `/`, `/pricing`, `/auth` — **before:** auth 1 critical (`button-name`) + landing/pricing 6 `color-contrast` nodes each; **after:** **0 violations on all three pages.**
- **Reflow / overflow (puppeteer, viewport-accurate):** `document.scrollWidth` equals viewport at **390px and 320px** on all three pages — **no horizontal overflow** (the earlier "pricing clips at 390" was a `--window-size` screenshot artifact, not a real layout bug; confirmed by measurement).
- **Viewports captured:** 1440 (desktop) and 390 (mobile); 320 measured for reflow.
- **Typecheck:** `tsc --noEmit -p tsconfig.app.json` reports no errors in any changed file. Vite dev + HMR compiled every change cleanly.
- **No misleading capability claims introduced** — copy unchanged except the SAFF→CFOClose and currency-label fixes; current approved prices (Solo 490 / Practice 990 / Firm 2,990 / Enterprise contact), "no free / no trial / 12-month term" preserved; the "Financial reporting — pilot, by invitation, not independently validated" hedge kept.

## 6. Remaining backend-dependent gaps (not concealed)
- **Authenticated/workspace screens (first-run, TB validation, mapping, sign-off)** cannot be screenshotted from the live app in isolation — no backend (no Docker; hosted off-limits) and several are server-rollout-gated. They are delivered as **mockups** (§1), not as live before/after. Standing them up needs the isolated stack in `../axiom-redesign-audit/docs/redesign/batch0/ISOLATED-RUNTIME-SETUP.md`.
- **`ValidationReport` currency** now accepts `currencyCode` but the caller (`PrepareWorkspace`) does not yet pass the workspace functional currency — wiring that through is a small follow-up (noted, not silently stubbed).
- **Heaviest off-token color debt** (~900+ named-palette uses) lives in **withheld/unreachable modules** (`maono/*`, `tz/*`, compliance/period panels); out of this bounded batch — tokenising them belongs to a later 1A slice once those modules are in scope.
- **`public/brand/` assets / favicon** are generated from `brand/source/CFOClose_logo.png`; swapping the placeholder set is a separate asset task.

## 7. Files changed (tracked)
`src/index.css`, `tailwind.config.ts`, `src/components/CFOCloseWordmark.tsx`, `src/components/landing/LandingHero.tsx`, `src/components/landing/LandingFinalCTA.tsx`, `src/components/Footer.tsx`, `src/components/contact/ContactChannels.tsx`, `src/components/AccountReviewPanel.tsx`, `src/components/ValidationReport.tsx`, `src/pages/Auth.tsx`, `index.html`. (11 files; brand tokens + 2 copy/correctness fixes + a11y. CRLF→LF normalisation appears in some diffs per `.gitattributes`.)
