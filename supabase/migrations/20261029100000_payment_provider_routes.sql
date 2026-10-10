-- 20261029100000_payment_provider_routes.sql
--
-- Online payment through two provider routes, on the existing provider-neutral checkout authority. No parallel billing
-- authority: checkout intents, the verified-payment commit, payment events, webhook receipts and the platform-state
-- matrix stay the only path from a payment to a licence. This migration:
--
--   0. refuses to apply unless commercial_platform_state is PAYMENTS_DISABLED (nothing in flight can change meaning), and
--      refuses a second application;
--   1. admits SNIPPE (Tanzania mobile money, TZS) and POLAR (merchant of record, cards) as provider identifiers on
--      commercial_offers.provider_restriction and payment_checkout_intents.provider;
--   2. widens the webhook processing vocabulary (duplicate, stale timestamp, merchant / account mismatch, non-final,
--      ignored event type, reversal recorded, placement review) so every delivery leaves one exact outcome row;
--   3. _commercial_licence_placement — the ONE rule for where a paid 12-month term goes: a new account starts now; the
--      same plan renews after the current term; a larger plan (more entities) upgrades now and ends the current term; a
--      smaller or equal plan starts when the current term ends (downgrade at renewal — the registered prerequisite
--      COMMERCIAL_DOWNGRADE_AT_RENEWAL_REQUIRED_BEFORE_CHECKOUT); an open-ended licence, or an upgrade over a queued
--      term, is never placed automatically;
--   4. commit_verified_commercial_payment (same 13 arguments) uses that rule; accepts only final provider outcomes
--      (SUCCEEDED, FAILED, CANCELLED, EXPIRED — EXPIRED now closes the intent as EXPIRED, not FAILED); and when a verified
--      payment cannot be placed automatically it records the payment, keeps the intent in MANUAL_REVIEW and never
--      charges again — the paid term is placed by admin_place_paid_licence;
--   5. admin_place_paid_licence — places a recorded, unplaced paid term (commercial administrators; audited);
--      admin_resolve_manual_review_intent refuses to cancel or fail an intent whose payment is recorded;
--   6. admin_grant_commercial_licence (manual activation, unchanged otherwise) never shortens a payment-created term;
--   7. claim_verification_attempt accepts an active commercial administrator named by the Edge Function (the
--      service-role client has no auth.uid());
--   8. ensure_checkout_billing_customer — a signed-in user without a workspace gets a billing record at checkout;
--   9. reads: get_checkout_status gains the purchased plan, payment reference and reversal state; get_my_payments (the
--      customer's own orders); admin_list_payment_attention and admin_find_billing_account (commercial administrators).
--
-- Not done here: no offer becomes purchasable, no price changes, commercial_platform_state is not touched, no
-- provider is configured. Forward-only; no applied migration is modified.

SET search_path TO public, pg_catalog;

-- ── 0. Preflight ────────────────────────────────────────────────────────────────────────────────────────────────────
DO $preflight$
BEGIN
  IF (SELECT state FROM public.commercial_platform_state WHERE id = true) IS DISTINCT FROM 'PAYMENTS_DISABLED' THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: payments must be disabled (commercial_platform_state = PAYMENTS_DISABLED); nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure('public._commercial_licence_placement(uuid,uuid,timestamp with time zone)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the payment provider routes are already in force; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. Provider identifiers ─────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.commercial_offers DROP CONSTRAINT IF EXISTS chk_co_provider_restriction;
ALTER TABLE public.commercial_offers ADD CONSTRAINT chk_co_provider_restriction CHECK (
  provider_restriction IS NULL OR provider_restriction IN ('FLUTTERWAVE','PESAPAL','SELCOM','DPO','STRIPE','SNIPPE','POLAR'));

ALTER TABLE public.payment_checkout_intents DROP CONSTRAINT IF EXISTS chk_pci_provider;
ALTER TABLE public.payment_checkout_intents ADD CONSTRAINT chk_pci_provider CHECK (
  provider IN ('FLUTTERWAVE','PESAPAL','SELCOM','DPO','STRIPE','SNIPPE','POLAR'));

-- ── 2. Webhook processing outcomes ──────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.payment_webhook_processing_events DROP CONSTRAINT IF EXISTS chk_pwpe_result;
ALTER TABLE public.payment_webhook_processing_events ADD CONSTRAINT chk_pwpe_result CHECK (processing_result IN (
  'PROCESSED','INVALID_SIGNATURE','REPLAY','VERIFICATION_FAILED','AMOUNT_MISMATCH','CURRENCY_MISMATCH',
  'REFERENCE_MISMATCH','REFERENCE_MISSING','UNKNOWN_PROVIDER_STATUS','ERROR',
  'DUPLICATE','STALE_TIMESTAMP','MERCHANT_MISMATCH','ACCOUNT_MISMATCH','NOT_FINAL','IGNORED_EVENT_TYPE',
  'REVERSAL_RECORDED','PLACEMENT_REVIEW'));

-- ── 3. Where a paid term goes ───────────────────────────────────────────────────────────────────────────────────────
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

  SELECT l.id, l.plan_id, l.effective_end, cp.entity_capacity INTO v_current
    FROM public.commercial_licences l JOIN public.commercial_plans cp ON cp.id = l.plan_id
   WHERE l.billing_customer_id = p_billing_customer_id AND l.status IN ('ACTIVE','GRACE')
     AND l.effective_start <= p_at AND l.effective_end > p_at
   ORDER BY l.effective_end DESC LIMIT 1;
  SELECT l.id, l.plan_id, l.effective_end, cp.entity_capacity INTO v_last
    FROM public.commercial_licences l JOIN public.commercial_plans cp ON cp.id = l.plan_id
   WHERE l.billing_customer_id = p_billing_customer_id AND l.status IN ('ACTIVE','GRACE') AND l.effective_end > p_at
   ORDER BY l.effective_end DESC LIMIT 1;
  SELECT count(*) INTO v_queued FROM public.commercial_licences
   WHERE billing_customer_id = p_billing_customer_id AND status IN ('ACTIVE','GRACE') AND effective_start > p_at;
  SELECT entity_capacity INTO v_new_cap FROM public.commercial_plans WHERE id = p_plan_id;

  IF v_last.id IS NULL THEN
    RETURN jsonb_build_object('kind', 'NEW', 'start', p_at);
  END IF;
  IF v_last.plan_id = p_plan_id THEN
    RETURN jsonb_build_object('kind', 'RENEWAL', 'start', v_last.effective_end);
  END IF;
  IF coalesce(v_new_cap, 0) > coalesce(v_last.entity_capacity, 0) THEN
    IF v_queued > 0 OR v_current.id IS NULL THEN
      RETURN jsonb_build_object('kind', 'BLOCKED_QUEUED');
    END IF;
    RETURN jsonb_build_object('kind', 'UPGRADE', 'start', p_at, 'ends_licence_id', v_current.id);
  END IF;
  RETURN jsonb_build_object('kind', 'AT_RENEWAL', 'start', v_last.effective_end);
END;
$$;
REVOKE ALL ON FUNCTION public._commercial_licence_placement(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._commercial_licence_placement(UUID, UUID, TIMESTAMPTZ) TO service_role;

-- ── 4. The verified-payment commit ──────────────────────────────────────────────────────────────────────────────────
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

  IF v_place->>'kind' IN ('BLOCKED_OPEN_ENDED','BLOCKED_QUEUED') THEN
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

-- ── 5. Placing a recorded paid term; manual review cannot discard a payment ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_place_paid_licence(p_checkout_intent_id UUID, p_effective_start TIMESTAMPTZ, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog AS $$
DECLARE
  v_actor   UUID := auth.uid();
  v_intent  RECORD;
  v_event   RECORD;
  v_plan    RECORD;
  v_licence UUID;
  v_end     TIMESTAMPTZ;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_actor AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_effective_start IS NULL THEN RAISE EXCEPTION 'EFFECTIVE_START_REQUIRED' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_intent FROM public.payment_checkout_intents WHERE id = p_checkout_intent_id FOR UPDATE;
  IF NOT FOUND OR v_intent.status <> 'MANUAL_REVIEW' THEN
    RAISE EXCEPTION 'INTENT_NOT_IN_MANUAL_REVIEW' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_event FROM public.payment_events
   WHERE checkout_intent_id = p_checkout_intent_id AND event_type = 'PAYMENT_CONFIRMED' AND licence_id IS NULL
   ORDER BY event_time DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_UNPLACED_PAYMENT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_plan FROM public.commercial_plans WHERE id = v_intent.plan_id;

  v_end := p_effective_start + (v_intent.billing_interval_count * 12 || ' months')::interval;
  BEGIN
    INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end)
    VALUES (v_intent.billing_customer_id, v_intent.plan_id, 'ACTIVE', v_intent.provider || '_VERIFIED_PAYMENT', p_effective_start, v_end)
    RETURNING id INTO v_licence;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'TERM_OVERLAPS_EXISTING_LICENCE' USING ERRCODE = '22023';
  END;

  UPDATE public.payment_checkout_intents
     SET status = 'SUCCEEDED', completed_at = now(),
         metadata = metadata || jsonb_build_object('placed_licence_id', v_licence, 'placed_by', v_actor)
   WHERE id = p_checkout_intent_id;

  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  VALUES (v_intent.billing_customer_id, v_actor, 'PAID_LICENCE_PLACED', jsonb_build_object('status','MANUAL_REVIEW'),
          jsonb_build_object('licence_id',v_licence,'payment_event_id',v_event.id,'checkout_intent_id',p_checkout_intent_id,
                             'plan_code',v_plan.code,'effective_start',p_effective_start,'effective_end',v_end),
          p_reason);
  RETURN jsonb_build_object('placed', true, 'licence_id', v_licence, 'effective_start', p_effective_start, 'effective_end', v_end);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_place_paid_licence(UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_place_paid_licence(UUID, TIMESTAMPTZ, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_resolve_manual_review_intent(
  p_checkout_intent_id UUID,
  p_resolution         TEXT,
  p_reason             TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_new_status TEXT;
  v_updated RECORD;
BEGIN
  IF v_user_id IS NULL OR NOT public.is_commercial_admin() THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_resolution = 'CONFIRMED_UNCHARGED_CANCEL' THEN
    v_new_status := 'CANCELLED';
  ELSIF p_resolution = 'CONFIRMED_FAILED' THEN
    v_new_status := 'FAILED';
  ELSE
    RAISE EXCEPTION 'UNKNOWN_RESOLUTION: %', p_resolution USING ERRCODE = '22023';
  END IF;
  -- A recorded payment is never discarded by a review decision: it is placed (admin_place_paid_licence) or refunded
  -- at the provider.
  IF EXISTS (SELECT 1 FROM public.payment_events WHERE checkout_intent_id = p_checkout_intent_id AND event_type = 'PAYMENT_CONFIRMED') THEN
    RAISE EXCEPTION 'PAYMENT_RECORDED_FOR_INTENT' USING ERRCODE = '22023';
  END IF;

  UPDATE public.payment_checkout_intents
     SET status = v_new_status, completed_at = now(),
         metadata = metadata || jsonb_build_object('manual_review_resolution', p_resolution, 'manual_review_reason', p_reason, 'resolved_by', v_user_id)
   WHERE id = p_checkout_intent_id
     AND status = 'MANUAL_REVIEW'
  RETURNING id INTO v_updated;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_IN_MANUAL_REVIEW: %', p_checkout_intent_id USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  SELECT billing_customer_id, v_user_id, 'MANUAL_REVIEW_RESOLVED',
         jsonb_build_object('status', 'MANUAL_REVIEW'), jsonb_build_object('status', v_new_status, 'resolution', p_resolution),
         p_reason
    FROM public.payment_checkout_intents WHERE id = p_checkout_intent_id;

  RETURN jsonb_build_object('resolved', true, 'status', v_new_status);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_resolve_manual_review_intent(UUID,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_manual_review_intent(UUID,TEXT,TEXT) TO authenticated;

-- ── 6. Manual activation never shortens a paid term ─────────────────────────────────────────────────────────────────
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

-- ── 7. Recovery verification: the owner, or an active commercial administrator named by the Edge Function ──────────
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
  IF NOT FOUND OR (v_intent.owner_user_id != p_requesting_user_id
                   AND NOT EXISTS (SELECT 1 FROM public.commercial_admins a WHERE a.user_id = p_requesting_user_id AND a.active)) THEN
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
    'currency_code',v_intent.currency_code,'provider_checkout_ref',v_intent.provider_checkout_ref,
    'billing_customer_id',v_intent.billing_customer_id,'status',v_intent.status);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_verification_attempt(UUID,UUID,INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_verification_attempt(UUID,UUID,INTEGER) TO service_role;

-- ── 8. A billing record for a signed-in user at checkout ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ensure_checkout_billing_customer(p_user_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog AS $$
DECLARE v_bc UUID; v_product UUID;
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  SELECT id INTO v_bc FROM public.billing_customers WHERE owner_user_id = p_user_id;
  IF v_bc IS NOT NULL THEN RETURN v_bc; END IF;
  SELECT id INTO v_product FROM public.commercial_products WHERE code = 'CFOCLOSE';
  INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES (p_user_id, v_product)
  ON CONFLICT (owner_user_id) DO NOTHING RETURNING id INTO v_bc;
  IF v_bc IS NULL THEN
    SELECT id INTO v_bc FROM public.billing_customers WHERE owner_user_id = p_user_id;
  ELSE
    INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
    VALUES (v_bc, p_user_id, 'BILLING_CUSTOMER_CREATED', NULL, jsonb_build_object('owner_user_id', p_user_id), 'Checkout');
  END IF;
  RETURN v_bc;
END;
$$;
REVOKE ALL ON FUNCTION public.ensure_checkout_billing_customer(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_checkout_billing_customer(UUID) TO service_role;

-- ── 9. Reads ────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_checkout_status(p_saff_reference TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_intent    RECORD;
  v_current   RECORD;
  v_purchased RECORD;
  v_paid      RECORD;
  v_reversal  RECORD;
  v_plan_code TEXT;
BEGIN
  SELECT ci.* INTO v_intent
    FROM public.payment_checkout_intents ci
    JOIN public.billing_customers bc ON bc.id = ci.billing_customer_id
   WHERE ci.saff_reference = p_saff_reference
     AND (bc.owner_user_id = auth.uid() OR public.is_commercial_admin());
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false, 'status', 'UNKNOWN');
  END IF;

  SELECT cl.status AS licence_status, cp.code AS plan_code, cl.effective_start, cl.effective_end INTO v_current
    FROM public.commercial_licences cl JOIN public.commercial_plans cp ON cp.id = cl.plan_id
   WHERE cl.billing_customer_id = v_intent.billing_customer_id AND cl.status IN ('ACTIVE', 'GRACE')
     AND cl.effective_start <= now() AND (cl.effective_end IS NULL OR cl.effective_end > now())
   ORDER BY cl.effective_end DESC NULLS LAST LIMIT 1;

  SELECT pe.id, pe.provider_transaction_id, pe.verified_at, pe.licence_id INTO v_paid
    FROM public.payment_events pe
   WHERE pe.checkout_intent_id = v_intent.id AND pe.event_type = 'PAYMENT_CONFIRMED'
   ORDER BY pe.event_time DESC LIMIT 1;

  -- Bind the purchased period to this exact checkout intent: the payment's own licence, or the one an administrator
  -- placed for it. Never inferred from "latest licence".
  SELECT cl.id AS licence_id, cl.status AS licence_status, cl.effective_start, cl.effective_end INTO v_purchased
    FROM public.commercial_licences cl
   WHERE cl.id = COALESCE(v_paid.licence_id, NULLIF(v_intent.metadata->>'placed_licence_id', '')::uuid);

  SELECT pe.event_type, pe.event_time INTO v_reversal
    FROM public.payment_events pe
   WHERE pe.event_type IN ('REFUND','CHARGEBACK') AND (pe.metadata->>'original_event_id') = v_paid.id::text
   ORDER BY pe.event_time DESC LIMIT 1;

  SELECT code INTO v_plan_code FROM public.commercial_plans WHERE id = v_intent.plan_id;

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
    'currency_exponent', v_intent.currency_exponent,
    'billing_interval', v_intent.billing_interval,
    'billing_interval_count', v_intent.billing_interval_count,
    'licence_status', v_current.licence_status,
    'plan_code', COALESCE(v_plan_code, v_current.plan_code),
    'purchased_plan_code', v_plan_code,
    'effective_start', v_current.effective_start,
    'effective_end', v_current.effective_end,
    'purchased_licence_id', v_purchased.licence_id,
    'purchased_licence_status', v_purchased.licence_status,
    'purchased_effective_start', v_purchased.effective_start,
    'purchased_effective_end', v_purchased.effective_end,
    'payment_recorded', v_paid.id IS NOT NULL,
    'payment_reference', v_paid.provider_transaction_id,
    'paid_at', v_paid.verified_at,
    'reversal_type', v_reversal.event_type,
    'reversal_at', v_reversal.event_time,
    'review_reason', CASE WHEN v_intent.status = 'MANUAL_REVIEW'
                          THEN CASE WHEN v_paid.id IS NOT NULL THEN 'PAID_LICENCE_PLACEMENT_REQUIRED' ELSE 'OUTCOME_UNCERTAIN' END END
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_checkout_status(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_checkout_status(TEXT) TO authenticated;

-- The signed-in customer's own orders, newest first.
CREATE OR REPLACE FUNCTION public.get_my_payments()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(row ORDER BY created_at DESC), '[]'::jsonb) FROM (
    SELECT ci.created_at,
           jsonb_build_object(
             'saff_reference', ci.saff_reference, 'status', ci.status, 'provider', ci.provider,
             'plan_code', cp.code, 'plan_name', cp.name,
             'amount_minor', ci.expected_amount_minor, 'currency_code', ci.currency_code, 'currency_exponent', ci.currency_exponent,
             'billing_interval', ci.billing_interval, 'created_at', ci.created_at, 'completed_at', ci.completed_at,
             'payment_reference', pe.provider_transaction_id, 'paid_at', pe.verified_at,
             'licence_start', cl.effective_start, 'licence_end', cl.effective_end,
             'reversal_type', rv.event_type) AS row
      FROM public.payment_checkout_intents ci
      JOIN public.billing_customers bc ON bc.id = ci.billing_customer_id AND bc.owner_user_id = auth.uid()
      JOIN public.commercial_plans cp ON cp.id = ci.plan_id
      LEFT JOIN LATERAL (SELECT e.id, e.provider_transaction_id, e.verified_at, e.licence_id FROM public.payment_events e
                          WHERE e.checkout_intent_id = ci.id AND e.event_type = 'PAYMENT_CONFIRMED' ORDER BY e.event_time DESC LIMIT 1) pe ON true
      LEFT JOIN public.commercial_licences cl ON cl.id = COALESCE(pe.licence_id, NULLIF(ci.metadata->>'placed_licence_id', '')::uuid)
      LEFT JOIN LATERAL (SELECT r.event_type FROM public.payment_events r
                          WHERE r.event_type IN ('REFUND','CHARGEBACK') AND r.metadata->>'original_event_id' = pe.id::text
                          ORDER BY r.event_time DESC LIMIT 1) rv ON true
     ORDER BY ci.created_at DESC
     LIMIT 25
  ) s;
$$;
REVOKE ALL ON FUNCTION public.get_my_payments() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_payments() TO authenticated;

-- What needs a commercial administrator: intents in review, payments still pending after their checkout expired, and
-- recorded refunds / chargebacks (their licence action is a review decision).
CREATE OR REPLACE FUNCTION public.admin_list_payment_attention()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'intents', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'intent_id', ci.id, 'saff_reference', ci.saff_reference, 'status', ci.status, 'provider', ci.provider,
        'provider_environment', ci.provider_environment, 'plan_code', cp.code,
        'amount_minor', ci.expected_amount_minor, 'currency_code', ci.currency_code, 'currency_exponent', ci.currency_exponent,
        'created_at', ci.created_at, 'expires_at', ci.expires_at, 'billing_customer_id', ci.billing_customer_id,
        'owner_email', u.email,
        'reason', COALESCE(ci.metadata->>'manual_review_reason', ci.metadata->>'uncertain_reason',
                           CASE WHEN ci.status = 'PENDING' THEN 'PENDING_AFTER_EXPIRY' END),
        'payment_recorded', EXISTS (SELECT 1 FROM public.payment_events e WHERE e.checkout_intent_id = ci.id AND e.event_type = 'PAYMENT_CONFIRMED'))
        ORDER BY ci.created_at)
      FROM public.payment_checkout_intents ci
      JOIN public.commercial_plans cp ON cp.id = ci.plan_id
      JOIN public.billing_customers bc ON bc.id = ci.billing_customer_id
      LEFT JOIN auth.users u ON u.id = bc.owner_user_id
     WHERE ci.status = 'MANUAL_REVIEW' OR (ci.status = 'PENDING' AND ci.expires_at < now())), '[]'::jsonb),
    'reversals', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'event_id', r.id, 'reversal_type', r.event_type, 'provider', r.provider, 'amount_minor', r.amount_minor,
        'currency_code', r.currency, 'event_time', r.event_time, 'saff_reference', r.saff_reference,
        'licence_id', r.licence_id, 'billing_customer_id', r.billing_customer_id, 'owner_email', u.email)
        ORDER BY r.event_time DESC)
      FROM public.payment_events r
      JOIN public.billing_customers bc ON bc.id = r.billing_customer_id
      LEFT JOIN auth.users u ON u.id = bc.owner_user_id
     WHERE r.event_type IN ('REFUND','CHARGEBACK')
       AND NOT EXISTS (SELECT 1 FROM public.billing_audit_events a
                        WHERE a.action = 'REVERSAL_REVIEWED' AND a.new_state->>'reversal_event_id' = r.id::text)), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_payment_attention() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_payment_attention() TO authenticated;

-- Records the administrator's decision on a refund / chargeback (the licence change itself goes through
-- admin_transition_licence_status or admin_cancel_future_licence). One decision per reversal.
CREATE OR REPLACE FUNCTION public.admin_record_reversal_review(p_reversal_event_id UUID, p_decision TEXT, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog AS $$
DECLARE v_actor UUID := auth.uid(); v_ev RECORD; v_audit UUID;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_actor AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('LICENCE_ENDED','LICENCE_KEPT') THEN
    RAISE EXCEPTION 'UNKNOWN_DECISION' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_ev FROM public.payment_events WHERE id = p_reversal_event_id AND event_type IN ('REFUND','CHARGEBACK');
  IF NOT FOUND THEN RAISE EXCEPTION 'REVERSAL_NOT_FOUND' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('reversal-review:' || p_reversal_event_id::text));
  IF EXISTS (SELECT 1 FROM public.billing_audit_events a WHERE a.action = 'REVERSAL_REVIEWED' AND a.new_state->>'reversal_event_id' = p_reversal_event_id::text) THEN
    RAISE EXCEPTION 'REVERSAL_ALREADY_REVIEWED' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  VALUES (v_ev.billing_customer_id, v_actor, 'REVERSAL_REVIEWED', NULL,
          jsonb_build_object('reversal_event_id', p_reversal_event_id, 'decision', p_decision, 'licence_id', v_ev.licence_id), p_reason)
  RETURNING id INTO v_audit;
  RETURN jsonb_build_object('recorded', true, 'audit_event_id', v_audit);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_record_reversal_review(UUID, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_record_reversal_review(UUID, TEXT, TEXT) TO authenticated;

-- Finds an account by its sign-in email (exact, case-insensitive), for manual activation.
CREATE OR REPLACE FUNCTION public.admin_find_billing_account(p_email TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE v_user RECORD; v_bc UUID;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_email IS NULL OR position('@' IN p_email) < 2 THEN RAISE EXCEPTION 'EMAIL_REQUIRED' USING ERRCODE = '22023'; END IF;
  SELECT id, email, created_at INTO v_user FROM auth.users WHERE lower(email) = lower(trim(p_email));
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  SELECT id INTO v_bc FROM public.billing_customers WHERE owner_user_id = v_user.id;
  RETURN jsonb_build_object('found', true, 'owner_user_id', v_user.id, 'email', v_user.email, 'signed_up_at', v_user.created_at,
    'billing_customer_id', v_bc,
    'companies', (SELECT count(*) FROM public.companies c WHERE c.user_id = v_user.id),
    'licences', COALESCE((SELECT jsonb_agg(jsonb_build_object('licence_id', l.id, 'plan_code', cp.code, 'status', l.status,
                     'source', l.source, 'effective_start', l.effective_start, 'effective_end', l.effective_end,
                     'additional_seats', l.additional_seats) ORDER BY l.effective_start DESC)
                   FROM public.commercial_licences l JOIN public.commercial_plans cp ON cp.id = l.plan_id
                  WHERE l.billing_customer_id = v_bc), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_find_billing_account(TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_find_billing_account(TEXT) TO authenticated;
