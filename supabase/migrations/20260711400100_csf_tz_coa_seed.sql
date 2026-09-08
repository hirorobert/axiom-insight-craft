-- ============================================================================
-- MAONO · csf_tz Chart of Accounts Vocabulary Seed · account_pl_mapping
--
-- Source: csf_tz v15.3.1 (GPL-3.0, ERPNext Tanzania localization, July 8 2026)
-- https://github.com/navariltd/CSF_TZ
--
-- These rules teach SAFISHA's P&L mapper the Tanzania-specific account naming
-- conventions used by Tanzanian businesses running ERPNext.
--
-- Pattern rules are applied AFTER range-based rules (priority 10–30) but
-- BEFORE generic word-stem fallbacks (priority 90).
-- csf_tz patterns use priority 80 — deliberate Tanzania-specific override.
--
-- source = 'csf_tz_coa' — used in audit queries to identify this origin.
--
-- IRON DOME constraints:
--   - INSERT ONLY. These rows are seeded once into GLOBAL scope
--     (company_id = NULL) — not tied to any specific company row.
--   - No rates, no statutory values, no tax computation logic here.
--   - On conflict (company_id, match_type, match_value): DO NOTHING — never
--     overwrite a firm's manually-set mappings.
--
-- pl_category values (the real 15-value account_pl_mapping enum, defined in
-- 20260711163040_9ec82b5f-ee11-45e7-942a-65f09f24dddf.sql and duplicated
-- verbatim in 20260711300000_maono_phase_a.sql):
--   REVENUE, COST_OF_SALES, OTHER_INCOME, PERSONNEL_COSTS, DEPRECIATION,
--   AMORTISATION, OTHER_OPEX, FINANCE_INCOME, FINANCE_COSTS, TAX_EXPENSE,
--   WITHHOLDING_TAX, BALANCE_SHEET_ASSET, BALANCE_SHEET_LIAB,
--   BALANCE_SHEET_EQUITY, STATISTICAL
-- ============================================================================

-- ── Insert csf_tz pattern seeds for the global (company_id = NULL) scope ──────
-- All patterns are case-insensitive ILIKE matches (match_type = 'pattern').
-- The match_value is stored as a simple substring (ILIKE '%value%' applied at
-- runtime by account_pl_mapping resolution logic).

-- NOTE on match_value format:
--   Stored without % wildcards — the resolution function wraps them.
--   match_type = 'pattern' means: account_name ILIKE '%' || match_value || '%'

