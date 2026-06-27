-- ============================================================
-- Migration: 20260627100000 — Module C statutory_payable dedup
-- Date: 2026-06-27
-- Closes: OD-13
--
-- PROBLEM:
--   uq_finding_per_rule_per_period (migration 20260626190000) only
--   covers rows WHERE statutory_rule_id IS NOT NULL.
--   Module C creates statutory_payable findings with statutory_rule_id = NULL.
--   Running the engine twice creates duplicate statutory_payable rows —
--   one per run — with no constraint to stop it.
--
-- FIX:
--   Partial unique index on (company_id, finding_category, period_start, period_end)
--   WHERE statutory_rule_id IS NULL AND finding_type = 'statutory_payable'.
--
--   This means: for a given company + statutory category + period, there can be
--   exactly ONE statutory_payable finding at any time. Re-running the engine
--   triggers a 23505 unique violation which the engine's existing dedup guard
--   catches and increments payables_skipped (not an error).
--
-- PURELY ADDITIVE. No rows, triggers, or policies modified.
-- ============================================================

-- NOTE: This migration FAILED in production (42703 — finding_category column
-- did not exist). Superseded by 20260627120000_findings_category_column.sql
-- which adds the column first, then creates the index.
-- This file is kept for history only. DO NOT re-run.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_statutory_payable_per_period
ON public.findings (company_id, finding_category, period_start, period_end)
WHERE statutory_rule_id IS NULL
  AND finding_type = 'statutory_payable';

COMMENT ON INDEX public.uq_statutory_payable_per_period IS
  'OD-13 closed. Prevents duplicate Module C statutory_payable findings '
  'when the findings engine is run more than once for the same period. '
  'Covers the null statutory_rule_id case not handled by '
  'uq_finding_per_rule_per_period.';

COMMIT;


-- ════════════════════════════════════════════════════════════
-- VERIFICATION (run after applying in Supabase SQL editor)
-- ════════════════════════════════════════════════════════════

-- V1: Index exists
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE tablename = 'findings'
--   AND indexname = 'uq_statutory_payable_per_period';
--
-- Expected row:
--   indexname: uq_statutory_payable_per_period
--   indexdef:  CREATE UNIQUE INDEX uq_statutory_payable_per_period ON public.findings
--              USING btree (company_id, finding_category, period_start, period_end)
--              WHERE ((statutory_rule_id IS NULL) AND (finding_type = 'statutory_payable'))

-- V2: Confirm both dedup indexes now exist
-- SELECT indexname
-- FROM pg_indexes
-- WHERE tablename = 'findings'
--   AND indexname IN ('uq_finding_per_rule_per_period', 'uq_statutory_payable_per_period')
-- ORDER BY indexname;
--
-- Expected: 2 rows
