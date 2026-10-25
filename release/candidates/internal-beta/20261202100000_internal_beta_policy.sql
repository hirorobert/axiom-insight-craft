-- INERT CANDIDATE: must become an authored supabase/migrations source before hosted submission.
-- INTERNAL_BETA is not production evaluation or data-handling approval.
DO $preflight$
BEGIN
  IF to_regclass('public.internal_beta_policy') IS NOT NULL THEN RAISE EXCEPTION 'BETA_ALREADY_INSTALLED'; END IF;
  IF to_regclass('public.ai_assistant_settings') IS NULL THEN RAISE EXCEPTION 'ASSISTANT_CONTROLS_REQUIRED'; END IF;
END;
$preflight$;

CREATE TABLE public.internal_beta_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  channel text NOT NULL DEFAULT 'INTERNAL_BETA' CHECK(channel='INTERNAL_BETA'),
  reporting_enabled boolean NOT NULL DEFAULT false,
  ai_enabled boolean NOT NULL DEFAULT false,
  total_budget_micros bigint NOT NULL DEFAULT 5000000 CHECK(total_budget_micros=5000000),
  prior_usage_reserved_micros bigint NOT NULL DEFAULT 1341400 CHECK(prior_usage_reserved_micros>=1341400),
  model text, prices jsonb, reservation_micros bigint CHECK(reservation_micros>0),
  max_input_tokens integer NOT NULL DEFAULT 20000 CHECK(max_input_tokens BETWEEN 1000 AND 20000),
  max_output_tokens integer NOT NULL DEFAULT 1200 CHECK(max_output_tokens BETWEEN 200 AND 1200),
  max_request_seconds integer NOT NULL DEFAULT 30 CHECK(max_request_seconds BETWEEN 10 AND 30),
  credits_confirmed_at timestamptz, pricing_confirmed_at timestamptz,
  revision bigint NOT NULL DEFAULT 1,
  CHECK(NOT ai_enabled OR (model IS NOT NULL AND prices IS NOT NULL AND reservation_micros IS NOT NULL
    AND credits_confirmed_at IS NOT NULL AND pricing_confirmed_at IS NOT NULL))
);
GRANT SELECT ON public.internal_beta_policy TO service_role;
ALTER TABLE public.internal_beta_policy ENABLE ROW LEVEL SECURITY;
INSERT INTO public.internal_beta_policy(singleton) VALUES(true);

CREATE TABLE public.internal_beta_enrollments (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  basis text NOT NULL CHECK(basis IN('existing_owner','existing_accepted_member','owner_enrolled_member')),
  enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz,
  PRIMARY KEY(company_id,user_id)
);
GRANT SELECT ON public.internal_beta_enrollments TO service_role;
ALTER TABLE public.internal_beta_enrollments ENABLE ROW LEVEL SECURITY;
INSERT INTO public.internal_beta_enrollments(company_id,user_id,basis)
SELECT id,user_id,'existing_owner' FROM public.companies WHERE user_id IS NOT NULL;
INSERT INTO public.internal_beta_enrollments(company_id,user_id,basis)
SELECT company_id,user_id,'existing_accepted_member' FROM public.firm_members
WHERE accepted_at IS NOT NULL AND company_id IS NOT NULL AND user_id IS NOT NULL ON CONFLICT DO NOTHING;

CREATE TABLE public.internal_beta_synthetic_contexts (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  period_year integer NOT NULL CHECK(period_year BETWEEN 2000 AND 2100),
  composition_sha256 text NOT NULL CHECK(composition_sha256 ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK(length(btrim(reason))>=10), operator_label text NOT NULL CHECK(length(btrim(operator_label))>=2),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,period_year,composition_sha256)
);
GRANT SELECT ON public.internal_beta_synthetic_contexts TO service_role;
ALTER TABLE public.internal_beta_synthetic_contexts ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER beta_synthetic_immutable BEFORE UPDATE OR DELETE ON public.internal_beta_synthetic_contexts
FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();

