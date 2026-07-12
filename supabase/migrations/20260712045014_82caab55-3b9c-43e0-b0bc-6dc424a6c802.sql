
-- tax_computations: missing columns referenced by frontend
ALTER TABLE public.tax_computations
  ADD COLUMN IF NOT EXISTS is_committed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cit_payable_tzs NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS period_month INTEGER;

-- findings: severity column
ALTER TABLE public.findings
  ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'medium'
  CHECK (severity IN ('low','medium','high','critical'));

-- filing_obligations table
CREATE TABLE IF NOT EXISTS public.filing_obligations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  obligation_type TEXT NOT NULL,
  period_year INTEGER NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','filed','overdue','waived')),
  due_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.filing_obligations TO authenticated;
GRANT ALL ON public.filing_obligations TO service_role;

ALTER TABLE public.filing_obligations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "filing_obligations_member_read" ON public.filing_obligations
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.get_member_company_ids()));

CREATE POLICY "filing_obligations_member_write" ON public.filing_obligations
  FOR ALL TO authenticated
  USING (company_id IN (SELECT public.get_member_company_ids()))
  WITH CHECK (company_id IN (SELECT public.get_member_company_ids()));

CREATE TRIGGER trg_filing_obligations_updated_at
  BEFORE UPDATE ON public.filing_obligations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_filing_obligations_company_period
  ON public.filing_obligations(company_id, period_year, period_end);
