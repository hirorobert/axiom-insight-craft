-- 20261019100000_fs_notes_and_schedules.sql — notes, disclosure requirements and movement schedules, decided and
-- reconciled BY THE DATABASE.
--
--   1. fs_pack_requirements / fs_schedule_definitions   the IFRS for SMEs requirements (kind, applicability, blocking)
--      and movement schedules (lines, movement kinds with their sign rule), seeded from src/lib/frameworkPacks (pack
--      1.1.0) and pinned to it by the proof; immutable.
--   2. fs_requirement_decisions   append-only applicability decisions for the CONDITIONAL disclosures that only the
--      preparer can decide (e.g. share capital, 4.12) — with a reason; prepare_close. Conditions the data decides (a
--      schedule applies when its line has a carrying amount; the early-application disclosure applies when the edition
--      is applied early) are never decided by hand.
--   3. fs_disclosure_texts        append-only: the preparer's own wording for a disclosure, kept verbatim with its
--      source reference (or withdrawn). Nothing is generated.
--   4. fs_schedule_submissions    append-only structured movement schedules: per class an opening and closing carrying
--      amount and the cited movements. The SERVER validates every amount (exact minor units), every sign rule and every
--      class's arithmetic before storing anything; a schedule that does not add up is refused, not stored.
--   5. fs_notes_status            per requirement: provided / missing / undecided / not applicable (with its basis);
--      each schedule reconciled to the composed statement (closing = the composed line; opening = the composed prior-
--      year line when an authoritative comparative exists, otherwise stated as unverified — never passed); the
--      statement of changes in equity and the statement of cash flows reported by the evidence they need (never
--      composed from a trial balance). Blockers are stated; statusSha256 identifies the state.

DO $preflight$
BEGIN
  IF to_regclass('public.fs_pack_requirements') IS NOT NULL OR to_regclass('public.fs_schedule_definitions') IS NOT NULL
     OR to_regclass('public.fs_requirement_decisions') IS NOT NULL OR to_regclass('public.fs_disclosure_texts') IS NOT NULL
     OR to_regclass('public.fs_schedule_submissions') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: notes and schedules objects already exist; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. Requirements and schedule definitions ────────────────────────────────────────────────────────────────────────
