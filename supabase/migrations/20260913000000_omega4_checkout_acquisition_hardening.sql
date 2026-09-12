-- Ω∞ A+ — CFOClose Ω3-CHECKOUT final closure hardening.
--
-- Codex independent re-audit of PR #15 @ b82f324b055e2ce52c6afffc834b87d93f9ea286
-- returned NO-GO on 4 BLOCKER + 4 HIGH findings not covered by the prior
-- audit-fix round. This migration is the DB half of the closure. Forward-
-- only: no historical (already-live) migration file is edited. Builds on
-- 20260912100000 (same unmerged branch/PR — its unsafe primitives are
-- retired here via expand -> cutover -> contract, exactly like that
-- migration retired the Ω2-G ones before it).
--
-- What this migration does:
--   1. payment_checkout_intents gains product_id (snapshotted FK, closing
--      the "monthly + annual are different offer_ids so both are
--      simultaneously acquirable" gap), creation_token (fencing token for
--      provider-result CAS), and verification-claim columns (durable
--      per-intent recovery throttle — no in-process rate limiting).
--   2. Status vocabulary is corrected: CREATED -> CREATING (a real state
--      rename — no row has ever existed under either name in a live
--      database) and MANUAL_REVIEW is added for a provider outcome that is
--      genuinely uncertain (e.g. a network timeout after Flutterwave may
--      or may not have created a real charge) and must never be
--      automatically superseded by a fresh attempt.
--   3. The customer+offer partial unique index from 20260912100000 is
--      retired and replaced with a customer+PRODUCT partial unique index
--      — the actual boundary the Marshall Plan needs: one payable attempt
--      per customer per PRODUCT, not per offer, so a monthly and annual
--      checkout for the same product can never both be payable at once.
--   4. acquire_checkout_attempt() is the sole, atomic, DB-authoritative
--      entry point for starting or reusing a checkout attempt. It never
--      makes a network call itself; it returns a fencing creation_token
--      to the ONE caller permitted to attempt a provider checkout for that
--      row.
--   5. persist_checkout_provider_result() is a compare-and-swap: it
--      commits a provider's checkout URL onto an intent ONLY if that exact
--      row is still CREATING under that exact creation_token. Zero rows
--      affected is a real, checked failure — the Edge Function is
--      structurally unable to return a checkout URL that was not
--      durably persisted.
--   6. mark_checkout_attempt_failed() / mark_checkout_attempt_uncertain()
--      are the only other token-fenced transitions out of CREATING —
--      "definitely no charge happened" vs "genuinely unknown," the latter
--      landing in MANUAL_REVIEW rather than being silently retried.
--   7. commercial_live_acceptance_allowlist is a new, dedicated table
--      (distinct from commercial_admins, which governs catalog authority,
--      not payment-acceptance-testing eligibility) enforced by
--      assert_platform_state_permits(), the single authoritative
--      implementation of the platform-state x provider-environment x
--      acceptance-identity matrix. Called from acquire_checkout_attempt()
--      or a NEW checkout attempt is never created.
--   8. commit_verified_commercial_payment (same 13-arg signature —
--      CREATE OR REPLACE only, no new expand/contract needed) now:
--        - re-checks payment_events idempotency AFTER taking the
--          customer-level advisory lock, not before;
--        - rejects a blank/whitespace provider_transaction_id outright;
--        - accepts PENDING or MANUAL_REVIEW intents (a manually
--          reconciled MANUAL_REVIEW intent can still be honoured if
--          independent verification later succeeds — "never
--          automatically superseded" governs NEW attempts, not a
--          legitimate late verification of the SAME attempt).
--   9. claim_verification_attempt() gives commercial-payment-status's POST
--      recovery path a durable, row-locked, per-intent throttle — no
--      unbounded browser-triggered Flutterwave API traffic.
--  10. Offer-seed binding is re-asserted in full (product/plan ownership,
--      market, currency, amount, exponent, interval, interval count,
--      provider_restriction, active/purchasable state, effective-period
--      validity, no duplicate authoritative family) — not merely the
--      economics-only check from 20260912100000. Aborts with a named
--      diagnostic identifying exactly which field disagrees and which
--      product/plan the conflicting row actually belongs to.
--  11. admin_upsert_commercial_offer (same 12-arg signature) additionally
--      refuses to silently repoint an existing offer_code's market or
--      billing_interval — an update must match the row's own identity on
--      every axis, not just plan/product.
--
-- Explicitly NOT done here: re-deriving the CURRENT commercial_platform_
-- state as a gate on an already-independently-verified, already-charged
-- payment at commit time. Doing so would recreate exactly the BLOCKER-1
-- "charge without licence" failure mode the prior audit-fix round closed,
-- via a different door (an admin flipping platform state after a
-- legitimate payment was already collected). What IS re-validated at
-- commit is internal consistency — the verification's own provider_
-- environment must still equal the value snapshotted on the intent at
-- acquisition time — which is the actual anti-corruption invariant the
-- matrix exists to protect, without depending on platform state remaining
-- unchanged for the lifetime of an in-flight payment.
--
-- Does not activate checkout, change commercial_platform_state's live
-- value, or make any offer purchasable. Does not touch PR #14.

SET search_path TO public, pg_catalog;

-- ============================================================
-- 1. payment_checkout_intents — new columns
-- ============================================================

ALTER TABLE public.payment_checkout_intents
  ADD COLUMN product_id UUID NULL,
  ADD COLUMN creation_token UUID NULL,
  ADD COLUMN last_verification_attempt_at TIMESTAMPTZ NULL,
  ADD COLUMN verification_claimed_until   TIMESTAMPTZ NULL;

