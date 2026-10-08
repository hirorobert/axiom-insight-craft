# Reporting workbench (Financial Statements; Sign-off & Exports)

Pages: `fs-statements`, `fs-notes`, `fs-schedules`, `fs-comparatives`, `signoff`, `exports`
(`src/components/reporting`, page `src/pages/workspace/ReportingWorkbenchPage.tsx`). **Not released**: each route is
registered only when its page is in `RELEASED_WORKBENCH_PAGES` (`src/lib/workbench/routes.ts`), behind the Statements
stage scope gate. The Statements stage is still withheld from customers (`src/lib/workspace/moduleAvailability.ts`).

## What each page does
| Page | Reads | Writes (server functions only) |
|---|---|---|
| Statements | `fs_statement_composition` | `fs_assign_presentation` |
| Notes | `fs_notes_status`, the pack's requirement labels and citations | `fs_decide_requirement`, `fs_record_disclosure` |
| Schedules | `fs_notes_status` (reconciliation figures) | `fs_record_schedule` |
| Comparatives | `fs_comparatives_status`, restatements and decisions (RLS selects) | `fs_bridge_comparative_account`, `fs_propose_restatement`, `fs_decide_restatement`, `fs_approve_comparatives` |
| Sign-off | `fs_list_saved_versions`, `fs_report_readiness`, evidence, Close Review adjustments | `fs_commit_revision` (evidence + version + evaluation, atomic), `fs_set_publication_state` |
| Exports | the stored document and its `fs_publication_bindings` row | none |

No page writes a table. Every amount on screen is a server figure; a figure the server did not compute is shown as
missing with its reason.

## Next action
`nextReportingAction` (`src/lib/reporting/nextAction.ts`, pure) reads only the server's states, in the order the server
enforces them: compose → notes → schedules → comparatives → evidence → a version on the current dependencies → its
blockers → REVIEWED → FINAL → export. A step that belongs to another role is shown as someone else's (`tone: blocked`).
Exactly one next action is shown.

## Saving a version
`prepareReportVersion` (`src/lib/reporting/prepareVersion.ts`):
1. Reads every authority fresh. It refuses before writing when the composition, notes or dependencies are not current,
   or when they changed during preparation.
2. Assembles the document with `assembleComposedReport` (`src/lib/financialGeneration/composedReport.ts`). The pieces are:
   - the composed statements;
   - the evidence statements;
   - the recorded wording in force;
   - a disclosure checklist taken from the server's notes status;
   - the dependencies identity.
3. Evaluates the document with the canonical rule pack.
4. Commits through `fs_commit_revision`. The idempotency key and the evaluation time are captured once per attempt, so
   a retry is an exact replay.

Stored evidence is itself a dependency. A save that brings new evidence therefore saves twice:
- the first version holds the evidence;
- a second version is saved immediately on the dependencies that evidence changed.

Both versions are kept. Only the latest can be signed.

**Comparative cash flows.** The prior year needs its own ledger and equity movements. Its opening cash comes only from
the signed prior-year statement of cash flows: a `PRIOR_PERIOD_STATEMENTS` row `CASH_FLOWS,
cash_and_cash_equivalents_opening_cf`. Its closing cash is then tested by the rule pack against the approved comparative
position. Nothing is derived backwards.

## Keyboard, context and recovery
- **Tables** use the workbench `DataTable`:
  - ↑/↓/Home/End/PageUp/PageDown move between rows;
  - Enter opens the lineage panel;
  - Esc closes it and returns focus to the row.
- **Version in links.** The selected version travels as `?v=` on every link.
- **Read failures** show the error and a retry. A stale write refreshes the page and says so.
- **Role-dependent controls** are hidden. The page says who acts. The server still refuses every unauthorised write.
- **Confirmation.** REVIEWED, FINAL and comparative approval each need a confirmation with a reason. FINAL also needs
  an acknowledgement when self-approved or self-revalidated adjustments are disclosed.

## Evidence
| Kind | Where |
|---|---|
| Unit tests | `src/lib/reporting/*.test.ts`, `src/lib/financialGeneration/composedReport.test.ts`, `src/lib/exports/reportPack.test.ts` |
| Component tests (jsdom) | `src/lib/reporting/workbenchUi.test.ts` |
| Real PostgreSQL | `scripts/db-proof/reportingWorkbench.mjs` (22 checks) |
| Browser | `scripts/browser-acceptance/reportingJourney.mjs` (18 checks) |

**Unit tests.** Next action, assembly, determinism, the checklist, comparative opening cash, rule-pack casting and pack
layout.

**Component tests.** One next action, recovery after a read failure, role controls, no writes, and axe.

**Real-PostgreSQL proof.** It runs the browser's own client code. Its cash-flow and equity expectations are computed by
hand. It also checks that the canonical rule pack passes independently, and covers sign-off by role, replay, a stale
version and tenancy.

**Browser journey.** Headless Chrome drives the dev harness (`dev-harness/reporting`) over a loopback bridge
(`scripts/db-proof/serveReporting.mjs`) to a throwaway database. It acts as preparer, reviewer and owner, and prints the
draft and sealed packs to PDF. The bridge simulates PostgREST identities; it is not GoTrue.

Passing these is not accounting validation. The expected figures were computed by the author from the author's own
fixtures, not by an independent qualified reviewer.

## Activation (not done here)
1. Apply migrations `20261018100000` → `20261021100000` (hosted; owner only).
2. Stop withholding the Statements stage (`moduleAvailability.ts`). The `statements` route segment must leave
   `WITHHELD_WORKSPACE_ROUTE_SEGMENTS` in the same change.
3. Add the six page ids to `RELEASED_WORKBENCH_PAGES` and set `REPORTING_PAGES_SHIPPED = true` in the same commit. Until then,
   the reporting chunk is not in the production build at all; `harnessIsolation.test.ts` scans `dist/` for it.
4. Allow-list the company in the financial-statements rollout (`fs_set_company_rollout`).

## The two-step save is resumable (closure)
Saving with new evidence takes two steps:
1. the **evidence** version, which stores the new batches and is stale, so it can never be signed;
2. the **bound** version.

Each step's idempotency key is the attempt's key, the step, and the version it builds on.

**After a failure at any point**, pressing save again (the same attempt) resumes:
- evidence the server already holds is not sent again;
- an attempt whose latest version is already bound to the current dependencies writes nothing.

**Concurrency.** A concurrent save or edit is absorbed by building on the newest version.

All of this is proven with injected failures in `scripts/db-proof/reportingClosure.mjs`.
