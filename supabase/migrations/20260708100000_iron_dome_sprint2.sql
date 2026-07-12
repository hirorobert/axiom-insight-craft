-- ============================================================
-- Migration: 20260708100000 — Iron Dome Nuclear Sprint 2
-- Date: 2026-07-08
-- Author: Kinga Engine — Post-Audit Defect Remediation
--
-- DEFECTS RESOLVED:
--   D2 — SCF disposal proceeds: add disposal_proceeds_tzs to capital_allowances
--   D4 — Dividends/share capital: management_inputs table
--   D6 — Sign-off role enforcement: firm_member_id columns on statement_sign_offs
--   D1 — periodYear chain: period_year column on trial_balance_uploads (stored)
--
-- PURELY ADDITIVE. No existing data is modified or destroyed.
-- ============================================================

BEGIN;

-- ════════════════════════════════════════════════════════════
-- 1. D2 FIX — capital_allowances: IFRS disposal proceeds column
-- ════════════════════════════════════════════════════════════
-- disposals_at_tax_cost_tzs = ITA WDV of the disposed asset (for ITA waterfall)
-- disposal_proceeds_tzs     = ACTUAL CASH RECEIVED on disposal (for SCF investing)
-- These are DIFFERENT values. Prior version used tax cost as SCF proceeds — IFRS violation.
-- NULL = not yet provided by CPA; engine falls back to tax cost with a warning.

ALTER TABLE public.capital_allowances
  ADD COLUMN IF NOT EXISTS disposal_proceeds_tzs NUMERIC(18,2) NULL;

COMMENT ON COLUMN public.capital_allowances.disposal_proceeds_tzs IS
  'IFRS SCF: actual cash received on asset disposal (sale proceeds). '
  'Distinct from disposals_at_tax_cost_tzs (ITA WDV basis for tax computation). '
  'NULL = CPA has not provided proceeds; engine falls back to tax cost with warning.';

-- ════════════════════════════════════════════════════════════
-- 2. D4 FIX — management_inputs: dividends, share capital, OCI
-- ════════════════════════════════════════════════════════════
-- Owner-managed Tanzania SMEs routinely pay dividends. Without this table:
--   - SOCIE closing equity is overstated (dividends not deducted)
--   - SCF financing activities missing cash outflow
--   - Reconciliation to SFP equity always fails for dividend-paying entities

CREATE TABLE IF NOT EXISTS public.management_inputs (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  UUID        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  upload_id                   UUID        NOT NULL REFERENCES public.trial_balance_uploads(id) ON DELETE CASCADE,
  period_year                 INTEGER     NOT NULL,

  -- Owner transactions (SOCIE + SCF financing)
  dividends_declared_tzs      NUMERIC(18,2) NOT NULL DEFAULT 0,
  -- Declared during the period. Paid ≠ declared for accrual; approximate as paid in SCF.

  share_capital_issued_tzs    NUMERIC(18,2) NOT NULL DEFAULT 0,
  -- New share capital raised during the period (SOCIE share capital + SCF financing).

  other_equity_movements_tzs  NUMERIC(18,2) NOT NULL DEFAULT 0,
  -- OCI and other movements not captured above (revaluation, FX translation, etc.).

  -- Financing cash flows (SCF) — additional items not computable from TB
  loan_repayments_tzs         NUMERIC(18,2) NOT NULL DEFAULT 0,
  -- Principal repayments on long-term borrowings (financing outflow).

  new_borrowings_tzs          NUMERIC(18,2) NOT NULL DEFAULT 0,
  -- New long-term borrowings raised during the period (financing inflow).

  notes                       TEXT          NULL,
  created_by                  UUID          NOT NULL REFERENCES auth.users(id),
  created_at                  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT now(),

  UNIQUE (company_id, upload_id)
);

COMMENT ON TABLE public.management_inputs IS
  'CPA-provided management inputs for items the engine cannot compute from the TB alone: '
  'dividends declared, share capital issued, loan repayments, new borrowings, OCI. '
  'Keyed on (company_id, upload_id). Engine reads this in STEP 0b.';

ALTER TABLE public.management_inputs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mi_select" ON public.management_inputs FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid() AND fm.company_id = management_inputs.company_id
  ));

CREATE POLICY "mi_insert" ON public.management_inputs FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = management_inputs.company_id
      AND fm.role IN ('owner', 'partner', 'preparer')
  ));

CREATE POLICY "mi_update" ON public.management_inputs FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = management_inputs.company_id
      AND fm.role IN ('owner', 'partner', 'preparer')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = management_inputs.company_id
      AND fm.role IN ('owner', 'partner', 'preparer')
  ));

CREATE INDEX IF NOT EXISTS idx_management_inputs_company_upload
  ON public.management_inputs (company_id, upload_id);

CREATE INDEX IF NOT EXISTS idx_management_inputs_company_year
  ON public.management_inputs (company_id, period_year);

-- ════════════════════════════════════════════════════════════
-- 3. D6 FIX — statement_sign_offs: firm_member_id audit columns
-- ════════════════════════════════════════════════════════════
-- Prior version stored only user UUID (auth.users). Cannot verify role at query time.
-- Adding FK to firm_members enables role verification and audit queries.

