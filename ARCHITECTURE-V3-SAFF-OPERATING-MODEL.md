# SAFF Architecture v3 — Professional Accounting Workspace
## Operating Model Redesign

**Status:** Design document — do not implement until approved  
**Date:** 2026-07-14  
**Supersedes:** Architecture v2.3 (engine collection model)

---

## 1. Design Mandate

Transform SAFF from an engine collection into a professional accounting workspace.

The current model exposes implementation:  
`/workspace/:cId/:year/safisha` → `SAFISHA` → `KINGA` → `FILING`

The v3 model exposes profession:  
`/workspace/:cId/:year/prepare` → `Prepare Data` → `Compute Tax` → `Prepare Filing`

The user must never ask "Which engine do I open?"  
The software must always answer "What is the next professional step?"

---

## 2. Permanent Design Rules (Applied)

| Rule | Concrete Decision |
|------|-------------------|
| 1 — Workspace is the product | Engines become invisible. No engine name appears in navigation, headings, or primary UI |
| 2 — One question per screen | Each stage answers exactly one question. All components within a stage serve that question |
| 3 — Navigation follows accounting | 7 stages follow the accounting lifecycle, not the technology stack |
| 4 — One primary CTA | Each stage has exactly one primary action button; all others are secondary or disabled |
| 5 — No duplicated information | KingaFindingsPanel removed from IssuesWorkspace; FilingCalendarPanel removed from Analytics |
| 6 — Accounting language | SAFISHA → Prepare Data. HESABU → Prepare Statements. KINGA → Compute Tax. FILING → Prepare Filing. ANALYTICS → Monitor |
| 7 — Dashboard = command center | WorkspaceOverview becomes the command center answering: where am I, what is blocked, what is next |
| 8 — Blocked missions explain why | Every locked stage shows: why locked, who must act, what unlocks it |
| 9 — Landing sells outcomes | No engine names on landing page (already enforced — do not regress) |
| 10 — IA first | This document. Then implementation. |

---

## 3. Information Architecture

### 3.1 Top-Level Structure

```
SAFF Platform
│
├── PUBLIC
│   └── /                    Landing (Why trust this platform?)
│       └── /auth            Authentication
│
└── AUTHENTICATED
    ├── /command              Command Center (What is the next professional step?)
    ├── /companies            Company Directory
    ├── /settings             Platform Settings
    └── /workspace/:cId/:year Engagement Workspace
        │
        ├── /                 Workspace Overview (engagement status summary)
        ├── /prepare          Stage 1: Prepare Data
        ├── /reconcile        Stage 2: Reconcile
        ├── /statements       Stage 3: Prepare Statements
        ├── /tax              Stage 4: Compute Tax
        ├── /filing           Stage 5: Prepare Filing
        ├── /compliance       Stage 6: Compliance Review
        └── /monitor          Monitor (always available)
```

### 3.2 Navigation Tree

**Platform navigation (top bar, always visible):**
- [SAFF Logo] → /command
- Companies → /companies
- [NotificationBell]
- [User avatar] → /settings

**Workspace sidebar (visible inside /workspace/:cId/:year):**
```
[Company Name] [Period Year]
─────────────────────────────
● Prepare Data          [status]
● Reconcile             [status]
● Prepare Statements    [status]
● Compute Tax           [status]
● Prepare Filing        [status]
● Compliance Review     [status]
─────────────────────────────
  Monitor               [always]
```

Status indicators: NOT STARTED / IN PROGRESS / REVIEW REQUIRED / BLOCKED / COMPLETE / LOCKED  
Locked items show inline tooltip: "Locked — [reason] — [who must act]"

---

## 4. Stage Definitions

### STAGE 1 — Prepare Data
**Route:** `/workspace/:cId/:year/prepare`  
**Mission slug (internal):** `prepare` (replaces `safisha`)  
**Primary question:** Is my financial data complete and classified?

**Primary CTA states (one at a time):**
1. `Upload Trial Balance` — when no upload exists
2. `Review Account Classifications` — when upload done, accounts unclassified
3. `Import EFDMS Data` — when TB ready, EFDMS not yet imported
4. `Data Ready` (disabled / green) — when all conditions met, advances to Stage 2

**Gate to exit:**  
All accounts classified + DQC assertions passed + (EFDMS imported OR not applicable for this company)

**Components in this stage (in display order):**

