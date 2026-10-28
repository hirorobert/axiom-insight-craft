-- Authored forward migration; NOT applied hosted. Follows 20261205100000 (the equipment preparation candidate) and
-- depends on its tables and on 20261019100000 (fs_record_schedule, fs_record_disclosure) and 20261018100000
-- (fs_statement_composition). No outer transaction: the native migrator owns it (see PR #210).
--
-- Multi-class, evidence-linked equipment preparation (IFRS for SMEs 2015, 17.31(d)-(e), 17.30, 17.17; charter
-- L5/L8, R1, R5, G4, G5, 11.3). Adds:
--   fs_equipment_answers                      append-only requirement-linked answers (facts) written only by the commit
--   _fs_equipment_v2_problems                 pure validation of a /2 workpaper: class identities, both roll-forward
--                                             identities per class, movement provenance, disposals, estimates,
--                                             class preservation, depreciation destinations, answers
--   fs_equipment_context_v2                   latest workpaper, the three notes, the recorded schedule's classes, the
--                                             latest answers of this period and of the prior period
--   fs_save_equipment_workpaper_v2            draft save (compare-and-set, replay by request)
--   fs_commit_equipment_preparation_v2        ONE transaction: workpaper + every class through fs_record_schedule +
--                                             answers + up to three reviewed notes; refuses a dropped class, a stale
--                                             workpaper/schedule/note, changed statements, any arithmetic difference
-- Nothing here approves a report, changes framework applicability or alters an existing table, row or privilege.

CREATE TABLE public.fs_equipment_answers (
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  period_year integer NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  workpaper_id uuid NOT NULL REFERENCES public.fs_equipment_workpapers(id) ON DELETE RESTRICT,
  class_key text CHECK (class_key IS NULL OR length(class_key) BETWEEN 1 AND 64),
  class_label text CHECK (class_label IS NULL OR length(class_label) BETWEEN 1 AND 200),
  question_id text NOT NULL CHECK (length(question_id) BETWEEN 1 AND 60),
  status text NOT NULL CHECK (status IN ('answered', 'none_with_basis', 'not_applicable', 'unresolved')),
  answer jsonb NOT NULL CHECK (jsonb_typeof(answer) = 'object' AND octet_length(answer::text) <= 20000),
  actor_user_id uuid NOT NULL,
  firm_member_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX fs_equipment_answers_latest ON public.fs_equipment_answers (company_id, period_year, question_id, seq DESC);
ALTER TABLE public.fs_equipment_answers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fs_equipment_answers FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.fs_equipment_answers_seq_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER fs_equipment_answers_immutable BEFORE UPDATE OR DELETE ON public.fs_equipment_answers FOR EACH ROW EXECUTE FUNCTION public._fs_equipment_immutable();
CREATE TRIGGER fs_equipment_answers_no_truncate BEFORE TRUNCATE ON public.fs_equipment_answers FOR EACH STATEMENT EXECUTE FUNCTION public._fs_equipment_immutable();

-- Pure validation of a /2 workpaper payload. Returns a JSON array of problems (empty = valid). p_existing_rows are the
-- classes of the latest recorded schedule; p_composition is fs_statement_composition's result; p_require_complete adds
-- the checks a reviewed-note commit needs (every mandatory question resolved, no unresolved applicable question).
CREATE FUNCTION public._fs_equipment_v2_problems(p_payload jsonb, p_existing_rows jsonb, p_composition jsonb, p_require_complete boolean)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE
  INT_RE CONSTANT text := '^(0|-?[1-9][0-9]{0,30})$';
  NAT_RE CONSTANT text := '^(0|[1-9][0-9]{0,30})$';
  DEC_RE CONSTANT text := '^[0-9]{1,15}(\.[0-9]{1,6})?$';
  UUID_RE CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  TEMPLATE_RE CONSTANT text := '(^|[^a-z])(tra|tax)\s+(class|rate|table|allowance)|wear\s*(and|&)\s*tear|\mtemplate\M|\millustrative\M|\m(kpmg|deloitte|pwc)\M';
  v_problems jsonb := '[]'::jsonb;
  v_classes jsonb;
  c jsonb; m jsonb; d jsonb; a jsonb; n jsonb; v_est jsonb;
  v_i integer := 0;
  v_label text; v_at text; v_kind text; v_sign text; v_status text; v_key text; v_target text; v_src jsonb;
  v_ids text[] := '{}'; v_labels text[] := '{}'; v_kinds text[]; v_retired text[] := '{}'; v_required text[];
  v_og numeric; v_od numeric; v_oi numeric; v_oc numeric; v_cg numeric; v_cd numeric; v_ci numeric; v_cc numeric;
  v_sg numeric; v_sd numeric; v_si numeric; v_g numeric; v_dd numeric; v_ii numeric; v_eff numeric;
  v_disp_g numeric; v_disp_d numeric; v_disp_i numeric; v_sum_c numeric; v_sum_d numeric; v_sum_i numeric;
  v_dep_total numeric := 0; v_dest_total numeric := 0; v_amt numeric; v_line numeric; v_closing_total numeric := 0; v_composed numeric;
  v_ok boolean;
BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR p_payload->>'contract' IS DISTINCT FROM 'cfoclose-equipment-workpaper/2' THEN
    RETURN jsonb_build_array(jsonb_build_object('code', 'CONTRACT'));
  END IF;
  v_classes := p_payload->'classes';
  IF jsonb_typeof(v_classes) IS DISTINCT FROM 'array' OR jsonb_array_length(v_classes) NOT BETWEEN 1 AND 100 THEN
    RETURN jsonb_build_array(jsonb_build_object('code', 'CLASSES_COUNT'));
  END IF;
  IF jsonb_typeof(p_payload->'retiredClasses') IS DISTINCT FROM 'array' OR jsonb_typeof(p_payload->'destinations') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_payload->'entityAnswers') IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_array(jsonb_build_object('code', 'PAYLOAD_SHAPE'));
  END IF;

  FOR c IN SELECT value FROM jsonb_array_elements(v_classes) LOOP
    v_i := v_i + 1;
    v_label := btrim(coalesce(c->>'label', ''));
    IF jsonb_typeof(c) <> 'object' OR coalesce(c->>'classId', '') !~ UUID_RE OR length(v_label) NOT BETWEEN 1 AND 200
       OR length(btrim(coalesce(c->>'accounts', ''))) < 3
       OR jsonb_typeof(c->'opening') IS DISTINCT FROM 'object' OR jsonb_typeof(c->'closing') IS DISTINCT FROM 'object'
       OR jsonb_typeof(c->'movements') IS DISTINCT FROM 'array' OR jsonb_typeof(c->'disposals') IS DISTINCT FROM 'array'
       OR jsonb_typeof(c->'estimate') IS DISTINCT FROM 'object' OR jsonb_typeof(c->'answers') IS DISTINCT FROM 'object' THEN
      v_problems := v_problems || jsonb_build_object('code', 'CLASS_MALFORMED', 'row', v_i);
      CONTINUE;
    END IF;
    IF c->>'classId' = ANY (v_ids) THEN v_problems := v_problems || jsonb_build_object('code', 'CLASS_ID_REPEATED', 'class', v_label); END IF;
    IF v_label = ANY (v_labels) THEN v_problems := v_problems || jsonb_build_object('code', 'CLASS_LABEL_REPEATED', 'class', v_label); END IF;
    v_ids := v_ids || (c->>'classId'); v_labels := v_labels || v_label;

    -- Balances at both dates: four exact amounts; gross and accumulated amounts non-negative; the net identity holds.
    v_ok := true;
    FOREACH v_at IN ARRAY ARRAY['opening', 'closing'] LOOP
      IF coalesce(c->v_at->>'grossMinor', '') !~ NAT_RE OR coalesce(c->v_at->>'accumulatedDepreciationMinor', '') !~ NAT_RE
         OR coalesce(c->v_at->>'accumulatedImpairmentMinor', '') !~ NAT_RE OR coalesce(c->v_at->>'carryingMinor', '') !~ INT_RE THEN
        v_problems := v_problems || jsonb_build_object('code', 'BALANCE_MALFORMED', 'class', v_label, 'at', v_at);
        v_ok := false;
      END IF;
    END LOOP;
    IF NOT v_ok THEN CONTINUE; END IF;
    v_og := (c->'opening'->>'grossMinor')::numeric; v_od := (c->'opening'->>'accumulatedDepreciationMinor')::numeric; v_oi := (c->'opening'->>'accumulatedImpairmentMinor')::numeric; v_oc := (c->'opening'->>'carryingMinor')::numeric;
    v_cg := (c->'closing'->>'grossMinor')::numeric; v_cd := (c->'closing'->>'accumulatedDepreciationMinor')::numeric; v_ci := (c->'closing'->>'accumulatedImpairmentMinor')::numeric; v_cc := (c->'closing'->>'carryingMinor')::numeric;
    IF v_og - v_od - v_oi <> v_oc THEN v_problems := v_problems || jsonb_build_object('code', 'NET_IDENTITY', 'class', v_label, 'at', 'opening', 'differenceMinor', (v_og - v_od - v_oi - v_oc)::text); END IF;
    IF v_cg - v_cd - v_ci <> v_cc THEN v_problems := v_problems || jsonb_build_object('code', 'NET_IDENTITY', 'class', v_label, 'at', 'closing', 'differenceMinor', (v_cg - v_cd - v_ci - v_cc)::text); END IF;
    v_closing_total := v_closing_total + v_cc;

    -- Movements: known kind once, three exact components, the pack's direction on the derived carrying effect, a source.
    v_sg := 0; v_sd := 0; v_si := 0; v_kinds := '{}'; v_ok := true;
    v_disp_g := NULL; v_disp_d := NULL; v_disp_i := NULL;
    FOR m IN SELECT value FROM jsonb_array_elements(c->'movements') LOOP
      v_kind := m->>'kind';
      IF v_kind IS NULL OR v_kind NOT IN ('additions', 'disposals', 'business_combinations', 'revaluations_and_oci_impairment', 'transfers_investment_property', 'impairment_profit_or_loss', 'depreciation', 'other') THEN
        v_problems := v_problems || jsonb_build_object('code', 'MOVEMENT_KIND_UNKNOWN', 'class', v_label, 'kind', coalesce(v_kind, '?')); v_ok := false; CONTINUE;
      END IF;
      IF v_kind = ANY (v_kinds) THEN v_problems := v_problems || jsonb_build_object('code', 'MOVEMENT_KIND_REPEATED', 'class', v_label, 'kind', v_kind); END IF;
      v_kinds := v_kinds || v_kind;
      IF coalesce(m->>'grossMinor', '') !~ INT_RE OR coalesce(m->>'accumulatedDepreciationMinor', '') !~ INT_RE OR coalesce(m->>'accumulatedImpairmentMinor', '') !~ INT_RE THEN
        v_problems := v_problems || jsonb_build_object('code', 'MOVEMENT_MALFORMED', 'class', v_label, 'kind', v_kind); v_ok := false; CONTINUE;
      END IF;
      v_g := (m->>'grossMinor')::numeric; v_dd := (m->>'accumulatedDepreciationMinor')::numeric; v_ii := (m->>'accumulatedImpairmentMinor')::numeric;
      v_eff := v_g - v_dd - v_ii;
      v_sign := CASE WHEN v_kind IN ('additions', 'business_combinations') THEN 'increase' WHEN v_kind IN ('disposals', 'depreciation') THEN 'decrease' ELSE 'either' END;
      IF (v_sign = 'increase' AND v_eff < 0) OR (v_sign = 'decrease' AND v_eff > 0) THEN
        v_problems := v_problems || jsonb_build_object('code', 'MOVEMENT_SIGN', 'class', v_label, 'kind', v_kind, 'sign', v_sign);
      END IF;
      v_src := m->'source';
      IF jsonb_typeof(v_src) IS DISTINCT FROM 'object' OR coalesce(v_src->>'type', '') NOT IN ('register', 'ledger_account', 'journal', 'workpaper') OR length(btrim(coalesce(v_src->>'reference', ''))) < 3 THEN
        v_problems := v_problems || jsonb_build_object('code', 'MOVEMENT_SOURCE_MISSING', 'class', v_label, 'kind', v_kind);
      END IF;
      v_sg := v_sg + v_g; v_sd := v_sd + v_dd; v_si := v_si + v_ii;
      IF v_kind = 'depreciation' THEN v_dep_total := v_dep_total + v_dd; END IF;
      IF v_kind = 'disposals' THEN v_disp_g := v_g; v_disp_d := v_dd; v_disp_i := v_ii; END IF;
    END LOOP;
    IF v_ok THEN
      IF v_og + v_sg <> v_cg THEN v_problems := v_problems || jsonb_build_object('code', 'ROLLFORWARD_GROSS', 'class', v_label, 'differenceMinor', (v_cg - v_og - v_sg)::text); END IF;
      IF v_od + v_sd <> v_cd THEN v_problems := v_problems || jsonb_build_object('code', 'ROLLFORWARD_ACCUMULATED_DEPRECIATION', 'class', v_label, 'differenceMinor', (v_cd - v_od - v_sd)::text); END IF;
      IF v_oi + v_si <> v_ci THEN v_problems := v_problems || jsonb_build_object('code', 'ROLLFORWARD_ACCUMULATED_IMPAIRMENT', 'class', v_label, 'differenceMinor', (v_ci - v_oi - v_si)::text); END IF;
    END IF;

    -- Disposals (17.27-17.30): the items disposed of must equal the cost removed and the deductions eliminated.
    IF v_disp_g IS NOT NULL AND (v_disp_g <> 0 OR v_disp_d <> 0 OR v_disp_i <> 0) THEN
      IF jsonb_array_length(c->'disposals') = 0 THEN
        v_problems := v_problems || jsonb_build_object('code', 'DISPOSAL_ITEMS_MISSING', 'class', v_label);
      ELSE
        v_sum_c := 0; v_sum_d := 0; v_sum_i := 0; v_ok := true;
        FOR d IN SELECT value FROM jsonb_array_elements(c->'disposals') LOOP
          IF jsonb_typeof(d) <> 'object' OR coalesce(d->>'costMinor', '') !~ NAT_RE OR coalesce(d->>'accumulatedDepreciationMinor', '') !~ NAT_RE OR coalesce(d->>'accumulatedImpairmentMinor', '') !~ NAT_RE
             OR (d->'proceedsMinor' IS NOT NULL AND jsonb_typeof(d->'proceedsMinor') <> 'null' AND coalesce(d->>'proceedsMinor', '') !~ INT_RE)
             OR length(btrim(coalesce(d->>'reference', ''))) < 1 THEN
            v_problems := v_problems || jsonb_build_object('code', 'DISPOSAL_MALFORMED', 'class', v_label); v_ok := false; CONTINUE;
          END IF;
          v_src := d->'source';
          IF jsonb_typeof(v_src) IS DISTINCT FROM 'object' OR coalesce(v_src->>'type', '') NOT IN ('register', 'ledger_account', 'journal', 'workpaper') OR length(btrim(coalesce(v_src->>'reference', ''))) < 3 THEN
            v_problems := v_problems || jsonb_build_object('code', 'DISPOSAL_SOURCE_MISSING', 'class', v_label, 'item', d->>'reference');
          END IF;
          v_sum_c := v_sum_c + (d->>'costMinor')::numeric; v_sum_d := v_sum_d + (d->>'accumulatedDepreciationMinor')::numeric; v_sum_i := v_sum_i + (d->>'accumulatedImpairmentMinor')::numeric;
        END LOOP;
        IF v_ok THEN
          IF v_sum_c <> -v_disp_g THEN v_problems := v_problems || jsonb_build_object('code', 'DISPOSAL_COST_MISMATCH', 'class', v_label, 'itemsMinor', v_sum_c::text, 'movementMinor', (-v_disp_g)::text); END IF;
          IF v_sum_d <> -v_disp_d THEN v_problems := v_problems || jsonb_build_object('code', 'DISPOSAL_ACCUMULATED_MISMATCH', 'class', v_label, 'itemsMinor', v_sum_d::text, 'movementMinor', (-v_disp_d)::text); END IF;
          IF v_sum_i <> -v_disp_i THEN v_problems := v_problems || jsonb_build_object('code', 'DISPOSAL_IMPAIRMENT_MISMATCH', 'class', v_label, 'itemsMinor', v_sum_i::text, 'movementMinor', (-v_disp_i)::text); END IF;
        END IF;
      END IF;
    END IF;

    -- Estimates (17.18-17.23): the entity's own structured estimate; a tax class or template is not an estimate.
    v_est := c->'estimate';
    IF coalesce(v_est->>'basis', '') NOT IN ('cost', 'revaluation') OR coalesce(v_est->>'method', '') NOT IN ('straight-line', 'reducing-balance', 'units-of-production')
       OR (v_est->>'method' = 'straight-line' AND (coalesce(v_est->>'lifeYears', '') !~ DEC_RE OR (v_est->>'lifeYears')::numeric = 0))
       OR (v_est->>'method' = 'reducing-balance' AND (coalesce(v_est->>'ratePercent', '') !~ DEC_RE OR (v_est->>'ratePercent')::numeric = 0))
       OR (v_est->>'method' = 'units-of-production' AND (coalesce(v_est->>'totalUnits', '') !~ DEC_RE OR (v_est->>'totalUnits')::numeric = 0 OR coalesce(v_est->>'unitsThisPeriod', '') !~ DEC_RE))
       OR coalesce(v_est->>'residualMinor', '') !~ NAT_RE OR coalesce(v_est->>'convention', '') NOT IN ('full-period', 'daily')
       OR coalesce(v_est->>'chargeSource', '') NOT IN ('calculated', 'register')
       OR (v_est->>'chargeSource' = 'register' AND (length(btrim(coalesce(v_est->>'registerReference', ''))) < 3 OR coalesce(v_est->>'registerChargeMinor', '') !~ NAT_RE))
       OR (v_est->>'chargeSource' = 'calculated' AND (jsonb_typeof(v_est->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(v_est->'items') = 0))
       OR coalesce(v_est->>'changedSincePrior', '') NOT IN ('yes', 'no')
       OR (v_est->>'changedSincePrior' = 'yes' AND (length(btrim(coalesce(v_est->>'changeDescription', ''))) < 3 OR coalesce(v_est->>'changeEffectMinor', '') !~ INT_RE))
       OR length(btrim(coalesce(v_est->>'rationale', ''))) < 3 OR length(btrim(coalesce(v_est->>'evidence', ''))) < 3 THEN
      v_problems := v_problems || jsonb_build_object('code', 'ESTIMATE_INCOMPLETE', 'class', v_label);
    END IF;
    IF (coalesce(v_est->>'rationale', '') || ' ' || coalesce(v_est->>'evidence', '') || ' ' || coalesce(v_est->>'lifeYears', '') || ' ' || coalesce(v_est->'factors'->>'usage', '') || ' ' || coalesce(v_est->'factors'->>'wear', '')
        || ' ' || coalesce(v_est->'factors'->>'obsolescence', '') || ' ' || coalesce(v_est->'factors'->>'legalLimits', '')) ~* TEMPLATE_RE THEN
      v_problems := v_problems || jsonb_build_object('code', 'ESTIMATE_NOT_ENTITY_SPECIFIC', 'class', v_label);
    END IF;

    -- Class answers: each recorded fact is well formed; a 'none' names who checked and what.
    FOR v_key, a IN SELECT key, value FROM jsonb_each(c->'answers') LOOP
      v_status := coalesce(a->>'status', '');
      IF jsonb_typeof(a) <> 'object' OR v_status NOT IN ('answered', 'none_with_basis', 'not_applicable', 'unresolved') OR length(v_key) NOT BETWEEN 1 AND 60
         OR (v_status = 'answered' AND (length(btrim(coalesce(a->>'text', ''))) < 3 OR length(btrim(coalesce(a->>'evidence', ''))) < 3))
         OR (v_status = 'none_with_basis' AND (length(btrim(coalesce(a->>'checkedBy', ''))) < 3 OR length(btrim(coalesce(a->>'evidence', ''))) < 3))
         OR (v_status = 'not_applicable' AND length(btrim(coalesce(a->>'text', ''))) < 3) THEN
        v_problems := v_problems || jsonb_build_object('code', 'ANSWER_MALFORMED', 'class', v_label, 'questionId', v_key);
      END IF;
    END LOOP;
    IF coalesce(c->'answers'->'addition_cost'->'flags'->>'expensed_items_included', 'false') = 'true' THEN
      v_problems := v_problems || jsonb_build_object('code', 'EXPENSED_COSTS_CAPITALISED', 'class', v_label);
    END IF;
    IF p_require_complete THEN
      FOREACH v_key IN ARRAY ARRAY['recognition', 'components'] LOOP
        IF coalesce(c->'answers'->v_key->>'status', 'unresolved') NOT IN ('answered', 'none_with_basis', 'not_applicable') THEN
          v_problems := v_problems || jsonb_build_object('code', 'QUESTION_UNRESOLVED', 'class', v_label, 'questionId', v_key);
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- Class preservation: every class of the recorded schedule is kept, or retired with a reason and evidence.
  FOR n IN SELECT value FROM jsonb_array_elements(p_payload->'retiredClasses') LOOP
    IF jsonb_typeof(n) <> 'object' OR length(btrim(coalesce(n->>'label', ''))) < 1 OR length(btrim(coalesce(n->>'reason', ''))) < 3 OR length(btrim(coalesce(n->>'evidence', ''))) < 3 THEN
      v_problems := v_problems || jsonb_build_object('code', 'RETIREMENT_MALFORMED', 'class', coalesce(n->>'label', '?'));
    ELSE
      v_retired := v_retired || btrim(n->>'label');
    END IF;
  END LOOP;
  IF jsonb_typeof(p_existing_rows) = 'array' THEN
    FOR n IN SELECT value FROM jsonb_array_elements(p_existing_rows) LOOP
      IF NOT (btrim(coalesce(n->>'classLabel', '')) = ANY (v_labels)) AND NOT (btrim(coalesce(n->>'classLabel', '')) = ANY (v_retired)) THEN
        v_problems := v_problems || jsonb_build_object('code', 'CLASS_DROPPED', 'class', btrim(coalesce(n->>'classLabel', '')));
      END IF;
    END LOOP;
  END IF;

  -- The sum of the classes' closing carrying amounts must be the composed statement line (G4).
  IF jsonb_typeof(p_composition) = 'object' AND p_composition->>'state' = 'composed' THEN
    SELECT coalesce(sum((l->'current'->>'amountMinor')::numeric), 0) INTO v_composed FROM jsonb_array_elements(coalesce(p_composition->'lines', '[]'::jsonb)) l WHERE l->>'lineId' = 'sfp.property_plant_and_equipment';
    IF v_closing_total <> v_composed THEN v_problems := v_problems || jsonb_build_object('code', 'STATEMENT_CLOSING_MISMATCH', 'scheduleMinor', v_closing_total::text, 'composedMinor', v_composed::text); END IF;
  END IF;

  -- Depreciation destinations (17.17): the schedule's charge is accounted for by its destinations, each bounded by its composed line.
  FOR n IN SELECT value FROM jsonb_array_elements(p_payload->'destinations') LOOP
    v_target := coalesce(n->>'target', '');
    IF jsonb_typeof(n) <> 'object' OR v_target NOT IN ('sci.depreciation_and_amortisation', 'sci.cost_of_sales', 'sci.operating_expenses_by_function', 'sci.other_expenses_by_nature', 'capitalised_inventories', 'capitalised_assets', 'other')
       OR coalesce(n->>'amountMinor', '') !~ NAT_RE OR length(btrim(coalesce(n->>'evidence', ''))) < 3 OR (v_target = 'other' AND length(btrim(coalesce(n->>'explanation', ''))) < 3) THEN
      v_problems := v_problems || jsonb_build_object('code', 'DESTINATION_MALFORMED', 'target', v_target); CONTINUE;
    END IF;
    v_amt := (n->>'amountMinor')::numeric; v_dest_total := v_dest_total + v_amt;
    IF v_target LIKE 'sci.%' AND jsonb_typeof(p_composition) = 'object' THEN
      SELECT (l->'current'->>'amountMinor')::numeric INTO v_line FROM jsonb_array_elements(coalesce(p_composition->'lines', '[]'::jsonb)) l WHERE l->>'lineId' = v_target LIMIT 1;
      IF v_line IS NULL THEN v_problems := v_problems || jsonb_build_object('code', 'DESTINATION_LINE_ABSENT', 'target', v_target);
      ELSIF v_amt > v_line THEN v_problems := v_problems || jsonb_build_object('code', 'DEPRECIATION_EXCEEDS_LINE', 'target', v_target, 'amountMinor', v_amt::text, 'lineMinor', v_line::text);
      END IF;
    END IF;
  END LOOP;
  IF v_dep_total <> v_dest_total THEN
    v_problems := v_problems || jsonb_build_object('code', 'DEPRECIATION_DESTINATIONS_MISMATCH', 'scheduleMinor', v_dep_total::text, 'destinationsMinor', v_dest_total::text, 'differenceMinor', (v_dep_total - v_dest_total)::text);
  END IF;

  -- Entity answers.
  FOR v_key, a IN SELECT key, value FROM jsonb_each(p_payload->'entityAnswers') LOOP
    v_status := coalesce(a->>'status', '');
    IF jsonb_typeof(a) <> 'object' OR v_status NOT IN ('answered', 'none_with_basis', 'not_applicable', 'unresolved') OR length(v_key) NOT BETWEEN 1 AND 60
       OR (v_status = 'answered' AND (length(btrim(coalesce(a->>'text', ''))) < 3 OR length(btrim(coalesce(a->>'evidence', ''))) < 3))
       OR (v_status = 'none_with_basis' AND (length(btrim(coalesce(a->>'checkedBy', ''))) < 3 OR length(btrim(coalesce(a->>'evidence', ''))) < 3))
       OR (v_status = 'not_applicable' AND length(btrim(coalesce(a->>'text', ''))) < 3) THEN
      v_problems := v_problems || jsonb_build_object('code', 'ANSWER_MALFORMED', 'questionId', v_key);
    END IF;
  END LOOP;
  IF p_require_complete THEN
    -- Mandatory every period: 17.32(a)-(b), the 27.7 assessment, 32.10, the framework history.
    FOREACH v_key IN ARRAY ARRAY['restrictions_security', 'commitments', 'impairment', 'events_after', 'framework_history'] LOOP
      IF coalesce(p_payload->'entityAnswers'->v_key->>'status', 'unresolved') NOT IN ('answered', 'none_with_basis') THEN
        v_problems := v_problems || jsonb_build_object('code', 'QUESTION_UNRESOLVED', 'questionId', v_key);
      END IF;
    END LOOP;
    IF coalesce(p_payload->'entityAnswers'->'impairment'->'flags'->>'indicator_present', 'false') = 'true'
       AND coalesce(p_payload->'entityAnswers'->'impairment_measurement'->>'status', 'unresolved') <> 'answered' THEN
      v_problems := v_problems || jsonb_build_object('code', 'QUESTION_UNRESOLVED', 'questionId', 'impairment_measurement');
    END IF;
    IF coalesce(p_payload->'entityAnswers'->'framework_history'->'flags'->>'first_smes_statements', 'false') = 'true'
       AND coalesce(p_payload->'entityAnswers'->'transition'->>'status', 'unresolved') <> 'answered' THEN
      v_problems := v_problems || jsonb_build_object('code', 'QUESTION_UNRESOLVED', 'questionId', 'transition');
    END IF;
    -- The conditional questions the browser evaluated: a reviewed-note commit requires none left unresolved.
    IF jsonb_typeof(p_payload->'questions'->'unresolved') = 'array' AND jsonb_array_length(p_payload->'questions'->'unresolved') > 0 THEN
      v_problems := v_problems || jsonb_build_object('code', 'QUESTIONS_UNRESOLVED', 'questions', p_payload->'questions'->'unresolved');
    END IF;
  END IF;
  RETURN v_problems;
END;
$$;
REVOKE ALL ON FUNCTION public._fs_equipment_v2_problems(jsonb, jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- The preparation context: latest workpaper (any contract), the three notes, the recorded schedule's classes, and the
-- latest recorded answer per question of this period and of the prior period (reusable facts, charter L8).
CREATE FUNCTION public.fs_equipment_context_v2(p_company_id uuid, p_period_year integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_refusal text; v_work jsonb; v_notes jsonb := '{}'::jsonb; v_schedule jsonb; v_answers jsonb; v_prior jsonb; v_req text; v_t jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  v_refusal := public._fs_notes_refusal(p_company_id, auth.uid());
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome', v_refusal); END IF;
  IF p_period_year IS NULL OR p_period_year NOT BETWEEN 2000 AND 2100 THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  SELECT jsonb_build_object('id', w.id, 'payload', w.payload, 'sourceDocumentId', w.source_document_id, 'createdAt', w.created_at, 'contract', w.payload->>'contract') INTO v_work
    FROM public.fs_equipment_workpapers w WHERE w.company_id = p_company_id AND w.period_year = p_period_year ORDER BY w.seq DESC LIMIT 1;
  FOREACH v_req IN ARRAY ARRAY['smes.note.policies', 'smes.note.subclassifications', 'smes.note.estimates'] LOOP
    SELECT jsonb_build_object('id', t.id, 'body', t.body, 'sourceRef', t.source_ref) INTO v_t FROM public.fs_disclosure_texts t
      WHERE t.company_id = p_company_id AND t.period_year = p_period_year AND t.requirement_id = v_req ORDER BY t.seq DESC LIMIT 1;
    v_notes := v_notes || jsonb_build_object(v_req, v_t);
    v_t := NULL;
  END LOOP;
  SELECT jsonb_build_object('id', s.id, 'rows', s.rows, 'sourceRef', s.source_ref, 'createdAt', s.created_at, 'contentSha256', s.content_sha256) INTO v_schedule
    FROM public.fs_schedule_submissions s WHERE s.company_id = p_company_id AND s.period_year = p_period_year AND s.schedule_id = 'ppe' ORDER BY s.seq DESC LIMIT 1;
  SELECT coalesce(jsonb_agg(jsonb_build_object('classKey', x.class_key, 'classLabel', x.class_label, 'questionId', x.question_id, 'status', x.status, 'answer', x.answer, 'workpaperId', x.workpaper_id, 'createdAt', x.created_at) ORDER BY x.seq), '[]'::jsonb) INTO v_answers
    FROM (SELECT DISTINCT ON (coalesce(class_key, ''), question_id) * FROM public.fs_equipment_answers
            WHERE company_id = p_company_id AND period_year = p_period_year ORDER BY coalesce(class_key, ''), question_id, seq DESC) x;
  SELECT coalesce(jsonb_agg(jsonb_build_object('classKey', x.class_key, 'classLabel', x.class_label, 'questionId', x.question_id, 'status', x.status, 'answer', x.answer, 'workpaperId', x.workpaper_id, 'createdAt', x.created_at) ORDER BY x.seq), '[]'::jsonb) INTO v_prior
    FROM (SELECT DISTINCT ON (coalesce(class_key, ''), question_id) * FROM public.fs_equipment_answers
            WHERE company_id = p_company_id AND period_year = p_period_year - 1 ORDER BY coalesce(class_key, ''), question_id, seq DESC) x;
  RETURN jsonb_build_object('outcome', 'available', 'contract', 'fs-equipment-context/2', 'workpaper', v_work, 'notes', v_notes, 'schedule', v_schedule, 'answers', v_answers, 'priorAnswers', v_prior);
END;
$$;

-- Draft save of a /2 workpaper: compare-and-set on the latest revision, exact replay by request, no validation beyond
-- shape (a draft may be incomplete; nothing downstream reads a draft as a fact).
CREATE FUNCTION public.fs_save_equipment_workpaper_v2(p_company_id uuid, p_period_year integer, p_payload jsonb, p_expected_id uuid, p_source_document_id uuid, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_refusal text; v_prior public.fs_equipment_workpapers; v_current uuid; v_request jsonb; v_id uuid; v_source_sha text; v_at timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  v_refusal := public._fs_notes_refusal(p_company_id, auth.uid());
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome', v_refusal); END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_period_year NOT BETWEEN 2000 AND 2100 OR p_request_id IS NULL OR p_payload IS NULL
     OR jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload::text) > 120000
     OR p_payload->>'contract' IS DISTINCT FROM 'cfoclose-equipment-workpaper/2'
     OR p_payload->>'companyId' IS DISTINCT FROM p_company_id::text OR p_payload->>'periodYear' IS DISTINCT FROM p_period_year::text THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  v_request := jsonb_build_object('payload', p_payload, 'expectedId', p_expected_id, 'sourceDocumentId', p_source_document_id, 'draft', true);
  PERFORM pg_advisory_xact_lock(hashtextextended('fs_equipment_request:' || auth.uid()::text || ':' || p_request_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('fs_notes:' || p_company_id::text || ':' || p_period_year::text, 0));
  SELECT * INTO v_prior FROM public.fs_equipment_workpapers WHERE actor_user_id = auth.uid() AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.company_id = p_company_id AND v_prior.period_year = p_period_year AND v_prior.request_payload = v_request THEN
      RETURN jsonb_build_object('outcome', 'recorded', 'workpaperId', v_prior.id, 'sourceRetained', v_prior.source_document_id IS NOT NULL, 'createdAt', v_prior.created_at, 'replay', true);
    END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  SELECT id INTO v_current FROM public.fs_equipment_workpapers WHERE company_id = p_company_id AND period_year = p_period_year ORDER BY seq DESC LIMIT 1;
  IF v_current IS DISTINCT FROM p_expected_id THEN RETURN jsonb_build_object('outcome', 'stale', 'currentId', v_current); END IF;
  IF p_source_document_id IS NOT NULL THEN
    SELECT d.sha256 INTO v_source_sha FROM public.financial_statement_documents d
      WHERE d.id = p_source_document_id AND d.company_id = p_company_id AND d.status NOT IN ('QUARANTINED', 'EXTRACTION_FAILED', 'CLASSIFICATION_FAILED') AND d.superseded_at IS NULL;
    IF NOT FOUND OR v_source_sha IS DISTINCT FROM p_payload#>>'{priorSource,fact,documentSha256}' THEN RETURN jsonb_build_object('outcome', 'source_mismatch'); END IF;
  END IF;
  INSERT INTO public.fs_equipment_workpapers (company_id, period_year, payload, source_document_id, actor_user_id, firm_member_id, request_id, request_payload)
  VALUES (p_company_id, p_period_year, p_payload, p_source_document_id, auth.uid(), public._cr_member(p_company_id, auth.uid()), p_request_id, v_request) RETURNING id, created_at INTO v_id, v_at;
  RETURN jsonb_build_object('outcome', 'recorded', 'workpaperId', v_id, 'sourceRetained', p_source_document_id IS NOT NULL, 'createdAt', v_at);
END;
$$;

-- ONE transaction: the reviewed /2 workpaper, every class through the existing schedule authority, the answers as
-- facts, and up to three reviewed notes (policies, subclassifications, estimates), each compare-and-set on its latest
-- text. Outcomes: recorded (with replay on the same request) | request_reused | stale (workpaper) | stale_schedule |
-- stale_note | stale_inputs | invalid_preparation (problems named, nothing stored) | source_mismatch | invalid_schedule
-- (from the schedule authority) | invalid_request | forbidden | feature_disabled | framework_not_ifrs_for_smes.
CREATE FUNCTION public.fs_commit_equipment_preparation_v2(p_company_id uuid, p_period_year integer, p_payload jsonb, p_expected_workpaper_id uuid, p_source_document_id uuid,
  p_expected_schedule_id uuid, p_notes jsonb, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_refusal text; v_prior public.fs_equipment_workpapers; v_request jsonb; v_current_wp uuid; v_current_schedule uuid; v_existing_rows jsonb := '[]'::jsonb;
  v_comp jsonb; v_problems jsonb; v_source_sha text; v_wp_id uuid; v_at timestamptz; v_rows jsonb; v_schedule jsonb; v_schedule_request uuid;
  v_notes_out jsonb := '[]'::jsonb; n jsonb; c jsonb; v_req text; v_reqs text[] := '{}'; v_note_request uuid; v_current_note uuid; v_result jsonb; v_answers integer := 0;
  v_key text; v_val jsonb; v_source text; v_sub uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  v_refusal := public._fs_notes_refusal(p_company_id, auth.uid());
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome', v_refusal); END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_period_year NOT BETWEEN 2000 AND 2100 OR p_request_id IS NULL OR p_payload IS NULL
     OR jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload::text) > 120000
     OR p_payload->>'contract' IS DISTINCT FROM 'cfoclose-equipment-workpaper/2'
     OR p_payload->>'companyId' IS DISTINCT FROM p_company_id::text OR p_payload->>'periodYear' IS DISTINCT FROM p_period_year::text
     OR jsonb_typeof(p_payload->'classes') IS DISTINCT FROM 'array'
     OR p_notes IS NULL OR jsonb_typeof(p_notes) <> 'array' OR jsonb_array_length(p_notes) > 3 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  FOR n IN SELECT value FROM jsonb_array_elements(p_notes) LOOP
    v_req := n->>'requirementId';
    IF jsonb_typeof(n) <> 'object' OR v_req IS NULL OR v_req NOT IN ('smes.note.policies', 'smes.note.subclassifications', 'smes.note.estimates') OR v_req = ANY (v_reqs)
       OR jsonb_typeof(n->'body') IS DISTINCT FROM 'string' OR length(btrim(n->>'body')) NOT BETWEEN 1 AND 20000
       OR (n->'expectedTextId' IS NOT NULL AND jsonb_typeof(n->'expectedTextId') NOT IN ('null', 'string')) THEN
      RETURN jsonb_build_object('outcome', 'invalid_request');
    END IF;
    v_reqs := v_reqs || v_req;
  END LOOP;
  v_request := jsonb_build_object('payload', p_payload, 'expectedWorkpaperId', p_expected_workpaper_id, 'expectedScheduleId', p_expected_schedule_id, 'sourceDocumentId', p_source_document_id, 'notes', p_notes);
  v_schedule_request := md5(p_request_id::text || ':schedule')::uuid;
  -- Every request lock before the period lock, including the locks the standalone writers take.
  PERFORM pg_advisory_xact_lock(hashtextextended('fs_equipment_request:' || auth.uid()::text || ':' || p_request_id::text, 0));
  FOREACH v_req IN ARRAY v_reqs LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('fs_equipment_policy_request:' || auth.uid()::text || ':' || md5(p_request_id::text || ':note:' || v_req)::uuid::text, 0));
  END LOOP;
  PERFORM pg_advisory_xact_lock(hashtextextended('fs_notes:' || p_company_id::text || ':' || p_period_year::text, 0));

  SELECT * INTO v_prior FROM public.fs_equipment_workpapers WHERE actor_user_id = auth.uid() AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.company_id = p_company_id AND v_prior.period_year = p_period_year AND v_prior.request_payload = v_request THEN
      SELECT id INTO v_sub FROM public.fs_schedule_submissions WHERE actor_user_id = auth.uid() AND request_id = v_schedule_request;
      SELECT coalesce(jsonb_agg(i.receipt || jsonb_build_object('requirementId', i.requirement_id) ORDER BY i.created_at), '[]'::jsonb) INTO v_notes_out
        FROM public.fs_equipment_policy_insertions i WHERE i.actor_user_id = auth.uid() AND i.workpaper_id = v_prior.id;
      SELECT count(*) INTO v_answers FROM public.fs_equipment_answers x WHERE x.workpaper_id = v_prior.id;
      RETURN jsonb_build_object('outcome', 'recorded', 'workpaperId', v_prior.id, 'createdAt', v_prior.created_at, 'sourceRetained', v_prior.source_document_id IS NOT NULL,
        'schedule', CASE WHEN v_sub IS NULL THEN jsonb_build_object('outcome', 'unchanged') ELSE jsonb_build_object('outcome', 'recorded', 'submissionId', v_sub, 'replay', true) END,
        'notes', v_notes_out, 'answersRecorded', v_answers, 'replay', true);
    END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;

  -- The statements the preparer reviewed must be the statements now (charter R13, G9).
  v_comp := public.fs_statement_composition(p_company_id, p_period_year);
  IF v_comp->>'state' IS DISTINCT FROM 'composed' OR v_comp#>>'{pack,packId}' IS DISTINCT FROM 'ifrs-for-smes/2015'
     OR v_comp->>'compositionSha256' IS DISTINCT FROM p_payload->>'compositionSha256' THEN
    RETURN jsonb_build_object('outcome', 'stale_inputs');
  END IF;
  SELECT id INTO v_current_wp FROM public.fs_equipment_workpapers WHERE company_id = p_company_id AND period_year = p_period_year ORDER BY seq DESC LIMIT 1;
  IF v_current_wp IS DISTINCT FROM p_expected_workpaper_id THEN RETURN jsonb_build_object('outcome', 'stale', 'currentId', v_current_wp); END IF;
  SELECT s.id, s.rows INTO v_current_schedule, v_existing_rows FROM public.fs_schedule_submissions s
    WHERE s.company_id = p_company_id AND s.period_year = p_period_year AND s.schedule_id = 'ppe' ORDER BY s.seq DESC LIMIT 1;
  IF NOT FOUND THEN v_existing_rows := '[]'::jsonb; END IF;
  IF v_current_schedule IS DISTINCT FROM p_expected_schedule_id THEN RETURN jsonb_build_object('outcome', 'stale_schedule', 'currentId', v_current_schedule); END IF;
  FOR n IN SELECT value FROM jsonb_array_elements(p_notes) LOOP
    v_current_note := NULL;
    SELECT t.id INTO v_current_note FROM public.fs_disclosure_texts t WHERE t.company_id = p_company_id AND t.period_year = p_period_year AND t.requirement_id = n->>'requirementId' ORDER BY t.seq DESC LIMIT 1;
    IF v_current_note IS DISTINCT FROM (n->>'expectedTextId')::uuid THEN
      RETURN jsonb_build_object('outcome', 'stale_note', 'requirementId', n->>'requirementId', 'currentId', v_current_note);
    END IF;
  END LOOP;
  v_problems := public._fs_equipment_v2_problems(p_payload, v_existing_rows, v_comp, jsonb_array_length(p_notes) > 0);
  IF jsonb_array_length(v_problems) > 0 THEN RETURN jsonb_build_object('outcome', 'invalid_preparation', 'problems', v_problems); END IF;
  IF p_source_document_id IS NOT NULL THEN
    SELECT d.sha256 INTO v_source_sha FROM public.financial_statement_documents d
      WHERE d.id = p_source_document_id AND d.company_id = p_company_id AND d.status NOT IN ('QUARANTINED', 'EXTRACTION_FAILED', 'CLASSIFICATION_FAILED') AND d.superseded_at IS NULL;
    IF NOT FOUND OR v_source_sha IS DISTINCT FROM p_payload#>>'{priorSource,fact,documentSha256}' THEN RETURN jsonb_build_object('outcome', 'source_mismatch'); END IF;
  END IF;

  BEGIN
    INSERT INTO public.fs_equipment_workpapers (company_id, period_year, payload, source_document_id, actor_user_id, firm_member_id, request_id, request_payload)
    VALUES (p_company_id, p_period_year, p_payload, p_source_document_id, auth.uid(), public._cr_member(p_company_id, auth.uid()), p_request_id, v_request) RETURNING id, created_at INTO v_wp_id, v_at;
    v_source := 'Reviewed equipment workpaper ' || v_wp_id::text;
    -- Every class, in the order given; the carrying effect of each movement derived from its three columns.
    SELECT jsonb_agg(jsonb_build_object('classLabel', btrim(x->>'label'), 'openingMinor', x->'opening'->>'carryingMinor', 'closingMinor', x->'closing'->>'carryingMinor',
             'movements', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', m->>'kind', 'amountMinor', ((m->>'grossMinor')::numeric - (m->>'accumulatedDepreciationMinor')::numeric - (m->>'accumulatedImpairmentMinor')::numeric)::text))
                                     FROM jsonb_array_elements(x->'movements') m), '[]'::jsonb)) ORDER BY o)
      INTO v_rows FROM jsonb_array_elements(p_payload->'classes') WITH ORDINALITY AS t(x, o);
    v_schedule := public.fs_record_schedule(p_company_id, p_period_year, 'ppe', v_rows, v_source, v_schedule_request);
    IF v_schedule->>'outcome' NOT IN ('recorded', 'unchanged') OR v_schedule->>'outcome' IS NULL THEN RAISE SQLSTATE 'P2701' USING MESSAGE = v_schedule::text; END IF;
    -- Answers as facts: entity level, then per class.
    FOR v_key, v_val IN SELECT key, value FROM jsonb_each(p_payload->'entityAnswers') LOOP
      INSERT INTO public.fs_equipment_answers (company_id, period_year, workpaper_id, class_key, class_label, question_id, status, answer, actor_user_id, firm_member_id)
      VALUES (p_company_id, p_period_year, v_wp_id, NULL, NULL, v_key, v_val->>'status', v_val, auth.uid(), public._cr_member(p_company_id, auth.uid()));
      v_answers := v_answers + 1;
    END LOOP;
    FOR c IN SELECT value FROM jsonb_array_elements(p_payload->'classes') LOOP
      FOR v_key, v_val IN SELECT key, value FROM jsonb_each(c->'answers') LOOP
        INSERT INTO public.fs_equipment_answers (company_id, period_year, workpaper_id, class_key, class_label, question_id, status, answer, actor_user_id, firm_member_id)
        VALUES (p_company_id, p_period_year, v_wp_id, c->>'classId', btrim(c->>'label'), v_key, v_val->>'status', v_val, auth.uid(), public._cr_member(p_company_id, auth.uid()));
        v_answers := v_answers + 1;
      END LOOP;
    END LOOP;
    -- Reviewed notes: the WHOLE note each time, compare-and-set on the latest text, replay-safe by a derived request.
    FOR n IN SELECT value FROM jsonb_array_elements(p_notes) LOOP
      v_req := n->>'requirementId';
      v_note_request := md5(p_request_id::text || ':note:' || v_req)::uuid;
      v_result := public.fs_record_disclosure(p_company_id, p_period_year, v_req, n->>'body', v_source, v_note_request);
      IF v_result->>'outcome' NOT IN ('recorded', 'unchanged') OR v_result->>'outcome' IS NULL THEN RAISE SQLSTATE 'P2701' USING MESSAGE = (v_result || jsonb_build_object('requirementId', v_req))::text; END IF;
      INSERT INTO public.fs_equipment_policy_insertions (company_id, period_year, workpaper_id, actor_user_id, request_id, expected_policy_id, requirement_id, body_sha256, receipt)
      VALUES (p_company_id, p_period_year, v_wp_id, auth.uid(), v_note_request, (n->>'expectedTextId')::uuid, v_req, encode(sha256(convert_to(n->>'body', 'UTF8')), 'hex'), v_result);
      v_notes_out := v_notes_out || (v_result || jsonb_build_object('requirementId', v_req));
    END LOOP;
    RETURN jsonb_build_object('outcome', 'recorded', 'workpaperId', v_wp_id, 'createdAt', v_at, 'sourceRetained', p_source_document_id IS NOT NULL,
      'schedule', v_schedule, 'notes', v_notes_out, 'answersRecorded', v_answers, 'replay', false);
  EXCEPTION WHEN SQLSTATE 'P2701' THEN RETURN SQLERRM::jsonb;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.fs_equipment_context_v2(uuid, integer), public.fs_save_equipment_workpaper_v2(uuid, integer, jsonb, uuid, uuid, uuid),
  public.fs_commit_equipment_preparation_v2(uuid, integer, jsonb, uuid, uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fs_equipment_context_v2(uuid, integer), public.fs_save_equipment_workpaper_v2(uuid, integer, jsonb, uuid, uuid, uuid),
  public.fs_commit_equipment_preparation_v2(uuid, integer, jsonb, uuid, uuid, uuid, jsonb, uuid) TO authenticated;
