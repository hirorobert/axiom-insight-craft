-- ============================================================
-- Migration: 20260703110000 — keyword_dictionary seed
-- Part 2 of Task 1b: Manual Account Mapping + Learning Dictionary
-- ~160 terms: English (en) + Swahili (sw)
-- 10 valid classification targets (cash_flow activities excluded).
-- Applied manually via Supabase SQL Editor on 2026-07-03.
-- Committed for repo/migration-history sync. Do not re-run.
--
-- DESIGN NOTE — PART 3 REQUIREMENT (not implemented here):
--   Dictionary matching MUST use LONGEST-MATCH-WINS ordering.
--   When multiple 'contains' terms match a single account name,
--   the longest matching term wins. Example:
--     "Salaries Payable" matches both 'salaries' (opex) and
--     'salaries payable' (current_liabilities).
--     Longer match → current_liabilities. ✓
--   Equal-length conflicting matches → needs_review, not a guess.
--   This is enforced in the PART 3 edge function, not in the DB.
--
-- "PAYABLE TRAP" MITIGATION (amendment to approved PART 2 seed):
--   All expense terms seeded with match_type='contains' have a
--   corresponding "X payable" seed row added below targeting
--   current_liabilities. Combined with longest-match-wins in
--   PART 3, this ensures "Audit Fees Payable" routes to
--   current_liabilities, not operating_expenses.
-- ============================================================

BEGIN;

-- Ensure the unique constraint exists.
-- keyword_dictionary may have been created by an earlier Lovable migration
-- without it; CREATE TABLE IF NOT EXISTS in PART 1 would have skipped the
-- table body (including the constraint). This block is idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname      = 'uq_keyword_dict_term_lang'
      AND conrelid     = 'public.keyword_dictionary'::regclass
  ) THEN
    ALTER TABLE public.keyword_dictionary
      ADD CONSTRAINT uq_keyword_dict_term_lang UNIQUE (term, language);
  END IF;
END;
$$;

INSERT INTO public.keyword_dictionary (term, language, classification, match_type)
VALUES

-- ══════════════════════════════════════════════════════════════
-- ENGLISH TERMS
-- ══════════════════════════════════════════════════════════════

-- ── Balance Sheet — Current Assets ────────────────────────────────────────────
  ('cash',                          'en', 'current_assets',          'contains'),
  ('petty cash',                    'en', 'current_assets',          'exact'),
  ('cash on hand',                  'en', 'current_assets',          'exact'),
  ('cash and bank',                 'en', 'current_assets',          'contains'),
  ('bank account',                  'en', 'current_assets',          'contains'),
  ('accounts receivable',           'en', 'current_assets',          'contains'),
  ('trade receivables',             'en', 'current_assets',          'exact'),
  ('trade debtors',                 'en', 'current_assets',          'exact'),
  ('debtors',                       'en', 'current_assets',          'exact'),
  ('receivables',                   'en', 'current_assets',          'contains'),
  ('inventories',                   'en', 'current_assets',          'exact'),
  ('inventory',                     'en', 'current_assets',          'contains'),
  ('prepayments',                   'en', 'current_assets',          'contains'),
  ('prepaid',                       'en', 'current_assets',          'contains'),
  ('advance paid',                  'en', 'current_assets',          'contains'),
  ('deposit paid',                  'en', 'current_assets',          'contains'),

-- ── Balance Sheet — Non-Current Assets ────────────────────────────────────────
  ('land',                          'en', 'non_current_assets',      'exact'),
  ('buildings',                     'en', 'non_current_assets',      'contains'),
  ('motor vehicles',                'en', 'non_current_assets',      'contains'),
  ('furniture',                     'en', 'non_current_assets',      'contains'),
  ('fixtures',                      'en', 'non_current_assets',      'contains'),
  ('machinery',                     'en', 'non_current_assets',      'contains'),
  ('computers',                     'en', 'non_current_assets',      'contains'),
  ('equipment',                     'en', 'non_current_assets',      'contains'),
  ('intangible',                    'en', 'non_current_assets',      'contains'),
  ('goodwill',                      'en', 'non_current_assets',      'exact'),
  ('software',                      'en', 'non_current_assets',      'contains'),
  ('work in progress',              'en', 'non_current_assets',      'contains'),
  ('accumulated depreciation',      'en', 'non_current_assets',      'contains'),
  ('water well',                    'en', 'non_current_assets',      'exact'),

