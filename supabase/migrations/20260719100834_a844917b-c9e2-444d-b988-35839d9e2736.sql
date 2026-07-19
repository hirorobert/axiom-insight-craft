
-- ============================================================
-- 1) Revoke EXECUTE from PUBLIC/anon/authenticated on all
--    SECURITY DEFINER functions in public schema, then re-grant
--    to authenticated only for those needed by client/edge RPCs.
-- ============================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
  END LOOP;
END $$;

-- Re-grant EXECUTE to authenticated only for functions invoked via RPC
-- by client code or edge functions that forward the user's JWT.
GRANT EXECUTE ON FUNCTION public.get_member_company_ids()                                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.safisha_resolve_exception(uuid, uuid, text, text)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.safisha_append_evidence_file(uuid, text, text, integer)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.xbrl_write_instance(uuid, uuid, integer, text, text, text, text, text, integer, boolean, integer, integer, integer, uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hesabu_write_validation(uuid, uuid, integer, text, integer, integer, integer, integer, numeric, numeric, numeric, uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.maono_write_alert(uuid, uuid, text, text, text[], text[], text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.maono_write_board_pack(uuid, uuid, text, text, jsonb, text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.maono_check_safisha_gate(uuid[])                            TO authenticated;
GRANT EXECUTE ON FUNCTION public.maono_compute_confidence(uuid, integer)                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.carry_forward_wdv(uuid, integer, integer)                   TO authenticated;

-- ============================================================
-- 2) Revoke SELECT from anon on all public-schema tables so
--    they are not discoverable via GraphQL / PostgREST as anon.
-- ============================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('REVOKE SELECT ON public.%I FROM anon', r.relname);
  END LOOP;
END $$;

-- ============================================================
-- 3) Retarget policies from role "public" to "authenticated".
--    Recreate SELECT policies with tighter role checks where
--    the scanner flagged missing role gates.
-- ============================================================

-- adjusting_journal_entries.aje_select — restrict to preparer+ roles
DROP POLICY IF EXISTS aje_select ON public.adjusting_journal_entries;
CREATE POLICY aje_select ON public.adjusting_journal_entries
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = adjusting_journal_entries.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager','reviewer'])
  ));

-- aje_lines: retarget both policies to authenticated, restrict SELECT by role
DROP POLICY IF EXISTS aje_lines_select ON public.aje_lines;
CREATE POLICY aje_lines_select ON public.aje_lines
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.adjusting_journal_entries a
    JOIN public.firm_members fm ON fm.company_id = a.company_id
    WHERE a.id = aje_lines.aje_id
      AND fm.user_id = auth.uid()
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager','reviewer'])
  ));
DROP POLICY IF EXISTS aje_lines_insert ON public.aje_lines;
CREATE POLICY aje_lines_insert ON public.aje_lines
  FOR INSERT TO authenticated WITH CHECK (true);

-- statement_sign_offs.sso_select — restrict to preparer+ roles
DROP POLICY IF EXISTS sso_select ON public.statement_sign_offs;
CREATE POLICY sso_select ON public.statement_sign_offs
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = statement_sign_offs.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager','reviewer','approver'])
  ));

-- tax_losses.tl_select — restrict to preparer+ roles
DROP POLICY IF EXISTS tl_select ON public.tax_losses;
CREATE POLICY tl_select ON public.tax_losses
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = tax_losses.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager','reviewer'])
  ));

-- capital_allowances.ca_select — restrict to preparer+ roles
DROP POLICY IF EXISTS ca_select ON public.capital_allowances;
CREATE POLICY ca_select ON public.capital_allowances
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = capital_allowances.company_id
      AND fm.role = ANY (ARRAY['owner','partner','preparer','manager','reviewer'])
  ));

-- ============================================================
-- 4) Retarget "public" role policies to "authenticated" on
--    remaining flagged tables (defense in depth).
-- ============================================================

