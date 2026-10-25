-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261203100000 — Internal beta: activation controls for a signed-in commercial administrator.
--
-- Builds on 20261202100000 (internal_beta_policy) and 20260919100000 (reporting rollout). Before this migration the
-- activation could not be completed from a normal administrator account:
--   • internal_beta_configure needs the policy's current revision, and no administrator could read it;
--   • the reporting master switch (fs_set_kill_switch) and the company allowlist (fs_set_company_rollout) are
--     service-role operator controls only;
--   • recording an approved synthetic composition for the assistant (internal_beta_record_synthetic_context) is
--     service-role only.
--
-- This migration adds FIVE functions, each executable by `authenticated` only and each refusing anybody who is not an
-- ACTIVE commercial administrator (commercial_admins.active) — the same predicate internal_beta_configure already uses.
-- Nothing else is granted. Every change writes the same append-only audit rows the operator functions write
-- (financial_statements_rollout_audit, operator_label 'commercial-admin:<user id>') plus an internal_beta_events row.
--
--   internal_beta_admin_overview()                       read: policy (incl. revision), master switch, companies with
--                                                        their allowlist state, enrolled members and synthetic scopes,
--                                                        spend, recent events. Read-only.
--   internal_beta_admin_open_reporting(ids, reason, rev)  ONE transaction, in the documented order: the allowlist is made
--                                                        EXACTLY `ids` (every other enabled company is disabled), every
--                                                        listed company must have an enrolled member with workspace
--                                                        access, beta reporting is switched on, and the master switch is
--                                                        released LAST. Optimistic revision check (PT409).
--   internal_beta_admin_close_reporting(reason)           ONE transaction: the master switch is engaged FIRST, then beta
--                                                        reporting is switched off and every allowlisted company is
--                                                        disabled. No revision is required: closing is always safe.
--                                                        It stops access; it does not roll back committed records.
--   internal_beta_admin_stop_ai(reason)                   switches assistant spending off. No revision required.
--   internal_beta_admin_record_synthetic_context(company, year, reason)
--                                                        records the composition hash the DATABASE computes for that
--                                                        company and year, read as the administrator (who must be able
--                                                        to read it). The administrator attests in the reason that the
--                                                        data is synthetic; no hash is accepted from the browser.
--
-- Switching assistant spending ON stays internal_beta_configure (unchanged): it requires the model, dated prices, a
-- reservation covering two calls and the credit and pricing confirmations. Nothing here changes a capability, a
-- financial record, a sign-off or approval rule, the reservation/budget logic or the production assistant settings.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $preflight$
BEGIN
  IF to_regclass('public.internal_beta_policy') IS NULL OR to_regclass('public.financial_statements_rollout_state') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: internal beta policy and reporting rollout must be installed first';
  END IF;
  IF to_regprocedure('public.internal_beta_admin_overview()') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: internal beta activation controls are already installed';
  END IF;
END;
$preflight$;

-- The one authority check. Internal: callable only from the functions below.
CREATE FUNCTION public._internal_beta_require_admin()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  RETURN auth.uid();
END;
$$;
REVOKE ALL ON FUNCTION public._internal_beta_require_admin() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.internal_beta_admin_overview()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_admin uuid := public._internal_beta_require_admin();
  p public.internal_beta_policy%ROWTYPE;
  v_spent bigint;
  v_open_runs integer;
  v_kill boolean;
