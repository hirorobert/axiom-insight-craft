-- ============================================================================
-- XBRL Concept Map Seed · IFRS Taxonomy 2023
--
-- Seeds xbrl_concept_map with the exact IFRS Taxonomy element names for:
--   (A) IFRS for SMEs 2023  — namespace: http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes
--   (B) Full IFRS 2023      — namespace: http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full
--
-- Sources:
--   IFRS for SMEs Taxonomy 2023 — https://www.ifrs.org/issued-standards/ifrs-taxonomy/
--   IFRS Full Taxonomy 2023     — https://www.ifrs.org/issued-standards/ifrs-taxonomy/
--   Both downloaded free from IFRS Foundation.
--
-- Element names verified against the official taxonomy label linkbases.
-- Balance directions verified against the taxonomy schema (xsd) files.
-- Period types verified against the taxonomy schema context definitions.
--
-- IRON DOME:
--   ON CONFLICT DO NOTHING — never overwrites if row already exists.
--   taxonomy_version pinned to '2023-01-01'.
--   'ignore' pl_category has no XBRL concept — correctly omitted from output.
--   'gross_profit' is a computed element in both taxonomies — tagged as credit/duration.
-- ============================================================================

-- ── A. IFRS for SMEs 2023 ────────────────────────────────────────────────────

-- INCOME STATEMENT ELEMENTS (duration — apply over the reporting period)

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('ifrs_for_smes', 'revenue',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes',
   'ifrs-smes', 'Revenue', 'credit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('ifrs_for_smes', 'cost_of_goods_sold',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes',
   'ifrs-smes', 'CostOfSales', 'debit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('ifrs_for_smes', 'gross_profit',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes',
   'ifrs-smes', 'GrossProfit', 'credit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('ifrs_for_smes', 'other_income',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes',
   'ifrs-smes', 'OtherIncome', 'credit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('ifrs_for_smes', 'employee_costs',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes',
   'ifrs-smes', 'EmployeeBenefitsExpense', 'debit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('ifrs_for_smes', 'depreciation_amortisation',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes',
   'ifrs-smes', 'DepreciationAndAmortisationExpense', 'debit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('ifrs_for_smes', 'operating_expenses',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes',
   'ifrs-smes', 'OtherExpense', 'debit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('ifrs_for_smes', 'finance_costs',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes',
   'ifrs-smes', 'FinanceCosts', 'debit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('ifrs_for_smes', 'taxation',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes',
   'ifrs-smes', 'IncomeTaxExpenseContinuingOperations', 'debit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

-- BALANCE SHEET ELEMENTS (instant — apply at the balance date)

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('ifrs_for_smes', 'current_assets',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes',
   'ifrs-smes', 'CurrentAssets', 'debit', 'instant', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('ifrs_for_smes', 'non_current_assets',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes',
   'ifrs-smes', 'NoncurrentAssets', 'debit', 'instant', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('ifrs_for_smes', 'current_liabilities',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes',
   'ifrs-smes', 'CurrentLiabilities', 'credit', 'instant', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('ifrs_for_smes', 'non_current_liabilities',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes',
   'ifrs-smes', 'NoncurrentLiabilities', 'credit', 'instant', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('ifrs_for_smes', 'equity',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes',
   'ifrs-smes', 'Equity', 'credit', 'instant', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

-- 'ignore' pl_category intentionally omitted — no XBRL concept.

-- ── B. Full IFRS 2023 ─────────────────────────────────────────────────────────

-- INCOME STATEMENT

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('full_ifrs', 'revenue',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full',
   'ifrs-full', 'Revenue', 'credit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('full_ifrs', 'cost_of_goods_sold',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full',
   'ifrs-full', 'CostOfSales', 'debit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('full_ifrs', 'gross_profit',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full',
   'ifrs-full', 'GrossProfit', 'credit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('full_ifrs', 'other_income',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full',
   'ifrs-full', 'OtherIncome', 'credit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('full_ifrs', 'employee_costs',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full',
   'ifrs-full', 'EmployeeBenefitsExpense', 'debit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('full_ifrs', 'depreciation_amortisation',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full',
   'ifrs-full', 'DepreciationAndAmortisationExpense', 'debit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('full_ifrs', 'operating_expenses',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full',
   'ifrs-full', 'OtherOperatingExpense', 'debit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('full_ifrs', 'finance_costs',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full',
   'ifrs-full', 'FinanceCosts', 'debit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('full_ifrs', 'taxation',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full',
   'ifrs-full', 'IncomeTaxExpenseContinuingOperations', 'debit', 'duration', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

-- BALANCE SHEET

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('full_ifrs', 'current_assets',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full',
   'ifrs-full', 'CurrentAssets', 'debit', 'instant', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('full_ifrs', 'non_current_assets',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full',
   'ifrs-full', 'NoncurrentAssets', 'debit', 'instant', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('full_ifrs', 'current_liabilities',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full',
   'ifrs-full', 'CurrentLiabilities', 'credit', 'instant', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('full_ifrs', 'non_current_liabilities',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full',
   'ifrs-full', 'NoncurrentLiabilities', 'credit', 'instant', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

INSERT INTO xbrl_concept_map
  (reporting_framework, pl_category, xbrl_namespace, xbrl_prefix, xbrl_concept, xbrl_balance, xbrl_period_type, taxonomy_version)
VALUES
  ('full_ifrs', 'equity',
   'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full',
   'ifrs-full', 'Equity', 'credit', 'instant', '2023-01-01')
ON CONFLICT (reporting_framework, pl_category) DO NOTHING;

-- ── Verification query (run after migration) ──────────────────────────────────
-- SELECT reporting_framework, pl_category, xbrl_prefix || ':' || xbrl_concept as tagged_concept,
--        xbrl_balance, xbrl_period_type
-- FROM xbrl_concept_map
-- ORDER BY reporting_framework, xbrl_period_type DESC, pl_category;
--
-- Expected: 28 rows total (14 per framework × 2 frameworks), 'ignore' omitted.
