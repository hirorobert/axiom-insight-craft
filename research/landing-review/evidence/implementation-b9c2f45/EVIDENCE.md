# Implementation evidence: PR #145 at `b9c2f45`

- **Source tested:** `b9c2f4530e909c67049659d2efe61744a45963a6` (`feat/landing-sample-first`, draft PR #145), with a clean tree for `src`, `index.html`, `public` and `scripts/browser-acceptance`.
- **Base:** `main` `00a2653`.
- **Separation:** this PR is separate from frozen candidate #139 (`f57b944`) and QA #144.

## Command (replayable)
From the repository root, at that commit:
```bash
node scripts/browser-acceptance/landingSample.mjs <outDir>
```
- The script lives in the product branch at `scripts/browser-acceptance/landingSample.mjs` and uses the repository's own driver (`cdp.mjs`, `checks.mjs`).
- It builds the app with a **placeholder backend** (`VITE_SUPABASE_URL=http://127.0.0.1:59999`, unreachable), serves the build with `vite preview` on `127.0.0.1:4318`, and drives headless Chrome.
- It exits 1 on any failed check.

## Environment
Node v24.15.0 · Windows 10.0.26200 · Chrome/155.0.8059.39 · placeholder backend (no data read or written; the plan rows show the no-server fallback).

## Result: 60 / 60 checks pass (`results.json`)
| Group | Pass |
|---|---|
| Layout at 320, 390 and 1280 px: hero (sample first, no screenshot), navigation incl. Sign in, no overflow, clipped or unlabelled controls (on load, disclosures open, try region open, completed view), text ≥ 12 px, no console errors | 27 / 27 |
| Keyboard: a visible focus indicator at every stop; tab order; Enter opens a disclosure; try toggle `aria-expanded`/`aria-controls`, with focus moved to the region heading; radio focus | 5 / 5 |
| Announcements: polite live regions plus `role="status"`; the status and outcome change on record | 2 / 2 |
| Labels: "Guided example—not automated evidence checking." inside both sets of choices | 1 / 1 |
| Scenarios S0–S6, keyboard only (only S4, both supported, shows the ready state; reset clears everything) | 9 / 9 |
| Completed example: read-only, supplied decisions with the invented reviewer and time, 4 limitations, records nothing for the visitor, never shows a visitor decision | 7 / 7 |
| Navigation (below) | 9 / 9 |

**Tab order (1280 px):** Skip to main content → CFOCLOSE → Product → Plans → Questions → Expert help → Contact → Sign in → View plans → See a sample review → View plans → View completed example → Try the two decisions → Checks → All 16 accounts → plans.

## Navigation
| Check | Result |
|---|---|
| N1 direct `/#sample` | The sample shows and is in view; the completed example is hidden |
| N2 direct `/#completed-example` | The completed example shows and is in view, with focus on its heading; the sample is hidden |
| N3 View completed → Back → Forward → "Back to the sample" → Back | completed (`#completed-example`) → sample (no hash) → completed → sample (`#sample`) → completed. Exactly one view at every step |
| N4 unsupported `#does-not-exist`, `#completed-examplex`, `#try-region`, `#completed-title` | The sample shows with its status line and the page H1; never blank, never the completed view |
| N5 from the completed example to `#plans` | Returns to the sample view and lands on the plans |

N1, N2 and N5 failed on the first run of this script, at `e579e39`. They were fixed in `29e94ea`, which `b9c2f45` contains; the run at `29e94ea` also passed 60/60:
- a direct fragment now scrolls and focuses after the view renders;
- a fragment is scrolled to again after a view switch changes the height above it.

## No JavaScript (recorded, not a fallback)
`#root` is empty, with 0 visible body characters and no `<noscript>`. The landing page is a client-rendered React app and renders nothing without JavaScript. The research mockup's static fallback does **not** carry over. Search engines receive the head metadata and the static JSON-LD in `index.html`. Screenshot: `screenshots/390-nojs.png`.

## Screenshots (`screenshots/`)
- **At each of 320, 390 and 1280 px:** `hero`, `sample`, `details` (disclosures open), `try`, `completed`.
- **At 1280 px only:** `ready` (S4) and `direct-completed` (N2).
- **At 390 px only:** `nojs`.

## Limitations
- **Placeholder backend.** Live plan prices and checkout are not exercised. The hosted staging browser acceptance has not run; it is CI-only.
- **No JavaScript:** as above.
- **CI wiring.** The script is not yet wired into CI; it is run by hand, as above.

## CI at the exact head (run 38932457202, `b9c2f45`), compared with main's own run (38847906557, `00a2653`)
| Job | Result | Classification |
|---|---|---|
| Lint, Build and Type Check | success | |
| Supabase Migration Audit | success | |
| Merge Conflict Marker Check | success | |
| Edge function checks (process-trial-balance) | success | |
| Edge function checks (reconciliation) | success | |
| Release Gate (clean Linux, frozen lockfile, full suite) | **failure** | **Baseline.** The same 3 tests fail on main: `persistenceMigrationContract`, `activationReadinessMigration`, `serviceEnquiryMigrationContract` (migration ordering). Totals 3 failed / 5,572 passed. |
| Golden Fixture Tests (vitest) | **failure** | **Baseline.** The same 3 tests, as above. |
| Disposable-DB Contract Tests | **failure** | **Baseline.** The same 7 late-payment / recovery-case tests fail on main. |
| Real application end to end (local Supabase stack) | **failure** | **Baseline.** The app journey passes 23/23; the same 5 payment-journey checks fail on main. The job also logs Docker Hub `toomanyrequests` rate limits (environment noise), as on main. |
| Staging RLS Regression (manual) | skipped | |

**Branch regression found and fixed:**
- At `29e94ea`, Release Gate and Golden Fixture Tests failed `databaseInert.test.ts`, because the new `scripts/browser-acceptance/landingSample.mjs` was not in the reviewed automation-surface allowlist.
- `b9c2f45` registers it, with its justification. The inert step passes, and the full suite then shows only main's baseline failures.

**The release gate is not green:** 4 required jobs fail. Every failure is identical to main's baseline; none is introduced by this branch.
