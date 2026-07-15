# SAFF Architecture v3.1 — Final Amendment
## Pre-Implementation Manifest

**Status:** APPROVED FOR IMPLEMENTATION  
**Supersedes:** Architecture v3 (2026-07-14)  
**Amendments applied:** 12 corrections listed in directive  
**Frozen files (content unchanged):** `Hero.tsx`, `Header.tsx`, `Features.tsx`, `copy.ts`, `index.css`  
**Frozen logic (unchanged):** `deriveWorkspaceState.ts` logic paths 1–14, `useWorkspaceData.ts`, 16 workspace tests

---

## PART 1 — FINAL ROUTE MAP

### 1.1 Canonical Routes (authoritative)

```
PUBLIC
  /                         Landing
  /auth                     Authentication

AUTHENTICATED — PLATFORM
  /command                  Command Center  (firm-level only)
  /companies                Company Directory
  /settings                 Platform Settings

AUTHENTICATED — ENGAGEMENT
  /workspace/:companyId/:periodYear                    Workspace Overview
  /workspace/:companyId/:periodYear/prepare            Stage 1: Prepare Data
  /workspace/:companyId/:periodYear/reconcile          Stage 2: Reconcile
  /workspace/:companyId/:periodYear/statements         Stage 3: Prepare Statements
  /workspace/:companyId/:periodYear/tax                Stage 4: Compute Tax
  /workspace/:companyId/:periodYear/compliance         Stage 5: Compliance Review
  /workspace/:companyId/:periodYear/filing             Stage 6: Prepare Filing
  /workspace/:companyId/:periodYear/monitor            Monitor (always available)
```

**Sequencing note:** Compliance precedes Filing. Findings are resolved and evidence is gathered (Stage 5) before the filing package is assembled (Stage 6).

### 1.2 Compatibility Redirects (Phase A, permanent)

| Old Route | Redirect To | HTTP |
|-----------|-------------|------|
| `/dashboard` | `/command` | 301 |
| `/workspace/:cId/:year/safisha` | `/workspace/:cId/:year/prepare` | 301 |
| `/workspace/:cId/:year/hesabu` | `/workspace/:cId/:year/statements` | 301 |
| `/workspace/:cId/:year/kinga` | `/workspace/:cId/:year/tax` | 301 |
| `/workspace/:cId/:year/analytics` | `/workspace/:cId/:year/monitor` | 301 |
| `/workspace/:cId/:year/issues` | `/workspace/:cId/:year/compliance` | 301 |
| `/uploads/status` | `/workspace` (or last-used engagement) | 301 |

**Note on `/filing`:** The `/filing` route slug is unchanged in the App.tsx route. Its label changes from "FILING" to "Prepare Filing". No redirect needed.

### 1.3 Mission Slug Map (deriveWorkspaceState internal keys)

| Current Internal Slug | New Internal Slug | Label Change | href Change |
|----------------------|------------------|--------------|-------------|
| `safisha` | `prepare` | "SAFISHA" → "Prepare Data" | `.../safisha` → `.../prepare` |
| *(new)* | `reconcile` | — → "Reconcile" | — → `.../reconcile` |
| `hesabu` | `statements` | "HESABU" → "Prepare Statements" | `.../hesabu` → `.../statements` |
| `kinga` | `tax` | "KINGA" → "Compute Tax" | `.../kinga` → `.../tax` |
| *(new)* | `compliance` | — → "Compliance Review" | — → `.../compliance` |
| `filing` | `filing` | "FILING" → "Prepare Filing" | unchanged |
| `analytics` | `monitor` | "ANALYTICS" → "Monitor" | `.../analytics` → `.../monitor` |

**`deriveWorkspaceState.ts` change scope (Phase A):** Labels and hrefs only. The 14 path conditions, gate logic, and `WorkspaceData` type are unchanged. The `missions` object gains two new keys (`reconcile`, `compliance`) and drops zero keys; existing keys are renamed. Tests update slug string assertions only.

---

## PART 2 — STAGE OWNERSHIP MATRIX

Each row defines: what question the stage answers, what DB state gates entry, what DB state gates exit, and which role is responsible.

| # | Route Slug | Stage Name | Primary Question | Entry Gate | Exit Gate | Responsible Role |
|---|-----------|-----------|-----------------|------------|-----------|-----------------|
| 1 | `prepare` | Prepare Data | Is my financial data complete and classified? | Company + period selected | All accounts classified; hesabu DQC assertions pass | Preparer |
| 2 | `reconcile` | Reconcile | Do my records agree? | Stage 1 complete | EFDMS gaps within materiality OR not-applicable; all proposed AJEs approved | Preparer / Reviewer |
| 3 | `statements` | Prepare Statements | Are my financial statements true and fair? | Stage 2 complete | `statement_sign_offs.approver_signed_at IS NOT NULL` | Preparer → Approver |
| 4 | `tax` | Compute Tax | What is the corporate tax position? | Stage 3 signed | Tax computation committed + partner sign-off | Partner |
| 5 | `compliance` | Compliance Review | Are all findings resolved and am I audit-ready? | Stage 4 signed | All `evidence_requests` resolved; audit readiness checklist complete | Partner / Reviewer |
| 6 | `filing` | Prepare Filing | Is the filing package complete? | Stage 5 complete | `TRAFilingChecklist` all items checked | Preparer |
| — | `monitor` | Monitor | How is the business performing? | Stage 1 started | None (ongoing) | Any role |

