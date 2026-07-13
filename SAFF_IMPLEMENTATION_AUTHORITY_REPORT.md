# SAFF ERP — Implementation Authority Report
**Architecture Authority:** SAFF_UX_REARCHITECTURE_v2_2.md (APPROVED)  
**Report Date:** 2026-07-12  
**Repository State:** Production (commit 72b3ea1 + uncommitted Sprint 2 changes)  
**Status of This Document:** IMPLEMENTATION AUTHORITY — All development teams must treat findings herein as binding requirements before any implementation begins.

---

## EXECUTIVE SUMMARY

Architecture v2.2 defines a lifecycle-driven engagement model centred on fifteen states from ONBOARDING through FILED. The current codebase has no `engagements` table, no `statement_snapshots`, no `compliance_periods`, no `version_allocations`, and no `idempotency_keys`. Eighteen tables required by v2.2 do not exist. Twenty-three tables that do exist carry auth.users FKs where v2.2 requires firm_members.id. The HESABU gate is missing all seven freshness fields v2.2 mandates. The statement_sign_offs UNIQUE constraint directly conflicts with the revision model. The tax finalization boundary (TAX_COMPUTED_DRAFT → TAX_FINALIZED) has no database representation.

**PRODUCTION READINESS: NOT READY**

Implementation is blocked. See Section 8 for the complete go/no-go checklist status.

---

## SECTION 1 — IMPLEMENTATION IMPACT MAP

### 1.1 Database Layer — Tables

| Table | Current Status | v2.2 Action |
|-------|----------------|-------------|
| `engagements` | DOES NOT EXIST | CREATE — master lifecycle record, all 15 states, revision model |
| `engagement_events` | DOES NOT EXIST | CREATE — append-only lifecycle event log |
| `statement_snapshots` | DOES NOT EXIST | CREATE — append-only statement versions with hash |
| `statement_snapshot_events` | DOES NOT EXIST | CREATE — snapshot state machine transitions |
| `compliance_periods` | DOES NOT EXIST | CREATE — monthly obligation state machine |
| `compliance_period_events` | DOES NOT EXIST | CREATE — obligation state transitions |
| `filing_packages` | DOES NOT EXIST | CREATE — assembled filing packages |
| `filing_submissions` | DOES NOT EXIST | CREATE — external submission records |
| `version_allocations` | DOES NOT EXIST | CREATE — concurrency-safe version counter |
| `idempotency_keys` | DOES NOT EXIST | CREATE — all 7 operation types |
| `applicability_rules` | DOES NOT EXIST | CREATE — jurisdiction × framework × taxpayer_category rules |
| `compliance_evidence_sources` | DOES NOT EXIST | CREATE — generic evidence metadata |
| `compliance_evidence_vat` | DOES NOT EXIST | CREATE — typed VAT evidence extension |
| `compliance_evidence_paye` | DOES NOT EXIST | CREATE — typed PAYE evidence extension |
| `compliance_evidence_sdl` | DOES NOT EXIST | CREATE — typed SDL evidence extension |
| `compliance_evidence_wht` | DOES NOT EXIST | CREATE — typed WHT evidence extension |
| `tax_computation_statutory_refs` | DOES NOT EXIST | CREATE — finalization boundary; rate snapshot at TAX_FINALIZED |
| `tax_aje_reconciliation` | DOES NOT EXIST | CREATE — AJE gate with generated gate_passed column |
| `statement_sign_offs` | EXISTS — DEFECTIVE | ALTER: remove UNIQUE(company_id, period_year); add engagement_id FK; add statement_snapshot_id FK; migrate preparer_id/reviewer_id/approver_id from auth.users to firm_members.id |
| `adjusting_journal_entries` | EXISTS — DEFECTIVE | ALTER: convert status to append-only event log pattern; migrate created_by/approved_by to firm_members.id; add source_tax_computation_id |
| `tax_computations` | EXISTS — INCOMPLETE | ALTER: add finalized_at, finalized_by (firm_members.id FK), computation_version_frozen, engagement_id; review UNIQUE(company_id, upload_id) against revision model |
| `capital_allowances` | EXISTS — DEFECTIVE | ALTER: block DELETE via trigger; migrate created_by to firm_members.id |
| `hesabu_validations` | EXISTS — INCOMPLETE | ALTER: add validation_context, statement_snapshot_id, statement_version, tax_computation_version, aje_version, management_input_hash, stale, stale_at, stale_reason; migrate validated_by to firm_members.id |
| `management_inputs` | EXISTS — DEFECTIVE | ALTER: migrate created_by from auth.users to firm_members.id |
| `safisha_reconciliations` | EXISTS — DEFECTIVE | ALTER: rename client_id → firm_member_id; change FK from auth.users to firm_members.id |
| `safisha_exceptions` | EXISTS — DEFECTIVE | ALTER: migrate reviewer_id from auth.users to firm_members.id |
| `account_pl_mapping` | EXISTS — DEFECTIVE | ALTER: migrate created_by from auth.users to firm_members.id |
| `variance_materiality` | EXISTS — DEFECTIVE | ALTER: migrate updated_by from auth.users to firm_members.id |
| `variance_budgets` | EXISTS — DEFECTIVE | ALTER: migrate submitted_by, approved_by from auth.users to firm_members.id |
| `variance_runs` | EXISTS — DEFECTIVE | ALTER: migrate triggered_by from auth.users to firm_members.id |
| `board_packs` | EXISTS — DEFECTIVE | ALTER: migrate generated_by from auth.users to firm_members.id |
| `efdms_z_reports` | EXISTS — DEFECTIVE | ALTER: migrate imported_by from auth.users to firm_members.id |
| `efdms_reconciliation` | EXISTS — DEFECTIVE | ALTER: migrate reconciled_by from auth.users to firm_members.id |
| `xbrl_instance_documents` | EXISTS — DEFECTIVE | ALTER: migrate generated_by from auth.users to firm_members.id |
| `companies` | EXISTS — INTACT | No structural change required; user_id is owner reference (non-audit FK) |
| `firm_members` | EXISTS — INTACT | No change; `id` is the correct target for all v2.2 audit FKs |
| `fiscal_periods` | EXISTS — MINOR | accounting_basis enum values differ from v2.2 reporting_framework enum; resolve alignment |
| `safisha_transactions` | EXISTS — INTACT | Append-only enforced; no change required |
| `aje_lines` | EXISTS — INTACT | INSERT-only enforced; no change required |
| `variance_analyses` | EXISTS — INTACT | Append-only enforced; no change required |
| `maono_insights` | EXISTS — INTACT | Append-only enforced; no change required |
| `xbrl_validation_issues` | EXISTS — INTACT | Append-only enforced; no change required |
| `efdms_records` | EXISTS — RETIRED | Pre-redesign table; must be retired (disable writes, preserve rows); all reads/writes route through efdms_z_reports |
| `filing_obligations` | EXISTS — SUPERSEDED | Created by Lovable migration 20260712045014; superseded by v2.2 compliance_periods model; evaluate whether to retire or fold |
| `statutory_rules` | EXISTS — INTACT | Verified-rate gate in place; three rows with verified_at=NULL are correctly gated |
| `period_closing_balances` | EXISTS — PARTIAL | Allows UPDATE via RLS; v2.2 requires append-only — review whether this conflicts with current engine writes |
| `maono_context` | EXISTS — INTACT | No change required |
| `variance_alerts` | EXISTS — INTACT | Append-only for core fields; acknowledgment UPDATE permitted — compliant with v2.2 |
| `maono_monitor_runs` | EXISTS — INTACT | No change required |
| `board_packs` | EXISTS — DEFECTIVE | See above (generated_by FK) |
| `hesabu_validation_assertions` | EXISTS — INTACT | No change required |
| `xbrl_concept_map` | EXISTS — INTACT | Seeded; read-only at runtime |
| `cashflow_forecasts` | EXISTS — INTACT | No change required |
| `maono_context` | EXISTS — INTACT | No change required |