| Component | Current Name | Stage 1 Label | Trigger |
|-----------|-------------|---------------|---------|
| SafishaGate | SafishaGate | Upload Financial Data | Always first |
| EmptyCertificationState | EmptyCertificationState | (empty state only) | No upload |
| CertificationHeader | CertificationHeader | Data Certification | After upload |
| CertificationSummaryStrip | CertificationSummaryStrip | Certification Summary | After upload |
| TrialBalanceIntegrityCard | TrialBalanceIntegrityCard | Trial Balance Integrity | After upload |
| BalanceSheetEquationCard | BalanceSheetEquationCard | Balance Sheet Equation | After upload |
| ClassificationBreakdown | ClassificationBreakdown | Account Classification | After upload |
| AccountReviewPanel | AccountReviewPanel | Review Accounts | When review required |
| ValidationReport | ValidationReport | Data Quality Report | After classification |
| UploadsStatusPanel | UploadsStatusPanel | Upload History | Secondary (collapsible) |
| AccountMappingModal | AccountMappingModal | Map Accounts | Triggered from Review |

**Stage 1 does NOT contain:**
- EFDMSReconciliationPanel (moves to Stage 2)
- AdjustingJournalPanel (moves to Stage 2)

---

### STAGE 2 — Reconcile
**Route:** `/workspace/:cId/:year/reconcile`  
**Mission slug (internal):** `reconcile` (new — replaces part of `safisha`)  
**Primary question:** Do my records agree?

**Primary CTA states:**
1. `Import EFDMS Z-Reports` — when no EFDMS data for period
2. `Review EFDMS Gaps` — when gaps exceed materiality threshold
3. `Review Adjusting Journals` — when AJEs proposed but not approved
4. `Approve Journals` — when AJEs ready for sign-off
5. `Reconciliation Complete` (disabled / green) — all gaps within materiality, AJEs approved

**Gate to exit:**  
EFDMS gaps < materiality threshold OR all material gaps have approved AJEs; all proposed AJEs approved

**Components:**

| Component | Current Home | Stage 2 Label |
|-----------|-------------|---------------|
| EFDMSReconciliationPanel | SafishaWorkspace | EFDMS Reconciliation |
| AdjustingJournalPanel | KingaWorkspace (tab) | Adjusting Journals |

**Locked when:** Stage 1 not complete  
**Blocked message:** "Complete data preparation before reconciling."

---

### STAGE 3 — Prepare Statements
**Route:** `/workspace/:cId/:year/statements`  
**Mission slug (internal):** `statements` (replaces `hesabu`)  
**Primary question:** Are my financial statements true and fair?

**Primary CTA states:**
1. `Run Statement Assurance` — when hesabu-validate has not been run for this upload
2. `Review Assurance Findings` — when H-01 to H-12 has failures
3. `Sign Off as Preparer` — when assurance passes, preparer not signed
4. `Sign Off as Approver` — when preparer signed, approver not signed
5. `Statements Signed` (disabled / green) — both signatures obtained

**Gate to exit:**  
`statement_sign_offs.approver_signed_at IS NOT NULL`

**Components (in display order):**

| Component | Current Home | Stage 3 Label |
|-----------|-------------|---------------|
| HesabuAssurancePanel | HesabuWorkspace | Statement Assurance (H-01 to H-12) |
| CapitalAllowancesRegister | KingaWorkspace | Capital Allowances Register |
| PeriodClosingBalancesPanel | HesabuWorkspace | Closing Balances |
| ExportStatements | FilingWorkspace | Export Financial Statements |

**CapitalAllowancesRegister moves here** because capital allowances are a financial statement input (depreciation / WDV), not a tax computation input. They must be finalised before statements are signed.

**Locked when:** Stage 2 not complete  
**Blocked message:** "Complete reconciliation before preparing statements."

---

### STAGE 4 — Compute Tax
**Route:** `/workspace/:cId/:year/tax`  
**Mission slug (internal):** `tax` (replaces `kinga`)  
**Primary question:** What is the corporate tax position?

**Primary CTA states:**
1. `Compute Corporate Tax` — when no committed computation exists for period
2. `Review Tax Findings` — when computation complete, findings unreviewed
3. `Commit Tax Computation` — when findings reviewed
4. `Sign Off Tax Position` — when committed, not signed
5. `Tax Signed Off` (disabled / green) — signed

**Gate to exit:**  
Tax computation committed + partner sign-off recorded

**Sub-navigation within Stage 4 (tabs):**
```
[Tax Computation] [Tax Findings] [Add-backs] [Thin Capitalisation] [Transfer Pricing] [Comparative]
```

These are TABS within one stage page — not separate routes. Tabs are always visible once in Stage 4. User does not need to choose which to open; the primary CTA guides the sequence.

**Components:**

