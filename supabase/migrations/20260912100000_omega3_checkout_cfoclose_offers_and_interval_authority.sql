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
--      second, independently-charged checkout for the same offer. A
--      preflight check (item 9 below) proves no pre-existing row would
--      violate this index before it is created.
--   8. CORRECTED (Codex Ω∞ A+ re-audit, BLOCKER-level): replaces
--      commit_verified_commercial_payment with a 13-argument version
--      (expand -> cutover -> contract, same discipline as items 3/5) that
--      (a) NEVER rejects an already-independently-verified SUCCEEDED
--      payment merely because local wall-clock time exceeded the
--      checkout intent's expires_at — the prior version could charge a
--      customer via Flutterwave and then permanently refuse to grant the
--      licence they paid for, solely because verification arrived late;
--      (b) acquires a transaction-scoped advisory lock keyed on the
--      billing customer, BEFORE the existing per-intent FOR UPDATE lock,
--      so two DIFFERENT intents for the SAME customer (e.g. a MONTHLY and
--      an ANNUAL checkout paid concurrently) can never both proceed to
--      the licence-insert step in parallel — the prior version locked
--      only the intent row, so two concurrent commits could both charge
--      successfully while the SECOND licence insert aborted outright on
--      the GiST no-overlap exclusion constraint, an unhandled failure
--      mode; with the customer serialized, the second commit correctly
--      observes the first's newly-granted licence and stacks its own
--      period immediately after it instead of racing; (c) requires and
--      validates a new p_provider_environment argument against the
--      value snapshotted on the intent at checkout-creation time (item
--      10), failing closed (never treating a NULL/mismatched value as
--      acceptable) rather than silently committing across a sandbox/
--      production boundary mismatch.
--   9. Adds an executable duplicate-row preflight check, run BEFORE
--      CREATE UNIQUE INDEX uq_pci_one_open_intent_per_customer_offer,
--      that aborts the migration with a clear, named diagnostic if any
--      pre-existing (billing_customer_id, commercial_offer_id, status IN
--      CREATED/PENDING) row would violate the index — rather than
--      letting index creation itself fail with a bare constraint-
--      violation error carrying no actionable context.
--  10. Adds payment_checkout_intents.provider_environment (nullable;
--      NULL means NOT COMPUTED, per this project's own Iron Dome
--      invariant — never silently treated as a match), snapshotted by
--      commercial-create-checkout at intent-creation time from the
--      SAME routing capability that already determines which credential
--      pair is live (routing.ts's FLUTTERWAVE_CAPABILITIES.environment),
--      and independently validated by commit_verified_commercial_payment
--      (item 8) at commit time.
--
-- Explicitly NOT done here (see the accompanying implementation report for
-- the reasoning): no pg_cron/pg_net reconciliation worker, no distributed
-- lease/fencing-token protocol, no second (sandbox vs production)
-- Flutterwave CREDENTIAL pair (this migration adds environment
-- SNAPSHOTTING/VALIDATION using whichever single credential pair is
-- currently configured — provisioning an actual second credential pair
-- is a deployment/secrets action explicitly outside this migration's
-- authority) — none of these are required to make the trusted checkout
-- kernel correct today, and the Ω3-CHECKOUT charter explicitly prohibits
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
  v_user_id       UUID := auth.uid();
  v_plan_id       UUID;
  v_offer_id      UUID;
  v_offer_plan_id UUID;
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

  -- CORRECTED (Codex Ω∞ A+ re-audit, HIGH): the prior version matched an
  -- existing offer by offer_code ALONE (globally unique, but NOT scoped
  -- to any plan/product) and updated it without ever proving it belongs
  -- to the plan/product family p_plan_code/p_product_code just resolved
  -- above. An admin call intending to edit ONE plan's catalog, using an
  -- offer_code that happens to already exist under a COMPLETELY
  -- DIFFERENT plan (e.g. reused by mistake, or a genuine naming
  -- collision), would silently repoint that other plan's real offer —
  -- while the audit log recorded the change as if it were for the
  -- caller's own intended plan_code. Ownership is now proven explicitly
  -- before any UPDATE is permitted.
  SELECT id, plan_id, to_jsonb(co.*) INTO v_offer_id, v_offer_plan_id, v_previous
    FROM public.commercial_offers co WHERE co.offer_code = p_offer_code;

  IF v_offer_id IS NOT NULL AND v_offer_plan_id != v_plan_id THEN
    RAISE EXCEPTION 'OFFER_CODE_BELONGS_TO_DIFFERENT_PLAN: offer_code % belongs to plan_id %, not the resolved plan_id % for %/%',
      p_offer_code, v_offer_plan_id, v_plan_id, p_product_code, p_plan_code
      USING ERRCODE = '22023';
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
-- 7/10. provider_environment — snapshot column on the checkout intent.
--    NULL means NOT COMPUTED (this project's own Iron Dome invariant) —
--    never silently treated as a match by the commit-time validation in
--    commit_verified_commercial_payment below.
-- ============================================================

ALTER TABLE public.payment_checkout_intents
  ADD COLUMN provider_environment TEXT NULL
    CONSTRAINT chk_pci_provider_environment CHECK (
      provider_environment IS NULL OR provider_environment IN ('sandbox', 'production')
    );

COMMENT ON COLUMN public.payment_checkout_intents.provider_environment IS
  'Ω3-CHECKOUT: snapshotted by commercial-create-checkout at intent-'
  'creation time from routing.ts''s FLUTTERWAVE_CAPABILITIES.environment '
  '(the same source that determines which credential pair is live). '
  'commit_verified_commercial_payment requires this to match the '
  'environment it is itself running under at commit time, failing closed '
  '(never treating NULL as a match) on any mismatch — see '
  'PROVIDER_ENVIRONMENT_MISMATCH below.';

-- ============================================================
-- 9. Atomic checkout-intent acquisition — one open intent per
--    customer+offer at a time. Preflight BEFORE the index, so a
--    pre-existing conflicting row aborts with a clear diagnostic rather
--    than a bare constraint-violation error during index creation.
-- ============================================================

DO $$
DECLARE
  v_conflict RECORD;
  v_conflict_count INTEGER;
BEGIN
  SELECT count(*) INTO v_conflict_count FROM (
    SELECT billing_customer_id, commercial_offer_id
      FROM public.payment_checkout_intents
     WHERE status IN ('CREATED', 'PENDING')
     GROUP BY billing_customer_id, commercial_offer_id
    HAVING count(*) > 1
  ) dupes;
  IF v_conflict_count > 0 THEN
    SELECT billing_customer_id, commercial_offer_id, count(*) AS n
      INTO v_conflict
      FROM public.payment_checkout_intents
     WHERE status IN ('CREATED', 'PENDING')
     GROUP BY billing_customer_id, commercial_offer_id
    HAVING count(*) > 1
     LIMIT 1;
    RAISE EXCEPTION 'PRE_EXISTING_OPEN_INTENT_DUPLICATES_FOUND: % conflicting (billing_customer_id, commercial_offer_id) group(s) exist with more than one open CREATED/PENDING row — example: billing_customer_id=%, commercial_offer_id=%, count=%. Resolve (e.g. mark all but the most recent as CANCELLED) before this migration can safely add the unique index.',
      v_conflict_count, v_conflict.billing_customer_id, v_conflict.commercial_offer_id, v_conflict.n;
  END IF;
END $$;

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
  'a prior one concluded is never blocked. A preflight check (immediately '
  'above) proved no pre-existing row violates this index before it was '
  'created.';

-- ============================================================
-- 8. commit_verified_commercial_payment — expand -> cutover -> contract.
--    New 13-argument version: no wall-clock expiry rejection of an
--    already-verified SUCCEEDED payment; customer-level advisory-lock
--    serialization; mandatory provider_environment validation.
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
  SELECT id INTO v_existing_evt FROM public.payment_events
   WHERE idempotency_key = p_idempotency_key;
  IF v_existing_evt IS NOT NULL THEN
    RETURN jsonb_build_object('status','ALREADY_COMMITTED','event_id',v_existing_evt,'committed',false);
  END IF;

  -- Ω3-CHECKOUT customer-level serialization (BLOCKER fix): look up which
  -- billing customer this intent belongs to WITHOUT yet locking the
  -- intent row, then take a transaction-scoped advisory lock keyed on
  -- that customer BEFORE any other logic runs. Two DIFFERENT checkout
  -- intents for the SAME customer (e.g. a MONTHLY and an ANNUAL request
  -- fired concurrently) previously could both commit fully in parallel —
  -- each locked only its OWN intent row via the FOR UPDATE below — so
  -- both could independently pass every check, then race to INSERT into
  -- commercial_licences, where only ONE would survive the GiST no-overlap
  -- exclusion constraint and the OTHER would abort with an unhandled
  -- exception AFTER Flutterwave had already been charged for it. This
  -- lock serializes the ENTIRE commit (read current licence -> compute
  -- period -> close prior -> insert new) per customer: the second
  -- transaction blocks here until the first's commits, then correctly
  -- observes the first's newly-inserted licence and stacks its own
  -- period immediately after it — both payments are honoured,
  -- sequentially, never in conflict, never silently dropped.
  SELECT billing_customer_id INTO v_billing_customer_id
    FROM public.payment_checkout_intents WHERE id = p_checkout_intent_id;
  IF v_billing_customer_id IS NULL THEN
    RAISE EXCEPTION 'Iron Dome: checkout_intent % not found', p_checkout_intent_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_billing_customer_id::text));

  SELECT * INTO v_intent FROM public.payment_checkout_intents
   WHERE id = p_checkout_intent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Iron Dome: checkout_intent % not found', p_checkout_intent_id;
  END IF;
  IF v_intent.status NOT IN ('CREATED','PENDING') THEN
    RETURN jsonb_build_object('status','INTENT_ALREADY_RESOLVED','intent_status',v_intent.status,'committed',false);
  END IF;

  -- CORRECTED (Codex Ω∞ A+ re-audit, BLOCKER): this function previously
  -- rejected an already-independently-verified SUCCEEDED payment purely
  -- because local wall-clock time had passed intent.expires_at,
  -- contradicting TIMESTAMP_AUTHORITY_DECISION.md's own stated invariant.
  -- A customer whose webhook or status-poll verification arrives even
  -- slightly late would have been genuinely charged by Flutterwave (Gate
  -- A and Gate B both already passed by the time this function runs) and
  -- then PERMANENTLY denied the licence they paid for. expires_at is
  -- enforced ONLY where it belongs — commercial-create-checkout's own
  -- acquire-or-reuse logic, gating whether an open intent may still be
  -- treated as reusable / whether a NEW provider checkout page may be
  -- opened for it — never re-checked here once a provider has already
  -- independently confirmed SUCCEEDED.

  IF p_amount_minor != v_intent.expected_amount_minor THEN
    RAISE EXCEPTION 'Iron Dome: amount mismatch. Expected % minor units, got % for intent %',
      v_intent.expected_amount_minor, p_amount_minor, p_checkout_intent_id;
  END IF;
  IF p_currency_code != v_intent.currency_code THEN
    RAISE EXCEPTION 'Iron Dome: currency mismatch. Expected %, got % for intent %',
      v_intent.currency_code, p_currency_code, p_checkout_intent_id;
  END IF;

  -- Provider-environment validation (HIGH fix): NULL on either side is
  -- NEVER treated as a match (NULL-means-NOT-COMPUTED) — a genuinely
  -- unsnapshotted or unresolvable environment fails closed exactly like
  -- an amount/currency mismatch, since committing across a sandbox/
  -- production boundary mismatch is exactly the class of silent-
  -- corruption this project's Iron Dome discipline forbids.
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
  'Ω3-CHECKOUT Iron Dome atomic commit: customer-serialized (advisory '
  'lock) -> intent validation (no wall-clock expiry rejection of an '
  'already-verified payment) -> provider-environment validation -> '
  'payment event -> licence (closing out any prior ACTIVE/GRACE licence '
  'first) -> audit -> done. Idempotent. service_role only. No partial '
  'commits — full rollback on any failure.';

