-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- I1-B: one file, two years — atomic registration of a current-year and a prior-year trial balance from the same
-- uploaded file, as two independent datasets that share one safely managed source object.
--
--   1. tb_source_objects — one row per shared Storage object (created only by register_two_period_uploads). Never
--      deleted; its state moves active → purge_pending → purged only through the scheduled source sweeper.
--   2. trial_balance_uploads.source_object_id — server-set only, immutable, and only to an ACTIVE object of the same
--      workspace whose path is the row's file_path. Existing uploads are NOT backfilled: they are immutable history and
--      stay bound by their reservation exactly as before; single-file registration and replacement are unchanged.
--   3. register_two_period_uploads — one transaction or nothing: the object, both uploads, the reservation's consumption,
--      the registration record and both lifecycle events. Idempotent per (reservation, request). The periods must belong
--      to the reservation's workspace and be adjacent; each year's active slot must be free.
--   4. tbu_source_path_bound — an upload is also bound through its source object, so BOTH years hold the file:
--      tbu_object_referenced / tbu_bound_storage_path (unchanged) then keep the object while either year references it.
--   5. Sweeper kind 'source_object' — when both years were discarded together (each discard saw the other still bound,
--      so neither discard owns the path), the object is purged exactly once after the last reference and every undo
--      window has ended. The trial-balance-source-sweeper handles the kind generically (no function change).
--   6. purge_trial_balance_discard answers 'source_shared' when the discarded year's file is kept for the other year.
--
-- PREFLIGHT: none of the new objects exist yet; the migration refuses if they do.
-- Release order: trial-balance-storage-cleanup (maps 'source_shared') → this migration → frontend.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
BEGIN
  IF to_regclass('public.tb_source_objects') IS NOT NULL OR to_regclass('public.tb_two_period_registrations') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'trial_balance_uploads' AND column_name = 'source_object_id') THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: shared-source objects already exist; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. Source objects ────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.tb_source_objects (
  id               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id       UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  reservation_id   UUID        NOT NULL UNIQUE REFERENCES public.trial_balance_source_reservations (id) ON DELETE RESTRICT,
  storage_path     TEXT        NOT NULL UNIQUE,
  state            TEXT        NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'purge_pending', 'purged')),
  created_by       UUID        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_claimed_at TIMESTAMPTZ NULL,
  purged_at        TIMESTAMPTZ NULL,
  CONSTRAINT chk_tbso_path_shape CHECK (storage_path LIKE 'workspaces/' || company_id::text || '/%'),
  CONSTRAINT chk_tbso_purged CHECK ((state = 'purged') = (purged_at IS NOT NULL))
);
CREATE INDEX idx_tbso_company ON public.tb_source_objects (company_id, created_at);

-- Identity never changes; the state only moves forward (a claim may be released back to active); nothing is deleted.
CREATE OR REPLACE FUNCTION public.tb_source_objects_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'SOURCE_OBJECT_APPEND_ONLY: a source object is never deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'SOURCE_OBJECT_IMMUTABLE: a source object''s identity never changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'purged' OR (OLD.state <> NEW.state AND NOT (
       (OLD.state = 'active' AND NEW.state IN ('purge_pending', 'purged'))
       OR (OLD.state = 'purge_pending' AND NEW.state IN ('active', 'purged')))) THEN
    RAISE EXCEPTION 'SOURCE_OBJECT_STATE: % → % is not allowed', OLD.state, NEW.state USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_tbso_guard BEFORE UPDATE OR DELETE ON public.tb_source_objects
  FOR EACH ROW EXECUTE FUNCTION public.tb_source_objects_guard();
CREATE TRIGGER trg_tbso_no_truncate BEFORE TRUNCATE ON public.tb_source_objects
  FOR EACH STATEMENT EXECUTE FUNCTION public.tb_source_objects_guard();

-- ── 2. The upload's reference ────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.trial_balance_uploads
  ADD COLUMN source_object_id UUID NULL REFERENCES public.tb_source_objects (id) ON DELETE RESTRICT;
CREATE INDEX idx_tbu_source_object ON public.trial_balance_uploads (source_object_id) WHERE source_object_id IS NOT NULL;