### 1.2 Database Layer — Functions

| Function | Current Status | v2.2 Action |
|----------|----------------|-------------|
| `hesabu_write_validation()` | EXISTS — DEFECTIVE | search_path = public, pg_temp (currently missing pg_temp); must be patched |
| `hesabu_block_signoff()` | EXISTS — INCOMPLETE | Checks gate_satisfied=TRUE only; must also check stale=FALSE, context='final', statement_snapshot_id IS NOT NULL, SoD (preparer ≠ reviewer) |
| `xbrl_write_instance()` | EXISTS — INTACT | SECURITY DEFINER, SET search_path = public; compliant |
| `maono_write_alert()` | EXISTS — INTACT | SECURITY DEFINER, SET search_path = public; compliant |
| `maono_write_board_pack()` | EXISTS — INTACT | SECURITY DEFINER, SET search_path = public; compliant |
| `maono_check_safisha_gate()` | EXISTS — INTACT | SECURITY DEFINER, SET search_path = public; compliant |
| `maono_compute_confidence()` | EXISTS — INTACT | SECURITY DEFINER, SET search_path = public; compliant |
| `safisha_resolve_exception()` | EXISTS — INTACT | SECURITY DEFINER; SET search_path = public; sentinel pattern correct |
| `safisha_enforce_resolve_gate()` | EXISTS — INTACT | SECURITY DEFINER; prevents unauthorized reviewer_action writes |
| `get_member_company_ids()` | EXISTS — INTACT | SECURITY DEFINER, SET search_path = public, STABLE; compliant |
| `allocate_version()` | DOES NOT EXIST | CREATE — must use INSERT...ON CONFLICT...DO UPDATE for concurrency-safe versioning; MAX()+1 is prohibited by v2.2 invariant |
| `finalize_tax_computation()` | DOES NOT EXIST | CREATE — SECURITY DEFINER; moves engagement from TAX_COMPUTED_DRAFT → TAX_FINALIZED; blocks until all statutory refs captured and AJE gate passed |
| `advance_snapshot_state()` | DOES NOT EXIST | CREATE — SECURITY DEFINER; sole writer to statement_snapshot_events |
| `advance_engagement_state()` | DOES NOT EXIST | CREATE — SECURITY DEFINER; sole writer to engagement_events |
| `resolve_actor_firm_member()` | DOES NOT EXIST | CREATE — SECURITY DEFINER; derives firm_members.id from auth.uid() + firm context |
| `create_owner_firm_member()` | EXISTS — INTACT | SECURITY DEFINER; sentinel pattern correct |
| `close_prior_statutory_rule()` | EXISTS — INTACT | Effective-dating trigger; compliant |
| `enforce_verified_statutory_rule()` | EXISTS (via trigger) | Blocks unverified rates; compliant |
| `cascade_period_lock()` | EXISTS — INTACT | Cascades to fiscal_periods |
| `guard_upload_on_locked_period()` | EXISTS — INTACT | Blocks uploads on locked periods |
| `maono_block_run_mutation()` | EXISTS — INTACT | Append-only enforcement for variance_runs |
| `maono_block_analysis_mutation()` | EXISTS — INTACT | Append-only enforcement for variance_analyses |
| `safisha_block_transaction_mutation()` | EXISTS — INTACT | Append-only enforcement for safisha_transactions |
| `enforce_budget_immutability()` | EXISTS — INTACT | Immutability after approval |
| `xbrl_block_document_mutation()` | EXISTS — INTACT | Append-only for xbrl_instance_documents |
| `maono_block_insight_mutation()` | EXISTS — INTACT | Append-only for maono_insights |

### 1.3 Edge Function Layer

