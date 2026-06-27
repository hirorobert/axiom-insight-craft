-- ============================================================
-- Migration: 20260627120000 — finding_category column on findings
-- Date: 2026-06-27
--
-- PROBLEM:
--   Module C (statutory_payable findings) sets finding_category to
--   identify which statutory category an outstanding liability belongs to
--   (e.g. 'sdl_outstanding', 'nssf_outstanding', 'tra_assessment').
--   The column did not exist in the original findings table schema,
--   causing all Module C inserts to fail with 42703.
--
--   The OD-13 dedup index also references this column and therefore
--   could not be created until the column existed.
--
-- FIX:
--   Add finding_category TEXT NULL.
--   Re-create the OD-13 dedup index (20260627100000 failed — superseded here).
--
-- PURELY ADDITIVE.
-- ============================================================

BEGIN;

ALTER TABLE public.findings
  ADD COLUMN IF NOT EXISTS finding_category TEXT NULL;

COMMENT ON COLUMN public.findings.finding_category IS
  'Statutory category for this finding. '
  'For rule_trigger findings: matches statutory_rules.trigger_category '
  '(e.g. sdl, wht_undistributed_earnings). '
  'For statutory_payable findings (Module C): category from engine pattern '
  '(e.g. sdl_outstanding, nssf_outstanding, tra_assessment, service_levy_outstanding). '
  'NULL for manual and efdms_diff findings.';

-- OD-13: Module C dedup — now possible with finding_category in place
CREATE UNIQUE INDEX IF NOT EXISTS uq_statutory_payable_per_period
ON public.findings (company_id, finding_category, period_start, period_end)
WHERE statutory_rule_id IS NULL
  AND finding_type = 'statutory_payable';

COMMENT ON INDEX public.uq_statutory_payable_per_period IS
  'OD-13 closed. Prevents duplicate Module C statutory_payable findings '
  'when the engine is re-run for the same period.';

COMMIT;


-- ════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════

-- V1: column exists
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'findings'
--   AND column_name = 'finding_category';
-- Expected: finding_category | text | YES

-- V2: both dedup indexes exist
-- SELECT indexname FROM pg_indexes
-- WHERE tablename = 'findings'
--   AND indexname IN ('uq_finding_per_rule_per_period','uq_statutory_payable_per_period')
-- ORDER BY indexname;
-- Expected: 2 rows