-- Backfill product_id for any pre-existing row (none in any real
-- deployment — checkout has never been live — but this keeps the
-- migration correct if a sandbox/test database already has rows).
UPDATE public.payment_checkout_intents pci
   SET product_id = cp.product_id
  FROM public.commercial_plans cp
 WHERE pci.plan_id = cp.id
   AND pci.product_id IS NULL;

DO $$
DECLARE
  v_missing INTEGER;
BEGIN
  SELECT count(*) INTO v_missing FROM public.payment_checkout_intents WHERE product_id IS NULL;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'PCI_PRODUCT_ID_BACKFILL_INCOMPLETE: % row(s) could not resolve product_id via plan_id', v_missing;
  END IF;
END $$;

ALTER TABLE public.payment_checkout_intents
  ALTER COLUMN product_id SET NOT NULL,
  ADD CONSTRAINT fk_pci_product FOREIGN KEY (product_id) REFERENCES public.commercial_products(id) ON DELETE RESTRICT;

CREATE INDEX idx_pci_billing_customer_product ON public.payment_checkout_intents (billing_customer_id, product_id, created_at DESC);

COMMENT ON COLUMN public.payment_checkout_intents.product_id IS
  'Ω∞ A+ closure: snapshotted at acquisition time. The atomic acquisition '
  'boundary is (billing_customer_id, product_id) — NOT commercial_offer_id '
  '— so a MONTHLY and ANNUAL offer under the same product can never both '
  'be payable for the same customer at once.';

COMMENT ON COLUMN public.payment_checkout_intents.creation_token IS
  'Ω∞ A+ closure: fencing token minted by acquire_checkout_attempt() for a '
  'NEW attempt (status=CREATING). persist_checkout_provider_result(), '
  'mark_checkout_attempt_failed() and mark_checkout_attempt_uncertain() '
  'all require an exact (id, creation_token, status=''CREATING'') match — '
  'a stale worker holding an old or wrong token can never mutate a row a '
  'newer attempt has already superseded.';

COMMENT ON COLUMN public.payment_checkout_intents.verification_claimed_until IS
  'Ω∞ A+ closure: durable, row-locked throttle for the POST recovery path '
  'in commercial-payment-status. claim_verification_attempt() is the sole '
  'writer. Never relies on Edge Function process memory for rate limiting.';

-- ============================================================
-- 2. Status vocabulary correction: CREATED -> CREATING, + MANUAL_REVIEW
-- ============================================================

-- No row has ever existed under 'CREATED' in any live database (checkout
-- has never been deployed) — this UPDATE is a correctness safety net for
-- a sandbox/test database only, not a production data migration.
UPDATE public.payment_checkout_intents SET status = 'CREATING' WHERE status = 'CREATED';

ALTER TABLE public.payment_checkout_intents DROP CONSTRAINT chk_pci_status;
ALTER TABLE public.payment_checkout_intents ADD CONSTRAINT chk_pci_status CHECK (
  status IN ('CREATING','PENDING','SUCCEEDED','FAILED','CANCELLED','EXPIRED','MANUAL_REVIEW')
);

ALTER TABLE public.payment_checkout_intents ALTER COLUMN status SET DEFAULT 'CREATING';

COMMENT ON COLUMN public.payment_checkout_intents.status IS
  'Ω∞ A+ closure: CREATING (attempt acquired, provider not yet called or '
  'result not yet persisted) -> PENDING (provider checkout durably '
  'persisted) -> SUCCEEDED | FAILED | CANCELLED | EXPIRED, or -> '
  'MANUAL_REVIEW when the provider outcome is genuinely uncertain (never '
  'automatically superseded by a new attempt).';

-- ============================================================
-- 3. Atomic acquisition boundary: customer + PRODUCT, not customer + offer
-- ============================================================

-- Preflight: no pre-existing row may already violate the new boundary.
DO $$
DECLARE
  v_conflict RECORD;
  v_conflict_count INTEGER;
BEGIN
  SELECT count(*) INTO v_conflict_count FROM (
    SELECT billing_customer_id, product_id
      FROM public.payment_checkout_intents
     WHERE status IN ('CREATING', 'PENDING', 'MANUAL_REVIEW')
     GROUP BY billing_customer_id, product_id
    HAVING count(*) > 1
  ) dupes;
  IF v_conflict_count > 0 THEN
    SELECT billing_customer_id, product_id, count(*) AS n
      INTO v_conflict
      FROM public.payment_checkout_intents
     WHERE status IN ('CREATING', 'PENDING', 'MANUAL_REVIEW')
     GROUP BY billing_customer_id, product_id
    HAVING count(*) > 1
     LIMIT 1;
    RAISE EXCEPTION 'PRE_EXISTING_OPEN_INTENT_PRODUCT_DUPLICATES_FOUND: % conflicting (billing_customer_id, product_id) group(s) exist — example: billing_customer_id=%, product_id=%, count=%. Resolve before this migration can safely add the unique index.',
      v_conflict_count, v_conflict.billing_customer_id, v_conflict.product_id, v_conflict.n;
  END IF;
END $$;

DROP INDEX IF EXISTS public.uq_pci_one_open_intent_per_customer_offer;

CREATE UNIQUE INDEX uq_pci_one_open_intent_per_customer_product
  ON public.payment_checkout_intents (billing_customer_id, product_id)
  WHERE status IN ('CREATING', 'PENDING', 'MANUAL_REVIEW');

COMMENT ON INDEX public.uq_pci_one_open_intent_per_customer_product IS
  'Ω∞ A+ closure: at most one non-terminal (CREATING/PENDING/MANUAL_REVIEW) '
  'checkout intent may exist per (billing_customer_id, product_id) pair — '
  'closing the gap where different billing_interval offers under the same '
  'product carried different commercial_offer_id values and could '
  'therefore both be simultaneously payable under the prior '
  '(customer, offer) boundary.';

