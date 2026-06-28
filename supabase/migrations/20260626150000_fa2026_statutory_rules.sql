-- ============================================================
-- MIGRATION: Finance Act 2026 — statutory_rules updates
-- Effective date for all new rate rows: 2026-07-01
--
-- Migration: 20260626150000_fa2026_statutory_rules
-- Author: Axiom / Kinga engineering
-- Date: 2026-06-26
--
-- Source: The Finance Act, 2026 (Special Bill Supplement,
-- Gazette No. 6 Vol. 107, 15 June 2026)
--
-- ── BILL STATUS WARNING ──────────────────────────────────────
--
-- As of 2026-06-26, this is a BILL — Special Bill Supplement —
-- NOT yet assented to by the President. It is not yet enacted
-- law. Accordingly, ALL rows inserted by this migration have
-- verified_at = NULL and verified_by = NULL.
--
-- The enforce_verified_statutory_rule trigger (migration
-- 20260625140000) will BLOCK the findings engine from
-- generating findings against any of these rows until a human
-- sets verified_at after confirming the final signed Gazette.
-- This is the correct and intended behaviour.
--
-- DO NOT SET verified_at = now() on these rows until
-- Presidential Assent is confirmed and the final Act text
-- is available. Rate figures in a Bill may change before
-- assent. Findings generated against unconfirmed rates are
-- legally indefensible and cannot be automatically rolled back.
--
-- ── SCHEMA COLUMN MAP ────────────────────────────────────────
--
-- statutory_rules NOT NULL columns (all INSERTs must include):
--   trigger_category TEXT
--   statute          TEXT    ← legislative citation goes here
--   obligation       TEXT    ← human-readable description
--   rate_is_threshold BOOLEAN DEFAULT false
--   jurisdiction     TEXT    DEFAULT 'TZ'
--   effective_from   DATE
--
-- NULL columns used in this migration:
--   rate_pct         NUMERIC(7,4) — set for rate rows
--   threshold_amount NUMERIC(20,2) — set for threshold rows
--   notes            TEXT — condition details, exclusions, caveats
--   verified_at      TIMESTAMPTZ — NULL until post-assent human review
--   verified_by      UUID — NULL (requires staff member UUID on verify)
--   effective_to     DATE — NULL for active rows
--   industry_pack    TEXT — NULL (all rows apply to all industries)
--   penalty_rate_pct NUMERIC(7,4) — NULL unless statutory penalty applies
--
-- Mutual exclusivity CHECK constraints (enforced by DB):
--   chk_rate_or_threshold:  rate_is_threshold = true  OR rate_pct IS NOT NULL
--   chk_threshold_has_amount: rate_is_threshold = false OR threshold_amount IS NOT NULL
--   → For rate rows:      rate_is_threshold = false, rate_pct = <value>, threshold_amount = NULL
--   → For threshold rows: rate_is_threshold = true,  threshold_amount = <value>, rate_pct = NULL
--   → "Mechanism" rows with neither: not representable. Encode as notes on the
--     relevant rate rows and implement in engine logic. See Block 2e note.
--
-- ── UPDATE + TRIGGER INTERACTION ─────────────────────────────
--
-- For categories with EXISTING active rows, this migration uses
-- a two-step pattern:
--   STEP 1 UPDATE: close the outgoing row (effective_to = '2026-06-30')
--     and add a closure note explaining WHY it was closed. This is an
--     explicit audit annotation on the outgoing row.
--   STEP 2 INSERT: insert the new row. The trg_close_prior_statutory_rule
--     BEFORE INSERT trigger fires but finds no active row (already closed
--     by STEP 1) — UPDATE affects 0 rows inside the trigger. Benign.
--
-- The trigger handles row-closing automatically when you INSERT without
-- an explicit UPDATE first (for net-new categories). Both paths produce
-- correct effective_to values.
--
-- UPDATE row counts are asserted via DO blocks where an existing row
-- is expected. Silent 0-row UPDATEs are not acceptable for known categories.
--
-- ── NET-NEW vs SUPERSESSION CATEGORIES ───────────────────────
--
-- SUPERSESSION (old row exists, must be closed):
--   vat_withholding_goods          ← exists at 3.0% from FA2025 seed
--   vat_withholding_services       ← exists at 6.0% from FA2025 seed
--   single_instalment_forest_produce  ← exists if FA2024/prior seed applied
--   nonresident_digital_service_tax   ← exists if prior seed applied
--
-- NET-NEW (no prior active row in this database):
--   retained_earnings_deemed_distribution  ← first appearance
--   presumptive_tax_threshold              ← first appearance
--   presumptive_tax_top_band_rate          ← first appearance
--   withholding_crops_livestock_fishery    ← new s.109A
--   single_instalment_food_crops           ← new s.116B
--
-- For net-new categories: omit the UPDATE step. Let the INSERT
-- trigger handle it (closes 0 rows — correct, nothing existed).
-- ============================================================


