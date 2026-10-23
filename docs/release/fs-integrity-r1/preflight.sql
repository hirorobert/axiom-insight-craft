-- READ-ONLY HOSTED PREFLIGHT for the publication integrity gate (docs/release/fs-integrity-r1/RECORD.md). Run BEFORE
-- 20261123100000_fs_publication_integrity_gate.sql (through the project's reviewed, journalled apply route). Writes nothing;
-- raises on the first violated expectation.
DO $$
BEGIN
  IF position('ACCOUNT_CAPACITY_EXCEEDED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('REVIEW_COMMENT_UNRESOLVED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR to_regprocedure('public._fs_memo_get(text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: fs-capacity-r1 (20261115100000) and fs-memo-r1 (20261116100000) are not in force';
  END IF;
  IF position('financial_statement_reports'' || p_report_id' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: fs-controls-r1 (20261111100000, publication state v2 with the lineage lock) is not in force';
  END IF;
  IF to_regprocedure('public._final_publication_for(uuid, integer, text)') IS NULL
     OR to_regprocedure('public.issue_official_reporting_pack(uuid, integer, text, uuid)') IS NULL
     OR to_regprocedure('public._reporting_pack_seal_refusal(uuid, uuid)') IS NULL
     OR to_regprocedure('public.reporting_pack_sealed_object(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: the official Reporting Pack functions (20260925140000) are not in force';
  END IF;
  IF to_regprocedure('public._fs_final_superseded_by(text, integer)') IS NOT NULL
     OR position('DOCUMENT_FACT_NOT_COMPOSED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: the publication integrity gate is already applied, or partly applied';
  END IF;
  RAISE NOTICE 'PREFLIGHT OK: apply 20261123100000_fs_publication_integrity_gate.sql';
END;
$$;
-- The sign-offs and sealed packs this release must preserve (record them; compare after):
SELECT report_id, report_version, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings ORDER BY seq;
SELECT id, company_id, output_ref, content_sha256, consumed_at FROM public.reporting_pack_issuances WHERE consumed_at IS NOT NULL ORDER BY consumed_at;
-- The latest UNSIGNED IFRS for SMEs trial-balance versions (the candidates for a sign-off after the apply). This listing does
-- not evaluate readiness; after the apply each workspace re-reads its own readiness. An honest version (saved by the
-- workbench) carries only server figures and is unaffected; a version refused by the new document closure was hand-edited
-- and must be re-saved from the workbench before it can be signed.
SELECT r.company_id, r.report_id, r.report_version
  FROM public.financial_statement_reports r
 WHERE r.provenance_origin = 'TRIAL_BALANCE_DERIVED' AND r.report_document #>> '{framework,kind}' = 'IFRS_FOR_SMES'
   AND r.report_version = (SELECT max(x.report_version) FROM public.financial_statement_reports x WHERE x.report_id = r.report_id)
   AND NOT EXISTS (SELECT 1 FROM public.financial_statement_publications p WHERE p.report_id = r.report_id AND p.report_version = r.report_version AND p.state = 'FINAL')
 ORDER BY r.company_id, r.report_id;
