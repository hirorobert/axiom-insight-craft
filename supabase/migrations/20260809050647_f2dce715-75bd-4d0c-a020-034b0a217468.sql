-- 1. Company-scoped tenancy helper for reconciliations
CREATE OR REPLACE FUNCTION public.safisha_recon_company_scoped(_recon_id uuid)
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
        CASE
          WHEN u.company_id IS NOT NULL
            THEN u.company_id IN (SELECT public.get_member_company_ids())
          ELSE r.client_id = auth.uid()
        END
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.safisha_upload_company_scoped(_upload_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.trial_balance_uploads u
    WHERE u.id = _upload_id
      AND u.company_id IS NOT NULL
      AND u.company_id IN (SELECT public.get_member_company_ids())
  );
$$;

-- 2. safisha_reconciliations: replace client_id-only scoping with company tenancy
DROP POLICY IF EXISTS safisha_recon_select ON public.safisha_reconciliations;
DROP POLICY IF EXISTS safisha_recon_update ON public.safisha_reconciliations;
DROP POLICY IF EXISTS safisha_recon_insert ON public.safisha_reconciliations;

CREATE POLICY safisha_recon_select
ON public.safisha_reconciliations
FOR SELECT
TO authenticated
USING (public.safisha_recon_company_scoped(id));

CREATE POLICY safisha_recon_update
ON public.safisha_reconciliations
FOR UPDATE
TO authenticated
USING (public.safisha_recon_company_scoped(id))
WITH CHECK (public.safisha_recon_company_scoped(id));

CREATE POLICY safisha_recon_insert
ON public.safisha_reconciliations
FOR INSERT
TO authenticated
WITH CHECK (
  client_id = auth.uid()
  AND public.safisha_upload_company_scoped(tb_upload_id)
);

-- 3. Child tables: writes must satisfy the same company tenancy check
DROP POLICY IF EXISTS safisha_txn_insert ON public.safisha_transactions;
CREATE POLICY safisha_txn_insert
ON public.safisha_transactions
FOR INSERT
TO authenticated
WITH CHECK (public.safisha_recon_company_scoped(reconciliation_id));

DROP POLICY IF EXISTS safisha_exc_insert ON public.safisha_exceptions;
CREATE POLICY safisha_exc_insert
ON public.safisha_exceptions
FOR INSERT
TO authenticated
WITH CHECK (public.safisha_recon_company_scoped(reconciliation_id));

-- 4. safisha_client_mappings: owner-scoped, split from broad ALL policy
DROP POLICY IF EXISTS safisha_mapping_all ON public.safisha_client_mappings;
CREATE POLICY safisha_mapping_select ON public.safisha_client_mappings
FOR SELECT TO authenticated USING (client_id = auth.uid());
CREATE POLICY safisha_mapping_insert ON public.safisha_client_mappings
FOR INSERT TO authenticated WITH CHECK (client_id = auth.uid());
CREATE POLICY safisha_mapping_update ON public.safisha_client_mappings
FOR UPDATE TO authenticated USING (client_id = auth.uid()) WITH CHECK (client_id = auth.uid());
CREATE POLICY safisha_mapping_delete ON public.safisha_client_mappings
FOR DELETE TO authenticated USING (client_id = auth.uid());

-- 5. maono_monitor_runs: explicitly locked to backend services only
REVOKE ALL ON public.maono_monitor_runs FROM anon;
REVOKE ALL ON public.maono_monitor_runs FROM authenticated;
GRANT ALL ON public.maono_monitor_runs TO service_role;
ALTER TABLE public.maono_monitor_runs ENABLE ROW LEVEL SECURITY;