CREATE TABLE public.fs_pack_requirements (
  pack_family    TEXT    NOT NULL CHECK (pack_family = 'ifrs-for-smes'),
  pack_version   TEXT    NOT NULL CHECK (pack_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  requirement_id TEXT    NOT NULL,
  kind           TEXT    NOT NULL CHECK (kind IN ('STATEMENT', 'LINE_ITEM', 'CLASSIFICATION', 'DISCLOSURE', 'COMPARATIVE', 'PERIOD', 'SCHEDULE')),
  statement      TEXT    NULL CHECK (statement IS NULL OR statement IN ('SFP', 'SCI', 'SOCIE', 'SCF', 'NOTES')),
  applicability  TEXT    NOT NULL CHECK (applicability IN ('ALWAYS', 'CONDITIONAL')),
  blocking       BOOLEAN NOT NULL,
  sort_order     INTEGER NOT NULL,
  PRIMARY KEY (pack_family, requirement_id)
);
INSERT INTO public.fs_pack_requirements (pack_family, pack_version, requirement_id, kind, statement, applicability, blocking, sort_order) VALUES
  ('ifrs-for-smes', '1.1.0', 'smes.set.sfp', 'STATEMENT', 'SFP', 'ALWAYS', true, 1),
  ('ifrs-for-smes', '1.1.0', 'smes.set.sci', 'STATEMENT', 'SCI', 'ALWAYS', true, 2),
  ('ifrs-for-smes', '1.1.0', 'smes.set.socie', 'STATEMENT', 'SOCIE', 'CONDITIONAL', true, 3),
  ('ifrs-for-smes', '1.1.0', 'smes.set.scf', 'STATEMENT', 'SCF', 'ALWAYS', true, 4),
  ('ifrs-for-smes', '1.1.0', 'smes.set.notes', 'STATEMENT', 'NOTES', 'ALWAYS', true, 5),
  ('ifrs-for-smes', '1.1.0', 'smes.comparatives', 'COMPARATIVE', NULL, 'ALWAYS', true, 6),
  ('ifrs-for-smes', '1.1.0', 'smes.period.annual', 'PERIOD', NULL, 'ALWAYS', true, 7),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_a', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 8),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_b', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 9),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_c', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 10),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_d', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 11),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_e', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 12),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_ea', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 13),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_f', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 14),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_g', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 15),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_h', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 16),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_i', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 17),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_j', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 18),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_k', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 19),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_l', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 20),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_m', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 21),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_n', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 22),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_o', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 23),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_p', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 24),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_q', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 25),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_2_r', 'LINE_ITEM', 'SFP', 'CONDITIONAL', true, 26),
  ('ifrs-for-smes', '1.1.0', 'smes.sfp.4_4', 'CLASSIFICATION', 'SFP', 'ALWAYS', true, 27),
  ('ifrs-for-smes', '1.1.0', 'smes.sci.5_5_a', 'LINE_ITEM', 'SCI', 'ALWAYS', true, 28),
  ('ifrs-for-smes', '1.1.0', 'smes.sci.5_5_b', 'LINE_ITEM', 'SCI', 'CONDITIONAL', true, 29),
  ('ifrs-for-smes', '1.1.0', 'smes.sci.5_5_c', 'LINE_ITEM', 'SCI', 'CONDITIONAL', true, 30),
  ('ifrs-for-smes', '1.1.0', 'smes.sci.5_5_d', 'LINE_ITEM', 'SCI', 'ALWAYS', true, 31),
  ('ifrs-for-smes', '1.1.0', 'smes.sci.5_5_e', 'LINE_ITEM', 'SCI', 'CONDITIONAL', true, 32),
  ('ifrs-for-smes', '1.1.0', 'smes.sci.5_5_f', 'LINE_ITEM', 'SCI', 'ALWAYS', true, 33),
  ('ifrs-for-smes', '1.1.0', 'smes.sci.5_5_g', 'LINE_ITEM', 'SCI', 'CONDITIONAL', true, 34),
  ('ifrs-for-smes', '1.1.0', 'smes.sci.5_5_h', 'LINE_ITEM', 'SCI', 'CONDITIONAL', true, 35),
  ('ifrs-for-smes', '1.1.0', 'smes.sci.5_5_i', 'LINE_ITEM', 'SCI', 'ALWAYS', true, 36),
  ('ifrs-for-smes', '1.1.0', 'smes.sci.5_11', 'CLASSIFICATION', 'SCI', 'ALWAYS', true, 37),
  ('ifrs-for-smes', '1.1.0', 'smes.note.compliance', 'DISCLOSURE', 'NOTES', 'ALWAYS', true, 38),
  ('ifrs-for-smes', '1.1.0', 'smes.note.identification', 'DISCLOSURE', 'NOTES', 'ALWAYS', true, 39),
  ('ifrs-for-smes', '1.1.0', 'smes.note.policies', 'DISCLOSURE', 'NOTES', 'ALWAYS', true, 40),
  ('ifrs-for-smes', '1.1.0', 'smes.note.judgements', 'DISCLOSURE', 'NOTES', 'ALWAYS', true, 41),
  ('ifrs-for-smes', '1.1.0', 'smes.note.estimates', 'DISCLOSURE', 'NOTES', 'ALWAYS', true, 42),
  ('ifrs-for-smes', '1.1.0', 'smes.note.subclassifications', 'DISCLOSURE', 'NOTES', 'ALWAYS', true, 43),
  ('ifrs-for-smes', '1.1.0', 'smes.note.share_capital', 'DISCLOSURE', 'NOTES', 'CONDITIONAL', true, 44),
  ('ifrs-for-smes', '1.1.0', 'smes.schedule.ppe', 'SCHEDULE', 'NOTES', 'CONDITIONAL', true, 45),
  ('ifrs-for-smes', '1.1.0', 'smes.schedule.investment_property_cost', 'SCHEDULE', 'NOTES', 'CONDITIONAL', true, 46),
  ('ifrs-for-smes', '1.1.0', 'smes.schedule.investment_property_fair_value', 'SCHEDULE', 'NOTES', 'CONDITIONAL', true, 47),
  ('ifrs-for-smes', '1.1.0', 'smes.schedule.intangibles', 'SCHEDULE', 'NOTES', 'CONDITIONAL', true, 48),
  ('ifrs-for-smes', '1.1.0', 'smes.schedule.provisions', 'SCHEDULE', 'NOTES', 'CONDITIONAL', true, 49),
  ('ifrs-for-smes', '1.1.0', 'smes.note.early_application', 'DISCLOSURE', 'NOTES', 'CONDITIONAL', true, 50);

CREATE TABLE public.fs_schedule_definitions (
  pack_family            TEXT    NOT NULL CHECK (pack_family = 'ifrs-for-smes'),
  schedule_id            TEXT    NOT NULL,
  requirement_id         TEXT    NOT NULL,
  label                  TEXT    NOT NULL,
  line_ids               TEXT[]  NOT NULL,
  movements              JSONB   NOT NULL,
  prior_period_required  BOOLEAN NOT NULL,
  sort_order             INTEGER NOT NULL,
  PRIMARY KEY (pack_family, schedule_id),
  CONSTRAINT fk_fssd_requirement FOREIGN KEY (pack_family, requirement_id) REFERENCES public.fs_pack_requirements (pack_family, requirement_id)
);
INSERT INTO public.fs_schedule_definitions (pack_family, schedule_id, requirement_id, label, line_ids, movements, prior_period_required, sort_order) VALUES
  ('ifrs-for-smes', 'ppe', 'smes.schedule.ppe', 'Property, plant and equipment', ARRAY['sfp.property_plant_and_equipment']::text[], '[{"kind":"additions","sign":"increase"},{"kind":"disposals","sign":"decrease"},{"kind":"business_combinations","sign":"increase"},{"kind":"revaluations_and_oci_impairment","sign":"either"},{"kind":"transfers_investment_property","sign":"either"},{"kind":"impairment_profit_or_loss","sign":"either"},{"kind":"depreciation","sign":"decrease"},{"kind":"other","sign":"either"}]'::jsonb, false, 1),
  ('ifrs-for-smes', 'investment_property_cost', 'smes.schedule.investment_property_cost', 'Investment property (cost model)', ARRAY['sfp.investment_property_cost']::text[], '[{"kind":"additions","sign":"increase"},{"kind":"disposals","sign":"decrease"},{"kind":"business_combinations","sign":"increase"},{"kind":"revaluations_and_oci_impairment","sign":"either"},{"kind":"transfers_investment_property","sign":"either"},{"kind":"impairment_profit_or_loss","sign":"either"},{"kind":"depreciation","sign":"decrease"},{"kind":"other","sign":"either"}]'::jsonb, false, 2),
  ('ifrs-for-smes', 'investment_property_fair_value', 'smes.schedule.investment_property_fair_value', 'Investment property (fair value)', ARRAY['sfp.investment_property_fair_value']::text[], '[{"kind":"additions","sign":"increase"},{"kind":"business_combination_additions","sign":"increase"},{"kind":"fair_value_gains_losses","sign":"either"},{"kind":"transfers_cost_model","sign":"either"},{"kind":"transfers_inventories_owner_occupied","sign":"either"},{"kind":"other","sign":"either"}]'::jsonb, false, 3),
  ('ifrs-for-smes', 'intangibles', 'smes.schedule.intangibles', 'Intangible assets', ARRAY['sfp.intangible_assets']::text[], '[{"kind":"additions","sign":"increase"},{"kind":"disposals","sign":"decrease"},{"kind":"business_combinations","sign":"increase"},{"kind":"amortisation","sign":"decrease"},{"kind":"impairment","sign":"decrease"},{"kind":"other","sign":"either"}]'::jsonb, false, 4),
  ('ifrs-for-smes', 'provisions', 'smes.schedule.provisions', 'Provisions', ARRAY['sfp.provisions']::text[], '[{"kind":"additions","sign":"increase"},{"kind":"used","sign":"decrease"},{"kind":"reversed","sign":"decrease"}]'::jsonb, false, 5);

