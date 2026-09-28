-- ════════════════════════════════════════════════════════════════════════════
-- Remove a processed trial balance from active use, without a successor. Forward-only; builds on the PR #32 upload
-- lifecycle (20260923100000–20260923170000) and the PR #34 capability layer (20260925100000–20260926160000), all
-- already applied: this migration never edits them.
--
-- The PR #32 lifecycle offered no way to take a PROCESSED upload (active_processing — including a failed run —,
-- active_processed or blocked) out of active use unless a replacement file took its place:
-- discard_trial_balance_upload() refuses anything with processing history ('replacement_required'), and
-- retire_trial_balance_upload() needs a reserved replacement. A Blocked upload could therefore only be replaced,
-- never removed. This migration adds:
--
--   tbu_issued_output_binding(company, period)    internal: why the period's source is bound to issued output
--                                                 ('reporting_pack_issued' | 'final_statements_published'), or NULL;
--   get_trial_balance_removal_eligibility(upload) authenticated, read-only: which removal path the server accepts
--                                                 ('remove' | 'discard' | 'cancel_replacement' | 'issued_output_bound'
--                                                 | 'not_active' | 'forbidden'), so the UI never guesses;
--   remove_trial_balance_upload(upload, version,  authenticated: moves the upload to the existing terminal lifecycle
--                               reason)          state 'retired' (no successor) and writes the lifecycle audit event.
--                                                 Nothing is deleted: the row, its source object, hashes,
--                                                 certifications and every derived record stay exactly as they are.
--
-- Authority is exactly the PR #32 source-file authority (tbu_authorize → workspace_authority_basis: a current plan,
-- and the workspace owner or an active manage_source_files grant). Removal is refused while issued output (a sealed
-- issued Reporting Pack, or a FINAL trial-balance-derived financial statement publication) exists for the period. A retired
-- upload is terminal: the existing lifecycle guard forbids any change out of 'retired', so there is no Undo for this
-- operation (the unprocessed discard keeps its own Undo). The period's active slot and its fiscal_periods pointer are
-- freed by the existing triggers, so a new upload can take the period.
--
-- Serialization with official outputs. Removal, a FINAL publication and a Reporting Pack seal for the same workspace
-- and period take ONE transaction-scoped advisory lock (tb_official_output_lock: company + period) before their
-- authoritative checks and writes, so they cannot interleave:
--   remove_trial_balance_upload()        takes it first, then locks the row and (re-)checks issued output;
--   trg_fsp_source_trial_balance_guard   BEFORE INSERT of a FINAL publication of a TRIAL_BALANCE_DERIVED report;
--   trg_rpi_seal_source_guard            BEFORE the seal (consumed_at set) of a Reporting Pack issuance.
-- After the lock, publication and sealing refuse (PT409) when the period's trial balance was removed from active use
-- (a user-retired upload and no active one; tb_period_source_removed), or when the issuance names an upload that is no
-- longer active. Whichever commits first wins; the other is refused. Nothing already FINAL or sealed is changed, and a
-- period that never had a Prepare Data upload behaves exactly as before. Lock order is always this lock before any
-- row lock taken by removal; publication and sealing take no trial-balance row lock, so no cycle is possible.
--
-- Isolation. The lock only helps if the checks made after it can SEE what committed while the caller waited. Under READ
-- COMMITTED every statement takes a fresh snapshot, so they do. Under REPEATABLE READ or SERIALIZABLE the snapshot is
-- fixed at the transaction's first statement and a waiter would check stale state. tb_require_read_committed() is the
-- ONE rule: tb_official_output_lock() applies it before taking the lock, and removal applies it as its first statement,
-- so all three operations refuse any other isolation level (SQLSTATE PT412, message READ_COMMITTED_REQUIRED) before any
-- authoritative write or audit event. Supabase RPC and PostgREST run READ COMMITTED; nothing changes for them.
--
-- No existing row is changed: no backfill, no accounting data touched. Idempotent: applying it again changes nothing.
-- One atomic statement (the repository's atomic envelope).
-- ════════════════════════════════════════════════════════════════════════════
--
-- ATOMIC ENVELOPE (security correction B-3): every statement below runs inside this ONE DO statement. Whatever the
-- runner does (statement by statement, whole file, with or without a transaction, continuing after errors) the
-- migration either applies completely or changes nothing.
DO $cfoclose_removal$
BEGIN
  EXECUTE $mremovalaaa$
DO $refuse$
BEGIN
  IF to_regclass('public.trial_balance_uploads') IS NULL
     OR to_regclass('public.trial_balance_upload_lifecycle_events') IS NULL
     OR to_regclass('public.reporting_pack_issuances') IS NULL
     OR to_regclass('public.financial_statement_publications') IS NULL
     OR to_regclass('public.financial_statement_reports') IS NULL
     OR to_regprocedure('public.tbu_authorize(uuid)') IS NULL
     OR to_regprocedure('public.tbu_log_event(uuid, uuid, uuid, integer, text, text, text, uuid, uuid, text, text, text, uuid, text)') IS NULL
     OR to_regprocedure('public.workspace_has_current_plan(uuid)') IS NULL
     OR to_regprocedure('public.tbu_processing_wall()') IS NULL THEN
    RAISE EXCEPTION 'remove-from-active-use migration refused: the upload lifecycle (20260923100000–20260923170000) or the PR #34 capability layer (20260925100000–20260926160000) is not applied. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
END
$refuse$
$mremovalaaa$;

  EXECUTE $mremovalaab$
SET search_path TO public, pg_catalog
$mremovalaab$;

  EXECUTE $mremovalaac$
-- THE isolation rule for the trial balance and its official outputs: READ COMMITTED only (see the header).
CREATE OR REPLACE FUNCTION public.tb_require_read_committed()
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'READ_COMMITTED_REQUIRED' USING ERRCODE = 'PT412';
  END IF;
END;
$$
$mremovalaac$;

  EXECUTE $mremovalaad$
-- THE lock for a workspace's trial balance and its official outputs in one reporting period (transaction-scoped).
CREATE OR REPLACE FUNCTION public.tb_official_output_lock(p_company_id UUID, p_period_year INTEGER)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.tb_require_read_committed();
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose.tb_official_output:' || p_company_id::text || ':' || COALESCE(p_period_year::text, 'none'), 0));
END;
$$
$mremovalaad$;

  EXECUTE $mremovalaae$
-- True when the period's trial balance was removed from active use: an upload retired by a person (remove_trial_balance
-- upload; the legacy backfill and an aborted discard never set retired_by) and no upload active for the period.
CREATE OR REPLACE FUNCTION public.tb_period_source_removed(p_company_id UUID, p_period_year INTEGER)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.trial_balance_uploads t
                  WHERE t.company_id = p_company_id AND t.period_year = p_period_year
                    AND t.lifecycle_state = 'retired' AND t.retired_by IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM public.trial_balance_uploads t
                      WHERE t.company_id = p_company_id AND t.period_year = p_period_year
                        AND t.lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked'));
