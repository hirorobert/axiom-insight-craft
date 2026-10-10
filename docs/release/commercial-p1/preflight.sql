-- READ-ONLY HOSTED PREFLIGHT for online payment (batch commercial-p1, docs/release/COMMERCIAL_P1_PAYMENTS_RELEASE.md).
-- Run AFTER batch commercial-c1 and BEFORE the commercial-p1 wrapper. Writes nothing; raises on the first violated
-- expectation.
DO $$
BEGIN
  IF to_regclass('public.workspace_purpose_events') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: the commercial candidate (batch commercial-c1) is not applied; apply it first';
  END IF;
  IF (SELECT state FROM public.commercial_platform_state WHERE id = true) IS DISTINCT FROM 'PAYMENTS_DISABLED' THEN
    RAISE EXCEPTION 'PREFLIGHT: commercial_platform_state must be PAYMENTS_DISABLED (the migration refuses otherwise)';
  END IF;
  IF to_regprocedure('public._commercial_licence_placement(uuid,uuid,timestamp with time zone)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: the payment provider routes (20261029100000) are already applied';
  END IF;
  IF to_regprocedure('public.commit_verified_commercial_payment(uuid,text,text,text,text,bigint,text,text,timestamp with time zone,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: the verified-payment commit (13 arguments) is not in force';
  END IF;
  RAISE NOTICE 'PREFLIGHT OK: apply 20261029100000_payment_provider_routes.wrapper.sql';
END;
$$;
-- Record before applying (compare after: the migration changes no row of these tables):
SELECT count(*) AS licences, coalesce(md5(string_agg(to_jsonb(l)::text, '' ORDER BY l.id)), '') AS licences_md5 FROM public.commercial_licences l;
SELECT count(*) AS intents, coalesce(md5(string_agg(to_jsonb(i)::text, '' ORDER BY i.id)), '') AS intents_md5 FROM public.payment_checkout_intents i;
SELECT count(*) AS payment_events, coalesce(md5(string_agg(to_jsonb(e)::text, '' ORDER BY e.id)), '') AS payment_events_md5 FROM public.payment_events e;
SELECT count(*) AS offers, coalesce(md5(string_agg(to_jsonb(o)::text, '' ORDER BY o.id)), '') AS offers_md5 FROM public.commercial_offers o;