CREATE TRIGGER trg_fspr_immutable BEFORE UPDATE OR DELETE ON public.fs_pack_requirements FOR EACH ROW EXECUTE FUNCTION public.fs_presentation_lines_guard();
CREATE TRIGGER trg_fspr_no_truncate BEFORE TRUNCATE ON public.fs_pack_requirements FOR EACH STATEMENT EXECUTE FUNCTION public.fs_presentation_lines_guard();
CREATE TRIGGER trg_fssd_immutable BEFORE UPDATE OR DELETE ON public.fs_schedule_definitions FOR EACH ROW EXECUTE FUNCTION public.fs_presentation_lines_guard();
CREATE TRIGGER trg_fssd_no_truncate BEFORE TRUNCATE ON public.fs_schedule_definitions FOR EACH STATEMENT EXECUTE FUNCTION public.fs_presentation_lines_guard();

-- ── 2–4. Append-only records ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.fs_requirement_decisions (
  id             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq            BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id     UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year    INTEGER     NOT NULL,
  pack_family    TEXT        NOT NULL DEFAULT 'ifrs-for-smes',
  requirement_id TEXT        NOT NULL,
  decision       TEXT        NOT NULL CHECK (decision IN ('applicable', 'not_applicable')),
  reason         TEXT        NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 2000),
  actor_user_id  UUID        NOT NULL,
  firm_member_id UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  request_id     UUID        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_fsrd_requirement FOREIGN KEY (pack_family, requirement_id) REFERENCES public.fs_pack_requirements (pack_family, requirement_id),
  CONSTRAINT uq_fsrd_request UNIQUE (actor_user_id, request_id)
);
CREATE INDEX idx_fsrd_current ON public.fs_requirement_decisions (company_id, period_year, requirement_id, seq DESC);

CREATE TABLE public.fs_disclosure_texts (
  id             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq            BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id     UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year    INTEGER     NOT NULL,
  pack_family    TEXT        NOT NULL DEFAULT 'ifrs-for-smes',
  requirement_id TEXT        NOT NULL,
  -- The preparer's wording, verbatim; NULL = withdrawn.
  body           TEXT        NULL CHECK (body IS NULL OR length(btrim(body)) BETWEEN 1 AND 20000),
  source_ref     TEXT        NULL CHECK (source_ref IS NULL OR length(btrim(source_ref)) BETWEEN 3 AND 300),
  actor_user_id  UUID        NOT NULL,
  firm_member_id UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  request_id     UUID        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_fsdt_requirement FOREIGN KEY (pack_family, requirement_id) REFERENCES public.fs_pack_requirements (pack_family, requirement_id),
  CONSTRAINT uq_fsdt_request UNIQUE (actor_user_id, request_id)
);
CREATE INDEX idx_fsdt_current ON public.fs_disclosure_texts (company_id, period_year, requirement_id, seq DESC);

CREATE TABLE public.fs_schedule_submissions (
  id             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq            BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id     UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year    INTEGER     NOT NULL,
  pack_family    TEXT        NOT NULL DEFAULT 'ifrs-for-smes',
  schedule_id    TEXT        NOT NULL,
  rows           JSONB       NOT NULL,
  opening_total  NUMERIC     NOT NULL,
  closing_total  NUMERIC     NOT NULL,
  content_sha256 TEXT        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_ref     TEXT        NOT NULL CHECK (length(btrim(source_ref)) BETWEEN 3 AND 300),
  actor_user_id  UUID        NOT NULL,
  firm_member_id UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  request_id     UUID        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_fsss_schedule FOREIGN KEY (pack_family, schedule_id) REFERENCES public.fs_schedule_definitions (pack_family, schedule_id),
  CONSTRAINT uq_fsss_request UNIQUE (actor_user_id, request_id)
);
CREATE INDEX idx_fsss_current ON public.fs_schedule_submissions (company_id, period_year, schedule_id, seq DESC);

