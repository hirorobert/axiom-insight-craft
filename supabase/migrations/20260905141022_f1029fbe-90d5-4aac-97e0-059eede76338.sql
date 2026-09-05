SET search_path TO public, pg_catalog;

CREATE OR REPLACE FUNCTION public.is_commercial_admin()
  RETURNS BOOLEAN
  LANGUAGE plpgsql
  SECURITY DEFINER
  STABLE
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.commercial_admins ca
     WHERE ca.user_id = v_user_id AND ca.active
  );
END;
$$;

COMMENT ON FUNCTION public.is_commercial_admin() IS
  'Ω1-RLS1: SECURITY DEFINER RLS helper breaking DEFECT-Ω1-COMMERCIAL-RLS-RECURSION-001. Checks auth.uid() only; returns boolean only; read-only; grants no accounting authority.';

REVOKE ALL ON FUNCTION public.is_commercial_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_commercial_admin() TO authenticated;

ALTER POLICY "ca_select_self_or_admin" ON public.commercial_admins
  USING (
    user_id = auth.uid()
    OR public.is_commercial_admin()
  );

ALTER POLICY "bc_select_owner_or_admin" ON public.billing_customers
  USING (
    owner_user_id = auth.uid()
    OR public.is_commercial_admin()
  );

ALTER POLICY "cl_select_owner_or_admin" ON public.commercial_licences
  USING (
    billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid())
    OR public.is_commercial_admin()
  );

ALTER POLICY "pe_select_owner_or_admin" ON public.payment_events
  USING (
    billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid())
    OR public.is_commercial_admin()
  );

ALTER POLICY "eo_select_owner_or_admin" ON public.entitlement_overrides
  USING (
    billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid())
    OR public.is_commercial_admin()
  );

ALTER POLICY "bae_select_owner_or_admin" ON public.billing_audit_events
  USING (
    billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid())
    OR public.is_commercial_admin()
  );