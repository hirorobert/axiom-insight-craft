-- READ-ONLY HOSTED POSTCONDITION for the publication controls (docs/release/fs-first-slice/RECORD.md §8). Run AFTER the
-- wrapper of 20261111100000_fs_publication_controls.sql. Writes nothing; raises on the first violated expectation.
DO $$
DECLARE
  v_bind text := pg_get_functiondef('public.fs_bind_publication()'::regprocedure);
  v_blockers text := pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure);
BEGIN
  IF to_regprocedure('public.fs_evidence_statements(uuid, integer)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_evidence_statements is missing (the wrapper is not applied)';
  END IF;
  IF (SELECT count(*) FROM public.fs_pack_requirements r WHERE r.pack_family = 'ifrs-for-smes') <> 59
     OR (SELECT count(*) FROM public.fs_pack_requirements r WHERE r.pack_family = 'ifrs-for-smes' AND r.pack_version = '1.2.0') <> 9
     OR (SELECT count(*) FROM public.fs_pack_requirements r WHERE r.pack_family = 'ifrs-for-smes' AND r.pack_version = '1.1.0') <> 50 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_pack_requirements is not pack 1.2.0 (50 rows at 1.1.0 and 9 at 1.2.0)';
  END IF;
  IF position('PUBLICATION_PATH_UNSUPPORTED' IN v_bind) = 0 OR position('BINDING_STALE' IN v_bind) = 0
     OR position('APPROVER_NOT_AUTHENTICATED' IN v_bind) = 0 OR position('SIGNOFF_SEPARATE_APPROVERS_REQUIRED' IN v_bind) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_bind_publication does not refuse unsupported paths, or lost an earlier check';
  END IF;
  IF position('PUBLICATION_PATH_UNSUPPORTED' IN v_blockers) = 0 OR position('FRAMEWORK_EDITION_MISMATCH' IN v_blockers) = 0
     OR position('EVIDENCE_NOT_BOUND' IN v_blockers) = 0 OR position('STATEMENT_OF_CHANGES_IN_EQUITY' IN v_blockers) = 0
     OR position('REPORTING_DEPENDENCIES_STALE' IN v_blockers) = 0 OR position('STATEMENT_FIGURE_MISMATCH' IN v_blockers) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_publication_blockers does not carry the publication controls, or lost an earlier check';
  END IF;
  IF position('fs-reporting-dependencies/3' IN pg_get_functiondef('public.fs_reporting_dependencies(uuid, integer)'::regprocedure)) = 0
     OR position('fs-notes-status/3' IN pg_get_functiondef('public.fs_notes_status(uuid, integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: the dependencies or notes status are not at contract 3';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fs_evidence_statements(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fs_evidence_statements(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fs_publication_blockers(uuid, text, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fs_ev_pick(uuid, integer, text, text, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: the function grants are not exactly authenticated-only (the helpers internal)';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.fs_evidence_statements(uuid, integer)'::regprocedure) <> 'v'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.fs_evidence_statements(uuid, integer)'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_evidence_statements is not VOLATILE SECURITY DEFINER';
  END IF;
  RAISE NOTICE 'POSTCONDITION OK.';
END;
$$;
-- The same sign-offs, unchanged (compare with the preflight's listing):
SELECT report_id, report_version, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings ORDER BY seq;
