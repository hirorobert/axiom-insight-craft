# SAFF ERP — IRON DOME NUCLEAR UX RE-ARCHITECTURE
## Architectural Design Document · 2026-07-13

---

# 1. CURRENT ARCHITECTURE AUDIT

## 1.1 What Exists Today

The current system is a single-page application with one dominant file: `Dashboard.tsx`. Every engine, every panel, every workpaper, and every workflow is rendered inside this single component, conditionally shown based on upload state.

**Current panel inventory (in approximate render order):**

| Panel | Engine Behind | Where Rendered |
|---|---|---|
| Company Manager | — | Dashboard |
| Upload Status Panel | — | Dashboard |
| Trial Balance Upload | — | Dashboard |
| Validation Report | — | Dashboard |
| Account Review Panel | — | Dashboard |
| KINGA Findings Panel | KINGA | Dashboard |
| KingaTaxPanel | KINGA + HESABU | Dashboard |
| Transfer Pricing Panel | KINGA | Dashboard |
| TRA Filing Checklist | — | Dashboard |
| Adjusting Journal Panel | — | Dashboard |
| EFDMS Reconciliation Panel | SAFISHA-EFDMS | Dashboard |
| TRA Audit Readiness Panel | — | Dashboard |
| Client Summary Panel | — | Dashboard |
| Compliance Scorecard | — | Dashboard |
| Period Closing Balances Panel | — | Dashboard |
| Capital Allowances Register | KINGA | Dashboard |
| Thin Cap Workpaper | KINGA | Dashboard |
| Add-Backs Workpaper | KINGA | Dashboard |
| Loss Carry-Forward Panel | KINGA | Dashboard |
| Installment Tax Panel | KINGA | Dashboard |
| MAONO Dashboard | MAONO | Dashboard |
| Management Letter Panel | MAONO + AI | Dashboard |
| Notification Bell | — | Header |
| Filing Calendar Panel | — | Dashboard |
| Payment Ledger Panel | — | Dashboard |
| Firm Dashboard Panel | — | Dashboard |
| Period Close Manager | — | Dashboard |
| HESABU Assurance Panel | HESABU | KingaTaxPanel |
| HesabuAssurancePanel (inline) | HESABU | KingaTaxPanel |

**Separate pages:** Home (`/`), Auth (`/auth`), Upload Status (`/upload-status`)

**Settings page panels:**
- Firm Management
- Audit Trail

## 1.2 How Panels Are Currently Triggered

All 25+ panels are rendered inside a single `useEffect + selectedUpload` chain:

```
User selects company
→ User selects upload
→ Upload status = "complete" AND is_valid = true
→ ALL 25 panels render simultaneously, stacked vertically
```

There is no routing. There is no state machine. There is no role gate at the UI layer. Everything appears for everyone.

## 1.3 Engine Integration Points (as built)

```
SAFISHA   → safisha-ingest, safisha-match, safisha-categorize, safisha-score, safisha-resolve
KINGA     → kinga-tax-engine, kinga-comparative-engine, process-trial-balance
HESABU    → hesabu-validate (auto-runs after KINGA commit)
MAONO     → maono-compute, maono-cashflow, maono-root-cause, maono-risk, maono-decide, maono-monitor
XBRL      → generate-xbrl (exists, no UI panel)
Disclosure → generate-disclosure-notes
Mgmt Ltr  → generate-management-letter
EFDMS     → safisha-efdms-ingest
```

---

# 2. UX PROBLEMS

## 2.1 Cognitive Load Problems

**P-01 · Engine exposure**
Users read "HESABU Assurance," "SAFISHA Gate," "MAONO," "KINGA Findings." These are internal system names. A CPA preparing year-end accounts does not think in engines. They think: *"I need to get the financial statements signed off."*

**P-02 · Infinite dashboard**
25+ panels render in a single vertical scroll. A user preparing the tax computation scrolls past MAONO, EFDMS, XBRL, Transfer Pricing, Capital Allowances, Loss Carry-Forward, and Management Letter before reaching the section they need.

**P-03 · No mission concept**
There is no concept of "what am I trying to accomplish today." The interface presents capabilities, not goals.

**P-04 · No completion signal**
A user cannot tell whether a period is fully complete. There is no progress indicator, no checklist, no done state visible at the period level. The only hint is the period lock badge inside KingaTaxPanel.

## 2.2 Role Problems

**P-05 · No role differentiation**
A Business Owner and a CPA see exactly the same interface. A CFO reviewing board-level metrics sees the same upload form as a junior accountant processing bank statements.

**P-06 · No entry point by role**
First-time users have no guided path. The interface offers a company dropdown and a file upload with no context about what to do or why.

## 2.3 Workflow Problems

**P-07 · Upload is the gateway to everything**
The entire system is gated behind "upload a trial balance." This is correct architecturally but the UI communicates nothing about why, or what happens next.

**P-08 · Multiple reconciliation surfaces**
Bank reconciliation (SAFISHA) and EFDMS Z-Report reconciliation are separate panels with no relationship shown between them. A user doing VAT work must mentally connect these.

**P-09 · Sign-off buried inside a tax panel**
The period sign-off chain (Preparer → Reviewer → Approver) lives inside KingaTaxPanel. This is architecturally wrong: the sign-off is a period-level event, not a tax-panel feature.

**P-10 · XBRL is unreachable**
The generate-xbrl edge function is fully implemented. There is no UI panel to reach it. Users cannot file XBRL.

**P-11 · No workflow gating in the UI**
The dashboard renders all panels regardless of whether prerequisite steps are complete. A user can open the KINGA Tax Panel before SAFISHA reconciliation is complete. The engine will reject the computation, but the UI gives no guidance.

**P-12 · Period selection is ambiguous**
Period year and month are derived from the upload's fiscal_year_end. There is no explicit "I am working on FY2025" selector. Periods are implicit, not declared.

**P-13 · Duplicate entry points**
Compliance score appears in both `ComplianceScorecard.tsx` and `FirmDashboardPanel.tsx`. Sign-off status appears in `KingaTaxPanel.tsx` and `PeriodCloseManager.tsx`. Filing deadlines appear in `FilingCalendarPanel.tsx` and `TRAFilingChecklist.tsx`.