### 2.1 Statements Internal State Machine

The Statements stage does not collapse to a boolean. It progresses through six named states:

```
DRAFT STATEMENTS
  ↓  FS renderer produces SFP/P&L/SCF/SOCIE
DRAFT VALIDATION
  ↓  hesabu-validate runs H-01 to H-12
TAX ADJUSTMENTS PENDING          ← if kinga-tax-engine has proposed unresolved AJEs
  ↓  User returns to Reconcile, approves AJEs
FINAL STATEMENTS
  ↓  FS renderer re-runs on post-AJE data
FINAL VALIDATION
  ↓  hesabu-validate passes all H-01 to H-12 on final version
SIGN-OFF
  ↓  preparer_signed_at (required) → approver_signed_at (required)
COMPLETE
```

**DB signals for each state:**

| State | DB Signal |
|-------|-----------|
| Draft Statements | Upload exists; FS export triggered at least once |
| Draft Validation | `hesabu_validations` row exists for current `upload_id` |
| Tax Adjustments Pending | `adjusting_journal_entries` rows with `status = 'draft'` exist for this period, proposed by kinga-tax-engine |
| Final Statements | No draft AJEs pending; FS export re-run after last AJE approval |
| Final Validation | `hesabu_validations.gate_satisfied = true` on the post-AJE version |
| Sign-Off | `statement_sign_offs.preparer_signed_at IS NOT NULL` |
| Complete | `statement_sign_offs.approver_signed_at IS NOT NULL` |

**Boundary rule:** FS Renderer (ExportStatements) generates statements. hesabu-validate validates them. These are two distinct operations on the same stage — do not merge them into one button or one status.

### 2.2 Tax Stage — AJE Proposal Protocol

When kinga-tax-engine runs, it may propose period-end adjusting journal entries (deferred tax provision, CIT provision). These entries are:

- **Proposed by:** kinga-tax-engine (Stage 4 — Tax)
- **Visible read-only in:** Stage 4 Tax panel (proposed state, not actionable here)
- **Reviewed and posted by:** AdjustingJournalPanel in Stage 2 — Reconcile
- **Effect on Stage 3:** If Tax proposes new AJEs after statements are signed, Stage 3 reverts to "Tax Adjustments Pending" until Reconcile approves and statements are re-exported

This creates an intentional loop: Tax → Reconcile (approve AJEs) → Statements (re-export + re-validate + re-sign). The loop is correct professional accounting workflow.

---

## PART 3 — PANEL OWNERSHIP MATRIX

Definitive home for every component. Appears in exactly one stage. No duplicates.

### Stage 1 — Prepare Data

| Component | Current File | Stage 1 Label | Move? |
|-----------|-------------|---------------|-------|
| SafishaGate (TrialBalanceUpload) | SafishaWorkspace | Upload Financial Data | KEEP (relabel) |
| EmptyCertificationState | SafishaWorkspace | (empty state only) | KEEP |
| CertificationHeader | SafishaWorkspace | Data Certification | KEEP |
| CertificationSummaryStrip | SafishaWorkspace | Certification Summary | KEEP |
| TrialBalanceIntegrityCard | SafishaWorkspace | Trial Balance Integrity | KEEP |
| BalanceSheetEquationCard | SafishaWorkspace | Balance Sheet Equation | KEEP |
| ClassificationBreakdown | SafishaWorkspace | Account Classifications | KEEP |
| AccountReviewPanel | SafishaWorkspace | Review Accounts | KEEP |
| ValidationReport | SafishaWorkspace | Data Quality Report | KEEP |
| UploadsStatusPanel | SafishaWorkspace | Upload History | KEEP (secondary) |
| AccountMappingModal | SafishaWorkspace | Map Accounts | KEEP (modal trigger) |

### Stage 2 — Reconcile

| Component | Current File | Stage 2 Label | Move? |
|-----------|-------------|---------------|-------|
| EFDMSReconciliationPanel | SafishaWorkspace | EFDMS Reconciliation | MOVE from prepare |
| AdjustingJournalPanel | KingaWorkspace (tab: aje) | Adjusting Journals | MOVE from tax |

**AdjustingJournalPanel ownership boundary:**
- Tax engine: proposes AJEs (inserts with `status = 'draft'`, `proposed_by = 'kinga-tax-engine'`)
- Reconcile workspace: surfaces all draft AJEs for review; user approves or reverses
- Write authority: AdjustingJournalPanel performs the `.update({ status: "approved" })` call — this is correct and stays unchanged. Only the stage housing it changes.

