-- READ-ONLY HOSTED PREFLIGHT for the I1-B / I1-C / Close Review / reporting-input / sign-off milestone
-- (docs/release/MILESTONE_I1B_SIGNOFF_RELEASE.md, step 2). Run against the TARGET database BEFORE the first of the seven
-- migrations. Writes nothing: it reads the catalogue and counts rows, then raises on the first violated expectation.
-- The counts it prints are the BASELINE for the preservation checks of step 8 — record them.
DO $$
DECLARE
  v_missing TEXT[];
  v_n BIGINT;
BEGIN
  -- 1. Nothing of this release may already exist (a partial earlier apply is investigated, never layered over).
  SELECT array_agg(x) INTO v_missing FROM unnest(ARRAY[
    'tb_source_objects', 'tb_two_period_registrations',
    'ai_consent_versions', 'ai_workspace_consents', 'ai_provider_settings', 'ai_workspace_budgets', 'ai_layout_assist_runs',
    'close_review_events', 'close_review_finding_runs', 'close_review_findings', 'close_review_requirements',
    'close_review_approval_policy_events', 'close_review_adjustments', 'close_review_adjustment_lines',
    'close_review_adjustment_bindings', 'fs_first_period_declarations']) x
   WHERE to_regclass('public.' || x) IS NOT NULL;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT: objects of this release already exist (investigate a partial apply): %', v_missing; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trial_balance_uploads' AND column_name = 'source_object_id') THEN
    RAISE EXCEPTION 'PREFLIGHT: trial_balance_uploads.source_object_id already exists (investigate a partial apply)';
  END IF;
  IF to_regproc('public.fs_reporting_input') IS NOT NULL OR to_regproc('public.fs_declare_first_period') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: reporting-input / first-period functions already exist (investigate a partial apply)';
  END IF;

  -- 2. Everything the seven migrations build on must exist (main's chain through 0032 applied).
  SELECT array_agg(x) INTO v_missing FROM unnest(ARRAY[
    'companies', 'firm_members', 'fiscal_periods', 'currency_registry', 'trial_balance_uploads', 'trial_balance_upload_operations',
    'trial_balance_source_reservations', 'tb_certifications', 'account_mappings', 'workspace_member_capabilities', 'commercial_admins',
    'financial_evidence_batches', 'financial_statement_reports', 'financial_statement_evaluations',
    'financial_statement_framework_requirements', 'financial_statements_rollout_state', 'financial_statements_rollout_companies',
    'layout_templates', 'layout_confirmations']) x
   WHERE to_regclass('public.' || x) IS NULL;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT: missing prerequisite tables: %', v_missing; END IF;
  SELECT array_agg(x) INTO v_missing FROM unnest(ARRAY[
    '_account_named_user_access_active', '_capability_withheld', '_layout_actor', 'can_access_workspace', 'fs_rollout_allows',
    'fs_try_jsonb', 'fs_unmet_reconciliation_count', 'fs_unresolved_blocking_count', 'get_authoritative_certification',
    'get_confirmed_treatments', 'has_workspace_capability', 'workspace_capability_allowed', 'tbu_abort_discard', 'tbu_authorize',
    'tbu_claim_discard_purge', 'tbu_cleanup_sweep_grace', 'tbu_log_event', 'tbu_object_referenced', 'tbu_personal_source_path',
    'tbu_reservation_sweep_grace', 'tbu_stale_discard_grace', 'tbu_storage_object_exists', 'tbu_undo_window',
    'tbu_workspace_source_path_shape', 'tbu_sweeper_candidates', 'tbu_sweeper_claim', 'tbu_sweeper_complete',
    'purge_trial_balance_discard', 'tbu_storage_cleanup_target', 'fs_report_readiness']) x
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = x);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT: missing prerequisite functions: %', v_missing; END IF;
  SELECT array_agg(r) INTO v_missing FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT: missing roles: %', v_missing; END IF;

  -- 3. Feature controls are in the expected (closed) state. The financial-statements rollout must fail closed.
  IF NOT EXISTS (SELECT 1 FROM public.financial_statements_rollout_state WHERE singleton) THEN
    RAISE EXCEPTION 'PREFLIGHT: financial_statements_rollout_state has no row (the rollout would fail closed, but the state is unexpected)';
  END IF;

  -- 4. Baseline for the preservation checks (record every line).
  SELECT count(*) INTO v_n FROM public.trial_balance_uploads;                                                   RAISE NOTICE 'BASELINE uploads=%', v_n;
  SELECT count(*) INTO v_n FROM public.trial_balance_uploads WHERE file_path IS NOT NULL AND file_path NOT LIKE 'workspaces/%'; RAISE NOTICE 'BASELINE legacy_personal_path_uploads=%', v_n;
  SELECT count(*) INTO v_n FROM public.trial_balance_uploads WHERE file_path LIKE 'workspaces/%';               RAISE NOTICE 'BASELINE workspace_path_uploads=%', v_n;
  SELECT count(*) INTO v_n FROM public.trial_balance_upload_operations WHERE state = 'completed' AND kind = 'discard'
     AND completed_at > now() - public.tbu_undo_window();                                                       RAISE NOTICE 'BASELINE discards_inside_undo_window=%', v_n;
  SELECT count(*) INTO v_n FROM public.trial_balance_upload_operations WHERE state IN ('pending', 'purging', 'storage_cleanup_pending');
                                                                                                                 RAISE NOTICE 'BASELINE operations_in_flight=%', v_n;
  SELECT count(*) INTO v_n FROM public.trial_balance_source_reservations;                                        RAISE NOTICE 'BASELINE reservations=%', v_n;
  SELECT count(*) INTO v_n FROM public.tb_certifications;                                                        RAISE NOTICE 'BASELINE tb_certifications=%', v_n;
  SELECT count(*) INTO v_n FROM storage.objects WHERE bucket_id = 'trial-balance-files';                         RAISE NOTICE 'BASELINE trial_balance_storage_objects=%', v_n;
  SELECT count(*) INTO v_n FROM public.financial_statements_rollout_companies WHERE enabled;                      RAISE NOTICE 'BASELINE fs_rollout_enabled_companies=%', v_n;
  SELECT count(*) INTO v_n FROM public.financial_statements_rollout_state WHERE singleton AND kill_switch;        RAISE NOTICE 'BASELINE fs_kill_switch_on=%', v_n;

  RAISE NOTICE 'PREFLIGHT OK. Confirm out of band which project this is: the production window must be explicitly approved.';
END $$;
