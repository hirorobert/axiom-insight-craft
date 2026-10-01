-- annualTermPreflight.sql — READ-ONLY audit to run against production BEFORE 20261001120000_annual_commercial_term.sql
-- is applied. SELECT statements only; run inside `BEGIN READ ONLY; … ROLLBACK;`. Proven read-only by
-- scripts/db-proof/annualTerm.mjs (T-08).
--
-- 1. Every licence that came from a MONTHLY checkout (a payment event links the licence to its intent).
-- 2. Every MONTHLY checkout intent still open (PENDING / MANUAL_REVIEW) — after the migration it cannot be committed.
-- 3. The self-serve offers the migration retires, with their current state.
-- 4. Licence counts by plan, status and source, for the before/after comparison.

SELECT 'monthly_paid_licence' AS finding, l.id AS licence_id, cp.code AS plan_code, l.status, l.source,
       l.effective_start, l.effective_end, (l.effective_end - l.effective_start) AS span, i.id AS checkout_intent_id
  FROM public.commercial_licences l
  JOIN public.commercial_plans cp ON cp.id = l.plan_id
  LEFT JOIN public.payment_events e ON e.licence_id = l.id
  LEFT JOIN public.payment_checkout_intents i ON i.id = e.checkout_intent_id
 WHERE i.billing_interval = 'MONTHLY'
    OR (l.source LIKE '%\_VERIFIED\_PAYMENT' ESCAPE '\' AND l.effective_end IS NOT NULL AND l.effective_end < l.effective_start + interval '12 months')
 ORDER BY l.effective_start;

SELECT 'open_monthly_intent' AS finding, i.id AS checkout_intent_id, cp.code AS plan_code, i.status, i.created_at, i.expires_at
  FROM public.payment_checkout_intents i
  JOIN public.commercial_plans cp ON cp.id = i.plan_id
 WHERE i.billing_interval = 'MONTHLY' AND i.status IN ('CREATED', 'PENDING', 'MANUAL_REVIEW')
 ORDER BY i.created_at;

SELECT 'self_serve_monthly_offer' AS finding, co.offer_code, co.is_active, co.is_purchasable, co.effective_start, co.effective_end
  FROM public.commercial_offers co
  JOIN public.commercial_plans cp ON cp.id = co.plan_id
 WHERE cp.code IN ('SOLO', 'PRACTICE', 'FIRM') AND co.billing_interval = 'MONTHLY'
 ORDER BY co.offer_code;

SELECT 'licence_census' AS finding, cp.code AS plan_code, l.status, l.source, count(*) AS licences
  FROM public.commercial_licences l
  JOIN public.commercial_plans cp ON cp.id = l.plan_id
 GROUP BY cp.code, l.status, l.source
 ORDER BY cp.code, l.status, l.source;
