-- One-time, idempotent backfill: attach legacy trial_balance_uploads rows to
-- their professional engagement. Safe to re-run; only touches NULL engagement_id.
--
-- Matching rule (deterministic, never guesses):
--   1. Resolve the upload's fiscal period: period_id when stamped, otherwise the
--      company's fiscal period whose reporting_end year equals period_year.
--   2. Link ONLY when that period has exactly ONE engagement for the company.
--      Ambiguous (2+) or absent (0) engagements are left NULL for manual review.
--
-- Run:  psql -f scripts/backfill_upload_engagement.sql

BEGIN;

WITH candidate AS (
  SELECT
    u.id AS upload_id,
    COALESCE(
      u.period_id,
      (SELECT fp.id
         FROM public.fiscal_periods fp
        WHERE fp.company_id = u.company_id
          AND EXTRACT(YEAR FROM fp.reporting_end)::int = u.period_year
        LIMIT 2)
    ) AS period_id
  FROM public.trial_balance_uploads u
  WHERE u.engagement_id IS NULL
),
resolved AS (
  SELECT c.upload_id,
         (SELECT e.id
            FROM public.engagements e
           WHERE e.fiscal_period_id = c.period_id
          LIMIT 2) AS engagement_id,
         (SELECT count(*)
            FROM public.engagements e
           WHERE e.fiscal_period_id = c.period_id) AS engagement_count
    FROM candidate c
   WHERE c.period_id IS NOT NULL
)
UPDATE public.trial_balance_uploads u
   SET engagement_id = r.engagement_id,
       period_id     = COALESCE(u.period_id, (SELECT e.fiscal_period_id FROM public.engagements e WHERE e.id = r.engagement_id))
  FROM resolved r
 WHERE u.id = r.upload_id
   AND r.engagement_count = 1
   AND u.engagement_id IS NULL;

-- Report anything still unlinked so it can be resolved by a human.
SELECT u.id, u.company_id, u.period_year, u.file_name,
       'unlinked: no period match or ambiguous engagement' AS reason
  FROM public.trial_balance_uploads u
 WHERE u.engagement_id IS NULL
 ORDER BY u.uploaded_at;

COMMIT;
