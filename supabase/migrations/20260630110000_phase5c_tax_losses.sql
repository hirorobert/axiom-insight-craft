-- ============================================================
-- Migration: 20260630110000 — Phase 5C: Tax Loss Carry-Forward
-- Date: 2026-06-30
-- Authority: ITA Cap.332 s.19 — Relief for business losses
--
-- PURPOSE:
--   ITA s.19 permits a company to carry forward unrelieved business
--   losses against future taxable income with NO time limit (unlike
--   some jurisdictions). However, losses cannot be carried back.
--   Also gates the AMT (Alternative Minimum Tax / minimum tax):
--   AMT applies ONLY when a company has unrelieved losses for the
--   current year AND the two preceding years (3-year loss history).
--
-- NEW TABLE:
--   tax_losses — one row per company per period per loss type.
--                Records opening balance, current-year loss/profit,
--                and any utilisation. Closing = carries to next period.
--
-- NEW COLUMN on tax_computations:
--   loss_relief_applied_tzs  — amount of prior losses offset vs taxable income
--   unrelieved_losses_bf_tzs — opening loss balance brought forward
--   unrelieved_losses_cf_tzs — closing loss balance carried forward
--   amt_3yr_trigger          — whether 3-year loss test is met (AMT gate)
--
-- ITA REFERENCE:
--   s.19(1): "A person may deduct an unrelieved loss of a year of income
--             in subsequent years until fully relieved."
--   s.65(2): Minimum tax applies if unrelieved losses exist for 3 years.
-- ============================================================

BEGIN;

-- ════════════════════════════════════════════════════════════
-- 1. TAX LOSSES TABLE
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.tax_losses (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              UUID          NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period_id               UUID          REFERENCES public.fiscal_periods(id) ON DELETE SET NULL,
  period_year             INTEGER       NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),

  -- Opening loss balance (carried from prior year; 0 if first year or profitable)
  unrelieved_loss_bf_tzs  NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (unrelieved_loss_bf_tzs >= 0),

  -- Current year result: positive = taxable income, negative = new loss
  current_year_result_tzs NUMERIC(18,2) NOT NULL DEFAULT 0,

  -- Amount of the b/f loss utilised against this year's taxable income
  loss_utilised_tzs       NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (loss_utilised_tzs >= 0),

  -- Unrelieved loss carried forward = b/f + new loss - utilisation
  -- (calculated by kinga-tax-engine and stored)
  unrelieved_loss_cf_tzs  NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (unrelieved_loss_cf_tzs >= 0),

  -- Whether AMT 3-year trigger is met (kinga-tax-engine sets this)
  -- TRUE when this company had a loss in current year AND the 2 preceding years.
  amt_3yr_trigger         BOOLEAN       NOT NULL DEFAULT false,

  -- Number of consecutive loss years at this point (1, 2, or 3+)
  consecutive_loss_years  INTEGER       NOT NULL DEFAULT 0 CHECK (consecutive_loss_years >= 0),

  -- Source upload that generated this record
  upload_id               UUID          REFERENCES public.trial_balance_uploads(id) ON DELETE SET NULL,

  -- Notes for CPA review
  notes                   TEXT,
  created_by              UUID          NOT NULL REFERENCES auth.users(id),
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),

  UNIQUE (company_id, period_year)
);

CREATE INDEX IF NOT EXISTS idx_tax_losses_company_year
  ON public.tax_losses (company_id, period_year DESC);

ALTER TABLE public.tax_losses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tl_select" ON public.tax_losses FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid() AND fm.company_id = tax_losses.company_id
  ));

CREATE POLICY "tl_insert" ON public.tax_losses FOR INSERT
  WITH CHECK (
    auth.uid() = created_by AND
    EXISTS (
      SELECT 1 FROM public.firm_members fm
      WHERE fm.user_id = auth.uid() AND fm.company_id = tax_losses.company_id
    )
  );

CREATE POLICY "tl_update" ON public.tax_losses FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid() AND fm.company_id = tax_losses.company_id
  ));

GRANT SELECT, INSERT, UPDATE ON public.tax_losses TO authenticated;
GRANT ALL ON public.tax_losses TO service_role;

