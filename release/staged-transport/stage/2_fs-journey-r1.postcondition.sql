INSERT INTO cfoclose_release.staged_artifacts (batch, kind, body) VALUES ('fs-journey-r1', 'postcondition', $cfoclose_stage_2b0b28522203b58a$-- READ-ONLY HOSTED POSTCONDITION for the reviewed reporting journey (docs/release/fs-first-slice/RECORD.md §8). Run AFTER
-- the wrapper of 20261112100000_fs_review_workflow_and_rollforward.sql. Writes nothing; raises on the first violated expectation.
DO $$
DECLARE
  v_blockers text := pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure);
BEGIN
  IF to_regclass('public.fs_review_comments') IS NULL OR to_regclass('public.fs_review_comment_events') IS NULL
     OR to_regclass('public.fs_rollforward_carries') IS NULL OR to_regclass('public.fs_prior_final_acceptances') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION: a reviewer-workflow table is missing (the wrapper is not applied)';
  END IF;
  IF position('REVIEW_COMMENT_UNRESOLVED' IN v_blockers) = 0 OR position('PUBLICATION_PATH_UNSUPPORTED' IN v_blockers) = 0
     OR position('FRAMEWORK_EDITION_UNSUPPORTED' IN v_blockers) = 0 OR position('STATEMENT_FIGURE_MISMATCH' IN v_blockers) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_publication_blockers does not carry the reviewer workflow, or lost an earlier control';
  END IF;
  IF position('fs-prior-final-reconciliation/2' IN pg_get_functiondef('public.fs_prior_final_reconciliation(uuid, integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: the prior-FINAL reconciliation is not at contract 2';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fs_review_comment_open(uuid, text, integer, text, text, text, text, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fs_review_comment_open(uuid, text, integer, text, text, text, text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fs_review_comment_states(uuid, text, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fs_review_comment_event(uuid, uuid, text, text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fs_publication_blockers(uuid, text, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_rollforward_worklist(uuid, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_accept_prior_final_differences(uuid, integer, boolean, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: the function grants are not exactly authenticated-only (the helpers internal)';
  END IF;
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.fs_review_comments'::regclass) IS DISTINCT FROM true
     OR (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.fs_review_comment_events'::regclass) IS DISTINCT FROM true
     OR (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.fs_rollforward_carries'::regclass) IS DISTINCT FROM true
     OR (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.fs_prior_final_acceptances'::regclass) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTCONDITION: a reviewer-workflow table is not under row-level security';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_fsrc_append_only') OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_fsrfc_guard') THEN
    RAISE EXCEPTION 'POSTCONDITION: an append-only guard is missing';
  END IF;
  RAISE NOTICE 'POSTCONDITION OK.';
END;
$$;
-- The same sign-offs, unchanged (compare with the preflight's listing):
SELECT report_id, report_version, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings ORDER BY seq;
$cfoclose_stage_2b0b28522203b58a$);