DO $$
BEGIN
  -- ────────────────────────────────────────────────────────────────────────────
  -- SECTION 1: STATUTORY DEDUCTIONS / GOVERNMENT CONTRIBUTIONS
  -- Tanzania-specific employer contribution accounts from csf_tz
  -- ────────────────────────────────────────────────────────────────────────────

  -- NSSF — National Social Security Fund
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'nssf', 80, 'PERSONNEL_COSTS', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- PSSF — Public Service Social Security Fund (government employees)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'pssf', 80, 'PERSONNEL_COSTS', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- WCF — Workers Compensation Fund
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'wcf', 80, 'PERSONNEL_COSTS', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- LAPF — Local Authorities Provident Fund (government local authority workers)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'lapf', 80, 'PERSONNEL_COSTS', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- GEPF — Government Employees Provident Fund (parastatal)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'gepf', 80, 'PERSONNEL_COSTS', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- NHIF — National Health Insurance Fund
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'nhif', 80, 'PERSONNEL_COSTS', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- SDL — Skills Development Levy
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'sdl', 80, 'PERSONNEL_COSTS', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'skills development levy', 80, 'PERSONNEL_COSTS', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- PAYE — Pay As You Earn (employer payable account — balance sheet item)
  -- This is the PAYE payable account, not an expense — classify as current liability
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'paye payable', 80, 'BALANCE_SHEET_LIAB', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- PAYE expense (the cost borne by employer where applicable, e.g. directors)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'paye expense', 80, 'PERSONNEL_COSTS', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- ────────────────────────────────────────────────────────────────────────────
  -- SECTION 2: VAT AND WITHHOLDING TAX ACCOUNTS
  -- ────────────────────────────────────────────────────────────────────────────

  -- Output VAT (credit normal — liability to TRA)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'output vat', 80, 'BALANCE_SHEET_LIAB', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'vat payable', 80, 'BALANCE_SHEET_LIAB', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'kodi ya ongezeko la thamani', 80, 'BALANCE_SHEET_LIAB', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Input VAT (debit normal — receivable from TRA)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'input vat', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'vat receivable', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- WHT — Withholding Tax payable (csf_tz: "Withholding Tax Account")
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'withholding tax payable', 80, 'BALANCE_SHEET_LIAB', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'wht payable', 80, 'BALANCE_SHEET_LIAB', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'withholding tax', 80, 'BALANCE_SHEET_LIAB', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- TRA — Tanzania Revenue Authority (generic payment account)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'tra payable', 80, 'BALANCE_SHEET_LIAB', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- ────────────────────────────────────────────────────────────────────────────
  -- SECTION 3: MOBILE MONEY ACCOUNTS (Tanzania-specific banking)
  -- csf_tz has specific account types for mobile money float/wallets
  -- These are CASH equivalents — classify as current_assets
  -- ────────────────────────────────────────────────────────────────────────────

  -- M-Pesa (Vodacom Tanzania)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'm-pesa', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'mpesa', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Tigo Pesa (MIC Tanzania)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'tigo pesa', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'tigopesa', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Airtel Money (Airtel Tanzania)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'airtel money', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Halotel (Viettel Tanzania) — smaller operator but csf_tz covers it
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'halopesa', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- T-Pesa (TTCL)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 't-pesa', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Generic mobile money float
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'mobile money', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'pesa ya simu', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'e-float', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- ────────────────────────────────────────────────────────────────────────────
  -- SECTION 4: SWAHILI ACCOUNT NAME TERMS
  -- csf_tz accounts are often in Swahili — teach the mapper
  -- ────────────────────────────────────────────────────────────────────────────

  -- Revenue / Income
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'mapato', 80, 'REVENUE', TRUE, 'csf_tz_coa')  -- income/revenue
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'mauzo', 80, 'REVENUE', TRUE, 'csf_tz_coa')  -- sales
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'faida', 80, 'OTHER_INCOME', TRUE, 'csf_tz_coa')  -- profit/gain
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Expenses
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'gharama', 80, 'OTHER_OPEX', FALSE, 'csf_tz_coa')  -- expenses/costs
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'mishahara', 80, 'PERSONNEL_COSTS', FALSE, 'csf_tz_coa')  -- salaries
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'mshahara', 80, 'PERSONNEL_COSTS', FALSE, 'csf_tz_coa')  -- salary (singular)
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'posho', 80, 'PERSONNEL_COSTS', FALSE, 'csf_tz_coa')  -- allowance
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'pango', 80, 'OTHER_OPEX', FALSE, 'csf_tz_coa')  -- rent
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'umeme', 80, 'OTHER_OPEX', FALSE, 'csf_tz_coa')  -- electricity/TANESCO
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'maji', 80, 'OTHER_OPEX', FALSE, 'csf_tz_coa')  -- water
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'usafiri', 80, 'OTHER_OPEX', FALSE, 'csf_tz_coa')  -- travel/transport
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'uchakamavu', 80, 'DEPRECIATION', FALSE, 'csf_tz_coa')  -- depreciation
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Assets
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'fedha taslimu', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')  -- cash
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'akaunti ya benki', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')  -- bank account
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'wadai', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')  -- debtors/receivables
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'bidhaa', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')  -- inventory/stock
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'hisa', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')  -- stock/shares (context: inventory)
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'mali', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')  -- fixed assets
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Liabilities
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'madeni', 80, 'BALANCE_SHEET_LIAB', TRUE, 'csf_tz_coa')  -- creditors/payables
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'deni', 80, 'BALANCE_SHEET_LIAB', TRUE, 'csf_tz_coa')  -- debt (singular)
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'mkopo', 80, 'BALANCE_SHEET_LIAB', TRUE, 'csf_tz_coa')  -- loan
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Equity
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'mtaji', 80, 'BALANCE_SHEET_EQUITY', TRUE, 'csf_tz_coa')  -- capital
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'akiba ya faida', 80, 'BALANCE_SHEET_EQUITY', TRUE, 'csf_tz_coa')  -- retained earnings
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- ────────────────────────────────────────────────────────────────────────────
  -- SECTION 5: TANZANIAN BANK ACCOUNTS (csf_tz banking sector names)
  -- Common Tanzanian bank names that appear as account names in ERPNext
  -- ────────────────────────────────────────────────────────────────────────────

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'crdb', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'nmb bank', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'stanbic', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'equity bank', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'dtb tanzania', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'exim bank', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'kcb tanzania', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'absa bank', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'standard chartered', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'azania bank', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'tpb bank', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')  -- Tanzania Postal Bank
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'uchumi commercial', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')  -- microfinance
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- ────────────────────────────────────────────────────────────────────────────
  -- SECTION 6: EFDMS / EFD DEVICE ACCOUNTS (csf_tz EFD integration)
  -- Tanzanian EFD (Electronic Fiscal Device) creates specific account entries
  -- ────────────────────────────────────────────────────────────────────────────

  -- EFD Sales (EFD-receipted revenue)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'efd sales', 80, 'REVENUE', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'fiscal sales', 80, 'REVENUE', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Z-Report rounding/discrepancy account (small balance — ignore in P&L)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'z-report discrepancy', 80, 'STATISTICAL', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'efd difference', 80, 'STATISTICAL', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- ────────────────────────────────────────────────────────────────────────────
  -- SECTION 7: OTHER TANZANIA-SPECIFIC ACCOUNTS
  -- ────────────────────────────────────────────────────────────────────────────

  -- TANESCO — electricity utility (expense)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'tanesco', 80, 'OTHER_OPEX', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- DAWASA / DAWASCO — water utility (expense)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'dawasa', 80, 'OTHER_OPEX', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'dawasco', 80, 'OTHER_OPEX', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- TRA corporate income tax (balance sheet — current tax payable)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'income tax payable', 80, 'BALANCE_SHEET_LIAB', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'current tax payable', 80, 'BALANCE_SHEET_LIAB', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'kodi ya mapato', 80, 'BALANCE_SHEET_LIAB', TRUE, 'csf_tz_coa')  -- income tax (Swahili)
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Income tax expense (IS line — taxation)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'income tax expense', 80, 'TAX_EXPENSE', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'current tax charge', 80, 'TAX_EXPENSE', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Deferred tax (balance sheet)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'deferred tax liability', 80, 'BALANCE_SHEET_LIAB', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (NULL, 'pattern', 'deferred tax asset', 80, 'BALANCE_SHEET_ASSET', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  RAISE NOTICE 'csf_tz CoA vocabulary seeded into account_pl_mapping (global scope, company_id = NULL).';

END;
$$;

-- ── Index hint for priority-based resolution ──────────────────────────────────
-- Partial index to make pattern lookups for csf_tz source fast
CREATE INDEX IF NOT EXISTS idx_account_pl_mapping_csf_tz
  ON account_pl_mapping(company_id, match_priority, pl_category)
  WHERE source = 'csf_tz_coa';

-- ── Verification query (run after migration to confirm seed counts) ───────────
-- SELECT source, pl_category, COUNT(*) as rules
-- FROM account_pl_mapping
-- WHERE source = 'csf_tz_coa'
-- GROUP BY source, pl_category
-- ORDER BY pl_category;
