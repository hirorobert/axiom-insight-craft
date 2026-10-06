-- 20261007100000_treatment_authority_and_processing_control.sql
--
-- H1 of the R0 integrity programme (design Amendment 2 + docs/release/R0_CONTRACT_CORRECTIONS.md). Forward-only; PENDING
-- HOSTED APPLICATION (no hosted journal number, hash or applied timestamp is stated anywhere until a hosted read confirms
-- it). S1 (20261006100000) is preserved: its two functions are re-created from their merged text with only the additions
-- marked H1a / H1b below.
--
-- H1a — processing release control (used at the E1 and S2 cut-overs):
--   * engine_runs.engine_generation: a NUMERIC engine generation written by the handler (never a version-string compare);
--     immutable once written (added to the engine_runs lifecycle guard).
--   * processing_release_control: one row — hold, held_at, canary companies, min_engine_generation (only ever rises), version.
--     Changed only by admin_set_processing_control (an active commercial administrator, optimistic version, a reason);
--     every change and every drain is appended to processing_release_control_events.
--   * Enforced in the DATABASE, so preview, live and direct function calls are all covered:
--       - engine_runs INSERT for process-trial-balance: refused while held (PT503 PROCESSING_HELD) unless the company is a
--         canary; refused below the generation floor (PT410 ENGINE_GENERATION_RETIRED) once a floor is set;
--       - trial_balance_uploads processing-field UPDATE (every role, the service role included): refused while held;
--       - tb_certifications INSERT: refused while held, and below the generation floor;
--       - tbu_request_reprocess: a recorded refusal, code PROCESSING_HELD.
--   * admin_drain_processing: once the hold has lasted at least the stated platform wall-clock bound, closes the
--     process-trial-balance runs still marked running that started before the hold (failed, DRAINED_AT_CUTOVER), fails
--     their reserved idempotency keys, and returns their 'validating' uploads to 'processing' (queued). Recorded.
--
-- H1b — CONFIRM_ACCOUNT_TREATMENT (keep the account as mapped, with a recorded reason):
--   * The engine (E1) emits, per flagged account, a treatment request in the upload's server-owned processing_result:
--     rule id and version, company, upload, source file hash, account key and code, debit and credit minor units, and the
--     mapping's review_decision_id. Its request_id is SHA-256 of a canonical text of exactly those fields
--     (public.treatment_request_id; supabase/functions/_shared/treatmentRequest.ts computes the same bytes).
--   * resolve_account_review_batch accepts the action only with treatment = 'keep_as_mapped', a reason of 3–500 characters
--     and a request that exists in THIS upload's current result for THIS account, against the upload's current source
--     hash and the mapping's current review decision, and whose id recomputes exactly. The decision stores the whole
--     request. Nothing in the mapping changes; reclassification stays the ordinary review action.
--   * Scope and expiry: valid only for that upload, source bytes, account facts, mapping decision and rule version; any
--     change produces a different request id, so the decision no longer applies. Nothing carries across periods.
--   * Replay identity: existing actions hash exactly as before (S1 bytes); a treatment confirmation also hashes its request
--     id and treatment (its reason is already part of the base element).
--   * get_confirmed_treatments (service role only): the confirmed request ids whose mapping link is still current.
--
-- Not here: E1's engine changes, S2's attempts/fence, any frontend publication.

-- ── H1a.1 Numeric engine generation ─────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.engine_runs
  ADD COLUMN IF NOT EXISTS engine_generation integer NULL
    CONSTRAINT chk_er_engine_generation_positive CHECK (engine_generation IS NULL OR engine_generation > 0);

CREATE OR REPLACE FUNCTION public.engine_runs_lifecycle_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Iron Dome: engine_runs rows cannot be deleted. [id=%]', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status != 'running' THEN
    RAISE EXCEPTION
      'Iron Dome: engine_runs row already reached a terminal state (%). '
      'No further update is permitted. [id=%]', OLD.status, OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION
      'Iron Dome: the only legal transition from running is to completed or '
      'failed. Attempted: %. [id=%]', NEW.status, OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.company_id       IS DISTINCT FROM OLD.company_id       OR
     NEW.firm_member_id   IS DISTINCT FROM OLD.firm_member_id   OR
     NEW.actor_type       IS DISTINCT FROM OLD.actor_type       OR
     NEW.function_name    IS DISTINCT FROM OLD.function_name    OR
     NEW.engine_version   IS DISTINCT FROM OLD.engine_version   OR
     NEW.engine_generation IS DISTINCT FROM OLD.engine_generation OR
     NEW.rule_version     IS DISTINCT FROM OLD.rule_version     OR
     NEW.request_id       IS DISTINCT FROM OLD.request_id       OR
     NEW.input_hash       IS DISTINCT FROM OLD.input_hash       OR
     NEW.started_at       IS DISTINCT FROM OLD.started_at       OR
     NEW.period_year      IS DISTINCT FROM OLD.period_year      OR
     NEW.source_table     IS DISTINCT FROM OLD.source_table     OR
     NEW.source_record_id IS DISTINCT FROM OLD.source_record_id OR
     NEW.created_at       IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'Iron Dome: only status/completed_at/duration_ms/output_hash/'
      'error_code/error_detail may change on the terminal transition. [id=%]',
      OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;

