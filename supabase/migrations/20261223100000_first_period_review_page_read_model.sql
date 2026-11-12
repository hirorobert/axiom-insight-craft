-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261223100000 — The first-period review PAGE's read model and the approver's binding guard (defect S2-A03, the part of PR #269
-- that PR #256's 20261217100000 does not contain). AUTHORED, NOT APPLIED to any hosted database. Forward-only; builds on
-- 20261217100000 (the first-period governed review, PR #256), which creates every table and function this file changes.
--
--   WHY A DELTA: PR #269 ports 20261217100000 onto main as a standalone file (20261223100000_first_period_governed_review_standalone.sql);
--   the two cannot both apply (each preflight refuses when the other's objects exist). With the Ready for Reporting stack
--   (#255 -> #256 -> #257 -> #259) landing first, 20261217100000 is the one that installs the review; what #269 adds beyond it
--   is exactly three function definitions, copied here byte for byte from #269's file:
--     1. fs_decide_first_period gains p_expected_binding (default NULL): when the server's binding for the subject has moved
--        since the approver's page was read (a newer claim, new or retracted evidence, a changed company or period), nothing is
--        recorded (outcome changed_since_viewed). A consistency guard for the page; who may decide is unchanged.
--     2. _fs_fp_review_view (new, not client-callable): the latest claim, decision and cited revisions of one subject, with
--        recordedByYou / decidedByYou relative to the caller.
--     3. fs_first_period_status additionally returns the entity, the server's reporting dates, the current evidence revisions and,
--        per subject, the claim, decision, cited revisions and the binding a decision taken now would carry.
--   Nothing else of 20261217100000 changes: no table, no column, no other RPC, no blockers splice, no row.
--
--   SIGNATURE: the old six-argument fs_decide_first_period is DROPPED (a seven-argument function with a default beside it would
--   make a six-argument call ambiguous); the new one carries the same grants (authenticated only; anon refused).
--
-- PREFLIGHT: 20261217100000 is installed (its tables and the six-argument decide function exist) and this file is not. Refused
-- with PREFLIGHT_REFUSED otherwise (nothing changed). POSTCONDITION: the seven-argument function exists and is the only decide
-- function, the view helper is not client-callable, the status function carries the new keys, grants are as before, and no claim
-- or decision row was created or changed by this file.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
BEGIN
  IF to_regprocedure('public.fs_decide_first_period(uuid, integer, text, boolean, text, uuid, text)') IS NOT NULL
     OR to_regprocedure('public._fs_fp_review_view(uuid, integer, uuid, uuid, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the first-period review read model is already applied (by this file or by the standalone port 20261223100000_first_period_governed_review_standalone.sql); nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regclass('public.fs_first_period_claims') IS NULL OR to_regclass('public.fs_first_period_decisions') IS NULL OR to_regclass('public.fs_first_period_evidence') IS NULL
     OR to_regprocedure('public.fs_decide_first_period(uuid, integer, text, boolean, text, uuid)') IS NULL
     OR to_regprocedure('public.fs_first_period_status(uuid, integer)') IS NULL
     OR to_regprocedure('public._fs_first_period_assess(uuid, integer)') IS NULL
     OR to_regprocedure('public._fs_opening_assess(uuid, integer)') IS NULL
     OR to_regprocedure('public._fs_fp_current_evidence(uuid, integer)') IS NULL
     OR to_regprocedure('public._fs_fp_period(uuid, integer)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: 20261217100000 (the first-period governed review) must be applied first; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- The six-argument function is replaced by the seven-argument one (same name, default NULL on the new argument).
DROP FUNCTION public.fs_decide_first_period(uuid, integer, text, boolean, text, uuid);

-- p_expected_binding: the binding the approver was SHOWN (fs_first_period_status -> <subject>.binding). When given and the
-- server's binding has moved since (a newer claim, new or retracted evidence, a changed company or period), nothing is
-- recorded (changed_since_viewed): an approver never decides something other than what the page put in front of them.
-- It is a consistency guard for the page, not an authorisation: who may decide is unchanged.
CREATE OR REPLACE FUNCTION public.fs_decide_first_period(p_company_id uuid, p_period_year integer, p_subject text, p_verify boolean, p_reason text, p_request_id uuid,
  p_expected_binding text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_claim public.fs_first_period_claims; v_assess jsonb; v_intent text; v_prior public.fs_first_period_decisions; v_last public.fs_first_period_decisions;
  v_outcome text; v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_request_id IS NULL OR p_subject IS NULL OR p_subject NOT IN ('first_period', 'opening_balances') OR p_verify IS NULL
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1500 OR p_period_year NOT BETWEEN 2000 AND 2100 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'approve_certification') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  PERFORM public._fs_scope_lock(p_company_id, p_period_year);
  SELECT * INTO v_claim FROM public.fs_first_period_claims c WHERE c.company_id = p_company_id AND c.period_year = p_period_year AND c.subject = p_subject ORDER BY c.seq DESC LIMIT 1;
  IF v_claim.id IS NULL THEN RETURN jsonb_build_object('outcome', 'no_claim'); END IF;
  v_intent := encode(sha256(convert_to(jsonb_build_array(p_company_id, p_period_year, p_subject, v_claim.id, p_verify, btrim(p_reason))::text, 'UTF8')), 'hex');
  SELECT * INTO v_prior FROM public.fs_first_period_decisions d WHERE d.actor_user_id = v_uid AND d.request_id = p_request_id;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.intent_sha256 = v_intent THEN RETURN jsonb_build_object('outcome', 'replay', 'decisionId', v_prior.id); END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  IF v_claim.actor_user_id = v_uid THEN RETURN jsonb_build_object('outcome', 'separate_approver_required'); END IF;
  v_assess := CASE WHEN p_subject = 'first_period' THEN public._fs_first_period_assess(p_company_id, p_period_year) ELSE public._fs_opening_assess(p_company_id, p_period_year) END;
  IF p_expected_binding IS NOT NULL AND p_expected_binding IS DISTINCT FROM (v_assess ->> 'binding') THEN
    RETURN jsonb_build_object('outcome', 'changed_since_viewed');
  END IF;
  IF p_verify AND jsonb_array_length(v_assess -> 'factIssues') > 0 THEN
    RETURN jsonb_build_object('outcome', 'not_ready', 'pending', v_assess -> 'factIssues');
  END IF;
  v_outcome := CASE WHEN p_verify THEN 'verified' ELSE 'not_verified' END;
  SELECT * INTO v_last FROM public.fs_first_period_decisions d WHERE d.company_id = p_company_id AND d.period_year = p_period_year AND d.subject = p_subject AND d.claim_id = v_claim.id ORDER BY d.seq DESC LIMIT 1;
  IF v_last.id IS NOT NULL AND v_last.outcome = v_outcome AND v_last.bound_sha256 IS NOT DISTINCT FROM (CASE WHEN p_verify THEN v_assess ->> 'binding' END) THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'decisionId', v_last.id);
  END IF;
  INSERT INTO public.fs_first_period_decisions (company_id, period_year, subject, claim_id, outcome, rule_version, bound_sha256, reason, request_id, intent_sha256, actor_user_id, firm_member_id)
  VALUES (p_company_id, p_period_year, p_subject, v_claim.id, v_outcome, v_assess ->> 'rules', CASE WHEN p_verify THEN v_assess ->> 'binding' END, btrim(p_reason),
          p_request_id, v_intent, v_uid, public._cr_member(p_company_id, v_uid)) RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'decisionId', v_id, 'verified', p_verify);
END;
$$;

-- What the page shows for ONE subject's latest claim and decision: the stated facts, the written basis, the cited revisions
-- exactly as recorded (whether each is still current), and who recorded or decided relative to the CALLER (recordedByYou /
-- decidedByYou: the page hides the approve control from the person who recorded the facts; the server still refuses it).
CREATE OR REPLACE FUNCTION public._fs_fp_review_view(p_company_id uuid, p_period_year integer, p_claim_id uuid, p_decision_id uuid, p_uid uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'claim', (SELECT jsonb_build_object('id', c.id, 'facts', c.facts, 'basisText', c.basis_text, 'evidenceIds', to_jsonb(c.evidence_ids), 'recordedAt', c.created_at,
                                        'recordedByYou', c.actor_user_id IS NOT DISTINCT FROM p_uid)
                FROM public.fs_first_period_claims c WHERE c.id = p_claim_id),
    'decision', (SELECT jsonb_build_object('id', d.id, 'outcome', d.outcome, 'reason', d.reason, 'ruleVersion', d.rule_version, 'decidedAt', d.created_at,
                                           'decidedByYou', d.actor_user_id IS NOT DISTINCT FROM p_uid)
                   FROM public.fs_first_period_decisions d WHERE d.id = p_decision_id),
    'cited', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'reference', e.reference, 'revision', e.revision, 'issuedOn', e.issued_on,
                                                           'assertedDate', e.asserted_date, 'documentSha256', e.document_sha256,
                                                           'current', EXISTS (SELECT 1 FROM public._fs_fp_current_evidence(p_company_id, p_period_year) x WHERE x.id = e.id)) ORDER BY e.seq)
                         FROM public.fs_first_period_claims c JOIN public.fs_first_period_evidence e ON e.id = ANY (c.evidence_ids) WHERE c.id = p_claim_id), '[]'::jsonb));
