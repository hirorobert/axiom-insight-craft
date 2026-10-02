-- annualTermPreflight.sql — READ-ONLY mirror of the zero-state gate in 20261001120000_annual_commercial_term.sql, for
-- planning the reconciliation BEFORE the migration is applied. SELECT statements only; run inside
-- `BEGIN READ ONLY; … ROLLBACK;`. The MIGRATION ITSELF enforces the same two conditions and refuses to apply
-- (SQLSTATE PT422: INVALID_OPEN_CHECKOUT_INTENTS / UNRECONCILED_PROVIDER_CHECKOUTS), so skipping this file cannot bypass
-- the gate. scripts/db-proof/annualTerm.mjs proves this file read-only and its gate identical to the migration's.
--
-- Definitions (identical to the migration's gate):
--   invalid intent   — a CFOCLOSE SOLO/PRACTICE/FIRM checkout intent with
--                      billing_interval IS DISTINCT FROM 'ANNUAL' OR billing_interval_count IS DISTINCT FROM 1;
--   fulfillable      — any status other than the terminal SUCCEEDED, FAILED, CANCELLED, EXPIRED;
--   provider-backed  — provider_checkout_ref IS NOT NULL;
--   reconciled       — a payment_events row for that intent, verification_method PROVIDER_API_VERIFY or MANUAL_ADMIN,
--                      verified_at set, non-blank provider_transaction_id and payload_hash (the provider evidence), and a
--                      final outcome: normalized_status CANCELLED, EXPIRED or REFUNDED (a void is a provider
--                      cancellation), or SUCCEEDED with its licence existing (fulfilled before the migration; preserved,
--                      expires naturally). Nothing else reconciles: not WEBHOOK_ONLY, not FAILED, not PARTIALLY_REFUNDED,
--                      not UNKNOWN, not PENDING, not CHECKOUT_CREATED, not an event without evidence.
--
-- An invalid checkout is NEVER fulfilled. Do NOT commit it through commit_verified_commercial_payment as SUCCEEDED: a
-- MONTHLY × 1 checkout would create a one-month licence, an ANNUAL × 2 checkout a 24-month one. Treatment, per row of B
-- and C, after looking the session up at the provider (provider, provider_environment, provider_checkout_ref,
-- saff_reference):
--
--   Provider state         Required action
--   ─────────────────────  ──────────────────────────────────────────────────────────────────────────────────────────
--   unpaid / open          cancel or expire it AT THE PROVIDER, then record the provider-verified CANCELLED / EXPIRED
--                          outcome (the verified non-success path, PROVIDER_API_VERIFY, with its evidence).
--   paid, not fulfilled    do NOT fulfil it. Refund or void AT THE PROVIDER and record the verified REFUNDED / CANCELLED
--                          outcome — or, with the customer's explicit consent, refund/void it AND sell a new, valid
--                          ANNUAL × 1 checkout (the invalid one still ends REFUNDED / CANCELLED).
--   already fulfilled      inventory the licence (A) and record an explicit grandfather or refund decision. The
--                          migration leaves the licence unchanged (it expires naturally).
--   cannot verify          STOP. Do not apply the migration; investigate with the provider. A reviewed MANUAL_ADMIN
--                          outcome is acceptable only with the provider's evidence (transaction id and evidence hash).
--
-- Apply only when D reads GATE = PASS; the migration re-checks both conditions atomically and refuses otherwise.

-- A. Licences that came from an invalid checkout, or that a payment created for anything but the 12-month term, and that
--    are effective or can still become effective (not CANCELLED, not EXPIRED, period not over). A future licence cancelled
--    through admin_cancel_future_licence is terminal and immutable, so it leaves this list; its row is preserved.
SELECT 'A_invalid_term_licence' AS section, l.id AS licence_id, p.code AS product_code, cp.code AS plan_code, l.status,
       l.source, l.effective_start, l.effective_end, (l.effective_end - l.effective_start) AS authorised_span,
       i.id AS checkout_intent_id, i.billing_interval, i.billing_interval_count
  FROM public.commercial_licences l
  JOIN public.commercial_plans cp ON cp.id = l.plan_id
  JOIN public.commercial_products p ON p.id = cp.product_id
  LEFT JOIN public.payment_events e ON e.licence_id = l.id
  LEFT JOIN public.payment_checkout_intents i ON i.id = e.checkout_intent_id
 WHERE l.status NOT IN ('CANCELLED', 'EXPIRED') AND (l.effective_end IS NULL OR l.effective_end > now())
   AND ((i.id IS NOT NULL AND (i.billing_interval IS DISTINCT FROM 'ANNUAL' OR i.billing_interval_count IS DISTINCT FROM 1))
    OR (l.source LIKE '%\_VERIFIED\_PAYMENT' ESCAPE '\'
        AND (l.effective_end IS NULL OR l.effective_end <> l.effective_start + interval '12 months')))
 ORDER BY l.effective_start;

-- B. Gate condition (1): invalid intents that can still be fulfilled.
SELECT 'B_invalid_fulfillable_intent' AS section, i.id AS checkout_intent_id, cp.code AS plan_code, i.billing_interval,
       i.billing_interval_count, i.status, i.provider, i.provider_environment, i.provider_checkout_ref, i.saff_reference,
       i.created_at, i.expires_at
  FROM public.payment_checkout_intents i
  JOIN public.commercial_plans cp ON cp.id = i.plan_id
  JOIN public.commercial_products p ON p.id = cp.product_id
 WHERE p.code = 'CFOCLOSE' AND cp.code IN ('SOLO', 'PRACTICE', 'FIRM')
   AND (i.billing_interval IS DISTINCT FROM 'ANNUAL' OR i.billing_interval_count IS DISTINCT FROM 1)
   AND i.status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED')
 ORDER BY i.created_at;

-- C. Gate condition (2): invalid provider-backed intents without an authoritative verified terminal outcome, with the
--    events they do have (for the investigation).
SELECT 'C_unreconciled_provider_checkout' AS section, i.id AS checkout_intent_id, cp.code AS plan_code, i.billing_interval,
       i.billing_interval_count, i.status, i.provider, i.provider_environment, i.provider_checkout_ref, i.saff_reference,
       (SELECT jsonb_agg(jsonb_build_object('normalized_status', e.normalized_status, 'verification_method', e.verification_method,
                                            'verified_at', e.verified_at, 'event_type', e.event_type) ORDER BY e.recorded_at)
          FROM public.payment_events e WHERE e.checkout_intent_id = i.id) AS events_present
  FROM public.payment_checkout_intents i
  JOIN public.commercial_plans cp ON cp.id = i.plan_id
  JOIN public.commercial_products p ON p.id = cp.product_id
 WHERE p.code = 'CFOCLOSE' AND cp.code IN ('SOLO', 'PRACTICE', 'FIRM')
   AND (i.billing_interval IS DISTINCT FROM 'ANNUAL' OR i.billing_interval_count IS DISTINCT FROM 1)
   AND i.provider_checkout_ref IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.payment_events e
      WHERE e.checkout_intent_id = i.id
        AND e.verification_method IN ('PROVIDER_API_VERIFY', 'MANUAL_ADMIN')
        AND e.verified_at IS NOT NULL
        AND nullif(btrim(e.provider_transaction_id), '') IS NOT NULL
        AND nullif(btrim(e.payload_hash), '') IS NOT NULL
        AND (e.normalized_status IN ('CANCELLED', 'EXPIRED', 'REFUNDED')
             OR (e.normalized_status = 'SUCCEEDED' AND e.licence_id IS NOT NULL
                 AND EXISTS (SELECT 1 FROM public.commercial_licences l WHERE l.id = e.licence_id))))
 ORDER BY i.created_at;