-- ============================================================
-- 4. commercial_live_acceptance_allowlist — LIVE_ACCEPTANCE eligibility
-- ============================================================

CREATE TABLE public.commercial_live_acceptance_allowlist (
  user_id     UUID        NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT true,
  reason      TEXT        NOT NULL,
  added_by    UUID        NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT commercial_live_acceptance_allowlist_pk PRIMARY KEY (user_id),
  CONSTRAINT fk_clal_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT fk_clal_added_by FOREIGN KEY (added_by) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT chk_clal_reason CHECK (trim(reason) != '')
);

COMMENT ON TABLE public.commercial_live_acceptance_allowlist IS
  'Ω∞ A+ closure: the ONLY mechanism by which a user may create a '
  'production-environment checkout while commercial_platform_state = '
  'LIVE_ACCEPTANCE. Deliberately separate from commercial_admins (catalog '
  'authority) — acceptance-testing eligibility is a distinct grant. No '
  'browser-supplied field can ever satisfy this check; membership is '
  'server-side only, written exclusively via service_role.';

ALTER TABLE public.commercial_live_acceptance_allowlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "clal_select_self_or_admin" ON public.commercial_live_acceptance_allowlist
  FOR SELECT USING (user_id = auth.uid() OR public.is_commercial_admin());

REVOKE ALL ON public.commercial_live_acceptance_allowlist FROM anon, authenticated;
GRANT SELECT ON public.commercial_live_acceptance_allowlist TO authenticated;
GRANT ALL    ON public.commercial_live_acceptance_allowlist TO service_role;

-- ============================================================
-- 5. assert_platform_state_permits — the sole matrix authority
-- ============================================================

