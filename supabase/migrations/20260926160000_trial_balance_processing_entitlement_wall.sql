-- ════════════════════════════════════════════════════════════════════════════
-- Processing an EXISTING trial balance needs a current plan (PR #34 release blocker P-1). Forward-only; builds on
-- 20260925100000–20260925150000 (already applied: this migration never edits them).
--
-- 20260925140000 walls NEW uploads (close_assurance_wall, BEFORE INSERT). Processing an upload that already exists —
-- validating it, hashing its source, recording results — is preparation work too, and was not walled: a no-plan account
-- reached Storage. This migration adds:
--
--   _upload_processing_account(company, uploader)  the account whose plan governs processing: the workspace account,
--                                                   or, for a personal upload (no workspace), its own uploader;
--   authorize_trial_balance_processing(user, upload) the one entitlement answer process-trial-balance asks BEFORE any
--                                                   source binding, Storage access or write (service role only; same
--                                                   shape as _authorize_paid_action: ALLOWED | ENTITLEMENT_REQUIRED |
--                                                   WORKSPACE_ACCESS_DENIED | UNAUTHENTICATED; a missing upload and
--                                                   another person's personal upload answer identically);
--   trg_tbu_processing_wall                          BEFORE UPDATE of the processing columns (status, is_valid,
--                                                   source_file_hash, processing_result, processed_at, accounting_errors,
--                                                   validation_report): refused (PT402, Close Assurance, SOLO) unless the
--                                                   governing account is ENTITLED now — whoever writes (the Edge
--                                                   Function's service role included), under the account's plan lock.
--
-- Fails closed: no account, no licence, an expired, cancelled or suspended licence, or an unknown plan is not ENTITLED.
-- Lifecycle changes (retire, supersede, discard: lifecycle_state and its columns) and every read are unaffected. No
-- existing row is changed: no backfill, no accounting data touched. Idempotent: applying it again changes nothing.
-- One atomic statement (the repository's atomic envelope).
-- ════════════════════════════════════════════════════════════════════════════
--
-- ATOMIC ENVELOPE (security correction B-3): every statement below runs inside this ONE DO statement. Whatever the
-- runner does (statement by statement, whole file, with or without a transaction, continuing after errors) the
-- migration either applies completely or changes nothing.
DO $cfoclose_processing$
BEGIN
  EXECUTE $mprocessingaaa$
DO $refuse$
BEGIN
  IF to_regclass('public.trial_balance_uploads') IS NULL
     OR to_regprocedure('public._authorize_paid_action(uuid, uuid, text)') IS NULL
     OR to_regprocedure('public._resolve_entitlement_for_owner(uuid, text)') IS NULL
     OR to_regprocedure('public._plan_write_lock(uuid)') IS NULL
     OR to_regprocedure('public.close_assurance_wall()') IS NULL THEN
    RAISE EXCEPTION 'processing-wall migration refused: the PR #34 capability and entitlement layer (20260925100000–20260925150000) is not applied. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
END
$refuse$
$mprocessingaaa$;

  EXECUTE $mprocessingaab$
SET search_path TO public, pg_catalog
$mprocessingaab$;

  EXECUTE $mprocessingaac$
CREATE OR REPLACE FUNCTION public._upload_processing_account(p_company_id UUID, p_uploader UUID)
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN p_company_id IS NOT NULL THEN (SELECT c.user_id FROM public.companies c WHERE c.id = p_company_id) ELSE p_uploader END;
$$
$mprocessingaac$;

  EXECUTE $mprocessingaad$
CREATE OR REPLACE FUNCTION public.authorize_trial_balance_processing(p_user UUID, p_upload_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_company  UUID;
  v_uploader UUID;
  v_ent      JSONB;
BEGIN
  IF p_user IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'UNAUTHENTICATED', 'capability', 'CLOSE_ASSURANCE');
  END IF;
  SELECT u.company_id, u.user_id INTO v_company, v_uploader FROM public.trial_balance_uploads u WHERE u.id = p_upload_id;
  IF NOT FOUND OR (v_company IS NULL AND v_uploader IS DISTINCT FROM p_user) THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'WORKSPACE_ACCESS_DENIED', 'capability', 'CLOSE_ASSURANCE');
  END IF;
  IF v_company IS NOT NULL THEN
    RETURN public._authorize_paid_action(p_user, v_company, 'CLOSE_ASSURANCE');
  END IF;
  v_ent := public._resolve_entitlement_for_owner(p_user, 'CLOSE_ASSURANCE');
  IF COALESCE(v_ent->>'status', '') = 'ENTITLED' THEN
    RETURN jsonb_build_object('allowed', true, 'code', 'ALLOWED', 'capability', 'CLOSE_ASSURANCE', 'plan_code', v_ent->>'plan_code');
  END IF;
  RETURN jsonb_build_object('allowed', false, 'code', 'ENTITLEMENT_REQUIRED', 'capability', 'CLOSE_ASSURANCE',
    'plan_code', v_ent->>'plan_code', 'required_plan', 'SOLO', 'reason', v_ent->>'reason');
END;
$$
$mprocessingaad$;

  EXECUTE $mprocessingaae$
CREATE OR REPLACE FUNCTION public.tbu_processing_wall()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_account UUID := public._upload_processing_account(NEW.company_id, NEW.user_id);
BEGIN
  PERFORM public._plan_write_lock(v_account);
  IF v_account IS NULL OR COALESCE((public._resolve_entitlement_for_owner(v_account, 'CLOSE_ASSURANCE'))->>'status', '') <> 'ENTITLED' THEN
    RAISE EXCEPTION 'ENTITLEMENT_REQUIRED' USING ERRCODE = 'PT402', DETAIL = 'CLOSE_ASSURANCE', HINT = 'SOLO';
  END IF;
  RETURN NEW;
END;
$$
$mprocessingaae$;

  EXECUTE $mprocessingaaf$
DROP TRIGGER IF EXISTS trg_tbu_processing_wall ON public.trial_balance_uploads
$mprocessingaaf$;

  EXECUTE $mprocessingaag$
CREATE TRIGGER trg_tbu_processing_wall
  BEFORE UPDATE OF status, is_valid, source_file_hash, processing_result, processed_at, accounting_errors, validation_report
  ON public.trial_balance_uploads FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.is_valid IS DISTINCT FROM NEW.is_valid
        OR OLD.source_file_hash IS DISTINCT FROM NEW.source_file_hash OR OLD.processing_result IS DISTINCT FROM NEW.processing_result
        OR OLD.processed_at IS DISTINCT FROM NEW.processed_at OR OLD.accounting_errors IS DISTINCT FROM NEW.accounting_errors
        OR OLD.validation_report IS DISTINCT FROM NEW.validation_report)
  EXECUTE FUNCTION public.tbu_processing_wall()
$mprocessingaag$;

  EXECUTE $mprocessingaah$
REVOKE ALL ON FUNCTION public._upload_processing_account(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role
$mprocessingaah$;

  EXECUTE $mprocessingaai$
REVOKE ALL ON FUNCTION public.authorize_trial_balance_processing(UUID, UUID) FROM PUBLIC, anon, authenticated
$mprocessingaai$;

  EXECUTE $mprocessingaaj$
GRANT EXECUTE ON FUNCTION public.authorize_trial_balance_processing(UUID, UUID) TO service_role
$mprocessingaaj$;

  EXECUTE $mprocessingaak$
REVOKE ALL ON FUNCTION public.tbu_processing_wall() FROM PUBLIC, anon, authenticated, service_role
$mprocessingaak$;

  EXECUTE $mprocessingaal$
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_tbu_processing_wall' AND tgrelid = 'public.trial_balance_uploads'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'processing-wall postcondition failed: the trigger is missing' USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('anon', 'public.authorize_trial_balance_processing(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.authorize_trial_balance_processing(uuid, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.authorize_trial_balance_processing(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'processing-wall postcondition failed: authorize_trial_balance_processing must be executable by service_role only' USING ERRCODE = '55000';
  END IF;
END
$post$
$mprocessingaal$;
END
$cfoclose_processing$;
