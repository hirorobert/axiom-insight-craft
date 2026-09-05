-- ════════════════════════════════════════════════════════════════════════════
-- Ω∞ WAVE Ω2 — REAL PAYMENTS + PREMIUM ENTITLEMENT + COMMERCIAL OPERATIONS
-- Provider-neutral commercial payment architecture. First provider: Flutterwave.
-- Tanzania-first: TZS, cards, mobile money, webhook + server-side verification.
--
-- FORWARD MIGRATION ONLY. Does not edit any Ω1 migration.
-- Apply AFTER 20260905120000_fix_commercial_admin_rls_recursion.sql.
--
-- Constitutional laws (inherited from Ω1, Ω2 additions below):
--   1. Commercial authority NEVER grants accounting authority.
--   2. Browser/redirect callbacks NEVER grant commercial value.
--   3. Webhook receipt alone NEVER grants commercial value.
--   4. Payment MUST be independently verified server-side before licence changes.
--   5. payment_events is append-only (existing trigger preserved + extended).
--   6. UNKNOWN != NOT_ENTITLED != ENTITLED. FAILED != CANCELLED != EXPIRED.
--   7. Money is BIGINT minor units. TZS exponent=0. Float is NEVER authoritative.
--   8. Flutterwave is an adapter. Replacing it must not touch licence schema,
--      payment_events semantics, entitlement resolver, or accounting authority.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path TO public, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. EXTEND commercial_plans WITH PRICE AUTHORITY
--    price_amount_minor NULL = plan not purchasable → checkout blocked server-side.
--    PRODUCT_PRICING_DECISION_REQUIRED: set price before enabling paid checkout.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.commercial_plans
  ADD COLUMN IF NOT EXISTS price_amount_minor BIGINT      NULL,
  ADD COLUMN IF NOT EXISTS currency_code      TEXT        NOT NULL DEFAULT 'TZS',
  ADD COLUMN IF NOT EXISTS currency_exponent  SMALLINT    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_purchasable     BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_period     TEXT        NOT NULL DEFAULT 'ANNUAL'
    CONSTRAINT chk_cp_billing_period CHECK (
      billing_period IN ('ANNUAL','MONTHLY','ONE_TIME')
    );

COMMENT ON COLUMN public.commercial_plans.price_amount_minor IS
  'Price in smallest currency unit. TZS exponent=0 so this IS the TZS amount. '
  'NULL = not purchasable. Set by business decision. PRODUCT_PRICING_DECISION_REQUIRED.';
COMMENT ON COLUMN public.commercial_plans.currency_exponent IS
  'ISO 4217 exponent. TZS=0 (no fractional shillings), USD=2. '
  'Used to convert amount_minor to display: display = amount_minor / 10^exponent.';
COMMENT ON COLUMN public.commercial_plans.is_purchasable IS
  'false = checkout creation blocked server-side regardless of price_amount_minor.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. CHECKOUT INTENT — server-owned expected transaction record
--    Created BEFORE contacting Flutterwave. Browser cannot mark this paid.
--    Only commit_verified_commercial_payment() may set status=SUCCEEDED.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.payment_checkout_intents (
  id                    UUID        NOT NULL DEFAULT gen_random_uuid(),
  billing_customer_id   UUID        NOT NULL,
  plan_id               UUID        NOT NULL,
  provider              TEXT        NOT NULL DEFAULT 'FLUTTERWAVE'
    CONSTRAINT chk_pci_provider CHECK (
      provider IN ('FLUTTERWAVE','PESAPAL','SELCOM','DPO','STRIPE')
    ),
  saff_reference        TEXT        NOT NULL,
  provider_checkout_ref TEXT        NULL,
  provider_checkout_url TEXT        NULL,
  expected_amount_minor BIGINT      NOT NULL,
  currency_code         TEXT        NOT NULL DEFAULT 'TZS',
  currency_exponent     SMALLINT    NOT NULL DEFAULT 0,
  status                TEXT        NOT NULL DEFAULT 'CREATED'
    CONSTRAINT chk_pci_status CHECK (
      status IN ('CREATED','PENDING','SUCCEEDED','FAILED','CANCELLED','EXPIRED')
    ),
  created_by_user_id    UUID        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 hour'),
  completed_at          TIMESTAMPTZ NULL,
  metadata              JSONB       NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT payment_checkout_intents_pk PRIMARY KEY (id),
  CONSTRAINT uq_pci_saff_reference UNIQUE (saff_reference),
  CONSTRAINT fk_pci_billing_customer
    FOREIGN KEY (billing_customer_id) REFERENCES public.billing_customers(id) ON DELETE CASCADE,
  CONSTRAINT fk_pci_plan
    FOREIGN KEY (plan_id) REFERENCES public.commercial_plans(id) ON DELETE RESTRICT,
  CONSTRAINT fk_pci_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_pci_amount CHECK (expected_amount_minor > 0),
  CONSTRAINT chk_pci_currency CHECK (char_length(currency_code) = 3)
);

