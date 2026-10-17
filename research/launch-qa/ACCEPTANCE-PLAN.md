# Launch-acceptance QA — plan (bounded, research-only)

Branch `research/launch-qa-20261016` (off `main` @ `00a2653`), own worktree. Owns only `research/launch-qa/**`. **No**
production edits, migrations, registries, workflows, lockfiles, or NORMAL's worktrees; **no** merge/deploy/hosted
writes/real purchases/customer data/paid model calls. Synthetic users/files only; the real authenticated app where available.

**Execution model (implemented).** The nine scenarios are implemented as real functions in `harness/scenarios.mjs` and run
via `harness/launchAcceptance.mjs`, which bootstraps the repository's **disposable local Supabase stack** (the same pattern
as `scripts/e2e/localStackJourney.mjs`) and drives the real app in headless Chrome as synthetic users. It is **machine-
readable** (exit 0 all-passed / 1 any-FAIL / 4 nothing-executed) and **fails closed** (no stack ⇒ all BLOCKED, never PASS).
Pure screening checks (`checks.test.mjs`, 34/34) and exact-money fixtures (`fixtures/syntheticTb.test.mjs`, 4/4) run today.
**This host cannot execute the journeys** (no Docker/`supabase start`, no headless Chrome) — they run on the Linux CI runner;
see `REPORT.md` (run contract + scenario↔existing-coverage map) and `ENVIRONMENT-REQUIREMENTS.md`. Nothing is marked passed
without a real run; existing unit/contract coverage is not journey execution.

**Payment scenarios** use the existing **sandbox / mock-provider** path only (`scripts/e2e/mockPaymentProviders.mjs`,
`paymentJourney.mjs`) — never a real charge.

| # | Scenario | Existing coverage (reference, not duplicated) | New in launch-qa (gap) | Expected result | Status |
|---|---|---|---|---|---|
| 1 | First visit: file → context confirm → processing → truthful result | `firstRunEngagement.classify.test`, `EntityContextSuggestion.test`, `ActiveFileProvenance.test`, `tbIngestion.test` | harness steps 1; wording via `copyWordingProblems` | supported file accepted; context confirmed (not assumed); processing status truthful; result never overclaims | PENDING |
| 2 | Existing entity: correct sourced context; no unintended entity creation | `EntityContextSuggestion.test` (confirmed vs unconfirmed-default), `firstRunEngagement.classify` (23505 duplicate → no retry/no dup) | harness step 2 | the existing entity's context is sourced & labelled; a second entity is NOT silently created | PENDING |
| 3 | Refresh/back/sign-out+in/retry: safe draft recovery, no cross-user leakage, no duplicate submit/consume | `WorkspaceAccessGate.test` (no render without grant; denied for other user/revoked/anon), `DiscardUploadDialog.test` (idempotent begin, retry), entitlement/idempotency contracts | harness step 3 (two synthetic users) | draft recovers for the SAME user; never visible to another; no duplicate submission or double consumption | PENDING |
| 4 | Purchase-required: clear explanation, retained draft, supported return; no entitlement bypass | `entitlementContract.test` (fails closed, no permanent free, GRACE=entitled), `billingProjectionTruth.test`, Ω3 `ACCEPTANCE_MATRIX` | harness step 4 (sandbox/mock only) | a clear reason + retained draft + supported return; entitlement is never bypassed client-side | PENDING |
| 5 | Replacement: explicit choice, preserved history, safe stale-version refusal | `DiscardUploadDialog.test` (replacement_required, stale_version, dependency_conflict distinct; history retained for Undo) | harness step 5 | replacement is an explicit choice; prior history preserved; a stale version is refused, not silently applied | PENDING |
| 6 | Invalid/unsupported/over-limit files: actionable refusal, no false success | `tbIngestion.test`, `layoutProfile.test`, `ingestCharacterization.test`, `layoutNumberFormat.test` | harness step 6; `loadingErrorStateProblems` (no raw errors) | refusal is actionable and specific; never a false "success" | PENDING |
| 7 | Review: distinct identities, uncertainty visible, blockers explained; no premature Phase-6 claims | `buildReviewDecisions.test`, `reviewDecisionState.test`, `accountReviewBrand.test`, `publicClaimRegistry.test` | harness step 7; `copyWordingProblems` (premature-feature claims) | distinct account identities; uncertainty shown; blockers explained; **no claim that Phase-6 statements/filing already work** | PENDING |
| 8 | Keyboard, focus, loading/error states, mobile reflow at 320/390px | `browserAcceptance.test` (layout width @320, header) — **mobile reflow only** | **`focusOrderProblems`, `loadingErrorStateProblems` (NEW — no existing keyboard/focus or error-state coverage)** | full keyboard reachability + visible focus + sensible order; busy indicators; legible/actionable errors; no horizontal overflow @320/390 | PENDING |
| 9 | Customer wording: one clear next action; no codenames or unsupported claims | `publicClaimRegistry.test`, `accountReviewBrand.test`, `omega3BrandRegression.test` | `copyWordingProblems`, `primaryActionProblems` (NEW launch-QA lens over captured live copy) | exactly one dominant next action; no SAFISHA/HESABU/KINGA/MAONO/SAFF; no unsupported certification/compliance claims | PENDING |

