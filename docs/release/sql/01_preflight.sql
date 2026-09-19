-- PREFLIGHT — run read-only against the TARGET database BEFORE applying
-- 20260919100000 and 20260919110000. Aborts (raises) on the first violated
-- expectation. Changes nothing.
DO $$
DECLARE
  v_missing TEXT[];
BEGIN
  -- 1. the objects the new migrations depend on must already exist
  SELECT array_agg(x) INTO v_missing FROM unnest(ARRAY['companies', 'firm_members']) x
   WHERE to_regclass('public.' || x) IS NULL;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT: missing prerequisite tables: %', v_missing; END IF;

  IF to_regprocedure('public.get_member_company_ids()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.get_member_company_ids() is missing';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_member_company_ids()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PREFLIGHT: authenticated cannot execute get_member_company_ids(); the read policies would deny every member';
  END IF;

  -- 2. the roles the grants name must exist
  SELECT array_agg(r) INTO v_missing FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT: missing roles: %', v_missing; END IF;

  -- 3. nothing from this release may already exist (a partial earlier apply must be investigated, not layered over)
  SELECT array_agg(x) INTO v_missing FROM unnest(ARRAY[
    'financial_evidence_batches', 'financial_statement_reports', 'financial_statement_evaluations',
    'financial_statement_reviewer_decisions', 'financial_statement_correction_groups', 'financial_statement_publications',
    'financial_statements_rollout_state', 'financial_statements_rollout_companies', 'financial_statements_rollout_audit']) x
   WHERE to_regclass('public.' || x) IS NOT NULL;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT: objects already exist (investigate a partial apply): %', v_missing; END IF;

  RAISE NOTICE 'PREFLIGHT OK. Confirm out of band which project this is: the production window must be explicitly approved.';
END $$;