-- SECURITY INVOKER on purpose: current_user is the caller's role, so a client role (anon/authenticated/service_role)
-- can never link an upload to a shared source; only the server's SECURITY DEFINER writers can.
CREATE OR REPLACE FUNCTION public.tbu_source_object_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_obj public.tb_source_objects%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.source_object_id IS DISTINCT FROM OLD.source_object_id THEN
      RAISE EXCEPTION 'SOURCE_OBJECT_REFERENCE_IMMUTABLE: an upload''s source object never changes' USING ERRCODE = '42501';
    END IF;
    IF NEW.source_object_id IS NOT NULL AND NEW.file_path IS DISTINCT FROM OLD.file_path THEN
      RAISE EXCEPTION 'SOURCE_OBJECT_REFERENCE_IMMUTABLE: a shared source''s path never changes' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_object_id IS NULL THEN RETURN NEW; END IF;
  IF current_user IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'SOURCE_OBJECT_SERVER_ONLY: only the server links an upload to a shared source' USING ERRCODE = '42501';
  END IF;
  -- Locks the object against a concurrent purge claim (the claim takes FOR UPDATE).
  SELECT * INTO v_obj FROM public.tb_source_objects o WHERE o.id = NEW.source_object_id FOR SHARE;
  IF v_obj.id IS NULL OR v_obj.state <> 'active' OR v_obj.company_id IS DISTINCT FROM NEW.company_id
     OR v_obj.storage_path IS DISTINCT FROM NEW.file_path THEN
    RAISE EXCEPTION 'SOURCE_OBJECT_UNAVAILABLE: the shared source is not an active object of this workspace at this path'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_tbu_source_object_guard BEFORE INSERT OR UPDATE ON public.trial_balance_uploads
  FOR EACH ROW EXECUTE FUNCTION public.tbu_source_object_guard();

-- ── 3. Registration records (idempotency) ────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.tb_two_period_registrations (
  id                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  reservation_id    UUID        NOT NULL UNIQUE REFERENCES public.trial_balance_source_reservations (id) ON DELETE RESTRICT,
  request_id        UUID        NOT NULL,
  company_id        UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  actor_user_id     UUID        NOT NULL,
  source_object_id  UUID        NOT NULL UNIQUE REFERENCES public.tb_source_objects (id) ON DELETE RESTRICT,
  current_upload_id UUID        NOT NULL,
  prior_upload_id   UUID        NOT NULL,
  current_period_id UUID        NOT NULL,
  prior_period_id   UUID        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_tbtpr_distinct CHECK (current_upload_id <> prior_upload_id AND current_period_id <> prior_period_id)
);
CREATE OR REPLACE FUNCTION public.tb_two_period_registrations_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'TWO_PERIOD_REGISTRATION_APPEND_ONLY' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER trg_tbtpr_append_only BEFORE UPDATE OR DELETE ON public.tb_two_period_registrations
  FOR EACH ROW EXECUTE FUNCTION public.tb_two_period_registrations_guard();
CREATE TRIGGER trg_tbtpr_no_truncate BEFORE TRUNCATE ON public.tb_two_period_registrations
  FOR EACH STATEMENT EXECUTE FUNCTION public.tb_two_period_registrations_guard();

ALTER TABLE public.tb_source_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tb_two_period_registrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tb_source_objects, public.tb_two_period_registrations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.tb_source_objects, public.tb_two_period_registrations TO authenticated, service_role;
CREATE POLICY tbso_workspace_read ON public.tb_source_objects FOR SELECT TO authenticated
  USING (public.can_access_workspace(company_id));
CREATE POLICY tbtpr_workspace_read ON public.tb_two_period_registrations FOR SELECT TO authenticated
  USING (public.can_access_workspace(company_id));

-- ── 4. Atomic two-year registration ──────────────────────────────────────────────────────────────────────────────────
-- Outcomes: registered | already_registered | invalid_request | stale_reservation | forbidden | expired |
--           object_missing | invalid_period | periods_not_adjacent | active_upload_exists | rejected.
-- 'registered' is also the answer to a retry of the same (reservation, request): the same pair, nothing new.
CREATE OR REPLACE FUNCTION public.register_two_period_uploads(
  p_reservation_id uuid, p_request_id uuid, p_file_size integer,
  p_current_period_id uuid, p_prior_period_id uuid,
  p_current_engagement_id uuid DEFAULT NULL, p_prior_engagement_id uuid DEFAULT NULL)
