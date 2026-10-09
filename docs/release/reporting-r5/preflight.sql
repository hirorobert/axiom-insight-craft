-- READ-ONLY HOSTED PREFLIGHT for the statement sign-off policy (docs/release/REPORTING_R5_SIGNOFF_POLICY.md, step 1). Run
-- BEFORE the wrapper. Writes nothing; raises on the first violated expectation.
DO $$
BEGIN
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.fs_report_readiness(uuid,text,integer)'::regprocedure) <> 'v' THEN
    RAISE EXCEPTION 'PREFLIGHT: the readiness correction (20261023100000) is not in force';
  END IF;
  IF position('APPROVER_NOT_AUTHENTICATED' IN pg_get_functiondef('public.fs_bind_publication()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: the reporting release r1 (20261022100000) is not in force';
  END IF;
  IF to_regclass('public.fs_signoff_policy_events') IS NOT NULL
     OR position('SIGNOFF_SEPARATE_APPROVERS_REQUIRED' IN pg_get_functiondef('public.fs_bind_publication()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: the sign-off policy is already applied, or partly applied';
  END IF;
  RAISE NOTICE 'PREFLIGHT OK: apply the wrapper';
END;
$$;
-- The sign-offs this release must preserve (record them; compare after):
SELECT report_id, report_version, state, document_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings
 WHERE company_id = '659daa94-116c-4803-99f8-157e0bdd4c62' ORDER BY approved_at;
