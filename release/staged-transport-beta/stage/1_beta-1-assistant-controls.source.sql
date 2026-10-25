INSERT INTO cfoclose_beta_release.staged_artifacts(batch, kind, body) VALUES ('beta-1-assistant-controls', 'source', $cfoclose_beta_stage_84695443fc325657$-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261201100000 — Ask CFOClose Release 0.1: controls for the statement-line assistant (explain a movement, draft
-- commentary). ADVISORY ONLY: nothing here can write a classification, adjustment, evidence status, framework decision,
-- approval, publication or report. Forward-only; builds on 20261012100000 (ai_append_only_guard, commercial_admins).
--
-- SHIPS DISABLED: no provider, model, prices, terms wording or budget is seeded, so every request is refused until each is
-- explicitly configured and both approvals (data handling, evaluation) are recorded.
--
--   1. ai_assistant_settings     one row, commercial admins only. Enabling needs a provider, model, prompt version, terms
--                                version, token and time bounds, dated prices, retention policy and BOTH approvals; the
--                                per-request reservation must cover two calls (the request and its one correction) at the
--                                configured bounds — a CHECK, so a reservation can never under-cover a request.
--   2. ai_assistant_enablements  a workspace's decision to use the assistant under the CURRENT terms version (append-only;
--                                granted/revoked by a member holding manage_members). The legal basis and wording are owner
--                                decisions; this records the workspace's decision, it does not presume consent is sufficient.
--   3. ai_assistant_budgets      per workspace: monthly cost cap, per-user daily quota, concurrent-request limit. No row
--                                means no budget: refused.
--   4. ai_assistant_runs         one row per request, reserved BEFORE any provider call under a per-workspace lock
--                                (access re-derived, quota, concurrency, pessimistic monthly cost), idempotent per
--                                (actor, request id) with a payload digest (same key + same payload replays; a different
--                                payload is refused), completed once. A run left reserved past twice the request bound is
--                                EXPIRED — before the idempotency lookup, so a retry of its own id sees it expired — and still
--                                counted at its reserved cost (an ambiguous call is never assumed free and never retried). The validated answer is kept for replay and purged after the configured
--                                retention; operational fields never hold the prompt. The cost recorded is the cost the
--                                provider reported — NEVER capped at the reservation; an unknown cost (failed or ambiguous
--                                call, or usage the provider did not report in the documented form) is recorded at the
--                                reservation as an estimate.
--   5. ai_assistant_overrun_reviews  any run whose recorded cost exceeds its reservation (overrun_micros > 0) stops EVERY
--                                new reservation, platform-wide, until a commercial admin records a review of it: an
--                                overrun means the bounds or prices are wrong, so spending pauses rather than continuing.
--
-- PREFLIGHT: none of these objects exist and 20261012100000 is applied.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
BEGIN
  IF to_regclass('public.ai_assistant_settings') IS NOT NULL OR to_regclass('public.ai_assistant_enablements') IS NOT NULL
     OR to_regclass('public.ai_assistant_budgets') IS NOT NULL OR to_regclass('public.ai_assistant_runs') IS NOT NULL
     OR to_regclass('public.ai_assistant_overrun_reviews') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: assistant objects already exist; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure('public.ai_append_only_guard()') IS NULL OR to_regclass('public.commercial_admins') IS NULL
     OR to_regprocedure('public._workspace_access_basis(uuid, uuid)') IS NULL OR to_regprocedure('public.fs_rollout_allows(uuid)') IS NULL
     OR to_regprocedure('public.has_workspace_capability(uuid, uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: 20261012100000 and the workspace capability authority must be applied first; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. Settings (single row; disabled; commercial admins only) ───────────────────────────────────────────────────────
CREATE TABLE public.ai_assistant_settings (
  singleton                     BOOLEAN     NOT NULL DEFAULT true PRIMARY KEY CHECK (singleton),
  enabled                       BOOLEAN     NOT NULL DEFAULT false,
  provider_id                   TEXT        NULL CHECK (provider_id IS NULL OR provider_id ~ '^[a-z0-9_-]{1,40}$'),
  model                         TEXT        NULL CHECK (model IS NULL OR model ~ '^[A-Za-z0-9._:-]{1,100}$'),
  prompt_version                TEXT        NULL CHECK (prompt_version IS NULL OR length(prompt_version) BETWEEN 1 AND 100),
  terms_version                 TEXT        NULL CHECK (terms_version IS NULL OR terms_version ~ '^[a-z0-9][a-z0-9._-]{0,40}$'),
  max_input_tokens              INTEGER     NULL CHECK (max_input_tokens IS NULL OR max_input_tokens BETWEEN 1000 AND 50000),
  max_output_tokens             INTEGER     NULL CHECK (max_output_tokens IS NULL OR max_output_tokens BETWEEN 200 AND 4000),
  max_request_seconds           INTEGER     NULL CHECK (max_request_seconds IS NULL OR max_request_seconds BETWEEN 10 AND 120),
  -- Dated price configuration: micro-units of the billing currency per million tokens.
  price_input_micros_per_mtok        BIGINT NULL CHECK (price_input_micros_per_mtok IS NULL OR price_input_micros_per_mtok >= 0),
  price_output_micros_per_mtok       BIGINT NULL CHECK (price_output_micros_per_mtok IS NULL OR price_output_micros_per_mtok >= 0),
  price_cache_write_micros_per_mtok  BIGINT NULL CHECK (price_cache_write_micros_per_mtok IS NULL OR price_cache_write_micros_per_mtok >= 0),
  price_cache_read_micros_per_mtok   BIGINT NULL CHECK (price_cache_read_micros_per_mtok IS NULL OR price_cache_read_micros_per_mtok >= 0),
  price_catalogue_date          DATE        NULL,
  max_cost_per_request_micros   BIGINT      NULL CHECK (max_cost_per_request_micros IS NULL OR max_cost_per_request_micros > 0),
  retention_policy              TEXT        NULL CHECK (retention_policy IS NULL OR retention_policy ~ '^[a-z0-9_]{1,40}$'),
  region                        TEXT        NULL CHECK (region IS NULL OR region ~ '^[a-z0-9_-]{1,40}$'),
  response_retention_days       INTEGER     NOT NULL DEFAULT 30 CHECK (response_retention_days BETWEEN 0 AND 365),
  data_handling_approved_at     TIMESTAMPTZ NULL,
  evaluation_approved_at        TIMESTAMPTZ NULL,
  updated_by                    UUID        NULL,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_aias_enable_gates CHECK (NOT enabled OR (provider_id IS NOT NULL AND model IS NOT NULL AND prompt_version IS NOT NULL
    AND terms_version IS NOT NULL AND max_input_tokens IS NOT NULL AND max_output_tokens IS NOT NULL AND max_request_seconds IS NOT NULL
    AND price_input_micros_per_mtok IS NOT NULL AND price_output_micros_per_mtok IS NOT NULL AND price_cache_write_micros_per_mtok IS NOT NULL
    AND price_cache_read_micros_per_mtok IS NOT NULL AND price_catalogue_date IS NOT NULL AND max_cost_per_request_micros IS NOT NULL
    AND retention_policy IS NOT NULL AND data_handling_approved_at IS NOT NULL AND evaluation_approved_at IS NOT NULL)),
  -- The reservation covers the request AND its one permitted correction at the configured bounds, every input token priced
  -- at the higher of the ordinary and cache-write rates (mirrors ceilingMicros in _shared/assistantProvider.ts).
  CONSTRAINT chk_aias_reservation_covers_two_calls CHECK (NOT enabled OR max_cost_per_request_micros >= 2 * ceil(
    (max_input_tokens::numeric * GREATEST(price_input_micros_per_mtok, price_cache_write_micros_per_mtok)
     + max_output_tokens::numeric * price_output_micros_per_mtok) / 1000000))
);
INSERT INTO public.ai_assistant_settings (singleton, enabled) VALUES (true, false);
CREATE TRIGGER trg_aias_no_delete BEFORE DELETE ON public.ai_assistant_settings FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();
CREATE TRIGGER trg_aias_no_truncate BEFORE TRUNCATE ON public.ai_assistant_settings FOR EACH STATEMENT EXECUTE FUNCTION public.ai_append_only_guard();

-- Configure (commercial admins). p_settings is a JSON object of the columns above; omitted keys become NULL (explicit).
-- Turning the assistant off (the emergency switch) is p_settings = {"enabled": false}: it needs nothing else.
CREATE OR REPLACE FUNCTION public.ai_assistant_configure(p_settings jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  s jsonb := COALESCE(p_settings, '{}'::jsonb);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_uid AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(s) <> 'object' THEN RAISE EXCEPTION 'INVALID_SETTINGS' USING ERRCODE = '22023'; END IF;
  IF s = '{"enabled": false}'::jsonb THEN
    UPDATE public.ai_assistant_settings SET enabled = false, updated_by = v_uid, updated_at = now() WHERE singleton;
    RETURN jsonb_build_object('outcome', 'configured', 'enabled', false);
  END IF;
  UPDATE public.ai_assistant_settings SET
    enabled = COALESCE((s ->> 'enabled')::boolean, false),
    provider_id = s ->> 'provider_id', model = s ->> 'model', prompt_version = s ->> 'prompt_version', terms_version = s ->> 'terms_version',
    max_input_tokens = (s ->> 'max_input_tokens')::integer, max_output_tokens = (s ->> 'max_output_tokens')::integer,
    max_request_seconds = (s ->> 'max_request_seconds')::integer,
    price_input_micros_per_mtok = (s ->> 'price_input_micros_per_mtok')::bigint, price_output_micros_per_mtok = (s ->> 'price_output_micros_per_mtok')::bigint,
    price_cache_write_micros_per_mtok = (s ->> 'price_cache_write_micros_per_mtok')::bigint,
    price_cache_read_micros_per_mtok = (s ->> 'price_cache_read_micros_per_mtok')::bigint,
    price_catalogue_date = (s ->> 'price_catalogue_date')::date, max_cost_per_request_micros = (s ->> 'max_cost_per_request_micros')::bigint,
    retention_policy = s ->> 'retention_policy', region = s ->> 'region',
    response_retention_days = COALESCE((s ->> 'response_retention_days')::integer, 30),
    data_handling_approved_at = (s ->> 'data_handling_approved_at')::timestamptz, evaluation_approved_at = (s ->> 'evaluation_approved_at')::timestamptz,
    updated_by = v_uid, updated_at = now()
  WHERE singleton;
  RETURN jsonb_build_object('outcome', 'configured', 'enabled', COALESCE((s ->> 'enabled')::boolean, false));
END;
$$;

-- ── 2. Workspace enablement (append-only; manage_members) ────────────────────────────────────────────────────────────
CREATE TABLE public.ai_assistant_enablements (
  id             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id     UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  terms_version  TEXT        NOT NULL CHECK (terms_version ~ '^[a-z0-9][a-z0-9._-]{0,40}$'),
  action         TEXT        NOT NULL CHECK (action IN ('enabled', 'disabled')),
  actor_user_id  UUID        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_aiae_company ON public.ai_assistant_enablements (company_id, created_at DESC);
CREATE TRIGGER trg_aiae_append_only BEFORE UPDATE OR DELETE ON public.ai_assistant_enablements FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();
CREATE TRIGGER trg_aiae_no_truncate BEFORE TRUNCATE ON public.ai_assistant_enablements FOR EACH STATEMENT EXECUTE FUNCTION public.ai_append_only_guard();

-- True only when the workspace's latest record enables the CURRENT terms version (a new terms version needs a new decision).
CREATE OR REPLACE FUNCTION public.ai_assistant_workspace_enabled(p_company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((SELECT e.action = 'enabled' AND e.terms_version = s.terms_version
                     FROM public.ai_assistant_enablements e CROSS JOIN public.ai_assistant_settings s
                    WHERE e.company_id = p_company_id AND s.singleton ORDER BY e.created_at DESC, e.id DESC LIMIT 1), false);
$$;

CREATE OR REPLACE FUNCTION public.ai_assistant_set_enablement(p_company_id uuid, p_terms_version text, p_enable boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_current text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_enable IS NULL OR p_terms_version IS NULL THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  IF NOT public.has_workspace_capability(p_company_id, v_uid, 'manage_members') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_assistant_enablement:' || p_company_id::text, 0));
  SELECT s.terms_version INTO v_current FROM public.ai_assistant_settings s WHERE s.singleton;
  IF p_enable AND (v_current IS NULL OR v_current <> p_terms_version) THEN
    RETURN jsonb_build_object('outcome', 'stale_terms', 'currentTermsVersion', v_current);
  END IF;
  IF p_enable AND public.ai_assistant_workspace_enabled(p_company_id) THEN RETURN jsonb_build_object('outcome', 'unchanged', 'enabled', true); END IF;
  INSERT INTO public.ai_assistant_enablements (company_id, terms_version, action, actor_user_id)
  VALUES (p_company_id, p_terms_version, CASE WHEN p_enable THEN 'enabled' ELSE 'disabled' END, v_uid);
  RETURN jsonb_build_object('outcome', 'recorded', 'enabled', p_enable);
END;
$$;

-- ── 3. Budgets (commercial admins) ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.ai_assistant_budgets (
  company_id            UUID        NOT NULL PRIMARY KEY REFERENCES public.companies (id) ON DELETE RESTRICT,
  monthly_cap_micros    BIGINT      NOT NULL CHECK (monthly_cap_micros >= 0),
  daily_user_quota      INTEGER     NOT NULL CHECK (daily_user_quota >= 0),
  workspace_concurrency INTEGER     NOT NULL CHECK (workspace_concurrency BETWEEN 1 AND 10),
  updated_by            UUID        NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION public.ai_assistant_set_budget(p_company_id uuid, p_monthly_cap_micros bigint, p_daily_user_quota integer, p_workspace_concurrency integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_uid AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_company_id IS NULL OR p_monthly_cap_micros IS NULL OR p_monthly_cap_micros < 0 OR p_daily_user_quota IS NULL OR p_daily_user_quota < 0
     OR p_workspace_concurrency IS NULL OR p_workspace_concurrency NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'INVALID_BUDGET' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.ai_assistant_budgets (company_id, monthly_cap_micros, daily_user_quota, workspace_concurrency, updated_by)
  VALUES (p_company_id, p_monthly_cap_micros, p_daily_user_quota, p_workspace_concurrency, v_uid)
  ON CONFLICT (company_id) DO UPDATE SET monthly_cap_micros = EXCLUDED.monthly_cap_micros, daily_user_quota = EXCLUDED.daily_user_quota,
    workspace_concurrency = EXCLUDED.workspace_concurrency, updated_by = EXCLUDED.updated_by, updated_at = now();
  RETURN jsonb_build_object('outcome', 'configured');
END;
$$;

-- ── 4. Runs ──────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.ai_assistant_runs (
  id                    UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id            UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year           INTEGER     NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  line_id               TEXT        NOT NULL CHECK (length(line_id) BETWEEN 1 AND 200),
  action                TEXT        NOT NULL CHECK (action IN ('explain_movement', 'draft_commentary')),
  actor_user_id         UUID        NOT NULL,
  request_id            UUID        NOT NULL,
  payload_sha256        TEXT        NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  context_sha256        TEXT        NOT NULL CHECK (context_sha256 ~ '^[0-9a-f]{64}$'),
  composition_sha256    TEXT        NOT NULL CHECK (composition_sha256 ~ '^[0-9a-f]{64}$'),
  state                 TEXT        NOT NULL DEFAULT 'reserved'
                                    CHECK (state IN ('reserved', 'succeeded', 'invalid', 'stale', 'rejected', 'failed', 'ambiguous', 'expired')),
  provider_id           TEXT        NOT NULL,
  model                 TEXT        NOT NULL,
  prompt_version        TEXT        NOT NULL,
  terms_version         TEXT        NOT NULL,
  retention_policy      TEXT        NOT NULL,
  region                TEXT        NULL,
  prices                JSONB       NOT NULL,
  reserved_cost_micros  BIGINT      NOT NULL CHECK (reserved_cost_micros > 0),
  actual_cost_micros    BIGINT      NULL CHECK (actual_cost_micros IS NULL OR actual_cost_micros >= 0),
  usage                 JSONB       NULL,
  attempts              INTEGER     NULL CHECK (attempts IS NULL OR attempts BETWEEN 0 AND 2),
  duration_ms           INTEGER     NULL CHECK (duration_ms IS NULL OR duration_ms >= 0),
  -- Recorded cost above the reservation (0 when within it). Never hidden by capping the recorded cost.
  overrun_micros        BIGINT      NULL CHECK (overrun_micros IS NULL OR overrun_micros >= 0),
  response              JSONB       NULL,
  response_purged_at    TIMESTAMPTZ NULL,
  source_refs           TEXT[]      NULL,
  validation            JSONB       NULL,
  failure_code          TEXT        NULL CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,60}$'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at          TIMESTAMPTZ NULL,
  CONSTRAINT uq_aiar_request UNIQUE (actor_user_id, request_id),
  CONSTRAINT chk_aiar_terminal CHECK ((state = 'reserved') = (completed_at IS NULL)),
  CONSTRAINT chk_aiar_response_only_on_success CHECK (response IS NULL OR state = 'succeeded')
);
CREATE INDEX idx_aiar_company_month ON public.ai_assistant_runs (company_id, created_at);
CREATE INDEX idx_aiar_user_day ON public.ai_assistant_runs (actor_user_id, company_id, created_at);
CREATE INDEX idx_aiar_reserved ON public.ai_assistant_runs (company_id) WHERE state = 'reserved';

-- Identity never changes; a run completes exactly once; afterwards only the stored answer may be purged (never restored).
CREATE OR REPLACE FUNCTION public.ai_assistant_runs_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  k_completion text[] := ARRAY['state', 'actual_cost_micros', 'overrun_micros', 'usage', 'attempts', 'duration_ms', 'response', 'source_refs', 'validation', 'failure_code', 'completed_at'];
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'AI_RECORD_APPEND_ONLY: % on %', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501'; END IF;
  IF OLD.state = 'reserved' THEN
    IF (to_jsonb(NEW) - k_completion) IS DISTINCT FROM (to_jsonb(OLD) - k_completion) THEN
      RAISE EXCEPTION 'AI_RUN_IMMUTABLE: a run''s identity never changes' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.response IS NOT NULL AND NEW.response IS NULL AND NEW.response_purged_at IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['response', 'response_purged_at']) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['response', 'response_purged_at']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AI_RUN_COMPLETED: a completed run never changes' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER trg_aiar_guard BEFORE UPDATE OR DELETE ON public.ai_assistant_runs FOR EACH ROW EXECUTE FUNCTION public.ai_assistant_runs_guard();
CREATE TRIGGER trg_aiar_no_truncate BEFORE TRUNCATE ON public.ai_assistant_runs FOR EACH STATEMENT EXECUTE FUNCTION public.ai_append_only_guard();

-- Reserve one request before any provider call. Called by the assistant-explain Edge Function (service_role) AFTER it has
-- read the composition with the person's own credentials; access is re-derived here for the given user regardless.
-- Refusal codes: INVALID_REQUEST | PROVIDER_DISABLED | FORBIDDEN | ASSISTANT_NOT_ENABLED | REQUEST_ID_REUSED | COST_OVERRUN_REVIEW_REQUIRED |
-- AI_BUDGET_EXCEEDED | QUOTA_EXCEEDED | USER_BUSY | CONCURRENCY_LIMIT. A repeated request id with the same payload replays.
CREATE OR REPLACE FUNCTION public.ai_assistant_reserve(p_user_id uuid, p_company_id uuid, p_period_year integer, p_line_id text,
  p_action text, p_request_id uuid, p_payload_sha256 text, p_context_sha256 text, p_composition_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_s public.ai_assistant_settings%ROWTYPE;
  v_b public.ai_assistant_budgets%ROWTYPE;
  v_run public.ai_assistant_runs%ROWTYPE;
  v_n integer;
  v_month bigint;
BEGIN
  IF p_user_id IS NULL OR p_company_id IS NULL OR p_period_year IS NULL OR p_line_id IS NULL OR p_request_id IS NULL
     OR p_action NOT IN ('explain_movement', 'draft_commentary') OR p_payload_sha256 !~ '^[0-9a-f]{64}$'
     OR p_context_sha256 !~ '^[0-9a-f]{64}$' OR p_composition_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'INVALID_REQUEST');
  END IF;
  SELECT * INTO v_s FROM public.ai_assistant_settings WHERE singleton;
  IF NOT COALESCE(v_s.enabled, false) THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'PROVIDER_DISABLED'); END IF;
  -- Access is decided BEFORE anything stored is looked up: a revoked member never receives a replayed answer.
  IF public._workspace_access_basis(p_user_id, p_company_id) IS NULL OR NOT public.fs_rollout_allows(p_company_id) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'FORBIDDEN');
  END IF;
  -- One lock per workspace, taken before the idempotency lookup: concurrent duplicates of one request see one reservation
  -- (the rest replay it), and concurrent reservations cannot both pass the budget, the quota or the concurrency limit.
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_assistant:' || p_company_id::text, 0));
  -- A run left reserved past twice the request bound is expired: its call may or may not have completed, so it keeps its
  -- reserved cost (actual_cost_micros stays NULL and counts at reserved_cost_micros) and is never retried. This runs BEFORE
  -- the idempotency lookup, so a retry of the stranded request's own id sees it expired (PREVIOUS_EXPIRED) instead of
  -- IN_PROGRESS forever; a run inside its bound is untouched and still replays as in progress.
  UPDATE public.ai_assistant_runs r SET state = 'expired', failure_code = 'EXPIRED_UNCONFIRMED', completed_at = clock_timestamp()
   WHERE r.company_id = p_company_id AND r.state = 'reserved' AND r.created_at < clock_timestamp() - make_interval(secs => 2 * v_s.max_request_seconds);
  SELECT * INTO v_run FROM public.ai_assistant_runs r WHERE r.actor_user_id = p_user_id AND r.request_id = p_request_id;
  IF v_run.id IS NOT NULL THEN
    IF v_run.payload_sha256 <> p_payload_sha256 OR v_run.company_id <> p_company_id THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'REQUEST_ID_REUSED');
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'runId', v_run.id, 'state', v_run.state, 'response', v_run.response,
      'compositionSha256', v_run.composition_sha256, 'failureCode', v_run.failure_code, 'purged', v_run.response_purged_at IS NOT NULL);
  END IF;
  IF NOT public.ai_assistant_workspace_enabled(p_company_id) THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'ASSISTANT_NOT_ENABLED'); END IF;
  -- Any unreviewed overrun, anywhere, pauses all new spending: the configured bounds or prices no longer hold.
  IF EXISTS (SELECT 1 FROM public.ai_assistant_runs r WHERE r.overrun_micros > 0
              AND NOT EXISTS (SELECT 1 FROM public.ai_assistant_overrun_reviews v WHERE v.run_id = r.id)) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'COST_OVERRUN_REVIEW_REQUIRED');
  END IF;
  SELECT * INTO v_b FROM public.ai_assistant_budgets b WHERE b.company_id = p_company_id;
  IF v_b.company_id IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'AI_BUDGET_EXCEEDED'); END IF;
  IF EXISTS (SELECT 1 FROM public.ai_assistant_runs r WHERE r.company_id = p_company_id AND r.actor_user_id = p_user_id AND r.state = 'reserved') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'USER_BUSY');
  END IF;
  SELECT count(*) INTO v_n FROM public.ai_assistant_runs r WHERE r.company_id = p_company_id AND r.state = 'reserved';
  IF v_n >= v_b.workspace_concurrency THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'CONCURRENCY_LIMIT'); END IF;
  SELECT count(*) INTO v_n FROM public.ai_assistant_runs r
   WHERE r.company_id = p_company_id AND r.actor_user_id = p_user_id AND r.created_at >= date_trunc('day', now());
  IF v_n >= v_b.daily_user_quota THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'QUOTA_EXCEEDED'); END IF;
  -- Pessimistic: an unresolved run counts at its reserved (maximum) cost; a completed run at its recorded cost.
  SELECT COALESCE(sum(COALESCE(r.actual_cost_micros, r.reserved_cost_micros)), 0) INTO v_month FROM public.ai_assistant_runs r
   WHERE r.company_id = p_company_id AND r.created_at >= date_trunc('month', now());
  IF v_month + v_s.max_cost_per_request_micros > v_b.monthly_cap_micros THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'AI_BUDGET_EXCEEDED'); END IF;
  INSERT INTO public.ai_assistant_runs (company_id, period_year, line_id, action, actor_user_id, request_id, payload_sha256, context_sha256,
    composition_sha256, provider_id, model, prompt_version, terms_version, retention_policy, region, prices, reserved_cost_micros)
  VALUES (p_company_id, p_period_year, p_line_id, p_action, p_user_id, p_request_id, p_payload_sha256, p_context_sha256, p_composition_sha256,
    v_s.provider_id, v_s.model, v_s.prompt_version, v_s.terms_version, v_s.retention_policy, v_s.region,
    jsonb_build_object('inputMicrosPerMTok', v_s.price_input_micros_per_mtok, 'outputMicrosPerMTok', v_s.price_output_micros_per_mtok,
      'cacheWriteMicrosPerMTok', v_s.price_cache_write_micros_per_mtok, 'cacheReadMicrosPerMTok', v_s.price_cache_read_micros_per_mtok,
      'catalogueDate', v_s.price_catalogue_date),
    v_s.max_cost_per_request_micros)
  RETURNING * INTO v_run;
  RETURN jsonb_build_object('outcome', 'reserved', 'runId', v_run.id, 'providerId', v_s.provider_id, 'model', v_s.model,
    'promptVersion', v_s.prompt_version, 'maxInputTokens', v_s.max_input_tokens, 'maxOutputTokens', v_s.max_output_tokens,
    'maxRequestSeconds', v_s.max_request_seconds, 'reservedCostMicros', v_s.max_cost_per_request_micros, 'prices', v_run.prices);