BEGIN;


-- ════════════════════════════════════════════════════════════
-- BLOCK 1: Retained earnings deemed-distribution fraction
--          Income Tax Act s.33A — 30% → 15%
-- ════════════════════════════════════════════════════════════
--
-- FA2026 s.23 reduces the deemed-distribution fraction from 30%
-- to 15%. The 10% withholding rate ON THE DEEMED AMOUNT is
-- unchanged and is NOT encoded in this migration (it is a separate
-- rule row — confirm whether your schema has a
-- 'wht_retained_earnings_deemed_distribution' row before
-- assuming this is fully covered).
--
-- EXCLUSIONS (stored in notes, not encoded as separate rows):
--   • DSE-listed companies
--   • Financial institutions (BAFIA)
--   • Insurance companies
--   • Mining companies with a Government Framework Agreement
--
-- NET-NEW: No prior 'retained_earnings_deemed_distribution' row
-- exists in this database. No UPDATE step needed. The INSERT
-- trigger closes 0 rows — correct.

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
VALUES (
  'retained_earnings_deemed_distribution',
  'Finance Act 2026 s.23 (amending Income Tax Act Cap.332 s.33A(1))',
  'Deemed-distribution fraction on retained earnings: 15% of retained '
    || 'earnings treated as dividend distributed to non-residents. '
    || 'Withholding tax on the deemed amount at 10% (separate WHT rule, unchanged).',
  false,
  15.0000,
  NULL,
  NULL,
  'TZ',
  NULL,
  '2026-07-01',
  NULL,
  NULL,   -- verified_at: NULL — Bill not yet assented
  NULL,   -- verified_by: NULL — set after Presidential Assent confirmed
  'BILL TEXT (not yet enacted). '
    || 'Fraction reduced from 30% to 15% under s.33A(1). '
    || 'Withholding rate on the deemed amount remains 10% (unchanged — '
    || 'confirm separately that your wht schema row for this is still current). '
    || 'EXCLUDED from this provision entirely: companies listed on the '
    || 'Dar es Salaam Stock Exchange; financial institutions under BAFIA; '
    || 'insurance companies; mining companies with a Government Framework Agreement. '
    || 'Source: Finance Act 2026, Part IX, s.23 (Special Bill Supplement, '
    || 'Gazette No. 6 Vol. 107, 15 June 2026).'
);


-- ════════════════════════════════════════════════════════════
-- BLOCK 2: VAT withholding rates — goods & services
--          VAT Act s.5(5) — major rate restructure
-- ════════════════════════════════════════════════════════════
--
-- FA2026 s.93 replaces the 3%/6% regime with 15%/12%.
-- This is a RATE CHANGE, not a typo of the standard 18% VAT rate.
-- The 3:2 apportionment for mixed supplies is a NEW MECHANISM
-- introduced by new s.5(7). See BLOCK 2e note below.
--
-- STEP 1: Close existing rows and annotate them.
--
-- ASSERTION: both of these categories MUST have exactly 1 active row
-- (they were inserted by the FA2025 seed migration). If 0 rows are
-- affected, the category name drifted or the seed was not applied —
-- abort and investigate.

DO $$
DECLARE
  v_affected INTEGER;