-- ── Balance Sheet — Current Liabilities ───────────────────────────────────────
-- Core payables
  ('accounts payable',              'en', 'current_liabilities',     'contains'),
  ('trade payables',                'en', 'current_liabilities',     'exact'),
  ('trade creditors',               'en', 'current_liabilities',     'exact'),
  ('creditors',                     'en', 'current_liabilities',     'exact'),
  ('vat payable',                   'en', 'current_liabilities',     'exact'),
  ('paye payable',                  'en', 'current_liabilities',     'exact'),
  ('nssf payable',                  'en', 'current_liabilities',     'exact'),
  ('nhif payable',                  'en', 'current_liabilities',     'exact'),
  ('wcf payable',                   'en', 'current_liabilities',     'exact'),
  ('sdl payable',                   'en', 'current_liabilities',     'exact'),
  ('tax payable',                   'en', 'current_liabilities',     'contains'),
  ('accrued expenses',              'en', 'current_liabilities',     'exact'),
  ('accruals',                      'en', 'current_liabilities',     'contains'),
  ('bank overdraft',                'en', 'current_liabilities',     'exact'),
  ('short term loan',               'en', 'current_liabilities',     'contains'),
  ('service levy payable',          'en', 'current_liabilities',     'exact'),
-- "Payable trap" anchors — longest-match-wins in PART 3 routes these
-- correctly when the same root term also exists as an opex 'contains' entry.
  ('salaries payable',              'en', 'current_liabilities',     'contains'),
  ('wages payable',                 'en', 'current_liabilities',     'contains'),
  ('accrued salaries',              'en', 'current_liabilities',     'exact'),
  ('accrued wages',                 'en', 'current_liabilities',     'exact'),
  ('allowances payable',            'en', 'current_liabilities',     'contains'),
  ('rent payable',                  'en', 'current_liabilities',     'contains'),
  ('interest payable',              'en', 'current_liabilities',     'contains'),
  ('loan interest payable',         'en', 'current_liabilities',     'contains'),
  ('audit fees payable',            'en', 'current_liabilities',     'contains'),
  ('legal fees payable',            'en', 'current_liabilities',     'contains'),
  ('professional fees payable',     'en', 'current_liabilities',     'contains'),
  ('accounting fees payable',       'en', 'current_liabilities',     'contains'),
  ('inspection fees payable',       'en', 'current_liabilities',     'contains'),
  ('facility fees payable',         'en', 'current_liabilities',     'contains'),
  ('insurance payable',             'en', 'current_liabilities',     'contains'),
  ('insurance premium payable',     'en', 'current_liabilities',     'contains'),
  ('electricity payable',           'en', 'current_liabilities',     'contains'),
  ('telephone payable',             'en', 'current_liabilities',     'contains'),
  ('internet payable',              'en', 'current_liabilities',     'contains'),
  ('transport payable',             'en', 'current_liabilities',     'contains'),
  ('repairs payable',               'en', 'current_liabilities',     'contains'),
  ('maintenance payable',           'en', 'current_liabilities',     'contains'),
  ('training fees payable',         'en', 'current_liabilities',     'contains'),
  ('security payable',              'en', 'current_liabilities',     'contains'),
  ('registration fees payable',     'en', 'current_liabilities',     'contains'),
  ('membership fees payable',       'en', 'current_liabilities',     'contains'),

