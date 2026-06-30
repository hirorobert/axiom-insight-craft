-- ============================================================
-- Migration: 20260628100000 — Phase 4 Tax Engine Schema
-- Date: 2026-06-28
-- Module E: ITA Corporate Tax Computation
--
-- NEW TABLES:
--   capital_allowances  — ITA s.34 wear & tear asset register
--   tax_computations    — Full ITA waterfall per company/period
--
-- PURELY ADDITIVE. No existing tables modified.
-- ============================================================

BEGIN;

-- ════════════════════════════════════════════════════════════
-- 1. CAPITAL ALLOWANCES  (ITA s.34 — Wear & Tear)
-- ════════════════════════════════════════════════════════════
--
-- ITA Asset Classes and Rates — VERIFIED against PwC Tanzania (Jan 2026):
--   Class 1: Computers, data equipment, automobiles, buses<30pax, const.equip   37.5% RB
--   Class 2: Heavy trucks, trailers, vessels, aircraft, ag/mfg plant/machinery  25%   RB
--   Class 3: Office furniture, fixtures, equipment; all other assets             12.5% RB
--   Class 5: Agricultural/livestock/fish farming buildings & structures          20%   SL
--   Class 6: All other commercial buildings                                      5%    SL
--   Class 8: Agricultural plant & machinery; EFDs for non-VAT traders           100%  immediate
--
-- NOTE: There is NO Class 4 in Tanzania ITA. Classes 5 & 6 are buildings (straight-line).
-- Source: https://taxsummaries.pwc.com/tanzania/corporate/deductions (reviewed 14 Jan 2026)
--
-- CPA enters one row per asset per period (multiple rows per class allowed).
-- Engine reads the table, computes wear_tear_tzs per class, deducts total from PBT.
-- wear_tear_tzs and ita_wdv_closing_tzs are computed by the
-- kinga-tax-engine and stored (not generated columns — avoids
-- complexity of PostgreSQL generated column CASE expressions).

CREATE TABLE IF NOT EXISTS public.capital_allowances (
  id                        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                UUID          NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period_year               INTEGER       NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),

  asset_description         TEXT          NOT NULL,
  -- Valid ITA classes: 1=37.5%RB, 2=25%RB, 3=12.5%RB, 5=20%SL, 6=5%SL, 7=1/useful-life SL, 8=100% immediate
  -- No Class 4 (removed Finance Act 2016). Class 7 deduction requires CPA to confirm useful life.
  ita_class                 INTEGER       NOT NULL CHECK (ita_class IN (1, 2, 3, 5, 6, 7, 8)),

  -- Tax written-down values (all TZS)
  cost_tzs                  NUMERIC(18,2) NOT NULL CHECK (cost_tzs >= 0),
  ita_wdv_opening_tzs       NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (ita_wdv_opening_tzs >= 0),
  additions_tzs             NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (additions_tzs >= 0),
  disposals_at_tax_cost_tzs NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (disposals_at_tax_cost_tzs >= 0),

  -- Computed and stored by kinga-tax-engine
  wear_tear_tzs             NUMERIC(18,2) NOT NULL DEFAULT 0,
  ita_wdv_closing_tzs       NUMERIC(18,2) NOT NULL DEFAULT 0,

  -- Accounting depreciation from TB (for add-back reconciliation)
  accounting_depreciation_tzs NUMERIC(18,2) NOT NULL DEFAULT 0,

  source_account            TEXT          NULL, -- TB account name this asset was found in
  notes                     TEXT          NULL,
  created_by                UUID          NOT NULL REFERENCES auth.users(id),
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_capital_allowances_company_year
  ON public.capital_allowances (company_id, period_year DESC);

ALTER TABLE public.capital_allowances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ca_select" ON public.capital_allowances FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid() AND fm.company_id = capital_allowances.company_id
  ));

CREATE POLICY "ca_insert" ON public.capital_allowances FOR INSERT
  WITH CHECK (
    auth.uid() = created_by AND
    EXISTS (
      SELECT 1 FROM public.firm_members fm
      WHERE fm.user_id = auth.uid() AND fm.company_id = capital_allowances.company_id
    )
  );

CREATE POLICY "ca_update" ON public.capital_allowances FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
      WHERE fm.user_id = auth.uid() AND fm.company_id = capital_allowances.company_id
    )
  );

CREATE POLICY "ca_delete" ON public.capital_allowances FOR DELETE
  USING (created_by = auth.uid());

COMMENT ON TABLE public.capital_allowances IS
  'ITA s.34 wear & tear asset register. One row per asset/class per year. '
  'wear_tear_tzs and ita_wdv_closing_tzs are computed by kinga-tax-engine '
  'and stored here for carry-forward to the next period. '
  'Used to deduct wear & tear from accounting profit when computing taxable income.';

COMMENT ON COLUMN public.capital_allowances.ita_class IS
  'ITA wear & tear class (PwC Tanzania, Jan 2026): '
  '1=computers,automobiles,const.equip(37.5% RB) | '
  '2=heavy vehicles,aircraft,ag/mfg plant(25% RB) | '
  '3=furniture,fixtures,other assets(12.5% RB) | '
  '5=ag/livestock buildings(20% SL) | '
  '6=commercial buildings(5% SL) | '
  '8=ag plant/EFDs(100% immediate)';


-- ════════════════════════════════════════════════════════════
-- 2. TAX COMPUTATIONS  (ITA Chapter 332 — Corporate Tax)
-- ════════════════════════════════════════════════════════════
--
-- Stores the full ITA waterfall per company per period.
-- Written by kinga-tax-engine after CPA clicks "Commit".
-- Unique per (company_id, upload_id) — re-running replaces previous.