BEGIN
  SELECT * INTO p FROM public.internal_beta_policy WHERE singleton;
  SELECT coalesce(sum(coalesce(actual_cost_micros, reserved_cost_micros)), 0), count(*) FILTER (WHERE state = 'reserved')
    INTO v_spent, v_open_runs FROM public.internal_beta_assistant_runs;
  SELECT kill_switch INTO v_kill FROM public.financial_statements_rollout_state WHERE singleton;
  RETURN jsonb_build_object(
    'contract', 'internal-beta-admin-overview/1',
    'policy', jsonb_build_object('revision', p.revision, 'reportingEnabled', p.reporting_enabled, 'aiEnabled', p.ai_enabled,
      'model', p.model, 'prices', p.prices, 'reservationMicros', p.reservation_micros,
      'creditsConfirmedAt', p.credits_confirmed_at, 'pricingConfirmedAt', p.pricing_confirmed_at,
      'maxInputTokens', p.max_input_tokens, 'maxOutputTokens', p.max_output_tokens, 'maxRequestSeconds', p.max_request_seconds,
      'totalBudgetMicros', p.total_budget_micros, 'priorUsageReservedMicros', p.prior_usage_reserved_micros,
      'spentMicros', v_spent, 'openRuns', v_open_runs,
      'remainingMicros', greatest(0, p.total_budget_micros - p.prior_usage_reserved_micros - v_spent)),
    -- NULL (no state row) is reported as engaged: an unknown switch is never presented as released.
    'masterSwitchEngaged', coalesce(v_kill, true),
    'reportingOpen', coalesce(NOT v_kill, false) AND p.reporting_enabled,
    'companies', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
          'companyId', c.id, 'name', c.name,
          'allowlisted', coalesce(r.enabled, false),
          'enrolledMembers', (SELECT count(*) FROM public.internal_beta_enrollments e
                               WHERE e.company_id = c.id AND e.revoked_at IS NULL AND public.internal_beta_member(e.user_id, c.id)),
          'syntheticScopes', coalesce((SELECT jsonb_agg(jsonb_build_object('periodYear', s.period_year, 'compositionSha256', s.composition_sha256,
                                         'recordedAt', s.recorded_at) ORDER BY s.recorded_at)
                               FROM public.internal_beta_synthetic_contexts s WHERE s.company_id = c.id), '[]'::jsonb))
        ORDER BY coalesce(r.enabled, false) DESC, c.name, c.id)
      FROM (SELECT * FROM public.companies ORDER BY name, id LIMIT 500) c
      LEFT JOIN public.financial_statements_rollout_companies r ON r.company_id = c.id), '[]'::jsonb),
    'events', coalesce((SELECT jsonb_agg(jsonb_build_object('action', x.action, 'reason', x.reason, 'at', x.at, 'actorUserId', x.actor_user_id) ORDER BY x.seq DESC)
      FROM (SELECT * FROM public.internal_beta_events ORDER BY seq DESC LIMIT 20) x), '[]'::jsonb),
    'rolloutAudit', coalesce((SELECT jsonb_agg(jsonb_build_object('scope', a.scope, 'companyId', a.company_id, 'previousState', a.previous_state,
        'newState', a.new_state, 'reason', a.reason, 'operator', a.operator_label, 'at', a.created_at) ORDER BY a.seq DESC)
      FROM (SELECT * FROM public.financial_statements_rollout_audit ORDER BY seq DESC LIMIT 20) a), '[]'::jsonb));
END;
$$;