### Stage 3 — Prepare Statements

| Component | Current File | Stage 3 Label | Move? |
|-----------|-------------|---------------|-------|
| ExportStatements | FilingWorkspace | Generate Financial Statements | MOVE from filing |
| HesabuAssurancePanel | HesabuWorkspace | Statement Assurance (H-01..H-12) | KEEP (relabel) |
| PeriodClosingBalancesPanel | HesabuWorkspace | Closing Balances | KEEP |

**CapitalAllowancesRegister: remains in Stage 4 (Tax → Workpapers). Not in Stage 3.**

### Stage 4 — Compute Tax

| Component | Current File | Stage 4 Tab | Stage 4 Label | Move? |
|-----------|-------------|-------------|---------------|-------|
| KingaTaxPanel | KingaWorkspace | Computation | Corporate Income Tax | KEEP (relabel) |
| KingaFindingsPanel | KingaWorkspace + IssuesWorkspace | Findings | Tax Findings | KEEP — remove from Issues |
| AddBacksWorkpaper | KingaWorkspace (workpapers tab) | Workpapers | Add-backs Schedule | KEEP |
| ThinCapWorkpaper | KingaWorkspace (workpapers tab) | Workpapers | Thin Capitalisation (ITA s.12(2)) | KEEP |
| TransferPricingPanel | KingaWorkspace (workpapers tab) | Workpapers | Transfer Pricing | KEEP |
| CapitalAllowancesRegister | KingaWorkspace (workpapers tab) | Workpapers | Capital Allowances Register | KEEP — do not move |
| KingaComparativePanel | KingaWorkspace | Comparative | Year-on-Year | KEEP |

**Stage 4 tab structure:**
```
[Computation] [Findings] [Workpapers ▼] [Comparative]
                          └─ Add-backs
                          └─ Thin Cap
                          └─ Transfer Pricing
                          └─ Capital Allowances
```

### Stage 5 — Compliance Review

| Component | Current File | Stage 5 Label | Move? |
|-----------|-------------|---------------|-------|
| TRAAuditReadinessPanel | FilingWorkspace | Audit Readiness Checklist | MOVE from filing |
| EvidenceRequestPanel | (legacy Dashboard) | Evidence Requests | SURFACE here |
| ClientSummaryPanel | FilingWorkspace | Client Summary | MOVE from filing |
| ComplianceScorecard | AnalyticsWorkspace | Compliance Score | MOVE from analytics |
| KingaFindingsPanel | *(read-only reference)* | Findings Summary | READ-ONLY view only — primary home is Stage 4 |

**Note on KingaFindingsPanel in Compliance:** Compliance shows findings in read-only summary form to provide context for evidence requests. The authoritative interactive panel remains in Stage 4. Do not duplicate the full component — use a read-only subset or a summary card.

**Findings, evidence requests, exceptions, remediation are NOT deleted.** They are consolidated here in Stage 5.

### Stage 6 — Prepare Filing

| Component | Current File | Stage 6 Label | Move? |
|-----------|-------------|---------------|-------|
| NoteSynth | FilingWorkspace | Disclosure Notes | KEEP |
| MgmtLetterPanel | FilingWorkspace | Management Letter | KEEP |
| generateTaxComputationPDF | (KingaTaxPanel action) | Tax Computation PDF | SURFACE as named tab |
| TRAFilingChecklist | FilingWorkspace | Filing Checklist | KEEP |
| FilingCalendarPanel | AnalyticsWorkspace | Deadline Calendar | MOVE from analytics |
| PaymentLedgerPanel | AnalyticsWorkspace | Payments | MOVE from analytics |

**ExportStatements moves to Stage 3 (Statements) — NOT Stage 6.**

### Monitor (always available)

| Component | Current File | Monitor Label | Move? |
|-----------|-------------|---------------|-------|
| MaonoDashboard | AnalyticsWorkspace | Business Monitor | KEEP (relabel) |
| BudgetEntryPanel | (various) | Budget Management | MOVE here |
| MaterialitySettings | (various) | → Platform Settings only | MOVE to /settings |

### Command Center (/command)

| Component | Source | Command Center Label | Notes |
|-----------|--------|----------------------|-------|
| FirmDashboardPanel | AnalyticsWorkspace | Firm Dashboard | MOVE from analytics |
| ComplianceScorecard (widget) | AnalyticsWorkspace | Compliance Score (per-engagement card) | Read-only widget; full panel stays in Stage 5 |
| EngagementStatusGrid | (new) | Engagement Status | New component — shows all engagements with WorkflowProgress mini |
| FilingCalendarPanel (widget) | Stage 6 | Upcoming Deadlines | Read-only widget only; full panel stays in Stage 6 |
| PeriodCloseManager | (various) | Period Management | MOVE to /settings |

