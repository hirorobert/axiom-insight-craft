-- READ-ONLY HOSTED POSTCONDITION for payment reversal authority (batch commercial-p4). Run AFTER the wrapper. Writes nothing;
-- raises on the first violated expectation. Then compare section 2 with the preflight's section 3 (all identical: the
-- migration writes no row) and section 1 with the preflight's section 2 (the same discrepancies, unchanged).
DO $$
DECLARE v_fn TEXT;
BEGIN
  IF to_regprocedure('public._record_payment_reversal_core(uuid,text,text,text,bigint,text,text,text,text,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION: the reversal core is missing';
  END IF;
  IF position('_record_payment_reversal_core' IN pg_get_functiondef('public.record_payment_reversal(uuid,text,text,text,bigint,text,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: record_payment_reversal does not go through the bounded core';
  END IF;
  IF position('_apply_reversal_licence_decision' IN pg_get_functiondef('public.admin_record_reversal_review(uuid,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: a review decision does not take effect';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['REVERSAL_ORIGINAL_NOT_A_CONFIRMED_PAYMENT','REVERSAL_CURRENCY_MISMATCH','REVERSAL_PROVIDER_MISMATCH','REVERSAL_AMOUNT_INVALID','REVERSAL_EXCEEDS_PAYMENT','REVERSAL_IDEMPOTENCY_KEY_REUSED','pg_advisory_xact_lock'] LOOP
    IF position(v_fn IN pg_get_functiondef('public._record_payment_reversal_core(uuid,text,text,text,bigint,text,text,text,text,uuid,jsonb)'::regprocedure)) = 0 THEN
      RAISE EXCEPTION 'POSTCONDITION: the reversal core lacks %', v_fn;
    END IF;
  END LOOP;
  v_fn := 'public.record_payment_reversal(uuid,text,text,text,bigint,text,text,text)';
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: % is not exactly scoped (service_role only)', v_fn;
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public._record_payment_reversal_core(uuid,text,text,text,bigint,text,text,text,text,uuid,jsonb)', 'public._apply_reversal_licence_decision(uuid,text,uuid,text)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION: % is callable by a client or the service role', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.admin_record_provider_refund(uuid,bigint,text,text,text,text,text,text,text,uuid)', 'public.admin_record_reversal_review(uuid,text,text)', 'public.admin_list_reversal_discrepancies()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('service_role', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION: % is not exactly scoped (authenticated commercial administrators only)', v_fn;
    END IF;
  END LOOP;
  IF position('''SNIPPE''' IN pg_get_functiondef('public.admin_record_provider_refund(uuid,bigint,text,text,text,text,text,text,text,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: the administrator refund workflow is not limited to providers that report no refunds';
  END IF;
  RAISE NOTICE 'POSTCONDITION OK.';
END;
$$;

-- 1. Historical discrepancies, unchanged (compare with the preflight's section 2):
WITH r AS (
  SELECT rv.id, rv.event_type, rv.provider, rv.currency, rv.amount_minor, rv.recorded_at,
         o.id AS original_id, o.event_type AS original_type, o.normalized_status AS original_status,
         o.provider AS original_provider, o.currency AS original_currency, o.amount_minor AS paid_minor,
         sum(rv.amount_minor) OVER (PARTITION BY rv.metadata->>'original_event_id' ORDER BY rv.recorded_at, rv.id) AS cumulative_minor
    FROM public.payment_events rv LEFT JOIN public.payment_events o ON o.id::text = rv.metadata->>'original_event_id'
   WHERE rv.event_type IN ('REFUND','CHARGEBACK'))
SELECT id AS reversal_event_id, event_type, provider, currency, amount_minor, original_id, paid_minor, cumulative_minor,
       array_remove(ARRAY[
         CASE WHEN original_id IS NULL THEN 'ORIGINAL_MISSING' END,
         CASE WHEN original_id IS NOT NULL AND (original_type <> 'PAYMENT_CONFIRMED' OR original_status IS DISTINCT FROM 'SUCCEEDED') THEN 'ORIGINAL_NOT_A_CONFIRMED_PAYMENT' END,
         CASE WHEN original_id IS NOT NULL AND provider IS DISTINCT FROM original_provider THEN 'PROVIDER_MISMATCH' END,
         CASE WHEN original_id IS NOT NULL AND upper(coalesce(currency,'')) <> upper(coalesce(original_currency,'')) THEN 'CURRENCY_MISMATCH' END,
         CASE WHEN amount_minor IS NULL OR amount_minor <= 0 THEN 'AMOUNT_NOT_POSITIVE' END,
         CASE WHEN paid_minor IS NOT NULL AND cumulative_minor > paid_minor THEN 'CUMULATIVE_EXCEEDS_PAYMENT' END], NULL) AS issues
  FROM r
 WHERE original_id IS NULL OR original_type <> 'PAYMENT_CONFIRMED' OR original_status IS DISTINCT FROM 'SUCCEEDED'
    OR provider IS DISTINCT FROM original_provider OR upper(coalesce(currency,'')) <> upper(coalesce(original_currency,''))
    OR amount_minor IS NULL OR amount_minor <= 0 OR (paid_minor IS NOT NULL AND cumulative_minor > paid_minor)
 ORDER BY recorded_at;

-- 2. Compare with the preflight's section 3:
SELECT count(*) AS payment_events, coalesce(md5(string_agg(to_jsonb(e)::text, '' ORDER BY e.id)), '') AS payment_events_md5 FROM public.payment_events e;
SELECT count(*) AS licences, coalesce(md5(string_agg(to_jsonb(l)::text, '' ORDER BY l.id)), '') AS licences_md5 FROM public.commercial_licences l;
SELECT count(*) AS audit_events, coalesce(md5(string_agg(to_jsonb(a)::text, '' ORDER BY a.id)), '') AS audit_md5 FROM public.billing_audit_events a;
