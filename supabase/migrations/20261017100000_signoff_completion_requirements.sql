-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Sign-off completion requirements (roadmap increment 13, I8 — server side).
--
--   1. fs_publication_blockers is re-created from its exact 20260919110000 body with two marked additions
--      ([20261017100000]):
--        • a TRIAL_BALANCE_DERIVED report can be REVIEWED/FINAL only when every trial-balance fact in it comes from ONE
--          input identity equal to fs_reporting_input's current inputSha256 (REPORTING_INPUT_STALE otherwise; a report
--          built from anything but the authoritative input — e.g. an upload's processing result — is
--          REPORTING_INPUT_NOT_AUTHORITATIVE / STALE), the Close Review findings of that authority have been checked
--          (CLOSE_REVIEW_FINDINGS_NOT_CHECKED) with no unresolved blocking finding (CLOSE_REVIEW_BLOCKING_FINDINGS:n),
--          and no adjustment awaits a decision (CLOSE_REVIEW_ADJUSTMENTS_UNDECIDED:n);
--        • the comparative requirement is satisfied by comparative figures OR an approved first-period declaration —
--          nothing else.
--      fs_set_publication_state (capability-checked since 20260925140000: REVIEWED needs review_close, FINAL needs
--      approve_certification, FINAL only after REVIEWED, only the latest version, FINAL immutable) calls it unchanged,
--      so there is still ONE sign-off path.
--   2. fs_first_period_declarations — the first-period exception (revision 5 §3, C6): declared by a member holding
--      approve_certification, with a reason and the reference and date of the evidence (e.g. the certificate of
--      incorporation), the date validated to fall within the period; withdrawn by the same capability; append-only events.
--
-- PREFLIGHT: the declarations table does not exist yet; the migration refuses if it does.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
BEGIN
  IF to_regclass('public.fs_first_period_declarations') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: fs_first_period_declarations already exists; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

CREATE TABLE public.fs_first_period_declarations (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq             BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id      UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year     INTEGER     NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  action          TEXT        NOT NULL CHECK (action IN ('declared', 'withdrawn')),
  reason          TEXT        NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 2000),
  evidence_ref    TEXT        NULL CHECK (evidence_ref IS NULL OR length(btrim(evidence_ref)) BETWEEN 3 AND 300),
  evidence_date   DATE        NULL,
  actor_user_id   UUID        NOT NULL,
  firm_member_id  UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_fpd_declared_evidence CHECK (action <> 'declared' OR (evidence_ref IS NOT NULL AND evidence_date IS NOT NULL))
);
CREATE INDEX idx_fpd_company_period ON public.fs_first_period_declarations (company_id, period_year, seq DESC);
CREATE TRIGGER trg_fpd_append_only BEFORE UPDATE OR DELETE ON public.fs_first_period_declarations FOR EACH ROW EXECUTE FUNCTION public.close_review_events_guard();
CREATE TRIGGER trg_fpd_no_truncate BEFORE TRUNCATE ON public.fs_first_period_declarations FOR EACH STATEMENT EXECUTE FUNCTION public.close_review_events_guard();

