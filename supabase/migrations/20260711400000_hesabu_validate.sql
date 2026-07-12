-- ============================================================================
-- HESABU · Cross-Statement Validation Gate · IRON DOME NUCLEAR DESIGN
--
-- Implements Hoffman fac-ifrs arithmetic consistency checks + DQC calculation
-- rules as a MANDATORY sign-off gate. No FS may be signed off without a
-- passing hesabu_validations record.
--
-- Tables:
--   1. hesabu_validations         One run per upload_id (append-only)
--   2. hesabu_validation_assertions One assertion per run (append-only)
--
-- Schema additions:
--   variance_materiality.sfp_tolerance_tzs    — SFP equation tolerance (default 1000)
--   variance_materiality.scf_tolerance_pct    — SCF cash bridge tolerance (default 0.01)
--   variance_materiality.socie_tolerance_pct  — SOCIE equity bridge tolerance (default 0.05)
--
-- SECURITY DEFINER functions:
--   hesabu_write_validation()   — only sanctioned write path for validation results
--   hesabu_block_signoff()      — called by statement_sign_offs insert trigger;
--                                 raises exception if upload has no passing run
--
-- IRON DOME:
--   - Both tables are APPEND-ONLY. Validation results cannot be amended post-write.
--   - hesabu-validate Edge Function writes ONLY through hesabu_write_validation().
--   - statement_sign_offs INSERT is blocked unless a passing validation exists.
--   - Tolerances are PER-COMPANY, stored in variance_materiality.
--     No tolerance value is ever hardcoded in application code.
--   - First-year assertions (SCF/SOCIE require prior-year data) are SKIPPED,
--     not failed. Skip is explicit — no silent bypass.
-- ============================================================================

-- ── Tolerance columns on variance_materiality ─────────────────────────────────
--
-- These control how tight each class of cross-statement check is.
-- NULL means "use Iron Dome defaults" (documented below as DEFAULT).
-- Firm CPA can override per client — e.g. a large client may tolerate TZS 5,000
-- rounding on the SFP equation where smaller clients can't.

ALTER TABLE variance_materiality
  ADD COLUMN IF NOT EXISTS sfp_tolerance_tzs   NUMERIC(18,2)
    CHECK (sfp_tolerance_tzs >= 0)
    DEFAULT NULL,  -- NULL → use Iron Dome default: min(abs_threshold_tzs, 1000)
  ADD COLUMN IF NOT EXISTS scf_tolerance_pct   NUMERIC(6,4)
    CHECK (scf_tolerance_pct >= 0 AND scf_tolerance_pct <= 1)
    DEFAULT NULL,  -- NULL → use Iron Dome default: 0.01 (1% of cash balance, min 500000 TZS)
  ADD COLUMN IF NOT EXISTS socie_tolerance_pct NUMERIC(6,4)
    CHECK (socie_tolerance_pct >= 0 AND socie_tolerance_pct <= 1)
    DEFAULT NULL;  -- NULL → use Iron Dome default: 0.05 (5% of equity)

COMMENT ON COLUMN variance_materiality.sfp_tolerance_tzs IS
  'Maximum allowed difference (TZS) in the SFP fundamental equation (A = L + E) '
  'and equity decomposition checks. NULL = default: min(abs_threshold_tzs, 1000). '
  'Should never exceed TZS 1,000 for a balanced TB — larger gaps mean miscategorised accounts.';

COMMENT ON COLUMN variance_materiality.scf_tolerance_pct IS
  'Maximum allowed gap as a fraction of cash balance for the SCF→SFP cash bridge '
  '(derived_closing_cash vs SFP cash_balance_tzs). NULL = default: 0.01 (1%). '
  'Minimum floor TZS 500,000 applied regardless of pct result.';

COMMENT ON COLUMN variance_materiality.socie_tolerance_pct IS
  'Maximum allowed gap as a fraction of total equity for SOCIE→SFP equity and '
  'retained-earnings bridges. NULL = default: 0.05 (5%).';

