-- READ-ONLY. Existing paid-seat records before unlimited team members (20261110100000) is applied.
-- Run on the hosted database by the owner (or Lovable), as one script. It writes nothing: the transaction is READ ONLY and
-- is rolled back. It returns ids and counts only (no names or email addresses). Nothing here refunds, changes or deletes.
-- Works on the schema as it is today (it does not need members_unlimited, which this migration adds).

BEGIN TRANSACTION READ ONLY;

-- 1. Every licence that records purchased (additional) seats, with whether it is current today.
SELECT cl.id                       AS licence_id,
       cl.billing_customer_id,
       cp.code                     AS plan_code,
       cl.status,
       cl.source,
       cl.provenance,
       cl.additional_seats,
       cl.effective_start,
       cl.effective_end,
       (cl.status IN ('ACTIVE','GRACE') AND cl.effective_start <= now()
        AND (cl.effective_end IS NULL OR cl.effective_end > now())) AS current_today
  FROM public.commercial_licences cl
  JOIN public.commercial_plans cp ON cp.id = cl.plan_id
 WHERE cl.additional_seats > 0
 ORDER BY cp.code, cl.effective_start;

-- 2. How each of those quantities was recorded (the audited administrator action), oldest first.
SELECT a.created_at, a.billing_customer_id, a.actor_user_id,
       a.previous_state->>'additional_seats' AS from_seats,
       a.new_state->>'additional_seats'      AS to_seats,
       a.new_state->>'licence_id'            AS licence_id,
       a.reason
  FROM public.billing_audit_events a
 WHERE a.action = 'LICENCE_ADDITIONAL_SEATS_SET'
 ORDER BY a.created_at;

-- 3. Was any money taken for seats? Seat prices were never purchasable online; confirm, and list any payment whose
--    metadata names additional seats (expected: none).
SELECT s.price_code, cp.code AS plan_code, s.billing_interval, s.amount_minor, s.currency_code, s.is_active, s.is_purchasable
  FROM public.commercial_additional_seat_prices s JOIN public.commercial_plans cp ON cp.id = s.plan_id
 ORDER BY s.price_code;
SELECT e.id AS payment_event_id, e.event_type, e.provider, e.amount_minor, e.currency, e.recorded_at, e.licence_id
  FROM public.payment_events e
 WHERE e.metadata ? 'additional_seats' OR e.metadata::text ILIKE '%seat%'
 ORDER BY e.recorded_at;

-- 4. Agreed named-user allowances (NAMED_USER_SEATS overrides) still in force — Enterprise and any manual grants.
SELECT eo.id AS override_id, eo.billing_customer_id, eo.capacity_value, eo.effective_start, eo.effective_end, eo.reason
  FROM public.entitlement_overrides eo
 WHERE eo.feature_code = 'NAMED_USER_SEATS' AND eo.revoked_at IS NULL
   AND eo.effective_start <= now() AND (eo.effective_end IS NULL OR eo.effective_end > now())
 ORDER BY eo.billing_customer_id;

-- 5. People billing-suspended today, by reason and by the account's current plan (decision 3: bulk reactivation or not).
SELECT s.reason, COALESCE(cur.plan_code, 'NO_CURRENT_PLAN') AS account_plan, count(*) AS open_suspensions,
       count(DISTINCT s.account_user_id) AS accounts
  FROM public.named_user_billing_suspensions s
  LEFT JOIN LATERAL (
    SELECT cp.code AS plan_code
      FROM public.billing_customers bc
      JOIN public.commercial_licences cl ON cl.billing_customer_id = bc.id
      JOIN public.commercial_plans cp ON cp.id = cl.plan_id
     WHERE bc.owner_user_id = s.account_user_id AND cl.status IN ('ACTIVE','GRACE')
       AND cl.effective_start <= now() AND (cl.effective_end IS NULL OR cl.effective_end > now())
     ORDER BY cl.effective_start DESC LIMIT 1) cur ON true
 WHERE s.lifted_at IS NULL
 GROUP BY 1, 2
 ORDER BY 2, 1;

-- 6. One-line summary.
SELECT (SELECT count(*) FROM public.commercial_licences WHERE additional_seats > 0)                                    AS licences_with_seats,
       (SELECT count(*) FROM public.commercial_licences WHERE additional_seats > 0 AND status IN ('ACTIVE','GRACE')
          AND effective_start <= now() AND (effective_end IS NULL OR effective_end > now()))                          AS current_licences_with_seats,
       (SELECT COALESCE(sum(additional_seats), 0) FROM public.commercial_licences WHERE additional_seats > 0)          AS recorded_seats_total,
       (SELECT count(*) FROM public.commercial_additional_seat_prices WHERE is_purchasable)                           AS purchasable_seat_prices,
       (SELECT count(*) FROM public.named_user_billing_suspensions WHERE lifted_at IS NULL)                           AS open_suspensions;

ROLLBACK;
