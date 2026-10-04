-- safishaIngestionPreflight.sql — READ-ONLY inspection of existing evidence rows for 20261005100000_safisha_ingestion_authority.sql,
-- run BEFORE the migration. SELECT statements only; run inside `BEGIN READ ONLY; … ROLLBACK;`. Counts only; names no
-- customer. scripts/db-proof/safishaIngestion.mjs proves it read-only and its counts equal an independent recount.
--
-- The migration rewrites and removes nothing. Every row counted here stays as it is ("legacy": no ingestion). After the
-- migration a retry of the same file claims a legacy row only when its source, content AND file line match (each legacy
-- row at most once); anything else is stored and flagged for review — content is never treated as proof by itself.
--   legacy_rows                     — all rows stored so far (every one becomes "legacy");
--   duplicate_groups / duplicate_extra_rows
--                                   — (reconciliation, source, raw_row_hash) stored more than once. The old handler always
--                                     dropped in-file repeats, so these come from its read-then-insert race or from two
--                                     different files holding identical rows;
--   same_line_duplicate_extra_rows  — the subset that also shares the file line: almost certainly the race (the same file
--                                     ingested concurrently). A retry claims one of each; the extras remain visible here;
--   cross_source_hash_pairs         — (reconciliation, raw_row_hash) present under more than one source;
--   reconciliations_without_status  — an unsealed reconciliation whose upload's safisha_status is NULL (the old unchecked
--                                     status update; the new path completes it on the next ingest);
--   unsealed_per_upload_over_one    — uploads with more than one unsealed reconciliation (must be 0: a partial unique index
--                                     already forbids it).
WITH groups AS (
  SELECT reconciliation_id, source_id, raw_row_hash, count(*) AS n
    FROM public.safisha_transactions GROUP BY 1, 2, 3
), line_groups AS (
  SELECT reconciliation_id, source_id, raw_row_hash, raw_row_number, count(*) AS n
    FROM public.safisha_transactions GROUP BY 1, 2, 3, 4
), cross_source AS (
  SELECT reconciliation_id, raw_row_hash FROM public.safisha_transactions
   GROUP BY 1, 2 HAVING count(DISTINCT source_id) > 1
)
SELECT 'legacy_rows' AS item, count(*) AS n FROM public.safisha_transactions
UNION ALL
SELECT 'duplicate_groups', count(*) FROM groups WHERE n > 1
UNION ALL
SELECT 'duplicate_extra_rows', COALESCE(sum(n - 1), 0) FROM groups WHERE n > 1
UNION ALL
SELECT 'same_line_duplicate_extra_rows', COALESCE(sum(n - 1), 0) FROM line_groups WHERE n > 1
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