ALTER TABLE public.statement_sign_offs
  ADD COLUMN IF NOT EXISTS preparer_firm_member_id UUID REFERENCES public.firm_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewer_firm_member_id UUID REFERENCES public.firm_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approver_firm_member_id UUID REFERENCES public.firm_members(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.statement_sign_offs.preparer_firm_member_id IS
  'FK to firm_members: the specific membership row of the preparer signer. '
  'Enables role verification audit: role must be preparer, partner, or owner.';
COMMENT ON COLUMN public.statement_sign_offs.reviewer_firm_member_id IS
  'FK to firm_members: reviewer must hold role = partner or owner.';
COMMENT ON COLUMN public.statement_sign_offs.approver_firm_member_id IS
  'FK to firm_members: approver/locker must hold role = partner or owner.';

-- ════════════════════════════════════════════════════════════
-- 4. D1 FIX — trial_balance_uploads: period_year stored column
-- ════════════════════════════════════════════════════════════
-- Upload date ≠ fiscal period year. A TB uploaded in Jan 2026 is for FY2025.
-- This column stores the CORRECT fiscal year extracted from fiscal_year_end DATE.
-- Nullable: only populated when fiscal_year_end is set (period_id linked).
-- Application logic falls back to smart derivation when NULL.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'trial_balance_uploads'
      AND column_name  = 'period_year'
  ) THEN
    ALTER TABLE public.trial_balance_uploads
      ADD COLUMN period_year INTEGER NULL;

    COMMENT ON COLUMN public.trial_balance_uploads.period_year IS
      'Fiscal year of the TB (e.g. 2025 for year ended 31 Dec 2025). '
      'Derived from fiscal_year_end when period_id is linked. '
      'NULL until period_id is set. Application uses company fiscal_year_end as fallback.';

    -- Backfill: populate period_year for existing rows that already have fiscal_year_end
    UPDATE public.trial_balance_uploads
    SET    period_year = EXTRACT(YEAR FROM fiscal_year_end)::INTEGER
    WHERE  fiscal_year_end IS NOT NULL
      AND  period_year IS NULL;
  END IF;
END;
$$;

-- Trigger: auto-populate period_year whenever fiscal_year_end is set
CREATE OR REPLACE FUNCTION public.sync_upload_period_year()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fiscal_year_end IS NOT NULL THEN
    NEW.period_year := EXTRACT(YEAR FROM NEW.fiscal_year_end)::INTEGER;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_upload_period_year ON public.trial_balance_uploads;
CREATE TRIGGER trg_sync_upload_period_year
  BEFORE INSERT OR UPDATE OF fiscal_year_end
  ON public.trial_balance_uploads
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_upload_period_year();

-- ════════════════════════════════════════════════════════════
-- 5. period_closing_balances: add taxable_income_tzs for AMT detection
-- ════════════════════════════════════════════════════════════
-- D8 fix: AMT 3-year detection requires querying taxable income for prior 2 years.
-- Add this column so the engine can determine consecutive-loss eligibility.

ALTER TABLE public.period_closing_balances
  ADD COLUMN IF NOT EXISTS taxable_income_tzs         NUMERIC(18,2) NULL,
  ADD COLUMN IF NOT EXISTS total_wear_tear_tzs         NUMERIC(18,2) NULL,
  ADD COLUMN IF NOT EXISTS accounting_pbt_tzs          NUMERIC(18,2) NULL,
  ADD COLUMN IF NOT EXISTS revenue_tzs                 NUMERIC(18,2) NULL;

COMMENT ON COLUMN public.period_closing_balances.taxable_income_tzs IS
  'ITA taxable income for this period (from kinga-tax-engine STEP 8). '
  'Used by D8 AMT 3-year consecutive loss detection.';
COMMENT ON COLUMN public.period_closing_balances.revenue_tzs IS
  'Turnover for the period — used as AMT base (1% of turnover).';

-- ════════════════════════════════════════════════════════════
-- SMOKE TEST
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_col_disposal     BOOLEAN;
  v_tbl_mgmt         BOOLEAN;
  v_col_prep_fmid    BOOLEAN;
  v_col_period_year  BOOLEAN;
  v_col_tax_income   BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='capital_allowances'
      AND column_name='disposal_proceeds_tzs'
  ) INTO v_col_disposal;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='management_inputs'
  ) INTO v_tbl_mgmt;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='statement_sign_offs'
      AND column_name='preparer_firm_member_id'
  ) INTO v_col_prep_fmid;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='trial_balance_uploads'
      AND column_name='period_year'
  ) INTO v_col_period_year;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='period_closing_balances'
      AND column_name='taxable_income_tzs'
  ) INTO v_col_tax_income;

  ASSERT v_col_disposal,    'FAIL: capital_allowances.disposal_proceeds_tzs missing';
  ASSERT v_tbl_mgmt,        'FAIL: management_inputs table missing';
  ASSERT v_col_prep_fmid,   'FAIL: statement_sign_offs.preparer_firm_member_id missing';
  ASSERT v_col_period_year,  'FAIL: trial_balance_uploads.period_year missing';
  ASSERT v_col_tax_income,  'FAIL: period_closing_balances.taxable_income_tzs missing';

  RAISE NOTICE 'Iron Dome Sprint 2 migration: all 5 smoke tests PASSED.';
END;
$$;

COMMIT;