$$;

-- The read model of the page: both subjects, each pending item with its one next action, and the legacy declaration; the entity
-- and the reporting dates exactly as the server binds them (the dates come from the authoritative certified trial balance,
-- _fs_fp_period, which clients cannot call); the current evidence revisions the preparer may cite; per subject, the latest
-- claim and decision (_fs_fp_review_view) and the binding digest a decision taken now would carry (fs_decide_first_period
-- refuses one taken against a binding the approver was not shown).
CREATE OR REPLACE FUNCTION public.fs_first_period_status(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_fp jsonb; v_op jsonb; v_leg record; v_per record; v_co record; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.close_review_readable(p_company_id) THEN RETURN jsonb_build_object('state', 'unavailable'); END IF;
  v_fp := public._fs_first_period_assess(p_company_id, p_period_year);
  v_op := public._fs_opening_assess(p_company_id, p_period_year);
  SELECT d.action, d.evidence_kind, d.evidence_ref, d.evidence_date, d.created_at INTO v_leg FROM public.fs_first_period_declarations d
   WHERE d.company_id = p_company_id AND d.period_year = p_period_year ORDER BY d.seq DESC LIMIT 1;
  SELECT * INTO v_per FROM public._fs_fp_period(p_company_id, p_period_year);
  SELECT c.name, c.tin INTO v_co FROM public.companies c WHERE c.id = p_company_id;
  RETURN jsonb_build_object('state', 'evaluated', 'periodYear', p_period_year,
    'entity', jsonb_build_object('legalName', v_co.name, 'tin', nullif(btrim(v_co.tin), '')),
    'period', jsonb_build_object('reportingStart', v_per.reporting_start, 'reportingEnd', v_per.reporting_end),
    'evidence', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'reference', e.reference, 'revision', e.revision, 'issuedOn', e.issued_on,
                                                              'assertedDate', e.asserted_date, 'documentSha256', e.document_sha256, 'note', e.note, 'recordedAt', e.created_at,
                                                              'recordedByYou', e.actor_user_id IS NOT DISTINCT FROM v_uid) ORDER BY e.seq)
                            FROM public._fs_fp_current_evidence(p_company_id, p_period_year) e), '[]'::jsonb),
    'firstPeriod', v_fp || jsonb_build_object('items', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', split_part(x, ':', 1), 'detail', nullif(substr(x, length(split_part(x, ':', 1)) + 2), ''), 'nextAction', public._fs_fp_next_action(x)) ORDER BY o)
                                                                        FROM jsonb_array_elements_text(v_fp -> 'pending') WITH ORDINALITY t(x, o)), '[]'::jsonb))
                    || public._fs_fp_review_view(p_company_id, p_period_year, (v_fp ->> 'claimId')::uuid, (v_fp ->> 'decisionId')::uuid, v_uid),
    'openingBalances', v_op || jsonb_build_object('items', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', split_part(x, ':', 1), 'detail', nullif(substr(x, length(split_part(x, ':', 1)) + 2), ''), 'nextAction', public._fs_fp_next_action(x)) ORDER BY o)
                                                                           FROM jsonb_array_elements_text(v_op -> 'pending') WITH ORDINALITY t(x, o)), '[]'::jsonb))
                    || public._fs_fp_review_view(p_company_id, p_period_year, (v_op ->> 'claimId')::uuid, (v_op ->> 'decisionId')::uuid, v_uid),
    'legacyDeclaration', CASE WHEN v_leg.action IS NULL THEN NULL ELSE jsonb_build_object('action', v_leg.action, 'evidenceKind', v_leg.evidence_kind, 'evidenceRef', v_leg.evidence_ref,
                          'evidenceDate', v_leg.evidence_date, 'recordedAt', v_leg.created_at, 'satisfiesRequirement', false) END);