-- ── 1. hesabu_validations ─────────────────────────────────────────────────────
--
-- One row per validation run. Append-only evidence of every consistency check
-- performed on a set of financial statements. Never updated or deleted.

CREATE TABLE IF NOT EXISTS hesabu_validations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What was validated
  upload_id         UUID NOT NULL REFERENCES trial_balance_uploads(id) ON DELETE CASCADE,
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_year       INTEGER NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),

  -- Overall result
  status            TEXT NOT NULL
                    CHECK (status IN ('all_pass', 'some_fail', 'blocked_missing_data')),
  --  all_pass            — all assertions passed within tolerance
  --  some_fail           — one or more assertions failed tolerance
  --  blocked_missing_data — required input data missing (e.g. no computation_detail)

  -- Counts
  assertions_total  INTEGER NOT NULL DEFAULT 0,
  assertions_passed INTEGER NOT NULL DEFAULT 0,
  assertions_failed INTEGER NOT NULL DEFAULT 0,
  assertions_skipped INTEGER NOT NULL DEFAULT 0,  -- e.g. first-year SCF/SOCIE

  -- Tolerances used (copied from variance_materiality at run time for audit)
  sfp_tolerance_tzs_used   NUMERIC(18,2),
  scf_tolerance_pct_used   NUMERIC(6,4),
  socie_tolerance_pct_used NUMERIC(6,4),

  -- Tracing
  request_id        UUID NOT NULL DEFAULT gen_random_uuid(),
  function_version  TEXT NOT NULL DEFAULT 'hesabu-validate/v1.0.0',
  validated_by      UUID NOT NULL REFERENCES auth.users(id),
  validated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Whether this run satisfies the sign-off gate
  -- TRUE iff status = 'all_pass'
  gate_satisfied    BOOLEAN NOT NULL GENERATED ALWAYS AS (status = 'all_pass') STORED,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- APPEND-ONLY enforcement
CREATE OR REPLACE FUNCTION hesabu_block_validation_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RAISE EXCEPTION
    'IRON DOME: hesabu_validations is append-only. Validation records cannot be modified or deleted.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER hesabu_validations_append_only
  BEFORE UPDATE OR DELETE ON hesabu_validations
  FOR EACH ROW EXECUTE FUNCTION hesabu_block_validation_mutation();

CREATE INDEX IF NOT EXISTS idx_hesabu_validations_upload
  ON hesabu_validations(upload_id, validated_at DESC);

CREATE INDEX IF NOT EXISTS idx_hesabu_validations_gate
  ON hesabu_validations(upload_id, gate_satisfied)
  WHERE gate_satisfied = TRUE;

ALTER TABLE hesabu_validations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hesabu_val_read" ON hesabu_validations FOR SELECT USING (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);
-- No direct INSERT policy — writes go through hesabu_write_validation() SECURITY DEFINER only.

-- ── 2. hesabu_validation_assertions ──────────────────────────────────────────
--
-- One row per assertion per validation run. Full audit trail of every check.

CREATE TABLE IF NOT EXISTS hesabu_validation_assertions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  validation_id    UUID NOT NULL REFERENCES hesabu_validations(id) ON DELETE CASCADE,

  -- Assertion identity
  assertion_id     TEXT NOT NULL,  -- e.g. 'H-01', 'H-07', 'D-01'
  assertion_name   TEXT NOT NULL,  -- human label
  source_standard  TEXT NOT NULL,  -- 'hoffman_fac_ifrs' | 'dqc_tagging_ifrs' | 'ifrs_for_smes_s7'

  -- Result
  result           TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'skip')),
  skip_reason      TEXT,           -- populated when result = 'skip'

  -- Values (all in TZS or pure ratio depending on assertion)
  expected_value   NUMERIC(20,2),  -- what the rule says it should be
  actual_value     NUMERIC(20,2),  -- what the data shows
  difference       NUMERIC(20,2) GENERATED ALWAYS AS (actual_value - expected_value) STORED,
  tolerance_used   NUMERIC(20,4),  -- the threshold applied for this assertion
  within_tolerance BOOLEAN GENERATED ALWAYS AS (
    ABS(actual_value - expected_value) <= tolerance_used
  ) STORED,

  -- Severity of this assertion if it fails
  severity         TEXT NOT NULL CHECK (severity IN ('critical', 'warn', 'info')),

  -- Plain English explanation for CPA review
  detail           TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- APPEND-ONLY