-- Contract: retire the now-superseded 12-argument overload. The webhook
-- (its sole live caller) is updated to pass p_provider_environment in
-- this same pull request — no caller of the 12-argument form survives.
DROP FUNCTION IF EXISTS public.commit_verified_commercial_payment(UUID,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT);

-- ============================================================
-- 11. get_checkout_status — expose the fields commercial-payment-status
--    needs to independently re-verify a still-open intent (BLOCKER fix).
--    Same signature (p_saff_reference TEXT) — CREATE OR REPLACE only,
--    no expand/contract needed.
-- ============================================================

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
    -- Ω3-CHECKOUT (BLOCKER fix, webhook/status convergence): the exact
    -- economics an independent re-verification of this SAME intent must
    -- match, so commercial-payment-status can call verifyTransactionByReference
    -- itself when the intent is still non-terminal and no webhook has
    -- (yet, or ever) arrived — never re-deriving these from anywhere else.
    'expected_amount_minor', v_intent.expected_amount_minor,
    'currency_code', v_intent.currency_code,
    'licence_status',v_billing.licence_status,'plan_code',v_billing.plan_code,
    'effective_start',v_billing.effective_start,'effective_end',v_billing.effective_end
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_checkout_status FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_checkout_status TO authenticated;

COMMENT ON FUNCTION public.get_checkout_status IS
  'Ω3-CHECKOUT: as Ω2-G, plus expected_amount_minor/currency_code so '
  'commercial-payment-status can independently re-verify a still-open '
  'intent via Flutterwave''s verify-by-reference endpoint when no '
  'webhook has arrived. Owner-scoped (auth.uid()) or commercial-admin — '
  'unchanged from Ω2-G.';
