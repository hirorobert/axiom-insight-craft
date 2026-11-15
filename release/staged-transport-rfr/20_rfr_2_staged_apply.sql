-- CFOClose Ready-for-Reporting staged transport: apply 20261224100000_contra_account_designation.sql. GENERATED; do not edit.
-- Exact staged bytes are checked before execution; existing mappings, decisions, reports, publications, declarations, the pilot allow-list,
-- the compiler receipts and identity, earlier records, grants, memberships and runtime settings must be unchanged. One atomic statement.
DO $cfoclose_rfr_transport_rfr_2$
DECLARE
  c_batch CONSTANT text := 'rfr-2';
  c_prior CONSTANT text := 'rfr-1';
  c_prior_kinds CONSTANT integer := 1;
  c_predecessor CONSTANT text[] := ARRAY['a2a4cca5bc06a333aa9265d9ad2f24efc36952c6165c8273600c8577a22d82b7', 'e891d1fff155899f665d16f1e610050faa75510d4d6d1cd2f3028c604cde9a70']::text[];
  v_n bigint; v_pred_id bigint; v_baseline text; v_compiler text; v_role text; v_search_path text; v_source text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_rfr_release_transport', 0));
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*), max(j.id) INTO v_n, v_pred_id FROM drizzle.__drizzle_migrations j WHERE j.hash = ANY (c_predecessor);
  IF v_n <> 1 OR v_pred_id <> 108
     OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations j WHERE j.id > v_pred_id
                AND j.xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_WRONG_PREDECESSOR: journal is not exactly the approved predecessor; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF to_regnamespace('cfoclose_rfr_release') IS NULL THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_NOT_INSTALLED: the transport bootstrap is absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['public.account_mappings', 'public.account_review_decisions']::text[]) t WHERE to_regclass(t) IS NULL)
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['public.resolve_account_review_batch(uuid, uuid, uuid, jsonb)', 'public.close_review_refresh_findings(uuid, integer)', 'public.account_mapping_content(public.financial_statement, public.account_classification, text, text, boolean, boolean, boolean)', 'public.account_mappings_provenance_guard()']::text[]) f WHERE to_regprocedure(f) IS NULL) THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_PREREQUISITE_MISSING: an object 20261224100000_contra_account_designation.sql builds on is absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF c_prior IS NOT NULL AND (SELECT count(*) FROM cfoclose_rfr_release.staged_artifacts WHERE batch = c_prior AND consumed_at IS NOT NULL) <> c_prior_kinds THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_PRIOR_NOT_APPLIED: % must be applied before %; nothing was changed', c_prior, c_batch USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM cfoclose_rfr_release.staged_artifacts WHERE batch = c_batch FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cfoclose_rfr_release.staged_artifacts WHERE batch = c_batch AND consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_ALREADY_APPLIED: % was already applied; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM cfoclose_rfr_release.staged_artifacts WHERE batch = c_batch) <> 1 THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_UNCERTAIN_STAGE: % does not have exactly 1 staged artifacts; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.account_mappings') AND attname = 'is_contra_account' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_UNCERTAIN_STATE: % has objects present without a consumed transport record', '20261224100000_contra_account_designation.sql' USING ERRCODE = '55000';
  END IF;
  SELECT s.body INTO v_source FROM cfoclose_rfr_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'source' AND s.consumed_at IS NULL
     AND s.body_bytes = 38243 AND s.body_sha256 = '4539d9eff542352f370f234819cf792170a832ba66ca9f6621468fb80ead35ff'
     AND octet_length(convert_to(s.body, 'UTF8')) = 38243
     AND encode(sha256(convert_to(s.body, 'UTF8')), 'hex') = '4539d9eff542352f370f234819cf792170a832ba66ca9f6621468fb80ead35ff';
  IF v_source IS NULL THEN RAISE EXCEPTION 'RFR_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % source is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE public.account_mappings, public.account_review_decisions, public.ai_assistant_settings, public.commercial_platform_state, public.companies, public.financial_statement_publications, public.financial_statement_reports, public.financial_statements_rollout_audit, public.financial_statements_rollout_companies, public.financial_statements_rollout_state, public.firm_members, public.fs_disclosure_texts, public.fs_equipment_answers, public.fs_equipment_policy_insertions, public.fs_equipment_workpapers, public.fs_first_period_declarations, public.fs_publication_bindings, public.fs_report_authority, public.fs_report_authority_events, public.fs_schedule_definitions, public.fs_schedule_submissions, public.fs_server_compilations, public.internal_beta_policy, public.ipsas_confirmations, public.ipsas_grant_confirmations, public.ipsas_grant_revisions, public.ipsas_prep_revisions, public.ipsas_presentation_revisions, public.reporting_pack_issuances, public.workspace_capability_grant_events, public.workspace_capability_grants IN SHARE MODE;
  v_baseline := (SELECT encode(sha256(convert_to(jsonb_build_array(
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.companies t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_publication_bindings t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.reporting_pack_issuances t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_report_authority t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_report_authority_events t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_schedule_definitions t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_schedule_submissions t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_disclosure_texts t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.financial_statements_rollout_state t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.financial_statements_rollout_companies t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.financial_statements_rollout_audit t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.ai_assistant_settings t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.internal_beta_policy t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.commercial_platform_state t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_equipment_workpapers t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_equipment_policy_insertions t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_equipment_answers t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.ipsas_prep_revisions t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.ipsas_confirmations t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.ipsas_grant_revisions t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.ipsas_grant_confirmations t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.ipsas_presentation_revisions t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.workspace_capability_grants t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.workspace_capability_grant_events t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.firm_members t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg((to_jsonb(t) - 'is_contra_account') ORDER BY (to_jsonb(t) - 'is_contra_account')::text) FROM public.account_mappings t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.account_review_decisions t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.financial_statement_reports t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.financial_statement_publications t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_first_period_declarations t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_server_compilations t), '[]'::jsonb)
  )::text, 'UTF8')), 'hex'));
  v_compiler := (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = to_regclass('public.fs_server_compilations') AND c.conname = 'fs_server_compilations_compiler_sha256_check') || ':' || md5(pg_get_functiondef(to_regprocedure('public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text)')));
  PERFORM set_config('cfoclose_rfr_release.applying', c_batch, true);
  -- The source binds unqualified names through the executing session's search_path and itself contains session-level SET search_path
  -- statements. Pin the path for the source, then restore the ORIGINAL path at SESSION level so the source's SET cannot outlive this transaction.
  v_search_path := current_setting('search_path');
  PERFORM set_config('search_path', 'pg_catalog, public', true);
  EXECUTE v_source;
  PERFORM set_config('search_path', v_search_path, false);
  IF NOT (EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.account_mappings') AND attname = 'is_contra_account' AND NOT attisdropped) AND position('is_contra_account' IN pg_get_functiondef(to_regprocedure('public.resolve_account_review_batch(uuid, uuid, uuid, jsonb)'))) > 0 AND position('is_contra_account' IN pg_get_functiondef(to_regprocedure('public.account_mappings_provenance_guard()'))) > 0 AND NOT has_column_privilege('authenticated', 'public.account_mappings', 'is_contra_account', 'INSERT') AND NOT has_column_privilege('authenticated', 'public.account_mappings', 'is_contra_account', 'UPDATE')) THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_POSTCONDITION: % did not install its target', '20261224100000_contra_account_designation.sql' USING ERRCODE = '55000';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN CONTINUE; END IF;
    IF has_function_privilege(v_role, 'public.fs_publication_blockers(uuid, text, integer)', 'EXECUTE') AND v_role <> 'service_role'


    THEN
      RAISE EXCEPTION 'RFR_TRANSPORT_PRIVILEGE_POSTCONDITION: % has an unexpected privilege on the installed objects; rolled back', v_role USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF ((SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = to_regclass('public.fs_server_compilations') AND c.conname = 'fs_server_compilations_compiler_sha256_check') || ':' || md5(pg_get_functiondef(to_regprocedure('public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text)')))) IS DISTINCT FROM v_compiler THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_COMPILER_IDENTITY_CHANGED: the compiler receipt pin or the receipt function changed; rolled back' USING ERRCODE = '55000';
  END IF;
  IF (SELECT encode(sha256(convert_to(jsonb_build_array(
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.companies t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_publication_bindings t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.reporting_pack_issuances t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_report_authority t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_report_authority_events t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_schedule_definitions t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_schedule_submissions t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_disclosure_texts t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.financial_statements_rollout_state t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.financial_statements_rollout_companies t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.financial_statements_rollout_audit t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.ai_assistant_settings t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.internal_beta_policy t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.commercial_platform_state t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_equipment_workpapers t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_equipment_policy_insertions t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_equipment_answers t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.ipsas_prep_revisions t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.ipsas_confirmations t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.ipsas_grant_revisions t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.ipsas_grant_confirmations t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.ipsas_presentation_revisions t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.workspace_capability_grants t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.workspace_capability_grant_events t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.firm_members t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg((to_jsonb(t) - 'is_contra_account') ORDER BY (to_jsonb(t) - 'is_contra_account')::text) FROM public.account_mappings t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.account_review_decisions t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.financial_statement_reports t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.financial_statement_publications t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_first_period_declarations t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.fs_server_compilations t), '[]'::jsonb)
  )::text, 'UTF8')), 'hex')) IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_BASELINE_CHANGED: a preserved financial record, mapping, decision, report, publication, declaration, allow-list row, receipt, grant, membership or runtime setting changed; rolled back' USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_rfr_release.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO cfoclose_rfr_release.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id, 'source', '20261224100000_contra_account_designation.sql', 'baseline_sha256', v_baseline,
      'source_sha256', '4539d9eff542352f370f234819cf792170a832ba66ca9f6621468fb80ead35ff'));
  PERFORM set_config('cfoclose_rfr_release.applying', '', true);
END
$cfoclose_rfr_transport_rfr_2$;