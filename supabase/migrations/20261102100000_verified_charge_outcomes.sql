-- 20261102100000_verified_charge_outcomes.sql
--
-- DEFECT-VERIFIED-CHARGE-DROPPED-001 (batch commercial-p5). Forward-only; nothing earlier is edited.
--
-- Reproduced on real PostgreSQL before this change (scripts/db-proof/verifiedChargeOutcomes.mjs, "before" group, and the
-- CI payment journey through the real Edge Functions with a mock Polar):
--   neither provider can cancel or expire a checkout on request (Polar: PATCH /v1/checkouts/{id} has no expiry, status or
--   cancel field and the session expires on Polar's own expires_at; Snippe documents no cancel endpoint). So an older
--   session can still be paid after CFOClose closed its intent (an administrator resolved the review as uncharged, or a
--   replacement attempt was started). commit_verified_commercial_payment then returned INTENT_ALREADY_RESOLVED — or, for a
--   second different transaction on a paid intent, INTENT_ALREADY_PAID — and RECORDED NOTHING; settle.ts reported it as a
--   DUPLICATE. A verified charge had no payment event, no licence and no audit row.
--
-- After this migration every verified successful charge has exactly one explicit outcome:
--   1. the intent's own payment (unchanged): the term is placed, or the payment waits for placement review;
--   2. a LATE payment on an intent CFOClose closed (no provider outcome was ever recorded for it), when nothing replaced it
--      (no newer attempt for the same account and product): placed by the normal rule, the intent becomes SUCCEEDED,
--      audited as late;
--   3. a payment after a replacement was started, a second different transaction on an already-paid intent, or a success
--      that contradicts a non-success the PROVIDER itself reported for the intent: the money is
--      recorded ONCE (payment event, placement RECOVERY_REQUIRED) with an OPEN payment_recovery_cases row and an audit
--      row; a commercial administrator resolves it — PLACE_ADDITIONAL_TERM (only with the customer's recorded agreement to
--      receive another term, and only where the current placement rule allows it), REFUNDED (only once refunds recorded
--      against that payment cover it in full), or TEST_PAYMENT_CLOSED (a sandbox payment, which moved no money). An
--      unintended second charge is refunded; it never silently becomes a renewal.
-- The same provider transaction is never recorded twice, whatever the key; a commit and a replacement attempt for the
-- same account and product are serialised under the acquisition lock. Payment history and existing terms are untouched.

DO $preflight$
BEGIN
  IF to_regprocedure('public._record_payment_reversal_core(uuid,text,text,text,bigint,text,text,text,text,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: payment reversal authority (20261101100000, commercial-p4) must be applied first' USING ERRCODE = 'P0001';
  END IF;
  IF to_regclass('public.payment_recovery_cases') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: verified charge outcomes (20261102100000) is already in force' USING ERRCODE = 'P0001';
  END IF;
END
$preflight$;

-- ── 1. The recovery case: one per verified charge that is not the intent's own placed payment ──────────────────────
CREATE TABLE public.payment_recovery_cases (
  id                      UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  payment_event_id        UUID        NOT NULL UNIQUE REFERENCES public.payment_events(id),
  checkout_intent_id      UUID        NOT NULL REFERENCES public.payment_checkout_intents(id),
  billing_customer_id     UUID        NOT NULL REFERENCES public.billing_customers(id),
  provider                TEXT        NOT NULL,
  provider_environment    TEXT        NOT NULL CHECK (provider_environment IN ('sandbox','production')),
  provider_transaction_id TEXT        NOT NULL,
  amount_minor            BIGINT      NOT NULL CHECK (amount_minor > 0),
  currency_code           TEXT        NOT NULL,
  plan_id                 UUID        NOT NULL REFERENCES public.commercial_plans(id),
  reason                  TEXT        NOT NULL CHECK (reason IN ('PAYMENT_AFTER_REPLACEMENT_STARTED','ADDITIONAL_PAYMENT_ON_PAID_INTENT','PAYMENT_AFTER_PROVIDER_REPORTED_NON_SUCCESS')),
  newer_attempt_id        UUID        NULL REFERENCES public.payment_checkout_intents(id),
  status                  TEXT        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','TERM_PLACED','REFUNDED','TEST_PAYMENT_CLOSED')),
  licence_id              UUID        NULL REFERENCES public.commercial_licences(id),
  resolved_by             UUID        NULL REFERENCES auth.users(id),
  resolved_at             TIMESTAMPTZ NULL,
  resolution_reason       TEXT        NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_prc_provider_tx UNIQUE (provider, provider_transaction_id),
  CONSTRAINT chk_prc_resolution CHECK ((status = 'OPEN') = (resolved_at IS NULL) AND (status = 'TERM_PLACED') = (licence_id IS NOT NULL))
);
ALTER TABLE public.payment_recovery_cases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_recovery_cases FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.payment_recovery_cases IS
  'One row per verified charge that is not an intent''s own placed payment (a payment after a replacement started, or a second '
  'transaction on a paid intent). OPEN until a commercial administrator places it as an additional term or records it refunded '
  '(20261102100000). Never deleted; resolved once.';

-- Resolved once, never deleted: only OPEN -> resolved, and only the resolution columns change.
CREATE OR REPLACE FUNCTION public.payment_recovery_cases_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'RECOVERY_CASE_IS_PERMANENT' USING ERRCODE = '42501'; END IF;
  IF OLD.status <> 'OPEN' THEN RAISE EXCEPTION 'RECOVERY_CASE_ALREADY_RESOLVED' USING ERRCODE = '42501'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status','licence_id','resolved_by','resolved_at','resolution_reason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','licence_id','resolved_by','resolved_at','resolution_reason']) THEN
    RAISE EXCEPTION 'RECOVERY_CASE_FACTS_ARE_FIXED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.payment_recovery_cases_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_payment_recovery_cases_guard BEFORE UPDATE OR DELETE ON public.payment_recovery_cases
  FOR EACH ROW EXECUTE FUNCTION public.payment_recovery_cases_guard();

-- ── 2. The commit: a verified charge is never dropped ───────────────────────────────────────────────────────────────
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
  v_paid_already        BOOLEAN;
  v_newer_attempt       UUID;
  v_existing_tx         UUID;
  v_case_id             UUID;
  v_late                BOOLEAN := false;
  v_provider_outcome    BOOLEAN;
  v_reason              TEXT;
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
  -- ...and the checkout-acquisition lock of the intent's account and product, so a commit and a replacement attempt for
  -- the same purchase are decided one after the other, never interleaved (acquire_checkout_attempt takes only this lock).
  PERFORM pg_advisory_xact_lock(hashtext(v_billing_customer_id::text || ':' ||
    (SELECT product_id::text FROM public.payment_checkout_intents WHERE id = p_checkout_intent_id)));

  SELECT id INTO v_existing_evt FROM public.payment_events WHERE idempotency_key = p_idempotency_key;
  IF v_existing_evt IS NOT NULL THEN
    RETURN jsonb_build_object('status','ALREADY_COMMITTED','event_id',v_existing_evt,'committed',false);
  END IF;

  SELECT * INTO v_intent FROM public.payment_checkout_intents WHERE id = p_checkout_intent_id FOR UPDATE;
  v_paid_already := EXISTS (SELECT 1 FROM public.payment_events WHERE checkout_intent_id = p_checkout_intent_id AND event_type = 'PAYMENT_CONFIRMED');
  IF v_intent.status NOT IN ('PENDING','MANUAL_REVIEW') OR v_paid_already THEN
    -- A non-success outcome for an intent that is already closed or paid changes nothing: no money moved.
    IF p_normalized_status <> 'SUCCEEDED' THEN
      RETURN jsonb_build_object('status','INTENT_ALREADY_RESOLVED','intent_status',v_intent.status,'committed',false);
    END IF;
    -- A VERIFIED CHARGE IS NEVER DROPPED (20261102100000). Neither provider can cancel or expire a checkout on request, so an
    -- older payable session may still be paid after CFOClose closed its intent, and a provider may report a second,
    -- different successful transaction for one intent. Each such charge gets an explicit outcome below.
    IF p_provider IS DISTINCT FROM v_intent.provider THEN
      RAISE EXCEPTION 'Iron Dome: provider mismatch for intent %', p_checkout_intent_id USING ERRCODE = '22023';
    END IF;
    IF p_amount_minor != v_intent.expected_amount_minor THEN
      RAISE EXCEPTION 'Iron Dome: amount mismatch. Expected % minor units, got % for intent %',
        v_intent.expected_amount_minor, p_amount_minor, p_checkout_intent_id;
    END IF;
    IF p_currency_code != v_intent.currency_code THEN
      RAISE EXCEPTION 'Iron Dome: currency mismatch. Expected %, got % for intent %', v_intent.currency_code, p_currency_code, p_checkout_intent_id;
    END IF;
    IF p_provider_environment IS NULL OR v_intent.provider_environment IS NULL OR p_provider_environment != v_intent.provider_environment THEN
      RAISE EXCEPTION 'Iron Dome: provider environment mismatch. Intent snapshotted %, verification ran under %, for intent %',
        v_intent.provider_environment, p_provider_environment, p_checkout_intent_id USING ERRCODE = '22023';
    END IF;
    -- The same provider transaction already recorded (under any key): a redelivery, never a second charge.
    SELECT id INTO v_existing_tx FROM public.payment_events
     WHERE provider = p_provider AND provider_transaction_id = p_provider_transaction_id AND event_type = 'PAYMENT_CONFIRMED';
    IF v_existing_tx IS NOT NULL THEN
      RETURN jsonb_build_object('status','ALREADY_COMMITTED','event_id',v_existing_tx,'committed',false);
    END IF;
    -- A newer attempt for the same account and product (open, being reviewed, or paid) means the customer moved on.
    SELECT id INTO v_newer_attempt FROM public.payment_checkout_intents
     WHERE billing_customer_id = v_intent.billing_customer_id AND product_id = v_intent.product_id
       AND id <> v_intent.id AND created_at > v_intent.created_at
       AND status IN ('CREATING','PROVIDER_CREATING','PENDING','MANUAL_REVIEW','SUCCEEDED')
     ORDER BY created_at DESC LIMIT 1;
    -- Did the PROVIDER report an outcome for this intent (a non-success event)? Then a later success contradicts the provider.
    v_provider_outcome := EXISTS (SELECT 1 FROM public.payment_events WHERE checkout_intent_id = p_checkout_intent_id);
    v_reason := CASE WHEN v_paid_already THEN 'ADDITIONAL_PAYMENT_ON_PAID_INTENT'
                     WHEN v_newer_attempt IS NOT NULL THEN 'PAYMENT_AFTER_REPLACEMENT_STARTED'
                     WHEN v_provider_outcome THEN 'PAYMENT_AFTER_PROVIDER_REPORTED_NON_SUCCESS' END;
    IF v_reason IS NULL THEN
      -- CFOClose closed the intent (no provider outcome was ever recorded for it) and nothing replaced it: this is simply a
      -- late payment for exactly what the intent offered. It is placed by the normal rule below (the intent becomes
      -- SUCCEEDED), and audited as late.
      v_late := true;
    ELSE
      -- Paid twice for one purchase, or paid an older session after starting a replacement: the money is recorded once and
      -- an administrator decides — place it as an additional term, or refund it at the provider and record the refund.
      SELECT * INTO v_plan FROM public.commercial_plans WHERE id = v_intent.plan_id;
      INSERT INTO public.payment_events (
        billing_customer_id, licence_id, provider, external_event_id, idempotency_key,
        event_type, amount, currency, amount_minor, provider_transaction_id,
        provider_status, normalized_status, saff_reference, provider_reference,
        payload_hash, verified_at, verification_method, checkout_intent_id,
        commercial_offer_id, plan_id, provider_created_at, event_time, metadata
      ) VALUES (
        v_intent.billing_customer_id, NULL, p_provider, p_provider_transaction_id,
        p_idempotency_key, 'PAYMENT_CONFIRMED', p_amount_minor::NUMERIC / POWER(10, v_intent.currency_exponent), p_currency_code,
        p_amount_minor, p_provider_transaction_id, p_provider_status, p_normalized_status,
        p_saff_reference, p_saff_reference, p_payload_hash, p_verified_at,
        p_verification_method, p_checkout_intent_id, v_intent.commercial_offer_id,
        v_intent.plan_id, now(), now(),
        jsonb_build_object('placement','RECOVERY_REQUIRED','recovery_reason',
          v_reason,
          'newer_attempt_id', v_newer_attempt, 'intent_status_at_payment', v_intent.status)
      ) RETURNING id INTO v_event_id;
      INSERT INTO public.payment_recovery_cases (payment_event_id, checkout_intent_id, billing_customer_id, provider, provider_environment,
        provider_transaction_id, amount_minor, currency_code, plan_id, reason, newer_attempt_id)
      VALUES (v_event_id, v_intent.id, v_intent.billing_customer_id, p_provider, v_intent.provider_environment,
        p_provider_transaction_id, p_amount_minor, p_currency_code, v_intent.plan_id,
        v_reason, v_newer_attempt)
      RETURNING id INTO v_case_id;
      INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
      VALUES (v_intent.billing_customer_id, NULL, 'VERIFIED_CHARGE_REQUIRES_RECOVERY',
        jsonb_build_object('checkout_intent_id', v_intent.id, 'intent_status', v_intent.status, 'paid_already', v_paid_already),
        jsonb_build_object('recovery_case_id', v_case_id, 'payment_event_id', v_event_id, 'provider', p_provider,
          'provider_transaction_id', p_provider_transaction_id, 'amount_minor', p_amount_minor, 'currency_code', p_currency_code,
          'plan_code', v_plan.code, 'newer_attempt_id', v_newer_attempt),
        'A verified charge for a purchase that was already paid, replaced, or reported unsuccessful by the provider: recorded once; an administrator places it or refunds it');
      RETURN jsonb_build_object('status','RECOVERY_REQUIRED','committed',true,'event_id',v_event_id,'recovery_case_id',v_case_id,
        'licence_id',NULL,'reason',v_reason);
    END IF;
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

  -- A sandbox payment is test money: it is recorded, never placed. It never ends, queues against or blocks a real term,
  -- whatever the platform state (DEFECT-SANDBOX-LICENCE-PRODUCTION-LEAK-001).
  IF v_intent.provider_environment = 'sandbox' THEN
    v_place := jsonb_build_object('kind', 'SANDBOX_RECORD', 'start', now());
  ELSE
    v_place := public._commercial_licence_placement(v_intent.billing_customer_id, v_intent.plan_id, now());
  END IF;

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
      jsonb_build_object('placement','REVIEW_REQUIRED','placement_kind',v_place->>'kind','late_payment_on_closed_intent',v_late)
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

  INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end, provenance, provenance_evidence)
  VALUES (v_intent.billing_customer_id, v_intent.plan_id,
          CASE v_intent.provider_environment WHEN 'sandbox' THEN 'SANDBOX' ELSE 'ACTIVE' END,
          p_provider || '_VERIFIED_PAYMENT', v_period_start, v_period_end,
          CASE v_intent.provider_environment WHEN 'sandbox' THEN 'SANDBOX_PAYMENT' ELSE 'PRODUCTION_PAYMENT' END,
          jsonb_build_object('basis', 'provider_environment of the checkout intent at commit', 'checkout_intent_id', p_checkout_intent_id,
                             'provider_environment', v_intent.provider_environment))
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
    v_intent.billing_customer_id, v_intent.created_by_user_id,
    CASE v_intent.provider_environment WHEN 'sandbox' THEN 'SANDBOX_TEST_PAYMENT_RECORDED' ELSE 'LICENCE_GRANTED' END,
    CASE WHEN v_ended_licence IS NOT NULL
      THEN jsonb_build_object('closed_prior_licence_id',v_ended_licence,'closed_effective_end',v_period_start) END,
    jsonb_build_object(
      'licence_id',v_licence_id,'plan_code',v_plan.code,'payment_event_id',v_event_id,
      'provider',p_provider,'amount_minor',p_amount_minor,'currency_code',p_currency_code,
      'market_code',v_intent.market_code,'period_start',v_period_start,'period_end',v_period_end,
      'placement',v_place->>'kind','verification_method',p_verification_method,
      'late_payment_on_closed_intent', v_late, 'intent_status_at_payment', v_intent.status),
    CASE WHEN v_late THEN 'Verified late payment on a closed intent that nothing replaced: placed by the normal rule'
         ELSE 'Verified payment commit' END);

  UPDATE public.payment_checkout_intents SET status='SUCCEEDED', completed_at=now() WHERE id=p_checkout_intent_id;

  RETURN jsonb_build_object('status','COMMITTED','committed',true,'event_id',v_event_id,'licence_id',v_licence_id,
    'period_start',v_period_start,'period_end',v_period_end,'placement',v_place->>'kind',
    'provider_environment',v_intent.provider_environment,'grants_access',v_intent.provider_environment <> 'sandbox',
    'late_payment', v_late);
