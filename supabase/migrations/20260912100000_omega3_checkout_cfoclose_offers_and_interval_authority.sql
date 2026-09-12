-- Ω3-CHECKOUT — CFOClose commercial offers, mandatory billing-interval
-- authority, product-scoped resolution, and CFOClose product/plan naming.
--
-- Forward-only. No historical row is deleted or rewritten. No migration
-- file is edited in place. This migration completes the ALREADY-LIVE
-- Ω2-G / Ω3.0 commercial-payments schema (see
-- 20260906083524_eca6c272-4a62-4468-995b-1c70e2cd67e5.sql and
-- 20260906120000_omega3_0_effective_history_and_platform_state.sql) —
-- it does not introduce a parallel checkout architecture.
--
-- What this migration does:
--   1. Renames the existing single commercial product from SAFF_ERP to
--      CFOCLOSE (code + display name only — the row's UUID `id` is
--      unchanged, so every existing FK reference by id, every existing
--      billing_customer, licence, payment_event and entitlement, is
--      completely unaffected). Renames the PAID plan's display name from
--      "Firm Licence" to "CFOClose Professional", matching
--      src/constants/copy.ts's PRICING.PAID_NAME.
--   2. Seeds two non-purchasable commercial_offers rows for CFOClose
--      Professional × GLOBAL × USD: MONTHLY (amount_minor 4900) and
--      ANNUAL (amount_minor 49900), matching src/constants/copy.ts's
--      PRICING constants exactly. is_purchasable defaults to false — an
--      operator makes an offer purchasable later via the existing audited
--      admin RPC, entirely outside this migration's authority.
--   3. Retires the ambiguous 2-argument resolve_commercial_offer(plan,
--      market) overload and replaces it with a product-scoped, MANDATORY-
--      billing-interval 3-argument version. The old overload returned
--      AMBIGUOUS the moment a second (interval-differentiated) purchasable
--      offer existed for the same plan/market/currency family — which is
--      now the CFOClose Professional/GLOBAL/USD family created in step 2.
--      Expand -> cutover -> contract, all within this one migration
--      (safe because checkout has never been live to real traffic: it
--      remains behind commercial_platform_state = PAYMENTS_DISABLED,
--      completely unchanged by this migration, and every calling site in
--      this same pull request is updated to the new 3-argument form in
--      lockstep — there is no live caller left depending on the retired
--      2-argument overload after this migration and its accompanying code
--      changes deploy together).
--   4. Adds platform-state gating directly inside resolve_commercial_offer:
--      an otherwise-AVAILABLE resolution is NEVER returned while
--      commercial_platform_state.state = 'PAYMENTS_DISABLED' (its current,
--      unchanged live value) — so this migration alone changes ZERO live
--      behavior. Checkout becomes resolvable only once an operator
--      explicitly advances the platform state via the existing, audited
--      admin_transition_platform_state RPC — an action this migration
--      does not take and is not authorized to take.
--   5. Adds product-scoping to admin_upsert_commercial_offer (a new,
--      optional p_product_code parameter, defaulting to 'CFOCLOSE') so a
--      future second product's plan codes can never collide with this
--      product's, closing the gap flagged by the Ω3-CHECKOUT design
--      package's COMMERCIAL_ARCHITECTURE_AUDIT.md review.
--   6. Extends get_my_billing_summary() to also report the current
--      licence's billing_interval / billing_interval_count (derived from
--      the PAYMENT_CONFIRMED payment_event that produced it, when one
--      exists — NULL for a FREE/admin-granted licence with no originating
--      checkout), so Settings can display the customer's billing interval
--      and offer a like-for-like manual-renewal action.
--   7. Adds a partial unique index enforcing that a billing customer can
--      never hold more than one CREATED/PENDING checkout intent against
--      the SAME commercial offer at once — the atomic "acquire or safe
--      reuse" primitive commercial-create-checkout's own code change (this
--      same pull request) relies on: a concurrent duplicate request either
--      finds the still-open intent first, or loses an atomic unique-
--      constraint race and is told to reuse the winner's intent — never a
--      second, independently-charged checkout for the same offer.
--
-- Explicitly NOT done here (see the accompanying implementation report for
-- the reasoning): no pg_cron/pg_net reconciliation worker, no distributed
-- lease/fencing-token protocol, no second (sandbox vs production)
-- Flutterwave credential pair, no customer-level advisory lock beyond the
-- existing FOR UPDATE row lock in commit_verified_commercial_payment and
-- the existing GiST no-overlap exclusion constraint on commercial_licences
-- — none of these are required to make the trusted checkout kernel
-- correct today, and the Ω3-CHECKOUT charter explicitly prohibits
-- speculative infrastructure absent executable evidence of necessity.

