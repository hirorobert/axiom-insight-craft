# Screen trace: the 18 screenshots, traced to code (PR #101)

Each observed problem is traced to its route, component, data source and the handler that changes the data, then classified. *Fixed in* names the commit on `feat/commercial-candidate`.

## 1. Traces

| # | Observation | Route → component | Data source | Mutation handler | Classification | Fixed in |
|---|---|---|---|---|---|---|
| 1 | Many engagements share one demo name | `/dashboard` → `EngagementHub` | `useActiveEngagements` (companies, open engagements, fiscal_periods) | `create_entity`, `open_engagement_with_scope` | Demo data (repeated acceptance companies). **No metadata separated test work** (missing capability) | `2bef37d`: workspaces grouped by company, with period dates and service. Purpose (client / test / training) is recorded, append-only and owner-only (`20261027100000`), and never inferred from a name |
| 2 | Overview says "statement equation is not exactly verified" while the checks say *Passed* | `/workspace/:c/:y` → `WorkspaceOverview` → `trialBalanceReviewStep` (`REVIEWED_SCOPE` constant) | Overview: workspace snapshot. Checks: `readRecordedEquation(processing_result)` | none (read only) | **Defect**: two readings of one fact | `5780478`: one reading (`recordedEquation` on the snapshot) drives both, and a legacy result keeps its conservative wording. No check is weakened |
| 3 | Overview's main action is "Open trial balance" although the trial balance is complete | `WorkspaceOverview` (withheld-stage branch) | `deriveWorkspaceState` next action (legacy statements stage) | — | **Defect**: the engine's next step lies in a withheld stage | `2f5c5e9`: for a reporting-enabled company the Overview shows the reporting journey's next action, with its reason |
| 4 | "Validate Draft Statements" is next while Findings has not run | `WorkspaceLayout` → `WorkbenchShell` → `NextOpenItem` | the legacy engine's next action (HESABU path 7) | — | **Defect**: not prerequisite-aware | `2f5c5e9`: a single reader (`reportingState.ts`) gives the order Close Review → statements → comparatives → notes → schedules → evidence → version → REVIEWED → FINAL → export |
| 5 | "Manage file" opens a long layout editor | `/…/trial-balance/intake` → `TrialBalanceIntake` → `LayoutEditor` | `trial-balance-layout` (inspect) | `trial-balance-layout` validate / confirm | UX defect | `f8db0f9`: a file summary leads; the editor opens on request, or by itself when detection fails or the check failed. Whole-file validation is unchanged |
| 6 | Seven number-format options dominate the editor | `LayoutEditor` | inspect `numberFormats` evidence | — | **Fixed configuration** (the seven formats are legitimate); the presentation was the defect | `f8db0f9`: the detected format and the file's own example amounts lead; the alternatives sit behind "Use a different format" |
| 7 | Checks, processing results and technical details repeat each other | `/…/trial-balance/review` → `PrepareWorkspace` → `TrialBalanceChecks` | verdict (`trialBalanceVerdict.ts`) | — | UX | `8be9856`: the result leads; milestones and information rows are collapsed when every check passed and stay open otherwise |
| 8 | Findings table crowded ("CreditSeverity") | `/…/close/findings` → `FindingsView` | `close_review_findings_summary`, `close_review_findings` | `close_review_finding_action` | UX defect (cells had no padding) | `b172fb3`: spaced and aligned columns; "Review finding" moves focus to the detail |
| 9 | The notes banner exposes `smes.note.*` keys | `ReportingWorkbench` → `NextActionBar` | `fs_notes_status` | — | **Defect**: identifiers shown as tasks | `2f5c5e9`: the framework pack's names are used; identifiers move to technical details |
| 10 | Banner says 11 note requirements; Notes says 13 blocking | `NextActionBar` vs `NotesView` | the same `fs_notes_status` | — | Both counts were correct, but the difference was never explained (2 statements waiting only for evidence) | `2f5c5e9`: both state the split |
| 11 | The notes banner dominates Schedules, Comparatives and Sign-off | `ReportingWorkbench` | — | — | UX | `2f5c5e9`: each page leads with its own task; another page's action shows as one line |
| 12 | Comparatives: FY2023 missing (`COMPARATIVE_REQUIRED_MISSING`), no recovery | `/…/statements/comparatives` → `ComparativesView` | `fs_comparatives_status` | — | **Defect**: no recovery path | `b172fb3`: import the prior year, or (first period only) record a declaration with evidence (`fs_declare_first_period`, refused by the server when earlier data exists). Server codes sit behind technical details |
| 13 | Cash-flow and equity evidence first appears under Sign-off | `SignoffView` → `Evidence` | `financial_evidence_batches` | `prepareReportVersion` → `fs_commit_revision` | UX / journey order | `2f5c5e9`: collected on Statements; Sign-off summarises read-only |
| 14 | Evidence is not stored until a version is saved | `EvidenceIntake` | — | `fs_commit_revision` (atomic) | **The contract is correct** (kept); the persistence state was not stated | `2f5c5e9`: each file shows *Selected*, *Validated (not stored)*, *Rejected*, *Stored* or *In version N* |
| 15 | Reconcile offers "Post Manual AJE" (IAS 8) | `/…/reconcile` → `ReconcileWorkspace` → `AdjustingJournalPanel` | `adjusting_journal_entries`, `aje_lines` | **Browser INSERT/UPDATE under RLS** (`aje_insert`, `aje_update_*`, `aje_lines_insert`), with the approver set from the browser | **Integrity defect**: a second, unreviewed adjustment path. "IAS 8" was also wrong for an IFRS for SMEs workspace (Section 10), and TZS was hard-coded | `2d8e0e0`/`df5f446`: `20261026100000` revokes client writes; Reconcile shows history read-only (no currency or framework assumed) and links to Close Review › Adjustments, now released within the pilot. History is preserved byte for byte (proof 16/16) |

