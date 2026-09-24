ALTER TABLE public.engine_runs
  ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT;
ALTER TABLE public.engine_runs DROP CONSTRAINT IF EXISTS chk_er_actor_type;
ALTER TABLE public.engine_runs DROP CONSTRAINT IF EXISTS chk_er_actor_pairing;
ALTER TABLE public.engine_runs
  ADD CONSTRAINT chk_er_actor_type CHECK (actor_type IN ('user', 'workspace_user', 'system')),
  ADD CONSTRAINT chk_er_actor_pairing CHECK (
    (actor_type = 'user'           AND firm_member_id IS NOT NULL AND actor_user_id IS NULL) OR
    (actor_type = 'workspace_user' AND actor_user_id  IS NOT NULL AND firm_member_id IS NULL) OR
    (actor_type = 'system'         AND firm_member_id IS NULL     AND actor_user_id IS NULL));
COMMENT ON COLUMN public.engine_runs.actor_user_id IS
  'actor_type=workspace_user only: the authenticated user (auth.uid()) who ran the engine on the basis of workspace '
  'ownership or an explicit capability grant, with no firm membership. Immutable.';

ALTER TABLE public.idempotency_keys
  ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT;
ALTER TABLE public.idempotency_keys DROP CONSTRAINT IF EXISTS chk_ik_actor_type;
ALTER TABLE public.idempotency_keys DROP CONSTRAINT IF EXISTS chk_ik_actor_pairing;
ALTER TABLE public.idempotency_keys DROP CONSTRAINT IF EXISTS uq_ik_claim;
ALTER TABLE public.idempotency_keys
  ADD CONSTRAINT chk_ik_actor_type CHECK (actor_type IN ('user', 'workspace_user', 'system')),
  ADD CONSTRAINT chk_ik_actor_pairing CHECK (
    (actor_type = 'user'           AND firm_member_id IS NOT NULL AND actor_user_id IS NULL) OR
    (actor_type = 'workspace_user' AND actor_user_id  IS NOT NULL AND firm_member_id IS NULL) OR
    (actor_type = 'system'         AND firm_member_id IS NULL     AND actor_user_id IS NULL)),
  ADD CONSTRAINT uq_ik_claim UNIQUE NULLS NOT DISTINCT (company_id, firm_member_id, actor_user_id, function_name, client_request_id);

CREATE OR REPLACE FUNCTION public.engine_actor_user_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id THEN
    RAISE EXCEPTION 'Iron Dome: %.actor_user_id is immutable. [id=%]', TG_TABLE_NAME, OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_er_actor_user_immutable ON public.engine_runs;
CREATE TRIGGER trg_er_actor_user_immutable BEFORE UPDATE ON public.engine_runs
  FOR EACH ROW EXECUTE FUNCTION public.engine_actor_user_immutable();
DROP TRIGGER IF EXISTS trg_ik_actor_user_immutable ON public.idempotency_keys;
CREATE TRIGGER trg_ik_actor_user_immutable BEFORE UPDATE ON public.idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION public.engine_actor_user_immutable();