SET search_path TO public, pg_catalog;

-- ============================================================
-- 1. CFOClose product + plan naming (presentation-only; ids unchanged)
-- ============================================================

UPDATE public.commercial_products
   SET code = 'CFOCLOSE', name = 'CFOClose'
 WHERE code = 'SAFF_ERP';

UPDATE public.commercial_plans
   SET name = 'CFOClose Professional'
 WHERE code = 'PAID'
   AND product_id = (SELECT id FROM public.commercial_products WHERE code = 'CFOCLOSE');

-- Executable assertion: exactly one product now carries the CFOCLOSE code,
-- and the PAID plan under it now carries the CFOClose Professional name.
-- Fails closed (aborts the whole migration) rather than silently renaming
-- zero rows if the expected pre-migration seed data is not what this
-- migration assumes.
DO $$
DECLARE
  v_product_count INTEGER;
  v_plan_name     TEXT;
BEGIN
  SELECT count(*) INTO v_product_count FROM public.commercial_products WHERE code = 'CFOCLOSE';
  IF v_product_count != 1 THEN
    RAISE EXCEPTION 'CFOCLOSE_PRODUCT_RENAME_FAILED: expected exactly 1 product with code CFOCLOSE, found %', v_product_count;
  END IF;

  SELECT cp.name INTO v_plan_name
    FROM public.commercial_plans cp
    JOIN public.commercial_products co ON co.id = cp.product_id
   WHERE co.code = 'CFOCLOSE' AND cp.code = 'PAID';
  IF v_plan_name IS DISTINCT FROM 'CFOClose Professional' THEN
    RAISE EXCEPTION 'CFOCLOSE_PLAN_RENAME_FAILED: expected PAID plan name ''CFOClose Professional'', found %', v_plan_name;
  END IF;
END $$;

-- ============================================================
-- 2. Seed CFOClose Professional MONTHLY + ANNUAL offers (GLOBAL, USD)
--    Non-purchasable by default (column default) — an operator must
--    explicitly flip is_purchasable via the existing admin RPC.
-- ============================================================

INSERT INTO public.commercial_offers (
  offer_code, plan_id, market_code, currency_code, amount_minor,
  currency_exponent, billing_interval, billing_interval_count
)
SELECT
  'CFOCLOSE_PROFESSIONAL_GLOBAL_USD_MONTHLY',
  cp.id, 'GLOBAL', 'USD', 4900, 2, 'MONTHLY', 1
FROM public.commercial_plans cp
JOIN public.commercial_products co ON co.id = cp.product_id
WHERE co.code = 'CFOCLOSE' AND cp.code = 'PAID'
ON CONFLICT (offer_code) DO NOTHING;

INSERT INTO public.commercial_offers (
  offer_code, plan_id, market_code, currency_code, amount_minor,
  currency_exponent, billing_interval, billing_interval_count
)
SELECT
  'CFOCLOSE_PROFESSIONAL_GLOBAL_USD_ANNUAL',
  cp.id, 'GLOBAL', 'USD', 49900, 2, 'ANNUAL', 1
FROM public.commercial_plans cp
JOIN public.commercial_products co ON co.id = cp.product_id
WHERE co.code = 'CFOCLOSE' AND cp.code = 'PAID'
ON CONFLICT (offer_code) DO NOTHING;

-- Executable assertion: both authoritative offers exist, are non-
-- purchasable, and carry exactly the economics src/constants/copy.ts
-- documents (amount_minor 4900/49900, exponent 2, currency USD).
DO $$
DECLARE
  v_monthly RECORD;
  v_annual  RECORD;