CREATE OR REPLACE FUNCTION public.assert_platform_state_permits(
  p_provider_environment TEXT,
  p_acting_user_id       UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_state TEXT;
BEGIN
  -- Fail closed on missing/blank/unknown environment — never a silent
  -- sandbox default. The caller (acquire_checkout_attempt) always passes
  -- a value it itself validated came from the actually-selected
  -- provider's own capability declaration, never a browser field.
  IF p_provider_environment IS NULL OR p_provider_environment NOT IN ('sandbox', 'production') THEN
    RAISE EXCEPTION 'PLATFORM_STATE_MATRIX_VIOLATION: provider_environment must be exactly ''sandbox'' or ''production'', got %', p_provider_environment
      USING ERRCODE = '22023';
  END IF;

  SELECT state INTO v_state FROM public.commercial_platform_state WHERE id = true;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_STATE_MATRIX_VIOLATION: commercial_platform_state singleton row missing' USING ERRCODE = '22023';
  END IF;

  IF v_state = 'PAYMENTS_DISABLED' THEN
    RAISE EXCEPTION 'PLATFORM_STATE_MATRIX_VIOLATION: PAYMENTS_DISABLED permits no checkout attempt' USING ERRCODE = '22023';

  ELSIF v_state = 'SANDBOX_ONLY' THEN
    IF p_provider_environment != 'sandbox' THEN
      RAISE EXCEPTION 'PLATFORM_STATE_MATRIX_VIOLATION: SANDBOX_ONLY permits only sandbox, got %', p_provider_environment
        USING ERRCODE = '22023';
    END IF;

  ELSIF v_state = 'LIVE_ACCEPTANCE' THEN
    IF p_provider_environment != 'production' THEN
      RAISE EXCEPTION 'PLATFORM_STATE_MATRIX_VIOLATION: LIVE_ACCEPTANCE permits only production, got %', p_provider_environment
        USING ERRCODE = '22023';
    END IF;
    IF p_acting_user_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.commercial_live_acceptance_allowlist a
       WHERE a.user_id = p_acting_user_id AND a.active
    ) THEN
      RAISE EXCEPTION 'PLATFORM_STATE_MATRIX_VIOLATION: LIVE_ACCEPTANCE permits only explicitly allowlisted acceptance identities'
        USING ERRCODE = '22023';
    END IF;

  ELSIF v_state = 'CUSTOMER_PAYMENTS_ENABLED' THEN
    IF p_provider_environment != 'production' THEN
      RAISE EXCEPTION 'PLATFORM_STATE_MATRIX_VIOLATION: CUSTOMER_PAYMENTS_ENABLED permits only production, got %', p_provider_environment
        USING ERRCODE = '22023';
    END IF;

  ELSE
    RAISE EXCEPTION 'PLATFORM_STATE_MATRIX_VIOLATION: unknown platform state %', v_state USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_platform_state_permits(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_platform_state_permits(TEXT, UUID) TO service_role;

COMMENT ON FUNCTION public.assert_platform_state_permits(TEXT, UUID) IS
  'Ω∞ A+ closure: sole authoritative implementation of the platform-state '
  'x provider-environment x acceptance-identity matrix. RAISEs (never '
  'returns false) on any violation — callers rely on this to abort the '
  'whole acquisition transaction. service_role only.';

-- ============================================================
-- 6. acquire_checkout_attempt — atomic, token-fenced acquisition
-- ============================================================

CREATE OR REPLACE FUNCTION public.acquire_checkout_attempt(
  p_billing_customer_id    UUID,
  p_product_id             UUID,
  p_plan_id                UUID,
  p_commercial_offer_id    UUID,
  p_market_code            TEXT,
  p_currency_code          TEXT,
  p_currency_exponent      SMALLINT,
  p_amount_minor           BIGINT,
  p_billing_interval       TEXT,
  p_billing_interval_count SMALLINT,
  p_provider               TEXT,
  p_provider_environment   TEXT,
  p_created_by_user_id     UUID,
  p_saff_reference         TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing    RECORD;
  v_new_id      UUID;
  v_new_token   UUID;
  v_expires_at  TIMESTAMPTZ;
BEGIN
  IF p_billing_customer_id IS NULL OR p_product_id IS NULL OR p_created_by_user_id IS NULL THEN
    RAISE EXCEPTION 'ACQUIRE_CHECKOUT_ATTEMPT_MISSING_IDENTITY' USING ERRCODE = '22023';
  END IF;

  -- Authoritative matrix gate. Raises and aborts the whole transaction on
  -- any violation — no attempt row is ever created for a disallowed
  -- platform-state/environment/identity combination.
  PERFORM public.assert_platform_state_permits(p_provider_environment, p_created_by_user_id);

  -- Serializes every acquisition for this exact (customer, product) pair.
  -- Taken BEFORE reading any existing row so two concurrent callers can
  -- never both observe "no existing row" and both insert.
  PERFORM pg_advisory_xact_lock(hashtext(p_billing_customer_id::text || ':' || p_product_id::text));

  SELECT * INTO v_existing
    FROM public.payment_checkout_intents
   WHERE billing_customer_id = p_billing_customer_id
     AND product_id = p_product_id
     AND status IN ('CREATING', 'PENDING', 'MANUAL_REVIEW')
   ORDER BY created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'MANUAL_REVIEW' THEN
      -- Never automatically superseded, regardless of requested interval.
      RETURN jsonb_build_object(
        'action', 'MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT',
        'intent_id', v_existing.id, 'saff_reference', v_existing.saff_reference
      );
    END IF;

    IF v_existing.commercial_offer_id != p_commercial_offer_id THEN
      RETURN jsonb_build_object(
        'action', 'CONFLICT_DIFFERENT_INTERVAL',
        'intent_id', v_existing.id, 'saff_reference', v_existing.saff_reference,
        'existing_billing_interval', v_existing.billing_interval
      );
    END IF;

    IF v_existing.status = 'CREATING' THEN
      RETURN jsonb_build_object(
        'action', 'ALREADY_IN_PROGRESS',
        'intent_id', v_existing.id, 'saff_reference', v_existing.saff_reference
      );
    END IF;

    -- v_existing.status = 'PENDING', same offer. Reusable only if the
    -- hosted link is unexpired AND was issued under the identical
    -- provider + provider_environment as this request — a sandbox link
    -- must never be reused after a transition to production, or vice
    -- versa, even for the same offer.
    IF v_existing.provider = p_provider
       AND v_existing.provider_environment = p_provider_environment
       AND v_existing.provider_checkout_url IS NOT NULL
       AND v_existing.expires_at > now()
    THEN
      RETURN jsonb_build_object(
        'action', 'REUSE_EXISTING',
        'intent_id', v_existing.id, 'saff_reference', v_existing.saff_reference,
        'checkout_url', v_existing.provider_checkout_url,
        'expires_at', v_existing.expires_at, 'provider', v_existing.provider
      );
    END IF;

    UPDATE public.payment_checkout_intents
       SET status = 'EXPIRED', completed_at = now()
     WHERE id = v_existing.id;
  END IF;

  v_new_token  := gen_random_uuid();
  v_expires_at := now() + interval '1 hour';

  INSERT INTO public.payment_checkout_intents (
    billing_customer_id, commercial_offer_id, plan_id, product_id, market_code,
    expected_amount_minor, currency_code, currency_exponent,
    billing_interval, billing_interval_count, provider, provider_environment,
    saff_reference, status, creation_token, created_by_user_id, expires_at
  ) VALUES (
    p_billing_customer_id, p_commercial_offer_id, p_plan_id, p_product_id, p_market_code,
    p_amount_minor, p_currency_code, p_currency_exponent,
    p_billing_interval, p_billing_interval_count, p_provider, p_provider_environment,
    p_saff_reference, 'CREATING', v_new_token, p_created_by_user_id, v_expires_at
  ) RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'action', 'NEW_ATTEMPT', 'intent_id', v_new_id, 'saff_reference', p_saff_reference,
    'creation_token', v_new_token, 'expires_at', v_expires_at
  );
EXCEPTION WHEN unique_violation THEN
  -- Atomic backstop only — the advisory lock above already serializes
  -- every acquisition for this (customer, product) pair, so this branch
  -- is not expected to be reached in normal operation. Never surfaced as
  -- an unhandled 500.
  RETURN jsonb_build_object('action', 'ALREADY_IN_PROGRESS');
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_checkout_attempt(UUID,UUID,UUID,UUID,TEXT,TEXT,SMALLINT,BIGINT,TEXT,SMALLINT,TEXT,TEXT,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_checkout_attempt(UUID,UUID,UUID,UUID,TEXT,TEXT,SMALLINT,BIGINT,TEXT,SMALLINT,TEXT,TEXT,UUID,TEXT) TO service_role;

COMMENT ON FUNCTION public.acquire_checkout_attempt IS
  'Ω∞ A+ closure: sole atomic entry point for starting/reusing a checkout '
  'attempt. Never makes a network call. Returns a fencing creation_token '
  'for a genuinely NEW attempt only. service_role only, called from '
  'commercial-create-checkout after server-side offer resolution and '
  'provider selection — never accepts a browser-supplied product/offer '
  'identity without having independently resolved it first.';

-- ============================================================
-- 7. persist_checkout_provider_result — token-fenced CAS
-- ============================================================

CREATE OR REPLACE FUNCTION public.persist_checkout_provider_result(
  p_checkout_intent_id     UUID,
  p_creation_token         UUID,
  p_provider_checkout_ref  TEXT,
  p_provider_checkout_url  TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_updated RECORD;
BEGIN
  IF p_provider_checkout_url IS NULL OR trim(p_provider_checkout_url) = '' THEN
    RAISE EXCEPTION 'PERSIST_CHECKOUT_PROVIDER_RESULT_BLANK_URL' USING ERRCODE = '22023';
  END IF;

  UPDATE public.payment_checkout_intents
     SET status = 'PENDING',
         provider_checkout_ref = p_provider_checkout_ref,
         provider_checkout_url = p_provider_checkout_url
   WHERE id = p_checkout_intent_id
     AND creation_token = p_creation_token
     AND status = 'CREATING'
  RETURNING id, saff_reference, expires_at
    INTO v_updated;

  IF NOT FOUND THEN
    -- A stale token, an already-transitioned row, or a genuinely unknown
    -- id all land here identically — the caller MUST NOT return a
    -- checkout URL to the browser on this outcome, regardless of which
    -- of those three actually happened.
    RETURN jsonb_build_object('persisted', false);
  END IF;

  RETURN jsonb_build_object(
    'persisted', true, 'intent_id', v_updated.id,
    'saff_reference', v_updated.saff_reference, 'expires_at', v_updated.expires_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_checkout_provider_result(UUID,UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_checkout_provider_result(UUID,UUID,TEXT,TEXT) TO service_role;

COMMENT ON FUNCTION public.persist_checkout_provider_result IS
  'Ω∞ A+ closure BLOCKER-1 fix: compare-and-swap. Zero affected rows is a '
  'real, checked failure — commercial-create-checkout is structurally '
  'unable to return a checkout URL that was not durably persisted under '
  'the exact creation_token it was issued.';

-- ============================================================
-- 8. mark_checkout_attempt_failed / _uncertain — the only other
--    token-fenced exits from CREATING
-- ============================================================

CREATE OR REPLACE FUNCTION public.mark_checkout_attempt_failed(
  p_checkout_intent_id UUID,
  p_creation_token     UUID,
  p_reason             TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_updated RECORD;
BEGIN
  UPDATE public.payment_checkout_intents
     SET status = 'FAILED', completed_at = now(),
         metadata = metadata || jsonb_build_object('failed_reason', p_reason)
   WHERE id = p_checkout_intent_id
     AND creation_token = p_creation_token
     AND status = 'CREATING'
  RETURNING id INTO v_updated;

  RETURN jsonb_build_object('updated', FOUND);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_checkout_attempt_failed(UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_checkout_attempt_failed(UUID,UUID,TEXT) TO service_role;

COMMENT ON FUNCTION public.mark_checkout_attempt_failed IS
  'Ω∞ A+ closure: used ONLY when the provider definitively reported no '
  'checkout was created (e.g. a clean 4xx validation response) — safe to '
  'retry immediately. Token-fenced identically to persist_checkout_'
  'provider_result.';

CREATE OR REPLACE FUNCTION public.mark_checkout_attempt_uncertain(
  p_checkout_intent_id UUID,
  p_creation_token     UUID,
  p_reason             TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_updated RECORD;
BEGIN
  UPDATE public.payment_checkout_intents
     SET status = 'MANUAL_REVIEW',
         metadata = metadata || jsonb_build_object('uncertain_reason', p_reason, 'uncertain_at', now())
   WHERE id = p_checkout_intent_id
     AND creation_token = p_creation_token
     AND status = 'CREATING'
  RETURNING id INTO v_updated;

  RETURN jsonb_build_object('updated', FOUND);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_checkout_attempt_uncertain(UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_checkout_attempt_uncertain(UUID,UUID,TEXT) TO service_role;

COMMENT ON FUNCTION public.mark_checkout_attempt_uncertain IS
  'Ω∞ A+ closure BLOCKER-1 fix: used when the provider call itself failed '
  'ambiguously (network error, timeout, non-parseable response) — it is '
  'genuinely unknown whether Flutterwave created a real charge. Lands in '
  'MANUAL_REVIEW, which acquire_checkout_attempt() never automatically '
  'supersedes — a human must reconcile it via admin_resolve_manual_'
  'review_intent.';

-- ============================================================
-- 9. cancel_checkout_attempt — safe, customer-initiated escape hatch
-- ============================================================

CREATE OR REPLACE FUNCTION public.cancel_checkout_attempt(
  p_checkout_intent_id  UUID,
  p_billing_customer_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_updated RECORD;
BEGIN
  -- Only a CREATING attempt (no provider has EVER confirmed anything for
  -- it) may be self-cancelled by the owning customer. A PENDING intent's
  -- hosted link may already have been paid — cancellation there is an
  -- admin-only, evidence-based decision (admin_resolve_manual_review_
  -- intent), never a customer self-service action, to avoid ever losing
  -- track of a payment that already happened.
  UPDATE public.payment_checkout_intents
     SET status = 'CANCELLED', completed_at = now()
   WHERE id = p_checkout_intent_id
     AND billing_customer_id = p_billing_customer_id
     AND status = 'CREATING'
  RETURNING id INTO v_updated;

  RETURN jsonb_build_object('cancelled', FOUND);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_checkout_attempt(UUID,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_checkout_attempt(UUID,UUID) TO service_role;

-- ============================================================
-- 10. admin_resolve_manual_review_intent — the only exit from
--     MANUAL_REVIEW other than a genuine late verification
-- ============================================================

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

COMMENT ON FUNCTION public.admin_resolve_manual_review_intent IS
  'Ω∞ A+ closure: the ONLY way a MANUAL_REVIEW intent leaves that state '
  'without a genuine late independent verification succeeding. Never '
  'automatic. commercial_admin only. Never grants a licence itself — a '
  'real payment can still only be honoured via commit_verified_'
  'commercial_payment with real provider evidence.';

-- ============================================================
-- 11. claim_verification_attempt — durable POST-recovery throttle
-- ============================================================

CREATE OR REPLACE FUNCTION public.claim_verification_attempt(
  p_checkout_intent_id UUID,
  p_requesting_user_id UUID,
  p_cooldown_seconds   INTEGER DEFAULT 15
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_intent RECORD;
  v_now    TIMESTAMPTZ := now();
BEGIN
  IF p_requesting_user_id IS NULL THEN
    RAISE EXCEPTION 'CLAIM_VERIFICATION_ATTEMPT_MISSING_IDENTITY' USING ERRCODE = '22023';
  END IF;

  SELECT ci.*, bc.owner_user_id INTO v_intent
    FROM public.payment_checkout_intents ci
    JOIN public.billing_customers bc ON bc.id = ci.billing_customer_id
   WHERE ci.id = p_checkout_intent_id
   FOR UPDATE OF ci;

  IF NOT FOUND OR (v_intent.owner_user_id != p_requesting_user_id AND NOT public.is_commercial_admin()) THEN
    -- Identical shape whether the row doesn't exist or the caller doesn't
    -- own it — never distinguishes the two to a caller.
    RETURN jsonb_build_object('claimed', false, 'reason', 'NOT_FOUND_OR_NOT_OWNER');
  END IF;

  IF v_intent.status NOT IN ('PENDING', 'MANUAL_REVIEW') THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'INTENT_NOT_VERIFIABLE', 'status', v_intent.status);
  END IF;

  IF v_intent.verification_claimed_until IS NOT NULL AND v_intent.verification_claimed_until > v_now THEN
    RETURN jsonb_build_object(
      'claimed', false, 'reason', 'THROTTLED',
      'retry_after_seconds', GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_intent.verification_claimed_until - v_now))))
    );
  END IF;

  UPDATE public.payment_checkout_intents
     SET last_verification_attempt_at = v_now,
         verification_claimed_until   = v_now + make_interval(secs => p_cooldown_seconds)
   WHERE id = p_checkout_intent_id;

  RETURN jsonb_build_object(
    'claimed', true, 'intent_id', v_intent.id, 'provider', v_intent.provider,
    'saff_reference', v_intent.saff_reference, 'expected_amount_minor', v_intent.expected_amount_minor,
    'currency_code', v_intent.currency_code
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_verification_attempt(UUID,UUID,INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_verification_attempt(UUID,UUID,INTEGER) TO service_role;

COMMENT ON FUNCTION public.claim_verification_attempt IS
  'Ω∞ A+ closure HIGH-1 fix: durable, row-locked, per-intent throttle for '
  'the POST recovery path in commercial-payment-status. Ownership proven '
  'via bc.owner_user_id = p_requesting_user_id (the caller''s own JWT '
  'subject, resolved by the Edge Function before calling this), OR '
  'is_commercial_admin(). Never relies on Edge Function process memory.';

-- ============================================================
-- 12. commit_verified_commercial_payment — CREATE OR REPLACE, same
--     13-arg signature. Idempotency re-checked after the customer lock;
--     blank provider_transaction_id rejected; PENDING or MANUAL_REVIEW
--     both commit-eligible.
-- ============================================================

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
  v_existing_evt         UUID;
  v_event_id             UUID;
  v_licence_id           UUID;
  v_period_start         TIMESTAMPTZ;
  v_period_end           TIMESTAMPTZ;
  v_current_lic          RECORD;
  v_display_amt          NUMERIC;
  v_billing_customer_id  UUID;
BEGIN
  -- Ω∞ A+ closure BLOCKER-4 fix: a blank provider transaction id can
  -- never produce a commit — it is the identity half of the canonical
  -- (provider, provider_transaction_id, checkout_intent_id) idempotency
  -- tuple, and a blank value would let two genuinely different provider
  -- transactions collide on identity or, worse, let an unverified "" id
  -- through as if it were real evidence.
  IF p_provider_transaction_id IS NULL OR trim(p_provider_transaction_id) = '' THEN
    RAISE EXCEPTION 'Iron Dome: provider_transaction_id must not be blank for intent %', p_checkout_intent_id
      USING ERRCODE = '22023';
  END IF;

  -- Ω∞ A+ closure BLOCKER-3/BLOCKER-2 fix: look up the billing customer
  -- and take the customer-level advisory lock BEFORE the idempotency
  -- check — the prior round checked idempotency first, which was safe in
  -- practice only because of the intent-status check further down, not
  -- because it was actually race-free. Re-checking under the lock makes
  -- the guarantee explicit and unconditional.
  SELECT billing_customer_id INTO v_billing_customer_id
    FROM public.payment_checkout_intents WHERE id = p_checkout_intent_id;
  IF v_billing_customer_id IS NULL THEN
    RAISE EXCEPTION 'Iron Dome: checkout_intent % not found', p_checkout_intent_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_billing_customer_id::text));

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

  -- Ω∞ A+ closure: a MANUAL_REVIEW intent CAN still be honoured by a
  -- genuine late independent verification succeeding — "never
  -- automatically superseded" (enforced by acquire_checkout_attempt)
  -- governs a NEW competing attempt, not a real verification of the SAME
  -- attempt arriving late.
  IF v_intent.status NOT IN ('PENDING','MANUAL_REVIEW') THEN
    RETURN jsonb_build_object('status','INTENT_ALREADY_RESOLVED','intent_status',v_intent.status,'committed',false);
  END IF;

  -- expires_at is deliberately NOT re-checked here (Ω∞ A+ audit BLOCKER-1,
  -- prior round) — an already-independently-verified SUCCEEDED payment is
  -- never invalidated by local wall-clock expiry.

  IF p_amount_minor != v_intent.expected_amount_minor THEN
    RAISE EXCEPTION 'Iron Dome: amount mismatch. Expected % minor units, got % for intent %',
      v_intent.expected_amount_minor, p_amount_minor, p_checkout_intent_id;
  END IF;
  IF p_currency_code != v_intent.currency_code THEN
    RAISE EXCEPTION 'Iron Dome: currency mismatch. Expected %, got % for intent %',
      v_intent.currency_code, p_currency_code, p_checkout_intent_id;
  END IF;

  -- Ω∞ A+ closure: re-validated as an internal-consistency check (the
  -- verification's own environment must match what was snapshotted at
  -- acquisition) — deliberately NOT re-derived from the CURRENT
  -- commercial_platform_state (see this migration's header comment for
  -- why: doing so would recreate BLOCKER-1's "charge without licence"
  -- failure mode via a different door).
  IF p_provider_environment IS NULL OR v_intent.provider_environment IS NULL
     OR p_provider_environment != v_intent.provider_environment THEN
    RAISE EXCEPTION 'Iron Dome: provider environment mismatch. Intent snapshotted %, verification ran under %, for intent %',
      v_intent.provider_environment, p_provider_environment, p_checkout_intent_id
      USING ERRCODE = '22023';
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

REVOKE ALL ON FUNCTION public.commit_verified_commercial_payment(UUID,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_verified_commercial_payment(UUID,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT) TO service_role;

COMMENT ON FUNCTION public.commit_verified_commercial_payment(UUID,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT) IS
  'Ω∞ A+ closure: idempotency re-checked AFTER the customer-level advisory '
  'lock (not before); blank provider_transaction_id rejected outright; '
  'PENDING or MANUAL_REVIEW both commit-eligible. Otherwise unchanged from '
  'the prior round''s BLOCKER-1 (no wall-clock expiry rejection) and '
  'HIGH-7 (provider-environment validation) fixes.';

-- ============================================================
-- 13. admin_upsert_commercial_offer — CREATE OR REPLACE, same 12-arg
--     signature. Refuses to silently repoint market/interval too, not
--     just plan/product.
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
  p_reason                 TEXT,
  p_product_code           TEXT DEFAULT 'CFOCLOSE'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id       UUID := auth.uid();
  v_plan_id       UUID;
  v_offer_id      UUID;
  v_offer_plan_id UUID;
  v_offer_market  TEXT;
  v_offer_interval TEXT;
  v_previous      JSONB;
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

  SELECT cp.id INTO v_plan_id
    FROM public.commercial_plans cp
    JOIN public.commercial_products co ON co.id = cp.product_id
   WHERE cp.code = p_plan_code AND co.code = p_product_code;
  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_PLAN_CODE_FOR_PRODUCT: % / %', p_product_code, p_plan_code USING ERRCODE = '22023';
  END IF;

  SELECT id, plan_id, market_code, billing_interval, to_jsonb(co.*)
    INTO v_offer_id, v_offer_plan_id, v_offer_market, v_offer_interval, v_previous
    FROM public.commercial_offers co WHERE co.offer_code = p_offer_code;

  IF v_offer_id IS NOT NULL AND v_offer_plan_id != v_plan_id THEN
    RAISE EXCEPTION 'OFFER_CODE_BELONGS_TO_DIFFERENT_PLAN: offer_code % belongs to plan_id %, not the resolved plan_id % for %/%',
      p_offer_code, v_offer_plan_id, v_plan_id, p_product_code, p_plan_code
      USING ERRCODE = '22023';
  END IF;

  -- Ω∞ A+ closure HIGH-2 fix: an UPDATE must never silently repoint an
  -- existing offer's market or billing interval either — those are
  -- identity axes of the offer family, not editable economics. An admin
  -- intending to change interval/market for a family must create a NEW
  -- offer_code, never repoint an existing one out from under any
  -- historical checkout intent that snapshotted its old identity.
  IF v_offer_id IS NOT NULL AND v_offer_market != p_market_code THEN
    RAISE EXCEPTION 'OFFER_CODE_MARKET_MISMATCH: offer_code % is market %, request specified %',
      p_offer_code, v_offer_market, p_market_code USING ERRCODE = '22023';
  END IF;
  IF v_offer_id IS NOT NULL AND v_offer_interval != p_billing_interval THEN
    RAISE EXCEPTION 'OFFER_CODE_INTERVAL_MISMATCH: offer_code % is interval %, request specified %',
      p_offer_code, v_offer_interval, p_billing_interval USING ERRCODE = '22023';
  END IF;

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
        'billing_interval',p_billing_interval,'billing_interval_count',p_billing_interval_count,
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
        'billing_interval',p_billing_interval,'billing_interval_count',p_billing_interval_count,
        'is_active',p_is_active,'is_purchasable',p_is_purchasable),
      p_reason
    );
  END IF;

  RETURN jsonb_build_object('offer_id', v_offer_id, 'offer_code', p_offer_code);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_upsert_commercial_offer(TEXT,TEXT,TEXT,TEXT,BIGINT,SMALLINT,TEXT,SMALLINT,BOOLEAN,BOOLEAN,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_commercial_offer(TEXT,TEXT,TEXT,TEXT,BIGINT,SMALLINT,TEXT,SMALLINT,BOOLEAN,BOOLEAN,TEXT,TEXT) TO authenticated;

-- ============================================================
-- 14. Offer-seed binding — full re-assertion (HIGH-2)
-- ============================================================

DO $$
DECLARE
  v_row RECORD;
  v_expected RECORD;
BEGIN
  FOR v_expected IN
    SELECT * FROM (VALUES
      ('CFOCLOSE_PROFESSIONAL_GLOBAL_USD_MONTHLY'::TEXT, 4900::BIGINT, 'MONTHLY'::TEXT, 1::SMALLINT),
      ('CFOCLOSE_PROFESSIONAL_GLOBAL_USD_ANNUAL'::TEXT, 49900::BIGINT, 'ANNUAL'::TEXT, 1::SMALLINT)
    ) AS t(offer_code, amount_minor, billing_interval, billing_interval_count)
  LOOP
    SELECT
      co.id, co.offer_code, co.market_code, co.currency_code, co.amount_minor,
      co.currency_exponent, co.billing_interval, co.billing_interval_count,
      co.provider_restriction, co.is_active, co.is_purchasable,
      co.effective_start, co.effective_end,
      cp.code AS plan_code, cprod.code AS product_code
      INTO v_row
      FROM public.commercial_offers co
      JOIN public.commercial_plans cp ON cp.id = co.plan_id
      JOIN public.commercial_products cprod ON cprod.id = cp.product_id
     WHERE co.offer_code = v_expected.offer_code;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'OFFER_SEED_BINDING_MISSING: % does not exist', v_expected.offer_code;
    END IF;
    IF v_row.product_code != 'CFOCLOSE' THEN
      RAISE EXCEPTION 'OFFER_SEED_BINDING_WRONG_PRODUCT: % belongs to product %, expected CFOCLOSE', v_expected.offer_code, v_row.product_code;
    END IF;
    IF v_row.plan_code != 'PAID' THEN
      RAISE EXCEPTION 'OFFER_SEED_BINDING_WRONG_PLAN: % belongs to plan %, expected PAID', v_expected.offer_code, v_row.plan_code;
    END IF;
    IF v_row.market_code != 'GLOBAL' THEN
      RAISE EXCEPTION 'OFFER_SEED_BINDING_WRONG_MARKET: % has market %, expected GLOBAL', v_expected.offer_code, v_row.market_code;
    END IF;
    IF v_row.currency_code != 'USD' THEN
      RAISE EXCEPTION 'OFFER_SEED_BINDING_WRONG_CURRENCY: % has currency %, expected USD', v_expected.offer_code, v_row.currency_code;
    END IF;
    IF v_row.amount_minor != v_expected.amount_minor THEN
      RAISE EXCEPTION 'OFFER_SEED_BINDING_WRONG_AMOUNT: % has amount_minor %, expected %', v_expected.offer_code, v_row.amount_minor, v_expected.amount_minor;
    END IF;
    IF v_row.currency_exponent != 2 THEN
      RAISE EXCEPTION 'OFFER_SEED_BINDING_WRONG_EXPONENT: % has exponent %, expected 2', v_expected.offer_code, v_row.currency_exponent;
    END IF;
    IF v_row.billing_interval != v_expected.billing_interval THEN
      RAISE EXCEPTION 'OFFER_SEED_BINDING_WRONG_INTERVAL: % has interval %, expected %', v_expected.offer_code, v_row.billing_interval, v_expected.billing_interval;
    END IF;
    IF v_row.billing_interval_count != v_expected.billing_interval_count THEN
      RAISE EXCEPTION 'OFFER_SEED_BINDING_WRONG_INTERVAL_COUNT: % has interval_count %, expected %', v_expected.offer_code, v_row.billing_interval_count, v_expected.billing_interval_count;
    END IF;
    IF v_row.provider_restriction IS NOT NULL THEN
      RAISE EXCEPTION 'OFFER_SEED_BINDING_UNEXPECTED_PROVIDER_RESTRICTION: % has provider_restriction %, expected NULL (any eligible provider)', v_expected.offer_code, v_row.provider_restriction;
    END IF;
    IF NOT v_row.is_active THEN
      RAISE EXCEPTION 'OFFER_SEED_BINDING_NOT_ACTIVE: % must be is_active = true', v_expected.offer_code;
    END IF;
    IF v_row.is_purchasable THEN
      RAISE EXCEPTION 'OFFER_SEED_BINDING_UNEXPECTEDLY_PURCHASABLE: % must seed non-purchasable — an operator flips this later via admin_upsert_commercial_offer', v_expected.offer_code;
    END IF;
    IF v_row.effective_start > now() OR (v_row.effective_end IS NOT NULL AND v_row.effective_end <= now()) THEN
      RAISE EXCEPTION 'OFFER_SEED_BINDING_NOT_CURRENTLY_EFFECTIVE: % has effective_start=%, effective_end=%', v_expected.offer_code, v_row.effective_start, v_row.effective_end;
    END IF;

    -- No duplicate authoritative current family: exactly one CURRENTLY-
    -- effective offer may exist for this exact (plan, market, currency,
    -- interval, interval_count) family — re-proves the GiST exclusion
    -- constraint's own invariant explicitly, rather than trusting it
    -- silently.
    IF (
      SELECT count(*) FROM public.commercial_offers co2
       WHERE co2.plan_id = (SELECT id FROM public.commercial_plans WHERE code = 'PAID' AND product_id = (SELECT id FROM public.commercial_products WHERE code = 'CFOCLOSE'))
         AND co2.market_code = v_row.market_code
         AND co2.currency_code = v_row.currency_code
         AND co2.billing_interval = v_row.billing_interval
         AND co2.billing_interval_count = v_row.billing_interval_count
         AND co2.effective_start <= now() AND (co2.effective_end IS NULL OR co2.effective_end > now())
    ) != 1 THEN
      RAISE EXCEPTION 'OFFER_SEED_BINDING_DUPLICATE_AUTHORITATIVE_FAMILY: more than one currently-effective offer exists for the % family', v_expected.offer_code;
    END IF;
  END LOOP;
END $$;
