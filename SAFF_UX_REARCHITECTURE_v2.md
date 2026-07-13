# SAFF ERP — IRON DOME NUCLEAR UX RE-ARCHITECTURE
## Revised Architecture Document · Version 2.0 · 2026-07-13

> **REVISION BASIS:** v1.0 contained a material accounting sequencing defect. Final financial statements were signed and locked before KINGA computed tax provisions, deferred tax, tax AJEs, and tax-note impacts. That sequence is structurally unsafe — locked statements would become stale the moment KINGA ran. This document corrects that defect and eight further issues. No code. No file modifications.

---

# 1. CORRECTED ANNUAL LIFECYCLE

## 1.1 The Defect in v1.0

v1.0 proposed:
```
STATEMENTS_SIGNED (period locked)
    ↓
TAX_COMPUTED
```

This is wrong. Tax computation produces:
- Current tax provision (P&L line item)
- Deferred tax assets and liabilities (SFP balances)
- Tax expense (IAS 12 / IFRS for SMEs s.29)
- Adjusting journal entries affecting retained earnings
- Closing balance for tax payable / prepaid
- Tax notes in the disclosure package
- Statement of Changes in Equity (retained earnings impact)
- Statement of Cash Flows (tax paid line)

Signing and locking statements before these are incorporated produces immutable, incorrect statements. That violates the Iron Dome principle of truthful sign-off.

## 1.2 Corrected Annual Engagement State Machine

```
ONBOARDING
    │  Trigger: Company + fiscal year engagement created
    ▼
DATA_INTAKE
    │  Trigger: Trial balance uploaded → process-trial-balance completes
    ▼
RECONCILED
    │  Trigger: SAFISHA gate passes (all exceptions resolved)
    ▼
DRAFT_STATEMENTS_READY
    │  Trigger: FS Renderer generates SFP, P&L, SCF, SOCIE from reconciled data
    │           Management inputs applied (dividends, share capital)
    │           Prior-year comparatives loaded
    ▼
DRAFT_HESABU_PASSED
    │  Trigger: hesabu-validate passes on draft statements (H-01 to H-12)
    │           Validation tagged with statement_version, AJE_version, input_hash
    │           This is a CHECKPOINT, NOT a sign-off gate
    ▼
TAX_COMPUTED
    │  Trigger: KINGA commits computation
    │           All statutory rates verified in statutory_rules
    │           Tax computation version locked in tax_computations
    │           Tax AJEs auto-generated and presented for CPA review
    ▼
TAX_ADJUSTMENTS_APPLIED
    │  Trigger: CPA reviews and approves tax AJEs
    │           Tax provision, DTA/DTL, retained earnings impact written
    │           to adjusting_journal_entries and closing balances
    ▼
FINAL_STATEMENTS_READY
    │  Trigger: FS Renderer regenerates statements incorporating all tax AJEs
    │           Tax notes populated from KINGA output
    │           Deferred tax note populated (IAS 12 / IFRS for SMEs s.29)
    ▼
FINAL_HESABU_PASSED
    │  Trigger: hesabu-validate passes on FINAL statements
    │           Validation tagged with new statement_version, tax_computation_version
    │           All 12 assertions must pass on the final version
    │           This IS the sign-off gate
    ▼
STATEMENTS_SIGNED
    │  Trigger: Tier 1 → Tier 2 → Tier 3 sign-off chain complete
    │           DB trigger blocks Tier 1 until FINAL_HESABU_PASSED and gate_satisfied = TRUE
    │           Period locked on Tier 3 signature
    │           IMMUTABLE from this point: no further AJEs permitted
    ▼
TAX_SIGNED
    │  Trigger: Tax computation sign-off chain complete
    │           Separate from statement sign-off — tax CPA may differ from FS CPA
    ▼
FILING_PACKAGE_READY
    │  Trigger: All three required package components exist and are approved:
    │           - Disclosure notes (generated + CPA-approved)
    │           - Management letter (generated + CPA-approved)
    │           - XBRL (generated + VALIDATED against taxonomy)
    │           TRA Checklist: all 6 gates pass
    ▼
READY_FOR_MANUAL_SUBMISSION
    │  Trigger: TRA package downloaded + CPA confirms package is complete
    │           System does NOT submit to TRA — CPA does this manually
    │           Status represents "ready" not "submitted"
    ▼
FILED
       Trigger: CPA records submission evidence (see Section 6)
               - return_type
               - submission_reference
               - submitted_at + submitted_by
               - acknowledgement_file_id + acknowledgement_hash
               - submission_channel
```

## 1.3 Permitted Regressions

| From | To | Trigger | Effect |
|---|---|---|---|
| DRAFT_HESABU_PASSED | DRAFT_STATEMENTS_READY | Management input changed | Draft HESABU result marked STALE |
| TAX_COMPUTED | TAX_COMPUTED | Workpaper input changed → re-commit | New tax computation version; prior AJEs voided |
| TAX_ADJUSTMENTS_APPLIED | TAX_COMPUTED | CPA rejects a tax AJE | AJE rejected in audit log; re-review required |
| FINAL_STATEMENTS_READY | TAX_ADJUSTMENTS_APPLIED | FS Renderer detects AJE not yet incorporated | Rerun FS Renderer with correct AJE set |
| FINAL_HESABU_PASSED | FINAL_STATEMENTS_READY | Any downstream change (see Section 2) | Final HESABU result marked STALE |

## 1.4 Blocked Transitions (Iron Dome)

```
RECONCILED          →→ STATEMENTS_SIGNED    BLOCKED — must pass all intermediate states
DATA_INTAKE         →→ TAX_COMPUTED         BLOCKED — SAFISHA gate required first
DRAFT_HESABU_PASSED →→ STATEMENTS_SIGNED    BLOCKED — tax must complete first
TAX_COMPUTED        →→ STATEMENTS_SIGNED    BLOCKED — tax AJEs must be applied + FINAL_HESABU required
FILING_PACKAGE_READY →→ FILED              BLOCKED — submission evidence required; auto-marking is prohibited
```

---

# 2. HESABU FRESHNESS MODEL

## 2.1 Why a Boolean is Insufficient

`gate_satisfied = TRUE` is a point-in-time assertion. It becomes misleading the moment any of its inputs change. The current implementation already tracks `computed_at` vs `validated_at` staleness. That must be extended.

## 2.2 Validation Version Object

Every HESABU run must produce and persist:

```
hesabu_validation_record {
  id
  upload_id
  company_id

  -- Version fingerprint (what was validated)
  statement_version        INTEGER       -- monotonic counter per upload_id
  tax_computation_version  INTEGER       -- from tax_computations.version
  aje_version              INTEGER       -- count of approved AJEs at time of run
  management_input_hash    TEXT          -- SHA-256 of all management inputs
  engine_version           TEXT          -- hesabu-validate function version
  input_hash               TEXT          -- SHA-256 of all assertion inputs combined

  -- Result
  gate_satisfied           BOOLEAN
  assertions_json          JSONB         -- H-01 to H-12 results
  validated_at             TIMESTAMPTZ

  -- Freshness
  stale                    BOOLEAN DEFAULT FALSE
  stale_at                 TIMESTAMPTZ
  stale_reason             TEXT
}
```

## 2.3 Staleness Triggers

A HESABU result is marked stale when ANY of the following change after validated_at:

| Change | Stale reason |
|---|---|
| Tax computation re-committed | `tax_computation_changed` |
| AJE approved or reversed | `aje_set_changed` |
| Management input updated (dividends, share capital, disposal proceeds) | `management_input_changed` |
| Closing balance changed | `closing_balance_changed` |
| Trial balance re-uploaded | `source_data_changed` |
| FS Renderer re-run (new statement version) | `statement_version_changed` |
| hesabu-validate engine deployed (new version) | `engine_updated` |

## 2.4 Staleness Enforcement

A stale HESABU result MUST NOT satisfy the sign-off gate, even if gate_satisfied = TRUE on the record. The check is:

```
gate_satisfied = TRUE
AND stale = FALSE
AND validated_at > (last material change timestamp)
```

The DB trigger `hesabu_block_signoff()` must evaluate all three conditions, not just gate_satisfied.

## 2.5 Draft vs Final Validation Context

| Context | Purpose | Sign-off gate? | Stale = block? |
|---|---|---|---|
| DRAFT_HESABU run | Early warning; catch gross errors before tax | No | Advisory only |
| FINAL_HESABU run | Assurance on complete, tax-inclusive statements | YES | YES — blocks sign-off |

The hesabu_validations table must carry a `validation_context` field: `'draft'` or `'final'`. The sign-off trigger only evaluates records where `validation_context = 'final'`.

---

# 3. ANNUAL ENGAGEMENT AND MONTHLY COMPLIANCE PERIODS

## 3.1 Two Distinct Work Units

The annual engagement and monthly compliance periods are related but structurally different. They must not share the same period/month model.

### Annual Engagement
```
engagements {
  id
  company_id
  fiscal_year                  INTEGER    -- e.g. 2025
  fiscal_year_end              DATE       -- e.g. 2025-12-31
  reporting_framework          TEXT       -- IFRS | IFRS_SME | IAS
  engagement_state             TEXT       -- state machine above
  created_at
  created_by
}
```

Owns: trial balance, SAFISHA reconciliation, financial statements, HESABU validations, tax computation, workpapers, disclosure notes, management letter, XBRL, filing package, sign-off chain.

### Monthly Compliance Period
```
compliance_periods {
  id
  company_id
  calendar_year                INTEGER    -- e.g. 2025
  calendar_month               INTEGER    -- e.g. 6 (June)
  obligation_type              TEXT       -- VAT | PAYE | SDL | EFDMS_MONTHLY
  period_state                 TEXT       -- OPEN | EVIDENCE_COLLECTED | RECONCILED | FILED
  vat_return_source            TEXT       -- TRA_API | VAT_RETURN_UPLOAD | APPROVED_VAT_SCHEDULE | MANUAL_CONFIRMED
  vat_return_evidence_id       UUID       -- FK to filing_evidence
  created_at
}
```

Owns: Z-report imports (efdms_z_reports), monthly VAT/PAYE/SDL obligations, monthly evidence, monthly reconciliation, monthly payment records.

## 3.2 Relationship

An annual engagement covers 12 monthly compliance periods. The annual CIT return is an annual-engagement artifact. Monthly VAT returns are compliance-period artifacts.

```
engagement (FY2025)
├── compliance_period (Jan 2025, VAT)
├── compliance_period (Feb 2025, VAT)
│   ...
└── compliance_period (Dec 2025, VAT)
```

The EFDMS/Z-report data in efdms_z_reports belongs to a compliance_period, not directly to an engagement. The annual tax engine (KINGA) may read aggregate EFDMS data from all periods in the fiscal year, but does not own it.

## 3.3 Navigation Implication

The engagement navigation sidebar (Section 5 of v1.0) must split into two entry points:

```
[Company] → [Annual · FY2025]       → 6 annual missions
[Company] → [Monthly · June 2025]   → monthly compliance mission
```

The monthly mission is not a sub-step of the annual missions. It runs independently, every month, for its own lifecycle.

---

# 4. EFDMS / VAT SOURCE CORRECTION

## 4.1 The v1.0 Error

v1.0 stated: "EFDMS gross vs. VAT return — compare to KINGA computation VAT figure."

KINGA is a corporate income tax engine. It reads revenue to compute taxable income. It is not the authoritative monthly VAT-return source. Comparing Z-report totals to KINGA's revenue figure does not constitute a filed VAT reconciliation.

## 4.2 Correct VAT Reconciliation

The EFDMS reconciliation must compare:

```
EFDMS / Z-report evidence (gross_sales, vat_collected)
        versus
Approved filed VAT return (gross_sales_filed, output_vat_filed)
```

## 4.3 VAT Return Source Modes

| source_type | Description | Notes |
|---|---|---|
| TRA_API | Live pull from TRA IDRAS API | Authoritative if API available |
| VAT_RETURN_UPLOAD | CPA uploads the filed return PDF/CSV | CPA must confirm it matches what was submitted |
| APPROVED_VAT_SCHEDULE | CPA manually enters filed-return totals | Requires CPA sign-off on the entry |
| MANUAL_CONFIRMED | Accountant confirms figures manually | Lowest assurance; flagged accordingly |

## 4.4 VAT Reconciliation State

```
VAT_RETURN_EVIDENCE_REQUIRED    ← No approved VAT-return source exists
EVIDENCE_COLLECTED              ← Z-reports present, VAT return source present
RECONCILED_CLEAN                ← Gap within materiality threshold
RECONCILED_GAP                  ← Gap exceeds materiality; documented and approved
DISPUTE_OPEN                    ← Gap under dispute; TRA correspondence filed
```

