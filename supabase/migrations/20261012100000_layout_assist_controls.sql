-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- I1-C: controls for AI-assisted layout suggestions. External AI calls stay DISABLED: this migration ships no provider,
-- no consent wording and no budget, so every suggestion is refused until each is explicitly approved and configured.
--
--   1. ai_consent_versions / ai_workspace_consents — a workspace's consent to send a minimized sample (ai-sample/1) of
--      its files to the configured provider. Versioned (a new wording needs a new consent), revocable, append-only;
--      given or revoked by a member holding manage_members. No version is seeded (the wording is an owner decision).
--   2. ai_provider_settings — the single provider configuration (commercial admins only). Seeded DISABLED with no
--      provider; the Edge Function additionally has no external adapter wired.
--   3. ai_workspace_budgets — per-workspace monthly cost cap and per-user daily quota (commercial admins only). No row
--      means no budget: refused.
--   4. ai_layout_assist_runs — one row per suggestion request: reserved before any provider call (quota and pessimistic
--      cost reserved under a per-workspace lock), completed once with the proposal, its whole-file validation and the
--      actual cost. Idempotent per (user, request). A proposal is advisory: nothing here can confirm a layout, change an
--      amount, approve a classification or decide a treatment — the person confirms through the existing layout path.
--
-- PREFLIGHT: none of the objects exist yet; the migration refuses if they do.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
BEGIN
  IF to_regclass('public.ai_layout_assist_runs') IS NOT NULL OR to_regclass('public.ai_provider_settings') IS NOT NULL
     OR to_regclass('public.ai_workspace_consents') IS NOT NULL OR to_regclass('public.ai_workspace_budgets') IS NOT NULL
     OR to_regclass('public.ai_consent_versions') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: layout-assist objects already exist; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── Append-only guard shared by the consent tables and versions ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ai_append_only_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'AI_RECORD_APPEND_ONLY: % on %', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;

