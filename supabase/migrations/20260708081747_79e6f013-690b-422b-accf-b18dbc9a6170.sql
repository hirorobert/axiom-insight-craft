
-- 1. RLS on keyword_dictionary
ALTER TABLE public.keyword_dictionary ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kd_select_authenticated" ON public.keyword_dictionary FOR SELECT TO authenticated USING (true);
CREATE POLICY "kd_service_all" ON public.keyword_dictionary FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. RLS on tax_computations
ALTER TABLE public.tax_computations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tc_select" ON public.tax_computations FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.firm_members fm WHERE fm.user_id=auth.uid() AND fm.company_id=tax_computations.company_id));
CREATE POLICY "tc_insert" ON public.tax_computations FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.firm_members fm WHERE fm.user_id=auth.uid() AND fm.company_id=tax_computations.company_id));
CREATE POLICY "tc_update" ON public.tax_computations FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.firm_members fm WHERE fm.user_id=auth.uid() AND fm.company_id=tax_computations.company_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.firm_members fm WHERE fm.user_id=auth.uid() AND fm.company_id=tax_computations.company_id));
CREATE POLICY "tc_delete" ON public.tax_computations FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.firm_members fm WHERE fm.user_id=auth.uid() AND fm.company_id=tax_computations.company_id));
CREATE POLICY "tc_service_all" ON public.tax_computations FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. Revoke ALL from anon on every public table & view
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relkind IN ('r','v')
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', r.relname);
  END LOOP;
END $$;

-- Revoke authenticated on internal views
REVOKE ALL ON public.v_aje_balance_check FROM authenticated;
REVOKE ALL ON public.v_loss_history FROM authenticated;
REVOKE ALL ON public.v_period_pairs FROM authenticated;
REVOKE ALL ON public.v_wdv_carry_forward FROM authenticated;

GRANT ALL ON public.v_aje_balance_check TO service_role;
GRANT ALL ON public.v_loss_history TO service_role;
GRANT ALL ON public.v_period_pairs TO service_role;
GRANT ALL ON public.v_wdv_carry_forward TO service_role;
GRANT ALL ON public.keyword_dictionary TO service_role;
GRANT SELECT ON public.keyword_dictionary TO authenticated;
GRANT ALL ON public.tax_computations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tax_computations TO authenticated;

-- 4. Rebuild views as SECURITY INVOKER
ALTER VIEW public.v_aje_balance_check SET (security_invoker = on);
ALTER VIEW public.v_loss_history      SET (security_invoker = on);
ALTER VIEW public.v_period_pairs      SET (security_invoker = on);
ALTER VIEW public.v_wdv_carry_forward SET (security_invoker = on);

-- 5. Revoke EXECUTE on SECURITY DEFINER functions
REVOKE EXECUTE ON FUNCTION public.carry_forward_wdv(uuid,integer,integer)    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.create_owner_firm_member()                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_verified_statutory_rule()          FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_member_company_ids()                   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user()                          FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_last_owner_delete()                FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_last_owner_demote()                FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_unauthorized_owner_insert()        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_finding_response_pack_ready()       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_canonical_record()                FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_member_company_ids() TO authenticated;

-- 6. Set search_path on functions missing it
ALTER FUNCTION public.cascade_period_lock()                     SET search_path = public;
ALTER FUNCTION public.close_prior_statutory_rule()              SET search_path = public;
ALTER FUNCTION public.guard_upload_on_locked_period()           SET search_path = public;
ALTER FUNCTION public.prevent_batch_delete()                    SET search_path = public;
ALTER FUNCTION public.prevent_batch_field_mutation()            SET search_path = public;
ALTER FUNCTION public.prevent_canonical_record_delete()         SET search_path = public;
ALTER FUNCTION public.prevent_canonical_record_update()         SET search_path = public;
ALTER FUNCTION public.prevent_finding_id_change()               SET search_path = public;
ALTER FUNCTION public.promote_valid_upload_to_active()          SET search_path = public;
ALTER FUNCTION public.sync_upload_fiscal_year_end()             SET search_path = public;
ALTER FUNCTION public.sync_upload_period_year()                 SET search_path = public;
ALTER FUNCTION public.carry_forward_wdv(uuid,integer,integer)   SET search_path = public;

-- 7. Fix avatars bucket public listing
DROP POLICY IF EXISTS "Avatars are publicly accessible" ON storage.objects;
CREATE POLICY "Users can view their own avatar"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (auth.uid())::text);
