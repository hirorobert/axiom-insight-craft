-- 20261001120000_annual_commercial_term.sql
--
-- One 12-month commercial term for the CFOCLOSE self-serve plans (SOLO, PRACTICE, FIRM). Enterprise stays
-- contract-based and is untouched; plans of any other product are untouched.
--
-- Why: commit_verified_commercial_payment (20260913000000) derives a licence's END from the checkout offer's billing
-- interval, so a MONTHLY payment yields effective_end = start + 1 month — a one-month entitlement. The approved model
-- forbids that: monthly may only ever be an instalment schedule against the same 12-month commitment, and the schema
-- cannot represent an instalment schedule (no contract term separate from billing cadence, no contract value). Until it
-- can, monthly is not offered and the server refuses every non-annual term:
--
--   0. ZERO-STATE GATE — the migration refuses to apply, before any mutation, while any INVALID self-serve checkout
--      intent can still be fulfilled. Invalid: billing_interval IS DISTINCT FROM ANNUAL OR billing_interval_count IS
--      DISTINCT FROM 1. Still fulfillable: every status that is not terminal. The terminal set is named, never the open
--      set, so a status added later counts as open until it is proven terminal. Derived from the live functions
--      (proven by scripts/db-proof/annualTerm.mjs): commit_verified_commercial_payment and claim_verification_attempt
--      fulfil PENDING and MANUAL_REVIEW; CREATING and PROVIDER_CREATING move into those (persist_checkout_provider_result,
--      mark_checkout_attempt_uncertain, acquire_checkout_attempt); SUCCEEDED, FAILED, CANCELLED and EXPIRED have no
--      transition out. expires_at is ignored: the commit deliberately does not re-check it. Such an intent could be paid
--      at the provider and then fail to commit under the term guard below — paid, without a licence. The migration ALSO
--      refuses while any invalid provider-backed intent lacks an authoritative verified terminal outcome (defined at the
--      gate). The gate is the whole zero-state condition: the read-only preflight (scripts/db-preflight/annualTermPreflight.sql)
--      mirrors it for planning and cannot be bypassed by skipping it. An invalid checkout is NEVER fulfilled: it is
--      cancelled, expired, refunded or voided at the provider (or replaced, with consent, by a valid ANNUAL × 1 checkout).
--   1. the CFOCLOSE SOLO / PRACTICE / FIRM MONTHLY offers are retired (inactive, non-purchasable, effective_end set) —
--      the precedent of 20260925100000 §4; nothing else about any offer changes;
--   2. a checkout intent for those plans must be exactly ANNUAL × 1, on INSERT and on any UPDATE of plan_id,
--      billing_interval or billing_interval_count (SQLSTATE PT422, ANNUAL_TERM_REQUIRED);
--   3. a payment-created licence for those plans (source *_VERIFIED_PAYMENT) is authorised for exactly the canonical
--      12-month term: on INSERT, effective_end must be effective_start + 12 months (never NULL, never shorter, never
--      longer). On UPDATE, the authorised term may only END EARLIER (expiry, suspension, the commit's own truncation on
--      a plan change): plan_id, source and effective_start are immutable, and effective_end may neither become NULL nor
--      move later (SQLSTATE PT422, INVALID_COMMERCIAL_TERM). The same rules stop a licence from being moved INTO the
--      payment-created self-serve state by an UPDATE.
--
-- Existing licences: no row is updated or deleted. Monthly-paid licences that already exist keep their period and
-- expire naturally; ending them earlier stays possible, extending them does not.
--
-- Self-serve checkout stays disabled: commercial_platform_state is not touched. Before any checkout activation, the
-- downgrade-at-purchase behaviour of commit_verified_commercial_payment (a plan change truncates the current licence
-- and starts the new plan immediately) must be corrected so downgrades apply at renewal — a registered prerequisite
-- (CLAUDE.md §9.2, COMMERCIAL_DOWNGRADE_AT_RENEWAL_REQUIRED_BEFORE_CHECKOUT).
--
--   4. admin_cancel_future_licence — a generic, server-authoritative cancellation of a licence that has not started
--      (status CANCELLED, dates preserved, audited, idempotent, irreversible); see section 4. It cancels nothing here.
--
-- Re-runnable: a second application changes nothing. Not applied by this PR; forward-only; no applied migration is
-- modified.

-- ── 0. Zero-state gate (both conditions; nothing below runs unless both are zero) ───────────────────────────────────
DO $gate$
DECLARE
  v_open         INTEGER;
  v_unreconciled INTEGER;