| Function | Current Status | v2.2 Action |
|----------|----------------|-------------|
| `kinga-tax-engine` | EXISTS — PARTIAL | Does not write through finalize_tax_computation(); no engagement_id awareness; no TAX_FINALIZED state; no tax_computation_statutory_refs capture. Must be upgraded to support finalization boundary |
| `hesabu-validate` | EXISTS — PARTIAL | Writes through hesabu_write_validation() ✓. Does not populate validation_context, statement_snapshot_id, or stale fields. Must be upgraded when HESABU freshness schema is in place |
| `generate-xbrl` | EXISTS — INTACT | Writes through xbrl_write_instance() ✓; IPSAS blocked ✓; auth required ✓ |
| `safisha-resolve` | EXISTS — PARTIAL | reviewer_id derived from auth.uid() ✓; does not derive firm_members.id (will need upgrade after firm_members.id migration) |
| `safisha-ingest` | EXISTS — INTACT | DQC polarity validation ✓; SHA-256 hash ✓ |
| `safisha-match` | EXISTS — INTACT | RapidFuzz 6-tier matching ✓ |
| `safisha-categorize` | EXISTS — INTACT | No schema changes required |
| `safisha-score` | EXISTS — INTACT | No schema changes required |
| `safisha-pdf-extract` | EXISTS — INTACT | Proxy to Python worker; no schema changes |
| `safisha-efdms-ingest` | EXISTS — DEFECTIVE | Reads computation_detail (fixed in 72b3ea1) ✓; still has open items from B-1 (Task #208) |
| `maono-compute` | EXISTS — INTACT | Safisha-gated ✓; deterministic ✓ |
| `maono-cashflow` | EXISTS — INTACT | No schema changes required |
| `maono-root-cause` | EXISTS — INTACT | Full input_snapshot ✓; numeric validation ✓ |
| `maono-risk` | EXISTS — INTACT | Z-score + TRA signals ✓ |
| `maono-decide` | EXISTS — INTACT | No auto-execute ✓ |
| `maono-monitor` | EXISTS — INTACT | Writes through maono_write_alert() ✓ |
| `generate-disclosure-notes` | EXISTS — INTACT | No v2.2 schema changes required |
| `generate-management-letter` | EXISTS — INTACT | No v2.2 schema changes required |
| `invite-firm-member` | EXISTS — INTACT | No v2.2 schema changes required |
| `kinga-findings-engine` | EXISTS — INTACT | No v2.2 schema changes required |
| `kinga-comparative-engine` | EXISTS — INTACT | No v2.2 schema changes required |
| `policy-compass` | EXISTS — INTACT | No v2.2 schema changes required |

### 1.4 UI Component Layer

| Component | Current Status | v2.2 Impact |
|-----------|----------------|-------------|
| `KingaTaxPanel.tsx` | EXISTS — PARTIAL | Task #206 (A-2) in_progress: auto-run HESABU after commit. Must also: disable sign-off until engagement state = STATEMENTS_SIGNED; surface engagement lifecycle state |
| `HesabuAssurancePanel.tsx` | EXISTS — INTACT | Shows H-01 to H-12. Will need staleness indicator once HESABU freshness fields are added |
| `EFDMSReconciliationPanel.tsx` | EXISTS — DEFECTIVE | Task #209 (B-2) pending: route all writes through safisha-efdms-ingest |
| `ThinCapWorkpaper.tsx` | EXISTS — DEFECTIVE | Task #210 (C-1) pending: gated state display, remove s.24A, no frontend compute |
| `AdjustingJournalPanel.tsx` | EXISTS — PARTIAL | Shows AJEs; does not surface source_tax_computation_id linkage; will need AJE gate reconciliation display |
| `ExportStatements.tsx` | EXISTS — INTACT | No v2.2 schema changes block current function |
| `ComplianceScorecard.tsx` | EXISTS — INTACT | No immediate v2.2 changes required |
| `FirmDashboardPanel.tsx` | EXISTS — INTACT | No immediate v2.2 changes required |
| `PeriodCloseManager.tsx` | EXISTS — PARTIAL | Currently signs off by period; v2.2 sign-off is per engagement revision |
| `TRAAuditReadinessPanel.tsx` | EXISTS — DEFECTIVE | G5 gate reads efdms_z_reports (fixed in 72b3ea1) ✓ |
| All others | EXISTS | No v2.2 schema changes block current function |

---

## SECTION 2 — DATABASE IMPACT

### 2.1 Tables: NO CHANGE REQUIRED

The following tables require no structural changes to comply with v2.2. They must not be touched during implementation phases unless explicitly noted.

- `safisha_transactions` — append-only enforced; SHA-256 hash present
- `aje_lines` — INSERT-only enforced
- `variance_analyses` — append-only enforced
- `maono_insights` — append-only enforced
- `variance_runs` — append-only enforced (core field mutation blocked)
- `variance_alerts` — append-only for core fields; acknowledgment UPDATE permitted per v2.2
- `variance_budgets` — immutable after approval; version-controlled
- `cashflow_forecasts` — no change required
- `xbrl_validation_issues` — append-only enforced
- `xbrl_concept_map` — seed data; read-only at runtime
- `maono_context` — no change required
- `maono_monitor_runs` — no change required
- `hesabu_validation_assertions` — no change required
- `statutory_rules` — rate gate working; three unverified rows correctly GATED
- `account_pl_mapping` (structural) — mapping logic intact; only the created_by FK needs migration
- `variance_materiality` — threshold logic intact; only the updated_by FK needs migration
- `safisha_reconciliations` (structural) — reconciliation logic intact; client_id rename and FK migration only
- `maono_check_safisha_gate()` — no change required
- `efdms_z_reports` — no structural change; only imported_by FK migration
- `efdms_reconciliation` — no structural change; only reconciled_by FK migration
- All seed tables (`tax_losses`, `payment_ledger`, `tax_payments`, etc.) — no change required

### 2.2 Tables: ALTER REQUIRED (Non-Breaking Additions)

These tables can receive the required changes via additive ALTER TABLE migrations. Existing data is not destroyed.

**`hesabu_validations`**  
Add columns: `validation_context TEXT CHECK (validation_context IN ('draft','final'))`, `statement_snapshot_id UUID`, `statement_version INTEGER`, `tax_computation_version INTEGER`, `aje_version INTEGER`, `management_input_hash TEXT`, `stale BOOLEAN NOT NULL DEFAULT FALSE`, `stale_at TIMESTAMPTZ`, `stale_reason TEXT`.  
Existing rows are backfilled with: validation_context = 'draft' (they were produced before the final context concept existed), stale = FALSE.

**`tax_computations`**  
Add columns: `engagement_id UUID`, `finalized_at TIMESTAMPTZ`, `finalized_by UUID REFERENCES firm_members(id)`, `computation_version_frozen INTEGER`.  
The existing `result_json` column (added by Lovable migration 20260712045023) is the column that all five frontend files previously misread as `computation_json`. It was corrected to `computation_detail` in remediation S-1. The `result_json` column is now vestigial — it remains NOT NULL DEFAULT '{}' and is never written. It should be retained for now (dropping a column is risky) and documented as deprecated.

**`statement_sign_offs`**  
Add columns: `engagement_id UUID REFERENCES engagements(id)`, `statement_snapshot_id UUID REFERENCES statement_snapshots(id)`.  
Migrate FKs: `preparer_id`, `reviewer_id`, `approver_id` currently reference `auth.users(id)`. Per v2.2, audit FKs must reference `firm_members.id`. Columns `preparer_firm_member_id`, `reviewer_firm_member_id`, `approver_firm_member_id` were added in Sprint 2 migration (20260708100000) as the correct replacement columns. Existing auth.users-based columns can be deprecated in place; do not drop until backfill is confirmed.  
**CRITICAL:** The `UNIQUE(company_id, period_year)` constraint must be DROPPED. v2.2 allows multiple engagement revisions per (company, fiscal_year). Each revision has its own sign-off row. The constraint makes this impossible. This is a schema mutation that requires care — all existing rows satisfy the new model (each is still an ORIGINAL revision), but the constraint removal must be scripted and verified.

**`adjusting_journal_entries`**  
Add column: `source_tax_computation_id UUID REFERENCES tax_computations(id)`.  
Migrate FKs: `created_by`, `approved_by` currently reference `auth.users(id)`. Add `created_by_member_id UUID REFERENCES firm_members(id)`, `approved_by_member_id UUID REFERENCES firm_members(id)`.  
The `status` column allows UPDATE via RLS, which violates v2.2's append-only requirement. v2.2 requires an event log (each status change is a new row, not an UPDATE). Options: (a) add an `aje_events` append-only table for new status transitions while freezing direct status UPDATEs, or (b) add a trigger blocking UPDATE on `status` once the event log is in place. Do not make this change until the AJE gate reconciliation model is fully designed.

**`capital_allowances`**  
Add trigger blocking DELETE. Existing rows remain. The `created_by` column references `auth.users(id)` — add `created_by_member_id UUID REFERENCES firm_members(id)`.

**`management_inputs`**  
Add `created_by_member_id UUID REFERENCES firm_members(id)`.

### 2.3 Tables: CREATE REQUIRED (Foundational New Tables)

These tables must be created before any v2.2 lifecycle implementation can proceed. They are the skeleton of the architecture.

**Priority 1 — Lifecycle Foundation (create first; everything depends on these)**
1. `version_allocations` — `(entity_type TEXT, entity_id UUID)` PK; `current_version INTEGER NOT NULL DEFAULT 0`; `INSERT...ON CONFLICT...DO UPDATE SET current_version = current_version + 1 RETURNING current_version` is the only safe version allocation pattern.
2. `idempotency_keys` — `(key TEXT, operation_type TEXT)` PK; `result_json JSONB`; `created_at TIMESTAMPTZ`. Seven operation_types: `advance_engagement`, `advance_snapshot`, `finalize_tax`, `approve_aje`, `record_compliance_period`, `create_filing_package`, `record_submission`.
3. `engagements` — master record; `company_id`, `fiscal_year INTEGER`, `revision_type TEXT CHECK (revision_type IN ('ORIGINAL','AMENDMENT','RESTATEMENT','REGULATOR_CORRECTION'))`, `revision_number INTEGER NOT NULL DEFAULT 1`, `supersedes_revision_id UUID`, `current_state TEXT CHECK (current_state IN ('ONBOARDING','DATA_INTAKE','RECONCILED','DRAFT_STATEMENTS_READY','DRAFT_HESABU_PASSED','TAX_COMPUTED_DRAFT','TAX_FINALIZED','TAX_ADJUSTMENTS_APPLIED','STATEMENT_SNAPSHOT_CREATED','FINAL_HESABU_PASSED','STATEMENTS_SIGNED','TAX_SIGNED','FILING_PACKAGE_READY','READY_FOR_MANUAL_SUBMISSION','FILED'))`, `reporting_framework TEXT`, `engagement_version INTEGER NOT NULL DEFAULT 1`; UNIQUE(company_id, fiscal_year) WHERE revision_type='ORIGINAL'.
4. `engagement_events` — append-only; `engagement_id FK`, `from_state TEXT`, `to_state TEXT`, `actor_firm_member_id UUID REFERENCES firm_members(id)`, `actor_auth_user_id UUID`, `db_role TEXT`, `db_clock TIMESTAMPTZ`, `caller_source_function TEXT`, `caller_engine_version TEXT`, `event_payload JSONB`, `request_id UUID`, `function_version TEXT`.

**Priority 2 — Statement Snapshot Model**
5. `statement_snapshots` — append-only; `engagement_id FK`, `statements_json JSONB NOT NULL`, `snapshot_hash TEXT NOT NULL` (SHA-256 of statements_json), `snapshot_version INTEGER`, `source_tb_upload_id UUID`, `source_computation_id UUID`, `source_aje_version INTEGER`, `source_management_input_hash TEXT`, `status TEXT` (cached projection of events), `created_by_member_id UUID REFERENCES firm_members(id)`.
6. `statement_snapshot_events` — append-only; all trusted actor provenance fields; `advance_snapshot_state()` is the sole writer.

**Priority 3 — Tax Finalization Boundary**
7. `tax_computation_statutory_refs` — captures rate snapshot at TAX_FINALIZED; `computation_id FK`, `statutory_rule_id FK`, `rate_pct NUMERIC`, `threshold_amount NUMERIC`, `verified_at TIMESTAMPTZ NOT NULL` (must be non-null — cannot finalize against unverified rate), `captured_at TIMESTAMPTZ`, `captured_by_member_id UUID REFERENCES firm_members(id)`.
8. `tax_aje_reconciliation` — `computation_id FK`, `total_approved_aje_amount NUMERIC`, `finalized_computation_amount NUMERIC`, `gate_passed BOOLEAN GENERATED ALWAYS AS (ABS(total_approved_aje_amount - finalized_computation_amount) < tolerance) STORED`, `no_aje_required BOOLEAN NOT NULL DEFAULT FALSE`, `reconciliation_note TEXT`.

**Priority 4 — Monthly Compliance State Machine**
9. `compliance_periods` — `engagement_id FK`, `obligation_type TEXT CHECK (obligation_type IN ('VAT','PAYE','SDL','WHT'))`, `period_year INTEGER`, `period_month INTEGER`, `current_state TEXT` (generic 11-state machine), `missing_evidence_codes TEXT[]`; UNIQUE(engagement_id, obligation_type, period_year, period_month).
10. `compliance_period_events` — append-only; all trusted actor provenance.
11. `compliance_evidence_sources` — generic; `compliance_period_id FK`, `source_type TEXT`, `file_path TEXT`, `uploaded_by_member_id UUID REFERENCES firm_members(id)`, `uploaded_at TIMESTAMPTZ`.
12. `compliance_evidence_vat` — typed extension of compliance_evidence_sources; `evidence_source_id FK`, `return_output_vat NUMERIC`, `efdms_vat NUMERIC`, `gap_tzs NUMERIC GENERATED ALWAYS AS (efdms_vat - return_output_vat) STORED`.
13. `compliance_evidence_paye`, `compliance_evidence_sdl`, `compliance_evidence_wht` — analogous typed extension tables.

**Priority 5 — Filing**
14. `applicability_rules` — `jurisdiction TEXT`, `return_type TEXT`, `taxpayer_category TEXT`, `reporting_framework TEXT`, `effective_from DATE`, `effective_to DATE`, `verified_rule_version TEXT`; MAONO cannot write to this table (enforced by trigger — no direct INSERT from unauthenticated paths).
15. `filing_packages` — `engagement_id FK`, `package_hash TEXT`, `contents_manifest JSONB`, `assembled_at TIMESTAMPTZ`, `assembled_by_member_id UUID REFERENCES firm_members(id)`, `status TEXT`.
16. `filing_submissions` — `filing_package_id FK`, `submission_channel TEXT`, `submission_reference TEXT`, `submitted_at TIMESTAMPTZ`, `submitted_by_member_id UUID REFERENCES firm_members(id)`, `acknowledgment_json JSONB`.

### 2.4 Tables: RETIRE

- `efdms_records` — pre-redesign table; created in Kinga Phase 2 migration (20260625100000); superseded by `efdms_z_reports`. Disable all INSERT/UPDATE via trigger. Reads must be redirected to `efdms_z_reports`. Do NOT drop — preserve historical rows.

### 2.5 FK Identity Migration (Cross-Cutting Concern)

v2.2 invariant: **All audit FKs reference firm_members.id, never auth.users.id.**

The current schema uses `auth.users(id)` FKs in the following columns across the following tables:

- `capital_allowances.created_by`
- `adjusting_journal_entries.created_by`, `.approved_by`
- `statement_sign_offs.preparer_id`, `.reviewer_id`, `.approver_id`
- `management_inputs.created_by`
- `safisha_reconciliations.client_id`
- `safisha_exceptions.reviewer_id`
- `account_pl_mapping.created_by`
- `variance_materiality.updated_by`
- `variance_budgets.submitted_by`, `.approved_by`
- `variance_runs.triggered_by`
- `board_packs.generated_by`
- `efdms_z_reports.imported_by`
- `efdms_reconciliation.reconciled_by`
- `xbrl_instance_documents.generated_by`
- `hesabu_validations.validated_by`
- `maono_insights.input_snapshot` (actor context within JSONB)
- `fiscal_periods.created_by`
- `tax_computations.cpa_modified_by`

**Migration pattern:** For each table, add a new `*_member_id` column referencing `firm_members.id`. Backfill using `UPDATE t SET actor_member_id = fm.id FROM firm_members fm WHERE fm.user_id = t.actor_auth_user_id`. Verify backfill count. Deprecate (but do not drop) original auth.users FK columns until all edge functions and UI components have been updated to use the new column.

**Note on `firm_members.user_id` vs `firm_members.auth_user_id`:** The current schema uses `user_id` as the column name for the auth.users FK on firm_members. v2.2 specifies this field should be called `auth_user_id`. This is a cosmetic rename that requires `ALTER TABLE firm_members RENAME COLUMN user_id TO auth_user_id` plus updates to every query, function, and RLS policy that references `firm_members.user_id`. This is a high-blast-radius change that must be treated as its own migration phase (Phase 0). All current SECURITY DEFINER functions, RLS policies, and edge functions use `firm_members.user_id`. The rename must not happen until all downstream references are catalogued and ready to update atomically.

---

## SECTION 3 — EDGE FUNCTION IMPACT

### 3.1 Functions Requiring No Changes

These functions comply with v2.2 as-is:
- `safisha-ingest` — DQC polarity, SHA-256, SECURITY DEFINER write path
- `safisha-match` — no schema changes required
- `safisha-categorize` — no schema changes required
- `safisha-score` — no schema changes required
- `safisha-pdf-extract` — proxy only
- `maono-compute` — Safisha-gated; deterministic; no engagement awareness required
- `maono-cashflow` — no schema changes required
- `maono-root-cause` — full input_snapshot; numeric validation
- `maono-risk` — Z-score; TRA signals
- `maono-decide` — no auto-execute; compliant
- `maono-monitor` — writes through maono_write_alert()
- `generate-disclosure-notes` — no schema changes required
- `generate-management-letter` — no schema changes required
- `invite-firm-member` — no schema changes required
- `kinga-findings-engine` — no schema changes required
- `kinga-comparative-engine` — no schema changes required
- `policy-compass` — no schema changes required
- `generate-xbrl` — writes through xbrl_write_instance(); IPSAS blocked; auth required

### 3.2 Functions Requiring Targeted Patches

**`hesabu-validate`**  
Current: Writes 12 assertion rows through `hesabu_write_validation()` SECURITY DEFINER. Gate checked by trigger.  
Required: Once HESABU freshness schema is added, the function must populate `validation_context` ('draft' or 'final'), `statement_snapshot_id`, `statement_version`, `tax_computation_version`, `aje_version`, `management_input_hash`. The function must also compute and write `stale=FALSE` at write time. A staleness invalidation path must be created (when upstream data changes, set stale=TRUE on all prior validation rows for that upload).  
Blocking: Cannot be patched until `hesabu_validations` schema additions (Section 2.2) are deployed.

**`safisha-resolve`**  
Current: Derives reviewer_id from `auth.uid()` (correct per Iron Dome invariant). Does not derive firm_members.id.  
Required: After the firm_members.id FK migration, `safisha-resolve` must resolve `auth.uid()` to `firm_members.id` using `resolve_actor_firm_member()` and write that to `reviewer_member_id`.  
Blocking: Cannot be patched until `resolve_actor_firm_member()` function exists and firm_members FK migration is complete.

**`safisha-efdms-ingest`**  
Current: Task #208 (B-1) is pending — computation_detail fix confirmed in 72b3ea1; source_type and JSON manual path items remain open.  
Required: Complete Task #208 before this function can be considered compliant.

**`kinga-tax-engine`**  
Current: v1.3; Finance Act 2026; gated on statutory_rules.verified_at; reads computation_detail; writes to tax_computations.  
Required for v2.2: The engine must be extended to support the TAX_FINALIZED boundary. Specifically: (a) call `finalize_tax_computation()` SECURITY DEFINER when user requests finalization; (b) capture the rate snapshot into `tax_computation_statutory_refs` at finalization time; (c) set `computation_version_frozen`; (d) advance engagement state from TAX_COMPUTED_DRAFT to TAX_FINALIZED.  
Blocking: Cannot proceed until engagements, tax_computation_statutory_refs, and finalize_tax_computation() exist.  
**The three gated statutory_rules rows (min_tax, thin_cap, mgmt_fee_cap with verified_at=NULL) will continue to block engine finalization for those computations until a human sets verified_at against confirmed primary-source citations. This is correct behaviour.**

---

## SECTION 4 — ENGINE CONTRACT AUDIT

### 4.1 SAFISHA

**v2.2 Contract:** Reconciliation engine. Ingests TB, bank, sub-ledger, MoMo. Outputs safisha_status='clean' on upload before any downstream engine can run. Reviewer is a human firm member; reviewer_id derived inside SECURITY DEFINER from auth.uid(); no auto-resolution.

**Current Implementation:**
- Ingest: `safisha-ingest` — compliant; DQC polarity; SHA-256 ✓
- Match: `safisha-match` — compliant; 6-tier RapidFuzz ✓
- Categorize/Score: compliant ✓
- Resolve: `safisha-resolve` — reviewer_id from auth.uid() ✓; firm_members.id linkage missing (pending FK migration)
- Gate: `safisha_status='clean'` on trial_balance_uploads; enforced in kinga-tax-engine and maono-compute ✓
- EFDMS: Task #208 pending; currently partially defective (B-1)

**Gap:** SAFISHA has no engagement awareness. v2.2 requires that a reconciliation advance the engagement state from DATA_INTAKE to RECONCILED when complete. No `advance_engagement_state()` call exists in any SAFISHA function.

**Contract status: PARTIAL — compliant for current production use; not yet wired to engagement lifecycle.**

### 4.2 KINGA (Tax Engine)

**v2.2 Contract:** Tax computation engine. Reads from trial_balance_uploads, tax_computations, capital_allowances, management_inputs, statutory_rules. Output advances engagement to TAX_COMPUTED_DRAFT. Finalization (TAX_FINALIZED) is a separate gated operation via finalize_tax_computation() SECURITY DEFINER.

**Current Implementation:**
- Finance Act 2026 constants: current ✓
- statutory_rules enforcement: verified_at gate in place ✓
- Three statutory_rules rows gated (min_tax, thin_cap, mgmt_fee_cap): verified_at=NULL ✓ (correctly blocked)
- Reads computation_detail (not result_json): fixed in 72b3ea1 ✓
- Writes to tax_computations.computation_detail ✓
- HESABU auto-run after commit: Task #206 in_progress

**Gap 1:** No engagement_id awareness. Engine does not advance engagement state.  
**Gap 2:** No finalization boundary. `finalize_tax_computation()` does not exist. TAX_COMPUTED_DRAFT → TAX_FINALIZED transition is not implemented.  
**Gap 3:** No `tax_computation_statutory_refs` capture at finalization.  
**Gap 4:** No AJE gate (`tax_aje_reconciliation`) check before finalization.

**Contract status: PARTIAL — core computation compliant; finalization boundary absent.**

### 4.3 FS Renderer

**v2.2 Contract:** Financial Statement generator. Reads from trial_balance_uploads, period_closing_balances, management_inputs. Produces IFRS/IFRS for SMEs statements. Writes to statement_snapshots (append-only) via advance_snapshot_state() SECURITY DEFINER. Does NOT write to hesabu_validations.

**Current Implementation:** FS rendering is done within `kinga-tax-engine` as part of the computation output (computation_detail.income_statement_breakdown, computation_detail.scf_engine, computation_detail.socie_engine). Statements are not stored in a separate table — they live inside `tax_computations.computation_detail` JSONB.

**Gap:** `statement_snapshots` does not exist. There is no separate FS Renderer function. Statements are embedded in the tax engine output — v2.2 requires FS Renderer to be a distinct engine that writes to statement_snapshots independently of KINGA. This is the largest architectural gap requiring the most new code.

**Contract status: ABSENT — no separate FS Renderer exists; statements embedded in KINGA output; statement_snapshots table not created.**

### 4.4 HESABU (Validation Engine)

**v2.2 Contract:** Post-generation, pre-sign-off cross-statement validator. Writes through hesabu_write_validation() SECURITY DEFINER. Every validation row carries: validation_context ('draft'/'final'), statement_snapshot_id, statement_version, tax_computation_version, aje_version, management_input_hash, stale, stale_at, stale_reason. Gate checks gate_satisfied=TRUE AND stale=FALSE AND validation_context='final'. Separation of duties enforced (preparer ≠ validator).

**Current Implementation:**
- 12 assertions (H-01 to H-12) implemented ✓
- Writes through hesabu_write_validation() SECURITY DEFINER ✓
- gate_satisfied GENERATED ALWAYS AS (status='all_pass') ✓
- hesabu_write_validation(): SET search_path = public — **missing pg_temp** (low severity but must be fixed)
- hesabu_block_signoff() trigger: checks gate_satisfied=TRUE ✓ but does NOT check stale=FALSE, context='final', snapshot_id, or SoD
- First-year SCF/SOCIE skip logic: implemented ✓
- Tolerances from variance_materiality: implemented ✓

**Gap 1:** The seven freshness fields (validation_context, statement_snapshot_id, statement_version, tax_computation_version, aje_version, management_input_hash, stale, stale_at, stale_reason) do not exist in hesabu_validations. All 12 assertions currently run without knowing whether the data they validated is still current.  
**Gap 2:** hesabu_block_signoff() gate is insufficient — it will pass on a stale validation row or a draft-context row.  
**Gap 3:** Separation of duties (preparer ≠ validator) is not enforced anywhere in the current trigger or function.  
**Gap 4:** hesabu_write_validation() missing pg_temp in SET search_path.

**Contract status: PARTIAL — assertion logic complete; freshness model absent; gate incomplete.**

### 4.5 MAONO (CFO Intelligence Engine)

**v2.2 Contract:** CFO intelligence layer. Reads from variance_analyses, maono_insights, cashflow_forecasts, maono_context. Cannot write to applicability_rules. All AI output goes through tool-use citation enforcement. Numeric validation required before storage. Actions from maono-decide never auto-execute. Scheduled monitor writes via maono_write_alert() SECURITY DEFINER only.

**Current Implementation:**
- Safisha gate enforced ✓
- All materiality thresholds configurable per company (variance_materiality) ✓
- maono_write_alert() SECURITY DEFINER ✓
- maono_write_board_pack() SECURITY DEFINER ✓
- AI numeric validation (numeric_validation_passed field) ✓
- No auto-execute from maono-decide ✓
- applicability_rules table does not yet exist — MAONO cannot violate a rule it cannot write to; this gap is in the schema, not the engine

**Gap:** No engagement_id awareness. Variance analyses are keyed by company_id and period dates, not by engagement. Under the v2.2 revision model, two engagement revisions for the same company and fiscal year might produce different variance analyses — MAONO would not know which revision's data to display.

**Contract status: SUBSTANTIALLY COMPLIANT — core invariants respected; engagement context missing.**

### 4.6 XBRL

**v2.2 Contract:** XBRL/iXBRL instance document generator. Reads from statement_snapshots (v2.2) or tax_computations (current). Writes through xbrl_write_instance() SECURITY DEFINER. IPSAS frameworks return BLOCKED. Every document SHA-256 hashed. Arelle validation mandatory.

**Current Implementation:**
- xbrl_write_instance() SECURITY DEFINER ✓
- IPSAS blocked ✓
- SHA-256 hash of instance_xml ✓
- Arelle validation summary inline ✓
- xbrl_instance_documents append-only ✓
- xbrl_validation_issues append-only ✓
- safisha-pdf-worker/xbrl_engine.py with Arelle integration ✓

**Gap:** Currently reads from tax_computations.computation_detail. v2.2 requires XBRL to read from statement_snapshots (which do not yet exist). Once FS Renderer and statement_snapshots are implemented, generate-xbrl must be updated to read from statement_snapshots and record the statement_snapshot_id on each xbrl_instance_documents row.

**Contract status: COMPLIANT for current architecture; requires update when statement_snapshots exist.**

---

## SECTION 5 — MIGRATION RISK

### 5.1 High Risk

**Risk H-1: statement_sign_offs UNIQUE constraint removal**  
`UNIQUE(company_id, period_year)` on statement_sign_offs will cause every attempt to create a revision (AMENDMENT, RESTATEMENT) for any company in any fiscal year to fail with a unique violation. This constraint must be dropped before any revision model feature can be enabled. Risk: if any application code depends on this constraint for deduplication logic, removing it creates a potential for duplicate sign-offs. Mitigation: verify all application paths that write to statement_sign_offs; confirm none rely on the UNIQUE constraint for correctness; then drop with `DROP INDEX` + explicit documentation.

**Risk H-2: firm_members.user_id → auth_user_id rename**  
This column is referenced in: `get_member_company_ids()` SECURITY DEFINER, `create_owner_firm_member()` trigger, every RLS policy on every table that uses `get_member_company_ids()`, the `firm_management` edge function, the `invite-firm-member` edge function, and likely 15–20 UI components that directly query firm_members. A rename without atomic rollout will break all of these. Mitigation: stage as Phase 0 — rename the column but simultaneously update all functions, policies, and edge functions in a single migration transaction; then deploy all edge functions in a single `supabase functions deploy` pass. Do not defer edge function deployment after the migration.

**Risk H-3: adjusting_journal_entries status → append-only conversion**  
The `status` column currently allows UPDATE (via the aje_update RLS policy added in 20260712050748). AdjustingJournalPanel.tsx and the kinga-tax-engine both may issue status UPDATEs. Converting to an event-log model requires: (a) creating an `aje_events` table; (b) updating every UPDATE query to instead INSERT into aje_events; (c) adding a trigger on adjusting_journal_entries that blocks status UPDATE; (d) potentially creating a view that projects current status from the event log. This is a multi-step coordinated change across schema, edge functions, and UI.

**Risk H-4: No rollback of audit tables**  
Per v2.2 forward-only migration invariant: if any migration adds a column to an audit table and that migration has a defect, the correct response is to deploy a forward correction. No audit table column is ever dropped for rollback. All teams must understand this before Phase 1 begins.

### 5.2 Medium Risk

**Risk M-1: Duplicate XBRL table creation**  
Lovable migration 20260712044423 re-creates xbrl_concept_map and xbrl_instance_documents using IF NOT EXISTS guards. These tables were originally created in 20260711500000. The IF NOT EXISTS guard makes this idempotent in isolation, but any column definition differences between the two migrations would silently succeed with the second migration doing nothing (leaving the v1.0 schema in place). Before deploying, verify that both migrations define identical schemas for both tables.

**Risk M-2: filing_obligations vs compliance_periods**  
Lovable migration 20260712045014 created a `filing_obligations` table with a simple status CHECK (pending/filed/overdue/waived). v2.2 defines a 11-state compliance_periods model. These are different models for the same concept. Both tables may exist simultaneously after implementation. The filing_obligations table must either be retired (disable writes, preserve rows) or explicitly documented as a UI-facing simplification layer that does not replace compliance_periods.

**Risk M-3: HESABU freshness invalidation cascade**  
Once hesabu_validations has the stale field, any change to upstream data (TB re-upload, AJE approval, management input change, tax computation revision) must set stale=TRUE on all current validation rows for that upload/snapshot. This invalidation cascade must be implemented as triggers on the upstream tables. If any trigger is missing, the HESABU gate can pass on stale data — which is the exact failure mode v2.2 was designed to prevent. Every upstream table must be catalogued and every trigger written before HESABU freshness is considered complete.

### 5.3 Low Risk

**Risk L-1: result_json column on tax_computations**  
Added by Lovable (20260712045023) as NOT NULL DEFAULT '{}'. Was never written to. Frontend S-1 fixes (72b3ea1) correctly route to computation_detail. The column is vestigial but harmless. Retain; document as deprecated; do not populate.

**Risk L-2: Three unverified statutory_rules rows**  
min_tax, thin_cap, mgmt_fee_cap rows have verified_at=NULL. The enforce_verified_statutory_rule trigger correctly blocks engines from using them. These rows will block kinga-tax-engine finalization for those computations until verified. This is not a migration risk — it is a deliberate gate. A human must verify each ITA citation against primary source text before setting verified_at.

---

## SECTION 6 — BACKFILL READINESS

### 6.1 Genesis Protocol Assessment

v2.2 specifies a 6-stage Genesis Protocol for all new foundational tables: dry-run → ambiguity resolution → write freeze → genesis writes → count/hash reconciliation → authorized sign-off.

**Tables requiring Genesis Protocol execution:**

| New Table | Backfill Source | Genesis Complexity | Ambiguity Risk |
|-----------|-----------------|-------------------|----------------|
| `engagements` | One row per unique (company_id, fiscal_year) from statement_sign_offs and tax_computations | Medium | Low: existing data has one revision per company-year |
| `statement_snapshots` | Cannot backfill — no historical statement JSON was stored separately; computation_detail JSONB in tax_computations contains engine output but is not a statement snapshot per v2.2 definition | N/A — cannot backfill | HIGH: existing users have no snapshot_hash or provenance |
| `compliance_periods` | Cannot backfill from current schema — compliance state history was not recorded | N/A — cannot backfill | HIGH |
| `filing_packages` | Cannot backfill — no historical filing package data exists | N/A | N/A |
| `version_allocations` | Seed from current maximum versions in tax_computations, etc. | Low | Low |
| `idempotency_keys` | Start empty — idempotency is forward-only | None | None |
| `applicability_rules` | Seed from existing statutory_rules patterns | Medium | Medium: obligation types and taxpayer categories require definition |

### 6.2 FK Backfill Assessment

**firm_members.id backfill for all auth.users audit columns:**  
This backfill is resolvable for all tables where `user_id` in the audit column matches a `user_id` in `firm_members`. Risk: if any audit row references a `auth.users.id` that is NOT in firm_members (e.g., a user who was later removed from the firm), the backfill will leave that row with a NULL firm_member_id. These orphaned rows must be catalogued before migration; a decision must be made on whether to delete, preserve with NULL, or create a sentinel firm_member row for them.

**safisha_reconciliations.client_id:**  
This column references `auth.users.id` directly. Backfill using `SELECT fm.id FROM firm_members fm WHERE fm.user_id = safisha_reconciliations.client_id`. Same orphan risk as above.

### 6.3 What Cannot Be Backfilled

The following data gaps cannot be resolved by any backfill and represent permanent forward-only boundaries:

1. **statement_snapshots for historical engagements** — No versioned statement JSON was stored independently of tax_computations. Existing users' historical statements are not available as discrete snapshots with hash provenance. These users start the new model from their next engagement.
2. **hesabu freshness fields for historical validations** — All existing hesabu_validations rows will be backfilled with stale=FALSE and validation_context='draft'. They cannot be retroactively assigned a statement_snapshot_id because no snapshots exist for historical engagements.
3. **compliance period history** — The monthly obligation state machine is a new model. Historical filing records exist in filing_obligations (Lovable migration) and tax_payments, but the state machine history (who moved from OPEN to EVIDENCE_GATHERING to RECONCILED_CLEAN, etc.) was never recorded.

---

## SECTION 7 — IMPLEMENTATION PHASES

All phases are sequenced to maintain production continuity. No existing engine is broken during any phase. Each phase is a distinct migration window.

### Phase 0 — Identity Foundation (PREREQUISITE FOR ALL PHASES)

**Scope:** Rename firm_members.user_id → auth_user_id. Update all SECURITY DEFINER functions, RLS policies, and edge functions atomically.  
**Risk:** HIGH. Touch point: every function and policy that references firm_members.  
**Gate to proceed:** All edge function tests pass post-rename; login, firm creation, and invitation flows verified end-to-end.  
**Note:** This phase must be executed and verified BEFORE any phase that adds firm_members.id audit FKs. If firm_members.user_id still exists when new FK columns are created, the backfill queries will use the old column name successfully — but the risk of asymmetry between phases is severe. Execute Phase 0 atomically.

### Phase 1 — Schema Foundations (No business logic change)

**Scope:**
- Create version_allocations and idempotency_keys tables.
- Create allocate_version() and resolve_actor_firm_member() SECURITY DEFINER functions.
- Create engagements and engagement_events tables (no data yet).
- Backfill engagements: one ORIGINAL revision per existing (company_id, fiscal_year) from statement_sign_offs.
- Drop UNIQUE(company_id, period_year) from statement_sign_offs.
- Add engagement_id FK to statement_sign_offs.

**Gate to proceed:** All existing engine flows continue to work; no engine references the new tables yet; engagement rows match statement_sign_offs count exactly.

### Phase 2 — Audit FK Migration

**Scope:**
- Add *_member_id columns to all 20+ tables listed in Section 2.5.
- Execute backfill for each column.
- Verify backfill: count non-NULL rows vs expected; document orphan rows.
- Update edge functions: safisha-resolve, hesabu-validate, generate-xbrl, kinga-tax-engine, invite-firm-member to use new member_id columns.
- Deprecate (but do not drop) original auth.users audit columns.

**Gate to proceed:** All SECURITY DEFINER functions correctly derive and write firm_members.id; no function writes a NULL member_id for an authenticated user with a valid firm membership.

### Phase 3 — HESABU Freshness

**Scope:**
- Add seven freshness columns to hesabu_validations.
- Patch hesabu_write_validation() to include pg_temp in SET search_path.
- Patch hesabu-validate edge function to populate all freshness fields.
- Create staleness invalidation triggers on: trial_balance_uploads, tax_computations, adjusting_journal_entries, management_inputs.
- Update hesabu_block_signoff() to check stale=FALSE, context='final', statement_snapshot_id IS NOT NULL, SoD.

**Gate to proceed:** A sign-off attempt on stale validation data fails with the correct IRON DOME error; a sign-off attempt with fresh, final-context validation passes; a preparer cannot be their own validator.

### Phase 4 — Statement Snapshots and FS Renderer

**Scope:**
- Create statement_snapshots and statement_snapshot_events tables.
- Create advance_snapshot_state() SECURITY DEFINER function.
- Implement FS Renderer as a distinct edge function (or extract from kinga-tax-engine) that writes to statement_snapshots.
- Update generate-xbrl to read from statement_snapshots instead of computation_detail.
- Advance engagement state from DRAFT_STATEMENTS_READY to STATEMENT_SNAPSHOT_CREATED on snapshot creation.

**Gate to proceed:** Every statement used by HESABU and XBRL is traceable to a statement_snapshot row with a non-NULL snapshot_hash.

### Phase 5 — Tax Finalization Boundary

**Scope:**
- Create tax_computation_statutory_refs table.
- Create tax_aje_reconciliation table.
- Create finalize_tax_computation() SECURITY DEFINER function.
- Upgrade kinga-tax-engine to call finalize_tax_computation() on user request.
- Verify three gated statutory_rules rows (min_tax, thin_cap, mgmt_fee_cap) are correctly BLOCKED.
- Advance engagement state from TAX_COMPUTED_DRAFT → TAX_FINALIZED via finalize_tax_computation().

**Gate to proceed:** Cannot finalize a computation referencing an unverified rate; cannot finalize with unresolved AJEs; engagement state advances correctly and is immutable once FINALIZED.

### Phase 6 — Compliance Period State Machine

**Scope:**
- Create compliance_periods, compliance_period_events, compliance_evidence_sources, and four typed evidence tables.
- Create applicability_rules table with trigger blocking MAONO writes.
- Seed applicability_rules for TZ jurisdiction: VAT/PAYE/SDL/WHT with verified effective dates.
- Wire EFDMSReconciliationPanel to advance VAT compliance period state.
- Wire PaymentLedgerPanel to evidence compliance_periods.
- Complete Tasks #208 (B-1) and #209 (B-2).

**Gate to proceed:** VAT reconciliation cycle for one company completes end-to-end through the state machine; MAONO cannot write to applicability_rules.

### Phase 7 — Filing Package and Submissions

**Scope:**
- Create filing_packages and filing_submissions tables.
- Implement FILING_PACKAGE_READY engagement state advancement.
- Wire TRAFilingChecklist to filing_packages.
- Retire filing_obligations table (disable writes; preserve rows).

**Gate to proceed:** A filing package can be assembled from an engagement in STATEMENTS_SIGNED state; the engagement advances to FILING_PACKAGE_READY; manual submission records can be captured.

---

## SECTION 8 — PRODUCTION READINESS

### Verdict: NOT READY

Implementation is blocked until all items in Sections A–H of the 56-item Go/No-Go Checklist are CONFIRMED. Current status of each section:

| Section | Description | Status |
|---------|-------------|--------|
| A — Architecture | v2.2 engagement lifecycle and engine boundaries | BLOCKED — engagements, statement_snapshots, compliance_periods absent |
| B — Schema | All required tables, columns, constraints, triggers in place | BLOCKED — 18 tables not created; 20+ FK columns reference wrong identity table; hesabu_validations missing 7 freshness fields; statement_sign_offs UNIQUE constraint not dropped |
| C — Backfill | Genesis Protocol executed; all counts reconcile; sign-off obtained | BLOCKED — cannot execute backfill until Phase 0–2 complete |
| D — Phases | All implementation phases sequenced and approved | BLOCKED — Phase 0 (identity foundation) not started |
| E — Rollback | Forward-only migration plan documented; no audit table drop permitted | CONFIRMED — forward-only pattern established in codebase |
| F — Identity | All audit FKs reference firm_members.id; resolve_actor_firm_member() exists | BLOCKED — 20+ auth.users audit FKs not migrated; resolve_actor_firm_member() not created |
| G — Idempotency | idempotency_keys table created; all 7 operation types registered | BLOCKED — table does not exist |
| H — Applicability | applicability_rules seeded; MAONO write block in place | BLOCKED — table does not exist |

### Summary of Open Items by Severity

**CRITICAL — blocks all phases:**
1. `engagements` table does not exist — the entire lifecycle has no anchor
2. `statement_sign_offs` UNIQUE(company_id, period_year) will prevent any revision model record from being inserted
3. `hesabu_block_signoff()` does not check stale=FALSE — HESABU gate can pass on stale validation data
4. No `version_allocations` table — concurrency-safe versioning is impossible; MAX()+1 is prohibited
5. No `idempotency_keys` — duplicate requests can create duplicate audit records
6. All audit FKs reference auth.users.id — every new SECURITY DEFINER function that enforces v2.2 will fail FK checks

**HIGH — blocks specific engines:**
7. `statement_snapshots` does not exist — FS Renderer cannot be implemented; HESABU has no snapshot to validate against
8. `finalize_tax_computation()` does not exist — TAX_FINALIZED state cannot be reached
9. `tax_computation_statutory_refs` does not exist — cannot prove rate provenance at finalization
10. `resolve_actor_firm_member()` does not exist — required by all SECURITY DEFINER gatekeepers in v2.2
11. `hesabu_validations` missing 7 freshness fields — HESABU is incapable of staleness detection
12. `hesabu_write_validation()` missing pg_temp in SET search_path — invariant violation

**MEDIUM — blocks compliance period model:**
13. `compliance_periods` and all related tables do not exist
14. `applicability_rules` does not exist — MAONO write-block trigger cannot be enforced
15. `compliance_evidence_sources` and typed extension tables do not exist
16. Tasks #208 (B-1), #209 (B-2), #210 (C-1) remain open from current sprint

**LOW — should be resolved before production but do not block phased implementation:**
17. `capital_allowances` DELETE not blocked by trigger
18. `adjusting_journal_entries.status` allows UPDATE (event-log conversion not yet done)
19. `efdms_records` table not formally retired
20. `filing_obligations` vs `compliance_periods` overlap not resolved
21. Duplicate XBRL table definitions in 20260711500000 vs 20260712044423 not verified for schema parity
22. `result_json` column on tax_computations is vestigial and undocumented

### What IS Production-Ready Today

The following engines and features are production-ready within the current architecture (i.e., prior to v2.2 full implementation) and must not be broken during v2.2 implementation phases:

- SAFISHA reconciliation pipeline (ingest → match → categorize → score → resolve → gate) ✓
- KINGA tax computation engine v1.3 with Finance Act 2026 ✓
- KINGA findings engine (Module B/C) ✓
- KINGA comparative engine ✓
- MAONO variance analysis, cashflow, root-cause, risk, decide, monitor ✓
- HESABU validation (12 assertions; gate functional post-trigger fix) ✓
- XBRL generation and Arelle validation ✓
- Firm management (invite, role enforcement, SoD) ✓
- Statement sign-off with HESABU gate (current, limited model) ✓
- All statutory rate gates with verified_at enforcement ✓
- Three unverified rate rows correctly blocked ✓

---

## APPENDIX A — CONSTITUTIONAL INVARIANTS COMPLIANCE MAP

v2.2 defines 50 constitutional invariants. Below is the compliance status of each category against the current codebase.

| Invariant Group | v2.2 Invariants | Current Status |
|-----------------|-----------------|----------------|
| Append-only audit tables | #1–5 | PARTIAL — safisha_transactions, aje_lines, variance_analyses, maono_insights, xbrl docs all compliant; adjusting_journal_entries status UPDATE not blocked; period_closing_balances allows UPDATE |
| SECURITY DEFINER write paths | #6–12 | PARTIAL — safisha-resolve, xbrl_write_instance, maono_write_alert, maono_write_board_pack compliant; finalize_tax_computation, advance_engagement_state, advance_snapshot_state absent |
| Actor identity (firm_members.id) | #13–18 | NON-COMPLIANT — 20+ audit FKs reference auth.users.id |
| No hardcoded thresholds | #19–22 | COMPLIANT — variance_materiality, statutory_rules used throughout |
| BLOCKED response on missing input | #23–25 | PARTIAL — generate-xbrl and hesabu-validate implement BLOCKED responses; other engines do not always return BLOCKED |
| request_id + function_version on every response | #26–27 | PARTIAL — hesabu-validate, generate-xbrl compliant; not all engines implement this |
| Concurrency-safe versioning | #28–30 | NON-COMPLIANT — version_allocations does not exist; any version counter using MAX()+1 is prohibited |
| Idempotency | #31–35 | NON-COMPLIANT — idempotency_keys does not exist |
| HESABU freshness | #36–40 | NON-COMPLIANT — 7 freshness fields absent |
| Engagement revision model | #41–45 | NON-COMPLIANT — engagements table does not exist |
| Tax finalization boundary | #46–48 | NON-COMPLIANT — finalize_tax_computation does not exist |
| Statement snapshot provenance | #49–50 | NON-COMPLIANT — statement_snapshots does not exist |

---

*This document is the implementation authority for all future SAFF ERP development. No migration, edge function, or UI change may be applied to the schema described herein without reference to this report and the approved v2.2 architecture. Any deviation from the findings and recommendations in this report requires a formal architecture amendment to SAFF_UX_REARCHITECTURE_v2_2.md before implementation proceeds.*
