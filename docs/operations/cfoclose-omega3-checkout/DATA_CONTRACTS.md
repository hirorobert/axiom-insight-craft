# Ω3-CHECKOUT — Data Contracts

Design document. SQL/TypeScript blocks marked **CURRENT** are verbatim quotations of live source (file:line given). Blocks marked **PROPOSED** are design only — not applied anywhere.

**Design-correction round 2 (this revision):** independent review found that round 1's `resolve_commercial_offer` product-scoping relied on `auth.uid()`, but `commercial-create-checkout` invokes every RPC through a **service-role client** (`createClient(SUPABASE_URL, SERVICE_KEY)`, confirmed at `commercial-create-checkout/index.ts:92`) — under a service-role client, `auth.uid()` inside the database is `NULL` regardless of which customer's request triggered the call, so round 1's fallback branch (`IF v_product_id IS NULL THEN v_product_id := commercial_default_product_id()`) would fire on **every single checkout**, silently defeating the fix it was meant to provide. This round separates anonymous catalogue display (which legitimately can and does use `auth.uid()`, because the frontend calls it directly with the user's own session) from checkout authority (which must receive an explicitly, server-derived `billing_customer_id` — never `auth.uid()`, never a client-supplied id). It also replaces the CREATED/NULL-url supersession idea with a token-fenced lease protocol, corrects the offer-activation design (the function round 1 pointed at cannot do what was asked of it), adds exact privilege DDL throughout, adds product identity to `admin_upsert_commercial_offer`, specifies the webhook CHECK-constraint migration and a single, fully-specified reconciliation mechanism, fixes a real provider-selection-index bug in the platform-state gate, and settles the GLOBAL/Tanzania question explicitly rather than by omission.

## 1. Offer resolution — split into display (anonymous-safe) and checkout (service-role-only) functions

**Corrected finding:** round 1 proposed one function, `resolve_commercial_offer`, serving both an anonymous/authenticated display caller (frontend, real user session, `auth.uid()` works) and the service-role checkout caller (`commercial-create-checkout`, `auth.uid()` is NULL). These are different trust contexts with different correct behavior on a missing product, and collapsing them into one function is what produced the `auth.uid()` defect. **They are now two functions.**

### 1a. `resolve_commercial_offer` — public catalogue display only (unchanged trust boundary from round 1, corrected scope statement)

```sql
CREATE OR REPLACE FUNCTION public.resolve_commercial_offer(
  p_plan_code        TEXT,
  p_billing_interval TEXT,                    -- required: no default; ordered before p_market_code
                                                -- so no required parameter follows a defaulted one
  p_market_code      TEXT DEFAULT 'GLOBAL'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_product_id  UUID;
  v_plan_id     UUID;
  v_count       INTEGER;
  v_offer       RECORD;
  v_used_market TEXT;
BEGIN
  IF p_billing_interval IS NULL OR p_billing_interval NOT IN ('MONTHLY', 'ANNUAL') THEN
    RETURN jsonb_build_object('resolution', 'UNKNOWN', 'reason', 'UNKNOWN_OR_MISSING_BILLING_INTERVAL');
  END IF;
  IF p_market_code IS NULL OR p_market_code NOT IN ('GLOBAL','TZ','MU','GB','EU') THEN
    RETURN jsonb_build_object('resolution','UNKNOWN','reason','UNKNOWN_MARKET_CODE');
  END IF;

  -- Correctly scoped to THIS function's actual trust context: it is called
  -- directly by the frontend using the user's own Supabase session (anon
  -- key + their JWT forwarded automatically by supabase-js), so auth.uid()
  -- is genuinely populated here — unlike inside a service-role-invoked
  -- caller (see §1b). A NULL auth.uid() here means a genuinely anonymous
  -- visitor (e.g. a logged-out /pricing view), for whom the single
  -- deployment-default product is the only sensible answer.
  IF v_user_id IS NOT NULL THEN
    SELECT product_id INTO v_product_id
      FROM public.billing_customers WHERE owner_user_id = v_user_id LIMIT 1;
  END IF;
  IF v_product_id IS NULL THEN
    v_product_id := public.commercial_default_product_id();
  END IF;

  SELECT id INTO v_plan_id
    FROM public.commercial_plans
   WHERE product_id = v_product_id AND code = p_plan_code AND is_active;
  IF v_plan_id IS NULL THEN
    RETURN jsonb_build_object('resolution','UNKNOWN','reason','UNKNOWN_OR_INACTIVE_PLAN_CODE');
  END IF;

  v_used_market := p_market_code;
  SELECT count(*) INTO v_count FROM public.commercial_offers co
   WHERE co.plan_id = v_plan_id AND co.market_code = v_used_market
     AND co.billing_interval = p_billing_interval AND co.is_active AND co.is_purchasable
     AND co.effective_start <= now() AND (co.effective_end IS NULL OR co.effective_end > now());

  IF v_count = 0 AND v_used_market != 'GLOBAL' THEN
    v_used_market := 'GLOBAL';
    SELECT count(*) INTO v_count FROM public.commercial_offers co
     WHERE co.plan_id = v_plan_id AND co.market_code = v_used_market
       AND co.billing_interval = p_billing_interval AND co.is_active AND co.is_purchasable
       AND co.effective_start <= now() AND (co.effective_end IS NULL OR co.effective_end > now());
  END IF;

  IF v_count = 0 THEN
    RETURN jsonb_build_object('resolution','NOT_AVAILABLE','plan_code',p_plan_code,'billing_interval',p_billing_interval,'requested_market',p_market_code);
  END IF;
  IF v_count > 1 THEN
    RETURN jsonb_build_object('resolution','AMBIGUOUS','plan_code',p_plan_code,'billing_interval',p_billing_interval,'market_code',v_used_market);
  END IF;

  SELECT co.id, co.offer_code, co.market_code, co.currency_code, co.amount_minor,
         co.currency_exponent, co.billing_interval, co.billing_interval_count, co.provider_restriction
    INTO v_offer FROM public.commercial_offers co
   WHERE co.plan_id = v_plan_id AND co.market_code = v_used_market
     AND co.billing_interval = p_billing_interval AND co.is_active AND co.is_purchasable
     AND co.effective_start <= now() AND (co.effective_end IS NULL OR co.effective_end > now())
   LIMIT 1;

  RETURN jsonb_build_object(
    'resolution','AVAILABLE','offer_id',v_offer.id,'offer_code',v_offer.offer_code,
    'plan_code',p_plan_code,'market_code',v_offer.market_code,'requested_market',p_market_code,
    'fallback_to_global',(v_used_market = 'GLOBAL' AND p_market_code != 'GLOBAL'),
    'currency_code',v_offer.currency_code,'amount_minor',v_offer.amount_minor,
    'currency_exponent',v_offer.currency_exponent,'billing_interval',v_offer.billing_interval,
    'billing_interval_count',v_offer.billing_interval_count,'provider_restriction',v_offer.provider_restriction
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_commercial_offer(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_commercial_offer(TEXT, TEXT, TEXT) TO anon, authenticated;

COMMENT ON FUNCTION public.resolve_commercial_offer IS
  'Ω3-CHECKOUT: DISPLAY-ONLY offer resolver, callable by anon/authenticated. '
  'Relies on auth.uid() being genuinely populated by a real forwarded '
  'session — NEVER call this from a service-role-authenticated context '
  '(auth.uid() would be NULL there, silently falling back to the default '
  'product). commercial-create-checkout MUST call '
  'resolve_commercial_checkout_offer (§1b) instead, which takes an '
  'explicit, server-derived billing_customer_id.';
```
`commercial_default_product_id()` is unchanged from round 1 — a tiny `STABLE` helper naming the existing hardcoded `'SAFF_ERP'` lookup `provision_billing_customer_for_company` already performs, locked down (`REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role` — it is an internal helper; `resolve_commercial_offer` is `SECURITY DEFINER`, so its internal call to this helper is checked against the function owner's privileges, not the calling role's, and needs no separate grant to `anon`/`authenticated`).