If no approved VAT-return source exists, the monthly compliance period cannot advance beyond `EVIDENCE_COLLECTED`. The UI must show `VAT_RETURN_EVIDENCE_REQUIRED` — not a percentage gap — because the denominator does not exist.

## 4.5 What KINGA May Legitimately Use from EFDMS

KINGA may read aggregate EFDMS annual gross sales as a cross-check against TB-derived revenue (a finding, not a reconciliation). This is a risk signal, not a VAT computation. It must be presented as:

> "EFDMS annual gross sales: TZS X. TB revenue: TZS Y. Variance: TZS Z. This is a cross-check signal only — not a filed VAT reconciliation."

---

# 5. MINIMUM PERSISTENCE MODEL

## 5.1 Why "UI Only" is Insufficient

The following items cannot be safely derived forever from scattered columns in existing tables:

| Item | Why derivation is unsafe |
|---|---|
| Engagement lifecycle state | Derived state can diverge if tables are updated out of order or by admin |
| State transition history | There is no audit trail of when a state was entered or who triggered it |
| Compliance periods | Monthly obligation tracking has no canonical table |
| Filing packages | Which components are in the package is not persisted |
| Submission evidence | No structured record of TRA submission reference + acknowledgement |
| Validation freshness | Staleness is currently a single boolean; versioned freshness requires a richer record |

## 5.2 Minimum Schema Additions (Not Migrations — Design Only)

### Table: engagements

```
engagements
  id                    UUID PK
  company_id            UUID FK → companies
  fiscal_year           INTEGER NOT NULL
  fiscal_year_end       DATE NOT NULL
  reporting_framework   TEXT CHECK IN ('IFRS','IFRS_SME','IAS')
  engagement_state      TEXT NOT NULL DEFAULT 'ONBOARDING'
  locked_at             TIMESTAMPTZ         -- set on STATEMENTS_SIGNED
  locked_by             UUID FK → firm_members
  created_at            TIMESTAMPTZ
  created_by            UUID FK → firm_members
  UNIQUE (company_id, fiscal_year)
```

### Table: engagement_state_events

```
engagement_state_events
  id                    UUID PK
  engagement_id         UUID FK → engagements
  from_state            TEXT
  to_state              TEXT NOT NULL
  triggered_by          UUID FK → firm_members
  trigger_source        TEXT    -- 'user_action' | 'engine_event' | 'admin_override'
  trigger_detail        JSONB   -- what caused the transition
  created_at            TIMESTAMPTZ
  APPEND-ONLY (no UPDATE, no DELETE — enforced by trigger)
```

### Table: compliance_periods

```
compliance_periods
  id                    UUID PK
  company_id            UUID FK → companies
  engagement_id         UUID FK → engagements   -- nullable (monthly periods link to annual)
  calendar_year         INTEGER NOT NULL
  calendar_month        INTEGER NOT NULL CHECK (calendar_month BETWEEN 1 AND 12)
  obligation_type       TEXT NOT NULL CHECK IN ('VAT','PAYE','SDL','EFDMS_MONTHLY')
  period_state          TEXT NOT NULL DEFAULT 'OPEN'
  vat_return_source     TEXT CHECK IN ('TRA_API','VAT_RETURN_UPLOAD','APPROVED_VAT_SCHEDULE','MANUAL_CONFIRMED')
  vat_return_evidence_id UUID FK → filing_evidence
  filed_at              TIMESTAMPTZ
  filed_by              UUID FK → firm_members
  created_at            TIMESTAMPTZ
  UNIQUE (company_id, calendar_year, calendar_month, obligation_type)
```

### Table: filing_packages

```
filing_packages
  id                    UUID PK
  engagement_id         UUID FK → engagements
  package_state         TEXT NOT NULL DEFAULT 'DRAFT'
  disclosure_notes_id   UUID    -- FK to generated disclosure notes record
  management_letter_id  UUID    -- FK to generated management letter record
  xbrl_instance_id      UUID    -- FK to xbrl_instances
  checklist_passed_at   TIMESTAMPTZ
  checklist_passed_by   UUID FK → firm_members
  package_hash          TEXT    -- SHA-256 of all three components combined
  created_at            TIMESTAMPTZ
  UNIQUE (engagement_id)        -- one canonical package per engagement
```

### Table: filing_submissions (FILED evidence)

```
filing_submissions
  id                    UUID PK
  engagement_id         UUID FK → engagements
  compliance_period_id  UUID FK → compliance_periods    -- nullable (annual = null)
  return_type           TEXT NOT NULL  -- 'ANNUAL_CIT' | 'VAT' | 'SDL' | 'PAYE'
  submission_channel    TEXT NOT NULL  -- 'TRA_PORTAL' | 'MANUAL_LODGEMENT' | 'API'
  submission_reference  TEXT NOT NULL  -- TRA reference number
  submitted_at          TIMESTAMPTZ NOT NULL
  submitted_by          UUID FK → firm_members
  acknowledgement_file_id UUID         -- uploaded ACK document
  acknowledgement_hash  TEXT          -- SHA-256 of ACK document
  submission_notes      TEXT
  created_at            TIMESTAMPTZ
  APPEND-ONLY
```

### Table: xbrl_instances

```
xbrl_instances
  id                    UUID PK
  engagement_id         UUID FK → engagements
  xbrl_state            TEXT NOT NULL DEFAULT 'DRAFT'
                        CHECK IN ('DRAFT','GENERATED','VALIDATION_FAILED','VALIDATED','EXPORTED','SUBMITTED','ACKNOWLEDGED','REJECTED')
  taxonomy_version      TEXT
  generated_at          TIMESTAMPTZ
  generated_by          UUID FK → firm_members
  validated_at          TIMESTAMPTZ
  validation_errors     JSONB
  exported_at           TIMESTAMPTZ
  submitted_at          TIMESTAMPTZ
  acknowledgement_ref   TEXT
  rejected_reason       TEXT
  instance_file_id      UUID            -- stored in Supabase Storage
  instance_hash         TEXT
  APPEND-ONLY
```

## 5.3 Authoritative Data Ownership Matrix

