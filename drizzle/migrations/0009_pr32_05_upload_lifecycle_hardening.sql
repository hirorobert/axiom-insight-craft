CREATE OR REPLACE FUNCTION public.trial_balance_upload_history_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_sanctioned boolean := COALESCE(current_setting('axiom.tbu_lifecycle_op', true), '') <> ''
                          AND current_user NOT IN ('anon', 'authenticated');
  v_fk_only boolean;
BEGIN
  IF OLD.lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked') OR v_sanctioned THEN
    RETURN NEW;
  END IF;
  v_fk_only := (to_jsonb(NEW) - ARRAY['company_id', 'period_id', 'period_year', 'fiscal_year_end'])
             = (to_jsonb(OLD) - ARRAY['company_id', 'period_id', 'period_year', 'fiscal_year_end'])
           AND (NEW.company_id IS NOT DISTINCT FROM OLD.company_id OR NEW.company_id IS NULL)
           AND (NEW.period_id IS NOT DISTINCT FROM OLD.period_id OR NEW.period_id IS NULL)
           AND ((NEW.period_year IS NOT DISTINCT FROM OLD.period_year AND NEW.fiscal_year_end IS NOT DISTINCT FROM OLD.fiscal_year_end)
                OR (NEW.period_id IS NULL AND OLD.period_id IS NOT NULL));
  IF v_fk_only THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Iron Dome: trial balance upload % is %; a historical upload cannot be reprocessed or changed.', OLD.id, OLD.lifecycle_state
    USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS trg_tbu_history_immutable ON public.trial_balance_uploads;
CREATE TRIGGER trg_tbu_history_immutable
  BEFORE UPDATE ON public.trial_balance_uploads
  FOR EACH ROW EXECUTE FUNCTION public.trial_balance_upload_history_guard();

CREATE OR REPLACE FUNCTION public.tb_certification_requires_active_upload()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_state text;
BEGIN
  SELECT t.lifecycle_state INTO v_state FROM public.trial_balance_uploads t WHERE t.id = NEW.upload_id;
  IF v_state IS NOT NULL AND v_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked') THEN
    RAISE EXCEPTION 'Iron Dome: upload % is %; a historical upload cannot be certified.', NEW.upload_id, v_state
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tbc_requires_active_upload ON public.tb_certifications;
CREATE TRIGGER trg_tbc_requires_active_upload
  BEFORE INSERT ON public.tb_certifications
  FOR EACH ROW EXECUTE FUNCTION public.tb_certification_requires_active_upload();

CREATE OR REPLACE FUNCTION public.promote_valid_upload_to_active()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'valid' AND NEW.period_id IS NOT NULL
     AND NEW.lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked') THEN
    UPDATE public.fiscal_periods
    SET    active_upload_id = NEW.id,
           updated_at       = now()
    WHERE  id = NEW.period_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fiscal_period_active_upload_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_state text;
BEGIN
  IF NEW.active_upload_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.active_upload_id IS NOT DISTINCT FROM OLD.active_upload_id) THEN
    RETURN NEW;
  END IF;
  SELECT t.lifecycle_state INTO v_state FROM public.trial_balance_uploads t WHERE t.id = NEW.active_upload_id;
  IF v_state IS NULL OR v_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked') THEN
    RAISE EXCEPTION 'Iron Dome: fiscal period % cannot point at upload % (%); only an active upload can be the period''s active upload.',
      NEW.id, NEW.active_upload_id, COALESCE(v_state, 'missing') USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_fp_active_upload_guard ON public.fiscal_periods;
CREATE TRIGGER trg_fp_active_upload_guard
  BEFORE INSERT OR UPDATE OF active_upload_id ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_period_active_upload_guard();

ALTER POLICY "Users can view their own uploads" ON public.trial_balance_uploads
  USING (auth.uid() = user_id AND company_id IS NULL);
ALTER POLICY "Users can update their own uploads" ON public.trial_balance_uploads
  USING (auth.uid() = user_id AND (company_id IS NULL OR EXISTS (SELECT 1 FROM public.companies c WHERE c.id = company_id AND c.user_id = auth.uid())))
  WITH CHECK (auth.uid() = user_id AND (company_id IS NULL OR EXISTS (SELECT 1 FROM public.companies c WHERE c.id = company_id AND c.user_id = auth.uid())));

