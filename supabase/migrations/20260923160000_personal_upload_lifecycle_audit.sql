-- ════════════════════════════════════════════════════════════════════════════
-- PR #32, part 6: personal (company-less) uploads can be processed again.
--
-- Found by the hosted staging proof of 138fa83 and reproduced on local PostgreSQL: 20260923100000's
-- trg_tbu_lifecycle_audit records every engine-driven lifecycle change (active_unprocessed -> active_processing
-- when processing starts) in trial_balance_upload_lifecycle_events. That table is the WORKSPACE-scoped audit ledger
-- (company_id NOT NULL, read through workspace RLS). A personal upload belongs to no workspace, so the insert failed
-- (23502), the engine's first write failed with it, and process-trial-balance answered 500 for every personal upload.
--
-- Fix: the audit trigger records workspace uploads exactly as before and does not write a workspace event for an
-- upload that has no workspace. Nothing else changes. Personal uploads are never certified, never discarded or
-- replaced through the workspace RPCs, and keep their processing record on the row itself (processed_at,
-- processing_result, source_file_hash). The ledger's NOT NULL and its RLS are untouched.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.trial_balance_upload_lifecycle_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
     AND COALESCE(current_setting('axiom.tbu_lifecycle_op', true), '') = ''
     AND NEW.company_id IS NOT NULL THEN
    PERFORM public.tbu_log_event(NEW.id, NEW.company_id, NEW.engagement_id, NEW.period_year,
      OLD.lifecycle_state, NEW.lifecycle_state, 'engine', auth.uid(), NULL, 'engine', NULL, 'applied', NULL,
      'Processing started (status ' || COALESCE(NEW.status, 'NULL') || ')');
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.trial_balance_upload_lifecycle_audit() FROM PUBLIC, anon, authenticated;

-- ── Rollback (NOT executed; for reference only) ──────────────────────────────────────────────
-- Restore the 20260923100000 body (without the NEW.company_id IS NOT NULL condition). Doing so re-breaks personal
-- upload processing.
