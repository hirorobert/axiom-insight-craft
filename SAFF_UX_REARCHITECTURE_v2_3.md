# SAFF ERP — Architecture v2.3
**Status:** APPROVED — Final Implementation Authority  
**Supersedes:** v2.2 (approved), v2.1, v2.0, v1.0  
**Date:** 2026-07-12  
**Rule:** No code. No migrations. No file edits without this document as authority.

---

## ARCHITECTURE LINEAGE

v2.0 — Lifecycle model established. Critical sequencing defect (statements signed before tax computed) identified and rejected.  
v2.1 — Sequencing corrected. Accounting-first lifecycle. Iron Dome nuclear design codified.  
v2.2 — Implementation-safety amendment. HESABU freshness, revision model, typed evidence, 50 constitutional invariants, 56-item checklist.  
v2.3 — Platform elevation. Adds Connector Architecture, Canonical Financial Twin, Professional Workflow model, Performance Architecture. Corrects four v2.2 implementation decisions. 55 constitutional invariants. 64-item checklist.

**What did NOT change from v2.2:**  
Every constitutional invariant from v2.1 and v2.2 is preserved. The 15-state engagement lifecycle is unchanged. The HESABU freshness model is unchanged. The Iron Dome nuclear design is unchanged. The engine sequence (SAFISHA → KINGA → FS Renderer → HESABU → XBRL → Filing) is unchanged. The revision model (ORIGINAL / AMENDMENT / RESTATEMENT / REGULATOR_CORRECTION) is unchanged.

**What changed from v2.2:**  
1. Production readiness statement corrected — current production is operational; v2.3 implementation is NOT READY (not the same thing).  
2. `firm_members.user_id` rename abandoned — column stays as `user_id`; the blast radius exceeds the architectural benefit.  
3. FS Renderer extraction is gradual refactor, not a rewrite-from-scratch.  
4. Four typed compliance evidence tables (compliance_evidence_vat/paye/sdl/wht) collapsed into one `compliance_evidence` table with `obligation_type` discriminator and `evidence_payload JSONB` + typed validator in application layer.  
5. Three new architectural layers added above and below the engine stack.  
6. Performance architecture specified.

---

## SECTION 1 — THE PLATFORM STACK

SAFF ERP is an enterprise financial operating platform. It is not a collection of accounting engines. The platform has five layers. No layer may bypass the layer below it.

```
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 4 — PROFESSIONAL WORKFLOWS                                   │
│  Close Books · Prepare Statements · Compute Tax · Sign Off          │
│  Review Compliance · File Returns · Reporting · Access to Finance   │
│  (Engines are invisible to the CPA. Workflow is the interface.)     │
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 2 — ACCOUNTING ENGINES                                       │
│  SAFISHA · KINGA · FS Renderer · HESABU · MAONO · XBRL             │
│  (Engine sequence is invariant. No engine bypasses another.)        │
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 1 — CANONICAL FINANCIAL TWIN                                 │
│  One source of truth per company. All engines read from the Twin.   │
│  The Twin is written by the Normalization Layer only.               │
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 0A — NORMALIZATION LAYER                                     │
│  Converts every source format to canonical ledger format.           │
│  SAFISHA is the gate. Nothing enters the Twin unless SAFISHA passes.│
├─────────────────────────────────────────────────────────────────────┤
│  LAYER 0 — CONNECTOR ARCHITECTURE                                   │
│  QuickBooks · Xero · Sage · Tally · Banks · TRA API · EFDMS        │
│  PDF · Excel · CSV · Manual Entry                                   │
│  (Every external source enters through a named connector.)          │
└─────────────────────────────────────────────────────────────────────┘
```

A CPA, auditor, accountant, CFO, or finance manager interacts with Layer 4 only. They never decide which engine to open. They close the books. The platform handles the rest.

---

## SECTION 2 — LAYER 0: CONNECTOR ARCHITECTURE

### 2.1 Principle

Every external data source enters the platform through a named, versioned connector. A connector is not a one-time import script. It is a first-class architectural citizen with its own schema, version number, and health status. The Normalization Layer below it converts connector output to canonical ledger format. SAFISHA validates the normalized output before anything enters the Canonical Financial Twin.

### 2.2 Connector Registry

The `connectors` table is the registry of all connectors a firm has activated for a company.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `company_id` | UUID FK companies | |
| `connector_type` | TEXT | See enum below |
| `connector_version` | TEXT | e.g. "quickbooks/v2.1" |
| `status` | TEXT | active / paused / error / deprecated |
| `credentials_ref` | TEXT | pointer to secrets manager; never stored inline |
| `last_sync_at` | TIMESTAMPTZ | |
| `last_sync_status` | TEXT | ok / partial / failed |
| `sync_error_detail` | TEXT | last error message |
| `created_by` | UUID FK firm_members | |
| `created_at` | TIMESTAMPTZ | |

`connector_type` enum: `quickbooks`, `xero`, `sage`, `tally`, `bank_api`, `tra_api`, `efdms_api`, `excel_upload`, `csv_upload`, `pdf_upload`, `manual_entry`, `safisha_bank_statement`, `safisha_subledger`, `safisha_momo`.

### 2.3 Connector Sync Log

Every connector execution is logged. This is append-only. A connector sync that fails still gets a row. Nothing is silent.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `connector_id` | UUID FK connectors | |
| `sync_started_at` | TIMESTAMPTZ | |
| `sync_completed_at` | TIMESTAMPTZ | |
| `records_fetched` | INTEGER | |
| `records_normalized` | INTEGER | |
| `records_rejected` | INTEGER | |
| `safisha_gate_result` | TEXT | clean / needs_review / blocked / not_run |
| `error_detail` | JSONB | |
| `request_id` | UUID | Iron Dome tracing |
| `function_version` | TEXT | connector adapter version |

### 2.4 Currently Implemented Connectors

The following connectors are implemented in the current codebase and satisfy v2.3:

- `csv_upload` — via `safisha-ingest` (CSV/XLSX adapter) ✓
- `pdf_upload` — via `safisha-pdf-extract` + Python worker ✓
- `efdms_api` — via `safisha-efdms-ingest` (Z-Report adapter) ✓ (Tasks #208/#209 must complete)
- `manual_entry` — via `management_inputs` table ✓

The following connectors are **not yet implemented** and represent future phases:
- `quickbooks` — QuickBooks Online API (OAuth 2.0)
- `xero` — Xero API (OAuth 2.0)
- `sage` — Sage 200/300 API
- `tally` — TallyPrime XML export adapter
- `bank_api` — CRDB/NMB/Equity Tanzania open banking (when available)
- `tra_api` — TRA IDRAS API (read-only; filing status and TIN verification)

### 2.5 Connector Architecture Invariants

**CA-1.** Every connector MUST write to `connector_sync_log` before any data enters normalization. A connector that succeeds without logging is a defect.

**CA-2.** Connector credentials are never stored in the database. They reference a secrets manager (Supabase Vault or equivalent). No connector writes a password, API key, or OAuth token to any table.

**CA-3.** Every connector output passes through SAFISHA before entering the Canonical Financial Twin. There is no direct path from a connector to `trial_balance_uploads` that bypasses SAFISHA.

**CA-4.** A connector sync failure does not affect in-progress engagements. Existing validated data in the Twin remains intact.

**CA-5.** MAONO cannot initiate a connector sync. Connectors are write inputs to the Twin. MAONO is a read layer above the Twin.

---

## SECTION 3 — LAYER 1: CANONICAL FINANCIAL TWIN

### 3.1 Principle

Every company has exactly one Canonical Financial Twin. The Twin is the single source of truth for all financial data. It is not a denormalized summary. It is the authoritative ledger from which all engines derive their inputs. The Twin is written by the Normalization Layer (via SAFISHA gate) only. No engine writes to the Twin. No UI writes to the Twin. The Twin is read by all engines.

### 3.2 What the Twin Is

The Twin is the totality of:
- The validated trial balance (`trial_balance_uploads` with `safisha_status='clean'`)
- The canonical account classification (`account_mappings`, `account_pl_mapping`)
- The period registry (`fiscal_periods`, `period_closing_balances`)
- The management inputs (`management_inputs` — dividends, share capital, non-TB adjustments)
- The statutory reference data (`statutory_rules`, `applicability_rules`)
- The asset register (`capital_allowances`)
- The tax loss pool (tax loss carry-forward tracker)

The Twin is NOT:
- Tax computations (those are engine outputs)
- Financial statements (those are engine outputs)
- HESABU validation results (those are engine audit trails)
- MAONO variance analyses (those are engine insights)

### 3.3 Twin Projections

Every engine produces a **projection** of the Twin for a specific purpose. Projections are derived, append-only, versioned outputs. They never mutate the Twin.

| Projection | Engine | Output Table |
|------------|--------|-------------|
| Reconciled ledger | SAFISHA | `safisha_reconciliations` |
| Tax computation | KINGA | `tax_computations` |
| Financial statements | FS Renderer | `statement_snapshots` |
| Validation result | HESABU | `hesabu_validations` |
| Variance analysis | MAONO | `variance_runs`, `variance_analyses` |
| XBRL instance | XBRL | `xbrl_instance_documents` |

### 3.4 Future: Financial Digital Twin

The Canonical Financial Twin is the foundation for a full Financial Digital Twin. In its current form it represents one company's books at a point in time. The Digital Twin vision extends this to a living, continuously updated model of the company's financial state across all dimensions:

- **Books** — validated ledger; period-closing balances; AJE history
- **Tax** — CIT position; tax loss pool; deferred tax; installment schedule
- **Cash** — 13-week rolling forecast; AR aging; AP aging; statutory calendar
- **Risk** — TRA audit signal score; thin-cap exposure; TP risk register; compliance gap
- **Compliance** — monthly obligation states (VAT/PAYE/SDL/WHT); filing calendar
- **Forecast** — variance-to-budget; trend confidence; seasonal adjustments
- **Audit** — HESABU assertion history; sign-off chain; engagement revision log
- **Bankability** — DSCR; current ratio; net working capital; covenant headroom

In the Digital Twin model, every number shown to a user is a projection from the Twin. No number is hardcoded. No number is manually entered into a display. Every projection is traceable to a source row in the Twin with a version timestamp.

**This is the moat.** When the Twin is complete, SAFF becomes an auditable, continuous financial model of every client company. No competitor can replicate audit-grade provenance at this depth without the same underlying architecture.

The Digital Twin is not implemented in the current codebase. It is the architectural north star. Every table, function, and engine designed today must be Twin-compatible — meaning: every output is versioned, every output is traceable to a Twin input, and every output can be invalidated when the Twin changes.

---

## SECTION 4 — LAYER 2: ACCOUNTING ENGINES

The engine sequence is invariant. No engine may call an engine that comes after it in the sequence.

```
SAFISHA → KINGA → FS Renderer → HESABU → MAONO → XBRL
```

SAFISHA is the gate. Nothing downstream runs on dirty data. This is non-negotiable.

### 4.1 SAFISHA — Reconciliation Engine

**Mission:** Accept raw financial data from any connector. Normalize it. Detect exceptions. Require human resolution of every exception. Produce a clean, signed, immutable ledger that KINGA can trust.

**Inputs:** CSV, XLSX, PDF, bank statements, EFDMS Z-reports, QuickBooks export, Xero export, manual entry.  
**Gate output:** `safisha_status = 'clean'` on `trial_balance_uploads`.  
**KINGA contract:** If `safisha_status != 'clean'`, KINGA returns BLOCKED. No exceptions.

**Iron Dome invariants (SAFISHA):**
- `safisha_transactions` is append-only. Evidence cannot be modified or deleted.
- `reviewer_action` is written only by `safisha_resolve_exception()` SECURITY DEFINER.
- `reviewer_id` is derived from `auth.uid()` inside SECURITY DEFINER — never from request body.
- No auto-resolution. A human signs every resolved exception.
- `safisha_status = 'clean'` is the only key that unlocks downstream. Not 'processing'. Not 'needs_review'. Clean only.
- SHA-256 hash on every `safisha_transactions` row for tampering detection.
- DQC polarity validation on ingest — sign anomalies surfaced as exceptions, not silently accepted.

**Currently implemented:** Complete. `safisha-ingest`, `safisha-match`, `safisha-categorize`, `safisha-score`, `safisha-resolve`, `safisha-pdf-extract`, `safisha-efdms-ingest`. Tasks #208 and #209 must complete before EFDMS path is fully clean.

**v2.3 addition:** SAFISHA must advance the engagement state from `DATA_INTAKE` to `RECONCILED` when all exceptions are resolved and `safisha_status` is set to 'clean'. This is the only event that unlocks KINGA. Currently not implemented — requires `advance_engagement_state()` SECURITY DEFINER to exist first.

### 4.2 KINGA — Tax Computation Engine

**Mission:** Compute corporate income tax, wear and tear, deferred tax, thin-cap, management fees, installments, and all statutory obligations from the clean ledger. Produce a versioned, finalization-gated computation that the FS Renderer can incorporate.

**Gate input:** `safisha_status = 'clean'` on the TB upload AND `statutory_rules.verified_at IS NOT NULL` for every rate applied.  
**Gate output:** `tax_computations` row with `finalized_at NOT NULL` and `computation_version_frozen` (TAX_FINALIZED state).

**Iron Dome invariants (KINGA):**
- KINGA never computes tax if `safisha_status != 'clean'`. Hard 403 return.
- KINGA never applies a statutory rate where `verified_at IS NULL`. Rate rows with `verified_at IS NULL` return BLOCKED with the specific rate name.
- The three currently unverified rates (min_tax, thin_cap, mgmt_fee_cap in `statutory_rules`) remain blocked until a human sets `verified_at` against a confirmed primary-source citation. This is not a defect. It is the correct production state.
- Tax finalization is a separate, gated operation from tax computation. Computing tax produces a draft. Finalizing tax is permanent. Only `finalize_tax_computation()` SECURITY DEFINER may set `finalized_at`.
- `finalize_tax_computation()` blocks until: all AJEs for this computation are in terminal state, `tax_aje_reconciliation.gate_passed = TRUE`, and all referenced statutory rates have `verified_at IS NOT NULL`.
- `tax_computation_statutory_refs` captures the exact rate snapshot at finalization time. The computation is reproducible from this snapshot regardless of future rate changes.

**Currently implemented:** v1.3 with Finance Act 2026. Computation is complete. **Finalization boundary is absent** — `finalize_tax_computation()` does not exist, `tax_computation_statutory_refs` does not exist, `tax_aje_reconciliation` does not exist. These are Phase 5 items.

**v2.3 constraint on KINGA computation of three gated items:**  
Until the three statutory_rules rows are verified, KINGA must:
- Skip the relevant calculation entirely (not substitute a hardcoded fallback).
- Include in its response a `blocked_calculations` array with the specific rule name and a note: "Rate unverified. Human must confirm ITA citation before this calculation runs."
- The computation is still written to `tax_computations` but is explicitly marked `incomplete: true` in `computation_detail`.
- Sign-off is blocked on an incomplete computation.

### 4.3 FS Renderer — Financial Statement Generator

**Mission:** Produce financial statements (SFP, IS, SCF, SOCIE, disclosure notes) from the clean ledger, period-closing balances, management inputs, and tax computation. Write each statement version to `statement_snapshots` (append-only) so that HESABU always validates a specific, immutable snapshot — not a live query.

**Gate input:** Engagement state ≥ `TAX_FINALIZED`.  
**Gate output:** `statement_snapshots` row with `snapshot_hash` (SHA-256 of `statements_json`). Engagement state advances to `STATEMENT_SNAPSHOT_CREATED`.

**v2.3 implementation decision — gradual extraction, not rewrite:**  
The current codebase embeds FS Renderer logic inside `kinga-tax-engine`. The output is `computation_detail.income_statement_breakdown`, `computation_detail.scf_engine`, `computation_detail.socie_engine`. This is functional and must not be broken.

The extraction proceeds in three stages, which may span multiple implementation phases:

**Stage 1 (immediate):** Create `statement_snapshots` table. After `kinga-tax-engine` produces its output, a separate `create_statement_snapshot()` call reads from `computation_detail` and writes a new snapshot row. The statement logic does not move yet. The snapshot table exists and holds the JSON. HESABU validates the snapshot, not the live computation_detail. This is the minimum viable separation.

**Stage 2 (medium term):** Extract statement generation into a dedicated `generate-statements` edge function. The function reads `tax_computations.computation_detail` and other sources, produces `statements_json`, writes to `statement_snapshots`. `kinga-tax-engine` no longer carries statement logic. The engines are now separate.

**Stage 3 (long term):** `generate-statements` reads from the Canonical Financial Twin directly (not from `computation_detail`). It becomes the authoritative statement generator that can be called independently of tax computation (e.g., for restated prior-year statements).

**Do not implement Stage 2 or Stage 3 in the same phase as Stage 1.** Stage 1 unblocks HESABU and the snapshot model. Stages 2 and 3 are architectural improvements that can be deferred without blocking other phases.

**Iron Dome invariants (FS Renderer):**
- `statement_snapshots` is append-only. No statement is ever modified. If a statement must change (e.g., due to a corrected AJE), a new snapshot is created and the engagement state machine controls which snapshot is the current one.
- `advance_snapshot_state()` SECURITY DEFINER is the only writer to `statement_snapshot_events`.
- Every snapshot carries: `snapshot_hash` (SHA-256), `source_tb_upload_id`, `source_computation_id`, `source_aje_version`, `source_management_input_hash`. All four source references must be non-null before the snapshot is created.
- IPSAS_ACCRUAL and IPSAS_CASH reporting frameworks return BLOCKED from the FS Renderer. These are not supported.

### 4.4 HESABU — Cross-Statement Validator

**Mission:** Validate the mathematical consistency of financial statements against 12 Hoffman fac-ifrs and DQC assertions. Produce a gated validation result that blocks sign-off until all critical assertions pass, the result is fresh (not stale), and the result was produced in 'final' context.

**Gate input:** A `statement_snapshots` row with `status = 'ready_for_validation'`.  
**Gate output:** `hesabu_validations` row with `gate_satisfied = TRUE` AND `stale = FALSE` AND `validation_context = 'final'`. Engagement state advances to `FINAL_HESABU_PASSED`.

**The 12 assertions (unchanged from v2.2):**
- H-01: SFP Fundamental Equation — CA + NCA = CL + NCL + Equity (critical)
- H-02: Equity Decomposition — Equity = ShareCap + RE + OtherRes (warn)
- H-03: Cash Subset of Assets — Cash ≤ CurrentAssets (warn)
- H-04: Gross Profit Identity — GP = Revenue − COGS (critical)
- H-05: PBT Derivation — PBT ≈ GP + OtherIncome − OpEx − FC (warn)
- H-06: SCF Internal Subtotal — NetChangeCash = Op + Inv + Fin (critical)
- H-07: SCF→SFP Cash Bridge — DerivedClosingCash ≈ SFP Cash (critical)
- H-08: SCF Opening + Change = Close (warn)
- H-09: SOCIE→SFP Equity Bridge — SOCIE ClosingEquity ≈ SFP Equity (critical)
- H-10: SOCIE→SFP Retained Earnings — SOCIE RE Closing ≈ SFP RE (critical)
- H-11: SOCIE Internal RE Chain — Opening + PAT − Div = Closing RE (warn)
- H-12: IS PAT feeds SOCIE — SOCIE PAT ≈ IS PBT − Tax (warn)

**HESABU freshness model (unchanged from v2.2):**  
Every `hesabu_validations` row carries: `validation_context` ('draft'/'final'), `statement_snapshot_id`, `statement_version`, `tax_computation_version`, `aje_version`, `management_input_hash`, `stale` (BOOLEAN), `stale_at` (TIMESTAMPTZ), `stale_reason` (TEXT).

The `hesabu_block_signoff()` trigger checks ALL of:
- `gate_satisfied = TRUE`
- `stale = FALSE`
- `validation_context = 'final'`
- `statement_snapshot_id IS NOT NULL`
- SoD: the actor setting `preparer_signed_at` must not be the same `firm_members.id` as the actor who ran the validation

Staleness invalidation: any change to `trial_balance_uploads`, `tax_computations`, `adjusting_journal_entries`, or `management_inputs` for the same upload triggers `stale = TRUE` on all current, non-stale `hesabu_validations` rows for that upload. This cascade is implemented as triggers on each upstream table.

**Iron Dome invariants (HESABU):**
- HESABU writes only through `hesabu_write_validation()` SECURITY DEFINER.
- `hesabu_write_validation()` MUST have `SET search_path = public, pg_temp`. (Current codebase missing `pg_temp` — must be patched.)
- `hesabu_validations` is append-only. Failed runs are preserved as evidence. No delete.
- Tolerances are loaded from `variance_materiality`. No tolerance is hardcoded.
- First-year SCF/SOCIE assertions skip (not fail) when `scf_engine.is_first_year_draft = true`.
- HESABU never writes to `statement_snapshots`, `tax_computations`, or any KINGA table.

### 4.5 MAONO — CFO Intelligence Engine

**Mission:** Compute variance analyses, cash flow forecasts, AI-powered root-cause, risk signals, and actionable decision paths from the validated ledger. Produce board packs. Alert the CPA to material issues. Never auto-execute any action.

**Gate input:** `safisha_status = 'clean'` for all TB uploads used in the analysis.  
**Gate output:** `variance_analyses`, `cashflow_forecasts`, `maono_insights`, `variance_alerts`.

**Iron Dome invariants (MAONO):**
- MAONO checks `safisha_status = 'clean'` via `maono_check_safisha_gate()` before every analysis run. Dirty data never enters MAONO.
- All materiality thresholds are per-company from `variance_materiality`. No threshold is hardcoded anywhere in MAONO code.
- All AI output is stored with `input_snapshot JSONB` — the exact DB rows passed to the model. Every TZS figure in `ai_output` must appear in `input_snapshot`.
- `numeric_validation_passed = FALSE` marks insights where numbers in `ai_output` could not be traced to `input_snapshot`. These are shown with a validation_failed badge.
- `confidence_level = 'high'` is only permitted when `numeric_validation_passed = TRUE` AND `seasonal_periods_available >= min_periods_high`.
- Actions from `maono-decide` are presented as options. They are never auto-executed.
- MAONO cannot write to `applicability_rules`. A trigger blocks any INSERT from the `authenticated` role.
- `maono_write_alert()` SECURITY DEFINER is the only write path for `variance_alerts` from the scheduled monitor.
- `variance_runs`, `variance_analyses`, `maono_insights`, `board_packs` are append-only.

### 4.6 XBRL — Structured Reporting Engine

**Mission:** Generate XBRL 2.1 or iXBRL 1.1 instance documents from validated financial statements. Validate via Arelle. Store as append-only legal evidence.

**Gate input:** `statement_snapshots` row (Stage 1: `tax_computations.computation_detail`). Engagement state ≥ `STATEMENTS_SIGNED`.  
**Gate output:** `xbrl_instance_documents` row with `validation_passed` and `instance_sha256`.

**Iron Dome invariants (XBRL):**
- `xbrl_write_instance()` SECURITY DEFINER is the only write path.
- IPSAS_ACCRUAL and IPSAS_CASH return BLOCKED — these taxonomies are not implemented.
- Every instance document is SHA-256 hashed. Hash is verified before storage.
- `xbrl_instance_documents` and `xbrl_validation_issues` are append-only. These are legal filing evidence.
- Arelle validation is mandatory. A document that bypasses Arelle never reaches `xbrl_instance_documents`.

---

## SECTION 5 — LAYER 3: PROFESSIONAL WORKFLOWS

### 5.1 The CPA Workflow as the Primary Architecture

The engines in Layer 2 are implementation details. A CPA never decides which engine to open. A CPA never navigates to a "HESABU module" or a "KINGA panel." A CPA closes the books and the platform does the rest.

The primary architecture of the user interface is the professional workflow. The workflow is the interface. The engines are invisible.

**The canonical CPA workflow:**

```
CREATE ENGAGEMENT
       │
       ▼
CONNECT DATA SOURCE
(upload CSV / connect QuickBooks / import PDF)
       │
       ▼
SAFISHA RECONCILES
(exceptions surface for human review)
       │
       ▼
CPA REVIEWS EXCEPTIONS
(approve / reject / escalate each exception)
       │
       ▼
LEDGER CONFIRMED CLEAN
(safisha_status = 'clean')
       │
       ▼
COMPUTE TAX
(KINGA runs automatically on clean ledger)
       │
       ▼
CPA REVIEWS ADJUSTING JOURNAL ENTRIES
(approve / reject each AJE; link to tax computation)
       │
       ▼
FINALIZE TAX
(CPA requests finalization; rate snapshot captured; finalize_tax_computation() runs)
       │
       ▼
STATEMENTS GENERATED
(FS Renderer runs; statement_snapshot created with hash)
       │
       ▼
HESABU VALIDATES
(12 assertions; CPA sees pass/fail per assertion)
       │
       ▼
CPA SIGNS STATEMENTS
(Tier 1: preparer; Tier 2: reviewer; Tier 3: approver; SoD enforced)
       │
       ▼
TAX SIGNED
(separate signature on finalized tax computation)
       │
       ▼
FILING PACKAGE ASSEMBLED
(statements + tax computation + XBRL + supporting schedules)
       │
       ▼
MANUAL SUBMISSION
(CPA submits to TRA / Companies House / regulator)
       │
       ▼
FILED
(submission reference recorded; engagement complete)
```

This workflow is the UI specification. Every panel, button, and step in the UI must map to one step in this workflow. Panels that do not map to a workflow step must be reviewed for necessity.

### 5.2 Engagement Lifecycle (15 States — Unchanged from v2.2)

The engagement lifecycle implements the CPA workflow as a state machine. Each state transition is gated. No state can be skipped. No state can be reversed.

```
ONBOARDING
    │ (company created; engagement initialized)
    ▼
DATA_INTAKE
    │ (TB upload received; connector sync started)
    ▼
RECONCILED
    │ (safisha_status='clean'; all exceptions resolved)
    ▼
DRAFT_STATEMENTS_READY
    │ (KINGA produced draft computation; IS/SFP/SCF/SOCIE available)
    ▼
DRAFT_HESABU_PASSED
    │ (HESABU assertions passed on draft; validation_context='draft')
    ▼
TAX_COMPUTED_DRAFT
    │ (CPA reviewed AJEs; draft tax computation confirmed)
    ▼
TAX_FINALIZED
    │ (finalize_tax_computation() called; rate snapshot captured; gate passed)
    ▼
TAX_ADJUSTMENTS_APPLIED
    │ (approved AJEs reflected; tax_aje_reconciliation.gate_passed=TRUE)
    ▼
STATEMENT_SNAPSHOT_CREATED
    │ (statement_snapshots row written with hash and provenance)
    ▼
FINAL_HESABU_PASSED
    │ (HESABU assertions passed; validation_context='final'; stale=FALSE)
    ▼
STATEMENTS_SIGNED
    │ (3-tier sign-off complete; SoD enforced)
    ▼
TAX_SIGNED
    │ (finalized tax computation signed separately)
    ▼
FILING_PACKAGE_READY
    │ (filing_packages row assembled; XBRL attached)
    ▼
READY_FOR_MANUAL_SUBMISSION
    │ (CPA review of package; acknowledgment of submission instructions)
    ▼
FILED
    (submission reference recorded; engagement archived)
```

**State transition invariants:**
- Every transition is written to `engagement_events` (append-only) by `advance_engagement_state()` SECURITY DEFINER.
- Every `engagement_events` row carries: `actor_firm_member_id` (trusted, derived inside SECURITY DEFINER from `auth.uid()`), `actor_auth_user_id` (trusted), `db_role` (trusted), `db_clock` (trusted), `caller_source_function` (untrusted, from request), `caller_engine_version` (untrusted), `request_id` (Iron Dome tracing), `function_version`.
- No engagement may advance to STATEMENTS_SIGNED before FINAL_HESABU_PASSED.
- No engagement may advance to FINAL_HESABU_PASSED before STATEMENT_SNAPSHOT_CREATED.
- No engagement may advance to STATEMENT_SNAPSHOT_CREATED before TAX_ADJUSTMENTS_APPLIED.
- No engagement may advance to TAX_FINALIZED before all referenced statutory rates have `verified_at IS NOT NULL`.

### 5.3 Engagement Revision Model (Unchanged from v2.2)

Each engagement revision is its own row in `engagements`:

| `revision_type` | When to use |
|-----------------|-------------|
| `ORIGINAL` | First filing for this company-year |
| `AMENDMENT` | CPA-initiated correction after filing |
| `RESTATEMENT` | Material error requiring restated statements |
| `REGULATOR_CORRECTION` | TRA/regulator-directed adjustment |

`UNIQUE(company_id, fiscal_year) WHERE revision_type = 'ORIGINAL'` — one ORIGINAL per company-year. Amendments and restatements create new rows without triggering this constraint.

`supersedes_revision_id` FK points to the prior revision being superseded.

### 5.4 Workflows Beyond the Engagement

Three additional professional workflows exist alongside the core engagement workflow:

**Monthly Compliance Workflow (VAT / PAYE / SDL / WHT):**
```
OPEN → EVIDENCE_GATHERING → EVIDENCE_INCOMPLETE / READY_TO_RECONCILE
→ RECONCILIATION_IN_PROGRESS → RECONCILED_CLEAN / GAP
→ GAP_UNDER_REVIEW → GAP_RESOLVED → READY_TO_FILE
→ FILING_IN_PROGRESS → FILED
```
Missing evidence is communicated via `missing_evidence_codes[]` on `compliance_periods`, not via state names. EFDMS vs VAT return gap is surfaced in `efdms_reconciliation`, not in obligation state names.

**Management Reporting Workflow:**  
CPA triggers MAONO run → variance analysis produced → insights generated → board pack assembled → board pack delivered to client. This workflow does not gate the engagement workflow. It runs independently.

**Access to Finance Workflow (Digital Twin long-term):**  
Bankability projections derived from the Twin → covenant headroom report → lender pack assembled. Not yet implemented. Specified as future roadmap.

---

## SECTION 6 — LAYER 4: PERFORMANCE ARCHITECTURE

### 6.1 Scale Targets

The platform must be designed for:
- 5,000 companies under management per firm
- 50,000,000 ledger lines per company per year
- 100 concurrent SAFISHA reconciliation jobs
- 500 concurrent HESABU validation requests
- MAONO variance analysis completing in < 30 seconds for any company with < 5 years of data
- Filing package assembly completing in < 60 seconds

### 6.2 Partitioning Strategy

The following tables must be partitioned by `company_id` before reaching 10,000 companies or 100,000,000 total rows, whichever comes first:

- `safisha_transactions` — partition by `company_id` hash (16 partitions minimum)
- `variance_analyses` — partition by `company_id` hash
- `engagement_events` — partition by `company_id` range
- `statement_snapshot_events` — partition by `company_id` range
- `compliance_period_events` — partition by `company_id` range

Current table count is well below partition thresholds. Implement partitioning in a dedicated database upgrade phase before reaching 1,000 companies.

### 6.3 Critical Indexes

The following indexes are required for production performance and must exist before any engagement lifecycle feature is enabled:

```
engagements(company_id, fiscal_year, current_state)
engagements(company_id, revision_type) WHERE revision_type = 'ORIGINAL'
engagement_events(engagement_id, created_at DESC)
statement_snapshots(engagement_id, created_at DESC)
statement_snapshots(snapshot_hash) — uniqueness check
hesabu_validations(upload_id, stale, gate_satisfied) WHERE stale = FALSE
hesabu_validations(statement_snapshot_id, validation_context, gate_satisfied)
tax_computations(engagement_id, finalized_at)
compliance_periods(engagement_id, obligation_type, period_year, period_month)
version_allocations(entity_type, entity_id) — already the PK; confirm no table scan paths
```

### 6.4 Worker Queues

Long-running operations must not block HTTP request threads. The following operations must be queued:

| Operation | Queue Mechanism | Max Duration |
|-----------|-----------------|-------------|
| SAFISHA PDF extraction | `safisha-pdf-extract` → Python worker queue | 120 seconds |
| SAFISHA match (large uploads > 10,000 rows) | Background job via Supabase pg_cron or edge function | 300 seconds |
| MAONO full analysis (all periods) | Background job | 60 seconds |
| Board pack PDF generation | Background job | 90 seconds |
| XBRL generation + Arelle validation | `generate-xbrl` → Python worker | 120 seconds |
| Connector sync (QuickBooks, Xero) | Background job; results written to connector_sync_log | Variable |

All queued jobs must write their status to an append-only `background_jobs` table with: `job_id`, `job_type`, `company_id`, `engagement_id`, `status`, `started_at`, `completed_at`, `error_detail`, `request_id`. This table must be created before any background job infrastructure is deployed.

### 6.5 Event Replay

`engagement_events`, `statement_snapshot_events`, and `compliance_period_events` are designed for event replay. The current state of any entity (engagement, snapshot, compliance period) must be computable by replaying all events in order from `created_at ASC`. This enables:

- Audit reconstruction: reproduce the exact state of an engagement at any point in history
- Disaster recovery: if a cached state column (`current_state`) is corrupted, it can be recomputed from events
- Temporal queries: "what was the state of this engagement on date X?"

Each SECURITY DEFINER function that writes an event must preserve idempotency via `idempotency_keys` to ensure event replay does not create duplicate events.

### 6.6 Cold Storage

After an engagement reaches `FILED` status and is more than 2 years old:
- `safisha_transactions` rows for the engagement's upload remain in the primary table but become cold (read-only via trigger; any INSERT to a cold upload is blocked).
- `statement_snapshots` and `xbrl_instance_documents` are immutable by design and do not require additional cold storage treatment.
- `engagement_events` remain queryable; no archiving.
- MAONO analyses for filed engagements can be referenced by subsequent year's runs but not recomputed.

Cold storage policies must be defined per-firm in `firm_cold_storage_policy` (table to be created in performance phase). Default: 2 years before cold.

### 6.7 Concurrency-Safe Versioning

Every version number in the system is allocated by `allocate_version()` SECURITY DEFINER. The function uses `INSERT INTO version_allocations (entity_type, entity_id, current_version) VALUES ($1, $2, 1) ON CONFLICT (entity_type, entity_id) DO UPDATE SET current_version = version_allocations.current_version + 1 RETURNING current_version`. This is an atomic increment under any isolation level. `MAX() + 1` is permanently prohibited — it is a race condition under concurrent writes.

---

## SECTION 7 — SCHEMA MODEL (v2.3)

### 7.1 Identity Convention (v2.3 Correction)

**v2.2 specified:** Rename `firm_members.user_id` to `firm_members.auth_user_id`.  
**v2.3 decision:** Do NOT rename. The column stays as `firm_members.user_id`.

Rationale: The rename touches every SECURITY DEFINER function, every RLS policy, every edge function, and 15–20 UI components simultaneously. The blast radius is not justified by the cosmetic benefit. The column name `user_id` is conventional in Supabase projects and is unambiguous in context.

**The actual identity invariant (unchanged):** All audit-trail foreign keys reference `firm_members.id` (the UUID primary key of the membership record), not `auth.users.id`. The column on `firm_members` that references `auth.users` is called `user_id` (kept as-is). The column on all other tables that references `firm_members` is called `*_member_id` (e.g., `created_by_member_id`, `validated_by_member_id`, `actor_firm_member_id`).

### 7.2 Compliance Evidence Model (v2.3 Correction)

**v2.2 specified:** Four typed extension tables: `compliance_evidence_vat`, `compliance_evidence_paye`, `compliance_evidence_sdl`, `compliance_evidence_wht`.  
**v2.3 decision:** One table with `obligation_type` discriminator and `evidence_payload JSONB`. Typed validation happens in the application layer (edge function), not in the schema.

```
compliance_evidence (
  id                   UUID PK,
  compliance_period_id UUID FK compliance_periods NOT NULL,
  obligation_type      TEXT NOT NULL CHECK (obligation_type IN ('VAT','PAYE','SDL','WHT')),
  source_type          TEXT NOT NULL CHECK (source_type IN ('efdms_z_report','bank_statement','payment_receipt','filed_return','manual')),
  evidence_payload     JSONB NOT NULL,
  -- obligation_type='VAT': payload = {gross_sales, net_sales, output_vat, input_vat, vat_payable, return_ref}
  -- obligation_type='PAYE': payload = {gross_emoluments, paye_withheld, employees_count, payment_ref}
  -- obligation_type='SDL': payload = {gross_emoluments, sdl_rate, sdl_amount, payment_ref}
  -- obligation_type='WHT': payload = {payment_type, gross_payment, wht_rate, wht_amount, recipient_tin, payment_ref}
  payload_schema_version TEXT NOT NULL DEFAULT 'v1',
  uploaded_by_member_id UUID FK firm_members NOT NULL,
  uploaded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_verified           BOOLEAN NOT NULL DEFAULT FALSE,
  verified_by_member_id UUID FK firm_members,
  verified_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

The `evidence_payload` schema per `obligation_type` is documented in `compliance_evidence_schemas` (a lookup table seeded at migration time, not a foreign key). The edge function validates `evidence_payload` against the schema for its `obligation_type` before writing. Invalid payloads return BLOCKED.

Benefit of this approach: one table to query, one table to index, one append-only trigger to maintain. New obligation types (e.g., corporate income tax installments) are added by adding a new `obligation_type` value and documenting the payload schema — without creating a new physical table.

### 7.3 Core New Tables Required (Summary)

These 14 tables must be created in the implementation phases. The schema below is the authoritative specification.

**Foundation tables (Phase 1):**

`version_allocations(entity_type TEXT, entity_id UUID, current_version INTEGER NOT NULL DEFAULT 0)` — PK(entity_type, entity_id). Sole version allocation mechanism.

`idempotency_keys(key TEXT, operation_type TEXT CHECK (operation_type IN ('advance_engagement','advance_snapshot','finalize_tax','approve_aje','record_compliance_period','create_filing_package','record_submission')), result_json JSONB, created_at TIMESTAMPTZ)` — PK(key, operation_type).

`engagements(id UUID PK, company_id UUID FK companies, fiscal_year INTEGER NOT NULL, revision_type TEXT CHECK IN ('ORIGINAL','AMENDMENT','RESTATEMENT','REGULATOR_CORRECTION'), revision_number INTEGER DEFAULT 1, supersedes_revision_id UUID FK engagements, current_state TEXT CHECK IN (15 states), reporting_framework TEXT CHECK IN ('FULL_IFRS','IFRS_FOR_SMES'), engagement_version INTEGER NOT NULL DEFAULT 1, created_by_member_id UUID FK firm_members, created_at TIMESTAMPTZ)` — UNIQUE(company_id, fiscal_year) WHERE revision_type='ORIGINAL'.

`engagement_events(id UUID PK, engagement_id UUID FK engagements, from_state TEXT, to_state TEXT, actor_firm_member_id UUID FK firm_members, actor_auth_user_id UUID, db_role TEXT, db_clock TIMESTAMPTZ, caller_source_function TEXT, caller_engine_version TEXT, event_payload JSONB, request_id UUID, function_version TEXT, created_at TIMESTAMPTZ)` — append-only; `advance_engagement_state()` SECURITY DEFINER is the sole writer.

**Statement snapshot tables (Phase 4):**

`statement_snapshots(id UUID PK, engagement_id UUID FK engagements, statements_json JSONB NOT NULL, snapshot_hash TEXT NOT NULL, snapshot_version INTEGER NOT NULL, source_tb_upload_id UUID FK trial_balance_uploads, source_computation_id UUID FK tax_computations, source_aje_version INTEGER, source_management_input_hash TEXT, status TEXT, created_by_member_id UUID FK firm_members, created_at TIMESTAMPTZ)` — append-only.

`statement_snapshot_events(id UUID PK, snapshot_id UUID FK statement_snapshots, from_status TEXT, to_status TEXT, actor_firm_member_id UUID FK firm_members, actor_auth_user_id UUID, db_role TEXT, db_clock TIMESTAMPTZ, request_id UUID, function_version TEXT, created_at TIMESTAMPTZ)` — append-only.

**Tax finalization tables (Phase 5):**

`tax_computation_statutory_refs(id UUID PK, computation_id UUID FK tax_computations, statutory_rule_id UUID FK statutory_rules, rate_pct NUMERIC, threshold_amount NUMERIC, verified_at TIMESTAMPTZ NOT NULL, captured_at TIMESTAMPTZ NOT NULL, captured_by_member_id UUID FK firm_members)`.

`tax_aje_reconciliation(id UUID PK, computation_id UUID FK tax_computations, total_approved_aje_amount NUMERIC, finalized_computation_amount NUMERIC, tolerance_tzs NUMERIC, gate_passed BOOLEAN GENERATED ALWAYS AS (total_approved_aje_amount IS NOT NULL AND ABS(total_approved_aje_amount - finalized_computation_amount) <= tolerance_tzs) STORED, no_aje_required BOOLEAN NOT NULL DEFAULT FALSE, reconciliation_note TEXT, reconciled_by_member_id UUID FK firm_members, reconciled_at TIMESTAMPTZ)`.

**Compliance period tables (Phase 6):**

`compliance_periods(id UUID PK, engagement_id UUID FK engagements, obligation_type TEXT CHECK IN ('VAT','PAYE','SDL','WHT'), period_year INTEGER, period_month INTEGER, current_state TEXT, missing_evidence_codes TEXT[], created_at TIMESTAMPTZ)` — UNIQUE(engagement_id, obligation_type, period_year, period_month).

`compliance_period_events(id UUID PK, period_id UUID FK compliance_periods, from_state TEXT, to_state TEXT, actor_firm_member_id UUID FK firm_members, actor_auth_user_id UUID, db_role TEXT, db_clock TIMESTAMPTZ, request_id UUID, function_version TEXT, created_at TIMESTAMPTZ)` — append-only.

`compliance_evidence` — see Section 7.2 above.

`applicability_rules(id UUID PK, jurisdiction TEXT, return_type TEXT, taxpayer_category TEXT, reporting_framework TEXT, effective_from DATE, effective_to DATE, rule_payload JSONB, verified_rule_version TEXT, created_by_member_id UUID FK firm_members, created_at TIMESTAMPTZ)` — MAONO INSERT blocked by trigger.

**Filing tables (Phase 7):**

`filing_packages(id UUID PK, engagement_id UUID FK engagements, package_hash TEXT, contents_manifest JSONB, status TEXT, assembled_by_member_id UUID FK firm_members, assembled_at TIMESTAMPTZ)`.

`filing_submissions(id UUID PK, filing_package_id UUID FK filing_packages, submission_channel TEXT, submission_reference TEXT, submitted_at TIMESTAMPTZ, submitted_by_member_id UUID FK firm_members, acknowledgment_json JSONB, created_at TIMESTAMPTZ)`.

**Connector tables (Layer 0):**

`connectors` and `connector_sync_log` — see Section 2.2 above.

`background_jobs(id UUID PK, job_type TEXT, company_id UUID FK companies, engagement_id UUID FK engagements, status TEXT CHECK IN ('queued','running','complete','failed'), started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, error_detail JSONB, request_id UUID, created_at TIMESTAMPTZ)` — append-only.

### 7.4 Tables with Required Alterations

**`hesabu_validations`** — add columns: `validation_context TEXT CHECK IN ('draft','final')`, `statement_snapshot_id UUID FK statement_snapshots`, `statement_version INTEGER`, `tax_computation_version INTEGER`, `aje_version INTEGER`, `management_input_hash TEXT`, `stale BOOLEAN NOT NULL DEFAULT FALSE`, `stale_at TIMESTAMPTZ`, `stale_reason TEXT`. Backfill: `validation_context='draft'`, `stale=FALSE` for all existing rows.

**`statement_sign_offs`** — DROP UNIQUE(company_id, period_year). Add `engagement_id UUID FK engagements`. Add `statement_snapshot_id UUID FK statement_snapshots`. Retain existing preparer_id/reviewer_id/approver_id (auth.users FK) as deprecated. Add `preparer_member_id`, `reviewer_member_id`, `approver_member_id` (firm_members FK). The preparer_firm_member_id, reviewer_firm_member_id, approver_firm_member_id columns from Sprint 2 migration ARE these columns — verify naming alignment.

**`tax_computations`** — add `engagement_id UUID FK engagements`, `finalized_at TIMESTAMPTZ`, `finalized_by_member_id UUID FK firm_members`, `computation_version_frozen INTEGER`. The `result_json` column is vestigial (added by Lovable migration 20260712045023, never written); retain; document as deprecated.

**`adjusting_journal_entries`** — add `source_tax_computation_id UUID FK tax_computations`. Add `created_by_member_id UUID FK firm_members`, `approved_by_member_id UUID FK firm_members`. Status mutation: defer the append-only conversion to Phase 3 after careful audit of all UPDATE paths. Do NOT block status UPDATE in the current production codebase until the event-log replacement is ready.

**`capital_allowances`** — add DELETE-blocking trigger. Add `created_by_member_id UUID FK firm_members`.

**`management_inputs`** — add `created_by_member_id UUID FK firm_members`.

**`hesabu_write_validation()`** — patch `SET search_path = public` to `SET search_path = public, pg_temp`.

### 7.5 Tables to Retire

**`efdms_records`** — pre-redesign table from Kinga Phase 2 (20260625100000). All production writes now route through `efdms_z_reports`. Action: add a trigger blocking INSERT and UPDATE. Preserve all rows. Do NOT drop.

**`filing_obligations`** — created by Lovable migration 20260712045014. Superseded by `compliance_periods`. Action: add a trigger blocking new INSERT once `compliance_periods` is deployed. Existing rows remain readable. Do NOT drop.

---

## SECTION 8 — CONSTITUTIONAL INVARIANTS

v2.3 defines 55 constitutional invariants. Invariants #1–50 from v2.2 are preserved and renumbered where necessary. Invariants #51–55 are new in v2.3.

### Group A — Data Integrity (Invariants #1–12)

**#1.** `safisha_transactions` is append-only. No UPDATE or DELETE ever.  
**#2.** `adjusting_journal_entries` status mutation is gated. UPDATE of `status` is only permitted through the AJE event-log pattern once implemented. Until then, UPDATEs are permitted but must be audited.  
**#3.** `aje_lines` is INSERT-only. No UPDATE or DELETE.  
**#4.** `hesabu_validations` is append-only. No UPDATE or DELETE.  
**#5.** `hesabu_validation_assertions` is append-only.  
**#6.** `statement_snapshots` is append-only. Statements are never edited; new snapshot created.  
**#7.** `statement_snapshot_events` is append-only.  
**#8.** `engagement_events` is append-only.  
**#9.** `compliance_period_events` is append-only.  
**#10.** `xbrl_instance_documents` is append-only. XBRL instances are legal filing evidence.  
**#11.** `xbrl_validation_issues` is append-only.  
**#12.** `variance_analyses`, `maono_insights`, `board_packs` are append-only.  

### Group B — Identity (Invariants #13–17)

**#13.** All audit-trail FKs reference `firm_members.id` (the PK of the membership record). Not `auth.users.id`. Not `firm_members.user_id`.  
**#14.** `firm_members.user_id` is the column referencing `auth.users.id` on the firm_members table. This column name is FIXED and is never renamed.  
**#15.** `actor_firm_member_id` on every event table is derived INSIDE a SECURITY DEFINER function from `auth.uid()` via `resolve_actor_firm_member()`. It is never accepted from the request body.  
**#16.** `reviewer_id` (or `reviewer_member_id`) in SAFISHA is derived from `auth.uid()` inside SECURITY DEFINER. Never from the request body.  
**#17.** No SECURITY DEFINER function may accept a caller-supplied actor identity. Trusted fields (firm_member_id, auth_user_id, db_role, db_clock) are derived internally. Untrusted fields (caller_source_function, caller_engine_version) are stored but not authoritative.  

### Group C — Security (Invariants #18–24)

**#18.** Every SECURITY DEFINER function MUST have `SET search_path = public, pg_temp`. This prevents search-path injection attacks.  
**#19.** Every SECURITY DEFINER function MUST `REVOKE ALL ON FUNCTION FROM PUBLIC` and then `GRANT EXECUTE` only to required roles.  
**#20.** `reviewer_action` on `safisha_exceptions` is written only by `safisha_resolve_exception()` SECURITY DEFINER. Direct UPDATE is blocked by trigger.  
**#21.** No connector stores credentials in the database. Credentials reference a secrets manager.  
**#22.** `applicability_rules` cannot be written by MAONO. A trigger blocks INSERT from MAONO callers.  
**#23.** No engine writes to another engine's primary output table. KINGA does not write to `hesabu_validations`. HESABU does not write to `statement_snapshots`. MAONO does not write to `tax_computations`. These boundaries are enforced by SECURITY DEFINER write gates — each table's write gate checks the caller's engine context.  
**#24.** `safisha_status = 'clean'` is the only value that unlocks KINGA and MAONO. The status 'needs_review', 'blocked', and 'processing' do not unlock downstream engines. There is no override flag.  

### Group D — No Hardcoded Values (Invariants #25–28)

**#25.** No statutory rate is hardcoded in any engine. All rates are read from `statutory_rules`.  
**#26.** No statutory rate is applied where `verified_at IS NULL`. The engine returns BLOCKED.  
**#27.** No materiality threshold is hardcoded in MAONO. All thresholds come from `variance_materiality`.  
**#28.** No reporting framework check is hardcoded in FS Renderer or XBRL. Framework is read from `companies.reporting_framework`. IPSAS_ACCRUAL and IPSAS_CASH always return BLOCKED — this is not a hardcoded rate; it is a feature flag for unsupported frameworks.  

### Group E — Versioning and Idempotency (Invariants #29–33)

**#29.** All version numbers are allocated by `allocate_version()` SECURITY DEFINER using `INSERT...ON CONFLICT...DO UPDATE SET current_version = current_version + 1 RETURNING current_version`. `MAX() + 1` is permanently prohibited.  
**#30.** All 7 operation types check `idempotency_keys` before executing. A duplicate call returns the original result without re-executing.  
**#31.** `idempotency_keys` entries are never deleted. They accumulate permanently as proof that duplicate calls were detected.  
**#32.** `request_id` and `function_version` appear on every API response and every event row. There is no "anonymous" engine call.  
**#33.** No engine call is silent on error. Every error returns a structured response with `error_code`, `error_detail`, `request_id`, `function_version`. The error is always logged to an append-only table.  

### Group F — HESABU Freshness (Invariants #34–40)

**#34.** Every `hesabu_validations` row carries `validation_context` ('draft' or 'final'). A 'draft' result never satisfies the sign-off gate.  
**#35.** Every `hesabu_validations` row carries `statement_snapshot_id`. A validation result not linked to a snapshot never satisfies the sign-off gate.  
**#36.** `stale = TRUE` is set on all current validation rows for an upload whenever upstream data changes (TB re-upload, AJE approval, management input change, tax computation revision).  
**#37.** The sign-off gate checks ALL of: `gate_satisfied = TRUE`, `stale = FALSE`, `validation_context = 'final'`, `statement_snapshot_id IS NOT NULL`.  
**#38.** Separation of duties: the actor who sets `preparer_signed_at` must not be the same `firm_members.id` as the actor who ran the most recent validation. The trigger enforces this.  
**#39.** Tolerances are loaded from `variance_materiality`. No tolerance is hardcoded.  
**#40.** First-year SCF/SOCIE assertions skip (not fail) when `scf_engine.is_first_year_draft = true`.  

### Group G — Engagement Lifecycle (Invariants #41–47)

**#41.** No engagement may advance to `STATEMENTS_SIGNED` before `FINAL_HESABU_PASSED`.  
**#42.** No engagement may advance to `TAX_FINALIZED` before all referenced statutory rates have `verified_at IS NOT NULL`.  
**#43.** No engagement may advance to `STATEMENT_SNAPSHOT_CREATED` before `TAX_ADJUSTMENTS_APPLIED`.  
**#44.** `advance_engagement_state()` SECURITY DEFINER is the only writer to `engagement_events`. Direct INSERT is blocked.  
**#45.** UNIQUE(company_id, fiscal_year) WHERE revision_type='ORIGINAL' — one original engagement per company-year. Amendments and restatements create additional rows.  
**#46.** No engagement state can be decremented. The lifecycle is forward-only. A restatement creates a new RESTATEMENT revision — it does not roll back the ORIGINAL.  
**#47.** `finalize_tax_computation()` SECURITY DEFINER blocks finalization until: (a) all AJEs for this computation are in terminal state, (b) `tax_aje_reconciliation.gate_passed = TRUE`, (c) all referenced statutory rates have `verified_at IS NOT NULL`.  

### Group H — Connector Architecture (Invariants #48–50)

**#48.** Every external data source enters the platform through a named connector registered in `connectors`. Data that enters without a connector record is not permitted.  
**#49.** Every connector sync writes to `connector_sync_log` before any data enters normalization. A sync that succeeds without a log row is a defect.  
**#50.** No connector stores credentials inline. All credentials reference a secrets manager.  

### Group I — Performance and Scalability (Invariants #51–55) — New in v2.3

**#51.** Long-running operations (> 10 seconds) are queued via background jobs. A background job that runs synchronously in an HTTP request is a defect. All background jobs write to `background_jobs` (append-only).  
**#52.** Tables exceeding 10,000,000 rows must be partitioned by `company_id` before the row count is reached. No exception.  
**#53.** The current state of any entity (engagement, snapshot, compliance period) must be computable by replaying its event log. If a cached `current_state` column and the event replay disagree, the event log is authoritative.  
**#54.** Cold storage policy for FILED engagements older than 2 years is defined per-firm in `firm_cold_storage_policy`. The platform enforces the policy via an INSERT-blocking trigger on the engagement's source uploads.  
**#55.** The Financial Digital Twin is the architectural north star. Every table, function, and engine designed from this point forward must be Twin-compatible: versioned output, traceable to Twin inputs, invalidatable when the Twin changes.  

---

## SECTION 9 — IMPLEMENTATION PHASES (v2.3)

All phases maintain production continuity. The current production architecture (SAFISHA, KINGA v1.3, MAONO, HESABU 12-assertion, XBRL) remains fully operational during all phases.

### Phase 0 — No-Op Identity Preparation

**What:** Audit every occurrence of `firm_members.user_id` in all SQL, functions, policies, edge functions, and UI components. Produce a complete inventory. Make no changes.  
**Why:** This prevents the rename mistake. Instead of renaming, we confirm the column stays as `user_id` and catalogue every place it's used so Phase 2 can add `*_member_id` columns safely.  
**Gate:** Inventory complete and reviewed. No production change.

### Phase 1 — Lifecycle Skeleton

**What:**
- Create `version_allocations`, `idempotency_keys`, `connectors`, `connector_sync_log`, `background_jobs`.
- Create `allocate_version()`, `resolve_actor_firm_member()`, `advance_engagement_state()` SECURITY DEFINER functions.
- Create `engagements`, `engagement_events`.
- Backfill `engagements`: one ORIGINAL revision per (company_id, fiscal_year) from `statement_sign_offs`. Count must match exactly. Genesis Protocol.
- DROP UNIQUE(company_id, period_year) from `statement_sign_offs`. Add `engagement_id FK`.

**Gate:** Engagement rows exist; UNIQUE constraint removed; all existing engine flows continue to work; no engine references `engagements` yet.

### Phase 2 — Audit FK Migration

**What:**
- Add `*_member_id` columns to all tables listed in Section 7.4.
- Backfill each column using `UPDATE t SET actor_member_id = fm.id FROM firm_members fm WHERE fm.user_id = t.actor_auth_user_id`.
- Document orphan rows (audit FKs where user no longer has a firm_members row).
- Update edge functions that derive actor identity to also write the `*_member_id` column.
- Patch `hesabu_write_validation()`: `SET search_path = public, pg_temp`.

**Gate:** Zero NULL `*_member_id` values for rows with non-NULL auth.users audit columns (excluding documented orphans). All SECURITY DEFINER functions derive firm_members.id correctly.

### Phase 3 — HESABU Freshness

**What:**
- Add 7 freshness columns to `hesabu_validations`.
- Patch `hesabu-validate` to populate all freshness fields.
- Create staleness invalidation triggers on upstream tables.
- Update `hesabu_block_signoff()` to check all 5 conditions (gate_satisfied, stale, context, snapshot_id, SoD).
- Add `statement_snapshot_id` FK to `hesabu_validations` (will be NULL until Phase 4; trigger updated to allow NULL until Phase 4 completes).

**Gate:** A sign-off attempt on stale data fails. A sign-off attempt with fresh, final-context, snapshot-linked validation passes. A preparer cannot be their own validator.

### Phase 4 — Statement Snapshots and FS Renderer Stage 1

**What:**
- Create `statement_snapshots`, `statement_snapshot_events`.
- Create `advance_snapshot_state()` SECURITY DEFINER.
- After `kinga-tax-engine` produces output, create a `create_statement_snapshot()` call that reads from `computation_detail` and writes a new `statement_snapshots` row. Statement logic does NOT move yet.
- Update `generate-xbrl` to also record `statement_snapshot_id` on `xbrl_instance_documents`.
- Update HESABU to populate `statement_snapshot_id` on validation rows.
- Advance engagement to `STATEMENT_SNAPSHOT_CREATED` when snapshot is created.
- Complete Tasks #208 (B-1) and #209 (B-2).

**Gate:** Every statement used by HESABU and XBRL is linked to a `statement_snapshots` row with a non-NULL `snapshot_hash`.

### Phase 5 — Tax Finalization Boundary

**What:**
- Create `tax_computation_statutory_refs`, `tax_aje_reconciliation`.
- Create `finalize_tax_computation()` SECURITY DEFINER.
- Add `engagement_id`, `finalized_at`, `finalized_by_member_id`, `computation_version_frozen` to `tax_computations`.
- Upgrade `kinga-tax-engine` to call `finalize_tax_computation()` when user requests finalization.
- Wire engagement state advance: TAX_COMPUTED_DRAFT → TAX_FINALIZED.
- Complete Task #210 (C-1).

**Gate:** Cannot finalize a computation with unverified rates. Cannot finalize with unresolved AJEs. Engagement state advances correctly and is immutable once FINALIZED.

### Phase 6 — Monthly Compliance State Machine

**What:**
- Create `compliance_periods`, `compliance_period_events`, `compliance_evidence`, `applicability_rules`.
- Seed `applicability_rules` for TZ jurisdiction: VAT, PAYE, SDL, WHT.
- Add MAONO write-block trigger on `applicability_rules`.
- Wire EFDMSReconciliationPanel to advance VAT compliance period state.
- Retire `efdms_records` (disable writes; preserve rows).
- Retire `filing_obligations` (disable writes once `compliance_periods` is stable).

**Gate:** VAT reconciliation cycle completes end-to-end through compliance period state machine. MAONO write blocked on applicability_rules.

### Phase 7 — Filing and Connectors

**What:**
- Create `filing_packages`, `filing_submissions`.
- Implement FILING_PACKAGE_READY engagement state advance.
- Wire TRAFilingChecklist to filing_packages.
- Implement first QuickBooks or Xero connector (whichever firm is ready to pilot).
- Deploy connector sync log.

**Gate:** Filing package assembled from STATEMENTS_SIGNED engagement. Manual submission reference captured. First external connector pilot completed.

### Phase 8 — Performance and Twin

**What:**
- Implement `background_jobs` queue for long-running operations.
- Add partitioning to safisha_transactions and variance_analyses at 10M row threshold.
- Implement cold storage policy.
- Begin Digital Twin projection model: every engine output is linked to Twin input rows with hash provenance.

**Gate:** No synchronous HTTP request blocks > 10 seconds. All critical indexes in place. Cold storage policy active for filed engagements.

---

## SECTION 10 — GO/NO-GO CHECKLIST (64 Items)

### Section A — Architecture Compliance (8 items)

A-1. Five-layer platform stack documented and approved.  
A-2. Connector architecture registry table exists with all connector types.  
A-3. Canonical Financial Twin boundary documented: what is in the Twin, what is not.  
A-4. Engine sequence invariant enforced: no engine calls a downstream engine.  
A-5. Professional CPA workflow is the primary UI specification.  
A-6. 15-state engagement lifecycle implemented with forward-only transitions.  
A-7. Revision model implemented: ORIGINAL / AMENDMENT / RESTATEMENT / REGULATOR_CORRECTION.  
A-8. UNIQUE(company_id, fiscal_year) WHERE revision_type='ORIGINAL' enforced.  

### Section B — Schema Completeness (20 items)

B-1. `version_allocations` exists; `allocate_version()` is the only version allocation mechanism.  
B-2. `idempotency_keys` exists with all 7 operation types.  
B-3. `engagements` exists with all 15 states in the CHECK constraint.  
B-4. `engagement_events` exists and is append-only.  
B-5. `statement_snapshots` exists with `snapshot_hash` and all 4 source provenance columns.  
B-6. `statement_snapshot_events` exists and is append-only.  
B-7. `tax_computation_statutory_refs` exists with `verified_at NOT NULL` constraint.  
B-8. `tax_aje_reconciliation` exists with `gate_passed` GENERATED ALWAYS AS column.  
B-9. `compliance_periods` exists with 11-state machine and `missing_evidence_codes[]`.  
B-10. `compliance_period_events` exists and is append-only.  
B-11. `compliance_evidence` exists with `obligation_type` discriminator and `evidence_payload JSONB`.  
B-12. `applicability_rules` exists with MAONO write-block trigger.  
B-13. `filing_packages` and `filing_submissions` exist.  
B-14. `connectors` and `connector_sync_log` exist.  
B-15. `background_jobs` exists and is append-only.  
B-16. `hesabu_validations` has all 7 freshness columns.  
B-17. UNIQUE(company_id, period_year) removed from `statement_sign_offs`.  
B-18. `engagement_id` FK exists on `statement_sign_offs` and `tax_computations`.  
B-19. All 14+ `*_member_id` audit FK columns point to `firm_members.id`.  
B-20. `hesabu_write_validation()` has `SET search_path = public, pg_temp`.  

### Section C — Backfill and Data Integrity (6 items)

C-1. Genesis Protocol executed for `engagements`: count matches source, hash reconciles.  
C-2. All `*_member_id` backfills executed; orphan rows documented.  
C-3. `hesabu_validations` existing rows backfilled: `validation_context='draft'`, `stale=FALSE`.  
C-4. `efdms_records` INSERT/UPDATE blocked; reads redirected to `efdms_z_reports`.  
C-5. `filing_obligations` INSERT blocked; `compliance_periods` is the active model.  
C-6. Duplicate XBRL table definitions (20260711500000 vs 20260712044423) verified for schema parity.  

### Section D — Implementation Phases (6 items)

D-1. Phase 0 inventory complete and reviewed.  
D-2. Phase 1 (lifecycle skeleton) complete and gated.  
D-3. Phase 2 (FK migration) complete; zero orphan member IDs without documentation.  
D-4. Phase 3 (HESABU freshness) complete; staleness cascade tested.  
D-5. Phase 4 (statement snapshots) complete; every HESABU result linked to a snapshot.  
D-6. Phase 5 (tax finalization) complete; finalization blocked on unverified rates.  

### Section E — Rollback and Forward-Only Policy (4 items)

E-1. No audit table column dropped for rollback. Forward correction only.  
E-2. Failed migrations deploy a forward correction, not a rollback migration.  
E-3. Cold engagement data disabled by trigger; source rows never dropped.  
E-4. `efdms_records` and `filing_obligations` preserved (not dropped) after retirement.  

### Section F — Identity and Actor Provenance (6 items)

F-1. `resolve_actor_firm_member()` SECURITY DEFINER exists and derives `firm_members.id` from `auth.uid()`.  
F-2. `advance_engagement_state()` derives `actor_firm_member_id` from `resolve_actor_firm_member()`.  
F-3. No SECURITY DEFINER function accepts a caller-supplied actor identity.  
F-4. `firm_members.user_id` column name is UNCHANGED (no rename).  
F-5. All new `*_member_id` audit columns reference `firm_members.id` (the PK, not user_id).  
F-6. Separation of duties enforced in HESABU gate: preparer ≠ validator.  

### Section G — Idempotency and Versioning (4 items)

G-1. `idempotency_keys` checked before all 7 operation types.  
G-2. `allocate_version()` is the only version allocation path; `MAX()+1` is absent from all code.  
G-3. `request_id` and `function_version` present on every API response and event row.  
G-4. Every engine error returns structured response with `error_code`, `request_id`, `function_version`.  

### Section H — Applicability and Compliance (4 items)

H-1. `applicability_rules` seeded for TZ jurisdiction: VAT, PAYE, SDL, WHT.  
H-2. MAONO INSERT block trigger on `applicability_rules` active and tested.  
H-3. Three unverified `statutory_rules` rows (min_tax, thin_cap, mgmt_fee_cap) remain with `verified_at=NULL` until human confirms primary-source citations.  
H-4. `compliance_evidence` payload schema documented for each `obligation_type` in `compliance_evidence_schemas` seed table.  

### Section I — Performance (6 items)

I-1. All critical indexes from Section 6.3 exist.  
I-2. Long-running operations (> 10 seconds) queued via `background_jobs`.  
I-3. Partitioning plan documented for tables approaching 10M rows.  
I-4. Cold storage policy active for FILED engagements > 2 years.  
I-5. Event replay verified for engagements, snapshots, and compliance periods.  
I-6. MAONO analysis for < 5 years of data completes in < 30 seconds under load test.  

---

## SECTION 11 — PRODUCTION READINESS STATEMENT

**Two separate production readiness questions exist. They must not be conflated.**

### Question 1: Is the current production architecture operational?

**YES.**

The current production system includes fully operational:
- SAFISHA reconciliation pipeline (ingest → match → categorize → score → resolve → gate)
- KINGA tax computation engine v1.3 with Finance Act 2026
- KINGA findings engine (Module B/C)
- KINGA comparative engine
- MAONO variance analysis, cashflow, root-cause, risk, decide, monitor
- HESABU validation (12 assertions; gate functional post-trigger fix 20260713000000)
- XBRL generation with Arelle validation
- Firm management (invite, role enforcement)
- Statement sign-off with HESABU gate
- Statutory rate enforcement with verified_at gate
- Three unverified rate rows correctly blocked

These capabilities are in production. They serve real engagements. They must not be broken during any v2.3 implementation phase.

### Question 2: Is the codebase ready to implement Architecture v2.3?

**NOT READY. Implementation is blocked until Sections A–I of the Go/No-Go Checklist are CONFIRMED.**

The six items that individually block all phases from starting:

1. **`engagements` table does not exist.** The 15-state lifecycle has no anchor. Phase 1 must create it before any lifecycle feature is built.

2. **`UNIQUE(company_id, period_year)` on `statement_sign_offs` is active.** Every AMENDMENT and RESTATEMENT record will be rejected by this constraint. It must be dropped in Phase 1.

3. **`hesabu_block_signoff()` does not check `stale=FALSE`.** The HESABU gate can pass on data that was valid when it was produced but has since been superseded. Phase 3 must close this gap.

4. **`version_allocations` does not exist.** Any concurrent write to versioned entities risks a race condition under `MAX()+1`. Phase 1 must create this table and the `allocate_version()` function before any versioned entity is created.

5. **`idempotency_keys` does not exist.** Duplicate API calls can create duplicate audit records. Phase 1 must create this table.

6. **20+ audit FK columns reference `auth.users.id`.** v2.3 requires `firm_members.id`. Phase 2 migrates these columns. Phase 1 creates the foundational functions that Phase 2 depends on.

---

*This document is the final implementation authority for all SAFF ERP development. v2.2 is superseded in its entirety. No migration, edge function, UI change, or connector may be implemented without this document as the governing specification. Any deviation requires a formal amendment to this document before implementation proceeds. The Financial Digital Twin is the north star. Every decision made under this architecture must be Twin-compatible.*
