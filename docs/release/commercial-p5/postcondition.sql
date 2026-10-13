-- READ-ONLY HOSTED POSTCONDITION for verified charge outcomes (batch commercial-p5). Run AFTER the wrapper. Writes nothing;
-- raises on the first violated expectation. Then repeat the preflight's section 2: every value must be identical.
DO $$
DECLARE v_fn TEXT; v_def TEXT;
BEGIN
  IF to_regclass('public.payment_recovery_cases') IS NULL THEN RAISE EXCEPTION 'POSTCONDITION: payment_recovery_cases is missing'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.payment_recovery_cases'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION: row level security is off on payment_recovery_cases';
  END IF;
  IF has_table_privilege('anon', 'public.payment_recovery_cases', 'SELECT') OR has_table_privilege('authenticated', 'public.payment_recovery_cases', 'SELECT')
     OR has_table_privilege('authenticated', 'public.payment_recovery_cases', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION: clients can read or write payment_recovery_cases';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_payment_recovery_cases_guard' AND tgrelid = 'public.payment_recovery_cases'::regclass AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'POSTCONDITION: the recovery case guard trigger is missing or disabled';
  END IF;
  v_def := pg_get_functiondef('public.commit_verified_commercial_payment(uuid,text,text,text,text,bigint,text,text,timestamp with time zone,text,text,text,text)'::regprocedure);
  IF position('RECOVERY_REQUIRED' IN v_def) = 0 OR position('payment_recovery_cases' IN v_def) = 0 OR position('late_payment_on_closed_intent' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: the commit still drops verified charges on closed or paid intents';
  END IF;
  IF position('INTENT_ALREADY_PAID' IN v_def) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: the commit still answers INTENT_ALREADY_PAID without recording the charge';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.get_checkout_status(text)', 'public.get_my_payments()', 'public.admin_place_paid_licence(uuid,timestamp with time zone,text)'] LOOP
    IF position('RECOVERY_REQUIRED' IN pg_get_functiondef(v_fn::regprocedure)) = 0 THEN
      RAISE EXCEPTION 'POSTCONDITION: % may read a recovery payment as the intent''s own', v_fn;
    END IF;
  END LOOP;
  v_fn := 'public.commit_verified_commercial_payment(uuid,text,text,text,text,bigint,text,text,timestamp with time zone,text,text,text,text)';
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: % is not exactly scoped (service_role only)', v_fn;
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.admin_list_payment_recovery_cases()', 'public.admin_resolve_payment_recovery(uuid,text,text)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('service_role', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION: % is not exactly scoped (authenticated commercial administrators only)', v_fn;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.payment_recovery_cases) THEN
    RAISE EXCEPTION 'POSTCONDITION: the migration created recovery cases (it must write no row)';
  END IF;
  RAISE NOTICE 'POSTCONDITION OK.';
END;
$$;

-- Compare with the preflight's section 2:
SELECT count(*) AS payment_events, coalesce(md5(string_agg(to_jsonb(e)::text, '' ORDER BY e.id)), '') AS payment_events_md5 FROM public.payment_events e;
SELECT count(*) AS intents, coalesce(md5(string_agg(to_jsonb(i)::text, '' ORDER BY i.id)), '') AS intents_md5 FROM public.payment_checkout_intents i;
SELECT count(*) AS licences, coalesce(md5(string_agg(to_jsonb(l)::text, '' ORDER BY l.id)), '') AS licences_md5 FROM public.commercial_licences l;
SELECT count(*) AS audit_events, coalesce(md5(string_agg(to_jsonb(a)::text, '' ORDER BY a.id)), '') AS audit_md5 FROM public.billing_audit_events a;
