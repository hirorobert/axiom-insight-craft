-- Ω∞ A+ closure — disposable-Postgres CI contract test harness, part 2:
-- executable assertions against the FULLY-APPLIED migration chain.
--
-- Every assertion RAISEs EXCEPTION on failure (aborting this script, and
-- because run.sh invokes psql with -v ON_ERROR_STOP=1, aborting the whole
-- CI job) and RAISE NOTICE 'PASS: ...' on success — the CI log itself is
-- the machine-readable pass/fail evidence.

SET client_min_messages TO NOTICE;

-- ============================================================
-- A. Function signatures + retirement of unsafe overloads
-- ============================================================

DO $$
DECLARE
  v_count INTEGER;
BEGIN
  -- The 2-argument resolve_commercial_offer overload must be gone.
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE proname = 'resolve_commercial_offer' AND pronargs = 2;
  IF v_count != 0 THEN
    RAISE EXCEPTION 'FAIL: retired 2-arg resolve_commercial_offer overload still exists (count=%)', v_count;
  END IF;
  RAISE NOTICE 'PASS: 2-arg resolve_commercial_offer overload retired';

  -- The 12-arg commit_verified_commercial_payment overload must be gone.
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE proname = 'commit_verified_commercial_payment' AND pronargs = 12;
  IF v_count != 0 THEN
    RAISE EXCEPTION 'FAIL: retired 12-arg commit_verified_commercial_payment overload still exists (count=%)', v_count;
  END IF;
  RAISE NOTICE 'PASS: 12-arg commit_verified_commercial_payment overload retired';

  -- The 11-arg admin_upsert_commercial_offer overload must be gone.
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE proname = 'admin_upsert_commercial_offer' AND pronargs = 11;
  IF v_count != 0 THEN
    RAISE EXCEPTION 'FAIL: retired 11-arg admin_upsert_commercial_offer overload still exists (count=%)', v_count;
  END IF;
  RAISE NOTICE 'PASS: 11-arg admin_upsert_commercial_offer overload retired';

  -- Exactly one live commit_verified_commercial_payment (13-arg).
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE proname = 'commit_verified_commercial_payment';
  IF v_count != 1 THEN
    RAISE EXCEPTION 'FAIL: expected exactly 1 commit_verified_commercial_payment overload, found %', v_count;
  END IF;
  RAISE NOTICE 'PASS: exactly one commit_verified_commercial_payment overload live';

  -- New Ω∞ A+ closure functions all exist and compiled.
  FOR v_count IN
    SELECT count(*) FROM pg_proc WHERE proname = ANY(ARRAY[
      'acquire_checkout_attempt', 'persist_checkout_provider_result',
      'mark_checkout_attempt_failed', 'mark_checkout_attempt_uncertain',
      'cancel_checkout_attempt', 'admin_resolve_manual_review_intent',
      'claim_verification_attempt', 'assert_platform_state_permits'
    ])
  LOOP
    IF v_count != 8 THEN
      RAISE EXCEPTION 'FAIL: expected all 8 new Ω∞ A+ closure functions to exist, found %', v_count;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS: all 8 new Ω∞ A+ closure functions exist and compiled';
END $$;

-- ============================================================
-- B. Grants — anon/authenticated/service_role
-- ============================================================

