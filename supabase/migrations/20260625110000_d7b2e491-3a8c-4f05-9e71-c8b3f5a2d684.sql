-- ============================================================
-- Kinga statutory_rules — Finance Act 2025 (Tanzania) seed data
-- IDEMPOTENT VERSION
--
-- Migration: 20260625110000_d7b2e491-3a8c-4f05-9e71-c8b3f5a2d684
-- Date: 2026-06-25 (revised for idempotency 2026-06-26)
--
-- DATA ENTRY ONLY.
-- No CREATE TABLE, CREATE POLICY, CREATE INDEX, or schema changes.
-- The statutory_rules table, its RLS, triggers, and indexes are
-- already live from migration 20260625100000_b3e5c891-*.
--
-- IDEMPOTENCY DESIGN:
-- Each INSERT is written as INSERT INTO ... SELECT ... WHERE NOT EXISTS.
-- The NOT EXISTS guard checks (trigger_category, jurisdiction,
-- industry_pack, effective_from) — the canonical identity of a
-- statutory rule version.
--
-- On first run:  NOT EXISTS = TRUE  → INSERT executes → trigger fires.
-- On repeat run: NOT EXISTS = FALSE → SELECT yields 0 rows → INSERT
--               executes 0 rows → trigger never fires → no error.
--
-- This prevents the confusing chk_effective_dates violation that plain
-- INSERT causes on re-execution (trigger updates prior row to
-- effective_to = '2025-06-30', violating effective_to > effective_from
-- on the now-closed row). See architecture review §2.1 for full trace.
--
-- industry_pack IS NULL for all nine rows in this file.
-- The WHERE NOT EXISTS guard uses IS NULL explicitly, not = NULL.
--
-- All rows:
--   verified_at = NULL, verified_by = NULL
--   (unverified — pending human legal review per governance pattern)
--   jurisdiction = 'TZ' (Tanzania Mainland)
--   industry_pack = NULL (applies to all industries)
--   effective_from = '2025-07-01' unless noted per-row
--
-- Expected output per run:
--   First run:    INSERT 0 1  (nine times)
--   Repeat run:   INSERT 0 0  (nine times — clean no-op)
--
-- Run as service role (no INSERT policy exists for authenticated role).
-- ============================================================

BEGIN;

-- ── SDL: Finance Act 2025 version ────────────────────────────────────────
--
-- ⚠  RATE CONFLICT — DO NOT RELY ON THIS RATE FOR NEW FILINGS ⚠
--
-- Two sources disagree on the SDL rate under Finance Act 2025:
--   PwC Tanzania tax summary → 3.5%
--   Other sources (original TRA notice basis) → 4%
--
-- Inserted at 4.0000% for continuity with the existing pre-FA2025 SDL
-- row built from the original TRA notice. The effective-dating trigger
-- will close the prior SDL row (set its effective_to = 2025-06-30)
-- on first execution only — idempotency guard prevents re-execution
-- from firing the trigger a second time.
--
-- Resolution protocol (do not re-run this migration to resolve):
--   If correct rate is 3.5%: INSERT a new statutory_rules row with
--     rate_pct = 3.5000, effective_from = '2025-07-01'. Trigger closes
--     this row. Then set verified_at / verified_by on the new row.
--   If correct rate is 4%: UPDATE the active SDL row directly:
--     SET verified_at = now(), verified_by = <reviewer_uuid>
--     WHERE trigger_category = 'sdl' AND effective_to IS NULL.
--
-- ⚠  Verify against the primary Finance Act 2025 text before using
--    this row for any client filings. ⚠

INSERT INTO public.statutory_rules (
  trigger_category,
  statute,
  obligation,
  rate_is_threshold,
  rate_pct,
  threshold_amount,
  penalty_rate_pct,
  jurisdiction,
  industry_pack,
  effective_from,
  effective_to,
  verified_at,
  verified_by,
  notes
)
SELECT
  'sdl',
  'Vocational Education and Training Act Cap 82 (as amended by Finance Act 2025)',
  'Skills Development Levy on gross emoluments',
  false,
  4.0000,     -- ⚠ RATE CONFLICT: see header note above
  NULL,
  NULL,
  'TZ',
  NULL,
  '2025-07-01',
  NULL,
  NULL,        -- verified_at: NULL — unverified
  NULL,        -- verified_by: NULL — unverified
  'RATE CONFLICT: PwC tax summary cites 3.5%; other sources cite 4%. Needs verification against primary Finance Act 2025 text before relying on this rate for new filings.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.statutory_rules
  WHERE trigger_category = 'sdl'
    AND jurisdiction      = 'TZ'
    AND industry_pack     IS NULL
    AND effective_from    = '2025-07-01'
);


-- ── 1. VAT Withholding on goods ───────────────────────────────────────────
--
-- Finance Act 2025 introduced split-rate VAT withholding:
-- 3% on goods, 6% on services (see row 2 below).
-- Withheld by TRA-designated agents at point of payment.

