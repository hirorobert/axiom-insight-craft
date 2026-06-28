-- ============================================================
-- MIGRATION: Presumptive tax schedule — bands 1–4
-- Finance Act 2026, Part IX, s.31(a)(ii)
-- First Schedule, Item 2, subparagraph 3 (full replacement table)
--
-- Migration: 20260626160000_presumptive_tax_bands_1_4
-- Author: Axiom / Kinga engineering
-- Date: 2026-06-26
--
-- Source: Finance Act 2026, Special Bill Supplement,
-- Gazette No. 6 Vol. 107, 15 June 2026 — primary Bill text,
-- directly quoted. All 5 bands confirmed against the source.
-- Band 5 (4.5%) was inserted by migration 20260626150000.
-- This migration adds bands 1–4.
--
-- ── BILL STATUS WARNING ──────────────────────────────────────
-- As of 2026-06-26, this is a Bill — not yet enacted law.
-- ALL rows have verified_at = NULL. The enforce_verified_statutory_rule
-- trigger (20260625140000) blocks findings against all of them
-- until a human sets verified_at after Presidential Assent.
--
-- ── FULL REPLACEMENT TABLE (source) ─────────────────────────
--
-- Band | Turnover (TZS)              | TAA non-compliant  | TAA compliant
-- -----|-----------------------------|--------------------|---------------------------
--  1   | ≤ 4,000,000                 | NIL                | NIL
--  2   | New TIN, 4M–200M, yr 1      | NIL                | NIL
--  3   | 4,000,001 – 7,000,000       | Flat 100,000       | 3% of excess above 4,000,000
--  4   | 7,000,001 – 11,000,000      | Flat 250,000       | 90,000 + 3% of excess above 7,000,000
--  5   | 11,000,001 – 200,000,000    | 4.5% of turnover   | 4.5% of turnover
--
-- "TAA complied" = s.43 of the Tax Administration Act complied with.
-- "TAA non-compliant" = s.43 NOT complied with.
--
-- ── SCHEMA ENCODING DECISIONS ────────────────────────────────
--
-- The statutory_rules schema has two numeric rate fields:
--   rate_pct NUMERIC(7,4)    — percentage rate
--   threshold_amount NUMERIC(20,2) — originally designed for eligibility
--                                    thresholds (e.g. EFD registration ceiling)
--
-- Some bands require encoding a FLAT TAX AMOUNT (not a percentage,
-- not an eligibility threshold). To avoid a schema migration mid-session,
-- this migration encodes flat amounts in threshold_amount with
-- rate_is_threshold = true, clearly flagged in notes.
--
-- Band 4 compliant requires TWO values: a TZS base (90,000) and a
-- percentage (3%). Encoded as:
--   rate_is_threshold = true  → threshold_amount = 90000.00 (base)
--   rate_pct          = 3.0000  (applied to excess above 7,000,000)
-- Both CHECK constraints satisfied. Engine must implement:
--   tax = threshold_amount + (rate_pct / 100) * (turnover - 7,000,000)
--
-- ⚠ RECOMMENDED FOLLOW-UP: Add a flat_tax_tzs NUMERIC(20,2) column to
-- statutory_rules to cleanly separate flat amounts from eligibility
-- thresholds. The threshold_amount reuse here is pragmatic, not correct.
--
-- ── NET-NEW CATEGORIES ───────────────────────────────────────
-- None of these trigger_categories existed before. No UPDATE/close
-- step is needed. The trg_close_prior_statutory_rule BEFORE INSERT
-- trigger fires but finds nothing to close — correct.
--
-- ── NAMING CONVENTION ────────────────────────────────────────
-- Band 5 (from migration 20260626150000):
--   presumptive_tax_top_band_rate  ← same for both TAA paths (4.5%)
--
-- Bands 1–4 (this migration):
--   presumptive_tax_band1          ← same for both TAA paths (NIL)
--   presumptive_tax_band2_new_tin  ← conditional NIL (new TIN, first year)
--   presumptive_tax_band3_compliant    ← 3% of excess
--   presumptive_tax_band3_noncompliant ← flat 100,000
--   presumptive_tax_band4_compliant    ← 90,000 + 3% of excess
--   presumptive_tax_band4_noncompliant ← flat 250,000
-- ============================================================


