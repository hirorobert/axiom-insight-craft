# Hosted reporting acceptance r1: demo company setup and journey

The **demo company only**: `659daa94-116c-4803-99f8-157e0bdd4c62`.

This document is for a human tester in the hosted app, plus one read-only SQL query. Nothing here changes FY2026, a
protected upload, customer data, a gate, or any other company. Nothing here is a compliance claim. The figures are
synthetic, author-prepared and **not independently validated**.

The whole procedure, from the same files, runs on every CI run against real PostgreSQL:
`scripts/db-proof/acceptanceFixtures.mjs`. That covers the preflight verdicts, setup, the Close Review requirement,
every expected total, sign-off, stale refusal and the non-enabled company. A hosted failure that the proof does not
show is therefore a hosted difference. Record it; do not work around it.

## 0. Preflight (read-only)

Run `docs/release/sql/07_acceptance_preflight.sql` in the SQL editor, with `<DEMO_COMPANY_UUID>` replaced by the demo
company's id. It returns one row per check and a `VERDICT`:

| Verdict | Meaning | Next |
|---|---|---|
| `PATH_A` | An existing dated period (start, end and currency recorded), other than FY2026, has a current reviewed trial balance, and so does the year before it. Row 6 names it. | Path A |
| `PATH_B` | No such year exists. FY2024 and FY2025, and the acceptance accounts (91000–97000, "(acceptance r1)"), are all unused. | Path B |
| `BLOCKED` | A row marked `BLOCKED` names the cause. Common causes: the framework is not IFRS for SMEs; the kill switch is on; a company other than the demo company is enabled; or Path B's years or accounts are already in use. | **Stop.** Report the rows. Do not repair, re-date or reclassify anything. The owner decides. |

FY2026 is never a candidate. Account authority and presentation are held **per company**, not per year. That is why
Path B uses its own account codes and names, and why the preflight refuses on any overlap. Without that, reviewing the
acceptance accounts could alter the classification of an existing year.

## Path A: an existing dated period

