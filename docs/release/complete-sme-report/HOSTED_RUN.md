# Complete SME report on the hosted demo company: owner-run script

This is the hosted counterpart of `scripts/db-proof/completeSmeReport.mjs` (case 1). The proof runs the whole journey on
a disposable database through the product's own RPCs; this script runs the same journey through the product's pages on
the hosted demo company (`659daa94-116c-4803-99f8-157e0bdd4c62`, the only company with reporting enabled). Nothing in
this repository can reach the hosted project: no credentials, no authenticated readback. The owner (or a tester the
owner names) runs it and records each step as PASS, FAIL or NOT RUN with the exact screen text.

Prerequisites: the acceptance-r1 engagement exists on the demo company (docs/release/ACCEPTANCE_R1_DEMO_SETUP.md, Path B,
steps 1 to 7), migration `20261206100000_fs_equipment_multiclass.sql` is applied (PR #211 merged on 2026-10-28; apply is
the owner's decision), and the `seal-reporting-pack` Edge Function is deployed. If any of these is not the case, stop at
step 0 and record it.

Synthetic data only: the inputs are the files under `docs/release/acceptance-r1/`,
`docs/release/equipment-guided-start-r1/fixtures/` and `docs/release/complete-sme-report/case1-acceptance-r1/`. Nothing here is
a real entity's record, and the wording is scenario wording, not a reviewed disclosure of a real entity.

| # | Step (as the demo company's owner unless stated) | Expected |
|---|---|---|
| 0 | Run `docs/release/sql/07_acceptance_preflight.sql` (read only). | `PATH_A` on FY2025 with its certified prior year; rows 6 to 8 as the setup document describes. |
| 1 | Financial Statements > Schedules > "Start guided equipment preparation" > "Read the recorded preparation". | "The recorded schedule has 1 class: Equipment." No saved preparation yet. |
| 2 | "Load the recorded classes into this preparation". Confirm the prior figure from `equipment-register-FY2025.csv` (reference, 2024-12-31, 16,000.00, TZS, units 0). | Equipment loaded with 16,000.00 opening and 14,000.00 closing, depreciation 2,000.00; nothing else assumed. |
| 3 | Enter the class as `case1-acceptance-r1/scenario.json` states it: accounts 91500/91510; opening gross 20,000.00, accumulated 4,000.00; closing gross 20,000.00, accumulated 6,000.00; depreciation 2,000.00 from the register (E-001); estimate: cost, straight-line, 10 years, residual 0, full-period, the four factors, charge calculated from item E-001 (cost 20,000.00, opening accumulated 4,000.00, available 2023-01-01). Tick movement coverage. | Roll-forward agrees; the calculated charge reads 2,000.00 and equals the recorded depreciation; the class agrees to the statement line 14,000.00. |
| 4 | Add the destination `sci.operating_expenses_by_function` 2,000.00, evidence "account 96200". | Tie-out agrees (within the 9,900.00 line). |
| 5 | Answer the questions with the scenario's facts (recognition, components; restrictions, commitments, impairment with no indicator, events after, framework history). | "Every applicable question is answered"; three proposals appear. |
| 6 | "Save a draft". Leave the page (open Statements), open Schedules again, "Read the recorded preparation", "Restore the saved preparation". | The draft is restored exactly: the same class figures, estimate and answers. |
| 7 | "Prepare the notes", tick reviewed, "Record everything". | "Recorded: workpaper …"; Schedules shows the PPE schedule Reconciled (14,000.00) with source "Reviewed equipment workpaper …". |
| 8 | Leave the page and open Schedules again; "Read the recorded preparation". | "The recorded schedule has 1 class: Equipment. A saved preparation is available". Restore shows the recorded preparation. |
| 9 | Notes: for every requirement whose wording still reads "(acceptance placeholder)", record the wording from `case1-acceptance-r1/scenario.json` (`notes.wording`), source "Complete SME report: synthetic FY2025 engagement file". The three equipment notes were written by step 7. | No requirement is missing, undecided or placeholder-worded. The decisions recorded at setup (share capital applicable; 5.5(e), (g), (h), events after and the two related-party requirements not applicable, each with its scenario reason) stay as recorded. |
| 10 | Sign-off: add the six evidence files; save a version. | Blocked by "Close Review has not been checked for this trial balance". |
| 11 | Close Review > Findings: run the check; explain the finding(s) with "Accumulated depreciation is a contra-asset by design", source "Fixed asset register 2025 (synthetic)". Sign-off: save a new version. | Readiness "ready", no blocker. Statements show the totals of `docs/release/acceptance-r1/EXPECTED_TOTALS.csv`: assets 33,000.00 / 28,800.00; equity 21,000.00 / 16,600.00; liabilities 12,000.00 / 12,200.00; PBT 6,000.00 / 3,800.00; profit 5,100.00 / 3,100.00; operating cash 6,200.00 / 4,700.00; financing -1,700.00 / -1,700.00; closing cash 12,500.00 / 8,000.00; equity closing 21,000.00. |
| 12 | A partner or manager marks the version REVIEWED. The same person tries FINAL. | REVIEWED recorded. FINAL refused: "the final approval must be recorded by someone other than the reviewer" (policy separate_approvers). |
| 13 | The owner marks it FINAL. | FINAL recorded, bound to that version. |
| 14 | Exports: "Issue the official pack". Save the file. Click "Verify" and "Retrieve again" on the issuance. | A sealed issuance with its SHA-256; verify reads intact and official; "Retrieved again: … digest … matches the seal recorded at issue". Compute the SHA-256 of the saved file yourself (`certutil -hashfile <file> SHA256` or `shasum -a 256`) and compare with the digest shown. |
| 15 | Notes: change the judgements wording (any revision). Sign-off: open the FINAL version. Exports: verify the issuance again. | The FINAL version is shown as changed after it was saved (REPORTING_DEPENDENCIES_STALE); marking it REVIEWED again is refused; the issuance still verifies intact; the saved file's hash is unchanged. |

Record for every step: the step number, PASS/FAIL/NOT RUN, the screen text, the time, and for step 14 the issuance id,
the digest shown and the digest you computed. A failure at any step: stop there and record the step, screen text and
response; do not work around it.

Second case (Mwanza Agro, `case2-mwanza-agro/`): the same steps with that folder's files on a second engagement. The
demo company's FY2025 engagement is calendar-year; the second case needs a company whose FY2025 runs 1 July 2024 to
30 June 2025, which the owner would have to create and enable for reporting first. That decision is the owner's; the
proof covers the case on a disposable database.