---

## PART 4 — COMPONENT INVENTORY: WorkflowProgress and WorkspaceOverview

### 4.1 WorkflowProgress Component (canonical, one instance only)

**New component:** `src/components/workspace/WorkflowProgress.tsx`

Renders a linear stage-progress indicator for one engagement. Shows all 7 stages (+ monitor) with their current status. Does not render any CTAs.

```
Prepare Data → Reconcile → Statements → Tax → Compliance → Filing → Monitor
[complete]     [complete]  [in_progress] [locked]  [locked]  [locked] [available]
```

**Props:**
```typescript
interface WorkflowProgressProps {
  missions: Record<MissionSlug, { status: MissionStatus; label: string; href: string; blocker?: string }>;
  loading?: boolean;
}
```

**Locked stage display:** Each locked stage shows a tooltip (or inline sub-text on hover/focus) with:
- Reason: why it is locked
- Prerequisite: which stage must be completed
- Responsible role: who must act
- Action: what they must do

No click-then-error. Locked tabs are `pointer-events-none` but show the reason inline when the user attempts to navigate.

**Appears exactly once:** In WorkspaceOverview. NOT repeated in WorkspaceLayout sub-nav. The WorkspaceLayout sub-nav uses compact tab-only labels (no StatusDots, no redundant indicators).

### 4.2 WorkspaceOverview — Content Specification (final)

**Route:** `/workspace/:companyId/:periodYear`  
**Renders exactly:**

```
1. WorkflowProgress          — stage status strip (no CTAs)
2. NextActionCard            — ONE primary CTA: the single next required action
3. BlockingAlerts            — up to 3, shown only if blocking conditions exist
4. RecentEvents              — up to 5 chronological engagement events
```

**Renders nothing else.** Remove:
- Context header (already in WorkspaceLayout header — no duplication)
- Mission table with Open links
- Uploads list / "View all uploads" link
- Engine panel components
- Repeated explanatory text
- Multiple CTAs or navigation shortcuts

### 4.3 NextActionCard — Single Dominant CTA

Displays the ONE thing the user must do next. Derived from `workspaceState.nextAction`.

```typescript
interface NextAction {
  label: string;        // "Sign Off Financial Statements"
  description: string;  // "Approver signature required before tax can be computed"
  href: string;         // "/workspace/:cId/:year/statements"
  role?: string;        // "Required: Partner or above"
  blockedBy?: string;   // null if actionable
}
```

If `nextAction.blockedBy` is set, the button is disabled and the blocker is shown inline. No navigation occurs. No error toast.

---

## PART 5 — HEADER MODEL

### 5.1 Two Semantic Header Modes

```
PublicHeader    = existing Header.tsx (FROZEN — do not modify)
WorkspaceHeader = new component: src/components/workspace/WorkspaceHeader.tsx
```

**PublicHeader (Header.tsx — frozen):** Used on `/`, `/auth`. Contains logo, marketing navigation anchors, and Sign In CTA. Marketing content only. Must never appear inside authenticated workspace routes.

**WorkspaceHeader (new):** Used on all `/workspace/*` and `/command` routes. Already partially implemented in `WorkspaceLayout.tsx` lines 103–146. Extract into a standalone component.

WorkspaceHeader contains:
- SaffLogo (variant="header")
- Company name + FY{periodYear} breadcrumb
- Role badge (from `firm_members.role`)
- NotificationBell
- Settings link + Profile avatar

WorkspaceHeader does NOT contain:
- Marketing navigation anchors (Features, Pricing, etc.)
- "Why SAFF?" or product marketing copy
- External links

**Implementation:** Extract the `<header>` block from `WorkspaceLayout.tsx` lines 103–146 into `WorkspaceHeader.tsx`. WorkspaceLayout imports and renders it. No change to Header.tsx.

### 5.2 Engine Name Display Rule

Engine names (SAFISHA, HESABU, KINGA, MAONO, FILING) may appear:

**Allowed:**
- As a small technical caption in diagnostics panels: `<span className="text-xs text-muted-foreground font-mono">engine: safisha-ingest</span>`
- In audit log entries
- In edge function error messages surfaced to technical users
- In this architecture document

**Not allowed:**
- As primary navigation labels (sidebar, tabs, breadcrumbs)
- As page titles or section headings
- In marketing copy or client-facing documents
- As the label on any button or CTA

---

## PART 6 — DELETION MANIFEST (file-by-file)

### DELETE

| File | Reason |
|------|--------|
| `src/pages/workspace/IssuesWorkspace.tsx` | Dead route. KingaFindingsPanel canonical home is Stage 4. Nothing navigates to `/issues`. |
| Route `<Route path="issues" element={<IssuesWorkspace />} />` in `src/App.tsx` | Corresponding route for deleted file |

### RENAME / MOVE (file identity preserved)