BEGIN
  -- (1) An invalid self-serve intent that can still be fulfilled.
  SELECT count(*) INTO v_open
    FROM public.payment_checkout_intents i
    JOIN public.commercial_plans cp ON cp.id = i.plan_id
    JOIN public.commercial_products p ON p.id = cp.product_id
   WHERE p.code = 'CFOCLOSE' AND cp.code IN ('SOLO', 'PRACTICE', 'FIRM')
     AND (i.billing_interval IS DISTINCT FROM 'ANNUAL' OR i.billing_interval_count IS DISTINCT FROM 1)
     AND i.status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED');
  IF v_open > 0 THEN
    RAISE EXCEPTION 'INVALID_OPEN_CHECKOUT_INTENTS'
      USING ERRCODE = 'PT422',
            DETAIL = format('%s invalid self-serve checkout intent(s) can still be fulfilled', v_open);
  END IF;

  -- (2) An invalid self-serve intent that reached a provider session (provider_checkout_ref) and is terminal WITHOUT an
  --     authoritative reconciliation: a payment event for that intent, verified by the provider API or by a reviewed
  --     admin decision (verified_at, a non-blank provider_transaction_id and an evidence payload_hash all present), whose
  --     outcome is final — CANCELLED, EXPIRED or REFUNDED (a void is a provider cancellation), or SUCCEEDED with its
  --     licence existing (fulfilled before this migration; that licence is preserved and expires naturally). WEBHOOK_ONLY,
  --     FAILED, PARTIALLY_REFUNDED, UNKNOWN, PENDING and CHECKOUT_CREATED never reconcile.
  SELECT count(*) INTO v_unreconciled
    FROM public.payment_checkout_intents i
    JOIN public.commercial_plans cp ON cp.id = i.plan_id
    JOIN public.commercial_products p ON p.id = cp.product_id
   WHERE p.code = 'CFOCLOSE' AND cp.code IN ('SOLO', 'PRACTICE', 'FIRM')
     AND (i.billing_interval IS DISTINCT FROM 'ANNUAL' OR i.billing_interval_count IS DISTINCT FROM 1)
     AND i.provider_checkout_ref IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.payment_events e
        WHERE e.checkout_intent_id = i.id
          AND e.verification_method IN ('PROVIDER_API_VERIFY', 'MANUAL_ADMIN')
          AND e.verified_at IS NOT NULL
          AND nullif(btrim(e.provider_transaction_id), '') IS NOT NULL
          AND nullif(btrim(e.payload_hash), '') IS NOT NULL
          AND (e.normalized_status IN ('CANCELLED', 'EXPIRED', 'REFUNDED')
               OR (e.normalized_status = 'SUCCEEDED' AND e.licence_id IS NOT NULL
                   AND EXISTS (SELECT 1 FROM public.commercial_licences l WHERE l.id = e.licence_id))));
  IF v_unreconciled > 0 THEN
    RAISE EXCEPTION 'UNRECONCILED_PROVIDER_CHECKOUTS'
      USING ERRCODE = 'PT422',
            DETAIL = format('%s invalid provider-backed checkout(s) lack an authoritative verified terminal outcome', v_unreconciled);
  END IF;
END
$gate$;

-- ── 1. Retire the CFOCLOSE self-serve MONTHLY offers ────────────────────────────────────────────────────────────────
UPDATE public.commercial_offers co
   SET is_active = false, is_purchasable = false,
       effective_end = GREATEST(now(), co.effective_start + interval '1 second'), updated_at = now()
  FROM public.commercial_plans cp
  JOIN public.commercial_products p ON p.id = cp.product_id AND p.code = 'CFOCLOSE'
 WHERE co.plan_id = cp.id
   AND cp.code IN ('SOLO', 'PRACTICE', 'FIRM')
   AND co.billing_interval = 'MONTHLY'
   AND (co.is_active OR co.is_purchasable);

-- The one place that decides whether a plan is a CFOCLOSE self-serve plan (product boundary included).
CREATE OR REPLACE FUNCTION public.commercial_is_cfoclose_self_serve_plan(p_plan_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.commercial_plans cp
      JOIN public.commercial_products p ON p.id = cp.product_id
     WHERE cp.id = p_plan_id AND p.code = 'CFOCLOSE' AND cp.code IN ('SOLO', 'PRACTICE', 'FIRM'));
$$;
REVOKE ALL ON FUNCTION public.commercial_is_cfoclose_self_serve_plan(UUID) FROM PUBLIC, anon, authenticated;

