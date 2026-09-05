-- ════════════════════════════════════════════════════════════════════════════
-- Ω1-RLS1 — PRODUCTION DEFECT REPAIR
-- DEFECT-Ω1-COMMERCIAL-RLS-RECURSION-001
--
-- FORWARD MIGRATION ONLY. Does not edit
-- 20260904180000_commercial_foundation_wave_omega1.sql, which is already
-- live. This migration only replaces policy USING clauses and adds one
-- new helper function — it creates no new tables, changes no licence,
-- entitlement, payment-ledger, or accounting-authority semantics.
--
-- ROOT CAUSE (confirmed by reading the live migration, not assumed from
-- the incident report): commercial_admins' own SELECT policy,
-- "ca_select_self_or_admin", is:
--
--   USING (
--     user_id = auth.uid()
--     OR EXISTS (SELECT 1 FROM public.commercial_admins ca
--                 WHERE ca.user_id = auth.uid() AND ca.active)
--   )
--
-- Evaluating this policy requires querying commercial_admins, which is the
-- SAME table the policy is attached to — Postgres must re-apply RLS to
-- that inner SELECT, which re-evaluates the same policy, which queries
-- commercial_admins again, forever: PostgreSQL 42P17, "infinite recursion
-- detected in policy for relation commercial_admins".
--
-- Five other tables' SELECT policies (billing_customers,
-- commercial_licences, payment_events, entitlement_overrides,
-- billing_audit_events) each contain the identical
-- "OR EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ...)"
-- admin branch. They do not recurse into themselves, but evaluating that
-- branch forces evaluation of commercial_admins' own (self-recursive)
-- policy — so every one of them inherits the same failure. This matches
-- the live-observed affected-table list exactly.
--
-- REPAIR: a single SECURITY DEFINER helper, is_commercial_admin(),
-- replaces every "EXISTS (SELECT ... FROM commercial_admins ...)" branch,
-- including commercial_admins' own policy. A SECURITY DEFINER function
-- executes its body as its OWNER (the migration-runner role, which also
-- owns commercial_admins) — table owners are exempt from their own
-- table's RLS unless FORCE ROW LEVEL SECURITY is set (it is not, here and
-- never has been), so the helper's internal SELECT does not re-trigger
-- commercial_admins' policy at all. The recursion is broken at its root,
-- not papered over with a different tie-break.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path TO public, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- FUNCTION: is_commercial_admin() — the sole replacement for every inline
-- "EXISTS (SELECT ... FROM commercial_admins ...)" RLS branch.
--
-- Security properties:
--   - SECURITY DEFINER + STABLE + hardened SET search_path (no hijack
--     surface via a caller-controlled search_path).
--   - Takes no arguments — always checks the CURRENT session's auth.uid(),
--     never an arbitrary caller-supplied user_id. There is no path by
--     which one authenticated user can ask "is user X an admin" about
--     anyone but themselves.
--   - Returns a bare boolean only — never exposes a commercial_admins row,
--     column, or count to the caller.
--   - Pure SELECT — cannot INSERT/UPDATE/DELETE commercial_admins under
--     any input, so it cannot be used to self-escalate into admin status.
--   - auth.uid() IS NULL (unauthenticated / anon) short-circuits to false
--     before any query runs.
--   - Confers no accounting authority: it never reads or references
--     firm_members, account_mappings, tax_computations, or any other
--     accounting-authority table.
-- ════════════════════════════════════════════════════════════════════════════

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
  'Ω1-RLS1: SECURITY DEFINER RLS helper. Bypasses commercial_admins'' own '
  'RLS for its internal lookup (function owner owns the table, and FORCE '
  'ROW LEVEL SECURITY is not set) — this is what breaks the '
  'DEFECT-Ω1-COMMERCIAL-RLS-RECURSION-001 recursion. Checks auth.uid() '
  'only, never an arbitrary user_id; returns boolean only; read-only; '
  'grants no accounting authority.';

REVOKE ALL ON FUNCTION public.is_commercial_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_commercial_admin() TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- REWRITE the six affected SELECT policies. Owner-scoping predicates are
-- reproduced byte-for-byte from the live migration — only the
-- commercial_admins admin branch changes, in every case from an inline
-- recursive EXISTS to a call to is_commercial_admin(). No policy's role
-- list, command type, or PERMISSIVE/RESTRICTIVE type changes; no table's
-- anonymous access changes (anon still has no GRANT on any of these six
-- tables — unaffected by this migration).
-- ════════════════════════════════════════════════════════════════════════════

-- commercial_admins — the recursion's own source.
ALTER POLICY "ca_select_self_or_admin" ON public.commercial_admins
  USING (
    user_id = auth.uid()
    OR public.is_commercial_admin()
  );

-- billing_customers
ALTER POLICY "bc_select_owner_or_admin" ON public.billing_customers
  USING (
    owner_user_id = auth.uid()
    OR public.is_commercial_admin()
  );

-- commercial_licences
ALTER POLICY "cl_select_owner_or_admin" ON public.commercial_licences
  USING (
    billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid())
    OR public.is_commercial_admin()
  );

-- payment_events
ALTER POLICY "pe_select_owner_or_admin" ON public.payment_events
  USING (
    billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid())
    OR public.is_commercial_admin()
  );

-- entitlement_overrides
ALTER POLICY "eo_select_owner_or_admin" ON public.entitlement_overrides
  USING (
    billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid())
    OR public.is_commercial_admin()
  );

-- billing_audit_events
ALTER POLICY "bae_select_owner_or_admin" ON public.billing_audit_events
  USING (
    billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid())
    OR public.is_commercial_admin()
  );

-- commercial_products and commercial_plans are unaffected: their policies
-- ("cprod_select_public" USING (true), "cplan_select_public" USING
-- (is_active)) never referenced commercial_admins and are not touched.

-- ── Rollback (NOT executed — for reference only) ─────────────────────────────
-- ALTER POLICY "bae_select_owner_or_admin" ON public.billing_audit_events
--   USING (
--     billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid())
--     OR EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = auth.uid() AND ca.active)
--   );
-- ALTER POLICY "eo_select_owner_or_admin" ON public.entitlement_overrides
--   USING (
--     billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid())
--     OR EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = auth.uid() AND ca.active)
--   );
-- ALTER POLICY "pe_select_owner_or_admin" ON public.payment_events
--   USING (
--     billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid())
--     OR EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = auth.uid() AND ca.active)
--   );
-- ALTER POLICY "cl_select_owner_or_admin" ON public.commercial_licences
--   USING (
--     billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid())
--     OR EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = auth.uid() AND ca.active)
--   );
-- ALTER POLICY "bc_select_owner_or_admin" ON public.billing_customers
--   USING (
--     owner_user_id = auth.uid()
--     OR EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = auth.uid() AND ca.active)
--   );
-- ALTER POLICY "ca_select_self_or_admin" ON public.commercial_admins
--   USING (
--     user_id = auth.uid()
--     OR EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = auth.uid() AND ca.active)
--   );
-- DROP FUNCTION IF EXISTS public.is_commercial_admin();
