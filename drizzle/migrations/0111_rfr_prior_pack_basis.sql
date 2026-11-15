-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261227100000 — Check my books derives last year's approved opening position DIRECTLY from the prior FINAL pack. AUTHORED, NOT
-- APPLIED to any hosted database. Forward-only; stacked on 20261226100000 (issued comparative schedules) and the Ready for
-- Reporting pilot (20261225100000).
--
--   THE GAP: for a client whose prior year was finalised in CFOClose, the accountant still had to export "approved prior-year figures"
--   to a CSV and classify the difference by hand, although CFOClose already holds the approved closing position (the prior FINAL's
--   reporting input, adjustments included) and the approved adjustment that explains a difference to the source ledger.
--
--   WHAT THIS ADDS: rfr_import_prior_pack(company, year, request) — for a scope that opted in:
--     · finds the prior year's FINAL (fs_report_authority) and REFUSES unless the sealed pack still equals CFOClose's current prior-year
--       reporting input (prior_changed_after_issue otherwise): an adjustment approved after issue never silently moves the opening;
--     · derives one bridge line per asset and liability account from that input (approved closing, debit positive) and records it as
--       the scope's opening_bridge input, citing the pack by report id, version, document hash and input hash;
--     · where an APPLIED prior-year adjustment touches the account, classifies the line as an unposted audit adjustment with evidence
--       reproduced from that adjustment (account, net amount, the prior period's end, adjustment numbers) and proposes the opening-first
--       correction (the account's effect against the retained-earnings account the mappings flag) for the existing two-person review;
--     · extends the scope's opening_lines with the derived lines (an append-only scope event).
--   The engine, the review, the approval and the adjusted trial balance are the existing ones. Equity is the balancing residual and is
--   not bridged here; a prior year with no FINAL, a changed pack, or an adjustment that needs a retained-earnings account the mappings do
--   not flag, is refused by name — nothing is guessed.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
BEGIN
  IF to_regprocedure('public.rfr_import_prior_pack(uuid, integer, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the prior pack import is already applied; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure('public._rfr_write_input(uuid, integer, text, text, boolean, jsonb, text, text, text, uuid, uuid)') IS NULL OR to_regprocedure('public._rfr_scope(uuid, integer)') IS NULL
     OR to_regclass('public.fs_report_authority') IS NULL OR to_regprocedure('public.fs_reporting_input(uuid, integer)') IS NULL OR to_regclass('public.close_review_adjustment_lines') IS NULL
     OR to_regclass('public.fs_issued_comparatives') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: 20261125100000 (report authority), 20261225100000 (readiness) and 20261226100000 (issued comparatives) must be applied first; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- Outcomes: recorded | unchanged | forbidden | feature_disabled | invalid_request | not_enabled | no_prior_final | prior_unavailable |
-- prior_changed_after_issue | retained_earnings_unidentified | request_reused.
CREATE OR REPLACE FUNCTION public.rfr_import_prior_pack(p_company_id uuid, p_period_year integer, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_py integer := p_period_year - 1;
  v_scope public.rfr_scope_events;
  v_auth public.fs_report_authority;
  v_doc jsonb; v_docsha text; v_hashes text[]; v_input jsonb; v_end text;
  v_re text; v_re_n integer;
  v_lines jsonb := '[]'::jsonb; v_props jsonb := '[]'::jsonb; v_basis text;
  acct record; e record; v_n numeric; v_nums text; v_lid text; v_evid text; v_cls jsonb;
  v_evs jsonb := '[]'::jsonb; v_r jsonb; v_rs jsonb := '[]'::jsonb; v_changed boolean := false; v_facts jsonb; v_open text[]; v_sha text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_request_id IS NULL OR p_period_year NOT BETWEEN 2001 AND 2100 THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'prepare_close') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  PERFORM public._fs_scope_lock(p_company_id, p_period_year);
  v_scope := public._rfr_scope(p_company_id, p_period_year);
  IF v_scope.id IS NULL THEN RETURN jsonb_build_object('outcome', 'not_enabled'); END IF;
  SELECT * INTO v_auth FROM public.fs_report_authority a WHERE a.company_id = p_company_id AND a.period_year = v_py;
  IF v_auth.report_id IS NULL THEN RETURN jsonb_build_object('outcome', 'no_prior_final'); END IF;
  SELECT r.report_document INTO v_doc FROM public.financial_statement_reports r WHERE r.report_id = v_auth.report_id AND r.report_version = v_auth.report_version AND r.company_id = p_company_id;
  v_docsha := encode(sha256(convert_to(v_doc::text, 'UTF8')), 'hex');
  -- The sealed pack must still BE the prior year's current reporting input: the same identity the sign-off gate compares.
  SELECT array_agg(DISTINCT s) INTO v_hashes
    FROM jsonb_path_query(v_doc, '$.facts[*].provenance.source ? (@.artifactKind == "TRIAL_BALANCE").sourceHash') h(s0), LATERAL (SELECT h.s0 #>> '{}' AS s) x;
  v_input := public.fs_reporting_input(p_company_id, v_py);
  IF v_input ->> 'state' IS DISTINCT FROM 'current' THEN RETURN jsonb_build_object('outcome', 'prior_unavailable', 'state', v_input ->> 'state'); END IF;
  IF v_hashes IS NULL OR array_length(v_hashes, 1) <> 1 OR v_hashes[1] IS DISTINCT FROM v_input ->> 'inputSha256' THEN RETURN jsonb_build_object('outcome', 'prior_changed_after_issue'); END IF;
  v_end := v_input #>> '{current,reportingEnd}';
  v_basis := 'prior_final:' || v_auth.report_id || '@v' || v_auth.report_version || ';doc:' || v_docsha || ';input:' || (v_input ->> 'inputSha256');
  SELECT count(*), min(x ->> 'accountKey') INTO v_re_n, v_re FROM jsonb_array_elements(v_input #> '{current,accounts}') x WHERE (x ->> 'isRetainedEarnings') = 'true';

  FOR acct IN SELECT x ->> 'accountKey' AS k, x ->> 'accountCode' AS code, ((x ->> 'debitMinor')::numeric - (x ->> 'creditMinor')::numeric) AS approved
             FROM jsonb_array_elements(v_input #> '{current,accounts}') x
            WHERE x ->> 'classification' IN ('current_assets', 'non_current_assets', 'current_liabilities', 'non_current_liabilities') ORDER BY x ->> 'accountKey' LOOP
    v_lid := 'acct-' || regexp_replace(lower(coalesce(acct.code, acct.k)), '[^a-z0-9]+', '-', 'g');
    -- The net effect of the prior year's APPLIED approved adjustments on this account (debit positive), and which adjustments.
    SELECT coalesce(sum(l.debit_minor - l.credit_minor), 0), string_agg(DISTINCT 'AA-' || (ad ->> 'number'), ',' ORDER BY 'AA-' || (ad ->> 'number'))
      INTO v_n, v_nums
      FROM jsonb_array_elements(v_input -> 'adjustments') ad
      JOIN public.close_review_adjustment_lines l ON l.adjustment_id = (ad ->> 'id')::uuid AND l.account_key = acct.k;
    v_cls := NULL;
    IF v_n <> 0 THEN
      IF v_re_n <> 1 THEN RETURN jsonb_build_object('outcome', 'retained_earnings_unidentified', 'accounts', v_re_n); END IF;
      v_evid := 'EV-CFOCLOSE-' || v_lid;
      v_evs := v_evs || jsonb_build_array(jsonb_build_object('key', v_evid, 'payload', jsonb_build_object('kind', 'audit_adjustment_schedule', 'extraction', 'reproduced',
                 'facts', jsonb_build_object('amount', v_n::text, 'account', acct.k, 'date', v_end, 'ref', v_nums), 'derived_from', jsonb_build_object('pack', v_auth.report_id, 'version', v_auth.report_version, 'documentSha256', v_docsha))));
      v_cls := jsonb_build_object('kind', 'unposted_audit_adjustment', 'evidence', jsonb_build_array(v_evid));
      v_props := v_props || jsonb_build_array(jsonb_build_object('id', 'corr:opening:' || v_lid, 'line', v_lid,
                 'lines', jsonb_build_array(jsonb_build_object('account', acct.k, 'amount', v_n::text), jsonb_build_object('account', v_re, 'amount', (-v_n)::text))));
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('line', v_lid, 'approved', acct.approved::text, 'accounts', jsonb_build_array(acct.k), 'level', 'account') || CASE WHEN v_cls IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('classification', v_cls) END);
  END LOOP;
  IF jsonb_array_length(v_lines) = 0 THEN RETURN jsonb_build_object('outcome', 'prior_unavailable', 'state', 'no_asset_or_liability_accounts'); END IF;

  -- Record: evidence first (hash-addressed), then the bridge, each under its own deterministic request identity.
  FOR e IN SELECT ev ->> 'key' AS k, ev -> 'payload' AS payload FROM jsonb_array_elements(v_evs) ev LOOP
    v_r := public._rfr_write_input(p_company_id, p_period_year, 'evidence', e.k, false, e.payload, 'manual', NULL, NULL, v_uid, md5(p_request_id::text || ':' || e.k)::uuid);
    IF v_r ->> 'outcome' NOT IN ('recorded', 'unchanged') THEN RETURN jsonb_build_object('outcome', v_r ->> 'outcome'); END IF;
    IF v_r ->> 'outcome' = 'recorded' AND NOT coalesce((v_r ->> 'replay')::boolean, false) THEN v_changed := true; END IF;
    v_rs := v_rs || jsonb_build_array(jsonb_build_object('family', 'evidence', 'key', e.k, 'outcome', v_r ->> 'outcome'));
  END LOOP;
  v_r := public._rfr_write_input(p_company_id, p_period_year, 'opening_bridge', 'opening_bridge', false, jsonb_build_object('basis', v_basis, 'lines', v_lines, 'proposals', v_props), 'manual', NULL, NULL, v_uid, md5(p_request_id::text || ':opening_bridge')::uuid);
  IF v_r ->> 'outcome' NOT IN ('recorded', 'unchanged') THEN RETURN jsonb_build_object('outcome', v_r ->> 'outcome'); END IF;
  IF v_r ->> 'outcome' = 'recorded' AND NOT coalesce((v_r ->> 'replay')::boolean, false) THEN v_changed := true; END IF;
  v_rs := v_rs || jsonb_build_array(jsonb_build_object('family', 'opening_bridge', 'key', 'opening_bridge', 'outcome', v_r ->> 'outcome'));

  -- The derived lines are now REQUIRED checks: extend the scope's opening_lines (an append-only scope event; unchanged when already there).
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_open FROM (SELECT jsonb_array_elements_text(coalesce(v_scope.facts -> 'opening_lines', '[]'::jsonb)) AS x
                                                           UNION SELECT l ->> 'line' FROM jsonb_array_elements(v_lines) l) q;
  v_facts := v_scope.facts || jsonb_build_object('opening_lines', to_jsonb(v_open));
  v_sha := encode(sha256(convert_to(v_facts::text, 'UTF8')), 'hex');
  IF v_sha <> v_scope.facts_sha256 THEN
    INSERT INTO public.rfr_scope_events (company_id, period_year, rule_pack_id, rule_pack_version, facts, facts_sha256, reason, actor_user_id, firm_member_id)
    VALUES (p_company_id, p_period_year, v_scope.rule_pack_id, v_scope.rule_pack_version, v_facts, v_sha, 'Opening lines derived from the prior FINAL pack', v_uid, public._cr_member(p_company_id, v_uid));
    v_changed := true;
  END IF;
  RETURN jsonb_build_object('outcome', CASE WHEN v_changed THEN 'recorded' ELSE 'unchanged' END, 'priorReportId', v_auth.report_id, 'priorReportVersion', v_auth.report_version, 'documentSha256', v_docsha,
    'inputSha256', v_input ->> 'inputSha256', 'lines', jsonb_array_length(v_lines), 'classified', jsonb_array_length(v_props), 'inputs', v_rs);
END;
$$;

REVOKE ALL ON FUNCTION public.rfr_import_prior_pack(uuid, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rfr_import_prior_pack(uuid, integer, uuid) TO authenticated;

DO $postcondition$
BEGIN
  IF to_regprocedure('public.rfr_import_prior_pack(uuid, integer, uuid)') IS NULL OR has_function_privilege('anon', 'public.rfr_import_prior_pack(uuid, integer, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.rfr_import_prior_pack(uuid, integer, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: the prior pack import is not in the expected state' USING ERRCODE = 'P0001';
  END IF;
END;
$postcondition$;
