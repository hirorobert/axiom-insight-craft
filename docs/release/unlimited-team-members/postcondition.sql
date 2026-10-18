-- READ-ONLY HOSTED POSTCONDITION for unlimited team members (batch pricing-p1; migration 20261110100000, PR #161).
-- Run AFTER the wrapper, in BEGIN TRANSACTION READ ONLY; … ROLLBACK;. CATALOG AND DATA READS ONLY: it invokes no
-- application function, so a read-only, non-owner role can run it (lesson from tb-release-r1). Raises on the first
-- violated expectation; ends with NOTICE 'POSTCONDITION OK.'.
DO $$
DECLARE v_def text;
BEGIN
  -- 1. The explicit flag: a NOT NULL boolean, never a sentinel number; exactly Solo, Practice and Firm have it.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'commercial_plans'
                  AND column_name = 'members_unlimited' AND data_type = 'boolean' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'POSTCONDITION: commercial_plans.members_unlimited is missing or not a NOT NULL boolean';
  END IF;
  IF (SELECT array_agg(code ORDER BY code) FROM public.commercial_plans WHERE members_unlimited) IS DISTINCT FROM ARRAY['FIRM', 'PRACTICE', 'SOLO']::text[] THEN
    RAISE EXCEPTION 'POSTCONDITION: members_unlimited is not set on exactly Solo, Practice and Firm';
  END IF;
  IF EXISTS (SELECT 1 FROM public.commercial_plans WHERE members_unlimited AND additional_seats_purchasable) THEN
    RAISE EXCEPTION 'POSTCONDITION: an unlimited-members plan still sells additional seats';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cp_members_unlimited_plans')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cp_members_unlimited_no_seat_sales') THEN
    RAISE EXCEPTION 'POSTCONDITION: a members_unlimited plan constraint is missing';
  END IF;

  -- 2. The capacity resolver answers unlimited from the flag (never from NULL), and the seat wall tests it.
  v_def := pg_get_functiondef('public._seat_capacity_for_account(uuid)'::regprocedure);
  IF position('members_unlimited' IN v_def) = 0 OR position('PLAN_UNLIMITED_TEAM_MEMBERS' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: _seat_capacity_for_account does not answer unlimited from the explicit flag';
  END IF;
  IF position('unlimited' IN pg_get_functiondef('public.named_user_seat_wall()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: named_user_seat_wall does not test the unlimited answer';
  END IF;
  IF position('members_unlimited' IN pg_get_functiondef('public.admin_set_licence_additional_seats(uuid,integer,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: admin_set_licence_additional_seats does not refuse raising seats on an unlimited plan';
  END IF;

  -- 3. The new internal helper is not callable by clients.
  IF to_regprocedure('public._lift_named_user_suspensions_unlimited(uuid,uuid[],text)') IS NULL
     OR has_function_privilege('authenticated', 'public._lift_named_user_suspensions_unlimited(uuid,uuid[],text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._lift_named_user_suspensions_unlimited(uuid,uuid[],text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: _lift_named_user_suspensions_unlimited is missing or callable by a client';
  END IF;

  -- 4. The proposed Practice/Firm additional-seat prices are retired (kept, inactive), exactly as the migration does.
  IF EXISTS (SELECT 1 FROM public.commercial_additional_seat_prices sp JOIN public.commercial_plans cp ON cp.id = sp.plan_id
              WHERE cp.members_unlimited AND cp.code IN ('PRACTICE', 'FIRM') AND sp.is_active) THEN
    RAISE EXCEPTION 'POSTCONDITION: an additional-seat price is still active on an unlimited-members plan';
  END IF;

  RAISE NOTICE 'POSTCONDITION OK.';
END $$;
