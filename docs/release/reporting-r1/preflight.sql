-- READ-ONLY HOSTED PREFLIGHT for the reporting release (docs/release/REPORTING_R1_RELEASE.md, step 2). Run against the
-- TARGET database BEFORE the first of the five wrappers. Writes nothing: it reads the catalogue and counts rows, then
-- raises on the first violated expectation. The counts it prints are the BASELINE for the postcondition; record them.
DO $$
DECLARE
  v_missing TEXT[];
  v_n BIGINT;
BEGIN
  -- 1. Nothing of this release may already exist (a partial earlier apply is investigated, never layered over).
  SELECT array_agg(x) INTO v_missing FROM unnest(ARRAY[
    'fs_presentation_lines', 'fs_presentation_assignments', 'fs_framework_elections',
    'fs_pack_requirements', 'fs_schedule_definitions', 'fs_requirement_decisions', 'fs_disclosure_texts', 'fs_schedule_submissions',
    'fs_comparative_bridges', 'fs_comparative_restatements', 'fs_comparative_restatement_decisions', 'fs_comparative_approvals',
    'fs_publication_bindings']) x
   WHERE to_regclass('public.' || x) IS NOT NULL;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT: objects of this release already exist (investigate a partial apply): %', v_missing; END IF;
  SELECT array_agg(x) INTO v_missing FROM unnest(ARRAY['fs_statement_composition', 'fs_notes_status', 'fs_comparatives_status', 'fs_reporting_dependencies',
    'fs_bind_publication', '_fs_comprehensive_income']) x
   WHERE EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = x);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT: functions of this release already exist (investigate a partial apply): %', v_missing; END IF;

  -- 2. Everything the five migrations build on must exist: main's chain through hosted entry 40 (mirror 0039).
  SELECT array_agg(x) INTO v_missing FROM unnest(ARRAY[
    'companies', 'firm_members', 'profiles', 'fiscal_periods', 'tb_certifications', 'account_mappings', 'financial_evidence_batches',
    'financial_statement_reports', 'financial_statement_evaluations', 'financial_statement_publications', 'financial_statement_framework_requirements',
    'financial_statements_rollout_state', 'financial_statements_rollout_companies', 'close_review_adjustments', 'close_review_adjustment_bindings',
    'fs_first_period_declarations']) x
   WHERE to_regclass('public.' || x) IS NULL;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT: missing prerequisite tables: %', v_missing; END IF;
  SELECT array_agg(x) INTO v_missing FROM unnest(ARRAY[
    'fs_reporting_input', 'fs_first_period_declared', 'fs_publication_blockers', 'fs_set_publication_state', 'fs_report_readiness', 'fs_commit_revision',
    'fs_actor_member_id', 'fs_rollout_allows', 'close_review_readable', 'workspace_capability_allowed', 'get_authoritative_certification', '_cr_member']) x
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = x);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT: missing prerequisite functions: %', v_missing; END IF;
  SELECT array_agg(r) INTO v_missing FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT: missing roles: %', v_missing; END IF;

  -- 3. The rollout fails closed (every reporting function also requires fs_rollout_allows).
  IF NOT EXISTS (SELECT 1 FROM public.financial_statements_rollout_state WHERE singleton) THEN
    RAISE EXCEPTION 'PREFLIGHT: financial_statements_rollout_state has no row';
  END IF;

  -- 4. Baseline (record every line).
  SELECT count(*) INTO v_n FROM public.financial_statement_reports;      RAISE NOTICE 'BASELINE fs_reports=%', v_n;
  SELECT count(*) INTO v_n FROM public.financial_statement_publications; RAISE NOTICE 'BASELINE fs_publications=%', v_n;
  SELECT count(*) INTO v_n FROM public.financial_evidence_batches;       RAISE NOTICE 'BASELINE fs_evidence_batches=%', v_n;
  SELECT count(*) INTO v_n FROM public.tb_certifications;                RAISE NOTICE 'BASELINE tb_certifications=%', v_n;
  SELECT count(*) INTO v_n FROM public.financial_statements_rollout_companies; RAISE NOTICE 'BASELINE rollout_companies=%', v_n;
  RAISE NOTICE 'PREFLIGHT OK.';
END;
$$;
