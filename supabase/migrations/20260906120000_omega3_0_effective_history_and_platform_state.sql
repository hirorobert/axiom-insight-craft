-- Ω3.0 — Effective-History Hardening + Currency Registry + Platform-State
-- Machine (Foundation phase of SAFF-OMEGA3-COMMERCIAL-LAUNCH-DESIGN.md,
-- approved design checkpoint commit
-- 24595a09053bb2181b57778d0c1a2b9805c44850).
--
-- Forward-only, non-data-destructive, transactional. Does not edit any
-- live Ω1/RLS1/Ω2 migration file. Two DDL-replacement operations are
-- included (Category 3 below) — each a DROP immediately followed by an
-- equivalent-or-wider CREATE/ADD in this same transaction, never
-- described as "purely additive."
--
-- DATA_DESTRUCTIVE_OPERATIONS = 0
-- DDL_REPLACEMENT_OPERATIONS  = 2 (uq_co_current_offer; chk_ccae_entity_type)

SET search_path TO public, pg_catalog;

-- ============================================================
-- 1. Currency registry (§G.2) — sole exponent authority
-- ============================================================

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

-- ============================================================
-- 2. Platform-state machine (§K.2) — DB-authoritative live gate,
--    orthogonal to which Flutterwave secret key is deployed.
-- ============================================================

