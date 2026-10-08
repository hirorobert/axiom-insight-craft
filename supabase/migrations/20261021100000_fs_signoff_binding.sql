-- 20261021100000_fs_signoff_binding.sql — sign-off bound to the immutable report content AND its reporting dependencies.
--
-- One sign-off path, unchanged: fs_set_publication_state (REVIEWED: review_close; FINAL: approve_certification; FINAL
-- immutable; only the latest version). This migration adds what it checks and what it records:
--   1. fs_reporting_dependencies   the identities a report rests on — the database's statement composition, notes
--                                  status and comparative status — their blockers, and every composed figure under a
--                                  fixed fact identity (each line, each presented account of it, each approved
--                                  restatement delta, each total); dependenciesSha256 identifies them together.
--   2. fs_publication_blockers v2  for an IFRS for SMEs trial-balance report: bound to those dependencies (unbound or
--                                  stale is a blocker), every dependency blocker is a report blocker, and the statements
--                                  of financial position and comprehensive income must carry exactly the composed
--                                  figures and nothing else. Everything else exactly as 20261017100000.
--   3. fs_publication_bindings     on every REVIEWED / FINAL publication (the canonical path's own insert, same
--                                  transaction): the server's SHA-256 of the stored document, its bound dependencies identity and a
--                                  snapshot of the dependencies at that moment. Append-only; a later change never alters
--                                  a binding — it makes the next sign-off need a new report version.

DO $preflight$
BEGIN
  IF to_regclass('public.fs_publication_bindings') IS NOT NULL OR to_regproc('public.fs_reporting_dependencies') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: sign-off binding objects already exist; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- VOLATILE because it reads the composition (a transaction-local working table); writes nothing persistent.
