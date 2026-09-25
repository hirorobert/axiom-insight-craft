-- ════════════════════════════════════════════════════════════════════════════
-- Resolves MIGRATION-AUTHORITY-DRIFT-0006: the minimum EXECUTE grant on the workspace-authority predicates.
--
-- can_user_act_on_workspace(user, workspace, capability) and workspace_authority_basis(user, workspace, capability)
-- take an ARBITRARY user id. Callable by a signed-in user, they would answer "can person X act on workspace Y" for any
-- X and Y: a cross-workspace existence and membership oracle. Their only callers are the service-role Edge Functions
-- trial-balance-source-signer and trial-balance-storage-cleanup (with the user id taken from the verified JWT) and
-- other SECURITY DEFINER functions (which run as the function owner). No RLS policy, client or authenticated RPC calls
-- them. The minimum grant is therefore EXECUTE for service_role only.
--
-- The authored migration 20260923100000 already revoked them from authenticated; Lovable's applied journal entry
-- 0006 omitted `authenticated` for can_user_act_on_workspace. This migration converges BOTH histories to the same
-- privileges: on a clean replay it changes nothing; on the hosted database it removes the extra grant. It is
-- idempotent by design (safe to apply again, it only re-asserts the same privileges) and ends with a postcondition
-- that fails the transaction if any other role can still execute either function.
-- ════════════════════════════════════════════════════════════════════════════

DO $refuse$
BEGIN
  IF to_regprocedure('public.can_user_act_on_workspace(uuid, uuid, text)') IS NULL
     OR to_regprocedure('public.workspace_authority_basis(uuid, uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'grant migration refused: the workspace-authority predicates are missing. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
END
$refuse$;

REVOKE ALL ON FUNCTION public.can_user_act_on_workspace(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_user_act_on_workspace(uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.workspace_authority_basis(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_authority_basis(uuid, uuid, text) TO service_role;

DO $post$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.can_user_act_on_workspace(uuid, uuid, text)', 'public.workspace_authority_basis(uuid, uuid, text)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'grant postcondition failed: % is still executable by anon or authenticated', f USING ERRCODE = '55000';
    END IF;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'grant postcondition failed: % is not executable by service_role', f USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$post$;
