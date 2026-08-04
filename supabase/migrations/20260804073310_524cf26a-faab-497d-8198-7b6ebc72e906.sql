CREATE TABLE public.onboarding_progress (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period_year INTEGER NOT NULL,
  current_step TEXT NOT NULL DEFAULT 'upload',
  dismissed BOOLEAN NOT NULL DEFAULT false,
  reviewed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, company_id, period_year)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.onboarding_progress TO authenticated;
GRANT ALL ON public.onboarding_progress TO service_role;

ALTER TABLE public.onboarding_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own onboarding progress"
  ON public.onboarding_progress FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND company_id IN (SELECT public.get_member_company_ids()));

CREATE POLICY "Users insert own onboarding progress"
  ON public.onboarding_progress FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND company_id IN (SELECT public.get_member_company_ids()));

CREATE POLICY "Users update own onboarding progress"
  ON public.onboarding_progress FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND company_id IN (SELECT public.get_member_company_ids()))
  WITH CHECK (user_id = auth.uid() AND company_id IN (SELECT public.get_member_company_ids()));

CREATE POLICY "Users delete own onboarding progress"
  ON public.onboarding_progress FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND company_id IN (SELECT public.get_member_company_ids()));

CREATE TRIGGER update_onboarding_progress_updated_at
  BEFORE UPDATE ON public.onboarding_progress
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();