| Data Domain | Authoritative Table | Written By | Read By |
|---|---|---|---|
| Financial transactions | safisha_transactions | safisha-ingest (SECURITY DEFINER) | KINGA, HESABU, MAONO |
| Account classification | safisha_client_mappings | FieldMappingModal → safisha-categorize | KINGA |
| Tax computation | tax_computations | kinga-tax-engine | HESABU, FS Renderer, Filing |
| Tax workpapers | capital_allowances, tax_computation_detail (JSONB) | kinga-tax-engine | Tax UI panels |
| Financial statements | Derived at runtime by FS Renderer | FS Renderer | HESABU, Disclosure, Export |
| HESABU validations | hesabu_validations | hesabu-validate (SECURITY DEFINER) | Sign-off gate, UI |
| Adjusting journals | adjusting_journal_entries | kinga-tax-engine + CPA approval | FS Renderer, HESABU |
| Closing balances | period_closing_balances | kinga-tax-engine | Next-year KINGA, FS Renderer |
| Sign-off chain | statement_sign_offs | hesabu_write_signoff (SECURITY DEFINER) | Period lock trigger |
| EFDMS Z-reports | efdms_z_reports | safisha-efdms-ingest | Monthly VAT reconciliation |
| Monthly VAT return evidence | compliance_periods.vat_return_evidence_id | CPA upload/confirmation | VAT reconciliation |
| Filing package | filing_packages | generate-filing-package | TRA Checklist, XBRL |
| Submission evidence | filing_submissions | CPA manual entry | FILED state gate |
| Engagement lifecycle | engagement_state_events | State machine (SECURITY DEFINER) | All UI navigation |
| Statutory rates | statutory_rules | Admin only (verified_at required) | KINGA (rate lookup) |
| Variance analysis | variance_runs | maono-compute | MAONO UI |
| Alert records | alert_events | SECURITY DEFINER (various triggers) | AlertCenter, My Work |

---

# 6. FILED STATE — EVIDENCE REQUIREMENTS

## 6.1 Evidence Schema

A filing_submissions record requires all of the following before an engagement can enter FILED state:

```
return_type              Mandatory — identifies what was filed
submission_channel       Mandatory — how it was submitted (TRA portal / manual / API)
submission_reference     Mandatory — TRA's reference number / receipt number
submitted_at             Mandatory — timestamp of submission (may differ from created_at)
submitted_by             Mandatory — firm_member who submitted
acknowledgement_file_id  Strongly recommended — scanned ACK from TRA
acknowledgement_hash     Mandatory if file present — integrity check
```

## 6.2 Without Evidence

Without a filing_submissions record that satisfies the above, the engagement state ceiling is READY_FOR_MANUAL_SUBMISSION. The UI must communicate clearly:

> "The filing package has been prepared and downloaded. Mark as Filed only after you have received TRA acknowledgement. Enter your submission reference and acknowledgement document before proceeding."

## 6.3 TRA Acknowledgement Caveat

The system must not represent FILED as TRA acceptance. The state means "CPA has recorded evidence of submission." TRA acceptance is a separate event:

```
FILED         → submission evidence recorded
              (TRA may accept, reject, query, or audit)
```

The system has no API link to TRA acceptance. XBRL_ACKNOWLEDGED (if TRA returns an API receipt) is a separate state within xbrl_instances, not an engagement-level state.

---

# 7. XBRL STATE MACHINE

## 7.1 Full State Machine

```
DRAFT               ← XBRL generation has not run yet
    │
    ▼  [Generate XBRL button pressed; engagement = FILING_PACKAGE_READY]
GENERATED           ← generate-xbrl produced instance document
    │
    ├──→ VALIDATION_FAILED  ← taxonomy errors detected
    │        │
    │        ▼  [CPA fixes source data; regenerate]
    │    GENERATED (new version)
    │
    ▼  [All taxonomy assertions pass]
VALIDATED           ← instance document conforms to TNFRS taxonomy
    │
    ▼  [CPA downloads the validated instance]
EXPORTED            ← instance document downloaded to local machine
    │
    ▼  [CPA submits to TRA portal and records submission ref]
SUBMITTED           ← filing_submissions record created (xbrl channel)
    │
    ├──→ REJECTED    ← TRA returns rejection (CPA records reason)
    │        │
    │        ▼  [Fix and regenerate]
    │    DRAFT (new version)
    │
    ▼  [TRA issues receipt]
ACKNOWLEDGED        ← acknowledgement_ref recorded in xbrl_instances
```

## 7.2 Invariants

```
XBRL_GENERATED   ≠ XBRL_VALIDATED
XBRL_VALIDATED   ≠ FILED
FILED            ≠ ACCEPTED_BY_REGULATOR
ACKNOWLEDGED     ≠ TAX_LIABILITY_SETTLED
```

These must appear as explicit notices in the XBRL UI screen — not in the footer, not in tooltips. They must be visible, permanent, and in the primary content area.

## 7.3 Versioning

Each XBRL generation creates a new xbrl_instances row (append-only). The filing_packages.xbrl_instance_id points to the specific validated version included in the filing package. Generating a new XBRL version does not invalidate the filing package unless the CPA explicitly replaces the linked instance.

---

# 8. STATE-TRANSITION AUTHORIZATION MATRIX

## 8.1 Core Principle

UI role gates are navigation convenience. They are not security controls. Every state transition must be enforced by:
1. A DB trigger or SECURITY DEFINER function on the relevant table
2. Server-side role check in the edge function (`supabase.auth.getUser()` → `firm_members.role`)
3. An immutable audit event in `engagement_state_events`

## 8.2 Annual Engagement Transitions

| Transition | Allowed Roles | DB Enforcement | Edge Function | Audit Event |
|---|---|---|---|---|
| ONBOARDING → DATA_INTAKE | accountant, cpa, partner | None (upload completion) | process-trial-balance | engagement_state_events |
| DATA_INTAKE → RECONCILED | cpa, partner | safisha_gate_passed trigger | safisha-score | engagement_state_events |
| RECONCILED → DRAFT_STATEMENTS_READY | cpa, partner | AJE commit confirmation | FS Renderer | engagement_state_events |
| DRAFT_STATEMENTS_READY → DRAFT_HESABU_PASSED | system only | hesabu-validate | hesabu-validate | hesabu_validations |
| DRAFT_HESABU_PASSED → TAX_COMPUTED | cpa, partner | tax_computations INSERT trigger | kinga-tax-engine | engagement_state_events |
| TAX_COMPUTED → TAX_ADJUSTMENTS_APPLIED | cpa, partner | AJE approval gate | kinga-tax-engine | adjusting_journal_entries |
| TAX_ADJUSTMENTS_APPLIED → FINAL_STATEMENTS_READY | system only | FS Renderer completion | FS Renderer | engagement_state_events |
| FINAL_STATEMENTS_READY → FINAL_HESABU_PASSED | system only | hesabu-validate (context=final) | hesabu-validate | hesabu_validations |
| FINAL_HESABU_PASSED → STATEMENTS_SIGNED | preparer/reviewer/approver per tier | hesabu_block_signoff trigger | — | statement_sign_offs |
| STATEMENTS_SIGNED → TAX_SIGNED | tax_cpa, partner | sign-off trigger | — | statement_sign_offs |
| TAX_SIGNED → FILING_PACKAGE_READY | cpa, partner | TRA checklist gate | generate-filing-package | filing_packages |
| FILING_PACKAGE_READY → READY_FOR_MANUAL_SUBMISSION | cpa, partner | package_hash present | — | engagement_state_events |
| READY_FOR_MANUAL_SUBMISSION → FILED | cpa, partner | filing_submissions INSERT required | — | filing_submissions + engagement_state_events |

