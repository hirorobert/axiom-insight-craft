-- Authored forward migration; NOT applied hosted. Follows 20261207100000 (IPSAS accrual preparation: it reuses _ipsas_immutable,
-- _ipsas_minor, _ipsas_nat, _ipsas_enough, _ipsas_arr and _ipsas_refusal) and 20261014100000 (_cr_certified_accounts, _cr_member).
-- New objects only; no existing table, row or privilege is changed. No outer transaction: the native migrator owns it (see PR #210).
--
-- IPSAS accrual grants and revenue by period (charter R1, R2, R6, G5; docs/release/ipsas-accrual-chain-r1/GRANTS.md):
--   ipsas_grant_revisions       append-only revisions of one period's grant register: agreements, classification, obligations,
--                               satisfaction evidence, complexity answers, trial-balance account selection
--   ipsas_grant_confirmations   append-only confirmations by a named reviewer of ONE grant's exact assessment (hash bound to the
--                               grant AND the server-derived period start); any change to the grant voids it
--   _ipsas_grants_period        the reporting period, read from the CERTIFIED upload's fiscal period, never from the browser
--   _ipsas_tb_sum               a certified-trial-balance sum for chosen account keys (NULL = unknown, never zero)
--   _ipsas_grants_assess        pure assessment (SQL twin of src/lib/ipsasAccrual/grants.ts, same blocker codes)
--   ipsas_grants_context / ipsas_save_grants / ipsas_confirm_grant
-- Revenue is computed ONLY from evidenced satisfaction of obligations (or recognised resources for a restriction / no present
-- obligation). Cash received and expenditure never enter it. Everything is recomputed from persisted inputs; no browser-supplied
-- total, period, confirmation or ready flag is authority. Only companies reporting under ipsas_accrual are served.

CREATE TABLE public.ipsas_grant_revisions (
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  period_year integer NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 400000),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  certification_id uuid REFERENCES public.tb_certifications(id) ON DELETE RESTRICT,
  receipt jsonb NOT NULL,
  actor_user_id uuid NOT NULL,
  firm_member_id uuid,
  request_id uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_user_id, request_id)
);
CREATE INDEX ipsas_grant_revisions_latest ON public.ipsas_grant_revisions (company_id, period_year, seq DESC);
ALTER TABLE public.ipsas_grant_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ipsas_grant_revisions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.ipsas_grant_revisions_seq_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER ipsas_grant_revisions_immutable BEFORE UPDATE OR DELETE ON public.ipsas_grant_revisions FOR EACH ROW EXECUTE FUNCTION public._ipsas_immutable();
CREATE TRIGGER ipsas_grant_revisions_no_truncate BEFORE TRUNCATE ON public.ipsas_grant_revisions FOR EACH STATEMENT EXECUTE FUNCTION public._ipsas_immutable();

CREATE TABLE public.ipsas_grant_confirmations (
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  period_year integer NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  grant_id text NOT NULL CHECK (length(grant_id) BETWEEN 1 AND 64),
  subject_sha256 text NOT NULL CHECK (subject_sha256 ~ '^[0-9a-f]{64}$'),
  revision_id uuid NOT NULL REFERENCES public.ipsas_grant_revisions(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL,
  firm_member_id uuid,
  request_id uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_user_id, request_id)
);
CREATE INDEX ipsas_grant_confirmations_subject ON public.ipsas_grant_confirmations (company_id, period_year, grant_id, subject_sha256);
ALTER TABLE public.ipsas_grant_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ipsas_grant_confirmations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.ipsas_grant_confirmations_seq_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER ipsas_grant_confirmations_immutable BEFORE UPDATE OR DELETE ON public.ipsas_grant_confirmations FOR EACH ROW EXECUTE FUNCTION public._ipsas_immutable();
CREATE TRIGGER ipsas_grant_confirmations_no_truncate BEFORE TRUNCATE ON public.ipsas_grant_confirmations FOR EACH STATEMENT EXECUTE FUNCTION public._ipsas_immutable();

