-- READ-ONLY HOSTED POSTCONDITION for the account capacity (docs/release/fs-first-slice/RECORD.md §8). Run AFTER the wrapper
-- of 20261115100000_fs_account_capacity.sql. Writes nothing; raises on the first violated expectation.
DO $$
DECLARE
  v_b jsonb := public.fs_work_bounds();
  v_blockers text := pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure);
BEGIN
  IF (v_b ->> 'contract') IS DISTINCT FROM 'fs-work-bounds/2' OR (v_b ->> 'accountsReadPerComposition')::int <> 1000
     OR (v_b ->> 'evidenceRowsPerBatch')::int <> 1000 OR (v_b ->> 'evidenceDocumentBytesPerBatch')::bigint <> 1048576 OR (v_b ->> 'evidenceRowsPerVersion')::int <> 3000
     OR (v_b ->> 'reportDocumentBytes')::bigint <> 8388608 OR (v_b ->> 'versionsPerLineage')::int <> 1000 OR (v_b ->> 'commentsPerVersion')::int <> 500 OR (v_b ->> 'eventsPerComment')::int <> 200 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_work_bounds() does not answer the reviewed bounds at contract 2';
  END IF;
  IF to_regprocedure('public.fs_account_capacity(uuid, integer)') IS NULL
     OR has_function_privilege('anon', 'public.fs_account_capacity(uuid, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_account_capacity(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_account_capacity is missing or wrongly granted';
  END IF;
  IF position('over_capacity' IN pg_get_functiondef('public.fs_statement_composition(uuid, integer)'::regprocedure)) = 0
     OR position('ACCOUNT_CAPACITY_EXCEEDED' IN pg_get_functiondef('public.fs_commit_revision(uuid, text, integer, text, integer, text, jsonb, text, jsonb, text[], jsonb)'::regprocedure)) = 0
     OR position('ACCOUNT_CAPACITY_EXCEEDED' IN v_blockers) = 0
     OR position('over_capacity' IN pg_get_functiondef('public.fs_approve_comparatives(uuid, integer, boolean, text, uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: a guarded function does not carry the capacity refusal';
  END IF;
  -- The accepted controls are still in the guarded functions (they were redefined from their latest texts).
  IF position('REVIEW_COMMENT_UNRESOLVED' IN v_blockers) = 0 OR position('PUBLICATION_PATH_UNSUPPORTED' IN v_blockers) = 0
     OR position('FRAMEWORK_EDITION_UNSUPPORTED' IN v_blockers) = 0 OR position('STATEMENT_FIGURE_MISMATCH' IN v_blockers) = 0
     OR position('REPLAY_CONFLICT' IN pg_get_functiondef('public.fs_commit_revision(uuid, text, integer, text, integer, text, jsonb, text, jsonb, text[], jsonb)'::regprocedure)) = 0
     OR position('edition_unresolved' IN pg_get_functiondef('public.fs_statement_composition(uuid, integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: an accepted control lost its definition';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fs_statement_composition(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fs_publication_blockers(uuid, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: the function grants changed';
  END IF;
  RAISE NOTICE 'POSTCONDITION OK.';
END;
$$;
-- The same sign-offs, unchanged (compare with the preflight's listing):
SELECT report_id, report_version, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings ORDER BY seq;