| Component | Current Home | Stage 4 Tab | Stage 4 Label |
|-----------|-------------|-------------|---------------|
| KingaTaxPanel | KingaWorkspace | Tax Computation | Corporate Income Tax |
| KingaFindingsPanel | KingaWorkspace + IssuesWorkspace | Tax Findings | Tax Findings |
| AddBacksWorkpaper | KingaWorkspace | Add-backs | Add-backs Schedule (ITA s.33, s.34, s.65) |
| ThinCapWorkpaper | KingaWorkspace | Thin Capitalisation | Thin Capitalisation (ITA s.12(2)) |
| TransferPricingPanel | KingaWorkspace | Transfer Pricing | Transfer Pricing |
| KingaComparativePanel | KingaWorkspace | Comparative | Year-on-Year Comparison |

**AdjustingJournalPanel removed from this stage** — it moves to Stage 2 (Reconcile).

**Locked when:** Stage 3 (statements) not signed off  
**Blocked message:** "Financial statements must be signed off before computing tax."

---

### STAGE 5 — Prepare Filing
**Route:** `/workspace/:cId/:year/filing`  
**Mission slug (internal):** `filing` (unchanged)  
**Primary question:** Is my filing package complete?

**Primary CTA states:**
1. `Generate Disclosure Notes` — first deliverable
2. `Generate Management Letter` — second deliverable
3. `Generate Tax Computation PDF` — third deliverable
4. `Complete Filing Checklist` — when documents ready, checklist incomplete
5. `Filing Package Ready` (disabled / green) — checklist complete

**Sub-navigation within Stage 5:**
```
[Disclosure Notes] [Management Letter] [Tax Computation PDF] [Filing Checklist] [Deadline Calendar] [Payment Ledger]
```

**Components:**

| Component | Current Home | Stage 5 Label |
|-----------|-------------|---------------|
| NoteSynth | FilingWorkspace | Disclosure Notes |
| MgmtLetterPanel | FilingWorkspace | Management Letter |
| generateTaxComputationPDF | KingaTaxPanel (button) | Tax Computation PDF |
| TRAFilingChecklist | FilingWorkspace | Filing Checklist |
| FilingCalendarPanel | AnalyticsWorkspace | Deadline Calendar |
| PaymentLedgerPanel | AnalyticsWorkspace | Payment Ledger |

**FilingCalendarPanel and PaymentLedgerPanel move from AnalyticsWorkspace** — they are filing logistics, not analytics.  
**TRAAuditReadinessPanel and ClientSummaryPanel move out of this stage** → Stage 6.

**Locked when:** Stage 4 (tax) not signed off  
**Blocked message:** "Tax computation must be signed off before preparing the filing package."

---

### STAGE 6 — Compliance Review
**Route:** `/workspace/:cId/:year/compliance`  
**Mission slug (internal):** `compliance` (replaces `filing` partial + new)  
**Primary question:** Am I ready for a TRA audit?

**Primary CTA states:**
1. `Review Evidence Requests` — when open evidence requests exist
2. `Complete Audit Readiness Checklist` — when evidence resolved, checklist incomplete
3. `Generate Client Summary` — when readiness complete, summary not generated
4. `Compliance Review Complete` (disabled / green)

**Components:**

| Component | Current Home | Stage 6 Label |
|-----------|-------------|---------------|
| TRAAuditReadinessPanel | FilingWorkspace | Audit Readiness |
| EvidenceRequestPanel | (Dashboard/legacy) | Evidence Requests |
| ClientSummaryPanel | FilingWorkspace | Client Summary |
| ComplianceScorecard | AnalyticsWorkspace | Compliance Score |

**ComplianceScorecard also appears** in the Command Center (read-only, per-company card) — not duplicated, just a read-only widget in the Command Center vs full panel here.

---

### MONITOR — Business Monitor
**Route:** `/workspace/:cId/:year/monitor`  
**Mission slug (internal):** `monitor` (replaces `analytics`)  
**Primary question:** How is the business performing?

**No gate — always available once Stage 1 is started.**

**Components:**

| Component | Current Home | Monitor Label |
|-----------|-------------|---------------|
| MaonoDashboard | AnalyticsWorkspace | Business Monitor |
| BudgetEntryPanel | (various) | Budget Management |
| MaterialitySettings | (various) | → moved to Platform Settings |

**FirmDashboardPanel moves out of Monitor** → Command Center (firm-wide view, not engagement-specific).

---

## 5. Command Center

**Route:** `/command` (authenticated root)  
**Replaces:** `/dashboard` redirect  
**Primary question:** What is the next professional step across all my engagements?

