-- annualTermPreflight.sql — MANDATORY zero-state gate, READ-ONLY, to run against production BEFORE
-- 20261001120000_annual_commercial_term.sql is applied. SELECT statements only; run inside
-- `BEGIN READ ONLY; … ROLLBACK;`. Proven read-only, and its PASS proven meaningful, by scripts/db-proof/annualTerm.mjs.
--
-- Definitions (identical to the migration's gate):
--   invalid intent   — a CFOCLOSE SOLO/PRACTICE/FIRM checkout intent with
--                      billing_interval IS DISTINCT FROM 'ANNUAL' OR billing_interval_count IS DISTINCT FROM 1;
--   fulfillable      — any status other than the terminal SUCCEEDED, FAILED, CANCELLED, EXPIRED (derived from the live
--                      functions: PENDING and MANUAL_REVIEW are committed directly; CREATING and PROVIDER_CREATING move
--                      into them; expires_at is ignored because the commit does not re-check it);
--   provider session — provider_checkout_ref IS NOT NULL (a checkout was created at the provider);
--   reconciled       — the intent carries a provider-verified outcome: a payment_events row written for it by
--                      commit_verified_commercial_payment (a SUCCEEDED commit with its licence, or a verified non-success).
--
-- Procedure:
--   1. Run this file. A–C are the record; D is the gate.
--   2. For every row in B: look the session up at the provider (provider, provider_environment, provider_checkout_ref,
--      saff_reference). Paid → commit it through the normal verified-payment path BEFORE the migration (its licence is
--      created under the current rules). Not paid → have the provider session expired/cancelled and record the verified
--      non-success through the same path. Either way the intent ends terminal WITH a provider-verified outcome.
--   3. Re-run. Apply only when D reads GATE = PASS. The migration itself refuses to apply while any invalid intent is
--      still fulfillable (SQLSTATE PT422, INVALID_OPEN_CHECKOUT_INTENTS). Rows in C (terminal, provider session, no
--      verified outcome) are pre-existing exposures the migration neither creates nor fixes; they must be cleared by a
--      reviewed decision before PASS.
--
-- Existing monthly-paid licences (A) are NOT changed by the migration: they keep their period and expire naturally.

-- A. Licences that came from an invalid checkout, or that a payment created for anything but the 12-month term.
SELECT 'A_invalid_term_licence' AS section, l.id AS licence_id, p.code AS product_code, cp.code AS plan_code, l.status,
       l.source, l.effective_start, l.effective_end, (l.effective_end - l.effective_start) AS authorised_span,
       i.id AS checkout_intent_id, i.billing_interval, i.billing_interval_count
  FROM public.commercial_licences l
  JOIN public.commercial_plans cp ON cp.id = l.plan_id
  JOIN public.commercial_products p ON p.id = cp.product_id
  LEFT JOIN public.payment_events e ON e.licence_id = l.id
  LEFT JOIN public.payment_checkout_intents i ON i.id = e.checkout_intent_id
 WHERE (i.id IS NOT NULL AND (i.billing_interval IS DISTINCT FROM 'ANNUAL' OR i.billing_interval_count IS DISTINCT FROM 1))
    OR (l.source LIKE '%\_VERIFIED\_PAYMENT' ESCAPE '\'
        AND (l.effective_end IS NULL OR l.effective_end <> l.effective_start + interval '12 months'))
 ORDER BY l.effective_start;

-- B. Every INVALID CFOCLOSE self-serve intent that can still be fulfilled — each must be reconciled at the provider and
--    resolved before the migration.
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

-- C. Every INVALID intent that reached a provider session and is terminal WITHOUT a provider-verified outcome.
SELECT 'C_unreconciled_provider_session' AS section, i.id AS checkout_intent_id, cp.code AS plan_code, i.billing_interval,
       i.billing_interval_count, i.status, i.provider, i.provider_environment, i.provider_checkout_ref, i.saff_reference
  FROM public.payment_checkout_intents i
  JOIN public.commercial_plans cp ON cp.id = i.plan_id
  JOIN public.commercial_products p ON p.id = cp.product_id
 WHERE p.code = 'CFOCLOSE' AND cp.code IN ('SOLO', 'PRACTICE', 'FIRM')
   AND (i.billing_interval IS DISTINCT FROM 'ANNUAL' OR i.billing_interval_count IS DISTINCT FROM 1)
   AND i.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED')
   AND i.provider_checkout_ref IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.payment_events e WHERE e.checkout_intent_id = i.id)
 ORDER BY i.created_at;

-- D. The gate. PASS only when no invalid intent can be fulfilled AND every invalid intent that reached a provider session
--    carries a provider-verified outcome. Platform payment state is shown for the record (must stay PAYMENTS_DISABLED).
SELECT 'D_gate' AS section, b.invalid_fulfillable_intents, c.unreconciled_provider_sessions, s.platform_state,
       CASE WHEN b.invalid_fulfillable_intents = 0 AND c.unreconciled_provider_sessions = 0 THEN 'PASS' ELSE 'FAIL' END AS gate
  FROM (SELECT count(*) AS invalid_fulfillable_intents
          FROM public.payment_checkout_intents i
          JOIN public.commercial_plans cp ON cp.id = i.plan_id
          JOIN public.commercial_products p ON p.id = cp.product_id
         WHERE p.code = 'CFOCLOSE' AND cp.code IN ('SOLO', 'PRACTICE', 'FIRM')
           AND (i.billing_interval IS DISTINCT FROM 'ANNUAL' OR i.billing_interval_count IS DISTINCT FROM 1)
           AND i.status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED')) b,
       (SELECT count(*) AS unreconciled_provider_sessions
          FROM public.payment_checkout_intents i
          JOIN public.commercial_plans cp ON cp.id = i.plan_id
          JOIN public.commercial_products p ON p.id = cp.product_id
         WHERE p.code = 'CFOCLOSE' AND cp.code IN ('SOLO', 'PRACTICE', 'FIRM')
           AND (i.billing_interval IS DISTINCT FROM 'ANNUAL' OR i.billing_interval_count IS DISTINCT FROM 1)
           AND i.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED')
           AND i.provider_checkout_ref IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.payment_events e WHERE e.checkout_intent_id = i.id)) c,
       (SELECT string_agg(state, ',') AS platform_state FROM public.commercial_platform_state) s;
