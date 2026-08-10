ALTER TABLE public.trial_balance_uploads
  ADD COLUMN IF NOT EXISTS engagement_id uuid REFERENCES public.engagements(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS trial_balance_uploads_engagement_id_idx
  ON public.trial_balance_uploads (engagement_id);

CREATE OR REPLACE FUNCTION public.validate_upload_engagement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e_company uuid;
  e_period uuid;
BEGIN
  IF NEW.engagement_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT company_id, fiscal_period_id INTO e_company, e_period
  FROM public.engagements
  WHERE id = NEW.engagement_id;

  IF e_company IS NULL THEN
    RAISE EXCEPTION 'Engagement % not found', NEW.engagement_id;
  END IF;

  IF NEW.company_id IS NOT NULL AND NEW.company_id <> e_company THEN
    RAISE EXCEPTION 'Engagement belongs to a different company';
  END IF;

  IF NEW.period_id IS NOT NULL AND e_period IS NOT NULL AND NEW.period_id <> e_period THEN
    RAISE EXCEPTION 'Engagement belongs to a different reporting period';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_upload_engagement_trg ON public.trial_balance_uploads;
CREATE TRIGGER validate_upload_engagement_trg
  BEFORE INSERT OR UPDATE OF engagement_id, company_id, period_id
  ON public.trial_balance_uploads
  FOR EACH ROW EXECUTE FUNCTION public.validate_upload_engagement();