CREATE TRIGGER trg_fsrd_append_only BEFORE UPDATE OR DELETE ON public.fs_requirement_decisions FOR EACH ROW EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_fsrd_no_truncate BEFORE TRUNCATE ON public.fs_requirement_decisions FOR EACH STATEMENT EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_fsdt_append_only BEFORE UPDATE OR DELETE ON public.fs_disclosure_texts FOR EACH ROW EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_fsdt_no_truncate BEFORE TRUNCATE ON public.fs_disclosure_texts FOR EACH STATEMENT EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_fsss_append_only BEFORE UPDATE OR DELETE ON public.fs_schedule_submissions FOR EACH ROW EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_fsss_no_truncate BEFORE TRUNCATE ON public.fs_schedule_submissions FOR EACH STATEMENT EXECUTE FUNCTION public.fs_presentation_append_only();

-- Shared guard: an authenticated actor with prepare_close, the rollout on, an IFRS for SMEs workspace. NULL = allowed.
CREATE OR REPLACE FUNCTION public._fs_notes_refusal(p_company_id uuid, p_uid uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN NOT public.workspace_capability_allowed(p_company_id, p_uid, 'prepare_close') THEN 'forbidden'
    WHEN NOT public.fs_rollout_allows(p_company_id) THEN 'feature_disabled'
    WHEN (SELECT c.reporting_framework FROM public.companies c WHERE c.id = p_company_id) IS DISTINCT FROM 'ifrs_for_smes' THEN 'framework_not_ifrs_for_smes'
  END;
$$;

-- ── 2. Applicability decisions ───────────────────────────────────────────────────────────────────────────────────────
-- Outcomes: recorded (replay on a retried request) | unchanged | forbidden | feature_disabled | invalid_request |
-- framework_not_ifrs_for_smes | not_decidable | request_reused.
CREATE OR REPLACE FUNCTION public.fs_decide_requirement(p_company_id uuid, p_period_year integer, p_requirement_id text, p_decision text,
  p_reason text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_refusal text;
  v_prior record;
  v_latest text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_requirement_id IS NULL OR p_request_id IS NULL OR p_decision NOT IN ('applicable', 'not_applicable')
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000 THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  v_refusal := public._fs_notes_refusal(p_company_id, v_uid);
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome', v_refusal); END IF;
  -- Only a CONDITIONAL disclosure the data cannot decide; the early-application disclosure follows the edition decision.
  IF NOT EXISTS (SELECT 1 FROM public.fs_pack_requirements r WHERE r.pack_family = 'ifrs-for-smes' AND r.requirement_id = p_requirement_id
                   AND r.kind = 'DISCLOSURE' AND r.applicability = 'CONDITIONAL' AND r.requirement_id <> 'smes.note.early_application') THEN
    RETURN jsonb_build_object('outcome', 'not_decidable');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fs_notes:' || p_company_id::text || ':' || p_period_year::text, 0));
  SELECT * INTO v_prior FROM public.fs_requirement_decisions d WHERE d.actor_user_id = v_uid AND d.request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.company_id = p_company_id AND v_prior.period_year = p_period_year AND v_prior.requirement_id = p_requirement_id
       AND v_prior.decision = p_decision AND v_prior.reason = btrim(p_reason) THEN RETURN jsonb_build_object('outcome', 'recorded', 'replay', true, 'decisionId', v_prior.id); END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  SELECT d.decision INTO v_latest FROM public.fs_requirement_decisions d
   WHERE d.company_id = p_company_id AND d.period_year = p_period_year AND d.requirement_id = p_requirement_id ORDER BY d.seq DESC LIMIT 1;
  IF v_latest = p_decision THEN RETURN jsonb_build_object('outcome', 'unchanged'); END IF;
  INSERT INTO public.fs_requirement_decisions (company_id, period_year, requirement_id, decision, reason, actor_user_id, firm_member_id, request_id)
  VALUES (p_company_id, p_period_year, p_requirement_id, p_decision, btrim(p_reason), v_uid, public._cr_member(p_company_id, v_uid), p_request_id)
  RETURNING jsonb_build_object('outcome', 'recorded', 'decisionId', id) INTO v_latest;
  RETURN v_latest::jsonb;
END;
$$;

-- ── 3. Disclosure texts ──────────────────────────────────────────────────────────────────────────────────────────────
-- p_body NULL withdraws the current text. Outcomes: recorded | unchanged | forbidden | feature_disabled |
-- invalid_request | framework_not_ifrs_for_smes | not_a_disclosure | request_reused.
CREATE OR REPLACE FUNCTION public.fs_record_disclosure(p_company_id uuid, p_period_year integer, p_requirement_id text, p_body text,
  p_source_ref text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_refusal text;
  v_prior record;
  v_latest record;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_requirement_id IS NULL OR p_request_id IS NULL
     OR (p_body IS NOT NULL AND length(btrim(p_body)) NOT BETWEEN 1 AND 20000)
     OR (p_source_ref IS NOT NULL AND length(btrim(p_source_ref)) NOT BETWEEN 3 AND 300) THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  v_refusal := public._fs_notes_refusal(p_company_id, v_uid);
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome', v_refusal); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fs_pack_requirements r WHERE r.pack_family = 'ifrs-for-smes' AND r.requirement_id = p_requirement_id AND r.kind IN ('DISCLOSURE', 'PERIOD')) THEN
    RETURN jsonb_build_object('outcome', 'not_a_disclosure');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fs_notes:' || p_company_id::text || ':' || p_period_year::text, 0));
  SELECT * INTO v_prior FROM public.fs_disclosure_texts t WHERE t.actor_user_id = v_uid AND t.request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.company_id = p_company_id AND v_prior.period_year = p_period_year AND v_prior.requirement_id = p_requirement_id
       AND v_prior.body IS NOT DISTINCT FROM p_body AND v_prior.source_ref IS NOT DISTINCT FROM btrim(p_source_ref) THEN
      RETURN jsonb_build_object('outcome', 'recorded', 'replay', true, 'textId', v_prior.id);
    END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  SELECT t.body, t.source_ref INTO v_latest FROM public.fs_disclosure_texts t
   WHERE t.company_id = p_company_id AND t.period_year = p_period_year AND t.requirement_id = p_requirement_id ORDER BY t.seq DESC LIMIT 1;
  IF (NOT FOUND AND p_body IS NULL) OR (FOUND AND v_latest.body IS NOT DISTINCT FROM p_body AND (p_body IS NULL OR v_latest.source_ref IS NOT DISTINCT FROM btrim(p_source_ref))) THEN
    RETURN jsonb_build_object('outcome', 'unchanged');
  END IF;
  INSERT INTO public.fs_disclosure_texts (company_id, period_year, requirement_id, body, source_ref, actor_user_id, firm_member_id, request_id)
  VALUES (p_company_id, p_period_year, p_requirement_id, p_body, CASE WHEN p_body IS NOT NULL THEN btrim(p_source_ref) END, v_uid, public._cr_member(p_company_id, v_uid), p_request_id)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'textId', v_id, 'withdrawn', p_body IS NULL);
END;
$$;

-- ── 4. Movement schedules ───────────────────────────────────────────────────────────────────────────────────────────
-- p_rows: [{"classLabel": text, "openingMinor": "<int>", "closingMinor": "<int>", "movements": [{"kind": text, "amountMinor": "<int>"}]}]
-- Every amount must be an exact integer string; each kind belongs to the schedule, appears at most once per class and
-- respects its sign; opening + movements = closing for every class, exactly. Otherwise nothing is stored and every
-- problem is named. Outcomes: recorded | unchanged | forbidden | feature_disabled | invalid_request |
-- framework_not_ifrs_for_smes | unknown_schedule | invalid_schedule | request_reused.
CREATE OR REPLACE FUNCTION public.fs_record_schedule(p_company_id uuid, p_period_year integer, p_schedule_id text, p_rows jsonb,
  p_source_ref text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_refusal text;
  v_def record;
  v_problems jsonb := '[]'::jsonb;
  v_norm jsonb;
  v_sha text;
  v_open numeric;
  v_close numeric;
  v_prior record;
  v_latest record;
  v_id uuid;
  c jsonb;
  m jsonb;
  v_i integer := 0;
  v_sum numeric;
  v_sign text;
  v_amt numeric;
  INT_RE CONSTANT text := '^(0|-?[1-9][0-9]{0,30})$';
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_schedule_id IS NULL OR p_request_id IS NULL OR p_source_ref IS NULL
     OR length(btrim(p_source_ref)) NOT BETWEEN 3 AND 300 OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 100 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  v_refusal := public._fs_notes_refusal(p_company_id, v_uid);
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome', v_refusal); END IF;
  SELECT * INTO v_def FROM public.fs_schedule_definitions d WHERE d.pack_family = 'ifrs-for-smes' AND d.schedule_id = p_schedule_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'unknown_schedule'); END IF;

  FOR c IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_i := v_i + 1;
    IF jsonb_typeof(c) <> 'object' OR jsonb_typeof(c -> 'classLabel') IS DISTINCT FROM 'string' OR length(btrim(c ->> 'classLabel')) NOT BETWEEN 1 AND 200
       OR jsonb_typeof(c -> 'openingMinor') IS DISTINCT FROM 'string' OR (c ->> 'openingMinor') !~ INT_RE
       OR jsonb_typeof(c -> 'closingMinor') IS DISTINCT FROM 'string' OR (c ->> 'closingMinor') !~ INT_RE
       OR jsonb_typeof(c -> 'movements') IS DISTINCT FROM 'array' THEN
      v_problems := v_problems || jsonb_build_object('row', v_i, 'code', 'ROW_MALFORMED');
      CONTINUE;
    END IF;
    v_sum := (c ->> 'openingMinor')::numeric;
    FOR m IN SELECT value FROM jsonb_array_elements(c -> 'movements') LOOP
      IF jsonb_typeof(m) <> 'object' OR jsonb_typeof(m -> 'kind') IS DISTINCT FROM 'string' OR jsonb_typeof(m -> 'amountMinor') IS DISTINCT FROM 'string'
         OR (m ->> 'amountMinor') !~ INT_RE THEN
        v_problems := v_problems || jsonb_build_object('row', v_i, 'code', 'MOVEMENT_MALFORMED');
        CONTINUE;
      END IF;
      SELECT e ->> 'sign' INTO v_sign FROM jsonb_array_elements(v_def.movements) e WHERE e ->> 'kind' = m ->> 'kind';
      IF v_sign IS NULL THEN v_problems := v_problems || jsonb_build_object('row', v_i, 'code', 'MOVEMENT_KIND_UNKNOWN', 'kind', m ->> 'kind'); CONTINUE; END IF;
      v_amt := (m ->> 'amountMinor')::numeric;
      IF (v_sign = 'increase' AND v_amt < 0) OR (v_sign = 'decrease' AND v_amt > 0) THEN
        v_problems := v_problems || jsonb_build_object('row', v_i, 'code', 'MOVEMENT_SIGN', 'kind', m ->> 'kind', 'sign', v_sign);
      END IF;
      v_sum := v_sum + v_amt;
    END LOOP;
    IF (SELECT count(*) FROM jsonb_array_elements(c -> 'movements') e) <> (SELECT count(DISTINCT e ->> 'kind') FROM jsonb_array_elements(c -> 'movements') e) THEN
      v_problems := v_problems || jsonb_build_object('row', v_i, 'code', 'MOVEMENT_KIND_REPEATED');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_problems) p WHERE (p ->> 'row')::integer = v_i AND p ->> 'code' IN ('MOVEMENT_MALFORMED', 'MOVEMENT_KIND_UNKNOWN'))
       AND v_sum <> (c ->> 'closingMinor')::numeric THEN
      v_problems := v_problems || jsonb_build_object('row', v_i, 'code', 'CLASS_DOES_NOT_ADD_UP', 'differenceMinor', ((c ->> 'closingMinor')::numeric - v_sum)::text);
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT btrim(e ->> 'classLabel')) FROM jsonb_array_elements(p_rows) e) <> jsonb_array_length(p_rows) THEN
    v_problems := v_problems || jsonb_build_object('code', 'CLASS_REPEATED');
  END IF;
  IF jsonb_array_length(v_problems) > 0 THEN RETURN jsonb_build_object('outcome', 'invalid_schedule', 'problems', v_problems); END IF;

  -- Canonical content: classes in the order given; movements in the schedule's cited order; amounts as given.
  SELECT jsonb_agg(jsonb_build_object('classLabel', btrim(e ->> 'classLabel'), 'openingMinor', e ->> 'openingMinor', 'closingMinor', e ->> 'closingMinor',
           'movements', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', x ->> 'kind', 'amountMinor', x ->> 'amountMinor')
                                   ORDER BY (SELECT d.o FROM jsonb_array_elements(v_def.movements) WITH ORDINALITY d(v, o) WHERE d.v ->> 'kind' = x ->> 'kind'))
                                  FROM jsonb_array_elements(e -> 'movements') x), '[]'::jsonb)) ORDER BY o),
         sum((e ->> 'openingMinor')::numeric), sum((e ->> 'closingMinor')::numeric)
    INTO v_norm, v_open, v_close FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(e, o);
  v_sha := encode(sha256(convert_to(v_norm::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended('fs_notes:' || p_company_id::text || ':' || p_period_year::text, 0));
  SELECT * INTO v_prior FROM public.fs_schedule_submissions s WHERE s.actor_user_id = v_uid AND s.request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.company_id = p_company_id AND v_prior.period_year = p_period_year AND v_prior.schedule_id = p_schedule_id
       AND v_prior.content_sha256 = v_sha AND v_prior.source_ref = btrim(p_source_ref) THEN
      RETURN jsonb_build_object('outcome', 'recorded', 'replay', true, 'submissionId', v_prior.id);
    END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  SELECT s.content_sha256, s.source_ref INTO v_latest FROM public.fs_schedule_submissions s
   WHERE s.company_id = p_company_id AND s.period_year = p_period_year AND s.schedule_id = p_schedule_id ORDER BY s.seq DESC LIMIT 1;
  IF FOUND AND v_latest.content_sha256 = v_sha AND v_latest.source_ref = btrim(p_source_ref) THEN RETURN jsonb_build_object('outcome', 'unchanged'); END IF;
  INSERT INTO public.fs_schedule_submissions (company_id, period_year, schedule_id, rows, opening_total, closing_total, content_sha256, source_ref, actor_user_id, firm_member_id, request_id)
  VALUES (p_company_id, p_period_year, p_schedule_id, v_norm, v_open, v_close, v_sha, btrim(p_source_ref), v_uid, public._cr_member(p_company_id, v_uid), p_request_id)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'submissionId', v_id, 'contentSha256', v_sha);
END;
$$;

-- ── 5. Status ────────────────────────────────────────────────────────────────────────────────────────────────────────
-- The latest valid evidence of a type for the period (CURRENT role): any series whose latest version validated.
CREATE OR REPLACE FUNCTION public._fs_evidence_present(p_company_id uuid, p_period_year integer, p_type text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM (SELECT DISTINCT ON (b.series_key) b.validation_status FROM public.financial_evidence_batches b
                    WHERE b.company_id = p_company_id AND b.reporting_period_id = 'FY' || p_period_year::text AND b.evidence_type = p_type AND b.period_role = 'CURRENT'
                    ORDER BY b.series_key, b.version DESC) latest
     WHERE latest.validation_status IN ('VALID', 'VALID_WITH_WARNINGS'));
$$;

-- VOLATILE because it reads fs_statement_composition (which uses a transaction-local working table); writes nothing.
CREATE OR REPLACE FUNCTION public.fs_notes_status(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_comp jsonb;
  v_early boolean;
  v_cmp_on boolean;
  v_start date;
  v_end date;
  v_reqs jsonb := '[]'::jsonb;
  v_blockers text[] := '{}';
  v_body jsonb;
  r record;
  v_status text;
  v_detail jsonb;
  v_dec record;
  v_txt record;
  v_sub record;
  v_def record;
  v_cur numeric;
  v_cmp numeric;
  v_comp_ok boolean;
BEGIN
  IF p_company_id IS NULL OR p_period_year IS NULL THEN RETURN jsonb_build_object('state', 'invalid_request'); END IF;
  v_comp := public.fs_statement_composition(p_company_id, p_period_year);
  IF v_comp ->> 'state' IS DISTINCT FROM 'composed' THEN RETURN v_comp; END IF;
  v_early := (v_comp -> 'pack' ->> 'earlyApplication')::boolean;
  v_cmp_on := v_comp -> 'comparative' ->> 'state' = 'available';
  v_start := (v_comp -> 'current' ->> 'reportingStart')::date;
  v_end := (v_comp -> 'current' ->> 'reportingEnd')::date;
  v_comp_ok := v_comp -> 'totals' -> 'current' ->> 'state' = 'complete' AND jsonb_array_length(v_comp -> 'blockers') = 0;

  FOR r IN SELECT * FROM public.fs_pack_requirements p WHERE p.pack_family = 'ifrs-for-smes' AND p.kind IN ('STATEMENT', 'DISCLOSURE', 'PERIOD', 'SCHEDULE') ORDER BY p.sort_order LOOP
    v_status := NULL; v_detail := '{}'::jsonb;
    SELECT t.id, t.body, t.source_ref, t.seq INTO v_txt FROM public.fs_disclosure_texts t
     WHERE t.company_id = p_company_id AND t.period_year = p_period_year AND t.requirement_id = r.requirement_id ORDER BY t.seq DESC LIMIT 1;
    IF r.kind = 'DISCLOSURE' THEN
      IF r.requirement_id = 'smes.note.early_application' AND NOT v_early THEN
        v_status := 'not_applicable'; v_detail := jsonb_build_object('basis', 'The edition is applied from its effective date.');
      ELSIF r.applicability = 'CONDITIONAL' AND r.requirement_id <> 'smes.note.early_application' THEN
        SELECT d.id, d.decision, d.reason INTO v_dec FROM public.fs_requirement_decisions d
         WHERE d.company_id = p_company_id AND d.period_year = p_period_year AND d.requirement_id = r.requirement_id ORDER BY d.seq DESC LIMIT 1;
        IF NOT FOUND THEN v_status := 'undecided';
        ELSIF v_dec.decision = 'not_applicable' THEN v_status := 'not_applicable'; v_detail := jsonb_build_object('basis', v_dec.reason, 'decisionId', v_dec.id);
        END IF;
        IF v_status IS NULL THEN v_detail := jsonb_build_object('decisionId', v_dec.id); END IF;
      END IF;
      IF v_status IS NULL THEN
        IF v_txt.body IS NOT NULL THEN v_status := 'provided'; v_detail := v_detail || jsonb_build_object('textId', v_txt.id, 'sourceRef', v_txt.source_ref);
        ELSE v_status := 'missing'; END IF;
      END IF;
      IF r.blocking AND v_status = 'missing' THEN v_blockers := v_blockers || ('REQUIRED_DISCLOSURE_MISSING:' || r.requirement_id); END IF;
      IF r.blocking AND v_status = 'undecided' THEN v_blockers := v_blockers || ('REQUIREMENT_UNDECIDED:' || r.requirement_id); END IF;
    ELSIF r.kind = 'PERIOD' THEN
      IF v_start IS NULL OR v_end IS NULL THEN v_status := 'dates_unknown'; v_blockers := v_blockers || 'PERIOD_DATES_UNKNOWN'::text;
      ELSIF v_end = (v_start + interval '1 year' - interval '1 day')::date THEN v_status := 'satisfied'; v_detail := jsonb_build_object('basis', 'A twelve-month period.');
      ELSIF v_txt.body IS NOT NULL THEN v_status := 'provided'; v_detail := jsonb_build_object('textId', v_txt.id, 'basis', 'A period longer or shorter than one year, disclosed.');
      ELSE v_status := 'missing'; v_detail := jsonb_build_object('basis', 'A period longer or shorter than one year needs its disclosure.');
        v_blockers := v_blockers || 'NON_ANNUAL_PERIOD_DISCLOSURE_MISSING'::text;
      END IF;
    ELSIF r.kind = 'SCHEDULE' THEN
      SELECT * INTO v_def FROM public.fs_schedule_definitions d WHERE d.pack_family = 'ifrs-for-smes' AND d.requirement_id = r.requirement_id;
      SELECT coalesce(sum((l -> 'current' ->> 'amountMinor')::numeric), 0), CASE WHEN v_cmp_on THEN coalesce(sum((l -> 'comparative' ->> 'amountMinor')::numeric), 0) END
        INTO v_cur, v_cmp FROM jsonb_array_elements(v_comp -> 'lines') l WHERE l ->> 'lineId' = ANY (v_def.line_ids);
      IF v_cur = 0 AND coalesce(v_cmp, 0) = 0 THEN
        v_status := 'not_applicable'; v_detail := jsonb_build_object('basis', 'No carrying amount on the composed statement at either date.');
      ELSE
        SELECT s.id, s.opening_total, s.closing_total, s.content_sha256, s.source_ref INTO v_sub FROM public.fs_schedule_submissions s
         WHERE s.company_id = p_company_id AND s.period_year = p_period_year AND s.schedule_id = v_def.schedule_id ORDER BY s.seq DESC LIMIT 1;
        v_detail := jsonb_build_object('scheduleId', v_def.schedule_id, 'composedClosingMinor', v_cur::text, 'composedOpeningMinor', v_cmp::text);
        IF NOT FOUND THEN v_status := 'missing'; v_blockers := v_blockers || ('SCHEDULE_MISSING:' || v_def.schedule_id);
        ELSE
          v_detail := v_detail || jsonb_build_object('submissionId', v_sub.id, 'contentSha256', v_sub.content_sha256, 'sourceRef', v_sub.source_ref,
                                                     'scheduleOpeningMinor', v_sub.opening_total::text, 'scheduleClosingMinor', v_sub.closing_total::text);
          IF v_sub.closing_total <> v_cur THEN
            v_status := 'closing_mismatch'; v_detail := v_detail || jsonb_build_object('differenceMinor', (v_sub.closing_total - v_cur)::text);
            v_blockers := v_blockers || ('SCHEDULE_CLOSING_MISMATCH:' || v_def.schedule_id);
          ELSIF v_cmp IS NULL THEN
            v_status := 'reconciled_opening_unverified'; v_detail := v_detail || jsonb_build_object('basis', 'No authoritative prior-year statement to agree the opening amount to.');
          ELSIF v_sub.opening_total <> v_cmp THEN
            v_status := 'opening_mismatch'; v_detail := v_detail || jsonb_build_object('differenceMinor', (v_sub.opening_total - v_cmp)::text);
            v_blockers := v_blockers || ('SCHEDULE_OPENING_MISMATCH:' || v_def.schedule_id);
          ELSE v_status := 'reconciled';
          END IF;
        END IF;
      END IF;
    ELSE -- STATEMENT
      IF r.requirement_id IN ('smes.set.sfp', 'smes.set.sci') THEN
        v_status := CASE WHEN v_comp_ok THEN 'composed' ELSE 'incomplete' END;
        IF NOT v_comp_ok THEN v_blockers := v_blockers || ('STATEMENT_INCOMPLETE:' || r.requirement_id); END IF;
      ELSIF r.requirement_id = 'smes.set.socie' THEN
        IF public._fs_evidence_present(p_company_id, p_period_year, 'EQUITY_MOVEMENTS') THEN v_status := 'evidence_present';
          v_detail := jsonb_build_object('basis', 'Equity-movement evidence is held; the statement is generated from it, never from a trial balance.');
        ELSE v_status := 'evidence_missing'; v_blockers := v_blockers || 'STATEMENT_EVIDENCE_MISSING:smes.set.socie'::text; END IF;
      ELSIF r.requirement_id = 'smes.set.scf' THEN
        IF public._fs_evidence_present(p_company_id, p_period_year, 'TRANSACTION_LEDGER') AND public._fs_evidence_present(p_company_id, p_period_year, 'CASH_ACCOUNT_MAP') THEN
          v_status := 'evidence_present';
          v_detail := jsonb_build_object('basis', 'A cash transaction ledger and cash account map are held; the statement is generated from them and reconciled account by account, never from a trial balance.');
        ELSE v_status := 'evidence_missing'; v_blockers := v_blockers || 'STATEMENT_EVIDENCE_MISSING:smes.set.scf'::text; END IF;
      ELSE
        v_status := 'derived'; -- the notes: complete when their components are (each blocks on its own)
      END IF;
    END IF;
    v_reqs := v_reqs || jsonb_build_array(jsonb_build_object('requirementId', r.requirement_id, 'kind', r.kind, 'blocking', r.blocking, 'status', v_status) || v_detail);
  END LOOP;

  v_body := jsonb_build_object('contract', 'fs-notes-status/1', 'packId', v_comp -> 'pack' ->> 'packId', 'compositionSha256', v_comp ->> 'compositionSha256',
                               'periodYear', p_period_year, 'requirements', v_reqs, 'blockers', to_jsonb(v_blockers));
  RETURN jsonb_build_object('state', 'evaluated') || v_body || jsonb_build_object('statusSha256', encode(sha256(convert_to(v_body::text, 'UTF8')), 'hex'));
END;
$$;

-- ── Access ───────────────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.fs_pack_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fs_schedule_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fs_requirement_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fs_disclosure_texts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fs_schedule_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fs_pack_requirements, public.fs_schedule_definitions, public.fs_requirement_decisions, public.fs_disclosure_texts,
  public.fs_schedule_submissions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.fs_pack_requirements, public.fs_schedule_definitions, public.fs_requirement_decisions, public.fs_disclosure_texts,
  public.fs_schedule_submissions TO authenticated;
CREATE POLICY fspr_read ON public.fs_pack_requirements FOR SELECT TO authenticated USING (true);
CREATE POLICY fssd_read ON public.fs_schedule_definitions FOR SELECT TO authenticated USING (true);
CREATE POLICY fsrd_read ON public.fs_requirement_decisions FOR SELECT TO authenticated USING (public.close_review_readable(company_id));
CREATE POLICY fsdt_read ON public.fs_disclosure_texts FOR SELECT TO authenticated USING (public.close_review_readable(company_id));
CREATE POLICY fsss_read ON public.fs_schedule_submissions FOR SELECT TO authenticated USING (public.close_review_readable(company_id));

REVOKE ALL ON FUNCTION public._fs_notes_refusal(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._fs_evidence_present(uuid, integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fs_decide_requirement(uuid, integer, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_decide_requirement(uuid, integer, text, text, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_record_disclosure(uuid, integer, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_record_disclosure(uuid, integer, text, text, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_record_schedule(uuid, integer, text, jsonb, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_record_schedule(uuid, integer, text, jsonb, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_notes_status(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_notes_status(uuid, integer) TO authenticated;
