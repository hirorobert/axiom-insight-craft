-- READ-ONLY HOSTED POSTCONDITION for online payment (batch commercial-p1). Run AFTER the wrapper. Writes nothing; raises
-- on the first violated expectation. Then repeat the four counts of the preflight: each must be identical.
DO $$
DECLARE v_fn TEXT;
BEGIN
  IF position('''POLAR''' IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'chk_pci_provider'))) = 0
     OR position('''SNIPPE''' IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'chk_pci_provider'))) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: SNIPPE / POLAR are not accepted provider identifiers (20261029100000 is not applied)';
  END IF;
  IF to_regprocedure('public._commercial_licence_placement(uuid,uuid,timestamp with time zone)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION: the placement rule is missing';
  END IF;
  IF position('_commercial_licence_placement' IN pg_get_functiondef('public.commit_verified_commercial_payment(uuid,text,text,text,text,bigint,text,text,timestamp with time zone,text,text,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: the verified-payment commit does not use the placement rule';
  END IF;
  IF position('PAID_TERM_WOULD_BE_SHORTENED' IN pg_get_functiondef('public.admin_grant_commercial_licence(uuid,text,timestamp with time zone,timestamp with time zone,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: manual activation does not protect a paid term';
  END IF;
  -- Server-only functions: no client role.
  FOREACH v_fn IN ARRAY ARRAY['public.commit_verified_commercial_payment(uuid,text,text,text,text,bigint,text,text,timestamp with time zone,text,text,text,text)',
                              'public._commercial_licence_placement(uuid,uuid,timestamp with time zone)',
                              'public.ensure_checkout_billing_customer(uuid)',
                              'public.claim_verification_attempt(uuid,uuid,integer)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION: % is executable by a client role', v_fn;
    END IF;
  END LOOP;
  -- Administrator functions: authenticated (gated inside by commercial_admins), never anon or service_role.
  FOREACH v_fn IN ARRAY ARRAY['public.admin_place_paid_licence(uuid,timestamp with time zone,text)',
                              'public.admin_list_payment_attention()',
                              'public.admin_record_reversal_review(uuid,text,text)',
                              'public.admin_find_billing_account(text)'] LOOP
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION: % is not exactly scoped', v_fn;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', 'public.get_my_payments()', 'EXECUTE') OR has_function_privilege('anon', 'public.get_my_payments()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: get_my_payments is not exactly scoped';
  END IF;
  IF NOT has_function_privilege('anon', 'public.get_public_plan_prices()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: get_public_plan_prices is not readable by the public pages';
  END IF;
  IF (public.get_public_plan_prices() ->> 'online_payment')::boolean THEN
    RAISE EXCEPTION 'POSTCONDITION: online payment must not be open after this migration';
  END IF;
  IF (SELECT state FROM public.commercial_platform_state WHERE id = true) IS DISTINCT FROM 'PAYMENTS_DISABLED' THEN
    RAISE EXCEPTION 'POSTCONDITION: payments must still be disabled';
  END IF;
  RAISE NOTICE 'POSTCONDITION OK.';
END;
$$;
SELECT count(*) AS licences, coalesce(md5(string_agg(to_jsonb(l)::text, '' ORDER BY l.id)), '') AS licences_md5 FROM public.commercial_licences l;
SELECT count(*) AS intents, coalesce(md5(string_agg(to_jsonb(i)::text, '' ORDER BY i.id)), '') AS intents_md5 FROM public.payment_checkout_intents i;
SELECT count(*) AS payment_events, coalesce(md5(string_agg(to_jsonb(e)::text, '' ORDER BY e.id)), '') AS payment_events_md5 FROM public.payment_events e;
SELECT count(*) AS offers, coalesce(md5(string_agg(to_jsonb(o)::text, '' ORDER BY o.id)), '') AS offers_md5 FROM public.commercial_offers o;
