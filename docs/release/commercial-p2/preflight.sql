-- READ-ONLY HOSTED PREFLIGHT for paid-term seat preservation (batch commercial-p2). Run AFTER commercial-p1 and BEFORE
-- the commercial-p2 wrapper. Writes nothing; raises on the first violated expectation.
DO $$
BEGIN
  IF to_regprocedure('public._commercial_licence_placement(uuid,uuid,timestamp with time zone)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: the payment provider routes (20261029100000, batch commercial-p1) are not applied; apply them first';
  END IF;
  IF (SELECT state FROM public.commercial_platform_state WHERE id = true) IS DISTINCT FROM 'PAYMENTS_DISABLED' THEN
    RAISE EXCEPTION 'PREFLIGHT: commercial_platform_state must be PAYMENTS_DISABLED (the migration refuses otherwise)';
  END IF;
  IF position('BLOCKED_SEATS' IN pg_get_functiondef('public._commercial_licence_placement(uuid,uuid,timestamp with time zone)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: paid-term seat preservation (20261030100000) is already applied';
  END IF;
  RAISE NOTICE 'PREFLIGHT OK: apply 20261030100000_paid_term_seat_preservation.wrapper.sql';
END;
$$;
-- Record before applying (compare after: the migration changes no row of these tables):
SELECT count(*) AS licences, coalesce(md5(string_agg(to_jsonb(l)::text, '' ORDER BY l.id)), '') AS licences_md5 FROM public.commercial_licences l;
SELECT count(*) AS intents, coalesce(md5(string_agg(to_jsonb(i)::text, '' ORDER BY i.id)), '') AS intents_md5 FROM public.payment_checkout_intents i;
SELECT count(*) AS payment_events, coalesce(md5(string_agg(to_jsonb(e)::text, '' ORDER BY e.id)), '') AS payment_events_md5 FROM public.payment_events e;