CREATE TRIGGER hesabu_assertions_append_only
  BEFORE UPDATE OR DELETE ON hesabu_validation_assertions
  FOR EACH ROW EXECUTE FUNCTION hesabu_block_validation_mutation();

CREATE INDEX IF NOT EXISTS idx_hesabu_assertions_validation
  ON hesabu_validation_assertions(validation_id, result);

CREATE INDEX IF NOT EXISTS idx_hesabu_assertions_failed
  ON hesabu_validation_assertions(validation_id, assertion_id)
  WHERE result = 'fail';

ALTER TABLE hesabu_validation_assertions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hesabu_assert_read" ON hesabu_validation_assertions FOR SELECT USING (
  validation_id IN (
    SELECT hv.id FROM hesabu_validations hv
    WHERE hv.company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
  )
);

-- ── SECURITY DEFINER: hesabu_write_validation() ───────────────────────────────
--
-- IRON DOME: The only sanctioned write path for validation results.
-- hesabu-validate Edge Function calls this; it does NOT insert directly.
-- Validates inputs, enforces append-only, returns validation_id.

CREATE OR REPLACE FUNCTION hesabu_write_validation(
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
  p_assertions         JSONB    -- array of assertion objects
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user         UUID;
  v_validation_id UUID;
  v_assertion    JSONB;
BEGIN
  v_user := auth.uid();

  -- Caller must be authenticated
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'IRON DOME: hesabu_write_validation requires authenticated user.';
  END IF;

  -- Caller must be a member of this company
  IF NOT EXISTS (
    SELECT 1 FROM firm_members
    WHERE company_id = p_company_id AND user_id = v_user
  ) THEN
    RAISE EXCEPTION 'IRON DOME: User is not a member of company %.', p_company_id;
  END IF;

  -- Validate status
  IF p_status NOT IN ('all_pass', 'some_fail', 'blocked_missing_data') THEN
    RAISE EXCEPTION 'Invalid status: %', p_status;
  END IF;

  -- Validate upload belongs to company
  IF NOT EXISTS (
    SELECT 1 FROM trial_balance_uploads
    WHERE id = p_upload_id AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'Upload % does not belong to company %.', p_upload_id, p_company_id;
  END IF;

  -- Write the run header
  INSERT INTO hesabu_validations (
    upload_id, company_id, period_year,
    status, assertions_total, assertions_passed, assertions_failed, assertions_skipped,
    sfp_tolerance_tzs_used, scf_tolerance_pct_used, socie_tolerance_pct_used,
    request_id, function_version, validated_by
  )
  VALUES (
    p_upload_id, p_company_id, p_period_year,
    p_status, p_assertions_total, p_assertions_passed, p_assertions_failed, p_assertions_skipped,
    p_sfp_tolerance_used, p_scf_tolerance_used, p_socie_tolerance_used,
    p_request_id, p_function_version, v_user
  )
  RETURNING id INTO v_validation_id;

  -- Write each assertion row
  FOR v_assertion IN SELECT * FROM jsonb_array_elements(p_assertions)
  LOOP
    INSERT INTO hesabu_validation_assertions (
      validation_id,
      assertion_id,
      assertion_name,
      source_standard,
      result,
      skip_reason,
      expected_value,
      actual_value,
      tolerance_used,
      severity,
      detail
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

REVOKE ALL ON FUNCTION hesabu_write_validation FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hesabu_write_validation TO authenticated;

-- ── SECURITY DEFINER: hesabu_block_signoff() ─────────────────────────────────
--
-- IRON DOME sign-off gate. Called by the statement_sign_offs INSERT trigger.
-- Raises an exception if the upload has no passing hesabu_validations record.
-- "No validation at all" and "validation failed" are both hard blocks.

CREATE OR REPLACE FUNCTION hesabu_block_signoff()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_upload_id  UUID;
  v_pass_count INTEGER;
  v_fail_run   hesabu_validations%ROWTYPE;
BEGIN
  -- statement_sign_offs has upload_id column
  v_upload_id := NEW.upload_id;

  SELECT COUNT(*) INTO v_pass_count
  FROM hesabu_validations
  WHERE upload_id = v_upload_id
    AND gate_satisfied = TRUE;

  IF v_pass_count = 0 THEN
    -- Check if a failed run exists (to give a more helpful error)
    SELECT * INTO v_fail_run
    FROM hesabu_validations
    WHERE upload_id = v_upload_id
    ORDER BY validated_at DESC
    LIMIT 1;

    IF v_fail_run.id IS NULL THEN
      RAISE EXCEPTION
        'IRON DOME — HESABU GATE: Financial statements have not been validated. '
        'Run hesabu-validate before signing off. Upload: %', v_upload_id
        USING ERRCODE = 'restrict_violation';
    ELSE
      RAISE EXCEPTION
        'IRON DOME — HESABU GATE: Last validation run (%) failed with status=%. '
        '% assertion(s) failed. Run hesabu-validate and resolve all failures before signing off. '
        'Upload: %',
        v_fail_run.id, v_fail_run.status, v_fail_run.assertions_failed, v_upload_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- Validation passed — allow sign-off to proceed
  RETURN NEW;
END;
$$;

-- Wire the gate onto statement_sign_offs
-- (preparer tier — the first signer; if preparer can't sign without validation,
--  reviewer and approver also can't, since sign-off is sequential)
CREATE TRIGGER hesabu_gate_before_signoff
  BEFORE INSERT ON statement_sign_offs
  FOR EACH ROW
  WHEN (NEW.sign_off_tier = 'preparer')   -- only gate the first tier
  EXECUTE FUNCTION hesabu_block_signoff();

-- ── Comments ──────────────────────────────────────────────────────────────────

COMMENT ON TABLE hesabu_validations IS
  'IRON DOME: Append-only record of HESABU cross-statement validation runs. '
  'Implements Hoffman fac-ifrs arithmetic consistency checks and DQC calculation '
  'rules across SFP, IS, SCF, and SOCIE. gate_satisfied=TRUE is required before '
  'statement_sign_offs INSERT is permitted (enforced by hesabu_block_signoff trigger).';

COMMENT ON TABLE hesabu_validation_assertions IS
  'IRON DOME: Append-only detail of each individual assertion checked in a '
  'hesabu_validations run. One row per assertion (H-01 through H-12 + D-01 through D-04). '
  'Contains expected_value, actual_value, difference, tolerance_used, and result for '
  'full CPA-reviewable audit trail.';

COMMENT ON FUNCTION hesabu_write_validation IS
  'SECURITY DEFINER write gate for HESABU validation results. '
  'Validates caller membership, enforces append-only, writes header + all assertion rows '
  'atomically. hesabu-validate Edge Function must use this — no direct INSERT permitted.';

COMMENT ON FUNCTION hesabu_block_signoff IS
  'SECURITY DEFINER trigger function. Fires BEFORE INSERT on statement_sign_offs '
  'when sign_off_tier=preparer. Blocks sign-off unless a passing hesabu_validations '
  'record exists for the upload. Provides specific error message distinguishing '
  '"never validated" from "validated but failed".';