**Layout:**
```
[SAFF Logo]  [Search companies]  [NotificationBell]  [User]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ATTENTION REQUIRED (2)
┌──────────────────────────────────┐  ┌───────────────────────────────────┐
│ ACME Ltd — 2025                  │  │ Beta Corp — 2025                  │
│ Stage: Compute Tax               │  │ Stage: Prepare Statements         │
│ BLOCKED: Statements not signed   │  │ REVIEW REQUIRED: H-07 fails       │
│ → Who: John Mwanga (Approver)    │  │ → Who: Mary Ngowi (Preparer)      │
│ [Open Workspace]                 │  │ [Open Workspace]                  │
└──────────────────────────────────┘  └───────────────────────────────────┘

IN PROGRESS (3)
[cards...]

COMPLETED (1)
[cards...]

UPCOMING DEADLINES
[FilingCalendar read-only widget — cross-company]

FIRM OVERVIEW
[FirmDashboardPanel — partner-level aggregate]
```

**Data sources:**
- Per-engagement status: from `deriveWorkspaceState` (already implemented)
- Compliance scores: from `computeComplianceScore`
- Upcoming deadlines: from `FilingCalendarPanel` data
- Firm aggregate: from `FirmDashboardPanel` data

---

## 6. Screen Inventory

| Screen | Route | Primary Question | Stage |
|--------|-------|-----------------|-------|
| Landing | `/` | Why trust this platform? | Public |
| Auth | `/auth` | Sign in | Public |
| Command Center | `/command` | What is my next step? | Platform |
| Company Directory | `/companies` | Which companies am I managing? | Platform |
| Platform Settings | `/settings` | Platform + firm configuration | Platform |
| Workspace Overview | `/workspace/:cId/:year` | What is the status of this engagement? | Engagement |
| Prepare Data | `/workspace/:cId/:year/prepare` | Is my data complete and classified? | Stage 1 |
| Reconcile | `/workspace/:cId/:year/reconcile` | Do my records agree? | Stage 2 |
| Prepare Statements | `/workspace/:cId/:year/statements` | Are my statements true and fair? | Stage 3 |
| Compute Tax | `/workspace/:cId/:year/tax` | What is the corporate tax position? | Stage 4 |
| Prepare Filing | `/workspace/:cId/:year/filing` | Is my filing package complete? | Stage 5 |
| Compliance Review | `/workspace/:cId/:year/compliance` | Am I ready for a TRA audit? | Stage 6 |
| Monitor | `/workspace/:cId/:year/monitor` | How is the business performing? | Ongoing |

**Total screens: 13** (down from a sprawling panel-per-engine model)

---

## 7. Workspace Hierarchy

```
Platform
├── Command Center (cross-engagement, cross-company)
├── Companies (list + management)
└── Settings (firm, materiality, team)

Engagement (Company × Period)
├── Workspace Overview (engagement status)
├── Stage 1: Prepare Data
│   ├── Upload (primary)
│   ├── Review Accounts (triggered)
│   └── Data Quality Report (triggered)
├── Stage 2: Reconcile
│   ├── EFDMS Reconciliation (primary)
│   └── Adjusting Journals (triggered)
├── Stage 3: Prepare Statements
│   ├── Statement Assurance (primary)
│   ├── Capital Allowances Register (triggered)
│   ├── Closing Balances (secondary)
│   └── Export Financial Statements (export action)
├── Stage 4: Compute Tax
│   ├── Corporate Income Tax (primary)
│   ├── Tax Findings (triggered)
│   ├── Add-backs Schedule (workpaper tab)
│   ├── Thin Capitalisation (workpaper tab)
│   ├── Transfer Pricing (workpaper tab)
│   └── Comparative Analysis (secondary tab)
├── Stage 5: Prepare Filing
│   ├── Disclosure Notes (primary)
│   ├── Management Letter (primary)
│   ├── Tax Computation PDF (primary)
│   ├── Filing Checklist (gate)
│   ├── Deadline Calendar (secondary)
│   └── Payment Ledger (secondary)
├── Stage 6: Compliance Review
│   ├── Audit Readiness (primary)
│   ├── Evidence Requests (triggered)
│   ├── Client Summary (output)
│   └── Compliance Score (read-only)
└── Monitor
    ├── Business Monitor (Maono)
    └── Budget Management
```

---

## 8. User Journey

### 8.1 New Engagement Journey (first time)

