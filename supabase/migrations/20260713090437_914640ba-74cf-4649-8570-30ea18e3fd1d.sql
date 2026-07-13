
-- ── Tolerance columns on variance_materiality ─────────────────────────────────
ALTER TABLE public.variance_materiality
  ADD COLUMN IF NOT EXISTS sfp_tolerance_tzs   NUMERIC(18,2)
    CHECK (sfp_tolerance_tzs >= 0) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS scf_tolerance_pct   NUMERIC(6,4)
    CHECK (scf_tolerance_pct >= 0 AND scf_tolerance_pct <= 1) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS socie_tolerance_pct NUMERIC(6,4)
    CHECK (socie_tolerance_pct >= 0 AND socie_tolerance_pct <= 1) DEFAULT NULL;

-- ── 1. hesabu_validations ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hesabu_validations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id         UUID NOT NULL REFERENCES public.trial_balance_uploads(id) ON DELETE CASCADE,
  company_id        UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period_year       INTEGER NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  status            TEXT NOT NULL
                    CHECK (status IN ('all_pass', 'some_fail', 'blocked_missing_data')),
  assertions_total  INTEGER NOT NULL DEFAULT 0,
  assertions_passed INTEGER NOT NULL DEFAULT 0,
  assertions_failed INTEGER NOT NULL DEFAULT 0,
  assertions_skipped INTEGER NOT NULL DEFAULT 0,
  sfp_tolerance_tzs_used   NUMERIC(18,2),
  scf_tolerance_pct_used   NUMERIC(6,4),
  socie_tolerance_pct_used NUMERIC(6,4),
  request_id        UUID NOT NULL DEFAULT gen_random_uuid(),
  function_version  TEXT NOT NULL DEFAULT 'hesabu-validate/v1.0.0',
  validated_by      UUID NOT NULL REFERENCES auth.users(id),
  validated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  gate_satisfied    BOOLEAN NOT NULL GENERATED ALWAYS AS (status = 'all_pass') STORED,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT ON public.hesabu_validations TO authenticated;
GRANT ALL ON public.hesabu_validations TO service_role;

ALTER TABLE public.hesabu_validations ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.hesabu_block_validation_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION
    'IRON DOME: hesabu_validations is append-only. Validation records cannot be modified or deleted.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS hesabu_validations_append_only ON public.hesabu_validations;
CREATE TRIGGER hesabu_validations_append_only
  BEFORE UPDATE OR DELETE ON public.hesabu_validations
  FOR EACH ROW EXECUTE FUNCTION public.hesabu_block_validation_mutation();

CREATE INDEX IF NOT EXISTS idx_hesabu_validations_upload
  ON public.hesabu_validations(upload_id, validated_at DESC);

CREATE INDEX IF NOT EXISTS idx_hesabu_validations_gate
  ON public.hesabu_validations(upload_id, gate_satisfied)
  WHERE gate_satisfied = TRUE;

DROP POLICY IF EXISTS "hesabu_val_read" ON public.hesabu_validations;
CREATE POLICY "hesabu_val_read" ON public.hesabu_validations FOR SELECT USING (
  company_id IN (SELECT company_id FROM public.firm_members WHERE user_id = auth.uid())
);

-- ── 2. hesabu_validation_assertions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hesabu_validation_assertions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  validation_id    UUID NOT NULL REFERENCES public.hesabu_validations(id) ON DELETE CASCADE,
  assertion_id     TEXT NOT NULL,
  assertion_name   TEXT NOT NULL,
  source_standard  TEXT NOT NULL,
  result           TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'skip')),
  skip_reason      TEXT,
  expected_value   NUMERIC(20,2),
  actual_value     NUMERIC(20,2),
  difference       NUMERIC(20,2) GENERATED ALWAYS AS (actual_value - expected_value) STORED,
  tolerance_used   NUMERIC(20,4),
  within_tolerance BOOLEAN GENERATED ALWAYS AS (
    ABS(actual_value - expected_value) <= tolerance_used
  ) STORED,
  severity         TEXT NOT NULL CHECK (severity IN ('critical', 'warn', 'info')),
  detail           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT ON public.hesabu_validation_assertions TO authenticated;
GRANT ALL ON public.hesabu_validation_assertions TO service_role;