-- A JSON string that is an exact non-negative amount; anything else (a JSON number, null, text) is NULL = not exact.
CREATE FUNCTION public._ipsas_natj(p jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS
$$ SELECT CASE WHEN jsonb_typeof(p) = 'string' THEN public._ipsas_nat(p #>> '{}') END $$;
REVOKE ALL ON FUNCTION public._ipsas_natj(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- The reporting period of the CURRENT certification's upload (fiscal_periods), the certification id, and nothing typed by a user.
CREATE FUNCTION public._ipsas_grants_period(p_company_id uuid, p_period_year integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('certificationId', c.id, 'start', fp.reporting_start::text, 'end', fp.reporting_end::text)
    FROM public.tb_certifications c
    JOIN public.trial_balance_uploads u ON u.id = c.upload_id
    LEFT JOIN public.fiscal_periods fp ON fp.id = u.period_id
   WHERE c.company_id = p_company_id AND c.period_year = p_period_year
   ORDER BY c.sequence_no DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public._ipsas_grants_period(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;

-- Sum over chosen account keys of the current certification: side 'credit' = credit − debit, 'debit' = debit − credit. NULL when
-- there is no certification, no key, a missing key, or any selected row is not an exact tb-row/1 amount.
CREATE FUNCTION public._ipsas_tb_sum(p_company_id uuid, p_period_year integer, p_keys jsonb, p_side text) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_cert uuid; v_keys text[]; v_n integer; v_exact boolean; v_sum numeric;
BEGIN
  IF jsonb_typeof(p_keys) IS DISTINCT FROM 'array' OR jsonb_array_length(p_keys) = 0 THEN RETURN NULL; END IF;
  v_keys := ARRAY(SELECT jsonb_array_elements_text(p_keys));
  SELECT c.id INTO v_cert FROM public.tb_certifications c WHERE c.company_id = p_company_id AND c.period_year = p_period_year ORDER BY c.sequence_no DESC LIMIT 1;
  IF v_cert IS NULL THEN RETURN NULL; END IF;
  SELECT count(*), coalesce(bool_and(a.exact), true),
         sum(CASE WHEN p_side = 'credit' THEN a.credit_minor - a.debit_minor ELSE a.debit_minor - a.credit_minor END)
    INTO v_n, v_exact, v_sum FROM public._cr_certified_accounts(v_cert) a WHERE a.account_key = ANY (v_keys);
  IF v_n <> cardinality(v_keys) OR NOT v_exact THEN RETURN NULL; END IF;
  RETURN v_sum;
END;
$$;
REVOKE ALL ON FUNCTION public._ipsas_tb_sum(uuid, integer, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

-- What a reviewer confirms for one grant: the grant exactly as saved, bound to the server-derived period start.
CREATE FUNCTION public._ipsas_grant_subject_sha(p_grant jsonb, p_start text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('grant', p_grant, 'periodStart', p_start)::text, 'UTF8')), 'hex');
$$;
REVOKE ALL ON FUNCTION public._ipsas_grant_subject_sha(jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

-- ── assessment ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- p_period = {start,end} from _ipsas_grants_period (NULLs allowed); p_tb = {revenueMinor, liabilityMinor, receivableMinor};
-- p_confirmed = {grantId: true}. Returns {model, state, codes ['CODE|grantId'], grants[], totals}.
CREATE FUNCTION public._ipsas_grants_assess(p_payload jsonb, p_period jsonb, p_tb jsonb, p_confirmed jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  v_codes text[] := '{}'; v_start text := p_period->>'start'; v_model text; v_reviewed boolean := false;
  v_g jsonb; v_o jsonb; v_id text; v_ref text; v_where text; v_c text; v_ids text[] := '{}'; v_refs text[] := '{}'; v_oids text[];
  v_gc text[]; v_figs jsonb := '[]'::jsonb; v_k text; v_a jsonb; v_q text;
  v_cons numeric; v_rec numeric; v_cash numeric; v_prior numeric; v_al numeric; v_sa numeric; v_alloc numeric; v_sat numeric; v_obl_ok boolean; v_has_obl boolean;
  v_cum numeric; v_f_rev numeric; v_f_liab numeric; v_f_recv numeric; v_computed boolean; v_n_obl integer;
  v_rev numeric := 0; v_liab numeric := 0; v_recv numeric := 0; v_tb numeric; v_resolved boolean;
  c_blockers CONSTANT text[] := ARRAY['GRANT_CLASSIFICATION_REQUIRED', 'CLASSIFICATION_PERIOD_MISMATCH', 'GRANT_AMOUNT_NOT_EXACT', 'COMPLEXITY_UNANSWERED', 'COMPLEX_GRANT_WORKPAPER_REQUIRED',
    'NOT_FULLY_FUNDED_GRANT_WORKPAPER_REQUIRED', 'CASH_EXCEEDS_RECOGNISED_RESOURCES', 'OBLIGATIONS_REQUIRED', 'OBLIGATION_ALLOCATION_MISMATCH', 'OBLIGATIONS_CONTRADICT_CLASSIFICATION',
    'OBLIGATION_SATISFACTION_EXCEEDS_ALLOCATION', 'DUPLICATE_OBLIGATION', 'REVENUE_REVERSAL_WORKPAPER_REQUIRED'];
  c_complexities CONSTANT text[] := ARRAY['variableConsideration', 'financing', 'agent', 'nonCash', 'modification', 'creditLoss', 'foreignCurrency'];
BEGIN
  v_model := CASE WHEN v_start IS NULL OR v_start !~ '^\d{4}-\d{2}-\d{2}$' THEN NULL WHEN v_start < '2026-01-01' THEN 'ipsas23' ELSE 'ipsas47' END;
  IF v_model IS NOT NULL THEN v_reviewed := v_start >= '2024-01-01' AND v_start < '2027-01-01'; END IF;
  IF v_model IS NULL THEN v_codes := array_append(v_codes, 'PERIOD_UNKNOWN|');
  ELSIF NOT v_reviewed THEN v_codes := array_append(v_codes, 'PERIOD_PROFILE_NOT_REVIEWED|'); END IF;
  -- entity questions that depend on the period's model
  FOREACH v_q IN ARRAY ARRAY['early_application_47', 'transition_47'] LOOP
    IF (v_q = 'early_application_47' AND v_model IS DISTINCT FROM 'ipsas23') OR (v_q = 'transition_47' AND v_model IS DISTINCT FROM 'ipsas47') THEN CONTINUE; END IF;
    v_a := p_payload#>ARRAY['entityAnswers', v_q];
    v_resolved := v_a IS NOT NULL AND jsonb_typeof(v_a) = 'object' AND coalesce(v_a->>'status', '') IN ('answered', 'none_with_basis', 'not_applicable') AND public._ipsas_enough(v_a->>'text', 8) AND public._ipsas_enough(v_a->>'evidence');
    IF NOT v_resolved THEN v_codes := array_append(v_codes, 'ENTITY_QUESTION_UNRESOLVED:' || v_q || '|');
    ELSIF (v_a#>'{flags,applies}') = 'true'::jsonb THEN v_codes := array_append(v_codes, 'SPECIALISED_ROUTE_REQUIRED:' || v_q || '|');
    ELSIF (v_a#>'{flags,applies}') IS DISTINCT FROM 'false'::jsonb THEN v_codes := array_append(v_codes, 'ENTITY_QUESTION_UNRESOLVED:' || v_q || '|'); END IF;
  END LOOP;
  FOR v_g IN SELECT value FROM jsonb_array_elements(public._ipsas_arr(p_payload->'grants')) LOOP
    v_gc := '{}'; v_id := coalesce(v_g->>'grantId', ''); v_ref := btrim(coalesce(v_g->>'reference', ''));
    v_where := coalesce(nullif(v_ref, ''), v_id);
    IF v_id = ANY (v_ids) THEN v_gc := array_append(v_gc, 'DUPLICATE_GRANT_ID'); END IF;
    v_ids := v_ids || v_id;
    IF v_where = ANY (v_refs) THEN v_gc := array_append(v_gc, 'DUPLICATE_GRANT_REFERENCE'); END IF;
    v_refs := v_refs || v_where;
    IF NOT public._ipsas_enough(v_g->>'agreementEvidence') THEN v_gc := array_append(v_gc, 'AGREEMENT_EVIDENCE_MISSING'); END IF;
    IF NOT public._ipsas_enough(v_g->>'classificationBasis', 8) OR NOT public._ipsas_enough(v_g->>'classificationEvidence') OR NOT public._ipsas_enough(v_g->>'complexityBasis', 8) THEN v_gc := array_append(v_gc, 'GRANT_BASIS_MISSING'); END IF;
    v_c := coalesce(v_g->>'classification', '');
    IF v_c = '' THEN v_gc := array_append(v_gc, 'GRANT_CLASSIFICATION_REQUIRED');
    ELSIF v_model IS NOT NULL AND ((v_model = 'ipsas23' AND v_c NOT IN ('restriction-only', 'enforceable-condition'))
        OR (v_model = 'ipsas47' AND v_c NOT IN ('binding-arrangement', 'without-binding-with-present-obligation', 'without-binding-no-present-obligation'))) THEN
      v_gc := array_append(v_gc, 'CLASSIFICATION_PERIOD_MISMATCH');
    END IF;
    v_cons := public._ipsas_natj(v_g->'considerationMinor'); v_rec := public._ipsas_natj(v_g->'recognisedResourcesMinor');
    v_cash := public._ipsas_natj(v_g->'cashReceivedMinor'); v_prior := public._ipsas_natj(v_g->'priorCumulativeRevenueMinor');
    IF v_cons IS NULL OR v_rec IS NULL OR v_cash IS NULL OR v_prior IS NULL THEN v_gc := array_append(v_gc, 'GRANT_AMOUNT_NOT_EXACT'); END IF;
    FOREACH v_k IN ARRAY c_complexities LOOP
      IF jsonb_typeof(v_g#>ARRAY['complexities', v_k]) IS DISTINCT FROM 'boolean' THEN v_gc := array_append(v_gc, 'COMPLEXITY_UNANSWERED'); EXIT; END IF;
    END LOOP;
    FOREACH v_k IN ARRAY c_complexities LOOP
      IF (v_g#>ARRAY['complexities', v_k]) = 'true'::jsonb THEN v_gc := array_append(v_gc, 'COMPLEX_GRANT_WORKPAPER_REQUIRED'); EXIT; END IF;
    END LOOP;
    IF v_cons IS NOT NULL AND v_rec IS NOT NULL AND v_cons <> v_rec THEN v_gc := array_append(v_gc, 'NOT_FULLY_FUNDED_GRANT_WORKPAPER_REQUIRED'); END IF;
    IF v_rec IS NOT NULL AND v_cash IS NOT NULL AND v_cash > v_rec THEN v_gc := array_append(v_gc, 'CASH_EXCEEDS_RECOGNISED_RESOURCES'); END IF;
    v_has_obl := v_c IN ('enforceable-condition', 'binding-arrangement', 'without-binding-with-present-obligation');
    v_alloc := 0; v_sat := 0; v_obl_ok := true; v_oids := '{}'; v_n_obl := 0;
    FOR v_o IN SELECT value FROM jsonb_array_elements(public._ipsas_arr(v_g->'obligations')) LOOP
      v_n_obl := v_n_obl + 1;
      v_al := public._ipsas_natj(v_o->'allocatedMinor'); v_sa := public._ipsas_natj(v_o->'satisfiedMinor');
      IF NOT public._ipsas_enough(v_o->>'id', 1) OR (v_o->>'id') = ANY (v_oids) THEN v_gc := array_append(v_gc, 'DUPLICATE_OBLIGATION'); END IF;
      v_oids := v_oids || coalesce(v_o->>'id', '');
      IF v_al IS NULL OR v_sa IS NULL THEN v_gc := array_append(v_gc, 'GRANT_AMOUNT_NOT_EXACT'); v_obl_ok := false; CONTINUE; END IF;
      IF v_sa > v_al THEN v_gc := array_append(v_gc, 'OBLIGATION_SATISFACTION_EXCEEDS_ALLOCATION'); END IF;
      IF v_sa > 0 AND (coalesce(v_o->>'satisfactionBasis', '') NOT IN ('milestone-delivered', 'output-measure', 'time-elapsed', 'agreement-stated-expenditure') OR NOT public._ipsas_enough(v_o->>'satisfactionEvidence')) THEN
        v_gc := array_append(v_gc, 'SATISFACTION_EVIDENCE_MISSING');
      END IF;
      v_alloc := v_alloc + v_al; v_sat := v_sat + v_sa;
    END LOOP;
    IF v_has_obl AND v_obl_ok AND v_n_obl = 0 THEN v_gc := array_append(v_gc, 'OBLIGATIONS_REQUIRED');
    ELSIF v_has_obl AND v_obl_ok AND v_cons IS NOT NULL AND v_alloc <> v_cons THEN v_gc := array_append(v_gc, 'OBLIGATION_ALLOCATION_MISMATCH'); END IF;
    IF NOT v_has_obl AND v_c <> '' AND v_n_obl > 0 THEN v_gc := array_append(v_gc, 'OBLIGATIONS_CONTRADICT_CLASSIFICATION'); END IF;
    IF NOT public._ipsas_enough(v_g->>'priorEvidence') AND v_prior IS NOT NULL AND v_prior > 0 THEN v_gc := array_append(v_gc, 'PRIOR_REVENUE_EVIDENCE_MISSING'); END IF;
    -- figures: only when nothing that affects them is open; otherwise NOT computed
    v_f_rev := NULL; v_f_liab := NULL; v_f_recv := NULL; v_cum := NULL; v_computed := false;
    IF NOT (v_gc && c_blockers) AND v_cons IS NOT NULL AND v_rec IS NOT NULL AND v_cash IS NOT NULL AND v_prior IS NOT NULL AND v_obl_ok THEN
      v_cum := CASE WHEN v_has_obl THEN v_sat ELSE v_rec END;
      IF v_prior > v_cum THEN v_gc := array_append(v_gc, 'REVENUE_REVERSAL_WORKPAPER_REQUIRED'); v_cum := NULL;
      ELSE v_f_rev := v_cum - v_prior; v_f_liab := v_rec - v_cum; v_f_recv := v_rec - v_cash; v_computed := true; END IF;
    END IF;
    IF coalesce(p_confirmed->>v_id, '') <> 'true' THEN v_gc := array_append(v_gc, 'GRANT_ASSESSMENT_UNCONFIRMED'); END IF;
    v_codes := v_codes || ARRAY(SELECT x || '|' || v_id FROM unnest(v_gc) x);
    v_figs := v_figs || jsonb_build_object('grantId', v_id, 'cumulativeRevenueMinor', v_cum::text, 'periodRevenueMinor', v_f_rev::text, 'liabilityMinor', v_f_liab::text,
      'receivableMinor', v_f_recv::text, 'cashReceivedMinor', v_cash::text, 'considerationMinor', v_cons::text);
    v_rev := CASE WHEN v_rev IS NOT NULL AND v_f_rev IS NOT NULL THEN v_rev + v_f_rev END;
    v_liab := CASE WHEN v_liab IS NOT NULL AND v_f_liab IS NOT NULL THEN v_liab + v_f_liab END;
    v_recv := CASE WHEN v_recv IS NOT NULL AND v_f_recv IS NOT NULL THEN v_recv + v_f_recv END;
  END LOOP;
  IF jsonb_array_length(public._ipsas_arr(p_payload->'grants')) = 0 THEN
    v_a := p_payload#>'{entityAnswers,no_grants}';
    v_resolved := v_a IS NOT NULL AND jsonb_typeof(v_a) = 'object' AND coalesce(v_a->>'status', '') IN ('answered', 'none_with_basis', 'not_applicable') AND public._ipsas_enough(v_a->>'text', 8) AND public._ipsas_enough(v_a->>'evidence');
    IF NOT v_resolved THEN v_codes := array_append(v_codes, 'ENTITY_QUESTION_UNRESOLVED:no_grants|');
    ELSIF (v_a#>'{flags,applies}') IS DISTINCT FROM 'false'::jsonb THEN v_codes := array_append(v_codes, 'NO_GRANTS_RECORDED|'); END IF;
  END IF;
  v_tb := public._ipsas_minor(p_tb->>'revenueMinor');
  IF v_tb IS NULL THEN v_codes := array_append(v_codes, 'TB_GRANT_REVENUE_UNKNOWN|'); ELSIF v_rev IS NOT NULL AND v_rev <> v_tb THEN v_codes := array_append(v_codes, 'TB_GRANT_REVENUE_DIFFERENCE|'); END IF;
  v_tb := public._ipsas_minor(p_tb->>'liabilityMinor');
  IF v_tb IS NULL THEN v_codes := array_append(v_codes, 'TB_GRANT_LIABILITY_UNKNOWN|'); ELSIF v_liab IS NOT NULL AND v_liab <> v_tb THEN v_codes := array_append(v_codes, 'TB_GRANT_LIABILITY_DIFFERENCE|'); END IF;
  v_tb := public._ipsas_minor(p_tb->>'receivableMinor');
  IF v_tb IS NULL THEN v_codes := array_append(v_codes, 'TB_GRANT_RECEIVABLE_UNKNOWN|'); ELSIF v_recv IS NOT NULL AND v_recv <> v_tb THEN v_codes := array_append(v_codes, 'TB_GRANT_RECEIVABLE_DIFFERENCE|'); END IF;
  v_codes := ARRAY(SELECT DISTINCT x FROM unnest(v_codes) x ORDER BY x);
  RETURN jsonb_build_object('contract', 'cfoclose-ipsas-grants/1', 'model', v_model, 'state', CASE WHEN cardinality(v_codes) = 0 THEN 'ready-for-review' ELSE 'incomplete' END,
    'codes', to_jsonb(v_codes), 'grants', v_figs, 'totals', jsonb_build_object('periodRevenueMinor', v_rev::text, 'liabilityMinor', v_liab::text, 'receivableMinor', v_recv::text));
END;
$$;
REVOKE ALL ON FUNCTION public._ipsas_grants_assess(jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._ipsas_grants_live(p_company_id uuid, p_period_year integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_rev public.ipsas_grant_revisions; v_period jsonb; v_tb jsonb; v_confirmed jsonb := '{}'::jsonb; v_g jsonb; v_sel jsonb;
BEGIN
  SELECT * INTO v_rev FROM public.ipsas_grant_revisions WHERE company_id = p_company_id AND period_year = p_period_year ORDER BY seq DESC LIMIT 1;
  v_period := coalesce(public._ipsas_grants_period(p_company_id, p_period_year), jsonb_build_object('certificationId', NULL, 'start', NULL, 'end', NULL));
  IF v_rev.id IS NULL THEN RETURN jsonb_build_object('period', v_period, 'revisionId', NULL, 'assessment', NULL, 'tb', NULL, 'confirmedGrants', v_confirmed); END IF;
  v_sel := coalesce(v_rev.payload->'tbSelection', '{}'::jsonb);
  v_tb := jsonb_build_object('revenueMinor', public._ipsas_tb_sum(p_company_id, p_period_year, v_sel->'revenueKeys', 'credit')::text,
    'liabilityMinor', public._ipsas_tb_sum(p_company_id, p_period_year, v_sel->'liabilityKeys', 'credit')::text,
    'receivableMinor', public._ipsas_tb_sum(p_company_id, p_period_year, v_sel->'receivableKeys', 'debit')::text);
  FOR v_g IN SELECT value FROM jsonb_array_elements(public._ipsas_arr(v_rev.payload->'grants')) LOOP
    IF EXISTS (SELECT 1 FROM public.ipsas_grant_confirmations k WHERE k.company_id = p_company_id AND k.period_year = p_period_year AND k.grant_id = (v_g->>'grantId')
                 AND k.subject_sha256 = public._ipsas_grant_subject_sha(v_g, v_period->>'start')) THEN
      v_confirmed := v_confirmed || jsonb_build_object(v_g->>'grantId', true);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('period', v_period, 'revisionId', v_rev.id, 'tb', v_tb, 'confirmedGrants', v_confirmed,
    'assessment', public._ipsas_grants_assess(v_rev.payload, v_period, v_tb, v_confirmed));
END;
$$;
REVOKE ALL ON FUNCTION public._ipsas_grants_live(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.ipsas_grants_context(p_company_id uuid, p_period_year integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_refusal text; v_rev jsonb; v_conf jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  v_refusal := public._ipsas_refusal(p_company_id, auth.uid(), 'read');
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome', v_refusal); END IF;
  IF p_period_year IS NULL OR p_period_year NOT BETWEEN 2000 AND 2100 THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  SELECT jsonb_build_object('id', r.id, 'payload', r.payload, 'sha256', r.payload_sha256, 'createdAt', r.created_at) INTO v_rev
    FROM public.ipsas_grant_revisions r WHERE r.company_id = p_company_id AND r.period_year = p_period_year ORDER BY r.seq DESC LIMIT 1;
  SELECT coalesce(jsonb_agg(jsonb_build_object('grantId', k.grant_id, 'subjectSha256', k.subject_sha256, 'firmMemberId', k.firm_member_id, 'createdAt', k.created_at) ORDER BY k.seq), '[]'::jsonb) INTO v_conf
    FROM public.ipsas_grant_confirmations k WHERE k.company_id = p_company_id AND k.period_year = p_period_year;
  RETURN jsonb_build_object('outcome', 'available', 'contract', 'cfoclose-ipsas-grants-context/1', 'register', v_rev, 'confirmations', v_conf, 'live', public._ipsas_grants_live(p_company_id, p_period_year));
END;
$$;

CREATE FUNCTION public.ipsas_save_grants(p_company_id uuid, p_period_year integer, p_payload jsonb, p_expected_id uuid, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_refusal text; v_fp text; v_prior public.ipsas_grant_revisions; v_current uuid; v_id uuid := gen_random_uuid(); v_at timestamptz; v_cert uuid; v_receipt jsonb; v_sha text; v_g jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  v_refusal := public._ipsas_refusal(p_company_id, auth.uid(), 'prepare_close');
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome', v_refusal); END IF;
  IF p_period_year IS NULL OR p_period_year NOT BETWEEN 2000 AND 2100 OR p_request_id IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR octet_length(p_payload::text) > 300000 OR p_payload->>'contract' IS DISTINCT FROM 'cfoclose-ipsas-grants/1'
     OR p_payload->>'companyId' IS DISTINCT FROM p_company_id::text OR p_payload->>'periodYear' IS DISTINCT FROM p_period_year::text
     OR jsonb_typeof(p_payload->'grants') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'grants') > 100
     OR jsonb_typeof(p_payload->'entityAnswers') IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload->'tbSelection') IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  FOR v_g IN SELECT value FROM jsonb_array_elements(p_payload->'grants') LOOP
    IF jsonb_typeof(v_g) <> 'object' OR coalesce(v_g->>'grantId', '') !~ '^[0-9a-fA-F-]{36}$' OR jsonb_array_length(public._ipsas_arr(v_g->'obligations')) > 50 THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  END LOOP;
  v_fp := encode(sha256(convert_to(jsonb_build_object('payload', p_payload, 'expectedId', p_expected_id)::text, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('ipsas_request:' || auth.uid()::text || ':' || p_request_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ipsas_grants:' || p_company_id::text || ':' || p_period_year::text, 0));
  SELECT * INTO v_prior FROM public.ipsas_grant_revisions WHERE actor_user_id = auth.uid() AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.company_id = p_company_id AND v_prior.period_year = p_period_year AND v_prior.request_fingerprint = v_fp THEN RETURN v_prior.receipt || jsonb_build_object('replay', true); END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  SELECT id INTO v_current FROM public.ipsas_grant_revisions WHERE company_id = p_company_id AND period_year = p_period_year ORDER BY seq DESC LIMIT 1;
  IF v_current IS DISTINCT FROM p_expected_id THEN RETURN jsonb_build_object('outcome', 'stale', 'currentId', v_current); END IF;
  v_cert := (public._ipsas_grants_period(p_company_id, p_period_year))->>'certificationId';
  v_sha := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');
  v_at := clock_timestamp();
  v_receipt := jsonb_build_object('outcome', 'recorded', 'revisionId', v_id, 'createdAt', v_at, 'payloadSha256', v_sha);
  INSERT INTO public.ipsas_grant_revisions (id, company_id, period_year, payload, payload_sha256, certification_id, receipt, actor_user_id, firm_member_id, request_id, request_fingerprint, created_at)
  VALUES (v_id, p_company_id, p_period_year, p_payload, v_sha, v_cert, v_receipt, auth.uid(), public._cr_member(p_company_id, auth.uid()), p_request_id, v_fp, v_at);
  RETURN v_receipt || jsonb_build_object('live', public._ipsas_grants_live(p_company_id, p_period_year));
END;
$$;

CREATE FUNCTION public.ipsas_confirm_grant(p_company_id uuid, p_period_year integer, p_grant_id text, p_expected_revision_id uuid, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_refusal text; v_fp text; v_prior public.ipsas_grant_confirmations; v_rev public.ipsas_grant_revisions; v_grant jsonb; v_sha text; v_period jsonb; v_id uuid := gen_random_uuid();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  v_refusal := public._ipsas_refusal(p_company_id, auth.uid(), 'review_close');
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome', v_refusal); END IF;
  IF p_period_year IS NULL OR p_period_year NOT BETWEEN 2000 AND 2100 OR p_request_id IS NULL OR p_expected_revision_id IS NULL OR p_grant_id IS NULL OR length(p_grant_id) NOT BETWEEN 1 AND 64 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  v_fp := encode(sha256(convert_to(jsonb_build_object('grant', p_grant_id, 'revision', p_expected_revision_id)::text, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('ipsas_request:' || auth.uid()::text || ':' || p_request_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ipsas_grants:' || p_company_id::text || ':' || p_period_year::text, 0));
  SELECT * INTO v_prior FROM public.ipsas_grant_confirmations WHERE actor_user_id = auth.uid() AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.company_id = p_company_id AND v_prior.period_year = p_period_year AND v_prior.request_fingerprint = v_fp THEN
      RETURN jsonb_build_object('outcome', 'confirmed', 'confirmationId', v_prior.id, 'subjectSha256', v_prior.subject_sha256, 'replay', true);
    END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  SELECT * INTO v_rev FROM public.ipsas_grant_revisions WHERE company_id = p_company_id AND period_year = p_period_year ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND OR v_rev.id <> p_expected_revision_id THEN RETURN jsonb_build_object('outcome', 'stale', 'currentId', v_rev.id); END IF;
  SELECT g.value INTO v_grant FROM jsonb_array_elements(public._ipsas_arr(v_rev.payload->'grants')) g(value) WHERE g.value->>'grantId' = p_grant_id LIMIT 1;
  IF v_grant IS NULL THEN RETURN jsonb_build_object('outcome', 'unknown_subject'); END IF;
  v_period := public._ipsas_grants_period(p_company_id, p_period_year);
  IF v_period IS NULL OR v_period->>'start' IS NULL OR coalesce(v_grant->>'classification', '') = '' OR NOT public._ipsas_enough(v_grant->>'classificationBasis', 8) THEN RETURN jsonb_build_object('outcome', 'not_confirmable'); END IF;
  v_sha := public._ipsas_grant_subject_sha(v_grant, v_period->>'start');
  INSERT INTO public.ipsas_grant_confirmations (id, company_id, period_year, grant_id, subject_sha256, revision_id, actor_user_id, firm_member_id, request_id, request_fingerprint)
  VALUES (v_id, p_company_id, p_period_year, p_grant_id, v_sha, v_rev.id, auth.uid(), public._cr_member(p_company_id, auth.uid()), p_request_id, v_fp);
  RETURN jsonb_build_object('outcome', 'confirmed', 'confirmationId', v_id, 'subjectSha256', v_sha, 'live', public._ipsas_grants_live(p_company_id, p_period_year));
END;
$$;

REVOKE ALL ON FUNCTION public.ipsas_grants_context(uuid, integer), public.ipsas_save_grants(uuid, integer, jsonb, uuid, uuid), public.ipsas_confirm_grant(uuid, integer, text, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ipsas_grants_context(uuid, integer), public.ipsas_save_grants(uuid, integer, jsonb, uuid, uuid), public.ipsas_confirm_grant(uuid, integer, text, uuid, uuid) TO authenticated;
