-- New companies must not require an existing beta enrollment to enroll their first accepted owner.
-- No enrollment, rollout, allowance, financial record or approval is changed by installation.
CREATE OR REPLACE FUNCTION public.internal_beta_team_status(p_company_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF auth.uid() IS NULL OR public._workspace_access_basis(auth.uid(),p_company_id) IS NULL
    OR NOT public.has_workspace_capability(p_company_id,auth.uid(),'manage_members') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('userId',m.user_id,'enrolled',
    EXISTS(SELECT 1 FROM public.internal_beta_enrollments e WHERE e.company_id=p_company_id AND e.user_id=m.user_id AND e.revoked_at IS NULL)))
    FROM public.firm_members m WHERE m.company_id=p_company_id AND m.accepted_at IS NOT NULL),'[]'::jsonb);
END;
$$;
CREATE OR REPLACE FUNCTION public.internal_beta_enroll_member(p_company_id uuid,p_user_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE changed integer;
BEGIN
  -- Serialize the two membership checks with enrollment and with membership removal.
  PERFORM 1 FROM public.firm_members WHERE company_id=p_company_id
    AND user_id IN (auth.uid(),p_user_id) ORDER BY id FOR UPDATE;
  IF auth.uid() IS NULL OR public._workspace_access_basis(auth.uid(),p_company_id) IS NULL
    OR NOT public.has_workspace_capability(p_company_id,auth.uid(),'manage_members') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason))<10 OR NOT EXISTS(SELECT 1 FROM public.firm_members
    WHERE company_id=p_company_id AND user_id=p_user_id AND accepted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'ACCEPTED_MEMBER_REQUIRED';
  END IF;
  INSERT INTO public.internal_beta_enrollments(company_id,user_id,basis)
    VALUES(p_company_id,p_user_id,'owner_enrolled_member')
    ON CONFLICT(company_id,user_id) DO UPDATE SET revoked_at=NULL,basis='owner_enrolled_member',enrolled_at=now()
      WHERE internal_beta_enrollments.revoked_at IS NOT NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed=1 THEN
    INSERT INTO public.internal_beta_events(actor_user_id,action,reason,detail)
      VALUES(auth.uid(),'ENROLL_MEMBER',btrim(p_reason),jsonb_build_object('companyId',p_company_id,'userId',p_user_id));
  END IF;
  RETURN jsonb_build_object('outcome','recorded','replayed',changed=0);
END;
$$;
REVOKE ALL ON FUNCTION public.internal_beta_team_status(uuid),public.internal_beta_enroll_member(uuid,uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.internal_beta_team_status(uuid),public.internal_beta_enroll_member(uuid,uuid,text) TO authenticated;
DO $$ BEGIN
  IF has_function_privilege('anon','public.internal_beta_enroll_member(uuid,uuid,text)','EXECUTE')
    OR has_function_privilege('service_role','public.internal_beta_enroll_member(uuid,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'BETA_TEAM_PRIVILEGE_POSTCONDITION';
  END IF;
END $$;
