-- 20261030100000_paid_term_seat_preservation.sql
--
-- Commercial launch closure (batch commercial-p2). Two defects found by the paid-term preservation review of
-- 20261029100000: (a) an UPGRADE ends the current licence immediately, and the additional named users bought on it
-- (commercial_licences.additional_seats) ended with it — an unrelated, separately arranged entitlement lost by a plan
-- purchase; (b) a manual grant took no lock, so a grant racing a verified payment for the same account could make that
-- payment's commit fail on the no-overlap constraint instead of being recorded. This migration:
--
--   0. refuses unless the payment provider routes (20261029100000) are applied and payments are disabled, and refuses a
--      second application;
--   1. _commercial_licence_placement: an upgrade over a current term that carries additional named users is
--      BLOCKED_SEATS (recorded once and placed by a commercial administrator, exactly like BLOCKED_OPEN_ENDED); renewal
--      and at-renewal placements report the ending term's additional_seats so checkout can say they are not included;
--   2. commit_verified_commercial_payment (same 13 arguments): any BLOCKED_* placement is recorded for review — the
--      payment once, no licence, the intent in MANUAL_REVIEW; nothing else changes;
--   3. admin_grant_commercial_licence (same 5 arguments): takes the commit's per-account lock before any read, so a grant
--      and a verified payment for one account are serialised. Its checks are unchanged.
--
-- No licence, order, payment or price row is changed. Forward-only; no applied migration is modified.

SET search_path TO public, pg_catalog;