## 8.3 Monthly Compliance Period Transitions

| Transition | Allowed Roles | DB Enforcement | Audit Event |
|---|---|---|---|
| OPEN → EVIDENCE_COLLECTED | accountant, cpa | Z-reports + VAT source present | compliance_periods update |
| EVIDENCE_COLLECTED → RECONCILED | cpa | Reconciliation approved | compliance_periods + engagement_state_events |
| RECONCILED → FILED (monthly) | cpa, partner | filing_submissions INSERT | filing_submissions |

## 8.4 Sign-Off Role Mapping

```
Tier 1 — Preparer:   role IN ('accountant', 'cpa')
                     HESABU final gate must pass (gate_satisfied=TRUE, stale=FALSE)
Tier 2 — Reviewer:   role IN ('cpa', 'auditor', 'partner')
                     Tier 1 must be signed
Tier 3 — Approver:   role IN ('partner', 'director')
                     Tier 2 must be signed
                     Period is locked on this signature
```

A user cannot sign their own work at multiple tiers. If one CPA has the role to sign Tier 1, they cannot also be the Tier 2 reviewer for the same engagement. This must be enforced by a DB constraint, not UI.

---

# 9. ENGINE BOUNDARIES (CORRECTED)

## 9.1 FS Renderer — Separated from HESABU

v1.0 did not distinguish between statement generation and statement validation. These must be separate engines.

```
FS RENDERER
Inputs:  reconciled safisha_transactions
         approved adjusting_journal_entries
         tax_computations (tax provision, DTA/DTL)
         management inputs (dividends, share capital, disposal proceeds)
         period_closing_balances (prior year)
Outputs: SFP, P&L, SCF, SOCIE (derived at runtime, not stored as rows)
         Generates: statement_version counter
Rule:    FS Renderer may be called any number of times. Each call reads
         current state of inputs. No output is stored permanently until
         sign-off locks the engagement.

HESABU
Inputs:  FS Renderer output (statement snapshot at time of run)
         Statement version, tax computation version, AJE version
Outputs: H-01 to H-12 assertion results
         hesabu_validations row (append-only)
Rule:    HESABU validates, it does not generate. HESABU must never
         modify any input to the FS Renderer. HESABU must never
         write to tax_computations or adjusting_journal_entries.
```

## 9.2 Canonical Engine Boundaries

### SAFISHA — Financial Data Integrity
Owns:
- Transaction ingestion (safisha-ingest)
- Bank-to-TB reconciliation and matching (safisha-match)
- Account categorization and confidence scoring (safisha-categorize, safisha-score)
- Exception resolution workflow (safisha-resolve)
- EFDMS Z-report ingestion (safisha-efdms-ingest)
- Clean-data gate (SAFISHA gate)

Does NOT own:
- Statement presentation
- Tax computation
- Financial analysis
- Monthly VAT-return evidence (SAFISHA ingests Z-reports; VAT-return evidence is a compliance_periods concern)

### KINGA — Tax Determination
Owns:
- Corporate income tax computation (ITA Cap.332)
- Statutory findings (CIT, SDL, TP, PAYE signals)
- Tax workpapers (thin cap s.12(2), add-backs, W&T s.34, loss pool)
- Tax AJE generation (current tax provision, DTA/DTL)
- Tax sign-off inputs
- Instalment schedule (ITA s.88)

Does NOT own:
- Statement validation
- Monthly VAT computation (monthly obligations are compliance_periods)
- Financial analysis
- Raw transaction reconciliation

### FS RENDERER — Financial Statement Generation
Owns:
- Reading reconciled transactions from SAFISHA
- Reading approved AJEs from adjusting_journal_entries
- Reading tax outputs from tax_computations
- Producing SFP, P&L, SCF, SOCIE
- Producing comparative columns
- Assigning statement_version