| Current Path | New Path | Reason |
|-------------|---------|--------|
| `src/pages/workspace/SafishaWorkspace.tsx` | `src/pages/workspace/PrepareWorkspace.tsx` | Route slug rename: safisha → prepare |
| `src/pages/workspace/HesabuWorkspace.tsx` | `src/pages/workspace/StatementsWorkspace.tsx` | Route slug rename: hesabu → statements |
| `src/pages/workspace/KingaWorkspace.tsx` | `src/pages/workspace/TaxWorkspace.tsx` | Route slug rename: kinga → tax |
| `src/pages/workspace/FilingWorkspace.tsx` | Stays `FilingWorkspace.tsx` | Route slug unchanged |
| `src/pages/workspace/AnalyticsWorkspace.tsx` | `src/pages/workspace/MonitorWorkspace.tsx` | Route slug rename: analytics → monitor |

### NEW FILES

| File | Purpose |
|------|---------|
| `src/pages/workspace/ReconcileWorkspace.tsx` | Stage 2: Reconcile (new stage) |
| `src/pages/workspace/ComplianceWorkspace.tsx` | Stage 5: Compliance Review (new stage) |
| `src/pages/command/CommandCenter.tsx` | `/command` route — firm-level overview |
| `src/components/workspace/WorkflowProgress.tsx` | Canonical stage-progress strip (one instance) |
| `src/components/workspace/NextActionCard.tsx` | Single dominant CTA derived from nextAction |
| `src/components/workspace/BlockingAlerts.tsx` | Up to 3 blocking condition alerts |
| `src/components/workspace/RecentEvents.tsx` | Up to 5 chronological engagement events |
| `src/components/workspace/WorkspaceHeader.tsx` | Extracted from WorkspaceLayout — WorkspaceHeader semantic mode |
| `src/components/workspace/LockedStageCard.tsx` | Locked stage explanation: reason + prerequisite + role + action |

### COMPONENT MOVES (same file, different parent page)

| Component | From Page | To Page | Phase |
|-----------|----------|---------|-------|
| `EFDMSReconciliationPanel` | PrepareWorkspace | ReconcileWorkspace | C |
| `AdjustingJournalPanel` | TaxWorkspace | ReconcileWorkspace | C |
| `ExportStatements` | FilingWorkspace | StatementsWorkspace | C |
| `TRAAuditReadinessPanel` | FilingWorkspace | ComplianceWorkspace | C |
| `ClientSummaryPanel` | FilingWorkspace | ComplianceWorkspace | C |
| `EvidenceRequestPanel` | (legacy) | ComplianceWorkspace | C |
| `ComplianceScorecard` | MonitorWorkspace | ComplianceWorkspace (primary) + CommandCenter (widget) | C |
| `FilingCalendarPanel` | MonitorWorkspace | FilingWorkspace | C |
| `PaymentLedgerPanel` | MonitorWorkspace | FilingWorkspace | C |
| `FirmDashboardPanel` | MonitorWorkspace | CommandCenter | C |
| `BudgetEntryPanel` | (various) | MonitorWorkspace | C |
| `MaterialitySettings` | (various) | `/settings` | C |

### PRESERVE (unchanged, no action)

| File | Reason |
|------|--------|
| `src/components/Hero.tsx` | Frozen |
| `src/components/Header.tsx` | Frozen — becomes PublicHeader by name only |
| `src/components/Features.tsx` | Frozen |
| `src/constants/copy.ts` | Frozen |
| `src/index.css` | Frozen |
| `src/lib/workspace/deriveWorkspaceState.ts` | Logic paths frozen — Phase A changes labels/slugs only |
| `src/hooks/useWorkspaceData.ts` | Frozen — authoritative DB reads unchanged |
| `src/lib/workspace/deriveWorkspaceState.test.ts` | Phase A: update slug string assertions only |
| `src/components/workspace/WorkspaceGate.tsx` | Unchanged — used across all stage pages |
| `src/contexts/WorkspaceContext.tsx` | Unchanged |
| All supabase/functions/ | Unchanged — implementation layer |
| All supabase/migrations/ | Unchanged — deployment concern |

### CONTENT REMOVAL (within existing files)

| File | What to Remove | Phase |
|------|---------------|-------|
| `WorkspaceOverview.tsx` | Mission table with Open links; "View all uploads" link; any secondary CTA buttons | C |
| `WorkspaceLayout.tsx` | StatusDot from sub-nav tabs (moved to WorkflowProgress); engine name labels (replace with accounting labels); extract `<header>` block → WorkspaceHeader | B |
| `MonitorWorkspace.tsx` (after rename) | FilingCalendarPanel; PaymentLedgerPanel; FirmDashboardPanel; ComplianceScorecard | C |
| `FilingWorkspace.tsx` | TRAAuditReadinessPanel; ClientSummaryPanel; ExportStatements | C |
| `TaxWorkspace.tsx` (after rename) | AdjustingJournalPanel (tab: aje) | C |

---

