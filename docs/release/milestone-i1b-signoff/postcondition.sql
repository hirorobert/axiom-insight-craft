-- READ-ONLY HOSTED POSTCONDITION for the I1-B / I1-C / Close Review / reporting-input / sign-off milestone
-- (docs/release/MILESTONE_I1B_SIGNOFF_RELEASE.md, step 4). Run after the SEVENTH migration. Writes nothing; raises on
-- the first violated expectation, then prints the same counts as the preflight for the preservation comparison.
DO $$
DECLARE
  v_missing TEXT[];
  v_n BIGINT;
BEGIN
  -- 1. Every table of the release exists, with row-level security enabled.
  SELECT array_agg(x) INTO v_missing FROM unnest(ARRAY[
    'tb_source_objects', 'tb_two_period_registrations',
    'ai_consent_versions', 'ai_workspace_consents', 'ai_provider_settings', 'ai_workspace_budgets', 'ai_layout_assist_runs',
    'close_review_events', 'close_review_finding_runs', 'close_review_findings', 'close_review_requirements',
    'close_review_approval_policy_events', 'close_review_adjustments', 'close_review_adjustment_lines',
    'close_review_adjustment_bindings', 'fs_first_period_declarations']) x
   WHERE to_regclass('public.' || x) IS NULL
      OR NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.' || x));
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION: missing, or without row-level security: %', v_missing; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trial_balance_uploads' AND column_name = 'source_object_id') THEN
    RAISE EXCEPTION 'POSTCONDITION: trial_balance_uploads.source_object_id is missing';
  END IF;

  -- 2. The release functions exist; none (other than a trigger function) is executable by anon.
  SELECT array_agg(x) INTO v_missing FROM unnest(ARRAY[
    'register_two_period_uploads', 'close_review_comment', 'close_review_refresh_findings', 'close_review_finding_action',
    'close_review_finding_states', 'close_review_set_requirement', 'close_review_propose_adjustment', 'close_review_decide_adjustment',
    'close_review_revalidate_adjustment', 'close_review_adjustments_summary', 'fs_reporting_input', 'fs_declare_first_period',
    'fs_first_period_declared']) x
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = x);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION: missing functions: %', v_missing; END IF;
  SELECT array_agg(p.oid::regprocedure::text) INTO v_missing FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND (p.proname LIKE 'close_review%' OR p.proname LIKE '\_cr\_%' OR p.proname LIKE 'ai\_%'
          OR p.proname IN ('register_two_period_uploads', 'fs_reporting_input', 'fs_declare_first_period', 'fs_first_period_declared'))
     AND p.prorettype <> 'trigger'::regtype   -- trigger functions cannot be called directly
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION: executable by anon: %', v_missing; END IF;

  -- 3. Restricted services stay restricted: external AI disabled; nothing consented, nothing run.
  IF EXISTS (SELECT 1 FROM public.ai_provider_settings WHERE enabled) THEN RAISE EXCEPTION 'POSTCONDITION: the AI provider is enabled'; END IF;
  SELECT count(*) INTO v_n FROM public.ai_layout_assist_runs; IF v_n <> 0 THEN RAISE EXCEPTION 'POSTCONDITION: % layout-assist runs exist', v_n; END IF;

  -- 4. Counts for the preservation comparison with the preflight baseline (record every line; uploads and
  --    certifications may only have GROWN by what users did during the window; nothing of the baseline is gone).
  SELECT count(*) INTO v_n FROM public.trial_balance_uploads;                                                   RAISE NOTICE 'AFTER uploads=%', v_n;
  SELECT count(*) INTO v_n FROM public.trial_balance_uploads WHERE file_path IS NOT NULL AND file_path NOT LIKE 'workspaces/%'; RAISE NOTICE 'AFTER legacy_personal_path_uploads=%', v_n;
  SELECT count(*) INTO v_n FROM public.trial_balance_uploads WHERE file_path LIKE 'workspaces/%';               RAISE NOTICE 'AFTER workspace_path_uploads=%', v_n;
  SELECT count(*) INTO v_n FROM public.trial_balance_uploads WHERE source_object_id IS NOT NULL;                 RAISE NOTICE 'AFTER uploads_on_a_shared_source=% (0 until two-year intake is used)', v_n;
  SELECT count(*) INTO v_n FROM public.trial_balance_upload_operations WHERE state = 'completed' AND kind = 'discard'
     AND completed_at > now() - public.tbu_undo_window();                                                       RAISE NOTICE 'AFTER discards_inside_undo_window=%', v_n;
  SELECT count(*) INTO v_n FROM public.trial_balance_upload_operations WHERE state IN ('pending', 'purging', 'storage_cleanup_pending');
                                                                                                                 RAISE NOTICE 'AFTER operations_in_flight=%', v_n;
  SELECT count(*) INTO v_n FROM public.trial_balance_source_reservations;                                        RAISE NOTICE 'AFTER reservations=%', v_n;
  SELECT count(*) INTO v_n FROM public.tb_certifications;                                                        RAISE NOTICE 'AFTER tb_certifications=%', v_n;
  SELECT count(*) INTO v_n FROM storage.objects WHERE bucket_id = 'trial-balance-files';                         RAISE NOTICE 'AFTER trial_balance_storage_objects=%', v_n;
  SELECT count(*) INTO v_n FROM public.financial_statements_rollout_companies WHERE enabled;                      RAISE NOTICE 'AFTER fs_rollout_enabled_companies=% (must equal the baseline)', v_n;
  SELECT count(*) INTO v_n FROM public.financial_statements_rollout_state WHERE singleton AND kill_switch;        RAISE NOTICE 'AFTER fs_kill_switch_on=% (must equal the baseline)', v_n;

  RAISE NOTICE 'POSTCONDITION OK.';
END $$;