-- ── 2. Checkout intents: exactly ANNUAL × 1 ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.commercial_annual_term_intent_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  IF public.commercial_is_cfoclose_self_serve_plan(NEW.plan_id)
     AND (NEW.billing_interval IS DISTINCT FROM 'ANNUAL' OR NEW.billing_interval_count IS DISTINCT FROM 1) THEN
    RAISE EXCEPTION 'ANNUAL_TERM_REQUIRED' USING ERRCODE = 'PT422';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_annual_term_intent_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_commercial_annual_term_intent_guard
  BEFORE INSERT OR UPDATE OF plan_id, billing_interval, billing_interval_count ON public.payment_checkout_intents
  FOR EACH ROW EXECUTE FUNCTION public.commercial_annual_term_intent_guard();

-- ── 3. Payment-created licences: the canonical 12-month term ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.commercial_annual_term_licence_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_new_paid BOOLEAN := NEW.source LIKE '%\_VERIFIED\_PAYMENT' ESCAPE '\' AND public.commercial_is_cfoclose_self_serve_plan(NEW.plan_id);
  v_old_paid BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_new_paid AND (NEW.effective_end IS NULL OR NEW.effective_end <> NEW.effective_start + interval '12 months') THEN
      RAISE EXCEPTION 'INVALID_COMMERCIAL_TERM' USING ERRCODE = 'PT422';
    END IF;
    RETURN NEW;
  END IF;

  v_old_paid := OLD.source LIKE '%\_VERIFIED\_PAYMENT' ESCAPE '\' AND public.commercial_is_cfoclose_self_serve_plan(OLD.plan_id);
  IF v_old_paid THEN
    -- An authorised payment term may only end earlier: provenance, plan and start are fixed.
    IF NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.effective_start IS DISTINCT FROM OLD.effective_start
       OR NEW.effective_end IS NULL
       OR (OLD.effective_end IS NOT NULL AND NEW.effective_end > OLD.effective_end) THEN
      RAISE EXCEPTION 'INVALID_COMMERCIAL_TERM' USING ERRCODE = 'PT422';
    END IF;
  ELSIF v_new_paid THEN
    -- No row becomes a payment-created self-serve licence by an UPDATE.
    RAISE EXCEPTION 'INVALID_COMMERCIAL_TERM' USING ERRCODE = 'PT422';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_annual_term_licence_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_commercial_annual_term_licence_guard
  BEFORE INSERT OR UPDATE OF plan_id, source, effective_start, effective_end ON public.commercial_licences
  FOR EACH ROW EXECUTE FUNCTION public.commercial_annual_term_licence_guard();

-- ── 4. Cancelling a licence that has not started ────────────────────────────────────────────────────────────────────
-- admin_transition_licence_status (20260905093408) cannot cancel a FUTURE licence: it moves effective_end to now(),
-- which precedes effective_start and violates chk_cl_effective_window. admin_cancel_future_licence is the generic,
-- server-authoritative replacement for that case. Authorization boundary: the repository's established commercial-admin
-- boundary — EXECUTE for authenticated only, and the caller must be an active commercial_admins row (exactly as
-- admin_transition_licence_status); PUBLIC, anon and service_role cannot execute it.
--
-- Contract: one transaction; the target row is locked FOR UPDATE; a missing licence answers exactly like an
-- unauthorised call (forbidden); refused unless the licence has not started (effective_start > transaction_timestamp()),
-- is ACTIVE or PENDING, and belongs to the CFOCLOSE product; sets status CANCELLED and nothing else (dates preserved
-- exactly); one append-only billing_audit_events row (account, actor, licence, previous and new status, dates, reason,
-- correlation/idempotency key, timestamp); idempotent per key; controlled outcomes only — cancelled, already_cancelled,
-- forbidden, not_future, invalid_state, invalid_request. No licence is cancelled by this migration.

-- One cancellation per idempotency key; the licence lookup used by the irreversibility guard.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bae_future_licence_cancellation_key
  ON public.billing_audit_events (correlation_id)
  WHERE action = 'FUTURE_LICENCE_CANCELLED';
CREATE INDEX IF NOT EXISTS idx_bae_future_licence_cancellation_licence
  ON public.billing_audit_events ((new_state ->> 'licence_id'))
  WHERE action = 'FUTURE_LICENCE_CANCELLED';