RETURNS TABLE (outcome text, current_upload_id uuid, prior_upload_id uuid, source_object_id uuid, detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_res public.trial_balance_source_reservations%ROWTYPE;
  v_reg public.tb_two_period_registrations%ROWTYPE;
  v_auth record;
  v_cur public.fiscal_periods%ROWTYPE;
  v_pri public.fiscal_periods%ROWTYPE;
  v_cur_year integer;
  v_pri_year integer;
  v_company_name text;
  v_obj uuid;
  v_cur_id uuid;
  v_pri_id uuid;
  v_constraint text;
BEGIN
  IF p_reservation_id IS NULL OR p_request_id IS NULL OR p_file_size IS NULL OR p_file_size < 0
     OR p_current_period_id IS NULL OR p_prior_period_id IS NULL OR p_current_period_id = p_prior_period_id THEN
    RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text; RETURN;
  END IF;
  SELECT * INTO v_res FROM public.trial_balance_source_reservations r WHERE r.id = p_reservation_id FOR UPDATE;
  IF v_res.id IS NULL THEN
    RETURN QUERY SELECT 'stale_reservation'::text, NULL::uuid, NULL::uuid, NULL::uuid, 'This upload reservation does not exist.'::text; RETURN;
  END IF;
  SELECT * INTO v_auth FROM public.tbu_authorize(v_res.company_id);
  IF v_res.actor_user_id <> auth.uid() OR v_auth.basis IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::uuid, NULL::uuid,
      'You don''t have permission to manage this workspace''s source files.'::text; RETURN;
  END IF;
  IF v_res.consumed_at IS NOT NULL THEN
    SELECT * INTO v_reg FROM public.tb_two_period_registrations g WHERE g.reservation_id = v_res.id;
    IF v_reg.id IS NOT NULL AND v_reg.request_id = p_request_id THEN
      RETURN QUERY SELECT 'registered'::text, v_reg.current_upload_id, v_reg.prior_upload_id, v_reg.source_object_id, 'replay'::text; RETURN;
    END IF;
    RETURN QUERY SELECT 'already_registered'::text, COALESCE(v_reg.current_upload_id, v_res.consumed_by_upload_id),
      v_reg.prior_upload_id, v_reg.source_object_id, 'This file was already registered.'::text; RETURN;
  END IF;
  IF v_res.expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::uuid, NULL::uuid, 'The upload reservation expired. Start the upload again.'::text; RETURN;
  END IF;
  IF NOT public.tbu_storage_object_exists(v_res.object_path) THEN
    RETURN QUERY SELECT 'object_missing'::text, NULL::uuid, NULL::uuid, NULL::uuid, 'The file has not reached storage yet.'::text; RETURN;
  END IF;

  SELECT * INTO v_cur FROM public.fiscal_periods p WHERE p.id = p_current_period_id AND p.company_id = v_res.company_id;
  SELECT * INTO v_pri FROM public.fiscal_periods p WHERE p.id = p_prior_period_id AND p.company_id = v_res.company_id;
  IF v_cur.id IS NULL OR v_pri.id IS NULL THEN
    RETURN QUERY SELECT 'invalid_period'::text, NULL::uuid, NULL::uuid, NULL::uuid,
      'Both reporting periods must belong to this workspace.'::text; RETURN;
  END IF;
  v_cur_year := EXTRACT(YEAR FROM COALESCE(v_cur.reporting_end, v_cur.fiscal_year_end))::integer;
  v_pri_year := EXTRACT(YEAR FROM COALESCE(v_pri.reporting_end, v_pri.fiscal_year_end))::integer;
  -- Adjacent: dated periods meet exactly (prior ends the day before current starts); otherwise consecutive years.
  IF (v_cur.reporting_start IS NOT NULL AND v_pri.reporting_end IS NOT NULL
      AND v_pri.reporting_end <> v_cur.reporting_start - 1)
     OR ((v_cur.reporting_start IS NULL OR v_pri.reporting_end IS NULL) AND v_pri_year <> v_cur_year - 1) THEN
    RETURN QUERY SELECT 'periods_not_adjacent'::text, NULL::uuid, NULL::uuid, NULL::uuid,
      'The prior period must end immediately before the current period starts.'::text; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.trial_balance_uploads t
              WHERE t.company_id = v_res.company_id AND t.period_year IN (v_cur_year, v_pri_year)
                AND t.lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked')) THEN
    RETURN QUERY SELECT 'active_upload_exists'::text, NULL::uuid, NULL::uuid, NULL::uuid,
      'A trial balance is already active for one of these periods. Use Replace trial balance to swap it.'::text; RETURN;
  END IF;

  SELECT c.name INTO v_company_name FROM public.companies c WHERE c.id = v_res.company_id;
  -- One subtransaction: any failure undoes every write below; the reservation stays usable.
  BEGIN
    INSERT INTO public.tb_source_objects (company_id, reservation_id, storage_path, created_by)
    VALUES (v_res.company_id, v_res.id, v_res.object_path, auth.uid()) RETURNING id INTO v_obj;
    INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, user_id, company_id, company_name, period_year, period_id, engagement_id, source_object_id)
    VALUES (v_res.file_name, v_res.object_path, p_file_size, 'processing', auth.uid(), v_res.company_id, v_company_name, v_cur_year, v_cur.id, p_current_engagement_id, v_obj)
    RETURNING id INTO v_cur_id;
    INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, user_id, company_id, company_name, period_year, period_id, engagement_id, source_object_id)
    VALUES (v_res.file_name, v_res.object_path, p_file_size, 'processing', auth.uid(), v_res.company_id, v_company_name, v_pri_year, v_pri.id, p_prior_engagement_id, v_obj)
    RETURNING id INTO v_pri_id;
    UPDATE public.trial_balance_source_reservations r SET consumed_at = now(), consumed_by_upload_id = v_cur_id WHERE r.id = v_res.id;
    INSERT INTO public.tb_two_period_registrations (reservation_id, request_id, company_id, actor_user_id, source_object_id,
      current_upload_id, prior_upload_id, current_period_id, prior_period_id)
    VALUES (v_res.id, p_request_id, v_res.company_id, auth.uid(), v_obj, v_cur_id, v_pri_id, v_cur.id, v_pri.id);
    PERFORM public.tbu_log_event(v_cur_id, v_res.company_id, p_current_engagement_id, v_cur_year, NULL, 'active_unprocessed',
      'user', auth.uid(), v_auth.membership_id, v_auth.basis, v_auth.capability, 'applied', NULL, 'Source uploaded (two-year file: current year)');
    PERFORM public.tbu_log_event(v_pri_id, v_res.company_id, p_prior_engagement_id, v_pri_year, NULL, 'active_unprocessed',
      'user', auth.uid(), v_auth.membership_id, v_auth.basis, v_auth.capability, 'applied', NULL, 'Source uploaded (two-year file: prior year)');
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'uq_one_active_upload_per_period' THEN
        RETURN QUERY SELECT 'active_upload_exists'::text, NULL::uuid, NULL::uuid, NULL::uuid,
          'A trial balance is already active for one of these periods. Use Replace trial balance to swap it.'::text; RETURN;
      END IF;
      RETURN QUERY SELECT 'rejected'::text, NULL::uuid, NULL::uuid, NULL::uuid, 'The trial balances could not be registered.'::text; RETURN;
    WHEN OTHERS THEN
      -- e.g. a locked period (trg_guard_upload_locked) or an engagement that does not match (validate_upload_engagement).
      RETURN QUERY SELECT 'rejected'::text, NULL::uuid, NULL::uuid, NULL::uuid, left(SQLERRM, 300); RETURN;
  END;
  RETURN QUERY SELECT 'registered'::text, v_cur_id, v_pri_id, v_obj, NULL::text;
