# Launch-acceptance QA — plan (bounded, research-only)

Branch `research/launch-qa-20261016` (off `main` @ `00a2653`), own worktree. Owns only `research/launch-qa/**`. **No**
production edits, migrations, registries, workflows, lockfiles, or NORMAL's worktrees; **no** merge/deploy/hosted
writes/real purchases/customer data/paid model calls. Synthetic users/files only; the real authenticated app where available.

**Execution model.** The 9 scenarios are end-to-end UX acceptance — they require a **live candidate + isolated preview from
NORMAL** (requested on PR #138). Until that exists, each is **PENDING**; nothing is marked passed from a mockup or prototype.
The replayable harness is `harness/launchQaHarness.mjs` (`LAUNCH_QA_BASE_URL=<non-production preview>`; refuses the
production ref; needs a wired CDP/Playwright driver). Pure, browser-free checks live in `checks.mjs` and run today
(`checks.test.mjs`, 22/22) — they add the **keyboard/focus + loading/error-state + wording** coverage the existing suites
lack; they validate check *logic*, not scenarios.

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
