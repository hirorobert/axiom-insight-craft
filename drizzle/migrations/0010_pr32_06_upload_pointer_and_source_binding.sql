DO $refuse$
DECLARE
  v_stale integer;
BEGIN
  SELECT count(*) INTO v_stale
    FROM public.fiscal_periods fp
    JOIN public.trial_balance_uploads t ON t.id = fp.active_upload_id
   WHERE t.lifecycle_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked');
  IF v_stale > 0 THEN
    RAISE EXCEPTION 'upload pointer hardening refused: % fiscal period(s) name a non-active upload as their active upload. Nothing was changed. Run scripts/db-preflight/uploadLifecyclePreflight.sql (section 9) and reconcile fiscal_periods.active_upload_id before applying.', v_stale
      USING ERRCODE = '55000';
  END IF;
END
$refuse$;

CREATE OR REPLACE FUNCTION public.tbu_sync_fiscal_period_pointer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_new_active boolean := NEW.lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked');
  v_old_active boolean := OLD.lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked');
BEGIN
  IF NEW.lifecycle_state IS NOT DISTINCT FROM OLD.lifecycle_state THEN
    RETURN NULL;
  END IF;
  IF NOT v_new_active THEN
    UPDATE public.fiscal_periods fp SET active_upload_id = NULL, updated_at = now() WHERE fp.active_upload_id = NEW.id;
  ELSIF NOT v_old_active AND NEW.status = 'valid' AND NEW.period_id IS NOT NULL THEN
    UPDATE public.fiscal_periods fp SET active_upload_id = NEW.id, updated_at = now()
     WHERE fp.id = NEW.period_id AND fp.active_upload_id IS NULL;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_tbu_sync_fiscal_period_pointer ON public.trial_balance_uploads;
CREATE TRIGGER trg_tbu_sync_fiscal_period_pointer
  AFTER UPDATE ON public.trial_balance_uploads
  FOR EACH ROW EXECUTE FUNCTION public.tbu_sync_fiscal_period_pointer();

CREATE OR REPLACE FUNCTION public.tbu_source_path_bound(p_file_path text, p_upload_id uuid, p_company_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(
    p_file_path IS NOT NULL
    AND p_file_path !~ '(^/|\.\.|//|\\)'
    AND CASE
          WHEN p_file_path LIKE 'workspaces/%' THEN
            p_company_id IS NOT NULL
            AND split_part(p_file_path, '/', 2) = p_company_id::text
            AND EXISTS (SELECT 1 FROM public.trial_balance_source_reservations r
                         WHERE r.object_path = p_file_path AND r.company_id = p_company_id
                           AND r.consumed_by_upload_id = p_upload_id)
          ELSE
            p_user_id IS NOT NULL
            AND split_part(p_file_path, '/', 1) = p_user_id::text
            AND split_part(p_file_path, '/', 2) <> ''
        END, false);
$$;

CREATE OR REPLACE FUNCTION public.tbu_upload_source_bound(p_upload_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((SELECT public.tbu_source_path_bound(t.file_path, t.id, t.company_id, t.user_id)
                     FROM public.trial_balance_uploads t WHERE t.id = p_upload_id), false);
$$;

CREATE OR REPLACE FUNCTION public.tbu_object_referenced(p_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_path IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.trial_balance_uploads t
     WHERE t.file_path = p_path AND public.tbu_source_path_bound(t.file_path, t.id, t.company_id, t.user_id));
$$;

CREATE OR REPLACE FUNCTION public.trial_balance_upload_client_source_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.file_path IS DISTINCT FROM OLD.file_path OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'Iron Dome: a trial balance upload''s source path and uploader are set by the server only.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF v_uid IS NULL OR NEW.user_id IS DISTINCT FROM v_uid OR NEW.file_path IS NULL
     OR NEW.file_path ~ '(^/|\.\.|//|\\)'
     OR split_part(NEW.file_path, '/', 1) <> v_uid::text
     OR split_part(NEW.file_path, '/', 2) = '' THEN
    RAISE EXCEPTION 'Iron Dome: a directly created upload must name a file in your own folder. Workspace sources are registered by the server.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tbu_client_source_guard ON public.trial_balance_uploads;
CREATE TRIGGER trg_tbu_client_source_guard
  BEFORE INSERT OR UPDATE ON public.trial_balance_uploads
  FOR EACH ROW EXECUTE FUNCTION public.trial_balance_upload_client_source_guard();

REVOKE ALL ON FUNCTION public.tbu_sync_fiscal_period_pointer() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trial_balance_upload_client_source_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_source_path_bound(text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_upload_source_bound(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_object_referenced(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tbu_upload_source_bound(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.tbu_object_referenced(text) TO service_role;