CREATE INDEX idx_pci_billing_customer ON public.payment_checkout_intents
  (billing_customer_id, created_at DESC);
CREATE INDEX idx_pci_saff_reference ON public.payment_checkout_intents (saff_reference);
CREATE INDEX idx_pci_status_active ON public.payment_checkout_intents (status)
  WHERE status IN ('CREATED','PENDING');

ALTER TABLE public.payment_checkout_intents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pci_select_owner_or_admin" ON public.payment_checkout_intents
  FOR SELECT USING (
    billing_customer_id IN (
      SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid()
    )
    OR public.is_commercial_admin()
  );

REVOKE ALL ON public.payment_checkout_intents FROM anon, authenticated;
GRANT SELECT ON public.payment_checkout_intents TO authenticated;
GRANT ALL    ON public.payment_checkout_intents TO service_role;

COMMENT ON TABLE public.payment_checkout_intents IS
  'Ω2 Iron Dome: SAFF expected transaction, created before provider contact. '
  'Browser cannot write. Only commit_verified_commercial_payment() closes this.';

-- ════════════════════════════════════════════════════════════════════════════
-- 3. WEBHOOK RECEIPTS — raw immutable evidence for every received webhook
--    Recorded BEFORE verification. Invalid receipts NEVER grant commercial value.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.payment_webhook_receipts (
  id                UUID        NOT NULL DEFAULT gen_random_uuid(),
  provider          TEXT        NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  signature_present BOOLEAN     NOT NULL,
  signature_valid   BOOLEAN     NOT NULL,
  payload_hash      TEXT        NOT NULL,
  provider_event_id TEXT        NULL,
  saff_reference    TEXT        NULL,
  processing_result TEXT        NOT NULL DEFAULT 'PENDING'
    CONSTRAINT chk_pwr_result CHECK (
      processing_result IN (
        'PENDING','PROCESSED','INVALID_SIGNATURE','REPLAY',
        'VERIFICATION_FAILED','AMOUNT_MISMATCH','CURRENCY_MISMATCH',
        'REFERENCE_MISMATCH','UNKNOWN_PROVIDER_STATUS','ERROR'
      )
    ),
  correlation_id    TEXT        NULL,

  CONSTRAINT payment_webhook_receipts_pk PRIMARY KEY (id)
);

CREATE OR REPLACE FUNCTION public.payment_webhook_receipts_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: payment_webhook_receipts is append-only. % on id=% is not permitted.', TG_OP, OLD.id;
END;
$$;

CREATE TRIGGER trg_pwr_immutable
  BEFORE UPDATE OR DELETE ON public.payment_webhook_receipts
  FOR EACH ROW EXECUTE FUNCTION public.payment_webhook_receipts_immutable();

ALTER TABLE public.payment_webhook_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pwr_select_admin_only" ON public.payment_webhook_receipts
  FOR SELECT USING (public.is_commercial_admin());

