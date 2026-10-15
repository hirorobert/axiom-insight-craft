-- READ-ONLY HOSTED POSTCONDITION for platform owner, access administration & entity allowances (batch access-a1).
-- Run AFTER the wrapper. Writes nothing; raises on the first violated expectation.
DO $$
DECLARE v_def TEXT;
BEGIN
  -- 1. Platform-owner tier on the one canonical cross-tenant table (additive; default keeps every existing row 'commercial').
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'commercial_admins' AND column_name = 'authority') THEN
    RAISE EXCEPTION 'POSTCONDITION: commercial_admins.authority is missing';
  END IF;
  IF position('platform_owner' IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'chk_ca_authority'))) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: chk_ca_authority does not restrict authority to commercial/platform_owner';
  END IF;
  IF to_regprocedure('public.is_platform_owner(uuid)') IS NULL THEN RAISE EXCEPTION 'POSTCONDITION: is_platform_owner(uuid) is missing'; END IF;

  -- 2. Explicit unlimited entity allowance (a boolean, never a sentinel number).
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'entitlement_overrides' AND column_name = 'unlimited') THEN
    RAISE EXCEPTION 'POSTCONDITION: entitlement_overrides.unlimited is missing';
  END IF;

  -- 3. Append-only access-administration ledger: RLS on, no client write, immutable.
  IF to_regclass('public.access_grant_events') IS NULL THEN RAISE EXCEPTION 'POSTCONDITION: access_grant_events is missing'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.access_grant_events'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION: row level security is off on access_grant_events';
  END IF;
  IF has_table_privilege('authenticated', 'public.access_grant_events', 'INSERT')
     OR has_table_privilege('authenticated', 'public.access_grant_events', 'UPDATE')
     OR has_table_privilege('anon', 'public.access_grant_events', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION: clients can write/anon-read access_grant_events';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_access_grant_events_immutable'
                  AND tgrelid = 'public.access_grant_events'::regclass AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'POSTCONDITION: the access_grant_events append-only trigger is missing or disabled';
  END IF;

  -- 4. Recent-reauth store is service-role-only (no client grant; RLS on, no policy).
  IF to_regclass('public.privileged_reauth') IS NULL THEN RAISE EXCEPTION 'POSTCONDITION: privileged_reauth is missing'; END IF;
  IF has_table_privilege('authenticated', 'public.privileged_reauth', 'SELECT')
     OR has_table_privilege('anon', 'public.privileged_reauth', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION: a client can read privileged_reauth (reauth nonces must be invisible to clients)';
  END IF;

  -- 5. The reauth mint is service_role-only; the privileged grant RPCs exist.
  IF has_function_privilege('authenticated', 'public.record_privileged_reauth(uuid,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: authenticated can mint reauth nonces (service_role only)';
  END IF;
  IF to_regprocedure('public.bootstrap_first_platform_owner(uuid,text)') IS NULL THEN RAISE EXCEPTION 'POSTCONDITION: bootstrap_first_platform_owner is missing'; END IF;
  IF has_function_privilege('authenticated', 'public.bootstrap_first_platform_owner(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: authenticated can run bootstrap_first_platform_owner (service_role only)';
  END IF;
  IF to_regprocedure('public.grant_platform_owner(uuid,text,text)') IS NULL
     OR to_regprocedure('public.revoke_platform_owner(uuid,text,text)') IS NULL
     OR to_regprocedure('public.owner_grant_complimentary_access(uuid,text,text,timestamp with time zone,text)') IS NULL
     OR to_regprocedure('public.owner_grant_entity_allowance(uuid,integer,boolean,text,timestamp with time zone,text)') IS NULL
     OR to_regprocedure('public.revoke_access_grant(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION: a platform-owner grant/revoke RPC is missing';
  END IF;

  -- 6. The canonical resolvers carry the new, scoped logic; customer entity enforcement is UNCHANGED (no pricing change).
  v_def := pg_get_functiondef('public._entity_capacity_for_account(uuid)'::regprocedure);
  IF position('PLATFORM_OWNER_COMPLIMENTARY' IN v_def) = 0 OR position('unlimited' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: _entity_capacity_for_account does not carry the platform-owner/unlimited logic';
  END IF;
  v_def := pg_get_functiondef('public._resolve_entitlement_for_owner(uuid,text)'::regprocedure);
  IF position('PLATFORM_OWNER_COMPLIMENTARY' IN v_def) = 0 OR position('capability_customer_available' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: _resolve_entitlement_for_owner does not gate complimentary access to released capabilities';
  END IF;
  v_def := pg_get_functiondef('public.company_entity_capacity_wall()'::regprocedure);
  IF position('unlimited' IN v_def) = 0 OR position('pg_advisory_xact_lock' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: company_entity_capacity_wall lost its unlimited bypass or its advisory lock';
  END IF;

  RAISE NOTICE 'POSTCONDITION OK.';
END $$;
