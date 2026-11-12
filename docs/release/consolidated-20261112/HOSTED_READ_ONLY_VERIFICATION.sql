-- Hosted read-only verification for the consolidated release (2026-11-12). READ ONLY: every statement is a SELECT.
-- Run through Lovable's read-only route (supabase--read_query as supabase_read_only_user), one statement per call, and paste the
-- results into the hosted-state section of the release record before any apply, deploy or Publish is requested.
-- Expected values come from the repository at the candidate commit; a mismatch is a STOP, not something to work around.

-- 1. Migration journal: every applied row. Compare hash with sha256(drizzle/migrations/<tag>.sql) in the repo mirror
--    (scripts/ci/releaseJournal.mjs RELEASE_JOURNAL carries the expected digest per entry). Expected last id: the row for
--    0101_qbo_readiness_controls; NOTHING from 20261215100000 onward may be present.
SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id;

-- 2. Pending-chain preconditions: objects the pending migrations' PREFLIGHTs require, and objects they must NOT find.
SELECT
  to_regclass('public.fs_server_compilations')                                                                   AS receipts_table,
  to_regprocedure('public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text)') AS receipt_fn,
  to_regprocedure('public.fs_publication_blockers(uuid, text, integer)')                                                AS blockers_fn,
  to_regprocedure('public.fs_first_period_declared(uuid, integer)')                                               AS first_period_declared,
  to_regprocedure('public._fs_first_period_pending(uuid, integer)')                                               AS first_period_pending_MUST_BE_NULL,
  to_regprocedure('public._rfr_blockers(uuid, text, integer)')                                                    AS rfr_blockers_MUST_BE_NULL,
  to_regclass('public.fs_first_period_claims')                                                                    AS first_period_claims_MUST_BE_NULL,
  to_regclass('public.rfr_runs')                                                                                  AS rfr_runs_MUST_BE_NULL,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='account_mappings' AND column_name='is_contra_account') AS contra_column_MUST_BE_0;

-- 3. Compiler identity: the receipt CHECK must still be the single original digest, the function must carry only the original
--    triple, and every stored receipt must carry the original digest (49fc0852…).
SELECT c.conname, pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.fs_server_compilations'::regclass AND c.contype = 'c';
SELECT compiler_sha256, count(*) AS receipts, min(created_at) AS first, max(created_at) AS last FROM public.fs_server_compilations GROUP BY 1;
SELECT md5(pg_get_functiondef('public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text)'::regprocedure)) AS receipt_fn_md5,
       position('49fc0852e33ce71604f4c1430916144910a700ab33873a3ef8e8ad85adbf4789' IN pg_get_functiondef('public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text)'::regprocedure)) > 0 AS has_original,
       position('12314dadd6e24dff7a13fa2e0b1dfde5d22905a8d4b97bf91894a8508d1488df' IN pg_get_functiondef('public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text)'::regprocedure)) > 0 AS has_second_MUST_BE_FALSE;

-- 4. fs_publication_blockers splice anchors (every pending splice finds exactly these; see each migration's PREFLIGHT).
SELECT position('fs_server_compilation_blocker' IN d) > 0 AS server_compilation,
       position('DOCUMENT_FACT_NOT_COMPOSED' IN d) > 0     AS document_structure,
       position('_fs_document_structure_blockers' IN d) > 0 AS document_structure_fn,
       position('ACCOUNT_CAPACITY_EXCEEDED' IN d) > 0      AS capacity,
       position('REVIEW_COMMENT_UNRESOLVED' IN d) > 0      AS review_comments,
       position('_fs_first_period_pending' IN d) > 0       AS first_period_MUST_BE_FALSE,
       position('_rfr_blockers' IN d) > 0                  AS readiness_MUST_BE_FALSE,
       (length(d) - length(replace(d, E'\n  RETURN v_out;', ''))) / length(E'\n  RETURN v_out;') AS final_return_count_MUST_BE_1
FROM (SELECT pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure) AS d) x;

-- 5. #270 (20261221100000) grants and policies on the eighteen tables: BEFORE apply, record what exists; the migration aborts on
--    drift by design. AFTER apply, authenticated/anon must hold no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER and no write policy.
SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('authenticated', 'anon')
  AND table_name IN ('account_pl_mapping','board_packs','canonical_financial_records','cashflow_forecasts','efdms_reconciliation','efdms_records','efdms_z_reports','filing_obligations','ingestion_batches','maono_insights','period_closing_balances','safisha_exceptions','safisha_reconciliations','safisha_transactions','statement_sign_offs','tax_losses','variance_analyses','variance_runs')
GROUP BY 1, 2 ORDER BY 1, 2;
SELECT tablename, policyname, cmd, roles FROM pg_policies WHERE schemaname = 'public'
  AND tablename IN ('account_pl_mapping','board_packs','canonical_financial_records','cashflow_forecasts','efdms_reconciliation','efdms_records','efdms_z_reports','filing_obligations','ingestion_batches','maono_insights','period_closing_balances','safisha_exceptions','safisha_reconciliations','safisha_transactions','statement_sign_offs','tax_losses','variance_analyses','variance_runs')
ORDER BY 1, 2;

-- 6. Close-review / account-review functions that 20261224100000 re-creates from the 20261007100000 / 20261014100000 texts: record the
--    live md5 so the apply can be compared with the proof's expectation (the migration redefines them; it does not splice).
SELECT p.oid::regprocedure AS fn, md5(pg_get_functiondef(p.oid)) AS md5
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('resolve_account_review_batch', 'close_review_refresh_findings', 'account_mapping_content', 'account_review_decision_content', 'account_mappings_provenance_guard');

-- 7. Customer-access and publication flags (names as in the repository; a NULL regclass means the table does not exist here).
SELECT to_regclass('public.financial_statements_rollout_companies') AS rollout_allowlist, to_regclass('public.feature_switches') AS feature_switches;
-- If present:  SELECT * FROM public.financial_statements_rollout_companies ORDER BY 1;

-- 8. Deployed Edge Functions are NOT visible from SQL. Record from Lovable (More -> Cloud -> Edge functions): status and last-update
--    time of compile-financial-report, rfr-check-books, maono-cashflow, maono-risk, safisha-categorize, safisha-efdms-ingest,
--    safisha-score, process-trial-balance, trial-balance-layout, layout-assist. Required closures are in
--    scripts/release/verifyDeployedClosure.mjs (KNOWN_CLOSURES); the deployed compile-financial-report must still be the
--    745c8170… closure (compiler 49fc0852…) until 20261228100000 is applied.
