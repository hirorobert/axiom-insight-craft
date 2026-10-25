-- HOSTED POSTCONDITION 1 of release batch track-a-r1: after 20261127100000_fs_track_a_authority_hardening.sql and BEFORE
-- the frontend is published (the staged apply of batch 1 executes it inside its own transaction, so a failure rolls the
-- migration back). Writes nothing; raises on the first violated expectation.
DO $$
DECLARE
  v_closed text[] := ARRAY['financial_evidence_batches', 'financial_statement_audit_events', 'financial_statement_correction_groups',
    'financial_statement_documents', 'financial_statement_evaluations', 'financial_statement_framework_requirements',
    'financial_statement_publications', 'financial_statement_reports', 'financial_statement_reviewer_decisions',
    'financial_statements_rollout_audit', 'fs_signoff_policy_events', 'tb_certification_findings', 'tb_certification_invalidations',
    'tb_certifications', 'tb_reprocess_requests', 'fs_report_authority', 'fs_report_authority_events', 'fs_authority_replacement_intents',
    'company_framework_events'];
  v_history text[] := ARRAY['fs_report_authority', 'fs_report_authority_events', 'fs_authority_replacement_intents', 'company_framework_events'];
  v_role text;
  v_t text;
  v_bad bigint;
  v_def text;