## 2.4 Information Architecture Problems

**P-14 · Firm vs. engagement vs. company confusion**
"Firm" (the accounting practice), "Company" (the client), and "Engagement" (the year-end work) are three different concepts. The current UI collapses them inconsistently. The Firm Dashboard Panel sits beside company-specific panels.

**P-15 · Notification Bell has no triage**
Alerts fire but there is no escalation hierarchy: critical TRA audit signal sits beside a "computation stale" advisory. All alerts look the same.

**P-16 · Payment Ledger is disconnected**
`PaymentLedgerPanel.tsx` tracks tax payments but has no visible connection to the tax computation that generated the liability.

**P-17 · Management Letter orphaned**
The Management Letter panel exists on the dashboard beside raw workpapers. It belongs at the end of a statutory filing workflow, not beside Capital Allowances.

---

# 3. PROPOSED INFORMATION ARCHITECTURE

## 3.1 Foundational Concepts

Replace the flat panel dump with four first-class concepts:

```
FIRM
└── ENGAGEMENT (one client company + one fiscal year)
    └── PERIOD (one calendar month, for VAT/SDL work)
    └── MISSIONS (what the user is trying to accomplish)
        └── ENGINES (invisible — internal only)
```

A **Firm** is the accounting practice. It has staff, clients, and a deadline calendar.

An **Engagement** is the unit of work for one company for one fiscal year. All missions run inside an engagement. The engagement has a lifecycle state.

A **Period** is a sub-engagement unit used for monthly VAT/EFDMS reconciliation.

A **Mission** is what the user sees. Engines are what run inside.

## 3.2 Engagement Lifecycle States

```
ONBOARDING
    ↓
DATA_INTAKE         ← Trial balance uploaded, SAFISHA running
    ↓
RECONCILED          ← SAFISHA gate passed
    ↓
STATEMENTS_READY    ← Financial statements generated, AJEs applied
    ↓
HESABU_PASSED       ← H-01 to H-12 all pass
    ↓
STATEMENTS_SIGNED   ← Tier 1/2/3 sign-off complete, period locked
    ↓
TAX_COMPUTED        ← KINGA engine committed
    ↓
TAX_SIGNED          ← Tax computation signed
    ↓
FILING_PACKAGE_READY ← Disclosure Notes + Mgmt Letter + XBRL generated
    ↓
FILED               ← TRA submission complete
```

Only missions appropriate to the current state are shown as active. Future-state missions are visible but locked with a clear "requires X first" message.

## 3.3 Role Profiles

| Role | Primary Missions | Secondary Missions | Read-Only |
|---|---|---|---|
| Accountant | Data Intake, Reconcile | Monthly VAT | — |
| CPA | All missions | Firm Overview | Audit Log |
| Auditor | Review, Evidence, Issues | Sign-Off (own tier) | Computation detail |
| CFO | Performance, Board Pack | Compliance | Filing package |
| Finance Manager | Monthly close, VAT | Performance | — |
| Business Owner | Summary, Health | Filing status | — |
| Firm Partner | Firm Overview, Deadlines | All client missions | — |

---

# 4. MISSION ARCHITECTURE

## Mission 1 — Prepare Financial Statements

**Who:** Accountant, CPA
**Entry condition:** Company + fiscal year selected
**Completion signal:** HESABU gate satisfied + Tier 3 sign-off + period locked

**Engine pipeline (invisible to user):**
```
[Upload Trial Balance]
        ↓
[process-trial-balance]     → account classification
        ↓
[SAFISHA: safisha-ingest]   → import transactions
        ↓
[SAFISHA: safisha-match]    → matching engine
        ↓
[SAFISHA: safisha-categorize + score] → exception scoring
        ↓
[SAFISHA: safisha-resolve]  → CPA resolves exceptions
        ↓
[AJE generation]            → auto-generated adjusting entries
        ↓
[Statement generation]      → SFP, P&L, SCF, SOCIE
        ↓
[HESABU: hesabu-validate]   → H-01 to H-12 cross-statement check
        ↓
[Sign-off: Preparer → Reviewer → Approver]
        ↓
[Period lock]
```

**User sees:**
- Step 1: Upload → automatic classification shown
- Step 2: Reconcile → exception queue, field mapping
- Step 3: Statements → SFP, P&L, SCF, SOCIE previews
- Step 4: Validate → HESABU assertion grid (pass/fail/skip)
- Step 5: Sign Off → tiered signature chain with HESABU gate enforced

---

## Mission 2 — Compute Corporate Tax

**Who:** CPA, Tax Accountant
**Entry condition:** Engagement state ≥ HESABU_PASSED
**Completion signal:** Tax computation committed + tax sign-off complete

**Engine pipeline:**
```
[KINGA: kinga-tax-engine]
        ↓
[Rate verification gate]    → statutory_rules.verified_at check
        ↓
[Findings: findings engine] → statutory exposure detection
        ↓
[Workpapers auto-populate]  → thin cap, add-backs, W&T, loss pool
        ↓
[CPA workpaper review]      → manual inputs (resident bank debt, etc.)
        ↓
[EFDMS reconciliation]      → safisha-efdms-ingest gap check
        ↓
[Commit computation]        → tax_computations row written
        ↓
[HESABU auto-rerun]         → staleness check
        ↓
[Tax sign-off]
```

**User sees:**
- Tax computation waterfall (ITA s.3 → taxable income → CIT)
- Findings list (live issues, resolved issues)
- Workpapers (accessible from within the computation, not separately)
- EFDMS VAT gap (shown as a sub-section of the computation)
- Installment tax schedule (auto-generated from the computation)
- Commit button + sign-off chain

---

## Mission 3 — Analyse Financial Performance

**Who:** CFO, Finance Manager, Business Owner (limited view)
**Entry condition:** Engagement state ≥ RECONCILED
**Completion signal:** N/A (analytical mission, no completion state)

**Engine pipeline:**
```
[MAONO: maono-compute]      → variance analysis vs. budget
        ↓
[MAONO: maono-cashflow]     → AR/AP aging + statutory calendar
        ↓
[MAONO: maono-risk]         → Z-score + TRA audit signal
        ↓
[MAONO: maono-root-cause]   → Claude agent, tool-use citation
        ↓
[MAONO: maono-decide]       → 3 decision paths, role-gated
```