END;
$$;
REVOKE ALL ON FUNCTION public.commit_verified_commercial_payment(UUID,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_verified_commercial_payment(UUID,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT) TO service_role;

-- ── 3. The intent's own payment, never a recovery payment, in placement and the order reads ───────────────────────
-- admin_place_paid_licence: as in 20261031110000_sandbox_licence_isolation.sql; a recovery payment (placement RECOVERY_REQUIRED) is never read as the intent's own payment.
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
   WHERE checkout_intent_id = p_checkout_intent_id AND event_type = 'PAYMENT_CONFIRMED' AND licence_id IS NULL AND COALESCE(metadata->>'placement', '') <> 'RECOVERY_REQUIRED'
   ORDER BY event_time DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_UNPLACED_PAYMENT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_plan FROM public.commercial_plans WHERE id = v_intent.plan_id;

  IF v_intent.provider_environment IS NULL OR v_intent.provider_environment NOT IN ('sandbox','production') THEN
    RAISE EXCEPTION 'PROVENANCE_UNKNOWN' USING ERRCODE = '22023';
  END IF;
  v_end := p_effective_start + (v_intent.billing_interval_count * 12 || ' months')::interval;
  BEGIN
    INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end, provenance, provenance_evidence)
    VALUES (v_intent.billing_customer_id, v_intent.plan_id,
            CASE v_intent.provider_environment WHEN 'sandbox' THEN 'SANDBOX' ELSE 'ACTIVE' END,
            v_intent.provider || '_VERIFIED_PAYMENT', p_effective_start, v_end,
            CASE v_intent.provider_environment WHEN 'sandbox' THEN 'SANDBOX_PAYMENT' ELSE 'PRODUCTION_PAYMENT' END,
            jsonb_build_object('basis', 'provider_environment of the checkout intent at placement', 'checkout_intent_id', p_checkout_intent_id,
                               'provider_environment', v_intent.provider_environment, 'payment_event_id', v_event.id))
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

