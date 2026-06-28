-- Add new audit action values for company management
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'create_company';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'update_company';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'delete_company';