BEGIN
  -- Objects.
  IF to_regclass('public.fs_authority_replacement_intents') IS NULL OR to_regclass('public.company_framework_events') IS NULL
     OR to_regprocedure('public.set_company_reporting_framework(uuid, text, text, text, uuid)') IS NULL
     OR to_regprocedure('public._fs_replacement_intent(uuid, text, integer)') IS NULL
     OR to_regprocedure('public.fs_refuse_truncate()') IS NULL
     OR to_regprocedure('public.fs_report_authority_guard()') IS NULL
     OR to_regprocedure('public.fs_report_authority_event_consistency()') IS NULL
     OR to_regprocedure('public._fs_authority_scope_check(uuid, integer)') IS NULL
     OR to_regprocedure('public._fs_company_decision_lock()') IS NULL THEN
    RAISE EXCEPTION 'TRA_POSTCONDITION: 20261127100000 objects are missing';
  END IF;
  -- The replacement is read from the owner-only intent, never from a caller-settable setting.
  FOREACH v_def IN ARRAY ARRAY[pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure),
                               pg_get_functiondef('public.fs_bind_publication()'::regprocedure),
                               pg_get_functiondef('public.fs_replace_final_authority(uuid, text, integer, text, integer, text)'::regprocedure)] LOOP
    IF position('cfoclose.fs_replace_authority' IN v_def) > 0 THEN
      RAISE EXCEPTION 'TRA_POSTCONDITION: fs_set_publication_state / fs_bind_publication / fs_replace_final_authority still read or write the replacement setting';
    END IF;
  END LOOP;
  IF position('_fs_replacement_intent' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) = 0
     OR position('_fs_replacement_intent' IN pg_get_functiondef('public.fs_bind_publication()'::regprocedure)) = 0
     OR position('fs_authority_replacement_intents' IN pg_get_functiondef('public.fs_replace_final_authority(uuid, text, integer, text, integer, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'TRA_POSTCONDITION: the replacement intent is not read where it must be';
  END IF;
  IF position('fr_company:' IN pg_get_functiondef('public._fs_scope_lock(uuid, integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'TRA_POSTCONDITION: _fs_scope_lock does not take the company framework lock';
  END IF;
  -- Triggers present and enabled.
  SELECT count(*) INTO v_bad FROM unnest(ARRAY['trg_fsra_guard', 'trg_fsra_event_consistency', 'trg_fsrae_event_consistency', 'trg_fsari_append_only',
      'trg_cfe_append_only', 'trg_tbc_company_decision_lock', 'trg_fsr_company_decision_lock']) t
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = t AND g.tgenabled = 'O' AND NOT g.tgisinternal);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'TRA_POSTCONDITION: % authority / history / decision-lock trigger(s) missing or disabled', v_bad;
  END IF;
  -- The two consistency checks are row-level, deferrable, initially deferred constraint triggers (they run at commit).
  SELECT count(*) INTO v_bad FROM unnest(ARRAY['trg_fsra_event_consistency', 'trg_fsrae_event_consistency']) t
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = t AND g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred AND (g.tgtype & 1) <> 0);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'TRA_POSTCONDITION: % authority consistency trigger(s) are not deferred row-level constraint triggers', v_bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.company_framework_events'::regclass AND a.attname = 'txid' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'TRA_POSTCONDITION: company_framework_events has no txid';
  END IF;
  FOREACH v_t IN ARRAY v_closed LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = ('public.' || v_t)::regclass AND NOT g.tgisinternal AND g.tgenabled = 'O'
                    AND (g.tgtype & 32) <> 0) THEN
      RAISE EXCEPTION 'TRA_POSTCONDITION: % has no enabled TRUNCATE refusal', v_t;
    END IF;
  END LOOP;
  -- Privileges: no API role truncates history, writes the authority or its history, or reaches the internal helpers.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN CONTINUE; END IF;
    FOREACH v_t IN ARRAY v_closed LOOP
      IF has_table_privilege(v_role, 'public.' || v_t, 'TRUNCATE') THEN
        RAISE EXCEPTION 'TRA_POSTCONDITION: % may TRUNCATE %', v_role, v_t;
      END IF;
    END LOOP;
    FOREACH v_t IN ARRAY v_history LOOP
      IF has_table_privilege(v_role, 'public.' || v_t, 'INSERT') OR has_table_privilege(v_role, 'public.' || v_t, 'UPDATE')
         OR has_table_privilege(v_role, 'public.' || v_t, 'DELETE') THEN
        RAISE EXCEPTION 'TRA_POSTCONDITION: % may write %', v_role, v_t;
      END IF;
    END LOOP;
    IF has_function_privilege(v_role, 'public._fs_replacement_intent(uuid, text, integer)', 'EXECUTE')
       OR has_function_privilege(v_role, 'public._fs_scope_lock(uuid, integer)', 'EXECUTE')
       OR has_function_privilege(v_role, 'public.fs_report_authority_event_consistency()', 'EXECUTE')
       OR has_function_privilege(v_role, 'public.fs_refuse_truncate()', 'EXECUTE')
       OR has_function_privilege(v_role, 'public._fs_authority_scope_check(uuid, integer)', 'EXECUTE') THEN
      RAISE EXCEPTION 'TRA_POSTCONDITION: % may execute an internal authority helper', v_role;
    END IF;
    IF v_role <> 'authenticated' AND (
         has_function_privilege(v_role, 'public.set_company_reporting_framework(uuid, text, text, text, uuid)', 'EXECUTE')
      OR has_function_privilege(v_role, 'public.fs_set_publication_state(text, integer, uuid, text, text)', 'EXECUTE')
      OR has_function_privilege(v_role, 'public.fs_replace_final_authority(uuid, text, integer, text, integer, text)', 'EXECUTE')
      OR has_function_privilege(v_role, 'public.fs_designate_final_authority(uuid, integer, text, integer, text)', 'EXECUTE')) THEN
      RAISE EXCEPTION 'TRA_POSTCONDITION: % may execute a member-only decision function', v_role;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', 'public.set_company_reporting_framework(uuid, text, text, text, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_set_publication_state(text, integer, uuid, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_replace_final_authority(uuid, text, integer, text, integer, text)', 'EXECUTE')
     OR NOT has_table_privilege('authenticated', 'public.company_framework_events', 'SELECT') THEN
    RAISE EXCEPTION 'TRA_POSTCONDITION: members lost a path this batch keeps';
  END IF;
  -- Data invariant the batch now enforces holds for every existing scope.
  -- Every scope (with a pointer or any authority event) passes the check the batch now enforces at commit.
  PERFORM public._fs_authority_scope_check(s.company_id, s.period_year)
     FROM (SELECT company_id, period_year FROM public.fs_report_authority UNION SELECT company_id, period_year FROM public.fs_report_authority_events) s;
  -- The direct-write guard is the SECOND migration: it must not be in force before the frontend is published.
  IF to_regprocedure('public.guard_company_reporting_framework()') IS NOT NULL THEN
    RAISE EXCEPTION 'TRA_POSTCONDITION: 20261128100000 is already in force; it is applied only after the frontend is published';
  END IF;
  RAISE NOTICE 'TRA_POSTCONDITION 1 OK';
END;
$$;
