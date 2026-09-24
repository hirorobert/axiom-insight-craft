CREATE OR REPLACE FUNCTION public.tbu_prepare_capabilities()
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT ARRAY['manage_source_files', 'prepare_trial_balance']::text[];
$$;

CREATE OR REPLACE FUNCTION public.tbu_can_read_prepare(p_company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_company_id IS NOT NULL AND auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(public.tbu_prepare_capabilities()) cap
     WHERE public.workspace_authority_basis(auth.uid(), p_company_id, cap) IS NOT NULL);
$$;

CREATE OR REPLACE FUNCTION public.get_workspace_access(p_company_id uuid)
RETURNS TABLE (company_id uuid, access text, capabilities text[], stages text[], name text, fiscal_year_end text,
               reporting_framework text, currency text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_company public.companies%ROWTYPE;
  v_caps text[];
  v_all constant text[] := ARRAY['prepare', 'reconcile', 'statements', 'tax', 'compliance', 'filing', 'monitor'];
BEGIN
  IF v_uid IS NULL OR p_company_id IS NULL THEN RETURN; END IF;
  SELECT * INTO v_company FROM public.companies c WHERE c.id = p_company_id;
  IF v_company.id IS NULL THEN RETURN; END IF;

  SELECT COALESCE(array_agg(DISTINCT g.capability ORDER BY g.capability), ARRAY[]::text[]) INTO v_caps
    FROM public.workspace_capability_grants g
   WHERE g.company_id = p_company_id AND g.grantee_user_id = v_uid AND g.revoked_at IS NULL;

  IF v_company.user_id = v_uid THEN
    RETURN QUERY SELECT v_company.id, 'owner'::text, v_caps, v_all, v_company.name, v_company.fiscal_year_end,
      v_company.reporting_framework, v_company.currency, v_company.created_at;
  ELSIF EXISTS (SELECT 1 FROM public.firm_members fm
                 WHERE fm.user_id = v_uid AND fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL) THEN
    RETURN QUERY SELECT v_company.id, 'member'::text, v_caps, v_all, v_company.name, v_company.fiscal_year_end,
      v_company.reporting_framework, v_company.currency, v_company.created_at;
  ELSIF v_caps && public.tbu_prepare_capabilities() AND COALESCE(v_company.is_active, true) THEN
    RETURN QUERY SELECT v_company.id, 'capability'::text, v_caps, ARRAY['prepare']::text[], v_company.name,
      v_company.fiscal_year_end, v_company.reporting_framework, v_company.currency, v_company.created_at;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_shared_workspaces()
RETURNS TABLE (company_id uuid, capabilities text[], name text, fiscal_year_end text, reporting_framework text,
               currency text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.id, array_agg(DISTINCT g.capability ORDER BY g.capability), c.name, c.fiscal_year_end,
         c.reporting_framework, c.currency, c.created_at
    FROM public.workspace_capability_grants g
    JOIN public.companies c ON c.id = g.company_id
   WHERE auth.uid() IS NOT NULL AND g.grantee_user_id = auth.uid() AND g.revoked_at IS NULL
     AND g.capability = ANY (public.tbu_prepare_capabilities())
     AND c.user_id IS DISTINCT FROM auth.uid() AND COALESCE(c.is_active, true)
   GROUP BY c.id, c.name, c.fiscal_year_end, c.reporting_framework, c.currency, c.created_at
   ORDER BY c.name, c.id;
$$;

DROP POLICY IF EXISTS "Workspace owner and Prepare grant holders read uploads" ON public.trial_balance_uploads;
CREATE POLICY "Workspace owner and Prepare grant holders read uploads" ON public.trial_balance_uploads
  FOR SELECT TO authenticated USING (public.tbu_can_read_prepare(company_id));
DROP POLICY IF EXISTS "Workspace owner and Prepare grant holders read certifications" ON public.tb_certifications;
CREATE POLICY "Workspace owner and Prepare grant holders read certifications" ON public.tb_certifications
  FOR SELECT TO authenticated USING (public.tbu_can_read_prepare(company_id));

REVOKE ALL ON FUNCTION public.tbu_prepare_capabilities() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_can_read_prepare(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_workspace_access(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_shared_workspaces() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tbu_can_read_prepare(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_workspace_access(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_shared_workspaces() TO authenticated;

CREATE OR REPLACE FUNCTION public.tbu_source_sweeper_status()
RETURNS TABLE (function_url text, pg_net_installed boolean, cron_job_active boolean, cron_schedule text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_active boolean;
  v_schedule text;
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE 'SELECT j.active, j.schedule FROM cron.job j WHERE j.jobname = $1 LIMIT 1'
      INTO v_active, v_schedule USING 'trial-balance-source-sweeper';
  END IF;
  RETURN QUERY SELECT (SELECT c.function_url FROM public.tbu_source_sweeper_config c WHERE c.id),
    to_regproc('net.http_post') IS NOT NULL, COALESCE(v_active, false), v_schedule;
END;
$$;
REVOKE ALL ON FUNCTION public.tbu_source_sweeper_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tbu_source_sweeper_status() TO service_role;