**User sees:**
- Performance dashboard (variance vs. budget by P&L category)
- Cash flow forecast (13-week waterfall)
- Risk radar (Z-score, TRA signals)
- Root cause insights (narrative, with citations)
- Recommended actions (decision paths — never auto-executed)

---

## Mission 4 — Prepare Statutory Filing Package

**Who:** CPA
**Entry condition:** Engagement state ≥ TAX_SIGNED
**Completion signal:** All package components generated + XBRL validated

**Engine pipeline:**
```
[generate-disclosure-notes] → IAS/IFRS disclosure notes
        ↓
[generate-management-letter]→ management letter (MAONO-informed)
        ↓
[generate-xbrl]             → XBRL instance document
        ↓
[TRA checklist validation]  → e-filing readiness gates
        ↓
[Filing package export]     → single ZIP or PDF bundle
```

**User sees:**
- Disclosure Notes (generated, CPA-reviewed)
- Management Letter (generated, CPA-reviewed)
- XBRL (generated, validated against taxonomy)
- TRA e-filing checklist (6 gates, all must pass)
- Download package button

---

## Mission 5 — Review Compliance

**Who:** CPA, Auditor, Finance Manager
**Entry condition:** Engagement state ≥ DATA_INTAKE
**Completion signal:** All open findings resolved + audit readiness gates passed

**Engine pipeline:**
```
[findings engine]           → statutory compliance findings
        ↓
[evidence_requests]         → evidence tracking per finding
        ↓
[TRAAuditReadinessPanel]   → 6-gate pre-submission check
        ↓
[Filing calendar]           → statutory deadline tracking
        ↓
[Payment ledger]            → payment tracking against liabilities
```

**User sees:**
- Open findings by category (CIT, VAT, SDL, PAYE, TP)
- Evidence requests per finding
- Audit readiness gates
- Deadline calendar (TRA obligations)
- Payment status vs. computed liabilities

---

## Mission 6 — Investigate Issues

**Who:** CPA, Auditor
**Entry condition:** Open findings exist OR exceptions in queue
**Completion signal:** All issues resolved or documented

**Engine pipeline:**
```
[safisha-resolve]           → exception resolution
        ↓
[findings engine]           → finding triage
        ↓
[MAONO: maono-root-cause]   → root cause if financial anomaly
```

**User sees:**
- Exception queue (SAFISHA unmatched/low-confidence transactions)
- Findings queue (statutory exposure items)
- Drill-down per item (evidence, commentary, resolution)

---

## Mission 7 — Manage Firm

**Who:** Firm Partner, Manager
**Entry condition:** Firm-level access
**Completion signal:** N/A (ongoing)

**Engine pipeline:**
```
[maono-monitor]             → alert aggregation across all clients
        ↓
[board_packs]               → auto-generated board pack per client
```

**User sees:**
- Client portfolio grid (all companies, all periods, all states)
- Deadline calendar (firm-wide, all clients)
- Alert center (aggregated across all engagements)
- Staff assignment (which staff on which engagement)
- Board pack generation

---

## Mission 8 — Administer

**Who:** Firm Owner, System Admin
**Entry condition:** Admin role
**Completion signal:** N/A

**User sees:**
- User management (firm_members)
- Audit log (complete, immutable)
- Statutory rules management (verified rates — admin only)
- API keys and integration settings
- Data retention settings

---

# 5. NAVIGATION TREE

## 5.1 Top-Level Navigation (All Roles)

```
SAFF ERP
│
├── [Logo → Home]
│
├── My Work              ← Role-adaptive inbox (alerts, tasks, deadlines)
│
├── Clients              ← List of companies / engagements
│   └── [Company]
│       └── [FY2025 Engagement]
│           ├── Overview
│           ├── Financials          (Mission 1)
│           ├── Tax                 (Mission 2)
│           ├── Performance         (Mission 3)
│           ├── Filing Package      (Mission 4)
│           ├── Compliance          (Mission 5)
│           └── Issues              (Mission 6)
│
├── Firm                 ← Firm-level view (Partner/Manager only)
│   ├── Dashboard
│   ├── Clients
│   ├── Deadlines
│   └── Alerts
│
└── [User Avatar]
    ├── Profile
    ├── Settings
    │   ├── Firm Settings
    │   ├── Statutory Rules         (Admin only)
    │   └── Audit Trail
    └── Sign Out
```

## 5.2 Engagement Navigation (Sidebar Within Engagement)

```
[Company Name · FY2025]
│
├── Overview                       ← Engagement state, progress, alerts
│
├── 1 · Financials
│   ├── Upload                     ← Trial balance intake
│   ├── Reconcile                  ← SAFISHA exception queue
│   ├── Statements                 ← SFP, P&L, SCF, SOCIE
│   ├── Validate                   ← HESABU assertions
│   └── Sign Off                   ← Tier 1/2/3 chain
│
├── 2 · Tax
│   ├── Computation                ← KINGA waterfall
│   ├── Workpapers
│   │   ├── Capital Allowances     ← ITA s.34
│   │   ├── Thin Cap               ← ITA s.12(2)
│   │   ├── Add-Backs              ← Full ITA adjustment schedule
│   │   ├── Loss Pool              ← Carry-forward tracker
│   │   └── Instalment Schedule    ← ITA s.88
│   ├── EFDMS                      ← Z-report reconciliation
│   ├── Findings                   ← Statutory exposure items
│   └── Sign Off
│
├── 3 · Performance
│   ├── Variance                   ← MAONO budget vs. actual
│   ├── Cash Flow                  ← 13-week forecast
│   ├── Risk                       ← Z-score + TRA signals
│   └── Insights                   ← Root cause narratives
│
├── 4 · Filing
│   ├── Disclosure Notes
│   ├── Management Letter
│   ├── XBRL
│   └── TRA Checklist
│
├── 5 · Compliance
│   ├── Open Findings
│   ├── Evidence Requests
│   ├── Audit Readiness
│   ├── Deadlines
│   └── Payments
│
└── 6 · Issues
    ├── Exception Queue
    └── Anomaly Explorer
```

## 5.3 Period Navigation (Monthly Work)

