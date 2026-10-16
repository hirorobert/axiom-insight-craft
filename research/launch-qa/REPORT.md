# Launch-acceptance QA — report (preparation pass)

- **QA branch / head:** `research/launch-qa-20261016` @ `00a2653` base (own worktree; owns only `research/launch-qa/**`).
- **Tested candidate commit:** _none yet_ — **candidate execution PENDING** (requested from NORMAL on PR #138).
- **Environment:** _no live preview available to this lane_ (no non-production preview URL / synthetic-login method yet;
  this host has no running app, no staging keys, and performs no hosted writes or purchases).
- **Date of this pass:** 2026-10-16.

## Screening aids, not verdicts
The pure checks are **screening aids**: each flagged item is a SIGNAL for manual confirmation in context, never an automatic
customer-facing defect. A displayed number or a word like "exception" is **not** auto-flagged (those generic patterns were
removed); only unambiguous internal leakage (`[object Object]`, `PGRST…`, `SQLSTATE`, `TypeError`, "stack trace") is
screened, and even that is confirmed manually on the candidate before being called a defect.

## What executed HERE (logic + driver wiring; NOT journeys)
- `research/launch-qa/checks.test.mjs` — **22/22 passed.** Validates the NEW pure checks (`productionTargetProblem`,
  `focusOrderProblems`, `loadingErrorStateProblems`, `copyWordingProblems`, `primaryActionProblems`). Check **logic** only.
  Found & fixed one real bug in my own check (regex boundaries missing raw error codes) during this pass.
- `research/launch-qa/harness/cdpDriver.mjs` — **real browser driver WIRED** on the repo's dependency-free CDP tool
  (`scripts/browser-acceptance/cdp.mjs`), **no new dependency, no edit to that shared file**. Provides isolated-identity
  contexts (own cookies/localStorage) — the primitive scenario 3 needs.
- `research/launch-qa/harness/launchQaHarness.mjs` — runs; reports all 9 scenarios **PENDING** with no preview, and
  **BLOCKS** (exit 2) a production-ref target. No scenario is reportable passed without a real candidate run.
- `research/launch-qa/harness/driverSmokeTest.mjs` — a **SYNTHETIC** driver+primitive smoke test (loopback HTTP page; not a
  journey) proving goto/evaluate/setViewport/screenshot + localStorage isolation + the checks scoring a real DOM.

## Environment finding (verified 2026-10-16) — browser not executable on this host
This research host **cannot run headless Chrome automation**: Chrome is installed, but `cdp.mjs` fails at
`Target.setDiscoverTargets` (its `--remote-debugging-pipe` transport does not work under Windows/Git-bash), and a direct
`chrome --headless=new --screenshot` also produces nothing. So the driver + smoke test are delivered **wired and
code-verified, un-run** here; they must run on the **Linux CI/preview runner** the existing browser-acceptance suite already
targets. This is an **environment limitation, not a test pass or fail**. (No `cdp.mjs` edit proposed from this lane.)

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

## Exact remaining dependency (see ENVIRONMENT-REQUIREMENTS.md)
Blocking journey execution: **(a)** candidate commit; **(b)** an **isolated, non-production** preview (own Supabase project,
not the production ref; seeded synthetic-login; sandbox payments; §2 isolation confirmed); **(c)** a **Linux runner** able to
launch headless Chrome for the driver. A preview URL alone is insufficient — the backend-isolation and no-production-reach
checks in §2 are mandatory.

## Done now (independent of the dependency)
Pure checks + tests (22/22), the real driver wired on the existing CDP tool, the synthetic driver+isolation smoke test, the
acceptance plan, and this report. On receipt of (a)+(b)+(c): run the harness with a wired driver, replace each PENDING with a
real PASS/FAIL + screenshots, and update this report on PR #138. NORMAL decides how to integrate any tests/fixes.