END;
$$;

-- Complete a reserved run exactly once. A NULL actual cost (unknown: failed or ambiguous) is recorded at the reserved
-- ceiling (an estimate). A reported cost is recorded IN FULL; any part above the reservation is kept as overrun_micros,
-- counts toward the monthly spend, and pauses new reservations until reviewed (ai_assistant_review_overrun).
CREATE OR REPLACE FUNCTION public.ai_assistant_complete(p_run_id uuid, p_state text, p_actual_cost_micros bigint, p_usage jsonb,
  p_attempts integer, p_duration_ms integer, p_response jsonb, p_source_refs text[], p_validation jsonb, p_failure_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_run public.ai_assistant_runs%ROWTYPE;
BEGIN
  IF p_state NOT IN ('succeeded', 'invalid', 'stale', 'rejected', 'failed', 'ambiguous') THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'INVALID_REQUEST'); END IF;
  IF (p_state = 'succeeded') <> (p_response IS NOT NULL) THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'INVALID_REQUEST'); END IF;
  SELECT * INTO v_run FROM public.ai_assistant_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF v_run.id IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'RUN_NOT_FOUND'); END IF;
  IF v_run.state <> 'reserved' THEN RETURN jsonb_build_object('outcome', 'already_completed', 'state', v_run.state); END IF;
  UPDATE public.ai_assistant_runs r
     SET state = p_state,
         actual_cost_micros = GREATEST(COALESCE(p_actual_cost_micros, r.reserved_cost_micros), 0),
         overrun_micros = GREATEST(COALESCE(p_actual_cost_micros, r.reserved_cost_micros) - r.reserved_cost_micros, 0),
         usage = p_usage, attempts = p_attempts, duration_ms = p_duration_ms, response = p_response, source_refs = p_source_refs,
         validation = p_validation,
         failure_code = p_failure_code,
         completed_at = clock_timestamp()
   WHERE r.id = p_run_id;
  RETURN jsonb_build_object('outcome', 'completed', 'state', p_state);