BEGIN

  UPDATE public.statutory_rules
  SET
    effective_to = '2026-06-30',
    notes        = COALESCE(notes, '')
                   || ' | Superseded by Finance Act 2026 s.93, effective 2026-07-01. '
                   || 'New rate: 15% on goods.'
  WHERE trigger_category = 'vat_withholding_goods'
    AND jurisdiction     = 'TZ'
    AND effective_to     IS NULL;

  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    RAISE EXCEPTION
      'ABORT: Expected to close active vat_withholding_goods row but found 0 rows. '
      'Confirm the FA2025 seed migration (20260625110000) has been applied and that '
      'vat_withholding_goods is the correct trigger_category name.'
    USING ERRCODE = 'no_data_found';
  ELSIF v_affected > 1 THEN
    RAISE EXCEPTION
      'ABORT: Closed % rows for vat_withholding_goods (expected exactly 1). '
      'Multiple active rows violate uq_statutory_rule_active — investigate.',
      v_affected
    USING ERRCODE = 'too_many_rows';
  END IF;

  UPDATE public.statutory_rules
  SET
    effective_to = '2026-06-30',
    notes        = COALESCE(notes, '')
                   || ' | Superseded by Finance Act 2026 s.93, effective 2026-07-01. '
                   || 'New rate: 12% on services.'
  WHERE trigger_category = 'vat_withholding_services'
    AND jurisdiction     = 'TZ'
    AND effective_to     IS NULL;

  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    RAISE EXCEPTION
      'ABORT: Expected to close active vat_withholding_services row but found 0 rows. '
      'Confirm the FA2025 seed migration (20260625110000) has been applied and that '
      'vat_withholding_services is the correct trigger_category name.'
    USING ERRCODE = 'no_data_found';
  ELSIF v_affected > 1 THEN
    RAISE EXCEPTION
      'ABORT: Closed % rows for vat_withholding_services (expected exactly 1). '
      'Multiple active rows violate uq_statutory_rule_active — investigate.',
      v_affected
    USING ERRCODE = 'too_many_rows';
  END IF;

END;
$$;

-- STEP 2: Insert new goods rate (15%).
-- The trigger fires and confirms no active row remains to close (correct —
-- the DO block already closed it).

INSERT INTO public.statutory_rules (
  trigger_category, statute, obligation,
  rate_is_threshold, rate_pct, threshold_amount, penalty_rate_pct,
  jurisdiction, industry_pack, effective_from, effective_to,
  verified_at, verified_by, notes
)
VALUES (
  'vat_withholding_goods',
  'Finance Act 2026 s.93 (amending VAT Act Cap.148 s.5(5))',
  'Withholding VAT on supply of goods by designated withholding agents: 15%.',
  false,
  15.0000,
  NULL,
  NULL,
  'TZ',
  NULL,
  '2026-07-01',
  NULL,
  NULL,   -- verified_at: NULL — Bill not yet assented
  NULL,
  'BILL TEXT (not yet enacted). '
    || 'Rate up from 3% (Finance Act 2025). '
    || 'Where a single invoice has both goods AND services components, '
    || 'apportion the taxable value 3:2 between goods and services before '
    || 'applying 15%/12% respectively (new s.5(7)). '
    || 'Apportionment is engine logic — do not create a separate rule row for it. '
    || 'Source: Finance Act 2026, Part XXV, s.93 (Special Bill Supplement, '
    || 'Gazette No. 6 Vol. 107, 15 June 2026).'
);

-- STEP 3: Insert new services rate (12%).

INSERT INTO public.statutory_rules (
  trigger_category, statute, obligation,
  rate_is_threshold, rate_pct, threshold_amount, penalty_rate_pct,
  jurisdiction, industry_pack, effective_from, effective_to,
  verified_at, verified_by, notes
)
VALUES (
  'vat_withholding_services',
  'Finance Act 2026 s.93 (amending VAT Act Cap.148 s.5(5))',
  'Withholding VAT on supply of services by designated withholding agents: 12%.',
  false,
  12.0000,
  NULL,
  NULL,
  'TZ',
  NULL,
  '2026-07-01',
  NULL,
  NULL,   -- verified_at: NULL — Bill not yet assented
  NULL,
  'BILL TEXT (not yet enacted). '
    || 'Rate restructured from 6% (Finance Act 2025). '
    || 'Where a single invoice has both goods AND services components, '
    || 'apportion the taxable value 3:2 between goods and services before '
    || 'applying 15%/12% respectively (new s.5(7)). '
    || 'Apportionment is engine logic — do not create a separate rule row for it. '
    || 'Source: Finance Act 2026, Part XXV, s.93 (Special Bill Supplement, '
    || 'Gazette No. 6 Vol. 107, 15 June 2026).'
);

