-- ── Phase 1-B: Identity Migration ────────────────────────────────────────────
--
-- SAFF Architecture v2.3 — Phase 1 implementation.
-- Adds firm_members.id parallel columns (_member_id) to all 23 tables that
-- currently store auth.users.id in audit/actor columns (AUDIT FK DEFECT per
-- Phase 0 report). Backfills existing rows. Updates 4 SECURITY DEFINER
-- functions to populate both the legacy auth.users.id column and the new
-- firm_members.id column simultaneously during the Phase 1 → Phase 2
-- transition window.
--
-- ── ARCHITECTURAL DECISIONS (resolves Phase 0 blockers 1–3) ──────────────────
--
-- DECISION 1 — safisha_audit_log.reviewer_id (Blocker 1):
--   APPEND-ONLY constraint is inviolable per Iron Dome. Backfill via UPDATE
--   is blocked by the safisha_block_audit_mutation() trigger. Decision:
--   Add reviewer_member_id (nullable). New rows populated going forward.
--   Historical rows retain auth.users.id in reviewer_id permanently.
--   reviewer_id is reclassified as AUTH USER IDENTITY (not a defect to fix).
--
-- DECISION 2 — maono_context.updated_by (Blocker 2):
--   maono_context is a global system configuration table with no company_id.
--   The concept of "which firm member updated the global TRA calendar" is
--   undefined without a company scope. updated_by keeps REFERENCES auth.users(id)
--   permanently. Classified AUTH USER IDENTITY. No column added.
--
-- DECISION 3 — safisha_reconciliations.client_id + safisha_client_mappings.client_id (Blocker 3):
--   Safisha is a per-user workspace tool. Each accountant owns their own
--   reconciliation workspace independently. client_id = auth.uid() is
--   intentional and correct for the Safisha access model. These columns
--   keep REFERENCES auth.users(id) permanently. Classified AUTH USER IDENTITY.
--
-- ── TRANSITION MODEL ─────────────────────────────────────────────────────────
--
-- Phase 1 (this migration): Add _member_id columns + backfill + write both.
-- Phase 2 (future): After all _member_id columns are fully populated, drop
--   legacy auth.users.id columns, update RLS policies, mark complete.
--
-- INVARIANT: During Phase 1, every write path populates BOTH the legacy column
-- (auth.users.id) AND the new _member_id column (firm_members.id). No data loss.
-- Old columns remain NOT NULL where they were NOT NULL; new columns are nullable
-- for backward compatibility.
--
-- ── SECTION 1: HELPER FUNCTION ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.resolve_member_id(
  p_user_id    UUID,
  p_company_id UUID
)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id
  FROM public.firm_members
  WHERE user_id    = p_user_id
    AND company_id = p_company_id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_member_id(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_member_id(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_member_id(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.resolve_member_id IS
  'SECURITY DEFINER helper: translates (auth.users.id, company_id) → firm_members.id. '
  'Returns NULL if no matching firm_member found (service-role pipelines). '
  'Used during Phase 1 to populate _member_id columns alongside legacy auth.users.id columns.';

-- ── SECTION 2: ADD _member_id COLUMNS ────────────────────────────────────────

-- Tax engine tables
ALTER TABLE public.capital_allowances
  ADD COLUMN IF NOT EXISTS created_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

ALTER TABLE public.tax_payments
  ADD COLUMN IF NOT EXISTS created_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

ALTER TABLE public.fiscal_periods
  ADD COLUMN IF NOT EXISTS created_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

ALTER TABLE public.tax_losses
  ADD COLUMN IF NOT EXISTS created_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

ALTER TABLE public.tax_computations
  ADD COLUMN IF NOT EXISTS cpa_modified_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

-- Iron Dome nuclear tables
ALTER TABLE public.adjusting_journal_entries
  ADD COLUMN IF NOT EXISTS created_by_member_id  UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

ALTER TABLE public.management_inputs
  ADD COLUMN IF NOT EXISTS created_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

-- statement_sign_offs: preparer/reviewer/approver already have _firm_member_id columns.
-- Only locked_by_member_id is missing.
ALTER TABLE public.statement_sign_offs
  ADD COLUMN IF NOT EXISTS locked_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.statement_sign_offs.locked_by_member_id IS
  'v2.3 Phase 1: firm_members.id of the user who locked the period. '
  'Parallel to locked_by (auth.users.id). locked_by retained for Phase 1→2 transition.';

-- Safisha tables
ALTER TABLE public.safisha_exceptions
  ADD COLUMN IF NOT EXISTS reviewer_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

-- safisha_audit_log: APPEND-ONLY. New column populated going forward via
-- safisha_resolve_exception() SECURITY DEFINER. Historical rows: reviewer_id
-- retains auth.users.id permanently (Decision 1 above).
ALTER TABLE public.safisha_audit_log
  ADD COLUMN IF NOT EXISTS reviewer_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

-- Maono tables
ALTER TABLE public.account_pl_mapping
  ADD COLUMN IF NOT EXISTS created_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

ALTER TABLE public.variance_materiality
  ADD COLUMN IF NOT EXISTS updated_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

ALTER TABLE public.variance_budgets
  ADD COLUMN IF NOT EXISTS submitted_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

ALTER TABLE public.variance_runs
  ADD COLUMN IF NOT EXISTS triggered_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

ALTER TABLE public.variance_alerts
  ADD COLUMN IF NOT EXISTS acknowledged_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

ALTER TABLE public.board_packs
  ADD COLUMN IF NOT EXISTS generated_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

ALTER TABLE public.efdms_z_reports
  ADD COLUMN IF NOT EXISTS imported_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

ALTER TABLE public.efdms_reconciliation
  ADD COLUMN IF NOT EXISTS reconciled_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

-- Hesabu / XBRL
ALTER TABLE public.hesabu_validations
  ADD COLUMN IF NOT EXISTS validated_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

ALTER TABLE public.xbrl_instance_documents
  ADD COLUMN IF NOT EXISTS generated_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

-- Early Kinga tables (pre-firm_members pattern)
ALTER TABLE public.efdms_records
  ADD COLUMN IF NOT EXISTS ingested_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

ALTER TABLE public.findings
  ADD COLUMN IF NOT EXISTS created_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

ALTER TABLE public.evidence_requests
  ADD COLUMN IF NOT EXISTS created_by_member_id UUID
    REFERENCES public.firm_members(id) ON DELETE SET NULL;

-- ── SECTION 3: BACKFILL ───────────────────────────────────────────────────────
--
-- For each table where company_id is available directly, backfill via a join
-- to firm_members on (user_id = <actor_col>, company_id = company_id).
-- For tables where company_id requires a join chain, the chain is explicit.
-- Only rows with non-null actor columns and null _member_id are updated.
-- Rows where the actor user is no longer a firm_member will not be translated
-- (orphan users); those rows retain NULL in _member_id and must be reviewed.

-- Tax engine tables (all have company_id directly)
UPDATE public.capital_allowances t
SET created_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.created_by AND fm.company_id = t.company_id
  AND t.created_by IS NOT NULL AND t.created_by_member_id IS NULL;

UPDATE public.tax_payments t
SET created_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.created_by AND fm.company_id = t.company_id
  AND t.created_by IS NOT NULL AND t.created_by_member_id IS NULL;

UPDATE public.fiscal_periods t
SET created_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.created_by AND fm.company_id = t.company_id
  AND t.created_by IS NOT NULL AND t.created_by_member_id IS NULL;

UPDATE public.tax_losses t
SET created_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.created_by AND fm.company_id = t.company_id
  AND t.created_by IS NOT NULL AND t.created_by_member_id IS NULL;

UPDATE public.tax_computations t
SET cpa_modified_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.cpa_modified_by AND fm.company_id = t.company_id
  AND t.cpa_modified_by IS NOT NULL AND t.cpa_modified_by_member_id IS NULL;

-- Iron Dome tables
UPDATE public.adjusting_journal_entries t
SET created_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.created_by AND fm.company_id = t.company_id
  AND t.created_by IS NOT NULL AND t.created_by_member_id IS NULL;

UPDATE public.adjusting_journal_entries t
SET approved_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.approved_by AND fm.company_id = t.company_id
  AND t.approved_by IS NOT NULL AND t.approved_by_member_id IS NULL;

UPDATE public.management_inputs t
SET created_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.created_by AND fm.company_id = t.company_id
  AND t.created_by IS NOT NULL AND t.created_by_member_id IS NULL;

UPDATE public.statement_sign_offs t
SET locked_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.locked_by AND fm.company_id = t.company_id
  AND t.locked_by IS NOT NULL AND t.locked_by_member_id IS NULL;

-- Safisha: company_id via reconciliation → upload → company
UPDATE public.safisha_exceptions se
SET reviewer_member_id = fm.id
FROM public.firm_members fm
JOIN public.trial_balance_uploads tbu ON tbu.company_id = fm.company_id
JOIN public.safisha_reconciliations sr
  ON sr.tb_upload_id = tbu.id AND sr.id = se.reconciliation_id
WHERE fm.user_id = se.reviewer_id
  AND se.reviewer_id IS NOT NULL AND se.reviewer_member_id IS NULL;
-- Note: safisha_audit_log is append-only — no backfill UPDATE possible.

-- Maono tables (all have company_id directly)
UPDATE public.account_pl_mapping t
SET created_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.created_by AND fm.company_id = t.company_id
  AND t.created_by IS NOT NULL AND t.created_by_member_id IS NULL;

UPDATE public.variance_materiality t
SET updated_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.updated_by AND fm.company_id = t.company_id
  AND t.updated_by IS NOT NULL AND t.updated_by_member_id IS NULL;

UPDATE public.variance_budgets t
SET submitted_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.submitted_by AND fm.company_id = t.company_id
  AND t.submitted_by IS NOT NULL AND t.submitted_by_member_id IS NULL;

UPDATE public.variance_budgets t
SET approved_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.approved_by AND fm.company_id = t.company_id
  AND t.approved_by IS NOT NULL AND t.approved_by_member_id IS NULL;

UPDATE public.variance_runs t
SET triggered_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.triggered_by AND fm.company_id = t.company_id
  AND t.triggered_by IS NOT NULL AND t.triggered_by_member_id IS NULL;

UPDATE public.variance_alerts t
SET acknowledged_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.acknowledged_by AND fm.company_id = t.company_id
  AND t.acknowledged_by IS NOT NULL AND t.acknowledged_by_member_id IS NULL;

UPDATE public.board_packs t
SET generated_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.generated_by AND fm.company_id = t.company_id
  AND t.generated_by IS NOT NULL AND t.generated_by_member_id IS NULL;

UPDATE public.efdms_z_reports t
SET imported_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.imported_by AND fm.company_id = t.company_id
  AND t.imported_by IS NOT NULL AND t.imported_by_member_id IS NULL;

UPDATE public.efdms_reconciliation t
SET reconciled_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.reconciled_by AND fm.company_id = t.company_id
  AND t.reconciled_by IS NOT NULL AND t.reconciled_by_member_id IS NULL;

-- Hesabu / XBRL (company_id directly)
UPDATE public.hesabu_validations t
SET validated_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.validated_by AND fm.company_id = t.company_id
  AND t.validated_by IS NOT NULL AND t.validated_by_member_id IS NULL;

UPDATE public.xbrl_instance_documents t
SET generated_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.generated_by AND fm.company_id = t.company_id
  AND t.generated_by IS NOT NULL AND t.generated_by_member_id IS NULL;

-- Early Kinga tables (company_id directly)
UPDATE public.efdms_records t
SET ingested_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.ingested_by AND fm.company_id = t.company_id
  AND t.ingested_by IS NOT NULL AND t.ingested_by_member_id IS NULL;

UPDATE public.findings t
SET created_by_member_id = fm.id
FROM public.firm_members fm
WHERE fm.user_id = t.created_by AND fm.company_id = t.company_id
  AND t.created_by IS NOT NULL AND t.created_by_member_id IS NULL;

UPDATE public.evidence_requests er
SET created_by_member_id = fm.id
FROM public.firm_members fm
JOIN public.findings f ON f.id = er.finding_id AND fm.company_id = f.company_id
WHERE fm.user_id = er.created_by
  AND er.created_by IS NOT NULL AND er.created_by_member_id IS NULL;

-- ── SECTION 4: RECREATE SECURITY DEFINER FUNCTIONS WITH _member_id POPULATION ─
--
-- Each function now:
--   1. Resolves v_member_id from firm_members WHERE user_id = auth.uid() AND company_id = ...
--   2. Writes the EXISTING auth.users.id column (unchanged — legacy column stays populated)
--   3. ALSO writes the NEW _member_id column (firm_members.id)
-- This dual-write ensures both columns are populated during the Phase 1 window.
-- Phase 2 will drop the legacy auth.users.id columns after full verification.

-- ── 4.1 hesabu_write_validation() ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.hesabu_write_validation(
  p_upload_id          UUID,
  p_company_id         UUID,
  p_period_year        INTEGER,
  p_status             TEXT,
  p_assertions_total   INTEGER,
  p_assertions_passed  INTEGER,
  p_assertions_failed  INTEGER,
  p_assertions_skipped INTEGER,
  p_sfp_tolerance_used NUMERIC,
  p_scf_tolerance_used NUMERIC,
  p_socie_tolerance_used NUMERIC,
  p_request_id         UUID,
  p_function_version   TEXT,
  p_assertions         JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user         UUID;
  v_member_id    UUID;
  v_validation_id UUID;
  v_assertion    JSONB;
BEGIN
  v_user := auth.uid();

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'IRON DOME: hesabu_write_validation requires authenticated user.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM firm_members
    WHERE company_id = p_company_id AND user_id = v_user
  ) THEN
    RAISE EXCEPTION 'IRON DOME: User is not a member of company %.', p_company_id;
  END IF;

  -- v2.3 Phase 1: resolve firm_members.id for audit trail
  v_member_id := public.resolve_member_id(v_user, p_company_id);

  IF p_status NOT IN ('all_pass', 'some_fail', 'blocked_missing_data') THEN
    RAISE EXCEPTION 'Invalid status: %', p_status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM trial_balance_uploads
    WHERE id = p_upload_id AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'Upload % does not belong to company %.', p_upload_id, p_company_id;
  END IF;

  INSERT INTO hesabu_validations (
    upload_id, company_id, period_year,
    status, assertions_total, assertions_passed, assertions_failed, assertions_skipped,
    sfp_tolerance_tzs_used, scf_tolerance_pct_used, socie_tolerance_pct_used,
    request_id, function_version,
    validated_by,          -- legacy: auth.users.id (Phase 1 → Phase 2 transition)
    validated_by_member_id -- v2.3: firm_members.id (canonical going forward)
  )
  VALUES (
    p_upload_id, p_company_id, p_period_year,
    p_status, p_assertions_total, p_assertions_passed, p_assertions_failed, p_assertions_skipped,
    p_sfp_tolerance_used, p_scf_tolerance_used, p_socie_tolerance_used,
    p_request_id, p_function_version,
    v_user,      -- auth.users.id
    v_member_id  -- firm_members.id
  )
  RETURNING id INTO v_validation_id;

  FOR v_assertion IN SELECT * FROM jsonb_array_elements(p_assertions)
  LOOP
    INSERT INTO hesabu_validation_assertions (
      validation_id,
      assertion_id, assertion_name, source_standard,
      result, skip_reason,
      expected_value, actual_value, tolerance_used,
      severity, detail
    )
    VALUES (
      v_validation_id,
      v_assertion->>'assertion_id',
      v_assertion->>'assertion_name',
      v_assertion->>'source_standard',
      v_assertion->>'result',
      v_assertion->>'skip_reason',
      (v_assertion->>'expected_value')::NUMERIC,
      (v_assertion->>'actual_value')::NUMERIC,
      (v_assertion->>'tolerance_used')::NUMERIC,
      v_assertion->>'severity',
      v_assertion->>'detail'
    );
  END LOOP;

  RETURN v_validation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.hesabu_write_validation(
  uuid, uuid, integer, text,
  integer, integer, integer, integer,
  numeric, numeric, numeric,
  uuid, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hesabu_write_validation(
  uuid, uuid, integer, text,
  integer, integer, integer, integer,
  numeric, numeric, numeric,
  uuid, text, jsonb
) TO authenticated;

-- ── 4.2 xbrl_write_instance() ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.xbrl_write_instance(
  p_upload_id         UUID,
  p_company_id        UUID,
  p_period_year       INTEGER,
  p_reporting_framework TEXT,
  p_output_format     TEXT,
  p_taxonomy_version  TEXT,
  p_instance_xml      TEXT,
  p_instance_sha256   TEXT,
  p_fact_count        INTEGER,
  p_validation_passed BOOLEAN,
  p_validation_errors INTEGER,
  p_validation_warnings INTEGER,
  p_validation_info   INTEGER,
  p_request_id        UUID,
  p_function_version  TEXT,
  p_issues            JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user      UUID;
  v_member_id UUID;
  v_doc_id    UUID;
  v_issue     JSONB;
BEGIN
  v_user := auth.uid();

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'IRON DOME: xbrl_write_instance requires authenticated user.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM firm_members
    WHERE company_id = p_company_id AND user_id = v_user
  ) THEN
    RAISE EXCEPTION 'IRON DOME: User is not a member of company %.', p_company_id;
  END IF;

  -- v2.3 Phase 1: resolve firm_members.id
  v_member_id := public.resolve_member_id(v_user, p_company_id);

  IF NOT EXISTS (
    SELECT 1 FROM trial_balance_uploads
    WHERE id = p_upload_id AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'Upload % does not belong to company %.', p_upload_id, p_company_id;
  END IF;

  IF p_reporting_framework IN ('ipsas_accrual', 'ipsas_cash') THEN
    RAISE EXCEPTION
      'IRON DOME: IPSAS XBRL taxonomy not implemented. '
      'Framework % cannot generate XBRL output. '
      'Use ifrs_for_smes or full_ifrs.', p_reporting_framework;
  END IF;

  IF p_output_format NOT IN ('xbrl_2_1', 'ixbrl_1_1') THEN
    RAISE EXCEPTION 'Invalid output_format: %', p_output_format;
  END IF;

  IF p_instance_sha256 IS NULL OR length(p_instance_sha256) != 64 THEN
    RAISE EXCEPTION
      'IRON DOME: instance_sha256 must be a 64-character hex string. '
      'Received: %', coalesce(p_instance_sha256, 'NULL');
  END IF;

  INSERT INTO xbrl_instance_documents (
    upload_id, company_id, period_year, reporting_framework,
    output_format, taxonomy_version,
    instance_xml, instance_sha256, fact_count,
    validation_passed, validation_errors, validation_warnings, validation_info,
    request_id, function_version,
    generated_by,          -- legacy: auth.users.id
    generated_by_member_id -- v2.3: firm_members.id
  )
  VALUES (
    p_upload_id, p_company_id, p_period_year, p_reporting_framework,
    p_output_format, p_taxonomy_version,
    p_instance_xml, p_instance_sha256, p_fact_count,
    p_validation_passed, p_validation_errors, p_validation_warnings, p_validation_info,
    p_request_id, p_function_version,
    v_user,      -- auth.users.id
    v_member_id  -- firm_members.id
  )
  RETURNING id INTO v_doc_id;

  FOR v_issue IN SELECT * FROM jsonb_array_elements(p_issues)
  LOOP
    INSERT INTO xbrl_validation_issues (
      document_id, severity, arelle_code, message, xbrl_element, fact_value
    )
    VALUES (
      v_doc_id,
      v_issue->>'severity',
      v_issue->>'arelle_code',
      v_issue->>'message',
      v_issue->>'xbrl_element',
      v_issue->>'fact_value'
    );
  END LOOP;

  RETURN v_doc_id;
END;
$$;

REVOKE ALL ON FUNCTION public.xbrl_write_instance(
  uuid, uuid, integer, text, text, text, text, text,
  integer, boolean, integer, integer, integer, uuid, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.xbrl_write_instance(
  uuid, uuid, integer, text, text, text, text, text,
  integer, boolean, integer, integer, integer, uuid, text, jsonb
) TO authenticated;

COMMENT ON FUNCTION public.xbrl_write_instance IS
  'SECURITY DEFINER write gate for XBRL instance documents. '
  'v2.3 Phase 1: writes both generated_by (auth.users.id) and generated_by_member_id (firm_members.id). '
  'Phase 2 will drop generated_by after full migration.';

-- ── 4.3 maono_write_board_pack() ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.maono_write_board_pack(
  p_company_id       UUID,
  p_run_id           UUID,
  p_period_label     TEXT,
  p_pack_type        TEXT,
  p_sections_json    JSONB,
  p_summary_text     TEXT,
  p_generation_model TEXT,
  p_context_version  INTEGER
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id        UUID;
  v_user      UUID;
  v_member_id UUID;
BEGIN
  v_user := auth.uid();

  IF NOT EXISTS (
    SELECT 1 FROM firm_members
    WHERE company_id = p_company_id AND user_id = v_user
  ) THEN
    RAISE EXCEPTION 'IRON DOME: User is not a member of this company.';
  END IF;

  -- v2.3 Phase 1: resolve firm_members.id
  v_member_id := public.resolve_member_id(v_user, p_company_id);

  IF p_pack_type NOT IN ('monthly', 'quarterly', 'annual') THEN
    RAISE EXCEPTION 'Invalid pack_type: %', p_pack_type;
  END IF;

  INSERT INTO board_packs (
    company_id, run_id, period_label, pack_type,
    sections_json, summary_text,
    generated_by,          -- legacy: auth.users.id
    generated_by_member_id, -- v2.3: firm_members.id
    generation_model, context_version
  )
  VALUES (
    p_company_id, p_run_id, p_period_label, p_pack_type,
    p_sections_json, p_summary_text,
    v_user,       -- auth.users.id
    v_member_id,  -- firm_members.id
    p_generation_model, p_context_version
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.maono_write_board_pack(
  uuid, uuid, text, text, jsonb, text, text, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.maono_write_board_pack(
  uuid, uuid, text, text, jsonb, text, text, integer
) TO authenticated;

-- ── 4.4 safisha_resolve_exception() ──────────────────────────────────────────
--
-- Adds: SET search_path = public, pg_temp (BLOCKER 6 fix, redundant after
-- Migration A but included here for correctness of the full function definition)
-- Adds: reviewer_member_id population (firm_members.id) alongside existing
-- reviewer_id (auth.users.id) in both safisha_exceptions UPDATE and
-- safisha_audit_log INSERT.
-- v_member_id resolved via: reviewer auth.users.id → firm_members → company →
-- trial_balance_uploads → safisha_reconciliations.

CREATE OR REPLACE FUNCTION public.safisha_resolve_exception(
  p_exception_id  UUID,
  p_reviewer_id   UUID,   -- auth.users.id of the reviewer
  p_action        TEXT,   -- 'approved' | 'rejected' | 'escalated'
  p_note          TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exception  safisha_exceptions%ROWTYPE;
  v_recon      safisha_reconciliations%ROWTYPE;
  v_remaining  INTEGER;
  v_member_id  UUID;
BEGIN
  IF p_action NOT IN ('approved','rejected','escalated') THEN
    RAISE EXCEPTION 'Invalid reviewer_action: %. Must be approved|rejected|escalated', p_action;
  END IF;

  SELECT * INTO v_exception FROM safisha_exceptions WHERE id = p_exception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Exception % not found', p_exception_id;
  END IF;
  IF v_exception.reviewer_action <> 'pending' THEN
    RAISE EXCEPTION 'Exception % is already resolved (%)', p_exception_id, v_exception.reviewer_action;
  END IF;

  -- v2.3 Phase 1: resolve firm_members.id via reconciliation → upload → company
  SELECT fm.id INTO v_member_id
  FROM public.firm_members fm
  JOIN public.trial_balance_uploads tbu ON tbu.company_id = fm.company_id
  JOIN public.safisha_reconciliations sr
    ON sr.tb_upload_id = tbu.id AND sr.id = v_exception.reconciliation_id
  WHERE fm.user_id = p_reviewer_id
  LIMIT 1;
  -- v_member_id may be NULL if reviewer has no firm membership for this company
  -- (e.g. service_role pipeline call). This is intentional — NULL is acceptable.

  PERFORM set_config('safisha.resolve_authorized', 'true', TRUE);

  UPDATE safisha_exceptions SET
    reviewer_action    = p_action,
    reviewer_id        = p_reviewer_id,   -- legacy: auth.users.id
    reviewer_member_id = v_member_id,     -- v2.3: firm_members.id (nullable)
    reviewer_note      = p_note,
    resolved_at        = now()
  WHERE id = p_exception_id;

  PERFORM set_config('safisha.resolve_authorized', 'false', TRUE);

  SELECT COUNT(*) INTO v_remaining
  FROM safisha_exceptions
  WHERE reconciliation_id = v_exception.reconciliation_id
    AND reviewer_action = 'pending';

  IF v_remaining = 0 THEN
    DECLARE
      v_blocked INTEGER;
    BEGIN
      SELECT COUNT(*) INTO v_blocked
      FROM safisha_exceptions
      WHERE reconciliation_id = v_exception.reconciliation_id
        AND category = 'investigate'
        AND reviewer_action = 'rejected';
      IF v_blocked > 0 THEN
        UPDATE safisha_reconciliations SET status = 'blocked' WHERE id = v_exception.reconciliation_id;
        UPDATE trial_balance_uploads SET safisha_status = 'blocked' WHERE id = (
          SELECT tb_upload_id FROM safisha_reconciliations WHERE id = v_exception.reconciliation_id
        );
      ELSE
        UPDATE safisha_reconciliations SET
          status       = 'clean',
          completed_at = now()
        WHERE id = v_exception.reconciliation_id;
        UPDATE trial_balance_uploads SET safisha_status = 'clean' WHERE id = (
          SELECT tb_upload_id FROM safisha_reconciliations WHERE id = v_exception.reconciliation_id
        );
      END IF;
    END;
  END IF;

  -- Append-only audit log write (INSERT only — trigger blocks UPDATE/DELETE)
  INSERT INTO safisha_audit_log (
    exception_id, reconciliation_id,
    reviewer_id,         -- legacy: auth.users.id
    reviewer_member_id,  -- v2.3: firm_members.id
    action, note
  ) VALUES (
    p_exception_id, v_exception.reconciliation_id,
    p_reviewer_id,
    v_member_id,
    p_action, p_note
  );

  RETURN jsonb_build_object(
    'exception_id',   p_exception_id,
    'action',         p_action,
    'remaining',      v_remaining,
    'recon_status',   (SELECT status FROM safisha_reconciliations WHERE id = v_exception.reconciliation_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.safisha_resolve_exception(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.safisha_resolve_exception(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.safisha_resolve_exception(uuid, uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.safisha_resolve_exception IS
  'SECURITY DEFINER: sole write path for safisha exception resolution. '
  'v2.3 Phase 1: writes reviewer_id (auth.users.id, legacy) AND reviewer_member_id '
  '(firm_members.id, canonical). reviewer_member_id may be NULL for service_role callers. '
  'safisha_audit_log is append-only; reviewer_member_id backfill not possible for historical rows.';

-- ── SECTION 5: SMOKE TEST ─────────────────────────────────────────────────────

DO $smoke$
DECLARE
  v_col BOOLEAN;

  PROCEDURE check_col(p_table TEXT, p_col TEXT) AS $$
  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = p_table AND column_name = p_col
    ) INTO v_col;
    ASSERT v_col, FORMAT('FAIL: %s.%s missing after Phase 1-B migration', p_table, p_col);
  END;
  $$

BEGIN
  check_col('capital_allowances',       'created_by_member_id');
  check_col('tax_payments',             'created_by_member_id');
  check_col('fiscal_periods',           'created_by_member_id');
  check_col('tax_losses',               'created_by_member_id');
  check_col('tax_computations',         'cpa_modified_by_member_id');
  check_col('adjusting_journal_entries','created_by_member_id');
  check_col('adjusting_journal_entries','approved_by_member_id');
  check_col('management_inputs',        'created_by_member_id');
  check_col('statement_sign_offs',      'locked_by_member_id');
  check_col('safisha_exceptions',       'reviewer_member_id');
  check_col('safisha_audit_log',        'reviewer_member_id');
  check_col('account_pl_mapping',       'created_by_member_id');
  check_col('variance_materiality',     'updated_by_member_id');
  check_col('variance_budgets',         'submitted_by_member_id');
  check_col('variance_budgets',         'approved_by_member_id');
  check_col('variance_runs',            'triggered_by_member_id');
  check_col('variance_alerts',          'acknowledged_by_member_id');
  check_col('board_packs',              'generated_by_member_id');
  check_col('efdms_z_reports',          'imported_by_member_id');
  check_col('efdms_reconciliation',     'reconciled_by_member_id');
  check_col('hesabu_validations',       'validated_by_member_id');
  check_col('xbrl_instance_documents',  'generated_by_member_id');
  check_col('efdms_records',            'ingested_by_member_id');
  check_col('findings',                 'created_by_member_id');
  check_col('evidence_requests',        'created_by_member_id');

  RAISE NOTICE 'Phase 1-B smoke test: all 25 _member_id columns confirmed present.';
END;
$smoke$;
