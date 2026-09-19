# Seven-stage browser proof (local, non-production)

What this is: the real workspace UI, driven in a real browser, talking through the real TypeScript
transport to a **disposable PostgreSQL 16** that replays every repository migration, through the
loopback bridge (`scripts/db-proof/serve.mjs`). Identity is a **simulated** `auth.uid()` (not GoTrue).
It is **not** hosted acceptance (`HOSTED_STAGING_RESULT=BLOCKED_MISSING_STAGING_PROJECT`).

The seven stages are **Sources, Structure, Statements, Notes & Policies, Validate, Professional
Review, Final Outputs** (`WORKSPACE_STAGES`). Scenario `multicash` (harness fixture): six cash
accounts, an ECL allowance and an overdraft, with a comparative year.

## Observed results

| # | Scenario | Observed |
|---|---|---|
| 1 | **Multi-account cash.** Upload a cash account map (bank, mobile money, cash on hand, restricted project account, ECL allowance, overdraft) | Perimeter `ESTABLISHED`: gross 6,300,000.00 · restricted 900,000.00 · ECL −100,000.00 · overdraft −200,000.00 · cash-flow closing 6,100,000.00 · net SFP 6,200,000.00; every account listed with its category; nothing picked by position or name |
| 2 | **XLSX intake.** Upload a workbook with a visible `Ledger` sheet and a hidden `Scratch` sheet | The sheet picker is mandatory (Add disabled until a sheet is chosen); the hidden sheet is labelled and disclosed as a warning (`OTHER_HIDDEN_SHEETS`); the batch stores the sheet name, format and per-row `Ledger!A2:H2` locators |
| 3 | **Server rejection of an incomplete report.** Save an incomplete report and try Reviewed | UI shows the server's blockers (`MISSING_STATEMENT:STATEMENT_OF_CHANGES_IN_EQUITY`, `COMPARATIVE_FIGURES_MISSING:…`) and disables Reviewed/Final. The **direct RPC** `fs_set_publication_state(REVIEWED)` (bypassing the UI) is refused: `PT409 BLOCKED: 2 requirement(s) unmet …` |
| 4 | **Complete report.** Add comparative ledger and current/comparative equity movements, save | Server readiness: "ready to mark Reviewed or Final"; partner marks Reviewed, then Final — both accepted by the database |
| 5 | **Reload recovery.** Reload the page | "Restored your saved work (version N)", status "Saved · version N", evidence marked Saved; the editable draft reproduces the stored content hash exactly |
| 6 | **Historical read-only.** Open version 1 from Saved versions | Banner "Viewing saved version 1 (historical, draft) exactly as stored — read-only"; only that version's two evidence rows; its own recorded findings (3 warnings, not today's 1); its incomplete statement set; no Save button; no correction forms; Return to the working draft |
| 7 | **State in the list.** After Final | The version list shows v3 `final` (refreshed after publication); creators shown as role + opaque reference, never a firm-member id |
| 8 | **Evidence correction.** Correct the `description` cell of the saved ledger as a different user | New evidence version; Save writes evidence + report version + decision + re-evaluation in one group (v4); reload restores it exactly, including the `CORRECT_EVIDENCE` decision |
| 9 | **Stale session.** A second session saved v5 while the first was at v4; the first edits and saves | "The report was saved by someone else since you opened it (server is at version 5, this session last saw 4). Nothing was saved."; server still holds 5 versions; Save is hidden; "Discard my draft and reload the saved version" restores v5 |
| 10 | **Cross-company.** Company B's owner opens company A | UI: "Read-only: you cannot save for this company", no saved-versions panel. API: `fs_list_saved_versions` → `FORBIDDEN`, table select → 0 rows, readiness → refused; an outsider likewise |
| 11 | **375 px.** Final Outputs at 375×812 | No horizontal page scroll (`scrollWidth = 375`), nothing overflowing outside a scroller |
| 12 | **Exports.** Final Outputs | `canonical.json`, `evidence.json`, `audit.json`, `findings.csv`, `budget-vs-actual.csv`, `disclosure-checklist.csv` present |
| 13 | **Print/PDF.** The print document | Contains the statement of financial position, cash flows, changes in equity, the cash and cash-equivalents note and the DRAFT marker; no workspace chrome (save bar, saved versions) |

## Defects the browser proof found (fixed in this release, each covered by a test)

* A save with new evidence but no correction wrote the evidence and **no report version**
  (`saveFlow.pg.test.ts` — "evidence added after a save … is a new report version").
* Reopening refused a saved version whenever newer evidence had been stored after it; it now
  applies that evidence to the draft and shows the draft as unsaved (`savedVersions.test.ts`).
* The save status stayed "Conflict" after "Discard my draft and reload"; the publication state was
  not reflected in the version list; a `<div>` inside a `<p>` in Final Outputs.

## Not covered by this proof

Print preview page numbering (Chromium margin boxes); a real GoTrue session; any hosted project;
load. See the release package's known limitations.