-- NOTE: vat_withholding_mixed_supply_apportionment row INTENTIONALLY OMITTED.
-- A 3:2 apportionment ratio is a computation mechanism, not a statutory rate.
-- The statutory_rules table is a rate/threshold store; a NULL-rate mechanism
-- row violates chk_rate_or_threshold and breaks any query that assumes numeric
-- rates on all rows. The apportionment logic belongs in the findings engine's
-- rate-calculation function. Both the 15% and 12% rows above include the
-- apportionment rule in their notes column for engine developer reference.


-- ════════════════════════════════════════════════════════════
-- BLOCK 3: Presumptive tax — threshold ceiling & top band rate
--          Income Tax Act First Schedule, Item 2
-- ════════════════════════════════════════════════════════════
--
-- FA2026 s.31 amends the presumptive tax schedule:
--   (a) Upper turnover ceiling: 100M → 200M TZS
--   (b) Top band rate: 3.5% → 4.5% (for turnover 11,000,001–200,000,000)
--
-- ⚠ PARTIAL CONFIRMATION WARNING:
--   Only the top band rate (4.5%) has been individually verified
--   against the quoted Act text. The Act replaces the ENTIRE
--   5-band table. Bands 1–4 (turnover below 11,000,000) may also
--   have changed. Do NOT generate findings using the top-band row
--   without first confirming the full replacement table against
--   Finance Act 2026, Part IX, s.31(a) in its entirety.
--   Both rows below have verified_at = NULL for this reason.
--
-- NET-NEW: Neither of these categories existed before. No UPDATE step.

-- 3a. Threshold ceiling row (200M TZS)

INSERT INTO public.statutory_rules (
  trigger_category, statute, obligation,
  rate_is_threshold, rate_pct, threshold_amount, penalty_rate_pct,
  jurisdiction, industry_pack, effective_from, effective_to,
  verified_at, verified_by, notes
)
VALUES (
  'presumptive_tax_threshold',
  'Finance Act 2026 s.31(a) (amending Income Tax Act First Schedule, Item 2)',
  'Presumptive tax regime eligibility ceiling: taxpayers with annual '
    || 'turnover not exceeding TZS 200,000,000 may be assessed under the '
    || 'presumptive regime.',
  true,        -- rate_is_threshold = true
  NULL,        -- rate_pct = NULL (threshold row, not a percentage)
  200000000.00, -- threshold_amount = TZS 200,000,000 (up from 100,000,000)
  NULL,
  'TZ',
  NULL,
  '2026-07-01',
  NULL,
  NULL,   -- verified_at: NULL — Bill not yet assented; full schedule unconfirmed
  NULL,
  'BILL TEXT (not yet enacted). '
    || 'Ceiling raised from TZS 100,000,000 to TZS 200,000,000. '
    || 'Taxpayers below this ceiling may now elect self-assessment and '
    || 'maintain books of account instead of presumptive assessment. '
    || 'WARNING: Only the threshold figure and top-band rate have been '
    || 'confirmed from the quoted text. Full 5-band replacement table '
    || 'must be verified against s.31(a) before use. '
    || 'Source: Finance Act 2026, Part IX, s.31(a) (Special Bill Supplement, '
    || 'Gazette No. 6 Vol. 107, 15 June 2026).'
);

-- 3b. Top band rate row (4.5%, turnover 11,000,001–200,000,000)