$$
$mremovalaae$;

  EXECUTE $mremovalaaf$
CREATE OR REPLACE FUNCTION public.tbu_issued_output_binding(p_company_id UUID, p_period_year INTEGER)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN p_company_id IS NULL OR p_period_year IS NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.reporting_pack_issuances i
                  WHERE i.company_id = p_company_id AND i.period_year = p_period_year AND i.consumed_at IS NOT NULL) THEN 'reporting_pack_issued'
    WHEN EXISTS (SELECT 1 FROM public.financial_statement_publications p
                   JOIN public.financial_statement_reports r ON r.report_id = p.report_id AND r.report_version = p.report_version
                  WHERE p.company_id = p_company_id AND p.state = 'FINAL'
                    AND r.company_id = p_company_id AND r.period_year = p_period_year
                    AND r.provenance_origin = 'TRIAL_BALANCE_DERIVED') THEN 'final_statements_published'
  END;
$$
$mremovalaaf$;

  EXECUTE $mremovalaag$
CREATE OR REPLACE FUNCTION public.get_trial_balance_removal_eligibility(p_upload_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row   public.trial_balance_uploads%ROWTYPE;
  v_bound TEXT;
BEGIN
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id;
  -- A missing upload and one the caller may not manage answer identically.
  IF v_row.id IS NULL OR v_row.company_id IS NULL OR (SELECT a.basis FROM public.tbu_authorize(v_row.company_id) a) IS NULL THEN
    RETURN jsonb_build_object('outcome', 'forbidden');
  END IF;
  IF v_row.lifecycle_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked') THEN
    RETURN jsonb_build_object('outcome', 'not_active', 'version', v_row.version);
  END IF;
  IF v_row.lifecycle_state = 'active_unprocessed' AND public.tbu_upload_evidence(v_row.id, v_row.replaces_upload_id) IS NULL THEN
    RETURN jsonb_build_object('outcome', CASE WHEN v_row.replaces_upload_id IS NOT NULL THEN 'cancel_replacement' ELSE 'discard' END,
                              'version', v_row.version);
  END IF;
  v_bound := public.tbu_issued_output_binding(v_row.company_id, v_row.period_year);
  IF v_bound IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'issued_output_bound', 'binding', v_bound, 'version', v_row.version);
  END IF;
  RETURN jsonb_build_object('outcome', 'remove', 'version', v_row.version);