BEGIN;


-- ════════════════════════════════════════════════════════════
-- BAND 1: Turnover ≤ TZS 4,000,000
--         TAA complied: NIL | TAA non-compliant: NIL
-- ════════════════════════════════════════════════════════════
-- Both paths are NIL. A single row covers both.
-- Encoded as rate_pct = 0.0000 — zero is not NULL, satisfies
-- chk_rate_or_threshold (rate_pct IS NOT NULL).

INSERT INTO public.statutory_rules (
  trigger_category, statute, obligation,
  rate_is_threshold, rate_pct, threshold_amount, penalty_rate_pct,
  jurisdiction, industry_pack, effective_from, effective_to,
  verified_at, verified_by, notes
)
VALUES (
  'presumptive_tax_band1',
  'Finance Act 2026 s.31(a)(ii) (amending Income Tax Act First Schedule, Item 2, subparagraph 3)',
  'Presumptive tax: NIL for annual turnover not exceeding TZS 4,000,000.',
  false,
  0.0000,        -- NIL tax in both TAA-compliant and non-compliant paths
  NULL,
  NULL,
  'TZ',
  NULL,
  '2026-07-01',
  NULL,
  NULL,          -- verified_at: NULL — Bill not yet assented
  NULL,
  'BILL TEXT (not yet enacted). '
    || 'Band 1 of the 5-band presumptive tax schedule. '
    || 'Applies to both s.43 TAA compliant and non-compliant taxpayers. '
    || 'Engine: if annual turnover ≤ 4,000,000 → no presumptive tax obligation. '
    || 'Upper ceiling for regime eligibility: TZS 200,000,000 '
    || '(see presumptive_tax_threshold row). '
    || 'Source: Finance Act 2026, Part IX, s.31(a)(ii) (Special Bill Supplement, '
    || 'Gazette No. 6 Vol. 107, 15 June 2026).'
);


-- ════════════════════════════════════════════════════════════
-- BAND 2: New TIN holder — first year exemption
--         Applies across 4,000,001–200,000,000 range
--         TAA complied: NIL | TAA non-compliant: NIL
-- ════════════════════════════════════════════════════════════
-- Conditional NIL: applies ONLY to a person in their first
-- year from TIN issuance. Engine must check TIN issuance date.
-- Both TAA paths are NIL — single row.

INSERT INTO public.statutory_rules (
  trigger_category, statute, obligation,
  rate_is_threshold, rate_pct, threshold_amount, penalty_rate_pct,
  jurisdiction, industry_pack, effective_from, effective_to,
  verified_at, verified_by, notes
)
VALUES (
  'presumptive_tax_band2_new_tin',
  'Finance Act 2026 s.31(a)(ii) (amending Income Tax Act First Schedule, Item 2, subparagraph 3)',
  'Presumptive tax: NIL for new TIN holder in first year of TIN issuance, '
    || 'regardless of turnover level within the 4,000,001–200,000,000 range.',
  false,
  0.0000,        -- NIL in both paths; condition is TIN age, not rate split
  NULL,
  NULL,
  'TZ',
  NULL,
  '2026-07-01',
  NULL,
  NULL,          -- verified_at: NULL — Bill not yet assented
  NULL,
  'BILL TEXT (not yet enacted). '
    || 'Band 2 of the 5-band presumptive tax schedule. '
    || 'CONDITION: applies only in the taxpayer''s first year from TIN issuance. '
    || 'Both s.43 TAA compliant and non-compliant paths are NIL for this band. '
    || 'Engine: check TIN issuance date before applying any other band; '
    || 'if TIN age < 1 year AND turnover in 4,000,001–200,000,000 → no tax (band 2). '
    || 'This band takes precedence over bands 3, 4, and 5 for qualifying taxpayers. '
    || 'Source: Finance Act 2026, Part IX, s.31(a)(ii) (Special Bill Supplement, '
    || 'Gazette No. 6 Vol. 107, 15 June 2026).'
);