INSERT INTO public.statutory_rules (
  trigger_category, statute, obligation,
  rate_is_threshold, rate_pct, threshold_amount, penalty_rate_pct,
  jurisdiction, industry_pack, effective_from, effective_to,
  verified_at, verified_by, notes
)
VALUES (
  'presumptive_tax_top_band_rate',
  'Finance Act 2026 s.31(a)(ii) (amending Income Tax Act First Schedule, Item 2, subparagraph 3)',
  'Presumptive tax rate for turnover band TZS 11,000,001–200,000,000: 4.5%.',
  false,
  4.5000,
  NULL,
  NULL,
  'TZ',
  NULL,
  '2026-07-01',
  NULL,
  NULL,   -- verified_at: NULL — Bill not yet assented; full schedule unconfirmed
  NULL,
  'BILL TEXT (not yet enacted). '
    || 'Rate up from 3.5% under Finance Act 2025 for the top band '
    || '(TZS 11,000,001 – 200,000,000). '
    || 'WARNING: Only this band has been individually confirmed against the '
    || 'quoted Act text. The Act replaces the entire 5-band schedule. '
    || 'Do not use this row for findings until all 5 bands are verified. '
    || 'Bands below TZS 11,000,000 retain NIL/flat-fee structure — '
    || 'confirm no change to those bands against the full table in s.31(a)(ii). '
    || 'Source: Finance Act 2026, Part IX, s.31(a)(ii) (Special Bill Supplement, '
    || 'Gazette No. 6 Vol. 107, 15 June 2026).'
);


-- ════════════════════════════════════════════════════════════
-- BLOCK 4: New withholding / instalment obligations
--          Net-new rows — nothing to close
-- ════════════════════════════════════════════════════════════

-- 4a. Withholding on crops, livestock, fishery products
--     Income Tax Act new s.109A — FA2026 s.25

INSERT INTO public.statutory_rules (
  trigger_category, statute, obligation,
  rate_is_threshold, rate_pct, threshold_amount, penalty_rate_pct,
  jurisdiction, industry_pack, effective_from, effective_to,
  verified_at, verified_by, notes
)
VALUES (
  'withholding_crops_livestock_fishery',
  'Finance Act 2026 s.25 (new Income Tax Act s.109A)',
  'Withholding tax at 1% by resident corporations on payments for '
    || 'crops, livestock products, and fishery products supplied by a '
    || 'resident person.',
  false,
  1.0000,
  NULL,
  NULL,
  'TZ',
  NULL,
  '2026-07-01',
  NULL,
  NULL,   -- verified_at: NULL — Bill not yet assented
  NULL,
  'BILL TEXT (not yet enacted). '
    || 'Applies to: crops; livestock products (including live animals, '
    || 'unprocessed milk); fishery products (including unprocessed fish, '
    || 'fish maws). Withholder: resident corporations making the payment. '
    || 'Source: Finance Act 2026, Part IX, s.25 (Special Bill Supplement, '
    || 'Gazette No. 6 Vol. 107, 15 June 2026).'
);


-- 4b. Single instalment tax on food crops
--     Income Tax Act new s.116B — FA2026 s.28

INSERT INTO public.statutory_rules (
  trigger_category, statute, obligation,
  rate_is_threshold, rate_pct, threshold_amount, penalty_rate_pct,
  jurisdiction, industry_pack, effective_from, effective_to,
  verified_at, verified_by, notes
)
VALUES (
  'single_instalment_food_crops',
  'Finance Act 2026 s.28 (new Income Tax Act s.116B)',
  'Single instalment tax at 1% on value of food crops purchased '
    || '(farm gate / purchase price, whichever is greater).',
  false,
  1.0000,
  NULL,
  NULL,
  'TZ',
  NULL,
  '2026-07-01',
  NULL,
  NULL,   -- verified_at: NULL — Bill not yet assented
  NULL,
  'BILL TEXT (not yet enacted). '
    || 'QUANTITY THRESHOLD: Does NOT apply when quantity purchased < 1 tonne. '
    || 'EXCLUDED crops (separate regimes apply — do not double-apply): '
    || 'sesame, sugarcane, tobacco, tea, cashew nuts, coffee, cotton, '
    || 'pyrethrum, sisal. '
    || 'Engine must check crop type against exclusion list before applying this rate. '
    || 'Source: Finance Act 2026, Part IX, s.28 (Special Bill Supplement, '
    || 'Gazette No. 6 Vol. 107, 15 June 2026).'
);


