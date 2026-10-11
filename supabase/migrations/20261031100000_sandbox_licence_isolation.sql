-- 20261031100000_sandbox_licence_isolation.sql
--
-- DEFECT-SANDBOX-LICENCE-PRODUCTION-LEAK-001 (commercial release correction, batch commercial-p3).
--
-- Reproduced on real PostgreSQL before this change (scripts/db-proof/sandboxLicenceIsolation.mjs, "before" group):
--   1. a verified SANDBOX payment created an ACTIVE licence (source POLAR_VERIFIED_PAYMENT) indistinguishable from a paid
--      one, so the billing summary, entity capacity, seat capacity, capabilities and create_entity all granted access;
--   2. moving the platform back to PAYMENTS_DISABLED did not revoke it;
--   3. a SANDBOX upgrade ended a genuine production term (the placement rule ran for test money).
--
-- Invariant, enforced at the table, independent of commercial_platform_state:
--   A licence created from a sandbox payment is never ACTIVE, GRACE or PENDING. It is recorded with status SANDBOX, which
--   every access decision already excludes (all of them select status IN ('ACTIVE','GRACE')), and with provenance
--   SANDBOX_PAYMENT, which can never change. A sandbox payment never runs placement, so it never ends, queues against or
--   blocks a real term.
--
-- This migration:
--   0. refuses unless commercial-p2 is applied and payments are disabled, and refuses a second application;
--   1. adds status SANDBOX; adds commercial_licences.provenance (+ provenance_evidence) and backfills it ONLY from
--      authoritative records — a payment licence takes the environment of the checkout intent its own PAYMENT_CONFIRMED
--      event (or its placement record) names; a licence whose environment cannot be proven is REVIEW_REQUIRED, never
--      assumed production;
--   2. contains every licence whose authoritative provenance is SANDBOX_PAYMENT: status -> SANDBOX, dates, payment and
--      audit history unchanged, one SANDBOX_LICENCE_CONTAINED audit row each (system actor, previous and new state);
--   3. a guard trigger: provenance is immutable except REVIEW_REQUIRED -> a reviewed value; SANDBOX status <=> SANDBOX_PAYMENT;
--   4. commit_verified_commercial_payment (same 13 arguments): a sandbox payment records a SANDBOX licence and never runs
--      placement; a production payment records PRODUCTION_PAYMENT; everything else unchanged from commercial-p2;
--   5. admin_grant_commercial_licence (same 5 arguments): records MANUAL_GRANT; unchanged otherwise;
--   6. admin_place_paid_licence (same 3 arguments): a sandbox payment is recorded as SANDBOX, a production one as
--      PRODUCTION_PAYMENT, an intent without a proven environment is refused (PROVENANCE_UNKNOWN);
--   7. get_checkout_status (same argument) and get_my_payments(): also return provider_environment and grants_access, so a
--      test order is never shown as an active plan;
--   8. review and containment procedures for commercial administrators, each audited:
--      admin_list_licence_provenance_review(), admin_resolve_licence_provenance(licence, provenance, reason),
--      admin_restore_term_ended_by_sandbox(licence, reason).
--
-- No licence, payment, intent or audit row is deleted; no payment is fabricated. Forward-only.

SET search_path TO public, pg_catalog;

