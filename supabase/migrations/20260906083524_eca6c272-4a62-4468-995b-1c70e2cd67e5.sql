SET search_path TO public, pg_catalog;

CREATE TABLE public.commercial_offers (
  id                     UUID        NOT NULL DEFAULT gen_random_uuid(),
  offer_code             TEXT        NOT NULL,
  plan_id                UUID        NOT NULL,
  market_code            TEXT        NOT NULL
    CONSTRAINT chk_co_market_code CHECK (market_code IN ('GLOBAL','TZ','MU','GB','EU')),
  currency_code          TEXT        NOT NULL
    CONSTRAINT chk_co_currency_code CHECK (char_length(currency_code) = 3),
  amount_minor           BIGINT      NOT NULL
    CONSTRAINT chk_co_amount_positive CHECK (amount_minor > 0),
  currency_exponent      SMALLINT    NOT NULL
    CONSTRAINT chk_co_exponent_range CHECK (currency_exponent BETWEEN 0 AND 4),
  billing_interval       TEXT        NOT NULL
    CONSTRAINT chk_co_billing_interval CHECK (billing_interval IN ('ANNUAL','MONTHLY','ONE_TIME')),
  billing_interval_count SMALLINT    NOT NULL DEFAULT 1
    CONSTRAINT chk_co_interval_count_positive CHECK (billing_interval_count > 0),
  effective_start        TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_end          TIMESTAMPTZ NULL,
  is_active              BOOLEAN     NOT NULL DEFAULT true,
  is_purchasable         BOOLEAN     NOT NULL DEFAULT false,
  provider_restriction   TEXT        NULL
    CONSTRAINT chk_co_provider_restriction CHECK (
      provider_restriction IS NULL OR provider_restriction IN
        ('FLUTTERWAVE','PESAPAL','SELCOM','DPO','STRIPE')
    ),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT commercial_offers_pk PRIMARY KEY (id),
  CONSTRAINT uq_co_offer_code UNIQUE (offer_code),
  CONSTRAINT fk_co_plan FOREIGN KEY (plan_id) REFERENCES public.commercial_plans(id) ON DELETE RESTRICT,
  CONSTRAINT chk_co_effective_window CHECK (effective_end IS NULL OR effective_end > effective_start)
);

CREATE UNIQUE INDEX uq_co_current_offer
  ON public.commercial_offers (plan_id, market_code, currency_code)
  WHERE is_active AND is_purchasable AND effective_end IS NULL;

CREATE INDEX idx_co_plan_market ON public.commercial_offers (plan_id, market_code)
  WHERE is_active;

ALTER TABLE public.commercial_offers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "co_select_public" ON public.commercial_offers
  FOR SELECT USING (is_active);

REVOKE ALL ON public.commercial_offers FROM anon, authenticated;
GRANT SELECT ON public.commercial_offers TO anon, authenticated;
GRANT ALL    ON public.commercial_offers TO service_role;

COMMENT ON TABLE public.commercial_offers IS
  'Ω2-G: the sole pricing authority. plan_id + market_code + currency_code '
  'define one purchasable price point. commercial_plans never carries a '
  'price. Editing an offer''s price/currency does not alter historical '
  'checkout intents or payment events — those snapshot their own economic '
  'facts at creation time (see payment_checkout_intents below) precisely so '
  'that changing an offer never rewrites evidence.';

CREATE TABLE public.commercial_catalog_audit_events (
  id             UUID        NOT NULL DEFAULT gen_random_uuid(),
  actor_user_id  UUID        NOT NULL,
  action         TEXT        NOT NULL,
  entity_type    TEXT        NOT NULL CONSTRAINT chk_ccae_entity_type CHECK (entity_type IN ('OFFER','PLAN')),
  entity_id      UUID        NOT NULL,
  previous_state JSONB       NULL,
  new_state      JSONB       NULL,
  reason         TEXT        NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT commercial_catalog_audit_events_pk PRIMARY KEY (id),
  CONSTRAINT fk_ccae_actor FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT
);

