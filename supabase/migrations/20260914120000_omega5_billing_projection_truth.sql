-- Ω5 — billing projection truth
--
-- Forward-only correction for two customer-facing projection defects found
-- during the first successful CFOClose sandbox renewal:
--   1. get_checkout_status returned the currently effective licence period,
--      not the licence created by the checkout being inspected.
--   2. get_my_billing_summary did not expose a future prepaid extension, so
--      Settings could not distinguish current access from scheduled access.
--
-- No payment, offer, platform-state, entitlement, or licence row is mutated.

CREATE OR REPLACE FUNCTION public.get_my_billing_summary()
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  STABLE
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id                  UUID := auth.uid();
  v_billing_customer_id      UUID;
  v_current                  RECORD;
  v_next                     RECORD;
  v_scheduled_effective_end  TIMESTAMPTZ;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  SELECT id INTO v_billing_customer_id
    FROM public.billing_customers
   WHERE owner_user_id = v_user_id;

  IF v_billing_customer_id IS NULL THEN
    RETURN jsonb_build_object(
      'has_billing_customer', false,
      'plan_code', NULL,
      'licence_status', NULL,
      'effective_start', NULL,
      'effective_end', NULL,
      'entitlements', '[]'::jsonb,
      'billing_interval', NULL,
      'billing_interval_count', NULL,
      'scheduled_effective_end', NULL,
      'next_effective_start', NULL,
      'next_effective_end', NULL,
      'next_billing_interval', NULL,
      'next_billing_interval_count', NULL
    );
  END IF;

  SELECT
    cl.id,
    cl.plan_id,
    cl.status AS licence_status,
    cl.effective_start,
    cl.effective_end,
    cp.code AS plan_code,
    cp.feature_codes,
    pci.billing_interval,
    pci.billing_interval_count
  INTO v_current
    FROM public.commercial_licences cl
    JOIN public.commercial_plans cp ON cp.id = cl.plan_id
    LEFT JOIN LATERAL (
      SELECT pe.checkout_intent_id
        FROM public.payment_events pe
       WHERE pe.licence_id = cl.id
         AND pe.event_type = 'PAYMENT_CONFIRMED'
       ORDER BY pe.event_time DESC
       LIMIT 1
    ) latest_evt ON true
    LEFT JOIN public.payment_checkout_intents pci
      ON pci.id = latest_evt.checkout_intent_id
   WHERE cl.billing_customer_id = v_billing_customer_id
     AND cl.status IN ('ACTIVE', 'GRACE')
     AND cl.effective_start <= now()
     AND (cl.effective_end IS NULL OR cl.effective_end > now())
   ORDER BY cl.effective_start DESC
   LIMIT 1;

  IF v_current.id IS NULL THEN
    RETURN jsonb_build_object(
      'has_billing_customer', true,
      'plan_code', NULL,
      'licence_status', NULL,
      'effective_start', NULL,
      'effective_end', NULL,
      'entitlements', '[]'::jsonb,
      'billing_interval', NULL,
      'billing_interval_count', NULL,
      'scheduled_effective_end', NULL,
      'next_effective_start', NULL,
      'next_effective_end', NULL,
      'next_billing_interval', NULL,
      'next_billing_interval_count', NULL
    );
  END IF;

  -- This is deliberately named "scheduled", not "current" or "renews".
  -- It reports the furthest stored ACTIVE/GRACE term for the current plan;
  -- the next-term fields below disclose the first future range explicitly.
  SELECT max(cl.effective_end)
    INTO v_scheduled_effective_end
    FROM public.commercial_licences cl
   WHERE cl.billing_customer_id = v_billing_customer_id
     AND cl.plan_id = v_current.plan_id
     AND cl.status IN ('ACTIVE', 'GRACE')
     AND cl.effective_end > now();

  SELECT
    cl.effective_start,
    cl.effective_end,
    pci.billing_interval,
    pci.billing_interval_count
  INTO v_next
    FROM public.commercial_licences cl
    LEFT JOIN LATERAL (
      SELECT pe.checkout_intent_id
        FROM public.payment_events pe
       WHERE pe.licence_id = cl.id
         AND pe.event_type = 'PAYMENT_CONFIRMED'
       ORDER BY pe.event_time DESC
       LIMIT 1
    ) latest_evt ON true
    LEFT JOIN public.payment_checkout_intents pci
      ON pci.id = latest_evt.checkout_intent_id
   WHERE cl.billing_customer_id = v_billing_customer_id
     AND cl.plan_id = v_current.plan_id
     AND cl.status IN ('ACTIVE', 'GRACE')
     AND cl.effective_start >= v_current.effective_end
   ORDER BY cl.effective_start ASC
   LIMIT 1;

  RETURN jsonb_build_object(
    'has_billing_customer', true,
    'plan_code', v_current.plan_code,
    'licence_status', v_current.licence_status,
    'effective_start', v_current.effective_start,
    'effective_end', v_current.effective_end,
    'entitlements', to_jsonb(v_current.feature_codes),
    'billing_interval', v_current.billing_interval,
    'billing_interval_count', v_current.billing_interval_count,
    'scheduled_effective_end', v_scheduled_effective_end,
    'next_effective_start', v_next.effective_start,
    'next_effective_end', v_next.effective_end,
    'next_billing_interval', v_next.billing_interval,
    'next_billing_interval_count', v_next.billing_interval_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_billing_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_billing_summary() TO authenticated;

COMMENT ON FUNCTION public.get_my_billing_summary() IS
  'Returns the caller current effective licence plus separately named future '
  'prepaid-term projection fields. Projection only; never an entitlement gate.';

CREATE OR REPLACE FUNCTION public.get_checkout_status(p_saff_reference TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_intent            RECORD;
  v_current           RECORD;
  v_purchased         RECORD;
BEGIN
  SELECT ci.* INTO v_intent
    FROM public.payment_checkout_intents ci
    JOIN public.billing_customers bc ON bc.id = ci.billing_customer_id
   WHERE ci.saff_reference = p_saff_reference
     AND (bc.owner_user_id = auth.uid() OR public.is_commercial_admin());

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false, 'status', 'UNKNOWN');
  END IF;

  SELECT
    cl.status AS licence_status,
    cp.code AS plan_code,
    cl.effective_start,
    cl.effective_end
  INTO v_current
    FROM public.commercial_licences cl
    JOIN public.commercial_plans cp ON cp.id = cl.plan_id
   WHERE cl.billing_customer_id = v_intent.billing_customer_id
     AND cl.status IN ('ACTIVE', 'GRACE')
     AND cl.effective_start <= now()
     AND (cl.effective_end IS NULL OR cl.effective_end > now())
   ORDER BY cl.effective_end DESC NULLS LAST
   LIMIT 1;

  -- Bind the purchased period to this exact checkout intent through the
  -- immutable PAYMENT_CONFIRMED event. Never infer it from "latest licence".
  SELECT
    cl.id AS licence_id,
    cl.status AS licence_status,
    cp.code AS plan_code,
    cl.effective_start,
    cl.effective_end
  INTO v_purchased
    FROM public.payment_events pe
    JOIN public.commercial_licences cl ON cl.id = pe.licence_id
    JOIN public.commercial_plans cp ON cp.id = cl.plan_id
   WHERE pe.checkout_intent_id = v_intent.id
     AND pe.event_type = 'PAYMENT_CONFIRMED'
   ORDER BY pe.event_time DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'found', true,
    'saff_reference', v_intent.saff_reference,
    'status', v_intent.status,
    'intent_id', v_intent.id,
    'provider', v_intent.provider,
    'market_code', v_intent.market_code,
    'created_at', v_intent.created_at,
    'expires_at', v_intent.expires_at,
    'completed_at', v_intent.completed_at,
    'expected_amount_minor', v_intent.expected_amount_minor,
    'currency_code', v_intent.currency_code,
    'billing_interval', v_intent.billing_interval,
    'billing_interval_count', v_intent.billing_interval_count,
    'licence_status', v_current.licence_status,
    'plan_code', COALESCE(v_purchased.plan_code, v_current.plan_code),
    'effective_start', v_current.effective_start,
    'effective_end', v_current.effective_end,
    'purchased_licence_id', v_purchased.licence_id,
    'purchased_licence_status', v_purchased.licence_status,
    'purchased_effective_start', v_purchased.effective_start,
    'purchased_effective_end', v_purchased.effective_end
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_checkout_status(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_checkout_status(TEXT) TO authenticated;

COMMENT ON FUNCTION public.get_checkout_status(TEXT) IS
  'Owner-scoped checkout status. Current licence fields remain compatible; '
  'purchased_* fields identify the exact licence created by this checkout.';