END;
$$
$mremovalaag$;

  EXECUTE $mremovalaah$
CREATE OR REPLACE FUNCTION public.remove_trial_balance_upload(p_upload_id UUID, p_expected_version BIGINT, p_reason TEXT DEFAULT NULL)
RETURNS TABLE (outcome TEXT, removed_upload_id UUID, detail TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row    public.trial_balance_uploads%ROWTYPE;
  v_auth   record;
  v_bound  TEXT;
  v_reason TEXT := COALESCE(NULLIF(btrim(p_reason), ''), 'Removed from active use');
BEGIN
  -- Refuse a snapshot isolation level before anything is read, written or audited (the same rule as the lock).
  PERFORM public.tb_require_read_committed();
  -- The workspace and period are immutable binding columns: read them, take the period's official-output lock, and only
  -- then lock the row. Every check below runs after the lock (fresh snapshot per statement), so a FINAL publication or
  -- a seal that committed while this waited is seen and refuses the removal.
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id;
  IF v_row.id IS NOT NULL AND v_row.company_id IS NOT NULL THEN
    PERFORM public.tb_official_output_lock(v_row.company_id, v_row.period_year);
  END IF;
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id FOR UPDATE;
  IF v_row.id IS NULL OR v_row.company_id IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, 'You don''t have permission to manage this workspace''s source files.'::text; RETURN;
  END IF;

  SELECT * INTO v_auth FROM public.tbu_authorize(v_row.company_id);
  IF v_auth.basis IS NULL THEN
    PERFORM public.tbu_log_event(v_row.id, v_row.company_id, v_row.engagement_id, v_row.period_year, v_row.lifecycle_state, NULL,
      'user', auth.uid(), NULL, NULL, 'manage_source_files', 'denied', NULL, 'remove refused: no workspace authority');
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, 'You don''t have permission to manage this workspace''s source files.'::text; RETURN;
  END IF;

  IF v_row.lifecycle_state = 'retired' THEN
    RETURN QUERY SELECT 'already_removed'::text, v_row.id, NULL::text; RETURN;
  END IF;
  IF v_row.lifecycle_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked') THEN
    RETURN QUERY SELECT 'not_active'::text, NULL::uuid, 'This trial balance is no longer active.'::text; RETURN;
  END IF;

  -- An upload with no history keeps its own reversible path (discard with Undo; or cancel, for a replacement).
  IF v_row.lifecycle_state = 'active_unprocessed' AND public.tbu_upload_evidence(v_row.id, v_row.replaces_upload_id) IS NULL THEN
    IF v_row.replaces_upload_id IS NOT NULL THEN
      RETURN QUERY SELECT 'cancel_replacement_required'::text, NULL::uuid,
        'This trial balance replaced an earlier one. Cancel the replacement to restore the earlier trial balance.'::text; RETURN;
    END IF;
    RETURN QUERY SELECT 'discard_required'::text, NULL::uuid, 'This trial balance has not been processed. Discard it instead.'::text; RETURN;
  END IF;

  v_bound := public.tbu_issued_output_binding(v_row.company_id, v_row.period_year);
  IF v_bound IS NOT NULL THEN
    PERFORM public.tbu_log_event(v_row.id, v_row.company_id, v_row.engagement_id, v_row.period_year, v_row.lifecycle_state, NULL,
      'user', auth.uid(), v_auth.membership_id, v_auth.basis, v_auth.capability, 'denied', NULL, 'remove refused: ' || v_bound);
    RETURN QUERY SELECT 'issued_output_bound'::text, NULL::uuid,
      (CASE v_bound
         WHEN 'reporting_pack_issued' THEN 'A Reporting Pack has been issued for this period, so its trial balance stays in use and preserved. Upload a replacement if the figures must change.'
         ELSE 'Final financial statements have been published for this period, so its trial balance stays in use and preserved. Upload a replacement if the figures must change.'
       END)::text; RETURN;
  END IF;

  IF p_expected_version IS NULL OR v_row.version <> p_expected_version THEN
    RETURN QUERY SELECT 'stale_version'::text, NULL::uuid, 'This trial balance changed since you last viewed it. Refresh and try again.'::text; RETURN;
  END IF;

  PERFORM set_config('axiom.tbu_lifecycle_op', 'remove', true);
  UPDATE public.trial_balance_uploads t
     SET lifecycle_state = 'retired', retired_at = now(), retired_by = auth.uid(), retired_by_membership_id = v_auth.membership_id,
         retired_reason = v_reason, version = t.version + 1
   WHERE t.id = v_row.id;
  PERFORM public.tbu_log_event(v_row.id, v_row.company_id, v_row.engagement_id, v_row.period_year, v_row.lifecycle_state, 'retired',
    'user', auth.uid(), v_auth.membership_id, v_auth.basis, v_auth.capability, 'applied', NULL, v_reason);
  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);

  RETURN QUERY SELECT 'removed'::text, v_row.id, NULL::text;
