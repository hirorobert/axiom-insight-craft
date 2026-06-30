-- ============================================================
-- Migration: 20260628100000 — Phase 4 Tax Engine Schema
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.capital_allowances (
  id                        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                UUID          NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period_year               INTEGER       NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  asset_description         TEXT          NOT NULL,
  ita_class                 INTEGER       NOT NULL CHECK (ita_class IN (1, 2, 3, 5, 6, 8)),
  cost_tzs                  NUMERIC(18,2) NOT NULL CHECK (cost_tzs >= 0),
  ita_wdv_opening_tzs       NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (ita_wdv_opening_tzs >= 0),
  additions_tzs             NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (additions_tzs >= 0),
  disposals_at_tax_cost_tzs NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (disposals_at_tax_cost_tzs >= 0),
  wear_tear_tzs             NUMERIC(18,2) NOT NULL DEFAULT 0,
  ita_wdv_closing_tzs       NUMERIC(18,2) NOT NULL DEFAULT 0,
  accounting_depreciation_tzs NUMERIC(18,2) NOT NULL DEFAULT 0,
  source_account            TEXT          NULL,
  notes                     TEXT          NULL,
  created_by                UUID          NOT NULL REFERENCES auth.users(id),
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.capital_allowances TO authenticated;
GRANT ALL ON public.capital_allowances TO service_role;

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

CREATE TABLE IF NOT EXISTS public.tax_computations (
  id                                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                        UUID          NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  upload_id                         UUID          NOT NULL REFERENCES public.trial_balance_uploads(id) ON DELETE CASCADE,
  period_year                       INTEGER       NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  accounting_profit_before_tax_tzs  NUMERIC(18,2),
  gross_income_tzs                  NUMERIC(18,2),
  add_backs                         JSONB         NOT NULL DEFAULT '[]',
  deductions                        JSONB         NOT NULL DEFAULT '[]',
  total_add_backs_tzs               NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_deductions_tzs              NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_wear_tear_tzs               NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_debt_tzs                    NUMERIC(18,2),
  total_equity_tzs                  NUMERIC(18,2),
  debt_equity_ratio                 NUMERIC(8,4),
  allowable_debt_tzs                NUMERIC(18,2),
  interest_expense_tzs              NUMERIC(18,2),
  thin_cap_disallowed_tzs           NUMERIC(18,2) NOT NULL DEFAULT 0,
  taxable_income_tzs                NUMERIC(18,2),
  cit_at_30pct_tzs                  NUMERIC(18,2),
  minimum_tax_tzs                   NUMERIC(18,2),
  tax_payable_tzs                   NUMERIC(18,2),
  minimum_tax_applies               BOOLEAN       NOT NULL DEFAULT false,
  effective_tax_rate_pct            NUMERIC(6,3),
  income_tax_provision_tzs          NUMERIC(18,2) NOT NULL DEFAULT 0,
  cit_gap_tzs                       NUMERIC(18,2),
  months_overdue                    INTEGER       NOT NULL DEFAULT 0,
  penalty_tzs                       NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_exposure_tzs                NUMERIC(18,2),
  engine_version                    TEXT          NOT NULL DEFAULT 'Module E v1.0',
  warnings                          JSONB         NOT NULL DEFAULT '[]',
  computation_detail                JSONB,
  created_at                        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (company_id, upload_id)
);

GRANT SELECT ON public.tax_computations TO authenticated;
GRANT ALL ON public.tax_computations TO service_role;

CREATE INDEX IF NOT EXISTS idx_tax_computations_company_year
  ON public.tax_computations (company_id, period_year DESC);

COMMIT;