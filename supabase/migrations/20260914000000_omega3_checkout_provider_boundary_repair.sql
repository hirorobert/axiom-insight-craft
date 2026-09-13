-- CFOClose Ω3-CHECKOUT provider-side-effect boundary repair.
-- Forward-only. This migration must be applied while checkout is disabled.

SET search_path TO public, pg_catalog;

DO $$
DECLARE v_state TEXT;
BEGIN
  SELECT state INTO v_state FROM public.commercial_platform_state WHERE id = true;
  IF v_state IS DISTINCT FROM 'PAYMENTS_DISABLED' THEN
    RAISE EXCEPTION 'CHECKOUT_REPAIR_REQUIRES_PAYMENTS_DISABLED: current state=%', v_state
      USING ERRCODE = '55000';
  END IF;
END $$;

ALTER TABLE public.payment_checkout_intents DROP CONSTRAINT chk_pci_status;
ALTER TABLE public.payment_checkout_intents ADD CONSTRAINT chk_pci_status CHECK (
  status IN ('CREATING','PROVIDER_CREATING','PENDING','SUCCEEDED','FAILED','CANCELLED','EXPIRED','MANUAL_REVIEW')
);

ALTER TABLE public.payment_checkout_intents
  ADD COLUMN creation_lease_expires_at TIMESTAMPTZ NULL,
  ADD COLUMN provider_request_started_at TIMESTAMPTZ NULL;

-- Old CREATING does not prove whether the external request had started.
-- Preserve it for reconciliation; never infer that retry is safe.
UPDATE public.payment_checkout_intents
   SET status = 'MANUAL_REVIEW',
       metadata = metadata || jsonb_build_object(
         'manual_review_reason', 'LEGACY_CREATING_PROVIDER_BOUNDARY_UNKNOWN',
         'manual_review_at', now()
       )
 WHERE status = 'CREATING';

DROP INDEX IF EXISTS public.uq_pci_one_open_intent_per_customer_product;
CREATE UNIQUE INDEX uq_pci_one_open_intent_per_customer_product
  ON public.payment_checkout_intents (billing_customer_id, product_id)
  WHERE status IN ('CREATING','PROVIDER_CREATING','PENDING','MANUAL_REVIEW');

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
      UPDATE public.payment_checkout_intents
         SET status='MANUAL_REVIEW',
             metadata=metadata || jsonb_build_object('manual_review_reason','PENDING_CHECKOUT_NOT_REUSABLE','manual_review_at',v_now)
       WHERE id=v_existing.id;
      RETURN jsonb_build_object('action','MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT','intent_id',v_existing.id);
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