CREATE TABLE public.internal_beta_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_user_id uuid NOT NULL,
  action text NOT NULL, reason text NOT NULL CHECK(length(btrim(reason))>=10), detail jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);
GRANT SELECT ON public.internal_beta_events TO service_role;
ALTER TABLE public.internal_beta_events ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER beta_events_immutable BEFORE UPDATE OR DELETE ON public.internal_beta_events
FOR EACH ROW EXECUTE FUNCTION public.ai_append_only_guard();

CREATE TABLE public.internal_beta_assistant_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id uuid NOT NULL, request_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  period_year integer NOT NULL CHECK(period_year BETWEEN 2000 AND 2100),
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
  composition_sha256 text NOT NULL CHECK(composition_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN('reserved','succeeded','invalid','stale','rejected','failed','ambiguous','expired')),
  reserved_cost_micros bigint NOT NULL CHECK(reserved_cost_micros>0), actual_cost_micros bigint CHECK(actual_cost_micros>=0),
  cost_known boolean NOT NULL DEFAULT false, model text NOT NULL, prices jsonb NOT NULL,
  response jsonb, usage jsonb, validation jsonb, failure_code text, attempts integer CHECK(attempts BETWEEN 0 AND 2),
  duration_ms integer CHECK(duration_ms>=0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  UNIQUE(actor_user_id,request_id), CHECK(response IS NULL OR state='succeeded'),
  CHECK((state='reserved')=(completed_at IS NULL))
);
GRANT SELECT ON public.internal_beta_assistant_runs TO service_role;
ALTER TABLE public.internal_beta_assistant_runs ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.internal_beta_runs_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'UPDATE' OR OLD.state<>'reserved'
    OR (to_jsonb(NEW)-ARRAY['state','actual_cost_micros','cost_known','response','usage','validation','failure_code','attempts','duration_ms','completed_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','actual_cost_micros','cost_known','response','usage','validation','failure_code','attempts','duration_ms','completed_at']) THEN
    RAISE EXCEPTION 'BETA_RUN_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER beta_runs_immutable BEFORE UPDATE OR DELETE ON public.internal_beta_assistant_runs
