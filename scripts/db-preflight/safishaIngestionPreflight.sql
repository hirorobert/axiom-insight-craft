-- safishaIngestionPreflight.sql — READ-ONLY inspection of existing evidence rows for 20261005100000_safisha_ingestion_authority.sql,
-- run BEFORE the migration (and safe to run after). SELECT statements only; run inside `BEGIN READ ONLY; … ROLLBACK;`.
-- Counts only; names no customer. scripts/db-proof/safishaIngestion.mjs proves it read-only and its counts exact.
--
-- The migration rewrites and removes nothing: rows stored before it keep row_occurrence NULL, and the new uniqueness index
-- covers only rows WITH an occurrence, so none of these counts can block the migration. They size what the old
-- read-then-insert path left behind, for an owner decision; nothing here is a defect the migration repairs in place.
--   duplicate_groups            — (reconciliation, source, raw_row_hash) groups stored more than once. Under the old
--                                 handler a repeat inside ONE file was always dropped, so every such group is either the
--                                 old race (simultaneous or retried ingests) or two different files each holding the row;
--   duplicate_extra_rows        — the rows beyond the first in those groups;
--   cross_source_hash_pairs     — (reconciliation, raw_row_hash) present under more than one source (the old handler
--                                 suppressed the later source's row, so these exist only where the earlier one was 'tb'
--                                 and the later ingest raced it);
--   reconciliations_without_status — an unsealed reconciliation whose upload's safisha_status is NULL (the old handler's
--                                 unchecked status update; the new path completes it on the next ingest);
--   unsealed_per_upload_over_one   — uploads with more than one unsealed reconciliation (must be 0: a partial unique
--                                 index already forbids it).
WITH groups AS (
  SELECT reconciliation_id, source_id, raw_row_hash, count(*) AS n
    FROM public.safisha_transactions GROUP BY 1, 2, 3
), cross_source AS (
  SELECT reconciliation_id, raw_row_hash FROM public.safisha_transactions
   GROUP BY 1, 2 HAVING count(DISTINCT source_id) > 1
)
SELECT 'duplicate_groups' AS item, count(*) AS n FROM groups WHERE n > 1
UNION ALL
SELECT 'duplicate_extra_rows', COALESCE(sum(n - 1), 0) FROM groups WHERE n > 1
UNION ALL
SELECT 'cross_source_hash_pairs', count(*) FROM cross_source
UNION ALL
SELECT 'reconciliations_without_status', count(*)
  FROM public.safisha_reconciliations r JOIN public.trial_balance_uploads u ON u.id = r.tb_upload_id
 WHERE NOT r.sealed AND u.safisha_status IS NULL
UNION ALL
SELECT 'unsealed_per_upload_over_one', count(*)
  FROM (SELECT tb_upload_id FROM public.safisha_reconciliations WHERE NOT sealed GROUP BY 1 HAVING count(*) > 1) x
ORDER BY 1;
