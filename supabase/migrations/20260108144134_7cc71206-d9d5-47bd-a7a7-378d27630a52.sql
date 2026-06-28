-- Create companies table for multi-company support
CREATE TABLE public.companies (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  code TEXT,
  description TEXT,
  industry TEXT,
  fiscal_year_end TEXT DEFAULT '12-31',
  currency TEXT DEFAULT 'USD',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

-- Create policies for companies
CREATE POLICY "Users can view their own companies"
ON public.companies FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own companies"
ON public.companies FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own companies"
ON public.companies FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own companies"
ON public.companies FOR DELETE
USING (auth.uid() = user_id);

-- Create index for faster lookups
CREATE INDEX idx_companies_user_id ON public.companies(user_id);

-- Add trigger for updated_at
CREATE TRIGGER update_companies_updated_at
BEFORE UPDATE ON public.companies
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Add company_id column to trial_balance_uploads
ALTER TABLE public.trial_balance_uploads
ADD COLUMN company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL;

-- Create index for company lookups
CREATE INDEX idx_trial_balance_uploads_company_id ON public.trial_balance_uploads(company_id);