INSERT INTO cfoclose_fsi_release.staged_artifacts(batch, kind, body) VALUES ('fsi-4-document-structure', 'source', $cfoclose_fsi_stage_81ffd8ecdb4ad6ef$-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261126100000 — Document structure: the server verifies the WHOLE presentation of a financial-statements document, not
-- only its figures. Forward-only; builds on 20261124100000 (document closure) and 20261125100000 (FINAL authority).
--
--   WHAT WAS LEFT (after the document closure): the blockers compared every monetary fact with a server figure, but the
--   renderers (the Statements page, the printable pack, the official canonical document) read more than amounts: which
--   LINE a figure is bound on, under which LABEL, in which SECTION and STATEMENT, for which PERIOD column, and whether a
--   line is a detail or a total. A crafted document could keep every server figure and still present cash as inventory
--   (a swapped binding), the comparative in the current column (swapped period), a relabelled line, a line moved to another
--   section, a second statement of the same type, or a fact whose own period field contradicted its identity; the only
--   check on those was the browser's own validation, which a tampering client does not run.
--
--   WHAT CHANGES: _fs_document_structure_blockers (new, internal) and fs_publication_blockers v7 (v6 + one call inside the
--   IFRS for SMEs / trial-balance block):
--     · DOCUMENT_SHAPE_INVALID:<part>        a field the renderers read is missing or of the wrong JSON type;
--     · DOCUMENT_PERIOD_MISMATCH:comparative-declaration  the declared comparative periods are not the composition's;
--     · DOCUMENT_FACT_PERIOD_MISMATCH:<n>:<factId>  a fact's own reporting period contradicts its identity;
--     · DOCUMENT_PROVENANCE_UNBOUND:<n>:<factId>    a fact names a certification or evidence batch that is not this version's;
--     · DOCUMENT_STATEMENT_MISMATCH:<n>:<detail>    a statement is missing, duplicated, or not under its fixed id and title;
--     · DOCUMENT_LINE_DUPLICATE:<n>:<lineId>        a line id appears twice;
--     · DOCUMENT_STRUCTURE_MISMATCH:<n>:<lineId>:<field>  a line, label, section, role, normal balance, period binding or casting
--       child differs from the skeleton the server composes from its own data (composition, presentation vocabulary,
--       notes status, the evidence rows behind the cash-flow and equity statements).
--   An honest document (prepareVersion.ts) is built from exactly those server answers by deterministic builders, so nothing
--   changes for it; the proof signs one. Line ORDER within a section is not compared (it changes no figure, label or binding).
--   WHAT STAYS preparer-authored and is NOT verified against a server authority (stated, not hidden): the recorded disclosure
--   wording and policies (presence and in-force text id are checked by fs_notes_status), the entity's legal name, the
--   labels of cash-flow lines and equity components (they ARE the evidence rows' own text, verified to match those rows).
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
BEGIN
  IF to_regprocedure('public._fs_document_structure_blockers(uuid, integer, jsonb, text[])') IS NOT NULL
     OR position('_fs_document_structure_blockers' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the document structure check is already applied; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF position('DOCUMENT_FACT_NOT_COMPOSED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR to_regclass('public.fs_report_authority') IS NULL
     OR position('fs_server_compilation_blocker' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR to_regprocedure('public.fs_evidence_statements(uuid, integer)') IS NULL
     OR to_regprocedure('public._fs_slug(text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: 20261123100000, 20261124100000 and 20261125100000 must be applied first; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. The expected presentation skeleton, from the server's own data, compared with the document ───────────────────────
-- Mirrors the browser's deterministic builders (statements/canonicalDocument.ts, financialGeneration/cashFlowDirect.ts and
-- equityStatement.ts) line for line: the same ids, labels, roles, normal balances, period bindings and casting children,
-- derived here from fs_statement_composition, fs_notes_status, fs_presentation_lines and the evidence rows the server already
-- reads for fs_evidence_statements. Order within a section is not compared (it changes no figure, label or binding).
CREATE OR REPLACE FUNCTION public._fs_document_structure_blockers(p_company_id uuid, p_period_year integer, p_doc jsonb, p_evidence_batch_ids text[])
RETURNS text[] LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_out text[] := '{}';
  v_comp jsonb; v_notes jsonb; v_ev jsonb; v_input jsonb;
  v_has_cmp boolean; v_cmp_pid text;
  v_bad text[]; v_n integer; v_first text;
  v_ps text[];               -- periods whose totals are complete ('current' / 'comparative')
  v_tci jsonb;
  v_cur_cert text; v_cmp_cert text;
  r record; l record; x record;
  v_children text[]; v_role text; v_normal text; v_bind text; v_stmt text; v_sec text; v_seclabel text; v_label text; v_lineid text;
  v_openings text[]; v_closings text[]; v_profits text[]; v_nets text[]; v_mv text[];
  v_title text; v_act text;
BEGIN
  IF jsonb_typeof(p_doc) IS DISTINCT FROM 'object' THEN RETURN ARRAY['DOCUMENT_SHAPE_INVALID:document']; END IF;

  -- ── Shape: the fields the renderers, the official renderer and these checks read, with their JSON types ──
  IF jsonb_typeof(p_doc -> 'statements') IS DISTINCT FROM 'array' THEN v_out := v_out || 'DOCUMENT_SHAPE_INVALID:statements'::text; END IF;
  IF jsonb_typeof(p_doc -> 'facts') IS DISTINCT FROM 'array' THEN v_out := v_out || 'DOCUMENT_SHAPE_INVALID:facts'::text; END IF;
  IF jsonb_typeof(p_doc -> 'notes') IS DISTINCT FROM 'array' THEN v_out := v_out || 'DOCUMENT_SHAPE_INVALID:notes'::text; END IF;
  IF jsonb_typeof(p_doc -> 'comparativePeriods') IS DISTINCT FROM 'array' THEN v_out := v_out || 'DOCUMENT_SHAPE_INVALID:comparativePeriods'::text; END IF;
  IF jsonb_typeof(p_doc -> 'period') IS DISTINCT FROM 'object' OR (p_doc #>> '{period,periodId}') IS DISTINCT FROM 'CURRENT'
     OR jsonb_typeof(p_doc #> '{period,startDate}') IS DISTINCT FROM 'string' OR jsonb_typeof(p_doc #> '{period,endDate}') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_doc #> '{period,periodYear}') IS DISTINCT FROM 'number' THEN v_out := v_out || 'DOCUMENT_SHAPE_INVALID:period'::text; END IF;
  IF jsonb_typeof(p_doc -> 'presentationCurrency') IS DISTINCT FROM 'object' OR jsonb_typeof(p_doc -> 'framework') IS DISTINCT FROM 'object' THEN v_out := v_out || 'DOCUMENT_SHAPE_INVALID:header'::text; END IF;
  IF v_out <> '{}' THEN RETURN v_out; END IF;
  SELECT array_agg((o - 1)::text ORDER BY o) INTO v_bad FROM jsonb_array_elements(p_doc -> 'facts') WITH ORDINALITY f(v, o)
   WHERE NOT coalesce((jsonb_typeof(f.v) = 'object' AND jsonb_typeof(f.v -> 'factId') = 'string' AND jsonb_typeof(f.v -> 'version') = 'number'
              AND jsonb_typeof(f.v -> 'value') = 'object' AND jsonb_typeof(f.v #> '{value,minorUnits}') = 'object'
              AND jsonb_typeof(f.v #> '{value,minorUnits,__bigint__}') = 'string' AND (f.v #>> '{value,minorUnits,__bigint__}') ~ '^(0|-?[1-9][0-9]*)$'
              AND jsonb_typeof(f.v #> '{value,currency}') = 'string' AND jsonb_typeof(f.v #> '{value,scale}') = 'number'
              AND jsonb_typeof(f.v -> 'reportingPeriod') = 'object' AND jsonb_typeof(f.v #> '{reportingPeriod,periodId}') = 'string'
              AND jsonb_typeof(f.v #> '{reportingPeriod,isComparative}') = 'boolean' AND jsonb_typeof(f.v -> 'provenance') = 'object'), false);
  IF v_bad IS NOT NULL THEN v_out := v_out || ('DOCUMENT_SHAPE_INVALID:facts:' || array_length(v_bad, 1) || ':' || v_bad[1]); END IF;
  IF jsonb_path_exists(p_doc, '$.statements[*] ? (!(exists(@.type)) || @.type.type() != "string" || !(exists(@.statementId)) || @.statementId.type() != "string" || !(exists(@.title)) || @.title.type() != "string" || !(exists(@.sections)) || @.sections.type() != "array")')
     OR jsonb_path_exists(p_doc, '$.statements[*].sections[*] ? (!(exists(@.sectionId)) || @.sectionId.type() != "string" || !(exists(@.label)) || @.label.type() != "string" || !(exists(@.lines)) || @.lines.type() != "array")')
     OR jsonb_path_exists(p_doc, '$.statements[*].sections[*].lines[*] ? (!(exists(@.lineId)) || @.lineId.type() != "string" || !(exists(@.label)) || @.label.type() != "string" || !(exists(@.role)) || @.role.type() != "string" || !(exists(@.normalBalance)) || @.normalBalance.type() != "string" || !(exists(@.isContra)) || @.isContra.type() != "boolean" || !(exists(@.factBindings)) || @.factBindings.type() != "array" || !(exists(@.castingChildLineIds)) || @.castingChildLineIds.type() != "array")')
     OR jsonb_path_exists(p_doc, '$.statements[*].sections[*].lines[*].factBindings[*] ? (!(exists(@.periodId)) || @.periodId.type() != "string" || !(exists(@.factId)) || @.factId.type() != "string")')
     OR jsonb_path_exists(p_doc, '$.statements[*].sections[*].lines[*].castingChildLineIds[*] ? (@.type() != "string")') THEN
    v_out := v_out || 'DOCUMENT_SHAPE_INVALID:statements'::text;
  END IF;
  IF jsonb_path_exists(p_doc, '$.notes[*] ? (!(exists(@.noteId)) || @.noteId.type() != "string" || !(exists(@.monetaryFactIds)) || @.monetaryFactIds.type() != "array")')
     OR jsonb_path_exists(p_doc, '$.notes[*].monetaryFactIds[*] ? (@.type() != "string")') THEN
    v_out := v_out || 'DOCUMENT_SHAPE_INVALID:notes'::text;
  END IF;
  IF jsonb_path_exists(p_doc, '$.comparativePeriods[*] ? (!(exists(@.periodId)) || @.periodId.type() != "string" || @.periodId == "CURRENT" || !(exists(@.startDate)) || @.startDate.type() != "string" || !(exists(@.endDate)) || @.endDate.type() != "string" || !(exists(@.periodYear)) || @.periodYear.type() != "number")') THEN
    v_out := v_out || 'DOCUMENT_SHAPE_INVALID:comparativePeriods'::text;
  END IF;
  IF v_out <> '{}' THEN RETURN v_out; END IF;

  -- ── The server's own data ──
  v_comp := public.fs_statement_composition(p_company_id, p_period_year);
  IF v_comp ->> 'state' IS DISTINCT FROM 'composed' THEN RETURN v_out; END IF;   -- the dependencies already name it
  v_notes := public.fs_notes_status(p_company_id, p_period_year);
  v_input := public.fs_reporting_input(p_company_id, p_period_year);
  v_ev := public.fs_evidence_statements(p_company_id, p_period_year);          -- also (re)populates pg_temp.fs_ev_* for this transaction
  v_has_cmp := v_comp -> 'comparative' ->> 'state' = 'available';
  v_cmp_pid := p_doc #>> '{comparativePeriods,0,periodId}';
  v_cur_cert := v_comp -> 'current' ->> 'certificationId';
  v_cmp_cert := v_comp -> 'comparative' ->> 'certificationId';

  -- ── Declared comparative periods: exactly the composition's ──
  IF jsonb_array_length(p_doc -> 'comparativePeriods') <> (CASE WHEN v_has_cmp THEN 1 ELSE 0 END) OR (v_has_cmp AND v_cmp_pid IS DISTINCT FROM 'COMPARATIVE_1') THEN
    v_out := v_out || ('DOCUMENT_PERIOD_MISMATCH:comparative-declaration:' || jsonb_array_length(p_doc -> 'comparativePeriods') || ':' || coalesce(v_cmp_pid, '?'));
  END IF;

  -- ── Every fact's OWN period is the one its identity carries (a current figure declared comparative is refused) ──
  SELECT array_agg(f.id ORDER BY f.id) INTO v_bad FROM (
    SELECT v ->> 'factId' AS id, v #>> '{reportingPeriod,periodId}' AS pid, (v #>> '{reportingPeriod,isComparative}')::boolean AS cmp,
           CASE WHEN v ->> 'factId' LIKE 'fact:current:%' THEN 'CURRENT'
                WHEN v ->> 'factId' LIKE 'fact:comparative:%' THEN 'COMPARATIVE_1'
                WHEN v ->> 'factId' ~ '^fact:(line:(cf|eq)|cashperim):.+:(CURRENT|COMPARATIVE_1)$' THEN substring(v ->> 'factId' FROM ':([^:]+)$')
                WHEN v ->> 'factId' LIKE 'fact:cashroll:%' THEN 'CURRENT' END AS want
      FROM jsonb_array_elements(p_doc -> 'facts') v) f
   WHERE f.want IS NULL OR f.pid IS DISTINCT FROM f.want OR f.cmp IS DISTINCT FROM (f.want <> 'CURRENT') OR (f.want = 'COMPARATIVE_1' AND NOT v_has_cmp);
  IF v_bad IS NOT NULL THEN v_out := v_out || ('DOCUMENT_FACT_PERIOD_MISMATCH:' || array_length(v_bad, 1) || ':' || v_bad[1]); END IF;

  -- ── Provenance: a trial-balance fact names a presented certification; an evidence fact names a bound batch and its hash ──
  SELECT array_agg(f.id ORDER BY f.id) INTO v_bad FROM (
    SELECT v ->> 'factId' AS id, v #>> '{provenance,source,artifactKind}' AS kind, v #>> '{provenance,source,sourceDocumentId}' AS src, v #>> '{provenance,source,sourceHash}' AS hash
      FROM jsonb_array_elements(p_doc -> 'facts') v) f
   WHERE (f.kind = 'TRIAL_BALANCE' AND NOT (f.src = v_cur_cert OR (v_has_cmp AND f.src = v_cmp_cert)))
      OR (f.kind = 'EVIDENCE_BATCH' AND NOT EXISTS (SELECT 1 FROM public.financial_evidence_batches b WHERE b.company_id = p_company_id AND b.evidence_batch_id = f.src AND b.evidence_batch_id = ANY (p_evidence_batch_ids) AND b.content_hash = f.hash))
      OR (f.kind IS DISTINCT FROM 'TRIAL_BALANCE' AND f.kind IS DISTINCT FROM 'EVIDENCE_BATCH');
  IF v_bad IS NOT NULL THEN v_out := v_out || ('DOCUMENT_PROVENANCE_UNBOUND:' || array_length(v_bad, 1) || ':' || v_bad[1]); END IF;

  -- ── The expected skeleton ──
  CREATE TEMP TABLE IF NOT EXISTS fs_struct_exp (stmt text, section_id text, section_label text, line_id text, label text, role text, normal text, bindings text, children text) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS fs_struct_act (stmt text, section_id text, section_label text, line_id text, label text, role text, normal text, bindings text, children text, contra boolean) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS fs_struct_stmt (stmt text, statement_id text, title text) ON COMMIT DROP;
  DELETE FROM pg_temp.fs_struct_exp WHERE true; DELETE FROM pg_temp.fs_struct_act WHERE true; DELETE FROM pg_temp.fs_struct_stmt WHERE true;

  SELECT array_agg(p ORDER BY p) INTO v_ps FROM unnest(CASE WHEN v_has_cmp THEN ARRAY['current', 'comparative'] ELSE ARRAY['current'] END) p
   WHERE v_comp -> 'totals' -> p ->> 'state' = 'complete';
  v_ps := coalesce(v_ps, '{}');
  SELECT q -> 'totalsMinor' INTO v_tci FROM jsonb_array_elements(coalesce(v_notes -> 'requirements', '[]'::jsonb)) q WHERE q ->> 'requirementId' = 'smes.sci.5_5_i' AND q ->> 'status' = 'composed' LIMIT 1;

  INSERT INTO pg_temp.fs_struct_stmt VALUES ('STATEMENT_OF_FINANCIAL_POSITION', 'stmt:sfp', 'Statement of Financial Position'), ('STATEMENT_OF_PROFIT_OR_LOSS', 'stmt:sci', 'Statement of Comprehensive Income');
  IF v_ev -> 'statements' ->> 'STATEMENT_OF_CASH_FLOWS' = 'composed' THEN INSERT INTO pg_temp.fs_struct_stmt VALUES ('STATEMENT_OF_CASH_FLOWS', 'statement:cash-flows', 'Statement of cash flows (direct method)'); END IF;
  IF v_ev -> 'statements' ->> 'STATEMENT_OF_CHANGES_IN_EQUITY' = 'composed' THEN INSERT INTO pg_temp.fs_struct_stmt VALUES ('STATEMENT_OF_CHANGES_IN_EQUITY', 'statement:changes-in-equity', 'Statement of changes in equity'); END IF;

  -- Composed lines of the statement of financial position and of comprehensive income, each casting its presented accounts.
  FOR l IN SELECT (e ->> 'statement') AS statement, (e ->> 'section') AS section, (e ->> 'lineId') AS line_id, (e ->> 'label') AS label, e -> 'lineage' AS lineage,
                  jsonb_typeof(e -> 'current') = 'object' AS has_cur, v_has_cmp AND jsonb_typeof(e -> 'comparative') = 'object' AS has_cmp
             FROM jsonb_array_elements(v_comp -> 'lines') e LOOP
    v_stmt := CASE WHEN l.statement = 'SFP' THEN 'STATEMENT_OF_FINANCIAL_POSITION' ELSE 'STATEMENT_OF_PROFIT_OR_LOSS' END;
    v_sec := CASE WHEN l.statement = 'SFP' THEN 'section:' || l.section ELSE 'section:sci' END;
    v_seclabel := CASE WHEN l.statement = 'SFP' THEN CASE l.section WHEN 'non_current_assets' THEN 'Non-current assets' WHEN 'current_assets' THEN 'Current assets' WHEN 'equity' THEN 'Equity'
                                                     WHEN 'non_current_liabilities' THEN 'Non-current liabilities' WHEN 'current_liabilities' THEN 'Current liabilities' END ELSE 'Profit or loss' END;
    v_normal := CASE WHEN l.statement = 'SFP' THEN CASE WHEN l.section IN ('non_current_assets', 'current_assets') THEN 'DEBIT_NORMAL' ELSE 'CREDIT_NORMAL' END
                     ELSE CASE WHEN l.line_id IN ('sci.revenue', 'sci.other_income', 'sci.share_of_associates') THEN 'CREDIT_NORMAL' ELSE 'DEBIT_NORMAL' END END;
    -- detail children (an account once per period; an approved restatement delta on the comparative)
    v_children := '{}';
    FOR x IN SELECT c.child_id, c.child_label, string_agg(c.pid || '=' || c.fact_id, ',' ORDER BY c.pid) AS bindings
               FROM (SELECT CASE WHEN g ->> 'kind' = 'restatement' THEN 'line:restatement:' || (g ->> 'restatementId') || ':' || l.section || ':' || l.line_id
                                 ELSE 'line:detail:' || lower(l.statement) || ':' || (g ->> 'accountKey') END AS child_id,
                            CASE WHEN g ->> 'kind' = 'restatement' THEN 'Restatement of ' || l.label ELSE coalesce(g ->> 'accountCode', g ->> 'accountKey') || ' ' || coalesce(g ->> 'accountName', 'null') END AS child_label,
                            CASE WHEN g ->> 'period' = 'current' THEN 'CURRENT' ELSE 'COMPARATIVE_1' END AS pid,
                            CASE WHEN g ->> 'kind' = 'restatement' THEN 'fact:comparative:restatement:' || (g ->> 'restatementId') || ':' || l.section || ':' || l.line_id
                                 ELSE 'fact:' || (g ->> 'period') || ':account:' || (g ->> 'accountKey') END AS fact_id
                       FROM jsonb_array_elements(l.lineage) g
                      WHERE g ->> 'period' = 'current' OR (v_has_cmp AND g ->> 'period' = 'comparative')) c
              GROUP BY c.child_id, c.child_label ORDER BY c.child_id LOOP
      INSERT INTO pg_temp.fs_struct_exp VALUES (v_stmt, v_sec, v_seclabel, x.child_id, x.child_label, 'DETAIL', v_normal, x.bindings, '');
      v_children := v_children || x.child_id;
    END LOOP;
    SELECT string_agg(b, ',' ORDER BY b) INTO v_bind FROM (
      SELECT 'CURRENT=fact:current:' || l.section || ':' || l.line_id AS b WHERE l.has_cur
      UNION ALL SELECT 'COMPARATIVE_1=fact:comparative:' || l.section || ':' || l.line_id WHERE l.has_cmp) q;
    INSERT INTO pg_temp.fs_struct_exp VALUES (v_stmt, v_sec, v_seclabel, 'line:' || l.section || ':' || l.line_id, l.label,
      CASE WHEN array_length(v_children, 1) > 0 THEN 'SUBTOTAL' ELSE 'DETAIL' END, v_normal, coalesce(v_bind, ''), array_to_string((SELECT array_agg(c ORDER BY c) FROM unnest(v_children) c), ','));
  END LOOP;

  -- Section subtotals of the statement of financial position (SUBTOTAL casting the section's cast lines; DETAIL when it casts nothing).
  IF v_ps <> '{}' THEN
    FOR r IN SELECT * FROM (VALUES ('non_current_assets', 'nonCurrentAssetsMinor', 'Total non-current assets', 'DEBIT_NORMAL'), ('current_assets', 'currentAssetsMinor', 'Total current assets', 'DEBIT_NORMAL'),
                                   ('equity', 'equityAccountsMinor', 'Equity accounts', 'CREDIT_NORMAL'), ('non_current_liabilities', 'nonCurrentLiabilitiesMinor', 'Total non-current liabilities', 'CREDIT_NORMAL'),
                                   ('current_liabilities', 'currentLiabilitiesMinor', 'Total current liabilities', 'CREDIT_NORMAL')) t(section, key, label, normal) LOOP
      SELECT array_agg(e.line_id ORDER BY e.line_id) INTO v_children FROM pg_temp.fs_struct_exp e
       WHERE e.stmt = 'STATEMENT_OF_FINANCIAL_POSITION' AND e.section_id = 'section:' || r.section AND e.role = 'SUBTOTAL';
      SELECT string_agg(CASE p WHEN 'current' THEN 'CURRENT' ELSE 'COMPARATIVE_1' END || '=fact:' || p || ':total:' || r.key, ',' ORDER BY CASE p WHEN 'current' THEN 'CURRENT' ELSE 'COMPARATIVE_1' END) INTO v_bind FROM unnest(v_ps) p;
      INSERT INTO pg_temp.fs_struct_exp VALUES ('STATEMENT_OF_FINANCIAL_POSITION', 'section:' || r.section,
        CASE r.section WHEN 'non_current_assets' THEN 'Non-current assets' WHEN 'current_assets' THEN 'Current assets' WHEN 'equity' THEN 'Equity' WHEN 'non_current_liabilities' THEN 'Non-current liabilities' ELSE 'Current liabilities' END,
        'line:sfp:total:' || r.key, r.label, CASE WHEN v_children IS NULL THEN 'DETAIL' ELSE 'SUBTOTAL' END, r.normal, v_bind, coalesce(array_to_string(v_children, ','), ''));
    END LOOP;
    -- The totals sections (children fixed by the builder; a sum with nothing to cast is a DETAIL line).
    FOR r IN SELECT * FROM (VALUES
        ('sfp', 'totalAssetsMinor', 'Total assets', 'TOTAL', 'DEBIT_NORMAL', 'line:sfp:total:currentAssetsMinor,line:sfp:total:nonCurrentAssetsMinor'),
        ('sfp', 'profitOrLossMinor', 'Profit or loss for the period (not yet transferred to equity accounts)', 'DETAIL', 'CREDIT_NORMAL', ''),
        ('sfp', 'totalEquityMinor', 'Total equity', 'TOTAL', 'CREDIT_NORMAL', 'line:sfp:total:equityAccountsMinor,line:sfp:total:profitOrLossMinor'),
        ('sfp', 'totalLiabilitiesMinor', 'Total liabilities', 'TOTAL', 'CREDIT_NORMAL', 'line:sfp:total:currentLiabilitiesMinor,line:sfp:total:nonCurrentLiabilitiesMinor'),
        ('sfp', 'totalEquityAndLiabilitiesMinor', 'Total equity and liabilities', 'TOTAL', 'CREDIT_NORMAL', 'line:sfp:total:totalEquityMinor,line:sfp:total:totalLiabilitiesMinor'),
        ('sfp', 'balanceDifferenceMinor', 'Balance check (assets less equity and liabilities)', 'DETAIL', 'DEBIT_NORMAL', ''),
        ('sci', 'profitBeforeTaxMinor', 'Profit before tax', 'DETAIL', 'CREDIT_NORMAL', ''),
        ('sci', 'profitOrLossMinor', 'Profit or loss for the period', 'DETAIL', 'CREDIT_NORMAL', '')) t(stmt, key, label, role, normal, children) LOOP
      SELECT string_agg(CASE p WHEN 'current' THEN 'CURRENT' ELSE 'COMPARATIVE_1' END || '=fact:' || p || ':total:' || r.key, ',' ORDER BY CASE p WHEN 'current' THEN 'CURRENT' ELSE 'COMPARATIVE_1' END) INTO v_bind FROM unnest(v_ps) p;
      INSERT INTO pg_temp.fs_struct_exp VALUES (CASE r.stmt WHEN 'sfp' THEN 'STATEMENT_OF_FINANCIAL_POSITION' ELSE 'STATEMENT_OF_PROFIT_OR_LOSS' END,
        CASE r.stmt WHEN 'sfp' THEN 'section:sfp-totals' ELSE 'section:sci' END, CASE r.stmt WHEN 'sfp' THEN 'Totals' ELSE 'Profit or loss' END,
        'line:' || r.stmt || ':total:' || r.key, r.label, r.role, r.normal, v_bind, r.children);
    END LOOP;
    -- Comprehensive-income subtotals cast the composed lines of their kind (DETAIL when the composition has none).
    FOR r IN SELECT * FROM (VALUES ('incomeMinor', 'Total income', 'CREDIT_NORMAL', 'income'), ('expensesExcludingTaxMinor', 'Total expenses (excluding tax)', 'DEBIT_NORMAL', 'expense'), ('taxExpenseMinor', 'Tax expense (total)', 'DEBIT_NORMAL', 'tax')) t(key, label, normal, kind) LOOP
      SELECT array_agg('line:sci:' || (e ->> 'lineId') ORDER BY 'line:sci:' || (e ->> 'lineId')) INTO v_children FROM jsonb_array_elements(v_comp -> 'lines') e
       WHERE e ->> 'statement' = 'SCI' AND CASE r.kind WHEN 'income' THEN (e ->> 'lineId') IN ('sci.revenue', 'sci.other_income', 'sci.share_of_associates')
                                                 WHEN 'tax' THEN (e ->> 'lineId') = 'sci.tax_expense'
                                                 ELSE (e ->> 'lineId') NOT IN ('sci.revenue', 'sci.other_income', 'sci.share_of_associates', 'sci.tax_expense') END;
      SELECT string_agg(CASE p WHEN 'current' THEN 'CURRENT' ELSE 'COMPARATIVE_1' END || '=fact:' || p || ':total:' || r.key, ',' ORDER BY CASE p WHEN 'current' THEN 'CURRENT' ELSE 'COMPARATIVE_1' END) INTO v_bind FROM unnest(v_ps) p;
      INSERT INTO pg_temp.fs_struct_exp VALUES ('STATEMENT_OF_PROFIT_OR_LOSS', 'section:sci', 'Profit or loss', 'line:sci:total:' || r.key, r.label,
        CASE WHEN v_children IS NULL THEN 'DETAIL' ELSE 'SUBTOTAL' END, r.normal, v_bind, coalesce(array_to_string(v_children, ','), ''));
    END LOOP;
    -- Total comprehensive income (5.5(i)) for the complete periods the notes status composed it for.
    IF v_tci IS NOT NULL THEN
      SELECT string_agg(CASE p WHEN 'current' THEN 'CURRENT' ELSE 'COMPARATIVE_1' END || '=fact:' || p || ':total:totalComprehensiveIncomeMinor', ',' ORDER BY CASE p WHEN 'current' THEN 'CURRENT' ELSE 'COMPARATIVE_1' END)
        INTO v_bind FROM unnest(v_ps) p WHERE v_tci ? p;
      IF v_bind IS NOT NULL THEN
        INSERT INTO pg_temp.fs_struct_exp VALUES ('STATEMENT_OF_PROFIT_OR_LOSS', 'section:sci', 'Profit or loss', 'line:sci:total:totalComprehensiveIncomeMinor', 'Total comprehensive income for the period', 'TOTAL', 'CREDIT_NORMAL', v_bind, 'line:sci:total:profitOrLossMinor');
      END IF;
    END IF;
  END IF;

  -- The statement of cash flows (direct method), from the ledger rows the server read.
  IF v_ev -> 'statements' ->> 'STATEMENT_OF_CASH_FLOWS' = 'composed' THEN
    v_nets := '{}';
    FOR r IN SELECT DISTINCT lower(c.activity) AS act FROM pg_temp.fs_ev_cf c ORDER BY 1 LOOP
      v_act := r.act;
      v_title := CASE v_act WHEN 'operating' THEN 'operating activities' WHEN 'investing' THEN 'investing activities' WHEN 'financing' THEN 'financing activities' ELSE v_act END;
      v_children := '{}';
      FOR x IN SELECT DISTINCT c.label FROM pg_temp.fs_ev_cf c WHERE lower(c.activity) = v_act ORDER BY 1 LOOP
        v_lineid := 'line:cf:' || v_act || ':' || public._fs_slug(x.label);
        SELECT string_agg(f.pid || '=fact:' || v_lineid || ':' || f.pid, ',' ORDER BY f.pid) INTO v_bind
          FROM (SELECT substring(g.fact_id FROM ':([^:]+)$') AS pid FROM pg_temp.fs_ev_fig g WHERE g.fact_id ~ ('^fact:' || replace(v_lineid, ':', '\:') || ':(CURRENT|COMPARATIVE_1)$')) f;
        INSERT INTO pg_temp.fs_struct_exp VALUES ('STATEMENT_OF_CASH_FLOWS', 'section:cf:' || v_act, 'Cash flows from ' || v_title, v_lineid, x.label, 'DETAIL', 'DEBIT_NORMAL', coalesce(v_bind, ''), '');
        v_children := v_children || v_lineid;
      END LOOP;
      v_lineid := 'line:cf:' || v_act || ':net';
      SELECT string_agg(f.pid || '=fact:' || v_lineid || ':' || f.pid, ',' ORDER BY f.pid) INTO v_bind
        FROM (SELECT substring(g.fact_id FROM ':([^:]+)$') AS pid FROM pg_temp.fs_ev_fig g WHERE g.fact_id ~ ('^fact:line:cf:' || v_act || ':net:(CURRENT|COMPARATIVE_1)$')) f;
      INSERT INTO pg_temp.fs_struct_exp VALUES ('STATEMENT_OF_CASH_FLOWS', 'section:cf:' || v_act, 'Cash flows from ' || v_title, v_lineid, 'Net cash from ' || v_title, 'SUBTOTAL', 'DEBIT_NORMAL', coalesce(v_bind, ''),
        array_to_string((SELECT array_agg(c ORDER BY c) FROM unnest(v_children) c), ','));
      v_nets := v_nets || v_lineid;
    END LOOP;
    SELECT string_agg(f.pid || '=fact:line:cf:net-increase:' || f.pid, ',' ORDER BY f.pid) INTO v_bind
      FROM (SELECT substring(g.fact_id FROM ':([^:]+)$') AS pid FROM pg_temp.fs_ev_fig g WHERE g.fact_id ~ '^fact:line:cf:net-increase:(CURRENT|COMPARATIVE_1)$') f;
    INSERT INTO pg_temp.fs_struct_exp VALUES ('STATEMENT_OF_CASH_FLOWS', 'section:cf:cash', 'Cash and cash equivalents', 'line:cf:net-increase', 'Net increase (decrease) in cash and cash equivalents', 'TOTAL', 'DEBIT_NORMAL', coalesce(v_bind, ''),
      array_to_string((SELECT array_agg(c ORDER BY c) FROM unnest(v_nets) c), ','));
    IF EXISTS (SELECT 1 FROM pg_temp.fs_ev_fig g WHERE g.fact_id LIKE 'fact:line:cf:opening:%') THEN
      SELECT string_agg(f.pid || '=fact:line:cf:opening:' || f.pid, ',' ORDER BY f.pid) INTO v_bind
        FROM (SELECT substring(g.fact_id FROM ':([^:]+)$') AS pid FROM pg_temp.fs_ev_fig g WHERE g.fact_id ~ '^fact:line:cf:opening:(CURRENT|COMPARATIVE_1)$') f;
      INSERT INTO pg_temp.fs_struct_exp VALUES ('STATEMENT_OF_CASH_FLOWS', 'section:cf:cash', 'Cash and cash equivalents', 'line:cf:opening', 'Cash and cash equivalents at the beginning of the period', 'DETAIL', 'DEBIT_NORMAL', coalesce(v_bind, ''), '');
      SELECT string_agg(f.pid || '=fact:line:cf:closing:' || f.pid, ',' ORDER BY f.pid) INTO v_bind
        FROM (SELECT substring(g.fact_id FROM ':([^:]+)$') AS pid FROM pg_temp.fs_ev_fig g WHERE g.fact_id ~ '^fact:line:cf:closing:(CURRENT|COMPARATIVE_1)$') f;
      INSERT INTO pg_temp.fs_struct_exp VALUES ('STATEMENT_OF_CASH_FLOWS', 'section:cf:cash', 'Cash and cash equivalents', 'line:cf:closing', 'Cash and cash equivalents at the end of the period', 'TOTAL', 'DEBIT_NORMAL', coalesce(v_bind, ''), 'line:cf:net-increase,line:cf:opening');
    END IF;
  END IF;

  -- The statement of changes in equity, from the equity-movement rows the server read.
  IF v_ev -> 'statements' ->> 'STATEMENT_OF_CHANGES_IN_EQUITY' = 'composed' THEN
    v_openings := '{}'; v_closings := '{}'; v_profits := '{}';
    FOR r IN SELECT DISTINCT e.component, public._fs_slug(e.component) AS cslug FROM pg_temp.fs_ev_eq e ORDER BY 1 LOOP
      v_lineid := 'line:eq:' || r.cslug || ':opening';
      SELECT string_agg(f.pid || '=fact:' || v_lineid || ':' || f.pid, ',' ORDER BY f.pid) INTO v_bind
        FROM (SELECT substring(g.fact_id FROM ':([^:]+)$') AS pid FROM pg_temp.fs_ev_fig g WHERE g.fact_id ~ ('^fact:line:eq:' || r.cslug || ':opening:(CURRENT|COMPARATIVE_1)$')) f;
      INSERT INTO pg_temp.fs_struct_exp VALUES ('STATEMENT_OF_CHANGES_IN_EQUITY', 'section:eq:' || r.cslug, r.component, v_lineid, 'Balance at the beginning of the period', 'DETAIL', 'CREDIT_NORMAL', coalesce(v_bind, ''), '');
      v_openings := v_openings || v_lineid;
      v_mv := ARRAY[v_lineid];
      FOR x IN SELECT DISTINCT e.mtype, e.description FROM pg_temp.fs_ev_eq e WHERE e.component = r.component AND e.mtype NOT IN ('OPENING_BALANCE', 'CLOSING_BALANCE') ORDER BY 1, 2 LOOP
        v_lineid := 'line:eq:' || r.cslug || ':' || lower(x.mtype) || ':' || public._fs_slug(x.description);
        v_label := CASE x.mtype WHEN 'PROFIT_OR_LOSS' THEN 'Result for the period' WHEN 'OTHER_COMPREHENSIVE_INCOME' THEN 'Other comprehensive income' WHEN 'ISSUE_OF_SHARES' THEN 'Issue of shares'
                                WHEN 'DIVIDENDS_OR_DISTRIBUTIONS' THEN 'Dividends or distributions' WHEN 'TRANSFER_BETWEEN_COMPONENTS' THEN 'Transfer between components'
                                WHEN 'PRIOR_PERIOD_ADJUSTMENT' THEN 'Prior-period adjustment' WHEN 'OTHER_MOVEMENT' THEN 'Other movement' ELSE 'undefined' END
                   || CASE WHEN x.description <> '' THEN ' — ' || x.description ELSE '' END;
        SELECT string_agg(f.pid || '=fact:' || v_lineid || ':' || f.pid, ',' ORDER BY f.pid) INTO v_bind
          FROM (SELECT substring(g.fact_id FROM ':([^:]+)$') AS pid FROM pg_temp.fs_ev_fig g WHERE g.fact_id ~ ('^fact:line:eq:' || r.cslug || ':' || lower(x.mtype) || ':' || public._fs_slug(x.description) || ':(CURRENT|COMPARATIVE_1)$')) f;
        INSERT INTO pg_temp.fs_struct_exp VALUES ('STATEMENT_OF_CHANGES_IN_EQUITY', 'section:eq:' || r.cslug, r.component, v_lineid, v_label, 'DETAIL', 'CREDIT_NORMAL', coalesce(v_bind, ''), '');
        v_mv := v_mv || v_lineid;
        IF x.mtype = 'PROFIT_OR_LOSS' THEN v_profits := v_profits || v_lineid; END IF;
      END LOOP;
      v_lineid := 'line:eq:' || r.cslug || ':closing';
      SELECT string_agg(f.pid || '=fact:' || v_lineid || ':' || f.pid, ',' ORDER BY f.pid) INTO v_bind
        FROM (SELECT substring(g.fact_id FROM ':([^:]+)$') AS pid FROM pg_temp.fs_ev_fig g WHERE g.fact_id ~ ('^fact:line:eq:' || r.cslug || ':closing:(CURRENT|COMPARATIVE_1)$')) f;
      INSERT INTO pg_temp.fs_struct_exp VALUES ('STATEMENT_OF_CHANGES_IN_EQUITY', 'section:eq:' || r.cslug, r.component, v_lineid, 'Balance at the end of the period', 'TOTAL', 'CREDIT_NORMAL', coalesce(v_bind, ''),
        array_to_string((SELECT array_agg(c ORDER BY c) FROM unnest(v_mv) c), ','));
      v_closings := v_closings || v_lineid;
    END LOOP;
    SELECT string_agg(f.pid || '=fact:line:eq:total-opening:' || f.pid, ',' ORDER BY f.pid) INTO v_bind
      FROM (SELECT substring(g.fact_id FROM ':([^:]+)$') AS pid FROM pg_temp.fs_ev_fig g WHERE g.fact_id ~ '^fact:line:eq:total-opening:(CURRENT|COMPARATIVE_1)$') f;
    INSERT INTO pg_temp.fs_struct_exp VALUES ('STATEMENT_OF_CHANGES_IN_EQUITY', 'section:eq:total', 'Total equity', 'line:eq:total-opening', 'Total equity at the beginning of the period', 'TOTAL', 'CREDIT_NORMAL', coalesce(v_bind, ''),
      array_to_string((SELECT array_agg(c ORDER BY c) FROM unnest(v_openings) c), ','));
    IF array_length(v_profits, 1) > 0 THEN
      SELECT string_agg(f.pid || '=fact:line:eq:total-profit:' || f.pid, ',' ORDER BY f.pid) INTO v_bind
        FROM (SELECT substring(g.fact_id FROM ':([^:]+)$') AS pid FROM pg_temp.fs_ev_fig g WHERE g.fact_id ~ '^fact:line:eq:total-profit:(CURRENT|COMPARATIVE_1)$') f;
      INSERT INTO pg_temp.fs_struct_exp VALUES ('STATEMENT_OF_CHANGES_IN_EQUITY', 'section:eq:total', 'Total equity', 'line:eq:total-profit', 'Result for the period recognised in equity', 'TOTAL', 'CREDIT_NORMAL', coalesce(v_bind, ''),
        array_to_string((SELECT array_agg(c ORDER BY c) FROM unnest(v_profits) c), ','));
    END IF;
    SELECT string_agg(f.pid || '=fact:line:eq:total-closing:' || f.pid, ',' ORDER BY f.pid) INTO v_bind
      FROM (SELECT substring(g.fact_id FROM ':([^:]+)$') AS pid FROM pg_temp.fs_ev_fig g WHERE g.fact_id ~ '^fact:line:eq:total-closing:(CURRENT|COMPARATIVE_1)$') f;
    INSERT INTO pg_temp.fs_struct_exp VALUES ('STATEMENT_OF_CHANGES_IN_EQUITY', 'section:eq:total', 'Total equity', 'line:eq:total-closing', 'Total equity at the end of the period', 'TOTAL', 'CREDIT_NORMAL', coalesce(v_bind, ''),
      array_to_string((SELECT array_agg(c ORDER BY c) FROM unnest(v_closings) c), ','));
  END IF;

  -- ── The document's skeleton, projected the same way ──
  INSERT INTO pg_temp.fs_struct_act
  SELECT s ->> 'type', sec ->> 'sectionId', sec ->> 'label', ln ->> 'lineId', ln ->> 'label', ln ->> 'role', ln ->> 'normalBalance',
         coalesce((SELECT string_agg((b ->> 'periodId') || '=' || (b ->> 'factId'), ',' ORDER BY b ->> 'periodId') FROM jsonb_array_elements(ln -> 'factBindings') b), ''),
         coalesce((SELECT string_agg(c, ',' ORDER BY c) FROM jsonb_array_elements_text(ln -> 'castingChildLineIds') c), ''),
         (ln ->> 'isContra')::boolean
    FROM jsonb_array_elements(p_doc -> 'statements') s
    CROSS JOIN LATERAL jsonb_array_elements(s -> 'sections') sec
    CROSS JOIN LATERAL jsonb_array_elements(sec -> 'lines') ln
   WHERE s ->> 'type' IN ('STATEMENT_OF_FINANCIAL_POSITION', 'STATEMENT_OF_PROFIT_OR_LOSS', 'STATEMENT_OF_CASH_FLOWS', 'STATEMENT_OF_CHANGES_IN_EQUITY');

  -- Statement identity: exactly the composed statements, each once, with its fixed id and title.
  SELECT array_agg(k ORDER BY k) INTO v_bad FROM (
    SELECT coalesce(e.stmt, a.stmt) || ':' || coalesce(a.statement_id, '?') || ':' || coalesce(a.title, '?') || ':' || coalesce(a.n::text, '0') AS k
      FROM pg_temp.fs_struct_stmt e
      FULL JOIN (SELECT s ->> 'type' AS stmt, min(s ->> 'statementId') AS statement_id, min(s ->> 'title') AS title, count(*) AS n FROM jsonb_array_elements(p_doc -> 'statements') s
                  WHERE s ->> 'type' IN ('STATEMENT_OF_FINANCIAL_POSITION', 'STATEMENT_OF_PROFIT_OR_LOSS', 'STATEMENT_OF_CASH_FLOWS', 'STATEMENT_OF_CHANGES_IN_EQUITY') GROUP BY 1) a ON a.stmt = e.stmt
     WHERE e.stmt IS NULL OR a.stmt IS NULL OR a.n <> 1 OR a.statement_id IS DISTINCT FROM e.statement_id OR a.title IS DISTINCT FROM e.title) q;
  IF v_bad IS NOT NULL THEN v_out := v_out || ('DOCUMENT_STATEMENT_MISMATCH:' || array_length(v_bad, 1) || ':' || v_bad[1]); END IF;

  -- A line id once in the whole document.
  SELECT array_agg(d.line_id ORDER BY d.line_id) INTO v_bad FROM (SELECT a.line_id FROM pg_temp.fs_struct_act a GROUP BY a.line_id HAVING count(*) > 1) d;
  IF v_bad IS NOT NULL THEN v_out := v_out || ('DOCUMENT_LINE_DUPLICATE:' || array_length(v_bad, 1) || ':' || v_bad[1]); END IF;

  -- Every expected line present exactly as composed; nothing else on the four statements.
  SELECT count(*), min(d.k) INTO v_n, v_first FROM (
    SELECT coalesce(e.line_id, a.line_id) || ':' ||
           CASE WHEN e.line_id IS NULL THEN 'unexpected' WHEN a.line_id IS NULL THEN 'missing'
                WHEN a.stmt IS DISTINCT FROM e.stmt THEN 'statement' WHEN a.section_id IS DISTINCT FROM e.section_id THEN 'section' WHEN a.section_label IS DISTINCT FROM e.section_label THEN 'sectionLabel'
                WHEN a.label IS DISTINCT FROM e.label THEN 'label' WHEN a.role IS DISTINCT FROM e.role THEN 'role' WHEN a.normal IS DISTINCT FROM e.normal THEN 'normalBalance'
                WHEN a.bindings IS DISTINCT FROM e.bindings THEN 'bindings' WHEN a.children IS DISTINCT FROM e.children THEN 'children' WHEN a.contra THEN 'isContra' ELSE 'ok' END AS k
      FROM pg_temp.fs_struct_exp e
      FULL JOIN (SELECT * FROM pg_temp.fs_struct_act ta WHERE NOT EXISTS (SELECT 1 FROM pg_temp.fs_struct_act tb WHERE tb.line_id = ta.line_id AND tb.ctid < ta.ctid)) a ON a.line_id = e.line_id) d
   WHERE d.k NOT LIKE '%:ok';
  IF v_n > 0 THEN v_out := v_out || ('DOCUMENT_STRUCTURE_MISMATCH:' || v_n || ':' || v_first); END IF;

  DELETE FROM pg_temp.fs_struct_exp WHERE true; DELETE FROM pg_temp.fs_struct_act WHERE true; DELETE FROM pg_temp.fs_struct_stmt WHERE true;
  RETURN v_out;
END;
$$;

-- ── 2. Publication blockers v7: the 20261124100000 text (with the 20261123100000 compiler splice) + the structure call ────────────────────────────────────────────
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
      -- [20261126100000] Document structure: the document's shape, every fact's own period, the provenance it names and the
      -- whole presentation skeleton of the four statements (statement identity, sections, line identities and labels, roles,
      -- normal balances, period bindings, casting children) must be exactly what the server composes from its own data.
      v_out := v_out || public._fs_document_structure_blockers(p_company_id, v_report.period_year, v_doc, v_report.evidence_batch_ids);
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
  -- [20261123100000] The independent server compilation (kept verbatim; the splice 20261123100000 made).
  v_txt := public.fs_server_compilation_blocker(p_company_id,p_report_id,p_version);
  IF v_txt IS NOT NULL THEN v_out := array_append(v_out,v_txt); END IF;
  RETURN v_out;
END;
$$;

-- ── Access ───────────────────────────────────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._fs_document_structure_blockers(UUID, INTEGER, JSONB, TEXT[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fs_publication_blockers(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;

DO $postcondition$
BEGIN
  IF to_regprocedure('public._fs_document_structure_blockers(uuid, integer, jsonb, text[])') IS NULL
     OR position('_fs_document_structure_blockers' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('DOCUMENT_FACT_NOT_COMPOSED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('fs_server_compilation_blocker' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('ACCOUNT_CAPACITY_EXCEEDED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('REVIEW_COMMENT_UNRESOLVED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR has_function_privilege('authenticated', 'public._fs_document_structure_blockers(uuid, integer, jsonb, text[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fs_publication_blockers(uuid, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: the document structure check is not in its reviewed state' USING ERRCODE = 'P0001';
  END IF;
END;
$postcondition$;
$cfoclose_fsi_stage_81ffd8ecdb4ad6ef$);