-- get_checkout_status: as in 20261031110000_sandbox_licence_isolation.sql; a recovery payment (placement RECOVERY_REQUIRED) is never read as the intent's own payment.
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
   WHERE pe.checkout_intent_id = v_intent.id AND pe.event_type = 'PAYMENT_CONFIRMED' AND COALESCE(pe.metadata->>'placement', '') <> 'RECOVERY_REQUIRED'
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
    'provider_environment', v_intent.provider_environment,
    'grants_access', CASE WHEN v_purchased.licence_id IS NULL THEN NULL ELSE v_purchased.licence_status IN ('ACTIVE','GRACE') END,
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

-- get_my_payments: as in 20261031110000_sandbox_licence_isolation.sql; a recovery payment (placement RECOVERY_REQUIRED) is never read as the intent's own payment.
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
             'reversal_type', rv.event_type,
             'provider_environment', ci.provider_environment,
             'grants_access', CASE WHEN cl.id IS NULL THEN NULL ELSE cl.status IN ('ACTIVE','GRACE') END) AS row
      FROM public.payment_checkout_intents ci
      JOIN public.billing_customers bc ON bc.id = ci.billing_customer_id AND bc.owner_user_id = auth.uid()
      JOIN public.commercial_plans cp ON cp.id = ci.plan_id
      LEFT JOIN LATERAL (SELECT e.id, e.provider_transaction_id, e.verified_at, e.licence_id FROM public.payment_events e
                          WHERE e.checkout_intent_id = ci.id AND e.event_type = 'PAYMENT_CONFIRMED' AND COALESCE(e.metadata->>'placement', '') <> 'RECOVERY_REQUIRED' ORDER BY e.event_time DESC LIMIT 1) pe ON true
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