CREATE TABLE public.commercial_platform_state (
  id          BOOLEAN     NOT NULL DEFAULT true,  -- singleton row pattern
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

-- The singleton row must exist before admin_transition_platform_state can
-- ever succeed (it locks and UPDATEs this row; it never creates it).
INSERT INTO public.commercial_platform_state (id, state)
VALUES (true, 'PAYMENTS_DISABLED')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 3. commercial_offers hardening — new columns (§E.2, §G.2)
-- ============================================================

ALTER TABLE public.commercial_offers
  ADD COLUMN effective_range TSTZRANGE GENERATED ALWAYS AS (
    tstzrange(effective_start, effective_end, '[)')
  ) STORED;

-- Step A (§E.2 point 6a): add the protection column. Legacy rows are NOT
-- yet classified — the column-level DEFAULT false is a placeholder the
-- next step overwrites for every pre-existing row; it is never left
-- standing for rows that predate this migration.
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

-- ============================================================
-- 4. Legacy-row classification — fail-closed, unconditional,
--    evidence-independent (§E.2 point 6a). MUST run, in this exact
--    order, BEFORE the ratchet trigger (section 5) exists: the
--    trigger's own OLD.effective_history_protected OR NEW.is_purchasable
--    logic would otherwise discard this step's own unconditional
--    classification for any legacy row with is_purchasable = false.
-- ============================================================

-- Step B: classify EVERY pre-existing row as protected, unconditionally.
-- No WHERE clause referencing is_purchasable or any audit table.
UPDATE public.commercial_offers SET effective_history_protected = true;

-- Step C: prove classification is complete — an executable assertion.
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

-- Step D: detect five-dimensional effective-range conflicts among the
-- now-fully-protected legacy set, BEFORE the exclusion constraint exists
-- to enforce it — a human-readable diagnostic, not merely a defensive
-- duplicate of what the constraint would raise anyway.
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

-- ============================================================
-- 5. Effective-history ratchet trigger — governs rows created or
--    updated AFTER this migration only (§E.2 point 6b). Created
--    strictly after section 4's legacy classification.
-- ============================================================

CREATE OR REPLACE FUNCTION public.commercial_offers_effective_history_ratchet()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  -- NEW.effective_history_protected is never read here — whatever value a
  -- caller (RPC, service_role, hostile hand-edit) supplies for it is
  -- completely discarded and recomputed unconditionally.
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

-- ============================================================
-- 6. Economic-integrity trigger — currency/exponent registry match
--    (§G.2) + offer-economics immutability after insertion (§E.1).
--    One trigger, one enforcement point for both rules; deliberately
--    separate from the ratchet trigger above (different concern).
-- ============================================================

CREATE OR REPLACE FUNCTION public.commercial_offers_economic_integrity()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_registry_exponent SMALLINT;
BEGIN
  -- Rule 1 (§G): currency/exponent must match the registry — on every INSERT and UPDATE.
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

  -- Rule 2 (§E.1): economics are immutable once a row exists. Lifecycle
  -- fields (is_active, is_purchasable, effective_end) are deliberately
  -- excluded — pausing/retiring/closing a window is not a price change.
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

-- ============================================================
-- 7. DDL replacement #1 — uq_co_current_offer widened to the same
--    five-column family key as the new exclusion constraint below.
--    The live 3-column index does not discriminate by billing
--    interval, which would make "MONTHLY×1 and ANNUAL×1 may coexist"
--    false in the live schema even after section 8 is installed.
-- ============================================================

DROP INDEX IF EXISTS public.uq_co_current_offer;
CREATE UNIQUE INDEX uq_co_current_offer
  ON public.commercial_offers (plan_id, market_code, currency_code, billing_interval, billing_interval_count)
  WHERE is_active AND is_purchasable AND effective_end IS NULL;

-- ============================================================
-- 8. New exclusion constraint (§E.2 point 9) — the sole database-
--    native mechanism preventing overlapping historical effective
--    periods within one complete five-column offer family. Predicate
--    depends only on effective_history_protected; no mutable
--    lifecycle field of any kind participates.
-- ============================================================

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

-- ============================================================
-- 9. DDL replacement #2 — chk_ccae_entity_type widened to the final
--    five-value vocabulary. Strictly widened: every value the live
--    constraint accepts today ('OFFER','PLAN') remains accepted.
--    PLATFORM_STATE added this round (Codex code-audit Finding 1):
--    a platform-state transition mutates the singleton
--    commercial_platform_state authority, not an ADMIN-table row, and
--    must not share ADMIN's entity_type.
-- ============================================================

ALTER TABLE public.commercial_catalog_audit_events
  DROP CONSTRAINT chk_ccae_entity_type;
ALTER TABLE public.commercial_catalog_audit_events
  ADD CONSTRAINT chk_ccae_entity_type CHECK (entity_type IN ('OFFER','PLAN','ADMIN','PRODUCT','PLATFORM_STATE'));

-- ------------------------------------------------------------
-- Canonical platform-state singleton entity identity (Finding 1).
--
-- commercial_catalog_audit_events.entity_id is NOT NULL UUID with no
-- natural row-level UUID to reference for a singleton, BOOLEAN-keyed
-- table. A per-request or per-admin UUID would misidentify the actor
-- as the entity (the original defect) or vary run-to-run, breaking
-- "the same authority is being mutated" traceability across
-- transitions and administrators.
--
-- This literal is a UUIDv5 (RFC 4122 section 4.3), namespace =
-- the standard NAMESPACE_URL (6ba7b811-9dad-11d1-80b4-00c04fd430c8),
-- name = 'saff:commercial_platform_state:singleton:v1'. It is
-- deterministic (computed offline, not at runtime), constant across
-- every environment and every transition, and depends on neither
-- deployment time nor current state. Cross-verified against two
-- independent RFC-4122 v5 implementations (Node.js manual SHA-1
-- construction and Python's uuid.uuid5(uuid.NAMESPACE_URL, ...)) —
-- both produced the identical value below.
-- ------------------------------------------------------------

-- ============================================================
-- 10. admin_upsert_commercial_offer — narrow, constraint-name-
--     verified exclusion-error translation added to the existing,
--     unchanged live body (Ω2, 20260906083524...:180-262). Zero
--     other change: currency/immutability are already fully enforced
--     by the trigger above, transparently, with no RPC-body change
--     needed for those two rules.
-- ============================================================

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

-- CREATE OR REPLACE preserves this function's existing GRANTs
-- (authenticated EXECUTE, PUBLIC/anon revoked) — no re-grant needed.

-- ============================================================
-- 11. admin_supersede_commercial_offer (new RPC, §E.2 point 13) —
--     the full required sequence: authority -> canonicalization ->
--     fingerprint -> pre-lock idempotency check -> predecessor lock
--     -> zero-row/eligibility/family/boundary validation -> post-lock
--     idempotency recheck -> atomic close-and-create -> durable
--     result -> narrow, named-only error translation.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_supersede_commercial_offer(
  p_old_offer_code TEXT,            -- NULL only when opening a brand-new family
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
  -- STEP 1: validate caller authority.
  IF NOT public.is_commercial_admin() THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;

  -- STEP 2: validate and canonicalize the complete request.
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

  -- STEP 3: calculate the canonical request fingerprint. Fingerprint
  -- contract v1 — a versioned, structured JSONB payload, never
  -- delimiter concatenation:
  --   (a) NULL vs. empty-string vs. absent is never conflated —
  --       concat_ws silently drops NULL positions entirely;
  --       jsonb_build_object preserves a genuine JSON `null`, distinct
  --       from `""`, for every field.
  --   (b) field boundaries are structural, not textual — every value is
  --       a properly quoted/escaped JSON string (or number), so an
  --       embedded '|', quote, backslash, or arbitrary Unicode
  --       character inside any text parameter can never be
  --       misinterpreted as a field boundary or collide with another
  --       field's content. jsonb's own JSON-text escaping (not this
  --       migration's own logic) is what guarantees this.
  --   (c) the timestamp is rendered via an explicit UTC conversion +
  --       fixed to_char numeric-only format template (no locale-
  --       dependent month/day names, so no lc_time dependency either)
  --       — never a bare TIMESTAMPTZ::TEXT cast, whose output depends
  --       on the session's TimeZone GUC. AT TIME ZONE 'UTC' first
  --       normalizes the instant to UTC wall-clock time, so the
  --       identical instant hashes identically regardless of the
  --       calling connection's TimeZone setting; a literal trailing
  --       "Z" is embedded IN the formatted value itself (ISO-8601 Zulu
  --       notation), and the field is additionally named
  --       '..._utc' — two independent, unambiguous UTC markers, one in
  --       the value, one in the field contract. Microsecond precision
  --       ('.US') means two effective_start values differing only by
  --       one microsecond hash differently.
  --   (d) amount_minor/currency_exponent/billing_interval_count are
  --       emitted as genuine JSON numbers, not text — jsonb's numeric
  --       serialization is a fixed machine format, never affected by
  --       lc_numeric (no thousands separators, no decimal comma).
  --   (e) UTF-8 conversion to bytea is explicit via convert_to(...,
  --       'UTF8') before digest() — not an implicit text->bytea cast
  --       that would otherwise depend on the database's own encoding
  --       setting.
  --   (f) the idempotency KEY (p_new_offer_code) and the free-text
  --       p_reason remain excluded from the payload, exactly as
  --       originally approved — the key is not part of its own
  --       payload, and a differing justification for an otherwise-
  --       identical economic request is not a differing request.
  -- jsonb_build_object's own on-disk key ordering is by (length, then
  -- lexicographic value), not call-site order, so the ::text
  -- serialization below is already canonical/deterministic regardless
  -- of how the object literal is written.
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

  -- STEPS 4-6: pre-lock idempotency check (cheap fast path — a pure
  -- replay never needs to lock the predecessor at all).
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
    -- STEPS 7-8: resolve AND LOCK the predecessor. This BLOCKS a second
    -- transaction naming the same predecessor — it does not race it.
    SELECT * INTO v_old FROM public.commercial_offers
      WHERE offer_code = p_old_offer_code
      FOR UPDATE;

    -- STEP 9: zero rows found.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'OLD_OFFER_NOT_FOUND: %', p_old_offer_code USING ERRCODE = '22023';
    END IF;

    -- STEP 10: post-lock idempotency RECHECK. While this transaction was
    -- blocked waiting for the lock above, a concurrent, identical request
    -- may have already committed the entire supersession.
    SELECT id, request_fingerprint INTO v_existing
      FROM public.commercial_offers WHERE offer_code = p_new_offer_code;
    IF FOUND THEN
      IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: offer_code % already exists with different parameters', p_new_offer_code
          USING ERRCODE = '22023';
      END IF;
      RETURN jsonb_build_object('offer_id', v_existing.id, 'offer_code', p_new_offer_code, 'replay', true);
    END IF;

    -- STEPS 11-12: predecessor eligibility. It must still be the open,
    -- current version of its family — not already closed by a DIFFERENT
    -- successor (step 10 above already returned if it was closed by
    -- THIS same request's own retry).
    IF v_old.effective_end IS NOT NULL OR NOT v_old.is_purchasable THEN
      RAISE EXCEPTION 'OLD_OFFER_NOT_SUPERSEDABLE: % is already retired or superseded', p_old_offer_code
        USING ERRCODE = '22023';
    END IF;

    -- STEPS 13-14: same complete offer-family identity as §E.2 point 1
    -- (five columns), predecessor vs. successor.
    IF v_old.plan_id != v_plan_id
       OR v_old.market_code != p_market_code
       OR v_old.currency_code != p_currency_code
       OR v_old.billing_interval != p_billing_interval
       OR v_old.billing_interval_count != p_billing_interval_count
    THEN
      RAISE EXCEPTION 'OFFER_FAMILY_MISMATCH: % is not in the same offer family as %', p_new_offer_code, p_old_offer_code
        USING ERRCODE = '22023';
    END IF;

    -- STEP 15: boundary validation. Because this function uses a SINGLE
    -- parameter (p_effective_start) as BOTH the value written to the
    -- predecessor's effective_end AND the value written to the
    -- successor's effective_start, successor.effective_start =
    -- predecessor.effective_end is structurally guaranteed, not merely
    -- checked. What genuinely must be validated is that this shared
    -- boundary is not degenerate (retroactively at-or-before the
    -- predecessor's own start):
    IF p_effective_start <= v_old.effective_start THEN
      RAISE EXCEPTION 'INVALID_EFFECTIVE_BOUNDARY: successor effective_start (%) must be strictly after predecessor effective_start (%)',
        p_effective_start, v_old.effective_start USING ERRCODE = '22023';
    END IF;

    -- STEP 16 (predecessor half): close the predecessor — lifecycle-only,
    -- permitted by commercial_offers_economic_integrity();
    -- effective_history_protected is untouched (already true,
    -- permanently, via the ratchet).
    UPDATE public.commercial_offers
       SET effective_end = p_effective_start, is_purchasable = false
     WHERE id = v_old.id;
  END IF;

  -- STEP 16 (successor half): same transaction as the predecessor closure
  -- immediately above (or the sole write, if p_old_offer_code IS NULL).
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

  -- STEP 17: durable successor identity + transition result.
  RETURN jsonb_build_object('offer_id', v_new_id, 'offer_code', p_new_offer_code, 'replay', false);

EXCEPTION
  -- STEPS 18-19: catching the broad PostgreSQL condition NAMES
  -- (unique_violation, exclusion_violation) is not, by itself, proof of
  -- WHICH constraint fired. GET STACKED DIAGNOSTICS reads the ACTUAL
  -- constraint name PostgreSQL attached to the error, and only an EXACT
  -- match against the one named constraint this handler exists for is
  -- translated. Anything else is re-raised with a bare `RAISE;`, which
  -- propagates the original exception completely unchanged.
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name = 'uq_co_offer_code' THEN
      -- Lost the race: a concurrent identical (or conflicting) call
      -- committed p_new_offer_code first. Re-run the same comparison
      -- against what actually landed.
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

-- ============================================================
-- 12. admin_transition_platform_state (new RPC, §K.2) — bare,
--     state-storage-only in Ω3.0. Mechanical go-live preconditions
--     (live key configured, a purchasable offer exists) are added in
--     Ω3.7 via CREATE OR REPLACE on this same function; not in scope
--     here.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_transition_platform_state(
  p_new_state TEXT,
  p_reason    TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  -- Canonical, constant identity of the singleton platform-state
  -- authority itself — never an administrator's own id. Same UUID
  -- literal documented above the chk_ccae_entity_type widening (§9);
  -- identical for every transition, every administrator, every
  -- environment. UUIDv5(NAMESPACE_URL, 'saff:commercial_platform_state:singleton:v1').
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

  -- Row lock on the singleton. The row is seeded by this same migration
  -- (section 2) and is never created by this RPC. STRICT makes this a
  -- native, uncaught PL/pgSQL failure if the singleton is ever absent
  -- (no_data_found, SQLSTATE P0002) or somehow duplicated
  -- (too_many_rows, P0003) — a missing/duplicated singleton is a broken
  -- database invariant, not a normal domain outcome, so it is
  -- deliberately NOT wrapped in its own IF/RAISE EXCEPTION domain error:
  -- there is no handler here to catch, translate, or swallow it, and no
  -- path that could proceed to the UPDATE or the audit INSERT below if
  -- it fires.
  SELECT state INTO STRICT v_previous
    FROM public.commercial_platform_state
   WHERE id = true
   FOR UPDATE;

  UPDATE public.commercial_platform_state
     SET state = p_new_state, updated_by = v_user_id, updated_at = now(), reason = p_reason
   WHERE id = true;

  -- entity_type='PLATFORM_STATE', entity_id=the canonical singleton
  -- constant (never v_user_id) — actor_user_id alone identifies WHO
  -- acted; entity_id identifies WHAT authority was mutated. No
  -- EXCEPTION block exists in this function (matching
  -- admin_upsert_commercial_product's own precedent): if this INSERT
  -- fails for any reason, the uncaught exception aborts the whole
  -- transaction and the state UPDATE above is rolled back with it.
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
