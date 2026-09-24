CREATE OR REPLACE FUNCTION public.tbu_path_well_formed(p_path text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(
    p_path IS NOT NULL AND p_path <> ''
    AND position(E'\\' IN p_path) = 0
    AND p_path !~ '[[:cntrl:]]'
    AND NOT EXISTS (SELECT 1 FROM unnest(string_to_array(p_path, '/')) AS s(seg) WHERE s.seg IN ('', '.', '..')),
    false);
$$;

CREATE OR REPLACE FUNCTION public.tbu_personal_source_path(p_path text, p_user_id uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(
    public.tbu_path_well_formed(p_path) AND p_user_id IS NOT NULL
    AND array_length(string_to_array(p_path, '/'), 1) = 2
    AND split_part(p_path, '/', 1) = p_user_id::text,
    false);
$$;

CREATE OR REPLACE FUNCTION public.tbu_workspace_source_path_shape(p_path text, p_company_id uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(
    public.tbu_path_well_formed(p_path) AND p_company_id IS NOT NULL
    AND array_length(string_to_array(p_path, '/'), 1) = 4
    AND split_part(p_path, '/', 1) = 'workspaces'
    AND split_part(p_path, '/', 2) = p_company_id::text,
    false);
$$;

CREATE OR REPLACE FUNCTION public.tbu_source_path_bound(p_file_path text, p_upload_id uuid, p_company_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN split_part(COALESCE(p_file_path, ''), '/', 1) = 'workspaces' THEN
      public.tbu_workspace_source_path_shape(p_file_path, p_company_id)
      AND EXISTS (SELECT 1 FROM public.trial_balance_source_reservations r
                   WHERE r.object_path = p_file_path AND r.company_id = p_company_id AND r.consumed_by_upload_id = p_upload_id)
    ELSE public.tbu_personal_source_path(p_file_path, p_user_id)
  END;
$$;

CREATE OR REPLACE FUNCTION public.tbu_bound_storage_path(p_upload public.trial_balance_uploads)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN public.tbu_source_path_bound(p_upload.file_path, p_upload.id, p_upload.company_id, p_upload.user_id)
         AND NOT EXISTS (SELECT 1 FROM public.trial_balance_uploads t
                          WHERE t.file_path = p_upload.file_path AND t.id <> p_upload.id
                            AND public.tbu_source_path_bound(t.file_path, t.id, t.company_id, t.user_id))
    THEN p_upload.file_path
  END;
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
  IF v_uid IS NULL OR NEW.user_id IS DISTINCT FROM v_uid OR NOT public.tbu_personal_source_path(NEW.file_path, v_uid) THEN
    RAISE EXCEPTION 'Iron Dome: a directly created upload must name a file in your own folder. Workspace sources are registered by the server.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trial_balance_upload_workspace_binding_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_internal boolean := current_user NOT IN ('anon', 'authenticated', 'service_role');
BEGIN
  IF OLD.company_id IS NULL AND NEW.company_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.company_id IS NOT DISTINCT FROM OLD.company_id AND NEW.period_id IS NOT DISTINCT FROM OLD.period_id
     AND NEW.period_year IS NOT DISTINCT FROM OLD.period_year AND NEW.fiscal_year_end IS NOT DISTINCT FROM OLD.fiscal_year_end
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id AND NEW.file_path IS NOT DISTINCT FROM OLD.file_path THEN
    RETURN NEW;
  END IF;
  IF v_internal AND COALESCE(current_setting('axiom.tbu_lifecycle_op', true), '') <> '' THEN
    RETURN NEW;
  END IF;
  IF v_internal AND pg_trigger_depth() > 1
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id AND NEW.file_path IS NOT DISTINCT FROM OLD.file_path
     AND (NEW.company_id IS NOT DISTINCT FROM OLD.company_id
          OR (NEW.company_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id)))
     AND (NEW.period_id IS NOT DISTINCT FROM OLD.period_id
          OR (NEW.period_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.fiscal_periods f WHERE f.id = OLD.period_id)))
     AND ((NEW.period_year IS NOT DISTINCT FROM OLD.period_year AND NEW.fiscal_year_end IS NOT DISTINCT FROM OLD.fiscal_year_end)
          OR (NEW.period_id IS NULL AND OLD.period_id IS NOT NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Iron Dome: a workspace trial balance upload cannot be detached from its workspace, attached to one, moved to another period, or re-pointed at another file or uploader.'
    USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_tbu_workspace_binding_immutable ON public.trial_balance_uploads;
CREATE TRIGGER trg_tbu_workspace_binding_immutable
  BEFORE UPDATE ON public.trial_balance_uploads
  FOR EACH ROW EXECUTE FUNCTION public.trial_balance_upload_workspace_binding_guard();

CREATE OR REPLACE FUNCTION public.tbu_log_event(
  p_upload_id uuid, p_company_id uuid, p_engagement_id uuid, p_period_year integer,
  p_from text, p_to text, p_actor_kind text, p_actor_user uuid, p_actor_membership uuid,
  p_basis text, p_capability text, p_outcome text, p_operation_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_company_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.trial_balance_upload_lifecycle_events
    (upload_id, company_id, engagement_id, period_year, from_state, to_state, actor_kind, actor_user_id,
     actor_membership_id, authority_basis, authority_capability, outcome, operation_id, reason)
  VALUES (p_upload_id, p_company_id, p_engagement_id, p_period_year, p_from, p_to, p_actor_kind, p_actor_user,
          p_actor_membership, p_basis, p_capability, p_outcome, p_operation_id, p_reason);
END;
$$;

REVOKE ALL ON FUNCTION public.tbu_path_well_formed(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tbu_personal_source_path(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tbu_workspace_source_path_shape(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tbu_path_well_formed(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tbu_personal_source_path(text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tbu_workspace_source_path_shape(text, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.tbu_source_path_bound(text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_bound_storage_path(public.trial_balance_uploads) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trial_balance_upload_client_source_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trial_balance_upload_workspace_binding_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_log_event(uuid, uuid, uuid, integer, text, text, text, uuid, uuid, text, text, text, uuid, text) FROM PUBLIC, anon, authenticated;