INSERT INTO public.statutory_rules (
  trigger_category,
  statute,
  obligation,
  rate_is_threshold,
  rate_pct,
  threshold_amount,
  penalty_rate_pct,
  jurisdiction,
  industry_pack,
  effective_from,
  effective_to,
  verified_at,
  verified_by,
  notes
)
SELECT
  'vat_withholding_goods',
  'VAT Act (as amended by Finance Act 2025)',
  'VAT withholding by designated agent — goods',
  false,
  3.0000,
  NULL,
  NULL,
  'TZ',
  NULL,
  '2025-07-01',
  NULL,
  NULL,
  NULL,
  'Withheld by designated withholding agent at point of payment; supplier receives VAT Withholding Certificate; remit to TRA by 20th of following month.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.statutory_rules
  WHERE trigger_category = 'vat_withholding_goods'
    AND jurisdiction      = 'TZ'
    AND industry_pack     IS NULL
    AND effective_from    = '2025-07-01'
);


-- ── 2. VAT Withholding on services ───────────────────────────────────────

INSERT INTO public.statutory_rules (
  trigger_category,
  statute,
  obligation,
  rate_is_threshold,
  rate_pct,
  threshold_amount,
  penalty_rate_pct,
  jurisdiction,
  industry_pack,
  effective_from,
  effective_to,
  verified_at,
  verified_by,
  notes
)
SELECT
  'vat_withholding_services',
  'VAT Act (as amended by Finance Act 2025)',
  'VAT withholding by designated agent — services',
  false,
  6.0000,
  NULL,
  NULL,
  'TZ',
  NULL,
  '2025-07-01',
  NULL,
  NULL,
  NULL,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.statutory_rules
  WHERE trigger_category = 'vat_withholding_services'
    AND jurisdiction      = 'TZ'
    AND industry_pack     IS NULL
    AND effective_from    = '2025-07-01'
);


-- ── 3. Reduced VAT rate — electronic B2C payments ────────────────────────
--
-- effective_from = '2025-09-01' — deferred 2 months vs. main FA2025 date.
-- Standard rate remains 18% for non-electronic or B2B supplies.
-- NOT EXISTS guard uses '2025-09-01', matching this row's effective_from.

INSERT INTO public.statutory_rules (
  trigger_category,
  statute,
  obligation,
  rate_is_threshold,
  rate_pct,
  threshold_amount,
  penalty_rate_pct,
  jurisdiction,
  industry_pack,
  effective_from,
  effective_to,
  verified_at,
  verified_by,
  notes
)
SELECT
  'vat_reduced_rate_electronic_b2c',
  'VAT Act Cap 148 (as amended by Finance Act 2025)',
  'Reduced VAT rate for standard-rated B2C supply paid electronically to non-VAT-registered buyer',
  false,
  16.0000,
  NULL,
  NULL,
  'TZ',
  NULL,
  '2025-09-01',   -- September, not July
  NULL,
  NULL,
  NULL,
  'Requires proof of bank/electronic payment; standard rate otherwise 18%.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.statutory_rules
  WHERE trigger_category = 'vat_reduced_rate_electronic_b2c'
    AND jurisdiction      = 'TZ'
    AND industry_pack     IS NULL
    AND effective_from    = '2025-09-01'
);


-- ── 4. WHT on undistributed retained earnings ────────────────────────────
--
-- New provision: s.33A introduced by Finance Act 2025.
-- Applies when no actual dividend is declared within 12 months of
-- tax year-end — Commissioner General deems 30% of profit as
-- distributed and collects WHT on that deemed amount.

INSERT INTO public.statutory_rules (
  trigger_category,
  statute,
  obligation,
  rate_is_threshold,
  rate_pct,
  threshold_amount,
  penalty_rate_pct,
  jurisdiction,
  industry_pack,
  effective_from,
  effective_to,
  verified_at,
  verified_by,
  notes
)
SELECT
  'wht_undistributed_earnings',
  'Income Tax Act s.33A (introduced by Finance Act 2025)',
  'Withholding tax on deemed distribution of undistributed retained earnings after 12 months',
  false,
  10.0000,
  NULL,
  NULL,
  'TZ',
  NULL,
  '2025-07-01',
  NULL,
  NULL,
  NULL,
  'Applies to 30% of profit deemed distributed by Commissioner General if no actual dividend declared within 12 months of tax year-end.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.statutory_rules
  WHERE trigger_category = 'wht_undistributed_earnings'
    AND jurisdiction      = 'TZ'
    AND industry_pack     IS NULL
    AND effective_from    = '2025-07-01'
);


-- ── 5. WHT on hired motor vehicles ───────────────────────────────────────