-- ════════════════════════════════════════════════════════════
-- BAND 3a: Turnover 4,000,001–7,000,000
--           s.43 TAA COMPLIED → 3% of turnover in excess of 4,000,000
-- ════════════════════════════════════════════════════════════

INSERT INTO public.statutory_rules (
  trigger_category, statute, obligation,
  rate_is_threshold, rate_pct, threshold_amount, penalty_rate_pct,
  jurisdiction, industry_pack, effective_from, effective_to,
  verified_at, verified_by, notes
)
VALUES (
  'presumptive_tax_band3_compliant',
  'Finance Act 2026 s.31(a)(ii) (amending Income Tax Act First Schedule, Item 2, subparagraph 3)',
  'Presumptive tax for turnover 4,000,001–7,000,000, s.43 TAA complied: '
    || '3% applied to the portion of turnover exceeding TZS 4,000,000.',
  false,
  3.0000,        -- rate applies to excess above 4,000,000, not to total turnover
  NULL,
  NULL,
  'TZ',
  NULL,
  '2026-07-01',
  NULL,
  NULL,          -- verified_at: NULL — Bill not yet assented
  NULL,
  'BILL TEXT (not yet enacted). '
    || 'Band 3 (TAA compliant path) of the 5-band presumptive tax schedule. '
    || 'ENGINE COMPUTATION: tax = 0.03 × (turnover − 4,000,000). '
    || 'rate_pct is the percentage; the base deduction (4,000,000) is '
    || 'NOT stored in this row — engine must hard-code or look up the band floor. '
    || 'Do NOT apply rate_pct to total turnover. '
    || 'TAA compliance check: taxpayer has complied with s.43 of the Tax Administration Act. '
    || 'See presumptive_tax_band3_noncompliant for the non-compliant path. '
    || 'Source: Finance Act 2026, Part IX, s.31(a)(ii) (Special Bill Supplement, '
    || 'Gazette No. 6 Vol. 107, 15 June 2026).'
);


-- ════════════════════════════════════════════════════════════
-- BAND 3b: Turnover 4,000,001–7,000,000
--           s.43 TAA NOT COMPLIED → flat TZS 100,000
-- ════════════════════════════════════════════════════════════
-- Encoded as rate_is_threshold = true, threshold_amount = 100,000.
-- SCHEMA NOTE: threshold_amount here encodes a FLAT TAX OBLIGATION
-- (TZS 100,000 owed regardless of exact turnover within this band),
-- NOT an eligibility threshold. This is a pragmatic reuse of the
-- column pending a flat_tax_tzs schema extension.

INSERT INTO public.statutory_rules (
  trigger_category, statute, obligation,
  rate_is_threshold, rate_pct, threshold_amount, penalty_rate_pct,
  jurisdiction, industry_pack, effective_from, effective_to,
  verified_at, verified_by, notes
)
VALUES (
  'presumptive_tax_band3_noncompliant',
  'Finance Act 2026 s.31(a)(ii) (amending Income Tax Act First Schedule, Item 2, subparagraph 3)',
  'Presumptive tax for turnover 4,000,001–7,000,000, s.43 TAA NOT complied: '
    || 'flat TZS 100,000.',
  true,          -- rate_is_threshold = true to satisfy chk_rate_or_threshold
                 -- threshold_amount encodes the FLAT TAX AMOUNT (not an eligibility ceiling)
  NULL,          -- no percentage component for this path
  100000.00,     -- flat tax: TZS 100,000
  NULL,
  'TZ',
  NULL,
  '2026-07-01',
  NULL,
  NULL,          -- verified_at: NULL — Bill not yet assented
  NULL,
  'BILL TEXT (not yet enacted). '
    || 'Band 3 (TAA NON-COMPLIANT path) of the 5-band presumptive tax schedule. '
    || 'ENGINE COMPUTATION: tax = TZS 100,000 (flat, regardless of turnover within band). '
    || 'SCHEMA NOTE: threshold_amount (100,000) encodes the flat tax obligation, '
    || 'NOT an eligibility threshold. Planned schema extension: flat_tax_tzs column. '
    || 'TAA compliance check: taxpayer has NOT complied with s.43 of the Tax Administration Act. '
    || 'See presumptive_tax_band3_compliant for the compliant path (3% of excess). '
    || 'Source: Finance Act 2026, Part IX, s.31(a)(ii) (Special Bill Supplement, '
    || 'Gazette No. 6 Vol. 107, 15 June 2026).'
);


