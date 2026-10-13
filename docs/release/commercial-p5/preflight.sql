-- READ-ONLY HOSTED PREFLIGHT for verified charge outcomes (batch commercial-p5, 20261102100000,
-- DEFECT-VERIFIED-CHARGE-DROPPED-001). Run AFTER commercial-p4 and BEFORE the commercial-p5 wrapper. Writes nothing; raises on
-- the first violated expectation. Paste the whole output into the report.
DO $$
BEGIN
  IF to_regprocedure('public._record_payment_reversal_core(uuid,text,text,text,bigint,text,text,text,text,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: payment reversal authority (commercial-p4) is not applied; apply it first';
  END IF;
  IF to_regclass('public.payment_recovery_cases') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: verified charge outcomes (20261102100000) is already applied';
  END IF;
  RAISE NOTICE 'PREFLIGHT OK: apply 20261102100000_verified_charge_outcomes.wrapper.sql';
END;
$$;

-- 1. EXPOSURE: intents CFOClose closed with no provider-reported outcome (no payment event at all) although a provider session
--    was created. Neither provider can cancel a session on request, so each may still be payable until the provider's own
--    expiry. Before this migration a payment on any of them would have been dropped; after it, it is placed or recorded for
--    recovery. Nothing here is changed.
SELECT ci.id, ci.saff_reference, ci.provider, ci.provider_environment, ci.status, ci.created_at, ci.completed_at,
       ci.metadata->>'manual_review_resolution' AS review_resolution, ci.provider_checkout_ref IS NOT NULL AS provider_session_created
  FROM public.payment_checkout_intents ci
 WHERE ci.status IN ('CANCELLED','FAILED','EXPIRED') AND ci.provider_checkout_ref IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.payment_events e WHERE e.checkout_intent_id = ci.id)
 ORDER BY ci.created_at;

-- 1b. HISTORICAL DROPPED CHARGES — DISCOVERY ONLY. A webhook delivery the old commit answered as "already resolved/paid" was
--     recorded as processing_result DUPLICATE with the provider transaction id, but no payment event exists for that
--     transaction. Each row is a charge the provider verified that CFOClose never recorded. This migration does NOT record
--     them: the in-app verification (claim_verification_attempt) accepts only open orders, so each needs an explicit,
--     separately approved decision. Charges whose webhook never reached CFOClose appear only in the provider's own records
--     (Polar orders, Snippe payments) and must be found by comparing those with payment_events.
SELECT pe.provider, pe.provider_transaction_id, pe.saff_reference, min(pe.created_at) AS first_seen, count(*) AS deliveries
  FROM public.payment_webhook_processing_events pe
 WHERE pe.processing_result = 'DUPLICATE' AND pe.provider_transaction_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.payment_events e WHERE e.provider = pe.provider AND e.provider_transaction_id = pe.provider_transaction_id)
 GROUP BY pe.provider, pe.provider_transaction_id, pe.saff_reference
 ORDER BY first_seen;

-- 2. Record before applying (the postcondition repeats these; all must be identical — the migration writes no row):
SELECT count(*) AS payment_events, coalesce(md5(string_agg(to_jsonb(e)::text, '' ORDER BY e.id)), '') AS payment_events_md5 FROM public.payment_events e;
SELECT count(*) AS intents, coalesce(md5(string_agg(to_jsonb(i)::text, '' ORDER BY i.id)), '') AS intents_md5 FROM public.payment_checkout_intents i;
SELECT count(*) AS licences, coalesce(md5(string_agg(to_jsonb(l)::text, '' ORDER BY l.id)), '') AS licences_md5 FROM public.commercial_licences l;
SELECT count(*) AS audit_events, coalesce(md5(string_agg(to_jsonb(a)::text, '' ORDER BY a.id)), '') AS audit_md5 FROM public.billing_audit_events a;
