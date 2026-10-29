-- CFOClose ipsas-grants-r1 staged transport: apply 20261208100000_ipsas_grants.sql. GENERATED; do not edit.
-- Exact staged bytes are checked before execution; existing schedules, disclosures, sign-offs, authority, issuances and runtime settings must be unchanged. One atomic statement.
DO $cfoclose_ipsas_grants_transport_ipsas_2_grants$
DECLARE
  c_batch CONSTANT text := 'ipsas-2-grants';
  c_prior CONSTANT text := NULL;
  c_prior_kinds CONSTANT integer := 0;
  c_predecessor CONSTANT text[] := ARRAY['9571610f3cbb5f840506a19a17cc07dbfd94a2617ecf002ddd1c04012f1cf792', '6a15bb84f38856deda766dc426a2dc5f9b79a1a1784187fdfaa44eb05ab5143f']::text[];
  v_n bigint; v_pred_id bigint; v_baseline text; v_role text; v_source text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_ipsas_grants_release_transport', 0));
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'IPSAS_GRANTS_TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*), max(j.id) INTO v_n, v_pred_id FROM drizzle.__drizzle_migrations j WHERE j.hash = ANY (c_predecessor);
  IF v_n <> 1 OR v_pred_id <> 94
     OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations j WHERE j.id > v_pred_id
                AND j.xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'IPSAS_GRANTS_TRANSPORT_WRONG_PREDECESSOR: journal is not exactly the approved predecessor; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF to_regnamespace('cfoclose_ipsas_grants_release') IS NULL THEN
    RAISE EXCEPTION 'IPSAS_GRANTS_TRANSPORT_NOT_INSTALLED: the transport bootstrap is absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['public.companies', 'public.tb_certifications', 'public.fiscal_periods', 'public.trial_balance_uploads', 'public.ipsas_prep_revisions', 'public.ipsas_confirmations']::text[]) t WHERE to_regclass(t) IS NULL)
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['public._ipsas_immutable()', 'public._ipsas_minor(text)', 'public._ipsas_nat(text)', 'public._ipsas_enough(text,integer)', 'public._ipsas_arr(jsonb)', 'public._ipsas_refusal(uuid,uuid,text)', 'public._cr_certified_accounts(uuid)', 'public._cr_member(uuid,uuid)', 'public.ipsas_prep_context(uuid,integer)']::text[]) f WHERE to_regprocedure(f) IS NULL) THEN
    RAISE EXCEPTION 'IPSAS_GRANTS_TRANSPORT_PREREQUISITE_MISSING: the IPSAS preparation, certification or capability objects this source depends on are absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF c_prior IS NOT NULL AND (SELECT count(*) FROM cfoclose_ipsas_grants_release.staged_artifacts WHERE batch = c_prior AND consumed_at IS NOT NULL) <> c_prior_kinds THEN
    RAISE EXCEPTION 'IPSAS_GRANTS_TRANSPORT_PRIOR_NOT_APPLIED: % must be applied before %; nothing was changed', c_prior, c_batch USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM cfoclose_ipsas_grants_release.staged_artifacts WHERE batch = c_batch FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cfoclose_ipsas_grants_release.staged_artifacts WHERE batch = c_batch AND consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'IPSAS_GRANTS_TRANSPORT_ALREADY_APPLIED: % was already applied; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM cfoclose_ipsas_grants_release.staged_artifacts WHERE batch = c_batch) <> 1 THEN
    RAISE EXCEPTION 'IPSAS_GRANTS_TRANSPORT_UNCERTAIN_STAGE: % does not have exactly 1 staged artifacts; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.ipsas_grant_revisions') IS NOT NULL AND to_regclass('public.ipsas_grant_confirmations') IS NOT NULL AND to_regprocedure('public.ipsas_grants_context(uuid,integer)') IS NOT NULL AND to_regprocedure('public.ipsas_save_grants(uuid,integer,jsonb,uuid,uuid)') IS NOT NULL AND to_regprocedure('public.ipsas_confirm_grant(uuid,integer,text,uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'IPSAS_GRANTS_TRANSPORT_UNCERTAIN_STATE: % appears installed without a consumed transport record', '20261208100000_ipsas_grants.sql' USING ERRCODE = '55000';
  END IF;
  SELECT s.body INTO v_source FROM cfoclose_ipsas_grants_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'source' AND s.consumed_at IS NULL
     AND s.body_bytes = 30002 AND s.body_sha256 = 'd1ddcb3bbe26f0953806f7fff369c0ffc3e8350b47fcecbf0efb37e150fbd5fd'
     AND octet_length(convert_to(s.body, 'UTF8')) = 30002
     AND encode(sha256(convert_to(s.body, 'UTF8')), 'hex') = 'd1ddcb3bbe26f0953806f7fff369c0ffc3e8350b47fcecbf0efb37e150fbd5fd';
  IF v_source IS NULL THEN RAISE EXCEPTION 'IPSAS_GRANTS_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % source is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE public.ai_assistant_settings, public.commercial_platform_state, public.companies, public.financial_statements_rollout_audit, public.financial_statements_rollout_companies, public.financial_statements_rollout_state, public.fs_disclosure_texts, public.fs_equipment_answers, public.fs_equipment_policy_insertions, public.fs_equipment_workpapers, public.fs_publication_bindings, public.fs_report_authority, public.fs_report_authority_events, public.fs_schedule_definitions, public.fs_schedule_submissions, public.internal_beta_policy, public.ipsas_confirmations, public.ipsas_prep_revisions, public.reporting_pack_issuances IN SHARE MODE;
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
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.ipsas_confirmations t), '[]'::jsonb)
  )::text, 'UTF8')), 'hex'));
  PERFORM set_config('cfoclose_ipsas_grants_release.applying', c_batch, true);
  EXECUTE v_source;
  IF NOT (to_regclass('public.ipsas_grant_revisions') IS NOT NULL AND to_regclass('public.ipsas_grant_confirmations') IS NOT NULL AND to_regprocedure('public.ipsas_grants_context(uuid,integer)') IS NOT NULL AND to_regprocedure('public.ipsas_save_grants(uuid,integer,jsonb,uuid,uuid)') IS NOT NULL AND to_regprocedure('public.ipsas_confirm_grant(uuid,integer,text,uuid,uuid)') IS NOT NULL) THEN
    RAISE EXCEPTION 'IPSAS_GRANTS_TRANSPORT_POSTCONDITION: % did not install its target', '20261208100000_ipsas_grants.sql' USING ERRCODE = '55000';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN CONTINUE; END IF;
    IF NOT (SELECT bool_and(c.relrowsecurity) FROM pg_class c WHERE c.oid IN ('public.ipsas_grant_revisions'::regclass, 'public.ipsas_grant_confirmations'::regclass))
       OR has_table_privilege(v_role, 'public.ipsas_grant_revisions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege(v_role, 'public.ipsas_grant_confirmations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '\_ipsas\_%' AND has_function_privilege(v_role, p.oid, 'EXECUTE'))
       OR (v_role = 'authenticated') IS DISTINCT FROM (has_function_privilege(v_role, 'public.ipsas_grants_context(uuid,integer)', 'EXECUTE')
             AND has_function_privilege(v_role, 'public.ipsas_save_grants(uuid,integer,jsonb,uuid,uuid)', 'EXECUTE')
             AND has_function_privilege(v_role, 'public.ipsas_confirm_grant(uuid,integer,text,uuid,uuid)', 'EXECUTE'))
       OR (v_role <> 'authenticated' AND (has_function_privilege(v_role, 'public.ipsas_grants_context(uuid,integer)', 'EXECUTE')
             OR has_function_privilege(v_role, 'public.ipsas_save_grants(uuid,integer,jsonb,uuid,uuid)', 'EXECUTE')
             OR has_function_privilege(v_role, 'public.ipsas_confirm_grant(uuid,integer,text,uuid,uuid)', 'EXECUTE'))) THEN
      RAISE EXCEPTION 'IPSAS_GRANTS_TRANSPORT_PRIVILEGE_POSTCONDITION: % has an unexpected privilege on the installed objects; rolled back', v_role USING ERRCODE = '55000';
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
    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.ipsas_confirmations t), '[]'::jsonb)
  )::text, 'UTF8')), 'hex')) IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'IPSAS_GRANTS_TRANSPORT_BASELINE_CHANGED: a preserved financial record or runtime setting changed; rolled back' USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_ipsas_grants_release.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO cfoclose_ipsas_grants_release.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id, 'source', '20261208100000_ipsas_grants.sql', 'baseline_sha256', v_baseline,
      'source_sha256', 'd1ddcb3bbe26f0953806f7fff369c0ffc3e8350b47fcecbf0efb37e150fbd5fd'));
  PERFORM set_config('cfoclose_ipsas_grants_release.applying', '', true);
END
$cfoclose_ipsas_grants_transport_ipsas_2_grants$;