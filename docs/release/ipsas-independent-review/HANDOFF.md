# IPSAS repair candidate (#229) - verified state and independent-review handoff

Written 2026-10-30 by the author side (not an independent reviewer). Nothing here records independent acceptance; at the time of writing the pull request has **no review and no review request** on GitHub. Merge, hosted installation, function deployment, publication, activation and accounting acceptance are separate decisions (`docs/release/ipsas-accrual-chain-r1/REVIEW_PACKAGE.md`).

## 1. Candidate
| Item | Value |
|---|---|
| Pull request | #229, draft, base `main` (`db6cef701b0856b98cd485d30431ac7b1137f2e4`, unchanged throughout) |
| Code head carrying all CI evidence below | `8a2467bd460c55ad3689180265f4e5e2e90c8c4f` |
| The commit that adds this file | differs from the code head by documentation only (`git diff 8a2467b..<head> --stat` lists only `docs/`) |
| Stack | `a992cad` (#224) -> #227 `d235708` -> #228 `748be05` -> #229 (own diff `748be05..8a2467b`, 7 commits) |
| Merge into `main` would bring | 50 commits, 153 files, +17,905/-59; three new migrations (`20261207100000`, `20261208100000`, `20261210100000`), one new Edge Function (`trial-balance-source-download`) and its shared helper, the `/ipsas` route, no modified existing function |

## 2. CI evidence (read from GitHub, not from summaries)
Run 41045676796 on `8a2467b`. Attempt 1: 9 jobs passed, 1 skipped by design (manual write-capable staging RLS). The real-stack job (`Real application end to end`) was then re-run twice on the same head to sample its stability; Release Gate and Disposable-DB results are from attempt 1 only.

| Job | Attempt | Job id | Outcome |
|---|---|---|---|
| Release Gate (full suite, build, guards) | 1 | 124029043535 | success |
| Disposable-DB Contract Tests | 1 | 124029043791 | success |
| Real application end to end | 1 | 124029043879 | success |
| Real application end to end | 2 | 124067112553 | success |
| Real application end to end | 3 | 124076190834 | success |

Counts (from the job logs): independent regression 9/9; preparation proof 29/29; grants 29/29; statement review 28/28; authority ordering 15/15; preparation transport 23/23; grants transport 24/24; browser journey over a loopback bridge 24/24; authenticated journey (real Auth, PostgREST, RLS, private Storage) 48 = 46 acceptance-labelled + 1 gap-record + 1 operator-integrity, all passed; main local-stack journey 71/71; drafts 4/4; finding correction 18/18; source download 14/14 (identical in all three real-stack attempts). The 48 are recorded checks, not 48 independent accounting workflows; the 46 include setup steps.

## 3. Stability investigation (kept separate from the review verdict)
**Observed.** The real-stack job's *main* local-stack journey (`scripts/e2e/localStackJourney.mjs`, which the IPSAS work does not touch) failed in 3 of 5 runs on heads carrying a click sampler of 100 ms / 0.5 px / 20 s budget. Exact failing steps: `d920ad9` attempt 1 - "the focused upload page ... 'Look for likely causes'" timed out waiting for `investigation-leads`; `d920ad9` attempt 2 - the same step and "a file recorded as another entity's is BLOCKED"; `fdafe87` attempt 2 - the latter step, where the driver itself refused `[data-testid="decision-choice-different_entity"]` with "did not settle before input (disappeared, covered or disabled)" after the whole budget.

| Head | Click sampler | Main-journey outcomes |
|---|---|---|
| `a22e982`, `8deb7ed`, #228 `748be05` | 350 ms / 1 px, one re-locate | 71/71 each |
| `6e10577`, `d920ad9`, `fdafe87` | 100 ms / 0.5 px / 20 s | pass; fail, fail; pass, fail (3 of 5 failed) |
| `8a2467b` | 350 ms / 1 px, at most six bounded re-locations | 71/71 in 3 of 3 attempts |

**Hypothesis behind the change.** The newer sampler is stricter and unbounded; the only component that differs between passing and failing heads is the click algorithm. **What the change does** (`scripts/browser-acceptance/cdp.mjs`, `click` only): hover, wait 350 ms, re-locate, accept a position within 1 px; a covered, disabled, vanished or still-moving target is re-sampled at most six times and then refused with the last samples in the message; one native press/release. **Not established.** The mechanism was not reproduced: the refusal text says the target never stabilised, not why. Five runs on one side and three on the other cannot prove cause (three passes at the earlier ~60% failure rate has probability about 6%), and the instant-scroll and focus-wait changes were kept, so they are not excluded. The bounded sampling exercise is closed; a future failure must be investigated from the new refusal message, not rerun.

## 4. Click-driver review (`fdafe87..8a2467b`, tests and records included)
Reviewed against the code and the harness:
- **Native input only:** `Input.dispatchMouseEvent`. `click` never calls an element's handler or forces an obstructed target. Pre-existing, outside the driver and not touched here: generic field setters in the journeys toggle checkboxes with `el.click()` (`set` helpers), the double-submit test deliberately triple-clicks via `evaluate`, and the mock-payment journey uses `evaluate` clicks. The IPSAS controls that matter (save, confirm, discard, download) use the native driver; the download step asserts exactly one *trusted* activation.
- **Before input:** presence, size/visibility/display, hit test (topmost element at the centre) and enabled state are checked before the hover and again after it; foreground focus and document focus are awaited within the deadline; scrolling is instant.
- **Bounded, no duplicate click:** at most six samples; the press/release pair is sent once or not at all; no harness caller retries a click (searched); `ipsasSaveProbe.test.ts` proves a failed native click restores the original transport without retrying.
- **Diagnostics kept:** the last four samples are in the refusal message.
- **Assertions:** none removed, relaxed or converted to skips; the four driver tests pass unchanged (26 driver/probe tests).
- **Delay vs persistence:** 350 ms is only pointer settling. Grants save completion is tied to the save request's own receipt (`revisionId` differs from the expected id), a matching authoritative context read, and the rendered `data-grants-revision`, with `fetch` observed passively and restored in `finally` (`saveGrantsAndReadBack`). Confirmations and discards wait for specific rendered server state. **Residual coupling for the reviewer:** the PPE steps still wait for the per-key "recorded version" banner on first saves (sound because each key is saved once per page load), a fixed 600 ms follows the PPE stale-discard before the adopted value is read, and 300 ms follows tab switches; none is a save-completion wait for a repeated save, but they are timing assumptions.

## 5. F1-F5 on this candidate
The review lists five findings. Negative controls ran in isolated swaps restored byte-identically.
| ID | Behaviour | Evidence |
|---|---|---|
| F1 | PPE and grants refuse stale or invalidated authority; no authority is unknown, not zero | regression on #228's SQL: 2 pass / 7 fail; on this head 9/9 (also in CI) |
| F2 | Approved adjustments included through the authoritative adjusted accounts, with classification and period scope | pre-repair PPE 1,400,000 vs 1,430,000 and liability 310,000 vs 340,000; wrong-class account yields unknown. **Period scope executed here in a throwaway script, not committed:** a prior-year adjustment moved only the opening figure (1,600,000 -> 1,630,000); a current-year one moved only the closing figure (1,400,000 -> 1,450,000) |
| F3 | refresh cannot overwrite edits made while pending | the three new component tests fail on #228's component, pass here; the ten earlier tests pass on both |
| F4 | choices bound to period + account key | same |
| F5 | confirmed save then failed refresh keeps receipt and edits, blocks the obsolete revision until a successful refresh | same |

Not executed and stated as such: the PPE confirm path with an invalidated source end to end. By reading, confirming estimates or prior figures does not depend on the trial-balance source (its subject is the payload); with the source invalid, the assessment reports named unknown-trial-balance matters (the CI journey showed this fail-closed text when the prior year was unavailable), and the grants confirmation refuses `not_confirmable` when the period is unknown.

## 6. #227's controls
The authorize helper body is identical to #227's (hash `c75b3e299e3a`) with the same 4 + 2 call sites; every SQL hunk since #227 lies inside the three rewritten helpers (`_ipsas_tb_facts`, `_ipsas_grants_period`, `_ipsas_tb_sum`); the ordering proof and its document, both save-handling test files and the harness are byte-identical; component changes are only the "not yet read" signal and a data attribute; the actor/company/period page key is unchanged. Changed dependency: callers now take the certification id from the shared authority decision; a missing authority records a null certification id on a draft save (as before) and blocks grants confirmation. Proofs on this candidate cover role/tenant refusal, append-only history, rollback, revocation including idempotent replay, request identity and conflicts, and, for the transports, catalogue equality with the direct migration, tamper refusal and concurrency.

**Documented limitation, classified.** A mutation takes the shared member-capability lock, then re-judges authority on a fresh READ COMMITTED snapshot before any replay or write. Serialised with it (total order): explicit grants and revocations of that person, new-membership template provisioning (all take the exclusive lock), and plan changes (shared plan lock). Not serialised, because their writers do not take a lock the mutation holds: membership removal or role change (the trigger revokes capability rows without the advisory lock), rollout closure, and framework change (takes `cfoclose.fr_company:`, which the mutation does not). The proof covers these changes committed *while the mutation waits for its locks* (honoured); it does not cover one committing between the boundary check and the mutation's commit. Consequence: one append-only revision, and the response to the actor's own write, can be committed microseconds after the withdrawal committed; the next request is refused. **Classification: accepted bounded behaviour for the merge (not a blocker); the hardening option - share-locking the actor's membership row and the company row inside the helper, which would order those writers after the mutation - is an unresolved decision to be made before activation.** It needs a migration change, regenerated transports and new proofs, so it is out of scope for this repair.

## 7. Integration plan
Verified ancestry: heads of #155, #216-#225, #227, #228 are all ancestors of `8a2467b`; #226 (statement composition) is not and is out of scope. Repository facts: `main` has no branch protection and no required checks or reviews, so the acceptance gate is process, not enforcement; merge commits, squash and rebase are all enabled; auto-merge is off; branches are not deleted on merge. Precedent: equipment PR #213 was merged and installed later by a separate owner step; CI also runs on pushes to `main`.

**Recommendation.** After independent acceptance, merge #229 once as a **merge commit** (history and ancestry preserved; squash or rebase would make the other open PRs conflict). Do **not** merge #227, #228 or #216-#224 first: their intermediate states contain the F1/F2 defects in unapplied migrations meant to be installed later and, for #228, the F3-F5 editing defects in a frontend that previews automatically, and merging them separately yields the same final tree with more defective states on `main`. #155 and #225 are small independent test fixes and may be accepted separately and earlier; if so, re-run CI on the updated merge result. After merging, expect GitHub to mark ancestor PRs merged; if not, close them with a link, not before. Acceptance units for the reviewer: #229's own diff; #228's and #227's own diffs (the reviewer already inspected their controls); #222 separately, because it adds an Edge Function and a short-lived signed download link. Final-result checks: CI on the merge ref (identical tree while `main` is unchanged), the push-to-`main` run, and if `main` moves first a merge of `main` into the branch (never a rebase) with a full re-run including the real-stack and Disposable-DB jobs and the three generators' `--check`. Merging does not install a transport, deploy a function or publish the frontend; the frontend preview may update on merge, and the `/ipsas` route is refused on the server unless rollout and framework allow it.

## 8. Gates
| Gate | Evidence still required | Blocks |
|---|---|---|
| Independent technical acceptance of #229 (and of #227/#228 units, #222) | a reviewer other than the author side records acceptance on the pull request; none exists | **merge** |
| Required CI on the integrated result | merge-ref and push-to-`main` runs green | merge |
| Real-stack stability | any recurrence investigated from the new refusal message | merge (only if it recurs) |
| Hosted prerequisite state | the journal head read again at install time (equipment head id 91 is only *recorded*), `20261116100000` (`fs-memo-r1`, recorded in the repository's release journal) confirmed present; neither is verified here | hosted installation |
| Transport verification and recovery readiness | generator `--check` on the final bytes, bootstrap/apply postconditions, owner-authorised execution | hosted installation |
| Deployed code identity | deployed function and frontend identities matched to the merged commit, including `trial-balance-source-download` | deployment |
| Revocation hardening decision | accept the bounded window or add the row-share locks | activation |
| Accounting acceptance and adopted responsibilities | appointed author and reviewer, adopted charter, real NGO case, the acceptance scenarios not yet executed, framework coverage beyond this PPE/grants/statement-review increment | activation and any official IPSAS issuance |
| Commercial matters | UI onboarding, download rights by capability, retrieval after plan expiry, audited download events, real provider acceptance (mock payment journeys are not provider acceptance) | commercial launch |

Open product decisions are not merge blockers unless they change merged behaviour; the download link remains a bearer credential for up to 60 seconds. This is a bounded PPE and grants preparation increment with statement review: no full statements, comparatives, transition handling or official issuance.

## 9. Verdict and next action
**READY FOR INDEPENDENT REVIEW.** The candidate has current green CI on the exact head with a bounded stability sample, the five findings and #227's controls are verified by executed evidence including negative controls, and no known defect in the behaviour being merged is open. The only remaining *merge* gate is independent acceptance. **Next action:** the owner assigns an independent reviewer to #229 (with this file, `REPORT.md` and the CI links); nothing is merged or installed until that acceptance is recorded.