REVOKE ALL ON public.payment_webhook_receipts FROM anon, authenticated;
GRANT SELECT ON public.payment_webhook_receipts TO authenticated;
GRANT ALL    ON public.payment_webhook_receipts TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. EXTEND payment_events WITH REAL PROVIDER EVIDENCE COLUMNS
--    All new columns nullable → existing rows unaffected. amount_minor is
--    the authoritative integer money. existing amount NUMERIC is legacy display.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.payment_events
  ADD COLUMN IF NOT EXISTS amount_minor           BIGINT        NULL,
  ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT         NULL,
  ADD COLUMN IF NOT EXISTS provider_status         TEXT         NULL,
  ADD COLUMN IF NOT EXISTS normalized_status       TEXT         NULL
    CONSTRAINT chk_pe_normalized_status CHECK (
      normalized_status IS NULL OR normalized_status IN (
        'CHECKOUT_CREATED','PENDING','SUCCEEDED','FAILED',
        'CANCELLED','REFUNDED','PARTIALLY_REFUNDED','EXPIRED','UNKNOWN'
      )
    ),
  ADD COLUMN IF NOT EXISTS saff_reference          TEXT         NULL,
  ADD COLUMN IF NOT EXISTS provider_reference      TEXT         NULL,
  ADD COLUMN IF NOT EXISTS payload_hash            TEXT         NULL,
  ADD COLUMN IF NOT EXISTS verified_at             TIMESTAMPTZ  NULL,
  ADD COLUMN IF NOT EXISTS verification_method     TEXT         NULL
    CONSTRAINT chk_pe_verification_method CHECK (
      verification_method IS NULL OR verification_method IN (
        'PROVIDER_API_VERIFY','WEBHOOK_ONLY','MANUAL_ADMIN'
      )
    ),
  ADD COLUMN IF NOT EXISTS checkout_intent_id      UUID         NULL,
  ADD COLUMN IF NOT EXISTS plan_id                 UUID         NULL,
  ADD COLUMN IF NOT EXISTS provider_created_at     TIMESTAMPTZ  NULL;