## PART 7 — MIGRATION AND COMPATIBILITY STRATEGY

### 7.1 Phase A — Labels, Metadata, Compatibility Redirects

**Scope:** Zero business-logic changes. Zero component moves. Zero new pages.

Changes:
1. `deriveWorkspaceState.ts`: Update `label` strings and `href` slugs for existing missions. Add `reconcile` and `compliance` mission slots with status `locked` (initial implementation — no gate logic yet).
2. `WorkspaceLayout.tsx`: Replace engine name tab labels with accounting labels. Replace engine icons with accounting-appropriate icons.
3. `App.tsx`: Add compatibility redirects for old routes. Add new routes for `reconcile` and `compliance` pointing to placeholder pages.
4. Test updates: Replace slug string assertions (`"safisha"` → `"prepare"`) in the 16 tests. No logic assertion changes.

**Acceptance:** All 16 tests pass. Build passes. Old URLs redirect. New URLs resolve.

### 7.2 Phase B — WorkflowProgress, Route-State Projection, Locked Stage Display

**Scope:** New UI components. No panel moves. No new DB reads.

Changes:
1. Create `WorkflowProgress.tsx` — stage-progress strip derived from `workspaceState.missions`.
2. Create `NextActionCard.tsx` — derives ONE CTA from `workspaceState.nextAction`.
3. Create `LockedStageCard.tsx` — displays reason, prerequisite, role, action for locked stages.
4. Refactor `WorkspaceOverview.tsx` to render only: WorkflowProgress + NextActionCard + BlockingAlerts + RecentEvents.
5. Remove StatusDots from sub-nav tabs in `WorkspaceLayout.tsx`. Sub-nav tabs remain as navigation only.
6. Create `ReconcileWorkspace.tsx` (placeholder — panel moves in Phase C).
7. Create `ComplianceWorkspace.tsx` (placeholder — panel moves in Phase C).
8. Extend `deriveWorkspaceState.ts` missions with `reconcile` and `compliance` gate logic.

**Acceptance:** WorkflowProgress appears exactly once in WorkspaceOverview. No StatusDot in sub-nav. WorkspaceOverview has exactly one `<Button variant="default">`. Locked stage shows reason/role/action without click-then-error.

### 7.3 Phase C — Panel Re-Homing

**Scope:** Move components between page files. No component logic changes. No new DB reads.

Changes (in order):
1. Extract `<header>` block from `WorkspaceLayout.tsx` → `WorkspaceHeader.tsx`.
2. Move `EFDMSReconciliationPanel` from PrepareWorkspace → ReconcileWorkspace.
3. Move `AdjustingJournalPanel` from TaxWorkspace → ReconcileWorkspace.
4. Move `ExportStatements` from FilingWorkspace → StatementsWorkspace.
5. Move `TRAAuditReadinessPanel` + `ClientSummaryPanel` from FilingWorkspace → ComplianceWorkspace.
6. Surface `EvidenceRequestPanel` in ComplianceWorkspace.
7. Move `FilingCalendarPanel` + `PaymentLedgerPanel` from MonitorWorkspace → FilingWorkspace.
8. Move `FirmDashboardPanel` from MonitorWorkspace → CommandCenter.
9. Move `ComplianceScorecard` from MonitorWorkspace → ComplianceWorkspace (primary) + widget reference in CommandCenter.
10. Create `CommandCenter.tsx` at `/command` route.
11. Clean up MonitorWorkspace — retains only MaonoDashboard + BudgetEntryPanel.
12. Remove residual content from WorkspaceOverview (mission table, uploads list).

**Acceptance:** Each panel appears in exactly one stage page. AnalyticsWorkspace (now MonitorWorkspace) contains only Maono + Budget. FilingWorkspace no longer contains audit readiness or client summary. PrepareWorkspace no longer contains EFDMS reconciliation.

### 7.4 Phase D — Header Consolidation, Landing Taxonomy Removal, Regression Tests

**Scope:** Header semantics, landing page copy audit, full route regression.

Changes:
1. Verify `Header.tsx` (PublicHeader) never renders inside workspace routes. Add guard.
2. Verify `WorkspaceHeader.tsx` never renders marketing navigation anchors.
3. Audit `Features.tsx` (frozen — read only): confirm no engine taxonomy tables are in the frozen content. Document any needed changes for a future unfreeze.
4. Add route regression test suite (see Part 8).
5. Run full build + 16 workspace tests + new tests.

**Note on frozen files:** `Features.tsx` and `Hero.tsx` are frozen. If they contain engine taxonomy content that violates Rule 9, document it as a deferred amendment — do not modify in this phase. The user will unfreeze these files when ready.

---

## PART 8 — EXACT ACCEPTANCE TESTS

### 8.1 Route Tests (Phase A)