-- ── 4. Administrator: the open recovery cases, and their one resolution ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_list_payment_recovery_cases()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_commercial_admin() THEN RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', rc.id, 'status', rc.status, 'reason', rc.reason, 'created_at', rc.created_at,
      'billing_customer_id', rc.billing_customer_id, 'owner_email', u.email, 'plan_code', cp.code,
      'provider', rc.provider, 'provider_environment', rc.provider_environment, 'provider_transaction_id', rc.provider_transaction_id,
      'amount_minor', rc.amount_minor, 'currency_code', rc.currency_code, 'checkout_intent_id', rc.checkout_intent_id,
      'saff_reference', ci.saff_reference, 'newer_attempt_id', rc.newer_attempt_id, 'payment_event_id', rc.payment_event_id,
      'refunded_minor', (SELECT COALESCE(sum(r.amount_minor), 0) FROM public.payment_events r
                          WHERE r.event_type IN ('REFUND','CHARGEBACK') AND r.metadata->>'original_event_id' = rc.payment_event_id::text),
      'licence_id', rc.licence_id, 'resolved_at', rc.resolved_at, 'resolution_reason', rc.resolution_reason)
      ORDER BY (rc.status = 'OPEN') DESC, rc.created_at)
    FROM public.payment_recovery_cases rc
    JOIN public.billing_customers b ON b.id = rc.billing_customer_id
    LEFT JOIN auth.users u ON u.id = b.owner_user_id
    JOIN public.commercial_plans cp ON cp.id = rc.plan_id
    JOIN public.payment_checkout_intents ci ON ci.id = rc.checkout_intent_id), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_payment_recovery_cases() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_payment_recovery_cases() TO authenticated;

