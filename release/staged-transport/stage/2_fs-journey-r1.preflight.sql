INSERT INTO cfoclose_release.staged_artifacts (batch, kind, body) VALUES ('fs-journey-r1', 'preflight', $cfoclose_stage_cd96b89774b8b6da$-- READ-ONLY HOSTED PREFLIGHT for the reviewed reporting journey (docs/release/fs-first-slice/RECORD.md §8). Run BEFORE the
-- wrapper of 20261112100000_fs_review_workflow_and_rollforward.sql. Writes nothing; raises on the first violated expectation.
DO $$
BEGIN
  IF to_regprocedure('public.fs_prior_final_reconciliation(uuid, integer)') IS NULL
     OR to_regprocedure('public.fs_evidence_statements(uuid, integer)') IS NULL
     OR position('financial_statement_reports:'' || p_report_id' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: the publication controls (20261111100000, with the lineage lock) are not in force';
  END IF;
  IF to_regprocedure('public.fs_presentation_append_only()') IS NULL OR to_regprocedure('public.close_review_readable(uuid)') IS NULL
     OR to_regprocedure('public.fs_record_disclosure(uuid, integer, text, text, text, uuid)') IS NULL
     OR to_regprocedure('public.fs_decide_requirement(uuid, integer, text, text, text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: the notes authorities (20261019100000 and later) are not in force';
  END IF;
  IF to_regclass('public.fs_review_comments') IS NOT NULL OR to_regclass('public.fs_rollforward_carries') IS NOT NULL
     OR to_regclass('public.fs_prior_final_acceptances') IS NOT NULL
     OR position('REVIEW_COMMENT_UNRESOLVED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: the reviewer workflow is already applied, or partly applied';
  END IF;
  RAISE NOTICE 'PREFLIGHT OK: apply the wrapper';
END;
$$;
-- The sign-offs this release must preserve (record them; compare after):
SELECT report_id, report_version, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings ORDER BY seq;
$cfoclose_stage_cd96b89774b8b6da$);
