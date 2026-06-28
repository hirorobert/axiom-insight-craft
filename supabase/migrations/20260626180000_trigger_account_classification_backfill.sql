-- ============================================================
-- Migration: 20260626180000 — trigger_account_classification backfill (RD-5)
-- ============================================================
--
-- Context:
--   trigger_account_classification is typed as public.account_classification
--   (a PostgreSQL ENUM).  It is the key the findings engine Module B uses to
--   join statutory_rules to account_mappings:
--
--     JOIN account_mappings am
--       ON am.classification = sr.trigger_account_classification
--
--   Rules that fire on EFDMS records (VAT withholding, WHT on payments,
--   advisory thresholds) must have trigger_account_classification = NULL.
--   They are Module A / EFDMS-diff rules, not GL-account-matching rules.
--
-- Design decision encoded here:
--   Module B (rule_trigger) = fires when a company has a non-zero balance
--   in the matching GL account classification.
--   Module A (efdms_diff)   = fires when canonical EFDMS records differ from GL.
--   A rule belongs to at most one module.  The column encodes that choice.
--
-- Categories in DB (all jurisdictions, all effective dates):
--   From 20260625110000 (FA2025 seed):
--     sdl, vat_withholding_goods, vat_withholding_services,
--     vat_reduced_rate_electronic_b2c, wht_undistributed_earnings,
--     wht_hired_motor_vehicles, vat_registration_threshold,
--     cpa_certification_required_individual, cpa_certification_required_corporate
--   From 20260626150000 (FA2026):
--     vat_withholding_goods (new version, unverified),
--     vat_withholding_services (new version, unverified),
--     retained_earnings_deemed_distribution, stamp_duty
--   From 20260626160000 (FA2026 presumptive tax):
--     presumptive_tax_threshold, presumptive_tax_top_band_rate,
--     presumptive_tax_band1, presumptive_tax_band2_new_tin,
--     presumptive_tax_band3_compliant, presumptive_tax_band3_noncompliant,
--     presumptive_tax_band4_compliant, presumptive_tax_band4_noncompliant
--   SDL correction (inline): SDL corrected to 3.5%, effective 2023-07-01.
--     (same trigger_category = 'sdl'; no new category)
--
-- ── Module B rules: set trigger_account_classification ──────
--
--   sdl → operating_expenses
--     Payroll/salary accounts appear as operating expenses in account_mappings.
--     The engine sums all operating_expense-classified accounts to compute
--     the SDL base.  Known limitation (v1.0): operating_expenses includes
--     non-payroll costs (rent, utilities).  Module B must apply a secondary
--     filter (account name keywords or explicit payroll flag) to narrow
--     to salary-only accounts.  Flagged as Required Decision for Module B v1.1.
--
--   wht_undistributed_earnings → equity
--     Retained earnings / undistributed earnings live in equity on the
--     balance sheet.  The engine checks equity balances for deemed
--     distribution.  (FA2025 version of what FA2026 renamed to
--     retained_earnings_deemed_distribution.)
--
--   retained_earnings_deemed_distribution → equity
--     Same logic as wht_undistributed_earnings (FA2026 rename).
--
--   presumptive_tax_* → revenue
--     Presumptive tax is turnover-based.  Total turnover = sum of all
--     revenue-classified accounts in the trial balance.
--     Engine Module B multi-band logic:
--       1. Sum revenue accounts = total_turnover.
--       2. Check total_turnover ≤ presumptive_tax_threshold.threshold_amount.
--          If false → company is above presumptive regime → no presumptive finding.
--       3. If true → match the active band rule(s) for the turnover level.
--       4. Compute obligation per matching band rule (rate_pct / flat_tax_tzs).
--     All eight presumptive_tax_* rows share trigger_account_classification='revenue'
--     so the engine finds them all in one pass and handles the band logic internally.
--
--   vat_registration_threshold → revenue
--     Advisory finding: if total revenue > threshold (TZS 200M in 12 months),
--     company should be VAT-registered.  Not a tax computation; finding_type
--     should be 'manual' or a new advisory type in v2.0.  Set to 'revenue' so
--     the engine can compute whether the threshold is breached.
--
-- ── Module A rules: leave NULL ──────────────────────────────
--
--   vat_withholding_goods / vat_withholding_services
--     These fire on EFDMS purchase records when the company makes qualifying
--     payments.  The obligation is not computable from GL balances alone —
--     it requires the EFDMS canonical record of each individual payment.
--     trigger_account_classification = NULL.
--
--   vat_reduced_rate_electronic_b2c
--     Fires on EFDMS sales records at the reduced VAT rate.
--     trigger_account_classification = NULL.
--
--   wht_hired_motor_vehicles
--     Fires on payments to vehicle hire suppliers (EFDMS records).
--     trigger_account_classification = NULL.
--
-- ── Advisory / regulatory rules: leave NULL ─────────────────
--
--   cpa_certification_required_individual / _corporate
--     These are professional-requirement rules (audit sign-off requirements),
--     not tax computation rules.  No financial obligation is computed.
--     trigger_account_classification = NULL.
--
--   stamp_duty
--     Stamp duty is transaction-specific (rental agreements, share transfers,
--     loan documents) and cannot be reliably detected from a GL account
--     classification alone.  Engine logic is bespoke.
--     trigger_account_classification = NULL for now; flag for Module B v1.1.
--
-- ============================================================

