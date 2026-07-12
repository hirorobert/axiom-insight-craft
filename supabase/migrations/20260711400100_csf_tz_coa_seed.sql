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
--   - INSERT ONLY. These rows are seeded once into saff_default company scope.
--   - No rates, no statutory values, no tax computation logic here.
--   - On conflict (company_id, match_type, match_value): DO NOTHING — never
--     overwrite a firm's manually-set mappings.
--
-- pl_category values (all 15 valid per 20260711300000_maono_phase_a.sql):
--   revenue, cost_of_goods_sold, gross_profit (computed),
--   operating_expenses, depreciation_amortisation, employee_costs,
--   finance_costs, other_income, taxation,
--   current_assets, non_current_assets, current_liabilities,
--   non_current_liabilities, equity, ignore
-- ============================================================================

-- ── Insert csf_tz pattern seeds for the saff_default company scope ────────────
-- All patterns are case-insensitive ILIKE matches (match_type = 'pattern').
-- The match_value is stored as a simple substring (ILIKE '%value%' applied at
-- runtime by account_pl_mapping resolution logic).

-- NOTE on match_value format:
--   Stored without % wildcards — the resolution function wraps them.
--   match_type = 'pattern' means: account_name ILIKE '%' || match_value || '%'

DO $$
DECLARE
  v_company UUID;
