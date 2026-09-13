SET search_path TO public, pg_catalog;

CREATE TABLE public.commercial_currencies (
  code           TEXT        NOT NULL,
  exponent       SMALLINT    NOT NULL,
  is_supported   BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT commercial_currencies_pk PRIMARY KEY (code),
  CONSTRAINT chk_cc_code_length CHECK (char_length(code) = 3),
  CONSTRAINT chk_cc_exponent_range CHECK (exponent BETWEEN 0 AND 4)
);

COMMENT ON TABLE public.commercial_currencies IS
  'Ω3.0: sole currency/exponent authority. commercial_offers_economic_integrity() '
  'rejects any currency_code not present here, or any currency_exponent not '
  'matching this table''s exponent for that code. Not admin-editable via any '
  'RPC (controlled vocabulary) — adding a currency is a migration, not a '
  'data-entry action.';

ALTER TABLE public.commercial_currencies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cc_select_public" ON public.commercial_currencies FOR SELECT USING (true);

REVOKE ALL ON public.commercial_currencies FROM anon, authenticated;
GRANT SELECT ON public.commercial_currencies TO anon, authenticated;
GRANT ALL    ON public.commercial_currencies TO service_role;

INSERT INTO public.commercial_currencies (code, exponent) VALUES
  ('TZS', 0),
  ('USD', 2),
  ('KES', 2),
  ('UGX', 0),
  ('GBP', 2),
  ('EUR', 2)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE public.commercial_platform_state (
  id          BOOLEAN     NOT NULL DEFAULT true,
  state       TEXT        NOT NULL DEFAULT 'PAYMENTS_DISABLED',
  updated_by  UUID        NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason      TEXT        NULL,

  CONSTRAINT commercial_platform_state_pk PRIMARY KEY (id),
  CONSTRAINT chk_cps_singleton CHECK (id),
  CONSTRAINT chk_cps_state_vocabulary CHECK (state IN ('PAYMENTS_DISABLED','SANDBOX_ONLY','LIVE_ACCEPTANCE','CUSTOMER_PAYMENTS_ENABLED')),
  CONSTRAINT fk_cps_updated_by FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.commercial_platform_state IS
  'Ω3.0: singleton live-acceptance gate. Sole write path is '
  'admin_transition_platform_state (SECURITY DEFINER, is_commercial_admin() '
  'gated). commercial-create-checkout reads this via its own service_role '
  'client, bypassing RLS entirely — the SELECT policy below only matters '
  'for a browser-originated authenticated read. Starts at PAYMENTS_DISABLED, '
  'matching current real-world state exactly — zero behavior change on '
  'deploy of this migration alone.';

ALTER TABLE public.commercial_platform_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cps_select_admin_only" ON public.commercial_platform_state
  FOR SELECT USING (public.is_commercial_admin());

REVOKE ALL ON public.commercial_platform_state FROM anon, authenticated;
GRANT SELECT ON public.commercial_platform_state TO authenticated;
GRANT ALL    ON public.commercial_platform_state TO service_role;

INSERT INTO public.commercial_platform_state (id, state)
VALUES (true, 'PAYMENTS_DISABLED')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.commercial_offers
  ADD COLUMN effective_range TSTZRANGE GENERATED ALWAYS AS (
    tstzrange(effective_start, effective_end, '[)')
  ) STORED;

ALTER TABLE public.commercial_offers
  ADD COLUMN effective_history_protected BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.commercial_offers
  ADD COLUMN request_fingerprint TEXT NULL;

COMMENT ON COLUMN public.commercial_offers.effective_history_protected IS
  'One-way ratchet: false->true only when a row is or becomes purchasable '
  '(new rows) or unconditionally at this migration''s own classification '
  'step (legacy rows); true->false is permanently forbidden, enforced by '
  'trg_commercial_offers_effective_history_ratchet, which recomputes this '
  'column unconditionally from trusted inputs and never trusts a caller''s '
  'own supplied value for it. Governs the sole predicate of '
  'excl_co_no_overlapping_purchasable_periods below.';

UPDATE public.commercial_offers SET effective_history_protected = true;

DO $$
DECLARE
  v_total      INTEGER;
  v_classified INTEGER;
BEGIN
  SELECT count(*) INTO v_total FROM public.commercial_offers;
  SELECT count(*) INTO v_classified
    FROM public.commercial_offers WHERE effective_history_protected;
  IF v_classified != v_total THEN
    RAISE EXCEPTION 'LEGACY_CLASSIFICATION_INCOMPLETE: classified % of % legacy rows — migration aborted, no exclusion constraint installed', v_classified, v_total;
  END IF;
END $$;

DO $$
DECLARE
  v_conflict_count INTEGER;
BEGIN
  SELECT count(*) INTO v_conflict_count
    FROM public.commercial_offers a
    JOIN public.commercial_offers b ON
      a.id < b.id
      AND a.plan_id                = b.plan_id
      AND a.market_code            = b.market_code
      AND a.currency_code          = b.currency_code
      AND a.billing_interval       = b.billing_interval
      AND a.billing_interval_count = b.billing_interval_count
      AND a.effective_range && b.effective_range
   WHERE a.effective_history_protected AND b.effective_history_protected;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'LEGACY_EFFECTIVE_RANGE_CONFLICTS_DETECTED: % conflicting protected-row pairs found across the full five-dimensional family key — reconcile the underlying data and retry this migration; the exclusion constraint has NOT been installed', v_conflict_count;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.commercial_offers_effective_history_ratchet()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.effective_history_protected := NEW.is_purchasable;
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.effective_history_protected := OLD.effective_history_protected OR NEW.is_purchasable;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_commercial_offers_effective_history_ratchet
  BEFORE INSERT OR UPDATE ON public.commercial_offers
  FOR EACH ROW EXECUTE FUNCTION public.commercial_offers_effective_history_ratchet();

REVOKE ALL ON FUNCTION public.commercial_offers_effective_history_ratchet() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.commercial_offers_economic_integrity()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_registry_exponent SMALLINT;
BEGIN
  SELECT exponent INTO v_registry_exponent
    FROM public.commercial_currencies
   WHERE code = NEW.currency_code AND is_supported;

  IF v_registry_exponent IS NULL THEN
    RAISE EXCEPTION 'CURRENCY_NOT_SUPPORTED: %', NEW.currency_code USING ERRCODE = '22023';
  END IF;

  IF NEW.currency_exponent != v_registry_exponent THEN
    RAISE EXCEPTION 'CURRENCY_EXPONENT_MISMATCH: currency % requires exponent %, got %',
      NEW.currency_code, v_registry_exponent, NEW.currency_exponent USING ERRCODE = '22023';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.currency_code           IS DISTINCT FROM OLD.currency_code
    OR NEW.amount_minor            IS DISTINCT FROM OLD.amount_minor
    OR NEW.currency_exponent       IS DISTINCT FROM OLD.currency_exponent
    OR NEW.billing_interval        IS DISTINCT FROM OLD.billing_interval
    OR NEW.billing_interval_count  IS DISTINCT FROM OLD.billing_interval_count
    OR NEW.plan_id                 IS DISTINCT FROM OLD.plan_id
    OR NEW.market_code             IS DISTINCT FROM OLD.market_code
    THEN
      RAISE EXCEPTION 'OFFER_ECONOMICS_IMMUTABLE: create a new offer_code instead of mutating %',
        OLD.offer_code USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_commercial_offers_economic_integrity
  BEFORE INSERT OR UPDATE ON public.commercial_offers
  FOR EACH ROW EXECUTE FUNCTION public.commercial_offers_economic_integrity();

REVOKE ALL ON FUNCTION public.commercial_offers_economic_integrity() FROM PUBLIC, anon, authenticated;

DROP INDEX IF EXISTS public.uq_co_current_offer;
CREATE UNIQUE INDEX uq_co_current_offer
  ON public.commercial_offers (plan_id, market_code, currency_code, billing_interval, billing_interval_count)
  WHERE is_active AND is_purchasable AND effective_end IS NULL;

ALTER TABLE public.commercial_offers
  ADD CONSTRAINT excl_co_no_overlapping_purchasable_periods
    EXCLUDE USING gist (
      plan_id                WITH =,
      market_code            WITH =,
      currency_code          WITH =,
      billing_interval       WITH =,
      billing_interval_count WITH =,
      effective_range        WITH &&
    ) WHERE (effective_history_protected);

ALTER TABLE public.commercial_catalog_audit_events
  DROP CONSTRAINT chk_ccae_entity_type;
ALTER TABLE public.commercial_catalog_audit_events
  ADD CONSTRAINT chk_ccae_entity_type CHECK (entity_type IN ('OFFER','PLAN','ADMIN','PRODUCT','PLATFORM_STATE'));

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

EXCEPTION
  WHEN exclusion_violation THEN
    DECLARE v_constraint_name TEXT;
    BEGIN
      GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
      IF v_constraint_name = 'excl_co_no_overlapping_purchasable_periods' THEN
        RAISE EXCEPTION 'OFFER_EFFECTIVE_PERIOD_CONFLICT: % overlaps an existing purchasable offer for this family', p_offer_code
          USING ERRCODE = '23P01';
      ELSE
        RAISE;
      END IF;
    END;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_supersede_commercial_offer(
  p_old_offer_code TEXT,
  p_new_offer_code TEXT, p_plan_code TEXT, p_market_code TEXT, p_currency_code TEXT,
  p_amount_minor BIGINT, p_currency_exponent SMALLINT,
  p_billing_interval TEXT, p_billing_interval_count SMALLINT,
  p_effective_start TIMESTAMPTZ, p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog AS $$
DECLARE
  v_fingerprint      TEXT;
  v_existing         RECORD;
  v_plan_id          UUID;
  v_old              RECORD;
  v_new_id           UUID;
  v_constraint_name  TEXT;
BEGIN
  IF NOT public.is_commercial_admin() THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_new_offer_code IS NULL OR trim(p_new_offer_code) = '' THEN
    RAISE EXCEPTION 'NEW_OFFER_CODE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  SELECT id INTO v_plan_id FROM public.commercial_plans WHERE code = p_plan_code;
  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_PLAN_CODE: %', p_plan_code USING ERRCODE = '22023';
  END IF;

  v_fingerprint := encode(digest(
    convert_to(
      jsonb_build_object(
        'v', 1,
        'old_offer_code', p_old_offer_code,
        'plan_code', p_plan_code,
        'market_code', p_market_code,
        'currency_code', p_currency_code,
        'billing_interval', p_billing_interval,
        'billing_interval_count', p_billing_interval_count,
        'amount_minor', p_amount_minor,
        'currency_exponent', p_currency_exponent,
        'effective_start_utc', to_char(p_effective_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      )::TEXT,
      'UTF8'
    ),
    'sha256'), 'hex');

  SELECT id, request_fingerprint INTO v_existing
    FROM public.commercial_offers WHERE offer_code = p_new_offer_code;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: offer_code % already exists with different parameters', p_new_offer_code
        USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('offer_id', v_existing.id, 'offer_code', p_new_offer_code, 'replay', true);
  END IF;

  IF p_old_offer_code IS NOT NULL THEN
    SELECT * INTO v_old FROM public.commercial_offers
      WHERE offer_code = p_old_offer_code
      FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'OLD_OFFER_NOT_FOUND: %', p_old_offer_code USING ERRCODE = '22023';
    END IF;

    SELECT id, request_fingerprint INTO v_existing
      FROM public.commercial_offers WHERE offer_code = p_new_offer_code;
    IF FOUND THEN
      IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: offer_code % already exists with different parameters', p_new_offer_code
          USING ERRCODE = '22023';
      END IF;
      RETURN jsonb_build_object('offer_id', v_existing.id, 'offer_code', p_new_offer_code, 'replay', true);
    END IF;

    IF v_old.effective_end IS NOT NULL OR NOT v_old.is_purchasable THEN
      RAISE EXCEPTION 'OLD_OFFER_NOT_SUPERSEDABLE: % is already retired or superseded', p_old_offer_code
        USING ERRCODE = '22023';
    END IF;

    IF v_old.plan_id != v_plan_id
       OR v_old.market_code != p_market_code
       OR v_old.currency_code != p_currency_code
       OR v_old.billing_interval != p_billing_interval
       OR v_old.billing_interval_count != p_billing_interval_count
    THEN
      RAISE EXCEPTION 'OFFER_FAMILY_MISMATCH: % is not in the same offer family as %', p_new_offer_code, p_old_offer_code
        USING ERRCODE = '22023';
    END IF;

    IF p_effective_start <= v_old.effective_start THEN
      RAISE EXCEPTION 'INVALID_EFFECTIVE_BOUNDARY: successor effective_start (%) must be strictly after predecessor effective_start (%)',
        p_effective_start, v_old.effective_start USING ERRCODE = '22023';
    END IF;

    UPDATE public.commercial_offers
       SET effective_end = p_effective_start, is_purchasable = false
     WHERE id = v_old.id;
  END IF;

  INSERT INTO public.commercial_offers (
    offer_code, plan_id, market_code, currency_code, amount_minor, currency_exponent,
    billing_interval, billing_interval_count, effective_start, is_active, is_purchasable,
    request_fingerprint
  ) VALUES (
    p_new_offer_code, v_plan_id, p_market_code, p_currency_code, p_amount_minor, p_currency_exponent,
    p_billing_interval, p_billing_interval_count, p_effective_start, true, true, v_fingerprint
  ) RETURNING id INTO v_new_id;

  INSERT INTO public.commercial_catalog_audit_events (
    actor_user_id, action, entity_type, entity_id, previous_state, new_state, reason
  ) VALUES (
    auth.uid(), 'OFFER_CREATED', 'OFFER', v_new_id, NULL,
    jsonb_build_object('offer_code', p_new_offer_code, 'superseded', p_old_offer_code), p_reason
  );

  RETURN jsonb_build_object('offer_id', v_new_id, 'offer_code', p_new_offer_code, 'replay', false);

EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name = 'uq_co_offer_code' THEN
      SELECT id, request_fingerprint INTO v_existing
        FROM public.commercial_offers WHERE offer_code = p_new_offer_code;
      IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: offer_code % already exists with different parameters', p_new_offer_code
          USING ERRCODE = '22023';
      END IF;
      RETURN jsonb_build_object('offer_id', v_existing.id, 'offer_code', p_new_offer_code, 'replay', true);
    ELSE
      RAISE;
    END IF;
  WHEN exclusion_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name = 'excl_co_no_overlapping_purchasable_periods' THEN
      RAISE EXCEPTION 'OFFER_EFFECTIVE_PERIOD_CONFLICT: % overlaps an existing purchasable offer for this family', p_new_offer_code
        USING ERRCODE = '23P01';
    ELSE
      RAISE;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_supersede_commercial_offer(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,SMALLINT,TEXT,SMALLINT,TIMESTAMPTZ,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_supersede_commercial_offer(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,SMALLINT,TEXT,SMALLINT,TIMESTAMPTZ,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_transition_platform_state(
  p_new_state TEXT,
  p_reason    TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  c_platform_state_entity_id CONSTANT UUID := '4056be2d-92cb-56eb-9ef4-c11e13579b94';
  v_user_id  UUID := auth.uid();
  v_previous RECORD;
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
  IF p_new_state NOT IN ('PAYMENTS_DISABLED','SANDBOX_ONLY','LIVE_ACCEPTANCE','CUSTOMER_PAYMENTS_ENABLED') THEN
    RAISE EXCEPTION 'INVALID_PLATFORM_STATE: %', p_new_state USING ERRCODE = '22023';
  END IF;

  SELECT state INTO STRICT v_previous
    FROM public.commercial_platform_state
   WHERE id = true
   FOR UPDATE;

  UPDATE public.commercial_platform_state
     SET state = p_new_state, updated_by = v_user_id, updated_at = now(), reason = p_reason
   WHERE id = true;

  INSERT INTO public.commercial_catalog_audit_events (
    actor_user_id, action, entity_type, entity_id, previous_state, new_state, reason
  ) VALUES (
    v_user_id, 'PLATFORM_STATE_TRANSITIONED', 'PLATFORM_STATE', c_platform_state_entity_id,
    jsonb_build_object('state', v_previous.state),
    jsonb_build_object('state', p_new_state),
    p_reason
  );

  RETURN jsonb_build_object('state', p_new_state, 'previous_state', v_previous.state);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_transition_platform_state(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_transition_platform_state(TEXT, TEXT) TO authenticated;