-- READ-ONLY release inspection: 20261004100000_reconciliation_server_authority.sql + 20261005100000_safisha_ingestion_authority.sql.
-- Run inside BEGIN READ ONLY; ... ROLLBACK; before ANY retry after an uncertain outcome. It changes nothing.
-- One row per entry, then one 'release' row. Act only on next_step. Never insert, update or delete journal or ledger rows.
WITH e(ord, entry, source, source_sha256, entry_journal_hash, ledger_rows, ledger_rows_exact_digest, journal_rows_entry_hash,
       journal_rows_source_hash, objects_present, postconditions_ok) AS (VALUES
  (1, '0027_apply_20261004100000_reconciliation_server_authority', '20261004100000_reconciliation_server_authority.sql', 'befca97c5f8fe1a1a8f1d13ab05100facf29417de5d32ab6aa6f2eb214d3425d', '71b8752b5f20a3fa6cb374b29ec74232b38257c29d1cc1d576f8ec33b2ac44d0',
   CASE WHEN to_regclass('public._release_migration_ledger') IS NOT NULL THEN (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM public._release_migration_ledger WHERE source = ''20261004100000_reconciliation_server_authority.sql''', false, true, '')))[1]::text::bigint ELSE 0 END,
   CASE WHEN to_regclass('public._release_migration_ledger') IS NOT NULL THEN (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM public._release_migration_ledger WHERE source = ''20261004100000_reconciliation_server_authority.sql'' AND source_sha256 = ''befca97c5f8fe1a1a8f1d13ab05100facf29417de5d32ab6aa6f2eb214d3425d''', false, true, '')))[1]::text::bigint ELSE 0 END,
   CASE WHEN to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM drizzle.__drizzle_migrations WHERE hash = ''71b8752b5f20a3fa6cb374b29ec74232b38257c29d1cc1d576f8ec33b2ac44d0''', false, true, '')))[1]::text::bigint ELSE 0 END,
   CASE WHEN to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM drizzle.__drizzle_migrations WHERE hash = ''befca97c5f8fe1a1a8f1d13ab05100facf29417de5d32ab6aa6f2eb214d3425d''', false, true, '')))[1]::text::bigint ELSE 0 END,
   to_regprocedure('public.safisha_record_match_result(uuid,uuid,jsonb)') IS NOT NULL,
   CASE WHEN to_regprocedure('public.safisha_record_match_result(uuid,uuid,jsonb)') IS NOT NULL THEN (xpath('/row/ok/text()', query_to_xml($inspect$SELECT bool_and(v.ok IS TRUE) AS ok FROM (
-- reconciliationAuthorityVerify.sql — READ-ONLY post-apply verification of 20261004100000_reconciliation_server_authority.sql.
-- SELECT statements only; run inside `BEGIN READ ONLY; … ROLLBACK;`. Every row with ok = false is a failed release check.
-- `n` rows report legacy counts (informational: the migration changes no row; the MAONO gate blocks these uploads).
-- scripts/db-proof/reconciliationAuthority.mjs proves it read-only and every check true on a correctly migrated database.
SELECT 'functions_present' AS item,
       (to_regprocedure('public.safisha_record_match_result(uuid,uuid,jsonb)') IS NOT NULL
        AND to_regprocedure('public.safisha_decide_exception(uuid,uuid,text,text)') IS NOT NULL
        AND to_regprocedure('public.safisha_reconciliation_coverage(uuid,integer)') IS NOT NULL
        AND to_regprocedure('public.safisha_upload_reconciliation_complete(uuid)') IS NOT NULL) AS ok, NULL::bigint AS n
UNION ALL
SELECT 'audit_decision_basis_column',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'safisha_audit_log' AND column_name = 'decision_basis' AND is_nullable = 'YES'), NULL
UNION ALL
SELECT 'triggers_present',
       (SELECT count(*) = 5 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
         ('ab_reconciliation_authority', 'ab_upload_reconciliation_status_authority', 'ab_exception_authority', 'ac_reconciliation_freshness')), NULL
UNION ALL
SELECT 'match_and_decision_service_role_only',
       (has_function_privilege('service_role', 'public.safisha_record_match_result(uuid,uuid,jsonb)', 'EXECUTE')
        AND has_function_privilege('service_role', 'public.safisha_decide_exception(uuid,uuid,text,text)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public.safisha_record_match_result(uuid,uuid,jsonb)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public.safisha_decide_exception(uuid,uuid,text,text)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public.safisha_resolve_exception(uuid,uuid,text,text)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.safisha_record_match_result(uuid,uuid,jsonb)', 'EXECUTE')), NULL
UNION ALL
SELECT 'maono_gate_service_role_only',
       (has_function_privilege('service_role', 'public.maono_check_safisha_gate(uuid[])', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public.maono_check_safisha_gate(uuid[])', 'EXECUTE')), NULL
UNION ALL
SELECT 'truncate_revoked_from_clients',
       NOT (has_table_privilege('authenticated', 'public.safisha_exceptions', 'TRUNCATE')
            OR has_table_privilege('authenticated', 'public.safisha_reconciliations', 'TRUNCATE')
            OR has_table_privilege('authenticated', 'public.safisha_transactions', 'TRUNCATE')
            OR has_table_privilege('anon', 'public.safisha_exceptions', 'TRUNCATE')), NULL
UNION ALL
SELECT 'legacy_clean_uploads_not_complete', true,
       (SELECT count(*) FROM public.trial_balance_uploads u WHERE u.safisha_status = 'clean' AND NOT public.safisha_upload_reconciliation_complete(u.id))
UNION ALL
SELECT 'legacy_clean_reconciliations_not_complete', true,
       (SELECT count(*) FROM public.safisha_reconciliations r WHERE r.status = 'clean' AND NOT public.safisha_reconciliation_complete(r.id))
ORDER BY 1
) v$inspect$, false, true, '')))[1]::text::boolean END),
  (2, '0028_apply_20261005100000_safisha_ingestion_authority', '20261005100000_safisha_ingestion_authority.sql', 'd814bbebeeaa541cbbe703aa3c037759e0b41882f7c64575f58ee3ed24bcc425', '9c9a27e6eb31fbba1cfc49d2e04617f57f4dcacd4ab2a57d56cf98b655c900a0',
   CASE WHEN to_regclass('public._release_migration_ledger') IS NOT NULL THEN (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM public._release_migration_ledger WHERE source = ''20261005100000_safisha_ingestion_authority.sql''', false, true, '')))[1]::text::bigint ELSE 0 END,
   CASE WHEN to_regclass('public._release_migration_ledger') IS NOT NULL THEN (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM public._release_migration_ledger WHERE source = ''20261005100000_safisha_ingestion_authority.sql'' AND source_sha256 = ''d814bbebeeaa541cbbe703aa3c037759e0b41882f7c64575f58ee3ed24bcc425''', false, true, '')))[1]::text::bigint ELSE 0 END,
   CASE WHEN to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM drizzle.__drizzle_migrations WHERE hash = ''9c9a27e6eb31fbba1cfc49d2e04617f57f4dcacd4ab2a57d56cf98b655c900a0''', false, true, '')))[1]::text::bigint ELSE 0 END,
   CASE WHEN to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM drizzle.__drizzle_migrations WHERE hash = ''d814bbebeeaa541cbbe703aa3c037759e0b41882f7c64575f58ee3ed24bcc425''', false, true, '')))[1]::text::bigint ELSE 0 END,
   to_regprocedure('public.safisha_ingest_evidence(uuid,uuid,text,text,text,jsonb,text,jsonb)') IS NOT NULL,
   CASE WHEN to_regprocedure('public.safisha_ingest_evidence(uuid,uuid,text,text,text,jsonb,text,jsonb)') IS NOT NULL THEN (xpath('/row/ok/text()', query_to_xml($inspect$SELECT bool_and(v.ok IS TRUE) AS ok FROM (
-- safishaIngestionVerify.sql — READ-ONLY post-apply verification of 20261005100000_safisha_ingestion_authority.sql.
-- SELECT statements only; run inside `BEGIN READ ONLY; … ROLLBACK;`. Every row with ok = false is a failed release check.
-- `n` rows are informational counts. scripts/db-proof/safishaIngestion.mjs proves it read-only and every check true on a
-- correctly migrated database.
SELECT 'function_present' AS item,
       to_regprocedure('public.safisha_ingest_evidence(uuid,uuid,text,text,text,jsonb,text,jsonb)') IS NOT NULL AS ok, NULL::bigint AS n
UNION ALL
SELECT 'function_service_role_only',
       (has_function_privilege('service_role', 'public.safisha_ingest_evidence(uuid,uuid,text,text,text,jsonb,text,jsonb)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public.safisha_ingest_evidence(uuid,uuid,text,text,text,jsonb,text,jsonb)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.safisha_ingest_evidence(uuid,uuid,text,text,text,jsonb,text,jsonb)', 'EXECUTE')), NULL
UNION ALL
SELECT 'provenance_tables_present',
       (to_regclass('public.safisha_ingestions') IS NOT NULL AND to_regclass('public.safisha_source_occurrences') IS NOT NULL), NULL
UNION ALL
SELECT 'transaction_columns_present',
       (SELECT count(*) = 2 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'safisha_transactions' AND column_name IN ('ingestion_id', 'source_txn_id')
           AND is_nullable = 'YES'), NULL
UNION ALL
SELECT 'identity_indexes_present',
       (SELECT count(*) = 2 FROM pg_indexes WHERE schemaname = 'public'
         AND indexname IN ('safisha_transactions_ingestion_line', 'safisha_source_occurrences_legacy_claim')), NULL
UNION ALL
SELECT 'client_insert_guard_present',
       EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'ab_transaction_authority'
                AND tgrelid = 'public.safisha_transactions'::regclass), NULL
UNION ALL
SELECT 'provenance_append_only',
       (SELECT count(*) = 2 FROM pg_trigger WHERE NOT tgisinternal
         AND tgname IN ('safisha_ingestions_append_only', 'safisha_source_occurrences_append_only')), NULL
UNION ALL
SELECT 'provenance_rls_and_no_client_writes',
       ((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.safisha_ingestions'::regclass)
        AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.safisha_source_occurrences'::regclass)
        AND NOT has_table_privilege('authenticated', 'public.safisha_ingestions', 'INSERT')
        AND NOT has_table_privilege('authenticated', 'public.safisha_source_occurrences', 'INSERT')
        AND NOT has_table_privilege('anon', 'public.safisha_ingestions', 'SELECT')), NULL
UNION ALL
SELECT 'every_new_row_has_one_occurrence',
       NOT EXISTS (SELECT 1 FROM public.safisha_transactions t
                    WHERE t.ingestion_id IS NOT NULL
                      AND (SELECT count(*) FROM public.safisha_source_occurrences o
                            WHERE o.transaction_id = t.id AND o.disposition = 'stored') <> 1), NULL
UNION ALL
SELECT 'every_ingestion_fully_accounted',
       NOT EXISTS (SELECT 1 FROM public.safisha_ingestions i
                    WHERE (SELECT count(*) FROM public.safisha_source_occurrences o WHERE o.ingestion_id = i.id) <> i.row_count), NULL
UNION ALL
SELECT 'legacy_rows', true, (SELECT count(*) FROM public.safisha_transactions WHERE ingestion_id IS NULL)
UNION ALL
SELECT 'ingestions', true, (SELECT count(*) FROM public.safisha_ingestions)
UNION ALL
SELECT 'legacy_rows_claimed_by_retry', true, (SELECT count(*) FROM public.safisha_source_occurrences WHERE disposition = 'legacy_match')
UNION ALL
SELECT 'every_flagged_overlap_has_its_review_item',
       NOT EXISTS (SELECT 1 FROM public.safisha_source_occurrences o
                    LEFT JOIN public.safisha_exceptions e ON e.id = o.review_exception_id
                    WHERE o.overlap_reason IS NOT NULL
                      AND (e.id IS NULL OR e.reconciliation_id <> o.reconciliation_id OR e.category <> 'investigate')), NULL
UNION ALL
SELECT 'no_clean_reconciliation_with_an_open_overlap',
       NOT EXISTS (SELECT 1 FROM public.safisha_source_occurrences o
                    JOIN public.safisha_exceptions e ON e.id = o.review_exception_id
                    JOIN public.safisha_reconciliations r ON r.id = o.reconciliation_id
                    WHERE r.status = 'clean' AND e.reviewer_action <> 'approved'), NULL
UNION ALL
SELECT 'occurrences_flagged_for_review', true, (SELECT count(*) FROM public.safisha_source_occurrences WHERE overlap_reason IS NOT NULL)
UNION ALL
SELECT 'overlap_review_items_open', true,
       (SELECT count(*) FROM public.safisha_source_occurrences o JOIN public.safisha_exceptions e ON e.id = o.review_exception_id
         WHERE e.reviewer_action IN ('pending', 'escalated'))
ORDER BY 1
) v$inspect$, false, true, '')))[1]::text::boolean END)
),
s AS (
  SELECT e.*,
         CASE WHEN ledger_rows = 1 AND ledger_rows_exact_digest = 1 AND journal_rows_entry_hash = 1 AND journal_rows_source_hash = 0
                   AND objects_present AND postconditions_ok IS TRUE THEN 'APPLIED'
              WHEN ledger_rows = 0 AND journal_rows_entry_hash = 0 AND journal_rows_source_hash = 0 AND NOT objects_present THEN 'NOT_APPLIED'
              ELSE 'INCONSISTENT' END AS state
    FROM e
),
j AS (
  SELECT CASE WHEN to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM drizzle.__drizzle_migrations WHERE hash = ''704beb2d1c2cc3a1276633055cbf3fc049d26049db4ce60565130a4d550cf0f8''', false, true, '')))[1]::text::bigint END AS pre_release_rows,
         CASE WHEN to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM drizzle.__drizzle_migrations WHERE created_at > (SELECT max(created_at) FROM drizzle.__drizzle_migrations WHERE hash = ''704beb2d1c2cc3a1276633055cbf3fc049d26049db4ce60565130a4d550cf0f8'')', false, true, '')))[1]::text::bigint END AS rows_after
),
r AS (
  SELECT CASE WHEN (SELECT pre_release_rows FROM j) IS DISTINCT FROM 1
                   OR (SELECT rows_after FROM j) IS DISTINCT FROM count(*) FILTER (WHERE state = 'APPLIED') THEN 'INCONSISTENT'
              WHEN bool_and(state = 'APPLIED') THEN 'COMPLETE'
              WHEN bool_and(state = 'NOT_APPLIED') THEN 'NOT_STARTED'
              WHEN bool_and(state IN ('APPLIED', 'NOT_APPLIED'))
                   AND NOT EXISTS (SELECT 1 FROM s a JOIN s b ON b.ord < a.ord WHERE a.state = 'APPLIED' AND b.state = 'NOT_APPLIED') THEN 'PARTIAL'
              ELSE 'INCONSISTENT' END AS state
    FROM s
)
SELECT s.ord, s.entry AS item, s.state,
       CASE WHEN (SELECT state FROM r) = 'INCONSISTENT' THEN 'STOP: inconsistent release state; escalate; do not resubmit; never edit the journal or the ledger'
            WHEN s.state = 'APPLIED' THEN 'none: applied; never resubmit this entry'
            WHEN NOT EXISTS (SELECT 1 FROM s p WHERE p.ord < s.ord AND p.state <> 'APPLIED') THEN 'submit this entry once, exactly as handed off'
            ELSE 'wait: the earlier entry must be applied first' END AS next_step,
       s.source, s.source_sha256, s.entry_journal_hash, s.ledger_rows, s.ledger_rows_exact_digest, s.journal_rows_entry_hash,
       s.journal_rows_source_hash, s.objects_present, s.postconditions_ok, NULL::bigint AS journal_rows_after_pre_release,
       NULL::boolean AS publication_permitted
  FROM s
UNION ALL
SELECT 3, 'release', (SELECT state FROM r),
       CASE (SELECT state FROM r) WHEN 'COMPLETE' THEN 'migrations complete; continue the release checklist'
                                  WHEN 'INCONSISTENT' THEN 'STOP: escalate; publication blocked'
                                  ELSE 'publication blocked until every entry is APPLIED' END,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, (SELECT rows_after FROM j), (SELECT state FROM r) = 'COMPLETE'
ORDER BY 1;