```typescript
// T-ROUTE-01: Canonical routes resolve
test("GET /command returns authenticated CommandCenter component")
test("GET /workspace/:cId/:year returns WorkspaceOverview")
test("GET /workspace/:cId/:year/prepare returns PrepareWorkspace")
test("GET /workspace/:cId/:year/reconcile returns ReconcileWorkspace")
test("GET /workspace/:cId/:year/statements returns StatementsWorkspace")
test("GET /workspace/:cId/:year/tax returns TaxWorkspace")
test("GET /workspace/:cId/:year/compliance returns ComplianceWorkspace")
test("GET /workspace/:cId/:year/filing returns FilingWorkspace")
test("GET /workspace/:cId/:year/monitor returns MonitorWorkspace")

// T-ROUTE-02: Compatibility redirects
test("GET /dashboard redirects 301 to /command")
test("GET /workspace/:cId/:year/safisha redirects 301 to /workspace/:cId/:year/prepare")
test("GET /workspace/:cId/:year/hesabu redirects 301 to /workspace/:cId/:year/statements")
test("GET /workspace/:cId/:year/kinga redirects 301 to /workspace/:cId/:year/tax")
test("GET /workspace/:cId/:year/analytics redirects 301 to /workspace/:cId/:year/monitor")
test("GET /workspace/:cId/:year/issues redirects 301 to /workspace/:cId/:year/compliance")

// T-ROUTE-03: Deleted routes do not resolve
test("GET /workspace/:cId/:year/issues returns 404 or redirect — not a live page")
```

### 8.2 WorkflowProgress Tests (Phase B)

```typescript
// T-WFP-01: Appears exactly once
test("WorkspaceOverview renders exactly one <WorkflowProgress> instance")
test("WorkspaceLayout does NOT render <WorkflowProgress>")
test("No other page renders <WorkflowProgress>")

// T-WFP-02: Shows all stages
test("WorkflowProgress renders 7 stage items: prepare, reconcile, statements, tax, compliance, filing, monitor")

// T-WFP-03: No CTAs in WorkflowProgress
test("WorkflowProgress renders zero <Button> elements")
test("WorkflowProgress renders zero anchor elements with role=button")
```

### 8.3 WorkspaceOverview Content Tests (Phase B)

```typescript
// T-OVR-01: Exactly one primary CTA
test("WorkspaceOverview renders exactly one <Button variant='default'>")

// T-OVR-02: Removed content is absent
test("WorkspaceOverview does not render mission table (no element with role=table containing mission rows)")
test("WorkspaceOverview does not render 'View all uploads' link")
test("WorkspaceOverview does not render 'Open' links for individual missions")
test("WorkspaceOverview does not render any workspace panel component (KingaTaxPanel, HesabuAssurancePanel, etc.)")

// T-OVR-03: Required content is present
test("WorkspaceOverview renders <WorkflowProgress>")
test("WorkspaceOverview renders <NextActionCard>")
test("WorkspaceOverview renders at most 3 blocking alert elements")
test("WorkspaceOverview renders at most 5 recent event elements")
```

### 8.4 Locked State Tests (Phase B)

```typescript
// T-LOCK-01: Locked stages are non-interactive
test("Locked stage tab has pointer-events-none class")
test("Clicking a locked stage tab does not navigate")
test("Clicking a locked stage tab does not throw an error or toast")

// T-LOCK-02: Locked stages explain themselves
test("Locked stage tab or associated LockedStageCard displays: reason why locked")
test("Locked stage shows: which prerequisite stage must be completed")
test("Locked stage shows: which role must act")
test("Locked stage shows: what action unlocks it")
```

### 8.5 Header Separation Tests (Phase D)

```typescript
// T-HDR-01: PublicHeader not in workspace
test("WorkspaceLayout does not render <Header> (PublicHeader)")
test("No workspace route renders marketing navigation anchors (Features, Pricing, Why SAFF)")

// T-HDR-02: WorkspaceHeader not on public routes
test("Index page does not render <WorkspaceHeader>")
test("Auth page does not render <WorkspaceHeader>")

// T-HDR-03: WorkspaceHeader content
test("WorkspaceHeader renders company name")
test("WorkspaceHeader renders period year")
test("WorkspaceHeader renders NotificationBell")
test("WorkspaceHeader renders settings/profile link")
```

### 8.6 Panel Ownership Tests (Phase C)

```typescript
// T-OWN-01: Each panel in exactly one stage
test("EFDMSReconciliationPanel is rendered only by ReconcileWorkspace")
test("AdjustingJournalPanel is rendered only by ReconcileWorkspace")
test("ExportStatements is rendered only by StatementsWorkspace")
test("KingaTaxPanel is rendered only by TaxWorkspace")
test("KingaFindingsPanel is rendered only by TaxWorkspace (no IssuesWorkspace)")
test("CapitalAllowancesRegister is rendered only by TaxWorkspace")
test("TRAAuditReadinessPanel is rendered only by ComplianceWorkspace")
test("ClientSummaryPanel is rendered only by ComplianceWorkspace")
test("FilingCalendarPanel is rendered only by FilingWorkspace")
test("PaymentLedgerPanel is rendered only by FilingWorkspace")
test("FirmDashboardPanel is rendered only by CommandCenter")
test("MaonoDashboard is rendered only by MonitorWorkspace")

// T-OWN-02: Deleted pages are gone
test("IssuesWorkspace.tsx does not exist in src/pages/workspace/")
test("No import of IssuesWorkspace exists in App.tsx")
```