END;
$$
$mremovalaah$;

  EXECUTE $mremovalaai$
-- FINAL publication of a trial-balance-derived report: same lock, then refuse if the period's trial balance was removed.
CREATE OR REPLACE FUNCTION public.fsp_source_trial_balance_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_period INTEGER;
  v_origin TEXT;
BEGIN
  SELECT r.period_year, r.provenance_origin INTO v_period, v_origin
    FROM public.financial_statement_reports r
   WHERE r.report_id = NEW.report_id AND r.report_version = NEW.report_version AND r.company_id = NEW.company_id;
  IF v_origin IS DISTINCT FROM 'TRIAL_BALANCE_DERIVED' THEN RETURN NEW; END IF;
  PERFORM public.tb_official_output_lock(NEW.company_id, v_period);
  IF public.tb_period_source_removed(NEW.company_id, v_period) THEN
    RAISE EXCEPTION 'SOURCE_TRIAL_BALANCE_REMOVED: the trial balance for FY% was removed from active use; upload a trial balance before marking these statements FINAL', v_period
      USING ERRCODE = 'PT409';
  END IF;
  RETURN NEW;
END;
$$
$mremovalaai$;

  EXECUTE $mremovalaaj$
DROP TRIGGER IF EXISTS trg_fsp_source_trial_balance_guard ON public.financial_statement_publications
$mremovalaaj$;

  EXECUTE $mremovalaak$
CREATE TRIGGER trg_fsp_source_trial_balance_guard
  BEFORE INSERT ON public.financial_statement_publications
  FOR EACH ROW WHEN (NEW.state = 'FINAL')
  EXECUTE FUNCTION public.fsp_source_trial_balance_guard()
$mremovalaak$;

  EXECUTE $mremovalaal$
-- Sealing a Reporting Pack: same lock, then refuse a trial-balance-derived output whose source was removed, or an
-- issuance that names an upload no longer active.
CREATE OR REPLACE FUNCTION public.rpi_seal_source_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  m TEXT[];
  v_tb_derived BOOLEAN := false;