FOR EACH ROW EXECUTE FUNCTION public.internal_beta_runs_guard();
REVOKE ALL ON FUNCTION public.internal_beta_runs_guard() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.internal_beta_member(p_user_id uuid,p_company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.internal_beta_enrollments e WHERE e.user_id=p_user_id AND e.company_id=p_company_id AND e.revoked_at IS NULL)
    AND public._workspace_access_basis(p_user_id,p_company_id) IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.internal_beta_member(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.internal_beta_member(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fs_rollout_allows(p_company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT coalesce((SELECT NOT kill_switch FROM public.financial_statements_rollout_state WHERE singleton),false)
    AND coalesce((SELECT enabled FROM public.financial_statements_rollout_companies WHERE company_id=p_company_id),false)
    AND coalesce((SELECT reporting_enabled FROM public.internal_beta_policy WHERE singleton),false)
    AND EXISTS(SELECT 1 FROM public.internal_beta_enrollments WHERE company_id=p_company_id AND revoked_at IS NULL)
    AND (auth.uid() IS NULL OR public.internal_beta_member(auth.uid(),p_company_id));
$$;
REVOKE ALL ON FUNCTION public.fs_rollout_allows(uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.internal_beta_status(p_company_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.internal_beta_policy%ROWTYPE; spent bigint;
BEGIN
  IF NOT public.internal_beta_member(auth.uid(),p_company_id) THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  SELECT * INTO p FROM public.internal_beta_policy WHERE singleton;
  SELECT coalesce(sum(coalesce(actual_cost_micros,reserved_cost_micros)),0) INTO spent FROM public.internal_beta_assistant_runs;
  RETURN jsonb_build_object('channel','INTERNAL_BETA','reportingEnabled',p.reporting_enabled,
    'state',CASE WHEN NOT p.ai_enabled THEN 'disabled'
      WHEN p.prior_usage_reserved_micros+spent+coalesce(p.reservation_micros,0)>p.total_budget_micros THEN 'no_budget'
      WHEN NOT EXISTS(SELECT 1 FROM public.internal_beta_synthetic_contexts WHERE company_id=p_company_id) THEN 'synthetic_scope_required'
      ELSE 'available' END,'remainingMicros',greatest(0,p.total_budget_micros-p.prior_usage_reserved_micros-spent));
END;
$$;
REVOKE ALL ON FUNCTION public.internal_beta_status(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.internal_beta_status(uuid) TO authenticated;

-- Normal account holder explicitly enrolls an already accepted member; enrollment does not grant a capability.
CREATE FUNCTION public.internal_beta_enroll_member(p_company_id uuid,p_user_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.internal_beta_member(auth.uid(),p_company_id)
    OR NOT public.has_workspace_capability(p_company_id,auth.uid(),'manage_members') THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason))<10 OR NOT EXISTS(SELECT 1 FROM public.firm_members
    WHERE company_id=p_company_id AND user_id=p_user_id AND accepted_at IS NOT NULL) THEN RAISE EXCEPTION 'ACCEPTED_MEMBER_REQUIRED'; END IF;
  INSERT INTO public.internal_beta_enrollments(company_id,user_id,basis) VALUES(p_company_id,p_user_id,'owner_enrolled_member') ON CONFLICT DO NOTHING;
  INSERT INTO public.internal_beta_events(actor_user_id,action,reason,detail)
    VALUES(auth.uid(),'ENROLL_MEMBER',p_reason,jsonb_build_object('companyId',p_company_id,'userId',p_user_id));
  RETURN jsonb_build_object('outcome','recorded');
END;
$$;
REVOKE ALL ON FUNCTION public.internal_beta_enroll_member(uuid,uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.internal_beta_enroll_member(uuid,uuid,text) TO authenticated;

CREATE FUNCTION public.internal_beta_configure(p_settings jsonb,p_reason text,p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.internal_beta_policy%ROWTYPE; rate numeric; k text; v numeric; ai boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.commercial_admins WHERE user_id=auth.uid() AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE='42501'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason))<10 OR jsonb_typeof(p_settings) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('internal_beta_aggregate_budget',0));
  SELECT * INTO p FROM public.internal_beta_policy WHERE singleton FOR UPDATE;
  IF p.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='PT409'; END IF;
  ai:=coalesce((p_settings->>'aiEnabled')::boolean,false);
  IF ai THEN
    FOREACH k IN ARRAY ARRAY['inputMicrosPerMTok','outputMicrosPerMTok','cacheWriteMicrosPerMTok','cacheReadMicrosPerMTok'] LOOP
      v:=(p_settings->'prices'->>k)::numeric;
      IF v IS NULL OR v<=0 OR v<>trunc(v) OR v>100000000 THEN RAISE EXCEPTION 'INVALID_PRICES'; END IF;
    END LOOP;
    rate:=greatest((p_settings->'prices'->>'inputMicrosPerMTok')::numeric,(p_settings->'prices'->>'cacheWriteMicrosPerMTok')::numeric);
    IF (p_settings->>'reservationMicros')::bigint IS NULL OR (p_settings->>'reservationMicros')::bigint < 2*ceil(
      (p.max_input_tokens*rate+p.max_output_tokens*(p_settings->'prices'->>'outputMicrosPerMTok')::numeric)/1000000) THEN
      RAISE EXCEPTION 'RESERVATION_UNDERFUNDED'; END IF;
    IF p_settings->>'creditsConfirmedAt' IS NULL OR p_settings->>'pricingConfirmedAt' IS NULL THEN RAISE EXCEPTION 'CREDITS_PRICING_REQUIRED'; END IF;
  END IF;
  UPDATE public.internal_beta_policy SET reporting_enabled=coalesce((p_settings->>'reportingEnabled')::boolean,p.reporting_enabled),
    ai_enabled=ai,model=p_settings->>'model',prices=p_settings->'prices',reservation_micros=(p_settings->>'reservationMicros')::bigint,
    credits_confirmed_at=(p_settings->>'creditsConfirmedAt')::timestamptz,pricing_confirmed_at=(p_settings->>'pricingConfirmedAt')::timestamptz,
    revision=revision+1 WHERE singleton;
  INSERT INTO public.internal_beta_events(actor_user_id,action,reason,detail) VALUES(auth.uid(),'CONFIGURE',p_reason,p_settings);
  RETURN jsonb_build_object('revision',p.revision+1,'aiEnabled',ai);
END;
$$;
REVOKE ALL ON FUNCTION public.internal_beta_configure(jsonb,text,bigint) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.internal_beta_configure(jsonb,text,bigint) TO authenticated;

CREATE FUNCTION public.internal_beta_record_synthetic_context(p_company_id uuid,p_period_year integer,p_composition_sha256 text,p_reason text,p_operator_label text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  INSERT INTO public.internal_beta_synthetic_contexts(company_id,period_year,composition_sha256,reason,operator_label)
    VALUES(p_company_id,p_period_year,p_composition_sha256,p_reason,p_operator_label) ON CONFLICT DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.internal_beta_record_synthetic_context(uuid,integer,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.internal_beta_record_synthetic_context(uuid,integer,text,text,text) TO service_role;

CREATE FUNCTION public.internal_beta_assistant_reserve(p_user_id uuid,p_company_id uuid,p_period_year integer,p_line_id text,
  p_action text,p_request_id uuid,p_payload_sha256 text,p_context_sha256 text,p_composition_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.internal_beta_policy%ROWTYPE; r public.internal_beta_assistant_runs%ROWTYPE; spent bigint;
BEGIN
  IF NOT public.internal_beta_member(p_user_id,p_company_id) OR NOT public.fs_rollout_allows(p_company_id) THEN
    RETURN jsonb_build_object('outcome','refused','code','FORBIDDEN'); END IF;
  IF p_request_id IS NULL OR p_action IS NULL OR p_action NOT IN('explain_movement','draft_commentary')
    OR p_period_year IS NULL OR p_period_year NOT BETWEEN 2000 AND 2100
    OR p_line_id IS NULL OR p_line_id !~ '^[a-z0-9_.]{1,200}$'
    OR p_payload_sha256 IS NULL OR p_payload_sha256 !~ '^[0-9a-f]{64}$'
    OR p_context_sha256 IS NULL OR p_context_sha256 !~ '^[0-9a-f]{64}$'
    OR p_composition_sha256 IS NULL OR p_composition_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('outcome','refused','code','INVALID_REQUEST'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('internal_beta_aggregate_budget',0));
  SELECT * INTO p FROM public.internal_beta_policy WHERE singleton;
  UPDATE public.internal_beta_assistant_runs SET state='expired',completed_at=clock_timestamp(),failure_code='EXPIRED_UNCONFIRMED'
    WHERE state='reserved' AND created_at<clock_timestamp()-make_interval(secs=>2*p.max_request_seconds);
  SELECT * INTO r FROM public.internal_beta_assistant_runs WHERE actor_user_id=p_user_id AND request_id=p_request_id;
  IF r.id IS NOT NULL THEN
    IF r.company_id<>p_company_id OR r.payload_sha256<>p_payload_sha256 THEN
      RETURN jsonb_build_object('outcome','refused','code','REQUEST_ID_REUSED'); END IF;
    RETURN jsonb_build_object('outcome','replay','runId',r.id,'state',r.state,'response',r.response,'compositionSha256',r.composition_sha256,'purged',false);
  END IF;
  IF NOT p.ai_enabled THEN RETURN jsonb_build_object('outcome','refused','code','PROVIDER_DISABLED'); END IF;
  IF NOT EXISTS(SELECT 1 FROM public.internal_beta_synthetic_contexts WHERE company_id=p_company_id AND period_year=p_period_year
    AND composition_sha256=p_composition_sha256) THEN RETURN jsonb_build_object('outcome','refused','code','SYNTHETIC_SCOPE_REQUIRED'); END IF;
  SELECT coalesce(sum(coalesce(actual_cost_micros,reserved_cost_micros)),0) INTO spent FROM public.internal_beta_assistant_runs;
  IF p.prior_usage_reserved_micros+spent+p.reservation_micros>p.total_budget_micros
    OR EXISTS(SELECT 1 FROM public.internal_beta_assistant_runs WHERE actual_cost_micros>reserved_cost_micros) THEN
    RETURN jsonb_build_object('outcome','refused','code','AI_BUDGET_EXCEEDED'); END IF;
  IF EXISTS(SELECT 1 FROM public.internal_beta_assistant_runs WHERE state='reserved') THEN RETURN jsonb_build_object('outcome','refused','code','CONCURRENCY_LIMIT'); END IF;
  IF (SELECT count(*) FROM public.internal_beta_assistant_runs WHERE actor_user_id=p_user_id AND created_at>=date_trunc('day',now()))>=20 THEN
    RETURN jsonb_build_object('outcome','refused','code','QUOTA_EXCEEDED'); END IF;
  INSERT INTO public.internal_beta_assistant_runs(actor_user_id,request_id,company_id,period_year,payload_sha256,composition_sha256,reserved_cost_micros,model,prices)
    VALUES(p_user_id,p_request_id,p_company_id,p_period_year,p_payload_sha256,p_composition_sha256,p.reservation_micros,p.model,p.prices) RETURNING * INTO r;
  RETURN jsonb_build_object('outcome','reserved','runId',r.id,'model',p.model,'maxInputTokens',p.max_input_tokens,'maxOutputTokens',p.max_output_tokens,
    'maxRequestSeconds',p.max_request_seconds,'prices',p.prices);
END;
$$;
REVOKE ALL ON FUNCTION public.internal_beta_assistant_reserve(uuid,uuid,integer,text,text,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.internal_beta_assistant_reserve(uuid,uuid,integer,text,text,uuid,text,text,text) TO service_role;

CREATE FUNCTION public.internal_beta_assistant_complete(p_run_id uuid,p_state text,p_actual_cost_micros bigint,p_usage jsonb,
  p_attempts integer,p_duration_ms integer,p_response jsonb,p_source_refs text[],p_validation jsonb,p_failure_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.internal_beta_assistant_runs%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('internal_beta_aggregate_budget',0));
  SELECT * INTO r FROM public.internal_beta_assistant_runs WHERE id=p_run_id FOR UPDATE;
  IF r.id IS NULL OR r.state<>'reserved' THEN RETURN jsonb_build_object('outcome','already_completed'); END IF;
  IF p_state IS NULL OR p_state NOT IN('succeeded','invalid','stale','rejected','failed','ambiguous')
    OR (p_state='succeeded')<>(p_response IS NOT NULL) OR p_actual_cost_micros<0 THEN RETURN jsonb_build_object('outcome','refused','code','INVALID_REQUEST'); END IF;
  UPDATE public.internal_beta_assistant_runs SET state=p_state,actual_cost_micros=coalesce(p_actual_cost_micros,r.reserved_cost_micros),
    cost_known=p_actual_cost_micros IS NOT NULL,response=p_response,usage=p_usage,validation=p_validation,failure_code=p_failure_code,
    attempts=p_attempts,duration_ms=p_duration_ms,completed_at=clock_timestamp() WHERE id=p_run_id;
  RETURN jsonb_build_object('outcome','completed');
END;
$$;
REVOKE ALL ON FUNCTION public.internal_beta_assistant_complete(uuid,text,bigint,jsonb,integer,integer,jsonb,text[],jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.internal_beta_assistant_complete(uuid,text,bigint,jsonb,integer,integer,jsonb,text[],jsonb,text) TO service_role;

DO $postcondition$
BEGIN
  IF (SELECT ai_enabled OR reporting_enabled FROM public.internal_beta_policy WHERE singleton)
    OR has_table_privilege('authenticated','public.internal_beta_assistant_runs','INSERT,UPDATE,DELETE')
    OR has_function_privilege('authenticated','public.internal_beta_assistant_reserve(uuid,uuid,integer,text,text,uuid,text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'BETA_POSTCONDITION_FAILED'; END IF;
END;
$postcondition$;