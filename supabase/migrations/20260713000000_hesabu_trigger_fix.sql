-- ============================================================================
-- HESABU TRIGGER FIX · 2026-07-13
--
-- DEFECT: hesabu_gate_before_signoff trigger (created in 20260711400000)
--   used WHEN (NEW.sign_off_tier = 'preparer') — but statement_sign_offs has
--   no sign_off_tier column. PostgreSQL rejects such triggers at creation time,
--   so the gate was never installed. Sign-offs were ungated.
--
-- FIX:
--   1. Drop the broken trigger.
--   2. Replace hesabu_block_signoff() to guard only the preparer (first) tier
--      by checking NEW.preparer_signed_at IS NOT NULL — a column that EXISTS
--      in statement_sign_offs and IS populated by the application on first sign.
--   3. Recreate the trigger with no WHEN clause so PostgreSQL can install it.
--      The function body guards the tier internally.
-- ============================================================================

-- ── Step 1: Drop broken trigger ───────────────────────────────────────────────
DROP TRIGGER IF EXISTS hesabu_gate_before_signoff ON public.statement_sign_offs;

-- ── Step 2: Replace hesabu_block_signoff() ───────────────────────────────────
--
-- Guards only the preparer (Tier 1) sign-off: fires when preparer_signed_at
-- is being set for the first time (INSERT with preparer_signed_at IS NOT NULL).
-- Reviewer and approver tiers (UPDATE path) are not gated here —
-- if the preparer passed, the gate was already satisfied.
--
-- On INSERT: the application inserts with preparer_signed_at set (Tier 1 sign).
-- On subsequent tiers: the application uses UPDATE, not INSERT — trigger does
-- not fire on UPDATE (BEFORE INSERT only).

CREATE OR REPLACE FUNCTION public.hesabu_block_signoff()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_upload_id  UUID;
  v_pass_count INTEGER;
  v_fail_run   hesabu_validations%ROWTYPE;
BEGIN
  -- Only gate when preparer is signing (first INSERT with preparer_signed_at set).
  -- If this INSERT has no preparer_signed_at, it's a draft creation — allow through.
  IF NEW.preparer_signed_at IS NULL THEN
    RETURN NEW;
  END IF;

  v_upload_id := NEW.upload_id;

  SELECT COUNT(*) INTO v_pass_count
  FROM public.hesabu_validations
  WHERE upload_id = v_upload_id
    AND gate_satisfied = TRUE;

  IF v_pass_count = 0 THEN
    -- Check if a failed run exists (provides a more informative error message)
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

  -- Validation passed — allow sign-off
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.hesabu_block_signoff FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hesabu_block_signoff TO authenticated;

COMMENT ON FUNCTION public.hesabu_block_signoff IS
  'SECURITY DEFINER trigger function. Fires BEFORE INSERT on statement_sign_offs. '
  'Guards the preparer (Tier 1) sign-off by checking NEW.preparer_signed_at IS NOT NULL. '
  'Blocks sign-off unless a passing hesabu_validations row exists for the upload. '
  'Draft inserts (preparer_signed_at NULL) pass through without validation check. '
  'Fixed 2026-07-13: prior version used WHEN (NEW.sign_off_tier = ''preparer'') which '
  'referenced a non-existent column and prevented trigger creation entirely.';

-- ── Step 3: Recreate trigger — no WHEN clause ─────────────────────────────────
CREATE TRIGGER hesabu_gate_before_signoff
  BEFORE INSERT ON public.statement_sign_offs
  FOR EACH ROW
  EXECUTE FUNCTION public.hesabu_block_signoff();

COMMENT ON TRIGGER hesabu_gate_before_signoff ON public.statement_sign_offs IS
  'IRON DOME: Blocks Tier 1 (preparer) sign-off unless hesabu_validations has a '
  'passing row (gate_satisfied=TRUE) for the upload. Reinstalled 2026-07-13 after '
  'fixing broken WHEN clause that referenced non-existent column sign_off_tier.';
