INSERT INTO cfoclose_release.staged_artifacts (batch, kind, body) VALUES ('fs-bounds-r1', 'postcondition', $cfoclose_stage_2f6e26999122c9cb$-- READ-ONLY HOSTED POSTCONDITION for the work bounds (docs/release/fs-first-slice/RECORD.md §8). Run AFTER the wrapper of
-- 20261114100000_fs_work_bounds.sql. Writes nothing; raises on the first violated expectation.
DO $$
DECLARE
  v_b jsonb := public.fs_work_bounds();
BEGIN
  IF (v_b ->> 'contract') IS DISTINCT FROM 'fs-work-bounds/1'
     OR (v_b ->> 'evidenceRowsPerBatch')::int <> 1000 OR (v_b ->> 'evidenceDocumentBytesPerBatch')::bigint <> 1048576
     OR (v_b ->> 'evidenceRowsPerVersion')::int <> 3000 OR (v_b ->> 'reportDocumentBytes')::bigint <> 8388608
     OR (v_b ->> 'versionsPerLineage')::int <> 1000 OR (v_b ->> 'commentsPerVersion')::int <> 500 OR (v_b ->> 'eventsPerComment')::int <> 200 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_work_bounds() does not answer the reviewed bounds';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_feb_work_bounds' AND tgrelid = 'public.financial_evidence_batches'::regclass AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_fsr_work_bounds' AND tgrelid = 'public.financial_statement_reports'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_fsrc_work_bounds' AND tgrelid = 'public.fs_review_comments'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_fsrce_work_bounds' AND tgrelid = 'public.fs_review_comment_events'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION: a work-bounds trigger is missing (the wrapper is not applied)';
  END IF;
  IF has_function_privilege('anon', 'public.fs_work_bounds()', 'EXECUTE') OR NOT has_function_privilege('authenticated', 'public.fs_work_bounds()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fs_bound_evidence_batch()', 'EXECUTE') OR has_function_privilege('authenticated', 'public.fs_bound_report_version()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fs_bound_review_comment()', 'EXECUTE') OR has_function_privilege('authenticated', 'public.fs_bound_review_comment_event()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: the function grants are not exactly authenticated-only for the bounds and internal for the triggers';
  END IF;
  -- The accepted functions are untouched: the reviewer workflow and the publication controls still carry their marks.
  IF position('REVIEW_COMMENT_UNRESOLVED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('financial_statement_reports:'' || p_report_id' IN pg_get_functiondef('public.fs_commit_revision(uuid, text, integer, text, integer, text, jsonb, text, jsonb, text[], jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: an accepted control lost its definition';
  END IF;
  RAISE NOTICE 'POSTCONDITION OK.';
END;
$$;
-- The same sign-offs, unchanged (compare with the preflight's listing):
SELECT report_id, report_version, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings ORDER BY seq;
$cfoclose_stage_2f6e26999122c9cb$);