END;
$$;

-- Retention: stored answers older than the configured retention are removed (the run's accounting record stays).
CREATE OR REPLACE FUNCTION public.ai_assistant_purge_responses()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_days integer;
  v_n integer;
BEGIN
  SELECT s.response_retention_days INTO v_days FROM public.ai_assistant_settings s WHERE s.singleton;
  UPDATE public.ai_assistant_runs r SET response = NULL, response_purged_at = clock_timestamp()
   WHERE r.response IS NOT NULL AND r.completed_at < clock_timestamp() - make_interval(days => v_days);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('outcome', 'purged', 'count', v_n);
END;
$$;

-- What the panel may show for this workspace (the server still decides every request).
CREATE OR REPLACE FUNCTION public.ai_assistant_status(p_company_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_s public.ai_assistant_settings%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR p_company_id IS NULL OR public._workspace_access_basis(v_uid, p_company_id) IS NULL THEN
    RETURN jsonb_build_object('state', 'unavailable');
  END IF;
  SELECT * INTO v_s FROM public.ai_assistant_settings WHERE singleton;
  RETURN jsonb_build_object(
    'state', CASE WHEN NOT COALESCE(v_s.enabled, false) THEN 'disabled'
                  WHEN NOT public.ai_assistant_workspace_enabled(p_company_id) THEN 'not_enabled'
                  WHEN NOT EXISTS (SELECT 1 FROM public.ai_assistant_budgets b WHERE b.company_id = p_company_id) THEN 'no_budget'
                  ELSE 'available' END,
    'termsVersion', v_s.terms_version,
    'canManage', public.has_workspace_capability(p_company_id, v_uid, 'manage_members'));
END;
$$;

-- ── 5. Overrun reviews (commercial admins; append-only) ─────────────────────────────────────────────────────────────
CREATE TABLE public.ai_assistant_overrun_reviews (
  run_id         UUID        NOT NULL PRIMARY KEY REFERENCES public.ai_assistant_runs (id) ON DELETE RESTRICT,
  reviewed_by    UUID        NOT NULL,
  note           TEXT        NOT NULL CHECK (length(btrim(note)) BETWEEN 10 AND 2000),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER trg_aior_append_only BEFORE UPDATE OR DELETE ON public.ai_assistant_overrun_reviews FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();
CREATE TRIGGER trg_aior_no_truncate BEFORE TRUNCATE ON public.ai_assistant_overrun_reviews FOR EACH STATEMENT EXECUTE FUNCTION public.ai_append_only_guard();

-- Record that an overrun was reviewed (the bounds or prices corrected, or the cause understood). The cost stays recorded.
CREATE OR REPLACE FUNCTION public.ai_assistant_review_overrun(p_run_id uuid, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_uid AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ai_assistant_runs r WHERE r.id = p_run_id AND r.overrun_micros > 0) THEN
    RETURN jsonb_build_object('outcome', 'not_an_overrun');
  END IF;
  INSERT INTO public.ai_assistant_overrun_reviews (run_id, reviewed_by, note) VALUES (p_run_id, v_uid, p_note)
  ON CONFLICT (run_id) DO NOTHING;
  RETURN jsonb_build_object('outcome', 'recorded');
END;
$$;

-- ── Access: no client reads or writes any table; everything goes through the functions above ─────────────────────────
ALTER TABLE public.ai_assistant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_assistant_enablements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_assistant_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_assistant_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_assistant_overrun_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_assistant_settings, public.ai_assistant_enablements, public.ai_assistant_budgets, public.ai_assistant_runs,
  public.ai_assistant_overrun_reviews
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.ai_assistant_runs_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ai_assistant_workspace_enabled(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_assistant_workspace_enabled(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.ai_assistant_configure(jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ai_assistant_configure(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.ai_assistant_set_enablement(uuid, text, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ai_assistant_set_enablement(uuid, text, boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.ai_assistant_set_budget(uuid, bigint, integer, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ai_assistant_set_budget(uuid, bigint, integer, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.ai_assistant_reserve(uuid, uuid, integer, text, text, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_assistant_reserve(uuid, uuid, integer, text, text, uuid, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.ai_assistant_complete(uuid, text, bigint, jsonb, integer, integer, jsonb, text[], jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_assistant_complete(uuid, text, bigint, jsonb, integer, integer, jsonb, text[], jsonb, text) TO service_role;
REVOKE ALL ON FUNCTION public.ai_assistant_review_overrun(uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ai_assistant_review_overrun(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.ai_assistant_purge_responses() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_assistant_purge_responses() TO service_role;
REVOKE ALL ON FUNCTION public.ai_assistant_status(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ai_assistant_status(uuid) TO authenticated;

DO $postcondition$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_assistant_settings', 'ai_assistant_enablements', 'ai_assistant_budgets', 'ai_assistant_runs', 'ai_assistant_overrun_reviews'] LOOP
    IF has_table_privilege('authenticated', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'POSTCONDITION_FAILED: a client role can read or write %', t;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.ai_assistant_reserve(uuid, uuid, integer, text, text, uuid, text, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ai_assistant_complete(uuid, text, bigint, jsonb, integer, integer, jsonb, text[], jsonb, text)', 'EXECUTE')
     OR (SELECT enabled FROM public.ai_assistant_settings WHERE singleton) THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: the assistant must ship disabled with server-only reservation';
  END IF;
END;
$postcondition$;
$cfoclose_beta_stage_84695443fc325657$);
