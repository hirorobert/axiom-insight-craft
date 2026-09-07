-- ============================================================
-- MIGRATION: Finance Act 2026 — POST-ASSENT VERIFICATION
-- Migration: 20260701000000_fa2026_enacted_verify
-- Date: 2026-07-01
-- Author: SAFF ERP / Kinga engineering
--
-- PURPOSE
-- ─────────────────────────────────────────────────────────────
-- The Finance Act, 2026 (No. 3 of 2026) was published in the
-- Official Gazette Vol. 107 No. 6 on 15 June 2026 and is
-- effective 1 July 2026. Presidential Assent is confirmed.
-- The Act text has been verified against the Special Bill
-- Supplement (same Gazette). All rate figures in
-- migration 20260626150000_fa2026_statutory_rules are confirmed
-- correct as enacted.
--
-- This migration lifts the verified_at = NULL block on all 9
-- statutory_rules rows inserted by the prior migration.
-- The enforce_verified_statutory_rule trigger (migration
-- 20260625140000) blocks findings against any row where
-- verified_at IS NULL. Setting verified_at here enables the
-- Kinga findings engine to use these rules from today.
--
-- DEPENDENCY
-- This migration MUST be applied AFTER:
--   20260626150000_fa2026_statutory_rules
-- It will succeed silently if the 9 rows already have
-- verified_at set (idempotent via WHERE verified_at IS NULL).
--
-- RATES CONFIRMED AGAINST ENACTED TEXT
-- ─────────────────────────────────────────────────────────────
-- retained_earnings_deemed_distribution    15.0%   FA2026 s.23 / ITA s.33A
-- vat_withholding_goods                    15.0%   FA2026 s.93 / VAT Act s.5(5)
-- vat_withholding_services                 12.0%   FA2026 s.93 / VAT Act s.5(5)
-- presumptive_tax_threshold          200,000,000   FA2026 s.31 / ITA First Sch. Item 2
-- presumptive_tax_top_band_rate             4.5%   FA2026 s.31 / ITA First Sch. Item 2
-- withholding_crops_livestock_fishery       1.0%   FA2026 s.25 / ITA new s.109A
-- single_instalment_food_crops              1.0%   FA2026 s.28 / ITA new s.116B
-- single_instalment_forest_produce          2.0%   FA2026 s.27 / ITA s.116A (scope expanded)
-- nonresident_digital_service_tax           3.0%   FA2026 s.26 / ITA s.116(1)
--
-- SDL rate 4.5% — UNCHANGED. FA2026 Part XXVI (s.102) amends VET Act
-- s.19(1) only to clarify Government institution exemption wording.
-- CIT rate 30% — UNCHANGED.
-- PAYE bands — UNCHANGED.
-- Wear & tear rates — UNCHANGED (Third Schedule).
-- AMT rate 1% of turnover — UNCHANGED.
-- ============================================================


BEGIN;


-- ── SET verified_at ON ALL 9 FA2026 STATUTORY RULES ─────────

UPDATE public.statutory_rules
SET
  verified_at = '2026-07-01T00:00:00+03:00'::timestamptz,
  notes       = COALESCE(notes, '')
                || ' | ENACTED: Finance Act 2026 (No. 3 of 2026) assented to, '
                || 'effective 1 July 2026. Rates confirmed against official Gazette '
                || 'Vol. 107 No. 6, 15 June 2026. Verified 2026-07-01.'
WHERE trigger_category IN (
  'retained_earnings_deemed_distribution',
  'vat_withholding_goods',
  'vat_withholding_services',
  'presumptive_tax_threshold',
  'presumptive_tax_top_band_rate',
  'withholding_crops_livestock_fishery',
  'single_instalment_food_crops',
  'single_instalment_forest_produce',
  'nonresident_digital_service_tax'
)
  AND effective_from = '2026-07-01'
  AND effective_to   IS NULL
  AND verified_at    IS NULL;

-- Assert: exactly 9 rows updated
-- (0 rows = migration 20260626150000 was not applied or rows already verified)
DO $$
DECLARE
  v_verified INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_verified
  FROM public.statutory_rules
  WHERE trigger_category IN (
    'retained_earnings_deemed_distribution',
    'vat_withholding_goods',
    'vat_withholding_services',
    'presumptive_tax_threshold',
    'presumptive_tax_top_band_rate',
    'withholding_crops_livestock_fishery',
    'single_instalment_food_crops',
    'single_instalment_forest_produce',
    'nonresident_digital_service_tax'
  )
    AND effective_from = '2026-07-01'
    AND effective_to   IS NULL
    AND verified_at    IS NOT NULL;

  IF v_verified <> 9 THEN
    RAISE EXCEPTION
      'ABORT: Expected 9 verified FA2026 rows but found %. '
      'Ensure migration 20260626150000_fa2026_statutory_rules was applied first '
      'and that no rows were manually altered.',
      v_verified
    USING ERRCODE = 'check_violation';
  END IF;

  RAISE NOTICE 'FA2026 verification complete: % rows enabled for findings engine.', v_verified;
END;
$$;


COMMIT;


-- ============================================================
-- VERIFICATION QUERIES — run after applying this migration
-- ============================================================

-- V1. All 9 FA2026 rows should now have verified_at IS NOT NULL
SELECT
  trigger_category,
  rate_pct,
  threshold_amount,
  rate_is_threshold,
  effective_from,
  effective_to,
  verified_at
FROM public.statutory_rules
WHERE trigger_category IN (
  'retained_earnings_deemed_distribution',
  'vat_withholding_goods',
  'vat_withholding_services',
  'presumptive_tax_threshold',
  'presumptive_tax_top_band_rate',
  'withholding_crops_livestock_fishery',
  'single_instalment_food_crops',
  'single_instalment_forest_produce',
  'nonresident_digital_service_tax'
)
  AND effective_from = '2026-07-01'
  AND effective_to   IS NULL
ORDER BY trigger_category;

-- Expected: 9 rows, all with verified_at = '2026-07-01 ...'
-- Any row still showing verified_at IS NULL means the UPDATE missed it —
-- check trigger_category spelling vs migration 20260626150000.


-- V2 smoke test — relocated out of this executable migration file.
-- The negative-test invariant (findings engine must reach an FK error,
-- not a V2 trigger error, once verified_at is set) is now captured as
-- a static, non-executing assertion in
-- src/lib/__tests__/migrationReplayCompatibilityGuard.test.ts
-- rather than as live SQL inside a migration file replayed by
-- `supabase db push`.
