-- ============================================================
-- Migration: 20260708100000 — Iron Dome Nuclear Sprint 2
-- ============================================================
BEGIN;

ALTER TABLE public.capital_allowances
  ADD COLUMN IF NOT EXISTS disposal_proceeds_tzs NUMERIC(18,2) NULL;

COMMENT ON COLUMN public.capital_allowances.disposal_proceeds_tzs IS
  'IFRS SCF: actual cash received on asset disposal (sale proceeds). Distinct from disposals_at_tax_cost_tzs (ITA WDV basis for tax computation). NULL = CPA has not provided proceeds; engine falls back to tax cost with warning.';

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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.management_inputs TO authenticated;
GRANT ALL ON public.management_inputs TO service_role;

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

ALTER TABLE public.statement_sign_offs
  ADD COLUMN IF NOT EXISTS preparer_firm_member_id UUID REFERENCES public.firm_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewer_firm_member_id UUID REFERENCES public.firm_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approver_firm_member_id UUID REFERENCES public.firm_members(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trial_balance_uploads' AND column_name = 'period_year'
  ) THEN
    ALTER TABLE public.trial_balance_uploads ADD COLUMN period_year INTEGER NULL;
    UPDATE public.trial_balance_uploads
    SET    period_year = EXTRACT(YEAR FROM fiscal_year_end)::INTEGER
    WHERE  fiscal_year_end IS NOT NULL AND period_year IS NULL;
  END IF;
END;
$$;

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

ALTER TABLE public.period_closing_balances
  ADD COLUMN IF NOT EXISTS taxable_income_tzs NUMERIC(18,2) NULL;

COMMIT;