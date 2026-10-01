-- 20261001120000_annual_commercial_term.sql
--
-- One 12-month commercial term for Solo, Practice and Firm. Enterprise stays contract-based (untouched).
--
-- Why: commit_verified_commercial_payment (20260913000000) derives a licence's END from the checkout offer's billing
-- interval — a MONTHLY offer yields effective_end = start + 1 month, i.e. a one-month entitlement. The approved model
-- forbids that: monthly may only ever be an instalment schedule against the same 12-month commitment, and the schema
-- cannot yet represent an instalment schedule (no contract term separate from billing cadence, no total contract
-- value). So, until it can, monthly is simply not offered, and the server refuses to mint anything shorter than the
-- 12-month term from a payment:
--
--   1. the MONTHLY offers for SOLO, PRACTICE and FIRM are retired (inactive, non-purchasable, effective_end set) —
--      the precedent of 20260925100000 §4; nothing else about any offer changes;
--   2. a checkout intent for a MONTHLY offer of those plans is refused (BEFORE INSERT);
--   3. a licence created from a verified payment for those plans must cover at least the 12-month term
--      (BEFORE INSERT) — defence in depth: even a direct call cannot mint a shorter payment-created entitlement;
--   4. renewal is represented on the licence (renewal_status RENEWS | NON_RENEWING) and the account holder may stop
--      renewal (stop_commercial_renewal). Stopping renewal changes nothing else: status, period and entitlement are
--      untouched; the current annual obligation runs to its end.
--
-- Existing licences: no row is updated or deleted. Every guard fires on INSERT only; the added renewal_status column
-- defaults to RENEWS (no existing licence has a cancellation of renewal to represent). Suspension (payment failure)
-- and expiry keep their existing semantics: new privileged actions are refused, existing records stay readable.
--
-- Re-runnable: applying it again changes nothing (CREATE OR REPLACE, ADD COLUMN IF NOT EXISTS, a retirement UPDATE that
-- matches only still-active offers).
--
-- Not applied by this PR. Authored forward-only; no applied migration is modified.

-- ── 1. Retire the MONTHLY offers for the self-serve plans ───────────────────────────────────────────────────────────
UPDATE public.commercial_offers co
   SET is_active = false, is_purchasable = false,
       effective_end = GREATEST(now(), co.effective_start + interval '1 second'), updated_at = now()
  FROM public.commercial_plans cp
  JOIN public.commercial_products p ON p.id = cp.product_id AND p.code = 'CFOCLOSE'
 WHERE co.plan_id = cp.id
   AND cp.code IN ('SOLO', 'PRACTICE', 'FIRM')
   AND co.billing_interval = 'MONTHLY'
   AND (co.is_active OR co.is_purchasable);

-- ── 2. No checkout intent for a monthly term on the self-serve plans ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.commercial_annual_term_intent_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.billing_interval IS DISTINCT FROM 'ANNUAL' AND EXISTS (
       SELECT 1 FROM public.commercial_plans cp WHERE cp.id = NEW.plan_id AND cp.code IN ('SOLO', 'PRACTICE', 'FIRM')) THEN
    RAISE EXCEPTION 'Iron Dome: % checkout is not offered — Solo, Practice and Firm have one 12-month term', NEW.billing_interval
      USING ERRCODE = '22023';
  END IF;
  IF NEW.billing_interval = 'ANNUAL' AND NEW.billing_interval_count IS DISTINCT FROM 1 AND EXISTS (
       SELECT 1 FROM public.commercial_plans cp WHERE cp.id = NEW.plan_id AND cp.code IN ('SOLO', 'PRACTICE', 'FIRM')) THEN
    RAISE EXCEPTION 'Iron Dome: the self-serve term is exactly 12 months (interval count %)', NEW.billing_interval_count
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_annual_term_intent_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_commercial_annual_term_intent_guard
  BEFORE INSERT ON public.payment_checkout_intents
  FOR EACH ROW EXECUTE FUNCTION public.commercial_annual_term_intent_guard();

-- ── 3. A payment-created licence covers the whole 12-month term ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.commercial_annual_term_licence_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.source LIKE '%\_VERIFIED\_PAYMENT' ESCAPE '\'
     AND EXISTS (SELECT 1 FROM public.commercial_plans cp WHERE cp.id = NEW.plan_id AND cp.code IN ('SOLO', 'PRACTICE', 'FIRM'))
     AND NEW.effective_end IS NOT NULL
     AND NEW.effective_end < NEW.effective_start + interval '12 months' THEN
    RAISE EXCEPTION 'Iron Dome: a payment never creates an entitlement shorter than the 12-month term (% to %)',
      NEW.effective_start, NEW.effective_end
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_annual_term_licence_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_commercial_annual_term_licence_guard
  BEFORE INSERT ON public.commercial_licences
  FOR EACH ROW EXECUTE FUNCTION public.commercial_annual_term_licence_guard();

-- ── 4. Renewal is represented; stopping it changes nothing else ─────────────────────────────────────────────────────
ALTER TABLE public.commercial_licences
  ADD COLUMN IF NOT EXISTS renewal_status TEXT NOT NULL DEFAULT 'RENEWS'
    CONSTRAINT chk_cl_renewal_status CHECK (renewal_status IN ('RENEWS', 'NON_RENEWING'));

-- The account holder stops renewal of their current licence. Status, period, seats and entitlement are untouched: the
-- current 12-month obligation and access run to the licence's own end. Idempotent; audited.
CREATE OR REPLACE FUNCTION public.stop_commercial_renewal(p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_bc  UUID;
  v_lic RECORD;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('outcome', 'unauthenticated');
  END IF;
  SELECT id INTO v_bc FROM public.billing_customers WHERE owner_user_id = v_uid;
  IF v_bc IS NULL THEN
    RETURN jsonb_build_object('outcome', 'no_current_licence');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_bc::text));
  SELECT * INTO v_lic FROM public.commercial_licences
   WHERE billing_customer_id = v_bc AND status IN ('ACTIVE', 'GRACE')
     AND effective_start <= now() AND (effective_end IS NULL OR effective_end > now())
   ORDER BY effective_start DESC LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'no_current_licence');
  END IF;
  IF v_lic.renewal_status = 'NON_RENEWING' THEN
    RETURN jsonb_build_object('outcome', 'already_non_renewing', 'licence_id', v_lic.id, 'effective_end', v_lic.effective_end);
  END IF;
  UPDATE public.commercial_licences SET renewal_status = 'NON_RENEWING', updated_at = now() WHERE id = v_lic.id;
  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  VALUES (v_bc, v_uid, 'RENEWAL_STOPPED',
          jsonb_build_object('licence_id', v_lic.id, 'renewal_status', 'RENEWS'),
          jsonb_build_object('licence_id', v_lic.id, 'renewal_status', 'NON_RENEWING', 'status', v_lic.status, 'effective_end', v_lic.effective_end),
          left(coalesce(p_reason, ''), 500));
  RETURN jsonb_build_object('outcome', 'renewal_stopped', 'licence_id', v_lic.id, 'status', v_lic.status, 'effective_end', v_lic.effective_end);
END;
$$;
REVOKE ALL ON FUNCTION public.stop_commercial_renewal(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stop_commercial_renewal(TEXT) TO authenticated;
