-- READ-ONLY HOSTED POSTCONDITION for paid-term seat preservation (batch commercial-p2). Run AFTER the wrapper. Writes
-- nothing; raises on the first violated expectation. Then repeat the three counts of the preflight: each must be identical.
DO $$
DECLARE v_fn TEXT;
BEGIN
  IF position('BLOCKED_SEATS' IN pg_get_functiondef('public._commercial_licence_placement(uuid,uuid,timestamp with time zone)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: the placement rule does not protect additional named users (20261030100000 is not applied)';
  END IF;
  IF position('''BLOCKED_''' IN pg_get_functiondef('public.commit_verified_commercial_payment(uuid,text,text,text,text,bigint,text,text,timestamp with time zone,text,text,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: the verified-payment commit does not route every BLOCKED_* placement to review';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.commit_verified_commercial_payment(uuid,text,text,text,text,bigint,text,text,timestamp with time zone,text,text,text,text)',
                              'public._commercial_licence_placement(uuid,uuid,timestamp with time zone)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION: % is not exactly scoped (service_role only)', v_fn;
    END IF;
  END LOOP;
  IF (SELECT state FROM public.commercial_platform_state WHERE id = true) IS DISTINCT FROM 'PAYMENTS_DISABLED' THEN
    RAISE EXCEPTION 'POSTCONDITION: payments must still be disabled';
  END IF;
  RAISE NOTICE 'POSTCONDITION OK.';
END;
$$;
SELECT count(*) AS licences, coalesce(md5(string_agg(to_jsonb(l)::text, '' ORDER BY l.id)), '') AS licences_md5 FROM public.commercial_licences l;
SELECT count(*) AS intents, coalesce(md5(string_agg(to_jsonb(i)::text, '' ORDER BY i.id)), '') AS intents_md5 FROM public.payment_checkout_intents i;
SELECT count(*) AS payment_events, coalesce(md5(string_agg(to_jsonb(e)::text, '' ORDER BY e.id)), '') AS payment_events_md5 FROM public.payment_events e;