BEGIN;

-- ── SDL ──────────────────────────────────────────────────────
-- All active and historical SDL rows (both 4.0% incorrect and 3.5% corrected).
-- The engine always reads the active (effective_to IS NULL) row; historical
-- rows carry the classification for audit trail completeness.
UPDATE public.statutory_rules
SET trigger_account_classification = 'operating_expenses'
WHERE trigger_category = 'sdl'
  AND jurisdiction = 'TZ';

-- ── Retained earnings / deemed distribution ───────────────────
-- FA2025: wht_undistributed_earnings
-- FA2026: retained_earnings_deemed_distribution (renamed category)
-- Both fire on equity account balances (retained earnings on the balance sheet).
UPDATE public.statutory_rules
SET trigger_account_classification = 'equity'
WHERE trigger_category IN (
  'wht_undistributed_earnings',
  'retained_earnings_deemed_distribution'
)
  AND jurisdiction = 'TZ';

-- ── Presumptive tax (all bands + threshold + top rate) ────────
-- All eight active presumptive_tax_* rows fire on revenue (turnover) accounts.
-- Engine handles multi-band logic internally — see design note above.
UPDATE public.statutory_rules
SET trigger_account_classification = 'revenue'
WHERE trigger_category IN (
  'presumptive_tax_threshold',
  'presumptive_tax_top_band_rate',
  'presumptive_tax_band1',
  'presumptive_tax_band2_new_tin',
  'presumptive_tax_band3_compliant',
  'presumptive_tax_band3_noncompliant',
  'presumptive_tax_band4_compliant',
  'presumptive_tax_band4_noncompliant'
)
  AND jurisdiction = 'TZ';

-- ── VAT registration threshold ────────────────────────────────
-- Advisory: check if revenue > TZS 200M in 12 months → should be VAT-registered.
UPDATE public.statutory_rules
SET trigger_account_classification = 'revenue'
WHERE trigger_category = 'vat_registration_threshold'
  AND jurisdiction = 'TZ';

-- ── NULL rules (explicitly documented — not a default, an active choice) ──
--
-- vat_withholding_goods:             Module A — EFDMS purchase records
-- vat_withholding_services:          Module A — EFDMS purchase records
-- vat_reduced_rate_electronic_b2c:   Module A — EFDMS sales records
-- wht_hired_motor_vehicles:          Module A — EFDMS payment records
-- cpa_certification_required_*:      Advisory — no financial obligation
-- stamp_duty:                        Bespoke — transaction-specific
--
-- No UPDATE needed — these are NULL by default (column default is NULL).
-- Explicit no-op: trigger_account_classification stays NULL for these categories.

-- ════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════

-- V1 — Primary gate: zero active rows should be unclassified among Module B rules.
-- An active row with NULL classification for an SDL / equity / revenue rule
-- means the engine cannot fire Module B for it.  Expected: 0 rows.
--
-- SELECT trigger_category, effective_from, effective_to, trigger_account_classification
-- FROM public.statutory_rules
-- WHERE trigger_category IN (
--     'sdl',
--     'wht_undistributed_earnings', 'retained_earnings_deemed_distribution',
--     'presumptive_tax_threshold', 'presumptive_tax_top_band_rate',
--     'presumptive_tax_band1', 'presumptive_tax_band2_new_tin',
--     'presumptive_tax_band3_compliant', 'presumptive_tax_band3_noncompliant',
--     'presumptive_tax_band4_compliant', 'presumptive_tax_band4_noncompliant',
--     'vat_registration_threshold'
-- )
-- AND trigger_account_classification IS NULL
-- ORDER BY trigger_category;
-- Expected: 0 rows

-- V2 — Confirm exact values set on active rows
-- SELECT trigger_category, trigger_account_classification
-- FROM public.statutory_rules
-- WHERE effective_to IS NULL
-- ORDER BY trigger_account_classification NULLS LAST, trigger_category;
-- Expected:
--   operating_expenses:  sdl
--   equity:              retained_earnings_deemed_distribution, wht_undistributed_earnings
--   revenue:             presumptive_tax_* (8 rows), vat_registration_threshold
--   NULL:                cpa_*, stamp_duty, vat_reduced_rate_electronic_b2c,
--                        vat_withholding_goods, vat_withholding_services,
--                        wht_hired_motor_vehicles

-- V3 — Confirm NO rows have an unknown trigger_category
-- (catches future category additions that were not backfilled here)
-- SELECT trigger_category, COUNT(*) AS rows,
--        BOOL_AND(trigger_account_classification IS NOT NULL) AS all_classified,
--        MAX(trigger_account_classification::TEXT) AS classification
-- FROM public.statutory_rules
-- WHERE effective_to IS NULL
-- GROUP BY trigger_category
-- ORDER BY trigger_category;
-- Review: any row where all_classified = false AND trigger_category not in the
-- expected NULL list above needs a decision.

-- V4 — Confirm RLS + trigger did not block any of the UPDATEs.
-- Run as service role (this migration runs as service role via Supabase CLI).
-- If running manually in SQL editor, wrap in:
--   SET ROLE service_role;  -- or use the Supabase SQL editor which runs as postgres

COMMIT;