INSERT INTO public.statutory_rules (
  trigger_category,
  statute,
  obligation,
  rate_is_threshold,
  rate_pct,
  threshold_amount,
  penalty_rate_pct,
  jurisdiction,
  industry_pack,
  effective_from,
  effective_to,
  verified_at,
  verified_by,
  notes
)
SELECT
  'wht_hired_motor_vehicles',
  'Income Tax Act (as amended by Finance Act 2025)',
  'Withholding tax on payments for motor vehicle rental',
  false,
  10.0000,
  NULL,
  NULL,
  'TZ',
  NULL,
  '2025-07-01',
  NULL,
  NULL,
  NULL,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.statutory_rules
  WHERE trigger_category = 'wht_hired_motor_vehicles'
    AND jurisdiction      = 'TZ'
    AND industry_pack     IS NULL
    AND effective_from    = '2025-07-01'
);


-- ── 6. VAT registration threshold — Tanzania Mainland ────────────────────
--
-- rate_is_threshold = true: threshold rule, not a rate rule.
-- chk_rate_or_threshold satisfied: rate_is_threshold = true (left side TRUE).
-- chk_threshold_has_amount satisfied: threshold_amount IS NOT NULL.
-- threshold_amount = 200,000,000 TZS annual taxable turnover.

INSERT INTO public.statutory_rules (
  trigger_category,
  statute,
  obligation,
  rate_is_threshold,
  rate_pct,
  threshold_amount,
  penalty_rate_pct,
  jurisdiction,
  industry_pack,
  effective_from,
  effective_to,
  verified_at,
  verified_by,
  notes
)
SELECT
  'vat_registration_threshold',
  'VAT Act Cap 148 (as amended by Finance Act 2025)',
  'Mandatory VAT registration above this annual taxable turnover threshold',
  true,
  NULL,
  200000000.00,   -- TZS 200,000,000
  NULL,
  'TZ',
  NULL,
  '2025-07-01',
  NULL,
  NULL,
  NULL,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.statutory_rules
  WHERE trigger_category = 'vat_registration_threshold'
    AND jurisdiction      = 'TZ'
    AND industry_pack     IS NULL
    AND effective_from    = '2025-07-01'
);


-- ── 7. CPA-certified return requirement — individuals ────────────────────
--
-- threshold_amount = 500,000,000 TZS annual turnover (individuals).
-- Distinct basis and threshold from the corporate equivalent below.

INSERT INTO public.statutory_rules (
  trigger_category,
  statute,
  obligation,
  rate_is_threshold,
  rate_pct,
  threshold_amount,
  penalty_rate_pct,
  jurisdiction,
  industry_pack,
  effective_from,
  effective_to,
  verified_at,
  verified_by,
  notes
)
SELECT
  'cpa_certification_required_individual',
  'Income Tax Act CAP 332 (as amended by Finance Act 2025)',
  'Tax return must be prepared or certified by a CPA in public practice',
  true,
  NULL,
  500000000.00,   -- TZS 500,000,000 annual turnover
  NULL,
  'TZ',
  NULL,
  '2025-07-01',
  NULL,
  NULL,
  NULL,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.statutory_rules
  WHERE trigger_category = 'cpa_certification_required_individual'
    AND jurisdiction      = 'TZ'
    AND industry_pack     IS NULL
    AND effective_from    = '2025-07-01'
);


-- ── 8. CPA-certified return requirement — corporations ───────────────────
--
-- threshold_amount = 100,000,000 TZS GROSS INCOME (not turnover).
-- Lower threshold than individuals; different measurement basis.
-- See notes column for the gross-income / turnover distinction.

INSERT INTO public.statutory_rules (
  trigger_category,
  statute,
  obligation,
  rate_is_threshold,
  rate_pct,
  threshold_amount,
  penalty_rate_pct,
  jurisdiction,
  industry_pack,
  effective_from,
  effective_to,
  verified_at,
  verified_by,
  notes
)
SELECT
  'cpa_certification_required_corporate',
  'Income Tax Act CAP 332 (as amended by Finance Act 2025)',
  'Tax return must be prepared or certified by a CPA in public practice',
  true,
  NULL,
  100000000.00,   -- TZS 100,000,000 gross income (not turnover)
  NULL,
  'TZ',
  NULL,
  '2025-07-01',
  NULL,
  NULL,
  NULL,
  'Threshold is gross income, not turnover, for corporations — distinct from the individual threshold above.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.statutory_rules
  WHERE trigger_category = 'cpa_certification_required_corporate'
    AND jurisdiction      = 'TZ'
    AND industry_pack     IS NULL
    AND effective_from    = '2025-07-01'
);


COMMIT;

-- ============================================================
-- Post-insert verification query (run separately after COMMIT):
--
-- SELECT trigger_category, rate_pct, threshold_amount,
--        effective_from, effective_to, verified_at,
--        LEFT(notes, 60) AS notes_preview
-- FROM public.statutory_rules
-- ORDER BY effective_from, trigger_category;
--
-- Expected first run:  9 rows, all verified_at = NULL.
-- Expected repeat run: 9 rows (unchanged — idempotent no-op).
--
-- SDL row: if a pre-existing SDL row existed before this migration ran,
--   close_prior_statutory_rule() will have set its effective_to = '2025-06-30'.
--   If no prior SDL row existed, effective_to on all new rows = NULL.
-- ============================================================