### 8.7 Engine Name Visibility Tests (Phase A/B)

```typescript
// T-ENG-01: Engine names not in primary navigation
test("WorkspaceLayout sub-nav tabs do not display text: SAFISHA, HESABU, KINGA, FILING, ANALYTICS")
test("WorkspaceOverview does not display text: SAFISHA, HESABU, KINGA, MAONO in headings or labels")
test("WorkspaceHeader does not display engine names")

// T-ENG-02: Engine names allowed in diagnostics only
// (No automated test — manual review of technical caption contexts)
```

### 8.8 Statements Internal State Tests (Phase B/C)

```typescript
// T-STMT-01: State machine progresses correctly
test("StatementsWorkspace shows 'Draft Statements' state when upload exists but hesabu-validate not run")
test("StatementsWorkspace shows 'Draft Validation' state when hesabu_validations row exists for upload")
test("StatementsWorkspace shows 'Tax Adjustments Pending' when draft AJEs proposed by kinga-tax-engine exist")
test("StatementsWorkspace shows 'Final Validation' when gate_satisfied=true on post-AJE upload")
test("StatementsWorkspace shows 'Sign-Off' state when hesabu gate satisfied and preparer_signed_at null")
test("StatementsWorkspace shows 'Complete' state when approver_signed_at IS NOT NULL")

// T-STMT-02: Generation and validation are separate operations
test("StatementsWorkspace renders ExportStatements and HesabuAssurancePanel as separate UI sections")
test("Clicking 'Generate Statements' does not simultaneously trigger hesabu-validate")
test("Clicking 'Run Assurance' does not re-render the statement export")
```

### 8.9 deriveWorkspaceState Tests (Phase A — update existing 16 tests)

The 16 existing tests require these string assertion changes only:

| Test file assertion | Old value | New value |
|--------------------|-----------|-----------| 
| Mission key references | `missions.safisha` | `missions.prepare` |
| Mission key references | `missions.hesabu` | `missions.statements` |
| Mission key references | `missions.kinga` | `missions.tax` |
| Mission key references | `missions.analytics` | `missions.monitor` |
| href assertions | `.../safisha` | `.../prepare` |
| href assertions | `.../hesabu` | `.../statements` |
| href assertions | `.../kinga` | `.../tax` |
| href assertions | `.../analytics` | `.../monitor` |
| Label assertions | `"SAFISHA"` | `"Prepare Data"` |
| Label assertions | `"HESABU"` | `"Prepare Statements"` |
| Label assertions | `"KINGA"` | `"Compute Tax"` |
| Label assertions | `"FILING"` | `"Prepare Filing"` |
| Label assertions | `"ANALYTICS"` | `"Monitor"` |

**No logic assertion changes.** Gate conditions, path counts, status values, and `nextAction` structure are unchanged.

---

## PART 9 — SUMMARY OF AMENDMENTS FROM V3

| V3 Decision | V3.1 Correction | Reference |
|-------------|----------------|-----------|
| CapitalAllowancesRegister → move to Statements | CapitalAllowancesRegister stays in Tax → Workpapers | §6 |
| ExportStatements in Filing | ExportStatements moves to Statements | §6 |
| Compliance after Filing | Compliance BEFORE Filing (canonical order) | §1 |
| Single boolean statement status | 6-state internal machine (Draft → Sign-Off) | §3 |
| No explicit WorkflowProgress spec | Canonical WorkflowProgress component, one instance, no CTAs | §4 |
| WorkspaceOverview with mission table + Open links | WorkspaceOverview: WorkflowProgress + NextActionCard + 3 alerts + 5 events only | §7 |
| One header component | Two semantic modes: PublicHeader (frozen Header.tsx) + WorkspaceHeader (new) | §9 |
| AdjustingJournalPanel: move to Reconcile entirely | Tax PROPOSES AJEs; Reconcile REVIEWS/POSTS; AdjustingJournalPanel in Reconcile | §6 |
| Findings as Compliance-only | Stage 4 KingaFindingsPanel is primary; Compliance shows read-only summary | §6 |
| FirmDashboardPanel in Monitor | FirmDashboardPanel moves to Command Center | §6 |
| Marketing: outcomes only (already correct) | Confirmed. Engine taxonomy tables not in marketing copy | §8 |
| Multiple CTAs on overview | One dominant CTA (NextActionCard). No inline Open/View All links | §5,§7 |

---

*End of Architecture v3.1 — Final Amendment.*  
*Implementation begins at Phase A.*