```
1. User opens Command Center
   → Sees: "No engagements in progress"
   → CTA: "Start New Engagement"
   
2. User selects Company + Period Year
   → Redirected to Workspace Overview
   → Status: "Stage 1 — Prepare Data — NOT STARTED"
   → CTA: "Upload Trial Balance"

3. User uploads trial balance CSV
   → Directed to Stage 1: Prepare Data
   → SafishaGate processes file
   → CTA: "Review Account Classifications" (if review items)

4. User reviews/approves account classifications
   → ValidationReport shows DQC pass
   → Stage 1 status → COMPLETE
   → CTA: "Begin Reconciliation" (Stage 2 unlocks)

5. User enters Stage 2: Reconcile
   → EFDMS panel: "No Z-Reports imported for this period"
   → CTA: "Import EFDMS Data" OR "Skip — No EFD Device" (if not applicable)
   → AJEs: auto-proposed from engine → user approves
   → Stage 2 status → COMPLETE

6. User enters Stage 3: Prepare Statements
   → CTA: "Run Statement Assurance"
   → hesabu-validate runs H-01 to H-12
   → All pass → CTA: "Sign Off as Preparer"
   → Preparer signs → CTA: "Awaiting Approver Sign-off"
   → Approver signs → Stage 3 status → SIGNED

7. User enters Stage 4: Compute Tax
   → CTA: "Compute Corporate Tax"
   → kinga-tax-engine runs
   → Tax Findings appear
   → User reviews findings, workpapers
   → CTA: "Commit Tax Computation"
   → CTA: "Sign Off Tax Position"
   → Stage 4 status → SIGNED

8. User enters Stage 5: Prepare Filing
   → CTA: "Generate Disclosure Notes"
   → CTA: "Generate Management Letter"
   → CTA: "Complete Filing Checklist"
   → Stage 5 status → COMPLETE

9. User enters Stage 6: Compliance Review
   → Evidence requests resolved
   → Audit Readiness checklist complete
   → Client Summary generated
   → Stage 6 → COMPLETE

10. Command Center shows engagement as COMPLETE
    → Compliance score displayed
    → Upcoming deadlines shown
```

### 8.2 Returning User Journey

```
1. User opens Command Center
   → Sees engagement cards sorted by: ATTENTION REQUIRED / IN PROGRESS / COMPLETED
   → ACME Ltd 2025: "BLOCKED — Tax: Statements not signed off"
   → CTA visible: "Go to Statements" (directly to Stage 3)

2. User clicks — lands directly on Stage 3: Prepare Statements
   → Sees exactly what is needed: "Approver signature required"
   → One CTA: "Sign Off as Approver"
   → Signs — Stage 3 SIGNED — Stage 4 unlocks immediately
```

### 8.3 Partner Overview Journey

```
1. Partner opens Command Center
   → Sees FirmDashboardPanel aggregate at bottom
   → 8 engagements across 5 companies
   → 2 require attention
   → 1 overdue filing deadline

2. Partner clicks "Overdue: ACME 2024 deadline"
   → Goes directly to Stage 5: Prepare Filing for that engagement
```

---

## 9. Transition Map (Stage Gates)

```
Stage 1: Prepare Data
├── ENTER: always (company + period selected)
├── EXIT CONDITION: all accounts classified + DQC passed
└── UNLOCKS: Stage 2

Stage 2: Reconcile
├── ENTER: Stage 1 complete
├── EXIT CONDITION: EFDMS gaps < materiality OR no EFD device; AJEs approved
├── UNLOCK SIGNAL: efdms_reconciliation.risk_level != 'critical' OR efdms_not_applicable flag
└── UNLOCKS: Stage 3

Stage 3: Prepare Statements
├── ENTER: Stage 2 complete
├── EXIT CONDITION: statement_sign_offs.approver_signed_at IS NOT NULL
├── UNLOCK SIGNAL: hesabu_validations.gate_satisfied = true (H-01..H-12 passed)
└── UNLOCKS: Stage 4

Stage 4: Compute Tax
├── ENTER: Stage 3 signed
├── EXIT CONDITION: tax_computations row committed + partner sign-off recorded
├── UNLOCK SIGNAL: statement_sign_offs.approver_signed_at IS NOT NULL (gates kinga-tax-engine)
└── UNLOCKS: Stage 5

Stage 5: Prepare Filing
├── ENTER: Stage 4 signed
├── EXIT CONDITION: TRAFilingChecklist all items checked
└── UNLOCKS: Stage 6

Stage 6: Compliance Review
├── ENTER: Stage 5 complete
├── EXIT CONDITION: evidence_requests all resolved; audit_readiness_score ≥ threshold
└── ENGAGEMENT COMPLETE

Monitor
├── ENTER: always (once Stage 1 started)
└── EXIT: none (ongoing)
```

**How blocked stages communicate:**

