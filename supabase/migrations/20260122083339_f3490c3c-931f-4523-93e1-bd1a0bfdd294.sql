-- ============================================
-- AXIOM ACCOUNT MAPPINGS TABLE
-- Explicit COA→FS mapping (no AI inference)
-- ============================================

-- Create enum for financial statement types
CREATE TYPE public.financial_statement AS ENUM (
  'balance_sheet',
  'income_statement',
  'cash_flow'
);

-- Create enum for account classifications
CREATE TYPE public.account_classification AS ENUM (
  'current_assets',
  'non_current_assets',
  'current_liabilities',
  'non_current_liabilities',
  'equity',
  'revenue',
  'cost_of_goods_sold',
  'operating_expenses',
  'other_income',
  'taxes',
  'operating_activities',
  'investing_activities',
  'financing_activities'
);

-- Create the account_mappings table
CREATE TABLE public.account_mappings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  
  -- Account identification (from Chart of Accounts)
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  
  -- Explicit mapping (no inference allowed)
  statement public.financial_statement NOT NULL,
  classification public.account_classification NOT NULL,
  line_item TEXT NOT NULL, -- e.g., "Cash and Cash Equivalents", "Accounts Receivable"
  
  -- Normal balance indicator (required for validation)
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  
  -- Metadata
  is_cash_account BOOLEAN NOT NULL DEFAULT false, -- Required for cash flow eligibility
  is_retained_earnings BOOLEAN NOT NULL DEFAULT false, -- Required for equity linkage
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  -- Enforce one-to-one mapping per user per account code
  CONSTRAINT unique_user_account_mapping UNIQUE (user_id, account_code)
);

-- Enable RLS
ALTER TABLE public.account_mappings ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own mappings"
  ON public.account_mappings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own mappings"
  ON public.account_mappings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own mappings"
  ON public.account_mappings FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own mappings"
  ON public.account_mappings FOR DELETE
  USING (auth.uid() = user_id);

-- Update trigger
CREATE TRIGGER update_account_mappings_updated_at
  BEFORE UPDATE ON public.account_mappings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Add processing_status enum for VALID/INVALID contract
CREATE TYPE public.processing_status AS ENUM (
  'pending',
  'validating',
  'mapping',
  'calculating',
  'valid',
  'invalid',
  'blocked'
);

-- Add validation_report column to trial_balance_uploads
ALTER TABLE public.trial_balance_uploads
  ADD COLUMN IF NOT EXISTS validation_report JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS accounting_errors JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS is_valid BOOLEAN DEFAULT NULL;

-- Add audit_action enum values for mapping operations
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'create_account_mapping';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'update_account_mapping';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'delete_account_mapping';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'validation_failed';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'validation_passed';