### 1b. `resolve_commercial_checkout_offer` — NEW, service-role-only, checkout authority (item 1)

```sql
CREATE OR REPLACE FUNCTION public.resolve_commercial_checkout_offer(
  p_billing_customer_id UUID,
  p_plan_code           TEXT,
  p_billing_interval    TEXT,
  p_market_code         TEXT DEFAULT 'GLOBAL'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_product_id  UUID;
  v_plan_id     UUID;
  v_count       INTEGER;
  v_offer       RECORD;
  v_used_market TEXT;
BEGIN
  IF p_billing_interval IS NULL OR p_billing_interval NOT IN ('MONTHLY', 'ANNUAL') THEN
    RETURN jsonb_build_object('resolution', 'UNKNOWN', 'reason', 'UNKNOWN_OR_MISSING_BILLING_INTERVAL');
  END IF;
  IF p_market_code IS NULL OR p_market_code NOT IN ('GLOBAL','TZ','MU','GB','EU') THEN
    RETURN jsonb_build_object('resolution','UNKNOWN','reason','UNKNOWN_MARKET_CODE');
  END IF;

  -- Product comes ONLY from the billing_customer row identified by the
  -- caller-supplied id — never from auth.uid() (this function is invoked
  -- from a service-role context where auth.uid() is NULL by construction),
  -- and never trusted as a raw value from the HTTP request body (see §2 for
  -- how the Edge Function is required to derive p_billing_customer_id
  -- itself, from the ALREADY-VALIDATED JWT's user id, before calling this
  -- function — this function does not re-authenticate the caller, it
  -- trusts that its caller already did).
  SELECT product_id INTO v_product_id
    FROM public.billing_customers WHERE id = p_billing_customer_id;
  IF v_product_id IS NULL THEN
    RETURN jsonb_build_object('resolution','UNKNOWN','reason','BILLING_CUSTOMER_NOT_FOUND');
  END IF;

  SELECT id INTO v_plan_id
    FROM public.commercial_plans
   WHERE product_id = v_product_id AND code = p_plan_code AND is_active;
  IF v_plan_id IS NULL THEN
    RETURN jsonb_build_object('resolution','UNKNOWN','reason','UNKNOWN_OR_INACTIVE_PLAN_CODE');
  END IF;

  -- (identical counting / fallback / AMBIGUOUS / AVAILABLE logic to §1a,
  -- omitted here for brevity — same v_used_market GLOBAL-fallback rule,
  -- same 5-column family the Ω3.0 uniqueness constraints already protect)
  v_used_market := p_market_code;
  SELECT count(*) INTO v_count FROM public.commercial_offers co
   WHERE co.plan_id = v_plan_id AND co.market_code = v_used_market
     AND co.billing_interval = p_billing_interval AND co.is_active AND co.is_purchasable
     AND co.effective_start <= now() AND (co.effective_end IS NULL OR co.effective_end > now());
  IF v_count = 0 AND v_used_market != 'GLOBAL' THEN
    v_used_market := 'GLOBAL';
    SELECT count(*) INTO v_count FROM public.commercial_offers co
     WHERE co.plan_id = v_plan_id AND co.market_code = v_used_market
       AND co.billing_interval = p_billing_interval AND co.is_active AND co.is_purchasable
       AND co.effective_start <= now() AND (co.effective_end IS NULL OR co.effective_end > now());
  END IF;
  IF v_count = 0 THEN
    RETURN jsonb_build_object('resolution','NOT_AVAILABLE','plan_code',p_plan_code,'billing_interval',p_billing_interval,'requested_market',p_market_code);
  END IF;
  IF v_count > 1 THEN
    RETURN jsonb_build_object('resolution','AMBIGUOUS','plan_code',p_plan_code,'billing_interval',p_billing_interval,'market_code',v_used_market);
  END IF;

  SELECT co.id, co.offer_code, co.market_code, co.currency_code, co.amount_minor,
         co.currency_exponent, co.billing_interval, co.billing_interval_count, co.provider_restriction
    INTO v_offer FROM public.commercial_offers co
   WHERE co.plan_id = v_plan_id AND co.market_code = v_used_market
     AND co.billing_interval = p_billing_interval AND co.is_active AND co.is_purchasable
     AND co.effective_start <= now() AND (co.effective_end IS NULL OR co.effective_end > now())
   LIMIT 1;

  RETURN jsonb_build_object(
    'resolution','AVAILABLE','offer_id',v_offer.id,'offer_code',v_offer.offer_code,
    'plan_code',p_plan_code,'market_code',v_offer.market_code,
    'currency_code',v_offer.currency_code,'amount_minor',v_offer.amount_minor,
    'currency_exponent',v_offer.currency_exponent,'billing_interval',v_offer.billing_interval,
    'billing_interval_count',v_offer.billing_interval_count,'provider_restriction',v_offer.provider_restriction
  );
END;
$$;

-- Exact privilege DDL (item 2): service_role ONLY. No anonymous catalogue
-- browsing, no authenticated-direct-call path — this function's sole
-- caller is commercial-create-checkout, using the service-role client it
-- already holds.
REVOKE ALL ON FUNCTION public.resolve_commercial_checkout_offer(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_commercial_checkout_offer(UUID, TEXT, TEXT, TEXT) TO service_role;
```