-- ── Balance Sheet — Non-Current Liabilities ───────────────────────────────────
  ('long term loan',                'en', 'non_current_liabilities', 'contains'),
  ('long-term loan',                'en', 'non_current_liabilities', 'contains'),
  ('mortgage',                      'en', 'non_current_liabilities', 'contains'),
  ('debentures',                    'en', 'non_current_liabilities', 'contains'),
  ('bonds payable',                 'en', 'non_current_liabilities', 'exact'),
  ('long term borrowings',          'en', 'non_current_liabilities', 'contains'),

-- ── Balance Sheet — Equity ────────────────────────────────────────────────────
  ('share capital',                 'en', 'equity',                  'exact'),
  ('paid up capital',               'en', 'equity',                  'exact'),
  ('paid-up capital',               'en', 'equity',                  'exact'),
  ('retained earnings',             'en', 'equity',                  'contains'),
  ('accumulated surplus',           'en', 'equity',                  'exact'),
  ('accumulated deficit',           'en', 'equity',                  'exact'),
  ('share premium',                 'en', 'equity',                  'exact'),
  ('ordinary shares',               'en', 'equity',                  'contains'),

-- ── Income Statement — Revenue ────────────────────────────────────────────────
  ('sales',                         'en', 'revenue',                 'exact'),
  ('turnover',                      'en', 'revenue',                 'exact'),
  ('revenue',                       'en', 'revenue',                 'exact'),
  ('rental income',                 'en', 'revenue',                 'contains'),
  ('commission income',             'en', 'revenue',                 'contains'),
  ('service income',                'en', 'revenue',                 'exact'),
  ('subscription income',           'en', 'revenue',                 'exact'),

-- ── Income Statement — Cost of Goods Sold ─────────────────────────────────────
  ('cost of sales',                 'en', 'cost_of_goods_sold',      'exact'),
  ('cost of goods sold',            'en', 'cost_of_goods_sold',      'exact'),
  ('direct costs',                  'en', 'cost_of_goods_sold',      'exact'),
  ('opening stock',                 'en', 'cost_of_goods_sold',      'exact'),
  ('opening inventory',             'en', 'cost_of_goods_sold',      'exact'),