CREATE OR REPLACE FUNCTION public.fs_first_period_declared(p_company_id uuid, p_period_year integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((SELECT d.action = 'declared' FROM public.fs_first_period_declarations d
                    WHERE d.company_id = p_company_id AND d.period_year = p_period_year ORDER BY d.seq DESC LIMIT 1), false);
$$;

-- Outcomes: recorded | forbidden | feature_disabled | invalid_request | no_period | evidence_date_outside_period | unchanged.
CREATE OR REPLACE FUNCTION public.fs_declare_first_period(p_company_id uuid, p_period_year integer, p_declare boolean, p_reason text,
  p_evidence_ref text, p_evidence_date date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_start date;
  v_end date;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_declare IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000
     OR (p_declare AND (p_evidence_ref IS NULL OR length(btrim(p_evidence_ref)) NOT BETWEEN 3 AND 300 OR p_evidence_date IS NULL)) THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'approve_certification') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fs_first_period:' || p_company_id::text || ':' || p_period_year::text, 0));
  IF public.fs_first_period_declared(p_company_id, p_period_year) = p_declare THEN RETURN jsonb_build_object('outcome', 'unchanged'); END IF;
  IF p_declare THEN
    -- The period of record: its dated start and end (the fiscal year end alone when undated).
    SELECT p.reporting_start, COALESCE(p.reporting_end, p.fiscal_year_end) INTO v_start, v_end
      FROM public.fiscal_periods p
     WHERE p.company_id = p_company_id AND EXTRACT(YEAR FROM COALESCE(p.reporting_end, p.fiscal_year_end))::integer = p_period_year
     ORDER BY p.created_at DESC LIMIT 1;
    IF v_end IS NULL THEN RETURN jsonb_build_object('outcome', 'no_period'); END IF;
    IF p_evidence_date > v_end OR (v_start IS NOT NULL AND p_evidence_date < v_start) OR (v_start IS NULL AND p_evidence_date < v_end - 366) THEN
      RETURN jsonb_build_object('outcome', 'evidence_date_outside_period', 'start', v_start, 'end', v_end);
    END IF;
  END IF;
  INSERT INTO public.fs_first_period_declarations (company_id, period_year, action, reason, evidence_ref, evidence_date, actor_user_id, firm_member_id)
  VALUES (p_company_id, p_period_year, CASE WHEN p_declare THEN 'declared' ELSE 'withdrawn' END, btrim(p_reason),
          CASE WHEN p_declare THEN btrim(p_evidence_ref) END, CASE WHEN p_declare THEN p_evidence_date END, v_uid, public._cr_member(p_company_id, v_uid));
  RETURN jsonb_build_object('outcome', 'recorded', 'declared', p_declare);
END;
$$;

ALTER TABLE public.fs_first_period_declarations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fs_first_period_declarations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.fs_first_period_declarations TO authenticated, service_role;
CREATE POLICY fpd_read ON public.fs_first_period_declarations FOR SELECT TO authenticated USING (public.close_review_readable(company_id));
REVOKE ALL ON FUNCTION public.fs_first_period_declared(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_first_period_declared(uuid, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fs_declare_first_period(uuid, integer, boolean, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_declare_first_period(uuid, integer, boolean, text, text, date) TO authenticated;

-- ── 1. fs_publication_blockers: the 20260919110000 body with the two [20261017100000] additions ──────────────────────
CREATE OR REPLACE FUNCTION public.fs_publication_blockers(p_company_id UUID, p_report_id TEXT, p_version INTEGER)
  RETURNS TEXT[]
  LANGUAGE plpgsql
  STABLE
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_report   public.financial_statement_reports;
  v_req      public.financial_statement_framework_requirements;
  v_b        public.financial_evidence_batches;
  v_out      TEXT[] := '{}';
  v_doc      JSONB;
  v_type     TEXT;
  v_cid      TEXT;
  v_id       TEXT;
  v_latest   INTEGER;
  v_n        INTEGER;
  v_comp_any BOOLEAN;
  v_txt      TEXT;
  v_cov      TEXT;
  v_rec      JSONB;
  v_disc     JSONB;
  v_has_budget BOOLEAN;
  v_input    JSONB;
  v_hashes   TEXT[];
BEGIN
  SELECT * INTO v_report FROM public.financial_statement_reports r
   WHERE r.report_id = p_report_id AND r.report_version = p_version AND r.company_id = p_company_id;
  IF NOT FOUND THEN
    RETURN ARRAY['REPORT_VERSION_NOT_FOUND'];
  END IF;
  v_doc := v_report.report_document;

  SELECT max(r.report_version) INTO v_latest FROM public.financial_statement_reports r WHERE r.report_id = p_report_id;
  IF v_latest <> p_version THEN v_out := array_append(v_out, 'NOT_LATEST_VERSION'); END IF;

  SELECT * INTO v_req FROM public.financial_statement_framework_requirements f WHERE f.framework_kind = v_doc #>> '{framework,kind}';
  IF NOT FOUND THEN
    v_out := array_append(v_out, 'FRAMEWORK_UNKNOWN');
  ELSE
    v_comp_any := jsonb_array_length(coalesce(v_doc -> 'comparativePeriods', '[]'::jsonb)) > 0;
    -- [20261017100000] The first-period exception: an approved first-period declaration (approve_certification, evidence
    -- dated within the period) satisfies the comparative requirement; nothing else does (reference-only figures never do).
    IF v_req.comparatives_required AND NOT v_comp_any AND NOT public.fs_first_period_declared(p_company_id, v_report.period_year) THEN
      v_out := array_append(v_out, 'COMPARATIVE_PERIOD_MISSING');
    END IF;

    FOREACH v_type IN ARRAY v_req.required_statement_types LOOP
      IF NOT jsonb_path_exists(v_doc, '$.statements[*] ? (@.type == $t)', jsonb_build_object('t', v_type)) THEN
        v_out := v_out || ('MISSING_STATEMENT:' || v_type);
      ELSIF v_req.comparatives_required AND v_comp_any THEN
        FOR v_cid IN SELECT jsonb_array_elements(v_doc -> 'comparativePeriods') ->> 'periodId' LOOP
          IF NOT jsonb_path_exists(v_doc, '$.statements[*] ? (@.type == $t).sections[*].lines[*].factBindings[*] ? (@.periodId == $c)',
                                   jsonb_build_object('t', v_type, 'c', v_cid)) THEN
            v_out := v_out || ('COMPARATIVE_FIGURES_MISSING:' || v_type || ':' || v_cid);
          END IF;
        END LOOP;
      END IF;
    END LOOP;

    FOREACH v_type IN ARRAY v_req.required_evidence_types LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.financial_evidence_batches b
         WHERE b.company_id = p_company_id AND b.evidence_batch_id = ANY (v_report.evidence_batch_ids) AND b.evidence_type = v_type
      ) THEN
        v_out := v_out || ('REQUIRED_EVIDENCE_MISSING:' || v_type);
      END IF;
    END LOOP;
  END IF;

  FOREACH v_id IN ARRAY v_report.evidence_batch_ids LOOP
    SELECT * INTO v_b FROM public.financial_evidence_batches b WHERE b.evidence_batch_id = v_id AND b.company_id = p_company_id;
    IF NOT FOUND THEN
      v_out := v_out || ('EVIDENCE_MISSING:' || v_id);
    ELSE
      IF v_b.validation_status NOT IN ('VALID', 'VALID_WITH_WARNINGS') THEN v_out := v_out || ('EVIDENCE_NOT_VALID:' || v_id); END IF;
      IF EXISTS (SELECT 1 FROM public.financial_evidence_batches n
                  WHERE n.company_id = v_b.company_id AND n.reporting_period_id = v_b.reporting_period_id AND n.evidence_type = v_b.evidence_type
                    AND n.period_role = v_b.period_role AND n.series_key = v_b.series_key AND n.version > v_b.version) THEN
        v_out := v_out || ('EVIDENCE_SUPERSEDED:' || v_id);
      END IF;
    END IF;
  END LOOP;

  IF v_req.framework_kind IS NOT NULL THEN
    -- Cash-flow authority: a ledger-derived closing figure AND proof that the ledger is complete account by account.
    IF 'STATEMENT_OF_CASH_FLOWS' = ANY (v_req.required_statement_types) THEN
      IF NOT jsonb_path_exists(v_doc, '$.statements[*] ? (@.type == "STATEMENT_OF_CASH_FLOWS").sections[*].lines[*] ? (@.lineId == "line:cf:closing")') THEN
        v_out := array_append(v_out, 'CASHFLOW_CLOSING_CASH_MISSING');
      END IF;
      IF NOT jsonb_path_exists(v_doc, '$.notes[*] ? (@.noteId == "note:cash-ledger-authority")') THEN
        v_out := array_append(v_out, 'CASHFLOW_LEDGER_AUTHORITY_MISSING');
      ELSIF NOT jsonb_path_exists(v_doc, '$.notes[*] ? (@.noteId == "note:cash-ledger-authority").monetaryFactIds[*] ? (@ starts with "fact:cashroll:ledger:")') THEN
        v_out := array_append(v_out, 'CASHFLOW_LEDGER_AUTHORITY_UNRESOLVED');
      END IF;
    END IF;

    -- Reviewed mappings: the trial balance must have been prepared with every account reviewed and unambiguous.
    IF v_req.requires_mapping_review THEN
      SELECT d ->> 'text' INTO v_cov FROM jsonb_array_elements(coalesce(v_doc -> 'textualDisclosures', '[]'::jsonb)) d WHERE d ->> 'disclosureId' = 'mapping:coverage' LIMIT 1;
      IF v_cov IS NULL THEN
        v_out := array_append(v_out, 'MAPPING_REVIEW_UNRECORDED');
      ELSIF v_cov !~ '^total=[1-9][0-9]*;unmapped=0;ambiguous=0$' THEN
        v_out := v_out || ('MAPPING_UNREVIEWED:' || left(v_cov, 60));
      END IF;
    END IF;

    -- Disclosure checklist: every framework disclosure area present and not MISSING.
    FOREACH v_id IN ARRAY v_req.disclosure_area_ids LOOP
      SELECT d ->> 'text' INTO v_txt FROM jsonb_array_elements(coalesce(v_doc -> 'textualDisclosures', '[]'::jsonb)) d WHERE d ->> 'disclosureId' = 'checklist:' || v_id LIMIT 1;
      IF v_txt IS NULL THEN
        v_out := v_out || ('DISCLOSURE_CHECKLIST_ABSENT:' || v_id);
      ELSIF v_txt LIKE 'MISSING:%' THEN
        v_out := v_out || ('DISCLOSURE_CHECKLIST_INCOMPLETE:' || v_id);
      END IF;
    END LOOP;

    -- Budget completeness, wherever a budget is part of this report.
    v_has_budget := EXISTS (SELECT 1 FROM public.financial_evidence_batches b WHERE b.company_id = p_company_id AND b.evidence_batch_id = ANY (v_report.evidence_batch_ids) AND b.evidence_type = 'BUDGET');
    IF jsonb_path_exists(v_doc, '$.textualDisclosures[*] ? (@.disclosureId == "budget:gap")') THEN
      v_out := array_append(v_out, 'BUDGET_COMPARISON_GAP');
    ELSIF v_has_budget AND NOT jsonb_path_exists(v_doc, '$.textualDisclosures[*] ? (@.disclosureId starts with "budget:line:")') THEN
      v_out := array_append(v_out, 'BUDGET_COMPARISON_MISSING');
    END IF;
    FOR v_disc IN SELECT d FROM jsonb_array_elements(coalesce(v_doc -> 'textualDisclosures', '[]'::jsonb)) d WHERE d ->> 'disclosureId' LIKE 'budget:line:%' ORDER BY d ->> 'disclosureId' LOOP
      v_rec := public.fs_try_jsonb(v_disc ->> 'text');
      IF v_rec IS NULL OR jsonb_typeof(v_rec) <> 'object' THEN
        v_out := v_out || ('BUDGET_LINE_UNREADABLE:' || (v_disc ->> 'disclosureId'));
      ELSE
        IF coalesce(v_rec ->> 'matched', 'false') <> 'true' THEN v_out := v_out || ('BUDGET_LINE_UNMATCHED:' || coalesce(v_rec ->> 'lineKey', '?')); END IF;
        IF v_rec ->> 'required' = 'true' AND coalesce(btrim(v_rec ->> 'explanation'), '') = '' THEN v_out := v_out || ('BUDGET_EXPLANATION_MISSING:' || coalesce(v_rec ->> 'lineKey', '?')); END IF;
      END IF;
    END LOOP;
  END IF;

  -- [20261017100000] A trial-balance report is final only on the CURRENT authoritative reporting input and a finished Close
  -- Review: its trial-balance facts must all come from one input identity equal to fs_reporting_input's now (else stale);
  -- the findings of that authority must have been checked with no unresolved blocking finding; no adjustment may be
  -- awaiting a decision.
  IF v_report.provenance_origin = 'TRIAL_BALANCE_DERIVED' THEN
    v_input := public.fs_reporting_input(p_company_id, v_report.period_year);
    SELECT array_agg(DISTINCT s) INTO v_hashes
      FROM jsonb_path_query(v_doc, '$.facts[*].provenance.source ? (@.artifactKind == "TRIAL_BALANCE").sourceHash') h(s0), LATERAL (SELECT h.s0 #>> '{}' AS s) x;
    IF v_input ->> 'state' IS DISTINCT FROM 'current' THEN
      v_out := v_out || ('REPORTING_INPUT_NOT_AUTHORITATIVE:' || coalesce(v_input ->> 'state', 'unknown'));
    ELSIF v_hashes IS NULL OR array_length(v_hashes, 1) <> 1 OR v_hashes[1] IS DISTINCT FROM v_input ->> 'inputSha256' THEN
      v_out := array_append(v_out, 'REPORTING_INPUT_STALE');
    END IF;
    IF v_input ->> 'state' = 'current' THEN
      IF v_input #>> '{findings,state}' IS DISTINCT FROM 'current' THEN
        v_out := array_append(v_out, 'CLOSE_REVIEW_FINDINGS_NOT_CHECKED');
      ELSIF coalesce((v_input #>> '{findings,unresolvedBlocking}')::integer, 0) > 0 THEN
        v_out := v_out || ('CLOSE_REVIEW_BLOCKING_FINDINGS:' || (v_input #>> '{findings,unresolvedBlocking}'));
      END IF;
      SELECT count(*) INTO v_n FROM public.close_review_adjustments a
       WHERE a.company_id = p_company_id AND a.period_year = v_report.period_year
         AND a.certification_id = (v_input #>> '{current,certificationId}')::uuid AND public._cr_adjustment_status(a.id) = 'proposed';
      IF v_n > 0 THEN v_out := v_out || ('CLOSE_REVIEW_ADJUSTMENTS_UNDECIDED:' || v_n); END IF;
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.financial_statement_evaluations e WHERE e.report_id = p_report_id AND e.report_version = p_version) THEN
    v_out := array_append(v_out, 'NOT_EVALUATED');
  ELSE
    v_n := public.fs_unresolved_blocking_count(p_report_id, p_version);
    IF v_n > 0 THEN v_out := v_out || ('BLOCKING_FINDINGS:' || v_n); END IF;
    v_n := public.fs_unmet_reconciliation_count(p_report_id, p_version);
    IF v_n > 0 THEN v_out := v_out || ('RECONCILIATION_UNMET:' || v_n); END IF;
  END IF;
  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.fs_publication_blockers(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
