INSERT INTO cfoclose_fsi_release.staged_artifacts(batch, kind, body) VALUES ('fsi-1-server-compilation', 'preflight', $cfoclose_fsi_stage_70f69d9e87508010$-- READ-ONLY HOSTED PREFLIGHT for the combined publication-integrity batch (docs/release/fs-integrity-r1/RECORD.md):
--   20261123100000_fs_server_compilation.sql        (PR #191: independent server compilation, receipt, approval/issuance guards)
--   20261124100000_fs_publication_integrity_gate.sql (PR #192: document closure; reviewer-only clearing/withdrawal; superseded FINAL)
--   20261125100000_fs_final_authority.sql           (PR #192: one current FINAL per company and period; explicit replacement)
--   20261126100000_fs_document_structure.sql        (PR #192: the whole presentation skeleton compared with the server)
-- Run BEFORE the first of them, through the project's reviewed, journalled apply route. Writes nothing; raises on the first
-- violated expectation. Each migration repeats its own preflight and refuses a double or out-of-order apply.
DO $$
BEGIN
  IF position('ACCOUNT_CAPACITY_EXCEEDED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('REVIEW_COMMENT_UNRESOLVED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR to_regprocedure('public._fs_memo_get(text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: fs-capacity-r1 (20261115100000) and fs-memo-r1 (20261116100000) are not in force';
  END IF;
  IF position('financial_statement_reports:'' || p_report_id' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: fs-controls-r1 (20261111100000, publication state v2 with the lineage lock) is not in force';
  END IF;
  IF to_regprocedure('public._final_publication_for(uuid, integer, text)') IS NULL
     OR to_regprocedure('public.issue_official_reporting_pack(uuid, integer, text, uuid)') IS NULL
     OR to_regprocedure('public._reporting_pack_seal_refusal(uuid, uuid)') IS NULL
     OR to_regprocedure('public.reporting_pack_sealed_object(uuid)') IS NULL
     OR to_regprocedure('public.tb_official_output_lock(uuid, integer)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: the official Reporting Pack functions (20260925140000, 20260927100000) are not in force';
  END IF;
  IF to_regprocedure('public.fs_evidence_statements(uuid, integer)') IS NULL OR to_regprocedure('public._fs_slug(text)') IS NULL
     OR to_regprocedure('public.fs_work_bounds()') IS NULL OR to_regprocedure('public._tb_signoff_rules_blocker(uuid, text, integer)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: the composition / evidence-statement / work-bound functions this batch reads are not in force';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.fs_report_readiness(uuid, text, integer)'::regprocedure) <> 'v' THEN
    RAISE EXCEPTION 'PREFLIGHT: fs_report_readiness is not VOLATILE (20261023100000, D-2, is not in force)';
  END IF;
  IF to_regclass('public.fs_server_compilations') IS NOT NULL
     OR position('fs_server_compilation_blocker' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) > 0
     OR to_regprocedure('public._fs_final_superseded_by(text, integer)') IS NOT NULL
     OR position('DOCUMENT_FACT_NOT_COMPOSED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) > 0
     OR to_regclass('public.fs_report_authority') IS NOT NULL
     OR to_regprocedure('public._fs_document_structure_blockers(uuid, integer, jsonb, text[])') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: part of the batch is already applied; apply only the missing migrations, in order, each through its own preflight';
  END IF;
  RAISE NOTICE 'PREFLIGHT OK: apply 20261123100000, 20261124100000, 20261125100000, 20261126100000 in that order';
END;
$$;
-- The sign-offs and sealed packs this release must preserve (record them; compare after):
SELECT report_id, report_version, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings ORDER BY seq;
SELECT id, company_id, output_ref, content_sha256, consumed_at FROM public.reporting_pack_issuances WHERE consumed_at IS NOT NULL ORDER BY consumed_at;
-- FINAL authority (20261125100000): what the backfill WILL record. A scope (company, period) whose FINAL versions are all in ONE
-- lineage gets a pointer to that lineage's latest FINAL version (ESTABLISHED, backfill). A scope with FINALs in MORE THAN ONE
-- lineage is recorded as CONFLICT_DETECTED and left UNRESOLVED: every further FINAL, official issuance and the next period's
-- comparative selection refuse by name until a holder of approve_certification designates one of the listed versions
-- (fs_designate_final_authority, from the Sign-off page). Review this listing with the owner BEFORE applying; nothing is
-- chosen by order or timestamp. Expected on the hosted project today: no rows (reporting rollout is off).
SELECT r.company_id, r.period_year, count(DISTINCT p.report_id) AS final_lineages, array_agg(DISTINCT p.report_id ORDER BY p.report_id) AS lineages
  FROM public.financial_statement_publications p
  JOIN public.financial_statement_reports r ON r.report_id = p.report_id AND r.report_version = p.report_version AND r.company_id = p.company_id
 WHERE p.state = 'FINAL'
 GROUP BY r.company_id, r.period_year
HAVING count(DISTINCT p.report_id) > 1;
-- The latest UNSIGNED IFRS for SMEs trial-balance versions (the candidates for a sign-off after the apply). This listing does
-- not evaluate readiness; after the apply each workspace re-reads its own readiness. An honest version (saved by the
-- workbench) carries only server figures and is unaffected by the document gates; EVERY unsigned version additionally needs
-- the server compilation receipt (20261123100000: SERVER_COMPILATION_REQUIRED until compile-financial-report is deployed and
-- the version is re-saved or checked). A version refused by a DOCUMENT_* code was hand-edited and must be re-saved from the
-- workbench before it can be signed.
SELECT r.company_id, r.report_id, r.report_version
  FROM public.financial_statement_reports r
 WHERE r.provenance_origin = 'TRIAL_BALANCE_DERIVED' AND r.report_document #>> '{framework,kind}' = 'IFRS_FOR_SMES'
   AND r.report_version = (SELECT max(x.report_version) FROM public.financial_statement_reports x WHERE x.report_id = r.report_id)
   AND NOT EXISTS (SELECT 1 FROM public.financial_statement_publications p WHERE p.report_id = r.report_id AND p.report_version = r.report_version AND p.state = 'FINAL')
 ORDER BY r.company_id, r.report_id;
$cfoclose_fsi_stage_70f69d9e87508010$);