END;
$$;

-- ── 5. Binding through the source object ─────────────────────────────────────────────────────────────────────────────
-- 20260923170000's rule, plus: an upload linked to a (not purged) source object at this path, in this workspace, whose
-- reservation was consumed, is bound — so both years hold the file.
CREATE OR REPLACE FUNCTION public.tbu_source_path_bound(p_file_path text, p_upload_id uuid, p_company_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN split_part(COALESCE(p_file_path, ''), '/', 1) = 'workspaces' THEN
      public.tbu_workspace_source_path_shape(p_file_path, p_company_id)
      AND (EXISTS (SELECT 1 FROM public.trial_balance_source_reservations r
                    WHERE r.object_path = p_file_path AND r.company_id = p_company_id AND r.consumed_by_upload_id = p_upload_id)
           OR EXISTS (SELECT 1 FROM public.trial_balance_uploads u
                        JOIN public.tb_source_objects so ON so.id = u.source_object_id
                        JOIN public.trial_balance_source_reservations r ON r.id = so.reservation_id
                       WHERE u.id = p_upload_id AND so.storage_path = p_file_path AND so.company_id = p_company_id
                         AND so.state <> 'purged' AND r.object_path = p_file_path AND r.consumed_at IS NOT NULL))
    ELSE public.tbu_personal_source_path(p_file_path, p_user_id)
  END;
$$;

-- ── 6. Purging a shared source after its last reference ──────────────────────────────────────────────────────────────
CREATE INDEX idx_tbuo_discard_source_object ON public.trial_balance_upload_operations (((row_snapshot ->> 'source_object_id')))
  WHERE kind = 'discard';

-- True when nothing can still need the object: no upload row links to it, no discard of a linked upload is pending or
-- still restorable, and no bound upload references its path.
CREATE OR REPLACE FUNCTION public.tbu_source_object_unreferenced(p_object_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.trial_balance_uploads t WHERE t.source_object_id = p_object_id)
     AND NOT EXISTS (SELECT 1 FROM public.trial_balance_upload_operations o
                      WHERE o.kind = 'discard' AND (o.row_snapshot ->> 'source_object_id') = p_object_id::text
                        AND (o.state = 'pending' OR (o.state = 'completed' AND o.completed_at > now() - public.tbu_undo_window())))
     AND NOT public.tbu_object_referenced((SELECT so.storage_path FROM public.tb_source_objects so WHERE so.id = p_object_id));
$$;

-- 20260923140000's candidates, plus 'source_object'.
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
    -- F-04: a discard left pending (the browser never completed it) is resolved, never deleted by the sweeper.
    SELECT 'stale_discard'::text, o.id, NULL::text FROM public.trial_balance_upload_operations o
     WHERE o.kind = 'discard' AND o.state = 'pending' AND o.created_at <= now() - public.tbu_stale_discard_grace()
     ORDER BY o.created_at LIMIT (SELECT n FROM lim)),
  s AS (
    -- I1-B: a shared source whose last reference has ended (and every undo window with it).
    SELECT 'source_object'::text, so.id, so.storage_path FROM public.tb_source_objects so
     WHERE so.state IN ('active', 'purge_pending') AND public.tbu_source_object_unreferenced(so.id)
     ORDER BY so.created_at LIMIT (SELECT n FROM lim))
  SELECT x.kind, x.id, x.path,
         x.path IS NOT NULL AND public.tbu_storage_object_exists(x.path) AND NOT public.tbu_object_referenced(x.path)
    FROM (SELECT * FROM d UNION ALL SELECT * FROM c UNION ALL SELECT * FROM r UNION ALL SELECT * FROM p
          UNION ALL SELECT * FROM s) x;
