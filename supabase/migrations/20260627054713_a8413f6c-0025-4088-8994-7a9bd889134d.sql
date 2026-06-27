-- ============================================================
-- Migration A: 20260626200000 — is_payroll_account flag
-- ============================================================
BEGIN;

ALTER TABLE public.account_mappings
  ADD COLUMN IF NOT EXISTS is_payroll_account BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.account_mappings.is_payroll_account IS
  'SDL base flag. Set TRUE for accounts representing gross emoluments '
  'paid to employees: salaries, wages, allowances, overtime, extra duty. '
  'SDL (CAP 441) = 3.5% x gross emoluments. '
  'Do NOT set TRUE on: NHIF, NSSF, WCF, SDL expense, rent, utilities, '
  'depreciation, or any other non-emolument operating expense. '
  'Used by kinga-findings-engine Step C1c to filter the SDL base. '
  'If no accounts are flagged, the engine emits a config error rather '
  'than computing SDL on the full operating_expenses total.';

COMMIT;

-- ============================================================
-- Migration B: 20260627110000 — tax_payments table
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.tax_payments (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  tax_category        TEXT        NOT NULL,
  period_year         INTEGER     NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  period_month        INTEGER     NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  amount_paid_tzs     NUMERIC(18,2) NOT NULL CHECK (amount_paid_tzs >= 0),
  payment_date        DATE        NOT NULL,
  payment_reference   TEXT        NULL,
  payment_source      TEXT        NOT NULL DEFAULT 'preparer_declared'
                      CHECK (payment_source IN (
                        'preparer_declared',
                        'efdms_matched',
                        'tra_receipt'
                      )),
  notes               TEXT        NULL,
  created_by          UUID        NOT NULL REFERENCES auth.users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tax_payments_company_category_period
ON public.tax_payments (company_id, tax_category, period_year, period_month);

CREATE INDEX IF NOT EXISTS idx_tax_payments_company_id
ON public.tax_payments (company_id, period_year DESC, period_month DESC);

ALTER TABLE public.tax_payments ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tax_payments TO authenticated;
GRANT ALL ON public.tax_payments TO service_role;

COMMIT;

-- ============================================================
-- Migration C: 20260627120000 — finding_category column + dedup index
-- ============================================================
BEGIN;

ALTER TABLE public.findings
  ADD COLUMN IF NOT EXISTS finding_category TEXT NULL;

COMMENT ON COLUMN public.findings.finding_category IS
  'Statutory category for this finding. '
  'For rule_trigger findings: matches statutory_rules.trigger_category '
  '(e.g. sdl, wht_undistributed_earnings). '
  'For statutory_payable findings (Module C): category from engine pattern '
  '(e.g. sdl_outstanding, nssf_outstanding, tra_assessment, service_levy_outstanding). '
  'NULL for manual and efdms_diff findings.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_statutory_payable_per_period
ON public.findings (company_id, finding_category, period_start, period_end)
WHERE statutory_rule_id IS NULL
  AND finding_type = 'statutory_payable';

COMMENT ON INDEX public.uq_statutory_payable_per_period IS
  'OD-13 closed. Prevents duplicate Module C statutory_payable findings '
  'when the engine is re-run for the same period.';

COMMIT;
