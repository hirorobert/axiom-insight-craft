
ALTER TABLE public.tax_computations
  ADD COLUMN IF NOT EXISTS result_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.capital_allowances
  ADD COLUMN IF NOT EXISTS wear_tear_allowance_tzs NUMERIC(18,2) NOT NULL DEFAULT 0;