-- 4c. Forest produce single instalment tax — SCOPE EXPANDED
--     Income Tax Act s.116A repealed and replaced — FA2026 s.27
--
-- The rate (2%) is unchanged. The definition of "forest produce"
-- is expanded. We supersede the old row to capture the new scope
-- in the notes column for the engine.
--
-- CONDITIONAL UPDATE: run only if an active row exists.
-- Unlike vat_withholding_goods/services, this category may or may
-- not exist depending on prior migrations. We assert a warning
-- (not an abort) if 0 rows found, since this may legitimately be
-- a new category in this database.

DO $$
DECLARE
  v_affected INTEGER;
BEGIN

  UPDATE public.statutory_rules
  SET
    effective_to = '2026-06-30',
    notes        = COALESCE(notes, '')
                   || ' | Superseded by Finance Act 2026 s.27 (scope expansion). '
                   || 'Rate (2%) unchanged. Forest produce definition broadened — see new row.'
  WHERE trigger_category = 'single_instalment_forest_produce'
    AND jurisdiction     = 'TZ'
    AND effective_to     IS NULL;

  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    RAISE WARNING
      'No active single_instalment_forest_produce row found to close. '
      'If this category existed in a prior migration, investigate. '
      'Proceeding with INSERT as a net-new category.';
  ELSIF v_affected > 1 THEN
    RAISE EXCEPTION
      'ABORT: Closed % rows for single_instalment_forest_produce (expected 0 or 1).',
      v_affected
    USING ERRCODE = 'too_many_rows';
  END IF;

END;
$$;

INSERT INTO public.statutory_rules (
  trigger_category, statute, obligation,
  rate_is_threshold, rate_pct, threshold_amount, penalty_rate_pct,
  jurisdiction, industry_pack, effective_from, effective_to,
  verified_at, verified_by, notes
)
VALUES (
  'single_instalment_forest_produce',
  'Finance Act 2026 s.27 (repeal and replacement of Income Tax Act s.116A)',
  'Single instalment tax at 2% on forest produce sales.',
  false,
  2.0000,
  NULL,
  NULL,
  'TZ',
  NULL,
  '2026-07-01',
  NULL,
  NULL,   -- verified_at: NULL — Bill not yet assented
  NULL,
  'BILL TEXT (not yet enacted). '
    || 'Rate unchanged at 2%. Scope expanded: "forest produce" definition '
    || 'now explicitly includes natural varnish, latex, resin, sap, and gums, '
    || 'in addition to timber, logs, mirunda, and poles. '
    || 'Engine must apply the broadened definition from 2026-07-01 onwards. '
    || 'Source: Finance Act 2026, Part IX, s.27 (Special Bill Supplement, '
    || 'Gazette No. 6 Vol. 107, 15 June 2026).'
);


-- 4d. Non-resident digital service tax — 2% → 3%
--     Income Tax Act s.116(1) — FA2026 s.26
--
-- Same conditional-update pattern as 4c.

DO $$
DECLARE
  v_affected INTEGER;
BEGIN

  UPDATE public.statutory_rules
  SET
    effective_to = '2026-06-30',
    notes        = COALESCE(notes, '')
                   || ' | Superseded by Finance Act 2026 s.26, effective 2026-07-01. '
                   || 'New rate: 3%.'
  WHERE trigger_category = 'nonresident_digital_service_tax'
    AND jurisdiction     = 'TZ'
    AND effective_to     IS NULL;

  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    RAISE WARNING
      'No active nonresident_digital_service_tax row found to close. '
      'If this category existed in a prior migration, investigate. '
      'Proceeding with INSERT as a net-new category.';
  ELSIF v_affected > 1 THEN
    RAISE EXCEPTION
      'ABORT: Closed % rows for nonresident_digital_service_tax (expected 0 or 1).',
      v_affected
    USING ERRCODE = 'too_many_rows';
  END IF;

END;
$$;

