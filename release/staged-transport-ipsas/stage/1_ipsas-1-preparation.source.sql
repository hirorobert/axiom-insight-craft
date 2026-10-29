INSERT INTO cfoclose_ipsas_release.staged_artifacts(batch, kind, body) VALUES ('ipsas-1-preparation', 'source', $cfoclose_ipsas_stage_3fb7460f4b5ff456$-- Authored forward migration; NOT applied hosted. Follows 20261206100000 (multi-class equipment preparation: it reuses
-- _fs_equipment_depreciation_charge / _fs_equipment_rational) and 20261014100000 (_cr_certified_accounts, _cr_member).
-- No outer transaction: the native migrator owns it (see PR #210).
--
-- IPSAS accrual preparation, first chain (charter R1, R2, R4, R5, G3, G4, P6; docs/release/ipsas-accrual-chain-r1/RECORD.md):
--   ipsas_prep_revisions      append-only revisions of two kinds: prior_figures (printed prior-report figures + evidenced
--                             bridge items) and ppe_workpaper (cost-model classes, estimates, entity answers)
--   ipsas_confirmations       append-only confirmations by a named actor of ONE exact subject hash: a class's estimates, or
--                             the prior-figure set. A changed subject no longer matches, so a confirmation never carries over.
--   _ipsas_ppe_assess         pure rule evaluation of a workpaper (SQL twin of src/lib/ipsasAccrual/ppeWorkpaper.ts)
--   _ipsas_bridge_assess      pure opening-bridge evaluation (twin of openingBridge.ts); never creates a balancing amount
--   _ipsas_tb_facts           PPE carrying amounts and depreciation expense read from the CERTIFIED trial balance rows
--   ipsas_prep_context        latest revisions + live assessment; readers without capability see nothing
--   ipsas_save_preparation    compare-and-set save with request-identity replay; an incomplete draft is saveable
--   ipsas_confirm             records a confirmation for the exact subject the server holds (review_close)
-- Every assessment is recomputed here from persisted inputs; nothing the browser sends (totals, ready flags, estimate
-- confirmation, certification ids) is authority. Nothing here approves a report, issues anything, changes a framework,
-- or alters an existing table, row or privilege. Only a company whose reporting_framework is ipsas_accrual is served.

CREATE FUNCTION public._ipsas_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'IPSAS_PREPARATION_IMMUTABLE' USING ERRCODE = '42501'; END; $$;
REVOKE ALL ON FUNCTION public._ipsas_immutable() FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.ipsas_prep_revisions (
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  period_year integer NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  kind text NOT NULL CHECK (kind IN ('prior_figures', 'ppe_workpaper')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 200000),
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
CREATE INDEX ipsas_prep_revisions_latest ON public.ipsas_prep_revisions (company_id, period_year, kind, seq DESC);
ALTER TABLE public.ipsas_prep_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ipsas_prep_revisions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.ipsas_prep_revisions_seq_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER ipsas_prep_revisions_immutable BEFORE UPDATE OR DELETE ON public.ipsas_prep_revisions FOR EACH ROW EXECUTE FUNCTION public._ipsas_immutable();
CREATE TRIGGER ipsas_prep_revisions_no_truncate BEFORE TRUNCATE ON public.ipsas_prep_revisions FOR EACH STATEMENT EXECUTE FUNCTION public._ipsas_immutable();

CREATE TABLE public.ipsas_confirmations (
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  period_year integer NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  subject_kind text NOT NULL CHECK (subject_kind IN ('ppe_class_estimate', 'prior_figure_set')),
  subject_key text NOT NULL CHECK (length(subject_key) BETWEEN 1 AND 64),
  subject_sha256 text NOT NULL CHECK (subject_sha256 ~ '^[0-9a-f]{64}$'),
  revision_id uuid NOT NULL REFERENCES public.ipsas_prep_revisions(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL,
  firm_member_id uuid,
  request_id uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_user_id, request_id)
);
CREATE INDEX ipsas_confirmations_subject ON public.ipsas_confirmations (company_id, period_year, subject_kind, subject_key, subject_sha256);
ALTER TABLE public.ipsas_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ipsas_confirmations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.ipsas_confirmations_seq_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER ipsas_confirmations_immutable BEFORE UPDATE OR DELETE ON public.ipsas_confirmations FOR EACH ROW EXECUTE FUNCTION public._ipsas_immutable();
CREATE TRIGGER ipsas_confirmations_no_truncate BEFORE TRUNCATE ON public.ipsas_confirmations FOR EACH STATEMENT EXECUTE FUNCTION public._ipsas_immutable();

-- ── small exact parsers ──────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public._ipsas_minor(p text) RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS
$$ SELECT CASE WHEN p ~ '^(0|-?[1-9][0-9]{0,30})$' THEN p::numeric END $$;
CREATE FUNCTION public._ipsas_nat(p text) RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS
$$ SELECT CASE WHEN p ~ '^(0|[1-9][0-9]{0,30})$' THEN p::numeric END $$;
CREATE FUNCTION public._ipsas_enough(p text, n integer DEFAULT 3) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS
$$ SELECT p IS NOT NULL AND length(btrim(p)) >= n $$;
REVOKE ALL ON FUNCTION public._ipsas_minor(text), public._ipsas_nat(text), public._ipsas_enough(text, integer) FROM PUBLIC, anon, authenticated, service_role;

-- The authority a caller needs. NULL = allowed. A reader needs prepare_close or review_close; the framework must be IPSAS accrual.
CREATE FUNCTION public._ipsas_refusal(p_company_id uuid, p_uid uuid, p_capability text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN p_company_id IS NULL OR p_uid IS NULL THEN 'forbidden'
    WHEN p_capability = 'read' AND NOT (public.workspace_capability_allowed(p_company_id, p_uid, 'prepare_close') OR public.workspace_capability_allowed(p_company_id, p_uid, 'review_close')) THEN 'forbidden'
    WHEN p_capability <> 'read' AND NOT public.workspace_capability_allowed(p_company_id, p_uid, p_capability) THEN 'forbidden'
    WHEN NOT public.fs_rollout_allows(p_company_id) THEN 'feature_disabled'
    WHEN (SELECT c.reporting_framework FROM public.companies c WHERE c.id = p_company_id) IS DISTINCT FROM 'ipsas_accrual' THEN 'framework_not_ipsas_accrual'
  END;
$$;
REVOKE ALL ON FUNCTION public._ipsas_refusal(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- Authority for a MUTATION, judged at the protected mutation boundary. Every mutation first calls _ipsas_refusal (a cheap early refusal that also takes
-- the shared plan lock), then acquires its request and company-period advisory locks - which may WAIT behind other work - and only then calls this.
-- It (1) takes the SHARED member-capability lock for (workspace, person): revoke_member_capability and the other member-capability writers take the
-- same lock EXCLUSIVELY, so an explicit revocation and an in-flight mutation of that person are serialised and exactly one of them is first (the
-- revoker waits for the mutation's transaction to end; a mutation that starts after the revocation committed is refused below); and (2) judges
-- authority again on a FRESH statement snapshot (membership, capability, plan, rollout, framework), so anything committed while the mutation waited
-- is honoured. It must run before any replay lookup: a revoked actor is not handed the stored receipt of an earlier request.
-- Lock order (no cycle): request -> company-period -> member-capability (shared) -> plan (shared, re-entrant: already held from the early check).
-- It relies on READ COMMITTED (the default for PostgREST and the migrator): under a transaction-long snapshot a re-check could not see what committed
-- while waiting, so it fails closed instead of judging on a stale view.
CREATE FUNCTION public._ipsas_authorize_mutation(p_company_id uuid, p_uid uuid, p_capability text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_company_id IS NULL OR p_uid IS NULL THEN RETURN 'forbidden'; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'IPSAS_AUTHORITY_ISOLATION: authority is re-checked after the mutation boundary and needs READ COMMITTED' USING ERRCODE = '25000';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('workspace_member_capabilities:' || p_company_id::text || ':' || p_uid::text, 0));
  RETURN public._ipsas_refusal(p_company_id, p_uid, p_capability);
END;
$$;
REVOKE ALL ON FUNCTION public._ipsas_authorize_mutation(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- ── facts from the certified trial balance ────────────────────────────────────────────────────────────────────────────
-- p_selection = {"ppeAccountKeys": [...], "depreciationExpenseKeys": [...]}. A figure is NULL (unknown, never zero) when no
-- certification exists, a selected key is absent, or a selected row is not an exact tb-row/1 amount.
CREATE FUNCTION public._ipsas_tb_facts(p_company_id uuid, p_period_year integer, p_selection jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cur public.tb_certifications; v_prior public.tb_certifications;
  v_ppe text[] := ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_selection->'ppeAccountKeys') = 'array' THEN p_selection->'ppeAccountKeys' ELSE '[]'::jsonb END));
  v_dep text[] := ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_selection->'depreciationExpenseKeys') = 'array' THEN p_selection->'depreciationExpenseKeys' ELSE '[]'::jsonb END));
  v_closing numeric; v_opening numeric; v_expense numeric; v_n integer; v_exact boolean;
BEGIN
  SELECT * INTO v_cur FROM public.tb_certifications WHERE company_id = p_company_id AND period_year = p_period_year ORDER BY sequence_no DESC LIMIT 1;
  SELECT * INTO v_prior FROM public.tb_certifications WHERE company_id = p_company_id AND period_year = p_period_year - 1 ORDER BY sequence_no DESC LIMIT 1;
  IF v_cur.id IS NOT NULL AND cardinality(v_ppe) > 0 THEN
    SELECT count(*), coalesce(bool_and(a.exact), true), sum(a.debit_minor - a.credit_minor) INTO v_n, v_exact, v_closing
      FROM public._cr_certified_accounts(v_cur.id) a WHERE a.account_key = ANY (v_ppe);
    IF v_n <> cardinality(v_ppe) OR NOT v_exact THEN v_closing := NULL; END IF;
  END IF;
  IF v_cur.id IS NOT NULL AND cardinality(v_dep) > 0 THEN
    SELECT count(*), coalesce(bool_and(a.exact), true), sum(a.debit_minor - a.credit_minor) INTO v_n, v_exact, v_expense
      FROM public._cr_certified_accounts(v_cur.id) a WHERE a.account_key = ANY (v_dep);
    IF v_n <> cardinality(v_dep) OR NOT v_exact THEN v_expense := NULL; END IF;
  END IF;
  IF v_prior.id IS NOT NULL AND cardinality(v_ppe) > 0 THEN
    SELECT count(*), coalesce(bool_and(a.exact), true), sum(a.debit_minor - a.credit_minor) INTO v_n, v_exact, v_opening
      FROM public._cr_certified_accounts(v_prior.id) a WHERE a.account_key = ANY (v_ppe);
    IF v_n <> cardinality(v_ppe) OR NOT v_exact THEN v_opening := NULL; END IF;
  END IF;
  RETURN jsonb_build_object('certificationId', v_cur.id, 'isBlocking', v_cur.is_blocking, 'requiresReview', v_cur.requires_review,
    'priorCertificationId', v_prior.id, 'ppeCarryingClosingMinor', v_closing::text, 'ppeCarryingOpeningMinor', v_opening::text,
    'depreciationExpenseMinor', v_expense::text);
END;
$$;
REVOKE ALL ON FUNCTION public._ipsas_tb_facts(uuid, integer, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- ── the estimate subject: exactly what management confirms for one class ─────────────────────────────────────────────
CREATE FUNCTION public._ipsas_estimate_subject_sha(p_payload jsonb, p_class jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('measurementModel', p_class->'measurementModel', 'convention', p_payload->'convention',
    'period', p_payload->'period', 'estimate', (p_class->'estimate') - 'calculatedChargeMinor')::text, 'UTF8')), 'hex');
$$;
REVOKE ALL ON FUNCTION public._ipsas_estimate_subject_sha(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- ── PPE assessment, in small pure pieces ──────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public._ipsas_arr(p jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS
$$ SELECT CASE WHEN jsonb_typeof(p) = 'array' THEN p ELSE '[]'::jsonb END $$;
REVOKE ALL ON FUNCTION public._ipsas_arr(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- One class: both identities (opening + movements = closing in every column, gross - accumulated = carrying at each date),
-- exact amounts, movement signs and sources, itemised disposals. Returns {state agrees|incomplete|difference, depMinor}.
CREATE FUNCTION public._ipsas_class_roll(p_class jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE
  v_inc boolean := false; v_kinds text[] := '{}'; v_k text; v_m jsonb; v_it jsonb; v_sign text;
  v_og numeric; v_od numeric; v_oi numeric; v_oc numeric; v_cg numeric; v_cd numeric; v_ci numeric; v_cc numeric;
  v_g numeric; v_d numeric; v_i numeric; v_sg numeric := 0; v_sd numeric := 0; v_si numeric := 0;
  v_dep numeric := 0; v_dep_found boolean := false; v_has_disp boolean := false; v_dg numeric; v_dd numeric; v_di numeric;
  v_sc numeric; v_sad numeric; v_sai numeric; v_items_ok boolean; v_diff boolean := false;
BEGIN
  IF length(btrim(coalesce(p_class->>'label', ''))) < 3 THEN v_inc := true; END IF;
  v_og := public._ipsas_nat(p_class#>>'{opening,grossMinor}'); v_od := public._ipsas_nat(p_class#>>'{opening,accumulatedDepreciationMinor}');
  v_oi := public._ipsas_nat(p_class#>>'{opening,accumulatedImpairmentMinor}'); v_oc := public._ipsas_minor(p_class#>>'{opening,carryingMinor}');
  v_cg := public._ipsas_nat(p_class#>>'{closing,grossMinor}'); v_cd := public._ipsas_nat(p_class#>>'{closing,accumulatedDepreciationMinor}');
  v_ci := public._ipsas_nat(p_class#>>'{closing,accumulatedImpairmentMinor}'); v_cc := public._ipsas_minor(p_class#>>'{closing,carryingMinor}');
  IF v_og IS NULL OR v_od IS NULL OR v_oi IS NULL OR v_oc IS NULL OR v_cg IS NULL OR v_cd IS NULL OR v_ci IS NULL OR v_cc IS NULL THEN v_inc := true; END IF;
  FOR v_m IN SELECT value FROM jsonb_array_elements(public._ipsas_arr(p_class->'movements')) LOOP
    v_k := coalesce(v_m->>'kind', '');
    IF v_k <> ALL (ARRAY['additions', 'disposals', 'business_combinations', 'revaluations_and_oci_impairment', 'transfers_investment_property', 'impairment_profit_or_loss', 'depreciation', 'other']) THEN v_inc := true; CONTINUE; END IF;
    IF v_k = ANY (v_kinds) THEN v_inc := true; END IF;
    v_kinds := v_kinds || v_k;
    v_g := public._ipsas_minor(v_m->>'grossMinor'); v_d := public._ipsas_minor(v_m->>'accumulatedDepreciationMinor'); v_i := public._ipsas_minor(v_m->>'accumulatedImpairmentMinor');
    IF v_k = 'depreciation' AND NOT v_dep_found THEN v_dep := v_d; v_dep_found := true; END IF;
    IF v_k = 'disposals' AND NOT v_has_disp THEN v_has_disp := true; v_dg := v_g; v_dd := v_d; v_di := v_i; END IF;
    IF v_g IS NULL OR v_d IS NULL OR v_i IS NULL THEN v_inc := true; CONTINUE; END IF;
    v_sign := CASE WHEN v_k IN ('additions', 'business_combinations') THEN 'increase' WHEN v_k IN ('disposals', 'depreciation') THEN 'decrease' ELSE 'either' END;
    IF (v_sign = 'increase' AND v_g - v_d - v_i < 0) OR (v_sign = 'decrease' AND v_g - v_d - v_i > 0) THEN v_inc := true; END IF;
    IF coalesce(v_m#>>'{source,type}', '') <> ALL (ARRAY['register', 'ledger_account', 'journal', 'workpaper']) OR NOT public._ipsas_enough(v_m#>>'{source,reference}') THEN v_inc := true; END IF;
    v_sg := v_sg + v_g; v_sd := v_sd + v_d; v_si := v_si + v_i;
  END LOOP;
  IF v_has_disp AND v_dg IS NOT NULL AND v_dd IS NOT NULL AND v_di IS NOT NULL AND (v_dg <> 0 OR v_dd <> 0 OR v_di <> 0) THEN
    IF jsonb_array_length(public._ipsas_arr(p_class->'disposals')) = 0 THEN v_inc := true;
    ELSE
      v_sc := 0; v_sad := 0; v_sai := 0; v_items_ok := true;
      FOR v_it IN SELECT value FROM jsonb_array_elements(public._ipsas_arr(p_class->'disposals')) LOOP
        IF public._ipsas_nat(v_it->>'costMinor') IS NULL OR public._ipsas_nat(v_it->>'accumulatedDepreciationMinor') IS NULL OR public._ipsas_nat(v_it->>'accumulatedImpairmentMinor') IS NULL THEN v_items_ok := false; v_inc := true; CONTINUE; END IF;
        IF NOT public._ipsas_enough(v_it->>'reference') THEN v_inc := true; END IF;
        IF coalesce(v_it#>>'{source,type}', '') <> ALL (ARRAY['register', 'ledger_account', 'journal', 'workpaper']) OR NOT public._ipsas_enough(v_it#>>'{source,reference}') THEN v_inc := true; END IF;
        IF jsonb_typeof(v_it->'proceedsMinor') = 'string' AND public._ipsas_minor(v_it->>'proceedsMinor') IS NULL THEN v_inc := true; END IF;
        v_sc := v_sc + (v_it->>'costMinor')::numeric; v_sad := v_sad + (v_it->>'accumulatedDepreciationMinor')::numeric; v_sai := v_sai + (v_it->>'accumulatedImpairmentMinor')::numeric;
      END LOOP;
      IF v_items_ok AND (v_sc <> -v_dg OR v_sad <> -v_dd OR v_sai <> -v_di) THEN v_inc := true; END IF;
    END IF;
  END IF;
  IF NOT v_dep_found THEN v_dep := 0; END IF;
  IF v_inc THEN RETURN jsonb_build_object('state', 'incomplete', 'depMinor', v_dep::text); END IF;
  IF v_og - v_od - v_oi - v_oc <> 0 OR v_cg - v_cd - v_ci - v_cc <> 0 OR v_cg - v_og - v_sg <> 0 OR v_cd - v_od - v_sd <> 0
     OR v_ci - v_oi - v_si <> 0 OR v_cc - v_oc - (v_sg - v_sd - v_si) <> 0 THEN v_diff := true; END IF;
  RETURN jsonb_build_object('state', CASE WHEN v_diff THEN 'difference' ELSE 'agrees' END, 'depMinor', v_dep::text,
    'grossDifferenceMinor', (v_cg - v_og - v_sg)::text);
END;
$$;

-- Itemised disposals: unresolved items keep the gain unknown; proceeds NULL is unknown, never zero.
CREATE FUNCTION public._ipsas_disposal_summary(p_class jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE v_it jsonb; v_unres integer := 0; v_total numeric := 0; v_c numeric; v_a numeric; v_i numeric; v_p numeric;
BEGIN
  FOR v_it IN SELECT value FROM jsonb_array_elements(public._ipsas_arr(p_class->'disposals')) LOOP
    v_c := public._ipsas_nat(v_it->>'costMinor'); v_a := public._ipsas_nat(v_it->>'accumulatedDepreciationMinor'); v_i := public._ipsas_nat(v_it->>'accumulatedImpairmentMinor');
    v_p := CASE WHEN jsonb_typeof(v_it->'proceedsMinor') = 'string' THEN public._ipsas_minor(v_it->>'proceedsMinor') END;
    IF v_c IS NULL OR v_a IS NULL OR v_i IS NULL OR v_p IS NULL THEN v_unres := v_unres + 1; ELSE v_total := v_total + (v_p - (v_c - v_a - v_i)); END IF;
  END LOOP;
  RETURN jsonb_build_object('unresolved', v_unres, 'gainMinor', CASE WHEN v_unres = 0 THEN v_total::text END);
END;
$$;

-- The class charge recalculated from the entity's own items with the proven item calculator.
CREATE FUNCTION public._ipsas_class_charge(p_class jsonb, p_start date, p_end date, p_convention text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE v_it jsonb; v_r jsonb; v_sum numeric := 0; v_n integer := 0; v_bad boolean := false;
BEGIN
  FOR v_it IN SELECT value FROM jsonb_array_elements(public._ipsas_arr(p_class#>'{estimate,items}')) LOOP
    v_n := v_n + 1;
    v_r := public._fs_equipment_depreciation_charge(v_it, p_start, p_end, p_convention);
    IF v_r->>'state' <> 'calculated' THEN v_bad := true; ELSE v_sum := v_sum + (v_r->>'chargeMinor')::numeric; END IF;
  END LOOP;
  IF v_n = 0 OR v_bad THEN RETURN jsonb_build_object('state', 'insufficient'); END IF;
  RETURN jsonb_build_object('state', 'calculated', 'chargeMinor', v_sum::text);
END;
$$;
REVOKE ALL ON FUNCTION public._ipsas_class_roll(jsonb), public._ipsas_disposal_summary(jsonb), public._ipsas_class_charge(jsonb, date, date, text) FROM PUBLIC, anon, authenticated, service_role;

-- Returns {state, codes ['CODE|classId'], totals, classes}. p_confirmed = {classId: true} derived from ipsas_confirmations
-- by the caller; nothing in the payload is read as a confirmation. p_tb = _ipsas_tb_facts.
CREATE FUNCTION public._ipsas_ppe_assess(p_payload jsonb, p_tb jsonb, p_confirmed jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  v_codes text[] := '{}'; v_ids text[] := '{}'; v_labels text[] := '{}'; v_classes jsonb := '[]'::jsonb;
  v_start date; v_end date; v_conv text := coalesce(p_payload->>'convention', '');
  v_c jsonb; v_id text; v_label text; v_est jsonb; v_model text; v_m jsonb; v_it jsonb; v_roll jsonb; v_ch jsonb; v_disp jsonb; v_src text;
  v_dep numeric; v_calc numeric; v_source numeric; v_reg numeric; v_stated numeric; v_og numeric; v_oa numeric; v_add numeric;
  v_item_cost numeric; v_item_acc numeric; v_op numeric; v_cl numeric;
  v_open_sum numeric := 0; v_close_sum numeric := 0; v_dep_sum numeric := 0; v_gain_sum numeric := 0;
  v_tb numeric; v_a jsonb; v_q text; v_resolved boolean; v_diff numeric; v_unsupported boolean;
BEGIN
  BEGIN v_start := (p_payload#>>'{period,start}')::date; v_end := (p_payload#>>'{period,end}')::date; EXCEPTION WHEN OTHERS THEN v_start := NULL; v_end := NULL; END;
  IF jsonb_array_length(public._ipsas_arr(p_payload->'classes')) = 0 THEN v_codes := array_append(v_codes, 'NO_ASSET_CLASSES|'); END IF;
  FOR v_c IN SELECT value FROM jsonb_array_elements(public._ipsas_arr(p_payload->'classes')) LOOP
    v_id := coalesce(v_c->>'classId', ''); v_label := btrim(coalesce(v_c->>'label', '')); v_est := coalesce(v_c->'estimate', '{}'::jsonb);
    IF v_id = ANY (v_ids) THEN v_codes := v_codes || ('DUPLICATE_CLASS_ID|' || v_id); END IF;
    v_ids := v_ids || v_id;
    IF coalesce(nullif(v_label, ''), v_id) = ANY (v_labels) THEN v_codes := v_codes || ('DUPLICATE_CLASS_LABEL|' || v_id); END IF;
    v_labels := v_labels || coalesce(nullif(v_label, ''), v_id);
    v_model := coalesce(v_c->>'measurementModel', '');
    IF v_model = '' THEN v_codes := v_codes || ('MEASUREMENT_MODEL_REQUIRED|' || v_id);
    ELSIF v_model = 'revaluation' OR v_est->>'basis' = 'revaluation' THEN v_codes := v_codes || ('REVALUATION_MODEL_NOT_SUPPORTED|' || v_id);
    ELSIF v_est->>'basis' IS DISTINCT FROM 'cost' THEN v_codes := v_codes || ('MEASUREMENT_BASIS_MISMATCH|' || v_id); END IF;
    FOR v_m IN SELECT value FROM jsonb_array_elements(public._ipsas_arr(v_c->'movements')) LOOP
      IF coalesce(v_m->>'kind', '') <> ALL (ARRAY['additions', 'disposals', 'impairment_profit_or_loss', 'depreciation', 'other']) THEN v_codes := v_codes || ('UNSUPPORTED_MOVEMENT_KIND|' || v_id); END IF;
    END LOOP;
    v_roll := public._ipsas_class_roll(v_c);
    IF v_roll->>'state' = 'incomplete' THEN v_codes := v_codes || ('ROLL_FORWARD_INCOMPLETE|' || v_id);
    ELSIF v_roll->>'state' = 'difference' THEN v_codes := v_codes || ('ROLL_FORWARD_DIFFERENCE|' || v_id); END IF;
    v_dep := public._ipsas_minor(v_roll->>'depMinor');
    -- the movement must be an exact amount (the roll-forward already refuses a non-exact one as incomplete)
    v_calc := NULL; v_source := NULL; v_src := coalesce(v_est->>'chargeSource', '');
    IF v_src = 'calculated' THEN
      IF v_conv = '' THEN v_codes := v_codes || ('CONVENTION_REQUIRED|' || v_id); END IF;
      v_ch := public._ipsas_class_charge(v_c, v_start, v_end, v_conv);
      IF v_ch->>'state' = 'calculated' THEN
        v_calc := (v_ch->>'chargeMinor')::numeric; v_source := v_calc;
        v_item_cost := 0; v_item_acc := 0;
        FOR v_it IN SELECT value FROM jsonb_array_elements(public._ipsas_arr(v_est->'items')) LOOP
          v_item_cost := v_item_cost + coalesce(public._ipsas_minor(v_it->>'costMinor'), 0);
          v_item_acc := v_item_acc + coalesce(public._ipsas_minor(v_it->>'openingAccumulatedMinor'), 0);
        END LOOP;
        v_og := public._ipsas_minor(v_c#>>'{opening,grossMinor}'); v_oa := public._ipsas_minor(v_c#>>'{opening,accumulatedDepreciationMinor}');
        v_add := 0;
        SELECT public._ipsas_minor(m.value->>'grossMinor') INTO v_add FROM jsonb_array_elements(public._ipsas_arr(v_c->'movements')) m(value) WHERE m.value->>'kind' = 'additions' LIMIT 1;
        IF NOT FOUND THEN v_add := 0; END IF;
        IF v_og IS NOT NULL AND v_add IS NOT NULL AND v_item_cost <> v_og + v_add THEN v_codes := v_codes || ('ITEMS_COST_NOT_CLASS_GROSS|' || v_id); END IF;
        IF v_oa IS NOT NULL AND v_item_acc <> v_oa THEN v_codes := v_codes || ('ITEMS_ACCUMULATED_NOT_CLASS_OPENING|' || v_id); END IF;
      ELSE v_codes := v_codes || ('ESTIMATE_MISSING|' || v_id); END IF;
    ELSIF v_src = 'register' THEN
      v_reg := public._ipsas_minor(v_est->>'registerChargeMinor');
      IF v_reg IS NULL OR v_reg < 0 OR NOT public._ipsas_enough(v_est->>'registerReference') THEN v_codes := v_codes || ('REGISTER_CHARGE_INCOMPLETE|' || v_id); ELSE v_source := v_reg; END IF;
    ELSE v_codes := v_codes || ('CHARGE_SOURCE_REQUIRED|' || v_id); END IF;
    IF v_dep IS NULL THEN v_codes := v_codes || ('DEPRECIATION_MOVEMENT_NOT_EXACT|' || v_id);
    ELSIF v_source IS NOT NULL AND v_dep - v_source <> 0 THEN
      v_stated := public._ipsas_minor(v_est#>>'{chargeDifference,amountMinor}');
      IF v_stated IS NULL OR v_stated <> v_dep - v_source OR NOT public._ipsas_enough(v_est#>>'{chargeDifference,explanation}') OR NOT public._ipsas_enough(v_est#>>'{chargeDifference,evidence}') THEN
        v_codes := v_codes || ('CHARGE_DIFFERENCE_UNEXPLAINED|' || v_id);
      END IF;
    END IF;
    IF coalesce(p_confirmed->>v_id, '') <> 'true' THEN v_codes := v_codes || ('ESTIMATE_UNCONFIRMED|' || v_id); END IF;
    IF NOT public._ipsas_enough(v_est->>'rationale', 8) OR NOT public._ipsas_enough(v_est->>'evidence') THEN v_codes := v_codes || ('ESTIMATE_BASIS_MISSING|' || v_id); END IF;
    v_disp := public._ipsas_disposal_summary(v_c);
    IF (v_disp->>'unresolved')::integer > 0 THEN v_codes := v_codes || ('DISPOSAL_PROCEEDS_UNKNOWN|' || v_id); END IF;
    v_op := public._ipsas_minor(v_c#>>'{opening,carryingMinor}'); v_cl := public._ipsas_minor(v_c#>>'{closing,carryingMinor}');
    v_open_sum := CASE WHEN v_open_sum IS NOT NULL AND v_op IS NOT NULL THEN v_open_sum + v_op END;
    v_close_sum := CASE WHEN v_close_sum IS NOT NULL AND v_cl IS NOT NULL THEN v_close_sum + v_cl END;
    v_dep_sum := CASE WHEN v_dep_sum IS NOT NULL AND v_dep IS NOT NULL THEN v_dep_sum + v_dep END;
    v_gain_sum := CASE WHEN v_gain_sum IS NOT NULL AND v_disp->>'gainMinor' IS NOT NULL THEN v_gain_sum + (v_disp->>'gainMinor')::numeric END;
    v_classes := v_classes || jsonb_build_object('classId', v_id, 'rollForward', v_roll->>'state', 'chargeCalculatedMinor', v_calc::text,
      'depreciationMovementMinor', v_dep::text, 'disposalGainMinor', v_disp->>'gainMinor');
  END LOOP;
  -- ties to the certified trial balance; an absent figure is unknown, never zero
  v_tb := public._ipsas_minor(p_tb->>'ppeCarryingOpeningMinor');
  IF v_tb IS NULL THEN v_codes := array_append(v_codes, 'TB_CARRYING_OPENING_UNKNOWN|'); ELSIF v_open_sum IS NOT NULL AND v_open_sum <> v_tb THEN v_codes := array_append(v_codes, 'TB_CARRYING_OPENING_DIFFERENCE|'); END IF;
  v_tb := public._ipsas_minor(p_tb->>'ppeCarryingClosingMinor');
  IF v_tb IS NULL THEN v_codes := array_append(v_codes, 'TB_CARRYING_CLOSING_UNKNOWN|'); ELSIF v_close_sum IS NOT NULL AND v_close_sum <> v_tb THEN v_codes := array_append(v_codes, 'TB_CARRYING_CLOSING_DIFFERENCE|'); END IF;
  v_tb := public._ipsas_minor(p_tb->>'depreciationExpenseMinor');
  IF v_tb IS NULL THEN v_codes := array_append(v_codes, 'TB_DEPRECIATION_UNKNOWN|');
  ELSIF v_dep_sum IS NOT NULL AND v_dep_sum <> v_tb THEN
    v_stated := public._ipsas_minor(p_payload#>>'{depreciationDifference,amountMinor}');
    IF v_stated IS NULL OR v_stated <> v_dep_sum - v_tb OR NOT public._ipsas_enough(p_payload#>>'{depreciationDifference,explanation}') OR NOT public._ipsas_enough(p_payload#>>'{depreciationDifference,evidence}') THEN
      v_codes := array_append(v_codes, 'TB_DEPRECIATION_DIFFERENCE|');
    END IF;
  END IF;
  -- entity questions: explicit answers; "applies" routes to a governed workpaper rather than excluding the matter
  FOREACH v_q IN ARRAY ARRAY['heritage_assets', 'infrastructure_assets', 'impairment_indicators', 'held_for_sale', 'commitments_restrictions'] LOOP
    v_a := p_payload#>('{entityAnswers,' || v_q || '}')::text[];
    v_unsupported := v_q <> 'commitments_restrictions';
    v_resolved := v_a IS NOT NULL AND jsonb_typeof(v_a) = 'object' AND coalesce(v_a->>'status', '') IN ('answered', 'none_with_basis', 'not_applicable')
                  AND public._ipsas_enough(v_a->>'text', 8) AND public._ipsas_enough(v_a->>'evidence');
    IF NOT v_resolved THEN v_codes := v_codes || ('ENTITY_QUESTION_UNRESOLVED:' || v_q || '|');
    ELSIF v_unsupported AND (v_a#>'{flags,applies}') = 'true'::jsonb THEN v_codes := v_codes || ('SPECIALISED_ROUTE_REQUIRED:' || v_q || '|');
    ELSIF v_unsupported AND (v_a#>'{flags,applies}') IS DISTINCT FROM 'false'::jsonb THEN v_codes := v_codes || ('ENTITY_QUESTION_UNRESOLVED:' || v_q || '|'); END IF;
  END LOOP;
  v_codes := ARRAY(SELECT DISTINCT c FROM unnest(v_codes) c ORDER BY c);
  RETURN jsonb_build_object('contract', 'cfoclose-ipsas-ppe-workpaper/1', 'state', CASE WHEN cardinality(v_codes) = 0 THEN 'ready-for-review' ELSE 'incomplete' END,
    'codes', to_jsonb(v_codes), 'classes', v_classes,
    'totals', jsonb_build_object('openingCarryingMinor', v_open_sum::text, 'closingCarryingMinor', v_close_sum::text, 'depreciationMinor', v_dep_sum::text, 'disposalGainMinor', v_gain_sum::text));
END;
$$;

-- ── opening bridge ───────────────────────────────────────────────────────────────────────────────────────────────────
-- p_prior = prior_figures payload; p_openings = {lineId: minor text | null} read from persisted facts by the server;
-- p_confirmed = a confirmation exists for exactly this prior-figure set. Never produces a balancing amount.
CREATE FUNCTION public._ipsas_bridge_assess(p_prior jsonb, p_openings jsonb, p_confirmed boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE
  v_codes text[] := '{}'; v_lines jsonb := '[]'::jsonb; v_line jsonb; v_it jsonb; v_lid text; v_ids text[] := '{}'; v_pub_ids text[] := '{}';
  v_amt numeric; v_item_bad boolean := false; v_by jsonb := '{}'::jsonb; v_group_total jsonb := '{}'::jsonb; v_group_lines jsonb := '{}'::jsonb; v_g text; v_status text;
  v_pub numeric; v_open numeric; v_bridged numeric; v_diff numeric; v_resid numeric; v_all_agree boolean := true; v_n integer := 0; v_known text[] := '{}'; v_pubtxt text;
BEGIN
  FOR v_line IN SELECT value FROM jsonb_array_elements(public._ipsas_arr(p_prior->'lines')) LOOP
    v_lid := coalesce(v_line->>'lineId', '');
    IF v_lid = ANY (v_pub_ids) THEN v_item_bad := true; END IF;
    v_pub_ids := v_pub_ids || v_lid;
  END LOOP;
  v_known := v_pub_ids || ARRAY(SELECT jsonb_object_keys(p_openings));
  FOR v_it IN SELECT value FROM jsonb_array_elements(public._ipsas_arr(p_prior->'items')) LOOP
    IF NOT public._ipsas_enough(v_it->>'id') OR (v_it->>'id') = ANY (v_ids) THEN v_item_bad := true; CONTINUE; END IF;
    v_ids := v_ids || (v_it->>'id');
    v_amt := public._ipsas_minor(v_it->>'amountMinor');
    IF v_amt IS NULL OR v_amt = 0 THEN v_item_bad := true; CONTINUE; END IF;
    IF coalesce(v_it->>'kind', '') <> ALL (ARRAY['reclassification', 'prior-period-error', 'policy-transition', 'scope-change', 'posted-journal']) THEN v_item_bad := true; CONTINUE; END IF;
    IF NOT public._ipsas_enough(v_it->>'evidenceRef') OR NOT public._ipsas_enough(v_it->>'authorityReference') THEN v_item_bad := true; END IF;
    v_lid := coalesce(v_it->>'lineId', '');
    IF v_lid <> ALL (v_known) THEN v_item_bad := true; CONTINUE; END IF;
    v_by := jsonb_set(v_by, ARRAY[v_lid], to_jsonb((coalesce((v_by->>v_lid)::numeric, 0) + v_amt)::text));
    IF v_it->>'kind' = 'reclassification' THEN
      v_g := coalesce(v_it->>'groupId', '');
      IF NOT public._ipsas_enough(v_g) THEN v_item_bad := true; CONTINUE; END IF;
      v_group_total := jsonb_set(v_group_total, ARRAY[v_g], to_jsonb((coalesce((v_group_total->>v_g)::numeric, 0) + v_amt)::text));
      v_group_lines := jsonb_set(v_group_lines, ARRAY[v_g], coalesce(v_group_lines->v_g, '[]'::jsonb) || CASE WHEN v_group_lines->v_g @> to_jsonb(v_lid) THEN '[]'::jsonb ELSE jsonb_build_array(v_lid) END);
    END IF;
  END LOOP;
  FOR v_g IN SELECT jsonb_object_keys(v_group_total) LOOP
    IF (v_group_total->>v_g)::numeric <> 0 OR jsonb_array_length(v_group_lines->v_g) < 2 THEN v_item_bad := true; END IF;
  END LOOP;
  FOR v_lid IN SELECT DISTINCT x FROM unnest(v_known) x ORDER BY x LOOP
    v_n := v_n + 1;
    SELECT l.value INTO v_line FROM jsonb_array_elements(public._ipsas_arr(p_prior->'lines')) l(value) WHERE l.value->>'lineId' = v_lid LIMIT 1;
    v_pubtxt := v_line->>'amountMinor'; v_pub := public._ipsas_minor(CASE WHEN jsonb_typeof(v_line->'amountMinor') = 'string' THEN v_pubtxt END);
    v_open := public._ipsas_minor(p_openings->>v_lid); v_bridged := coalesce((v_by->>v_lid)::numeric, 0); v_diff := NULL; v_resid := NULL;
    IF v_line IS NULL OR v_pub IS NULL THEN v_status := 'published-missing'; v_codes := v_codes || ('PUBLISHED_FIGURE_MISSING|' || v_lid);
    ELSIF NOT p_confirmed THEN v_status := 'published-unconfirmed'; v_codes := v_codes || ('PUBLISHED_FIGURE_UNCONFIRMED|' || v_lid);
    ELSIF v_open IS NULL THEN v_status := 'opening-missing'; v_codes := v_codes || ('OPENING_FIGURE_MISSING|' || v_lid);
    ELSE
      v_diff := v_open - v_pub; v_resid := v_diff - v_bridged;
      IF v_resid = 0 THEN v_status := CASE WHEN v_diff = 0 THEN 'agrees' ELSE 'bridged' END;
      ELSE v_status := 'unexplained'; v_codes := v_codes || ('OPENING_RESIDUAL_UNEXPLAINED|' || v_lid); END IF;
    END IF;
    IF v_status <> 'agrees' THEN v_all_agree := false; END IF;
    v_lines := v_lines || jsonb_build_object('lineId', v_lid, 'publishedMinor', v_pub::text, 'openingMinor', v_open::text, 'differenceMinor', v_diff::text,
      'bridgedMinor', v_bridged::text, 'residualMinor', v_resid::text, 'status', v_status);
  END LOOP;
  IF v_item_bad THEN v_codes := array_append(v_codes, 'BRIDGE_ITEM_INVALID|'); END IF;
  IF v_n = 0 THEN v_codes := array_append(v_codes, 'NO_OPENING_LINES|'); END IF;
  v_codes := ARRAY(SELECT DISTINCT c FROM unnest(v_codes) c ORDER BY c);
  RETURN jsonb_build_object('state', CASE WHEN cardinality(v_codes) > 0 THEN 'blocked' WHEN v_all_agree THEN 'agrees' ELSE 'bridged' END, 'codes', to_jsonb(v_codes), 'lines', v_lines);
END;
$$;
REVOKE ALL ON FUNCTION public._ipsas_ppe_assess(jsonb, jsonb, jsonb), public._ipsas_bridge_assess(jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- ── the live assessment of everything persisted for one company and year ─────────────────────────────────────────────
CREATE FUNCTION public._ipsas_live(p_company_id uuid, p_period_year integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_work public.ipsas_prep_revisions; v_prior public.ipsas_prep_revisions; v_tb jsonb; v_confirmed jsonb := '{}'::jsonb; v_c jsonb;
  v_ppe jsonb; v_bridge jsonb; v_prior_confirmed boolean := false; v_openings jsonb := '{}'::jsonb; v_conf_rows jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_work FROM public.ipsas_prep_revisions WHERE company_id = p_company_id AND period_year = p_period_year AND kind = 'ppe_workpaper' ORDER BY seq DESC LIMIT 1;
  SELECT * INTO v_prior FROM public.ipsas_prep_revisions WHERE company_id = p_company_id AND period_year = p_period_year AND kind = 'prior_figures' ORDER BY seq DESC LIMIT 1;
  v_tb := public._ipsas_tb_facts(p_company_id, p_period_year, coalesce(v_work.payload->'tbSelection', '{}'::jsonb));
  IF v_work.id IS NOT NULL THEN
    FOR v_c IN SELECT value FROM jsonb_array_elements(public._ipsas_arr(v_work.payload->'classes')) LOOP
      IF EXISTS (SELECT 1 FROM public.ipsas_confirmations k WHERE k.company_id = p_company_id AND k.period_year = p_period_year AND k.subject_kind = 'ppe_class_estimate'
                   AND k.subject_key = (v_c->>'classId') AND k.subject_sha256 = public._ipsas_estimate_subject_sha(v_work.payload, v_c)) THEN
        v_confirmed := v_confirmed || jsonb_build_object(v_c->>'classId', true);
      END IF;
    END LOOP;
    v_ppe := public._ipsas_ppe_assess(v_work.payload, v_tb, v_confirmed);
  END IF;
  IF v_prior.id IS NOT NULL THEN
    v_prior_confirmed := EXISTS (SELECT 1 FROM public.ipsas_confirmations k WHERE k.company_id = p_company_id AND k.period_year = p_period_year AND k.subject_kind = 'prior_figure_set' AND k.subject_sha256 = v_prior.payload_sha256);
    v_openings := jsonb_build_object('ppe', CASE WHEN v_ppe IS NOT NULL THEN v_ppe#>>'{totals,openingCarryingMinor}' END);
    v_bridge := public._ipsas_bridge_assess(v_prior.payload, v_openings, v_prior_confirmed);
  END IF;
  RETURN jsonb_build_object('tb', v_tb, 'confirmedClasses', v_confirmed, 'priorConfirmed', v_prior_confirmed, 'ppe', v_ppe, 'bridge', v_bridge,
    'workpaperId', v_work.id, 'priorFiguresId', v_prior.id);
END;
$$;
REVOKE ALL ON FUNCTION public._ipsas_live(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;

-- ── RPCs ────────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.ipsas_prep_context(p_company_id uuid, p_period_year integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_refusal text; v_work jsonb; v_prior jsonb; v_conf jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  v_refusal := public._ipsas_refusal(p_company_id, auth.uid(), 'read');
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome', v_refusal); END IF;
  IF p_period_year IS NULL OR p_period_year NOT BETWEEN 2000 AND 2100 THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  SELECT jsonb_build_object('id', r.id, 'payload', r.payload, 'sha256', r.payload_sha256, 'createdAt', r.created_at, 'certificationId', r.certification_id) INTO v_work
    FROM public.ipsas_prep_revisions r WHERE r.company_id = p_company_id AND r.period_year = p_period_year AND r.kind = 'ppe_workpaper' ORDER BY r.seq DESC LIMIT 1;
  SELECT jsonb_build_object('id', r.id, 'payload', r.payload, 'sha256', r.payload_sha256, 'createdAt', r.created_at) INTO v_prior
    FROM public.ipsas_prep_revisions r WHERE r.company_id = p_company_id AND r.period_year = p_period_year AND r.kind = 'prior_figures' ORDER BY r.seq DESC LIMIT 1;
  SELECT coalesce(jsonb_agg(jsonb_build_object('subjectKind', k.subject_kind, 'subjectKey', k.subject_key, 'subjectSha256', k.subject_sha256, 'firmMemberId', k.firm_member_id, 'createdAt', k.created_at) ORDER BY k.seq), '[]'::jsonb) INTO v_conf
    FROM public.ipsas_confirmations k WHERE k.company_id = p_company_id AND k.period_year = p_period_year;
  RETURN jsonb_build_object('outcome', 'available', 'contract', 'cfoclose-ipsas-context/1', 'workpaper', v_work, 'priorFigures', v_prior,
    'confirmations', v_conf, 'assessment', public._ipsas_live(p_company_id, p_period_year));
END;
$$;

CREATE FUNCTION public.ipsas_save_preparation(p_company_id uuid, p_period_year integer, p_kind text, p_payload jsonb, p_expected_id uuid, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_refusal text; v_fp text; v_prior public.ipsas_prep_revisions; v_current uuid; v_id uuid := gen_random_uuid(); v_at timestamptz; v_cert uuid;
  v_receipt jsonb; v_line jsonb; v_doc uuid; v_sha text; v_live jsonb; v_c jsonb; v_contract text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  v_refusal := public._ipsas_refusal(p_company_id, auth.uid(), 'prepare_close');
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome', v_refusal); END IF;
  v_contract := CASE p_kind WHEN 'prior_figures' THEN 'cfoclose-ipsas-prior-figures/1' ELSE 'cfoclose-ipsas-ppe-workpaper/1' END;
  IF p_period_year IS NULL OR p_period_year NOT BETWEEN 2000 AND 2100 OR p_request_id IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR p_kind NOT IN ('prior_figures', 'ppe_workpaper') OR octet_length(p_payload::text) > 120000
     OR p_payload->>'companyId' IS DISTINCT FROM p_company_id::text OR p_payload->>'periodYear' IS DISTINCT FROM p_period_year::text
     OR p_payload->>'contract' IS DISTINCT FROM v_contract THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  IF p_kind = 'prior_figures' THEN
    IF jsonb_typeof(p_payload->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'lines') > 1 OR jsonb_typeof(p_payload->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'items') > 50 THEN
      RETURN jsonb_build_object('outcome', 'invalid_request');
    END IF;
    FOR v_line IN SELECT value FROM jsonb_array_elements(p_payload->'lines') LOOP
      IF v_line->>'lineId' IS DISTINCT FROM 'ppe' THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
      IF v_line->>'sourceDocumentId' IS NOT NULL THEN
        BEGIN v_doc := (v_line->>'sourceDocumentId')::uuid; EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END;
        IF NOT EXISTS (SELECT 1 FROM public.financial_statement_documents d WHERE d.id = v_doc AND d.company_id = p_company_id
                         AND d.status NOT IN ('QUARANTINED', 'EXTRACTION_FAILED', 'CLASSIFICATION_FAILED') AND d.superseded_at IS NULL) THEN RETURN jsonb_build_object('outcome', 'source_mismatch'); END IF;
      END IF;
    END LOOP;
  ELSE
    IF jsonb_typeof(p_payload->'classes') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'classes') > 50
       OR jsonb_typeof(p_payload->'period') IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload->'entityAnswers') IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_payload->'tbSelection') IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
    BEGIN PERFORM (p_payload#>>'{period,start}')::date, (p_payload#>>'{period,end}')::date; EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END;
    FOR v_c IN SELECT value FROM jsonb_array_elements(p_payload->'classes') LOOP
      IF jsonb_typeof(v_c) <> 'object' OR coalesce(v_c->>'classId', '') !~ '^[0-9a-fA-F-]{36}$' THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
    END LOOP;
  END IF;
  v_fp := encode(sha256(convert_to(jsonb_build_object('kind', p_kind, 'payload', p_payload, 'expectedId', p_expected_id)::text, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('ipsas_request:' || auth.uid()::text || ':' || p_request_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ipsas:' || p_company_id::text || ':' || p_period_year::text, 0));
  v_refusal := public._ipsas_authorize_mutation(p_company_id, auth.uid(), 'prepare_close'); -- authority at the mutation boundary, before any replay or write
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome', v_refusal); END IF;
  SELECT * INTO v_prior FROM public.ipsas_prep_revisions WHERE actor_user_id = auth.uid() AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.company_id = p_company_id AND v_prior.period_year = p_period_year AND v_prior.request_fingerprint = v_fp THEN RETURN v_prior.receipt || jsonb_build_object('replay', true); END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  SELECT id INTO v_current FROM public.ipsas_prep_revisions WHERE company_id = p_company_id AND period_year = p_period_year AND kind = p_kind ORDER BY seq DESC LIMIT 1;
  IF v_current IS DISTINCT FROM p_expected_id THEN RETURN jsonb_build_object('outcome', 'stale', 'currentId', v_current); END IF;
  IF p_kind = 'ppe_workpaper' THEN
    v_cert := (public._ipsas_tb_facts(p_company_id, p_period_year, p_payload->'tbSelection'))->>'certificationId';
  END IF;
  v_sha := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');
  v_at := clock_timestamp();
  v_receipt := jsonb_build_object('outcome', 'recorded', 'revisionId', v_id, 'kind', p_kind, 'createdAt', v_at, 'payloadSha256', v_sha);
  INSERT INTO public.ipsas_prep_revisions (id, company_id, period_year, kind, payload, payload_sha256, certification_id, receipt, actor_user_id, firm_member_id, request_id, request_fingerprint, created_at)
  VALUES (v_id, p_company_id, p_period_year, p_kind, p_payload, v_sha, v_cert, v_receipt, auth.uid(), public._cr_member(p_company_id, auth.uid()), p_request_id, v_fp, v_at);
  v_live := public._ipsas_live(p_company_id, p_period_year);
  RETURN v_receipt || jsonb_build_object('assessment', v_live);
END;
$$;

CREATE FUNCTION public.ipsas_confirm(p_company_id uuid, p_period_year integer, p_subject_kind text, p_subject_key text, p_expected_revision_id uuid, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_refusal text; v_fp text; v_prior public.ipsas_confirmations; v_rev public.ipsas_prep_revisions; v_class jsonb; v_sha text; v_id uuid := gen_random_uuid();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  v_refusal := public._ipsas_refusal(p_company_id, auth.uid(), 'review_close');
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome', v_refusal); END IF;
  IF p_period_year IS NULL OR p_period_year NOT BETWEEN 2000 AND 2100 OR p_request_id IS NULL OR p_expected_revision_id IS NULL
     OR p_subject_kind NOT IN ('ppe_class_estimate', 'prior_figure_set') OR p_subject_key IS NULL OR length(p_subject_key) NOT BETWEEN 1 AND 64 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  v_fp := encode(sha256(convert_to(jsonb_build_object('kind', p_subject_kind, 'key', p_subject_key, 'revision', p_expected_revision_id)::text, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('ipsas_request:' || auth.uid()::text || ':' || p_request_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ipsas:' || p_company_id::text || ':' || p_period_year::text, 0));
  v_refusal := public._ipsas_authorize_mutation(p_company_id, auth.uid(), 'review_close'); -- authority at the mutation boundary, before any replay or write
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome', v_refusal); END IF;
  SELECT * INTO v_prior FROM public.ipsas_confirmations WHERE actor_user_id = auth.uid() AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.company_id = p_company_id AND v_prior.period_year = p_period_year AND v_prior.request_fingerprint = v_fp THEN
      RETURN jsonb_build_object('outcome', 'confirmed', 'confirmationId', v_prior.id, 'subjectSha256', v_prior.subject_sha256, 'replay', true);
    END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  SELECT * INTO v_rev FROM public.ipsas_prep_revisions WHERE company_id = p_company_id AND period_year = p_period_year
    AND kind = CASE p_subject_kind WHEN 'ppe_class_estimate' THEN 'ppe_workpaper' ELSE 'prior_figures' END ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND OR v_rev.id <> p_expected_revision_id THEN RETURN jsonb_build_object('outcome', 'stale', 'currentId', v_rev.id); END IF;
  IF p_subject_kind = 'ppe_class_estimate' THEN
    SELECT c.value INTO v_class FROM jsonb_array_elements(public._ipsas_arr(v_rev.payload->'classes')) c(value) WHERE c.value->>'classId' = p_subject_key LIMIT 1;
    IF v_class IS NULL THEN RETURN jsonb_build_object('outcome', 'unknown_subject'); END IF;
    IF coalesce(v_class#>>'{estimate,chargeSource}', '') = '' OR NOT public._ipsas_enough(v_class#>>'{estimate,rationale}', 8) THEN RETURN jsonb_build_object('outcome', 'not_confirmable'); END IF;
    v_sha := public._ipsas_estimate_subject_sha(v_rev.payload, v_class);
  ELSE
    IF p_subject_key <> 'prior_figures' THEN RETURN jsonb_build_object('outcome', 'unknown_subject'); END IF;
    IF jsonb_array_length(public._ipsas_arr(v_rev.payload->'lines')) = 0 THEN RETURN jsonb_build_object('outcome', 'not_confirmable'); END IF;
    v_sha := v_rev.payload_sha256;
  END IF;
  INSERT INTO public.ipsas_confirmations (id, company_id, period_year, subject_kind, subject_key, subject_sha256, revision_id, actor_user_id, firm_member_id, request_id, request_fingerprint)
  VALUES (v_id, p_company_id, p_period_year, p_subject_kind, p_subject_key, v_sha, v_rev.id, auth.uid(), public._cr_member(p_company_id, auth.uid()), p_request_id, v_fp);
  RETURN jsonb_build_object('outcome', 'confirmed', 'confirmationId', v_id, 'subjectSha256', v_sha, 'assessment', public._ipsas_live(p_company_id, p_period_year));
END;
$$;

REVOKE ALL ON FUNCTION public.ipsas_prep_context(uuid, integer), public.ipsas_save_preparation(uuid, integer, text, jsonb, uuid, uuid), public.ipsas_confirm(uuid, integer, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ipsas_prep_context(uuid, integer), public.ipsas_save_preparation(uuid, integer, text, jsonb, uuid, uuid), public.ipsas_confirm(uuid, integer, text, text, uuid, uuid) TO authenticated;
$cfoclose_ipsas_stage_3fb7460f4b5ff456$);