-- ── 0. Preflight ────────────────────────────────────────────────────────────────────────────────────────────────────
DO $preflight$
BEGIN
  IF to_regprocedure('public._commercial_licence_placement(uuid,uuid,timestamp with time zone)') IS NULL
     OR position('BLOCKED_SEATS' IN pg_get_functiondef('public._commercial_licence_placement(uuid,uuid,timestamp with time zone)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: paid-term seat preservation (20261030100000, commercial-p2) is not applied; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT state FROM public.commercial_platform_state WHERE id = true) IS DISTINCT FROM 'PAYMENTS_DISABLED' THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: payments must be disabled (commercial_platform_state = PAYMENTS_DISABLED); nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'commercial_licences' AND column_name = 'provenance') THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: sandbox licence isolation is already in force; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END
$preflight$;

-- ── 1. Status SANDBOX; provenance from authoritative records only ────────────────────────────────────────────────────
ALTER TABLE public.commercial_licences DROP CONSTRAINT chk_cl_status;
ALTER TABLE public.commercial_licences ADD CONSTRAINT chk_cl_status
  CHECK (status IN ('PENDING','ACTIVE','GRACE','SUSPENDED','CANCELLED','EXPIRED','SANDBOX'));

ALTER TABLE public.commercial_licences ADD COLUMN provenance TEXT NULL;
ALTER TABLE public.commercial_licences ADD COLUMN provenance_evidence JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Every checkout intent a licence is bound to by an authoritative record: the PAYMENT_CONFIRMED event that names the
-- licence, or the intent whose administrator placement names it (admin_place_paid_licence records placed_licence_id).
WITH links AS (
  SELECT pe.licence_id, pe.checkout_intent_id, pe.id AS payment_event_id, 'payment_event' AS via
    FROM public.payment_events pe
   WHERE pe.event_type = 'PAYMENT_CONFIRMED' AND pe.licence_id IS NOT NULL AND pe.checkout_intent_id IS NOT NULL
  UNION
  SELECT (ci.metadata->>'placed_licence_id')::uuid, ci.id, NULL::uuid, 'placement'
    FROM public.payment_checkout_intents ci
   WHERE ci.metadata->>'placed_licence_id' ~ '^[0-9a-f-]{36}$'
), envs AS (
  SELECT l.licence_id,
         count(DISTINCT ci.id) AS intents,
         count(DISTINCT ci.provider_environment) AS environments,
         bool_or(ci.provider_environment IS NULL) AS any_unknown,
         min(ci.provider_environment) AS environment,
         jsonb_agg(DISTINCT jsonb_build_object('checkout_intent_id', ci.id, 'provider_environment', ci.provider_environment,
                                               'payment_event_id', l.payment_event_id, 'via', l.via)) AS evidence
    FROM links l JOIN public.payment_checkout_intents ci ON ci.id = l.checkout_intent_id
   GROUP BY l.licence_id
)
UPDATE public.commercial_licences cl
   SET provenance = CASE
         WHEN cl.source = 'MANUAL_ADMIN_GRANT' THEN 'MANUAL_GRANT'
         WHEN cl.source = 'SYSTEM_DEFAULT_FREE' THEN 'SYSTEM_FREE'
         WHEN cl.source LIKE '%\_VERIFIED\_PAYMENT' ESCAPE '\' AND e.licence_id IS NOT NULL AND e.environments = 1 AND NOT e.any_unknown
              THEN CASE e.environment WHEN 'production' THEN 'PRODUCTION_PAYMENT' WHEN 'sandbox' THEN 'SANDBOX_PAYMENT' END
         ELSE 'REVIEW_REQUIRED'
       END,
       provenance_evidence = jsonb_build_object(
         'basis', CASE
           WHEN cl.source = 'MANUAL_ADMIN_GRANT' THEN 'source MANUAL_ADMIN_GRANT (written only by admin_grant_commercial_licence)'
           WHEN cl.source = 'SYSTEM_DEFAULT_FREE' THEN 'source SYSTEM_DEFAULT_FREE (retired free plan; grants nothing)'
           WHEN e.licence_id IS NULL THEN 'payment licence with no PAYMENT_CONFIRMED event or placement record naming it'
           WHEN e.any_unknown THEN 'a linked checkout intent has no recorded provider_environment'
           WHEN e.environments > 1 THEN 'linked checkout intents disagree on provider_environment'
           ELSE 'provider_environment of the linked checkout intent' END,
         'source', cl.source, 'links', COALESCE(e.evidence, '[]'::jsonb), 'backfilled_by', '20261031100000')
  FROM (SELECT id FROM public.commercial_licences) all_l
  LEFT JOIN envs e ON e.licence_id = all_l.id
 WHERE cl.id = all_l.id;

ALTER TABLE public.commercial_licences ALTER COLUMN provenance SET NOT NULL;
-- A licence written by anything other than the three authorised writers (the verified-payment commit, the administrator
-- placement, manual activation — each sets its provenance explicitly) has an unproven origin: REVIEW_REQUIRED, listed for
-- review, never assumed production.
ALTER TABLE public.commercial_licences ALTER COLUMN provenance SET DEFAULT 'REVIEW_REQUIRED';
ALTER TABLE public.commercial_licences ADD CONSTRAINT chk_cl_provenance
  CHECK (provenance IN ('PRODUCTION_PAYMENT','SANDBOX_PAYMENT','MANUAL_GRANT','SYSTEM_FREE','REVIEW_REQUIRED'));

COMMENT ON COLUMN public.commercial_licences.provenance IS
  'Where this licence came from, proven from authoritative records (20261031100000). SANDBOX_PAYMENT licences are always status SANDBOX and grant nothing; REVIEW_REQUIRED awaits admin_resolve_licence_provenance.';

-- ── 2. Containment: every licence proven to come from a sandbox payment stops granting access, audited ───────────────
DO $contain$
DECLARE r RECORD; v_closed RECORD;
BEGIN
  FOR r IN SELECT * FROM public.commercial_licences WHERE provenance = 'SANDBOX_PAYMENT' AND status <> 'SANDBOX' ORDER BY created_at, id LOOP
    -- A sandbox upgrade may have ended a real term: name it (from the commit's own audit row) for administrator review.
    SELECT a.previous_state INTO v_closed FROM public.billing_audit_events a
     WHERE a.action = 'LICENCE_GRANTED' AND a.new_state->>'licence_id' = r.id::text AND a.previous_state ? 'closed_prior_licence_id'
     ORDER BY a.created_at LIMIT 1;
    UPDATE public.commercial_licences SET status = 'SANDBOX', updated_at = now() WHERE id = r.id;
    INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
    VALUES (r.billing_customer_id, NULL, 'SANDBOX_LICENCE_CONTAINED',
            jsonb_build_object('licence_id', r.id, 'status', r.status, 'source', r.source, 'effective_start', r.effective_start, 'effective_end', r.effective_end),
            jsonb_build_object('licence_id', r.id, 'status', 'SANDBOX', 'provenance', 'SANDBOX_PAYMENT', 'provenance_evidence', r.provenance_evidence,
                               'ended_production_licence_id', v_closed.previous_state->>'closed_prior_licence_id'),
            'DEFECT-SANDBOX-LICENCE-PRODUCTION-LEAK-001: a sandbox payment never grants access (migration 20261031100000)');
  END LOOP;
END
$contain$;

-- ── 3. Guard: provenance is fixed; a sandbox licence can never grant ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.commercial_licence_provenance_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.provenance IS DISTINCT FROM OLD.provenance AND OLD.provenance <> 'REVIEW_REQUIRED' THEN
    RAISE EXCEPTION 'LICENCE_PROVENANCE_IS_FIXED (licence %: % cannot become %)', OLD.id, OLD.provenance, NEW.provenance USING ERRCODE = '42501';
  END IF;
  IF NEW.provenance = 'SANDBOX_PAYMENT' AND NEW.status <> 'SANDBOX' THEN
    RAISE EXCEPTION 'SANDBOX_LICENCE_NEVER_GRANTS (licence %: status % refused)', NEW.id, NEW.status USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'SANDBOX' AND NEW.provenance <> 'SANDBOX_PAYMENT' THEN
    RAISE EXCEPTION 'SANDBOX_STATUS_REQUIRES_SANDBOX_PROVENANCE (licence %)', NEW.id USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_licence_provenance_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_cl_provenance_guard BEFORE INSERT OR UPDATE ON public.commercial_licences
  FOR EACH ROW EXECUTE FUNCTION public.commercial_licence_provenance_guard();

-- ── 4. The verified-payment commit: a sandbox payment records SANDBOX and never runs placement ───────────────────────
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
      'placement',v_place->>'kind','verification_method',p_verification_method),
    'Verified payment commit');

  UPDATE public.payment_checkout_intents SET status='SUCCEEDED', completed_at=now() WHERE id=p_checkout_intent_id;

  RETURN jsonb_build_object('status','COMMITTED','committed',true,'event_id',v_event_id,'licence_id',v_licence_id,
    'period_start',v_period_start,'period_end',v_period_end,'placement',v_place->>'kind',
    'provider_environment',v_intent.provider_environment,'grants_access',v_intent.provider_environment <> 'sandbox');
END;
$$;
REVOKE ALL ON FUNCTION public.commit_verified_commercial_payment(UUID,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_verified_commercial_payment(UUID,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT) TO service_role;

-- ── 5. Manual activation records MANUAL_GRANT ────────────────────────────────────────────────────────────────────────
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

  INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end, provenance, provenance_evidence)
  VALUES (p_billing_customer_id, v_plan_id, 'ACTIVE', 'MANUAL_ADMIN_GRANT', p_effective_start, p_effective_end, 'MANUAL_GRANT',
          jsonb_build_object('basis', 'admin_grant_commercial_licence', 'granted_by', v_user_id))
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

-- ── 6. Placing a recorded paid term keeps its environment ───────────────────────────────────────────────────────────
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

-- ── 7. The order status says whether the order grants access ────────────────────────────────────────────────────────
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
             'reversal_type', rv.event_type,
             'provider_environment', ci.provider_environment,
             'grants_access', CASE WHEN cl.id IS NULL THEN NULL ELSE cl.status IN ('ACTIVE','GRACE') END) AS row
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