-- A recovery case closes only with a valid outcome:
--   PLACE_ADDITIONAL_TERM  a production payment, nothing refunded, the customer's RECORDED AGREEMENT to receive another term
--                          (how and when they agreed — an unintended second charge is refunded, never silently a renewal), and
--                          a placement the CURRENT rule allows (_commercial_licence_placement: renewal queued at the end, a
--                          downgrade at renewal, an upgrade from now; every BLOCKED_* result — an open-ended agreement, a queued
--                          term, paid additional named users — refuses it);
--   REFUNDED               refunds recorded against THAT payment cover it in full;
--   TEST_PAYMENT_CLOSED    a sandbox payment (it moved no money and is never placed).
CREATE OR REPLACE FUNCTION public.admin_resolve_payment_recovery(p_case_id UUID, p_resolution TEXT, p_reason TEXT, p_customer_agreement TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = public, pg_catalog AS $$
DECLARE
  v_actor UUID := auth.uid(); v_case RECORD; v_intent RECORD; v_refunded BIGINT; v_start TIMESTAMPTZ; v_end TIMESTAMPTZ; v_licence UUID;
  v_place JSONB; v_ended UUID;
BEGIN
  IF v_actor IS NULL OR NOT public.is_commercial_admin() THEN RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_resolution IS NULL OR p_resolution NOT IN ('PLACE_ADDITIONAL_TERM','REFUNDED','TEST_PAYMENT_CLOSED') THEN
    RAISE EXCEPTION 'UNKNOWN_RESOLUTION' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_case FROM public.payment_recovery_cases WHERE id = p_case_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RECOVERY_CASE_NOT_FOUND' USING ERRCODE = '22023'; END IF;
  -- The account's commit lock: a placement here and a payment commit are never interleaved.
  PERFORM pg_advisory_xact_lock(hashtext(v_case.billing_customer_id::text));
  SELECT * INTO v_case FROM public.payment_recovery_cases WHERE id = p_case_id FOR UPDATE;
  IF v_case.status <> 'OPEN' THEN RAISE EXCEPTION 'RECOVERY_CASE_ALREADY_RESOLVED' USING ERRCODE = '22023'; END IF;
  SELECT COALESCE(sum(amount_minor), 0) INTO v_refunded FROM public.payment_events
   WHERE event_type IN ('REFUND','CHARGEBACK') AND metadata->>'original_event_id' = v_case.payment_event_id::text;

  IF p_resolution = 'TEST_PAYMENT_CLOSED' THEN
    IF v_case.provider_environment <> 'sandbox' THEN RAISE EXCEPTION 'NOT_A_TEST_PAYMENT' USING ERRCODE = '22023'; END IF;
  ELSIF p_resolution = 'REFUNDED' THEN
    IF v_refunded < v_case.amount_minor THEN
      RAISE EXCEPTION 'REFUND_NOT_RECORDED_IN_FULL (paid %, refunds recorded %)', v_case.amount_minor, v_refunded USING ERRCODE = '22023';
    END IF;
  ELSE
    IF v_case.provider_environment <> 'production' THEN RAISE EXCEPTION 'NOT_A_PRODUCTION_PAYMENT' USING ERRCODE = '22023'; END IF;
    IF v_refunded > 0 THEN RAISE EXCEPTION 'PAYMENT_PARTLY_OR_FULLY_REFUNDED' USING ERRCODE = '22023'; END IF;
    IF p_customer_agreement IS NULL OR length(btrim(p_customer_agreement)) < 10 THEN
      RAISE EXCEPTION 'CUSTOMER_AGREEMENT_REQUIRED: record how and when the customer agreed to receive another term' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_intent FROM public.payment_checkout_intents WHERE id = v_case.checkout_intent_id;
    -- The CURRENT placement rule, exactly as a verified payment is placed (renewal, downgrade at renewal, upgrade, or refusal).
    v_place := public._commercial_licence_placement(v_case.billing_customer_id, v_case.plan_id, now());
    IF v_place IS NULL OR left(coalesce(v_place->>'kind', ''), 8) = 'BLOCKED_' THEN
      RAISE EXCEPTION 'PLACEMENT_RULE_REFUSES: %', coalesce(v_place->>'kind', 'NO_PLACEMENT') USING ERRCODE = '22023';
    END IF;
    v_start := (v_place->>'start')::timestamptz;
    IF v_place->>'kind' = 'UPGRADE' THEN
      v_ended := (v_place->>'ends_licence_id')::uuid;
      UPDATE public.commercial_licences SET effective_end = v_start, updated_at = now() WHERE id = v_ended;
    END IF;
    v_end := CASE v_intent.billing_interval
      WHEN 'MONTHLY' THEN v_start + (v_intent.billing_interval_count || ' months')::interval
      ELSE v_start + (v_intent.billing_interval_count * 12 || ' months')::interval END;
    INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end, provenance, provenance_evidence)
    VALUES (v_case.billing_customer_id, v_case.plan_id, 'ACTIVE', v_case.provider || '_VERIFIED_PAYMENT', v_start, v_end, 'PRODUCTION_PAYMENT',
            jsonb_build_object('basis', 'verified charge placed by an administrator as an additional term', 'recovery_case_id', v_case.id,
                               'payment_event_id', v_case.payment_event_id, 'provider_transaction_id', v_case.provider_transaction_id,
                               'placement', v_place->>'kind', 'customer_agreement', btrim(p_customer_agreement)))
    RETURNING id INTO v_licence;
  END IF;

  UPDATE public.payment_recovery_cases
     SET status = CASE p_resolution WHEN 'PLACE_ADDITIONAL_TERM' THEN 'TERM_PLACED' WHEN 'REFUNDED' THEN 'REFUNDED' ELSE 'TEST_PAYMENT_CLOSED' END,
         licence_id = v_licence, resolved_by = v_actor, resolved_at = now(), resolution_reason = p_reason
   WHERE id = p_case_id;
  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  VALUES (v_case.billing_customer_id, v_actor, 'PAYMENT_RECOVERY_RESOLVED',
    jsonb_build_object('recovery_case_id', p_case_id, 'status', 'OPEN'),
    jsonb_build_object('recovery_case_id', p_case_id, 'resolution', p_resolution, 'licence_id', v_licence, 'effective_start', v_start,
                       'effective_end', v_end, 'payment_event_id', v_case.payment_event_id, 'refunded_minor', v_refunded,
                       'placement', v_place->>'kind', 'closed_prior_licence_id', v_ended, 'customer_agreement', btrim(p_customer_agreement)),
    p_reason);
  RETURN jsonb_build_object('resolved', true, 'resolution', p_resolution, 'licence_id', v_licence, 'effective_start', v_start, 'effective_end', v_end,
    'placement', v_place->>'kind');
END;
$$;
REVOKE ALL ON FUNCTION public.admin_resolve_payment_recovery(UUID,TEXT,TEXT,TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_resolve_payment_recovery(UUID,TEXT,TEXT,TEXT) TO authenticated;
