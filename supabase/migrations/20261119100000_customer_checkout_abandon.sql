-- 20261119100000_customer_checkout_abandon.sql — a customer may leave an UNPAID hosted checkout and choose another plan
-- (owner decision, 2026-10-20). Forward-only. One new function; no table, column, index, policy or existing function changes.
--
-- The defect: leaving Polar's page without paying left the checkout intent PENDING. acquire_checkout_attempt
-- (20261105100000) then refused every new attempt for the product (OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT), and only the
-- provider's own expiry — seen through a webhook or a later manual check — ever released it. Nothing let the customer out.
--
-- The repair: abandon_unpaid_checkout closes the customer's OWN PENDING intent as CANCELLED, audited. It is executable by the
-- service role only: the commercial-payment-status Edge Function calls it ONLY after re-verifying the session with the
-- provider (settlement first — a paid session is committed, never abandoned — then the provider must report the session
-- still OPEN and unpaid). Neither provider can cancel a session on request, so a payment the customer still makes on the
-- old tab is never lost: commit_verified_commercial_payment (20261102100000) places it normally when nothing replaced the
-- intent, or records it once as a PAYMENT_AFTER_REPLACEMENT_STARTED recovery case when a newer attempt exists.

DO $preflight$
BEGIN
  IF to_regclass('public.payment_checkout_intents') IS NULL OR to_regclass('public.billing_audit_events') IS NULL
     OR to_regclass('public.payment_recovery_cases') IS NULL
     OR to_regprocedure('public.acquire_checkout_attempt(uuid,uuid,uuid,uuid,text,text,smallint,bigint,text,smallint,text,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the checkout and verified-charge authority this change extends is missing; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure('public.abandon_unpaid_checkout(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: customer checkout abandon is already in force; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

CREATE FUNCTION public.abandon_unpaid_checkout(p_checkout_intent_id UUID, p_actor_user_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_intent public.payment_checkout_intents%ROWTYPE;
  v_owner  UUID;
BEGIN
  IF p_checkout_intent_id IS NULL OR p_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('abandoned', false, 'reason', 'INVALID_REQUEST');
  END IF;
  -- The same row lock commit_verified_commercial_payment takes: an abandon and a verified payment are serialised.
  SELECT * INTO v_intent FROM public.payment_checkout_intents WHERE id = p_checkout_intent_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('abandoned', false, 'reason', 'NOT_FOUND_OR_NOT_OWNER');
  END IF;
  SELECT owner_user_id INTO v_owner FROM public.billing_customers WHERE id = v_intent.billing_customer_id;
  IF v_owner IS DISTINCT FROM p_actor_user_id THEN
    RETURN jsonb_build_object('abandoned', false, 'reason', 'NOT_FOUND_OR_NOT_OWNER');
  END IF;
  IF v_intent.status = 'CANCELLED' AND v_intent.metadata->>'cancel_reason' = 'CUSTOMER_ABANDONED_UNPAID' THEN
    RETURN jsonb_build_object('abandoned', true, 'already', true, 'status', v_intent.status);
  END IF;
  IF v_intent.status <> 'PENDING' THEN
    RETURN jsonb_build_object('abandoned', false, 'reason', 'NOT_PENDING', 'status', v_intent.status);
  END IF;
  IF EXISTS (SELECT 1 FROM public.payment_events WHERE checkout_intent_id = p_checkout_intent_id AND event_type = 'PAYMENT_CONFIRMED') THEN
    RETURN jsonb_build_object('abandoned', false, 'reason', 'PAYMENT_RECORDED');
  END IF;
  UPDATE public.payment_checkout_intents
     SET status = 'CANCELLED', completed_at = now(),
         metadata = metadata || jsonb_build_object('cancel_reason', 'CUSTOMER_ABANDONED_UNPAID', 'cancelled_at', now(), 'cancelled_by', p_actor_user_id)
   WHERE id = p_checkout_intent_id;
  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  VALUES (v_intent.billing_customer_id, p_actor_user_id, 'CHECKOUT_ABANDONED_BY_CUSTOMER',
          jsonb_build_object('checkout_intent_id', v_intent.id, 'saff_reference', v_intent.saff_reference, 'status', 'PENDING'),
          jsonb_build_object('checkout_intent_id', v_intent.id, 'status', 'CANCELLED'),
          'The customer left the provider checkout without paying; the provider reported the session open and unpaid');
  RETURN jsonb_build_object('abandoned', true, 'already', false, 'status', 'CANCELLED');
END;
$$;

REVOKE ALL ON FUNCTION public.abandon_unpaid_checkout(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abandon_unpaid_checkout(uuid, uuid) TO service_role;