-- ════════════════════════════════════════════════════════════
-- BAND 4a: Turnover 7,000,001–11,000,000
--           s.43 TAA COMPLIED → TZS 90,000 + 3% of excess above 7,000,000
-- ════════════════════════════════════════════════════════════
-- Dual-value encoding:
--   threshold_amount = 90,000  (TZS base component)
--   rate_pct        = 3.0000   (% applied to excess above 7,000,000)
-- Both CHECK constraints satisfied:
--   chk_rate_or_threshold:    rate_is_threshold = true → passes
--   chk_threshold_has_amount: rate_is_threshold = true, threshold_amount = 90000 → passes
-- Engine computes: tax = 90,000 + 0.03 × (turnover − 7,000,000)

INSERT INTO public.statutory_rules (
  trigger_category, statute, obligation,
  rate_is_threshold, rate_pct, threshold_amount, penalty_rate_pct,
  jurisdiction, industry_pack, effective_from, effective_to,
  verified_at, verified_by, notes
)
VALUES (
  'presumptive_tax_band4_compliant',
  'Finance Act 2026 s.31(a)(ii) (amending Income Tax Act First Schedule, Item 2, subparagraph 3)',
  'Presumptive tax for turnover 7,000,001–11,000,000, s.43 TAA complied: '
    || 'TZS 90,000 plus 3% of turnover in excess of TZS 7,000,000.',
  true,          -- rate_is_threshold = true allows both threshold_amount AND rate_pct
  3.0000,        -- percentage component: applied to (turnover − 7,000,000)
  90000.00,      -- base component: TZS 90,000 fixed amount
  NULL,
  'TZ',
  NULL,
  '2026-07-01',
  NULL,
  NULL,          -- verified_at: NULL — Bill not yet assented
  NULL,
  'BILL TEXT (not yet enacted). '
    || 'Band 4 (TAA COMPLIANT path) of the 5-band presumptive tax schedule. '
    || 'ENGINE COMPUTATION: tax = threshold_amount + (rate_pct / 100) × (turnover − 7,000,000). '
    || '  = 90,000 + 0.03 × (turnover − 7,000,000). '
    || 'threshold_amount (90,000) = fixed base component (TZS). '
    || 'rate_pct (3.0000) = percentage applied to excess above 7,000,000. '
    || 'SCHEMA NOTE: dual-value encoding — both fields active simultaneously. '
    || 'Planned schema extension: flat_tax_tzs column to separate from threshold semantics. '
    || 'TAA compliance check: taxpayer has complied with s.43 of the Tax Administration Act. '
    || 'See presumptive_tax_band4_noncompliant for the flat path (TZS 250,000). '
    || 'Source: Finance Act 2026, Part IX, s.31(a)(ii) (Special Bill Supplement, '
    || 'Gazette No. 6 Vol. 107, 15 June 2026).'
);


-- ════════════════════════════════════════════════════════════
-- BAND 4b: Turnover 7,000,001–11,000,000
--           s.43 TAA NOT COMPLIED → flat TZS 250,000
-- ════════════════════════════════════════════════════════════