## 2. Demo data, fixed configuration and hard-coding

| Item | Verdict |
|---|---|
| Account 91000, the account names and the demo company title | **Uploaded demo data**. Nothing in the code depends on them |
| The bank as account 91000 | **Not universal and not assumed**: the cash perimeter comes from recorded classification decisions (`is_cash_account`) and the cash account map. The end-to-end journey uses bank 10457 and other non-round codes |
| Column roles, the seven number formats and the evidence CSV headers | **Fixed configuration** (legitimate) |
| Company, period, currency, edition, comparative period, classifications and tasks | Dynamic: read from the server. The **exceptions found and fixed** follow |
| Evidence intake periods `YYYY-01-01 … YYYY-12-31` | **Inappropriate hard-coding (fixed, `8a8aea6`)**: a July–June company's ledger was checked against the calendar year. It now uses the recorded period dates (`fs_reporting_input`) and refuses when they are unknown |
| Reconcile's "TZS" and "IAS 8" | **Inappropriate hard-coding (fixed, `2d8e0e0`)** |
| Comparative period = `period_year − 1` (`fs_reporting_input`, `20261016100000`) | **Recorded, not changed.** The prior period is the period labelled one year earlier; no explicit prior-period link or date contiguity is checked. Correct for consecutive 12-month periods, including non-calendar ones; **not** proven for a changed year-end or a short or long period. **Owner decision**: an explicit link, or a contiguity check that blocks otherwise. This needs a reviewed server change |
| `deriveReportingPeriod` calendar fallback (`reportingPeriod.ts`) | Already flagged `CALENDAR_YEAR_ASSUMED`, so it requires confirmation. Left as is |
| `ClientSummaryPanel` payment dates by calendar year | In the Tanzania pack (a withheld stage). Recorded only |

## 3. Separation of concerns

- **Confirmed defects (fixed here):** 2, 3, 4, 9, 12, 15 and evidence calendar dates. Also, from the commercial milestone: the sealed-report edition identity (`0f5c205`).
- **Configuration requirements:** custom SMTP; enquiry email secrets; staff and commercial-admin enrolment; applying `reporting-r5` then `commercial-c1`; deploying two functions; Publish (see the Lovable checklist).
- **Owner decisions:** the comparative-period link (above); an in-app activation screen; whether `manager` and `triage_agent` should differ in power; the internal notification address.
- **External professional review (release requirements):** legal review of the terms and privacy pages before paid go-live; independent accounting validation of the financial-reporting pilot. Accounting coverage stays labelled *not independently validated*.