INSERT INTO public.statutory_rules (
  trigger_category, statute, obligation,
  rate_is_threshold, rate_pct, threshold_amount, penalty_rate_pct,
  jurisdiction, industry_pack, effective_from, effective_to,
  verified_at, verified_by, notes
)
VALUES (
  'nonresident_digital_service_tax',
  'Finance Act 2026 s.26 (amending Income Tax Act s.116(1))',
  'Income tax on payments to non-resident digital service providers: 3%.',
  false,
  3.0000,
  NULL,
  NULL,
  'TZ',
  NULL,
  '2026-07-01',
  NULL,
  NULL,   -- verified_at: NULL — Bill not yet assented
  NULL,
  'BILL TEXT (not yet enacted). '
    || 'Rate up from 2%. '
    || 'Source: Finance Act 2026, Part IX, s.26 (Special Bill Supplement, '
    || 'Gazette No. 6 Vol. 107, 15 June 2026).'
);


COMMIT;


-- ============================================================
-- VERIFICATION QUERIES
-- Run after applying this migration.
-- ============================================================

-- V1. Count of active rows inserted by this migration
-- Expected: 9 rows (retained_earnings, vat_goods, vat_services,
--   presumptive_threshold, presumptive_top_band, crops_livestock_fishery,
--   food_crops, forest_produce, digital_service_tax)

SELECT trigger_category, rate_pct, threshold_amount, rate_is_threshold,
       verified_at, effective_from, effective_to
