-- IPSAS statement review r1. Authored forward migration; not an installation record.
-- No amounts, approvals or financial journals are accepted from the caller. No outer transaction controls.
DO $preflight$
BEGIN
  IF to_regclass('public.ipsas_presentation_revisions') IS NOT NULL THEN RAISE EXCEPTION 'IPSAS_STATEMENT_REVIEW_ALREADY_PRESENT'; END IF;
  IF to_regprocedure('public._ipsas_refusal(uuid,uuid,text)') IS NULL OR to_regprocedure('public._fs_reporting_input_compute(uuid,integer)') IS NULL
     OR to_regprocedure('public.tb_official_output_lock(uuid,integer)') IS NULL OR to_regprocedure('public._ipsas_authorize_mutation(uuid,uuid,text)') IS NULL THEN RAISE EXCEPTION 'IPSAS_STATEMENT_REVIEW_PREREQUISITE_MISSING'; END IF;
END;
$preflight$;

CREATE TABLE public.ipsas_presentation_revisions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), seq bigint GENERATED ALWAYS AS IDENTITY,
  company_id uuid NOT NULL REFERENCES public.companies(id), period_year integer NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  assignments jsonb NOT NULL CHECK (jsonb_typeof(assignments) = 'array' AND jsonb_array_length(assignments) <= 1000),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  actor_user_id uuid NOT NULL, request_id uuid NOT NULL, request_fingerprint text NOT NULL,
  receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(actor_user_id, request_id)
);
CREATE INDEX ipsas_presentation_latest ON public.ipsas_presentation_revisions(company_id, period_year, seq DESC);
ALTER TABLE public.ipsas_presentation_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ipsas_presentation_revisions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.ipsas_presentation_revisions_seq_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER ipsas_presentation_immutable BEFORE UPDATE OR DELETE ON public.ipsas_presentation_revisions FOR EACH ROW EXECUTE FUNCTION public._ipsas_immutable();
CREATE TRIGGER ipsas_presentation_no_truncate BEFORE TRUNCATE ON public.ipsas_presentation_revisions FOR EACH STATEMENT EXECUTE FUNCTION public._ipsas_immutable();

-- Draft vocabulary, not the minimum/full requirement universe. Positions come from reviewed classifications.
CREATE FUNCTION public._ipsas_statement_captions() RETURNS TABLE(id text, label text, statement text, section text)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT * FROM (VALUES
    ('cash','Cash and cash equivalents','SFP','current_assets'),
    ('receivables_current','Receivables','SFP','current_assets'), ('receivables_non_current','Receivables','SFP','non_current_assets'),
    ('inventories','Inventories','SFP','current_assets'), ('prepayments','Prepayments','SFP','current_assets'),
    ('other_assets_current','Other current assets','SFP','current_assets'), ('other_assets_non_current','Other non-current assets','SFP','non_current_assets'),
    ('ppe','Property, plant and equipment','SFP','non_current_assets'), ('intangibles','Intangible assets','SFP','non_current_assets'),
    ('right_of_use','Right-of-use assets','SFP','non_current_assets'), ('investment_property','Investment property','SFP','non_current_assets'),
    ('payables','Payables and accruals','SFP','current_liabilities'), ('grant_liabilities_current','Grant/revenue arrangement liabilities','SFP','current_liabilities'),
    ('grant_liabilities_non_current','Grant/revenue arrangement liabilities','SFP','non_current_liabilities'),
    ('borrowings_current','Borrowings','SFP','current_liabilities'), ('borrowings_non_current','Borrowings','SFP','non_current_liabilities'),
    ('lease_current','Lease liabilities','SFP','current_liabilities'), ('lease_non_current','Lease liabilities','SFP','non_current_liabilities'),
    ('other_liabilities_current','Other current liabilities','SFP','current_liabilities'), ('other_liabilities_non_current','Other non-current liabilities','SFP','non_current_liabilities'),
    ('contributed_capital','Contributed capital','SFP','equity'), ('reserves','Reserves','SFP','equity'),
    ('funds','Fund balances','SFP','equity'), ('accumulated','Accumulated surplus / deficit','SFP','equity'),
    ('tax_revenue','Tax revenue','SFPERF','income'), ('grants','Grants and transfers revenue','SFPERF','income'),
    ('donations','Donations','SFPERF','income'), ('fees','Fees and services','SFPERF','income'),
    ('investment_income','Investment income','SFPERF','income'), ('other_revenue','Other revenue','SFPERF','income'),
    ('employees','Employee expenses','SFPERF','expense'), ('supplies','Supplies and services','SFPERF','expense'),
    ('depreciation','Depreciation and amortisation','SFPERF','expense'), ('impairment','Impairment','SFPERF','expense'),
    ('transfers','Transfer expenses','SFPERF','expense'), ('finance','Finance costs','SFPERF','expense'), ('other_expenses','Other expenses','SFPERF','expense')
  ) x(id,label,statement,section);
