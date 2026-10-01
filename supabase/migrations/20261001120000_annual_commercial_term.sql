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
--      at the provider and then fail to commit under the term guard below — paid, without a licence. The operator
--      reconciles each with the provider and resolves it first (scripts/db-preflight/annualTermPreflight.sql).
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
-- Re-runnable: a second application changes nothing. Not applied by this PR; forward-only; no applied migration is
-- modified.

-- ── 0. Zero-state gate ──────────────────────────────────────────────────────────────────────────────────────────────
DO $gate$
DECLARE
  v_open INTEGER;
BEGIN
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
            DETAIL = format('%s invalid self-serve checkout intent(s) can still be fulfilled; reconcile and resolve them first (scripts/db-preflight/annualTermPreflight.sql)', v_open);
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
