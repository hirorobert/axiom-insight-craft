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
ORDER BY 1;