COMMENT ON TABLE public.tax_losses IS
  'ITA Cap.332 s.19 loss carry-forward register. '
  'One row per company per year — chains backwards through prior_period_id. '
  'kinga-tax-engine reads the prior year row to get unrelieved_loss_bf_tzs '
  'and applies it against current taxable income. '
  'amt_3yr_trigger = TRUE gates the minimum tax (AMT) computation per s.65(2).';

COMMENT ON COLUMN public.tax_losses.amt_3yr_trigger IS
  'TRUE when the company has unrelieved losses in the current year AND the two '
  'preceding years. This is the ONLY gate for applying AMT (minimum tax = 1% of '
  'gross income). If FALSE, minimum tax does not apply regardless of the loss '
  'position. CPA should still verify — engine sets this based on loss register only.';


-- ════════════════════════════════════════════════════════════
-- 2. NEW COLUMNS ON tax_computations
-- ════════════════════════════════════════════════════════════

DO $$
BEGIN
  -- Loss relief offset
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tax_computations'
      AND column_name = 'loss_relief_applied_tzs'
  ) THEN
    ALTER TABLE public.tax_computations
      ADD COLUMN loss_relief_applied_tzs   NUMERIC(18,2) NOT NULL DEFAULT 0,
      ADD COLUMN unrelieved_losses_bf_tzs  NUMERIC(18,2) NOT NULL DEFAULT 0,
      ADD COLUMN unrelieved_losses_cf_tzs  NUMERIC(18,2) NOT NULL DEFAULT 0,
      ADD COLUMN amt_3yr_trigger           BOOLEAN       NOT NULL DEFAULT false;
  END IF;
END $$;

COMMENT ON COLUMN public.tax_computations.loss_relief_applied_tzs IS
  'Amount of brought-forward unrelieved loss offset against this year taxable income. '
  'ITA s.19(1): loss deducted until fully relieved. No time limit in Tanzania.';

COMMENT ON COLUMN public.tax_computations.amt_3yr_trigger IS
  'TRUE → minimum tax (1% of gross income) applies this year per ITA s.65(2). '
  'Copied from tax_losses.amt_3yr_trigger. CPA must confirm before committing.';


-- ════════════════════════════════════════════════════════════
-- 3. HELPER VIEW — 5-year loss history per company
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.v_loss_history AS
SELECT
  tl.company_id,
  c.name                           AS company_name,
  tl.period_year,
  tl.unrelieved_loss_bf_tzs,
  tl.current_year_result_tzs,
  tl.loss_utilised_tzs,
  tl.unrelieved_loss_cf_tzs,
  tl.consecutive_loss_years,
  tl.amt_3yr_trigger,
  -- Rolling 3-year loss flag for UI display
  CASE WHEN tl.consecutive_loss_years >= 3 THEN 'AMT RISK'
       WHEN tl.consecutive_loss_years >= 2 THEN 'WATCH'
       WHEN tl.consecutive_loss_years >= 1 THEN 'LOSS YEAR'
       ELSE 'PROFITABLE'
  END                              AS risk_label
FROM public.tax_losses tl
JOIN public.companies c ON c.id = tl.company_id
ORDER BY tl.company_id, tl.period_year DESC;

COMMENT ON VIEW public.v_loss_history IS
  'Rolling loss history per company. '
  'kinga-comparative-engine uses this to populate the AMT risk panel. '
  'Shows up to 5 years of loss carry-forward status.';


COMMIT;


-- ════════════════════════════════════════════════════════════
-- VERIFICATION SQL
-- ════════════════════════════════════════════════════════════

-- V1: tax_losses table created with RLS
-- SELECT tablename, rowsecurity FROM pg_tables
-- WHERE schemaname = 'public' AND tablename = 'tax_losses';
-- Expected: rowsecurity = true

-- V2: new columns on tax_computations
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'tax_computations'
--   AND column_name IN ('loss_relief_applied_tzs','amt_3yr_trigger');
-- Expected: 2 rows

-- V3: view exists
-- SELECT * FROM public.v_loss_history LIMIT 1;
