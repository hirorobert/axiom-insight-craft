-- ============================================================
-- Migration: 20260626190000 — Findings engine: dedup constraint + engine_run_id
-- Date: 2026-06-26
-- Author: Axiom / Kinga engineering
--
-- TWO CHANGES — both required before the findings engine goes to production:
--
-- ── CHANGE 1: engine_run_id column ──────────────────────────────────────
--   Adds engine_run_id UUID NULL to public.findings.
--   Enables full audit traceability from any finding back to the
--   reconciliation run that created it. Until this column exists,
--   engine_run_id lives only in findings.source_detail JSONB, which
--   is queryable but requires a JSONB index or full-table scan.
--
-- ── CHANGE 2: deduplication unique constraint ────────────────────────────
--   Adds UNIQUE(company_id, statutory_rule_id, period_start, period_end)
--   on public.findings.
--
--   WHY THIS IS A PRODUCTION BLOCKER:
--   The findings engine code contains:
--     if (insertErr.code === '23505') { result.findings_skipped++; continue; }
--   This guard exists to make re-running the engine idempotent — if a finding
--   for this rule+period already exists, skip it rather than error.
--
--   WITHOUT this constraint, 23505 will NEVER fire because PostgreSQL only
--   raises that error code when a UNIQUE or PRIMARY KEY constraint is violated.
--   Running the engine twice creates exact duplicate findings. Running it
--   twelve times (one per month) or re-running after a bug fix creates 12×
--   or N× duplicates per rule per period. The dedup guard in the engine is
--   dead code until this constraint exists.
--
--   WHY PARTIAL (WHERE statutory_rule_id IS NOT NULL):
--   findings.statutory_rule_id IS nullable (manual findings may omit it).
--   A standard UNIQUE on a nullable column in PostgreSQL treats NULL as
--   distinct — two rows with (company_id, NULL, period_start, period_end)
--   would not conflict, allowing unlimited manual findings for the same period.
--   That behaviour is correct for manual findings.  The engine only inserts
--   rule_trigger findings (statutory_rule_id IS NOT NULL), so scoping the
--   UNIQUE to non-NULL statutory_rule_id is both correct and minimal.
--
--   WHY NOT (company_id, statutory_rule_id, period_start, period_end, finding_type):
--   Adding finding_type would allow two rule_trigger findings for the same
--   rule+period (one at each type). There is never a valid reason for two
--   engine-generated findings to reference the same rule over the same
--   period for the same company. The constraint intentionally excludes
--   finding_type to prevent any such duplication.
--
-- PURELY ADDITIVE. No existing rows, policies, triggers, or indexes
-- are modified by this migration.
-- ============================================================

BEGIN;

-- ════════════════════════════════════════════════════════════
-- CHANGE 1: engine_run_id column
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.findings
  ADD COLUMN IF NOT EXISTS engine_run_id UUID NULL;