Each locked stage item in the sidebar shows:
```
🔒 Compute Tax
   Locked — Financial statements must be signed off
   Action required: John Mwanga (Approver) → Stage 3
   [Go to Statements →]
```

This is what Rule 8 mandates: every blocked mission explains why, who must act, and what unlocks it.

---

## 10. Component Ownership Map

### 10.1 Component → New Home

| Component | Current Route | New Route | New Stage Label | Action |
|-----------|-------------|-----------|-----------------|--------|
| SafishaGate | /safisha | /prepare | Upload Financial Data | KEEP + rename |
| EmptyCertificationState | /safisha | /prepare | (empty state) | KEEP |
| CertificationHeader | /safisha | /prepare | Data Certification | KEEP |
| CertificationSummaryStrip | /safisha | /prepare | Certification Summary | KEEP |
| TrialBalanceIntegrityCard | /safisha | /prepare | TB Integrity | KEEP |
| BalanceSheetEquationCard | /safisha | /prepare | Balance Equation | KEEP |
| ClassificationBreakdown | /safisha | /prepare | Classification | KEEP |
| AccountReviewPanel | /safisha | /prepare | Review Accounts | KEEP |
| ValidationReport | /safisha | /prepare | Data Quality | KEEP |
| UploadsStatusPanel | /safisha | /prepare | Upload History | KEEP (secondary) |
| AccountMappingModal | /safisha | /prepare | Map Accounts | KEEP |
| EFDMSReconciliationPanel | /safisha | /reconcile | EFDMS Reconciliation | MOVE |
| AdjustingJournalPanel | /kinga (tab: aje) | /reconcile | Adjusting Journals | MOVE |
| HesabuAssurancePanel | /hesabu | /statements | Statement Assurance | KEEP |
| PeriodClosingBalancesPanel | /hesabu | /statements | Closing Balances | KEEP |
| CapitalAllowancesRegister | /kinga (tab: workpapers) | /statements | Capital Allowances | MOVE |
| ExportStatements | /filing | /statements | Export Statements | MOVE |
| KingaTaxPanel | /kinga (tab: tax) | /tax | Corporate Income Tax | KEEP + rename |
| KingaFindingsPanel | /kinga (tab: compliance) + /issues | /tax (tab: findings) | Tax Findings | KEEP — deduplicate |
| AddBacksWorkpaper | /kinga (tab: workpapers) | /tax (tab: addbacks) | Add-backs Schedule | KEEP |
| ThinCapWorkpaper | /kinga (tab: workpapers) | /tax (tab: thincap) | Thin Capitalisation | KEEP |
| TransferPricingPanel | /kinga (tab: workpapers) | /tax (tab: tp) | Transfer Pricing | KEEP |
| KingaComparativePanel | /kinga (tab: comparative) | /tax (tab: comparative) | Comparative Analysis | KEEP |
| NoteSynth | /filing | /filing | Disclosure Notes | KEEP |
| MgmtLetterPanel | /filing | /filing | Management Letter | KEEP |
| generateTaxComputationPDF | (KingaTaxPanel button) | /filing | Tax Computation PDF | SURFACE as tab |
| TRAFilingChecklist | /filing | /filing | Filing Checklist | KEEP |
| FilingCalendarPanel | /analytics | /filing | Deadline Calendar | MOVE |
| PaymentLedgerPanel | /analytics | /filing | Payment Ledger | MOVE |
| TRAAuditReadinessPanel | /filing | /compliance | Audit Readiness | MOVE |
| EvidenceRequestPanel | (legacy Dashboard) | /compliance | Evidence Requests | MOVE + surface |
| ClientSummaryPanel | /filing | /compliance | Client Summary | MOVE |
| ComplianceScorecard | /analytics | /compliance + Command Center | Compliance Score | MOVE + widget |
| MaonoDashboard | /analytics | /monitor | Business Monitor | MOVE |
| BudgetEntryPanel | (various) | /monitor | Budget Management | MOVE |
| FirmDashboardPanel | /analytics | /command | Firm Dashboard | MOVE |
| MaterialitySettings | (various) | /settings | Materiality | MOVE to Platform |
| PeriodCloseManager | (various) | /settings or /command | Period Management | MOVE to Platform |
| NotificationBell | Header (global) | Header (global) | Notifications | KEEP |
| WorkspaceGate | /kinga, /filing | All stages | Gate | KEEP |
| WorkspaceOverview | /workspace | /workspace | Engagement Status | KEEP + enhance |
| WorkspaceLayout | wrapper | wrapper | — | KEEP + relabel |

### 10.2 Platform Settings Contents (revised)