CREATE OR REPLACE FUNCTION public.tbu_resolve_processing_actor(p_user_id uuid, p_company_id uuid)
RETURNS TABLE (actor_type text, firm_member_id uuid, firm_member_role text, authority_basis text, authority_capability text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_member uuid;
  v_role text;
  v_basis text;
  v_cap text := 'prepare_trial_balance';
BEGIN
  IF p_user_id IS NULL OR p_company_id IS NULL THEN RETURN; END IF;
  v_basis := public.workspace_authority_basis(p_user_id, p_company_id, 'prepare_trial_balance');
  IF v_basis IS NULL THEN
    v_cap := 'manage_source_files';
    v_basis := public.workspace_authority_basis(p_user_id, p_company_id, 'manage_source_files');
  END IF;
  SELECT fm.id, fm.role::text INTO v_member, v_role FROM public.firm_members fm
   WHERE fm.user_id = p_user_id AND fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL
   ORDER BY fm.id LIMIT 1;

  IF v_member IS NOT NULL THEN
    RETURN QUERY SELECT 'user'::text, v_member, v_role, COALESCE(v_basis, 'firm_membership'),
                        CASE WHEN v_basis = 'explicit_capability' THEN v_cap END;
  ELSIF v_basis IS NOT NULL THEN
    RETURN QUERY SELECT 'workspace_user'::text, NULL::uuid, NULL::text, v_basis,
                        CASE WHEN v_basis = 'explicit_capability' THEN v_cap END;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.tb_certification_drives_upload_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.trial_balance_uploads%ROWTYPE;
  v_target text := CASE WHEN NEW.is_blocking THEN 'blocked' ELSE 'active_processed' END;
  v_member uuid;
  v_member_user uuid;
BEGIN
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = NEW.upload_id FOR UPDATE;
  IF v_row.id IS NULL
     OR v_row.lifecycle_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked')
     OR v_row.lifecycle_state = v_target THEN
    RETURN NULL;
  END IF;

  SELECT er.firm_member_id, COALESCE(er.actor_user_id, fm.user_id) INTO v_member, v_member_user
    FROM public.engine_runs er LEFT JOIN public.firm_members fm ON fm.id = er.firm_member_id
   WHERE er.id = NEW.engine_run_id;

  PERFORM set_config('axiom.tbu_lifecycle_op', 'certification', true);
  UPDATE public.trial_balance_uploads t SET lifecycle_state = v_target, version = t.version + 1 WHERE t.id = v_row.id;
  PERFORM public.tbu_log_event(v_row.id, v_row.company_id, v_row.engagement_id, v_row.period_year,
    v_row.lifecycle_state, v_target, 'engine', v_member_user, v_member, 'engine', NULL, 'applied', NULL,
    'Certification ' || NEW.id::text || ' (is_blocking=' || NEW.is_blocking::text || ', requires_review=' || NEW.requires_review::text || ')');
  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);
  RETURN NULL;
END;
$$;

ALTER TABLE public.trial_balance_source_reservations ADD COLUMN IF NOT EXISTS swept_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_tbsr_unconsumed_expiry
  ON public.trial_balance_source_reservations (expires_at) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tbuo_discard_completed
  ON public.trial_balance_upload_operations (completed_at) WHERE kind = 'discard' AND state = 'completed';
CREATE INDEX IF NOT EXISTS idx_tbuo_cleanup_pending
  ON public.trial_balance_upload_operations (created_at) WHERE kind = 'cancel_replacement' AND state = 'storage_cleanup_pending';

CREATE OR REPLACE FUNCTION public.tbu_reservation_sweep_grace()
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$ SELECT interval '15 minutes' $$;
CREATE OR REPLACE FUNCTION public.tbu_cleanup_sweep_grace()
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$ SELECT interval '5 minutes' $$;

CREATE OR REPLACE FUNCTION public.tbu_sweeper_candidates(p_limit integer DEFAULT 100)
RETURNS TABLE (kind text, target_id uuid, object_path text, delete_object boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH lim AS (SELECT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500) AS n),
  d AS (
    SELECT 'discard'::text AS kind, o.id, o.file_path AS path FROM public.trial_balance_upload_operations o
     WHERE o.kind = 'discard' AND o.state = 'completed' AND o.completed_at <= now() - public.tbu_undo_window()
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
     ORDER BY s.expires_at LIMIT (SELECT n FROM lim))
  SELECT x.kind, x.id, x.path,
         x.path IS NOT NULL AND public.tbu_storage_object_exists(x.path)
           AND NOT EXISTS (SELECT 1 FROM public.trial_balance_uploads t WHERE t.file_path = x.path)
    FROM (SELECT * FROM d UNION ALL SELECT * FROM c UNION ALL SELECT * FROM r) x;
$$;