BEGIN
  SELECT amount_minor, currency_exponent, currency_code, is_purchasable
    INTO v_monthly
    FROM public.commercial_offers WHERE offer_code = 'CFOCLOSE_PROFESSIONAL_GLOBAL_USD_MONTHLY';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CFOCLOSE_MONTHLY_OFFER_MISSING';
  END IF;
  IF v_monthly.amount_minor != 4900 OR v_monthly.currency_exponent != 2 OR v_monthly.currency_code != 'USD' THEN
    RAISE EXCEPTION 'CFOCLOSE_MONTHLY_OFFER_ECONOMICS_MISMATCH: got amount_minor=%, exponent=%, currency=%',
      v_monthly.amount_minor, v_monthly.currency_exponent, v_monthly.currency_code;
  END IF;
  IF v_monthly.is_purchasable THEN
    RAISE EXCEPTION 'CFOCLOSE_MONTHLY_OFFER_UNEXPECTEDLY_PURCHASABLE: this migration must seed it non-purchasable';
  END IF;

  SELECT amount_minor, currency_exponent, currency_code, is_purchasable
    INTO v_annual
    FROM public.commercial_offers WHERE offer_code = 'CFOCLOSE_PROFESSIONAL_GLOBAL_USD_ANNUAL';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CFOCLOSE_ANNUAL_OFFER_MISSING';
  END IF;
  IF v_annual.amount_minor != 49900 OR v_annual.currency_exponent != 2 OR v_annual.currency_code != 'USD' THEN
    RAISE EXCEPTION 'CFOCLOSE_ANNUAL_OFFER_ECONOMICS_MISMATCH: got amount_minor=%, exponent=%, currency=%',
      v_annual.amount_minor, v_annual.currency_exponent, v_annual.currency_code;
  END IF;
  IF v_annual.is_purchasable THEN
    RAISE EXCEPTION 'CFOCLOSE_ANNUAL_OFFER_UNEXPECTEDLY_PURCHASABLE: this migration must seed it non-purchasable';
  END IF;
END $$;

-- ============================================================
-- 3/4. resolve_commercial_offer — expand -> cutover -> contract.
--    New 3-arg (plan, billing_interval, market) signature: mandatory
--    billing interval, product-scoped plan lookup, platform-state gated.
-- ============================================================