Use the year named in preflight row 6 (`Y`) and its prior year (`Y−1`). Use only what is already recorded: the
framework edition follows from the recorded period start (see Path B's edition rule). Do not upload, re-date or
reclassify anything. If a step needs input that does not exist, the step **fails**: record it as FAILED with the missing
input named. Never invent it.

Expected totals are whatever the reviewed trial balance gives. Record them. They are not compared against the
acceptance fixture. Continue at **Journey** with `Y`.

## Path B: the dedicated synthetic engagement (FY2025 current, FY2024 comparative)

| Input | Value |
|---|---|
| Framework | IFRS for SMEs: the company's recorded `reporting_framework` must already be `ifrs_for_smes` (preflight row 2). |
| Edition | **2015 edition.** Both periods start before 2027-01-01, the third edition's mandatory date. No early-application election is made, so the system selects nothing silently: the rule decides. |
| Current period | 2025-01-01 to 2025-12-31, TZS, 2 decimals |
| Comparative period | 2024-01-01 to 2024-12-31, TZS |
| Files | `docs/release/acceptance-r1/` (rendered by `scripts/release/renderAcceptanceFixtures.mjs`; CI checks them for drift) |
| Expected totals | `docs/release/acceptance-r1/EXPECTED_TOTALS.csv`: computed by hand, author-prepared, **not independently validated** |

Setup, as the demo company's owner (a partner or manager may do the review steps):

1. **Trial balance › Intake** in the FY2025 workspace (`/workspace/<demo>/2025/trial-balance/intake`).
   - Under Reporting period, enter start 2025-01-01, end 2025-12-31 and currency TZS.
   - Tick "Also set up the prior period", then enter prior start 2024-01-01 and prior end 2024-12-31. Save.
2. **FY2024 trial balance.** Upload `trial_balance_FY2024_prior.csv` in the FY2024 workspace
   (`/workspace/<demo>/2024/trial-balance/intake`).
   - On **Trial balance › Review**, classify each account exactly as in `account_classification.csv`.
   - Mark only 91000 as the cash account. Save.
   - The check completes as a reviewed trial balance.
3. **FY2025 trial balance.** Upload `trial_balance_FY2025_current.csv` in the FY2025 workspace. It completes as reviewed:
   the same accounts, so no new decision is needed. If a review is asked for, apply the same classification.
4. **Statements.** Assign each account to the line in `presentation_assignments.csv`, with reason "Acceptance fixture
   r1 presentation".
5. **Notes.** Record the decisions in `decisions_FY2025.csv` (5.5(e), (g) and (h) are not applicable; share capital is
   applicable), and the wording in `notes_wording_FY2025.csv`. That wording is a placeholder, not a reviewed disclosure.
6. **Schedules.** Record the PPE schedule from `ppe_schedule_FY2025.csv`.
7. **Comparatives.** As a reviewer or the owner, approve with the reason "Agreed to the FY2024 acceptance statements".

## Journey (both paths; `Y` = 2025 on Path B)

Record each step as PASS, FAIL or NOT RUN, with a screenshot and the exact screen text.

| # | Step | Expected |
|---|---|---|
| J1 | Open the demo company's workspace. | Navigation shows **Close Review** (Findings only), **Financial Statements** and **Sign-off & Exports**. |
| J2 | **Statements** | Both statements show the server's figures. On Path B they match `EXPECTED_TOTALS.csv`: total assets 33,000.00 / 28,800.00; total equity 21,000.00 / 16,600.00; total liabilities 12,000.00 / 12,200.00; profit before tax 6,000.00 / 3,800.00; profit 5,100.00 / 3,100.00. Enter on a line opens its lineage. |
| J3 | **Notes**, **Schedules**, **Comparatives** | Each shows the recorded state. The comparatives are approved. |
| J4 | **Sign-off.** Add the six evidence files: current ledger, equity movements and cash map; comparative ledger, equity movements and prior-period statements. Save a version. | A version is saved. Its readiness names **"Close Review has not been checked for this trial balance"** (`CLOSE_REVIEW_FINDINGS_NOT_CHECKED`). Marking it REVIEWED is refused. |
| J5 | **Close Review › Findings.** Run the check. Explain each finding (Path B: "Accumulated depreciation is a contra-asset by design", source "Fixed asset register 2025 (synthetic)"). | No unresolved blocking finding. |
| J6 | **Sign-off.** Save a new version. | Readiness "ready", with no blocker. On Path B the cash flows show operating 6,200.00 / 4,700.00, financing −1,700.00 / −1,700.00 and closing cash 12,500.00 / 8,000.00. Changes in equity closes at 21,000.00. |
| J7 | Mark it REVIEWED (partner or manager), then FINAL (owner), each with a reason. | Both recorded, bound to that version. |
| J8 | **Exports** | The pack shows the FINAL seal, the recorded approver and both hashes. Print/PDF and CSV both work. |
| J9 | **Stale-result refusal.** On Notes, change one wording (Path B: the estimates note). Then open Sign-off. | The FINAL version stays sealed but is shown as changed after it was saved (`REPORTING_DEPENDENCIES_STALE`). The next action is "Save a new report version". Marking a stale version REVIEWED is refused. |
| J10 | **Not enabled.** Open a company the same tester can access that is not on the allow-list. | No Close Review, Financial Statements or Sign-off navigation. `/close/findings`, `/statements` and `/signoff` show "unavailable". |
| J11 | **Cross-workspace** (only with a genuine second account in a different workspace) | Opening the demo company's `/statements` shows "unavailable" with no figures. Without such an account: **NOT RUN**. Never create one for this purpose. |

## Recovery

- **Disable reporting** for the demo company: run `docs/release/sql/04_deactivate_company.sql` (service role, named
  operator, reason). For every company at once: `05_kill_switch.sql`.
- **Acceptance data** is append-only by design. Signed versions, decisions and evidence are never deleted. Path B's data
  is confined to FY2024/FY2025 and the accounts 91000–97000 named "(acceptance r1)". It can be told apart from real
  data by those years, codes and names. Do not delete or overwrite it to "reset". Run a repeat on a fresh version
  instead: Sign-off always saves a new version.
- A failure at any step: stop at that step, and record the step, screen text, response and time.
