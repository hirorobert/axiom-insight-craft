-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261124100000 — Financial-statements publication integrity gate: the server decides on the WHOLE document, reviewer-only
-- clearing of findings and reviews, and no official pack of a superseded FINAL. Forward-only; builds on 20261115100000 /
-- 20261116100000 (blockers v5, composition memo), 20261111100000 (publication state v2) and 20260925140000 (official pack).
--
--   WHAT WAS WRONG (reproduced by scripts/db-proof/publicationIntegrityGate.mjs with INTEGRITY_GATE_ABSENT=1):
--     1. fs_publication_blockers compared the server's figures with the facts BOUND ON the four statements only. A document's
--        other facts (notes, facts[] itself) and its header (period, dates, currency, provenance) were never compared, and the
--        only check on them was the evaluation the BROWSER supplies with the save (fs_commit_revision / fs_save_evaluation).
--        A client that reports no findings could therefore have a version with a fabricated note figure, a second "version"
--        of a statement fact carrying a different amount (the browser renders the highest version; the server accepted the
--        first match), a re-denominated amount or a re-dated period header marked REVIEWED and FINAL, and issued officially.
--     2. fs_append_decision let ANY member holding prepare_close record ACCEPT_FINDING / REJECT_FINDING, which removes a
--        blocking finding from fs_unresolved_blocking_count: a preparer could clear the findings of the version they prepared.
--     3. fs_set_publication_state let any such member move a REVIEWED version back to DRAFT (no capability check for DRAFT):
--        a recorded review could be withdrawn silently by a preparer.
--     4. issue_official_reporting_pack / seal_reporting_pack_server issued an OFFICIAL pack of a FINAL version even after a
--        LATER version of the same lineage had been made FINAL (a correction): a superseded version could be issued officially,
--        and verify/retrieve never disclosed the supersession.
--
--   WHAT CHANGES (each function redefined from its latest committed text with marked blocks only; nothing else in them changes):
--     · fs_publication_blockers v6 — document closure inside the IFRS for SMEs / trial-balance block: every fact in facts[] is a
--       server figure with exactly its amount (DOCUMENT_FACT_NOT_COMPOSED), every fact a note names is one (NOTE_FACT_NOT_COMPOSED),
--       every fact is in the composition's currency and scale (DOCUMENT_FACT_DENOMINATION), the presentation currency, the
--       period header, the comparative header and the provenance are the server's (DOCUMENT_CURRENCY_MISMATCH,
--       DOCUMENT_PERIOD_MISMATCH, DOCUMENT_PROVENANCE_MISMATCH). fs_report_readiness, fs_set_publication_state and the
--       binding trigger all follow. An honest document (prepareVersion.ts) carries only server figures, so nothing changes for it.
--     · fs_append_decision v2 — ACCEPT_FINDING / REJECT_FINDING need review_close (42501 otherwise); DEFER and REQUEST_EVIDENCE unchanged.
--     · fs_set_publication_state v3 — DRAFT on a REVIEWED version needs review_close (42501 otherwise); everything else unchanged.
--     · _fs_final_superseded_by(report, version) — the first later FINAL version of the lineage, or null (internal).
--     · issue_official_reporting_pack v2 / _reporting_pack_seal_refusal v2 — outcome superseded_final_version (audited REFUSED
--       event SUPERSEDED_FINAL_VERSION) when a later version of the lineage is FINAL; reporting_pack_sealed_object v2 adds
--       'superseded' so the Edge Function's verify/retrieve disclose it (official status of an intact pack is unchanged: it is
--       the official pack of the version it names, as issued); fs_list_saved_versions v2 adds supersededByFinal.
--   WHAT STAYS: every table, column, index, policy and grant of an existing object; every saved version, binding and sealed
--   pack; the legacy fs_save_report_version / fs_save_evaluation entry points (their evaluations are no longer the only check).
--   Not addressed here, registered: a second report LINEAGE of the same company, period and provenance can still reach FINAL
--   (the honest pages extend the first lineage; a cross-lineage rule needs its own proof pass).
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
BEGIN
  IF to_regprocedure('public._fs_final_superseded_by(text, integer)') IS NOT NULL
     OR position('DOCUMENT_FACT_NOT_COMPOSED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the publication integrity gate is already applied; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF position('ACCOUNT_CAPACITY_EXCEEDED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('REVIEW_COMMENT_UNRESOLVED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('financial_statement_reports:'' || p_report_id' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) = 0
     OR to_regprocedure('public._fs_memo_get(text)') IS NULL
     OR to_regprocedure('public._final_publication_for(uuid, integer, text)') IS NULL
     OR to_regprocedure('public.issue_official_reporting_pack(uuid, integer, text, uuid)') IS NULL
     OR to_regprocedure('public._reporting_pack_seal_refusal(uuid, uuid)') IS NULL
     OR to_regprocedure('public.reporting_pack_sealed_object(uuid)') IS NULL
     OR to_regprocedure('public.fs_append_decision(text, text, uuid, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: 20261115100000, 20261116100000, 20261111100000 and 20260925140000 must be applied first; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. The first later FINAL version of a lineage, or null ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._fs_final_superseded_by(p_report_id TEXT, p_report_version INTEGER)
RETURNS INTEGER LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT min(p.report_version) FROM public.financial_statement_publications p
   WHERE p_report_id IS NOT NULL AND p_report_version IS NOT NULL
     AND p.report_id = p_report_id AND p.report_version > p_report_version AND p.state = 'FINAL';
$$;

-- ── 2. Publication blockers v6: the 20261115100000 text + the document-closure block ──────────────────────────────────
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
  v_comp     JSONB;
BEGIN
  SELECT * INTO v_report FROM public.financial_statement_reports r
   WHERE r.report_id = p_report_id AND r.report_version = p_version AND r.company_id = p_company_id;
  IF NOT FOUND THEN
    RETURN ARRAY['REPORT_VERSION_NOT_FOUND'];
  END IF;
  v_doc := v_report.report_document;

  SELECT max(r.report_version) INTO v_latest FROM public.financial_statement_reports r WHERE r.report_id = p_report_id;
  IF v_latest <> p_version THEN v_out := array_append(v_out, 'NOT_LATEST_VERSION'); END IF;
  -- [20261115100000] Account capacity: named and returned at once, before any recomposition or evidence work.
  DECLARE
    v_cap jsonb := public.fs_account_capacity(p_company_id, v_report.period_year);
  BEGIN
    IF v_cap ->> 'state' = 'measured' AND NOT (v_cap ->> 'within')::boolean THEN
      RETURN array_append(v_out, 'ACCOUNT_CAPACITY_EXCEEDED:' || (v_cap ->> 'total') || '/' || (v_cap ->> 'bound'));
    END IF;
  END;

  -- [20261111100000] The one supported publication path: an IFRS for SMEs report derived from the authoritative trial
  -- balance. Every other framework or provenance is refused by name. The generic checks below still report what else is
  -- missing, but no such report can ever reach REVIEWED or FINAL through them (and fs_bind_publication refuses it too).
  IF v_report.provenance_origin IS DISTINCT FROM 'TRIAL_BALANCE_DERIVED' OR v_doc #>> '{framework,kind}' IS DISTINCT FROM 'IFRS_FOR_SMES' THEN
    v_out := v_out || ('PUBLICATION_PATH_UNSUPPORTED:' || coalesce(v_doc #>> '{framework,kind}', 'FRAMEWORK_UNKNOWN') || ':' || coalesce(v_report.provenance_origin, 'PROVENANCE_UNKNOWN'));
  END IF;

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

  -- [20261021100000, 20261111100000] An IFRS for SMEs trial-balance report is bound to its reporting dependencies — the
  -- database's composition, notes status, comparative status and evidence statements — and its four statements must carry
  -- EXACTLY the database's figures under their fixed fact identities; nothing else may be bound there. Every blocker of
  -- those dependencies is a blocker of the report; any later change makes the binding stale.
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
      -- [20261111100000] The edition the document seals must be the one the server resolves for the period.
      IF v_doc #>> '{framework,version}' IS NULL THEN
        v_out := array_append(v_out, 'FRAMEWORK_EDITION_UNRECORDED');
      ELSIF v_doc #>> '{framework,version}' IS DISTINCT FROM v_deps ->> 'packId' THEN
        v_out := v_out || ('FRAMEWORK_EDITION_MISMATCH:' || (v_doc #>> '{framework,version}') || ':' || (v_deps ->> 'packId'));
      END IF;
      -- [20261111100000] Only the 2015 edition's requirement texts are verified; a report composed under the third edition
      -- (a period beginning on or after 2027-01-01, or an early-application election) is refused by name.
      IF v_deps ->> 'packId' IS DISTINCT FROM 'ifrs-for-smes/2015' THEN
        v_out := v_out || ('FRAMEWORK_EDITION_UNSUPPORTED:' || coalesce(v_deps ->> 'packId', 'unknown'));
      END IF;
      v_out := v_out || ARRAY(SELECT jsonb_array_elements_text(v_deps -> 'blockers'));
      -- [20261111100000] Every evidence batch a server figure rests on is bound to this version.
      FOR v_rec IN SELECT b FROM jsonb_array_elements(coalesce(v_deps -> 'evidenceBatches', '[]'::jsonb)) b LOOP
        IF NOT ((v_rec ->> 'batchId') = ANY (v_report.evidence_batch_ids)) THEN
          v_out := v_out || ('EVIDENCE_NOT_BOUND:' || (v_rec ->> 'type') || ':' || (v_rec ->> 'role'));
        END IF;
      END LOOP;
      -- Every composed figure present with exactly its amount ...
      SELECT array_agg(f ->> 'factId' ORDER BY f ->> 'factId') INTO v_bad
        FROM jsonb_array_elements(v_deps -> 'figures') f
       WHERE NOT jsonb_path_exists(v_doc, '$.facts[*] ? (@.factId == $id && @.value.minorUnits.__bigint__ == $m)',
                                   jsonb_build_object('id', f ->> 'factId', 'm', f ->> 'amountMinor'));
      IF v_bad IS NOT NULL THEN v_out := v_out || ('STATEMENT_FIGURE_MISMATCH:' || array_length(v_bad, 1) || ':' || v_bad[1]); END IF;
      -- ... and nothing else bound on the four statements (20261111100000: the statements of changes in equity and cash flows too).
      SELECT array_agg(DISTINCT b ORDER BY b) INTO v_bad
        FROM jsonb_path_query(v_doc, '$.statements[*] ? (@.type == "STATEMENT_OF_FINANCIAL_POSITION" || @.type == "STATEMENT_OF_PROFIT_OR_LOSS" || @.type == "STATEMENT_OF_CHANGES_IN_EQUITY" || @.type == "STATEMENT_OF_CASH_FLOWS").sections[*].lines[*].factBindings[*].factId') q(j),
             LATERAL (SELECT q.j #>> '{}' AS b) x
       WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_deps -> 'figures') f WHERE f ->> 'factId' = x.b);
      IF v_bad IS NOT NULL THEN v_out := v_out || ('STATEMENT_FIGURE_NOT_COMPOSED:' || array_length(v_bad, 1) || ':' || v_bad[1]); END IF;

      -- [20261124100000] Document closure. The two checks above cover the facts BOUND ON the four statements. A document
      -- also carries facts in its notes and in facts[] itself, and a header (period, dates, currency, provenance); none of
      -- that was compared with the server, so a fabricated note figure, a second "version" of a statement fact (the browser
      -- renders the highest version), a re-denominated amount or a re-dated header passed whenever the browser-supplied
      -- evaluation reported nothing. Now EVERY monetary fact must be a server figure with exactly its amount, every fact a
      -- note names must be one, every fact is in the composition's currency and scale, and the header is the server's.
      SELECT array_agg(x.id ORDER BY x.id) INTO v_bad
        FROM (SELECT coalesce(f ->> 'factId', '(no factId)') AS id, f #>> '{value,minorUnits,__bigint__}' AS m
                FROM jsonb_array_elements(coalesce(v_doc -> 'facts', '[]'::jsonb)) f) x
       WHERE x.m IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_deps -> 'figures') g WHERE g ->> 'factId' = x.id AND g ->> 'amountMinor' = x.m);
      IF v_bad IS NOT NULL THEN v_out := v_out || ('DOCUMENT_FACT_NOT_COMPOSED:' || array_length(v_bad, 1) || ':' || v_bad[1]); END IF;
      SELECT array_agg(DISTINCT x.id ORDER BY x.id) INTO v_bad
        FROM (SELECT q #>> '{}' AS id FROM jsonb_path_query(v_doc, '$.notes[*].monetaryFactIds[*]') q
              UNION ALL SELECT q #>> '{}' FROM jsonb_path_query(v_doc, '$.notes[*].totalFactId') q
              UNION ALL SELECT q #>> '{}' FROM jsonb_path_query(v_doc, '$.notes[*].movementSchedule.openingBalanceFactId') q
              UNION ALL SELECT q #>> '{}' FROM jsonb_path_query(v_doc, '$.notes[*].movementSchedule.closingBalanceFactId') q
              UNION ALL SELECT q #>> '{}' FROM jsonb_path_query(v_doc, '$.notes[*].movementSchedule.additionFactIds[*]') q
              UNION ALL SELECT q #>> '{}' FROM jsonb_path_query(v_doc, '$.notes[*].movementSchedule.disposalFactIds[*]') q
              UNION ALL SELECT q #>> '{}' FROM jsonb_path_query(v_doc, '$.notes[*].movementSchedule.otherMovements[*].factId') q) x
       WHERE x.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_deps -> 'figures') g WHERE g ->> 'factId' = x.id);
      IF v_bad IS NOT NULL THEN v_out := v_out || ('NOTE_FACT_NOT_COMPOSED:' || array_length(v_bad, 1) || ':' || v_bad[1]); END IF;
      v_comp := public.fs_statement_composition(p_company_id, v_report.period_year);
      IF v_comp ->> 'state' = 'composed' THEN
        SELECT array_agg(coalesce(f ->> 'factId', '(no factId)') ORDER BY f ->> 'factId') INTO v_bad
          FROM jsonb_array_elements(coalesce(v_doc -> 'facts', '[]'::jsonb)) f
         WHERE (f #>> '{value,currency}') IS DISTINCT FROM (v_comp -> 'current' ->> 'currency') OR (f #>> '{value,scale}') IS DISTINCT FROM (v_comp -> 'current' ->> 'exponent');
        IF v_bad IS NOT NULL THEN v_out := v_out || ('DOCUMENT_FACT_DENOMINATION:' || array_length(v_bad, 1) || ':' || v_bad[1]); END IF;
        IF (v_doc #>> '{presentationCurrency,currency}') IS DISTINCT FROM (v_comp -> 'current' ->> 'currency')
           OR (v_doc #>> '{presentationCurrency,scale}') IS DISTINCT FROM (v_comp -> 'current' ->> 'exponent') THEN
          v_out := v_out || ('DOCUMENT_CURRENCY_MISMATCH:' || coalesce(v_doc #>> '{presentationCurrency,currency}', '?') || '/' || coalesce(v_doc #>> '{presentationCurrency,scale}', '?')
                             || ':' || coalesce(v_comp -> 'current' ->> 'currency', '?') || '/' || coalesce(v_comp -> 'current' ->> 'exponent', '?'));
        END IF;
        IF (v_doc #>> '{period,periodYear}') IS DISTINCT FROM v_report.period_year::text
           OR (v_doc #>> '{period,startDate}') IS DISTINCT FROM (v_comp -> 'current' ->> 'reportingStart')
           OR (v_doc #>> '{period,endDate}') IS DISTINCT FROM (v_comp -> 'current' ->> 'reportingEnd') THEN
          v_out := v_out || ('DOCUMENT_PERIOD_MISMATCH:current:' || coalesce(v_doc #>> '{period,periodYear}', '?') || ':' || coalesce(v_doc #>> '{period,startDate}', '?') || ':' || coalesce(v_doc #>> '{period,endDate}', '?'));
        END IF;
        IF jsonb_array_length(coalesce(v_doc -> 'comparativePeriods', '[]'::jsonb)) > 0
           AND ((v_doc #>> '{comparativePeriods,0,periodYear}') IS DISTINCT FROM (v_comp -> 'comparative' ->> 'periodYear')
                OR (v_doc #>> '{comparativePeriods,0,startDate}') IS DISTINCT FROM (v_input #>> '{comparative,reportingStart}')
                OR (v_doc #>> '{comparativePeriods,0,endDate}') IS DISTINCT FROM (v_input #>> '{comparative,reportingEnd}')) THEN
          v_out := v_out || ('DOCUMENT_PERIOD_MISMATCH:comparative:' || coalesce(v_doc #>> '{comparativePeriods,0,periodYear}', '?') || ':' || coalesce(v_doc #>> '{comparativePeriods,0,startDate}', '?') || ':' || coalesce(v_doc #>> '{comparativePeriods,0,endDate}', '?'));
        END IF;
      END IF;
      IF (v_doc ->> 'provenanceOrigin') IS DISTINCT FROM v_report.provenance_origin THEN
        v_out := v_out || ('DOCUMENT_PROVENANCE_MISMATCH:' || coalesce(v_doc ->> 'provenanceOrigin', '?') || ':' || v_report.provenance_origin);
      END IF;
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
  -- [20261112100000] A reviewer's BLOCKING comment on this lineage that is not resolved for THIS version's content blocks
  -- it by name; an advisory comment never does; a resolved comment whose item is unchanged stays resolved.
  v_out := v_out || ARRAY(SELECT 'REVIEW_COMMENT_UNRESOLVED:' || c.id::text
                            FROM public.fs_review_comment_states(p_company_id, p_report_id, p_version) c
                           WHERE c.severity = 'blocking' AND c.state <> 'resolved' ORDER BY c.seq);
  RETURN v_out;
END;
$$;

-- ── 3. Reviewer decisions v2: clearing a finding needs review_close ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fs_append_decision(p_decision_id TEXT, p_report_id TEXT, p_company_id UUID, p_decision JSONB)
  RETURNS public.financial_statement_reviewer_decisions
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor UUID;
  v_row   public.financial_statement_reviewer_decisions;
  v_clean JSONB := p_decision - 'reviewerId';
BEGIN
  v_actor := public.fs_actor_member_id(p_company_id);

  IF v_clean ->> 'decisionId' IS DISTINCT FROM p_decision_id THEN
    RAISE EXCEPTION 'INVALID: the decision payload id does not match the decision id argument' USING ERRCODE = '22023';
  END IF;
  IF v_clean ->> 'decisionType' IN ('CORRECT_FACT', 'CORRECT_EVIDENCE') THEN
    RAISE EXCEPTION 'INVALID: a correction must be recorded through a correction group' USING ERRCODE = '22023';
  END IF;
  -- [20261124100000] Accepting or rejecting a finding is a REVIEWER's decision: it removes the finding from the sign-off
  -- blockers (fs_unresolved_blocking_count), so review_close is required. A preparer may defer or request evidence; a
  -- preparer can never clear a blocking finding of a version they prepared.
  IF v_clean ->> 'decisionType' IN ('ACCEPT_FINDING', 'REJECT_FINDING') AND NOT public.workspace_capability_allowed(p_company_id, auth.uid(), 'review_close') THEN
    RAISE EXCEPTION 'FORBIDDEN: accepting or rejecting a finding needs the review_close capability' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('financial_statement_reviewer_decisions:' || p_report_id || ':' || p_decision_id));

  IF NOT EXISTS (SELECT 1 FROM public.financial_statement_reports r WHERE r.report_id = p_report_id AND r.company_id = p_company_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: no report lineage % for this company', p_report_id USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_row FROM public.financial_statement_reviewer_decisions WHERE report_id = p_report_id AND decision_id = p_decision_id;
  IF FOUND THEN
    IF v_row.company_id = p_company_id AND v_row.decision = v_clean THEN
      RETURN v_row;
    END IF;
    RAISE EXCEPTION 'REPLAY_CONFLICT: decision % already exists with different content', p_decision_id USING ERRCODE = 'PT409';
  END IF;

  INSERT INTO public.financial_statement_reviewer_decisions (decision_id, report_id, company_id, decision, reviewer_firm_member_id)
       VALUES (p_decision_id, p_report_id, p_company_id, v_clean, v_actor)
    RETURNING * INTO v_row;
  PERFORM public.fs_audit_event(p_company_id, p_report_id, 'DECISION_RECORDED', jsonb_build_object('decisionId', p_decision_id, 'decisionType', v_clean ->> 'decisionType'), v_actor);
  RETURN v_row;
END;
$$;

-- ── 4. Publication state v3: withdrawing a review needs review_close ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fs_set_publication_state(p_report_id text, p_report_version integer, p_company_id uuid, p_state text, p_reason text)
 RETURNS financial_statement_publications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_actor   UUID;
  v_current public.financial_statement_publications;
  v_latest_version INTEGER;
  v_row     public.financial_statement_publications;
  v_blockers TEXT[];
BEGIN
  v_actor := public.fs_actor_member_id(p_company_id);

  -- 20261111100000: approvals and version commits of one lineage are serialised on the lineage lock fs_commit_revision
  -- and fs_save_report_version take; the per-version lock below keeps its own ordering of replays and conflicts.
  PERFORM pg_advisory_xact_lock(hashtext('financial_statement_reports:' || p_report_id));
  PERFORM pg_advisory_xact_lock(hashtext('financial_statement_publications:' || p_report_id || ':' || p_report_version::text));

  IF NOT EXISTS (SELECT 1 FROM public.financial_statement_reports r WHERE r.report_id = p_report_id AND r.report_version = p_report_version AND r.company_id = p_company_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: no report % version % for this company', p_report_id, p_report_version USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_current FROM public.financial_statement_publications
   WHERE report_id = p_report_id AND report_version = p_report_version ORDER BY seq DESC LIMIT 1;

  IF FOUND AND v_current.state = p_state THEN
    RETURN v_current; -- exact replay
  END IF;
  IF FOUND AND v_current.state = 'FINAL' THEN
    RAISE EXCEPTION 'CONFLICT: a FINAL report version is immutable; create a new version instead' USING ERRCODE = 'PT409';
  END IF;
  -- [20261124100000] Withdrawing a recorded review (REVIEWED back to DRAFT) is a reviewer's act and needs review_close;
  -- before, any member holding prepare_close could silently un-review a version.
  IF p_state = 'DRAFT' AND v_current.id IS NOT NULL AND v_current.state = 'REVIEWED' AND NOT public.workspace_capability_allowed(p_company_id, auth.uid(), 'review_close') THEN
    RAISE EXCEPTION 'FORBIDDEN: withdrawing a recorded review needs the review_close capability' USING ERRCODE = '42501';
  END IF;

  IF (p_state = 'REVIEWED' AND NOT public.workspace_capability_allowed(p_company_id, auth.uid(), 'review_close'))
     OR (p_state = 'FINAL' AND NOT public.workspace_capability_allowed(p_company_id, auth.uid(), 'approve_certification')) THEN
    RAISE EXCEPTION 'FORBIDDEN: REVIEWED needs the review_close capability and FINAL needs approve_certification' USING ERRCODE = '42501';
  END IF;

  IF p_state IN ('REVIEWED', 'FINAL') THEN
    IF NOT EXISTS (SELECT 1 FROM public.financial_statement_evaluations e WHERE e.report_id = p_report_id AND e.report_version = p_report_version) THEN
      RAISE EXCEPTION 'NOT_EVALUATED: this report version has no evaluation; validate it before marking it %', p_state USING ERRCODE = 'PT409';
    END IF;
    IF p_state = 'FINAL' THEN
      SELECT max(r.report_version) INTO v_latest_version FROM public.financial_statement_reports r WHERE r.report_id = p_report_id;
      IF v_latest_version <> p_report_version THEN
        RAISE EXCEPTION 'STALE_REPORT_VERSION: only the latest version can be FINAL' USING ERRCODE = 'PT409';
      END IF;
    END IF;
    v_blockers := public.fs_publication_blockers(p_company_id, p_report_id, p_report_version);
    IF coalesce(array_length(v_blockers, 1), 0) > 0 THEN
      RAISE EXCEPTION 'BLOCKED: % requirement(s) unmet, the report cannot be marked %: %', array_length(v_blockers, 1), p_state, array_to_string(v_blockers, '; ') USING ERRCODE = 'PT409';
    END IF;
  END IF;

  IF p_state = 'FINAL' THEN
    IF v_current.id IS NULL OR v_current.state <> 'REVIEWED' THEN
      RAISE EXCEPTION 'CONFLICT: a report must be REVIEWED before it can be FINAL' USING ERRCODE = 'PT409';
    END IF;
    SELECT max(r.report_version) INTO v_latest_version FROM public.financial_statement_reports r WHERE r.report_id = p_report_id;
    IF v_latest_version <> p_report_version THEN
      RAISE EXCEPTION 'STALE_REPORT_VERSION: only the latest version can be FINAL' USING ERRCODE = 'PT409';
    END IF;
  END IF;

  INSERT INTO public.financial_statement_publications (report_id, report_version, company_id, state, reason, actor_firm_member_id)
       VALUES (p_report_id, p_report_version, p_company_id, p_state, p_reason, v_actor)
    RETURNING * INTO v_row;
  PERFORM public.fs_audit_event(p_company_id, p_report_id, 'PUBLICATION_STATE_SET', jsonb_build_object('reportVersion', p_report_version::text, 'state', p_state, 'reason', p_reason), v_actor);
  RETURN v_row;
END;
$function$;

-- ── 5. The official Reporting Pack: a superseded FINAL is never issued officially again, and supersession is disclosed ──
CREATE OR REPLACE FUNCTION public.issue_official_reporting_pack(p_company_id uuid, p_period_year integer, p_output_ref text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_pub  UUID;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('outcome', 'unauthenticated'); END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_request_id IS NULL
     OR NOT public._reporting_pack_officially_sealable('financial_statements_data', p_output_ref)
     OR NOT public._reporting_pack_output_ref_valid(p_company_id, p_period_year, 'financial_statements_data', p_output_ref) THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  -- Nothing about publication state is disclosed to a person without access to the workspace.
  IF public._workspace_access_basis(v_user, p_company_id) IS NULL THEN
    RETURN jsonb_build_object('outcome', 'workspace_access_denied');
  END IF;
  v_pub := public._final_publication_for(p_company_id, p_period_year, p_output_ref);
  IF v_pub IS NULL THEN
    INSERT INTO public.reporting_pack_issuance_events (company_id, actor_user_id, event, detail)
    VALUES (p_company_id, v_user, 'REFUSED', jsonb_build_object('stage', 'issue', 'code', 'FINAL_PUBLICATION_REQUIRED', 'output_ref', p_output_ref));
    RETURN jsonb_build_object('outcome', 'final_publication_required');
  END IF;
  -- [20261124100000] A FINAL version that a LATER FINAL of its lineage has superseded is history: no new official pack of
  -- it is issued (its existing sealed packs stay retrievable and verifiable, disclosed as superseded).
  IF public._fs_final_superseded_by((regexp_match(p_output_ref, '^fs-report:([A-Za-z0-9_-]{1,120}):v([0-9]{1,6})$'))[1], (regexp_match(p_output_ref, '^fs-report:([A-Za-z0-9_-]{1,120}):v([0-9]{1,6})$'))[2]::integer) IS NOT NULL THEN
    INSERT INTO public.reporting_pack_issuance_events (company_id, actor_user_id, event, detail)
    VALUES (p_company_id, v_user, 'REFUSED', jsonb_build_object('stage', 'issue', 'code', 'SUPERSEDED_FINAL_VERSION', 'output_ref', p_output_ref));
    RETURN jsonb_build_object('outcome', 'superseded_final_version');
  END IF;
  RETURN public._issue_reporting_pack(p_company_id, p_period_year, 'financial_statements_data', p_output_ref, p_request_id, v_pub);
END;
$function$;

CREATE OR REPLACE FUNCTION public._reporting_pack_seal_refusal(p_user UUID, p_issuance_id UUID, OUT p_code TEXT, OUT p_plan TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row  public.reporting_pack_issuances%ROWTYPE;
  v_auth JSONB;
  v_kind_auth JSONB;
  m TEXT[];
BEGIN
  SELECT * INTO v_row FROM public.reporting_pack_issuances WHERE id = p_issuance_id;
  IF v_row.id IS NULL OR v_row.issued_by IS DISTINCT FROM p_user THEN
    p_code := 'not_found'; RETURN;
  END IF;
  IF v_row.consumed_at IS NOT NULL THEN p_code := 'already_sealed'; RETURN; END IF;
  IF v_row.expires_at <= clock_timestamp() THEN p_code := 'expired'; RETURN; END IF;
  IF NOT public._reporting_pack_output_ref_valid(v_row.company_id, v_row.period_year, v_row.pack_kind, v_row.output_ref) THEN
    p_code := 'binding_mismatch'; RETURN;
  END IF;
  IF NOT public._reporting_pack_officially_sealable(v_row.pack_kind, v_row.output_ref) THEN
    p_code := 'official_sealing_unavailable'; RETURN;
  END IF;
  IF v_row.final_publication_id IS NULL
     OR v_row.final_publication_id IS DISTINCT FROM public._final_publication_for(v_row.company_id, v_row.period_year, v_row.output_ref) THEN
    p_code := 'final_publication_required'; RETURN;
  END IF;
  -- [20261124100000] An issuance opened before a later FINAL of the lineage is not sealed after it: superseded.
  m := regexp_match(v_row.output_ref, '^fs-report:([A-Za-z0-9_-]{1,120}):v([0-9]{1,6})$');
  IF m IS NOT NULL AND public._fs_final_superseded_by(m[1], m[2]::integer) IS NOT NULL THEN
    p_code := 'superseded_final_version'; RETURN;
  END IF;
  v_auth := public._authorize_paid_action(p_user, v_row.company_id, 'REPORTING_PACK_EXPORT');
  IF (v_auth->>'allowed')::boolean THEN
    v_kind_auth := public._authorize_paid_action(p_user, v_row.company_id, (SELECT f.capability_code FROM public.reporting_pack_kind_features f WHERE f.pack_kind = v_row.pack_kind));
    IF NOT (v_kind_auth->>'allowed')::boolean THEN v_auth := v_kind_auth; END IF;
  END IF;
  IF NOT (v_auth->>'allowed')::boolean THEN
    p_code := lower(v_auth->>'code'); RETURN;
  END IF;
  IF NOT public.has_workspace_capability(v_row.company_id, p_user, 'issue_reporting_pack') THEN
    p_code := 'capability_required'; RETURN;
  END IF;
  p_plan := v_auth->>'plan_code';
END;
$$;

CREATE OR REPLACE FUNCTION public.reporting_pack_sealed_object(p_issuance_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.reporting_pack_issuances%ROWTYPE;
  v_doc TEXT;
BEGIN
  SELECT * INTO v_row FROM public.reporting_pack_issuances i WHERE i.id = p_issuance_id AND i.consumed_at IS NOT NULL;
  IF v_row.id IS NULL THEN RETURN NULL; END IF;
  BEGIN
    v_doc := public._official_reporting_pack_document(v_row.id);
  EXCEPTION WHEN OTHERS THEN
    v_doc := NULL;
  END;
  RETURN jsonb_build_object('issuance_id', v_row.id, 'company_id', v_row.company_id, 'storage_path', v_row.storage_path,
                            'content_sha256', v_row.content_sha256, 'byte_size', v_row.byte_size,
                            'canonical_sha256', CASE WHEN v_doc IS NULL THEN NULL ELSE public.fs_sha256_hex(v_doc) END,
                            'object_present', public._reporting_pack_object_matches(v_row.storage_path, v_row.byte_size),
                            -- [20261124100000] Disclosed to verify/retrieve: a later FINAL of the lineage supersedes this pack's version.
                            'superseded', public._fs_final_superseded_by((regexp_match(v_row.output_ref, '^fs-report:([A-Za-z0-9_-]{1,120}):v([0-9]{1,6})$'))[1], (regexp_match(v_row.output_ref, '^fs-report:([A-Za-z0-9_-]{1,120}):v([0-9]{1,6})$'))[2]::integer) IS NOT NULL);
END;
$$;

-- ── 6. Saved versions: a superseded FINAL is listed as such ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fs_list_saved_versions(p_company_id UUID, p_period_year INTEGER)
  RETURNS JSONB
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_company_id NOT IN (SELECT public.get_member_company_ids()) THEN
    RAISE EXCEPTION 'FORBIDDEN: an accepted member of the company is required' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'reportId', r.report_id,
             'reportVersion', r.report_version,
             'createdAt', r.created_at,
             'creatorRole', fm.role,
             'creatorRef', left(public.fs_sha256_hex(r.created_by_firm_member_id::text), 8),
             'contentHash', r.content_hash,
             'evidenceBatchIds', to_jsonb(r.evidence_batch_ids),
             'state', coalesce((SELECT p.state FROM public.financial_statement_publications p
                                 WHERE p.report_id = r.report_id AND p.report_version = r.report_version ORDER BY p.seq DESC LIMIT 1), 'DRAFT'),
             'isLatest', r.report_version = (SELECT max(x.report_version) FROM public.financial_statement_reports x WHERE x.report_id = r.report_id),
             -- [20261124100000] The first later version of the lineage that is FINAL, or null: a superseded FINAL is shown as such.
             'supersededByFinal', public._fs_final_superseded_by(r.report_id, r.report_version)
           ) ORDER BY r.report_id, r.report_version)
      FROM public.financial_statement_reports r
      JOIN public.firm_members fm ON fm.id = r.created_by_firm_member_id
     WHERE r.company_id = p_company_id AND r.period_year = p_period_year), '[]'::jsonb);
END;
$$;

-- ── Access (restated for every redefined public name; nothing widens) ────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._fs_final_superseded_by(TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fs_publication_blockers(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fs_append_decision(TEXT, TEXT, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_append_decision(TEXT, TEXT, UUID, JSONB) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_set_publication_state(TEXT, INTEGER, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_set_publication_state(TEXT, INTEGER, UUID, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_list_saved_versions(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_list_saved_versions(UUID, INTEGER) TO authenticated;
REVOKE ALL ON FUNCTION public.issue_official_reporting_pack(UUID, INTEGER, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_official_reporting_pack(UUID, INTEGER, TEXT, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public._reporting_pack_seal_refusal(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reporting_pack_sealed_object(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reporting_pack_sealed_object(UUID) TO service_role;

DO $postcondition$
BEGIN
  IF to_regprocedure('public._fs_final_superseded_by(text, integer)') IS NULL
     OR position('DOCUMENT_FACT_NOT_COMPOSED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('NOTE_FACT_NOT_COMPOSED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('DOCUMENT_PERIOD_MISMATCH' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('ACCOUNT_CAPACITY_EXCEEDED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('REVIEW_COMMENT_UNRESOLVED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('ACCEPT_FINDING'', ''REJECT_FINDING'') AND NOT public.workspace_capability_allowed' IN pg_get_functiondef('public.fs_append_decision(text, text, uuid, jsonb)'::regprocedure)) = 0
     OR position('withdrawing a recorded review needs the review_close capability' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) = 0
     OR position('financial_statement_reports:'' || p_report_id' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) = 0
     OR position('superseded_final_version' IN pg_get_functiondef('public.issue_official_reporting_pack(uuid, integer, text, uuid)'::regprocedure)) = 0
     OR position('superseded_final_version' IN pg_get_functiondef('public._reporting_pack_seal_refusal(uuid, uuid)'::regprocedure)) = 0
     OR position('''superseded''' IN pg_get_functiondef('public.reporting_pack_sealed_object(uuid)'::regprocedure)) = 0
     OR position('supersededByFinal' IN pg_get_functiondef('public.fs_list_saved_versions(uuid, integer)'::regprocedure)) = 0
     OR has_function_privilege('authenticated', 'public._fs_final_superseded_by(text, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._fs_final_superseded_by(text, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fs_publication_blockers(uuid, text, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._reporting_pack_seal_refusal(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reporting_pack_sealed_object(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.reporting_pack_sealed_object(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_append_decision(text, text, uuid, jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_set_publication_state(text, integer, uuid, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_list_saved_versions(uuid, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.issue_official_reporting_pack(uuid, integer, text, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.issue_official_reporting_pack(uuid, integer, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: the publication integrity gate is not in its reviewed state' USING ERRCODE = 'P0001';
  END IF;
END;
$postcondition$;