```
[Company Name · Month View · June 2025]
│
├── VAT Reconciliation             ← EFDMS Z-Reports vs. return
├── SDL Check
├── PAYE Deadline
└── Monthly Close
```

---

# 6. SCREEN MAP

## S-01 · Home (Role-Adaptive)

**Accountant view:** Recent uploads, outstanding reconciliation tasks, deadlines this week.
**CPA view:** Engagements requiring sign-off, open findings by client, filing calendar.
**CFO view:** Portfolio performance summary, alerts, board pack status.
**Business Owner view:** Financial health score, cash position, next filing date.
**Partner view:** Firm dashboard — all clients, all periods, aggregate exposure.

Components: Greeting, Today's Tasks (max 5), Urgent Alerts, Deadline Strip (7-day), Quick Actions.

---

## S-02 · Clients List

Grid of company cards. Each card shows:
- Company name + TIN
- Active engagement (FY)
- Engagement state badge (DATA_INTAKE → FILED)
- Days to next TRA deadline
- Alert count
- Assigned staff

Filter: All / My clients / By state / By deadline.

---

## S-03 · Engagement Overview

**The single source of truth for one company + one fiscal year.**

Header: Company name | FY | Period end | Engagement state badge | Days to filing.

Progress stepper (horizontal):
```
[Upload] → [Reconcile] → [Statements] → [Validate] → [Sign Off] → [Tax] → [File]
```
Each step shows: complete ✓ / in progress ● / locked 🔒 / blocked ⚠

Panels below:
- Active tasks for this engagement (by role)
- Recent activity log
- Alert summary (engine-generated, triaged by severity)
- Quick links to each sub-mission

---

## S-04 · Financials: Upload

Single-focus screen. No other panels visible.

Components:
- Drop zone (TB file or scanned PDF)
- Auto-detect result (TB / audited accounts / EFDMS CSV)
- Classification confidence summary
- Routing confirmation ("This will go to: process-trial-balance → SAFISHA")
- Upload history for this engagement (with retry)

State: Locked if engagement ≥ STATEMENTS_SIGNED (no new uploads for a locked period).

---

## S-05 · Financials: Reconcile

Single-focus screen.

Components:
- SAFISHA status banner (% matched, exceptions remaining)
- Field mapping modal (if new client)
- Exception queue: unmatched, low-confidence, flagged
- Per-exception: source transaction, suggested match, confidence score, CPA resolution (Accept / Reject / Manual map)
- Completion gate: "X exceptions remaining before you can proceed"

State: Unlocks Statements step when SAFISHA gate passes.

---

## S-06 · Financials: Statements

Three-tab layout: SFP | P&L | SCF + SOCIE.

Each tab: Statement preview (with IFRS/IFRS for SMEs/IAS formatting), note references, management inputs (dividends, share capital).
AJE panel (collapsible): auto-generated + manual entries, approve/reverse.
Comparative columns if prior-year data exists.

Export: 6-page PDF.

State: Read-only after sign-off.

---

## S-07 · Financials: Validate (HESABU)

Full-focus validation screen.

Components:
- Gate status banner (ShieldCheck / ShieldX / ShieldAlert)
- Assertion grid (H-01 to H-12): assertion ID, description, expected, actual, difference, tolerance, result
- Run Validation button
- Staleness warning if tax computation has changed since last run
- Guidance text per failed assertion

State: Tier 1 sign-off is database-blocked until gate_satisfied = TRUE.

---

## S-08 · Financials: Sign Off

Clean, focused sign-off screen.

Components:
- HESABU gate status (must be green to proceed)
- Three-tier chain visual (Preparer → Reviewer → Approver)
- Each tier: role name, assigned user, status, signed date, signature note
- Current tier's button is active; others are locked
- Period lock status (post-Approver sign-off)
- Lock notice (immutable after lock)

Note input: Per-signature note field.

---

## S-09 · Tax: Computation

Full KINGA computation screen.

Layout: Two-column (waterfall left, workpapers right).

Left column — Tax waterfall:
- Revenue → Gross Income → Allowable Deductions → Taxable Income → CIT / AMT / Presumptive
- Each line item expandable to source
- Gated items shown as GATED with amber notice (not computed)

Right column — Linked workpapers:
- Thin Cap (ITA s.12(2)) — if triggered
- Management Fee cap (ITA s.33) — if triggered
- Add-backs summary
- Deferred tax (IAS 12)

Bottom: Commit Computation button (with confirm modal), version history.

State: Unlocks after STATEMENTS_SIGNED. HESABU auto-runs on commit.

---

## S-10 · Tax: Workpapers

Tabbed workpaper panel (not separate screens — tabs within Tax section):

Tabs:
- Capital Allowances Register (asset grid, WDV, W&T by class)
- Thin Cap (ITA s.12(2) — shown as GATED until rates verified)
- Add-Backs Schedule (full ITA adjustment table)
- Loss Pool (carry-forward tracker, FY by FY)
- Instalment Schedule (ITA s.88, payment dates + amounts)

Each workpaper is CPA-annotation-enabled. No frontend recomputation of statutory rates.

---

## S-11 · Tax: EFDMS

Integrated within Tax mission (not standalone).

Tabs: Z-Report Import | VAT Reconciliation | Risk Summary.

- Import: CSV upload or manual Z-report entry → safisha-efdms-ingest
- Reconciliation: EFDMS gross vs. VAT return, gap %, risk level
- Risk: TRA audit signal if gap exceeds materiality

State: Shown only if isVatRegistered = true (future: schema field).

---

## S-12 · Tax: Findings

Statutory compliance findings for this engagement.

Components:
- Finding cards grouped by category (CIT, VAT, SDL, TP, Other)
- Each finding: category, exposure amount, ITA reference, status, evidence requests
- Resolution flow: Accept / Dispute / Provide evidence
- Overall exposure summary (pie chart by category)

State: Open findings block TRA Checklist from passing.

---

## S-13 · Tax: Sign Off

Same pattern as S-08 but for the tax computation.

Additional component: Pre-sign checklist (EFDMS reconciled? Workpapers reviewed? All findings resolved or documented?).

---

## S-14 · Performance: Variance

MAONO variance dashboard.