-- D. The gate — exactly the migration's two conditions. Platform payment state shown for the record (PAYMENTS_DISABLED).
SELECT 'D_gate' AS section, b.invalid_fulfillable_intents, c.unreconciled_provider_checkouts, s.platform_state,
       CASE WHEN b.invalid_fulfillable_intents = 0 AND c.unreconciled_provider_checkouts = 0 THEN 'PASS' ELSE 'FAIL' END AS gate
  FROM (SELECT count(*) AS invalid_fulfillable_intents
          FROM public.payment_checkout_intents i
          JOIN public.commercial_plans cp ON cp.id = i.plan_id
          JOIN public.commercial_products p ON p.id = cp.product_id
         WHERE p.code = 'CFOCLOSE' AND cp.code IN ('SOLO', 'PRACTICE', 'FIRM')
           AND (i.billing_interval IS DISTINCT FROM 'ANNUAL' OR i.billing_interval_count IS DISTINCT FROM 1)
           AND i.status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED')) b,
       (SELECT count(*) AS unreconciled_provider_checkouts
          FROM public.payment_checkout_intents i
          JOIN public.commercial_plans cp ON cp.id = i.plan_id
          JOIN public.commercial_products p ON p.id = cp.product_id
         WHERE p.code = 'CFOCLOSE' AND cp.code IN ('SOLO', 'PRACTICE', 'FIRM')
           AND (i.billing_interval IS DISTINCT FROM 'ANNUAL' OR i.billing_interval_count IS DISTINCT FROM 1)
           AND i.provider_checkout_ref IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM public.payment_events e
              WHERE e.checkout_intent_id = i.id
                AND e.verification_method IN ('PROVIDER_API_VERIFY', 'MANUAL_ADMIN')
                AND e.verified_at IS NOT NULL
                AND nullif(btrim(e.provider_transaction_id), '') IS NOT NULL
                AND nullif(btrim(e.payload_hash), '') IS NOT NULL
                AND (e.normalized_status IN ('CANCELLED', 'EXPIRED', 'REFUNDED')
                     OR (e.normalized_status = 'SUCCEEDED' AND e.licence_id IS NOT NULL
                         AND EXISTS (SELECT 1 FROM public.commercial_licences l WHERE l.id = e.licence_id))))) c,
       (SELECT string_agg(state, ',') AS platform_state FROM public.commercial_platform_state) s;