CREATE OR REPLACE FUNCTION public.resolve_commercial_offer(
  p_plan_code        TEXT,
  p_billing_interval TEXT,
  p_market_code      TEXT DEFAULT 'GLOBAL'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_plan_id      UUID;
  v_count        INTEGER;
  v_offer        RECORD;
  v_used_market  TEXT;
  v_platform_state TEXT;
BEGIN
  -- Mandatory billing interval (Ω3-CHECKOUT trust boundary: the browser
  -- may submit planCode and billingInterval only — every other economic
  -- fact, including WHICH interval-differentiated offer applies, is
  -- resolved authoritatively here). A missing/unsupported value is a
  -- distinct, explicit UNKNOWN outcome — never a silent default to
  -- whichever offer happens to exist.
  IF p_billing_interval IS NULL OR p_billing_interval NOT IN ('MONTHLY', 'ANNUAL') THEN
    RETURN jsonb_build_object('resolution', 'UNKNOWN', 'reason', 'UNKNOWN_BILLING_INTERVAL');
  END IF;

  IF p_market_code IS NULL OR p_market_code NOT IN ('GLOBAL','TZ','MU','GB','EU') THEN
    RETURN jsonb_build_object('resolution','UNKNOWN','reason','UNKNOWN_MARKET_CODE');
  END IF;

  -- Product-scoped plan lookup: CFOClose's own plan family only. A future
  -- second product's identically-coded plan (e.g. another product's own
  -- "PAID") can never be resolved or purchased through this function.
  SELECT cp.id INTO v_plan_id
    FROM public.commercial_plans cp
    JOIN public.commercial_products co ON co.id = cp.product_id
   WHERE cp.code = p_plan_code AND cp.is_active AND co.code = 'CFOCLOSE';
  IF v_plan_id IS NULL THEN
    RETURN jsonb_build_object('resolution','UNKNOWN','reason','UNKNOWN_OR_INACTIVE_PLAN_CODE');
  END IF;

  -- Platform-state gate: an otherwise-AVAILABLE resolution is withheld
  -- entirely while payments remain platform-disabled. Reading through
  -- SECURITY DEFINER (not the caller's own RLS-restricted read) is safe
  -- here because this function only ever returns a coarse
  -- AVAILABLE/NOT_AVAILABLE outcome, never the raw platform_state value
  -- itself, to an anon/authenticated caller.
  SELECT state INTO v_platform_state FROM public.commercial_platform_state WHERE id = true;
  IF v_platform_state IS NULL OR v_platform_state = 'PAYMENTS_DISABLED' THEN
    RETURN jsonb_build_object('resolution','NOT_AVAILABLE','plan_code',p_plan_code,
      'requested_market',p_market_code,'billing_interval',p_billing_interval,
      'reason','PLATFORM_PAYMENTS_DISABLED');
  END IF;

  v_used_market := p_market_code;
  SELECT count(*) INTO v_count
    FROM public.commercial_offers co
   WHERE co.plan_id = v_plan_id AND co.market_code = v_used_market
     AND co.billing_interval = p_billing_interval
     AND co.is_active AND co.is_purchasable
     AND co.effective_start <= now() AND (co.effective_end IS NULL OR co.effective_end > now());

  IF v_count = 0 AND v_used_market != 'GLOBAL' THEN
    v_used_market := 'GLOBAL';
    SELECT count(*) INTO v_count
      FROM public.commercial_offers co
     WHERE co.plan_id = v_plan_id AND co.market_code = v_used_market
       AND co.billing_interval = p_billing_interval
       AND co.is_active AND co.is_purchasable
       AND co.effective_start <= now() AND (co.effective_end IS NULL OR co.effective_end > now());
  END IF;

  IF v_count = 0 THEN
    RETURN jsonb_build_object('resolution','NOT_AVAILABLE','plan_code',p_plan_code,
      'requested_market',p_market_code,'billing_interval',p_billing_interval);
  END IF;

  IF v_count > 1 THEN
    RETURN jsonb_build_object('resolution','AMBIGUOUS','plan_code',p_plan_code,
      'market_code',v_used_market,'billing_interval',p_billing_interval);
  END IF;

  SELECT co.id, co.offer_code, co.market_code, co.currency_code, co.amount_minor,
         co.currency_exponent, co.billing_interval, co.billing_interval_count,
         co.provider_restriction
    INTO v_offer
    FROM public.commercial_offers co
   WHERE co.plan_id = v_plan_id AND co.market_code = v_used_market
     AND co.billing_interval = p_billing_interval
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

REVOKE ALL ON FUNCTION public.resolve_commercial_offer(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_commercial_offer(TEXT, TEXT, TEXT) TO anon, authenticated;

COMMENT ON FUNCTION public.resolve_commercial_offer(TEXT, TEXT, TEXT) IS
  'Ω3-CHECKOUT: pure server-side offer resolver. Billing interval is '
  'MANDATORY (MONTHLY or ANNUAL) — never inferred, never defaulted. '
  'Product-scoped to CFOCLOSE. Gated on commercial_platform_state: '
  'returns NOT_AVAILABLE (PLATFORM_PAYMENTS_DISABLED) while payments '
  'remain platform-disabled, regardless of offer configuration. Returns '
  'AVAILABLE/NOT_AVAILABLE/AMBIGUOUS/UNKNOWN explicitly — never silently '
  'picks between equally authoritative offers, never accepts browser-'
  'supplied price/currency, never accepts locale/IP. Callable by '
  'anon/authenticated for pricing display; commercial-create-checkout '
  're-resolves server-side regardless of what the browser echoes back.';

-- Contract: retire the now-unsafe 2-argument overload. It could only ever
-- resolve correctly when at most one purchasable offer existed per plan/
-- market/currency family; the CFOClose Professional/GLOBAL/USD family
-- created by this same migration has two (MONTHLY, ANNUAL), which the old
-- overload would resolve as AMBIGUOUS for every caller, forever. No
-- caller of the 2-argument form survives this pull request.
DROP FUNCTION IF EXISTS public.resolve_commercial_offer(TEXT, TEXT);

-- ============================================================
-- 5. admin_upsert_commercial_offer — product-scoped plan lookup
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

  -- Product-scoped plan lookup (Ω3-CHECKOUT correction): a plan code is
  -- authoritative only within its own product family. Without this join,
  -- a second product reusing a plan code (e.g. another product's own
  -- "PAID") could have its offers silently mutated by an admin call
  -- intending a completely different product.
  SELECT cp.id INTO v_plan_id
    FROM public.commercial_plans cp
    JOIN public.commercial_products co ON co.id = cp.product_id
   WHERE cp.code = p_plan_code AND co.code = p_product_code;
  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_PLAN_CODE_FOR_PRODUCT: % / %', p_product_code, p_plan_code USING ERRCODE = '22023';
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

REVOKE ALL ON FUNCTION public.admin_upsert_commercial_offer(TEXT,TEXT,TEXT,TEXT,BIGINT,SMALLINT,TEXT,SMALLINT,BOOLEAN,BOOLEAN,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_commercial_offer(TEXT,TEXT,TEXT,TEXT,BIGINT,SMALLINT,TEXT,SMALLINT,BOOLEAN,BOOLEAN,TEXT,TEXT) TO authenticated;

-- Old 11-arg overload (no product_code) is superseded by the 12-arg form
-- above (product_code defaults to 'CFOCLOSE', so every existing call site
-- continues to work unchanged) — but retire it explicitly rather than
-- leave two overloads live, since a caller that omits product_code should
-- go through the new, product-scoped code path, not a stale duplicate.
DROP FUNCTION IF EXISTS public.admin_upsert_commercial_offer(TEXT,TEXT,TEXT,TEXT,BIGINT,SMALLINT,TEXT,SMALLINT,BOOLEAN,BOOLEAN,TEXT);

-- ============================================================
-- 6. get_my_billing_summary — report the current licence's billing
--    interval (NULL when the licence has no originating checkout, e.g.
--    the auto-provisioned FREE licence or an admin-granted licence).
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_my_billing_summary()
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  STABLE
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id             UUID := auth.uid();
  v_billing_customer_id UUID;
  v_result              JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  SELECT id INTO v_billing_customer_id
    FROM public.billing_customers WHERE owner_user_id = v_user_id;

  IF v_billing_customer_id IS NULL THEN
    RETURN jsonb_build_object(
      'has_billing_customer', false, 'plan_code', NULL, 'licence_status', NULL,
      'effective_start', NULL, 'effective_end', NULL, 'entitlements', '[]'::jsonb,
      'billing_interval', NULL, 'billing_interval_count', NULL
    );
  END IF;

  SELECT jsonb_build_object(
    'has_billing_customer', true,
    'plan_code', cp.code,
    'licence_status', cl.status,
    'effective_start', cl.effective_start,
    'effective_end', cl.effective_end,
    'entitlements', to_jsonb(cp.feature_codes),
    'billing_interval', pci.billing_interval,
    'billing_interval_count', pci.billing_interval_count
  ) INTO v_result
    FROM public.commercial_licences cl
    JOIN public.commercial_plans cp ON cp.id = cl.plan_id
    LEFT JOIN LATERAL (
      SELECT pe.checkout_intent_id
        FROM public.payment_events pe
       WHERE pe.licence_id = cl.id AND pe.event_type = 'PAYMENT_CONFIRMED'
       ORDER BY pe.event_time DESC
       LIMIT 1
    ) latest_evt ON true
    LEFT JOIN public.payment_checkout_intents pci ON pci.id = latest_evt.checkout_intent_id
   WHERE cl.billing_customer_id = v_billing_customer_id
     AND cl.effective_start <= now()
     AND (cl.effective_end IS NULL OR cl.effective_end > now())
   ORDER BY cl.effective_start DESC
   LIMIT 1;

  IF v_result IS NULL THEN
    RETURN jsonb_build_object(
      'has_billing_customer', true, 'plan_code', NULL, 'licence_status', NULL,
      'effective_start', NULL, 'effective_end', NULL, 'entitlements', '[]'::jsonb,
      'billing_interval', NULL, 'billing_interval_count', NULL
    );
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_billing_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_billing_summary() TO authenticated;

COMMENT ON FUNCTION public.get_my_billing_summary() IS
  'Ω3-CHECKOUT: as Ω1, plus billing_interval/billing_interval_count of '
  'the current licence''s originating PAYMENT_CONFIRMED event, when one '
  'exists (NULL for FREE/admin-granted licences with no checkout). Used '
  'by Settings to display the customer''s billing interval and to offer '
  'a like-for-like manual-renewal checkout.';

-- ============================================================
-- 7. Atomic checkout-intent acquisition — one open intent per
--    customer+offer at a time.
-- ============================================================

CREATE UNIQUE INDEX uq_pci_one_open_intent_per_customer_offer
  ON public.payment_checkout_intents (billing_customer_id, commercial_offer_id)
  WHERE status IN ('CREATED', 'PENDING');

COMMENT ON INDEX public.uq_pci_one_open_intent_per_customer_offer IS
  'Ω3-CHECKOUT: at most one non-terminal (CREATED/PENDING) checkout '
  'intent may exist per (billing_customer_id, commercial_offer_id) pair '
  'at any instant. This is the atomic primitive commercial-create-'
  'checkout''s acquire-or-reuse logic relies on: a concurrent duplicate '
  'request either observes the still-open intent first, or loses this '
  'unique-constraint race and is told to reuse the winner''s intent — '
  'never creates a second, independently-charged checkout for the same '
  'offer. A terminal intent (SUCCEEDED/FAILED/CANCELLED/EXPIRED) is '
  'excluded from the predicate, so a genuinely new checkout attempt after '
  'a prior one concluded is never blocked.';