$$;
REVOKE ALL ON FUNCTION public._ipsas_statement_captions() FROM PUBLIC, anon, authenticated, service_role;

-- One SQL-statement snapshot, reused for both reads and stale-input verification. Private helper has no API grant.
CREATE FUNCTION public._ipsas_statement_review_compute(p_company uuid, p_year integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_input jsonb; v_cur jsonb; v_cmp jsonb; v_cmp_ok boolean; v_rev public.ipsas_presentation_revisions;
  v_source jsonb; v_sha text; v_active boolean; v_rows jsonb; v_lines jsonb; v_totals jsonb; v_body jsonb;
BEGIN
  v_input := public._fs_reporting_input_compute(p_company,p_year);
  IF v_input->>'state' IS DISTINCT FROM 'current' THEN RETURN jsonb_build_object('outcome',v_input->>'state'); END IF;
  v_cur := v_input->'current'; v_cmp := v_input->'comparative';
  IF jsonb_array_length(v_cur->'accounts')=0 THEN RETURN jsonb_build_object('outcome','empty_trial_balance'); END IF;
  IF jsonb_array_length(v_cur->'accounts') + jsonb_array_length(coalesce(v_cmp->'accounts','[]'::jsonb)) > 1000 THEN RETURN jsonb_build_object('outcome','over_capacity'); END IF;
  IF v_cur->>'reportingStart' IS NULL OR v_cur->>'reportingEnd' IS NULL OR (v_cur->>'reportingStart')::date > (v_cur->>'reportingEnd')::date THEN RETURN jsonb_build_object('outcome','period_unknown'); END IF;
  v_cmp_ok := v_cmp->>'state' = 'available' AND v_cmp->>'currency' = v_cur->>'currency' AND v_cmp->>'exponent' = v_cur->>'exponent'
    AND v_cmp->>'reportingStart' IS NOT NULL AND v_cmp->>'reportingEnd' IS NOT NULL AND (v_cmp->>'reportingEnd')::date+1 = (v_cur->>'reportingStart')::date;
  v_cmp_ok := coalesce(v_cmp_ok,false);
  v_source := jsonb_build_object('contract','ipsas-statement-source/1','company',p_company,'year',p_year,'current',v_cur,'comparative',v_cmp,
    'adjustments',v_input->'adjustments','revalidation',v_input->'adjustmentsRequiringRevalidation');
  v_sha := encode(sha256(convert_to(v_source::text,'UTF8')),'hex');
  SELECT * INTO v_rev FROM public.ipsas_presentation_revisions WHERE company_id=p_company AND period_year=p_year ORDER BY seq DESC LIMIT 1;
  v_active := v_rev.id IS NOT NULL AND v_rev.source_sha256=v_sha;
  WITH accounts AS (
    SELECT 'current'::text AS period,a FROM jsonb_array_elements(v_cur->'accounts') a
    UNION ALL SELECT 'comparative',a FROM jsonb_array_elements(CASE WHEN v_cmp_ok THEN v_cmp->'accounts' ELSE '[]'::jsonb END) a
  ), joined AS (
    SELECT x.period,x.a,public._fs_section(x.a->>'classification') section,j.value choice,c.id caption,c.label,c.statement
    FROM accounts x LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(coalesce(v_rev.assignments,'[]'::jsonb))
      WHERE value->>'period'=x.period AND value->>'accountKey'=x.a->>'accountKey') j ON true
    LEFT JOIN public._ipsas_statement_captions() c ON c.id=j.value->>'captionId'
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('period',period,'accountKey',a->>'accountKey','accountName',a->>'accountName',
    'classification',a->>'classification','section',section,'debitMinor',a->>'debitMinor','creditMinor',a->>'creditMinor',
    'certifiedDebitMinor',a->>'certifiedDebitMinor','certifiedCreditMinor',a->>'certifiedCreditMinor','adjustmentIds',a->'adjustmentIds',
    'captionId',choice->>'captionId','zeroDisposition',choice->>'zeroDisposition','reason',choice->>'reason',
    'status',CASE WHEN NOT v_active THEN 'needs_confirmation'
      WHEN caption IS NOT NULL AND section=(SELECT c.section FROM public._ipsas_statement_captions() c WHERE c.id=caption) THEN 'presented'
      WHEN (a->>'debitMinor')::numeric=(a->>'creditMinor')::numeric AND choice->>'zeroDisposition' IN ('movement-source-reviewed','non-reporting-reviewed') THEN 'reviewed_zero'
      ELSE 'unassigned' END) ORDER BY period, a->>'accountKey'),'[]'::jsonb) INTO v_rows FROM joined;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label,'statement',statement,'section',section,
    'currentMinor',CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'period'='current' AND r->>'status' NOT IN ('presented','reviewed_zero')) THEN NULL
      ELSE (SELECT coalesce(sum(CASE WHEN c.section IN ('current_assets','non_current_assets','expense') THEN (r->>'debitMinor')::numeric-(r->>'creditMinor')::numeric ELSE (r->>'creditMinor')::numeric-(r->>'debitMinor')::numeric END),0)::text
        FROM jsonb_array_elements(v_rows) r WHERE r->>'period'='current' AND r->>'captionId'=c.id) END,
    'comparativeMinor',CASE WHEN NOT v_cmp_ok OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'period'='comparative' AND r->>'status' NOT IN ('presented','reviewed_zero')) THEN NULL
      ELSE (SELECT coalesce(sum(CASE WHEN c.section IN ('current_assets','non_current_assets','expense') THEN (r->>'debitMinor')::numeric-(r->>'creditMinor')::numeric ELSE (r->>'creditMinor')::numeric-(r->>'debitMinor')::numeric END),0)::text
        FROM jsonb_array_elements(v_rows) r WHERE r->>'period'='comparative' AND r->>'captionId'=c.id) END) ORDER BY statement,section,id),'[]'::jsonb)
    INTO v_lines FROM public._ipsas_statement_captions() c;

  WITH periods AS (SELECT 'current'::text period UNION ALL SELECT 'comparative' WHERE v_cmp_ok), totals AS (
    SELECT period,
      NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'period'=p.period AND r->>'status' NOT IN ('presented','reviewed_zero')) ready,
      (SELECT coalesce(sum((r->>'debitMinor')::numeric-(r->>'creditMinor')::numeric),0) FROM jsonb_array_elements(v_rows) r WHERE r->>'period'=p.period) balance,
      (SELECT coalesce(sum((r->>'debitMinor')::numeric-(r->>'creditMinor')::numeric),0) FROM jsonb_array_elements(v_rows) r WHERE r->>'period'=p.period AND r->>'section' IN ('current_assets','non_current_assets')) assets,
      (SELECT coalesce(sum((r->>'creditMinor')::numeric-(r->>'debitMinor')::numeric),0) FROM jsonb_array_elements(v_rows) r WHERE r->>'period'=p.period AND r->>'section' IN ('current_liabilities','non_current_liabilities')) liabilities,
      (SELECT coalesce(sum((r->>'creditMinor')::numeric-(r->>'debitMinor')::numeric),0) FROM jsonb_array_elements(v_rows) r WHERE r->>'period'=p.period AND r->>'section'='equity') equity,
      (SELECT coalesce(sum((r->>'creditMinor')::numeric-(r->>'debitMinor')::numeric),0) FROM jsonb_array_elements(v_rows) r WHERE r->>'period'=p.period AND r->>'section'='income') revenue,
      (SELECT coalesce(sum((r->>'debitMinor')::numeric-(r->>'creditMinor')::numeric),0) FROM jsonb_array_elements(v_rows) r WHERE r->>'period'=p.period AND r->>'section'='expense') expenses
    FROM periods p)
  SELECT jsonb_object_agg(period,jsonb_build_object('state',CASE WHEN ready AND balance=0 THEN 'composed' ELSE 'incomplete' END,
    'assetsMinor',CASE WHEN ready AND balance=0 THEN assets::text END,'liabilitiesMinor',CASE WHEN ready AND balance=0 THEN liabilities::text END,
    'revenueMinor',CASE WHEN ready AND balance=0 THEN revenue::text END,'expensesMinor',CASE WHEN ready AND balance=0 THEN expenses::text END,
    'surplusMinor',CASE WHEN ready AND balance=0 THEN (revenue-expenses)::text END,
    'netAssetsMinor',CASE WHEN ready AND balance=0 THEN (equity+revenue-expenses)::text END,
    'balanceDifferenceMinor',balance::text)) INTO v_totals FROM totals;
  v_body := jsonb_build_object('outcome','available','contract','ipsas-statement-review/1','companyId',p_company,'periodYear',p_year,
    'catalogueVersion','1','current',v_cur - 'accounts','comparative',(v_cmp - 'accounts') || jsonb_build_object('usable',v_cmp_ok,'label','Prior certified TB — reference only, not an audited comparative'),
    'sourceSha256',v_sha,'revisionId',v_rev.id,'assignmentsCurrent',v_active,'accounts',v_rows,'lines',v_lines,'totals',v_totals,
    'inputSha256',encode(sha256(convert_to(jsonb_build_object('source',v_sha,'revision',v_rev.id)::text,'UTF8')),'hex'),
    'adjustmentsRequiringRevalidation',v_input->'adjustmentsRequiringRevalidation',
    'officialIssuance',jsonb_build_object('available',false,'reasons',jsonb_build_array('Full IPSAS requirement register and accounting acceptance are outstanding.',
      'Trial-balance completeness and the pre-close performance basis need confirmation; balance alone does not establish complete revenue and expenses.',
      'Cash-flow and component net-assets workpapers, budget applicability, complete notes and comparative transition handling are not integrated.',
      'The reviewed approval and frozen-issuance path is not integrated.')));
  RETURN v_body || jsonb_build_object('compositionSha256',encode(sha256(convert_to(v_body::text,'UTF8')),'hex'));