-- ── 0. Preflight ────────────────────────────────────────────────────────────────────────────────────────────────────
DO $preflight$
BEGIN
  IF to_regprocedure('public._commercial_licence_placement(uuid,uuid,timestamp with time zone)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the payment provider routes (20261029100000) are not applied; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT state FROM public.commercial_platform_state WHERE id = true) IS DISTINCT FROM 'PAYMENTS_DISABLED' THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: payments must be disabled (commercial_platform_state = PAYMENTS_DISABLED); nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF position('BLOCKED_SEATS' IN pg_get_functiondef('public._commercial_licence_placement(uuid,uuid,timestamp with time zone)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: paid-term seat preservation is already in force; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. Where a paid term goes — now also carrying the current term's additional named users ──────────────────────────
CREATE OR REPLACE FUNCTION public._commercial_licence_placement(p_billing_customer_id UUID, p_plan_id UUID, p_at TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_current RECORD;
  v_last    RECORD;
  v_queued  INTEGER;
  v_new_cap INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM public.commercial_licences
              WHERE billing_customer_id = p_billing_customer_id AND status IN ('ACTIVE','GRACE') AND effective_end IS NULL) THEN
    RETURN jsonb_build_object('kind', 'BLOCKED_OPEN_ENDED');
  END IF;

  SELECT l.id, l.plan_id, l.effective_end, cp.entity_capacity, l.additional_seats INTO v_current
    FROM public.commercial_licences l JOIN public.commercial_plans cp ON cp.id = l.plan_id
   WHERE l.billing_customer_id = p_billing_customer_id AND l.status IN ('ACTIVE','GRACE')
     AND l.effective_start <= p_at AND l.effective_end > p_at
   ORDER BY l.effective_end DESC LIMIT 1;
  SELECT l.id, l.plan_id, l.effective_end, cp.entity_capacity, l.additional_seats INTO v_last
    FROM public.commercial_licences l JOIN public.commercial_plans cp ON cp.id = l.plan_id
   WHERE l.billing_customer_id = p_billing_customer_id AND l.status IN ('ACTIVE','GRACE') AND l.effective_end > p_at
   ORDER BY l.effective_end DESC LIMIT 1;
  SELECT count(*) INTO v_queued FROM public.commercial_licences
   WHERE billing_customer_id = p_billing_customer_id AND status IN ('ACTIVE','GRACE') AND effective_start > p_at;
  SELECT entity_capacity INTO v_new_cap FROM public.commercial_plans WHERE id = p_plan_id;

  IF v_last.id IS NULL THEN
    RETURN jsonb_build_object('kind', 'NEW', 'start', p_at);
  END IF;
  -- 'additional_seats': the named users bought beyond the plan for the term that ends where the new one starts. A new
  -- term never carries them (they are arranged separately); the customer is told before paying.
  IF v_last.plan_id = p_plan_id THEN
    RETURN jsonb_build_object('kind', 'RENEWAL', 'start', v_last.effective_end, 'additional_seats', coalesce(v_last.additional_seats, 0));
  END IF;
  IF coalesce(v_new_cap, 0) > coalesce(v_last.entity_capacity, 0) THEN
    IF v_queued > 0 OR v_current.id IS NULL THEN
      RETURN jsonb_build_object('kind', 'BLOCKED_QUEUED');
    END IF;
    -- An upgrade ends the current term now. Additional named users paid on it would end with it: never automatically.
    IF coalesce(v_current.additional_seats, 0) > 0 THEN
      RETURN jsonb_build_object('kind', 'BLOCKED_SEATS', 'additional_seats', v_current.additional_seats);
    END IF;
    RETURN jsonb_build_object('kind', 'UPGRADE', 'start', p_at, 'ends_licence_id', v_current.id);
  END IF;
  RETURN jsonb_build_object('kind', 'AT_RENEWAL', 'start', v_last.effective_end, 'additional_seats', coalesce(v_last.additional_seats, 0));
END;
$$;
REVOKE ALL ON FUNCTION public._commercial_licence_placement(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._commercial_licence_placement(UUID, UUID, TIMESTAMPTZ) TO service_role;

-- ── 2. The verified-payment commit: every BLOCKED_* placement is recorded for review, never placed ────────────────────
CREATE OR REPLACE FUNCTION public.commit_verified_commercial_payment(
  p_checkout_intent_id       UUID,
  p_provider                 TEXT,
  p_provider_transaction_id  TEXT,
  p_provider_status          TEXT,
  p_normalized_status        TEXT,
  p_amount_minor             BIGINT,
  p_currency_code            TEXT,
  p_payload_hash             TEXT,
  p_verified_at              TIMESTAMPTZ,
  p_verification_method      TEXT,
  p_idempotency_key          TEXT,
  p_saff_reference           TEXT,
  p_provider_environment     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_intent              RECORD;
  v_plan                RECORD;
  v_existing_evt        UUID;
  v_event_id            UUID;
  v_licence_id          UUID;
  v_place               JSONB;
  v_period_start        TIMESTAMPTZ;
  v_period_end          TIMESTAMPTZ;
  v_ended_licence       UUID;
  v_display_amt         NUMERIC;
  v_billing_customer_id UUID;
BEGIN
  IF p_provider_transaction_id IS NULL OR trim(p_provider_transaction_id) = '' THEN
    RAISE EXCEPTION 'Iron Dome: provider_transaction_id must not be blank for intent %', p_checkout_intent_id
      USING ERRCODE = '22023';
  END IF;
  -- Only a final provider outcome closes an intent. A pending or unknown status changes nothing.
  IF p_normalized_status IS NULL OR p_normalized_status NOT IN ('SUCCEEDED','FAILED','CANCELLED','EXPIRED') THEN
    RAISE EXCEPTION 'NON_FINAL_PAYMENT_STATUS' USING ERRCODE = '22023';
  END IF;

  SELECT billing_customer_id INTO v_billing_customer_id
    FROM public.payment_checkout_intents WHERE id = p_checkout_intent_id;
  IF v_billing_customer_id IS NULL THEN
    RAISE EXCEPTION 'Iron Dome: checkout_intent % not found', p_checkout_intent_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_billing_customer_id::text));

  SELECT id INTO v_existing_evt FROM public.payment_events WHERE idempotency_key = p_idempotency_key;
  IF v_existing_evt IS NOT NULL THEN
    RETURN jsonb_build_object('status','ALREADY_COMMITTED','event_id',v_existing_evt,'committed',false);
  END IF;

  SELECT * INTO v_intent FROM public.payment_checkout_intents WHERE id = p_checkout_intent_id FOR UPDATE;
  IF v_intent.status NOT IN ('PENDING','MANUAL_REVIEW') THEN
    RETURN jsonb_build_object('status','INTENT_ALREADY_RESOLVED','intent_status',v_intent.status,'committed',false);
  END IF;
  -- One payment per intent: a second, different provider transaction for an intent whose payment is already recorded
  -- is never applied (it is a support case, not a second licence).
  IF EXISTS (SELECT 1 FROM public.payment_events WHERE checkout_intent_id = p_checkout_intent_id AND event_type = 'PAYMENT_CONFIRMED') THEN
    RETURN jsonb_build_object('status','INTENT_ALREADY_PAID','committed',false);
  END IF;
  IF p_provider IS DISTINCT FROM v_intent.provider THEN
    RAISE EXCEPTION 'Iron Dome: provider mismatch for intent %', p_checkout_intent_id USING ERRCODE = '22023';
  END IF;
  IF p_amount_minor != v_intent.expected_amount_minor THEN
    RAISE EXCEPTION 'Iron Dome: amount mismatch. Expected % minor units, got % for intent %',
      v_intent.expected_amount_minor, p_amount_minor, p_checkout_intent_id;
  END IF;
  IF p_currency_code != v_intent.currency_code THEN
    RAISE EXCEPTION 'Iron Dome: currency mismatch. Expected %, got % for intent %',
      v_intent.currency_code, p_currency_code, p_checkout_intent_id;
  END IF;
  IF p_provider_environment IS NULL OR v_intent.provider_environment IS NULL
     OR p_provider_environment != v_intent.provider_environment THEN
    RAISE EXCEPTION 'Iron Dome: provider environment mismatch. Intent snapshotted %, verification ran under %, for intent %',
      v_intent.provider_environment, p_provider_environment, p_checkout_intent_id
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_plan FROM public.commercial_plans WHERE id = v_intent.plan_id;
  v_display_amt := p_amount_minor::NUMERIC / POWER(10, v_intent.currency_exponent);

  IF p_normalized_status != 'SUCCEEDED' THEN
    INSERT INTO public.payment_events (
      billing_customer_id, provider, external_event_id, idempotency_key, event_type,
      amount, currency, amount_minor, provider_transaction_id, provider_status,
      normalized_status, saff_reference, payload_hash, verified_at, verification_method,
      checkout_intent_id, commercial_offer_id, plan_id, event_time, metadata
    ) VALUES (
      v_intent.billing_customer_id, p_provider, p_provider_transaction_id, p_idempotency_key,
      CASE p_normalized_status WHEN 'CANCELLED' THEN 'CANCELLATION' ELSE 'PAYMENT_FAILED' END,
      v_display_amt, p_currency_code, p_amount_minor, p_provider_transaction_id,
      p_provider_status, p_normalized_status, p_saff_reference, p_payload_hash,
      p_verified_at, p_verification_method, p_checkout_intent_id,
      v_intent.commercial_offer_id, v_intent.plan_id, now(), jsonb_build_object('non_success',true)
    ) RETURNING id INTO v_event_id;

    UPDATE public.payment_checkout_intents
       SET status = CASE p_normalized_status WHEN 'CANCELLED' THEN 'CANCELLED' WHEN 'EXPIRED' THEN 'EXPIRED' ELSE 'FAILED' END,
           completed_at = now()
     WHERE id = p_checkout_intent_id;

    RETURN jsonb_build_object('status','NON_SUCCESS_RECORDED','event_id',v_event_id,'normalized',p_normalized_status,'committed',false);
  END IF;

  v_place := public._commercial_licence_placement(v_intent.billing_customer_id, v_intent.plan_id, now());

  IF left(coalesce(v_place->>'kind', ''), 8) = 'BLOCKED_' THEN
    -- Paid, verified, but the term cannot be placed by rule: record the payment exactly once, keep the intent in
    -- MANUAL_REVIEW (no new checkout can start for this product), and leave placement to a commercial administrator.
    INSERT INTO public.payment_events (
      billing_customer_id, licence_id, provider, external_event_id, idempotency_key,
      event_type, amount, currency, amount_minor, provider_transaction_id,
      provider_status, normalized_status, saff_reference, provider_reference,
      payload_hash, verified_at, verification_method, checkout_intent_id,
      commercial_offer_id, plan_id, provider_created_at, event_time, metadata
    ) VALUES (
      v_intent.billing_customer_id, NULL, p_provider, p_provider_transaction_id,
      p_idempotency_key, 'PAYMENT_CONFIRMED', v_display_amt, p_currency_code,
      p_amount_minor, p_provider_transaction_id, p_provider_status, p_normalized_status,
      p_saff_reference, p_saff_reference, p_payload_hash, p_verified_at,
      p_verification_method, p_checkout_intent_id, v_intent.commercial_offer_id,
      v_intent.plan_id, now(), now(),
      jsonb_build_object('placement','REVIEW_REQUIRED','placement_kind',v_place->>'kind')
    ) RETURNING id INTO v_event_id;

    UPDATE public.payment_checkout_intents
       SET status = 'MANUAL_REVIEW',
           metadata = metadata || jsonb_build_object('manual_review_reason','PAID_LICENCE_PLACEMENT_REQUIRED',
                                                     'placement_kind',v_place->>'kind','manual_review_at',now())
     WHERE id = p_checkout_intent_id;

    INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
    VALUES (v_intent.billing_customer_id, v_intent.created_by_user_id, 'PAYMENT_REQUIRES_LICENCE_PLACEMENT', NULL,
            jsonb_build_object('payment_event_id',v_event_id,'checkout_intent_id',p_checkout_intent_id,'plan_code',v_plan.code,
                               'placement_kind',v_place->>'kind','provider',p_provider,'amount_minor',p_amount_minor,'currency_code',p_currency_code),
            'Verified payment recorded; the licence term needs placement by a commercial administrator');

    RETURN jsonb_build_object('status','PLACEMENT_REVIEW_REQUIRED','committed',true,'event_id',v_event_id,'licence_id',NULL,
                              'placement',v_place->>'kind');
  END IF;

  v_period_start := (v_place->>'start')::timestamptz;
  v_period_end := CASE v_intent.billing_interval
    WHEN 'MONTHLY'  THEN v_period_start + (v_intent.billing_interval_count || ' months')::interval
    WHEN 'ONE_TIME' THEN v_period_start + interval '100 years'
    ELSE v_period_start + (v_intent.billing_interval_count * 12 || ' months')::interval
  END;

  IF v_place->>'kind' = 'UPGRADE' THEN
    v_ended_licence := (v_place->>'ends_licence_id')::uuid;
    UPDATE public.commercial_licences SET effective_end = v_period_start, updated_at = now() WHERE id = v_ended_licence;
  END IF;

  INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end)
  VALUES (v_intent.billing_customer_id, v_intent.plan_id, 'ACTIVE', p_provider || '_VERIFIED_PAYMENT', v_period_start, v_period_end)
  RETURNING id INTO v_licence_id;

  INSERT INTO public.payment_events (
    billing_customer_id, licence_id, provider, external_event_id, idempotency_key,
    event_type, amount, currency, amount_minor, provider_transaction_id,
    provider_status, normalized_status, saff_reference, provider_reference,
    payload_hash, verified_at, verification_method, checkout_intent_id,
    commercial_offer_id, plan_id, provider_created_at, event_time, metadata
  ) VALUES (
    v_intent.billing_customer_id, v_licence_id, p_provider, p_provider_transaction_id,
    p_idempotency_key, 'PAYMENT_CONFIRMED', v_display_amt, p_currency_code,
    p_amount_minor, p_provider_transaction_id, p_provider_status, p_normalized_status,
    p_saff_reference, p_saff_reference, p_payload_hash, p_verified_at,
    p_verification_method, p_checkout_intent_id, v_intent.commercial_offer_id,
    v_intent.plan_id, now(), now(),
    jsonb_build_object('licence_id',v_licence_id,'period_start',v_period_start,'period_end',v_period_end,'placement',v_place->>'kind')
  ) RETURNING id INTO v_event_id;

  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  VALUES (
    v_intent.billing_customer_id, v_intent.created_by_user_id, 'LICENCE_GRANTED',
    CASE WHEN v_ended_licence IS NOT NULL
      THEN jsonb_build_object('closed_prior_licence_id',v_ended_licence,'closed_effective_end',v_period_start) END,
    jsonb_build_object(
      'licence_id',v_licence_id,'plan_code',v_plan.code,'payment_event_id',v_event_id,
      'provider',p_provider,'amount_minor',p_amount_minor,'currency_code',p_currency_code,
      'market_code',v_intent.market_code,'period_start',v_period_start,'period_end',v_period_end,
      'placement',v_place->>'kind','verification_method',p_verification_method),
    'Verified payment commit');

  UPDATE public.payment_checkout_intents SET status='SUCCEEDED', completed_at=now() WHERE id=p_checkout_intent_id;

  RETURN jsonb_build_object('status','COMMITTED','committed',true,'event_id',v_event_id,'licence_id',v_licence_id,
    'period_start',v_period_start,'period_end',v_period_end,'placement',v_place->>'kind');
