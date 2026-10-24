-- READ-ONLY HOSTED POSTCONDITION for the combined publication-integrity batch. Run AFTER 20261126100000_fs_document_structure.sql
-- (the last of 20261123100000 .. 20261126100000). Writes nothing; raises on the first violated expectation.
DO $$
DECLARE
  v_blockers text := pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure);
  v_state    text := pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure);
BEGIN
  -- 20261123100000 (PR #191): the compiler receipt, its blocker INSIDE the one blockers text, both triggers.
  IF to_regclass('public.fs_server_compilations') IS NULL
     OR to_regprocedure('public.fs_server_compilation_blocker(uuid, text, integer)') IS NULL
     OR position('fs_server_compilation_blocker' IN v_blockers) = 0
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.financial_statement_publications'::regclass AND tgname = 'trg_fsp_server_compilation' AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.reporting_pack_issuances'::regclass AND tgname = 'trg_rpi_server_compilation' AND tgenabled = 'O')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.fs_server_compilations'::regclass)
     OR has_table_privilege('authenticated', 'public.fs_server_compilations', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('service_role', 'public.fs_server_compilations', 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDITION: the independent server compilation (20261123100000) is not enforced, or its blocker was lost from fs_publication_blockers';
  END IF;
  -- 20261124100000: document closure, reviewer-only clearing / withdrawal, superseded FINAL.
  IF to_regprocedure('public._fs_final_superseded_by(text, integer)') IS NULL
     OR position('DOCUMENT_FACT_NOT_COMPOSED' IN v_blockers) = 0 OR position('NOTE_FACT_NOT_COMPOSED' IN v_blockers) = 0
     OR position('DOCUMENT_PERIOD_MISMATCH' IN v_blockers) = 0 OR position('ACCOUNT_CAPACITY_EXCEEDED' IN v_blockers) = 0
     OR position('REVIEW_COMMENT_UNRESOLVED' IN v_blockers) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_publication_blockers lacks the document closure (v6) on top of v5';
  END IF;
  IF position('ACCEPT_FINDING'', ''REJECT_FINDING'') AND NOT public.workspace_capability_allowed' IN pg_get_functiondef('public.fs_append_decision(text, text, uuid, jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_append_decision does not require review_close to clear a finding';
  END IF;
  IF position('withdrawing a recorded review needs the review_close capability' IN v_state) = 0
     OR position('financial_statement_reports:'' || p_report_id' IN v_state) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_set_publication_state lacks the review-withdrawal guard (v3) or the lineage lock (v2)';
  END IF;
  IF position('superseded_final_version' IN pg_get_functiondef('public.issue_official_reporting_pack(uuid, integer, text, uuid)'::regprocedure)) = 0
     OR position('superseded_final_version' IN pg_get_functiondef('public._reporting_pack_seal_refusal(uuid, uuid)'::regprocedure)) = 0
     OR position('''superseded''' IN pg_get_functiondef('public.reporting_pack_sealed_object(uuid)'::regprocedure)) = 0
     OR position('supersededByFinal' IN pg_get_functiondef('public.fs_list_saved_versions(uuid, integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: the superseded-FINAL refusal or its disclosure is missing';
  END IF;
  -- 20261125100000: the FINAL authority (scope lock first in the FINAL path; issue/seal read the relation; the pointer table).
  IF to_regclass('public.fs_report_authority') IS NULL OR to_regclass('public.fs_report_authority_events') IS NULL
     OR to_regprocedure('public._fs_scope_lock(uuid, integer)') IS NULL
     OR to_regprocedure('public.fs_replace_final_authority(uuid, text, integer, text, integer, text)') IS NULL
     OR to_regprocedure('public.fs_designate_final_authority(uuid, integer, text, integer, text)') IS NULL
     OR position('_fs_scope_lock' IN v_state) = 0 OR position('AUTHORITY_CONFLICT' IN v_state) = 0
     OR position('_fs_claim_final_authority' IN pg_get_functiondef('public.fs_bind_publication()'::regprocedure)) = 0
     OR position('authority_unresolved' IN pg_get_functiondef('public.issue_official_reporting_pack(uuid, integer, text, uuid)'::regprocedure)) = 0
     OR position('authority_unresolved' IN pg_get_functiondef('public._reporting_pack_seal_refusal(uuid, uuid)'::regprocedure)) = 0
     OR position('_fs_scope_lock' IN pg_get_functiondef('public.seal_reporting_pack_server(uuid, uuid, text)'::regprocedure)) = 0
     OR position('''authority''' IN pg_get_functiondef('public.reporting_pack_sealed_object(uuid)'::regprocedure)) = 0
     OR position('PRIOR_FINAL_AUTHORITY_UNRESOLVED' IN pg_get_functiondef('public.fs_prior_final_reconciliation(uuid, integer)'::regprocedure)) = 0
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.fs_report_readiness(uuid, text, integer)'::regprocedure) <> 'v' THEN
    RAISE EXCEPTION 'POSTCONDITION: the FINAL authority (20261125100000) is not in its reviewed state';
  END IF;
  -- 20261126100000: the structure check inside the blockers.
  IF to_regprocedure('public._fs_document_structure_blockers(uuid, integer, jsonb, text[])') IS NULL
     OR position('_fs_document_structure_blockers' IN v_blockers) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: the document structure check (20261126100000) is not in fs_publication_blockers';
  END IF;
  -- Privileges: internal functions callable by no API role; the public ones exactly as before.
  IF has_function_privilege('authenticated', 'public._fs_final_superseded_by(text, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fs_scope_lock(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._fs_scope_lock(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fs_document_structure_blockers(uuid, integer, jsonb, text[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fs_publication_blockers(uuid, text, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fs_server_compilation_blocker(uuid, text, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fs_server_compile_snapshot(uuid, text, integer)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._fs_server_compile_snapshot(uuid, text, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fs_record_server_compilation(uuid, uuid, text, integer, text, text, jsonb, jsonb, jsonb, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fs_record_server_compilation(uuid, uuid, text, integer, text, text, jsonb, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._reporting_pack_seal_refusal(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reporting_pack_sealed_object(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.reporting_pack_sealed_object(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_append_decision(text, text, uuid, jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_set_publication_state(text, integer, uuid, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_replace_final_authority(uuid, text, integer, text, integer, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_designate_final_authority(uuid, integer, text, integer, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fs_replace_final_authority(uuid, text, integer, text, integer, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_list_saved_versions(uuid, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.issue_official_reporting_pack(uuid, integer, text, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.issue_official_reporting_pack(uuid, integer, text, uuid)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.fs_report_authority', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated', 'public.fs_report_authority_events', 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDITION: a privilege is not as reviewed';
  END IF;
  RAISE NOTICE 'POSTCONDITION OK';
END;
$$;
-- Must be byte-identical to the preflight's listings:
SELECT report_id, report_version, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings ORDER BY seq;
SELECT id, company_id, output_ref, content_sha256, consumed_at FROM public.reporting_pack_issuances WHERE consumed_at IS NOT NULL ORDER BY consumed_at;
-- The backfill's record: one ESTABLISHED (backfill) per single-lineage scope with a pointer; one CONFLICT_DETECTED per multi-lineage
-- scope with NO pointer (to be designated by a partner). Must agree with the preflight's conflict listing.
SELECT e.company_id, e.period_year, e.kind, e.report_id, e.report_version, e.detail -> 'candidates' AS candidates,
       (SELECT a.report_id || ' v' || a.report_version FROM public.fs_report_authority a WHERE a.company_id = e.company_id AND a.period_year = e.period_year) AS pointer
  FROM public.fs_report_authority_events e
 WHERE (e.detail ->> 'backfill') = 'true'
 ORDER BY e.company_id, e.period_year, e.seq;
