-- ════════════════════════════════════════════════════════════════════════════
-- Ω∞ PHASE 1 SLICE 1 — companies.reporting_framework: eliminate silent default
--
-- Fixes the Phase 1 Design Adjudication's confirmed SILENT_DEFAULT_DEFECT
-- (gap #2 of the Phase 1 Done-When matrix): companies.reporting_framework
-- was TEXT NOT NULL DEFAULT 'ifrs_for_smes' (20260701000001), and the sole
-- creation-time writers (CompanyManager.tsx, FirstRunEngagement.tsx) both
-- pre-filled their form state with the same literal value. A company created
-- without the user ever touching the framework field persisted the exact
-- same DB value as one where the user deliberately chose IFRS for SMEs --
-- genuinely indistinguishable, confirmed by direct code trace, not inferred.
--
-- SCOPE: this migration ONLY drops the column default and the NOT NULL
-- constraint on companies.reporting_framework. It does not touch:
--   - the existing 4-value CHECK constraint (unaffected -- CHECK(col IN (...))
--     evaluates to NULL, not FALSE, when col IS NULL, so it already permits
--     NULL without modification)
--   - any other column on companies (currency, fiscal_year_end, industry,
--     tin, or any tax/ownership/entity-class field)
--   - any existing row's stored value -- this is a pure ALTER COLUMN, no
--     UPDATE statement, no bulk rewrite, nothing reinterpreted
--
-- EXISTING DATA: rows created before this migration that hold 'ifrs_for_smes'
-- KEEP that value unchanged. This correction is prospective only -- past user
-- intent (deliberate choice vs. untouched default) cannot be safely
-- reconstructed, and this migration does not attempt to. Application code
-- (detectEntityContext.ts) continues to treat a literal 'ifrs_for_smes'
-- value as LOW confidence, honestly reflecting that remaining historical
-- ambiguity -- this is intentional, not an oversight (see that file's own
-- updated comment).
--
-- NOT applied to any live database. NOT deployed by this commit.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.companies
  ALTER COLUMN reporting_framework DROP DEFAULT,
  ALTER COLUMN reporting_framework DROP NOT NULL;

COMMENT ON COLUMN public.companies.reporting_framework IS
  'Statutory reporting framework: ifrs_for_smes | full_ifrs | ipsas_accrual | '
  'ipsas_cash | NULL (not yet selected). No default as of Phase 1 (SAFF V5 '
  'PART IX, 20260903100000) -- a new company persists NULL until a value is '
  'explicitly chosen. Rows created before this migration may still hold the '
  'prior schema default (''ifrs_for_smes'') from before this correction; '
  'those values were NOT rewritten and remain as originally stored.';

-- ── Rollback (NOT executed — for reference only) ─────────────────────────────
-- ALTER TABLE public.companies
--   ALTER COLUMN reporting_framework SET DEFAULT 'ifrs_for_smes',
--   ALTER COLUMN reporting_framework SET NOT NULL;