CREATE OR REPLACE FUNCTION public.tbu_sweeper_complete(p_kind text, p_target_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_op public.trial_balance_upload_operations%ROWTYPE;
  v_res public.trial_balance_source_reservations%ROWTYPE;
BEGIN
  IF p_kind IN ('discard', 'cancel_replacement') THEN
    SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_target_id AND o.kind = p_kind FOR UPDATE;
    IF v_op.id IS NULL THEN RETURN 'stale'; END IF;

    IF p_kind = 'discard' THEN
      IF v_op.state = 'purged' THEN RETURN 'already_done'; END IF;
      IF v_op.state <> 'completed' OR v_op.completed_at > now() - public.tbu_undo_window() THEN RETURN 'not_eligible'; END IF;
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

CREATE TABLE IF NOT EXISTS public.tbu_source_sweeper_tickets (
  token_hash text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz
);
ALTER TABLE public.tbu_source_sweeper_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tbu_source_sweeper_tickets FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.tbu_source_sweeper_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  function_url text NOT NULL CHECK (function_url ~
    '^(https://[A-Za-z0-9.-]+(:[0-9]+)?|http://(localhost|127\.0\.0\.1|kong|host\.docker\.internal)(:[0-9]+)?)/functions/v1/trial-balance-source-sweeper$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tbu_source_sweeper_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tbu_source_sweeper_config FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tbu_configure_source_sweeper(p_function_url text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.tbu_source_sweeper_config (id, function_url, updated_at) VALUES (true, p_function_url, now())
  ON CONFLICT (id) DO UPDATE SET function_url = EXCLUDED.function_url, updated_at = now();
  RETURN 'configured';
EXCEPTION WHEN check_violation OR not_null_violation THEN
  RETURN 'invalid_url';
END;
$$;

CREATE OR REPLACE FUNCTION public.tbu_mint_source_sweeper_ticket()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
BEGIN
  DELETE FROM public.tbu_source_sweeper_tickets WHERE created_at < now() - interval '1 day';
  INSERT INTO public.tbu_source_sweeper_tickets (token_hash, expires_at)
  VALUES (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), now() + interval '5 minutes');
  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.tbu_redeem_source_sweeper_ticket(p_token text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_hit text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
  UPDATE public.tbu_source_sweeper_tickets t SET redeemed_at = now()
   WHERE t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') AND t.redeemed_at IS NULL AND t.expires_at > now()
  RETURNING t.token_hash INTO v_hit;
  RETURN v_hit IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.tbu_run_source_sweeper()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_url text;
  v_token text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tbu_sweeper_candidates(1)) THEN RETURN 'idle'; END IF;
  SELECT c.function_url INTO v_url FROM public.tbu_source_sweeper_config c WHERE c.id;
  IF v_url IS NULL THEN RETURN 'not_configured'; END IF;
  IF to_regproc('net.http_post') IS NULL THEN RETURN 'scheduler_unavailable'; END IF;
  v_token := public.tbu_mint_source_sweeper_ticket();
  EXECUTE 'SELECT net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 60000)'
    USING v_url, jsonb_build_object('ticket', v_token), '{"Content-Type": "application/json"}'::jsonb;
  RETURN 'dispatched';
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net')
     AND EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
    CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     AND COALESCE(current_setting('shared_preload_libraries', true), '') LIKE '%pg_cron%' THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    EXECUTE $q$SELECT cron.schedule('trial-balance-source-sweeper', '*/5 * * * *', 'SELECT public.tbu_run_source_sweeper()')$q$;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.engine_actor_user_immutable() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tbu_resolve_processing_actor(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_reservation_sweep_grace() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_cleanup_sweep_grace() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_sweeper_candidates(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_sweeper_complete(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_configure_source_sweeper(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_mint_source_sweeper_ticket() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_redeem_source_sweeper_ticket(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_run_source_sweeper() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tbu_resolve_processing_actor(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.tbu_sweeper_candidates(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.tbu_sweeper_complete(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.tbu_configure_source_sweeper(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.tbu_mint_source_sweeper_ticket() TO service_role;
GRANT EXECUTE ON FUNCTION public.tbu_redeem_source_sweeper_ticket(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.tbu_run_source_sweeper() TO service_role;