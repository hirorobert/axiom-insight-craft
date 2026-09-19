-- POSTCONDITION — run read-only after the migrations are applied. Proves the
-- release landed DEFAULT DENIED and least-privilege. Raises on any deviation.
DO $$
DECLARE
  t TEXT;
  v_tables TEXT[] := ARRAY[
    'financial_evidence_batches', 'financial_statement_reports', 'financial_statement_evaluations',
    'financial_statement_reviewer_decisions', 'financial_statement_correction_groups', 'financial_statement_publications',
    'financial_statements_rollout_state', 'financial_statements_rollout_companies', 'financial_statements_rollout_audit'];
  f TEXT;
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN RAISE EXCEPTION 'POSTCONDITION: % is missing', t; END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN RAISE EXCEPTION 'POSTCONDITION: RLS is off on %', t; END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT') OR has_table_privilege('anon', 'public.' || t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || t, 'INSERT') OR has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION 'POSTCONDITION: % grants a client role more than read access', t;
    END IF;
  END LOOP;

  -- writers: SECURITY DEFINER, pinned search_path, authenticated only
  FOREACH f IN ARRAY ARRAY['fs_commit_revision', 'fs_save_report_version', 'fs_save_evaluation', 'fs_append_decision', 'fs_apply_correction_group', 'fs_set_publication_state', 'financial_statements_workspace_access'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = f AND p.prosecdef
         AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
         AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('public', p.oid, 'EXECUTE')) THEN
      RAISE EXCEPTION 'POSTCONDITION: function % is not SECURITY DEFINER / search_path-pinned / authenticated-only', f;
    END IF;
  END LOOP;

  -- operator controls: service_role only
  FOREACH f IN ARRAY ARRAY['fs_set_company_rollout', 'fs_set_kill_switch'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = f AND has_function_privilege('service_role', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
      RAISE EXCEPTION 'POSTCONDITION: operator function % is not service_role-only', f;
    END IF;
  END LOOP;

  -- DEFAULT DENIED: no company enabled, kill switch present and NOT engaged
  IF (SELECT count(*) FROM public.financial_statements_rollout_state) <> 1 THEN RAISE EXCEPTION 'POSTCONDITION: rollout state must have exactly one row'; END IF;
  IF (SELECT kill_switch FROM public.financial_statements_rollout_state) THEN RAISE EXCEPTION 'POSTCONDITION: kill switch is engaged at release time'; END IF;
  IF EXISTS (SELECT 1 FROM public.financial_statements_rollout_companies WHERE enabled) THEN RAISE EXCEPTION 'POSTCONDITION: a company is already enabled — the release must land default denied'; END IF;
  RAISE NOTICE 'POSTCONDITION OK: default denied, least privilege, append-only history.';
END $$;