-- ── 8. Review and containment procedures (commercial administrators; every action audited) ──────────────────────────
CREATE OR REPLACE FUNCTION public.admin_list_licence_provenance_review()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'review_required', COALESCE((SELECT jsonb_agg(jsonb_build_object('licence_id', l.id, 'billing_customer_id', l.billing_customer_id,
        'status', l.status, 'source', l.source, 'effective_start', l.effective_start, 'effective_end', l.effective_end,
        'provenance_evidence', l.provenance_evidence) ORDER BY l.created_at)
      FROM public.commercial_licences l WHERE l.provenance = 'REVIEW_REQUIRED'), '[]'::jsonb),
    'terms_ended_by_sandbox', COALESCE((SELECT jsonb_agg(jsonb_build_object('sandbox_licence_id', a.new_state->>'licence_id',
        'ended_licence_id', a.new_state->>'ended_production_licence_id', 'billing_customer_id', a.billing_customer_id,
        'restored', EXISTS (SELECT 1 FROM public.billing_audit_events r WHERE r.action = 'TERM_RESTORED_AFTER_SANDBOX'
                              AND r.new_state->>'licence_id' = a.new_state->>'ended_production_licence_id')) ORDER BY a.created_at)
      FROM public.billing_audit_events a
     WHERE a.action IN ('SANDBOX_LICENCE_CONTAINED','SANDBOX_PROVENANCE_CONFIRMED') AND a.new_state->>'ended_production_licence_id' IS NOT NULL), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_licence_provenance_review() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_licence_provenance_review() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_resolve_licence_provenance(p_licence_id UUID, p_provenance TEXT, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE v_actor UUID := auth.uid(); v_lic RECORD; v_closed RECORD;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_actor AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_provenance IS NULL OR p_provenance NOT IN ('PRODUCTION_PAYMENT','SANDBOX_PAYMENT','MANUAL_GRANT') THEN
    RAISE EXCEPTION 'UNKNOWN_PROVENANCE' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_lic FROM public.commercial_licences WHERE id = p_licence_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LICENCE_NOT_FOUND' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_lic.billing_customer_id::text));
  IF v_lic.provenance <> 'REVIEW_REQUIRED' THEN RAISE EXCEPTION 'PROVENANCE_ALREADY_PROVEN' USING ERRCODE = '22023'; END IF;
  IF p_provenance = 'MANUAL_GRANT' AND v_lic.source LIKE '%\_VERIFIED\_PAYMENT' ESCAPE '\' THEN
    RAISE EXCEPTION 'A_PAYMENT_LICENCE_IS_NOT_A_MANUAL_GRANT' USING ERRCODE = '22023';
  END IF;
  SELECT a.previous_state INTO v_closed FROM public.billing_audit_events a
   WHERE a.action = 'LICENCE_GRANTED' AND a.new_state->>'licence_id' = p_licence_id::text AND a.previous_state ? 'closed_prior_licence_id'
   ORDER BY a.created_at LIMIT 1;
  UPDATE public.commercial_licences
     SET provenance = p_provenance,
         status = CASE WHEN p_provenance = 'SANDBOX_PAYMENT' THEN 'SANDBOX' ELSE status END,
         provenance_evidence = provenance_evidence || jsonb_build_object('reviewed_by', v_actor, 'reviewed_at', now(), 'review_reason', p_reason),
         updated_at = now()
   WHERE id = p_licence_id;
  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  VALUES (v_lic.billing_customer_id, v_actor,
          CASE WHEN p_provenance = 'SANDBOX_PAYMENT' THEN 'SANDBOX_PROVENANCE_CONFIRMED' ELSE 'LICENCE_PROVENANCE_CONFIRMED' END,
          jsonb_build_object('licence_id', p_licence_id, 'status', v_lic.status, 'provenance', v_lic.provenance),
          jsonb_build_object('licence_id', p_licence_id, 'provenance', p_provenance,
                             'status', CASE WHEN p_provenance = 'SANDBOX_PAYMENT' THEN 'SANDBOX' ELSE v_lic.status END,
                             'ended_production_licence_id', CASE WHEN p_provenance = 'SANDBOX_PAYMENT' THEN v_closed.previous_state->>'closed_prior_licence_id' END),
          p_reason);
  RETURN jsonb_build_object('resolved', true, 'licence_id', p_licence_id, 'provenance', p_provenance);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_resolve_licence_provenance(UUID, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_resolve_licence_provenance(UUID, TEXT, TEXT) TO authenticated;

-- A term a sandbox upgrade ended is restored to the end its own grant recorded — and only if nothing has changed it since.
CREATE OR REPLACE FUNCTION public.admin_restore_term_ended_by_sandbox(p_licence_id UUID, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE v_actor UUID := auth.uid(); v_lic RECORD; v_containment RECORD; v_sandbox RECORD; v_grant RECORD; v_original_end TIMESTAMPTZ;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_actor AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_lic FROM public.commercial_licences WHERE id = p_licence_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LICENCE_NOT_FOUND' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_lic.billing_customer_id::text));
  IF EXISTS (SELECT 1 FROM public.billing_audit_events WHERE action = 'TERM_RESTORED_AFTER_SANDBOX' AND new_state->>'licence_id' = p_licence_id::text) THEN
    RAISE EXCEPTION 'TERM_ALREADY_RESTORED' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_containment FROM public.billing_audit_events
   WHERE action IN ('SANDBOX_LICENCE_CONTAINED','SANDBOX_PROVENANCE_CONFIRMED') AND new_state->>'ended_production_licence_id' = p_licence_id::text
   ORDER BY created_at LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_ENDED_BY_A_SANDBOX_PAYMENT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_sandbox FROM public.commercial_licences WHERE id = (v_containment.new_state->>'licence_id')::uuid;
  -- Untouched since: the term still ends exactly where the sandbox licence began.
  IF v_lic.effective_end IS DISTINCT FROM v_sandbox.effective_start THEN
    RAISE EXCEPTION 'TERM_CHANGED_SINCE_SANDBOX_PAYMENT (ends %, sandbox began %)', v_lic.effective_end, v_sandbox.effective_start USING ERRCODE = '22023';
  END IF;
  -- The authoritative original end: the term's own grant record.
  SELECT * INTO v_grant FROM public.billing_audit_events
   WHERE action IN ('LICENCE_GRANTED','PAID_LICENCE_PLACED') AND new_state->>'licence_id' = p_licence_id::text ORDER BY created_at LIMIT 1;
  v_original_end := COALESCE((v_grant.new_state->>'period_end')::timestamptz, (v_grant.new_state->>'effective_end')::timestamptz);
  IF v_grant.id IS NULL OR v_original_end IS NULL OR v_original_end <= v_lic.effective_end THEN
    RAISE EXCEPTION 'ORIGINAL_END_NOT_RECORDED' USING ERRCODE = '22023';
  END IF;
  BEGIN
    UPDATE public.commercial_licences SET effective_end = v_original_end, updated_at = now() WHERE id = p_licence_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'RESTORED_TERM_WOULD_OVERLAP_ANOTHER_TERM' USING ERRCODE = '22023';
  END;
  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  VALUES (v_lic.billing_customer_id, v_actor, 'TERM_RESTORED_AFTER_SANDBOX',
          jsonb_build_object('licence_id', p_licence_id, 'effective_end', v_lic.effective_end),
          jsonb_build_object('licence_id', p_licence_id, 'effective_end', v_original_end, 'sandbox_licence_id', v_sandbox.id,
                             'original_grant_audit_event_id', v_grant.id),
          p_reason);
  RETURN jsonb_build_object('restored', true, 'licence_id', p_licence_id, 'effective_end', v_original_end);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_restore_term_ended_by_sandbox(UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_restore_term_ended_by_sandbox(UUID, TEXT) TO authenticated;