## Repro (once a preview exists)
1. NORMAL supplies the candidate commit + a non-production preview URL + a synthetic-login method.
2. Wire a CDP/Playwright driver implementing `driver.scenarios[1..9]` (observe → feed the pure checks).
3. `LAUNCH_QA_BASE_URL=<preview> node research/launch-qa/harness/launchQaHarness.mjs`.
4. Record per-scenario PASS/FAIL + problems + screenshots into `REPORT.md`; a scenario is PASS only on a real run with no
   problems — never from a mockup.

## Owner rulings on the 68f9710 report (2026-10-16)

### Ruling I-1 — peer actions in a deliberate choice
Scenario I keeps the single-primary rule for every state with **one actual next task** (for example the
trial-balance result page: "Resolve account classifications"). The hub's deliberate **"Choose an engagement to
continue"** state (`account-next-action[data-kind="choose_engagement"]`) may present several **peer** Resume actions
instead of one primary. It passes only when every one of these holds (`chooserStateProblems`, `checks.mjs`):

- the task is explicit: the state's heading tells the user to choose;
- there are at least two peers, and each action's accessible name identifies its engagement (company and FY), uniquely;
- nothing is pre-selected: no peer, and nothing else on the screen, is styled as the primary action;
- every peer is visible and reachable in the real Tab sequence;
- activating a peer opens that engagement's workspace directly, with no extra confirmation screen.

This is a contextual clarification, not a waiver: scenario I still fails on any violation above, and on a second
primary in any single-task state.

### Ruling F-1 — a file the server refuses
A file refused as a whole by the server's check (an upload-policy limit such as `TOO_MANY_ACCOUNTS`, or a file that
cannot be read as a trial balance) is shown **Blocked** with its recorded reason and a Replace action. It is never
"being confirmed", and no check is named failed when it did not run. Persisted: the source evidence is kept, the exact
refusal code is recorded, zero accounts are accepted, no certification exists, no attempt is left running, and no
dependency snapshot is taken. The upload stays active, so it can be retried (a new request is refused the same way; the
same request replays), protected from stale replacement (409 `replace_conflict`), and replaced through the page's own
Replace (the refused upload is superseded and kept, and the corrected file is checked). Scenario F asserts all of this
for both an account-limit refusal and an unreadable-file refusal.

### Ruling I-2 — the trial-balance page's action hierarchy (owner, 2026-10-16)
While account review is open, exactly one of the page's two review actions leads. Which one is chosen from the review
panel's own state (`reviewActionHierarchy`, application `ebafa68`):

| Review state | Leading action | Other control |
|---|---|---|
| incomplete (an account still needs a decision) | "Resolve account classifications" (moves focus to the review section) | Save & reprocess secondary, disabled |
| ready (valid, unsaved decisions) | Save & reprocess | Resolve secondary |
| failed (the save was refused; decisions kept) | Save & reprocess, with the reason shown inline (`role=alert`) | Resolve secondary |
| submitting | Save & reprocess, disabled, `aria-busy`, live progress (no duplicate submission) | Resolve secondary |
| nothing to save | the card's own next action; Save is never promoted | — |

A Replace or Retry card action keeps the lead. Scenario I walks a fresh entity through every state in the real browser:
- **incomplete:** an invented account the classifier cannot suggest;
- **ready:** after deciding it;
- **failed:** the save request blocked at the network layer, a test-only fault with no test endpoint;
- **submitting:** with a second activation, which must not submit twice;
- **after save:** nothing left to save.

It checks keyboard focus and the 1280/390 presentation. Passing never depends on counting CSS classes
(`reviewHierarchyProblems`). Each control's *declared* emphasis must match the state, and so must its *computed* visual
emphasis (contrast ≥ 1.5 against what it sits on). Exactly one decision batch must be recorded.

## Provenance (from 2026-10-17; BLACK's finding on run 38946721958)
Every run records, separately, in `identity.json` (`research/launch-qa/ci/recordProvenance.mjs` → `provenance.mjs`):
- the **application** commit and tree (`LAUNCH_QA_CANDIDATE_SHA`);
- the **PR head** (`github.event.pull_request.head.sha`), which carries the harness;
- the **base** (`github.event.pull_request.base.sha`);
- the **actual checkout** (`git rev-parse HEAD`) with its parents, read from the commit object;
- the **harness content** (`HEAD:research/launch-qa` tree).

It verifies the relationship rather than assuming one: on a pull request, the checkout must be exactly the merge of the PR
head into the base (parents `[base, head]`); on a push, it must be the head. The checkout may differ from the application only
in the QA files, with nothing modified before the build. The harness, the gate and every evidence record carry these fields;
`GITHUB_SHA` is never taken to be the PR head.

**Reconciliation of the earlier records.** On run 38946721958, GitHub reports the PR head `f23f347`, and the harness recorded
`5c70e005` as "harnessSha". `5c70e005` is GitHub's `pull/144/merge` checkout: its parents are `00a2653b` (base `main`) and
`f23f3472` (the PR head). The label was wrong; the commit was not stale. The same holds for the 390 px capture record
`I-review-action-area-390.json` on run 39001141635: its "harnessSha" `c02d81bf` has parents `00a2653b` and `05ff40ce` (the PR
head). It therefore describes PR head `05ff40c`, application `ebafa68`. Both parent sets were read from GitHub's commit API.
