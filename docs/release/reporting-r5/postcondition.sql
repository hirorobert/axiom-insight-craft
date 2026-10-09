-- READ-ONLY HOSTED POSTCONDITION for the statement sign-off policy (docs/release/REPORTING_R5_SIGNOFF_POLICY.md, step 3).
-- Run AFTER the wrapper. Writes nothing; raises on the first violated expectation.
DO $$
BEGIN
  IF to_regclass('public.fs_signoff_policy_events') IS NULL OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.fs_signoff_policy_events'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_signoff_policy_events is missing or without row-level security';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_fsspe_append_only' AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'POSTCONDITION: the policy events are not append-only';
  END IF;
  IF has_table_privilege('anon', 'public.fs_signoff_policy_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.fs_signoff_policy_events', 'INSERT')
     OR has_table_privilege('authenticated', 'public.fs_signoff_policy_events', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.fs_signoff_policy_events', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_signoff_policy_events grants are wider than SELECT for members';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fs_set_signoff_policy(uuid,text,text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fs_set_signoff_policy(uuid,text,text,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_signoff_policy(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fs_signoff_policy(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: the policy functions are not exactly authenticated-only (the helper internal)';
  END IF;
  IF position('SIGNOFF_SEPARATE_APPROVERS_REQUIRED' IN pg_get_functiondef('public.fs_bind_publication()'::regprocedure)) = 0
     OR position('APPROVER_NOT_AUTHENTICATED' IN pg_get_functiondef('public.fs_bind_publication()'::regprocedure)) = 0
     OR position('BINDING_STALE' IN pg_get_functiondef('public.fs_bind_publication()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_bind_publication does not enforce the policy, or lost an earlier check';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fs_publication_bindings'
       AND column_name IN ('signoff_policy', 'signoff_policy_event_id', 'same_approver')) <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_publication_bindings lacks the policy columns';
  END IF;
  RAISE NOTICE 'POSTCONDITION OK.';
END;
$$;
-- The same sign-offs, unchanged (the new columns are NULL on every binding recorded before this release):
SELECT report_id, report_version, state, document_sha256, approver_user_id, approved_at, signoff_policy, same_approver FROM public.fs_publication_bindings
 WHERE company_id = '659daa94-116c-4803-99f8-157e0bdd4c62' ORDER BY approved_at;
