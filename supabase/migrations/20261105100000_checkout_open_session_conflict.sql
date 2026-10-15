-- 20261105100000_checkout_open_session_conflict.sql — billing recovery (checkout abandonment).
-- acquire_checkout_attempt used to move a still-payable PENDING checkout into MANUAL_REVIEW
-- ('PENDING_CHECKOUT_NOT_REUSABLE') whenever a new request could not reuse it: a different plan of the same product,
-- or the same plan after the LOCAL one-hour lease passed while the provider session (Polar: ~24 h) was still open.
-- That stranded open, unpaid orders behind manual review. Now that case is answered WITHOUT any write:
-- 'OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT' with the existing order's reference; the one-attempt-per-(customer, product)
-- lock, the advisory lock and every other branch are unchanged. The existing order is closed only by a
-- provider-verified final outcome through commit_verified_commercial_payment (never by the browser or a local clock).
-- Existing MANUAL_REVIEW rows are not rewritten.
CREATE OR REPLACE FUNCTION public.acquire_checkout_attempt(
  p_billing_customer_id UUID, p_product_id UUID, p_plan_id UUID,
  p_commercial_offer_id UUID, p_market_code TEXT, p_currency_code TEXT,
  p_currency_exponent SMALLINT, p_amount_minor BIGINT,
  p_billing_interval TEXT, p_billing_interval_count SMALLINT,
  p_provider TEXT, p_provider_environment TEXT,
  p_created_by_user_id UUID, p_saff_reference TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing RECORD;
  v_new_id UUID;
  v_new_token UUID := gen_random_uuid();
  v_now TIMESTAMPTZ := now();
  v_expires_at TIMESTAMPTZ := now() + interval '1 hour';
BEGIN
  IF p_billing_customer_id IS NULL OR p_product_id IS NULL OR p_created_by_user_id IS NULL THEN
    RAISE EXCEPTION 'ACQUIRE_CHECKOUT_ATTEMPT_MISSING_IDENTITY' USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_platform_state_permits(p_provider_environment, p_created_by_user_id);
  PERFORM pg_advisory_xact_lock(hashtext(p_billing_customer_id::text || ':' || p_product_id::text));

  SELECT * INTO v_existing
    FROM public.payment_checkout_intents
   WHERE billing_customer_id = p_billing_customer_id
     AND product_id = p_product_id
     AND status IN ('CREATING','PROVIDER_CREATING','PENDING','MANUAL_REVIEW')
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'MANUAL_REVIEW' THEN
      RETURN jsonb_build_object('action','MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT','intent_id',v_existing.id);
    END IF;

    IF v_existing.status = 'PROVIDER_CREATING' THEN
      IF v_existing.creation_lease_expires_at IS NULL OR v_existing.creation_lease_expires_at <= v_now THEN
        UPDATE public.payment_checkout_intents
           SET status='MANUAL_REVIEW',
               metadata=metadata || jsonb_build_object('manual_review_reason','PROVIDER_REQUEST_LEASE_EXPIRED','manual_review_at',v_now)
         WHERE id=v_existing.id;
        RETURN jsonb_build_object('action','MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT','intent_id',v_existing.id);
      END IF;
      RETURN jsonb_build_object('action','ALREADY_IN_PROGRESS','intent_id',v_existing.id);
    END IF;

    IF v_existing.status = 'CREATING' THEN
      IF v_existing.creation_lease_expires_at IS NULL OR v_existing.creation_lease_expires_at <= v_now THEN
        UPDATE public.payment_checkout_intents
           SET status='FAILED', completed_at=v_now,
               metadata=metadata || jsonb_build_object('failed_reason','PRE_PROVIDER_LEASE_EXPIRED')
         WHERE id=v_existing.id;
      ELSE
        RETURN jsonb_build_object(
          'action', CASE WHEN v_existing.commercial_offer_id = p_commercial_offer_id
                         THEN 'ALREADY_IN_PROGRESS' ELSE 'CONFLICT_DIFFERENT_INTERVAL' END,
          'intent_id',v_existing.id,'existing_billing_interval',v_existing.billing_interval
        );
      END IF;
    ELSIF v_existing.status = 'PENDING' THEN
      IF v_existing.commercial_offer_id = p_commercial_offer_id
         AND v_existing.provider = p_provider
         AND v_existing.provider_environment = p_provider_environment
         AND v_existing.provider_checkout_url IS NOT NULL
         AND v_existing.expires_at > v_now THEN
        RETURN jsonb_build_object(
          'action','REUSE_EXISTING','intent_id',v_existing.id,
          'saff_reference',v_existing.saff_reference,
          'checkout_url',v_existing.provider_checkout_url,
          'expires_at',v_existing.expires_at,'provider',v_existing.provider
        );
      END IF;
      -- Not reusable here, but possibly still payable at the provider: block without writing anything.
      RETURN jsonb_build_object(
        'action','OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT','intent_id',v_existing.id,
        'saff_reference',v_existing.saff_reference,'existing_offer_id',v_existing.commercial_offer_id,
        'existing_plan_id',v_existing.plan_id
      );
    END IF;
  END IF;

  INSERT INTO public.payment_checkout_intents (
    billing_customer_id, commercial_offer_id, plan_id, product_id, market_code,
    expected_amount_minor, currency_code, currency_exponent,
    billing_interval, billing_interval_count, provider, provider_environment,
    saff_reference, status, creation_token, creation_lease_expires_at,
    created_by_user_id, expires_at
  ) VALUES (
    p_billing_customer_id,p_commercial_offer_id,p_plan_id,p_product_id,p_market_code,
    p_amount_minor,p_currency_code,p_currency_exponent,
    p_billing_interval,p_billing_interval_count,p_provider,p_provider_environment,
    p_saff_reference,'CREATING',v_new_token,v_now + interval '2 minutes',
    p_created_by_user_id,v_expires_at
  ) RETURNING id INTO v_new_id;

  RETURN jsonb_build_object('action','NEW_ATTEMPT','intent_id',v_new_id,
    'saff_reference',p_saff_reference,'creation_token',v_new_token,'expires_at',v_expires_at);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('action','ALREADY_IN_PROGRESS');
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_checkout_attempt(UUID,UUID,UUID,UUID,TEXT,TEXT,SMALLINT,BIGINT,TEXT,SMALLINT,TEXT,TEXT,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_checkout_attempt(UUID,UUID,UUID,UUID,TEXT,TEXT,SMALLINT,BIGINT,TEXT,SMALLINT,TEXT,TEXT,UUID,TEXT) TO service_role;