FROM   public.statutory_rules
WHERE  trigger_category IN (
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
  AND  effective_from = '2026-07-01'
  AND  effective_to IS NULL
ORDER  BY trigger_category;

-- Expected: 9 rows, all with effective_to IS NULL and verified_at IS NULL.


-- V2. Confirm prior FA2025 rows for goods/services are now closed

SELECT trigger_category, rate_pct, effective_from, effective_to
FROM   public.statutory_rules
WHERE  trigger_category IN ('vat_withholding_goods', 'vat_withholding_services')
ORDER  BY trigger_category, effective_from;

-- Expected: 4 rows total (2 per category):
--   FA2025 row: effective_to = '2026-06-30' (closed)
--   FA2026 row: effective_to = NULL (active)


-- V3. Confirm threshold row has correct amount (not in rate_pct)

SELECT trigger_category, rate_is_threshold, rate_pct, threshold_amount
FROM   public.statutory_rules
WHERE  trigger_category = 'presumptive_tax_threshold'
  AND  effective_to IS NULL;

-- Expected: rate_is_threshold = true, rate_pct = NULL, threshold_amount = 200000000.00


-- V4. Confirm all new rows have verified_at = NULL
--     (guard: none of them should be available to the findings engine yet)

SELECT trigger_category, verified_at
FROM   public.statutory_rules
WHERE  trigger_category IN (
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
  AND  effective_from = '2026-07-01';

-- Expected: 9 rows, ALL with verified_at IS NULL.
-- If ANY row shows verified_at IS NOT NULL, the Bill-status guard has been
-- bypassed and that row is immediately usable by the findings engine.


-- ============================================================
-- SMOKE TESTS
-- Mirror the V1/V2 trigger pattern from migration 20260625140000.
-- Run as service_role in the SQL Editor.
--
-- These tests verify that the enforce_verified_statutory_rule
-- trigger correctly BLOCKS findings against all new rows
-- (verified_at = NULL) and that the block lifts correctly once
-- verified_at is set.
-- ============================================================


-- ── SMOKE A: V2 trigger correctly blocks findings against new goods rate ──
-- Attempts rule_trigger finding against unverified vat_withholding_goods row.
-- Must fail with V2 violation — verified_at IS NULL.

BEGIN;
INSERT INTO public.findings (
  company_id, statutory_rule_id, finding_type, title,
  period_start, period_end, exposure_amount_tzs, source_detail, created_by
)
SELECT
  gen_random_uuid(),                  -- fake company_id: trigger raises before FK check
  sr.id,
  'rule_trigger',
  'Smoke A — vat_withholding_goods 2026 unverified — must FAIL',
  '2026-07-01', '2026-09-30',
  0.00, '{"smoke_test": true}', auth.uid()
FROM public.statutory_rules sr
WHERE sr.trigger_category = 'vat_withholding_goods'
  AND sr.effective_from   = '2026-07-01'
  AND sr.verified_at      IS NULL
LIMIT 1;
ROLLBACK;
-- Expected: ERROR: V2 violation: statutory_rules row <uuid> has verified_at = NULL
-- Diagnostic fields must include: trigger_category: vat_withholding_goods,
--   effective_from: 2026-07-01, rate_pct: 15.0000


-- ── SMOKE B: V2 trigger correctly blocks findings against new services rate ──

BEGIN;
INSERT INTO public.findings (
  company_id, statutory_rule_id, finding_type, title,
  period_start, period_end, exposure_amount_tzs, source_detail, created_by
)
SELECT
  gen_random_uuid(),
  sr.id,
  'rule_trigger',
  'Smoke B — vat_withholding_services 2026 unverified — must FAIL',
  '2026-07-01', '2026-09-30',
  0.00, '{"smoke_test": true}', auth.uid()
FROM public.statutory_rules sr
WHERE sr.trigger_category = 'vat_withholding_services'
  AND sr.effective_from   = '2026-07-01'
  AND sr.verified_at      IS NULL
LIMIT 1;
ROLLBACK;
-- Expected: ERROR: V2 violation: ... rate_pct: 12.0000


-- ── SMOKE C: Verified_at gate lifts correctly when verification is recorded ──
-- Sets verified_at on the vat_withholding_goods row (simulated),
-- attempts a finding (must succeed past the trigger), then rolls back.
-- This confirms the trigger is not blocking indiscriminately.

BEGIN;

-- Simulate verification (this would normally be done by a staff member
-- after Presidential Assent is confirmed and the final Act is published).
UPDATE public.statutory_rules
SET
  verified_at = now(),
  verified_by = NULL    -- NULL is valid; a real deployment would pass a UUID
WHERE trigger_category = 'vat_withholding_goods'
  AND effective_from   = '2026-07-01'
  AND effective_to     IS NULL;

-- Now attempt the finding — trigger must not block (verified_at IS NOT NULL).
INSERT INTO public.findings (
  company_id, statutory_rule_id, finding_type, title,
  period_start, period_end, exposure_amount_tzs, source_detail, created_by
)
SELECT
  gen_random_uuid(),
  sr.id,
  'rule_trigger',
  'Smoke C — verified gate lifts — should reach FK error not trigger error',
  '2026-07-01', '2026-09-30',
  0.00, '{"smoke_test": true}', auth.uid()
FROM public.statutory_rules sr
WHERE sr.trigger_category = 'vat_withholding_goods'
  AND sr.effective_from   = '2026-07-01';

ROLLBACK;
-- Expected: NOT a V2 trigger error (23000).
-- Will fail with FK violation (23503) because company_id is a random UUID
-- with no matching row in companies.
-- Error code 23503 = trigger passed, FK rejected = gate lifted correctly.


-- ── SMOKE D: Old FA2025 goods rate row is CLOSED and unusable for new findings ──
-- Demonstrates that the superseded 3% row (effective_to = '2026-06-30')
-- is now a historical record, not an active rule.

SELECT
  trigger_category,
  rate_pct,
  effective_from,
  effective_to,
  verified_at
FROM public.statutory_rules
WHERE trigger_category = 'vat_withholding_goods'
ORDER BY effective_from;

-- Expected: 2 rows
--   row 1: rate_pct = 3.0000, effective_from = 2025-07-01, effective_to = 2026-06-30
--   row 2: rate_pct = 15.0000, effective_from = 2026-07-01, effective_to = NULL


-- ── SMOKE E: No new row violates uq_statutory_rule_active ──
-- Confirms the partial unique index has exactly one active row per category.

SELECT trigger_category, COUNT(*) as active_count
FROM   public.statutory_rules
WHERE  trigger_category IN (
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
  AND  effective_to IS NULL
GROUP  BY trigger_category
HAVING COUNT(*) <> 1;

-- Expected: 0 rows. Any row returned here is a duplicate-active-row violation
-- that must be resolved before the findings engine can use these categories.