-- account_mappings
DROP POLICY IF EXISTS "Users can create their own mappings" ON public.account_mappings;
DROP POLICY IF EXISTS "Users can delete their own mappings" ON public.account_mappings;
DROP POLICY IF EXISTS "Users can update their own mappings" ON public.account_mappings;
DROP POLICY IF EXISTS "Users can view their own mappings"   ON public.account_mappings;
CREATE POLICY "Users can view their own mappings"   ON public.account_mappings FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can create their own mappings" ON public.account_mappings FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own mappings" ON public.account_mappings FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete their own mappings" ON public.account_mappings FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- companies
DROP POLICY IF EXISTS "Users can create their own companies" ON public.companies;
DROP POLICY IF EXISTS "Users can delete their own companies" ON public.companies;
DROP POLICY IF EXISTS "Users can update their own companies" ON public.companies;
DROP POLICY IF EXISTS "Users can view their own companies"   ON public.companies;
CREATE POLICY "Users can view their own companies"   ON public.companies FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can create their own companies" ON public.companies FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own companies" ON public.companies FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete their own companies" ON public.companies FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- safisha_audit_log
DROP POLICY IF EXISTS safisha_audit_select ON public.safisha_audit_log;
CREATE POLICY safisha_audit_select ON public.safisha_audit_log
  FOR SELECT TO authenticated
  USING (reconciliation_id IN (
    SELECT id FROM public.safisha_reconciliations WHERE client_id = auth.uid()
  ));

-- safisha_client_mappings
DROP POLICY IF EXISTS safisha_mapping_all ON public.safisha_client_mappings;
CREATE POLICY safisha_mapping_all ON public.safisha_client_mappings
  FOR ALL TO authenticated
  USING (client_id = auth.uid())
  WITH CHECK (client_id = auth.uid());

-- safisha_exceptions
DROP POLICY IF EXISTS safisha_exc_insert ON public.safisha_exceptions;
DROP POLICY IF EXISTS safisha_exc_select ON public.safisha_exceptions;
CREATE POLICY safisha_exc_insert ON public.safisha_exceptions
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY safisha_exc_select ON public.safisha_exceptions
  FOR SELECT TO authenticated
  USING (reconciliation_id IN (
    SELECT id FROM public.safisha_reconciliations WHERE client_id = auth.uid()
  ));

-- safisha_reconciliations
DROP POLICY IF EXISTS safisha_recon_insert ON public.safisha_reconciliations;
DROP POLICY IF EXISTS safisha_recon_select ON public.safisha_reconciliations;
DROP POLICY IF EXISTS safisha_recon_update ON public.safisha_reconciliations;
CREATE POLICY safisha_recon_insert ON public.safisha_reconciliations FOR INSERT TO authenticated WITH CHECK (client_id = auth.uid());
CREATE POLICY safisha_recon_select ON public.safisha_reconciliations FOR SELECT TO authenticated USING (client_id = auth.uid());
CREATE POLICY safisha_recon_update ON public.safisha_reconciliations FOR UPDATE TO authenticated USING (client_id = auth.uid()) WITH CHECK (client_id = auth.uid());

-- safisha_transactions
DROP POLICY IF EXISTS safisha_txn_insert ON public.safisha_transactions;
DROP POLICY IF EXISTS safisha_txn_select ON public.safisha_transactions;
CREATE POLICY safisha_txn_insert ON public.safisha_transactions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY safisha_txn_select ON public.safisha_transactions
  FOR SELECT TO authenticated
  USING (reconciliation_id IN (
    SELECT id FROM public.safisha_reconciliations WHERE client_id = auth.uid()
  ));

-- trial_balance_uploads: retarget any public-role policies to authenticated
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname='public' AND tablename='trial_balance_uploads' AND 'public' = ANY(roles)
  LOOP
    EXECUTE format('ALTER POLICY %I ON public.trial_balance_uploads TO authenticated', r.policyname);
  END LOOP;
END $$;
