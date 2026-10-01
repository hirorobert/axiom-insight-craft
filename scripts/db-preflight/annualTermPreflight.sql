-- annualTermPreflight.sql — MANDATORY zero-state gate, READ-ONLY, to run against production BEFORE
-- 20261001120000_annual_commercial_term.sql is applied. SELECT statements only; run inside
-- `BEGIN READ ONLY; … ROLLBACK;`. Proven read-only by scripts/db-proof/annualTerm.mjs.
--
-- Procedure:
--   1. Run this file. Sections A–C are for the record and for reconciliation; section D is the gate.
--   2. For EVERY row in section B, look the session up at the provider (provider + provider_checkout_ref /
--      saff_reference) and settle it there: a session that was paid is committed through the normal verified-payment
--      path BEFORE the migration (it will then create its licence under the old rules); a session that was not paid is
--      expired/cancelled at the provider and resolved here through the existing failure path. Never apply the migration
--      with a session still open at the provider.
--   3. Re-run. Apply the migration only when section D reads GATE = PASS with zero open intents, and the provider
--      dashboards show zero open sessions for the references listed in B. The migration itself also refuses to apply
--      while any open self-serve monthly intent exists (SQLSTATE PT422, OPEN_MONTHLY_CHECKOUT_INTENTS).
--
-- Existing monthly-paid licences (section A) are NOT changed by the migration: they keep their period and expire
-- naturally.

-- A. Every licence that came from a MONTHLY checkout, or that a payment created for less than the 12-month term.
SELECT 'A_monthly_paid_licence' AS section, l.id AS licence_id, p.code AS product_code, cp.code AS plan_code, l.status,
       l.source, l.effective_start, l.effective_end, (l.effective_end - l.effective_start) AS authorised_span,
       i.id AS checkout_intent_id, i.billing_interval
  FROM public.commercial_licences l
  JOIN public.commercial_plans cp ON cp.id = l.plan_id
  JOIN public.commercial_products p ON p.id = cp.product_id
  LEFT JOIN public.payment_events e ON e.licence_id = l.id
  LEFT JOIN public.payment_checkout_intents i ON i.id = e.checkout_intent_id
 WHERE i.billing_interval = 'MONTHLY'
    OR (l.source LIKE '%\_VERIFIED\_PAYMENT' ESCAPE '\'
        AND (l.effective_end IS NULL OR l.effective_end <> l.effective_start + interval '12 months'))
 ORDER BY l.effective_start;

-- B. Every open checkout intent (any interval) with its provider references — each must be reconciled at the provider.
--    Monthly self-serve intents are the ones the gate counts; annual ones are listed so no open session is overlooked.
SELECT 'B_open_checkout_intent' AS section, i.id AS checkout_intent_id, p.code AS product_code, cp.code AS plan_code,
       i.billing_interval, i.billing_interval_count, i.status, i.provider, i.provider_environment, i.provider_checkout_ref,
       i.saff_reference, i.created_at, i.expires_at, (i.expires_at < now()) AS locally_expired_but_still_open
  FROM public.payment_checkout_intents i
  JOIN public.commercial_plans cp ON cp.id = i.plan_id
  JOIN public.commercial_products p ON p.id = cp.product_id
 WHERE i.status IN ('CREATED', 'PENDING', 'MANUAL_REVIEW')
 ORDER BY i.created_at;

-- C. Platform payment state — must remain PAYMENTS_DISABLED (this migration does not change it).
SELECT 'C_platform_state' AS section, state, updated_at FROM public.commercial_platform_state;

-- D. The gate.
SELECT 'D_gate' AS section,
       count(*) FILTER (WHERE p.code = 'CFOCLOSE' AND cp.code IN ('SOLO', 'PRACTICE', 'FIRM')
                          AND i.billing_interval IS DISTINCT FROM 'ANNUAL') AS open_self_serve_monthly_intents,
       count(*) AS open_intents_any_interval,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS gate
  FROM public.payment_checkout_intents i
  JOIN public.commercial_plans cp ON cp.id = i.plan_id
  JOIN public.commercial_products p ON p.id = cp.product_id
 WHERE i.status IN ('CREATED', 'PENDING', 'MANUAL_REVIEW');