CREATE OR REPLACE FUNCTION public.begin_provider_checkout_request(
  p_checkout_intent_id UUID, p_creation_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE v_updated UUID;
BEGIN
  UPDATE public.payment_checkout_intents
     SET status='PROVIDER_CREATING', provider_request_started_at=now()
   WHERE id=p_checkout_intent_id AND creation_token=p_creation_token
     AND status='CREATING' AND creation_lease_expires_at > now()
  RETURNING id INTO v_updated;
  RETURN jsonb_build_object('transitioned', FOUND);
END;
$$;
REVOKE ALL ON FUNCTION public.begin_provider_checkout_request(UUID,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_provider_checkout_request(UUID,UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.persist_checkout_provider_result(
  p_checkout_intent_id UUID, p_creation_token UUID,
  p_provider_checkout_ref TEXT, p_provider_checkout_url TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE v_updated RECORD;
BEGIN
  IF p_provider_checkout_url IS NULL OR trim(p_provider_checkout_url) = '' THEN
    RAISE EXCEPTION 'PERSIST_CHECKOUT_PROVIDER_RESULT_BLANK_URL' USING ERRCODE='22023';
  END IF;
  UPDATE public.payment_checkout_intents
     SET status='PENDING', provider_checkout_ref=p_provider_checkout_ref,
         provider_checkout_url=p_provider_checkout_url
   WHERE id=p_checkout_intent_id AND creation_token=p_creation_token
     AND status='PROVIDER_CREATING'
  RETURNING id,saff_reference,expires_at INTO v_updated;
  IF NOT FOUND THEN RETURN jsonb_build_object('persisted',false); END IF;
  RETURN jsonb_build_object('persisted',true,'intent_id',v_updated.id,
    'saff_reference',v_updated.saff_reference,'expires_at',v_updated.expires_at);
END;
$$;
REVOKE ALL ON FUNCTION public.persist_checkout_provider_result(UUID,UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_checkout_provider_result(UUID,UUID,TEXT,TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_checkout_attempt_failed(
  p_checkout_intent_id UUID, p_creation_token UUID, p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE v_updated UUID;
BEGIN
  UPDATE public.payment_checkout_intents
     SET status='FAILED', completed_at=now(),
         metadata=metadata || jsonb_build_object('failed_reason',p_reason)
   WHERE id=p_checkout_intent_id AND creation_token=p_creation_token
     AND status='PROVIDER_CREATING'
  RETURNING id INTO v_updated;
  RETURN jsonb_build_object('updated',FOUND);
END;
$$;
REVOKE ALL ON FUNCTION public.mark_checkout_attempt_failed(UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_checkout_attempt_failed(UUID,UUID,TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_checkout_attempt_uncertain(
  p_checkout_intent_id UUID, p_creation_token UUID, p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE v_updated UUID;
BEGIN
  UPDATE public.payment_checkout_intents
     SET status='MANUAL_REVIEW',
         metadata=metadata || jsonb_build_object('uncertain_reason',p_reason,'uncertain_at',now())
   WHERE id=p_checkout_intent_id AND creation_token=p_creation_token
     AND status='PROVIDER_CREATING'
  RETURNING id INTO v_updated;
  RETURN jsonb_build_object('updated',FOUND);
END;
$$;
REVOKE ALL ON FUNCTION public.mark_checkout_attempt_uncertain(UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_checkout_attempt_uncertain(UUID,UUID,TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_verification_attempt(
  p_checkout_intent_id UUID, p_requesting_user_id UUID,
  p_cooldown_seconds INTEGER DEFAULT 60
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE v_intent RECORD; v_now TIMESTAMPTZ := now(); v_cooldown INTEGER;
BEGIN
  IF p_requesting_user_id IS NULL THEN
    RAISE EXCEPTION 'CLAIM_VERIFICATION_ATTEMPT_MISSING_IDENTITY' USING ERRCODE='22023';
  END IF;
  v_cooldown := LEAST(300,GREATEST(30,COALESCE(p_cooldown_seconds,60)));
  SELECT ci.*,bc.owner_user_id INTO v_intent
    FROM public.payment_checkout_intents ci
    JOIN public.billing_customers bc ON bc.id=ci.billing_customer_id
   WHERE ci.id=p_checkout_intent_id FOR UPDATE OF ci;
  IF NOT FOUND OR (v_intent.owner_user_id != p_requesting_user_id AND NOT public.is_commercial_admin()) THEN
    RETURN jsonb_build_object('claimed',false,'reason','NOT_FOUND_OR_NOT_OWNER');
  END IF;
  IF v_intent.status NOT IN ('PENDING','MANUAL_REVIEW') THEN
    RETURN jsonb_build_object('claimed',false,'reason','INTENT_NOT_VERIFIABLE','status',v_intent.status);
  END IF;
  IF v_intent.verification_claimed_until IS NOT NULL AND v_intent.verification_claimed_until > v_now THEN
    RETURN jsonb_build_object('claimed',false,'reason','THROTTLED','retry_after_seconds',
      GREATEST(1,CEIL(EXTRACT(EPOCH FROM (v_intent.verification_claimed_until-v_now)))));
  END IF;
  UPDATE public.payment_checkout_intents
     SET last_verification_attempt_at=v_now,
         verification_claimed_until=v_now+make_interval(secs=>v_cooldown)
   WHERE id=p_checkout_intent_id;
  RETURN jsonb_build_object('claimed',true,'intent_id',v_intent.id,'provider',v_intent.provider,
    'saff_reference',v_intent.saff_reference,'expected_amount_minor',v_intent.expected_amount_minor,
    'currency_code',v_intent.currency_code);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_verification_attempt(UUID,UUID,INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_verification_attempt(UUID,UUID,INTEGER) TO service_role;

COMMENT ON COLUMN public.payment_checkout_intents.creation_lease_expires_at IS
  'Lease for pre-provider CREATING work. Expiry is safe to fail only before PROVIDER_CREATING.';
COMMENT ON COLUMN public.payment_checkout_intents.provider_request_started_at IS
  'Durable point at which an external provider side effect may have begun.';