Components:
- Period selector (month or year)
- Variance grid (P&L category, actual vs. budget, variance TZS and %)
- Material variances highlighted
- Root cause trigger button (calls maono-root-cause for selected variance)
- Narrative insight cards (Claude-generated, cited)

---

## S-15 · Performance: Cash Flow

13-week cash flow waterfall.

Components:
- AR aging heatmap
- AP aging heatmap
- Statutory calendar overlay (TRA payment dates)
- Projected cash position by week

---

## S-16 · Performance: Risk

Risk radar.

Components:
- Z-score gauge (Altman or equivalent — TZ calibrated)
- TRA audit signal flags
- Recommended decisions (role-gated, never auto-executed)

---

## S-17 · Filing: Disclosure Notes

Generated disclosure notes viewer/editor.

Components:
- Note list (by IFRS standard)
- Each note: generated text, CPA edit field, status (draft / reviewed / approved)
- Regenerate button (re-runs generate-disclosure-notes)

---

## S-18 · Filing: Management Letter

Management letter viewer.

Components:
- Letter preview
- Section editor (CPA annotations)
- Regenerate button

---

## S-19 · Filing: XBRL

XBRL generation and validation screen.

Components:
- Generate XBRL button (calls generate-xbrl)
- Validation report (against TNFRS taxonomy)
- Error list (invalid element, missing concept, etc.)
- Download instance document (.xml)

State: Locked if engagement < TAX_SIGNED.

---

## S-20 · Filing: TRA Checklist

6-gate checklist.

Gates: G1 (HESABU) / G2 (AJEs approved) / G3 (Signed off) / G4 (Findings reviewed) / G5 (EFDMS present) / G6 (Evidence closed).

Each gate: pass/fail indicator, detail, action link.
Download filing package button (enabled only when all 6 pass).

---

## S-21 · Compliance: Findings (Canonical)

Canonical findings view (replaces the one inside Tax).

This screen is role-visible to Auditors and CPAs regardless of which mission they came from. Shows findings for the engagement, linked to evidence requests.

---

## S-22 · Compliance: Audit Readiness

Pre-audit checklist, deadline calendar, payment ledger — combined in one compliance screen, tabbed.

Tabs: Readiness | Deadlines | Payments.

---

## S-23 · Issues: Exception Queue

SAFISHA exception queue for this engagement.

Identical to S-05 but accessible from Issues without re-entering the Financials flow.

---

## S-24 · Firm: Dashboard

Partner-level view.

Components:
- Client grid (all companies, all periods)
- Aggregate exposure (TZS by category across all clients)
- Deadline strip (next 30 days, all clients)
- Alert feed (maono-monitor output, triaged)
- Board pack generation per client

---

## S-25 · Firm: Deadlines

Calendar view of all TRA deadlines, sign-off deadlines, and filing dates across all clients.

---

## S-26 · Firm: Alerts

Triaged alert center.

Alert levels: CRITICAL (TRA risk signal) / WARN (gate blocked) / INFO (staleness).
Each alert: source, client, period, message, action link.

---

## S-27 · Admin: Statutory Rules

Read-only for CPAs. Admin-editable.

Shows statutory_rules table: trigger_category, rate_pct, verified_at, verified_by, notes.
GATED rows highlighted in amber.
Admin: Set verified_at (requires written ITA citation).

---

# 7. WORKFLOW DIAGRAMS

## 7.1 Year-End Workflow (Complete Path)

```
START
  │
  ▼
[S-02 Clients List]
  │  Select company + create/open FY engagement
  ▼
[S-03 Engagement Overview]
  │  State: ONBOARDING
  ▼
──────────────────── MISSION 1: FINANCIALS ────────────────────
  │
  ▼
[S-04 Upload]
  │  Upload TB → process-trial-balance → SAFISHA ingest
  │  State: DATA_INTAKE
  ▼
[S-05 Reconcile]
  │  safisha-match → categorize → score
  │  CPA resolves exceptions
  │  SAFISHA gate passes
  │  State: RECONCILED
  ▼
[S-06 Statements]
  │  AJEs auto-generated + CPA reviewed
  │  Management inputs (dividends, share capital)
  │  State: STATEMENTS_READY
  ▼
[S-07 Validate]
  │  hesabu-validate → H-01 to H-12
  │  All pass → gate_satisfied = TRUE
  │  State: HESABU_PASSED
  ▼
[S-08 Sign Off]
  │  Tier 1 (Preparer) → Tier 2 (Reviewer) → Tier 3 (Approver)
  │  DB trigger blocks Tier 1 until HESABU gate passes
  │  Period locked on Tier 3 approval
  │  State: STATEMENTS_SIGNED
  │
──────────────────── MISSION 2: TAX ───────────────────────────
  ▼
[S-09 Computation]
  │  kinga-tax-engine runs
  │  Statutory rates checked → GATED if unverified
  │  Findings generated
  │  State: TAX_COMPUTED (draft)
  ▼
[S-10 Workpapers]
  │  CPA reviews: thin cap, add-backs, W&T, loss pool, instalment
  │  Manual inputs applied
  ▼
[S-11 EFDMS]
  │  Z-reports imported (if VAT registered)
  │  Gap computed → risk level assigned
  ▼
[S-12 Findings]
  │  CPA resolves or documents each finding
  ▼
[S-13 Tax Sign Off]
  │  Computation committed → HESABU auto-reruns
  │  Sign-off chain
  │  State: TAX_SIGNED
  │
──────────────────── MISSION 4: FILING ────────────────────────
  ▼
[S-17 Disclosure Notes]   [S-18 Management Letter]   [S-19 XBRL]
  │  Generated, CPA-reviewed in parallel
  ▼
[S-20 TRA Checklist]
  │  All 6 gates pass
  │  Filing package downloaded
  │  State: FILING_PACKAGE_READY
  ▼
[Manual TRA submission by CPA]
  │
  │  State: FILED
  ▼
END
```

## 7.2 Monthly Close Workflow (VAT/SDL)