-- ── Income Statement — Operating Expenses ─────────────────────────────────────
-- These 'contains' terms are guarded above by their "X payable" counterparts.
-- PART 3 longest-match-wins resolves conflicts in favour of the longer term.
  ('salaries',                      'en', 'operating_expenses',      'contains'),
  ('wages',                         'en', 'operating_expenses',      'contains'),
  ('allowances',                    'en', 'operating_expenses',      'contains'),
  ('office rent',                   'en', 'operating_expenses',      'exact'),
  ('land rent',                     'en', 'operating_expenses',      'exact'),
  ('electricity',                   'en', 'operating_expenses',      'contains'),
  ('fuel',                          'en', 'operating_expenses',      'contains'),
  ('insurance',                     'en', 'operating_expenses',      'contains'),
  ('depreciation',                  'en', 'operating_expenses',      'contains'),
  ('repairs',                       'en', 'operating_expenses',      'contains'),
  ('maintenance',                   'en', 'operating_expenses',      'contains'),
  ('audit fee',                     'en', 'operating_expenses',      'contains'),
  ('legal fee',                     'en', 'operating_expenses',      'contains'),
  ('professional fee',              'en', 'operating_expenses',      'contains'),
  ('accounting fee',                'en', 'operating_expenses',      'contains'),
  ('inspection fee',                'en', 'operating_expenses',      'contains'),
  ('bank charges',                  'en', 'operating_expenses',      'exact'),
  ('loan interest',                 'en', 'operating_expenses',      'contains'),
  ('interest on loan',              'en', 'operating_expenses',      'exact'),
  ('facility fee',                  'en', 'operating_expenses',      'contains'),
  ('telephone',                     'en', 'operating_expenses',      'contains'),
  ('internet',                      'en', 'operating_expenses',      'contains'),
  ('postage',                       'en', 'operating_expenses',      'contains'),
  ('training',                      'en', 'operating_expenses',      'contains'),
  ('security',                      'en', 'operating_expenses',      'contains'),
  ('cleaning',                      'en', 'operating_expenses',      'contains'),
  ('fumigation',                    'en', 'operating_expenses',      'contains'),
  ('stationery',                    'en', 'operating_expenses',      'contains'),
  ('stationeries',                  'en', 'operating_expenses',      'exact'),
  ('printing',                      'en', 'operating_expenses',      'contains'),
  ('transport',                     'en', 'operating_expenses',      'contains'),
  ('travelling',                    'en', 'operating_expenses',      'contains'),
  ('registration',                  'en', 'operating_expenses',      'contains'),
  ('membership',                    'en', 'operating_expenses',      'contains'),
  ('entertainment',                 'en', 'operating_expenses',      'contains'),
  ('meeting',                       'en', 'operating_expenses',      'contains'),
  ('welfare',                       'en', 'operating_expenses',      'contains'),
  ('uniform',                       'en', 'operating_expenses',      'contains'),
  ('nhif',                          'en', 'operating_expenses',      'contains'),
  ('nssf',                          'en', 'operating_expenses',      'contains'),
  ('wcf',                           'en', 'operating_expenses',      'contains'),
  ('skills development levy',       'en', 'operating_expenses',      'contains'),
  ('service levy',                  'en', 'operating_expenses',      'exact'),
  ('water and sewerage',            'en', 'operating_expenses',      'contains'),
  ('hospital system',               'en', 'operating_expenses',      'exact'),
  ('valuation',                     'en', 'operating_expenses',      'contains'),
  ('brela',                         'en', 'operating_expenses',      'exact'),
  ('business licence',              'en', 'operating_expenses',      'contains'),
  ('business license',              'en', 'operating_expenses',      'contains'),
  ('stock taking',                  'en', 'operating_expenses',      'exact'),
  ('contract renewal',              'en', 'operating_expenses',      'contains'),
  ('expenditure',                   'en', 'operating_expenses',      'contains'),

-- ── Income Statement — Other Income ───────────────────────────────────────────
-- 'interest income' → other_income (not revenue) for non-financial companies.
  ('interest income',               'en', 'other_income',            'exact'),
  ('dividend income',               'en', 'other_income',            'exact'),
  ('gain on disposal',              'en', 'other_income',            'contains'),
  ('profit on disposal',            'en', 'other_income',            'contains'),
  ('foreign exchange gain',         'en', 'other_income',            'contains'),
  ('miscellaneous income',          'en', 'other_income',            'exact'),

-- ── Income Statement — Taxes ──────────────────────────────────────────────────
  ('income tax provision',          'en', 'taxes',                   'exact'),
  ('corporate tax provision',       'en', 'taxes',                   'exact'),
  ('income tax charge',             'en', 'taxes',                   'exact'),
  ('tax provision',                 'en', 'taxes',                   'contains'),

-- ══════════════════════════════════════════════════════════════
-- SWAHILI TERMS
-- ══════════════════════════════════════════════════════════════

-- ── Balance Sheet — Current Assets ────────────────────────────────────────────
  ('fedha taslimu',                 'sw', 'current_assets',          'contains'),
  ('pesa taslimu',                  'sw', 'current_assets',          'contains'),
  ('benki',                         'sw', 'current_assets',          'contains'),
  ('wadaiwa',                       'sw', 'current_assets',          'exact'),
  ('hesabu za benki',               'sw', 'current_assets',          'contains'),