Does NOT own:
- Validating what it generates (that is HESABU's job)
- Computing any line item independently (reads from authoritative tables only)

### HESABU — Financial Statement Assurance
Owns:
- Cross-statement consistency (H-01 to H-12)
- Statement completeness checks
- Presentation checks (IFRS / IFRS for SMEs)
- Note coverage verification
- Final sign-off gate enforcement
- Validation freshness tracking

Does NOT own:
- Statement generation
- Tax law computation
- Financial forecasting
- Any write to tax_computations, adjusting_journal_entries, or safisha_transactions

### MAONO — Financial Analysis and Decision Support
Owns:
- Budget vs. actual variance analysis
- Cash flow forecasting
- Financial risk signals (Z-score, TRA audit signal)
- Root cause analysis narratives (Claude, tool-use citation)
- Decision path generation (never auto-executed)
- Management insights

Does NOT own:
- Canonical accounting totals (reads from safisha_transactions and tax_computations)
- Statutory findings (reads from findings, does not generate)
- AJE generation or approval
- Any write to financial tables
- Regulatory filing authority

### DISCLOSURE ENGINE — Statutory Notes
Owns:
- IAS/IFRS disclosure notes (generate-disclosure-notes)
- Note-to-account cross-references
- Regulatory template compliance

Does NOT own:
- Statement generation
- Tax computation

### MANAGEMENT LETTER ENGINE — Advisory Report
Owns:
- Management letter generation (generate-management-letter)
- MAONO-informed narrative on control weaknesses and risks

Does NOT own:
- Statutory findings (reads, does not generate)
- Tax positions

### XBRL ENGINE — Taxonomy Instance
Owns:
- XBRL instance document generation (generate-xbrl)
- TNFRS taxonomy mapping
- Instance validation
- State tracking (DRAFT → VALIDATED → EXPORTED)

Does NOT own:
- Statement values (reads from FS Renderer output)
- Filing confirmation (XBRL_VALIDATED ≠ FILED)

---

# 10. UPDATED NAVIGATION TREE

## 10.1 Top Level

```
SAFF ERP
│
├── My Work          ← Role-adaptive inbox (alerts, tasks, deadlines)
│
├── Clients
│   └── [Company]
│       ├── Annual Work
│       │   └── [FY2025 Engagement]
│       │       ├── Overview               ← Engagement lifecycle state
│       │       ├── 1 · Close Books        (Missions 1A–1E)
│       │       ├── 2 · Compute Tax        (Mission 2)
│       │       ├── 3 · Analyse            (Mission 3)
│       │       ├── 4 · File Returns       (Mission 4)
│       │       ├── 5 · Compliance         (Mission 5)
│       │       └── 6 · Issues             (Mission 6)
│       │
│       └── Monthly Work
│           └── [June 2025]
│               ├── VAT Reconciliation
│               ├── PAYE Check
│               └── SDL Check
│
├── Firm             ← Partner / Manager only
│   ├── Dashboard
│   ├── Deadlines
│   └── Alerts
│
└── [Avatar]
    ├── Profile
    ├── Settings
    │   ├── Firm Settings
    │   ├── Statutory Rules   (Admin only)
    │   └── Audit Log
    └── Sign Out
```

## 10.2 Annual Engagement Sidebar — "Close Books" (Mission 1)

User-facing label is "Close Books" not "Financials" — professional accounting language.

```
1 · Close Books
├── 1A · Import Data            ← Upload trial balance
├── 1B · Reconcile              ← SAFISHA exception queue
├── 1C · Draft Statements       ← FS Renderer output, AJEs, management inputs
├── 1D · Draft Validation       ← HESABU draft run (advisory, not gate)
└── 1E · Final Review & Sign Off ← After tax (unlocks post TAX_ADJUSTMENTS_APPLIED)
    ├── Final Statements        ← FS Renderer with tax AJEs incorporated
    ├── Final Validation        ← HESABU final run (this is the gate)
    └── Sign Off Chain          ← Tier 1 → 2 → 3 + period lock
```

## 10.3 Annual Engagement Sidebar — "Compute Tax" (Mission 2)

```
2 · Compute Tax
├── 2A · Tax Computation        ← KINGA waterfall (unlocks after DRAFT_HESABU_PASSED)
├── 2B · Workpapers
│   ├── Capital Allowances      ← ITA s.34
│   ├── Thin Cap                ← ITA s.12(2) — GATED until rates verified
│   ├── Add-Backs               ← Full ITA schedule
│   ├── Loss Pool               ← Carry-forward tracker
│   └── Instalment Schedule     ← ITA s.88
├── 2C · Tax AJEs               ← Generated by KINGA; CPA approval required
├── 2D · Findings               ← Statutory exposure items
└── 2E · Tax Sign Off           ← After STATEMENTS_SIGNED
```

## 10.4 Monthly Compliance Sidebar

```
Monthly · June 2025 · VAT
├── Z-Report Import             ← safisha-efdms-ingest
├── VAT Return Evidence         ← Upload or confirm approved VAT return
├── Reconciliation              ← EFDMS vs. VAT return (not vs. KINGA)
└── Payment & Filing            ← filing_submissions for monthly VAT
```

---

# 11. MISSION AVAILABILITY MATRIX (REVISED)

| Mission | ONBOARDING | DATA_INTAKE | RECONCILED | DRAFT_STMTS_READY | DRAFT_HESABU_PASSED | TAX_COMPUTED | TAX_ADJ_APPLIED | FINAL_STMTS_READY | FINAL_HESABU_PASSED | STMTS_SIGNED | TAX_SIGNED | FILING_READY |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1A Import | ✓ | ✓ | ✓* | ✓* | ✓* | ✓* | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 |
| 1B Reconcile | 🔒 | ✓ | ✓ | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 |
| 1C Draft Stmts | 🔒 | 🔒 | ✓ | ✓ | ✓ | ✓ | ✓ | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 |
| 1D Draft Validation | 🔒 | 🔒 | 🔒 | ✓ | ✓ | ✓ | ✓ | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 |
| 1E Final Review + Sign Off | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | ✓ | ✓ | read | read | read |
| 2A Tax Computation | 🔒 | 🔒 | 🔒 | 🔒 | ✓ | ✓ | 🔒 | 🔒 | 🔒 | 🔒 | read | read |
| 2B Workpapers | 🔒 | 🔒 | 🔒 | 🔒 | ✓ | ✓ | ✓ | 🔒 | 🔒 | 🔒 | read | read |
| 2C Tax AJEs | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | ✓ | ✓ | 🔒 | 🔒 | 🔒 | read | read |
| 2D Findings | 🔒 | 🔒 | 🔒 | 🔒 | ✓ | ✓ | ✓ | ✓ | ✓ | read | read | read |
| 2E Tax Sign Off | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | ✓ | read | read |
| 3 Analyse | 🔒 | ◐ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 4 File Returns | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | 🔒 | ✓ | ✓ |
| 5 Compliance | 🔒 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 6 Issues | 🔒 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

*Re-upload after DRAFT_STATEMENTS_READY is permitted but resets the engagement to DATA_INTAKE and marks all subsequent states stale.
🔒 = locked (not accessible)
◐ = limited (MAONO available but no budget data yet)
read = accessible in read-only mode

---

# 12. VALIDATION FRESHNESS MODEL (COMPLETE)

## 12.1 What Invalidates a HESABU Result

```
Input change                          → New statement_version needed?  → HESABU stale?
──────────────────────────────────────────────────────────────────────────────────────
Trial balance re-uploaded             YES                               YES — reset to DATA_INTAKE
Exception resolved / unresolved       YES (minor)                      YES — re-run FS Renderer
AJE approved or reversed              YES                               YES
Management input changed              YES                               YES
Tax computation re-committed          YES                               YES (for final; advisory for draft)
Tax AJE approved or rejected          YES                               YES (for final)
Closing balance changed               YES                               YES
HESABU engine redeployed (new version) NO (inputs unchanged)           YES — engine version mismatch
```

## 12.2 Staleness Communication

```
DRAFT HESABU result:
  If stale: advisory amber banner ("Draft validation is stale. Re-run before proceeding to tax.")
  Stale draft does NOT block tax computation — CPA must acknowledge staleness

FINAL HESABU result:
  If stale: critical red banner ("Final validation is stale. Cannot proceed to sign-off.")
  Stale final BLOCKS sign-off — DB trigger refuses INSERT to statement_sign_offs
```

## 12.3 Validation Run History

All HESABU runs are retained. The UI shows a validation history panel:

```
Run #4  [FINAL]  2026-07-13 14:32  PASSED  statement_v4  tax_comp_v2  aje_v3  ✓ Current
Run #3  [DRAFT]  2026-07-13 11:15  PASSED  statement_v3  tax_comp_v1  aje_v2  ⊘ Stale (tax changed)
Run #2  [DRAFT]  2026-07-13 09:44  FAILED  statement_v2  —            aje_v1  ⊘ Stale
Run #1  [DRAFT]  2026-07-12 16:03  FAILED  statement_v1  —            aje_v0  ⊘ Stale
```

---

# 13. PHASED MIGRATION PLAN (REVISED)

## 13.1 What Does NOT Change

- All 7 engines (SAFISHA, KINGA, HESABU, MAONO, XBRL, Disclosure, Management Letter)
- All existing edge functions
- Iron Dome triggers and constraints
- SECURITY DEFINER functions
- Three-tier sign-off chain mechanics
- HESABU assertion logic (H-01 to H-12)
- Append-only tables

## 13.2 Migration Phases

### Phase 0 — Schema Additions (DB work, pre-migration)
New tables: `engagements`, `engagement_state_events`, `compliance_periods`, `filing_packages`, `filing_submissions`, `xbrl_instances`.

Derived view: `engagement_state_v` as bridge until canonical table is live.

Extend `hesabu_validations`: add `validation_context`, `statement_version`, `tax_computation_version`, `aje_version`, `management_input_hash`, `stale`, `stale_at`, `stale_reason`.

### Phase 1 — Routing Shell
Add React Router v6 nested routes. Build `EngagementLayout` (sidebar nav). Build `EngagementOverview` screen. Existing Dashboard.tsx continues to work at `/dashboard`.

### Phase 2 — Close Books (Mission 1, Steps A–D)
Move upload, reconcile, draft statements, draft HESABU into routed sub-screens. Draft sign-off screen built but gated until Phase 3 is complete.

### Phase 3 — Compute Tax (Mission 2)
Move KINGA panels into `/tax/`. New screen: Tax AJEs (Mission 2C). Sign-off screen (Mission 2E) is built but gated until Mission 1E is complete.

### Phase 4 — Final Review + Sign Off (Mission 1E)
Build final statements screen (post-tax). Build final HESABU screen. Wire final sign-off chain gated on `FINAL_HESABU_PASSED`.

**This is the critical phase. Tax must be deployed and working before Phase 4 can go live.**

### Phase 5 — Analyse (Mission 3)
Move MAONO panels. No sequencing dependency on Phases 3–4.

### Phase 6 — File Returns (Mission 4)
Build XBRL screen with full state machine. Build disclosure notes and management letter screens. Build filing package + TRA checklist. Implement READY_FOR_MANUAL_SUBMISSION gate. Implement FILED evidence form.

### Phase 7 — Compliance + Issues (Missions 5–6)
Move TRAAuditReadinessPanel, FilingCalendarPanel, PaymentLedgerPanel, ExceptionQueue, FindingsPanel.

### Phase 8 — Monthly Compliance
Build compliance_periods table and UI. Build monthly VAT reconciliation screen with correct VAT return source logic. Separate from annual engagement entirely.

### Phase 9 — Home + My Work
Build role-adaptive Home. Connect to engagement_state_events and alert_events for "next action" guidance.

### Phase 10 — Firm Dashboard + Retirement
Move firm panels to `/firm`. Retire Dashboard.tsx. Redirect `/dashboard` → `/clients`.

## 13.3 Phase 3–4 Sequencing Is Non-Negotiable

Phases 3 and 4 are deliberately split to enforce the lifecycle. Phase 3 delivers tax computation. Phase 4 delivers final sign-off. They cannot be merged because the correct test of Phase 4 is: does it refuse to show the sign-off screen before Phase 3 (tax) is complete?

---

# 14. RISKS AND ROLLBACK BOUNDARIES

## 14.1 Critical Risks

| Risk | Level | Mitigation | Rollback |
|---|---|---|---|
| CPA signs final statements with stale HESABU result | CRITICAL | DB trigger blocks on stale=TRUE for final context | N/A — trigger is the control |
| Tax AJEs applied before sign-off produce a different statement than what HESABU validated | CRITICAL | FS Renderer re-runs after each AJE approval; HESABU must re-run on final statements | Reject final sign-off until HESABU re-run |
| FILED state set without evidence | CRITICAL | filing_submissions INSERT is the trigger; state cannot advance without it | Remove transition without row |
| XBRL generation incorrectly treated as TRA submission | HIGH | Invariant notices in XBRL screen; XBRL_VALIDATED state ≠ FILED state | Documented, non-removable |
| Monthly VAT reconciliation compared to KINGA instead of filed VAT return | HIGH | Separate VAT return evidence table; reconciliation screen requires `vat_return_source` | Remove KINGA comparison code in Phase 8 |
| Phase 4 deployed before Phase 3 — users reach sign-off without completing tax | HIGH | Phase 4 routes gated on engagement state ≥ TAX_ADJUSTMENTS_APPLIED | Gate enforced at route level + DB |
| Engagement state machine diverges from DB reality | MEDIUM | State derived from `engagement_state_events` (append-only canonical) | Re-derive from event log |
| Prior-year engagement state set incorrectly on initial migration | MEDIUM | Migration script sets state from existing data (manual review before deploy) | State reset by admin with audit log |

## 14.2 Iron Dome Invariants That Cannot Change

These constraints are constitutional. No UX design, migration, or user request removes them:

```
1. safisha_transactions is APPEND-ONLY
2. safisha_audit_log is APPEND-ONLY
3. variance_runs is APPEND-ONLY
4. engagement_state_events is APPEND-ONLY
5. filing_submissions is APPEND-ONLY
6. hesabu_validations is APPEND-ONLY
7. reviewer_id always from supabase.auth.getUser() — never from request body
8. hesabu_block_signoff() trigger: gate_satisfied=TRUE AND stale=FALSE AND context='final'
9. statutory_rules: rates require verified_at before KINGA may use them
10. KINGA commit is immutable: no silent re-computation after commit
11. maono-decide outputs never auto-execute
12. budget rows immutable after approved_by is set
13. materiality is configurable per company — no hardcoded thresholds
14. FILED requires filing_submissions record — cannot be set by UI state alone
15. No engine may recompute another engine's canonical outputs
```

## 14.3 What This Architecture Explicitly Rules Out

```
✗ Signing financial statements before tax computation is complete
✗ Treating HESABU gate_satisfied=TRUE as permanent (must be fresh)
✗ Using KINGA revenue as the monthly VAT reconciliation denominator
✗ Treating XBRL_VALIDATED as equivalent to FILED
✗ Treating FILED as equivalent to TRA acceptance
✗ UI role gates substituting for DB authorization
✗ Monthly VAT periods mixed into annual engagement state machine
✗ Frontend computing statutory tax rates
✗ Silent state changes (every state transition = an audit event)
✗ Admin bypassing sign-off chain for speed
✗ Engagement state derived from non-canonical scattered columns in perpetuity
```

---

# APPENDIX A — CORRECTED WORKFLOW: ANNUAL CLOSE (COMPLETE PATH)

```
[Engagement created — state: ONBOARDING]
        │
        ▼
[1A] Upload Trial Balance
      process-trial-balance → account classification
      State → DATA_INTAKE
        │
        ▼
[1B] Reconcile
      safisha-ingest → safisha-match → categorize → score
      CPA resolves exceptions → safisha-resolve
      SAFISHA gate passes → State → RECONCILED
        │
        ▼
[1C] Draft Statements
      FS Renderer generates SFP, P&L, SCF, SOCIE
      AJEs reviewed (non-tax) → approved
      Management inputs entered (dividends, share capital, disposal proceeds)
      State → DRAFT_STATEMENTS_READY
        │
        ▼
[1D] Draft Validation (Advisory)
      hesabu-validate (context=draft) → H-01 to H-12
      All pass → state → DRAFT_HESABU_PASSED
      Fails → back to 1C (fix statements)
        │
        ▼
[2A] Tax Computation  ← FIRST TIME TAX IS RUN
      kinga-tax-engine (unlocked after DRAFT_HESABU_PASSED)
      Statutory rates verified in statutory_rules → GATED if not
      Findings generated
      Workpapers auto-populated (thin cap, add-backs, W&T, loss pool)
      CPA reviews workpapers (2B) — manual inputs applied
      KINGA computation committed → tax_computations row (immutable)
      State → TAX_COMPUTED
        │
        ▼
[2C] Tax AJEs
      KINGA auto-generates: current tax provision AJE, DTA AJE, DTL AJE
      CPA reviews each AJE — approve / reject
      All approved → State → TAX_ADJUSTMENTS_APPLIED
        │
        ▼
[1E-i] Final Statements
      FS Renderer re-runs with all tax AJEs incorporated
      Tax notes auto-populated (deferred tax note, current tax note)
      Statement version incremented
      State → FINAL_STATEMENTS_READY
        │
        ▼
[1E-ii] Final Validation (Gate)
      hesabu-validate (context=final)
      Validates statements that include tax AJEs
      All H-01 to H-12 pass → gate_satisfied=TRUE, stale=FALSE
      State → FINAL_HESABU_PASSED
        │
        ▼
[1E-iii] Sign Off
      Tier 1 (Preparer): DB trigger checks FINAL_HESABU_PASSED and stale=FALSE
      Tier 2 (Reviewer): after Tier 1 signed
      Tier 3 (Approver): after Tier 2 signed → period locked
      State → STATEMENTS_SIGNED
        │
        ▼
[2E] Tax Sign Off
      Tax CPA / Partner signs tax computation
      Separate from statement sign-off
      State → TAX_SIGNED
        │
        ▼
[4A] Disclosure Notes    [4B] Management Letter    [4C] XBRL
     Generated + CPA          Generated + CPA            Generated → validated
     approved                 approved                    (see XBRL state machine)
        │
        ▼
[4D] TRA Checklist
      G1 Final HESABU passed     G4 Findings resolved / documented
      G2 AJEs approved           G5 EFDMS Z-reports present (if VAT-registered)
      G3 Statements signed       G6 Evidence requests closed
      All 6 pass → State → FILING_PACKAGE_READY
        │
        ▼
[4E] Download Package
      CPA downloads ZIP: statements PDF + tax computation + XBRL instance
      State → READY_FOR_MANUAL_SUBMISSION
        │
        ▼
[CPA submits to TRA portal manually]
        │
        ▼
[4F] Record Submission
      CPA enters: return_type, submission_reference, submitted_at,
      acknowledgement file, submission_channel
      filing_submissions row created
      State → FILED
```

---

# APPENDIX B — CORRECTED WORKFLOW: MONTHLY COMPLIANCE

```
[compliance_period created — June 2025, VAT — state: OPEN]
        │
        ▼
[EFDMS Import]
      Upload Z-report CSV or manual entry
      safisha-efdms-ingest → efdms_z_reports
        │
        ▼
[VAT Return Evidence]
      CPA uploads approved VAT return PDF / enters filed return totals
      Source type recorded: TRA_API | VAT_RETURN_UPLOAD | APPROVED_VAT_SCHEDULE | MANUAL_CONFIRMED
      If no VAT return → status = VAT_RETURN_EVIDENCE_REQUIRED → STOP
        │
        ▼
[VAT Reconciliation]
      EFDMS gross_sales, vat_collected
      versus
      Filed VAT return: gross_sales_filed, output_vat_filed
      Gap computed → risk level (CLEAN / GAP / CRITICAL)
      State → EVIDENCE_COLLECTED
        │
        ├── Gap within materiality → State → RECONCILED_CLEAN
        └── Gap exceeds materiality → CPA documents / resolves → State → RECONCILED_GAP
                │
                ▼
[Monthly Filing]
      CPA confirms monthly return submitted
      filing_submissions row (return_type='VAT', compliance_period_id=...)
      State → FILED (monthly)
```

---

*End of document. No code. No file modifications. This is a corrected architecture only.*
*The accounting lifecycle defect in v1.0 has been corrected. Tax computation now precedes final financial-statement validation and sign-off. The eight further corrections (HESABU freshness, period separation, VAT source, persistence model, FILED evidence, XBRL states, authorization matrix, engine boundaries) have been incorporated.*