```
[S-03 Engagement Overview → Period tab]
  │  Select month (e.g. June 2025)
  ▼
[S-11 EFDMS → Z-Report Import]
  │  Upload CSV or manual Z-report entry
  │  safisha-efdms-ingest → efdms_z_reports
  ▼
[EFDMS → VAT Reconciliation]
  │  Gap computed vs. tax computation VAT figure
  │  Risk level assigned
  │  TRA alert fired if CRITICAL
  ▼
[S-22 Compliance → Deadlines]
  │  Check VAT return deadline
  │  Check SDL deadline
  ▼
[S-22 Compliance → Payments]
  │  Log payment against liability
  ▼
DONE
```

## 7.3 Exception Resolution Workflow

```
SAFISHA flags low-confidence transaction
  │
  ▼
[Alert fires → My Work inbox]
  │
  ▼
[S-23 Issues: Exception Queue]
  │  CPA reviews: transaction, suggested match, confidence
  │
  ├── Accept match → resolved
  ├── Reject + manual map → resolved
  └── Dispute → creates finding → S-12 Findings
                                    │
                                    └── CPA documents / requests evidence
                                        → evidence_request created
                                        → S-22 Compliance: Evidence
```

## 7.4 HESABU Gate Failure Recovery

```
hesabu-validate runs (auto, post-commit)
  │
  ▼
[H-04 SCF fails: closing cash mismatch]
  │
  ▼
[S-07 Validate: assertion grid shows H-04 FAIL]
  │
  ├── Detail: expected TZS 45,000,000 | actual TZS 43,200,000 | diff TZS 1,800,000
  │
  ▼
[Action link → S-06 Statements: SCF tab]
  │
  ├── CPA identifies disposal proceeds missing (management input)
  │   → Updates disposal_proceeds_tzs
  │
  ▼
[Re-run hesabu-validate]
  │
  ▼
[H-04 PASS → gate_satisfied = TRUE]
  │
  ▼
[S-08 Sign Off: Tier 1 button now enabled]
```

---

# 8. STATE MACHINE

## 8.1 Engagement State Machine

```
States:
  ONBOARDING
  DATA_INTAKE
  RECONCILED
  STATEMENTS_READY
  HESABU_PASSED
  STATEMENTS_SIGNED  (period locked)
  TAX_COMPUTED
  TAX_SIGNED
  FILING_PACKAGE_READY
  FILED

Transitions:
  ONBOARDING          → DATA_INTAKE          [trigger: TB upload complete]
  DATA_INTAKE         → RECONCILED           [trigger: SAFISHA gate passes]
  RECONCILED          → STATEMENTS_READY     [trigger: AJEs reviewed + committed]
  STATEMENTS_READY    → HESABU_PASSED        [trigger: hesabu-validate gate_satisfied = TRUE]
  HESABU_PASSED       → STATEMENTS_SIGNED    [trigger: Tier 3 sign-off + period lock]
  STATEMENTS_SIGNED   → TAX_COMPUTED         [trigger: KINGA commit + HESABU auto-pass]
  TAX_COMPUTED        → TAX_SIGNED           [trigger: tax sign-off chain complete]
  TAX_SIGNED          → FILING_PACKAGE_READY [trigger: all 3 filing docs generated]
  FILING_PACKAGE_READY → FILED              [trigger: manual CPA confirmation]

Regressions (allowed):
  HESABU_PASSED       → STATEMENTS_READY     [trigger: management input changed]
  TAX_COMPUTED        → TAX_COMPUTED         [trigger: workpaper input changed, re-commit]

Blocked transitions (Iron Dome):
  DATA_INTAKE         → STATEMENTS_SIGNED    BLOCKED (cannot skip SAFISHA)
  RECONCILED          → TAX_COMPUTED         BLOCKED (cannot skip HESABU)
  STATEMENTS_READY    → TAX_SIGNED           BLOCKED (cannot skip sign-off)
```

## 8.2 Mission Availability by State

| Mission | ONBOARDING | DATA_INTAKE | RECONCILED | STATEMENTS_READY | HESABU_PASSED | STATEMENTS_SIGNED | TAX_COMPUTED | TAX_SIGNED | FILING_PACKAGE_READY |
|---|---|---|---|---|---|---|---|---|---|
| 1 Financials | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active | ✓ read-only | ✓ read-only | ✓ read-only | ✓ read-only |
| 2 Tax | 🔒 locked | 🔒 locked | 🔒 locked | 🔒 locked | 🔒 locked | ✓ active | ✓ active | ✓ read-only | ✓ read-only |
| 3 Performance | 🔒 locked | ◐ limited | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active |
| 4 Filing | 🔒 locked | 🔒 locked | 🔒 locked | 🔒 locked | 🔒 locked | 🔒 locked | 🔒 locked | ✓ active | ✓ active |
| 5 Compliance | 🔒 locked | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active |
| 6 Issues | 🔒 locked | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active |
| 7 Manage Firm | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active | ✓ active |

## 8.3 Alert State Machine

```
Alert levels: INFO → WARN → CRITICAL

Alert sources:
  SAFISHA exception     → WARN (low confidence)
  SAFISHA gate fail     → CRITICAL (blocks sign-off)
  HESABU gate fail      → CRITICAL (blocks sign-off)
  Gated rate            → WARN (computation incomplete)
  EFDMS VAT gap CRITICAL → CRITICAL
  TRA deadline < 7 days → WARN
  Finding open > 30 days → WARN

Alert lifecycle:
  ACTIVE → ACKNOWLEDGED → RESOLVED | ESCALATED

An unacknowledged CRITICAL alert must appear on My Work for all relevant roles.
```

---

# 9. MIGRATION STRATEGY

## 9.1 What Does NOT Change

- All 7 engines (SAFISHA, KINGA, HESABU, MAONO, XBRL, Disclosure, Mgmt Letter)
- All edge functions
- All database tables and migrations
- All Iron Dome triggers and constraints
- All SECURITY DEFINER functions
- The three-tier sign-off chain
- HESABU gate enforcement
- append-only tables (safisha_transactions, safisha_audit_log, variance_runs)

## 9.2 What Changes: UI Only

Every change is confined to `src/` (React components and pages).
No migration files. No edge function changes. No schema changes.

## 9.3 Migration Phases

### Phase 0 — Routing Infrastructure (prerequisite)
Add React Router routes for engagement sub-missions.

