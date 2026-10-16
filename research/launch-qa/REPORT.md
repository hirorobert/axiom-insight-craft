# Launch-acceptance QA — report

- **QA branch / head:** `research/launch-qa-20261016` (own worktree; owns only `research/launch-qa/**`).
- **Tested candidate commit:** _none executed_ — see Blockers. The runner records `LAUNCH_QA_CANDIDATE_SHA` into every report.
- **Environment:** no local Supabase stack and **no headless-Chrome capability on this host** (verified) — so BLACK has
  **implemented** the nine journeys but **executed none** of them here. They run on the Linux CI runner (`supabase start`).
- **Date:** 2026-10-16.

## Status legend
PASS (executed assertions, no mismatch) · FAIL (observed mismatch) · BLOCKED (named missing prerequisite) · NOT RUN · N/A.
Existing unit/contract coverage does **not** substitute for a journey run. Regex/DOM checks are **screening aids** confirmed
in context, never automatic verdicts.

## What BLACK built (and what executed here)
- **Nine real scenario functions** — `harness/scenarios.mjs`, grounded in the repository's actual selectors/conventions
  (from `scripts/e2e/localStackJourney.mjs`, read-only): sign-in `#email`/`#password`; first-run `#fr-*`; launchpad/
  data-choice testids; uploader `trial-balance-file-input`/`trial-balance-upload-primary`; review `account-review-workbench`;
  server-truth via the service-role client. **Not placeholders**; **runtime-unverified** until the runner executes them.
- **Executable runner** — `harness/launchAcceptance.mjs`: bootstraps the disposable local Supabase stack
  (`supabase status` → build the app pointed ONLY at local, `assertLocalStack` + `verifyLocalBundle` isolation guards →
  loopback preview → real Chrome), seeds synthetic users, runs the nine, writes machine-readable
  `acceptance-evidence/launch-acceptance.json` + screenshots. **Fails closed**: no stack ⇒ all BLOCKED, overall NOT PASS,
  exit 4 (verified here).
- **Pure screening checks** — `checks.test.mjs` **34/34** (keyboard/focus, loading/error legibility, wording, single-CTA,
  320/390 responsive, aria-association, processing announcement, clarity-state). Logic only.
- **Invented exact-money fixtures** — `fixtures/syntheticTb.test.mjs` **4/4** (balanced 101,500,000=101,500,000; a genuine
  −30,000,000 imbalance kept visible; same-name/different-code codes preserved distinct).
- **Synthetic driver smoke test** — `harness/driverSmokeTest.mjs` (loopback page); could not run on this host (no headless
  Chrome). Environment limitation, not a pass/fail.

## Scenario ↔ existing coverage map, and BLACK status
The repository's **`scripts/e2e/localStackJourney.mjs` already exercises most of these on the local stack in CI** (NORMAL-owned).
BLACK adds the independent acceptance lens and the gaps. BLACK executed none here (no stack/Chrome).

| # | BLACK scenario | Existing real-journey coverage (NORMAL) | BLACK adds | BLACK status (this host) |
|---|---|---|---|---|
| A | First upload → context → truthful result | first-run + upload + check + review | truthful-result + persisted-binding assertions, wording | NOT RUN (runner BLOCKED: no stack) |
| B | Existing entity, correct attachment | periods/intake + upload | "no unintended entity / no cross-period" via server truth | NOT RUN |
| C | Recovery + identity isolation | isolation (2nd account sees nothing) | refresh/back/retry recovery + API-read leakage | NOT RUN |
| D | Purchase-required, no bypass | — (paymentJourney covers checkout) | gated-copy + draft-kept + no-entitlement-change | **BLOCKED**: needs NORMAL's mock-purchase hook in `env.mockPurchase` |
| E | Replacement, stale refused | stale (changed layout → out of date) | explicit-decision + history-preserved + stale-intact | **BLOCKED**: confirm the real replacement control with NORMAL |
| F | Invalid/unsupported/over-limit | — | unsupported-refusal + recovery; **over-limit needs NORMAL's final policy/fixture** | NOT RUN (unsupported) / **BLOCKED** (over-limit) |
| G | Same-name/different-code identities | — | distinct-identity assertion | **BLOCKED**: gated on NORMAL's `uq_acct_map_company_norm_name` repair |
| H | Accessibility + responsive 320/390 | widths 1280/375 | 320/390 + keyboard/focus/aria/announcement; axe optional | NOT RUN |
| I | Professional clarity across states | next-action | what-happened/next/saved + one-primary + wording | NOT RUN |

## Findings
- **Reproduced defects: NONE** — no journey executed against a candidate. (Do not infer production impact from this; equally,
  no-production-impact is not claimed merely because hosted access is unavailable.)
- **Screening-aid signals** are not defects until confirmed on the candidate.

## Blockers (precise)
1. **No execution environment on this host** — needs the **Linux CI runner** (`supabase start` + Docker + Chrome). This host
   has neither Docker nor working headless Chrome (verified).
2. **Candidate SHA** — set `LAUNCH_QA_CANDIDATE_SHA`; do not let a moving branch name substitute for a tested commit.
3. **NORMAL-owned hooks** for D (mock-purchase), E (replacement control), F (final over-limit policy/fixture), G (same-name
   repair). Each dependent scenario returns BLOCKED with this exact reason until provided.

## Run contract (machine-readable)
- **Command:** `node research/launch-qa/harness/launchAcceptance.mjs [outDir]` (after `supabase start`).
- **Env var NAMES:** `CHROME_PATH` (optional), `LAUNCH_QA_CANDIDATE_SHA` (recorded). Supabase keys are read via
  `supabase status -o json` — never passed in a file; **service-role stays server-side, never in browser code/logs/report**.
- **Prerequisites:** local Supabase stack running; Chrome/Chromium; `@supabase/supabase-js` + `vite` installed (devDeps).
- **Exit codes:** `0` = all executed scenarios passed; `1` = ≥1 FAIL; `4` = nothing executed (all BLOCKED) — never a PASS.
  (`2`/`3` are reserved for the synthetic smoke/driver.)
- **Artifacts:** `research/launch-qa/acceptance-evidence/launch-acceptance.json` + `*.png` screenshots.
- **Smallest CI integration (NORMAL-owned; BLACK does not edit workflows):** add one step after the existing `supabase start`
  that runs the command above; **or** import `{ SCENARIOS }` from `harness/scenarios.mjs` into `localStackJourney.mjs` and
  call them with its already-built helpers (it has sign-in/upload/widths/admin). Known failures stay visible and attributed;
  never silently skipped.

## Next
On a Linux runner with the candidate: run the command, attach `launch-acceptance.json` + screenshots, replace NOT RUN with
PASS/FAIL, and send NORMAL one consolidated findings comment. Retest repaired failures against NORMAL's new candidate without
rerunning unrelated scenarios.
