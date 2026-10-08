-- READ-ONLY HOSTED POSTCONDITION for the reporting release (docs/release/REPORTING_R1_RELEASE.md, step 4). Run after the
-- FIFTH wrapper. Writes nothing; raises on the first violated expectation, then prints the counts for the comparison with
-- the preflight baseline.
DO $$
DECLARE
  v_missing TEXT[];
  v_n BIGINT;
BEGIN
  -- 1. Every table of the release exists, with row-level security enabled; history tables are append-only.
  SELECT array_agg(x) INTO v_missing FROM unnest(ARRAY[
    'fs_presentation_lines', 'fs_presentation_assignments', 'fs_framework_elections',
    'fs_pack_requirements', 'fs_schedule_definitions', 'fs_requirement_decisions', 'fs_disclosure_texts', 'fs_schedule_submissions',
    'fs_comparative_bridges', 'fs_comparative_restatements', 'fs_comparative_restatement_decisions', 'fs_comparative_approvals',
    'fs_publication_bindings']) x
   WHERE to_regclass('public.' || x) IS NULL OR NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.' || x));
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION: missing, or without row-level security: %', v_missing; END IF;
  SELECT array_agg(t) INTO v_missing FROM unnest(ARRAY['trg_fspa_append_only', 'trg_fsrd_append_only', 'trg_fsdt_append_only', 'trg_fsss_append_only',
    'trg_fscb_append_only', 'trg_fscr_append_only', 'trg_fscrd_append_only', 'trg_fsca_append_only', 'trg_fspb_append_only', 'trg_fsp_bind']) t
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t AND NOT tgisinternal AND tgenabled <> 'D');
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION: missing or disabled triggers: %', v_missing; END IF;

  -- 2. The closure: the approver columns and their constraint; the comprehensive-income evaluation; the approver check.
  SELECT array_agg(c) INTO v_missing FROM unnest(ARRAY['approver_user_id', 'approver_firm_member_id', 'approver_role', 'approver_display_name', 'approved_at']) c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fs_publication_bindings' AND column_name = c);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION: fs_publication_bindings lacks %', v_missing; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_fspb_approver') THEN RAISE EXCEPTION 'POSTCONDITION: chk_fspb_approver is missing'; END IF;
  IF position('_fs_comprehensive_income' IN pg_get_functiondef('public.fs_notes_status(uuid, integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_notes_status does not evaluate comprehensive income (20261022100000 not in force)';
  END IF;
  IF position('APPROVER_NOT_AUTHENTICATED' IN pg_get_functiondef('public.fs_bind_publication()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_bind_publication does not record the authenticated approver (20261022100000 not in force)';
  END IF;

  -- 3. Nothing is executable by anon; the internal helper is not executable by authenticated.
  SELECT array_agg(p.oid::regprocedure::text) INTO v_missing FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND (p.proname LIKE 'fs\_%' OR p.proname LIKE '\_fs\_%') AND p.prorettype <> 'trigger'::regtype
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION: executable by anon: %', v_missing; END IF;
  IF has_function_privilege('authenticated', 'public._fs_comprehensive_income(uuid, integer, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: _fs_comprehensive_income is executable by authenticated';
  END IF;

  -- 4. The pack requirements are loaded.
  SELECT count(*) INTO v_n FROM public.fs_pack_requirements WHERE pack_family = 'ifrs-for-smes';
  IF v_n = 0 THEN RAISE EXCEPTION 'POSTCONDITION: no IFRS for SMEs requirements are loaded'; END IF;
  RAISE NOTICE 'AFTER pack_requirements=%', v_n;

  -- 5. Counts for the comparison with the preflight baseline (nothing of the baseline is gone; the rollout unchanged).
  SELECT count(*) INTO v_n FROM public.financial_statement_reports;      RAISE NOTICE 'AFTER fs_reports=%', v_n;
  SELECT count(*) INTO v_n FROM public.financial_statement_publications; RAISE NOTICE 'AFTER fs_publications=%', v_n;
  SELECT count(*) INTO v_n FROM public.financial_evidence_batches;       RAISE NOTICE 'AFTER fs_evidence_batches=%', v_n;
  SELECT count(*) INTO v_n FROM public.tb_certifications;                RAISE NOTICE 'AFTER tb_certifications=%', v_n;
  SELECT count(*) INTO v_n FROM public.financial_statements_rollout_companies; RAISE NOTICE 'AFTER rollout_companies=% (unchanged by the release)', v_n;
  SELECT count(*) INTO v_n FROM public.fs_publication_bindings;          RAISE NOTICE 'AFTER fs_publication_bindings=%', v_n;
  RAISE NOTICE 'POSTCONDITION OK.';
END;
$$;