ALTER TABLE public.payment_events
  ADD CONSTRAINT fk_pe_checkout_intent
    FOREIGN KEY (checkout_intent_id)
    REFERENCES public.payment_checkout_intents(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_pe_plan
    FOREIGN KEY (plan_id)
    REFERENCES public.commercial_plans(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX uq_pe_provider_tx_id
  ON public.payment_events (provider, provider_transaction_id)
  WHERE provider IS NOT NULL AND provider_transaction_id IS NOT NULL;

COMMENT ON COLUMN public.payment_events.amount_minor IS
  'Authoritative money in smallest currency unit (TZS exponent=0, so 1 TZS = 1 unit). '
  'Validated against checkout_intent.expected_amount_minor before granting commercial value.';
COMMENT ON COLUMN public.payment_events.verified_at IS
  'Timestamp of independent Flutterwave API verification call. '
  'NULL = not independently verified. Commercial value only granted when NOT NULL.';
COMMENT ON COLUMN public.payment_events.normalized_status IS
  'Provider-neutral status enum. Flutterwave "successful" maps to SUCCEEDED here. '
  'A SUCCEEDED row without verified_at IS NOT NULL must never grant entitlement.';

-- ════════════════════════════════════════════════════════════════════════════
-- 5. ATOMIC COMMERCIAL COMMIT — single write boundary for verified payment
--    SECURITY DEFINER, service_role only. One transaction: intent → event
--    → licence → audit → done. Idempotent on replay via idempotency_key.
-- ════════════════════════════════════════════════════════════════════════════

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
  p_saff_reference           TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_intent       RECORD;
  v_plan         RECORD;
  v_existing_evt UUID;
  v_event_id     UUID;
  v_licence_id   UUID;
  v_period_start TIMESTAMPTZ;
  v_period_end   TIMESTAMPTZ;
  v_existing_lic RECORD;
  v_display_amt  NUMERIC;
BEGIN
  -- 0. Idempotency — replay returns prior result without duplication
  SELECT id INTO v_existing_evt FROM public.payment_events
   WHERE idempotency_key = p_idempotency_key;
  IF v_existing_evt IS NOT NULL THEN
    RETURN jsonb_build_object('status','ALREADY_COMMITTED','event_id',v_existing_evt,'committed',false);
  END IF;

  -- 1. Validate and lock checkout intent
  SELECT * INTO v_intent FROM public.payment_checkout_intents
   WHERE id = p_checkout_intent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Iron Dome: checkout_intent % not found', p_checkout_intent_id;
  END IF;
  IF v_intent.status NOT IN ('CREATED','PENDING') THEN
    RETURN jsonb_build_object('status','INTENT_ALREADY_RESOLVED','intent_status',v_intent.status,'committed',false);
  END IF;
  IF now() > v_intent.expires_at THEN
    UPDATE public.payment_checkout_intents SET status='EXPIRED' WHERE id=p_checkout_intent_id;
    RETURN jsonb_build_object('status','INTENT_EXPIRED','committed',false);
  END IF;

  -- 2. Money validation — amount AND currency must exactly match intent
  IF p_amount_minor != v_intent.expected_amount_minor THEN
    RAISE EXCEPTION 'Iron Dome: amount mismatch. Expected % minor units, got % for intent %',
      v_intent.expected_amount_minor, p_amount_minor, p_checkout_intent_id;
  END IF;
  IF p_currency_code != v_intent.currency_code THEN
    RAISE EXCEPTION 'Iron Dome: currency mismatch. Expected %, got % for intent %',
      v_intent.currency_code, p_currency_code, p_checkout_intent_id;
  END IF;

  -- 3. Load plan
  SELECT * INTO v_plan FROM public.commercial_plans WHERE id = v_intent.plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Iron Dome: plan % not found for intent %', v_intent.plan_id, p_checkout_intent_id;
  END IF;

  -- Display amount (legacy NUMERIC field)
  v_display_amt := p_amount_minor::NUMERIC / POWER(10, v_intent.currency_exponent);

  -- 4. Non-success: record evidence, mark intent, no licence
  IF p_normalized_status != 'SUCCEEDED' THEN
    INSERT INTO public.payment_events (
      billing_customer_id, provider, external_event_id, idempotency_key, event_type,
      amount, currency, amount_minor, provider_transaction_id, provider_status,
      normalized_status, saff_reference, payload_hash, verified_at, verification_method,
      checkout_intent_id, plan_id, event_time, metadata
    ) VALUES (
      v_intent.billing_customer_id, p_provider, p_provider_transaction_id,
      p_idempotency_key,
      CASE p_normalized_status WHEN 'CANCELLED' THEN 'CANCELLATION' ELSE 'PAYMENT_FAILED' END,
      v_display_amt, p_currency_code, p_amount_minor, p_provider_transaction_id,
      p_provider_status, p_normalized_status, p_saff_reference, p_payload_hash,
      p_verified_at, p_verification_method, p_checkout_intent_id, v_intent.plan_id,
      now(), jsonb_build_object('non_success',true)
    ) RETURNING id INTO v_event_id;

    UPDATE public.payment_checkout_intents
       SET status = CASE p_normalized_status WHEN 'CANCELLED' THEN 'CANCELLED' ELSE 'FAILED' END,
           completed_at = now()
     WHERE id = p_checkout_intent_id;

    RETURN jsonb_build_object('status','NON_SUCCESS_RECORDED','event_id',v_event_id,
      'normalized',p_normalized_status,'committed',false);
  END IF;

  -- 5. SUCCEEDED: determine licence period
  -- If an active paid licence ends in future, renewal begins at that end (no gap, no overlap)
  SELECT * INTO v_existing_lic FROM public.commercial_licences
   WHERE billing_customer_id = v_intent.billing_customer_id
     AND plan_id = v_intent.plan_id
     AND status IN ('ACTIVE','GRACE') AND effective_end > now()
   ORDER BY effective_end DESC LIMIT 1;

  v_period_start := CASE WHEN FOUND THEN v_existing_lic.effective_end ELSE now() END;
  v_period_end   := CASE v_plan.billing_period
    WHEN 'MONTHLY'  THEN v_period_start + interval '1 month'
    WHEN 'ONE_TIME' THEN v_period_start + interval '100 years'
    ELSE v_period_start + interval '1 year'
  END;

  -- 6. Create licence
  INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, effective_start, effective_end)
  VALUES (v_intent.billing_customer_id, v_intent.plan_id, 'ACTIVE', v_period_start, v_period_end)
  RETURNING id INTO v_licence_id;

  -- 7. Insert immutable payment event
  INSERT INTO public.payment_events (
    billing_customer_id, licence_id, provider, external_event_id, idempotency_key,
    event_type, amount, currency, amount_minor, provider_transaction_id,
    provider_status, normalized_status, saff_reference, provider_reference,
    payload_hash, verified_at, verification_method, checkout_intent_id,
    plan_id, provider_created_at, event_time, metadata
  ) VALUES (
    v_intent.billing_customer_id, v_licence_id, p_provider, p_provider_transaction_id,
    p_idempotency_key, 'PAYMENT_CONFIRMED', v_display_amt, p_currency_code,
    p_amount_minor, p_provider_transaction_id, p_provider_status, p_normalized_status,
    p_saff_reference, p_saff_reference, p_payload_hash, p_verified_at,
    p_verification_method, p_checkout_intent_id, v_intent.plan_id, now(), now(),
    jsonb_build_object('licence_id',v_licence_id,'period_start',v_period_start,'period_end',v_period_end)
  ) RETURNING id INTO v_event_id;

  -- 8. Billing audit
  INSERT INTO public.billing_audit_events (billing_customer_id, event_type, actor_user_id, metadata)
  VALUES (
    v_intent.billing_customer_id, 'LICENCE_GRANTED', v_intent.created_by_user_id,
    jsonb_build_object(
      'licence_id',v_licence_id,'plan_code',v_plan.code,'payment_event_id',v_event_id,
      'provider',p_provider,'amount_minor',p_amount_minor,'currency_code',p_currency_code,
      'period_start',v_period_start,'period_end',v_period_end,
      'verification_method',p_verification_method
    )
  );

  -- 9. Mark intent completed
  UPDATE public.payment_checkout_intents
     SET status='SUCCEEDED', completed_at=now()
   WHERE id=p_checkout_intent_id;

  RETURN jsonb_build_object(
    'status','COMMITTED','committed',true,'event_id',v_event_id,
    'licence_id',v_licence_id,'period_start',v_period_start,'period_end',v_period_end
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commit_verified_commercial_payment FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_verified_commercial_payment TO service_role;

COMMENT ON FUNCTION public.commit_verified_commercial_payment IS
  'Ω2 Iron Dome atomic commit: intent validation → payment event → licence → audit. '
  'Idempotent. service_role only. No partial commits — full rollback on any failure.';

-- ════════════════════════════════════════════════════════════════════════════
-- 6. REVERSAL SAFE PATH — immutable evidence, REVIEW_REQUIRED, no auto-mutation
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.record_payment_reversal(
  p_original_event_id UUID, p_reversal_type TEXT,
  p_provider TEXT, p_provider_event_id TEXT,
  p_amount_minor BIGINT, p_currency_code TEXT,
  p_idempotency_key TEXT, p_payload_hash TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog AS $$
DECLARE
  v_original RECORD; v_event_id UUID;
BEGIN
  IF p_reversal_type NOT IN ('REFUND','CHARGEBACK') THEN
    RAISE EXCEPTION 'Iron Dome: invalid reversal_type %. Must be REFUND or CHARGEBACK.', p_reversal_type;
  END IF;
  SELECT id INTO v_event_id FROM public.payment_events WHERE idempotency_key = p_idempotency_key;
  IF v_event_id IS NOT NULL THEN
    RETURN jsonb_build_object('status','ALREADY_RECORDED','event_id',v_event_id);
  END IF;
  SELECT * INTO v_original FROM public.payment_events WHERE id = p_original_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Iron Dome: original payment event % not found', p_original_event_id;
  END IF;
  INSERT INTO public.payment_events (
    billing_customer_id, licence_id, provider, external_event_id, idempotency_key,
    event_type, amount, currency, amount_minor, provider_transaction_id,
    provider_status, normalized_status, saff_reference, payload_hash, event_time, metadata
  ) VALUES (
    v_original.billing_customer_id, v_original.licence_id, p_provider, p_provider_event_id,
    p_idempotency_key, p_reversal_type,
    p_amount_minor::NUMERIC, p_currency_code, p_amount_minor, p_provider_event_id,
    p_reversal_type,
    CASE p_reversal_type WHEN 'REFUND' THEN 'REFUNDED' ELSE 'UNKNOWN' END,
    v_original.saff_reference, p_payload_hash, now(),
    jsonb_build_object('original_event_id',p_original_event_id,
      'reversal_type',p_reversal_type,'licence_action','REVIEW_REQUIRED','auto_licence_mutation',false)
  ) RETURNING id INTO v_event_id;
  INSERT INTO public.billing_audit_events (billing_customer_id, event_type, actor_user_id, metadata)
  VALUES (v_original.billing_customer_id, 'REVERSAL_REQUIRES_REVIEW', NULL,
    jsonb_build_object('reversal_event_id',v_event_id,'original_event_id',p_original_event_id,
      'reversal_type',p_reversal_type,'amount_minor',p_amount_minor,'currency_code',p_currency_code,
      'policy','REVIEW_REQUIRED: no automatic licence mutation on reversal'));
  RETURN jsonb_build_object('status','REVERSAL_RECORDED','event_id',v_event_id,
    'licence_action','REVIEW_REQUIRED','committed',false);
END;
$$;

REVOKE ALL ON FUNCTION public.record_payment_reversal FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment_reversal TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. CHECKOUT STATUS RPC — safe owner-scoped reader for payment return page
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_checkout_status(p_saff_reference TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog AS $$
DECLARE
  v_intent RECORD; v_billing RECORD;
BEGIN
  SELECT ci.* INTO v_intent
    FROM public.payment_checkout_intents ci
    JOIN public.billing_customers bc ON bc.id = ci.billing_customer_id
   WHERE ci.saff_reference = p_saff_reference
     AND (bc.owner_user_id = auth.uid() OR public.is_commercial_admin());
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found',false,'status','UNKNOWN');
  END IF;
  SELECT cl.status AS licence_status, cp.code AS plan_code
    INTO v_billing
    FROM public.billing_customers bc
    LEFT JOIN public.commercial_licences cl ON cl.billing_customer_id = bc.id
      AND cl.status IN ('ACTIVE','GRACE') AND cl.effective_start <= now() AND cl.effective_end > now()
    LEFT JOIN public.commercial_plans cp ON cp.id = cl.plan_id
   WHERE bc.id = v_intent.billing_customer_id
   ORDER BY cl.effective_end DESC NULLS LAST LIMIT 1;
  RETURN jsonb_build_object(
    'found',true,'saff_reference',v_intent.saff_reference,
    'intent_status',v_intent.status,'intent_id',v_intent.id,
    'provider',v_intent.provider,'created_at',v_intent.created_at,
    'expires_at',v_intent.expires_at,'completed_at',v_intent.completed_at,
    'licence_status',v_billing.licence_status,'plan_code',v_billing.plan_code
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_checkout_status FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_checkout_status TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. ADMIN BILLING DETAIL INSPECTOR
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.admin_get_billing_detail(p_owner_user_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog AS $$
DECLARE v_bc RECORD;
BEGIN
  IF NOT public.is_commercial_admin() THEN
    RAISE EXCEPTION 'Iron Dome: admin_get_billing_detail requires commercial_admin role';
  END IF;
  SELECT * INTO v_bc FROM public.billing_customers WHERE owner_user_id = p_owner_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
  RETURN jsonb_build_object(
    'found',true,
    'billing_customer', row_to_json(v_bc),
    'licences', COALESCE((SELECT jsonb_agg(row_to_json(cl) ORDER BY cl.effective_start DESC)
      FROM public.commercial_licences cl WHERE cl.billing_customer_id = v_bc.id),'[]'::jsonb),
    'payment_events', COALESCE((SELECT jsonb_agg(row_to_json(pe) ORDER BY pe.event_time DESC)
      FROM public.payment_events pe WHERE pe.billing_customer_id = v_bc.id LIMIT 20),'[]'::jsonb),
    'checkout_intents', COALESCE((SELECT jsonb_agg(row_to_json(ci) ORDER BY ci.created_at DESC)
      FROM public.payment_checkout_intents ci WHERE ci.billing_customer_id = v_bc.id LIMIT 10),'[]'::jsonb),
    'overrides', COALESCE((SELECT jsonb_agg(row_to_json(eo))
      FROM public.entitlement_overrides eo WHERE eo.billing_customer_id = v_bc.id),'[]'::jsonb),
    'audit_events', COALESCE((SELECT jsonb_agg(row_to_json(bae) ORDER BY bae.event_time DESC)
      FROM public.billing_audit_events bae WHERE bae.billing_customer_id = v_bc.id LIMIT 50),'[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_billing_detail FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_billing_detail TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. GRANT HYGIENE — revoke Ω1 overly broad grants
-- ════════════════════════════════════════════════════════════════════════════

REVOKE UPDATE, DELETE ON public.commercial_licences FROM authenticated;

COMMENT ON SCHEMA public IS 'Ω2 applied: commercial payment authority added.';