END;
$$;
REVOKE ALL ON FUNCTION public._ipsas_statement_review_compute(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.ipsas_statement_review(p_company uuid,p_year integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_refusal text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('outcome','forbidden'); END IF;
  IF p_company IS NULL OR p_year IS NULL OR p_year NOT BETWEEN 2000 AND 2100 THEN RETURN jsonb_build_object('outcome','invalid_request'); END IF;
  v_refusal := public._ipsas_refusal(p_company,auth.uid(),'read');
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome',v_refusal); END IF;
  RETURN public._ipsas_statement_review_compute(p_company,p_year);
END;
$$;

CREATE FUNCTION public.ipsas_save_presentation(p_company uuid,p_year integer,p_assignments jsonb,p_expected_revision uuid,p_expected_input text,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_refusal text; v_live jsonb; v_fp text; v_prior public.ipsas_presentation_revisions; v_a jsonb; v_r jsonb; v_caption record;
  v_id uuid:=pg_catalog.gen_random_uuid(); v_receipt jsonb; v_seen text[]:='{}'; v_key text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('outcome','forbidden'); END IF;
  IF p_company IS NULL OR p_year IS NULL OR p_year NOT BETWEEN 2000 AND 2100 OR p_request IS NULL OR p_expected_input IS NULL
    OR p_expected_input !~ '^[0-9a-f]{64}$' OR jsonb_typeof(p_assignments) IS DISTINCT FROM 'array' OR octet_length(p_assignments::text)>250000
    OR jsonb_array_length(p_assignments)>1000 THEN RETURN jsonb_build_object('outcome','invalid_request'); END IF;
  -- Reuse #227's READ COMMITTED authority boundary, including replays. Early refusal holds the shared plan lock.
  -- Order: early plan -> request -> report scope -> prior/current TB -> member capability (shared) -> plan (re-entrant).
  v_refusal:=public._ipsas_refusal(p_company,auth.uid(),'prepare_close');
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome',v_refusal); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ipsas_presentation_request:'||auth.uid()::text||':'||p_request::text,0));
  PERFORM public._fs_scope_lock(p_company,p_year);
  PERFORM public.tb_official_output_lock(p_company,p_year-1); PERFORM public.tb_official_output_lock(p_company,p_year);
  v_refusal:=public._ipsas_authorize_mutation(p_company,auth.uid(),'prepare_close');
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome',v_refusal); END IF;
  v_fp:=encode(sha256(convert_to(jsonb_build_object('company',p_company,'year',p_year,'assignments',p_assignments,'expected',p_expected_revision,'input',p_expected_input)::text,'UTF8')),'hex');
  SELECT * INTO v_prior FROM public.ipsas_presentation_revisions WHERE actor_user_id=auth.uid() AND request_id=p_request;
  IF FOUND THEN
    IF v_prior.request_fingerprint=v_fp THEN RETURN v_prior.receipt || jsonb_build_object('replay',true); END IF;
    RETURN jsonb_build_object('outcome','request_reused');
  END IF;
  v_live:=public._ipsas_statement_review_compute(p_company,p_year);
  IF v_live->>'outcome' IS DISTINCT FROM 'available' THEN RETURN jsonb_build_object('outcome',v_live->>'outcome'); END IF;
  IF (v_live->>'revisionId')::uuid IS DISTINCT FROM p_expected_revision OR v_live->>'inputSha256'<>p_expected_input THEN RETURN jsonb_build_object('outcome','stale'); END IF;
  FOR v_a IN SELECT value FROM jsonb_array_elements(p_assignments) LOOP
    IF jsonb_typeof(v_a) IS DISTINCT FROM 'object' OR (v_a - ARRAY['period','accountKey','captionId','zeroDisposition','reason']) <> '{}'::jsonb
      OR coalesce(v_a->>'period','') NOT IN ('current','comparative') OR coalesce(length(v_a->>'accountKey'),0) NOT BETWEEN 1 AND 160 THEN RETURN jsonb_build_object('outcome','invalid_request'); END IF;
    v_key:=(v_a->>'period')||':'||(v_a->>'accountKey');
    IF v_key=ANY(v_seen) THEN RETURN jsonb_build_object('outcome','duplicate_account'); END IF; v_seen:=array_append(v_seen,v_key);
    SELECT value INTO v_r FROM jsonb_array_elements(v_live->'accounts') WHERE value->>'period'=v_a->>'period' AND value->>'accountKey'=v_a->>'accountKey';
    IF v_r IS NULL THEN RETURN jsonb_build_object('outcome','unknown_account'); END IF;
    SELECT * INTO v_caption FROM public._ipsas_statement_captions() WHERE id=v_a->>'captionId';
    IF FOUND THEN
      IF v_caption.section IS DISTINCT FROM v_r->>'section' OR v_a->>'zeroDisposition' IS NOT NULL THEN RETURN jsonb_build_object('outcome','incompatible_caption'); END IF;
    ELSIF v_a->>'captionId' IS NOT NULL THEN RETURN jsonb_build_object('outcome','unknown_caption');
    ELSIF v_a->>'zeroDisposition' IS NOT NULL THEN
      IF v_r->>'debitMinor' IS DISTINCT FROM v_r->>'creditMinor' OR v_a->>'zeroDisposition' NOT IN ('movement-source-reviewed','non-reporting-reviewed')
        OR coalesce(length(btrim(v_a->>'reason')),0) NOT BETWEEN 8 AND 2000 THEN RETURN jsonb_build_object('outcome','invalid_zero_disposition'); END IF;
    END IF;
  END LOOP;
  v_receipt:=jsonb_build_object('outcome','recorded','revisionId',v_id,'sourceSha256',v_live->>'sourceSha256','requestId',p_request);
  INSERT INTO public.ipsas_presentation_revisions(id,company_id,period_year,assignments,source_sha256,actor_user_id,request_id,request_fingerprint,receipt)
    VALUES(v_id,p_company,p_year,p_assignments,v_live->>'sourceSha256',auth.uid(),p_request,v_fp,v_receipt);
  RETURN v_receipt;
END;
$$;
REVOKE ALL ON FUNCTION public.ipsas_statement_review(uuid,integer),public.ipsas_save_presentation(uuid,integer,jsonb,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ipsas_statement_review(uuid,integer),public.ipsas_save_presentation(uuid,integer,jsonb,uuid,text,uuid) TO authenticated;