BEGIN
  PERFORM public.tb_official_output_lock(NEW.company_id, NEW.period_year);
  m := regexp_match(COALESCE(NEW.output_ref, ''), '^upload:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  IF m IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.trial_balance_uploads t
                    WHERE t.id = m[1]::uuid AND t.company_id = NEW.company_id
                      AND t.lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked')) THEN
      RAISE EXCEPTION 'SOURCE_TRIAL_BALANCE_REMOVED: the trial balance this Reporting Pack names is no longer in active use' USING ERRCODE = 'PT409';
    END IF;
    v_tb_derived := true;
  END IF;
  m := regexp_match(COALESCE(NEW.output_ref, ''), '^fs-report:([A-Za-z0-9_-]{1,120}):v([0-9]{1,6})$');
  IF m IS NOT NULL AND EXISTS (SELECT 1 FROM public.financial_statement_reports r
                                WHERE r.report_id = m[1] AND r.report_version = m[2]::integer AND r.company_id = NEW.company_id
                                  AND r.provenance_origin = 'TRIAL_BALANCE_DERIVED') THEN
    v_tb_derived := true;
  END IF;
  IF v_tb_derived AND public.tb_period_source_removed(NEW.company_id, NEW.period_year) THEN
    RAISE EXCEPTION 'SOURCE_TRIAL_BALANCE_REMOVED: the trial balance for FY% was removed from active use; this Reporting Pack cannot be sealed', NEW.period_year
      USING ERRCODE = 'PT409';
  END IF;
  RETURN NEW;
END;
$$
$mremovalaal$;

  EXECUTE $mremovalaam$
DROP TRIGGER IF EXISTS trg_rpi_seal_source_guard ON public.reporting_pack_issuances
$mremovalaam$;

  EXECUTE $mremovalaan$
CREATE TRIGGER trg_rpi_seal_source_guard
  BEFORE UPDATE OF consumed_at ON public.reporting_pack_issuances
  FOR EACH ROW WHEN (OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL)
  EXECUTE FUNCTION public.rpi_seal_source_guard()
$mremovalaan$;

  EXECUTE $mremovalaao$
REVOKE ALL ON FUNCTION public.tb_require_read_committed() FROM PUBLIC, anon, authenticated, service_role
$mremovalaao$;

  EXECUTE $mremovalaap$
REVOKE ALL ON FUNCTION public.tb_official_output_lock(UUID, INTEGER) FROM PUBLIC, anon, authenticated, service_role
$mremovalaap$;

  EXECUTE $mremovalaaq$
REVOKE ALL ON FUNCTION public.tb_period_source_removed(UUID, INTEGER) FROM PUBLIC, anon, authenticated, service_role
$mremovalaaq$;

  EXECUTE $mremovalaar$
REVOKE ALL ON FUNCTION public.fsp_source_trial_balance_guard() FROM PUBLIC, anon, authenticated, service_role
$mremovalaar$;

  EXECUTE $mremovalaas$
REVOKE ALL ON FUNCTION public.rpi_seal_source_guard() FROM PUBLIC, anon, authenticated, service_role
$mremovalaas$;

  EXECUTE $mremovalaat$
REVOKE ALL ON FUNCTION public.tbu_issued_output_binding(UUID, INTEGER) FROM PUBLIC, anon, authenticated, service_role
$mremovalaat$;

  EXECUTE $mremovalaau$
REVOKE ALL ON FUNCTION public.get_trial_balance_removal_eligibility(UUID) FROM PUBLIC, anon
$mremovalaau$;

  EXECUTE $mremovalaav$
GRANT EXECUTE ON FUNCTION public.get_trial_balance_removal_eligibility(UUID) TO authenticated
$mremovalaav$;

  EXECUTE $mremovalaaw$
REVOKE ALL ON FUNCTION public.remove_trial_balance_upload(UUID, BIGINT, TEXT) FROM PUBLIC, anon
$mremovalaaw$;

  EXECUTE $mremovalaax$
GRANT EXECUTE ON FUNCTION public.remove_trial_balance_upload(UUID, BIGINT, TEXT) TO authenticated
$mremovalaax$;

  EXECUTE $mremovalaay$
DO $post$
BEGIN
  IF has_function_privilege('anon', 'public.remove_trial_balance_upload(uuid, bigint, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_trial_balance_removal_eligibility(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tbu_issued_output_binding(uuid, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.remove_trial_balance_upload(uuid, bigint, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_trial_balance_removal_eligibility(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'remove-from-active-use postcondition failed: unexpected function privileges' USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('authenticated', 'public.tb_require_read_committed()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tb_official_output_lock(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tb_period_source_removed(uuid, integer)', 'EXECUTE')
     OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trg_fsp_source_trial_balance_guard', 'trg_rpi_seal_source_guard')) <> 2 THEN
    RAISE EXCEPTION 'remove-from-active-use postcondition failed: official-output serialization is incomplete' USING ERRCODE = '55000';
  END IF;
END
$post$
$mremovalaay$;
END
$cfoclose_removal$;