**Sole caller in the repository:** `commercial-create-checkout`, updated per §2 below. `resolve_commercial_offer` (§1a) and `resolve_commercial_checkout_offer` (§1b) never call each other and share no code beyond the identical inline offer-counting logic — a future refactor could extract that shared logic into a private `STABLE` helper if desired, but that is a code-cleanliness choice, not a correctness requirement, and is left to implementation time rather than specified here as a new named function this design doesn't otherwise need.

**Overload/deployment discipline (item 1's product-migration angle), unchanged in kind from round 1, restated for the two-function split:** `resolve_commercial_offer(TEXT,TEXT)` (the still-live Ω2-G 2-arg overload) remains subject to the same three-phase `REVOKE`/`DROP` cleanup as before (§ deployment order below). `resolve_commercial_checkout_offer` is entirely new — there is no prior overload to manage for it.

## 2. `commercial-create-checkout` — corrected for service-role-safe product/customer binding, the lease protocol, and provider-selection-ordered platform-state enforcement

**CURRENT** (`supabase/functions/commercial-create-checkout/index.ts`): uses `createClient(SUPABASE_URL, SERVICE_KEY)` throughout (`:92`), resolves `billing_customers` by `owner_user_id = user.id` (`:146-150`, this part is already correct and is reused, not replaced), and inserts directly into `payment_checkout_intents` (`:178-196`).

**PROPOSED — full corrected flow:**
```ts
// 1. validateAuth(...) — UNCHANGED.
// 2. Parse request body — UNCHANGED except marketCode is no longer read at
//    all (removed from the accepted shape entirely, per the prior round's
//    item 2; this round does not revisit that decision).
const body = await req.json();
const planCode: string = body.planCode;
const billingInterval: string = body.billingInterval;
if (!planCode || typeof planCode !== 'string') return json(400, {error:'planCode is required', correlationId});
if (billingInterval !== 'MONTHLY' && billingInterval !== 'ANNUAL') {
  return json(400, {error:'UNKNOWN_OR_MISSING_BILLING_INTERVAL', correlationId});
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY); // service-role, UNCHANGED

// 3. Platform-state gate, PART A (provider-independent checks only — see
//    Part B below, which must run AFTER provider selection, item 8):
const { data: platformState, error: platformStateErr } = await supabase
  .from('commercial_platform_state').select('state').eq('id', true).maybeSingle();
const KNOWN_STATES = ['PAYMENTS_DISABLED','SANDBOX_ONLY','LIVE_ACCEPTANCE','CUSTOMER_PAYMENTS_ENABLED'];
if (platformStateErr || !platformState || !KNOWN_STATES.includes(platformState.state)) {
  return json(503, {error:'PAYMENTS_UNAVAILABLE', correlationId});
}
const state = platformState.state;
if (state === 'PAYMENTS_DISABLED') return json(503, {error:'PAYMENTS_DISABLED', correlationId});

// 4. Resolve billing_customer_id from the VALIDATED user.id — this is the
//    item-1 fix itself. This is an ordinary table SELECT the service-role
//    client is already authorized to run (RLS is bypassed by service_role
//    by definition; the WHERE clause is what provides correctness here,
//    exactly as the pre-existing "resolve billing customer" step already
//    did further down in the old flow — moved earlier because the new
//    checkout resolver (§1b) needs it as an input, not an afterthought).
const { data: billingCustomer, error: bcErr } = await supabase
  .from('billing_customers').select('id').eq('owner_user_id', user.id).single();
if (bcErr || !billingCustomer) {
  return json(404, {error:'Billing account not found. Please contact support.', correlationId});
}

// 5. Restricted-acceptance-identity check (item 8's "choose one mechanism
//    and specify it completely" — resolved as: query commercial_admins
//    directly, the SAME table is_commercial_admin() itself reads, using
//    the already-validated user.id. No new table, no new function, no
//    reliance on auth.uid() (which would be NULL here regardless, the
//    exact same class of bug as item 1) — this is the one mechanism, fully
//    specified, no alternative left open at implementation time.
const { data: adminRow } = await supabase
  .from('commercial_admins').select('user_id').eq('user_id', user.id).maybeSingle();
const isRestrictedAcceptanceIdentity = !!adminRow;

if ((state === 'SANDBOX_ONLY' || state === 'LIVE_ACCEPTANCE') && !isRestrictedAcceptanceIdentity) {
  return json(403, {error: state === 'SANDBOX_ONLY' ? 'SANDBOX_RESTRICTED' : 'LIVE_ACCEPTANCE_RESTRICTED', correlationId});
}

// 6. Resolve the offer via the NEW, service-role-only, customer-bound
//    resolver — never the display resolver.
const { data: resolution, error: resolveErr } = await supabase.rpc('resolve_commercial_checkout_offer', {
  p_billing_customer_id: billingCustomer.id,
  p_plan_code: planCode,
  p_billing_interval: billingInterval,
  p_market_code: 'GLOBAL',   // literal, server-side constant (item 9 — GLOBAL-only checkout, see §9 below)
});
// ... UNKNOWN(404) / NOT_AVAILABLE(402) / AMBIGUOUS(500) / AVAILABLE(proceed) — UNCHANGED shape from round 1.

// 7. Route to a provider — UNCHANGED call, but its RESULT now drives the
//    platform-state Part B check below, instead of an arbitrary array index.
const providerSelection = selectPaymentProvider(
  { currencyCode: offer.currency_code!, marketCode: offer.market_code!, providerRestriction: offer.provider_restriction ?? null },
  getConfiguredProviders(),
);
if (!providerSelection.selected) return json(503, {error:'PAYMENT_PROVIDER_UNAVAILABLE', correlationId});
const provider = providerSelection.provider;

// 8. Platform-state gate, PART B — corrected (item 8's confirmed bug fix):
//    round 1 checked getConfiguredProviders()[0].environment, an arbitrary
//    array element that need not be the provider actually selected for
//    THIS offer. The corrected check inspects the SAME capability entry
//    selectPaymentProvider() just chose.
const selectedCapabilities = getConfiguredProviders().find(p => p.provider === provider);
const providerIsSandbox = selectedCapabilities?.environment === 'sandbox';

if (state === 'SANDBOX_ONLY' && !providerIsSandbox) {
  return json(503, {error:'PROVIDER_ENVIRONMENT_MISMATCH', correlationId});
}
if ((state === 'LIVE_ACCEPTANCE' || state === 'CUSTOMER_PAYMENTS_ENABLED') && providerIsSandbox) {
  return json(503, {error:'PROVIDER_ENVIRONMENT_MISMATCH', correlationId});
}

// 9. Acquire a checkout-intent LEASE (replaces the withdrawn round-1
//    "acquire_or_reuse_checkout_intent does everything in one call" design
//    — see §3 below for the full lease/fencing protocol, item 3).
const lease = await supabase.rpc('acquire_checkout_intent_lease', {
  p_billing_customer_id: billingCustomer.id,
  p_offer_id: offer.offer_id,
  p_expected_amount_minor: offer.amount_minor,
  p_currency_code: offer.currency_code,
  p_currency_exponent: offer.currency_exponent,
  p_billing_interval: offer.billing_interval,
  p_billing_interval_count: offer.billing_interval_count,
  p_saff_reference: generateReference(),  // 'CFOCLOSE-' prefix, item 11 from round 1, unchanged
});

if (lease.data.acquired === 'REUSED') {
  return json(200, { saffReference: lease.data.saff_reference, checkoutUrl: lease.data.checkout_url, expiresAt: lease.data.expires_at, provider, correlationId });
}
if (lease.data.acquired === 'LEASE_HELD') {
  // A live, not-yet-expired PROVIDER_CREATING lease exists for this exact
  // customer+offer, held by another in-flight request. This is a narrow,
  // sub-second window in ordinary operation. Return 409 with a
  // machine-readable code the frontend retries once, briefly, rather than
  // surfacing a raw error — never silently wait server-side (an Edge
  // Function must not block indefinitely on another invocation).
  return json(409, {error:'CHECKOUT_IN_PROGRESS', correlationId});
}
// acquired === 'NEW' from here.

// 10. Call the provider — UNCHANGED adapter contract — then persist the
//     result via the token-based CAS (item 3), NEVER a plain UPDATE.
const checkoutResult = await adapter.createCheckout({ ...,  saffReference: lease.data.saff_reference });

if (!checkoutResult.success) {
  await supabase.rpc('fail_checkout_intent_lease', {
    p_intent_id: lease.data.intent_id, p_creation_token: lease.data.creation_token,
  });
  return json(502, {error:'Payment service temporarily unavailable. Please try again.', correlationId});
}

const cas = await supabase.rpc('persist_checkout_provider_result', {
  p_intent_id: lease.data.intent_id,
  p_creation_token: lease.data.creation_token,
  p_checkout_url: checkoutResult.checkoutUrl,
  p_provider_checkout_ref: checkoutResult.providerRef,
});

if (!cas.data.persisted) {
  // Item 3's explicit requirement: NEVER return a URL after a failed CAS.
  // The row's fenced ownership has already moved on (its lease was
  // superseded as stale by a later request, which can only happen if THIS
  // request itself stalled past its own 60-second lease window) — treat
  // this exactly like a provider failure from the caller's perspective.
  return json(502, {error:'Checkout session could not be finalized. Please try again.', correlationId});
}

return json(200, { saffReference: lease.data.saff_reference, checkoutUrl: checkoutResult.checkoutUrl, expiresAt: cas.data.expires_at, provider, correlationId });
```

## 3. Checkout-intent lease/fencing protocol — replaces the withdrawn CREATED/NULL-url supersession design (item 3)

**Why the round-1 design was insufficient:** `acquire_or_reuse_checkout_intent`'s `pg_advisory_xact_lock` is released the instant that ONE RPC call's transaction commits — but the actual external Flutterwave HTTP call happens in the Edge Function's own code, **after** that RPC returns and the lock is gone. A second invocation for the same customer+offer, arriving while the first is still mid-flight calling Flutterwave, would acquire the (now-free) lock immediately and could observe the first request's row still sitting `CREATED`/`checkout_url IS NULL` — round 1's design would have treated that as safely supersedable ("CREATED-without-URL, mark FAILED, create fresh") even though the original request might still be about to succeed a moment later. **New schema and three narrow, single-purpose RPCs replace it:**

**New columns on `payment_checkout_intents`:**
```sql
ALTER TABLE public.payment_checkout_intents
  ADD COLUMN creation_token   UUID        NULL,
  ADD COLUMN lease_expires_at TIMESTAMPTZ NULL;
-- 'PROVIDER_CREATING' extends the existing status CHECK constraint additively.
```

**RPC 1 — `acquire_checkout_intent_lease` (acquire only; never calls the provider):**
```sql
CREATE OR REPLACE FUNCTION public.acquire_checkout_intent_lease(
  p_billing_customer_id UUID, p_offer_id UUID, p_expected_amount_minor BIGINT,
  p_currency_code TEXT, p_currency_exponent SMALLINT, p_billing_interval TEXT,
  p_billing_interval_count SMALLINT, p_saff_reference TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_lock_key BIGINT := hashtextextended(p_billing_customer_id::text || ':' || p_offer_id::text, 0);
  v_existing RECORD;
  v_new_id   UUID;
  v_token    UUID := gen_random_uuid();
BEGIN
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Deterministic staleness sweep — unchanged principle from round 1, now
  -- also covering PROVIDER_CREATING rows whose lease has expired (a
  -- crashed prior attempt), which is the CORRECT and ONLY place a
  -- PROVIDER_CREATING row may ever be superseded: its own expired lease,
  -- never a live one.
  UPDATE public.payment_checkout_intents
     SET status = 'EXPIRED'
   WHERE billing_customer_id = p_billing_customer_id AND commercial_offer_id = p_offer_id
     AND status IN ('CREATED','PENDING') AND expires_at <= now();

  UPDATE public.payment_checkout_intents
     SET status = 'FAILED'
   WHERE billing_customer_id = p_billing_customer_id AND commercial_offer_id = p_offer_id
     AND status = 'PROVIDER_CREATING' AND lease_expires_at <= now();

  -- Reusable: a PENDING row with a real checkout_url, not yet expired.
  SELECT * INTO v_existing FROM public.payment_checkout_intents
   WHERE billing_customer_id = p_billing_customer_id AND commercial_offer_id = p_offer_id
     AND status = 'PENDING' AND expires_at > now() AND checkout_url IS NOT NULL
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('acquired','REUSED','intent_id',v_existing.id,
      'saff_reference',v_existing.saff_reference,'checkout_url',v_existing.checkout_url,'expires_at',v_existing.expires_at);
  END IF;

  -- A LIVE lease (not yet expired) blocks acquisition outright — "never
  -- steal a live lease" (item 3's explicit requirement). This is checked
  -- AFTER the staleness sweep above has already removed any lease that was
  -- genuinely expired, so reaching this branch means a truly concurrent,
  -- still-active attempt is in flight.
  PERFORM 1 FROM public.payment_checkout_intents
   WHERE billing_customer_id = p_billing_customer_id AND commercial_offer_id = p_offer_id
     AND status = 'PROVIDER_CREATING' AND lease_expires_at > now();
  IF FOUND THEN
    RETURN jsonb_build_object('acquired','LEASE_HELD');
  END IF;

  INSERT INTO public.payment_checkout_intents (
    billing_customer_id, commercial_offer_id, expected_amount_minor, currency_code,
    currency_exponent, billing_interval, billing_interval_count, saff_reference,
    status, creation_token, lease_expires_at, expires_at
  ) VALUES (
    p_billing_customer_id, p_offer_id, p_expected_amount_minor, p_currency_code,
    p_currency_exponent, p_billing_interval, p_billing_interval_count, p_saff_reference,
    'PROVIDER_CREATING', v_token, now() + interval '60 seconds', now() + interval '1 hour'
  ) RETURNING id INTO v_new_id;

  RETURN jsonb_build_object('acquired','NEW','intent_id',v_new_id,'creation_token',v_token,'saff_reference',p_saff_reference);
END;
$$;
REVOKE ALL ON FUNCTION public.acquire_checkout_intent_lease(UUID,UUID,BIGINT,TEXT,SMALLINT,TEXT,SMALLINT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_checkout_intent_lease(UUID,UUID,BIGINT,TEXT,SMALLINT,TEXT,SMALLINT,TEXT) TO service_role;
```

**RPC 2 — `persist_checkout_provider_result` (token-based CAS; the only way a `PROVIDER_CREATING` row becomes `PENDING`):**
```sql
CREATE OR REPLACE FUNCTION public.persist_checkout_provider_result(
  p_intent_id UUID, p_creation_token UUID, p_checkout_url TEXT, p_provider_checkout_ref TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE v_row RECORD;
BEGIN
  UPDATE public.payment_checkout_intents
     SET status = 'PENDING', checkout_url = p_checkout_url, provider_checkout_ref = p_provider_checkout_ref,
         creation_token = NULL, lease_expires_at = NULL
   WHERE id = p_intent_id AND creation_token = p_creation_token AND status = 'PROVIDER_CREATING'
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    -- The fence has already moved on (this caller's own lease expired and
    -- was superseded before this UPDATE ran). Report failure explicitly —
    -- the caller (the Edge Function) MUST NOT hand the checkout_url to the
    -- customer in this case (item 3's "never return a URL after failed
    -- CAS"), even though the URL itself is a real, live Flutterwave
    -- session (see the orphan-session note below).
    RETURN jsonb_build_object('persisted', false);
  END IF;
  RETURN jsonb_build_object('persisted', true, 'expires_at', v_row.expires_at);
END;
$$;
REVOKE ALL ON FUNCTION public.persist_checkout_provider_result(UUID,UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_checkout_provider_result(UUID,UUID,TEXT,TEXT) TO service_role;
```

**RPC 3 — `fail_checkout_intent_lease` (explicit failure path, also token-CAS'd, for a provider-call failure rather than a successful-but-unpersisted one):**
```sql
CREATE OR REPLACE FUNCTION public.fail_checkout_intent_lease(p_intent_id UUID, p_creation_token UUID)
RETURNS VOID LANGUAGE sql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog AS $$
  UPDATE public.payment_checkout_intents SET status = 'FAILED', creation_token = NULL, lease_expires_at = NULL
   WHERE id = p_intent_id AND creation_token = p_creation_token AND status = 'PROVIDER_CREATING';
$$;
REVOKE ALL ON FUNCTION public.fail_checkout_intent_lease(UUID,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_checkout_intent_lease(UUID,UUID) TO service_role;
```

**Orphan-provider-session reconciliation (item 3's final requirement):** if a CAS fails (`persisted:false`) because this request's own lease genuinely expired (it took over 60 seconds to hear back from Flutterwave, an unusual but real possibility) and a *later* request already superseded the row, Flutterwave may now hold a real, live checkout session that was never recorded against any `PENDING` intent — but its `tx_ref` **was** already generated as `p_saff_reference` before the provider call, so it is not unrecoverable evidence, merely unattached. Two independent safety nets already cover the customer-harm case without new mechanism: (a) the customer's browser never received this URL (the Edge Function returned a 502, never the URL, per the CAS-failure rule above), so nobody can actually pay against the orphaned session through the normal flow; (b) **if**, hypothetically, a webhook nonetheless arrives later claiming this exact `saff_reference` (e.g. a very unusual client retry that somehow reused the reference, or a manual test), the webhook handler's existing `load intent by saff_reference` step finds the intent in `FAILED` status, not `CREATED`/`PENDING` — `authoriseCommit`'s existing status check (`IF NOT ['CREATED','PENDING'].includes(intent.status)`) already rejects this with `INTENT_ALREADY_RESOLVED`, which is exactly the reconciliation behavior item 3 asks for: never silently committed, never silently discarded (the receipt and processing-event rows are still durably recorded, available for `admin_billing_lookup` review). No new reconciliation code is needed for this specific path — the existing status-check discipline already produces the correct outcome once the lease design ensures the URL was never leaked to a customer in the first place.

## 4. Offer activation/deactivation — a new, narrow, purpose-built RPC (item 4)

**Corrected finding, verified by direct source read of `admin_supersede_commercial_offer` (`20260906120000...sql:446-451`):** this function's signature requires `p_new_offer_code` (`NEW_OFFER_CODE_REQUIRED` if blank) and always **inserts a new row**, closing out an old one (`p_old_offer_code`, nullable only "when opening a brand-new family") — it is a price/economics **succession** operation, not a purchasable-flag toggle on an existing, unchanged row. It cannot activate the two already-created non-purchasable USD rows in place (there is no "new offer" to introduce — the row already exists with the correct economics; only its `is_purchasable` flag needs to change), and calling it to "supersede" a row with an economically-identical new one just to flip one boolean would create a spurious, disproportionate history entry for zero economic change, and still would not let the SAME row's flag ever be set back to `false` for a genuine rollback without introducing a **third** row.

**PROPOSED — `admin_set_offer_purchasable`, a single, narrow, CAS-protected lifecycle RPC:**
```sql
CREATE OR REPLACE FUNCTION public.admin_set_offer_purchasable(
  p_offer_code TEXT, p_expected_current_purchasable BOOLEAN, p_target_purchasable BOOLEAN, p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_offer   RECORD;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT public.is_commercial_admin() THEN RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_expected_current_purchasable = p_target_purchasable THEN
    RAISE EXCEPTION 'NO_OP_TRANSITION_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  -- Expected-state protection (item 4's own phrase): a genuine
  -- compare-and-swap on the boolean, matching the fingerprint-based
  -- pre/post-lock idempotency discipline admin_supersede_commercial_offer
  -- already established elsewhere in this codebase — here expressed as a
  -- direct value comparison because the guarded field is a single boolean,
  -- not a multi-field economic payload.
  SELECT * INTO v_offer FROM public.commercial_offers WHERE offer_code = p_offer_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OFFER_NOT_FOUND: %', p_offer_code USING ERRCODE = '22023'; END IF;
  IF v_offer.is_purchasable IS DISTINCT FROM p_expected_current_purchasable THEN
    RAISE EXCEPTION 'EXPECTED_STATE_MISMATCH: offer % is_purchasable=%, expected %',
      p_offer_code, v_offer.is_purchasable, p_expected_current_purchasable USING ERRCODE = '40001';
  END IF;

  UPDATE public.commercial_offers SET is_purchasable = p_target_purchasable WHERE offer_code = p_offer_code;

  INSERT INTO public.commercial_catalog_audit_events (actor_user_id, action, entity_type, entity_id, previous_state, new_state, reason)
  VALUES (v_user_id, CASE WHEN p_target_purchasable THEN 'OFFER_ACTIVATED' ELSE 'OFFER_DEACTIVATED' END,
          'OFFER', v_offer.id, jsonb_build_object('is_purchasable', v_offer.is_purchasable),
          jsonb_build_object('is_purchasable', p_target_purchasable), p_reason);

  RETURN jsonb_build_object('offer_code', p_offer_code, 'is_purchasable', p_target_purchasable);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_offer_purchasable(TEXT, BOOLEAN, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_offer_purchasable(TEXT, BOOLEAN, BOOLEAN, TEXT) TO authenticated;
```
The `is_active`/economic-field immutability trigger (`commercial_offers_economic_integrity`, Ω3.0) already excludes `is_purchasable` from its post-creation immutability check (confirmed in the prior audit round: "immutability check excludes lifecycle-only fields (is_active, is_purchasable, effective_end)") — so this `UPDATE` is not blocked by that trigger, and the ratchet trigger (`commercial_offers_effective_history_ratchet`) correctly reacts to it by permanently setting `effective_history_protected = true` the moment `is_purchasable` first becomes `true`, exactly as designed. **Rollback (deactivation) is symmetric and equally narrow:** calling the same function with `p_expected_current_purchasable := true, p_target_purchasable := false` — never a `DELETE`, never a second `admin_supersede_commercial_offer` succession.

## 5. `admin_upsert_commercial_offer` — product identity added (item 5)

**CURRENT** (`20260906083524...sql:180-191` signature, `:215` body defect): 11 parameters, no product identifier; `SELECT id INTO v_plan_id FROM public.commercial_plans WHERE code = p_plan_code;` — the identical unscoped-lookup defect confirmed in `resolve_commercial_offer` (round 1) and, newly confirmed this round, **also present in `admin_supersede_commercial_offer`** (`:475`, same bare `WHERE code = p_plan_code`) — a third occurrence of the same class of bug, strengthening the case that this is a systemic pattern needing a single, consistent fix rather than three independent ones.

**PROPOSED — `admin_upsert_commercial_offer`, new required `p_product_code` parameter, product-scoped STRICT plan resolution:**
```sql
CREATE OR REPLACE FUNCTION public.admin_upsert_commercial_offer(
  p_offer_code TEXT, p_product_code TEXT, p_plan_code TEXT, p_market_code TEXT,
  p_currency_code TEXT, p_amount_minor BIGINT, p_currency_exponent SMALLINT,
  p_billing_interval TEXT, p_billing_interval_count SMALLINT,
  p_is_active BOOLEAN, p_is_purchasable BOOLEAN, p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_product_id UUID;
  v_plan_id UUID;
  v_offer_id UUID;
  v_previous JSONB;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT public.is_commercial_admin() THEN RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN RAISE EXCEPTION 'AMOUNT_MUST_BE_POSITIVE' USING ERRCODE = '22023'; END IF;

  -- Product-scoped, STRICT resolution (item 5): an unknown product code, or
  -- a plan code that does not exist WITHIN that specific product, both
  -- raise a clear, named exception — never a silent, unordered pick among
  -- multiple products' same-named plans.
  SELECT id INTO STRICT v_product_id FROM public.commercial_products WHERE code = p_product_code;
  SELECT id INTO STRICT v_plan_id FROM public.commercial_plans WHERE product_id = v_product_id AND code = p_plan_code;

  -- ... (unchanged remainder: offer_code lookup, INSERT/UPDATE, constraint-
  -- name exception translation, commercial_catalog_audit_events insert) ...
END;
$$;
```
`SELECT ... INTO STRICT` converts "product not found" and "plan not found within that product" into Postgres's own native `no_data_found`/`too_many_rows` exceptions (the exact same idiom Ω3.0's `admin_transition_platform_state` already uses for its singleton lookup, per the prior audit round) — no new hand-rolled error-translation code, consistent with this codebase's own established precedent.

**Overload/deployment discipline:** adding `p_product_code` changes the parameter list (a `TEXT` inserted between the 1st and what-was-2nd parameter), which is a new overload exactly like the resolver split in §1 — `admin_upsert_commercial_offer(TEXT,TEXT,TEXT,TEXT,BIGINT,SMALLINT,TEXT,SMALLINT,BOOLEAN,BOOLEAN,TEXT)` (11 args, old) and `(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,SMALLINT,TEXT,SMALLINT,BOOLEAN,BOOLEAN,TEXT)` (12 args, new) are different `pg_proc` entries. The same three-phase discipline applies: Phase A creates the new 12-arg overload alongside the old 11-arg one; Phase B updates the sole caller (any admin tooling/script that calls this function — today, only the two USD-offer-seed calls in this design's own implementation plan, since no UI admin tool exists yet in this codebase); Phase C (`REVOKE`+`DROP` the 11-arg overload) ships only after Phase B is confirmed. **`admin_supersede_commercial_offer`'s identical defect (`:475`) is flagged but explicitly out of scope for this design pass** — fixing it would mean changing a function with a much larger, already-shipped, fingerprint-idempotency-sensitive signature, for a bug that (like the resolver's own pre-round-1 state) has never manifested because only one product exists; it is recorded as a follow-up finding, not silently bundled into Ω3-CHECKOUT's own scope.

## 6. Webhook processing-result vocabulary — exact migration DDL (item 6)

**CURRENT** (`20260906083524...sql:405-417`):
```sql
processing_result TEXT NOT NULL
  CONSTRAINT chk_pwpe_result CHECK (
    processing_result IN (
      'PROCESSED','INVALID_SIGNATURE','REPLAY',
      'VERIFICATION_FAILED','AMOUNT_MISMATCH','CURRENCY_MISMATCH',
      'REFERENCE_MISMATCH','REFERENCE_MISSING','UNKNOWN_PROVIDER_STATUS','ERROR'
    )
  ),
```

**PROPOSED — exact, additive migration DDL:**
```sql
ALTER TABLE public.payment_webhook_processing_events DROP CONSTRAINT chk_pwpe_result;
ALTER TABLE public.payment_webhook_processing_events ADD CONSTRAINT chk_pwpe_result CHECK (
  processing_result IN (
    'PROCESSED','INVALID_SIGNATURE','REPLAY',
    'VERIFICATION_FAILED','AMOUNT_MISMATCH','CURRENCY_MISMATCH',
    'REFERENCE_MISMATCH','REFERENCE_MISSING','UNKNOWN_PROVIDER_STATUS','ERROR',
    'VERIFICATION_TRANSIENT_FAILURE',   -- NEW (item 6/7): a network/5xx/timeout
                                         -- contacting the provider's verify
                                         -- endpoint — distinct from
                                         -- VERIFICATION_FAILED, which remains
                                         -- reserved for a definitive rejection
    'RECONCILED',                       -- NEW (item 7): committed via the
                                         -- reconciliation path, not a webhook
    'RECONCILIATION_NO_TRANSACTION_FOUND',  -- NEW (item 7): reconciliation
                                             -- checked and found nothing yet
                                             -- (not an error — the customer
                                             -- may still complete payment)
    'RECONCILIATION_TERMINAL_FAILURE'   -- NEW (item 7): attempt-count cap
                                         -- reached, escalated for manual review
  )
);
```
Purely additive (`DROP`+`ADD` on the same column, no data migration — no existing row's `processing_result` value is ever one of the four new values, so no existing row is affected); safe to run without a backfill.

## 7. Reconciliation — one fully-specified mechanism, not two options (item 7)

**Chosen mechanism: `pg_cron` schedules a periodic HTTP call (via `pg_net`) to a dedicated Edge Function, `commercial-payment-reconcile`, which claims and processes rows via a `SKIP LOCKED` RPC.** This is chosen over a standalone long-running Edge-Function-side scheduler because (a) Supabase's own `pg_cron`+`pg_net` combination is the standard, already-available primitive for scheduled work in this stack — no new infrastructure — and (b) the actual provider-verification HTTP call must happen in the Deno/Edge Function runtime (where the Flutterwave adapter lives), so `pg_cron`'s role is strictly "trigger on schedule," with all row-claiming and business logic living in SQL/Deno exactly like every other path in this design.

**Schedule:**
```sql
SELECT cron.schedule(
  'omega3_checkout_reconciliation', '*/5 * * * *',
  $$SELECT net.http_post(
      url := '<project-url>/functions/v1/commercial-payment-reconcile',
      headers := jsonb_build_object('Authorization', 'Bearer <service-role-key-or-dedicated-cron-secret>', 'Content-Type','application/json'),
      body := '{}'::jsonb
    )$$
);
```

**New columns on `payment_checkout_intents`:**
```sql
ALTER TABLE public.payment_checkout_intents
  ADD COLUMN reconciliation_claimed_at     TIMESTAMPTZ NULL,
  ADD COLUMN reconciliation_attempt_count  INTEGER     NOT NULL DEFAULT 0;
```

**Row claiming — `SKIP LOCKED`, exponential backoff, terminal-failure cap:**
```sql
CREATE OR REPLACE FUNCTION public.claim_stale_checkout_intents_for_reconciliation(p_batch_size INT DEFAULT 25)
RETURNS SETOF public.payment_checkout_intents
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.payment_checkout_intents t
     SET reconciliation_claimed_at = now(), reconciliation_attempt_count = t.reconciliation_attempt_count + 1
    FROM (
      SELECT id FROM public.payment_checkout_intents
       WHERE status = 'PENDING' AND created_at < now() - interval '10 minutes' AND expires_at > now()
         AND reconciliation_attempt_count < 8   -- terminal-failure cap
         AND (
           reconciliation_claimed_at IS NULL
           OR reconciliation_claimed_at < now() - (interval '2 minutes' * power(2, LEAST(reconciliation_attempt_count, 5)))
         )   -- exponential backoff: ~4/8/16/32/64-minute re-claim spacing, capped at attempt 5
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED   -- two concurrent runs (a slow prior run still
                                 -- executing when the next tick fires) claim
                                 -- disjoint batches, never block each other,
                                 -- never double-process the same row
       LIMIT p_batch_size
    ) claimable
    WHERE t.id = claimable.id
  RETURNING t.*;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_stale_checkout_intents_for_reconciliation(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_stale_checkout_intents_for_reconciliation(INT) TO service_role;
```

**Terminal failure and alerting:** once `reconciliation_attempt_count` reaches 8 (roughly two days of backoff-spaced attempts) for a row still unresolved, that row is excluded from further automatic claiming (the `< 8` predicate above) and the Edge Function records `RECONCILIATION_TERMINAL_FAILURE` to `payment_webhook_processing_events` plus a `billing_audit_events` row. **Alerting, stated honestly against this codebase's real state:** no external paging/alerting provider is wired into this repository today (`CLAUDE.md`'s own registered `OBSERVABILITY_PROVIDER_WIRING_DEFERRED_TO_Ω2/PRE-GO-LIVE` gate) — "alerting" here means a structured, greppable `console.error('RECONCILIATION_TERMINAL_FAILURE', {...})` log line plus the durable audit row, sufficient for a manual on-call check today and upgradeable to a real paging integration later without any change to this design's data model.

**Exact authoritative verification/commit path — never a lesser-authority shortcut:** for each claimed row, `commercial-payment-reconcile` calls a **new adapter capability**, `verifyTransactionByReference(saffReference, expectedMinor, expectedCurrency)` (Flutterwave's `GET /transactions?tx_ref=...` lookup-by-reference — a real, documented endpoint, distinct from the existing verify-by-id endpoint `verifyTransaction` already uses, needed here because reconciliation by definition has no `providerTransactionId` yet). The result feeds through the **identical** amount/currency/reference checks `verifyTransaction` already performs (same Gate-B logic, different lookup key) — a successful, corroborated result then goes through `authoriseCommit` and `commit_verified_commercial_payment`, the **exact same functions and RPC the webhook path uses**. A not-found or non-SUCCEEDED result simply leaves the row for its next scheduled, backed-off attempt.

## 8. `Pricing.tsx` request/response, `CheckoutUpgradeButton`, `commercialRpc.ts` — unchanged from round 1

The `marketCode`-removed, `billingInterval`-required contracts specified in round 1 are unchanged by this round; `CheckoutUpgradeButton`'s display call now targets `resolve_commercial_offer` (§1a, unchanged public signature from round 1's shape) and its checkout call goes through `createCheckoutIntent` → `commercial-create-checkout`, which internally now uses `resolve_commercial_checkout_offer` (§1b) — this internal routing change is invisible to the frontend contract.

## 9. GLOBAL-only checkout, reconciled against Tanzania (item 9)

**Decision, stated explicitly rather than by omission: Ω3-CHECKOUT's checkout path is GLOBAL-market-only.** `commercial-create-checkout` passes the literal `'GLOBAL'` to `resolve_commercial_checkout_offer` unconditionally (§2) — there is no code path by which a TZ-market offer can be resolved for checkout under this design, regardless of that offer's `is_purchasable` value. This corrects an overclaim in the prior round's audit, which stated "nothing in this design touches TZ-specific offers" — true at the *schema* level, but incomplete: hardcoding the checkout market to `GLOBAL` makes TZ checkout **categorically unreachable through this Edge Function**, which is a real behavioral consequence of this design, not merely a non-effect.

**Proof this is not a regression, required before this design may ship:** both existing `commercial_offers` rows with `market_code = 'TZ'` are `is_purchasable = false` today (the Ω2-G sandbox seed, confirmed by direct read in the original audit round) — so there is **no currently-reachable, currently-purchasable TZ checkout path this design would be removing**. This must be re-verified at deployment time, not merely asserted from this design pass's snapshot of the data: `ACCEPTANCE_MATRIX.md` §9 (new) requires a staging query proving `SELECT count(*) FROM commercial_offers WHERE market_code = 'TZ' AND is_purchasable = true` returns zero immediately before this design ships, precisely because an admin could have activated a TZ offer via `admin_upsert_commercial_offer`/`admin_set_offer_purchasable` between this document being written and implementation happening.

**Future scope, explicitly deferred, unchanged from round 1's framing but now correctly labeled as a real gap rather than a non-issue:** a persisted, admin-controlled per-customer market (e.g. `billing_customers.market_code`) is the mechanism that would need to exist before a TZ (or any non-GLOBAL) checkout could ever be reachable again — new schema, new admin tooling, its own design pass. Tanzania's **accounting/workspace** functionality (SAFISHA, HESABU, KINGA, TZ compliance, EFDMS) is completely unaffected by any of this — only the **commercial checkout market**, which never had a reachable purchasable path in the first place, is scoped to GLOBAL-only by this design.

## 10. Platform-state × provider-environment × acceptance-identity matrix (item 4 round 1, corrected for item 8 round 2)

| `commercial_platform_state` | Allowed provider environment | Allowed caller | Edge Function behavior on mismatch |
|---|---|---|---|
| `PAYMENTS_DISABLED` | none | none | Reject with 503 `PAYMENTS_DISABLED`, before any offer resolution (Part A of the gate, §2) |
| `SANDBOX_ONLY` | sandbox only, for **the specific provider `selectPaymentProvider()` selects for this offer** (round 2 correction — never a fixed `getConfiguredProviders()[0]` index) | restricted acceptance identities only — a direct `commercial_admins` row for the validated `user.id` (round 2's single, fully-specified mechanism, §2 step 5) | 503 `PROVIDER_ENVIRONMENT_MISMATCH` if the selected provider is production; 403 `SANDBOX_RESTRICTED` for an ordinary customer |
| `LIVE_ACCEPTANCE` | production only, for the selected provider | restricted acceptance identities only | 503 `PROVIDER_ENVIRONMENT_MISMATCH` if the selected provider is sandbox; 403 `LIVE_ACCEPTANCE_RESTRICTED` for an ordinary customer |
| `CUSTOMER_PAYMENTS_ENABLED` | production only, for the selected provider | any authenticated customer | 503 `PROVIDER_ENVIRONMENT_MISMATCH` if the selected provider is sandbox (fail closed rather than silently accepting real customer traffic against a sandbox key) |
| Missing row / query error / value outside the 4-value vocabulary | — | — | 503 `PAYMENTS_UNAVAILABLE` — fail closed, never "proceed as if enabled" |

This table is the literal contract `commercial-create-checkout`'s two-part platform-state gate (§2) implements — Part A's rows (`PAYMENTS_DISABLED`, missing/invalid row) are checked before offer resolution; Part B's rows (provider-environment mismatch, restricted identity) are checked after `selectPaymentProvider` has determined the actual provider for this offer, exactly because that determination is what round 2 corrected.

## 11. Payment-commit design — customer-level serialization (item 6, round 1, unchanged and re-confirmed in round 2)

**Defect this closes:** `commit_verified_commercial_payment`'s original `SELECT ... FOR UPDATE` locks only the **intent** row — sufficient for two webhook deliveries of the *same* intent, insufficient for two *different*, both-successful intents for the *same customer* racing concurrently, each locking only its own intent row while both read the customer's current licence state before either has written it. The GiST exclusion constraint (`excl_cl_no_overlapping_authoritative_periods`) is the last-resort net that would catch an actual overlap — but a thrown exception there, for an already-Gate-A/B-verified real charge, is exactly the "silently discarded provider charge" risk item 6 names.

**PROPOSED — a customer-level advisory lock, acquired before the licence re-read, immediately after the existing idempotency-key pre-check and intent-level `FOR UPDATE`:**
```sql
-- Inside commit_verified_commercial_payment, after the existing idempotency
-- pre-check and the existing SELECT ... FOR UPDATE on the intent row:

v_lock_key := hashtextextended(v_intent.billing_customer_id::text || ':licence', 0);
PERFORM pg_advisory_xact_lock(v_lock_key);

-- RE-READ current licence state AFTER acquiring the lock — the existing
-- "SELECT * INTO v_current_lic FROM commercial_licences WHERE ... LIMIT 1"
-- lookup must be repeated here, not reused from before the lock, because a
-- concurrent transaction may have committed a different successful intent
-- for this same customer in the window between this transaction's start
-- and this lock's acquisition.
SELECT * INTO v_current_lic FROM public.commercial_licences
 WHERE billing_customer_id = v_intent.billing_customer_id
   AND status IN ('ACTIVE','GRACE')
 ORDER BY effective_start DESC LIMIT 1
 FOR UPDATE;

-- ... existing closeout + insert logic, now provably serialized per
-- customer, continues unchanged from here ...
```

**Deterministic behavior for two paid intents:** with the lock held for the licence-mutation portion of every commit, two successful payments for the same customer commit strictly one after the other, never concurrently. The second commit to acquire the lock sees the first's already-closed-out licence row (via the re-read above) and proceeds normally. **No exclusion-constraint violation is reachable this way** — the failure mode is structurally impossible by construction, not merely caught after the fact. Both commits return `COMMITTED` (never `ALREADY_COMMITTED`, which is reserved for the true idempotency-key replay case) — they are genuinely two distinct, real payments for two distinct periods; the product/support question of intent (did the customer mean to buy both) remains a support concern, explicitly out of this design's data-integrity scope.

This is the one function in this design package changed from **MUST NOT CHANGE** (its original classification) to **MUST CHANGE** — the change is scoped narrowly to one lock acquisition plus one re-read at a specific point, touching no existing amount/currency/status validation, idempotency check, or audit-row insertion.
