CREATE OR REPLACE FUNCTION public.safisha_recon_visible(_recon_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.safisha_reconciliations r
    LEFT JOIN public.trial_balance_uploads u ON u.id = r.tb_upload_id
    WHERE r.id = _recon_id
      AND (
        r.client_id = auth.uid()
        OR (
          u.company_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.firm_members fm
            WHERE fm.company_id = u.company_id
              AND fm.user_id = auth.uid()
              AND fm.accepted_at IS NOT NULL
          )
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.safisha_recon_visible(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.safisha_recon_visible(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.safisha_recon_visible(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS safisha_exc_select ON public.safisha_exceptions;
CREATE POLICY safisha_exc_select ON public.safisha_exceptions
  FOR SELECT TO authenticated
  USING (public.safisha_recon_visible(reconciliation_id));

DROP POLICY IF EXISTS safisha_txn_select ON public.safisha_transactions;
CREATE POLICY safisha_txn_select ON public.safisha_transactions
  FOR SELECT TO authenticated
  USING (public.safisha_recon_visible(reconciliation_id));

DROP POLICY IF EXISTS safisha_audit_select ON public.safisha_audit_log;
CREATE POLICY safisha_audit_select ON public.safisha_audit_log
  FOR SELECT TO authenticated
  USING (public.safisha_recon_visible(reconciliation_id));