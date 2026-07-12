
-- ── 1. Role gating on privileged writes ─────────────────────────────
-- Allowed writer roles for privileged actions
-- (owner, partner, preparer, manager). Viewers and other roles denied.

-- adjusting_journal_entries
DROP POLICY IF EXISTS aje_insert ON public.adjusting_journal_entries;
CREATE POLICY aje_insert ON public.adjusting_journal_entries
FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = created_by
  AND EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = adjusting_journal_entries.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
);

DROP POLICY IF EXISTS aje_update ON public.adjusting_journal_entries;
CREATE POLICY aje_update ON public.adjusting_journal_entries
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = adjusting_journal_entries.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = adjusting_journal_entries.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
);

-- capital_allowances
DROP POLICY IF EXISTS ca_insert ON public.capital_allowances;
CREATE POLICY ca_insert ON public.capital_allowances
FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = created_by
  AND EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = capital_allowances.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
);

DROP POLICY IF EXISTS ca_update ON public.capital_allowances;
CREATE POLICY ca_update ON public.capital_allowances
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = capital_allowances.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = capital_allowances.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
);

DROP POLICY IF EXISTS ca_delete ON public.capital_allowances;
CREATE POLICY ca_delete ON public.capital_allowances
FOR DELETE TO authenticated
USING (
  created_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = capital_allowances.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
);

-- tax_payments
DROP POLICY IF EXISTS tax_payments_insert ON public.tax_payments;
CREATE POLICY tax_payments_insert ON public.tax_payments
FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = created_by
  AND EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = tax_payments.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
);

DROP POLICY IF EXISTS tax_payments_update ON public.tax_payments;
CREATE POLICY tax_payments_update ON public.tax_payments
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = tax_payments.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = tax_payments.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
);

DROP POLICY IF EXISTS tax_payments_delete ON public.tax_payments;
CREATE POLICY tax_payments_delete ON public.tax_payments
FOR DELETE TO authenticated
USING (
  created_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = tax_payments.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
);

-- tax_losses
DROP POLICY IF EXISTS tl_insert ON public.tax_losses;
CREATE POLICY tl_insert ON public.tax_losses
FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = created_by
  AND EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = tax_losses.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
);

DROP POLICY IF EXISTS tl_update ON public.tax_losses;
CREATE POLICY tl_update ON public.tax_losses
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = tax_losses.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = tax_losses.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
);

-- statement_sign_offs (only preparer/manager/partner/owner can sign off)
DROP POLICY IF EXISTS sso_insert ON public.statement_sign_offs;
CREATE POLICY sso_insert ON public.statement_sign_offs
FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = statement_sign_offs.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
);

DROP POLICY IF EXISTS sso_update ON public.statement_sign_offs;
CREATE POLICY sso_update ON public.statement_sign_offs
FOR UPDATE TO authenticated
USING (
  locked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = statement_sign_offs.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = statement_sign_offs.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
  )
);

-- ── 2. maono_monitor_runs — service_role only ─────────────────────────
-- The table is a cross-company scan log with no company_id; regular users
-- must not read or write it. Service role bypasses RLS and still works.
DROP POLICY IF EXISTS monitor_runs_read ON public.maono_monitor_runs;
DROP POLICY IF EXISTS monitor_runs_write ON public.maono_monitor_runs;

REVOKE ALL ON public.maono_monitor_runs FROM anon, authenticated;
GRANT  ALL ON public.maono_monitor_runs TO service_role;

-- ── 3. Function search_path hardening ─────────────────────────────────
ALTER FUNCTION public.safisha_block_audit_mutation()      SET search_path = public;
ALTER FUNCTION public.safisha_block_transaction_mutation() SET search_path = public;
ALTER FUNCTION public.safisha_enforce_resolve_gate()      SET search_path = public;
ALTER FUNCTION public.safisha_resolve_exception(uuid, uuid, text, text) SET search_path = public;

-- ── 4. Revoke default EXECUTE on SECURITY DEFINER helpers ─────────────
-- Trigger functions never need direct EXECUTE from clients.
-- get_member_company_ids is called from RLS by authenticated users — keep grant.
DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND p.proname NOT IN ('get_member_company_ids')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn.sig);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO service_role', fn.sig);
  END LOOP;
END $$;

-- ── 5. Revoke anon SELECT / GraphQL exposure on internal tables ───────
-- No app flow reads these tables anonymously.
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname='public'
  LOOP
    EXECUTE format('REVOKE SELECT ON public.%I FROM anon', t.tablename);
  END LOOP;
END $$;