-- ── 1. Consent ───────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.ai_consent_versions (
  version        TEXT        NOT NULL PRIMARY KEY CHECK (version ~ '^[a-z0-9][a-z0-9._-]{0,40}$'),
  wording        TEXT        NOT NULL CHECK (length(btrim(wording)) BETWEEN 20 AND 8000),
  wording_sha256 TEXT        NOT NULL CHECK (wording_sha256 ~ '^[0-9a-f]{64}$'),
  sample_format  TEXT        NOT NULL CHECK (sample_format = 'ai-sample/1'),
  published_by   UUID        NOT NULL,
  published_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_current     BOOLEAN     NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX uq_ai_consent_versions_current ON public.ai_consent_versions (is_current) WHERE is_current;
CREATE TRIGGER trg_aicv_no_delete BEFORE DELETE ON public.ai_consent_versions FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();
CREATE TRIGGER trg_aicv_no_truncate BEFORE TRUNCATE ON public.ai_consent_versions FOR EACH STATEMENT EXECUTE FUNCTION public.ai_append_only_guard();
-- Only is_current may change (a newer version replaces it); the wording of a version never changes.
CREATE OR REPLACE FUNCTION public.ai_consent_versions_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (to_jsonb(NEW) - 'is_current') IS DISTINCT FROM (to_jsonb(OLD) - 'is_current') THEN
    RAISE EXCEPTION 'AI_CONSENT_VERSION_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_aicv_immutable BEFORE UPDATE ON public.ai_consent_versions FOR EACH ROW EXECUTE FUNCTION public.ai_consent_versions_guard();

CREATE TABLE public.ai_workspace_consents (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id      UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  consent_version TEXT        NOT NULL REFERENCES public.ai_consent_versions (version) ON DELETE RESTRICT,
  action          TEXT        NOT NULL CHECK (action IN ('granted', 'revoked')),
  actor_user_id   UUID        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_aiwc_company ON public.ai_workspace_consents (company_id, created_at DESC);
CREATE TRIGGER trg_aiwc_append_only BEFORE UPDATE OR DELETE ON public.ai_workspace_consents FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();
CREATE TRIGGER trg_aiwc_no_truncate BEFORE TRUNCATE ON public.ai_workspace_consents FOR EACH STATEMENT EXECUTE FUNCTION public.ai_append_only_guard();

-- True only when the workspace's latest consent record grants the CURRENT version.
CREATE OR REPLACE FUNCTION public.ai_workspace_consent_current(p_company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((SELECT c.action = 'granted' AND v.is_current
                     FROM public.ai_workspace_consents c JOIN public.ai_consent_versions v ON v.version = c.consent_version
                    WHERE c.company_id = p_company_id ORDER BY c.created_at DESC, c.id DESC LIMIT 1), false);
$$;

-- Grant or revoke, by a member holding manage_members. Granting needs the current version, named explicitly.
CREATE OR REPLACE FUNCTION public.ai_set_workspace_consent(p_company_id uuid, p_consent_version text, p_grant boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_current text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_grant IS NULL OR p_consent_version IS NULL THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  IF NOT public.has_workspace_capability(p_company_id, v_uid, 'manage_members') THEN
    RETURN jsonb_build_object('outcome', 'forbidden');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_consent:' || p_company_id::text, 0));
  SELECT v.version INTO v_current FROM public.ai_consent_versions v WHERE v.is_current;
  IF p_grant AND (v_current IS NULL OR v_current <> p_consent_version) THEN
    RETURN jsonb_build_object('outcome', 'stale_version', 'currentVersion', v_current);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ai_consent_versions v WHERE v.version = p_consent_version) THEN
    RETURN jsonb_build_object('outcome', 'stale_version', 'currentVersion', v_current);
  END IF;
  IF public.ai_workspace_consent_current(p_company_id) = p_grant AND p_grant THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'granted', true);
  END IF;
  INSERT INTO public.ai_workspace_consents (company_id, consent_version, action, actor_user_id)
  VALUES (p_company_id, p_consent_version, CASE WHEN p_grant THEN 'granted' ELSE 'revoked' END, v_uid);
  RETURN jsonb_build_object('outcome', 'recorded', 'granted', p_grant);
END;
$$;

-- ── 2. Provider (single row; disabled; commercial admins only) ───────────────────────────────────────────────────────
CREATE TABLE public.ai_provider_settings (
  singleton                    BOOLEAN     NOT NULL DEFAULT true PRIMARY KEY CHECK (singleton),
  enabled                      BOOLEAN     NOT NULL DEFAULT false,
  provider_id                  TEXT        NULL CHECK (provider_id IS NULL OR provider_id ~ '^[a-z0-9_-]{1,40}$'),
  model                        TEXT        NULL CHECK (model IS NULL OR length(model) BETWEEN 1 AND 100),
  prompt_version               TEXT        NULL,
  max_cost_per_call_micros     BIGINT      NULL CHECK (max_cost_per_call_micros IS NULL OR max_cost_per_call_micros > 0),
  data_handling_approved_at    TIMESTAMPTZ NULL,
  evaluation_approved_at       TIMESTAMPTZ NULL,
  updated_by                   UUID        NULL,
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Enabling requires a provider, a model, a prompt version, a per-call cost ceiling, and BOTH approval gates recorded.
  CONSTRAINT chk_aips_enable_gates CHECK (NOT enabled OR (provider_id IS NOT NULL AND model IS NOT NULL AND prompt_version IS NOT NULL
    AND max_cost_per_call_micros IS NOT NULL AND data_handling_approved_at IS NOT NULL AND evaluation_approved_at IS NOT NULL))
);
INSERT INTO public.ai_provider_settings (singleton, enabled) VALUES (true, false);
CREATE TRIGGER trg_aips_no_delete BEFORE DELETE ON public.ai_provider_settings FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();

CREATE OR REPLACE FUNCTION public.ai_configure_provider(p_enabled boolean, p_provider_id text, p_model text, p_prompt_version text,
  p_max_cost_per_call_micros bigint, p_data_handling_approved_at timestamptz, p_evaluation_approved_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_uid AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  UPDATE public.ai_provider_settings SET enabled = p_enabled, provider_id = p_provider_id, model = p_model, prompt_version = p_prompt_version,
    max_cost_per_call_micros = p_max_cost_per_call_micros, data_handling_approved_at = p_data_handling_approved_at,
    evaluation_approved_at = p_evaluation_approved_at, updated_by = v_uid, updated_at = now()
   WHERE singleton;
  RETURN jsonb_build_object('outcome', 'configured', 'enabled', p_enabled);
END;
$$;

-- ── 3. Budgets ───────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.ai_workspace_budgets (
  company_id          UUID        NOT NULL PRIMARY KEY REFERENCES public.companies (id) ON DELETE RESTRICT,
  monthly_cap_micros  BIGINT      NOT NULL CHECK (monthly_cap_micros >= 0),
  daily_user_quota    INTEGER     NOT NULL CHECK (daily_user_quota >= 0),
  updated_by          UUID        NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION public.ai_set_workspace_budget(p_company_id uuid, p_monthly_cap_micros bigint, p_daily_user_quota integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_uid AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_monthly_cap_micros IS NULL OR p_monthly_cap_micros < 0 OR p_daily_user_quota IS NULL OR p_daily_user_quota < 0 THEN
    RAISE EXCEPTION 'INVALID_BUDGET' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.ai_workspace_budgets (company_id, monthly_cap_micros, daily_user_quota, updated_by)
  VALUES (p_company_id, p_monthly_cap_micros, p_daily_user_quota, v_uid)
  ON CONFLICT (company_id) DO UPDATE SET monthly_cap_micros = EXCLUDED.monthly_cap_micros, daily_user_quota = EXCLUDED.daily_user_quota,
    updated_by = EXCLUDED.updated_by, updated_at = now();
  RETURN jsonb_build_object('outcome', 'configured');
END;
$$;

-- ── 4. Runs ──────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.ai_layout_assist_runs (
  id                    UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id            UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  upload_id             UUID        NOT NULL,
  actor_user_id         UUID        NOT NULL,
  firm_member_id        UUID        NULL,
  request_id            UUID        NOT NULL,
  state                 TEXT        NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'proposed', 'invalid', 'failed')),
  consent_version       TEXT        NOT NULL,
  provider_id           TEXT        NOT NULL,
  model                 TEXT        NOT NULL,
  prompt_version        TEXT        NOT NULL,
  sample_format         TEXT        NOT NULL CHECK (sample_format = 'ai-sample/1'),
  sample_sha256         TEXT        NOT NULL CHECK (sample_sha256 ~ '^[0-9a-f]{64}$'),
  reserved_cost_micros  BIGINT      NOT NULL CHECK (reserved_cost_micros > 0),
  actual_cost_micros    BIGINT      NULL CHECK (actual_cost_micros IS NULL OR actual_cost_micros >= 0),
  proposal              JSONB       NULL,
  proposal_sha256       TEXT        NULL,
  validation            JSONB       NULL,
  failure_code          TEXT        NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ NULL,
  CONSTRAINT uq_ailar_request UNIQUE (actor_user_id, request_id),
  CONSTRAINT chk_ailar_terminal CHECK ((state = 'reserved') = (completed_at IS NULL))
);
CREATE INDEX idx_ailar_company_month ON public.ai_layout_assist_runs (company_id, created_at);
CREATE INDEX idx_ailar_user_day ON public.ai_layout_assist_runs (actor_user_id, created_at);

-- Identity never changes; a run completes exactly once (reserved → proposed | invalid | failed); nothing is deleted.
CREATE OR REPLACE FUNCTION public.ai_layout_assist_runs_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'AI_RECORD_APPEND_ONLY: % on %', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501'; END IF;
  IF OLD.state <> 'reserved' THEN RAISE EXCEPTION 'AI_RUN_COMPLETED: a completed run never changes' USING ERRCODE = '42501'; END IF;
  IF (to_jsonb(NEW) - ARRAY['state', 'actual_cost_micros', 'proposal', 'proposal_sha256', 'validation', 'failure_code', 'completed_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'actual_cost_micros', 'proposal', 'proposal_sha256', 'validation', 'failure_code', 'completed_at']) THEN
    RAISE EXCEPTION 'AI_RUN_IMMUTABLE: a run''s identity never changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_ailar_guard BEFORE UPDATE OR DELETE ON public.ai_layout_assist_runs FOR EACH ROW EXECUTE FUNCTION public.ai_layout_assist_runs_guard();
CREATE TRIGGER trg_ailar_no_truncate BEFORE TRUNCATE ON public.ai_layout_assist_runs FOR EACH STATEMENT EXECUTE FUNCTION public.ai_append_only_guard();

-- Reserve one suggestion before any provider call. Called by the layout-assist Edge Function (service_role) AFTER it
-- has authorized the user for the upload; the actor is re-derived here (prepare_close + current plan via _layout_actor).
-- Codes: PROVIDER_DISABLED | CONSENT_REQUIRED | FORBIDDEN | QUOTA_EXCEEDED | AI_BUDGET_EXCEEDED | reserved (replay too).
CREATE OR REPLACE FUNCTION public.ai_layout_assist_reserve(p_user_id uuid, p_upload_id uuid, p_request_id uuid, p_sample_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_p public.ai_provider_settings%ROWTYPE;
  v_company uuid;
  v_actor record;
  v_budget public.ai_workspace_budgets%ROWTYPE;
  v_run public.ai_layout_assist_runs%ROWTYPE;
  v_today integer;
  v_month bigint;
  v_version text;
BEGIN
  IF p_user_id IS NULL OR p_upload_id IS NULL OR p_request_id IS NULL OR p_sample_sha256 IS NULL OR p_sample_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'INVALID_REQUEST');
  END IF;
  SELECT * INTO v_run FROM public.ai_layout_assist_runs r WHERE r.actor_user_id = p_user_id AND r.request_id = p_request_id;
  IF v_run.id IS NOT NULL THEN
    IF v_run.upload_id <> p_upload_id OR v_run.sample_sha256 <> p_sample_sha256 THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'REQUEST_ID_REUSED');
    END IF;
    RETURN jsonb_build_object('outcome', 'reserved', 'runId', v_run.id, 'state', v_run.state, 'replay', true,
      'proposal', v_run.proposal, 'validation', v_run.validation, 'failureCode', v_run.failure_code);
  END IF;
  SELECT * INTO v_p FROM public.ai_provider_settings WHERE singleton;
  IF NOT COALESCE(v_p.enabled, false) THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'PROVIDER_DISABLED'); END IF;
  SELECT t.company_id INTO v_company FROM public.trial_balance_uploads t WHERE t.id = p_upload_id;
  IF v_company IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'FORBIDDEN'); END IF;
  SELECT * INTO v_actor FROM public._layout_actor(p_user_id, v_company);
  IF v_actor.actor_type IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'FORBIDDEN'); END IF;
  -- One lock per workspace: concurrent reservations cannot both pass the budget or the quota.
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_layout_assist:' || v_company::text, 0));
  IF NOT public.ai_workspace_consent_current(v_company) THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'CONSENT_REQUIRED'); END IF;
  SELECT v.version INTO v_version FROM public.ai_consent_versions v WHERE v.is_current;
  SELECT * INTO v_budget FROM public.ai_workspace_budgets b WHERE b.company_id = v_company;
  IF v_budget.company_id IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'AI_BUDGET_EXCEEDED'); END IF;
  SELECT count(*) INTO v_today FROM public.ai_layout_assist_runs r
   WHERE r.company_id = v_company AND r.actor_user_id = p_user_id AND r.created_at >= date_trunc('day', now());
  IF v_today >= v_budget.daily_user_quota THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'QUOTA_EXCEEDED'); END IF;
  -- Pessimistic: a run still reserved counts at its reserved (maximum) cost; a completed run at its actual cost.
  SELECT COALESCE(sum(COALESCE(r.actual_cost_micros, r.reserved_cost_micros)), 0) INTO v_month FROM public.ai_layout_assist_runs r
   WHERE r.company_id = v_company AND r.created_at >= date_trunc('month', now());
  IF v_month + v_p.max_cost_per_call_micros > v_budget.monthly_cap_micros THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'AI_BUDGET_EXCEEDED');
  END IF;
  INSERT INTO public.ai_layout_assist_runs (company_id, upload_id, actor_user_id, firm_member_id, request_id, consent_version,
    provider_id, model, prompt_version, sample_format, sample_sha256, reserved_cost_micros)
  VALUES (v_company, p_upload_id, p_user_id, v_actor.firm_member_id, p_request_id, v_version,
    v_p.provider_id, v_p.model, v_p.prompt_version, 'ai-sample/1', p_sample_sha256, v_p.max_cost_per_call_micros)
  RETURNING * INTO v_run;
  RETURN jsonb_build_object('outcome', 'reserved', 'runId', v_run.id, 'state', 'reserved', 'replay', false,
    'providerId', v_p.provider_id, 'model', v_p.model, 'promptVersion', v_p.prompt_version, 'maxCostMicros', v_p.max_cost_per_call_micros);