ALTER TABLE public.trial_balance_upload_operations DROP CONSTRAINT IF EXISTS trial_balance_upload_operations_state_check;
ALTER TABLE public.trial_balance_upload_operations ADD CONSTRAINT trial_balance_upload_operations_state_check
  CHECK (state IN ('pending', 'completed', 'restored', 'aborted', 'purging', 'purged', 'storage_cleanup_pending'));

CREATE OR REPLACE FUNCTION public.tbu_object_referenced(p_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_path IS NOT NULL AND EXISTS (SELECT 1 FROM public.trial_balance_uploads t WHERE t.file_path = p_path);
$$;

CREATE OR REPLACE FUNCTION public.tbu_claim_discard_purge(p_operation_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_op public.trial_balance_upload_operations%ROWTYPE;
BEGIN
  SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_operation_id AND o.kind = 'discard' FOR UPDATE;
  IF v_op.id IS NULL THEN RETURN 'stale_operation'; END IF;
  IF v_op.state = 'purged' THEN RETURN 'already_purged'; END IF;
  IF v_op.state = 'purging' THEN RETURN 'claimed'; END IF;
  IF v_op.state <> 'completed' THEN RETURN 'not_purgeable'; END IF;
  IF v_op.completed_at > now() - public.tbu_undo_window() THEN RETURN 'undo_window_open'; END IF;
  IF public.tbu_object_referenced(v_op.file_path) THEN RETURN 'not_purgeable'; END IF;
  UPDATE public.trial_balance_upload_operations o SET state = 'purging' WHERE o.id = v_op.id;
  RETURN 'claimed';
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_trial_balance_discard_purge(p_operation_id uuid)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_company uuid;
BEGIN
  SELECT o.company_id INTO v_company FROM public.trial_balance_upload_operations o WHERE o.id = p_operation_id AND o.kind = 'discard';
  IF v_company IS NULL THEN RETURN QUERY SELECT 'stale_operation'::text; RETURN; END IF;
  IF (SELECT basis FROM public.tbu_authorize(v_company)) IS NULL THEN RETURN QUERY SELECT 'forbidden'::text; RETURN; END IF;
  RETURN QUERY SELECT public.tbu_claim_discard_purge(p_operation_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_trial_balance_upload(p_operation_id uuid)
RETURNS TABLE (outcome text, upload_id uuid, detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_op public.trial_balance_upload_operations%ROWTYPE;
  v_auth record;
  v_snap jsonb;
  v_existing public.trial_balance_uploads%ROWTYPE;
  v_new public.trial_balance_uploads%ROWTYPE;
  v_constraint text;
BEGIN
  SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_operation_id FOR UPDATE;
  IF v_op.id IS NULL OR v_op.kind <> 'discard' THEN
    RETURN QUERY SELECT 'stale_operation'::text, NULL::uuid, 'This undo no longer refers to a discard.'::text; RETURN;
  END IF;

  SELECT * INTO v_auth FROM public.tbu_authorize(v_op.company_id);
  IF v_auth.basis IS NULL THEN
    PERFORM public.tbu_log_event(v_op.upload_id, v_op.company_id, NULL, v_op.period_year, NULL, NULL,
      'user', auth.uid(), NULL, NULL, 'manage_source_files', 'denied', v_op.id, 'restore refused: no workspace authority');
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, 'You don''t have permission to manage this workspace''s source files.'::text; RETURN;
  END IF;

  v_snap := v_op.row_snapshot;
  SELECT * INTO v_existing FROM public.trial_balance_uploads t WHERE t.id = v_op.upload_id;

  IF v_op.state = 'restored' OR (v_op.state = 'completed' AND v_existing.id IS NOT NULL) THEN
    IF v_existing.id IS NOT NULL
       AND v_existing.company_id IS NOT DISTINCT FROM (v_snap->>'company_id')::uuid
       AND v_existing.file_path IS NOT DISTINCT FROM (v_snap->>'file_path')
       AND v_existing.uploaded_at IS NOT DISTINCT FROM (v_snap->>'uploaded_at')::timestamptz THEN
      IF v_op.state <> 'restored' THEN
        UPDATE public.trial_balance_upload_operations o
           SET state = 'restored', restored_at = now(), restored_by = auth.uid(), restored_by_membership_id = v_auth.membership_id
         WHERE o.id = v_op.id;
      END IF;
      RETURN QUERY SELECT 'already_restored'::text, v_existing.id, NULL::text; RETURN;
    END IF;
    RETURN QUERY SELECT 'terminal_failure'::text, NULL::uuid, 'The restored record no longer matches the discarded trial balance.'::text; RETURN;
  END IF;

  IF v_op.state IN ('purging', 'purged') THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, 'The undo window for this discard has closed.'::text; RETURN;
  END IF;

  IF v_op.state <> 'completed' THEN
    RETURN QUERY SELECT 'stale_operation'::text, NULL::uuid, 'The discard has not finished, so there is nothing to undo yet.'::text; RETURN;
  END IF;

  IF v_op.completed_at <= now() - public.tbu_undo_window() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, 'The undo window for this discard has closed.'::text; RETURN;
  END IF;

  IF v_op.period_year IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.trial_balance_uploads t
        WHERE t.company_id = v_op.company_id AND t.period_year = v_op.period_year
          AND t.lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked')) THEN
    RETURN QUERY SELECT 'conflict_new_active_upload'::text, NULL::uuid,
      'Undo cannot proceed because a new trial balance is now active for this period.'::text; RETURN;
  END IF;

  IF (v_snap->>'file_path') IS NOT NULL AND NOT public.tbu_storage_object_exists(v_snap->>'file_path') THEN
    RETURN QUERY SELECT 'storage_restore_required'::text, NULL::uuid, 'The original file must be put back before the trial balance can be restored.'::text; RETURN;
  END IF;

  PERFORM set_config('axiom.tbu_lifecycle_op', 'restore', true);
  BEGIN
    INSERT INTO public.trial_balance_uploads
    SELECT * FROM jsonb_populate_record(NULL::public.trial_balance_uploads,
      v_snap || jsonb_build_object('lifecycle_state', 'active_unprocessed', 'version', COALESCE((v_snap->>'version')::bigint, 1) + 2))
    RETURNING * INTO v_new;
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      PERFORM set_config('axiom.tbu_lifecycle_op', '', true);
      IF v_constraint = 'uq_one_active_upload_per_period' THEN
        RETURN QUERY SELECT 'conflict_new_active_upload'::text, NULL::uuid,
          'Undo cannot proceed because a new trial balance is now active for this period.'::text; RETURN;
      END IF;
      RETURN QUERY SELECT 'terminal_failure'::text, NULL::uuid, 'The trial balance could not be restored.'::text; RETURN;
    WHEN OTHERS THEN
      PERFORM set_config('axiom.tbu_lifecycle_op', '', true);
      RETURN QUERY SELECT 'terminal_failure'::text, NULL::uuid, 'The trial balance could not be restored (for example, the period is now locked).'::text; RETURN;
  END;
  UPDATE public.trial_balance_upload_operations o
     SET state = 'restored', restored_at = now(), restored_by = auth.uid(), restored_by_membership_id = v_auth.membership_id
   WHERE o.id = v_op.id;
  PERFORM public.tbu_log_event(v_new.id, v_new.company_id, v_new.engagement_id, v_new.period_year, 'discarded', 'active_unprocessed',
    'user', auth.uid(), v_auth.membership_id, v_auth.basis, v_auth.capability, 'applied', v_op.id, 'Discard undone');
  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);

  RETURN QUERY SELECT 'restored'::text, v_new.id, NULL::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_trial_balance_discard(p_operation_id uuid)
RETURNS TABLE (outcome text, detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_op public.trial_balance_upload_operations%ROWTYPE;
  v_auth record;
BEGIN
  SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_operation_id AND o.kind = 'discard' FOR UPDATE;
  IF v_op.id IS NULL THEN
    RETURN QUERY SELECT 'stale_operation'::text, NULL::text; RETURN;
  END IF;
  SELECT * INTO v_auth FROM public.tbu_authorize(v_op.company_id);
  IF v_auth.basis IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::text; RETURN;
  END IF;
  IF v_op.state = 'purged' THEN
    RETURN QUERY SELECT 'already_purged'::text, NULL::text; RETURN;
  END IF;
  IF v_op.state NOT IN ('completed', 'purging') THEN
    RETURN QUERY SELECT 'not_purgeable'::text, 'Only a completed, unrestored discard is purged.'::text; RETURN;
  END IF;
  IF v_op.completed_at > now() - public.tbu_undo_window() THEN
    RETURN QUERY SELECT 'undo_window_open'::text, 'The discard can still be undone.'::text; RETURN;
  END IF;
  IF public.tbu_storage_object_exists(v_op.file_path) THEN
    RETURN QUERY SELECT 'storage_cleanup_pending'::text, 'The discarded file is still in storage.'::text; RETURN;
  END IF;
  UPDATE public.trial_balance_upload_operations o SET state = 'purged' WHERE o.id = v_op.id;
  PERFORM public.tbu_log_event(v_op.upload_id, v_op.company_id, NULL, v_op.period_year, 'discarded', 'discarded',
    'user', auth.uid(), v_auth.membership_id, v_auth.basis, v_auth.capability, 'applied', v_op.id, 'Discarded source purged after the undo window');
  RETURN QUERY SELECT 'purged'::text, NULL::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.tbu_storage_cleanup_target(p_operation_id uuid)
RETURNS TABLE (kind text, state text, company_id uuid, file_path text, deletion_eligible boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT o.kind, o.state, o.company_id, o.file_path,
         (CASE WHEN o.kind = 'cancel_replacement' THEN o.state = 'storage_cleanup_pending'
               ELSE o.state = 'purging' END)
         AND NOT public.tbu_object_referenced(o.file_path)
    FROM public.trial_balance_upload_operations o WHERE o.id = p_operation_id;
$$;

CREATE OR REPLACE FUNCTION public.tbu_abort_discard(p_operation_id uuid, p_actor_kind text, p_actor uuid, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_op public.trial_balance_upload_operations%ROWTYPE;
  v_row public.trial_balance_uploads%ROWTYPE;
  v_target text;
BEGIN
  SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_operation_id AND o.kind = 'discard' FOR UPDATE;
  IF v_op.id IS NULL OR v_op.state <> 'pending' THEN RETURN 'not_eligible'; END IF;
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = v_op.upload_id FOR UPDATE;
  PERFORM set_config('axiom.tbu_lifecycle_op', 'discard_abort', true);
  IF v_row.id IS NOT NULL AND v_row.lifecycle_state = 'discard_pending' THEN
    IF v_row.company_id IS NOT NULL AND v_row.period_year IS NOT NULL AND EXISTS (
         SELECT 1 FROM public.trial_balance_uploads t
          WHERE t.company_id = v_row.company_id AND t.period_year = v_row.period_year AND t.id <> v_row.id
            AND t.lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked')) THEN
      v_target := 'retired';
      UPDATE public.trial_balance_uploads t
         SET lifecycle_state = 'retired', retired_at = now(), version = t.version + 1,
             retired_reason = 'Discard not completed while another trial balance became active for this period; kept as history.'
       WHERE t.id = v_row.id;
    ELSE
      v_target := public.tbu_derived_active_state(v_row);
      UPDATE public.trial_balance_uploads t SET lifecycle_state = v_target, version = t.version + 1 WHERE t.id = v_row.id;
    END IF;
    PERFORM public.tbu_log_event(v_row.id, v_row.company_id, v_row.engagement_id, v_row.period_year, 'discard_pending', v_target,
      p_actor_kind, p_actor, NULL, CASE WHEN p_actor_kind = 'engine' THEN 'engine' ELSE v_op.authority_basis END, NULL,
      'applied', v_op.id, p_reason);
  END IF;
  UPDATE public.trial_balance_upload_operations o SET state = 'aborted', completed_at = now() WHERE o.id = v_op.id;
  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);
  RETURN 'aborted';
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_trial_balance_discard(p_operation_id uuid)
RETURNS TABLE (outcome public.discard_outcome, detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_op public.trial_balance_upload_operations%ROWTYPE;
  v_row public.trial_balance_uploads%ROWTYPE;
  v_auth record;
BEGIN
  SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_operation_id AND o.kind = 'discard' FOR UPDATE;
  IF v_op.id IS NULL THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, 'This discard has already completed or was never started.'::text; RETURN;
  END IF;

  SELECT * INTO v_auth FROM public.tbu_authorize(v_op.company_id);
  IF v_auth.basis IS NULL THEN
    PERFORM public.tbu_log_event(v_op.upload_id, v_op.company_id, NULL, v_op.period_year, 'discard_pending', NULL,
      'user', auth.uid(), NULL, NULL, 'manage_source_files', 'denied', v_op.id, 'discard completion refused: no workspace authority');
    RETURN QUERY SELECT 'forbidden'::public.discard_outcome, 'You don''t have permission to manage this workspace''s source files.'::text; RETURN;
  END IF;

  IF v_op.state = 'aborted' THEN
    RETURN QUERY SELECT 'stale_version'::public.discard_outcome,
      'This discard was not completed in time and was cancelled; the trial balance was kept. Refresh and try again.'::text; RETURN;
  END IF;
  IF v_op.state <> 'pending' THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, NULL::text; RETURN;
  END IF;

  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = v_op.upload_id FOR UPDATE;

  IF v_row.id IS NOT NULL AND public.tbu_upload_evidence(v_row.id) IS NOT NULL THEN
    PERFORM public.tbu_abort_discard(v_op.id, 'user', auth.uid(), 'Discard aborted: evidence appeared during the saga');
    RETURN QUERY SELECT 'replacement_required'::public.discard_outcome,
      'This trial balance acquired processing history during the discard. Upload a replacement instead.'::text; RETURN;
  END IF;

  PERFORM set_config('axiom.tbu_lifecycle_op', 'discard', true);
  IF v_row.id IS NOT NULL THEN
    DELETE FROM public.trial_balance_uploads t WHERE t.id = v_row.id AND t.lifecycle_state = 'discard_pending';
    PERFORM public.tbu_log_event(v_row.id, v_row.company_id, v_row.engagement_id, v_row.period_year, 'discard_pending', 'discarded',
      'user', auth.uid(), v_auth.membership_id, v_auth.basis, v_auth.capability, 'applied', v_op.id, 'Hard discard completed');
  END IF;
  UPDATE public.trial_balance_upload_operations o SET state = 'completed', completed_at = now() WHERE o.id = v_op.id;
  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);

  RETURN QUERY SELECT 'deleted_now'::public.discard_outcome, NULL::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.tbu_stale_discard_grace()
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$ SELECT interval '15 minutes' $$;

CREATE OR REPLACE FUNCTION public.tbu_sweeper_candidates(p_limit integer DEFAULT 100)
RETURNS TABLE (kind text, target_id uuid, object_path text, delete_object boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH lim AS (SELECT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500) AS n),
  d AS (
    SELECT 'discard'::text AS kind, o.id, o.file_path AS path FROM public.trial_balance_upload_operations o
     WHERE o.kind = 'discard' AND o.state IN ('completed', 'purging') AND o.completed_at <= now() - public.tbu_undo_window()
     ORDER BY o.completed_at LIMIT (SELECT n FROM lim)),
  c AS (
    SELECT 'cancel_replacement'::text, o.id, o.file_path FROM public.trial_balance_upload_operations o
     WHERE o.kind = 'cancel_replacement' AND o.state = 'storage_cleanup_pending'
       AND o.created_at <= now() - public.tbu_cleanup_sweep_grace()
     ORDER BY o.created_at LIMIT (SELECT n FROM lim)),
  r AS (
    SELECT 'reservation'::text, s.id, s.object_path FROM public.trial_balance_source_reservations s
     WHERE s.consumed_at IS NULL AND s.expires_at <= now() - public.tbu_reservation_sweep_grace()
       AND (s.swept_at IS NULL
            OR (s.expires_at > now() - interval '1 day' AND public.tbu_storage_object_exists(s.object_path)))
     ORDER BY s.expires_at LIMIT (SELECT n FROM lim)),
  p AS (
    SELECT 'stale_discard'::text, o.id, NULL::text FROM public.trial_balance_upload_operations o
     WHERE o.kind = 'discard' AND o.state = 'pending' AND o.created_at <= now() - public.tbu_stale_discard_grace()
     ORDER BY o.created_at LIMIT (SELECT n FROM lim))
  SELECT x.kind, x.id, x.path,
         x.path IS NOT NULL AND public.tbu_storage_object_exists(x.path) AND NOT public.tbu_object_referenced(x.path)
    FROM (SELECT * FROM d UNION ALL SELECT * FROM c UNION ALL SELECT * FROM r UNION ALL SELECT * FROM p) x;
$$;

CREATE OR REPLACE FUNCTION public.tbu_sweeper_claim(p_kind text, p_target_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_path text;
BEGIN
  IF p_kind = 'discard' THEN
    RETURN CASE WHEN public.tbu_claim_discard_purge(p_target_id) = 'claimed' THEN 'claimed' ELSE 'not_eligible' END;
  ELSIF p_kind = 'cancel_replacement' THEN
    SELECT o.file_path INTO v_path FROM public.trial_balance_upload_operations o
     WHERE o.id = p_target_id AND o.kind = 'cancel_replacement' AND o.state = 'storage_cleanup_pending' FOR UPDATE;
    RETURN CASE WHEN v_path IS NOT NULL AND NOT public.tbu_object_referenced(v_path) THEN 'claimed' ELSE 'not_eligible' END;
  ELSIF p_kind = 'reservation' THEN
    SELECT s.object_path INTO v_path FROM public.trial_balance_source_reservations s
     WHERE s.id = p_target_id AND s.consumed_at IS NULL AND s.expires_at <= now() - public.tbu_reservation_sweep_grace() FOR UPDATE;
    RETURN CASE WHEN v_path IS NOT NULL AND NOT public.tbu_object_referenced(v_path) THEN 'claimed' ELSE 'not_eligible' END;
  END IF;
  RETURN 'not_eligible';
END;
$$;

CREATE OR REPLACE FUNCTION public.tbu_sweeper_complete(p_kind text, p_target_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_op public.trial_balance_upload_operations%ROWTYPE;
  v_res public.trial_balance_source_reservations%ROWTYPE;
BEGIN
  IF p_kind = 'stale_discard' THEN
    SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_target_id AND o.kind = 'discard' FOR UPDATE;
    IF v_op.id IS NULL THEN RETURN 'stale'; END IF;
    IF v_op.state <> 'pending' OR v_op.created_at > now() - public.tbu_stale_discard_grace() THEN RETURN 'not_eligible'; END IF;
    RETURN public.tbu_abort_discard(v_op.id, 'engine', NULL, 'Discard never completed; resolved by the scheduled source sweeper');
  END IF;

  IF p_kind IN ('discard', 'cancel_replacement') THEN
    SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_target_id AND o.kind = p_kind FOR UPDATE;
    IF v_op.id IS NULL THEN RETURN 'stale'; END IF;

    IF p_kind = 'discard' THEN
      IF v_op.state = 'purged' THEN RETURN 'already_done'; END IF;
      IF v_op.state NOT IN ('completed', 'purging') OR v_op.completed_at > now() - public.tbu_undo_window() THEN RETURN 'not_eligible'; END IF;
      IF public.tbu_storage_object_exists(v_op.file_path) THEN RETURN 'storage_cleanup_pending'; END IF;
      UPDATE public.trial_balance_upload_operations o SET state = 'purged' WHERE o.id = v_op.id;
      PERFORM public.tbu_log_event(v_op.upload_id, v_op.company_id, NULL, v_op.period_year, 'discarded', 'discarded',
        'engine', NULL, NULL, 'engine', NULL, 'applied', v_op.id, 'Discarded source purged by the scheduled source sweeper after the undo window');
      RETURN 'purged';
    END IF;

    IF v_op.state = 'completed' THEN RETURN 'already_done'; END IF;
    IF v_op.state <> 'storage_cleanup_pending' THEN RETURN 'not_eligible'; END IF;
    IF public.tbu_storage_object_exists(v_op.file_path) THEN RETURN 'storage_cleanup_pending'; END IF;
    UPDATE public.trial_balance_upload_operations o SET state = 'completed', completed_at = now() WHERE o.id = v_op.id;
    RETURN 'completed';
  END IF;

  IF p_kind = 'reservation' THEN
    SELECT * INTO v_res FROM public.trial_balance_source_reservations s WHERE s.id = p_target_id FOR UPDATE;
    IF v_res.id IS NULL THEN RETURN 'stale'; END IF;
    IF v_res.consumed_at IS NOT NULL OR v_res.expires_at > now() - public.tbu_reservation_sweep_grace() THEN RETURN 'not_eligible'; END IF;
    IF public.tbu_storage_object_exists(v_res.object_path) THEN RETURN 'storage_cleanup_pending'; END IF;
    UPDATE public.trial_balance_source_reservations s SET swept_at = now() WHERE s.id = v_res.id;
    RETURN 'reclaimed';
  END IF;

  RETURN 'invalid_request';
END;
$$;

REVOKE ALL ON FUNCTION public.trial_balance_upload_history_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tb_certification_requires_active_upload() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fiscal_period_active_upload_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_object_referenced(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_claim_discard_purge(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_abort_discard(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_stale_discard_grace() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_sweeper_claim(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_trial_balance_discard_purge(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_trial_balance_discard_purge(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tbu_sweeper_claim(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.tbu_object_referenced(text) TO service_role;