END;
$$;
REVOKE ALL ON FUNCTION public.commit_verified_commercial_payment(UUID,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_verified_commercial_payment(UUID,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT) TO service_role;

-- ── 3. A manual grant and a verified payment for the same account are serialised ─────────────────────────────────────
-- Unchanged from 20261029100000 except the account lock taken before any read.
CREATE OR REPLACE FUNCTION public.admin_grant_commercial_licence(
  p_billing_customer_id UUID,
  p_plan_code           TEXT,
  p_effective_start     TIMESTAMPTZ,
  p_effective_end       TIMESTAMPTZ,
  p_reason              TEXT
) RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id    UUID := auth.uid();
  v_product_id UUID;
  v_plan_id    UUID;
  v_licence_id UUID;
  v_prior      RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_user_id AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_effective_start IS NULL THEN
    RAISE EXCEPTION 'EFFECTIVE_START_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_effective_end IS NOT NULL AND p_effective_end <= p_effective_start THEN
    RAISE EXCEPTION 'EFFECTIVE_END_MUST_BE_AFTER_START' USING ERRCODE = '22023';
  END IF;

  -- One account at a time: the SAME lock commit_verified_commercial_payment takes (hashtext of the billing customer id), so a
  -- grant and a verified payment for one account never interleave. Without it, a grant could pass the paid-term check
  -- below while a payment for the same account was being placed, and that payment's commit would then fail on the
  -- no-overlap constraint instead of being recorded (proved by paidTermPreservation.mjs, "simultaneous").
  PERFORM pg_advisory_xact_lock(hashtext(p_billing_customer_id::text));

  SELECT product_id INTO v_product_id FROM public.billing_customers WHERE id = p_billing_customer_id;
  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'BILLING_CUSTOMER_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  SELECT id INTO v_plan_id FROM public.commercial_plans WHERE product_id = v_product_id AND code = p_plan_code AND is_active;
  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_OR_INACTIVE_PLAN_CODE: %', p_plan_code USING ERRCODE = '22023';
  END IF;

  -- A payment-created term is never shortened or replaced by a manual grant: choose a start on or after its end.
  IF EXISTS (SELECT 1 FROM public.commercial_licences
              WHERE billing_customer_id = p_billing_customer_id AND status IN ('ACTIVE','GRACE')
                AND source LIKE '%\_VERIFIED\_PAYMENT' ESCAPE '\'
                AND effective_range && tstzrange(p_effective_start, p_effective_end, '[)')) THEN
    RAISE EXCEPTION 'PAID_TERM_WOULD_BE_SHORTENED' USING ERRCODE = '22023';
  END IF;

  SELECT id, effective_start, effective_end INTO v_prior
    FROM public.commercial_licences
   WHERE billing_customer_id = p_billing_customer_id
     AND status IN ('ACTIVE','GRACE')
     AND effective_range && tstzrange(p_effective_start, p_effective_end, '[)')
   LIMIT 1;
  IF FOUND THEN
    IF p_effective_start <= v_prior.effective_start THEN
      RAISE EXCEPTION 'NEW_EFFECTIVE_START_MUST_BE_AFTER_EXISTING_PERIOD_START (existing licence %, starts %)',
        v_prior.id, v_prior.effective_start USING ERRCODE = '22023';
    END IF;
    UPDATE public.commercial_licences SET effective_end = p_effective_start, updated_at = now() WHERE id = v_prior.id;
  END IF;

  INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end)
  VALUES (p_billing_customer_id, v_plan_id, 'ACTIVE', 'MANUAL_ADMIN_GRANT', p_effective_start, p_effective_end)
  RETURNING id INTO v_licence_id;

  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  VALUES (
    p_billing_customer_id, v_user_id, 'LICENCE_GRANTED',
    CASE WHEN v_prior.id IS NOT NULL
      THEN jsonb_build_object('closed_prior_licence_id', v_prior.id, 'closed_effective_end', p_effective_start) END,
    jsonb_build_object('licence_id', v_licence_id, 'plan_code', p_plan_code,
                       'effective_start', p_effective_start, 'effective_end', p_effective_end),
    p_reason);

  RETURN jsonb_build_object('licence_id', v_licence_id, 'plan_code', p_plan_code, 'closed_prior_licence_id', v_prior.id);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_grant_commercial_licence(UUID,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_grant_commercial_licence(UUID,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT) TO authenticated;