END;
$$;

-- Complete a reserved run exactly once. The actual cost is recorded as reported, never above the reserved ceiling
-- (the adapter bounds output; an over-ceiling report is recorded at the ceiling and flagged COST_ABOVE_CEILING).
CREATE OR REPLACE FUNCTION public.ai_layout_assist_complete(p_run_id uuid, p_state text, p_actual_cost_micros bigint,
  p_proposal jsonb, p_proposal_sha256 text, p_validation jsonb, p_failure_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_run public.ai_layout_assist_runs%ROWTYPE;
BEGIN
  IF p_state NOT IN ('proposed', 'invalid', 'failed') THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'INVALID_REQUEST'); END IF;
  IF p_state = 'proposed' AND (p_proposal IS NULL OR p_validation IS NULL OR p_proposal_sha256 !~ '^[0-9a-f]{64}$') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'INVALID_REQUEST');
  END IF;
  SELECT * INTO v_run FROM public.ai_layout_assist_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF v_run.id IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'RUN_NOT_FOUND'); END IF;
  IF v_run.state <> 'reserved' THEN RETURN jsonb_build_object('outcome', 'completed', 'state', v_run.state, 'replay', true); END IF;
  UPDATE public.ai_layout_assist_runs r
     SET state = p_state, actual_cost_micros = LEAST(GREATEST(COALESCE(p_actual_cost_micros, r.reserved_cost_micros), 0), r.reserved_cost_micros),
         proposal = p_proposal, proposal_sha256 = p_proposal_sha256, validation = p_validation,
         failure_code = CASE WHEN COALESCE(p_actual_cost_micros, 0) > r.reserved_cost_micros THEN 'COST_ABOVE_CEILING' ELSE p_failure_code END,
         completed_at = now()
   WHERE r.id = p_run_id;
  RETURN jsonb_build_object('outcome', 'completed', 'state', p_state, 'replay', false);
