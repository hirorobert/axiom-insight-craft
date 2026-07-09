-- ============================================================
-- Migration: Iron Dome Nuclear Sprint 2 (idempotent re-apply)
-- Makes the original 20260708100000 migration safely rerunnable.
-- CREATE POLICY does not support IF NOT EXISTS, so we DROP-then-CREATE.
-- Purely additive. No existing data modified or destroyed.
-- ============================================================

BEGIN;

-- 1. D2 FIX — capital_allowances.disposal_proceeds_tzs
ALTER TABLE public.capital_allowances
  ADD COLUMN IF NOT EXISTS disposal_proceeds_tzs NUMERIC(18,2) NULL;

COMMENT ON COLUMN public.capital_allowances.disposal_proceeds_tzs IS
  'IFRS SCF: actual cash received on asset disposal (sale proceeds). '
  'Distinct from disposals_at_tax_cost_tzs (ITA WDV basis for tax computation). '
  'NULL = CPA has not provided proceeds; engine falls back to tax cost with warning.';

-- 2. D4 FIX — management_inputs table
CREATE TABLE IF NOT EXISTS public.management_inputs (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  UUID        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  upload_id                   UUID        NOT NULL REFERENCES public.trial_balance_uploads(id) ON DELETE CASCADE,
  period_year                 INTEGER     NOT NULL,
  dividends_declared_tzs      NUMERIC(18,2) NOT NULL DEFAULT 0,
  share_capital_issued_tzs    NUMERIC(18,2) NOT NULL DEFAULT 0,
  other_equity_movements_tzs  NUMERIC(18,2) NOT NULL DEFAULT 0,
  loan_repayments_tzs         NUMERIC(18,2) NOT NULL DEFAULT 0,
  new_borrowings_tzs          NUMERIC(18,2) NOT NULL DEFAULT 0,
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

-- Idempotent policy creation: CREATE POLICY has no IF NOT EXISTS,
-- so drop-then-create each policy defensively.
DROP POLICY IF EXISTS "mi_select" ON public.management_inputs;
CREATE POLICY "mi_select" ON public.management_inputs FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid() AND fm.company_id = management_inputs.company_id
  ));

DROP POLICY IF EXISTS "mi_insert" ON public.management_inputs;
CREATE POLICY "mi_insert" ON public.management_inputs FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = management_inputs.company_id
      AND fm.role IN ('owner', 'partner', 'preparer')
  ));

DROP POLICY IF EXISTS "mi_update" ON public.management_inputs;
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

-- 3. D6 FIX — statement_sign_offs firm_member_id columns
ALTER TABLE public.statement_sign_offs
  ADD COLUMN IF NOT EXISTS preparer_firm_member_id UUID REFERENCES public.firm_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewer_firm_member_id UUID REFERENCES public.firm_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approver_firm_member_id UUID REFERENCES public.firm_members(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.statement_sign_offs.preparer_firm_member_id IS
  'FK to firm_members: preparer must hold role = preparer, partner, or owner.';
COMMENT ON COLUMN public.statement_sign_offs.reviewer_firm_member_id IS
  'FK to firm_members: reviewer must hold role = partner or owner.';
COMMENT ON COLUMN public.statement_sign_offs.approver_firm_member_id IS
  'FK to firm_members: approver/locker must hold role = partner or owner.';

-- 4. D1 FIX — trial_balance_uploads.period_year + trigger
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

    UPDATE public.trial_balance_uploads
    SET    period_year = EXTRACT(YEAR FROM fiscal_year_end)::INTEGER
    WHERE  fiscal_year_end IS NOT NULL
      AND  period_year IS NULL;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upload_period_year()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = public
AS $$
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

-- 5. period_closing_balances — AMT columns
ALTER TABLE public.period_closing_balances
  ADD COLUMN IF NOT EXISTS taxable_income_tzs   NUMERIC(18,2) NULL,
  ADD COLUMN IF NOT EXISTS total_wear_tear_tzs  NUMERIC(18,2) NULL,
  ADD COLUMN IF NOT EXISTS accounting_pbt_tzs   NUMERIC(18,2) NULL,
  ADD COLUMN IF NOT EXISTS revenue_tzs          NUMERIC(18,2) NULL;

COMMENT ON COLUMN public.period_closing_balances.taxable_income_tzs IS
  'ITA taxable income for this period (from kinga-tax-engine STEP 8). '
  'Used by D8 AMT 3-year consecutive loss detection.';
COMMENT ON COLUMN public.period_closing_balances.revenue_tzs IS
  'Turnover for the period — used as AMT base (1% of turnover).';

-- SMOKE TEST
DO $$
DECLARE
  v_col_disposal    BOOLEAN;
  v_tbl_mgmt        BOOLEAN;
  v_col_prep_fmid   BOOLEAN;
  v_col_period_year BOOLEAN;
  v_col_tax_income  BOOLEAN;
  v_pol_count       INTEGER;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='capital_allowances'
      AND column_name='disposal_proceeds_tzs') INTO v_col_disposal;
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='management_inputs') INTO v_tbl_mgmt;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='statement_sign_offs'
      AND column_name='preparer_firm_member_id') INTO v_col_prep_fmid;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='trial_balance_uploads'
      AND column_name='period_year') INTO v_col_period_year;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='period_closing_balances'
      AND column_name='taxable_income_tzs') INTO v_col_tax_income;
  SELECT COUNT(*) FROM pg_policies
    WHERE schemaname='public' AND tablename='management_inputs' INTO v_pol_count;

  ASSERT v_col_disposal,    'FAIL: capital_allowances.disposal_proceeds_tzs missing';
  ASSERT v_tbl_mgmt,        'FAIL: management_inputs table missing';
  ASSERT v_col_prep_fmid,   'FAIL: statement_sign_offs.preparer_firm_member_id missing';
  ASSERT v_col_period_year, 'FAIL: trial_balance_uploads.period_year missing';
  ASSERT v_col_tax_income,  'FAIL: period_closing_balances.taxable_income_tzs missing';
  ASSERT v_pol_count >= 3,  'FAIL: management_inputs must have at least 3 policies';

  RAISE NOTICE 'Iron Dome Sprint 2 idempotent re-apply: all 6 smoke tests PASSED.';
END;
$$;

COMMIT;