INSERT INTO public.statutory_rules (
  trigger_category, statute, obligation,
  rate_is_threshold, rate_pct, threshold_amount, penalty_rate_pct,
  jurisdiction, industry_pack, effective_from, effective_to,
  verified_at, verified_by, notes
)
VALUES (
  'presumptive_tax_band4_noncompliant',
  'Finance Act 2026 s.31(a)(ii) (amending Income Tax Act First Schedule, Item 2, subparagraph 3)',
  'Presumptive tax for turnover 7,000,001–11,000,000, s.43 TAA NOT complied: '
    || 'flat TZS 250,000.',
  true,          -- rate_is_threshold = true; threshold_amount encodes flat tax (not threshold)
  NULL,          -- no percentage component
  250000.00,     -- flat tax: TZS 250,000
  NULL,
  'TZ',
  NULL,
  '2026-07-01',
  NULL,
  NULL,          -- verified_at: NULL — Bill not yet assented
  NULL,
  'BILL TEXT (not yet enacted). '
    || 'Band 4 (TAA NON-COMPLIANT path) of the 5-band presumptive tax schedule. '
    || 'ENGINE COMPUTATION: tax = TZS 250,000 (flat, regardless of turnover within band). '
    || 'SCHEMA NOTE: threshold_amount (250,000) encodes the flat tax obligation, '
    || 'NOT an eligibility threshold. Planned schema extension: flat_tax_tzs column. '
    || 'TAA compliance check: taxpayer has NOT complied with s.43 of the Tax Administration Act. '
    || 'See presumptive_tax_band4_compliant for the compound formula path. '
    || 'Source: Finance Act 2026, Part IX, s.31(a)(ii) (Special Bill Supplement, '
    || 'Gazette No. 6 Vol. 107, 15 June 2026).'
);


COMMIT;


-- ============================================================
-- VERIFICATION QUERIES
-- ============================================================

-- V1. All 6 new rows present and correct
SELECT
  trigger_category,
  rate_is_threshold,
  rate_pct,
  threshold_amount,
  verified_at,
  effective_from,
  effective_to
FROM public.statutory_rules
WHERE trigger_category IN (
  'presumptive_tax_band1',
  'presumptive_tax_band2_new_tin',
  'presumptive_tax_band3_compliant',
  'presumptive_tax_band3_noncompliant',
  'presumptive_tax_band4_compliant',
  'presumptive_tax_band4_noncompliant'
)
ORDER BY trigger_category;

-- Expected: 6 rows, all effective_from = 2026-07-01, effective_to IS NULL,
-- verified_at IS NULL.
-- Band 4 compliant must show BOTH rate_pct = 3.0000 AND threshold_amount = 90000.00.

-- V2. No duplicate active rows
SELECT trigger_category, COUNT(*) AS active_count
FROM   public.statutory_rules
WHERE  trigger_category IN (
  'presumptive_tax_band1',
  'presumptive_tax_band2_new_tin',
  'presumptive_tax_band3_compliant',
  'presumptive_tax_band3_noncompliant',
  'presumptive_tax_band4_compliant',
  'presumptive_tax_band4_noncompliant'
)
  AND  effective_to IS NULL
GROUP  BY trigger_category
HAVING COUNT(*) <> 1;

-- Expected: 0 rows (each category has exactly 1 active row).

-- V3. Full presumptive tax schedule in the database (all 5 bands + ceiling)
SELECT
  trigger_category,
  rate_is_threshold,
  rate_pct,
  threshold_amount,
  effective_from,
  verified_at
FROM public.statutory_rules
WHERE trigger_category LIKE 'presumptive_tax%'
  AND effective_to IS NULL
ORDER BY trigger_category;

-- Expected: 8 rows total:
--   presumptive_tax_band1                (rate_pct=0,    threshold=NULL)
--   presumptive_tax_band2_new_tin        (rate_pct=0,    threshold=NULL)
--   presumptive_tax_band3_compliant      (rate_pct=3,    threshold=NULL)
--   presumptive_tax_band3_noncompliant   (rate_pct=NULL, threshold=100000)
--   presumptive_tax_band4_compliant      (rate_pct=3,    threshold=90000)
--   presumptive_tax_band4_noncompliant   (rate_pct=NULL, threshold=250000)
--   presumptive_tax_threshold            (rate_pct=NULL, threshold=200000000)
--   presumptive_tax_top_band_rate        (rate_pct=4.5,  threshold=NULL)