```
/                           → Home (S-01)
/clients                    → Client List (S-02)
/clients/:companyId         → Engagement list for company
/clients/:companyId/:year   → Engagement Overview (S-03)
/clients/:companyId/:year/financials/upload
/clients/:companyId/:year/financials/reconcile
/clients/:companyId/:year/financials/statements
/clients/:companyId/:year/financials/validate
/clients/:companyId/:year/financials/signoff
/clients/:companyId/:year/tax/computation
/clients/:companyId/:year/tax/workpapers/:tab
/clients/:companyId/:year/tax/efdms
/clients/:companyId/:year/tax/findings
/clients/:companyId/:year/tax/signoff
/clients/:companyId/:year/performance/:tab
/clients/:companyId/:year/filing/:tab
/clients/:companyId/:year/compliance/:tab
/clients/:companyId/:year/issues/:tab
/firm                       → Firm Dashboard (S-24)
/firm/deadlines             → (S-25)
/firm/alerts                → (S-26)
/settings                   → Settings
/settings/statutory-rules   → (S-27, admin only)
/settings/audit-log
```

### Phase 1 — Engagement Overview + Navigation Shell
Build: EngagementLayout (sidebar nav), EngagementOverview screen, engagement state derivation hook.

All existing panels remain on Dashboard.tsx temporarily. No panels are deleted yet.

### Phase 2 — Mission 1: Financials
Move existing panels into routed sub-screens:
- TrialBalanceUpload → `/financials/upload`
- SafishaGate + ExceptionQueue → `/financials/reconcile`
- ExportStatements + AdjustingJournalPanel → `/financials/statements`
- HesabuAssurancePanel → `/financials/validate`
- Sign-off chain (extracted from KingaTaxPanel) → `/financials/signoff`

### Phase 3 — Mission 2: Tax
Move existing panels into routed sub-screens:
- KingaTaxPanel (computation section only) → `/tax/computation`
- CapitalAllowancesRegister, ThinCapWorkpaper, AddBacksWorkpaper, LossCarryForward, InstallmentTax → `/tax/workpapers` (tabbed)
- EFDMSReconciliationPanel → `/tax/efdms`
- KingaFindingsPanel → `/tax/findings`
- Tax sign-off section (extracted from KingaTaxPanel) → `/tax/signoff`

### Phase 4 — Mission 3: Performance
Move MAONO:
- MaonoDashboard → `/performance/variance`
- Cashflow → `/performance/cashflow`
- Risk → `/performance/risk`

### Phase 5 — Mission 4: Filing
Build new Filing screens that call existing edge functions:
- Disclosure Notes screen → calls generate-disclosure-notes
- Management Letter screen → calls generate-management-letter
- XBRL screen → calls generate-xbrl (NEW UI for existing engine)
- TRA Checklist → `/filing/checklist`

### Phase 6 — Mission 5 & 6: Compliance + Issues
Move:
- TRAAuditReadinessPanel, FilingCalendarPanel, PaymentLedgerPanel → `/compliance`
- ExceptionQueue (from SAFISHA) → `/issues/exceptions`
- FindingsPanel (canonical) → `/compliance/findings`

### Phase 7 — Home + My Work
Build role-adaptive Home screen using data already available in DB.

### Phase 8 — Firm Dashboard
Move FirmDashboardPanel, PeriodCloseManager, AlertCenter → `/firm`

### Phase 9 — Dashboard.tsx Retirement
Once all panels are routed, Dashboard.tsx is retired and replaced by EngagementOverview.
Settings.tsx remains but trimmed.

### Phase 10 — Role Gates
Add role detection from firm_members.role and conditionally render missions and screens.

## 9.4 Backwards Compatibility

During Phases 1-9, the old Dashboard.tsx URL (`/dashboard` or `/`) continues to work. New routes activate progressively. At Phase 9, `/dashboard` redirects to `/clients`.

## 9.5 Data Requirements

The engagement state machine requires one new derived view or computed field:

```sql
-- Option A: View (no schema change)
CREATE VIEW engagement_state AS
SELECT
  company_id,
  fiscal_year,
  CASE
    WHEN statement_sign_offs.approver_signed_at IS NOT NULL     THEN 'STATEMENTS_SIGNED'
    WHEN hesabu_validations.gate_satisfied = TRUE               THEN 'HESABU_PASSED'
    WHEN trial_balance_uploads.status = 'complete'
     AND trial_balance_uploads.is_valid = TRUE                  THEN 'STATEMENTS_READY'
    WHEN trial_balance_uploads.status = 'complete'              THEN 'RECONCILED'
    WHEN trial_balance_uploads.id IS NOT NULL                   THEN 'DATA_INTAKE'
    ELSE                                                             'ONBOARDING'
  END AS state
FROM companies
LEFT JOIN trial_balance_uploads USING (company_id)
LEFT JOIN hesabu_validations USING (upload_id)
LEFT JOIN statement_sign_offs USING (upload_id);
```

No new tables. No new migrations required for Phase 0-2.

---

# 10. RISK ASSESSMENT

## 10.1 Iron Dome Integrity Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Navigation refactor accidentally bypasses HESABU gate | Medium | CRITICAL | Gate is enforced at DB layer (trigger on statement_sign_offs). UI state is cosmetic only. |
| Role-gating in UI mistaken for security boundary | High | HIGH | Document explicitly: role gates are UX only. All security enforcement is DB-side. |
| Mission 4 Filing screen exposes XBRL generation before TAX_SIGNED | Medium | MEDIUM | Check engagement state before enabling generate-xbrl call |
| Engagement state machine disagrees with DB reality | Low | HIGH | State is derived from DB queries, not frontend state. Refresh on navigation. |

## 10.2 UX Regression Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| CPA loses orientation during phased migration | High | MEDIUM | Keep /dashboard working until Phase 9 |
| Mobile/tablet unusability of sidebar nav | Medium | MEDIUM | Sidebar collapses to icon-only on narrow screens |
| Upload flow loses "drag and drop here" simplicity | Low | LOW | Upload screen (S-04) is single-focus — simpler than current |
| XBRL screen creates false confidence in regulatory compliance | Medium | HIGH | Prominent note: XBRL output requires manual TRA portal submission and is not a filing confirmation |

