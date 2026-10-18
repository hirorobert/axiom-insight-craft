# Trial-balance journey UX: before/after evidence (evidence only, do not merge)

Supports the draft PR on `fix/tb-journey-ux`. **Before** is `main` at `02c516a`. **After** is the branch's code, the same code as head `31b2b9d` (rebased onto `caedd14`, which adds only a release document).

## How it was produced (runtime, synthetic data)
- **Harness:** the repository's committed trial-balance harness, `dev-harness/trial-balance`. It runs the REAL `PrepareWorkspace` against an in-browser synthetic backend: no network, no credentials, no hosted data.
- **Captures:** `capture.mjs` drives the harness with headless Chrome via `scripts/browser-acceptance/cdp.mjs`, at 1280 px and 390 px, through these states: empty → file chosen → submitting → blocked → needs review → review open → balanced → injected failures. It records every visible action's label and disabled state, the live regions, red elements and `layoutProblems`, into `inventory.json`.
- **Ledger:** `ledger.mjs` reaches "Needs review" and reads the technical processing ledger. The before and after runs are separate harness instances, one per checkout.

## Observed at runtime (harness)
| Screen / state | Before | After |
|---|---|---|
| Needs review: card reason | One account's text: "Suggested from the account name — confirm before the trial balance is accepted." | "5 of 5 accounts need a reviewer's confirmation. Confirm or change the classification of each account in the account review, then save." |
| Needs review: "Every account classified" check | The same suggestion sentence repeated 5 times | "5 of 5 accounts need a reviewer's confirmation." |
| Account review, every account on a suggestion | Empty list; "0 of 5 undecided"; "Every account has a decision"; live status "All decisions recorded" | The full list with each suggestion; "5 suggested, not yet checked"; live status "5 pre-selected suggestions not yet checked. Saving records them as your decisions." |
| Upload and check, 5 clicks in one tick | 5 uploads, 5 check runs (`harness-runs`) | Covered by the jsdom test: exactly 1 upload |
| Upload and check, 2 clicks 60 ms apart | 1 upload (already guarded by re-render) | unchanged |
| Prepare-only viewer, needs review | The primary action "Resolve account classifications" did nothing (no scroll, no focus, no panel) | The card offers no action; the step explains what blocks progress and who can resolve it (jsdom and pure tests) |
| "Processing <file>" notice | `toast.success` (a check mark) while still processing | A neutral notice |
| Processing ledger after "Needs review" | 1 spinner; "Account totals assembled — Running"; "Validation complete — Waiting" | No spinner; both "Not applicable"; review is "Needs review" |
| Layout at 390 and 1280 px | No problems with the list collapsed | No problems with the full list open (pickers are labelled per account) |
| Keyboard, needs-review state (1280) | | A visible focus indicator at every stop |

## Established by code inspection only (not observed at runtime)
- The `prepare` alias redirects to `trial-balance/review`; Intake is the period/layout page.
- The Overview and EngagementHub next actions were read in code, not exercised. There is no harness for the Overview, and the hub harness was not used.
- Close review, statements and sign-off sit behind release and reporting-access gates. They were not exercised and are out of scope.
- No hosted environment was used.