Settings (`/settings`) now contains:
- Firm profile
- Team management (FirmManagementPanel)
- Materiality thresholds (MaterialitySettings — moved from analytics)
- Budget management (or link to Monitor)
- Period registry
- API & integrations

---

## 11. What to Delete

| Item | Location | Reason |
|------|----------|--------|
| `IssuesWorkspace.tsx` | `src/pages/workspace/IssuesWorkspace.tsx` | Dead route. KingaFindingsPanel already in KingaWorkspace/Stage 4. Nothing navigates to `/issues`. |
| Route `/workspace/:cId/:year/issues` | `src/App.tsx` line 55 | Dead route — remove |
| Engine name labels in sidebar | `WorkspaceLayout.tsx` lines 65-69 | "safisha", "hesabu", "kinga", "filing", "analytics" icons map to engine names — replace with accounting stage labels |
| Engine name labels in WorkspaceOverview | `WorkspaceOverview.tsx` lines 54-58 | Same — MISSION_ICONS keyed by engine name |
| `Dashboard.tsx` panel-container usage | `/dashboard` route | Legacy. Already redirects to workspace. The route and page can be collapsed once workspace is complete. |
| Engine name strings in `deriveWorkspaceState.ts` | mission labels | `label: "SAFISHA"` → `label: "Prepare Data"` etc. (language change only — logic unchanged) |
| Duplicate KingaFindingsPanel | `/issues` route | Removed with IssuesWorkspace |
| FilingCalendarPanel from AnalyticsWorkspace | AnalyticsWorkspace.tsx | Moved to Stage 5 Filing |
| PaymentLedgerPanel from AnalyticsWorkspace | AnalyticsWorkspace.tsx | Moved to Stage 5 Filing |
| FirmDashboardPanel from AnalyticsWorkspace | AnalyticsWorkspace.tsx | Moved to Command Center |
| ComplianceScorecard from AnalyticsWorkspace | AnalyticsWorkspace.tsx | Moved to Stage 6 + Command Center widget |

---

## 12. What to Merge

| Merge | From | Into | Result |
|-------|------|------|--------|
| AdjustingJournalPanel + EFDMSReconciliationPanel | KingaWorkspace + SafishaWorkspace | New Stage 2: Reconcile | Single screen answering "Do my records agree?" |
| TRAAuditReadinessPanel + EvidenceRequestPanel + ClientSummaryPanel | FilingWorkspace (dispersed) | New Stage 6: Compliance | Single screen answering "Am I audit-ready?" |
| FilingCalendarPanel + PaymentLedgerPanel | AnalyticsWorkspace | Stage 5: Prepare Filing | Filing logistics alongside filing documents |
| FirmDashboardPanel + ComplianceScorecard widget | AnalyticsWorkspace | Command Center | Partner-level view consolidated at the top |
| generateTaxComputationPDF (button) | KingaTaxPanel (hidden button) | Stage 5: Prepare Filing as explicit tab | Makes the PDF generation step visible and intentional |
| MaterialitySettings + Platform Settings | Various | `/settings` | One place for firm-level configuration |

---

## 13. What Remains (Unchanged)

The following are correct and require no restructuring — only relabelling in navigation:

- All Edge Functions (unchanged — implementation detail)
- All DB tables and migrations (unchanged)
- `deriveWorkspaceState.ts` — logic unchanged, only mission slug names and labels change
- `useWorkspaceData.ts` — frozen, unchanged
- All 16 workspace tests — unchanged (test the logic, not the route names)
- `WorkspaceGate.tsx` — unchanged
- `WorkspaceContext.tsx` — unchanged
- All component business logic — unchanged
- Landing page (`Hero.tsx`, `Header.tsx`, `Features.tsx`) — frozen
- `src/constants/copy.ts`, `src/index.css` — frozen

---

## 14. Route Rename Map

| Current Route | New Route | Current Slug | New Slug | Label Change |
|--------------|-----------|-------------|---------|--------------|
| `/workspace/:cId/:year/safisha` | `/workspace/:cId/:year/prepare` | `safisha` | `prepare` | "SAFISHA" → "Prepare Data" |
| (new) | `/workspace/:cId/:year/reconcile` | — | `reconcile` | — → "Reconcile" |
| `/workspace/:cId/:year/hesabu` | `/workspace/:cId/:year/statements` | `hesabu` | `statements` | "HESABU" → "Prepare Statements" |
| `/workspace/:cId/:year/kinga` | `/workspace/:cId/:year/tax` | `kinga` | `tax` | "KINGA" → "Compute Tax" |
| `/workspace/:cId/:year/filing` | `/workspace/:cId/:year/filing` | `filing` | `filing` | "FILING" → "Prepare Filing" |
| (new) | `/workspace/:cId/:year/compliance` | — | `compliance` | — → "Compliance Review" |
| `/workspace/:cId/:year/analytics` | `/workspace/:cId/:year/monitor` | `analytics` | `monitor` | "ANALYTICS" → "Monitor" |
| `/workspace/:cId/:year/issues` | DELETED | `issues` | — | Removed |
| `/dashboard` | `/command` | — | — | Dashboard → Command Center |