CREATE FUNCTION public.internal_beta_admin_open_reporting(p_company_ids uuid[], p_reason text, p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_admin uuid := public._internal_beta_require_admin();
  v_label text := 'commercial-admin:' || v_admin::text;
  v_ids uuid[];
  v_id uuid;
  v_prev boolean;
  p public.internal_beta_policy%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 OR p_expected_revision IS NULL
     OR p_company_ids IS NULL OR cardinality(p_company_ids) = 0 OR array_position(p_company_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids FROM unnest(p_company_ids) x;
  IF cardinality(v_ids) > 25 THEN RAISE EXCEPTION 'INVALID_REQUEST: at most 25 companies' USING ERRCODE = '22023'; END IF;

  -- Lock order: beta policy → each listed or currently enabled company (sorted) → master switch.
  PERFORM pg_advisory_xact_lock(hashtextextended('internal_beta_aggregate_budget', 0));
  SELECT * INTO p FROM public.internal_beta_policy WHERE singleton FOR UPDATE;
  IF p.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = 'PT409', DETAIL = format('current revision %s', p.revision);
  END IF;
  FOR v_id IN SELECT DISTINCT c FROM (SELECT unnest(v_ids) c UNION SELECT company_id FROM public.financial_statements_rollout_companies WHERE enabled) u ORDER BY c LOOP
    PERFORM pg_advisory_xact_lock(hashtext('financial_statements_rollout:' || v_id::text));
  END LOOP;
  PERFORM pg_advisory_xact_lock(hashtext('financial_statements_rollout:kill_switch'));

  FOREACH v_id IN ARRAY v_ids LOOP
    IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = v_id) THEN
      RAISE EXCEPTION 'COMPANY_NOT_FOUND' USING ERRCODE = 'P0002', DETAIL = v_id::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.internal_beta_enrollments e WHERE e.company_id = v_id AND e.revoked_at IS NULL
                   AND public.internal_beta_member(e.user_id, v_id)) THEN
      RAISE EXCEPTION 'COMPANY_HAS_NO_ENROLLED_MEMBER' USING ERRCODE = 'PT422', DETAIL = v_id::text;
    END IF;
  END LOOP;

  -- 1. The allowlist becomes EXACTLY the listed companies (audited per change).
  FOR v_id IN SELECT company_id FROM public.financial_statements_rollout_companies WHERE enabled AND NOT (company_id = ANY (v_ids)) ORDER BY company_id LOOP
    UPDATE public.financial_statements_rollout_companies SET enabled = false, updated_at = now() WHERE company_id = v_id;
    INSERT INTO public.financial_statements_rollout_audit (scope, company_id, previous_state, new_state, reason, operator_label)
      VALUES ('COMPANY', v_id, true, false, p_reason, v_label);
  END LOOP;
  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT enabled INTO v_prev FROM public.financial_statements_rollout_companies WHERE company_id = v_id;
    IF v_prev IS DISTINCT FROM true THEN
      INSERT INTO public.financial_statements_rollout_companies (company_id, enabled, updated_at) VALUES (v_id, true, now())
        ON CONFLICT (company_id) DO UPDATE SET enabled = true, updated_at = now();
      INSERT INTO public.financial_statements_rollout_audit (scope, company_id, previous_state, new_state, reason, operator_label)
        VALUES ('COMPANY', v_id, v_prev, true, p_reason, v_label);
    END IF;
  END LOOP;

  -- 2. Beta reporting on (the enrollment requirement then applies to every reporting read).
  UPDATE public.internal_beta_policy SET reporting_enabled = true, revision = revision + 1 WHERE singleton;
  INSERT INTO public.internal_beta_events (actor_user_id, action, reason, detail)
    VALUES (v_admin, 'OPEN_REPORTING', p_reason, jsonb_build_object('companyIds', to_jsonb(v_ids)));

  -- 3. The master switch is released LAST.
  SELECT kill_switch INTO v_prev FROM public.financial_statements_rollout_state WHERE singleton;
  IF v_prev IS DISTINCT FROM false THEN
    UPDATE public.financial_statements_rollout_state SET kill_switch = false, updated_at = now() WHERE singleton;
    IF NOT FOUND THEN RAISE EXCEPTION 'ROLLOUT_STATE_MISSING' USING ERRCODE = '55000'; END IF;
    INSERT INTO public.financial_statements_rollout_audit (scope, company_id, previous_state, new_state, reason, operator_label)
      VALUES ('KILL_SWITCH', NULL, v_prev, false, p_reason, v_label);
  END IF;
  RETURN jsonb_build_object('outcome', 'opened', 'revision', p.revision + 1, 'companyIds', to_jsonb(v_ids));
END;
$$;

