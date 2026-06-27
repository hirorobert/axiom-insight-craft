-- ============================================================
-- Migration: 20260626200000 — is_payroll_account flag on account_mappings
-- Date: 2026-06-26
-- Author: Axiom / Kinga engineering
--
-- CLOSES PRODUCTION BLOCKER OD-2 (SDL payroll base over-estimation).
--
-- PROBLEM:
--   The findings engine Module B computes SDL as:
--     3.5% × total(operating_expenses)
--   operating_expenses in processing_result contains ALL accounts
--   classified as operating_expenses: salaries, rent, electricity,
--   depreciation, NHIF, NSSF, WCF, SDL expense itself, and more.
--
--   For Kamanga Medics 2025:
--     Engine SDL base:   TZS 5,394,365,596 (all opex)
--     Engine SDL result: TZS 188,802,796
--     Actual SDL paid:   TZS 103,072,691   (correct — salaries only)
--     Over-estimation:   TZS  85,730,105   (83% over)
--
--   Additionally: SDL expense account (7104, TZS 103M) was INSIDE the
--   base, creating a circular SDL-on-SDL computation adding ~TZS 3.6M
--   phantom obligation.
--
-- FIX:
--   Add is_payroll_account BOOLEAN to account_mappings.
--   Set TRUE on accounts that represent gross emoluments:
--     → Salaries, Wages, Allowances
--     → Overtime, Extra Duty (if treated as emoluments)
--   Set FALSE (default) on:
--     → NHIF employer contribution (not an emolument)
--     → NSSF employer contribution (not an emolument)
--     → WCF contribution (not an emolument)
--     → SDL expense (levy — not an emolument; excluding it resolves the
--       circular SDL-on-SDL problem automatically)
--     → Rent, utilities, depreciation, all non-payroll costs
--
--   Engine Step C1c: for SDL rules, secondary query to account_mappings
--   WHERE is_payroll_account = true. Only those accounts form the base.
--   If no accounts are marked is_payroll_account = true, the engine
--   emits a configuration error (not a silent skip or a wrong finding).
--
-- LEGAL REFERENCE:
--   Tanzania Skills and Development Levy Act CAP 441 s.5(1):
--   SDL is charged on "gross emoluments paid to employees".
--   "Gross emoluments" = wages, salaries, leave pay, sick pay, and
--   the cash value of all other benefits paid to employees.
--   Employer NSSF/NHIF contributions, WCF, and SDL itself are NOT
--   emoluments — they are statutory employer obligations DERIVED from
--   the payroll, not paid TO employees.
--
-- PURELY ADDITIVE. No existing rows, policies, or triggers modified.
-- ============================================================

BEGIN;

ALTER TABLE public.account_mappings
  ADD COLUMN IF NOT EXISTS is_payroll_account BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.account_mappings.is_payroll_account IS
  'SDL base flag. Set TRUE for accounts representing gross emoluments '
  'paid to employees: salaries, wages, allowances, overtime, extra duty. '
  'SDL (CAP 441) = 3.5% x gross emoluments. '
  'Do NOT set TRUE on: NHIF, NSSF, WCF, SDL expense, rent, utilities, '
  'depreciation, or any other non-emolument operating expense. '
  'Used by kinga-findings-engine Step C1c to filter the SDL base. '
  'If no accounts are flagged, the engine emits a config error rather '
  'than computing SDL on the full operating_expenses total.';

COMMIT;


-- ════════════════════════════════════════════════════════════
-- VERIFICATION (run after applying)
-- ════════════════════════════════════════════════════════════

-- V1: Column exists
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'account_mappings'
--   AND column_name = 'is_payroll_account';
-- Expected: is_payroll_account | boolean | NO | false


-- ════════════════════════════════════════════════════════════
-- MARK PAYROLL ACCOUNTS — run per company after applying migration
--
-- For Kamanga Medics (user_id = 4321c7cc-89f7-4f18-bfdf-30b9626caf2f):
--   Only account 7101 (Salaries, Allowances & Wages) is gross emoluments.
--   Call & Extra Duty (7106): context-dependent. If it represents overtime
--   pay to employees it IS an emolument. Mark true if so.
--   NHIF/NSSF/WCF/SDL: DO NOT mark — they are statutory levies, not emoluments.
-- ════════════════════════════════════════════════════════════

-- UPDATE public.account_mappings
-- SET is_payroll_account = true
-- WHERE user_id = '4321c7cc-89f7-4f18-bfdf-30b9626caf2f'
--   AND account_code IN ('7101');   -- Salaries, Allowances & Wages only
-- Expected: UPDATE 1

-- -- If Call & Extra Duty is treated as gross emoluments for this company:
-- UPDATE public.account_mappings
-- SET is_payroll_account = true
-- WHERE user_id = '4321c7cc-89f7-4f18-bfdf-30b9626caf2f'
--   AND account_code = '7106';     -- Call & Extra Duty
-- Expected: UPDATE 1

-- V2: Confirm marks
-- SELECT account_code, account_name, is_payroll_account
-- FROM public.account_mappings
-- WHERE user_id = '4321c7cc-89f7-4f18-bfdf-30b9626caf2f'
--   AND classification = 'operating_expenses'
-- ORDER BY account_code;
-- Expected: 7101 = true, all others = false