COMMENT ON COLUMN public.findings.engine_run_id IS
  'UUID of the engine run that created this finding. '
  'Matches audit_logs.metadata->engine_run_id where '
  'entity_type = ''company'' and action in ('
  '''reconciliation_engine_completed'', ''reconciliation_engine_partial''). '
  'NULL for manually created findings and findings created before '
  'migration 20260626190000.';

CREATE INDEX IF NOT EXISTS idx_findings_engine_run_id
ON public.findings (engine_run_id)
WHERE engine_run_id IS NOT NULL;

COMMENT ON INDEX idx_findings_engine_run_id IS
  'Partial index: retrieve all findings from a specific engine run. '
  'Partial (IS NOT NULL) keeps the index small since manual findings '
  'never have an engine_run_id.';


-- ════════════════════════════════════════════════════════════
-- CHANGE 2: deduplication unique constraint
-- ════════════════════════════════════════════════════════════
--
-- UNIQUE partial index on non-NULL statutory_rule_id rows only.
-- PostgreSQL creates a unique index from this DDL — it both enforces
-- the constraint AND serves as a fast-path lookup for:
--   SELECT * FROM findings
--   WHERE company_id = $1
--     AND statutory_rule_id = $2
--     AND period_start = $3
--     AND period_end = $4;

CREATE UNIQUE INDEX IF NOT EXISTS uq_finding_per_rule_per_period
ON public.findings (company_id, statutory_rule_id, period_start, period_end)
WHERE statutory_rule_id IS NOT NULL;

COMMENT ON INDEX uq_finding_per_rule_per_period IS
  'Deduplication constraint for engine-generated findings. '
  'Enforces: at most one finding per (company, rule, period). '
  'Partial (statutory_rule_id IS NOT NULL): manual findings with no '
  'rule reference are excluded — multiple manual findings per period '
  'are valid (e.g. multiple TRA notice findings in the same period). '
  'This constraint makes the engine''s 23505 dedup guard functional. '
  'Without it, re-running the engine creates silent duplicates.';


COMMIT;


-- ════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after applying, before engine use)
-- ════════════════════════════════════════════════════════════

-- V1: engine_run_id column exists with correct type
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name   = 'findings'
--   AND column_name  = 'engine_run_id';
-- Expected: column_name=engine_run_id | data_type=uuid | is_nullable=YES

-- V2: unique index created
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE tablename = 'findings'
--   AND indexname = 'uq_finding_per_rule_per_period';
-- Expected: 1 row, indexdef contains 'WHERE (statutory_rule_id IS NOT NULL)'

-- V3: partial index — manual findings (statutory_rule_id IS NULL) are NOT blocked
-- This test inserts two manual findings for the same period and confirms no conflict.
-- Substitute a real company_id before running.
-- BEGIN;
-- INSERT INTO public.findings
--   (company_id, statutory_rule_id, finding_type, title, period_start, period_end,
--    exposure_amount_tzs, source_detail, created_by)
-- VALUES
--   ('<company_id>', NULL, 'manual', 'Dedup test A', '2025-07-01', '2025-07-31',
--    0, '{"smoke_test": true}', '<user_id>'),
--   ('<company_id>', NULL, 'manual', 'Dedup test B', '2025-07-01', '2025-07-31',
--    0, '{"smoke_test": true}', '<user_id>');
-- Expected: INSERT 0 2  (both succeed — manual findings are not deduplicated)
-- ROLLBACK;

-- V4: engine findings ARE blocked on re-insert
-- BEGIN;
-- -- First insert for a real rule and period
-- INSERT INTO public.findings
--   (company_id, statutory_rule_id, finding_type, title, period_start, period_end,
--    exposure_amount_tzs, source_detail, created_by)
-- SELECT c.id, sr.id, 'rule_trigger', 'Dedup test rule_trigger',
--        '2025-07-01', '2025-07-31', 0, '{}', c.user_id
-- FROM public.companies c
-- CROSS JOIN public.statutory_rules sr
-- WHERE sr.trigger_category = 'sdl' AND sr.verified_at IS NOT NULL
-- LIMIT 1;
-- Expected: INSERT 0 1
--
-- -- Attempt identical second insert — must conflict on uq_finding_per_rule_per_period
-- INSERT INTO public.findings
--   (company_id, statutory_rule_id, finding_type, title, period_start, period_end,
--    exposure_amount_tzs, source_detail, created_by)
-- SELECT c.id, sr.id, 'rule_trigger', 'Dedup test rule_trigger DUPLICATE',
--        '2025-07-01', '2025-07-31', 0, '{}', c.user_id
-- FROM public.companies c
-- CROSS JOIN public.statutory_rules sr
-- WHERE sr.trigger_category = 'sdl' AND sr.verified_at IS NOT NULL
-- LIMIT 1;
-- Expected: ERROR 23505 — duplicate key value violates unique constraint "uq_finding_per_rule_per_period"
-- ROLLBACK;
