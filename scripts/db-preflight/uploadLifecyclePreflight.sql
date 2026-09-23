-- ════════════════════════════════════════════════════════════════════════════
-- Pre-flight report for 20260923100000_upload_lifecycle_retire_and_replace.sql
--
-- READ-ONLY. Run it against a target database BEFORE applying the migration, and have a human review
-- the output. It changes nothing: every statement is a SELECT.
--
-- The migration keeps, for each (company_id, period_year), exactly the upload that the pre-lifecycle
-- authority rule (get_authoritative_certification: latest uploaded_at, then id DESC) already treated as
-- current, and retires the others. It retires them with an explicit reason and no inferred successor,
-- and preserves every row, certification and derived record. This report shows precisely which uploads
-- that would affect.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Periods that currently hold more than one upload: these are the only periods the backfill changes.
SELECT company_id, period_year, count(*) AS uploads
  FROM public.trial_balance_uploads
 WHERE company_id IS NOT NULL AND period_year IS NOT NULL
 GROUP BY company_id, period_year
HAVING count(*) > 1
 ORDER BY uploads DESC, company_id, period_year;

-- 2. Every upload the backfill would RETIRE, with its certification count and latest verdict.
--    Nothing listed here is deleted.
WITH ranked AS (
  SELECT u.*, row_number() OVER (PARTITION BY company_id, period_year ORDER BY uploaded_at DESC, id DESC) AS rn
    FROM public.trial_balance_uploads u
   WHERE company_id IS NOT NULL AND period_year IS NOT NULL
)
SELECT r.company_id, r.period_year, r.id AS upload_id, r.file_name, r.uploaded_at, r.status,
       (SELECT count(*) FROM public.tb_certifications c WHERE c.upload_id = r.id) AS certifications,
       (SELECT CASE WHEN c.is_blocking THEN 'blocking' WHEN c.requires_review THEN 'needs_review' ELSE 'clean' END
          FROM public.tb_certifications c WHERE c.upload_id = r.id ORDER BY c.sequence_no DESC LIMIT 1) AS latest_verdict
  FROM ranked r
 WHERE r.rn > 1
 ORDER BY r.company_id, r.period_year, r.uploaded_at DESC;

-- 3. The upload each multi-upload period KEEPS active (the current one under the existing rule).
WITH ranked AS (
  SELECT u.*, row_number() OVER (PARTITION BY company_id, period_year ORDER BY uploaded_at DESC, id DESC) AS rn,
         count(*) OVER (PARTITION BY company_id, period_year) AS n
    FROM public.trial_balance_uploads u
   WHERE company_id IS NOT NULL AND period_year IS NOT NULL
)
SELECT company_id, period_year, id AS kept_upload_id, file_name, uploaded_at, status
  FROM ranked WHERE rn = 1 AND n > 1
 ORDER BY company_id, period_year;

-- 4. Exact uploaded_at ties at the top of a period. The rule resolves these by id DESC, which is
--    deterministic and matches what get_authoritative_certification already returned. They are listed so
--    a reviewer can confirm that is acceptable before applying.
SELECT company_id, period_year, uploaded_at, array_agg(id ORDER BY id DESC) AS tied_uploads
  FROM (
    SELECT company_id, period_year, id, uploaded_at,
           max(uploaded_at) OVER (PARTITION BY company_id, period_year) AS top_at
      FROM public.trial_balance_uploads
     WHERE company_id IS NOT NULL AND period_year IS NOT NULL) s
 WHERE uploaded_at = top_at
 GROUP BY company_id, period_year, uploaded_at
HAVING count(*) > 1;

-- 5. Uploads without a company or period. They are never ranked or retired, and stay outside the
--    one-active-upload index.
SELECT count(*) FILTER (WHERE company_id IS NULL) AS without_company,
       count(*) FILTER (WHERE company_id IS NOT NULL AND period_year IS NULL) AS without_period
  FROM public.trial_balance_uploads;

-- 6. Is the migration already applied? (lifecycle_state column present)
SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'trial_balance_uploads' AND column_name = 'lifecycle_state'
) AS lifecycle_already_applied;