END;
$$;

-- ── Access ───────────────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.ai_consent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_workspace_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_provider_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_workspace_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_layout_assist_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_consent_versions, public.ai_workspace_consents, public.ai_provider_settings,
  public.ai_workspace_budgets, public.ai_layout_assist_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ai_consent_versions, public.ai_workspace_consents, public.ai_workspace_budgets,
  public.ai_layout_assist_runs TO authenticated;
GRANT SELECT ON TABLE public.ai_consent_versions, public.ai_workspace_consents, public.ai_provider_settings,
  public.ai_workspace_budgets, public.ai_layout_assist_runs TO service_role;
CREATE POLICY aicv_read ON public.ai_consent_versions FOR SELECT TO authenticated USING (true);
CREATE POLICY aiwc_workspace_read ON public.ai_workspace_consents FOR SELECT TO authenticated USING (public.can_access_workspace(company_id));
CREATE POLICY aiwb_workspace_read ON public.ai_workspace_budgets FOR SELECT TO authenticated USING (public.can_access_workspace(company_id));
CREATE POLICY ailar_workspace_read ON public.ai_layout_assist_runs FOR SELECT TO authenticated USING (public.can_access_workspace(company_id));

REVOKE ALL ON FUNCTION public.ai_append_only_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_consent_versions_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_layout_assist_runs_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_workspace_consent_current(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_workspace_consent_current(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ai_set_workspace_consent(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_set_workspace_consent(uuid, text, boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.ai_configure_provider(boolean, text, text, text, bigint, timestamptz, timestamptz) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ai_configure_provider(boolean, text, text, text, bigint, timestamptz, timestamptz) TO authenticated;
REVOKE ALL ON FUNCTION public.ai_set_workspace_budget(uuid, bigint, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ai_set_workspace_budget(uuid, bigint, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.ai_layout_assist_reserve(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_layout_assist_reserve(uuid, uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.ai_layout_assist_complete(uuid, text, bigint, jsonb, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_layout_assist_complete(uuid, text, bigint, jsonb, text, jsonb, text) TO service_role;
