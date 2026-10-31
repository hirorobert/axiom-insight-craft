-- CFOClose source-access-r1 staged transport: apply 20261211100000_source_access_authority_repairs.sql. GENERATED; do not edit.
-- Exact staged bytes are checked before execution; existing schedules, disclosures, sign-offs, grants, memberships, authority, issuances and runtime settings must be unchanged. One atomic statement.
DO $cfoclose_source_access_transport_source_access_1$
DECLARE
  c_batch CONSTANT text := 'source-access-1';
  c_prior CONSTANT text := NULL;
  c_prior_kinds CONSTANT integer := 0;
  c_predecessor CONSTANT text[] := ARRAY['9d95500fbcf35c6dc7c1c15238afc06e81ec847816b7ede703e3f40c54f6e415', 'f5c3ad23b687834910c65276e6631544a21c2ed19cd57c3965ff003cadd9e1f6']::text[];
  v_n bigint; v_pred_id bigint; v_baseline text; v_role text; v_search_path text; v_source text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_source_access_release_transport', 0));
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*), max(j.id) INTO v_n, v_pred_id FROM drizzle.__drizzle_migrations j WHERE j.hash = ANY (c_predecessor);
  IF v_n <> 1 OR v_pred_id <> 98
     OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations j WHERE j.id > v_pred_id
                AND j.xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_WRONG_PREDECESSOR: journal is not exactly the approved predecessor; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF to_regnamespace('cfoclose_source_access_release') IS NULL THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_NOT_INSTALLED: the transport bootstrap is absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['public.workspace_capability_grants', 'public.workspace_capability_grant_events', 'public.firm_members', 'public.companies', 'public.trial_balance_uploads']::text[]) t WHERE to_regclass(t) IS NULL)
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['public.tbu_append_only_guard()', 'public.workspace_authority_basis(uuid,uuid,text)', 'public._plan_write_lock(uuid)']::text[]) f WHERE to_regprocedure(f) IS NULL) THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_PREREQUISITE_MISSING: the workspace grant tables, the authority predicate, the plan lock and the append-only guard this source depends on are absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF c_prior IS NOT NULL AND (SELECT count(*) FROM cfoclose_source_access_release.staged_artifacts WHERE batch = c_prior AND consumed_at IS NOT NULL) <> c_prior_kinds THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_PRIOR_NOT_APPLIED: % must be applied before %; nothing was changed', c_prior, c_batch USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM cfoclose_source_access_release.staged_artifacts WHERE batch = c_batch FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cfoclose_source_access_release.staged_artifacts WHERE batch = c_batch AND consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_ALREADY_APPLIED: % was already applied; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM cfoclose_source_access_release.staged_artifacts WHERE batch = c_batch) <> 1 THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_UNCERTAIN_STAGE: % does not have exactly 1 staged artifacts; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.trial_balance_source_download_events') IS NOT NULL OR to_regprocedure('public.decide_trial_balance_source_download_issuance(uuid,uuid,uuid,timestamptz,timestamptz,integer,timestamptz,integer,text)') IS NOT NULL OR to_regprocedure('public.record_trial_balance_source_download_denial(uuid,uuid,uuid,text)') IS NOT NULL OR to_regprocedure('public.firm_members_revoke_workspace_grants()') IS NOT NULL OR to_regprocedure('public.trial_balance_source_download_events_no_truncate()') IS NOT NULL THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_UNCERTAIN_STATE: % has objects present without a consumed transport record', '20261211100000_source_access_authority_repairs.sql' USING ERRCODE = '55000';
  END IF;
  SELECT s.body INTO v_source FROM cfoclose_source_access_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'source' AND s.consumed_at IS NULL
     AND s.body_bytes = 25437 AND s.body_sha256 = 'be582111440335aefc7da9c4cd7454f94e260f79b0e9098233d5e36c1736b344'
     AND octet_length(convert_to(s.body, 'UTF8')) = 25437
     AND encode(sha256(convert_to(s.body, 'UTF8')), 'hex') = 'be582111440335aefc7da9c4cd7454f94e260f79b0e9098233d5e36c1736b344';
  IF v_source IS NULL THEN RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % source is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE public.ai_assistant_settings, public.commercial_platform_state, public.companies, public.financial_statements_rollout_audit, public.financial_statements_rollout_companies, public.financial_statements_rollout_state, public.firm_members, public.fs_disclosure_texts, public.fs_equipment_answers, public.fs_equipment_policy_insertions, public.fs_equipment_workpapers, public.fs_publication_bindings, public.fs_report_authority, public.fs_report_authority_events, public.fs_schedule_definitions, public.fs_schedule_submissions, public.internal_beta_policy, public.ipsas_confirmations, public.ipsas_grant_confirmations, public.ipsas_grant_revisions, public.ipsas_prep_revisions, public.ipsas_presentation_revisions, public.reporting_pack_issuances, public.workspace_capability_grant_events, public.workspace_capability_grants IN SHARE MODE;
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
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.firm_members t), '[]'::jsonb)
  )::text, 'UTF8')), 'hex'));
  PERFORM set_config('cfoclose_source_access_release.applying', c_batch, true);
  -- The source binds unqualified names through the executing session's search_path and itself contains a session-level SET search_path.
  -- Pin the path for the source, then restore the ORIGINAL path at SESSION level so the source's SET cannot outlive this transaction.
  v_search_path := current_setting('search_path');
  PERFORM set_config('search_path', 'pg_catalog, public', true);
  EXECUTE v_source;
  PERFORM set_config('search_path', v_search_path, false);
  IF NOT (to_regclass('public.trial_balance_source_download_events') IS NOT NULL AND to_regprocedure('public.decide_trial_balance_source_download_issuance(uuid,uuid,uuid,timestamptz,timestamptz,integer,timestamptz,integer,text)') IS NOT NULL AND to_regprocedure('public.record_trial_balance_source_download_denial(uuid,uuid,uuid,text)') IS NOT NULL AND to_regprocedure('public.firm_members_revoke_workspace_grants()') IS NOT NULL AND to_regprocedure('public.trial_balance_source_download_events_no_truncate()') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.firm_members'::regclass AND tgname = 'trg_firm_members_revoke_workspace_grants' AND NOT tgisinternal)) THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_POSTCONDITION: % did not install its target', '20261211100000_source_access_authority_repairs.sql' USING ERRCODE = '55000';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN CONTINUE; END IF;
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.trial_balance_source_download_events'::regclass)
       OR has_table_privilege(v_role, 'public.trial_balance_source_download_events', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR (v_role = 'anon' AND has_table_privilege(v_role, 'public.trial_balance_source_download_events', 'SELECT'))
       OR (v_role <> 'anon' AND NOT has_table_privilege(v_role, 'public.trial_balance_source_download_events', 'SELECT'))
       OR (v_role = 'service_role') IS DISTINCT FROM (has_function_privilege(v_role, 'public.decide_trial_balance_source_download_issuance(uuid,uuid,uuid,timestamptz,timestamptz,integer,timestamptz,integer,text)', 'EXECUTE')
             AND has_function_privilege(v_role, 'public.record_trial_balance_source_download_denial(uuid,uuid,uuid,text)', 'EXECUTE'))
       OR (v_role <> 'service_role' AND (has_function_privilege(v_role, 'public.decide_trial_balance_source_download_issuance(uuid,uuid,uuid,timestamptz,timestamptz,integer,timestamptz,integer,text)', 'EXECUTE')
             OR has_function_privilege(v_role, 'public.record_trial_balance_source_download_denial(uuid,uuid,uuid,text)', 'EXECUTE')))
       OR has_function_privilege(v_role, 'public.firm_members_revoke_workspace_grants()', 'EXECUTE')
       OR has_function_privilege(v_role, 'public.trial_balance_source_download_events_no_truncate()', 'EXECUTE') THEN
      RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_PRIVILEGE_POSTCONDITION: % has an unexpected privilege on the installed objects; rolled back', v_role USING ERRCODE = '55000';
    END IF;
  END LOOP;
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
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.firm_members t), '[]'::jsonb)
  )::text, 'UTF8')), 'hex')) IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_BASELINE_CHANGED: a preserved financial record, grant, membership or runtime setting changed; rolled back' USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_source_access_release.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO cfoclose_source_access_release.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id, 'source', '20261211100000_source_access_authority_repairs.sql', 'baseline_sha256', v_baseline,
      'source_sha256', 'be582111440335aefc7da9c4cd7454f94e260f79b0e9098233d5e36c1736b344'));
  PERFORM set_config('cfoclose_source_access_release.applying', '', true);
END
$cfoclose_source_access_transport_source_access_1$;