-- READ-ONLY HOSTED PREFLIGHT for sandbox licence isolation (batch commercial-p3, DEFECT-SANDBOX-LICENCE-PRODUCTION-LEAK-001).
-- Run AFTER commercial-p2 and BEFORE the commercial-p3 wrapper. Writes nothing; raises on the first violated expectation.
-- Paste the whole output into the report: it is the classification the migration will apply, from authoritative records.
-- 20261031110000 supersedes 20261031100000, whose single submission failed atomically (PT422 CANCELLED_LICENCE_IMMUTABLE)
-- and wrote nothing: this preflight passes on that unchanged state. Never submit the superseded wrapper.
DO $$
BEGIN
  IF to_regprocedure('public._commercial_licence_placement(uuid,uuid,timestamp with time zone)') IS NULL
     OR position('BLOCKED_SEATS' IN pg_get_functiondef('public._commercial_licence_placement(uuid,uuid,timestamp with time zone)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: paid-term seat preservation (20261030100000, commercial-p2) is not applied; apply it first';
  END IF;
  IF (SELECT state FROM public.commercial_platform_state WHERE id = true) IS DISTINCT FROM 'PAYMENTS_DISABLED' THEN
    RAISE EXCEPTION 'PREFLIGHT: commercial_platform_state must be PAYMENTS_DISABLED (the migration refuses otherwise)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'commercial_licences' AND column_name = 'provenance') THEN
    RAISE EXCEPTION 'PREFLIGHT: sandbox licence isolation (20261031110000) is already applied';
  END IF;
  RAISE NOTICE 'PREFLIGHT OK: apply 20261031110000_sandbox_licence_isolation.wrapper.sql';
END;
$$;

-- 1. What the migration will record for every licence (the same rule it applies; nothing is written here).
WITH links AS (
  SELECT pe.licence_id, pe.checkout_intent_id FROM public.payment_events pe
   WHERE pe.event_type = 'PAYMENT_CONFIRMED' AND pe.licence_id IS NOT NULL AND pe.checkout_intent_id IS NOT NULL
  UNION
  SELECT (ci.metadata->>'placed_licence_id')::uuid, ci.id FROM public.payment_checkout_intents ci
   WHERE ci.metadata->>'placed_licence_id' ~ '^[0-9a-f-]{36}$'
), envs AS (
  SELECT l.licence_id, count(DISTINCT ci.provider_environment) AS environments, bool_or(ci.provider_environment IS NULL) AS any_unknown,
         min(ci.provider_environment) AS environment
    FROM links l JOIN public.payment_checkout_intents ci ON ci.id = l.checkout_intent_id GROUP BY l.licence_id
)
SELECT cl.id AS licence_id, cl.billing_customer_id, cp.code AS plan_code, cl.status, cl.source, cl.effective_start, cl.effective_end,
       CASE
         WHEN cl.source = 'MANUAL_ADMIN_GRANT' THEN 'MANUAL_GRANT'
         WHEN cl.source = 'SYSTEM_DEFAULT_FREE' THEN 'SYSTEM_FREE'
         WHEN cl.source LIKE '%\_VERIFIED\_PAYMENT' ESCAPE '\' AND e.licence_id IS NOT NULL AND e.environments = 1 AND NOT e.any_unknown
              THEN CASE e.environment WHEN 'production' THEN 'PRODUCTION_PAYMENT'
                                      WHEN 'sandbox' THEN CASE WHEN cl.status = 'CANCELLED' THEN 'SANDBOX_PAYMENT (STAYS CANCELLED; PROVENANCE RECORDED)'
                                                               ELSE 'SANDBOX_PAYMENT (WILL BE CONTAINED)' END END
         ELSE 'REVIEW_REQUIRED'
       END AS provenance_to_record
  FROM public.commercial_licences cl
  JOIN public.commercial_plans cp ON cp.id = cl.plan_id
  LEFT JOIN envs e ON e.licence_id = cl.id
 ORDER BY provenance_to_record, cl.created_at;

-- 2. The reported licence, explicitly.
SELECT cl.id, cl.status, cl.source, cl.effective_start, cl.effective_end,
       ci.saff_reference, ci.provider, ci.provider_environment, ci.status AS intent_status, pe.id AS payment_event_id
  FROM public.commercial_licences cl
  LEFT JOIN public.payment_events pe ON pe.licence_id = cl.id AND pe.event_type = 'PAYMENT_CONFIRMED'
  LEFT JOIN public.payment_checkout_intents ci ON ci.id = pe.checkout_intent_id
 WHERE cl.id = 'ba803893-8116-454f-bea2-0f2a7c7f2603';

-- 3. Genuine terms a sandbox payment ended (the commit's own audit row names them).
SELECT a.new_state->>'licence_id' AS sandbox_licence_id, a.previous_state->>'closed_prior_licence_id' AS ended_licence_id,
       a.previous_state->>'closed_effective_end' AS ended_at
  FROM public.billing_audit_events a
  JOIN public.payment_events pe ON pe.licence_id = (a.new_state->>'licence_id')::uuid AND pe.event_type = 'PAYMENT_CONFIRMED'
  JOIN public.payment_checkout_intents ci ON ci.id = pe.checkout_intent_id AND ci.provider_environment = 'sandbox'
 WHERE a.action = 'LICENCE_GRANTED' AND a.previous_state ? 'closed_prior_licence_id';

-- 4. Record before applying (compare after with the postcondition):
SELECT count(*) AS licences,
       coalesce(md5(string_agg(jsonb_build_array(l.id, l.billing_customer_id, l.plan_id, l.source, l.effective_start, l.effective_end, l.additional_seats)::text, '' ORDER BY l.id)), '') AS licence_terms_md5
  FROM public.commercial_licences l;
SELECT count(*) AS intents, coalesce(md5(string_agg(to_jsonb(i)::text, '' ORDER BY i.id)), '') AS intents_md5 FROM public.payment_checkout_intents i;
SELECT count(*) AS payment_events, coalesce(md5(string_agg(to_jsonb(e)::text, '' ORDER BY e.id)), '') AS payment_events_md5 FROM public.payment_events e;
SELECT count(*) AS audit_events FROM public.billing_audit_events;
