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
ORDER BY 1;