-- ── H1a.2 Processing release control ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.processing_release_control (
  singleton boolean PRIMARY KEY DEFAULT true CONSTRAINT chk_prc_singleton CHECK (singleton),
  hold boolean NOT NULL DEFAULT false,
  held_at timestamptz,
  canary_company_ids uuid[] NOT NULL DEFAULT '{}',
  min_engine_generation integer CONSTRAINT chk_prc_floor_positive CHECK (min_engine_generation IS NULL OR min_engine_generation > 0),
  reason text,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT chk_prc_held_at CHECK ((hold AND held_at IS NOT NULL) OR (NOT hold AND held_at IS NULL))
);
INSERT INTO public.processing_release_control (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.processing_release_control_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid NOT NULL,
  action text NOT NULL CONSTRAINT chk_prce_action CHECK (action IN ('set', 'drain')),
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  reason text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.processing_release_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processing_release_control_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.processing_release_control, public.processing_release_control_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.processing_release_control, public.processing_release_control_events TO service_role;

-- The control row changes only inside the admin RPC; events are append-only.
CREATE OR REPLACE FUNCTION public.processing_release_control_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'processing_release_control_events' THEN
    RAISE EXCEPTION 'Iron Dome: processing_release_control_events is append-only. % is not permitted.', TG_OP USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' OR TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'Iron Dome: the processing control row is a singleton; % is not permitted.', TG_OP USING ERRCODE = '42501';
  END IF;
  IF coalesce(current_setting('axiom.processing_control_writer', true), '') <> txid_current()::text THEN
    RAISE EXCEPTION 'Iron Dome: processing control changes only through admin_set_processing_control.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_prc_guard ON public.processing_release_control;
CREATE TRIGGER trg_prc_guard BEFORE INSERT OR UPDATE OR DELETE ON public.processing_release_control
  FOR EACH ROW EXECUTE FUNCTION public.processing_release_control_guard();
DROP TRIGGER IF EXISTS trg_prce_append_only ON public.processing_release_control_events;
CREATE TRIGGER trg_prce_append_only BEFORE UPDATE OR DELETE ON public.processing_release_control_events
  FOR EACH ROW EXECUTE FUNCTION public.processing_release_control_guard();

-- May processing write for this company now? Fail closed: a missing control row allows nothing.
CREATE OR REPLACE FUNCTION public.processing_control_allows(p_company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((SELECT NOT c.hold OR (p_company_id IS NOT NULL AND p_company_id = ANY (c.canary_company_ids))
                     FROM public.processing_release_control c WHERE c.singleton), false);
$$;
CREATE OR REPLACE FUNCTION public.processing_control_generation_ok(p_generation integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((SELECT c.min_engine_generation IS NULL OR (p_generation IS NOT NULL AND p_generation >= c.min_engine_generation)
                     FROM public.processing_release_control c WHERE c.singleton), false);
$$;
REVOKE ALL ON FUNCTION public.processing_control_allows(uuid), public.processing_control_generation_ok(integer) FROM PUBLIC, anon, authenticated;

-- Enforcement points (every role; the drain RPC is the one sanctioned bypass, by transaction marker).
CREATE OR REPLACE FUNCTION public.engine_runs_processing_control()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.function_name = 'process-trial-balance' THEN
    IF NOT public.processing_control_allows(NEW.company_id) THEN
      RAISE EXCEPTION 'PROCESSING_HELD' USING ERRCODE = 'PT503', DETAIL = 'process-trial-balance';
    END IF;
    IF NOT public.processing_control_generation_ok(NEW.engine_generation) THEN
      RAISE EXCEPTION 'ENGINE_GENERATION_RETIRED' USING ERRCODE = 'PT410', DETAIL = coalesce(NEW.engine_generation::text, 'none');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_er_processing_control ON public.engine_runs;
CREATE TRIGGER trg_er_processing_control BEFORE INSERT ON public.engine_runs
  FOR EACH ROW EXECUTE FUNCTION public.engine_runs_processing_control();

CREATE OR REPLACE FUNCTION public.trial_balance_upload_processing_control()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF coalesce(current_setting('axiom.processing_control_writer', true), '') = txid_current()::text THEN
    RETURN NEW; -- admin_drain_processing returning a drained upload to the queue
  END IF;
  IF NOT public.processing_control_allows(NEW.company_id) THEN
    RAISE EXCEPTION 'PROCESSING_HELD' USING ERRCODE = 'PT503', DETAIL = 'trial_balance_uploads';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tbu_processing_control ON public.trial_balance_uploads;
CREATE TRIGGER trg_tbu_processing_control
  BEFORE UPDATE OF status, is_valid, processing_result, validation_report, accounting_errors, processed_at, source_file_hash
  ON public.trial_balance_uploads
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.is_valid IS DISTINCT FROM NEW.is_valid
        OR OLD.processing_result IS DISTINCT FROM NEW.processing_result OR OLD.validation_report IS DISTINCT FROM NEW.validation_report
        OR OLD.accounting_errors IS DISTINCT FROM NEW.accounting_errors OR OLD.processed_at IS DISTINCT FROM NEW.processed_at
        OR OLD.source_file_hash IS DISTINCT FROM NEW.source_file_hash)
  EXECUTE FUNCTION public.trial_balance_upload_processing_control();

CREATE OR REPLACE FUNCTION public.tb_certifications_processing_control()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_generation integer;
BEGIN
  IF NOT public.processing_control_allows(NEW.company_id) THEN
    RAISE EXCEPTION 'PROCESSING_HELD' USING ERRCODE = 'PT503', DETAIL = 'tb_certifications';
  END IF;
  SELECT er.engine_generation INTO v_generation FROM public.engine_runs er WHERE er.id = NEW.engine_run_id;
  IF NOT public.processing_control_generation_ok(v_generation) THEN
    RAISE EXCEPTION 'ENGINE_GENERATION_RETIRED' USING ERRCODE = 'PT410', DETAIL = coalesce(v_generation::text, 'none');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tbc_processing_control ON public.tb_certifications;
CREATE TRIGGER trg_tbc_processing_control BEFORE INSERT ON public.tb_certifications
  FOR EACH ROW EXECUTE FUNCTION public.tb_certifications_processing_control();
REVOKE ALL ON FUNCTION public.engine_runs_processing_control(), public.trial_balance_upload_processing_control(),
  public.tb_certifications_processing_control(), public.processing_release_control_guard() FROM PUBLIC, anon, authenticated;

-- Admin control (an active commercial administrator only).
CREATE OR REPLACE FUNCTION public._processing_control_state()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('hold', c.hold, 'held_at', c.held_at, 'canary_company_ids', to_jsonb(c.canary_company_ids),
                            'min_engine_generation', c.min_engine_generation, 'reason', c.reason, 'version', c.version)
    FROM public.processing_release_control c WHERE c.singleton;
$$;
REVOKE ALL ON FUNCTION public._processing_control_state() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_processing_control(
  p_hold boolean, p_canary_company_ids uuid[], p_min_engine_generation integer, p_reason text, p_expected_version bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_old public.processing_release_control%ROWTYPE;
  v_before jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_uid AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_hold IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_old FROM public.processing_release_control c WHERE c.singleton FOR UPDATE;
  IF v_old.version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'CONTROL_VERSION_CONFLICT: current version %', v_old.version USING ERRCODE = '40001';
  END IF;
  IF v_old.min_engine_generation IS NOT NULL
     AND (p_min_engine_generation IS NULL OR p_min_engine_generation < v_old.min_engine_generation) THEN
    RAISE EXCEPTION 'ENGINE_GENERATION_FLOOR_CANNOT_DECREASE' USING ERRCODE = '22023';
  END IF;
  v_before := public._processing_control_state();
  PERFORM set_config('axiom.processing_control_writer', txid_current()::text, true);
  UPDATE public.processing_release_control c
     SET hold = p_hold,
         held_at = CASE WHEN p_hold THEN COALESCE(v_old.held_at, now()) ELSE NULL END,
         canary_company_ids = COALESCE(p_canary_company_ids, '{}'),
         min_engine_generation = p_min_engine_generation,
         reason = btrim(p_reason), changed_by = v_uid, changed_at = now(), version = v_old.version + 1
   WHERE c.singleton;
  PERFORM set_config('axiom.processing_control_writer', '', true);
  INSERT INTO public.processing_release_control_events (actor_user_id, action, before_state, after_state, reason)
  VALUES (v_uid, 'set', v_before, public._processing_control_state(), btrim(p_reason));
  RETURN public._processing_control_state();
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_drain_processing(p_minimum_hold_seconds integer, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_c public.processing_release_control%ROWTYPE;
  v_runs uuid[];
  v_keys integer;
  v_uploads integer;
  v_detail jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_uid AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_minimum_hold_seconds IS NULL OR p_minimum_hold_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'INVALID_DRAIN_BOUND' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_c FROM public.processing_release_control c WHERE c.singleton FOR UPDATE;
  IF NOT v_c.hold THEN RAISE EXCEPTION 'NOT_HELD' USING ERRCODE = '55000'; END IF;
  IF now() < v_c.held_at + make_interval(secs => p_minimum_hold_seconds) THEN
    RAISE EXCEPTION 'DRAIN_TOO_EARLY: the hold must last at least % seconds', p_minimum_hold_seconds USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('axiom.processing_control_writer', txid_current()::text, true);
  -- Runs that started before the hold and are still marked running cannot be alive after the platform bound — in every
  -- company, canaries included (a canary's NEW runs start after the hold and are never touched).
  WITH closed AS (
    UPDATE public.engine_runs er
       SET status = 'failed', completed_at = now(),
           duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - er.started_at)) * 1000)::integer,
           error_code = 'DRAINED_AT_CUTOVER'
     WHERE er.function_name = 'process-trial-balance' AND er.status = 'running' AND er.started_at < v_c.held_at
    RETURNING er.id)
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_runs FROM closed;
  UPDATE public.idempotency_keys k SET status = 'failed', resolved_at = now()
   WHERE k.engine_run_id = ANY (v_runs) AND k.status = 'reserved';
  GET DIAGNOSTICS v_keys = ROW_COUNT;
  -- An upload left 'validating' with no live run for it goes back to the queue; one a live (post-hold canary) run is
  -- processing is left alone.
  UPDATE public.trial_balance_uploads t SET status = 'processing'
   WHERE t.status = 'validating'
     AND NOT EXISTS (SELECT 1 FROM public.engine_runs er
                      WHERE er.function_name = 'process-trial-balance' AND er.status = 'running'
                        AND er.source_record_id = t.id);
  GET DIAGNOSTICS v_uploads = ROW_COUNT;
  PERFORM set_config('axiom.processing_control_writer', '', true);
  v_detail := jsonb_build_object('runs_closed', coalesce(array_length(v_runs, 1), 0), 'run_ids', to_jsonb(v_runs),
                                 'keys_failed', v_keys, 'uploads_requeued', v_uploads, 'minimum_hold_seconds', p_minimum_hold_seconds);
  INSERT INTO public.processing_release_control_events (actor_user_id, action, before_state, after_state, reason, detail)
  VALUES (v_uid, 'drain', public._processing_control_state(), public._processing_control_state(), btrim(p_reason), v_detail);
  RETURN v_detail;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_get_processing_control()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  RETURN public._processing_control_state();
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_processing_control(boolean, uuid[], integer, text, bigint),
  public.admin_drain_processing(integer, text), public.admin_get_processing_control() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_processing_control(boolean, uuid[], integer, text, bigint),
  public.admin_drain_processing(integer, text), public.admin_get_processing_control() TO authenticated;

-- ── H1b.1 The treatment action and its request identity ─────────────────────────────────────────────────────────────
ALTER TABLE public.account_review_decisions DROP CONSTRAINT IF EXISTS account_review_decisions_decision_action_check;
ALTER TABLE public.account_review_decisions ADD CONSTRAINT account_review_decisions_decision_action_check
  CHECK (decision_action IN ('USER_ACCEPTED_SUGGESTION', 'USER_MANUAL_CLASSIFICATION', 'MARK_NON_REPORTING_ACCOUNT', 'CONFIRM_ACCOUNT_TREATMENT'));

-- SHA-256 (hex) of the canonical text of a treatment request. supabase/functions/_shared/treatmentRequest.ts builds the
-- identical text; a missing field contributes an empty segment, so any change of any field changes the id.
-- PL/pgSQL (not SQL): extensions.digest is resolved when called, as in S1's RPCs, so the migration applies wherever
-- pgcrypto lives; the hosted project has it in schema "extensions".
CREATE OR REPLACE FUNCTION public.treatment_request_id(p_req jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN encode(extensions.digest(
    'tb-treatment/1'
    || '|' || coalesce(p_req->>'rule_id', '') || '|' || coalesce(p_req->>'rule_version', '')
    || '|' || coalesce(p_req->>'company_id', '') || '|' || coalesce(p_req->>'upload_id', '')
    || '|' || coalesce(p_req->>'source_file_hash', '') || '|' || coalesce(p_req->>'account_key', '')
    || '|' || coalesce(p_req->>'account_code', '') || '|' || coalesce(p_req->>'debit_minor', '')
    || '|' || coalesce(p_req->>'credit_minor', '') || '|' || coalesce(p_req->>'mapping_decision_id', ''),
    'sha256'), 'hex');
END;
$$;

-- The confirmed treatment requests among p_request_ids whose mapping link is still the one each was bound to.
CREATE OR REPLACE FUNCTION public.get_confirmed_treatments(p_company_id uuid, p_request_ids text[])
RETURNS TABLE (request_id text, decision_id uuid, decided_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT ON (d.new_value->>'request_id') d.new_value->>'request_id', d.id, d.created_at
    FROM public.account_review_decisions d
    JOIN public.account_mappings m
      ON m.company_id = d.company_id AND m.account_key = d.review_account_key
     AND m.review_decision_id::text = d.new_value->'request'->>'mapping_decision_id'
   WHERE d.company_id = p_company_id
     AND d.decision_action = 'CONFIRM_ACCOUNT_TREATMENT'
     AND d.new_value->>'request_id' = ANY (p_request_ids)
   ORDER BY d.new_value->>'request_id', d.sequence_no DESC;
$$;
REVOKE ALL ON FUNCTION public.get_confirmed_treatments(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_confirmed_treatments(uuid, text[]) TO service_role;

-- ── H1b.2 resolve_account_review_batch: S1 (20261006100000) + the treatment confirmation ───────────────────────────

CREATE OR REPLACE FUNCTION public.resolve_account_review_batch(p_company_id uuid, p_upload_id uuid, p_client_request_id uuid, p_decisions jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_user_id            UUID := auth.uid();
  v_firm_member_id     UUID;
  v_role               TEXT;
  v_upload_company_id  UUID;
  v_request_hash       TEXT;
  v_existing_batch      RECORD;
  v_batch_id           UUID;
  v_result             JSONB;
  v_decision           JSONB;
  v_sorted_keys        TEXT[];
  v_key                TEXT;
  v_code               TEXT;
  v_norm_name          TEXT;
  v_review_key         TEXT;
  v_proposal_type      TEXT;
  v_decision_action    TEXT;
  v_previous           JSONB;
  v_statement          TEXT;
  v_classification     TEXT;
  v_content            JSONB;
  v_decision_id        UUID;
  v_mappings_written   INTEGER := 0;
  v_decisions_logged   INTEGER := 0;
  v_non_reporting_count INTEGER := 0;
  v_seen_keys          TEXT[] := ARRAY[]::TEXT[];
  v_upload_result      JSONB;
  v_upload_hash        TEXT;
  v_req                JSONB;
  v_treatments_recorded INTEGER := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  SELECT fm.id, fm.role
    INTO v_firm_member_id, v_role
    FROM public.firm_members fm
   WHERE fm.user_id     = v_user_id
     AND fm.company_id  = p_company_id
     AND fm.accepted_at IS NOT NULL
     AND public.named_user_access_active(fm.company_id, fm.user_id)
   LIMIT 1;

  IF v_firm_member_id IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER_OF_COMPANY' USING ERRCODE = '42501';
  END IF;

  IF NOT public.workspace_capability_allowed(p_company_id, v_user_id, 'prepare_close') THEN
    RAISE EXCEPTION 'CAPABILITY_REQUIRED_FOR_CLASSIFICATION_DECISIONS' USING ERRCODE = '42501';
  END IF;

  -- H1b: the upload's server-owned result and source hash, for treatment confirmations (read without a lock: the review
  -- path takes key locks first; the engine re-validates every treatment against current facts when it uses one).
  SELECT tbu.company_id, tbu.processing_result, tbu.source_file_hash INTO v_upload_company_id, v_upload_result, v_upload_hash
    FROM public.trial_balance_uploads tbu
   WHERE tbu.id = p_upload_id;

  IF v_upload_company_id IS NULL OR v_upload_company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'UPLOAD_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  IF p_decisions IS NULL OR jsonb_array_length(p_decisions) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DECISION_BATCH' USING ERRCODE = '22023';
  END IF;

  -- Replay identity: byte-identical to 20261003100000 (a retry of an earlier request still replays).
  v_request_hash := encode(
    extensions.digest(
      p_company_id::TEXT || '|' || p_upload_id::TEXT || '|' ||
      (
        SELECT string_agg(
                 coalesce(elem->>'account_code','') || '::' ||
                 coalesce(elem->>'account_name','') || '::' ||
                 coalesce(elem->>'proposal_type','NONE') || '::' ||
                 coalesce(elem->>'decision_action','') || '::' ||
                 coalesce(elem->>'statement','') || '::' ||
                 coalesce(elem->>'classification','') || '::' ||
                 coalesce(elem->>'line_item','') || '::' ||
                 coalesce(elem->>'normal_balance','') || '::' ||
                 coalesce(elem->>'reason','') || '::' ||
                 coalesce(elem->>'is_cash_account','~') || '::' ||
                 coalesce(elem->>'is_retained_earnings','~') || '::' ||
                 coalesce(elem->>'is_payroll_account','~') ||
                 CASE WHEN elem->>'decision_action' = 'CONFIRM_ACCOUNT_TREATMENT'
                      THEN '::' || coalesce(elem->>'treatment_request_id','') || '::' || coalesce(elem->>'treatment','')
                      ELSE '' END,
                 '|' ORDER BY
                   coalesce(elem->>'account_code', elem->>'account_name')
               )
          FROM jsonb_array_elements(p_decisions) elem
      ),
      'sha256'
    ),
    'hex'
  );

  SELECT * INTO v_existing_batch
    FROM public.account_review_batches
   WHERE upload_id = p_upload_id
     AND firm_member_id = v_firm_member_id
     AND client_request_id = p_client_request_id
   LIMIT 1;

  IF FOUND THEN
    IF v_existing_batch.request_hash = v_request_hash THEN
      RETURN v_existing_batch.result_summary;
    ELSE
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' USING ERRCODE = '22023';
    END IF;
  END IF;

  FOR v_decision IN SELECT * FROM jsonb_array_elements(p_decisions)
  LOOP
    v_proposal_type := coalesce(v_decision->>'proposal_type', 'NONE');
    IF v_proposal_type = 'AUTO_MAPPED_RULE' THEN
      RAISE EXCEPTION 'AUTO_MAPPED_RULE_NOT_AUTHORIZED_IN_PHASE_2A' USING ERRCODE = '42501';
    END IF;

    v_decision_action := v_decision->>'decision_action';
    IF v_decision_action IS NULL OR v_decision_action NOT IN
       ('USER_ACCEPTED_SUGGESTION', 'USER_MANUAL_CLASSIFICATION', 'MARK_NON_REPORTING_ACCOUNT', 'CONFIRM_ACCOUNT_TREATMENT') THEN
      RAISE EXCEPTION 'INVALID_DECISION_ACTION: %', coalesce(v_decision_action, 'NULL') USING ERRCODE = '22023';
    END IF;

    -- H1b: a treatment confirmation keeps the account as mapped. It names the engine's treatment request and states why.
    IF v_decision_action = 'CONFIRM_ACCOUNT_TREATMENT' THEN
      IF v_decision->>'treatment' IS DISTINCT FROM 'keep_as_mapped' THEN
        RAISE EXCEPTION 'UNSUPPORTED_TREATMENT: %', coalesce(v_decision->>'treatment', 'NULL') USING ERRCODE = '22023';
      END IF;
      IF coalesce(v_decision->>'treatment_request_id', '') !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'TREATMENT_REQUEST_ID_REQUIRED' USING ERRCODE = '22023';
      END IF;
      IF length(btrim(coalesce(v_decision->>'reason', ''))) NOT BETWEEN 3 AND 500 THEN
        RAISE EXCEPTION 'TREATMENT_REASON_REQUIRED' USING ERRCODE = '22023';
      END IF;
    END IF;

    -- S1: only the supported statement/class pairs are accepted. Cash-flow lines are derived, never mapped.
    IF v_decision_action IN ('USER_ACCEPTED_SUGGESTION', 'USER_MANUAL_CLASSIFICATION') THEN
      v_statement := v_decision->>'statement';
      v_classification := v_decision->>'classification';
      IF v_statement = 'cash_flow'
         OR v_classification IN ('operating_activities', 'investing_activities', 'financing_activities') THEN
        RAISE EXCEPTION 'UNSUPPORTED_CASH_FLOW_CLASSIFICATION: %', coalesce(v_classification, v_statement) USING ERRCODE = '22023';
      END IF;
      -- COALESCE: a missing statement or class is a mismatch, never an unknown that slips through.
      IF NOT COALESCE((v_statement = 'balance_sheet' AND v_classification IN
                 ('current_assets', 'non_current_assets', 'current_liabilities', 'non_current_liabilities', 'equity'))
           OR (v_statement = 'income_statement' AND v_classification IN
                 ('revenue', 'cost_of_goods_sold', 'operating_expenses', 'other_income', 'taxes')), false) THEN
        RAISE EXCEPTION 'STATEMENT_CLASSIFICATION_MISMATCH: % / %', coalesce(v_statement, 'NULL'), coalesce(v_classification, 'NULL')
          USING ERRCODE = '22023';
      END IF;
    END IF;

    v_code := NULLIF(trim(coalesce(v_decision->>'account_code', '')), '');
    v_norm_name := lower(trim(regexp_replace(regexp_replace(
                     coalesce(v_decision->>'account_name', ''), '[[:punct:]]', '', 'g'),
                     '\s+', ' ', 'g')));
    v_review_key := COALESCE(v_code, v_norm_name);

    IF v_review_key = '' THEN
      RAISE EXCEPTION 'ACCOUNT_IDENTITY_UNRESOLVABLE' USING ERRCODE = '22023';
    END IF;

    IF v_review_key = ANY(v_seen_keys) THEN
      RAISE EXCEPTION 'DUPLICATE_ACCOUNT_IN_BATCH: %', v_review_key USING ERRCODE = '22023';
    END IF;
    v_seen_keys := v_seen_keys || v_review_key;
  END LOOP;

  SELECT array_agg(DISTINCT k ORDER BY k) INTO v_sorted_keys
    FROM unnest(v_seen_keys) AS k;

  FOREACH v_key IN ARRAY v_sorted_keys LOOP
    PERFORM pg_advisory_xact_lock(hashtext(p_company_id::TEXT), hashtext(v_key));
  END LOOP;

  INSERT INTO public.account_review_batches (
    id, client_request_id, request_hash, company_id, upload_id, firm_member_id, result_summary
  ) VALUES (
    gen_random_uuid(), p_client_request_id, v_request_hash, p_company_id, p_upload_id, v_firm_member_id, '{}'::jsonb
  ) RETURNING id INTO v_batch_id;

  FOR v_decision IN SELECT * FROM jsonb_array_elements(p_decisions)
  LOOP
    v_code := NULLIF(trim(coalesce(v_decision->>'account_code', '')), '');
    v_norm_name := lower(trim(regexp_replace(regexp_replace(
                     coalesce(v_decision->>'account_name', ''), '[[:punct:]]', '', 'g'),
                     '\s+', ' ', 'g')));
    v_review_key := COALESCE(v_code, v_norm_name);
    v_decision_action := v_decision->>'decision_action';
    v_proposal_type := coalesce(v_decision->>'proposal_type', 'NONE');

    SELECT to_jsonb(am.*) INTO v_previous
      FROM public.account_mappings am
     WHERE am.company_id = p_company_id
       AND am.account_key = v_review_key
     LIMIT 1;

    IF v_decision_action IN ('USER_ACCEPTED_SUGGESTION', 'USER_MANUAL_CLASSIFICATION') THEN
      -- The complete content this decision makes current: line_item defaults to the account name; a flag the
      -- decision does not carry keeps the existing mapping's value (NULL when there is none) — as before S1.
      v_content := public.account_mapping_content(
        (v_decision->>'statement')::public.financial_statement,
        (v_decision->>'classification')::public.account_classification,
        coalesce(v_decision->>'line_item', v_decision->>'account_name'),
        v_decision->>'normal_balance',
        CASE WHEN v_decision ? 'is_cash_account' THEN (v_decision->>'is_cash_account')::boolean
             ELSE (v_previous->>'is_cash_account')::boolean END,
        CASE WHEN v_decision ? 'is_retained_earnings' THEN (v_decision->>'is_retained_earnings')::boolean
             ELSE (v_previous->>'is_retained_earnings')::boolean END,
        CASE WHEN v_decision ? 'is_payroll_account' THEN (v_decision->>'is_payroll_account')::boolean
             ELSE (v_previous->>'is_payroll_account')::boolean END);

      INSERT INTO public.account_review_decisions (
        batch_id, company_id, upload_id, firm_member_id,
        account_code, normalized_account_name, review_account_key,
        proposal_type, decision_action, previous_value, new_value, source, reason
      ) VALUES (
        v_batch_id, p_company_id, p_upload_id, v_firm_member_id,
        v_code, v_norm_name, v_review_key,
        v_proposal_type, v_decision_action, v_previous,
        (v_decision - 'mapping') || jsonb_build_object('mapping', v_content),
        v_decision->>'source', v_decision->>'reason'
      ) RETURNING id INTO v_decision_id;

      INSERT INTO public.account_mappings (
        user_id, company_id, account_code, account_name, normalized_account_name,
        statement, classification, line_item, normal_balance,
        is_cash_account, is_retained_earnings, is_payroll_account,
        confidence_source, approved_at, review_decision_id
      ) VALUES (
        v_user_id, p_company_id, v_code, v_decision->>'account_name', v_norm_name,
        (v_content->>'statement')::public.financial_statement,
        (v_content->>'classification')::public.account_classification,
        v_content->>'line_item',
        v_content->>'normal_balance',
        (v_content->>'is_cash_account')::boolean,
        (v_content->>'is_retained_earnings')::boolean,
        (v_content->>'is_payroll_account')::boolean,
        'user_approved', now(), v_decision_id
      )
      ON CONFLICT (company_id, account_key) DO UPDATE SET
        account_code             = EXCLUDED.account_code,
        account_name             = EXCLUDED.account_name,
        normalized_account_name  = EXCLUDED.normalized_account_name,
        statement                = EXCLUDED.statement,
        classification           = EXCLUDED.classification,
        line_item                = EXCLUDED.line_item,
        normal_balance           = EXCLUDED.normal_balance,
        is_cash_account          = EXCLUDED.is_cash_account,
        is_retained_earnings     = EXCLUDED.is_retained_earnings,
        is_payroll_account       = EXCLUDED.is_payroll_account,
        confidence_source        = 'user_approved',
        approved_at              = now(),
        review_decision_id       = EXCLUDED.review_decision_id,
        updated_at               = now();
      v_mappings_written := v_mappings_written + 1;

    ELSIF v_decision_action = 'CONFIRM_ACCOUNT_TREATMENT' THEN
      -- The request must be one the engine emitted for THIS upload's current result, for this account, against this
      -- upload's current source bytes and the mapping's current review decision; its id must recompute exactly.
      SELECT r INTO v_req
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_upload_result->'treatment_requests') = 'array'
                                       THEN v_upload_result->'treatment_requests' ELSE '[]'::jsonb END) r
       WHERE r->>'request_id' = v_decision->>'treatment_request_id'
       LIMIT 1;
      IF v_req IS NULL THEN
        RAISE EXCEPTION 'TREATMENT_REQUEST_NOT_FOUND' USING ERRCODE = '22023';
      END IF;
      IF v_req->>'company_id' IS DISTINCT FROM p_company_id::text OR v_req->>'upload_id' IS DISTINCT FROM p_upload_id::text
         OR v_req->>'source_file_hash' IS DISTINCT FROM v_upload_hash OR v_req->>'account_key' IS DISTINCT FROM v_review_key THEN
        RAISE EXCEPTION 'TREATMENT_REQUEST_MISMATCH' USING ERRCODE = '22023';
      END IF;
      IF public.treatment_request_id(v_req) IS DISTINCT FROM v_req->>'request_id' THEN
        RAISE EXCEPTION 'TREATMENT_REQUEST_INVALID' USING ERRCODE = '22023';
      END IF;
      IF v_previous IS NULL OR (v_previous->>'review_decision_id') IS DISTINCT FROM v_req->>'mapping_decision_id' THEN
        RAISE EXCEPTION 'TREATMENT_MAPPING_CHANGED' USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.account_review_decisions (
        batch_id, company_id, upload_id, firm_member_id,
        account_code, normalized_account_name, review_account_key,
        proposal_type, decision_action, previous_value, new_value, source, reason
      ) VALUES (
        v_batch_id, p_company_id, p_upload_id, v_firm_member_id,
        v_code, v_norm_name, v_review_key,
        v_proposal_type, v_decision_action, v_previous,
        jsonb_build_object('treatment', 'keep_as_mapped', 'reason', btrim(v_decision->>'reason'),
                           'request_id', v_req->>'request_id', 'request', v_req),
        v_decision->>'source', v_decision->>'reason'
      );
      v_treatments_recorded := v_treatments_recorded + 1;

    ELSIF v_decision_action = 'MARK_NON_REPORTING_ACCOUNT' THEN
      DELETE FROM public.account_mappings
       WHERE company_id = p_company_id
         AND account_key = v_review_key;
      v_non_reporting_count := v_non_reporting_count + 1;

      INSERT INTO public.account_review_decisions (
        batch_id, company_id, upload_id, firm_member_id,
        account_code, normalized_account_name, review_account_key,
        proposal_type, decision_action, previous_value, new_value, source, reason
      ) VALUES (
        v_batch_id, p_company_id, p_upload_id, v_firm_member_id,
        v_code, v_norm_name, v_review_key,
        v_proposal_type, v_decision_action, v_previous, NULL,
        v_decision->>'source', v_decision->>'reason'
      );
    END IF;
    v_decisions_logged := v_decisions_logged + 1;
  END LOOP;

  v_result := jsonb_build_object(
    'batch_id', v_batch_id,
    'mappings_written', v_mappings_written,
    'decisions_logged', v_decisions_logged,
    'non_reporting_decisions_recorded', v_non_reporting_count,
    'treatments_recorded', v_treatments_recorded
  );

  UPDATE public.account_review_batches SET result_summary = v_result WHERE id = v_batch_id;

  RETURN v_result;
END;
$function$;



-- ── H1a.3 tbu_request_reprocess: S1 (20261006100000) + a recorded refusal while processing is held ─────────────────

CREATE OR REPLACE FUNCTION public.tbu_request_reprocess(p_upload_id uuid, p_operation_id uuid, p_expected_source_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_hash text;
  v_prior public.tb_reprocess_requests%ROWTYPE;
  v_row public.trial_balance_uploads%ROWTYPE;
  v_member uuid;
  v_basis text;
  v_code text;
  v_cert uuid;
  v_to text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;
  IF p_upload_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST: upload id and operation id are required' USING ERRCODE = '22023';
  END IF;

  -- Same operation id → one decision at a time (taken before the upload lock; nothing else takes this lock).
  PERFORM pg_advisory_xact_lock(hashtext('tbu_request_reprocess'), hashtext(p_operation_id::text));
  v_hash := encode(extensions.digest(p_upload_id::text || '|' || COALESCE(p_expected_source_hash, '') || '|' || v_uid::text, 'sha256'), 'hex');

  SELECT * INTO v_prior FROM public.tb_reprocess_requests r WHERE r.operation_id = p_operation_id;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.request_hash <> v_hash THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'code', 'IDEMPOTENCY_KEY_REUSED', 'upload_id', p_upload_id,
                                'operation_id', p_operation_id, 'invalidated_certification_id', NULL);
    END IF;
    RETURN jsonb_build_object('outcome', CASE WHEN v_prior.outcome = 'accepted' THEN 'replayed' ELSE 'refused' END,
                              'code', v_prior.code, 'upload_id', v_prior.upload_id, 'operation_id', p_operation_id,
                              'invalidated_certification_id', v_prior.invalidated_certification_id, 'replayed', true);
  END IF;

  -- Authorization (read without a lock first: a caller with no authority never holds the upload lock).
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id;
  IF v_row.id IS NULL THEN
    v_code := 'NOT_A_MEMBER_OF_COMPANY';
  ELSIF v_row.company_id IS NOT NULL THEN
    SELECT fm.id INTO v_member FROM public.firm_members fm
     WHERE fm.user_id = v_uid AND fm.company_id = v_row.company_id AND fm.accepted_at IS NOT NULL
       AND public.named_user_access_active(fm.company_id, fm.user_id)
     ORDER BY fm.id LIMIT 1;
    IF v_member IS NULL THEN
      v_code := 'NOT_A_MEMBER_OF_COMPANY';
    ELSIF NOT public.has_workspace_capability(v_row.company_id, v_uid, 'prepare_close') THEN
      v_code := 'CAPABILITY_REQUIRED';
    END IF;
  ELSIF v_row.user_id IS DISTINCT FROM v_uid THEN
    v_code := 'NOT_A_MEMBER_OF_COMPANY';
  END IF;
  IF v_code IS NULL AND COALESCE((public.authorize_trial_balance_processing(v_uid, p_upload_id))->>'allowed', 'false') <> 'true' THEN
    v_code := 'ENTITLEMENT_REQUIRED';
  END IF;
  -- H1a: while processing is held (a release cut-over), a new check is refused and the refusal recorded.
  IF v_code IS NULL AND NOT public.processing_control_allows(v_row.company_id) THEN
    v_code := 'PROCESSING_HELD';
  END IF;

  IF v_code IS NULL THEN
    -- Lifecycle checks under the upload row lock (upload lock only, the global lock order).
    SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id FOR UPDATE;
    IF v_row.id IS NULL OR v_row.lifecycle_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked') THEN
      v_code := 'UPLOAD_NOT_ACTIVE';
    ELSIF NOT public.tbu_upload_source_bound(p_upload_id) THEN
      v_code := 'SOURCE_NOT_BOUND';
    ELSIF v_row.source_file_hash IS NOT NULL AND v_row.source_file_hash IS DISTINCT FROM p_expected_source_hash THEN
      v_code := 'SOURCE_CHANGED';
    ELSIF v_row.status = 'validating'
       OR EXISTS (SELECT 1 FROM public.trial_balance_upload_operations o
                   WHERE o.upload_id = p_upload_id AND o.state IN ('pending', 'purging', 'storage_cleanup_pending')) THEN
      -- A processing worker has claimed the upload, or a discard / sweeper / storage-cleanup claim is held.
      v_code := 'IN_PROGRESS';
    END IF;
  END IF;

  IF v_code IS NOT NULL THEN
    INSERT INTO public.tb_reprocess_requests (operation_id, request_hash, upload_id, company_id, actor_user_id, outcome, code)
    VALUES (p_operation_id, v_hash, p_upload_id, v_row.company_id, v_uid, 'refused', v_code);
    RETURN jsonb_build_object('outcome', 'refused', 'code', v_code, 'upload_id', p_upload_id, 'operation_id', p_operation_id,
                              'invalidated_certification_id', NULL);
  END IF;

  -- Accepted: invalidate the upload's current certification (kept unchanged as history), mark the upload for a new
  -- check, and record it — one transaction.
  SELECT c.id INTO v_cert FROM public.tb_certifications c
   WHERE c.upload_id = p_upload_id ORDER BY c.sequence_no DESC LIMIT 1;
  IF v_cert IS NOT NULL AND EXISTS (SELECT 1 FROM public.tb_certification_invalidations i WHERE i.certification_id = v_cert) THEN
    v_cert := NULL; -- already invalidated by an earlier request
  END IF;
  IF v_cert IS NOT NULL THEN
    INSERT INTO public.tb_certification_invalidations (certification_id, company_id, upload_id, reason, operation_id, actor_user_id)
    SELECT c.id, c.company_id, c.upload_id, 'reprocess_requested', p_operation_id, v_uid FROM public.tb_certifications c WHERE c.id = v_cert;
  END IF;

  v_to := CASE WHEN v_row.lifecycle_state IN ('active_processed', 'blocked') THEN 'active_processing' ELSE v_row.lifecycle_state END;
  PERFORM set_config('axiom.tbu_lifecycle_op', 'reprocess_request', true);
  UPDATE public.trial_balance_uploads t
     SET status = 'processing', is_valid = false,
         lifecycle_state = v_to,
         version = CASE WHEN v_to IS DISTINCT FROM v_row.lifecycle_state THEN t.version + 1 ELSE t.version END
   WHERE t.id = p_upload_id;
  v_basis := CASE WHEN EXISTS (SELECT 1 FROM public.companies c WHERE c.id = v_row.company_id AND c.user_id = v_uid)
                  THEN 'workspace_owner' ELSE 'explicit_capability' END;
  PERFORM public.tbu_log_event(p_upload_id, v_row.company_id, v_row.engagement_id, v_row.period_year,
    v_row.lifecycle_state, v_to, 'user', v_uid, v_member, v_basis, 'prepare_close', 'applied', p_operation_id,
    'Reprocess requested' || CASE WHEN v_cert IS NOT NULL THEN '; certification ' || v_cert::text || ' invalidated' ELSE '' END);
  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);

  INSERT INTO public.tb_reprocess_requests (operation_id, request_hash, upload_id, company_id, actor_user_id, outcome, code, invalidated_certification_id)
  VALUES (p_operation_id, v_hash, p_upload_id, v_row.company_id, v_uid, 'accepted', 'ACCEPTED', v_cert);

  RETURN jsonb_build_object('outcome', 'accepted', 'code', 'ACCEPTED', 'upload_id', p_upload_id, 'operation_id', p_operation_id,
                            'invalidated_certification_id', v_cert);
END;
$$;

