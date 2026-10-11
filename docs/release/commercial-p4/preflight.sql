-- READ-ONLY HOSTED PREFLIGHT for payment reversal authority (batch commercial-p4, 20261101100000,
-- DEFECT-PAYMENT-REVERSAL-UNBOUND-001). Run AFTER commercial-p3 and BEFORE the commercial-p4 wrapper. Writes nothing; raises on
-- the first violated expectation. Paste the whole output into the report.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'commercial_licences' AND column_name = 'provenance') THEN
    RAISE EXCEPTION 'PREFLIGHT: sandbox licence isolation (commercial-p3) is not applied; apply it first';
  END IF;
  IF to_regprocedure('public._record_payment_reversal_core(uuid,text,text,text,bigint,text,text,text,text,uuid,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: payment reversal authority (20261101100000) is already applied';
  END IF;
  RAISE NOTICE 'PREFLIGHT OK: apply 20261101100000_payment_reversal_authority.wrapper.sql';
END;
$$;

-- 1. Every existing reversal (refund or chargeback) and the original it names. The migration changes none of them.
SELECT rv.id, rv.event_type, rv.provider, rv.currency, rv.amount_minor, rv.recorded_at, rv.metadata->>'original_event_id' AS original_event_id
  FROM public.payment_events rv WHERE rv.event_type IN ('REFUND','CHARGEBACK') ORDER BY rv.recorded_at;

-- 2. HISTORICAL DISCREPANCIES: existing reversals the corrected rules would refuse. Reported, never rewritten. After the
--    migration, admin_list_reversal_discrepancies() lists exactly these.
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

-- 3. Record before applying (the postcondition repeats these; all must be identical):
SELECT count(*) AS payment_events, coalesce(md5(string_agg(to_jsonb(e)::text, '' ORDER BY e.id)), '') AS payment_events_md5 FROM public.payment_events e;
SELECT count(*) AS licences, coalesce(md5(string_agg(to_jsonb(l)::text, '' ORDER BY l.id)), '') AS licences_md5 FROM public.commercial_licences l;
SELECT count(*) AS audit_events, coalesce(md5(string_agg(to_jsonb(a)::text, '' ORDER BY a.id)), '') AS audit_md5 FROM public.billing_audit_events a;
