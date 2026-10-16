# Launch-acceptance QA — report (preparation pass)

- **QA branch / head:** `research/launch-qa-20261016` @ `00a2653` base (own worktree; owns only `research/launch-qa/**`).
- **Tested candidate commit:** _none yet_ — **candidate execution PENDING** (requested from NORMAL on PR #138).
- **Environment:** _no live preview available to this lane_ (no non-production preview URL / synthetic-login method yet;
  this host has no running app, no staging keys, and performs no hosted writes or purchases).
- **Date of this pass:** 2026-10-16.

## What executed HERE (browser-free; logic only, not scenarios)
- `research/launch-qa/checks.test.mjs` — **22/22 passed.** Validates the NEW pure checks (`productionTargetProblem`,
  `focusOrderProblems`, `loadingErrorStateProblems`, `copyWordingProblems`, `primaryActionProblems`). These exercise check
  **logic**, not the live app. One real bug in my own check (regex word-boundaries missing raw error codes) was found and
  fixed during this pass.
- `research/launch-qa/harness/launchQaHarness.mjs` — runs; correctly reports all 9 scenarios **PENDING** with no preview,
  and **BLOCKS** (exit 2) a production-ref target. No scenario is reportable as passed without a real candidate run.

## Per-scenario status
All nine scenarios are **PENDING candidate execution** (see `ACCEPTANCE-PLAN.md` for expected result + repro). None can be
truthfully marked PASS or FAIL until run against a live candidate; a prototype/mockup is explicitly not accepted as evidence.

## Findings — distinguished per the charter
- **Reproduced defects:** **NONE.** Nothing has been executed against a candidate, so there are zero reproduced defects.
  (This section will list only defects reproduced on the live candidate with exact repro steps + screenshots.)
- **Untested concerns (hypotheses to verify on the candidate, NOT defects):**
  1. **Keyboard/focus** has **no existing automated coverage** — focus order, visible focus, and focus traps are unverified
     until the harness runs (scenario 8). _Highest-value gap._
  2. **Error-state wording** — whether any surface leaks a raw provider/DB error vs an actionable message (scenario 6/8) is
     unverified live; `loadingErrorStateProblems` is ready to score it.
  3. **Cross-user draft isolation end-to-end** (scenario 3) is covered in units at the gate/contract level but not yet as a
     live two-user flow.
  4. **Premature Phase-6 wording** (scenario 7) — that the review UI never implies statements/filing already work — needs a
     live copy capture; `copyWordingProblems` is ready.
- **Known NORMAL-owned repairs (do NOT file as new defects):**
  1. **Same-name / different-code accounts** — `uq_acct_map_company_norm_name` raises a raw constraint error; the coordinated
     constraint-and-lookup repair is NORMAL-owned (PR #138 handoff). If scenario 7 surfaces it, it is attributed here, not
     filed anew.
  2. Any area NORMAL marks in-repair in response to the PR #138 coordination request will be recorded here as NORMAL-owned.

## Next
Awaiting NORMAL's candidate commit + isolated preview + synthetic-login method. On receipt: wire the driver, run the harness,
replace each PENDING with a real PASS/FAIL + evidence, and publish the updated report on PR #138. NORMAL decides how to
integrate any tests/fixes.