DO $$
BEGIN
  IF NOT has_function_privilege('service_role', 'public.acquire_checkout_attempt(uuid,uuid,uuid,uuid,text,text,smallint,bigint,text,smallint,text,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: service_role missing EXECUTE on acquire_checkout_attempt';
  END IF;
  IF has_function_privilege('authenticated', 'public.acquire_checkout_attempt(uuid,uuid,uuid,uuid,text,text,smallint,bigint,text,smallint,text,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated must NOT have EXECUTE on acquire_checkout_attempt';
  END IF;
  IF has_function_privilege('anon', 'public.acquire_checkout_attempt(uuid,uuid,uuid,uuid,text,text,smallint,bigint,text,smallint,text,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: anon must NOT have EXECUTE on acquire_checkout_attempt';
  END IF;
  RAISE NOTICE 'PASS: acquire_checkout_attempt EXECUTE grants are service_role-only';

  IF NOT has_function_privilege('authenticated', 'public.admin_resolve_manual_review_intent(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated missing EXECUTE on admin_resolve_manual_review_intent (its own is_commercial_admin() check is the real gate)';
  END IF;
  RAISE NOTICE 'PASS: admin_resolve_manual_review_intent granted to authenticated (gated internally by is_commercial_admin())';
END $$;

-- ============================================================
-- C. Direct-write blocking — anon/authenticated cannot manufacture
--    offers, intents, payment_events, or licences directly (privilege
--    checks fire before any constraint/FK validation, so garbage values
--    are sufficient here).
-- ============================================================

DO $$
BEGIN
  EXECUTE 'SET ROLE authenticated';
  BEGIN
    INSERT INTO public.commercial_offers (offer_code, plan_id, market_code, currency_code, amount_minor, currency_exponent, billing_interval, billing_interval_count)
    VALUES ('HOSTILE', gen_random_uuid(), 'GLOBAL', 'USD', 1, 2, 'MONTHLY', 1);
    RAISE EXCEPTION 'FAIL: authenticated was able to INSERT into commercial_offers directly';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: authenticated cannot INSERT into commercial_offers directly';
  END;
  EXECUTE 'RESET ROLE';
END $$;

DO $$
BEGIN
  EXECUTE 'SET ROLE authenticated';
  BEGIN
    INSERT INTO public.payment_checkout_intents (billing_customer_id, commercial_offer_id, plan_id, product_id, market_code, expected_amount_minor, currency_code, currency_exponent, billing_interval, billing_interval_count, provider, saff_reference, created_by_user_id)
    VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'GLOBAL', 4900, 'USD', 2, 'MONTHLY', 1, 'FLUTTERWAVE', 'HOSTILE-REF', gen_random_uuid());
    RAISE EXCEPTION 'FAIL: authenticated was able to INSERT into payment_checkout_intents directly';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: authenticated cannot INSERT into payment_checkout_intents directly';
  END;
  EXECUTE 'RESET ROLE';
END $$;

DO $$
BEGIN
  EXECUTE 'SET ROLE authenticated';
  BEGIN
    INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'ACTIVE', 'HOSTILE_MANUFACTURED', now());
    RAISE EXCEPTION 'FAIL: authenticated was able to INSERT into commercial_licences directly — PAID could be manufactured without any verified payment';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: authenticated cannot manufacture a licence directly (PAID cannot be manufactured without commit_verified_commercial_payment)';
  END;
  EXECUTE 'RESET ROLE';
END $$;

DO $$
BEGIN
  EXECUTE 'SET ROLE authenticated';
  BEGIN
    INSERT INTO public.payment_events (billing_customer_id, provider, external_event_id, idempotency_key, event_type, amount, currency, amount_minor)
    VALUES (gen_random_uuid(), 'FLUTTERWAVE', 'HOSTILE', 'HOSTILE-KEY', 'PAYMENT_CONFIRMED', 1, 'USD', 100);
    RAISE EXCEPTION 'FAIL: authenticated was able to INSERT into payment_events directly';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: authenticated cannot INSERT into payment_events directly';
  END;
  EXECUTE 'RESET ROLE';
END $$;

-- ============================================================
-- D. Platform-state x provider-environment x acceptance-identity matrix
-- ============================================================

DO $$
DECLARE
  v_admin_id UUID := gen_random_uuid();
  v_plain_id UUID := gen_random_uuid();
  v_failed BOOLEAN;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (v_admin_id, 'ci-admin@example.test'), (v_plain_id, 'ci-plain@example.test');
  INSERT INTO public.commercial_live_acceptance_allowlist (user_id, reason, active) VALUES (v_admin_id, 'CI harness acceptance identity', true);

  -- PAYMENTS_DISABLED (the real, live starting value) permits nothing.
  UPDATE public.commercial_platform_state SET state = 'PAYMENTS_DISABLED' WHERE id = true;
  v_failed := false;
  BEGIN
    PERFORM public.assert_platform_state_permits('sandbox', v_plain_id);
  EXCEPTION WHEN OTHERS THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL: PAYMENTS_DISABLED must permit no environment'; END IF;
  RAISE NOTICE 'PASS: PAYMENTS_DISABLED rejects sandbox';

  -- SANDBOX_ONLY permits sandbox, rejects production.
  UPDATE public.commercial_platform_state SET state = 'SANDBOX_ONLY' WHERE id = true;
  PERFORM public.assert_platform_state_permits('sandbox', v_plain_id); -- must not raise
  RAISE NOTICE 'PASS: SANDBOX_ONLY permits sandbox for any authenticated user';
  v_failed := false;
  BEGIN
    PERFORM public.assert_platform_state_permits('production', v_plain_id);
  EXCEPTION WHEN OTHERS THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL: SANDBOX_ONLY must reject production'; END IF;
  RAISE NOTICE 'PASS: SANDBOX_ONLY rejects production';

  -- LIVE_ACCEPTANCE permits production ONLY for an allowlisted identity.
  UPDATE public.commercial_platform_state SET state = 'LIVE_ACCEPTANCE' WHERE id = true;
  PERFORM public.assert_platform_state_permits('production', v_admin_id); -- must not raise
  RAISE NOTICE 'PASS: LIVE_ACCEPTANCE permits production for an allowlisted identity';
  v_failed := false;
  BEGIN
    PERFORM public.assert_platform_state_permits('production', v_plain_id);
  EXCEPTION WHEN OTHERS THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL: LIVE_ACCEPTANCE must reject a non-allowlisted identity even under production'; END IF;
  RAISE NOTICE 'PASS: LIVE_ACCEPTANCE rejects a non-allowlisted identity';
  v_failed := false;
  BEGIN
    PERFORM public.assert_platform_state_permits('sandbox', v_admin_id);
  EXCEPTION WHEN OTHERS THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL: LIVE_ACCEPTANCE must reject sandbox even for an allowlisted identity'; END IF;
  RAISE NOTICE 'PASS: LIVE_ACCEPTANCE rejects sandbox even for an allowlisted identity';

  -- CUSTOMER_PAYMENTS_ENABLED permits production for any authenticated user, rejects sandbox.
  UPDATE public.commercial_platform_state SET state = 'CUSTOMER_PAYMENTS_ENABLED' WHERE id = true;
  PERFORM public.assert_platform_state_permits('production', v_plain_id); -- must not raise
  RAISE NOTICE 'PASS: CUSTOMER_PAYMENTS_ENABLED permits production for an ordinary customer';
  v_failed := false;
  BEGIN
    PERFORM public.assert_platform_state_permits('sandbox', v_plain_id);
  EXCEPTION WHEN OTHERS THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL: CUSTOMER_PAYMENTS_ENABLED must reject sandbox'; END IF;
  RAISE NOTICE 'PASS: CUSTOMER_PAYMENTS_ENABLED rejects sandbox';

  -- Missing/blank/unknown environment fails closed regardless of state.
  v_failed := false;
  BEGIN
    PERFORM public.assert_platform_state_permits(NULL, v_plain_id);
  EXCEPTION WHEN OTHERS THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL: NULL environment must fail closed even under CUSTOMER_PAYMENTS_ENABLED'; END IF;
  v_failed := false;
  BEGIN
    PERFORM public.assert_platform_state_permits('staging', v_plain_id);
  EXCEPTION WHEN OTHERS THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL: an unrecognized environment string must fail closed'; END IF;
  RAISE NOTICE 'PASS: NULL and unrecognized environment values fail closed';
END $$;

-- ============================================================
-- E1. Full happy-path pipeline (acquire -> persist -> commit) exercised
--     end-to-end as service_role, exactly as the Edge Functions do it —
--     proving FREE remains FREE until a real commit happens, and that
--     the resulting PAID licence cannot be downgraded by direct client
--     action afterward.
-- ============================================================

DO $$
DECLARE
  v_user_id UUID := gen_random_uuid();
  v_bc_id UUID;
  v_product_id UUID;
  v_plan_id UUID;
  v_offer_id UUID;
  v_acquire JSONB;
  v_intent_id UUID;
  v_token UUID;
  v_persist JSONB;
  v_commit JSONB;
  v_licence_count INTEGER;
  v_plan_code TEXT;
  v_failed BOOLEAN;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (v_user_id, 'ci-happy-path@example.test');
  SELECT id INTO v_product_id FROM public.commercial_products WHERE code = 'CFOCLOSE';
  SELECT id INTO v_plan_id FROM public.commercial_plans WHERE code = 'PAID' AND product_id = v_product_id;
  SELECT id INTO v_offer_id FROM public.commercial_offers WHERE offer_code = 'CFOCLOSE_PROFESSIONAL_GLOBAL_USD_MONTHLY';

  INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES (v_user_id, v_product_id) RETURNING id INTO v_bc_id;

  -- FREE remains FREE: no licence exists yet, get_my_billing_summary
  -- (called as this user) must report plan_code NULL, never a fabricated
  -- default.
  EXECUTE 'SET ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_user_id::text, false);
  SELECT (public.get_my_billing_summary()->>'plan_code') INTO v_plan_code;
  EXECUTE 'RESET ROLE';
  IF v_plan_code IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: a billing customer with no licence must report plan_code NULL (FREE), got %', v_plan_code;
  END IF;
  RAISE NOTICE 'PASS: a fresh billing customer remains FREE (plan_code NULL) before any verified payment';

  UPDATE public.commercial_platform_state SET state = 'CUSTOMER_PAYMENTS_ENABLED' WHERE id = true;

  v_acquire := public.acquire_checkout_attempt(
    v_bc_id, v_product_id, v_plan_id, v_offer_id, 'GLOBAL', 'USD', 2, 4900, 'MONTHLY', 1,
    'FLUTTERWAVE', 'production', v_user_id, 'CI-HAPPY-PATH-REF'
  );
  IF v_acquire->>'action' != 'NEW_ATTEMPT' THEN
    RAISE EXCEPTION 'FAIL: expected NEW_ATTEMPT, got %', v_acquire->>'action';
  END IF;
  v_intent_id := (v_acquire->>'intent_id')::uuid;
  v_token := (v_acquire->>'creation_token')::uuid;

  v_persist := public.persist_checkout_provider_result(v_intent_id, v_token, 'flw-happy-path-ref', 'https://checkout.example.test/happy-path');
  IF (v_persist->>'persisted')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: expected persisted:true, got %', v_persist;
  END IF;

  -- Simulates the Edge Function's own post-verification commit call —
  -- the amount/currency/environment must match what was snapshotted at
  -- acquisition (4900/USD/production), exactly as a real Flutterwave
  -- verification response would.
  v_commit := public.commit_verified_commercial_payment(
    v_intent_id, 'FLUTTERWAVE', 'flw-txn-happy-path-001', 'successful', 'SUCCEEDED',
    4900, 'USD', 'deadbeef', now(), 'PROVIDER_API_VERIFY',
    'ci-happy-path-idempotency-key-001', 'CI-HAPPY-PATH-REF', 'production'
  );
  IF (v_commit->>'committed')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: expected committed:true, got %', v_commit;
  END IF;

  SELECT count(*) INTO v_licence_count FROM public.commercial_licences
   WHERE billing_customer_id = v_bc_id AND plan_id = v_plan_id AND status = 'ACTIVE';
  IF v_licence_count != 1 THEN
    RAISE EXCEPTION 'FAIL: expected exactly 1 ACTIVE licence after commit, found %', v_licence_count;
  END IF;
  RAISE NOTICE 'PASS: full acquire -> persist -> commit pipeline produces exactly one ACTIVE licence';

  -- Idempotency: replaying the IDENTICAL commit call must never duplicate
  -- the licence/payment_event — proves duplicate-commit convergence.
  v_commit := public.commit_verified_commercial_payment(
    v_intent_id, 'FLUTTERWAVE', 'flw-txn-happy-path-001', 'successful', 'SUCCEEDED',
    4900, 'USD', 'deadbeef', now(), 'PROVIDER_API_VERIFY',
    'ci-happy-path-idempotency-key-001', 'CI-HAPPY-PATH-REF', 'production'
  );
  IF v_commit->>'status' != 'ALREADY_COMMITTED' THEN
    RAISE EXCEPTION 'FAIL: replaying an identical commit must return ALREADY_COMMITTED, got %', v_commit->>'status';
  END IF;
  SELECT count(*) INTO v_licence_count FROM public.commercial_licences
   WHERE billing_customer_id = v_bc_id AND plan_id = v_plan_id AND status = 'ACTIVE';
  IF v_licence_count != 1 THEN
    RAISE EXCEPTION 'FAIL: a replayed identical commit must never create a second licence, found %', v_licence_count;
  END IF;
  RAISE NOTICE 'PASS: replaying an identical commit converges on ALREADY_COMMITTED — no duplicate licence';

  -- Blank provider_transaction_id must be rejected outright.
  v_failed := false;
  BEGIN
    PERFORM public.commit_verified_commercial_payment(
      v_intent_id, 'FLUTTERWAVE', '', 'successful', 'SUCCEEDED', 4900, 'USD', 'deadbeef', now(),
      'PROVIDER_API_VERIFY', 'ci-happy-path-blank-txn-id', 'CI-HAPPY-PATH-REF', 'production'
    );
  EXCEPTION WHEN OTHERS THEN v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'FAIL: a blank provider_transaction_id must be rejected outright';
  END IF;
  RAISE NOTICE 'PASS: a blank provider_transaction_id is rejected outright';

  -- Existing PAID is not downgradable by direct client action.
  EXECUTE 'SET ROLE authenticated';
  BEGIN
    UPDATE public.commercial_licences SET status = 'CANCELLED' WHERE billing_customer_id = v_bc_id;
    RAISE EXCEPTION 'FAIL: authenticated was able to directly downgrade/cancel an existing ACTIVE licence';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: an existing ACTIVE (PAID) licence cannot be downgraded by direct client action';
  END;
  EXECUTE 'RESET ROLE';
END $$;

-- ============================================================
-- E. Offer-seed binding — independently re-queried (already asserted at
--    migration-apply time by 20260913000000 itself; re-proven here as a
--    live, post-apply fact, not merely "the migration didn't abort")
-- ============================================================

DO $$
DECLARE v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.commercial_offers co
    JOIN public.commercial_plans cp ON cp.id = co.plan_id
    JOIN public.commercial_products cprod ON cprod.id = cp.product_id
   WHERE co.offer_code IN ('CFOCLOSE_PROFESSIONAL_GLOBAL_USD_MONTHLY', 'CFOCLOSE_PROFESSIONAL_GLOBAL_USD_ANNUAL')
     AND cprod.code = 'CFOCLOSE' AND cp.code = 'PAID' AND co.is_purchasable = false AND co.is_active = true;
  IF v_count != 2 THEN
    RAISE EXCEPTION 'FAIL: expected 2 correctly-bound, non-purchasable CFOClose offers, found %', v_count;
  END IF;
  RAISE NOTICE 'PASS: both CFOClose offers exist, correctly bound, non-purchasable';
END $$;

-- ============================================================
-- F. TZS/TZ vocabulary remains supported; a hypothetical new TZ offer
--    still defaults to non-purchasable (no historical TZ commercial offer
--    row exists anywhere in this repository's migration history to
--    re-test directly — this proves the underlying invariant the same
--    way a historical row would).
-- ============================================================

DO $$
DECLARE
  v_admin_id UUID := gen_random_uuid();
  v_offer JSONB;
  v_is_purchasable BOOLEAN;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (v_admin_id, 'ci-tz-admin@example.test');
  INSERT INTO public.commercial_admins (user_id, active) VALUES (v_admin_id, true);

  EXECUTE 'SET ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, false);
  v_offer := public.admin_upsert_commercial_offer(
    'CFOCLOSE_PROFESSIONAL_TZ_TZS_MONTHLY_CITEST', 'PAID', 'TZ', 'TZS', 100000, 0, 'MONTHLY', 1,
    true, false, 'CI harness TZ vocabulary check'
  );
  EXECUTE 'RESET ROLE';

  SELECT is_purchasable INTO v_is_purchasable FROM public.commercial_offers WHERE offer_code = 'CFOCLOSE_PROFESSIONAL_TZ_TZS_MONTHLY_CITEST';
  IF v_is_purchasable IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL: a newly created TZ/TZS offer must default to non-purchasable';
  END IF;
  RAISE NOTICE 'PASS: TZ market / TZS currency remain supported vocabulary; a new offer still defaults non-purchasable';
END $$;

DO $$ BEGIN RAISE NOTICE 'PASS: static contract assertions complete'; END $$;
