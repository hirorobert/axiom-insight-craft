-- ════════════════════════════════════════════════════════════════════════════
-- Ω∞ CONSTITUTIONAL FIX — DENY-BY-DEFAULT AT THE GRANT LAYER
--
-- FINDING (live, verified against this project's database):
--   pg_default_acl, schema public, grantor postgres:
--     anon = arwdDxtm  (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER)
--   => EVERY table created in `public` is born fully granted to `anon`.
--   26 live tables carry anon INSERT; 4 carry anon SELECT. They are safe
--   today ONLY because RLS happens to have a policy and every policy happens
--   to be scoped TO authenticated. Tenancy isolation is therefore enforced by
--   the memory of each migration author, not by the architecture.
--   Views and SECURITY DEFINER functions sit OUTSIDE RLS entirely — this
--   already fired once (v_latest_account_mapping_memory leaked every firm's
--   confirmed mappings to an anon key, fixed in 20260811000001).
--
-- FIX: anon gets nothing in `public`, now and forever, unless a future
-- migration grants it explicitly alongside an anon-permissive RLS policy.
-- RLS becomes the SECOND line of defence instead of the only one.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path TO public, pg_catalog;

-- ── 1. Future objects: stop minting anon privileges ──────────────────────────
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;

-- ── 2. Existing objects: withdraw what was already minted ────────────────────
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;

-- Schema USAGE stays: PostgREST needs it to resolve names and return a clean
-- "permission denied for table X" instead of an opaque failure.
GRANT USAGE ON SCHEMA public TO anon;

-- ── 3. Views must run as the CALLER, or base-table RLS is bypassed ───────────
-- (v_latest_account_mapping_memory was already fixed; re-asserted here so the
--  whole view surface is provably uniform.)
ALTER VIEW public.v_latest_account_mapping_memory SET (security_invoker = on);
ALTER VIEW public.v_aje_balance_check             SET (security_invoker = on);
ALTER VIEW public.v_loss_history                  SET (security_invoker = on);
ALTER VIEW public.v_period_pairs                  SET (security_invoker = on);
ALTER VIEW public.v_wdv_carry_forward             SET (security_invoker = on);

-- ── 4. The one policy still addressed to PUBLIC, not authenticated ───────────
DROP POLICY IF EXISTS "amm_select" ON public.account_mapping_memory;
CREATE POLICY "amm_select" ON public.account_mapping_memory
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id    = auth.uid()
         AND fm.company_id = account_mapping_memory.company_id
         AND fm.accepted_at IS NOT NULL
    )
  );

COMMENT ON SCHEMA public IS
  'Ω∞ deny-by-default: `anon` holds NO privileges here and default privileges '
  'no longer mint any. A future migration that needs anon access must GRANT it '
  'explicitly AND ship an anon-permissive RLS policy in the same migration. '
  'All views MUST be created with security_invoker = on. CI gate: '
  'scripts/grant_gate.mjs.';