**Note on `deriveWorkspaceState.ts`:** The 14-path deterministic engine is frozen. The route changes require updating only the `href` generation (the `missionSlug` parameter) and the `label` strings. The logic paths (1–14) and gate conditions are unchanged.

---

## 15. Implementation Sequence

The following is the recommended atomic implementation order. Each item is independently releasable.

### Phase A — Route and Label Changes (no logic change)
1. Rename mission slugs in `deriveWorkspaceState.ts`: `safisha` → `prepare`, `hesabu` → `statements`, `kinga` → `tax`, `analytics` → `monitor`. Update labels from engine names to accounting names.
2. Update `App.tsx` route paths to match.
3. Update `WorkspaceLayout.tsx` sidebar labels and icons.
4. Update `WorkspaceOverview.tsx` mission icons and labels.
5. Add redirect: `/workspace/:cId/:year/safisha` → `/workspace/:cId/:year/prepare` (and equivalents) for back-compat.
6. Delete `/issues` route and `IssuesWorkspace.tsx`.
7. Update workspace tests: replace slug assertions (`"safisha"`) with new slugs (`"prepare"`).

### Phase B — New Stage 2: Reconcile (new page)
8. Create `ReconcileWorkspace.tsx`.
9. Move `EFDMSReconciliationPanel` from `SafishaWorkspace` to `ReconcileWorkspace`.
10. Move `AdjustingJournalPanel` from `KingaWorkspace` to `ReconcileWorkspace`.
11. Add `/reconcile` route to `App.tsx`.
12. Add `reconcile` mission to `deriveWorkspaceState.ts` (new 5th mission, insert between `prepare` and `statements`).
13. Update 16 tests to accommodate the new mission.

### Phase C — Redistribute Misplaced Components
14. Move `CapitalAllowancesRegister` from `KingaWorkspace` to `HesabuWorkspace` (now `StatementsWorkspace`).
15. Move `ExportStatements` from `FilingWorkspace` to `StatementsWorkspace`.
16. Move `FilingCalendarPanel` + `PaymentLedgerPanel` from `AnalyticsWorkspace` to `FilingWorkspace`.
17. Move `TRAAuditReadinessPanel` + `ClientSummaryPanel` from `FilingWorkspace` to new `ComplianceWorkspace`.

### Phase D — New Stage 6: Compliance (new page)
18. Create `ComplianceWorkspace.tsx`.
19. Wire `TRAAuditReadinessPanel`, `EvidenceRequestPanel`, `ClientSummaryPanel`, `ComplianceScorecard`.
20. Add `/compliance` route.
21. Add `compliance` mission to `deriveWorkspaceState.ts`.

### Phase E — Command Center
22. Create `CommandCenter.tsx` at `/command`.
23. Wire FirmDashboardPanel, ComplianceScorecard widget, cross-engagement status grid.
24. Redirect `/dashboard` to `/command`.

### Phase F — AnalyticsWorkspace → Monitor (cleanup)
25. Rename `AnalyticsWorkspace.tsx` to `MonitorWorkspace.tsx`.
26. Remove FilingCalendarPanel, PaymentLedgerPanel, FirmDashboardPanel, ComplianceScorecard (already moved).
27. Keep MaonoDashboard, BudgetEntryPanel.

### Phase G — Primary CTA Enforcement
28. Audit each stage page: ensure exactly one primary Button (variant="default") is visible at a time.
29. All other actions: secondary, tertiary, or disabled.
30. Each locked stage: add inline explanation card per Rule 8.

---

## 16. What Does NOT Change

**Constitutional invariants — preserved:**
- No engine may recompute another engine's canonical output
- No financial calculation in the frontend
- No direct table writes where Edge Function is the authority
- NULL means NOT COMPUTED
- Append-only records
- Workspace freeze: `deriveWorkspaceState.ts` logic, `useWorkspaceData.ts`, 16 tests — logic unchanged, only labels/slugs change in Phase A

**Protected files (content unchanged):**
- `src/components/Hero.tsx`
- `src/components/Header.tsx`
- `src/components/Features.tsx`
- `src/constants/copy.ts`
- `src/index.css`

---

*End of Architecture v3 document.*