BEGIN
  -- Resolve the saff_default company
  SELECT id INTO v_company
  FROM companies
  WHERE slug = 'saff_default'
  LIMIT 1;

  IF v_company IS NULL THEN
    RAISE NOTICE 'saff_default company not found — csf_tz CoA seed skipped.';
    RETURN;
  END IF;

  -- ────────────────────────────────────────────────────────────────────────────
  -- SECTION 1: STATUTORY DEDUCTIONS / GOVERNMENT CONTRIBUTIONS
  -- Tanzania-specific employer contribution accounts from csf_tz
  -- ────────────────────────────────────────────────────────────────────────────

  -- NSSF — National Social Security Fund
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'nssf', 80, 'employee_costs', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- PSSF — Public Service Social Security Fund (government employees)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'pssf', 80, 'employee_costs', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- WCF — Workers Compensation Fund
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'wcf', 80, 'employee_costs', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- LAPF — Local Authorities Provident Fund (government local authority workers)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'lapf', 80, 'employee_costs', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- GEPF — Government Employees Provident Fund (parastatal)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'gepf', 80, 'employee_costs', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- NHIF — National Health Insurance Fund
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'nhif', 80, 'employee_costs', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- SDL — Skills Development Levy
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'sdl', 80, 'employee_costs', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'skills development levy', 80, 'employee_costs', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- PAYE — Pay As You Earn (employer payable account — balance sheet item)
  -- This is the PAYE payable account, not an expense — classify as current liability
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'paye payable', 80, 'current_liabilities', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- PAYE expense (the cost borne by employer where applicable, e.g. directors)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'paye expense', 80, 'employee_costs', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- ────────────────────────────────────────────────────────────────────────────
  -- SECTION 2: VAT AND WITHHOLDING TAX ACCOUNTS
  -- ────────────────────────────────────────────────────────────────────────────

  -- Output VAT (credit normal — liability to TRA)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'output vat', 80, 'current_liabilities', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'vat payable', 80, 'current_liabilities', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'kodi ya ongezeko la thamani', 80, 'current_liabilities', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Input VAT (debit normal — receivable from TRA)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'input vat', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'vat receivable', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- WHT — Withholding Tax payable (csf_tz: "Withholding Tax Account")
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'withholding tax payable', 80, 'current_liabilities', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'wht payable', 80, 'current_liabilities', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'withholding tax', 80, 'current_liabilities', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- TRA — Tanzania Revenue Authority (generic payment account)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'tra payable', 80, 'current_liabilities', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- ────────────────────────────────────────────────────────────────────────────
  -- SECTION 3: MOBILE MONEY ACCOUNTS (Tanzania-specific banking)
  -- csf_tz has specific account types for mobile money float/wallets
  -- These are CASH equivalents — classify as current_assets
  -- ────────────────────────────────────────────────────────────────────────────

  -- M-Pesa (Vodacom Tanzania)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'm-pesa', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'mpesa', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Tigo Pesa (MIC Tanzania)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'tigo pesa', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'tigopesa', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Airtel Money (Airtel Tanzania)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'airtel money', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Halotel (Viettel Tanzania) — smaller operator but csf_tz covers it
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'halopesa', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- T-Pesa (TTCL)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 't-pesa', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Generic mobile money float
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'mobile money', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'pesa ya simu', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'e-float', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- ────────────────────────────────────────────────────────────────────────────
  -- SECTION 4: SWAHILI ACCOUNT NAME TERMS
  -- csf_tz accounts are often in Swahili — teach the mapper
  -- ────────────────────────────────────────────────────────────────────────────

  -- Revenue / Income
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'mapato', 80, 'revenue', TRUE, 'csf_tz_coa')  -- income/revenue
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'mauzo', 80, 'revenue', TRUE, 'csf_tz_coa')  -- sales
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'faida', 80, 'other_income', TRUE, 'csf_tz_coa')  -- profit/gain
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Expenses
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'gharama', 80, 'operating_expenses', FALSE, 'csf_tz_coa')  -- expenses/costs
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'mishahara', 80, 'employee_costs', FALSE, 'csf_tz_coa')  -- salaries
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'mshahara', 80, 'employee_costs', FALSE, 'csf_tz_coa')  -- salary (singular)
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'posho', 80, 'employee_costs', FALSE, 'csf_tz_coa')  -- allowance
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'pango', 80, 'operating_expenses', FALSE, 'csf_tz_coa')  -- rent
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'umeme', 80, 'operating_expenses', FALSE, 'csf_tz_coa')  -- electricity/TANESCO
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'maji', 80, 'operating_expenses', FALSE, 'csf_tz_coa')  -- water
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'usafiri', 80, 'operating_expenses', FALSE, 'csf_tz_coa')  -- travel/transport
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'uchakamavu', 80, 'depreciation_amortisation', FALSE, 'csf_tz_coa')  -- depreciation
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Assets
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'fedha taslimu', 80, 'current_assets', FALSE, 'csf_tz_coa')  -- cash
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'akaunti ya benki', 80, 'current_assets', FALSE, 'csf_tz_coa')  -- bank account
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'wadai', 80, 'current_assets', FALSE, 'csf_tz_coa')  -- debtors/receivables
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'bidhaa', 80, 'current_assets', FALSE, 'csf_tz_coa')  -- inventory/stock
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'hisa', 80, 'current_assets', FALSE, 'csf_tz_coa')  -- stock/shares (context: inventory)
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'mali', 80, 'non_current_assets', FALSE, 'csf_tz_coa')  -- fixed assets
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Liabilities
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'madeni', 80, 'current_liabilities', TRUE, 'csf_tz_coa')  -- creditors/payables
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'deni', 80, 'current_liabilities', TRUE, 'csf_tz_coa')  -- debt (singular)
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'mkopo', 80, 'non_current_liabilities', TRUE, 'csf_tz_coa')  -- loan
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Equity
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'mtaji', 80, 'equity', TRUE, 'csf_tz_coa')  -- capital
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'akiba ya faida', 80, 'equity', TRUE, 'csf_tz_coa')  -- retained earnings
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- ────────────────────────────────────────────────────────────────────────────
  -- SECTION 5: TANZANIAN BANK ACCOUNTS (csf_tz banking sector names)
  -- Common Tanzanian bank names that appear as account names in ERPNext
  -- ────────────────────────────────────────────────────────────────────────────

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'crdb', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'nmb bank', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'stanbic', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'equity bank', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'dtb tanzania', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'exim bank', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'kcb tanzania', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'absa bank', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'standard chartered', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'azania bank', 80, 'current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'tpb bank', 80, 'current_assets', FALSE, 'csf_tz_coa')  -- Tanzania Postal Bank
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'uchumi commercial', 80, 'current_assets', FALSE, 'csf_tz_coa')  -- microfinance
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- ────────────────────────────────────────────────────────────────────────────
  -- SECTION 6: EFDMS / EFD DEVICE ACCOUNTS (csf_tz EFD integration)
  -- Tanzanian EFD (Electronic Fiscal Device) creates specific account entries
  -- ────────────────────────────────────────────────────────────────────────────

  -- EFD Sales (EFD-receipted revenue)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'efd sales', 80, 'revenue', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'fiscal sales', 80, 'revenue', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Z-Report rounding/discrepancy account (small balance — ignore in P&L)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'z-report discrepancy', 80, 'ignore', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'efd difference', 80, 'ignore', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- ────────────────────────────────────────────────────────────────────────────
  -- SECTION 7: OTHER TANZANIA-SPECIFIC ACCOUNTS
  -- ────────────────────────────────────────────────────────────────────────────

  -- TANESCO — electricity utility (expense)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'tanesco', 80, 'operating_expenses', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- DAWASA / DAWASCO — water utility (expense)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'dawasa', 80, 'operating_expenses', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'dawasco', 80, 'operating_expenses', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- TRA corporate income tax (balance sheet — current tax payable)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'income tax payable', 80, 'current_liabilities', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'current tax payable', 80, 'current_liabilities', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'kodi ya mapato', 80, 'current_liabilities', TRUE, 'csf_tz_coa')  -- income tax (Swahili)
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Income tax expense (IS line — taxation)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'income tax expense', 80, 'taxation', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'current tax charge', 80, 'taxation', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  -- Deferred tax (balance sheet)
  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'deferred tax liability', 80, 'non_current_liabilities', TRUE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  INSERT INTO account_pl_mapping (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
  VALUES (v_company, 'pattern', 'deferred tax asset', 80, 'non_current_assets', FALSE, 'csf_tz_coa')
  ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

  RAISE NOTICE 'csf_tz CoA vocabulary seeded into account_pl_mapping for company %.', v_company;

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