## 10.3 Migration Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| KingaTaxPanel is too large to cleanly extract sign-off section | High | MEDIUM | Phase 3: extract sign-off JSX block first, test independently, then remove from KingaTaxPanel |
| React Router conflicts with current routing | Low | MEDIUM | Current app uses react-router-dom — no library change needed |
| Engagement state derived incorrectly for multi-year companies | Medium | MEDIUM | Filter by fiscal_year in all engagement state queries |
| MAONO screens lack data when called outside of old Dashboard context | Low | HIGH | Ensure all MAONO screens receive companyId + periodYear via URL params, not parent component state |

## 10.4 User Adoption Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| CPAs trained on old dashboard resist new navigation | High | MEDIUM | Phased migration: old routes remain. New routes available. No forced cutover. |
| Business Owner view oversimplifies and loses critical tax status | Medium | HIGH | Business Owner role shows health summary + urgent flags, with "View full detail" links to CPA view |
| Deadline calendar gaps (data quality) | Medium | MEDIUM | Calendar pulls from statutory_rules.effective_from — dates must be correct |

## 10.5 REMOVE List (Panels to Eliminate)

| Panel | Reason | Replacement |
|---|---|---|
| Dashboard.tsx (the monolith) | Replaced by EngagementLayout + routed sub-screens | Phase 9 |
| FirmDashboardPanel inside Dashboard | Belongs at /firm, not inside a client engagement | S-24 |
| PeriodCloseManager inside Dashboard | Replaced by Engagement Overview state machine | S-03 |
| ComplianceScorecard inside Dashboard | Merged into Compliance mission (S-22) | S-22 |
| ClientSummaryPanel inside Dashboard | Role-gated view in Engagement Overview (S-03) | S-03 |
| NotificationBell (standalone dropdown) | Replaced by My Work inbox + Firm Alerts | S-01 + S-26 |
| PaymentLedgerPanel (standalone) | Merged into Compliance → Payments tab | S-22 |
| FilingCalendarPanel (standalone) | Merged into Compliance → Deadlines tab | S-22 |
| TRAFilingChecklist (standalone) | Merged into Filing → TRA Checklist | S-20 |
| UploadsStatusPanel | Replaced by Upload screen history + Engagement Overview | S-04 + S-03 |

## 10.6 MERGE List (Duplicate Functionality)

| Duplicate A | Duplicate B | Canonical Location |
|---|---|---|
| Compliance score in ComplianceScorecard | Compliance score in FirmDashboardPanel | Engagement Overview sidebar badge |
| Sign-off status in KingaTaxPanel | Sign-off status in PeriodCloseManager | S-08 (canonical) + S-03 (summary) |
| Filing deadlines in FilingCalendarPanel | Filing deadlines in TRAFilingChecklist | S-22 Compliance → Deadlines |
| Open findings in KingaFindingsPanel | Open findings in ComplianceScorecard | S-12 Tax Findings + S-21 Compliance Findings |
| HESABU panel in KingaTaxPanel | HesabuAssurancePanel standalone | S-07 Validate (canonical) |
| Evidence requests in EvidenceRequestPanel | Evidence requests in TRAAuditReadinessPanel | S-22 Compliance → Evidence |

## 10.7 KEEP List (Already Excellent)

| What | Why |
|---|---|
| HESABU assertion grid (H-01 to H-12) | Complete, accurate, well-structured. Move to S-07 unchanged. |
| SAFISHA exception queue with field mapping | Excellent UX pattern. Move to S-05 unchanged. |
| KINGA tax waterfall with gating notices | Correct design. Move to S-09 unchanged. |
| Three-tier sign-off chain with HESABU gate | Iron Dome design is exactly right. Move to S-08 unchanged. |
| EFDMS Z-report import with TIN anti-impersonation | Correct Iron Dome design. Move to S-11 unchanged. |
| Thin Cap workpaper with GATED amber notice | Correct Iron Dome design post-remediation. |
| Instalment tax schedule (ITA s.88) | Useful, accurate, correctly surfaced from engine output. |
| AJE viewer with approve/reverse | Correct append-only design. Keep in S-06 Statements. |
| Alert system with maono-monitor | Keep structure, improve triage and routing in S-26. |
| Audit log (Settings) | Immutable. Keep exactly as-is. |

---

# APPENDIX: USER JOURNEY SUMMARIES

## First-Time User (CPA onboarding a new client)
1. Create company (CompanyManager, unchanged)
2. Enter TIN, fiscal year end, reporting framework
3. System creates FY engagement → state: ONBOARDING
4. Home → My Work shows "Upload trial balance to begin"
5. Follows: Upload → Reconcile → Statements → Validate → Sign Off → Tax → File
6. System guides through each gate with clear progress indicators

## Monthly Bookkeeping
1. Open engagement → switch to Period view → select month
2. Upload bank statement → SAFISHA auto-runs
3. Resolve any exceptions
4. Import EFDMS Z-reports (if VAT registered)
5. Review gap → close month
6. Total: 3-screen workflow (Upload, Reconcile, EFDMS)

## Quarter-End (VAT return prep)
1. Open 3 monthly periods → check EFDMS VAT gaps for each
2. Aggregate VAT figure from EFDMS reconciliation
3. Compare to KINGA computation VAT figure
4. Compliance → Deadlines → confirm VAT return date
5. Compliance → Payments → log VAT payment

## Year-End
Full path: Mission 1 → Mission 2 → Mission 4 (see Workflow Diagram 7.1)

## External Audit
1. Auditor logs in → sees Compliance + Issues missions only (role-gated)
2. Reviews open findings
3. Requests evidence per finding
4. Signs off at Tier 2 (Reviewer) after evidence satisfied
5. Downloads financial statements PDF for file

## TRA Filing
1. Complete Mission 4 (Filing Package)
2. TRA Checklist: all 6 gates pass
3. Download filing package (financial statements + tax computation + XBRL)
4. Manual upload to TRA portal
5. Mark engagement as FILED

## Bank Loan Preparation
1. Engagement Overview → Performance mission
2. Generate board pack (maono-monitor output)
3. Download financial statements (Mission 1 output)
4. Download management letter (Mission 4 output)
5. Client Summary Panel shows key ratios (retained in S-03 Engagement Overview)

---

*End of document. No code. No file modifications. Architecture only.*