CREATE OR REPLACE FUNCTION public.fs_reporting_dependencies(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_comp jsonb;
  v_notes jsonb;
  v_cmp jsonb;
  v_figures jsonb;
  v_body jsonb;
BEGIN
  IF p_company_id IS NULL OR p_period_year IS NULL THEN RETURN jsonb_build_object('state', 'invalid_request'); END IF;
  v_comp := public.fs_statement_composition(p_company_id, p_period_year);
  IF v_comp ->> 'state' IS DISTINCT FROM 'composed' THEN RETURN jsonb_build_object('state', coalesce(v_comp ->> 'state', 'unavailable'), 'reason', v_comp ->> 'reason'); END IF;
  v_notes := public.fs_notes_status(p_company_id, p_period_year);
  v_cmp := public.fs_comparatives_status(p_company_id, p_period_year);
  -- Every composed figure under its fixed fact identity: lines per period, and the totals of every complete period.
  SELECT coalesce(jsonb_agg(x ORDER BY x ->> 'factId'), '[]'::jsonb) INTO v_figures FROM (
    SELECT jsonb_build_object('factId', 'fact:' || p.period || ':' || (l ->> 'section') || ':' || (l ->> 'lineId'), 'amountMinor', l -> p.period ->> 'amountMinor') AS x
      FROM jsonb_array_elements(v_comp -> 'lines') l CROSS JOIN (VALUES ('current'), ('comparative')) p(period)
     WHERE jsonb_typeof(l -> p.period) = 'object'
    UNION ALL
    -- Each presented account of each line, from the composition's lineage (an account appears once per period), and each
    -- approved restatement delta of the comparative.
    SELECT jsonb_build_object('factId', CASE WHEN x ->> 'kind' = 'restatement'
                                              THEN 'fact:comparative:restatement:' || (x ->> 'restatementId') || ':' || (l ->> 'section') || ':' || (l ->> 'lineId')
                                              ELSE 'fact:' || (x ->> 'period') || ':account:' || (x ->> 'accountKey') END,
                              'amountMinor', x ->> 'amountMinor')
      FROM jsonb_array_elements(v_comp -> 'lines') l CROSS JOIN LATERAL jsonb_array_elements(l -> 'lineage') x
    UNION ALL
    SELECT jsonb_build_object('factId', 'fact:' || t.key || ':total:' || k.key, 'amountMinor', k.value #>> '{}')
      FROM jsonb_each(v_comp -> 'totals') t CROSS JOIN LATERAL jsonb_each(t.value) k
     WHERE t.value ->> 'state' = 'complete' AND k.key LIKE '%Minor') s;
  v_body := jsonb_build_object('contract', 'fs-reporting-dependencies/1', 'periodYear', p_period_year,
    'packId', v_comp -> 'pack' ->> 'packId', 'linesVersion', v_comp -> 'pack' ->> 'linesVersion',
    'requirementsVersion', (SELECT max(r.pack_version) FROM public.fs_pack_requirements r WHERE r.pack_family = 'ifrs-for-smes'),
    'inputSha256', v_comp ->> 'inputSha256', 'compositionSha256', v_comp ->> 'compositionSha256',
    'notesStatusSha256', v_notes ->> 'statusSha256', 'comparativeStatusSha256', v_cmp ->> 'statusSha256',
    'comparativeState', v_cmp -> 'comparative' ->> 'state', 'comparativeSha256', v_cmp -> 'comparative' ->> 'comparativeSha256',
    'figures', v_figures,
    'blockers', (SELECT coalesce(jsonb_agg(b), '[]'::jsonb) FROM (
                   SELECT jsonb_array_elements_text(v_comp -> 'blockers') b
                   UNION ALL SELECT jsonb_array_elements_text(coalesce(v_notes -> 'blockers', '[]'::jsonb))
                   UNION ALL SELECT jsonb_array_elements_text(coalesce(v_cmp -> 'comparative' -> 'blockers', '[]'::jsonb))) bl));
  RETURN jsonb_build_object('state', 'current') || v_body || jsonb_build_object('dependenciesSha256', encode(sha256(convert_to(v_body::text, 'UTF8')), 'hex'));
END;
$$;

CREATE OR REPLACE FUNCTION public.fs_publication_blockers(p_company_id UUID, p_report_id TEXT, p_version INTEGER)
  RETURNS TEXT[]
  LANGUAGE plpgsql
  VOLATILE
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
  v_deps     JSONB;
  v_bad      TEXT[];
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
  -- awaiting a decision, and no approved adjustment may be awaiting a revalidation decision after a re-check.
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
      IF coalesce((v_input ->> 'adjustmentsRequiringRevalidation')::integer, 0) > 0 THEN
        v_out := v_out || ('CLOSE_REVIEW_ADJUSTMENTS_REQUIRE_REVALIDATION:' || (v_input ->> 'adjustmentsRequiringRevalidation'));
      END IF;
    END IF;
  END IF;

  -- [20261021100000] An IFRS for SMEs trial-balance report is bound to its reporting dependencies — the database's
  -- composition, notes status and comparative status — and its statements of financial position and comprehensive
  -- income must carry EXACTLY the database's composed figures, under the fixed fact identities
  -- fact:<period>:<section>:<lineId> (lines) and fact:<period>:total:<key> (totals); nothing else may be bound there.
  -- Every blocker of those dependencies is a blocker of the report; any later change makes the binding stale.
  IF v_report.provenance_origin = 'TRIAL_BALANCE_DERIVED' AND v_doc #>> '{framework,kind}' = 'IFRS_FOR_SMES' THEN
    v_deps := public.fs_reporting_dependencies(p_company_id, v_report.period_year);
    IF v_deps ->> 'state' IS DISTINCT FROM 'current' THEN
      v_out := v_out || ('REPORTING_DEPENDENCIES_UNAVAILABLE:' || coalesce(v_deps ->> 'state', 'unknown'));
    ELSE
      IF v_doc #>> '{reportingDependencies,dependenciesSha256}' IS NULL THEN
        v_out := array_append(v_out, 'REPORTING_DEPENDENCIES_UNBOUND');
      ELSIF v_doc #>> '{reportingDependencies,dependenciesSha256}' IS DISTINCT FROM v_deps ->> 'dependenciesSha256' THEN
        v_out := array_append(v_out, 'REPORTING_DEPENDENCIES_STALE');
      END IF;
      v_out := v_out || ARRAY(SELECT jsonb_array_elements_text(v_deps -> 'blockers'));
      -- Every composed figure present with exactly its amount ...
      SELECT array_agg(f ->> 'factId' ORDER BY f ->> 'factId') INTO v_bad
        FROM jsonb_array_elements(v_deps -> 'figures') f
       WHERE NOT jsonb_path_exists(v_doc, '$.facts[*] ? (@.factId == $id && @.value.minorUnits.__bigint__ == $m)',
                                   jsonb_build_object('id', f ->> 'factId', 'm', f ->> 'amountMinor'));
      IF v_bad IS NOT NULL THEN v_out := v_out || ('STATEMENT_FIGURE_MISMATCH:' || array_length(v_bad, 1) || ':' || v_bad[1]); END IF;
      -- ... and nothing else bound on those two statements.
      SELECT array_agg(DISTINCT b ORDER BY b) INTO v_bad
        FROM jsonb_path_query(v_doc, '$.statements[*] ? (@.type == "STATEMENT_OF_FINANCIAL_POSITION" || @.type == "STATEMENT_OF_PROFIT_OR_LOSS").sections[*].lines[*].factBindings[*].factId') q(j),
             LATERAL (SELECT q.j #>> '{}' AS b) x
       WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_deps -> 'figures') f WHERE f ->> 'factId' = x.b);
      IF v_bad IS NOT NULL THEN v_out := v_out || ('STATEMENT_FIGURE_NOT_COMPOSED:' || array_length(v_bad, 1) || ':' || v_bad[1]); END IF;
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

-- ── 3. Bindings ──────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.fs_publication_bindings (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq                 BIGINT      GENERATED ALWAYS AS IDENTITY,
  publication_id      UUID        NOT NULL UNIQUE REFERENCES public.financial_statement_publications (id) ON DELETE RESTRICT,
  company_id          UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  report_id           TEXT        NOT NULL,
  report_version      INTEGER     NOT NULL,
  state               TEXT        NOT NULL CHECK (state IN ('REVIEWED', 'FINAL')),
  -- The SERVER's SHA-256 of the stored document (jsonb text) — the content identity signed. The client-declared
  -- content hash of the version is kept beside it for reference only; it is never the authority.
  document_sha256     TEXT        NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  declared_content_hash TEXT      NOT NULL,
  dependencies_sha256 TEXT        NOT NULL CHECK (dependencies_sha256 ~ '^[0-9a-f]{64}$'),
  dependencies        JSONB       NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_fspb_report ON public.fs_publication_bindings (report_id, report_version, seq);
CREATE TRIGGER trg_fspb_append_only BEFORE UPDATE OR DELETE ON public.fs_publication_bindings FOR EACH ROW EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_fspb_no_truncate BEFORE TRUNCATE ON public.fs_publication_bindings FOR EACH STATEMENT EXECUTE FUNCTION public.fs_presentation_append_only();

-- Runs inside the canonical fs_set_publication_state insert (same transaction): an IFRS for SMEs trial-balance report
-- marked REVIEWED or FINAL records exactly what it was signed on. The blockers already refuse an unbound or stale
-- report; this re-checks at the moment of signing (defence in depth) and fails the whole sign-off if they differ.
CREATE OR REPLACE FUNCTION public.fs_bind_publication()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_report public.financial_statement_reports;
  v_deps jsonb;
BEGIN
  IF NEW.state NOT IN ('REVIEWED', 'FINAL') THEN RETURN NEW; END IF;
  SELECT * INTO v_report FROM public.financial_statement_reports r WHERE r.report_id = NEW.report_id AND r.report_version = NEW.report_version;
  IF v_report.provenance_origin IS DISTINCT FROM 'TRIAL_BALANCE_DERIVED' OR v_report.report_document #>> '{framework,kind}' IS DISTINCT FROM 'IFRS_FOR_SMES' THEN
    RETURN NEW;
  END IF;
  v_deps := public.fs_reporting_dependencies(NEW.company_id, v_report.period_year);
  IF v_deps ->> 'state' IS DISTINCT FROM 'current' OR v_report.report_document #>> '{reportingDependencies,dependenciesSha256}' IS DISTINCT FROM v_deps ->> 'dependenciesSha256' THEN
    RAISE EXCEPTION 'BINDING_STALE: the report is not bound to its current reporting dependencies; save a new version' USING ERRCODE = 'PT409';
  END IF;
  INSERT INTO public.fs_publication_bindings (publication_id, company_id, report_id, report_version, state, document_sha256, declared_content_hash, dependencies_sha256, dependencies)
  VALUES (NEW.id, NEW.company_id, NEW.report_id, NEW.report_version, NEW.state, encode(sha256(convert_to(v_report.report_document::text, 'UTF8')), 'hex'),
          v_report.content_hash, v_deps ->> 'dependenciesSha256', v_deps);
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_fsp_bind AFTER INSERT ON public.financial_statement_publications FOR EACH ROW EXECUTE FUNCTION public.fs_bind_publication();

-- ── Access ───────────────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.fs_publication_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fs_publication_bindings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.fs_publication_bindings TO authenticated;
CREATE POLICY fspb_read ON public.fs_publication_bindings FOR SELECT TO authenticated USING (public.close_review_readable(company_id));
REVOKE ALL ON FUNCTION public.fs_bind_publication() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fs_reporting_dependencies(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_reporting_dependencies(uuid, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_publication_blockers(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
