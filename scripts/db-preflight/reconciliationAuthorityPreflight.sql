-- reconciliationAuthorityPreflight.sql — READ-ONLY impact report for 20261004100000_reconciliation_server_authority.sql,
-- run BEFORE the migration. SELECT statements only; run inside `BEGIN READ ONLY; … ROLLBACK;`. It names no customer and
-- returns counts only. scripts/db-proof/reconciliationAuthority.mjs proves it read-only and its counts correct.
--
-- The migration changes no row. These counts are the legacy rows whose recorded status the new rules would not have
-- produced; after the migration the MAONO gate blocks them, and a new match run or decision recomputes them:
--   clean_upload_with_open_exception   — upload safisha_status 'clean' while its latest reconciliation has an exception
--                                        that is pending, escalated or rejected (the old resolver's defect);
--   clean_upload_without_tb_lines      — upload 'clean' while its latest reconciliation has no trial-balance line;
--   clean_upload_line_count_mismatch   — upload 'clean' while the stored trial-balance lines differ from the recorded count;
--   clean_reconciliation_not_latest_ok — reconciliation 'clean' with an open exception (any upload);
--   escalated_exceptions               — exceptions waiting for a senior decision under the new rules.
WITH latest AS (
  SELECT DISTINCT ON (r.tb_upload_id) r.id, r.tb_upload_id, r.status, r.total_tb_lines
    FROM public.safisha_reconciliations r
   ORDER BY r.tb_upload_id, r.created_at DESC, r.id DESC
), per AS (
  SELECT l.tb_upload_id, l.id,
         (SELECT count(*) FROM public.safisha_transactions t WHERE t.reconciliation_id = l.id AND t.source_id = 'tb') AS tb_lines,
         l.total_tb_lines,
         EXISTS (SELECT 1 FROM public.safisha_exceptions e WHERE e.reconciliation_id = l.id AND e.reviewer_action <> 'approved') AS open_exception
    FROM latest l
)
SELECT 'clean_upload_with_open_exception' AS item, count(*) AS n
  FROM public.trial_balance_uploads u JOIN per p ON p.tb_upload_id = u.id WHERE u.safisha_status = 'clean' AND p.open_exception
UNION ALL
SELECT 'clean_upload_without_tb_lines', count(*)
  FROM public.trial_balance_uploads u JOIN per p ON p.tb_upload_id = u.id WHERE u.safisha_status = 'clean' AND p.tb_lines = 0
UNION ALL
SELECT 'clean_upload_line_count_mismatch', count(*)
  FROM public.trial_balance_uploads u JOIN per p ON p.tb_upload_id = u.id WHERE u.safisha_status = 'clean' AND p.tb_lines <> p.total_tb_lines
UNION ALL
SELECT 'clean_reconciliation_not_latest_ok', count(*)
  FROM public.safisha_reconciliations r
 WHERE r.status = 'clean' AND EXISTS (SELECT 1 FROM public.safisha_exceptions e WHERE e.reconciliation_id = r.id AND e.reviewer_action <> 'approved')
UNION ALL
SELECT 'escalated_exceptions', count(*) FROM public.safisha_exceptions WHERE reviewer_action = 'escalated'
ORDER BY 1;