$$;

-- 20260923140000's claim, plus 'source_object' (locks the object; the upload guard's FOR SHARE waits on it).
CREATE OR REPLACE FUNCTION public.tbu_sweeper_claim(p_kind text, p_target_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_path text;
  v_state text;
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
  ELSIF p_kind = 'source_object' THEN
    SELECT so.state INTO v_state FROM public.tb_source_objects so WHERE so.id = p_target_id FOR UPDATE;
    IF v_state NOT IN ('active', 'purge_pending') OR NOT public.tbu_source_object_unreferenced(p_target_id) THEN
      RETURN 'not_eligible';
    END IF;
    IF v_state = 'active' THEN
      UPDATE public.tb_source_objects so SET state = 'purge_pending', purge_claimed_at = now() WHERE so.id = p_target_id;
    END IF;
    RETURN 'claimed';
  END IF;
  RETURN 'not_eligible';
END;
$$;

-- 20261008100000's completion, plus 'source_object'.
CREATE OR REPLACE FUNCTION public.tbu_sweeper_complete(p_kind text, p_target_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_op public.trial_balance_upload_operations%ROWTYPE;
  v_res public.trial_balance_source_reservations%ROWTYPE;
  v_obj public.tb_source_objects%ROWTYPE;
  v_upload uuid;
BEGIN
  IF p_kind = 'stale_discard' THEN
    -- S2 lock order: the upload (L4) before the operation (L6).
    SELECT o.upload_id INTO v_upload FROM public.trial_balance_upload_operations o WHERE o.id = p_target_id AND o.kind = 'discard';
    PERFORM 1 FROM public.trial_balance_uploads t WHERE t.id = v_upload FOR UPDATE;
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

  IF p_kind = 'source_object' THEN
    SELECT * INTO v_obj FROM public.tb_source_objects so WHERE so.id = p_target_id FOR UPDATE;
    IF v_obj.id IS NULL THEN RETURN 'stale'; END IF;
    IF v_obj.state = 'purged' THEN RETURN 'already_done'; END IF;
    IF NOT public.tbu_source_object_unreferenced(v_obj.id) THEN
      IF v_obj.state = 'purge_pending' THEN
        UPDATE public.tb_source_objects so SET state = 'active', purge_claimed_at = NULL WHERE so.id = v_obj.id;
      END IF;
      RETURN 'not_eligible';
    END IF;
    IF public.tbu_storage_object_exists(v_obj.storage_path) THEN RETURN 'storage_cleanup_pending'; END IF;
    UPDATE public.tb_source_objects so SET state = 'purged', purged_at = now() WHERE so.id = v_obj.id;
    RETURN 'purged';
  END IF;

  RETURN 'invalid_request';
END;
$function$;

-- ── 7. Discard purge of one year of a shared file ────────────────────────────────────────────────────────────────────
-- 20260923140000's purge; a discard whose file is kept because the other year still uses it answers 'source_shared'.
CREATE OR REPLACE FUNCTION public.purge_trial_balance_discard(p_operation_id uuid)
RETURNS TABLE (outcome text, detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_op public.trial_balance_upload_operations%ROWTYPE;
  v_auth record;
  v_shared boolean;
BEGIN
  SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_operation_id AND o.kind = 'discard' FOR UPDATE;
  IF v_op.id IS NULL THEN
    RETURN QUERY SELECT 'stale_operation'::text, NULL::text; RETURN;
  END IF;
  SELECT * INTO v_auth FROM public.tbu_authorize(v_op.company_id);
  IF v_auth.basis IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::text; RETURN;
  END IF;
  v_shared := v_op.file_path IS NULL AND (v_op.row_snapshot ->> 'source_object_id') IS NOT NULL
              AND EXISTS (SELECT 1 FROM public.trial_balance_uploads t
                           WHERE t.source_object_id::text = (v_op.row_snapshot ->> 'source_object_id'));
  IF v_op.state = 'purged' THEN
    IF v_shared THEN
      RETURN QUERY SELECT 'source_shared'::text, 'The file is kept because the other year still uses it.'::text; RETURN;
    END IF;
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
    'user', auth.uid(), v_auth.membership_id, v_auth.basis, v_auth.capability, 'applied', v_op.id,
    CASE WHEN v_shared THEN 'Discard purged; the shared file is kept for the other year' ELSE 'Discarded source purged after the undo window' END);
  IF v_shared THEN
    RETURN QUERY SELECT 'source_shared'::text, 'The file is kept because the other year still uses it.'::text; RETURN;
  END IF;
  RETURN QUERY SELECT 'purged'::text, NULL::text;
END;
$$;

-- ── 8. Grants ────────────────────────────────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.tb_source_objects_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_source_object_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tb_two_period_registrations_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_source_object_unreferenced(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.register_two_period_uploads(uuid, uuid, integer, uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_two_period_uploads(uuid, uuid, integer, uuid, uuid, uuid, uuid) TO authenticated;
-- Re-created functions keep their existing grants (CREATE OR REPLACE preserves privileges).