END;
$$;

REVOKE ALL ON FUNCTION public._fs_fp_review_view(uuid, integer, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fs_decide_first_period(uuid, integer, text, boolean, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_decide_first_period(uuid, integer, text, boolean, text, uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_first_period_status(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_first_period_status(uuid, integer) TO authenticated;

DO $postcondition$
BEGIN
  IF to_regprocedure('public.fs_decide_first_period(uuid, integer, text, boolean, text, uuid, text)') IS NULL
     OR to_regprocedure('public.fs_decide_first_period(uuid, integer, text, boolean, text, uuid)') IS NOT NULL
     OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'fs_decide_first_period') <> 1
     OR position('p_expected_binding' IN pg_get_functiondef('public.fs_decide_first_period(uuid, integer, text, boolean, text, uuid, text)'::regprocedure)) = 0
     OR position('changed_since_viewed' IN pg_get_functiondef('public.fs_decide_first_period(uuid, integer, text, boolean, text, uuid, text)'::regprocedure)) = 0
     OR position('_fs_fp_review_view' IN pg_get_functiondef('public.fs_first_period_status(uuid, integer)'::regprocedure)) = 0
     OR has_function_privilege('authenticated', 'public._fs_fp_review_view(uuid, integer, uuid, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fs_decide_first_period(uuid, integer, text, boolean, text, uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_decide_first_period(uuid, integer, text, boolean, text, uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_first_period_status(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fs_first_period_status(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: the first-period review read model is not in the expected state' USING ERRCODE = 'P0001';
  END IF;
END;
$postcondition$;
