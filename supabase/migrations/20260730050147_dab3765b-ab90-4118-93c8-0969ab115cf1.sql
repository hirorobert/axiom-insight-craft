ALTER TABLE public.firm_members DISABLE TRIGGER USER;
DELETE FROM public.firm_members;
ALTER TABLE public.firm_members ENABLE TRIGGER USER;
DELETE FROM public.trial_balance_uploads;
DELETE FROM public.companies;