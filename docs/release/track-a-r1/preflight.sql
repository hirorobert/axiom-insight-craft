-- READ-ONLY HOSTED PREFLIGHT for release batch track-a-r1 (docs/release/track-a-r1/RECORD.md):
--   20261127100000_fs_track_a_authority_hardening.sql   (FINAL authority writes, replacement intent, TRUNCATE closure,
--                                                         audited framework-change function and its history)
--   20261128100000_companies_framework_change_guard.sql (the database refuses any other writer of the framework; applied
--                                                         ONLY after the frontend that calls the function is published)
-- Run BEFORE the first of them (the staged apply of batch 1 executes it inside its own transaction). Writes nothing;
-- raises on the first violated expectation. Each migration repeats its own precondition and refuses a double or
-- out-of-order application.
DO $$
DECLARE
  v_bad bigint;
  v_tables text[] := ARRAY['fs_report_authority', 'fs_report_authority_events', 'financial_statement_publications', 'fs_publication_bindings',
    'reporting_pack_issuances', 'companies', 'engine_runs', 'trial_balance_uploads', 'tb_certifications', 'financial_statement_reports',
    'financial_evidence_batches', 'financial_statement_audit_events', 'financial_statement_correction_groups', 'financial_statement_documents',
    'financial_statement_evaluations', 'financial_statement_framework_requirements', 'financial_statement_reviewer_decisions',
    'financial_statements_rollout_audit', 'fs_signoff_policy_events', 'tb_certification_findings', 'tb_certification_invalidations', 'tb_reprocess_requests'];
  v_missing text[];
BEGIN
  -- 1. The baseline this batch replaces: fs-integrity-r1 (hosted ids 76-80) in force, exactly.
  IF to_regclass('public.fs_server_compilations') IS NULL
     OR to_regprocedure('public._fs_document_structure_blockers(uuid, integer, jsonb, text[])') IS NULL
     OR to_regprocedure('public.fs_replace_final_authority(uuid, text, integer, text, integer, text)') IS NULL
     OR to_regprocedure('public.fs_designate_final_authority(uuid, integer, text, integer, text)') IS NULL
     OR to_regprocedure('public._fs_scope_lock(uuid, integer)') IS NULL THEN
    RAISE EXCEPTION 'TRA_PREFLIGHT: fs-integrity-r1 (20261123100000-20261126100000) is not fully in force';
  END IF;
  IF position('current_setting(''cfoclose.fs_replace_authority'', true)' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) = 0
     OR position('current_setting(''cfoclose.fs_replace_authority'', true)' IN pg_get_functiondef('public.fs_bind_publication()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'TRA_PREFLIGHT: fs_set_publication_state / fs_bind_publication are not the 20261125100000 definitions';
  END IF;
  SELECT array_agg(t) INTO v_missing FROM unnest(v_tables) t WHERE to_regclass('public.' || t) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'TRA_PREFLIGHT: tables this batch hardens are missing: %', v_missing;
  END IF;
  -- 2. Not already (partly) applied.
  IF to_regclass('public.fs_authority_replacement_intents') IS NOT NULL OR to_regclass('public.company_framework_events') IS NOT NULL
     OR to_regprocedure('public.set_company_reporting_framework(uuid, text, text, text, uuid)') IS NOT NULL
     OR to_regprocedure('public.guard_company_reporting_framework()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('trg_fsra_guard', 'trg_fsra_event_consistency', 'trg_tb_certifications_no_truncate')) THEN
    RAISE EXCEPTION 'TRA_PREFLIGHT: part of track-a-r1 is already applied; uncertain state requires review';
  END IF;
  -- 3. Existing data satisfies what the batch will enforce from now on (it never rewrites a row to make it so).
  --    a) every authority pointer names the publication of its latest authority event (the deferred consistency trigger);
  SELECT count(*) INTO v_bad FROM public.fs_report_authority a
   WHERE NOT EXISTS (SELECT 1 FROM (SELECT e.kind, e.publication_id FROM public.fs_report_authority_events e
                                     WHERE e.company_id = a.company_id AND e.period_year = a.period_year AND e.kind <> 'CONFLICT_DETECTED'
                                     ORDER BY e.seq DESC LIMIT 1) l
                      WHERE l.publication_id = a.publication_id AND l.kind IN ('ESTABLISHED', 'SUCCEEDED', 'REPLACED', 'DESIGNATED'));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'TRA_PREFLIGHT: % authority pointer(s) do not match their latest authority event; resolve before hardening', v_bad;
  END IF;
  --    b) every recorded framework is one the audited function can name.
  SELECT count(*) INTO v_bad FROM public.companies c
   WHERE c.reporting_framework IS NOT NULL AND c.reporting_framework::text NOT IN ('ifrs_for_smes', 'full_ifrs', 'ipsas_accrual', 'ipsas_cash');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'TRA_PREFLIGHT: % company row(s) hold a framework outside the supported four', v_bad;
  END IF;
  RAISE NOTICE 'TRA_PREFLIGHT OK: apply 20261127100000; publish the frontend; then apply 20261128100000';
END;
$$;
