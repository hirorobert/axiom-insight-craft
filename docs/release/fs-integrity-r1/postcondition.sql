-- READ-ONLY HOSTED POSTCONDITION for the publication integrity gate. Run AFTER 20261123100000_fs_publication_integrity_gate.sql.
-- Writes nothing; raises on the first violated expectation.
DO $$
BEGIN
  IF to_regprocedure('public._fs_final_superseded_by(text, integer)') IS NULL
     OR position('DOCUMENT_FACT_NOT_COMPOSED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('NOTE_FACT_NOT_COMPOSED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('DOCUMENT_PERIOD_MISMATCH' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('ACCOUNT_CAPACITY_EXCEEDED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('REVIEW_COMMENT_UNRESOLVED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_publication_blockers is not v6 (document closure) on top of v5';
  END IF;
  IF position('ACCEPT_FINDING'', ''REJECT_FINDING'') AND NOT public.workspace_capability_allowed' IN pg_get_functiondef('public.fs_append_decision(text, text, uuid, jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_append_decision does not require review_close to clear a finding';
  END IF;
  IF position('withdrawing a recorded review needs the review_close capability' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) = 0
     OR position('financial_statement_reports'' || p_report_id' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_set_publication_state is not v3 (review withdrawal guarded) on top of v2 (lineage lock)';
  END IF;
  IF position('superseded_final_version' IN pg_get_functiondef('public.issue_official_reporting_pack(uuid, integer, text, uuid)'::regprocedure)) = 0
     OR position('superseded_final_version' IN pg_get_functiondef('public._reporting_pack_seal_refusal(uuid, uuid)'::regprocedure)) = 0
     OR position('''superseded''' IN pg_get_functiondef('public.reporting_pack_sealed_object(uuid)'::regprocedure)) = 0
     OR position('supersededByFinal' IN pg_get_functiondef('public.fs_list_saved_versions(uuid, integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: the superseded-FINAL refusal or its disclosure is missing';
  END IF;
  IF has_function_privilege('authenticated', 'public._fs_final_superseded_by(text, integer)', 'EXECUTE')
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
    RAISE EXCEPTION 'POSTCONDITION: a privilege is not as reviewed';
  END IF;
  RAISE NOTICE 'POSTCONDITION OK';
END;
$$;
-- Must be byte-identical to the preflight's listings:
SELECT report_id, report_version, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings ORDER BY seq;
SELECT id, company_id, output_ref, content_sha256, consumed_at FROM public.reporting_pack_issuances WHERE consumed_at IS NOT NULL ORDER BY consumed_at;