CREATE TABLE IF NOT EXISTS public.tax_computations (
  id                                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                        UUID          NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  upload_id                         UUID          NOT NULL REFERENCES public.trial_balance_uploads(id) ON DELETE CASCADE,
  period_year                       INTEGER       NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),

  -- ── FROM TRIAL BALANCE ────────────────────────────────────
  accounting_profit_before_tax_tzs  NUMERIC(18,2),
  gross_income_tzs                  NUMERIC(18,2), -- total revenue for minimum tax base

  -- ── ITA ADJUSTMENTS (JSONB arrays) ────────────────────────
  -- Each element: { description, amount_tzs, ita_section, account_names[], auto_detected }
  add_backs                         JSONB         NOT NULL DEFAULT '[]',
  deductions                        JSONB         NOT NULL DEFAULT '[]',
  total_add_backs_tzs               NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_deductions_tzs              NUMERIC(18,2) NOT NULL DEFAULT 0,

  -- ── WEAR & TEAR (ITA s.34) ───────────────────────────────
  total_wear_tear_tzs               NUMERIC(18,2) NOT NULL DEFAULT 0,

  -- ── THIN CAP (ITA s.24A — 70:30 debt:equity) ─────────────
  total_debt_tzs                    NUMERIC(18,2),
  total_equity_tzs                  NUMERIC(18,2),
  debt_equity_ratio                 NUMERIC(8,4),
  allowable_debt_tzs                NUMERIC(18,2), -- 70/30 × equity
  interest_expense_tzs              NUMERIC(18,2),
  thin_cap_disallowed_tzs           NUMERIC(18,2) NOT NULL DEFAULT 0,

  -- ── TAXABLE INCOME ────────────────────────────────────────
  taxable_income_tzs                NUMERIC(18,2),

  -- ── TAX CHARGE ────────────────────────────────────────────
  cit_at_30pct_tzs                  NUMERIC(18,2), -- 30% × max(0, taxable_income)
  minimum_tax_tzs                   NUMERIC(18,2), -- 1% × turnover (AMT — only for 3-year loss cos)
  tax_payable_tzs                   NUMERIC(18,2), -- CIT (or AMT if CPA confirms 3-year loss trigger)
  minimum_tax_applies               BOOLEAN       NOT NULL DEFAULT false, -- CPA must set; cannot auto-determine
  effective_tax_rate_pct            NUMERIC(6,3),

  -- ── PROVISION VS COMPUTED ────────────────────────────────
  income_tax_provision_tzs          NUMERIC(18,2) NOT NULL DEFAULT 0,
  cit_gap_tzs                       NUMERIC(18,2), -- tax_payable - provision (+ = underprovided)

  -- ── PENALTY (TAA 2015 s.76) ──────────────────────────────
  months_overdue                    INTEGER       NOT NULL DEFAULT 0,
  penalty_tzs                       NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_exposure_tzs                NUMERIC(18,2),

  -- ── META ─────────────────────────────────────────────────
  engine_version                    TEXT          NOT NULL DEFAULT 'Module E v1.0',
  warnings                          JSONB         NOT NULL DEFAULT '[]',
  computation_detail                JSONB,        -- full JSON dump for audit trail
  created_at                        TIMESTAMPTZ   NOT NULL DEFAULT now(),

  UNIQUE (company_id, upload_id)
);

CREATE INDEX IF NOT EXISTS idx_tax_computations_company_year
  ON public.tax_computations (company_id, period_year DESC);

COMMENT ON TABLE public.tax_computations IS
  'Full ITA Chapter 332 corporate tax waterfall per company per upload. '
  'Written by kinga-tax-engine (Module E). '
  'Displayed in KingaTaxPanel as a step-by-step waterfall. '
  'CIT gap triggers a finding in the findings table.';

COMMENT ON COLUMN public.tax_computations.minimum_tax_applies IS
  'TRUE when AMT (1% of turnover per PwC TZ Jan 2026) applies. '
  'AMT ONLY triggers if company had unrelieved losses for current + 2 preceding years. '
  'CPA must verify 3-year loss history — engine does NOT auto-set this flag. '
  'Exempt: agriculture, tea processing (Jul 2024-Jun 2027), health, education sectors.';

COMMENT ON COLUMN public.tax_computations.thin_cap_disallowed_tzs IS
  'Interest expense disallowed under ITA s.24A thin capitalisation rule (7:3 debt:equity). '
  'CRITICAL: ITA EXCLUDES debt owed to resident Tanzanian financial institutions. '
  'Engine computes an upper-bound (includes all detected debt). '
  'CPA must subtract local bank loans from total_debt_tzs before relying on this figure. '
  'Source: Deloitte Tanzania Thin Cap article (Aug 2025); ITA Cap.332.';

COMMIT;


-- ════════════════════════════════════════════════════════════
-- VERIFICATION (run in Supabase SQL editor after applying)
-- ════════════════════════════════════════════════════════════

-- V1: Both tables exist with RLS
-- SELECT tablename, rowsecurity FROM pg_tables
-- WHERE schemaname = 'public'
--   AND tablename IN ('capital_allowances', 'tax_computations')
-- ORDER BY tablename;
-- Expected: capital_allowances rowsecurity=true, tax_computations rowsecurity=false

-- V2: capital_allowances columns
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'capital_allowances'
-- ORDER BY ordinal_position;

-- V3: tax_computations unique constraint
-- SELECT indexname FROM pg_indexes
-- WHERE tablename = 'tax_computations'
--   AND indexname LIKE '%company_id%upload_id%';