CREATE OR REPLACE FUNCTION public.admin_cancel_future_licence(p_licence_id UUID, p_reason TEXT, p_idempotency_key UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_actor   UUID := auth.uid();
  v_lic     RECORD;
  v_prior   RECORD;
  v_event   UUID;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_actor AND active) THEN
    RETURN jsonb_build_object('outcome', 'forbidden');
  END IF;
  IF p_licence_id IS NULL OR p_idempotency_key IS NULL OR p_reason IS NULL OR p_reason !~ '^[A-Z][A-Z0-9_]{2,127}$' THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;

  SELECT l.id, l.billing_customer_id, l.plan_id, l.status, l.source, l.effective_start, l.effective_end
    INTO v_lic
    FROM public.commercial_licences l
   WHERE l.id = p_licence_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'forbidden');   -- indistinguishable from an unauthorised call
  END IF;

  -- Replay of the same request (serialised behind the row lock): the original result, no second audit event.
  SELECT e.id, e.new_state INTO v_prior
    FROM public.billing_audit_events e
   WHERE e.action = 'FUTURE_LICENCE_CANCELLED' AND e.correlation_id = p_idempotency_key;
  IF FOUND THEN
    IF v_prior.new_state ->> 'licence_id' = p_licence_id::text THEN
      RETURN jsonb_build_object('outcome', 'cancelled', 'licence_id', p_licence_id, 'audit_event_id', v_prior.id, 'replayed', true);
    END IF;
    RETURN jsonb_build_object('outcome', 'invalid_request');   -- the key already belongs to another cancellation
  END IF;

  IF v_lic.status = 'CANCELLED' THEN
    RETURN jsonb_build_object('outcome', 'already_cancelled', 'licence_id', p_licence_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_plans cp JOIN public.commercial_products p ON p.id = cp.product_id
                  WHERE cp.id = v_lic.plan_id AND p.code = 'CFOCLOSE') THEN
    RETURN jsonb_build_object('outcome', 'invalid_state');
  END IF;
  IF v_lic.effective_start <= transaction_timestamp() THEN
    RETURN jsonb_build_object('outcome', 'not_future');
  END IF;
  IF v_lic.status NOT IN ('ACTIVE', 'PENDING') THEN
    RETURN jsonb_build_object('outcome', 'invalid_state');
  END IF;

  BEGIN
    UPDATE public.commercial_licences SET status = 'CANCELLED', updated_at = now() WHERE id = p_licence_id;
    INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason, correlation_id)
    VALUES (v_lic.billing_customer_id, v_actor, 'FUTURE_LICENCE_CANCELLED',
            jsonb_build_object('licence_id', p_licence_id, 'account_id', v_lic.billing_customer_id, 'status', v_lic.status,
                               'effective_start', v_lic.effective_start, 'effective_end', v_lic.effective_end),
            jsonb_build_object('licence_id', p_licence_id, 'account_id', v_lic.billing_customer_id, 'status', 'CANCELLED',
                               'effective_start', v_lic.effective_start, 'effective_end', v_lic.effective_end),
            p_reason, p_idempotency_key)
    RETURNING id INTO v_event;
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent cancellation of ANOTHER licence claimed the same key first: this one is undone (subtransaction).
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END;
  RETURN jsonb_build_object('outcome', 'cancelled', 'licence_id', p_licence_id, 'audit_event_id', v_event, 'replayed', false);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_cancel_future_licence(UUID, TEXT, UUID) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_future_licence(UUID, TEXT, UUID) TO authenticated;

-- A licence cancelled through admin_cancel_future_licence is terminal: its status, plan, source, account, seats and
-- dates can never change again (no return to ACTIVE, no extension, no re-plan, no reuse) — whoever attempts it.
CREATE OR REPLACE FUNCTION public.commercial_cancelled_future_licence_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  IF OLD.status = 'CANCELLED'
     AND (NEW.status, NEW.plan_id, NEW.source, NEW.billing_customer_id, NEW.additional_seats, NEW.effective_start, NEW.effective_end)
         IS DISTINCT FROM (OLD.status, OLD.plan_id, OLD.source, OLD.billing_customer_id, OLD.additional_seats, OLD.effective_start, OLD.effective_end)
     AND EXISTS (SELECT 1 FROM public.billing_audit_events e
                  WHERE e.action = 'FUTURE_LICENCE_CANCELLED' AND e.new_state ->> 'licence_id' = OLD.id::text) THEN
    RAISE EXCEPTION 'CANCELLED_LICENCE_IMMUTABLE' USING ERRCODE = 'PT422';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_cancelled_future_licence_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_commercial_cancelled_future_licence_guard
  BEFORE UPDATE ON public.commercial_licences
  FOR EACH ROW EXECUTE FUNCTION public.commercial_cancelled_future_licence_guard();