CREATE INDEX idx_ccae_entity ON public.commercial_catalog_audit_events (entity_type, entity_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.commercial_catalog_audit_events_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: commercial_catalog_audit_events is append-only. % on id=% is not permitted.', TG_OP, OLD.id;
END;
$$;

CREATE TRIGGER trg_ccae_immutable
  BEFORE UPDATE OR DELETE ON public.commercial_catalog_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.commercial_catalog_audit_events_immutable();

ALTER TABLE public.commercial_catalog_audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ccae_select_admin_only" ON public.commercial_catalog_audit_events
  FOR SELECT USING (public.is_commercial_admin());

REVOKE ALL ON public.commercial_catalog_audit_events FROM anon, authenticated;
GRANT SELECT ON public.commercial_catalog_audit_events TO authenticated;
GRANT ALL    ON public.commercial_catalog_audit_events TO service_role;
REVOKE ALL ON FUNCTION public.commercial_catalog_audit_events_immutable() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.resolve_commercial_offer(
  p_plan_code   TEXT,
  p_market_code TEXT DEFAULT 'GLOBAL'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_plan_id    UUID;
  v_count      INTEGER;
  v_offer      RECORD;
  v_used_market TEXT;
BEGIN
  IF p_market_code IS NULL OR p_market_code NOT IN ('GLOBAL','TZ','MU','GB','EU') THEN
    RETURN jsonb_build_object('resolution','UNKNOWN','reason','UNKNOWN_MARKET_CODE');
  END IF;

  SELECT id INTO v_plan_id FROM public.commercial_plans WHERE code = p_plan_code AND is_active;
  IF v_plan_id IS NULL THEN
    RETURN jsonb_build_object('resolution','UNKNOWN','reason','UNKNOWN_OR_INACTIVE_PLAN_CODE');
  END IF;

  v_used_market := p_market_code;
  SELECT count(*) INTO v_count
    FROM public.commercial_offers co
   WHERE co.plan_id = v_plan_id AND co.market_code = v_used_market
     AND co.is_active AND co.is_purchasable
     AND co.effective_start <= now() AND (co.effective_end IS NULL OR co.effective_end > now());

  IF v_count = 0 AND v_used_market != 'GLOBAL' THEN
    v_used_market := 'GLOBAL';
    SELECT count(*) INTO v_count
      FROM public.commercial_offers co
     WHERE co.plan_id = v_plan_id AND co.market_code = v_used_market
       AND co.is_active AND co.is_purchasable
       AND co.effective_start <= now() AND (co.effective_end IS NULL OR co.effective_end > now());
  END IF;

  IF v_count = 0 THEN
    RETURN jsonb_build_object('resolution','NOT_AVAILABLE','plan_code',p_plan_code,'requested_market',p_market_code);
  END IF;

  IF v_count > 1 THEN
    RETURN jsonb_build_object('resolution','AMBIGUOUS','plan_code',p_plan_code,'market_code',v_used_market);
  END IF;

  SELECT co.id, co.offer_code, co.market_code, co.currency_code, co.amount_minor,
         co.currency_exponent, co.billing_interval, co.billing_interval_count,
         co.provider_restriction
    INTO v_offer
    FROM public.commercial_offers co
   WHERE co.plan_id = v_plan_id AND co.market_code = v_used_market
     AND co.is_active AND co.is_purchasable
     AND co.effective_start <= now() AND (co.effective_end IS NULL OR co.effective_end > now())
   LIMIT 1;

  RETURN jsonb_build_object(
    'resolution','AVAILABLE',
    'offer_id',v_offer.id,'offer_code',v_offer.offer_code,'plan_id',v_plan_id,
    'plan_code',p_plan_code,'market_code',v_offer.market_code,
    'requested_market',p_market_code,'fallback_to_global',(v_used_market != p_market_code),
    'currency_code',v_offer.currency_code,'amount_minor',v_offer.amount_minor,
    'currency_exponent',v_offer.currency_exponent,'billing_interval',v_offer.billing_interval,
    'billing_interval_count',v_offer.billing_interval_count,
    'provider_restriction',v_offer.provider_restriction
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_commercial_offer(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_commercial_offer(TEXT, TEXT) TO anon, authenticated;

COMMENT ON FUNCTION public.resolve_commercial_offer IS
  'Ω2-G: pure server-side offer resolver. Returns AVAILABLE/NOT_AVAILABLE/'
  'AMBIGUOUS/UNKNOWN explicitly — never silently picks between equally '
  'authoritative offers, never accepts browser-supplied price/currency, '
  'never accepts locale/IP. Callable by anon/authenticated for pricing '
  'display; commercial-create-checkout re-resolves server-side regardless '
  'of what the browser echoes back.';

CREATE OR REPLACE FUNCTION public.admin_upsert_commercial_offer(
  p_offer_code             TEXT,
  p_plan_code              TEXT,
  p_market_code            TEXT,
  p_currency_code          TEXT,
  p_amount_minor           BIGINT,
  p_currency_exponent      SMALLINT,
  p_billing_interval       TEXT,
  p_billing_interval_count SMALLINT,
  p_is_active              BOOLEAN,
  p_is_purchasable         BOOLEAN,
  p_reason                 TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_plan_id  UUID;
  v_offer_id UUID;
  v_previous JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_commercial_admin() THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RAISE EXCEPTION 'AMOUNT_MUST_BE_POSITIVE' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_plan_id FROM public.commercial_plans WHERE code = p_plan_code;
  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_PLAN_CODE: %', p_plan_code USING ERRCODE = '22023';
  END IF;

  SELECT id, to_jsonb(co.*) INTO v_offer_id, v_previous
    FROM public.commercial_offers co WHERE co.offer_code = p_offer_code;

  IF v_offer_id IS NOT NULL THEN
    UPDATE public.commercial_offers SET
      currency_code = p_currency_code, amount_minor = p_amount_minor,
      currency_exponent = p_currency_exponent, billing_interval = p_billing_interval,
      billing_interval_count = p_billing_interval_count, is_active = p_is_active,
      is_purchasable = p_is_purchasable, updated_at = now()
     WHERE id = v_offer_id;

    INSERT INTO public.commercial_catalog_audit_events (
      actor_user_id, action, entity_type, entity_id, previous_state, new_state, reason
    ) VALUES (
      v_user_id, 'OFFER_UPDATED', 'OFFER', v_offer_id, v_previous,
      jsonb_build_object('offer_code',p_offer_code,'market_code',p_market_code,
        'currency_code',p_currency_code,'amount_minor',p_amount_minor,
        'is_active',p_is_active,'is_purchasable',p_is_purchasable),
      p_reason
    );
  ELSE
    INSERT INTO public.commercial_offers (
      offer_code, plan_id, market_code, currency_code, amount_minor, currency_exponent,
      billing_interval, billing_interval_count, is_active, is_purchasable
    ) VALUES (
      p_offer_code, v_plan_id, p_market_code, p_currency_code, p_amount_minor, p_currency_exponent,
      p_billing_interval, p_billing_interval_count, p_is_active, p_is_purchasable
    ) RETURNING id INTO v_offer_id;

    INSERT INTO public.commercial_catalog_audit_events (
      actor_user_id, action, entity_type, entity_id, previous_state, new_state, reason
    ) VALUES (
      v_user_id, 'OFFER_CREATED', 'OFFER', v_offer_id, NULL,
      jsonb_build_object('offer_code',p_offer_code,'plan_code',p_plan_code,'market_code',p_market_code,
        'currency_code',p_currency_code,'amount_minor',p_amount_minor,
        'is_active',p_is_active,'is_purchasable',p_is_purchasable),
      p_reason
    );
  END IF;

  RETURN jsonb_build_object('offer_id', v_offer_id, 'offer_code', p_offer_code);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_upsert_commercial_offer FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_commercial_offer TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_list_commercial_offers(p_plan_code TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog AS $$
BEGIN
  IF NOT public.is_commercial_admin() THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id',co.id,'offer_code',co.offer_code,'plan_code',cp.code,'plan_id',co.plan_id,
      'market_code',co.market_code,'currency_code',co.currency_code,
      'amount_minor',co.amount_minor,'currency_exponent',co.currency_exponent,
      'billing_interval',co.billing_interval,'billing_interval_count',co.billing_interval_count,
      'is_active',co.is_active,'is_purchasable',co.is_purchasable,
      'effective_start',co.effective_start,'effective_end',co.effective_end
    ) ORDER BY cp.code, co.market_code, co.currency_code)
    FROM public.commercial_offers co
    JOIN public.commercial_plans cp ON cp.id = co.plan_id
   WHERE p_plan_code IS NULL OR cp.code = p_plan_code
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_commercial_offers(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_commercial_offers(TEXT) TO authenticated;

CREATE TABLE public.payment_checkout_intents (
  id                      UUID        NOT NULL DEFAULT gen_random_uuid(),
  billing_customer_id     UUID        NOT NULL,
  commercial_offer_id     UUID        NOT NULL,
  plan_id                 UUID        NOT NULL,
  market_code             TEXT        NOT NULL,
  expected_amount_minor   BIGINT      NOT NULL,
  currency_code           TEXT        NOT NULL,
  currency_exponent       SMALLINT    NOT NULL,
  billing_interval        TEXT        NOT NULL,
  billing_interval_count  SMALLINT    NOT NULL,
  provider                TEXT        NOT NULL
    CONSTRAINT chk_pci_provider CHECK (
      provider IN ('FLUTTERWAVE','PESAPAL','SELCOM','DPO','STRIPE')
    ),
  saff_reference          TEXT        NOT NULL,
  provider_checkout_ref   TEXT        NULL,
  provider_checkout_url   TEXT        NULL,
  status                  TEXT        NOT NULL DEFAULT 'CREATED'
    CONSTRAINT chk_pci_status CHECK (
      status IN ('CREATED','PENDING','SUCCEEDED','FAILED','CANCELLED','EXPIRED')
    ),
  created_by_user_id      UUID        NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at              TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 hour'),
  completed_at            TIMESTAMPTZ NULL,
  metadata                JSONB       NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT payment_checkout_intents_pk PRIMARY KEY (id),
  CONSTRAINT uq_pci_saff_reference UNIQUE (saff_reference),
  CONSTRAINT fk_pci_billing_customer
    FOREIGN KEY (billing_customer_id) REFERENCES public.billing_customers(id) ON DELETE CASCADE,
  CONSTRAINT fk_pci_offer
    FOREIGN KEY (commercial_offer_id) REFERENCES public.commercial_offers(id) ON DELETE RESTRICT,
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
  'Ω2-G Iron Dome: SAFF expected transaction, created before provider contact. '
  'Snapshots commercial_offer_id + its economic facts at creation time so a '
  'later offer price/currency change never mutates an existing checkout. '
  'Browser cannot write. Only commit_verified_commercial_payment() closes this.';

CREATE TABLE public.payment_webhook_receipts (
  id                UUID        NOT NULL DEFAULT gen_random_uuid(),
  provider          TEXT        NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  signature_present BOOLEAN     NOT NULL,
  payload_hash      TEXT        NOT NULL,
  provider_event_id TEXT        NULL,
  saff_reference    TEXT        NULL,
  correlation_id    TEXT        NULL,

  CONSTRAINT payment_webhook_receipts_pk PRIMARY KEY (id)
);

CREATE INDEX idx_pwr_saff_reference ON public.payment_webhook_receipts (saff_reference);
CREATE INDEX idx_pwr_provider_event ON public.payment_webhook_receipts (provider, provider_event_id);

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

COMMENT ON TABLE public.payment_webhook_receipts IS
  'Ω2-GR1: immutable observation of what arrived over the wire — provider, '
  'raw payload hash, whether a signature was present, and the claimed '
  'reference(s), recorded BEFORE any verification. Never updated. '
  'Processing outcomes (signature validity, verification result) live in '
  'payment_webhook_processing_events, one append-only row per attempt.';

CREATE TABLE public.payment_webhook_processing_events (
  id                     UUID        NOT NULL DEFAULT gen_random_uuid(),
  receipt_id             UUID        NOT NULL,
  provider               TEXT        NOT NULL,
  signature_valid        BOOLEAN     NOT NULL,
  processing_result      TEXT        NOT NULL
    CONSTRAINT chk_pwpe_result CHECK (
      processing_result IN (
        'PROCESSED','INVALID_SIGNATURE','REPLAY',
        'VERIFICATION_FAILED','AMOUNT_MISMATCH','CURRENCY_MISMATCH',
        'REFERENCE_MISMATCH','REFERENCE_MISSING','UNKNOWN_PROVIDER_STATUS','ERROR'
      )
    ),
  provider_transaction_id TEXT       NULL,
  saff_reference          TEXT       NULL,
  payment_event_id        UUID       NULL,
  correlation_id          TEXT       NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payment_webhook_processing_events_pk PRIMARY KEY (id),
  CONSTRAINT fk_pwpe_receipt FOREIGN KEY (receipt_id) REFERENCES public.payment_webhook_receipts(id) ON DELETE CASCADE,
  CONSTRAINT fk_pwpe_payment_event FOREIGN KEY (payment_event_id) REFERENCES public.payment_events(id) ON DELETE SET NULL
);

CREATE INDEX idx_pwpe_receipt ON public.payment_webhook_processing_events (receipt_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.payment_webhook_processing_events_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: payment_webhook_processing_events is append-only. % on id=% is not permitted.', TG_OP, OLD.id;
END;
$$;

CREATE TRIGGER trg_pwpe_immutable
  BEFORE UPDATE OR DELETE ON public.payment_webhook_processing_events
  FOR EACH ROW EXECUTE FUNCTION public.payment_webhook_processing_events_immutable();

ALTER TABLE public.payment_webhook_processing_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pwpe_select_admin_only" ON public.payment_webhook_processing_events
  FOR SELECT USING (public.is_commercial_admin());

REVOKE ALL ON public.payment_webhook_processing_events FROM anon, authenticated;
GRANT SELECT ON public.payment_webhook_processing_events TO authenticated;
GRANT ALL    ON public.payment_webhook_processing_events TO service_role;

REVOKE ALL ON FUNCTION public.payment_webhook_receipts_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payment_webhook_processing_events_immutable() FROM PUBLIC, anon, authenticated;

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
  ADD COLUMN IF NOT EXISTS commercial_offer_id     UUID         NULL,
  ADD COLUMN IF NOT EXISTS plan_id                 UUID         NULL,
  ADD COLUMN IF NOT EXISTS provider_created_at     TIMESTAMPTZ  NULL;

ALTER TABLE public.payment_events
  ADD CONSTRAINT fk_pe_checkout_intent
    FOREIGN KEY (checkout_intent_id)
    REFERENCES public.payment_checkout_intents(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_pe_offer
    FOREIGN KEY (commercial_offer_id)
    REFERENCES public.commercial_offers(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_pe_plan
    FOREIGN KEY (plan_id)
    REFERENCES public.commercial_plans(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX uq_pe_provider_tx_id
  ON public.payment_events (provider, provider_transaction_id)
  WHERE provider IS NOT NULL AND provider_transaction_id IS NOT NULL;

COMMENT ON COLUMN public.payment_events.amount_minor IS
  'Authoritative money in smallest currency unit of whatever currency this '
  'event''s offer was priced in. Validated against '
  'checkout_intent.expected_amount_minor before granting commercial value.';
COMMENT ON COLUMN public.payment_events.verified_at IS
  'Timestamp of independent provider API verification call. '
  'NULL = not independently verified. Commercial value only granted when NOT NULL.';
COMMENT ON COLUMN public.payment_events.normalized_status IS
  'Provider-neutral status enum. A SUCCEEDED row without verified_at IS NOT '
  'NULL must never grant entitlement.';

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
  v_current_lic  RECORD;
  v_display_amt  NUMERIC;
BEGIN
  SELECT id INTO v_existing_evt FROM public.payment_events
   WHERE idempotency_key = p_idempotency_key;
  IF v_existing_evt IS NOT NULL THEN
    RETURN jsonb_build_object('status','ALREADY_COMMITTED','event_id',v_existing_evt,'committed',false);
  END IF;

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

  IF p_amount_minor != v_intent.expected_amount_minor THEN
    RAISE EXCEPTION 'Iron Dome: amount mismatch. Expected % minor units, got % for intent %',
      v_intent.expected_amount_minor, p_amount_minor, p_checkout_intent_id;
  END IF;
  IF p_currency_code != v_intent.currency_code THEN
    RAISE EXCEPTION 'Iron Dome: currency mismatch. Expected %, got % for intent %',
      v_intent.currency_code, p_currency_code, p_checkout_intent_id;
  END IF;

  SELECT * INTO v_plan FROM public.commercial_plans WHERE id = v_intent.plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Iron Dome: plan % not found for intent %', v_intent.plan_id, p_checkout_intent_id;
  END IF;

  v_display_amt := p_amount_minor::NUMERIC / POWER(10, v_intent.currency_exponent);

  IF p_normalized_status != 'SUCCEEDED' THEN
    INSERT INTO public.payment_events (
      billing_customer_id, provider, external_event_id, idempotency_key, event_type,
      amount, currency, amount_minor, provider_transaction_id, provider_status,
      normalized_status, saff_reference, payload_hash, verified_at, verification_method,
      checkout_intent_id, commercial_offer_id, plan_id, event_time, metadata
    ) VALUES (
      v_intent.billing_customer_id, p_provider, p_provider_transaction_id,
      p_idempotency_key,
      CASE p_normalized_status WHEN 'CANCELLED' THEN 'CANCELLATION' ELSE 'PAYMENT_FAILED' END,
      v_display_amt, p_currency_code, p_amount_minor, p_provider_transaction_id,
      p_provider_status, p_normalized_status, p_saff_reference, p_payload_hash,
      p_verified_at, p_verification_method, p_checkout_intent_id,
      v_intent.commercial_offer_id, v_intent.plan_id,
      now(), jsonb_build_object('non_success',true)
    ) RETURNING id INTO v_event_id;

    UPDATE public.payment_checkout_intents
       SET status = CASE p_normalized_status WHEN 'CANCELLED' THEN 'CANCELLED' ELSE 'FAILED' END,
           completed_at = now()
     WHERE id = p_checkout_intent_id;

    RETURN jsonb_build_object('status','NON_SUCCESS_RECORDED','event_id',v_event_id,
      'normalized',p_normalized_status,'committed',false);
  END IF;

  SELECT * INTO v_current_lic FROM public.commercial_licences
   WHERE billing_customer_id = v_intent.billing_customer_id
     AND status IN ('ACTIVE','GRACE')
     AND effective_start <= now() AND (effective_end IS NULL OR effective_end > now())
   LIMIT 1;

  IF FOUND AND v_current_lic.plan_id = v_intent.plan_id AND v_current_lic.effective_end IS NOT NULL THEN
    v_period_start := GREATEST(now(), v_current_lic.effective_end);
  ELSE
    v_period_start := now();
  END IF;

  v_period_end := CASE v_intent.billing_interval
    WHEN 'MONTHLY'  THEN v_period_start + (v_intent.billing_interval_count || ' months')::interval
    WHEN 'ONE_TIME' THEN v_period_start + interval '100 years'
    ELSE v_period_start + (v_intent.billing_interval_count || ' years')::interval
  END;

  IF FOUND AND (v_current_lic.effective_end IS NULL OR v_current_lic.effective_end > v_period_start) THEN
    UPDATE public.commercial_licences
       SET effective_end = v_period_start, updated_at = now()
     WHERE id = v_current_lic.id;
  END IF;

  INSERT INTO public.commercial_licences (
    billing_customer_id, plan_id, status, source, effective_start, effective_end
  )
  VALUES (
    v_intent.billing_customer_id, v_intent.plan_id, 'ACTIVE',
    p_provider || '_VERIFIED_PAYMENT', v_period_start, v_period_end
  )
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
    jsonb_build_object('licence_id',v_licence_id,'period_start',v_period_start,'period_end',v_period_end)
  ) RETURNING id INTO v_event_id;

  INSERT INTO public.billing_audit_events (
    billing_customer_id, actor_user_id, action, previous_state, new_state, reason
  ) VALUES (
    v_intent.billing_customer_id, v_intent.created_by_user_id, 'LICENCE_GRANTED',
    CASE WHEN v_current_lic.id IS NOT NULL
      THEN jsonb_build_object('closed_prior_licence_id',v_current_lic.id,'closed_effective_end',v_period_start)
      ELSE NULL
    END,
    jsonb_build_object(
      'licence_id',v_licence_id,'plan_code',v_plan.code,'payment_event_id',v_event_id,
      'provider',p_provider,'amount_minor',p_amount_minor,'currency_code',p_currency_code,
      'market_code',v_intent.market_code,'period_start',v_period_start,'period_end',v_period_end,
      'verification_method',p_verification_method
    ),
    'Verified payment commit'
  );

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
  'Ω2-G Iron Dome atomic commit: intent validation → payment event → licence '
  '(closing out any prior ACTIVE/GRACE licence first, satisfying RLS1''s '
  'no-overlap constraint) → audit → done. Idempotent. service_role only. '
  'No partial commits — full rollback on any failure.';

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
  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  VALUES (v_original.billing_customer_id, NULL, 'REVERSAL_REQUIRES_REVIEW', NULL,
    jsonb_build_object('reversal_event_id',v_event_id,'original_event_id',p_original_event_id,
      'reversal_type',p_reversal_type,'amount_minor',p_amount_minor,'currency_code',p_currency_code),
    'REVIEW_REQUIRED: no automatic licence mutation on reversal');
  RETURN jsonb_build_object('status','REVERSAL_RECORDED','event_id',v_event_id,
    'licence_action','REVIEW_REQUIRED','committed',false);
END;
$$;

REVOKE ALL ON FUNCTION public.record_payment_reversal FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment_reversal TO service_role;

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
  SELECT cl.status AS licence_status, cp.code AS plan_code,
         cl.effective_start AS effective_start, cl.effective_end AS effective_end
    INTO v_billing
    FROM public.billing_customers bc
    LEFT JOIN public.commercial_licences cl ON cl.billing_customer_id = bc.id
      AND cl.status IN ('ACTIVE','GRACE') AND cl.effective_start <= now() AND cl.effective_end > now()
    LEFT JOIN public.commercial_plans cp ON cp.id = cl.plan_id
   WHERE bc.id = v_intent.billing_customer_id
   ORDER BY cl.effective_end DESC NULLS LAST LIMIT 1;
  RETURN jsonb_build_object(
    'found',true,'saff_reference',v_intent.saff_reference,
    'status',v_intent.status,'intent_id',v_intent.id,
    'provider',v_intent.provider,'market_code',v_intent.market_code,
    'created_at',v_intent.created_at,
    'expires_at',v_intent.expires_at,'completed_at',v_intent.completed_at,
    'licence_status',v_billing.licence_status,'plan_code',v_billing.plan_code,
    'effective_start',v_billing.effective_start,'effective_end',v_billing.effective_end
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_checkout_status FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_checkout_status TO authenticated;

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
    'audit_events', COALESCE((SELECT jsonb_agg(row_to_json(bae) ORDER BY bae.created_at DESC)
      FROM public.billing_audit_events bae WHERE bae.billing_customer_id = v_bc.id LIMIT 50),'[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_billing_detail FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_billing_detail TO authenticated;

REVOKE UPDATE, DELETE ON public.commercial_licences FROM authenticated;

COMMENT ON SCHEMA public IS 'Ω2-G applied: global commercial offer + payment authority added.';