CREATE FUNCTION public.internal_beta_admin_close_reporting(p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_admin uuid := public._internal_beta_require_admin();
  v_label text := 'commercial-admin:' || v_admin::text;
  v_prev boolean;
  v_id uuid;
  v_rev bigint;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023'; END IF;
  -- Lock order shared with opening (beta policy before the master switch), so the two can never deadlock; the operator
  -- functions each take a single one of these locks.
  PERFORM pg_advisory_xact_lock(hashtextextended('internal_beta_aggregate_budget', 0));
  PERFORM pg_advisory_xact_lock(hashtext('financial_statements_rollout:kill_switch'));
  -- 1. The master switch is engaged FIRST.
  SELECT kill_switch INTO v_prev FROM public.financial_statements_rollout_state WHERE singleton;
  IF v_prev IS DISTINCT FROM true THEN
    UPDATE public.financial_statements_rollout_state SET kill_switch = true, updated_at = now() WHERE singleton;
    INSERT INTO public.financial_statements_rollout_audit (scope, company_id, previous_state, new_state, reason, operator_label)
      VALUES ('KILL_SWITCH', NULL, v_prev, true, p_reason, v_label);
  END IF;
  -- 2. Beta reporting off.
  UPDATE public.internal_beta_policy SET reporting_enabled = false, revision = revision + 1 WHERE singleton RETURNING revision INTO v_rev;
  INSERT INTO public.internal_beta_events (actor_user_id, action, reason, detail)
    VALUES (v_admin, 'CLOSE_REPORTING', p_reason, '{}'::jsonb);
  -- 3. Every allowlisted company is disabled (audited per change).
  FOR v_id IN SELECT company_id FROM public.financial_statements_rollout_companies WHERE enabled ORDER BY company_id LOOP
    PERFORM pg_advisory_xact_lock(hashtext('financial_statements_rollout:' || v_id::text));
    UPDATE public.financial_statements_rollout_companies SET enabled = false, updated_at = now() WHERE company_id = v_id AND enabled;
    IF FOUND THEN
      INSERT INTO public.financial_statements_rollout_audit (scope, company_id, previous_state, new_state, reason, operator_label)
        VALUES ('COMPANY', v_id, true, false, p_reason, v_label);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('outcome', 'closed', 'revision', v_rev);
END;
$$;

CREATE FUNCTION public.internal_beta_admin_stop_ai(p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_admin uuid := public._internal_beta_require_admin();
  v_rev bigint;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('internal_beta_aggregate_budget', 0));
  UPDATE public.internal_beta_policy SET ai_enabled = false, revision = revision + 1 WHERE singleton RETURNING revision INTO v_rev;
  INSERT INTO public.internal_beta_events (actor_user_id, action, reason, detail) VALUES (v_admin, 'STOP_AI', p_reason, '{}'::jsonb);
  RETURN jsonb_build_object('outcome', 'stopped', 'revision', v_rev);
END;
$$;

CREATE FUNCTION public.internal_beta_admin_record_synthetic_context(p_company_id uuid, p_period_year integer, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_admin uuid := public._internal_beta_require_admin();
  v_comp jsonb;
  v_sha text;
BEGIN
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_period_year NOT BETWEEN 2000 AND 2100
     OR p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  -- Read AS THE ADMINISTRATOR (auth.uid() is unchanged inside this function): what they cannot read is not recorded.
  v_comp := public.fs_statement_composition(p_company_id, p_period_year);
  v_sha := v_comp ->> 'compositionSha256';
  IF v_comp ->> 'state' IS DISTINCT FROM 'composed' OR v_sha IS NULL OR v_sha !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'COMPOSITION_NOT_AVAILABLE' USING ERRCODE = 'PT422', DETAIL = coalesce(v_comp ->> 'state', 'unknown');
  END IF;
  INSERT INTO public.internal_beta_synthetic_contexts (company_id, period_year, composition_sha256, reason, operator_label)
    VALUES (p_company_id, p_period_year, v_sha, p_reason, 'commercial-admin:' || v_admin::text) ON CONFLICT DO NOTHING;
  INSERT INTO public.internal_beta_events (actor_user_id, action, reason, detail)
    VALUES (v_admin, 'RECORD_SYNTHETIC_CONTEXT', p_reason,
            jsonb_build_object('companyId', p_company_id, 'periodYear', p_period_year, 'compositionSha256', v_sha));
  RETURN jsonb_build_object('outcome', 'recorded', 'compositionSha256', v_sha);
END;
$$;

REVOKE ALL ON FUNCTION public.internal_beta_admin_overview() FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.internal_beta_admin_open_reporting(uuid[], text, bigint) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.internal_beta_admin_close_reporting(text) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.internal_beta_admin_stop_ai(text) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.internal_beta_admin_record_synthetic_context(uuid, integer, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.internal_beta_admin_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.internal_beta_admin_open_reporting(uuid[], text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.internal_beta_admin_close_reporting(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.internal_beta_admin_stop_ai(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.internal_beta_admin_record_synthetic_context(uuid, integer, text) TO authenticated;

DO $postcondition$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.internal_beta_admin_overview()', 'public.internal_beta_admin_open_reporting(uuid[],text,bigint)',
    'public.internal_beta_admin_close_reporting(text)', 'public.internal_beta_admin_stop_ai(text)',
    'public.internal_beta_admin_record_synthetic_context(uuid,integer,text)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('service_role', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION_FAILED: privileges of %', f;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public._internal_beta_require_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: the internal authority check is callable';
  END IF;
  -- Installing this changes no state: beta reporting and AI stay as they were (off on a fresh install).
END;
$postcondition$;
