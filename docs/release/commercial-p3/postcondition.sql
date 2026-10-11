-- READ-ONLY HOSTED POSTCONDITION for sandbox licence isolation (batch commercial-p3). Run AFTER the wrapper. Writes nothing;
-- raises on the first violated expectation. Then repeat the preflight's section 4: licences, licence_terms_md5, intents and
-- payment_events must be identical; audit_events grows by exactly the number of contained licences.
DO $$
DECLARE v_fn TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'commercial_licences'
                  AND column_name = 'provenance' AND is_nullable = 'NO' AND column_default LIKE '%REVIEW_REQUIRED%') THEN
    RAISE EXCEPTION 'POSTCONDITION: commercial_licences.provenance is missing, nullable or without its REVIEW_REQUIRED default';
  END IF;
  IF position('SANDBOX' IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'chk_cl_status'))) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: status SANDBOX is not allowed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cl_provenance_guard' AND tgrelid = 'public.commercial_licences'::regclass AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'POSTCONDITION: the provenance guard trigger is missing or disabled';
  END IF;
  -- The invariant, on the live data: no sandbox licence grants; nothing else is SANDBOX.
  IF EXISTS (SELECT 1 FROM public.commercial_licences WHERE provenance = 'SANDBOX_PAYMENT' AND status <> 'SANDBOX')
     OR EXISTS (SELECT 1 FROM public.commercial_licences WHERE status = 'SANDBOX' AND provenance <> 'SANDBOX_PAYMENT') THEN
    RAISE EXCEPTION 'POSTCONDITION: a sandbox licence can grant, or a non-sandbox licence is SANDBOX';
  END IF;
  IF EXISTS (SELECT 1 FROM public.commercial_licences l WHERE l.provenance = 'SANDBOX_PAYMENT'
              AND NOT EXISTS (SELECT 1 FROM public.billing_audit_events a WHERE a.action = 'SANDBOX_LICENCE_CONTAINED' AND a.new_state->>'licence_id' = l.id::text)) THEN
    RAISE EXCEPTION 'POSTCONDITION: a sandbox licence was contained without its audit row';
  END IF;
  IF position('SANDBOX_RECORD' IN pg_get_functiondef('public.commit_verified_commercial_payment(uuid,text,text,text,text,bigint,text,text,timestamp with time zone,text,text,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: the commit still places sandbox payments';
  END IF;
  IF position('grants_access' IN pg_get_functiondef('public.get_checkout_status(text)'::regprocedure)) = 0
     OR position('grants_access' IN pg_get_functiondef('public.get_my_payments()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: the order reads do not say whether an order grants access';
  END IF;
  v_fn := 'public.commit_verified_commercial_payment(uuid,text,text,text,text,bigint,text,text,timestamp with time zone,text,text,text,text)';
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: % is not exactly scoped (service_role only)', v_fn;
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.admin_list_licence_provenance_review()', 'public.admin_resolve_licence_provenance(uuid,text,text)',
                              'public.admin_restore_term_ended_by_sandbox(uuid,text)', 'public.admin_place_paid_licence(uuid,timestamp with time zone,text)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('service_role', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION: % is not exactly scoped (authenticated commercial administrators only)', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.commercial_licence_provenance_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: the guard function is callable by clients';
  END IF;
  IF (SELECT state FROM public.commercial_platform_state WHERE id = true) IS DISTINCT FROM 'PAYMENTS_DISABLED' THEN
    RAISE EXCEPTION 'POSTCONDITION: payments must still be disabled';
  END IF;
  RAISE NOTICE 'POSTCONDITION OK.';
END;
$$;

-- What was recorded (paste into the report).
SELECT provenance, status, count(*) FROM public.commercial_licences GROUP BY provenance, status ORDER BY provenance, status;
SELECT id, status, provenance, provenance_evidence FROM public.commercial_licences WHERE id = 'ba803893-8116-454f-bea2-0f2a7c7f2603';
SELECT public_review.* FROM (SELECT id, billing_customer_id, status, source, provenance_evidence->>'basis' AS basis
                              FROM public.commercial_licences WHERE provenance = 'REVIEW_REQUIRED' ORDER BY created_at) public_review;
SELECT new_state->>'licence_id' AS contained_licence_id, new_state->>'ended_production_licence_id' AS ended_term_to_review, created_at
  FROM public.billing_audit_events WHERE action = 'SANDBOX_LICENCE_CONTAINED' ORDER BY created_at;

-- Compare with the preflight's section 4:
SELECT count(*) AS licences,
       coalesce(md5(string_agg(jsonb_build_array(l.id, l.billing_customer_id, l.plan_id, l.source, l.effective_start, l.effective_end, l.additional_seats)::text, '' ORDER BY l.id)), '') AS licence_terms_md5
  FROM public.commercial_licences l;
SELECT count(*) AS intents, coalesce(md5(string_agg(to_jsonb(i)::text, '' ORDER BY i.id)), '') AS intents_md5 FROM public.payment_checkout_intents i;
SELECT count(*) AS payment_events, coalesce(md5(string_agg(to_jsonb(e)::text, '' ORDER BY e.id)), '') AS payment_events_md5 FROM public.payment_events e;
SELECT count(*) AS audit_events FROM public.billing_audit_events;
