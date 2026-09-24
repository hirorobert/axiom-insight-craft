CREATE OR REPLACE FUNCTION public.trial_balance_upload_lifecycle_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
     AND COALESCE(current_setting('axiom.tbu_lifecycle_op', true), '') = ''
     AND NEW.company_id IS NOT NULL THEN
    PERFORM public.tbu_log_event(NEW.id, NEW.company_id, NEW.engagement_id, NEW.period_year,
      OLD.lifecycle_state, NEW.lifecycle_state, 'engine', auth.uid(), NULL, 'engine', NULL, 'applied', NULL,
      'Processing started (status ' || COALESCE(NEW.status, 'NULL') || ')');
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.trial_balance_upload_lifecycle_audit() FROM PUBLIC, anon, authenticated;