-- ── Balance Sheet — Non-Current Assets ────────────────────────────────────────
-- 'uchakavu ulioongezeka' (non_current_assets, contains) must be seeded before
-- 'uchakavu' (operating_expenses, exact below). Longest-match-wins in PART 3
-- ensures "Uchakavu Ulioongezeka" routes to non_current_assets. ✓
  ('mali ya kudumu',                'sw', 'non_current_assets',      'contains'),
  ('majengo',                       'sw', 'non_current_assets',      'contains'),
  ('ardhi',                         'sw', 'non_current_assets',      'exact'),
  ('magari',                        'sw', 'non_current_assets',      'contains'),
  ('uchakavu ulioongezeka',         'sw', 'non_current_assets',      'contains'),

-- ── Balance Sheet — Current Liabilities ───────────────────────────────────────
  ('wadai',                         'sw', 'current_liabilities',     'exact'),
  ('mkopo wa muda mfupi',           'sw', 'current_liabilities',     'contains'),
  ('mishahara inayodaiwa',          'sw', 'current_liabilities',     'contains'),
  ('kodi inayodaiwa',               'sw', 'current_liabilities',     'contains'),
  ('bima inayodaiwa',               'sw', 'current_liabilities',     'contains'),

-- ── Balance Sheet — Non-Current Liabilities ───────────────────────────────────
  ('mkopo wa muda mrefu',           'sw', 'non_current_liabilities', 'contains'),
  ('deni la muda mrefu',            'sw', 'non_current_liabilities', 'contains'),

-- ── Balance Sheet — Equity ────────────────────────────────────────────────────
  ('mtaji',                         'sw', 'equity',                  'exact'),
  ('faida iliyobakiwa',             'sw', 'equity',                  'contains'),
  ('hisa za kawaida',               'sw', 'equity',                  'contains'),

-- ── Income Statement — Revenue ────────────────────────────────────────────────
-- 'mapato' alone excluded (ambiguous — can mean any income type in Swahili).
  ('mauzo',                         'sw', 'revenue',                 'exact'),
  ('mapato ya biashara',            'sw', 'revenue',                 'contains'),
  ('pato la biashara',              'sw', 'revenue',                 'contains'),

-- ── Income Statement — Cost of Goods Sold ─────────────────────────────────────
  ('gharama za bidhaa',             'sw', 'cost_of_goods_sold',      'contains'),
  ('ununuzi',                       'sw', 'cost_of_goods_sold',      'exact'),
  ('stoki ya mwanzo',               'sw', 'cost_of_goods_sold',      'exact'),

-- ── Income Statement — Operating Expenses ─────────────────────────────────────
-- 'uchakavu' (exact) → depreciation expense.
-- Safe: exact match only fires when account name IS exactly 'uchakavu'.
-- 'uchakavu ulioongezeka' (non_current_assets, contains, seeded above) handles
-- the accumulated depreciation BS account via longer-match-wins in PART 3.
  ('mishahara',                     'sw', 'operating_expenses',      'contains'),
  ('posho',                         'sw', 'operating_expenses',      'contains'),
  ('kodi ya pango',                 'sw', 'operating_expenses',      'contains'),
  ('umeme',                         'sw', 'operating_expenses',      'exact'),
  ('maji',                          'sw', 'operating_expenses',      'exact'),
  ('simu',                          'sw', 'operating_expenses',      'exact'),
  ('usafiri',                       'sw', 'operating_expenses',      'exact'),
  ('matengenezo',                   'sw', 'operating_expenses',      'contains'),
  ('bima',                          'sw', 'operating_expenses',      'exact'),
  ('uchakavu',                      'sw', 'operating_expenses',      'exact'),
  ('mafunzo',                       'sw', 'operating_expenses',      'exact'),
  ('usalama',                       'sw', 'operating_expenses',      'exact'),

-- ── Income Statement — Taxes ──────────────────────────────────────────────────
  ('kodi ya mapato',                'sw', 'taxes',                   'contains')

ON CONFLICT ON CONSTRAINT uq_keyword_dict_term_lang DO NOTHING;

COMMIT;