ALTER TABLE public.hesabu_validation_assertions ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS hesabu_assertions_append_only ON public.hesabu_validation_assertions;
CREATE TRIGGER hesabu_assertions_append_only
  BEFORE UPDATE OR DELETE ON public.hesabu_validation_assertions
  FOR EACH ROW EXECUTE FUNCTION public.hesabu_block_validation_mutation();

CREATE INDEX IF NOT EXISTS idx_hesabu_assertions_validation
  ON public.hesabu_validation_assertions(validation_id, result);

CREATE INDEX IF NOT EXISTS idx_hesabu_assertions_failed
  ON public.hesabu_validation_assertions(validation_id, assertion_id)
  WHERE result = 'fail';

DROP POLICY IF EXISTS "hesabu_assert_read" ON public.hesabu_validation_assertions;
CREATE POLICY "hesabu_assert_read" ON public.hesabu_validation_assertions FOR SELECT USING (
  validation_id IN (
    SELECT hv.id FROM public.hesabu_validations hv
    WHERE hv.company_id IN (SELECT company_id FROM public.firm_members WHERE user_id = auth.uid())
  )
);

-- ── hesabu_write_validation() ─────────────────────────────────────────────────
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
SET search_path = public
AS $$
DECLARE
  v_user         UUID;
  v_validation_id UUID;
  v_assertion    JSONB;
BEGIN
  v_user := auth.uid();

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'IRON DOME: hesabu_write_validation requires authenticated user.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.firm_members
    WHERE company_id = p_company_id AND user_id = v_user
  ) THEN
    RAISE EXCEPTION 'IRON DOME: User is not a member of company %.', p_company_id;
  END IF;

  IF p_status NOT IN ('all_pass', 'some_fail', 'blocked_missing_data') THEN
    RAISE EXCEPTION 'Invalid status: %', p_status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.trial_balance_uploads
    WHERE id = p_upload_id AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'Upload % does not belong to company %.', p_upload_id, p_company_id;
  END IF;

  INSERT INTO public.hesabu_validations (
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

  FOR v_assertion IN SELECT * FROM jsonb_array_elements(p_assertions)
  LOOP
    INSERT INTO public.hesabu_validation_assertions (
      validation_id, assertion_id, assertion_name, source_standard,
      result, skip_reason, expected_value, actual_value, tolerance_used, severity, detail
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
  UUID, UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, INTEGER,
  NUMERIC, NUMERIC, NUMERIC, UUID, TEXT, JSONB
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hesabu_write_validation(
  UUID, UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, INTEGER,
  NUMERIC, NUMERIC, NUMERIC, UUID, TEXT, JSONB
) TO authenticated;

-- ── hesabu_block_signoff() (uses the 2026-07-13 corrected form) ───────────────
CREATE OR REPLACE FUNCTION public.hesabu_block_signoff()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_upload_id  UUID;
  v_pass_count INTEGER;
  v_fail_run   public.hesabu_validations%ROWTYPE;
BEGIN
  IF NEW.preparer_signed_at IS NULL THEN
    RETURN NEW;
  END IF;

  v_upload_id := NEW.upload_id;

  SELECT COUNT(*) INTO v_pass_count
  FROM public.hesabu_validations
  WHERE upload_id = v_upload_id
    AND gate_satisfied = TRUE;

  IF v_pass_count = 0 THEN
    SELECT * INTO v_fail_run
    FROM public.hesabu_validations
    WHERE upload_id = v_upload_id
    ORDER BY validated_at DESC
    LIMIT 1;

    IF v_fail_run.id IS NULL THEN
      RAISE EXCEPTION
        'IRON DOME — HESABU GATE: Financial statements have not been validated. '
        'Run HESABU validation before signing off. Upload: %', v_upload_id
        USING ERRCODE = 'restrict_violation';
    ELSE
      RAISE EXCEPTION
        'IRON DOME — HESABU GATE: Last validation run (%) has status=%. '
        '% assertion(s) failed. Resolve all failures and rerun validation before signing off. '
        'Upload: %',
        v_fail_run.id, v_fail_run.status, v_fail_run.assertions_failed, v_upload_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.hesabu_block_signoff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hesabu_block_signoff() TO authenticated;

DROP TRIGGER IF EXISTS hesabu_gate_before_signoff ON public.statement_sign_offs;
CREATE TRIGGER hesabu_gate_before_signoff
  BEFORE INSERT ON public.statement_sign_offs
  FOR EACH ROW
  EXECUTE FUNCTION public.hesabu_block_signoff();
