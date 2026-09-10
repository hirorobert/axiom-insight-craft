# Ω3-CHECKOUT — Data Contracts

Design document. SQL/TypeScript blocks marked **CURRENT** are verbatim quotations of live source (file:line given). Blocks marked **PROPOSED** are design only — not applied anywhere.

**Design-correction round 2:** independent review found that round 1's `resolve_commercial_offer` product-scoping relied on `auth.uid()`, but `commercial-create-checkout` invokes every RPC through a **service-role client** (`createClient(SUPABASE_URL, SERVICE_KEY)`, confirmed at `commercial-create-checkout/index.ts:92`) — under a service-role client, `auth.uid()` inside the database is `NULL` regardless of which customer's request triggered the call, so round 1's fallback branch would fire on **every single checkout**, silently defeating the fix it was meant to provide. Round 2 separated anonymous catalogue display from checkout authority, replaced the CREATED/NULL-url supersession idea with a token-fenced lease protocol, corrected the offer-activation design, added privilege DDL, added product identity to `admin_upsert_commercial_offer`, specified a webhook CHECK-constraint migration and a reconciliation mechanism, fixed a provider-selection-index bug in the platform-state gate, and settled the GLOBAL/Tanzania question explicitly.

**Design-correction round 3:** a third independent review checked round 2's SQL against the ACTUAL `payment_checkout_intents` schema and found the lease RPC's `INSERT` referenced a `checkout_url` column that does not exist (the real column is `provider_checkout_url`) and omitted four columns the real table declares `NOT NULL` — `plan_id`, `market_code`, `provider`, `created_by_user_id` — meaning it would have failed outright the first time it ran. Also found: no exact DDL for adding `PROVIDER_CREATING` to `chk_pci_status`/`idx_pci_status_active`; reconciliation outcomes were routed to a table (`payment_webhook_processing_events`) whose `receipt_id` is `NOT NULL`, making that routing structurally impossible for evidence with no webhook receipt; the reconciliation claim was timestamp-only, not a durable fenced lease, risking a permanently stranded intent if a worker crashed after claiming the terminal attempt; the backoff arithmetic and maximum elapsed window were never stated exactly; the cron-authentication design was an unusable placeholder; the `LEASE_HELD` client contract was underspecified; the platform-state gate had a fail-OPEN gap when a provider capability could not be resolved; `admin_supersede_commercial_offer`'s identical unscoped-plan-lookup defect was left unaddressed with no compensating invariant; and Flutterwave's lookup-by-reference had no specified behavior for its several distinct outcomes.

**Design-correction round 4 (this revision, surgical — modifies only the specific blocks these findings name):** a fourth independent review found a genuine, load-bearing contradiction round 3 introduced: its reconciliation claim AND terminal predicates both required `expires_at > now()`, but `expires_at` defaults to 1 hour while the reconciliation programme's own backoff schedule runs for up to 305 minutes — any intent past its 1-hour checkout-session expiry would have been silently excluded from both further claiming and the terminal transition, permanently stranded. §7.0 (new) states one canonical rule decoupling checkout-session expiry from reconciliation eligibility, and corrects `authoriseCommit` to compare the provider's own payment timestamp against `expires_at`, never wall-clock now(). Also found and fixed: no `provider_environment` tracking, risking a sandbox checkout URL being reused after a platform-state transition to production (item 1); the offer row was read without a lock and without cross-product or provider-restriction verification inside the lease RPC itself (item 2); the `CLAIMED` evidence row was written in a separate, non-atomic step from the claim itself (item 4); lease release/terminalization had no token-based staleness rejection and no "never overwrite SUCCEEDED" guarantee (item 5, now `finalize_reconciliation_attempt`); the backoff anchor was an approximation rather than the real completion time (item 6); and the cron job's project-URL source was assumed rather than provisioned, with no mechanism to catch a Vault/Edge-secret mismatch before it silently disabled reconciliation forever (item 7). All resolved below, with corrected SQL — no implementation performed.

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

// 7. Route to a provider — CORRECTED round 5 (Blocker 5, closing a gap
//    found while specifying dual-environment credentials, DATA_CONTRACTS.md
//    §12.3): getConfiguredProviders() can now return TWO Flutterwave
//    entries (sandbox + production) simultaneously configured during a
//    transition window. Filtering to the ONE environment `state` currently
//    requires, BEFORE calling selectPaymentProvider, is what makes the
//    Part B lookup below unambiguous — without this filter,
//    selectPaymentProvider (and the naive `.find(p => p.provider ===
//    provider)` a Part B lookup against the FULL list would otherwise use)
//    could match either environment's entry for the identical
//    provider==='FLUTTERWAVE' value, silently picking the wrong one.
const requiredEnv = (state === 'SANDBOX_ONLY') ? 'sandbox'
  : (state === 'LIVE_ACCEPTANCE' || state === 'CUSTOMER_PAYMENTS_ENABLED') ? 'production'
  : null; // PAYMENTS_DISABLED already rejected in Part A; state has no other value here
const envFilteredProviders = getConfiguredProviders().filter(p => p.environment === requiredEnv);
const providerSelection = selectPaymentProvider(
  { currencyCode: offer.currency_code!, marketCode: offer.market_code!, providerRestriction: offer.provider_restriction ?? null },
  envFilteredProviders,
);
if (!providerSelection.selected) return json(503, {error:'PAYMENT_PROVIDER_UNAVAILABLE', correlationId});
const provider = providerSelection.provider;

// 8. Platform-state gate, PART B — corrected (item 8 round 2's bug fix;
//    corrected again round 3 for the fail-closed requirement; corrected
//    again round 5 for the environment-ambiguity gap above): round 1
//    checked getConfiguredProviders()[0].environment, an arbitrary array
//    element. Round 3 fixed the fail-open gap on an unresolved capability.
//    Round 5's fix is REUSING envFilteredProviders (step 7) here, rather
//    than re-querying the FULL, unfiltered getConfiguredProviders() — since
//    providerSelection.provider was chosen FROM the single-environment
//    filtered list, looking it up again in that SAME list is unambiguous
//    by construction; looking it up in the full list would not be, once
//    two same-provider/different-environment entries can coexist.
const selectedCapabilities = envFilteredProviders.find(p => p.provider === provider);
if (!selectedCapabilities) {
  // Fail closed (item 9): the provider selectPaymentProvider() just chose
  // has no resolvable capability entry. This should be structurally
  // unreachable (selectPaymentProvider only ever returns a provider drawn
  // from the SAME getConfiguredProviders() list), but this design does not
  // rely on "should be unreachable" — it asserts it explicitly.
  console.error('Selected provider has no resolvable capability entry', { correlationId, provider });
  return json(503, {error:'PROVIDER_CAPABILITY_UNRESOLVED', correlationId});
}
const providerIsSandbox = selectedCapabilities.environment === 'sandbox';

if (state === 'SANDBOX_ONLY' && !providerIsSandbox) {
  return json(503, {error:'PROVIDER_ENVIRONMENT_MISMATCH', correlationId});
}
if ((state === 'LIVE_ACCEPTANCE' || state === 'CUSTOMER_PAYMENTS_ENABLED') && providerIsSandbox) {
  return json(503, {error:'PROVIDER_ENVIRONMENT_MISMATCH', correlationId});
}

// 9. Acquire a checkout-intent LEASE — §3 below for the full protocol,
//    corrected this round to match the real payment_checkout_intents
//    schema (item 1). The RPC derives plan_id/market_code/economics from
//    the offer row itself — the Edge Function passes only identity and
//    the server-selected provider, never loose economic fields.
const lease = await supabase.rpc('acquire_checkout_intent_lease', {
  p_billing_customer_id: billingCustomer.id,
  p_created_by_user_id: user.id,
  p_offer_id: offer.offer_id,
  p_provider: provider,   // the value selectPaymentProvider() chose — never client input
  p_provider_environment: providerIsSandbox ? 'SANDBOX' : 'PRODUCTION',  // item 1 round 4 —
    // the SAME boolean the platform-state gate (step 8, above) already computed
    // from selectedCapabilities.environment; snapshotted verbatim, never re-derived
  p_saff_reference: generateReference(),  // 'CFOCLOSE-' prefix, item 11 round 1, unchanged
});

if (lease.data.acquired === 'REUSED') {
  return json(200, { saffReference: lease.data.saff_reference, checkoutUrl: lease.data.provider_checkout_url, expiresAt: lease.data.expires_at, provider, correlationId });
}
if (lease.data.acquired === 'LEASE_HELD') {
  // A live, not-yet-expired PROVIDER_CREATING lease exists for this exact
  // customer+offer, held by another in-flight request — a narrow,
  // sub-second window in ordinary operation. Exact contract, item 8 round 3
  // (superseding round 2's 409 choice): 202 Accepted, machine-readable
  // code, and an explicit Retry-After so the client's retry behavior is
  // server-dictated, not guessed.
  return json(202, {status:'CHECKOUT_IN_PROGRESS', correlationId}, {'Retry-After': '2'});
}
// acquired === 'NEW' from here.

// 10. Call the provider — UNCHANGED adapter contract — then persist the
//     result via the token-based CAS (item 3 round 2), NEVER a plain UPDATE.
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
  p_provider_checkout_url: checkoutResult.checkoutUrl,
  p_provider_checkout_ref: checkoutResult.providerRef,
});

if (!cas.data.persisted) {
  // Item 3 round 2's explicit requirement: NEVER return a URL after a
  // failed CAS. The row's fenced ownership has already moved on (its lease
  // was superseded as stale by a later request, which can only happen if
  // THIS request itself stalled past its own 60-second lease window) —
  // treat this exactly like a provider failure from the caller's perspective.
  return json(502, {error:'Checkout session could not be finalized. Please try again.', correlationId});
}

return json(200, { saffReference: lease.data.saff_reference, checkoutUrl: checkoutResult.checkoutUrl, expiresAt: cas.data.expires_at, provider, correlationId });
```

**Client contract for `LEASE_HELD`/202 — ONE canonical definition, corrected round 5 (High 2A) to match the actual implementation exactly, used identically in this section, §8 below, and `ACCEPTANCE_MATRIX.md`:** `maxAttempts = 3` means **one initial request plus two retries** — three HTTP requests total, never a fourth. The frontend's `createCheckoutIntent` helper, on receiving a 202 with `status:'CHECKOUT_IN_PROGRESS'`, waits the server-specified (sanitized — §8) `Retry-After` seconds and re-issues the identical checkout-creation request, up to that 3-attempt cap, with a **hard 15-second wall-clock deadline enforced before EVERY request (including the first) and before every sleep**, not merely checked once. The retry sequence terminates on any of: a 200 response (success), a definitive provider failure (502, surfaced as an error toast, no further retries), the 3rd attempt still returning 202 (surfaced as "Checkout is taking longer than expected — please try again in a moment" — no 4th request is ever issued), or the 15-second deadline being reached before a request would otherwise fire (same message, same no-further-requests guarantee) — or, although not separately detectable by the client since the server does not expose lease timing directly, the natural resolution of the underlying lease's own 60-second expiry, which by design resolves well within the client's 15-second budget in the ordinary case.

## 3. Checkout-intent lease/fencing protocol — corrected to the real `payment_checkout_intents` schema (round 3)

**Confirmed defect in rounds 1–2:** every prior draft of this section's `INSERT` statement targeted an imagined shape of `payment_checkout_intents` — it referenced a `checkout_url` column that does not exist (the real column, confirmed by direct read of `20260906083524...sql:293-333`, is `provider_checkout_url`) and omitted four columns the real table declares `NOT NULL` with no default: `plan_id`, `market_code`, `provider`, `created_by_user_id`. As written, that `INSERT` would have failed with a constraint violation the first time it ever ran. This round corrects every SQL reference to the real column name and the real required-column set, and additionally derives economics from the **locked offer row** rather than trusting the caller to pass them separately (closing a second, related risk: nothing previously stopped a caller from passing an `offer_id` and a mismatched `expected_amount_minor` that didn't actually belong to that offer).

**Real schema, quoted verbatim for reference:**
```sql
CREATE TABLE public.payment_checkout_intents (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  billing_customer_id UUID NOT NULL, commercial_offer_id UUID NOT NULL,
  plan_id UUID NOT NULL, market_code TEXT NOT NULL,
  expected_amount_minor BIGINT NOT NULL, currency_code TEXT NOT NULL,
  currency_exponent SMALLINT NOT NULL, billing_interval TEXT NOT NULL,
  billing_interval_count SMALLINT NOT NULL,
  provider TEXT NOT NULL CONSTRAINT chk_pci_provider CHECK (provider IN ('FLUTTERWAVE','PESAPAL','SELCOM','DPO','STRIPE')),
  saff_reference TEXT NOT NULL, provider_checkout_ref TEXT NULL, provider_checkout_url TEXT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED' CONSTRAINT chk_pci_status CHECK (status IN ('CREATED','PENDING','SUCCEEDED','FAILED','CANCELLED','EXPIRED')),
  created_by_user_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 hour'), completed_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- fk_pci_billing_customer, fk_pci_offer, fk_pci_plan, fk_pci_created_by (-> auth.users), uq_pci_saff_reference, chk_pci_amount, chk_pci_currency
);
CREATE INDEX idx_pci_status_active ON public.payment_checkout_intents (status) WHERE status IN ('CREATED','PENDING');
```
No `creation_token`/`lease_expires_at` columns exist yet, and `'PROVIDER_CREATING'` is not yet a legal `status` value — both are added by this design (§3a below), alongside the `chk_pci_status`/`idx_pci_status_active` corrections item 3 (this round) requires.

### 3.0 — exact DDL: `chk_pci_status`, `idx_pci_status_active`, `provider_environment` (item 3 round 3, item 1 round 4)

```sql
ALTER TABLE public.payment_checkout_intents DROP CONSTRAINT chk_pci_status;
ALTER TABLE public.payment_checkout_intents ADD CONSTRAINT chk_pci_status CHECK (
  status IN ('CREATED','PENDING','SUCCEEDED','FAILED','CANCELLED','EXPIRED','PROVIDER_CREATING')
);

ALTER TABLE public.payment_checkout_intents
  ADD COLUMN creation_token       UUID        NULL,
  ADD COLUMN lease_expires_at     TIMESTAMPTZ NULL,
  -- Item 1 (round 4): snapshotted once at acquisition, from the SAME
  -- getConfiguredProviders() capability entry the platform-state gate
  -- (DATA_CONTRACTS.md §2 step 8) already resolved for this request — never
  -- re-derived later, so a mid-flight platform-state/config change can
  -- never retroactively relabel an already-created intent.
  ADD COLUMN provider_environment TEXT NOT NULL DEFAULT 'SANDBOX'
    CONSTRAINT chk_pci_provider_environment CHECK (provider_environment IN ('SANDBOX','PRODUCTION'));
  -- DEFAULT 'SANDBOX' exists only to satisfy the NOT NULL constraint for
  -- any pre-existing row at migration time (there are none with a real
  -- provider_checkout_url yet, since Ω3-CHECKOUT has not shipped) — every
  -- row this design's own INSERT creates always supplies an explicit value.

DROP INDEX public.idx_pci_status_active;
CREATE INDEX idx_pci_status_active ON public.payment_checkout_intents (status)
  WHERE status IN ('CREATED','PENDING','PROVIDER_CREATING');
```
`'CREATED'` remains in the vocabulary for backward compatibility with any historical row (harmless — this design's own lease protocol inserts directly as `'PROVIDER_CREATING'`, never `'CREATED'`, so the value becomes dormant going forward without needing removal, which would be a breaking, non-additive change to a CHECK constraint's historical guarantee). The partial index is dropped and recreated (not `ALTER`ed in place — Postgres has no `ALTER INDEX ... SET WHERE`) because its predicate must now also cover the new pre-terminal `PROVIDER_CREATING` state, which the reconciliation-adjacent staleness sweep and the `LEASE_HELD` check both scan by status.

**Why `provider_environment` is needed (item 1):** without it, a `PENDING` row created while `commercial_platform_state = 'SANDBOX_ONLY'` (checkout URL points at Flutterwave's sandbox) could be silently reused by `acquire_checkout_intent_lease`'s `REUSED` path after an admin transitions the platform to `LIVE_ACCEPTANCE`/`CUSTOMER_PAYMENTS_ENABLED` — handing a customer a sandbox checkout URL that will never accept a real card, or (worse, the reverse direction) handing a production URL to a test/sandbox-identity flow. The reuse check (§3a below) is corrected to require an exact `provider_environment` match, never merely `offer_id`+`provider`.

### 3a. `acquire_checkout_intent_lease` — corrected: real columns, offer-derived economics, ownership verification (item 1, round 3)

**Why the round-1 design was insufficient:** `acquire_or_reuse_checkout_intent`'s `pg_advisory_xact_lock` is released the instant that ONE RPC call's transaction commits — but the actual external Flutterwave HTTP call happens in the Edge Function's own code, **after** that RPC returns and the lock is gone. A second invocation for the same customer+offer, arriving while the first is still mid-flight calling Flutterwave, would acquire the (now-free) lock immediately and could observe the first request's row still sitting `CREATED`/`checkout_url IS NULL` — round 1's design would have treated that as safely supersedable ("CREATED-without-URL, mark FAILED, create fresh") even though the original request might still be about to succeed a moment later. **New schema and three narrow, single-purpose RPCs replace it:**

**New columns on `payment_checkout_intents`:** see §3.0 above — `creation_token`, `lease_expires_at`, `provider_environment` (item 1 round 4), plus the `PROVIDER_CREATING` status value.

**RPC 1 — `acquire_checkout_intent_lease` (acquire only; never calls the provider) — corrected signature: takes only identity and offer references, derives every economic column from the LOCKED offer row itself; round 4 adds `p_provider_environment`, offer row-locking, and cross-product/provider-restriction verification:**
```sql
CREATE OR REPLACE FUNCTION public.acquire_checkout_intent_lease(
  p_billing_customer_id  UUID,
  p_created_by_user_id   UUID,   -- the validated JWT user id — the Edge Function's OWN
                                  -- job to have already authenticated; this function does
                                  -- not re-authenticate, it re-VERIFIES the pairing below
  p_offer_id             UUID,
  p_provider              TEXT,  -- MUST be the value selectPaymentProvider() already chose
                                  -- server-side — never a client-supplied value; re-validated
                                  -- against chk_pci_provider's own vocabulary as defense in depth
  p_provider_environment  TEXT,  -- 'SANDBOX' | 'PRODUCTION' — MUST be the value the platform-
                                  -- state gate (§2 step 8) already resolved for the selected
                                  -- provider's capability entry; snapshotted verbatim, item 1
  p_saff_reference       TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_lock_key      BIGINT := hashtextextended(p_billing_customer_id::text || ':' || p_offer_id::text, 0);
  v_billing_cust  RECORD;
  v_offer         RECORD;
  v_offer_product UUID;
  v_existing      RECORD;
  v_new_id        UUID;
  v_token         UUID := gen_random_uuid();
BEGIN
  -- Ownership verification (item 1 round 3): the supplied billing_customer_id
  -- must actually belong to the supplied, already-validated created_by_user_id.
  -- Also captures billing_customers.product_id for the cross-product check
  -- below (item 2 round 4) — one lookup serves both purposes.
  SELECT * INTO v_billing_cust FROM public.billing_customers
   WHERE id = p_billing_customer_id AND owner_user_id = p_created_by_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BILLING_CUSTOMER_OWNER_MISMATCH' USING ERRCODE = '28000';
  END IF;

  IF p_provider NOT IN ('FLUTTERWAVE','PESAPAL','SELCOM','DPO','STRIPE') THEN
    RAISE EXCEPTION 'INVALID_PROVIDER: %', p_provider USING ERRCODE = '22023';
  END IF;
  IF p_provider_environment NOT IN ('SANDBOX','PRODUCTION') THEN
    RAISE EXCEPTION 'INVALID_PROVIDER_ENVIRONMENT: %', p_provider_environment USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Deterministic staleness sweep — CORRECTED (item 1 round 5, canonical
  -- lifecycle split, §7.0 below). This sweep may ONLY expire rows that
  -- NEVER obtained a real provider checkout URL — 'CREATED' (legacy,
  -- dormant status this design never writes but the CHECK constraint still
  -- permits) and 'PROVIDER_CREATING' whose lease has expired (a crashed
  -- prior attempt, so no checkout URL was ever persisted for it either).
  -- Neither case carries any payment risk: the customer never saw a real
  -- Flutterwave page, so no charge could conceivably exist.
  --
  -- 'PENDING' is DELIBERATELY EXCLUDED from this sweep. A PENDING row has a
  -- real, once-live provider_checkout_url — the customer may have already
  -- paid on it. Transitioning it to EXPIRED merely because expires_at
  -- passed would be exactly the canonical-rule violation this round exists
  -- to remove: CUSTOMER CHARGED → PAYMENT VERIFIED → intent no longer
  -- PENDING → webhook/reconciliation commit rejected as
  -- INTENT_ALREADY_RESOLVED. A PENDING row past expires_at is simply no
  -- longer eligible for FRESH acquisition/REUSE (enforced by the REUSED
  -- check's own `expires_at > now()` clause below, unchanged) — it remains
  -- untouched here, and remains reconciliation-eligible (§7.2) until
  -- reconciliation's own COMPLETED terminal attempt classifies it, per
  -- §7.0's four-part lifecycle. "Reconciliation owns the terminal
  -- classification of unresolved PENDING intents" (item 1's own words).
  UPDATE public.payment_checkout_intents
     SET status = 'EXPIRED'
   WHERE billing_customer_id = p_billing_customer_id AND commercial_offer_id = p_offer_id
     AND status = 'CREATED' AND expires_at <= now();

  UPDATE public.payment_checkout_intents
     SET status = 'FAILED', creation_token = NULL, lease_expires_at = NULL
   WHERE billing_customer_id = p_billing_customer_id AND commercial_offer_id = p_offer_id
     AND status = 'PROVIDER_CREATING' AND lease_expires_at <= now();

  -- Reusable: a PENDING row with a real provider_checkout_url, not yet
  -- expired, for the SAME provider AND the SAME provider_environment (item 1
  -- round 4) — never hand back a sandbox URL to a request that just resolved
  -- under PRODUCTION, or vice versa, even if offer_id and provider both
  -- coincidentally match (e.g. immediately after an admin platform-state
  -- transition mid-session).
  SELECT * INTO v_existing FROM public.payment_checkout_intents
   WHERE billing_customer_id = p_billing_customer_id AND commercial_offer_id = p_offer_id
     AND status = 'PENDING' AND expires_at > now() AND provider_checkout_url IS NOT NULL
     AND provider = p_provider AND provider_environment = p_provider_environment
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('acquired','REUSED','intent_id',v_existing.id,
      'saff_reference',v_existing.saff_reference,'provider_checkout_url',v_existing.provider_checkout_url,
      'expires_at',v_existing.expires_at);
  END IF;

  -- A LIVE lease (not yet expired) blocks acquisition outright — "never
  -- steal a live lease" (item 3, round 2's requirement, unchanged).
  PERFORM 1 FROM public.payment_checkout_intents
   WHERE billing_customer_id = p_billing_customer_id AND commercial_offer_id = p_offer_id
     AND status = 'PROVIDER_CREATING' AND lease_expires_at > now();
  IF FOUND THEN
    RETURN jsonb_build_object('acquired','LEASE_HELD');
  END IF;

  -- Lock the offer row (item 2 round 4): FOR SHARE, not a plain SELECT.
  -- Round 3 argued a plain SELECT was "sufficient" because economic fields
  -- are immutable post-creation — true, but is_purchasable/is_active are
  -- lifecycle fields admin_set_offer_purchasable CAN flip concurrently, and
  -- a plain SELECT gives no protection against that flip landing between
  -- this check and the INSERT below. FOR SHARE blocks a concurrent
  -- admin_set_offer_purchasable's FOR UPDATE (§4) from completing until
  -- THIS transaction ends, and is held through the INSERT (Postgres row
  -- locks acquired mid-transaction are held until COMMIT/ROLLBACK, not
  -- released early) — so an offer cannot be deactivated in the narrow
  -- window between this validation and the row actually being created.
  SELECT * INTO v_offer FROM public.commercial_offers WHERE id = p_offer_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OFFER_NOT_FOUND: %', p_offer_id USING ERRCODE = '22023';
  END IF;
  IF NOT (v_offer.is_active AND v_offer.is_purchasable
          AND v_offer.effective_start <= now()
          AND (v_offer.effective_end IS NULL OR v_offer.effective_end > now())) THEN
    RAISE EXCEPTION 'OFFER_NO_LONGER_PURCHASABLE: %', p_offer_id USING ERRCODE = '22023';
  END IF;

  -- Cross-product verification (item 2 round 4): the offer's own plan must
  -- belong to the SAME product as the billing customer. resolve_commercial_
  -- checkout_offer (§1b) already enforces this at resolution time, but that
  -- is a separate call from a separate moment — this function re-verifies
  -- independently rather than trusting the earlier call was honoured,
  -- consistent with the ownership re-check above.
  SELECT product_id INTO v_offer_product FROM public.commercial_plans WHERE id = v_offer.plan_id;
  IF v_offer_product IS DISTINCT FROM v_billing_cust.product_id THEN
    RAISE EXCEPTION 'OFFER_PRODUCT_MISMATCH: offer plan belongs to a different product than the billing customer' USING ERRCODE = '22023';
  END IF;

  -- Provider-restriction verification (item 2 round 4): if this specific
  -- offer is restricted to one provider, the caller-supplied provider must
  -- match it exactly — selectPaymentProvider() already enforces this
  -- upstream, but again, never trusted blindly inside a function that
  -- mutates authoritative checkout state.
  IF v_offer.provider_restriction IS NOT NULL AND v_offer.provider_restriction != p_provider THEN
    RAISE EXCEPTION 'PROVIDER_RESTRICTION_MISMATCH: offer requires %, got %', v_offer.provider_restriction, p_provider USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.payment_checkout_intents (
    billing_customer_id, commercial_offer_id, plan_id, market_code,
    expected_amount_minor, currency_code, currency_exponent,
    billing_interval, billing_interval_count, provider, provider_environment, saff_reference,
    created_by_user_id, status, creation_token, lease_expires_at
  ) VALUES (
    p_billing_customer_id, p_offer_id, v_offer.plan_id, v_offer.market_code,
    v_offer.amount_minor, v_offer.currency_code, v_offer.currency_exponent,
    v_offer.billing_interval, v_offer.billing_interval_count, p_provider, p_provider_environment, p_saff_reference,
    p_created_by_user_id, 'PROVIDER_CREATING', v_token, now() + interval '60 seconds'
    -- expires_at is NOT listed — its table DEFAULT (now() + interval '1 hour')
    -- applies exactly as it does for every other insert into this table today.
    -- The FOR SHARE lock on v_offer, acquired above, is still held here —
    -- item 2's "hold the row lock through the INSERT" — because nothing
    -- between that SELECT and this INSERT commits or rolls back.
  ) RETURNING id INTO v_new_id;

  RETURN jsonb_build_object('acquired','NEW','intent_id',v_new_id,'creation_token',v_token,'saff_reference',p_saff_reference);
END;
$$;
REVOKE ALL ON FUNCTION public.acquire_checkout_intent_lease(UUID,UUID,UUID,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_checkout_intent_lease(UUID,UUID,UUID,TEXT,TEXT,TEXT) TO service_role;
```

**RPC 2 — `persist_checkout_provider_result` (token-based CAS; the only way a `PROVIDER_CREATING` row becomes `PENDING`) — corrected column name (item 2):**
```sql
CREATE OR REPLACE FUNCTION public.persist_checkout_provider_result(
  p_intent_id UUID, p_creation_token UUID, p_provider_checkout_url TEXT, p_provider_checkout_ref TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE v_row RECORD;
BEGIN
  UPDATE public.payment_checkout_intents
     SET status = 'PENDING', provider_checkout_url = p_provider_checkout_url,
         provider_checkout_ref = p_provider_checkout_ref,
         creation_token = NULL, lease_expires_at = NULL
   WHERE id = p_intent_id AND creation_token = p_creation_token AND status = 'PROVIDER_CREATING'
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    -- The fence has already moved on (this caller's own lease expired and
    -- was superseded before this UPDATE ran). Report failure explicitly —
    -- the caller (the Edge Function) MUST NOT hand the checkout URL to the
    -- customer in this case (item 3, round 2's "never return a URL after
    -- failed CAS"), even though the URL itself is a real, live Flutterwave
    -- session (see the orphan-session note below).
    RETURN jsonb_build_object('persisted', false);
  END IF;
  RETURN jsonb_build_object('persisted', true, 'expires_at', v_row.expires_at);
END;
$$;
REVOKE ALL ON FUNCTION public.persist_checkout_provider_result(UUID,UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_checkout_provider_result(UUID,UUID,TEXT,TEXT) TO service_role;
```
The TypeScript-facing `CheckoutIntentResponse.checkoutUrl` field name (`commercialRpc.ts`) is unaffected — the Edge Function maps `provider_checkout_url`/`cas.data.provider_checkout_url` onto `checkoutUrl` in its own JSON response at the single existing translation boundary, exactly as `pollCheckoutStatus` already translates `get_checkout_status`'s snake_case response onto a camelCase contract today. No frontend file changes as a result of this column-name correction.

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

**Overload/deployment discipline:** adding `p_product_code` changes the parameter list (a `TEXT` inserted between the 1st and what-was-2nd parameter), which is a new overload exactly like the resolver split in §1 — `admin_upsert_commercial_offer(TEXT,TEXT,TEXT,TEXT,BIGINT,SMALLINT,TEXT,SMALLINT,BOOLEAN,BOOLEAN,TEXT)` (11 args, old) and `(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,SMALLINT,TEXT,SMALLINT,BOOLEAN,BOOLEAN,TEXT)` (12 args, new) are different `pg_proc` entries. The same three-phase discipline applies: Phase A creates the new 12-arg overload alongside the old 11-arg one; Phase B updates the sole caller (today, only the two USD-offer-seed calls in this design's own implementation plan); Phase C (`REVOKE`+`DROP` the 11-arg overload) ships only after Phase B is confirmed.

**Round 2 explicitly deferred `admin_supersede_commercial_offer`'s identical defect (`:475`, `SELECT id INTO v_plan_id FROM public.commercial_plans WHERE code = p_plan_code;`, no product scoping) as out of scope. Round 3 correction (item 10): this is no longer left as a knowingly-unscoped commercial-authority RPC — it is fixed in the SAME Phase A migration, via the identical pattern:**
```sql
CREATE OR REPLACE FUNCTION public.admin_supersede_commercial_offer(
  p_product_code TEXT,   -- NEW, first parameter (before p_old_offer_code, so every
                          -- existing required parameter after it keeps its relative
                          -- order — Postgres has no issue with a new parameter
                          -- inserted anywhere in the list as long as the RESULT still
                          -- has all defaulted parameters trailing all required ones,
                          -- which this signature already satisfies: none of
                          -- admin_supersede_commercial_offer's 11 original parameters
                          -- carry a default)
  p_old_offer_code TEXT, p_new_offer_code TEXT, p_plan_code TEXT, p_market_code TEXT, p_currency_code TEXT,
  p_amount_minor BIGINT, p_currency_exponent SMALLINT,
  p_billing_interval TEXT, p_billing_interval_count SMALLINT,
  p_effective_start TIMESTAMPTZ, p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog AS $$
DECLARE
  v_product_id UUID;
  v_plan_id    UUID;
  -- ... (v_fingerprint, v_existing, v_old, v_new_id, v_constraint_name unchanged) ...
BEGIN
  IF NOT public.is_commercial_admin() THEN RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_new_offer_code IS NULL OR trim(p_new_offer_code) = '' THEN RAISE EXCEPTION 'NEW_OFFER_CODE_REQUIRED' USING ERRCODE = '22023'; END IF;

  -- Product-scoped, STRICT resolution (item 10 round 3, same pattern as §5's
  -- admin_upsert_commercial_offer fix immediately above):
  SELECT id INTO STRICT v_product_id FROM public.commercial_products WHERE code = p_product_code;
  SELECT id INTO STRICT v_plan_id FROM public.commercial_plans WHERE product_id = v_product_id AND code = p_plan_code;

  -- ... (fingerprint computation, pre-lock idempotency check, predecessor
  -- lock, exception translation, audit insert — ALL UNCHANGED from the live
  -- Ω3.0 body; the fingerprint payload itself does not need p_product_code
  -- added to it, since v_plan_id is already product-disambiguated by the
  -- time the fingerprint is computed, and the fingerprint's job is to
  -- detect a changed ECONOMIC request, not to re-encode identity that the
  -- STRICT lookup above already resolved unambiguously) ...
END;
$$;

REVOKE ALL ON FUNCTION public.admin_supersede_commercial_offer(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,SMALLINT,TEXT,SMALLINT,TIMESTAMPTZ,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_supersede_commercial_offer(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,SMALLINT,TEXT,SMALLINT,TIMESTAMPTZ,TEXT) TO authenticated;
```
This is a new, 12-arg overload of `admin_supersede_commercial_offer` (the original 11-arg form quoted in the architecture audit becomes the old overload) — subject to the identical three-phase deployment discipline as `admin_upsert_commercial_offer`, batched into the SAME Phase A/Phase C migrations already planned for that function's fix, since both are the same fix applied to sibling functions and warrant no separate migration file. After this correction, every commercial-authority RPC that resolves a plan by code (`resolve_commercial_offer`/`resolve_commercial_checkout_offer`, `admin_upsert_commercial_offer`, `admin_supersede_commercial_offer`) is product-scoped — none is left relying on `commercial_plans.code` being globally unique, which it is not guaranteed to be.

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
    'VERIFICATION_TRANSIENT_FAILURE'   -- NEW, the ONLY new value added here: a
                                        -- network/5xx/timeout contacting the
                                        -- provider's verify endpoint during a
                                        -- genuine WEBHOOK delivery — distinct
                                        -- from VERIFICATION_FAILED (a definitive
                                        -- rejection). Reconciliation outcomes are
                                        -- NOT added here — see the correction below.
  )
);
```
Purely additive (`DROP`+`ADD` on the same column, no data migration — no existing row's `processing_result` value is ever `VERIFICATION_TRANSIENT_FAILURE`, so no existing row is affected); safe to run without a backfill.

**Correction, round 3 (item 4): reconciliation outcomes are NOT recorded here.** Round 2 proposed adding `RECONCILED`/`RECONCILIATION_NO_TRANSACTION_FOUND`/`RECONCILIATION_TERMINAL_FAILURE` to this same constraint and inserting reconciliation attempts into `payment_webhook_processing_events`. **This is structurally impossible against the real schema**: `payment_webhook_processing_events.receipt_id` is `NOT NULL`, foreign-keyed to `payment_webhook_receipts(id)` (`20260906083524...sql:407,425`) — every row in this table must reference a real webhook delivery receipt, and reconciliation, by definition, runs for intents that never received a webhook at all. There is no receipt to reference; any attempted `INSERT` from the reconciliation path would fail the `NOT NULL` constraint outright. §7 below specifies a dedicated, purpose-built table for reconciliation evidence instead.

## 7. Reconciliation — one fully-specified mechanism with a dedicated evidence table, a durable lease, corrected arithmetic, and real cron authentication (items 4, 5, 6, 7, 11)

**Chosen mechanism, unchanged from round 2: `pg_cron` schedules a periodic HTTP call (via `pg_net`) to a dedicated Edge Function, `commercial-payment-reconcile`.** Everything downstream of that choice is corrected this round — including, per item 7, the schedule's own authentication, which round 2 left as an unusable placeholder (`'Bearer <service-role-key-or-dedicated-cron-secret>'`, a literal that cannot appear in a real migration and hedged between two different credential types without choosing).

### 7.0 — The canonical expiry / reconciliation-window rule (item 3)

**Confirmed contradiction:** `payment_checkout_intents.expires_at` defaults to `now() + 1 hour` — an existing, real, unchanged table default. Round 3's own reconciliation design (§7.2's `claimable` CTE, §7.2's `terminal` CTE) filtered on `t.expires_at > now()` in BOTH the ongoing-claim predicate and the terminal-transition predicate. **The two cannot coexist:** a `PENDING` intent that receives no webhook simply falls out of `expires_at > now()` after 61 minutes — never claimed again, and (because the terminal predicate carried the identical `expires_at > now()` clause) never transitioned to a terminal state either. It would sit `PENDING`, `reconciliation_attempt_count` frozen below 8, forever — a genuinely stranded row, discovered only by re-deriving the reconciliation programme's own math (a 265/305-minute schedule cannot possibly execute against a 60-minute eligibility window) rather than by any single line looking wrong in isolation.

**Root cause:** `expires_at` and "how long reconciliation may keep trying" are two different concepts that round 2/3 conflated by reusing one column for both. **`expires_at` governs ONLY the checkout SESSION's own browsable-URL lifetime** — how long a customer may still land on the Flutterwave-hosted page via a `REUSED` link, and the point past which `acquire_checkout_intent_lease`'s staleness sweep may mark a still-unresolved `CREATED`/`PENDING` row `EXPIRED` for FRESH-ACQUISITION purposes. It says nothing about whether a payment that genuinely completed on that page, in its final moments, may still be found and committed afterward — reconciliation's entire reason to exist is exactly that case (a webhook that never arrives, or arrives very late, for a real payment).

**Canonical rule, stated once, governing every point below — corrected round 5 into an explicit four-part lifecycle (Blocker 1), because a single column (`expires_at`) or a single status field cannot honestly represent four different questions at once:**

| Dimension | What it answers | Where it lives | What may set it |
|---|---|---|---|
| **A. URL reuse freshness** | May this specific `provider_checkout_url` still be handed back to the customer? | `expires_at` (unchanged, 1 hour) | Nothing mutates `expires_at` itself; it is a fixed deadline set once at row creation. Only READ, never written after `INSERT` |
| **B. Payment-resolution status** | Did the customer's money actually move, and is a licence owed? | `payment_checkout_intents.status` (`PENDING`/`SUCCEEDED`/`FAILED`/`CANCELLED`/`EXPIRED`) | ONLY `commit_verified_commercial_payment` (→`SUCCEEDED`), a definitive non-success verification (→`FAILED`), or a COMPLETED reconciliation terminal attempt finding no transaction (→`EXPIRED`, §7.2). **Never** set by `expires_at` passing alone |
| **C. Reconciliation status** | Is the system still actively trying to find out what happened? | `reconciliation_attempt_count`, `reconciliation_claim_token`, `reconciliation_lease_expires_at`, `reconciliation_last_completed_at` (§7.2) | `claim_stale_checkout_intents_for_reconciliation` / `finalize_reconciliation_attempt` only — fully decoupled from `expires_at` (point 2 below) |
| **D. Manual-review status** | Does a human need to look at this, because the system genuinely cannot determine B on its own? | **NEW column, item 1 round 5:** `payment_checkout_intents.requires_manual_review BOOLEAN NOT NULL DEFAULT false` (DDL in §7.2) | Only `finalize_reconciliation_attempt`'s ambiguous/transient-cap-exhaustion branch and the crashed-terminal-attempt sweep (§7.2) ever set this `true`; nothing ever sets it back to `false` automatically — clearing it is a deliberate, out-of-band admin action (via `admin_billing_lookup`'s existing review tooling), not part of this design's automated surface |

1. **`expires_at` (A) governs checkout-session freshness only** — `acquire_checkout_intent_lease`'s reuse check (§3a), corrected this round to never touch `status` for a `PENDING` row.
2. **Reconciliation eligibility (C) is fully decoupled from `expires_at`.** The claim predicates (§7.2) never reference `expires_at` at all.
3. **A payment that completed, on the provider's own side, BEFORE `expires_at` may commit (B) even if verified/reconciled AFTER `expires_at`.** Requires comparing the PROVIDER'S OWN payment timestamp against `expires_at` — never wall-clock "now."
4. **A payment that genuinely never happened becomes `EXPIRED` (B) ONLY via a COMPLETED, definitive `NO_TRANSACTION_FOUND` terminal reconciliation attempt** — never merely because an attempt counter reached 8, and never because `expires_at` passed. A crashed, never-completed terminal attempt sets `requires_manual_review` (D) instead — see the crashed-terminal-attempt sweep, §7.2, Blocker 2.
5. **A payment whose true outcome could never be determined is NEVER auto-classified `EXPIRED` or `FAILED` (B).** It sets `requires_manual_review = true` (D) instead, `status` unchanged — an honest "unknown," never a guess.
6. **A definitive non-success (Flutterwave reports `failed`/`cancelled`/`refunded`) transitions to `FAILED` (B) immediately** — unaffected by `expires_at` in either direction.
7. **A payment whose OWN provider timestamp is itself after `expires_at`** (the customer genuinely paid outside the checkout window, as opposed to paying on time but being verified late) **is rejected from commit (`PAYMENT_AFTER_INTENT_EXPIRY`) without mutating `status`** — real money may have moved on the provider's side, so this is never silently discarded; the caller (webhook or reconciliation) records it as evidence and sets `requires_manual_review = true` (D), since a human, not an automated heuristic, should decide how to handle a genuinely late but real payment.

**Corrected `authoriseCommit` (`supabase/functions/_shared/payments/authority.ts`) — CURRENT vs. PROPOSED:**

**CURRENT** (quoted verbatim from the file read during Step 1 of this mission):
```ts
export interface IntentRecord { id: string; expected_amount_minor: bigint; currency_code: string; saff_reference: string; status: string; expires_at: string; }
export function authoriseCommit(intent: IntentRecord, transaction: NormalizedTransaction): AuthorityCheckResult {
  if (!['CREATED', 'PENDING'].includes(intent.status)) return { authorised: false, reason: `INTENT_ALREADY_RESOLVED:${intent.status}` };
  if (new Date() > new Date(intent.expires_at)) return { authorised: false, reason: 'INTENT_EXPIRED' };
  if (transaction.normalizedStatus !== 'SUCCEEDED') return { authorised: false, reason: `NON_SUCCESS:${transaction.normalizedStatus}` };
  if (!moneyEquals(transaction.amountMinor, transaction.currencyCode, intent.expected_amount_minor, intent.currency_code)) {
    return { authorised: false, reason: `AMOUNT_MISMATCH: expected ${intent.expected_amount_minor} ${intent.currency_code}, got ${transaction.amountMinor} ${transaction.currencyCode}` };
  }
  if (transaction.saffReference && transaction.saffReference !== intent.saff_reference) {
    return { authorised: false, reason: `REFERENCE_MISMATCH: expected ${intent.saff_reference}, got ${transaction.saffReference}` };
  }
  return { authorised: true };
}
```
Line 2 (`new Date() > new Date(intent.expires_at)`) compares the CURRENT wall-clock instant against `expires_at` — exactly the defect the canonical rule closes: a payment that completed at minute 58 of a 60-minute window, verified by a webhook arriving at minute 63, is wrongly rejected `INTENT_EXPIRED` today, even though nothing about the payment itself was late.

**PROPOSED:**
```ts
export interface IntentRecord { id: string; expected_amount_minor: bigint; currency_code: string; saff_reference: string; status: string; expires_at: string; }
export function authoriseCommit(intent: IntentRecord, transaction: NormalizedTransaction): AuthorityCheckResult {
  if (!['CREATED', 'PENDING'].includes(intent.status)) return { authorised: false, reason: `INTENT_ALREADY_RESOLVED:${intent.status}` };
  if (transaction.normalizedStatus !== 'SUCCEEDED') return { authorised: false, reason: `NON_SUCCESS:${transaction.normalizedStatus}` };
  // Item 3 (round 4): compare the PROVIDER'S OWN payment timestamp against
  // expires_at, never wall-clock now() — a payment that completed before
  // the checkout session expired is authorised regardless of when
  // verification (webhook OR reconciliation) happens to run.
  if (new Date(transaction.providerCreatedAt) > new Date(intent.expires_at)) {
    return { authorised: false, reason: 'PAYMENT_AFTER_INTENT_EXPIRY' };
  }
  if (!moneyEquals(transaction.amountMinor, transaction.currencyCode, intent.expected_amount_minor, intent.currency_code)) {
    return { authorised: false, reason: `AMOUNT_MISMATCH: expected ${intent.expected_amount_minor} ${intent.currency_code}, got ${transaction.amountMinor} ${transaction.currencyCode}` };
  }
  if (transaction.saffReference && transaction.saffReference !== intent.saff_reference) {
    return { authorised: false, reason: `REFERENCE_MISMATCH: expected ${intent.saff_reference}, got ${transaction.saffReference}` };
  }
  return { authorised: true };
}
```
This requires a new field, `providerCreatedAt: string`, on `NormalizedTransaction` (`_shared/payments/contracts.ts`) — sourced from Flutterwave's `data.created_at` (a genuine, already-present field in the payload `flutterwave.ts`'s `verifyTransaction`/`verifyTransactionByReference` already parse for `id`/`status`/`currency`/`amount`/`tx_ref` — no new API surface, one more field read from a response already being read), and distinct from the existing `verifiedAt` field (which records when THIS system ran Gate B, not any provider-side timestamp). **The exact semantics of `data.created_at`, and the fail-closed handling required before this field can be trusted, are specified precisely — not assumed — in §7.4's "High 1" discussion below; read that before treating this field as settled.** Both adapter methods populate `providerCreatedAt` only after the fail-closed validation §7.4 specifies.

**`commit_verified_commercial_payment` — CURRENT vs. PROPOSED (round 5: quoted verbatim for the first time; rounds 1–4 described this function only in prose, which is exactly how the real defect below went unnoticed for four rounds).**

**CURRENT** (quoted verbatim, `supabase/migrations/20260906083524_eca6c272-4a62-4468-995b-1c70e2cd67e5.sql:547-553,630-644`):
```sql
  IF v_intent.status NOT IN ('CREATED','PENDING') THEN
    RETURN jsonb_build_object('status','INTENT_ALREADY_RESOLVED','intent_status',v_intent.status,'committed',false);
  END IF;
  IF now() > v_intent.expires_at THEN
    UPDATE public.payment_checkout_intents SET status='EXPIRED' WHERE id=p_checkout_intent_id;
    RETURN jsonb_build_object('status','INTENT_EXPIRED','committed',false);
  END IF;
  -- ... amount/currency checks unchanged ...
  -- (on the SUCCEEDED path, further down:)
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
```
**Two confirmed, independent defects in the real, live function**, neither previously quoted or fixed in rounds 1–4:
1. **Line `IF now() > v_intent.expires_at THEN`** compares wall-clock now against `expires_at` — exactly the canonical-rule violation Blocker 1 names — and, worse, **unconditionally mutates `status` to `'EXPIRED'`** before even checking whether `p_normalized_status = 'SUCCEEDED'`. A genuinely successful, correctly-verified payment arriving after `expires_at` hits this branch FIRST and is rejected `INTENT_EXPIRED` without ever reaching the commit logic at all — the exact "CUSTOMER CHARGED → PAYMENT VERIFIED → LICENCE DENIED BECAUSE LOCAL WALL CLOCK PASSED expires_at" scenario, confirmed present in the real, currently-deployed function.
2. **The `payment_events` INSERT's `provider_created_at` column (the table already has this column — `payment_events.provider_created_at TIMESTAMPTZ NULL`, added by this same Ω2-G migration, confirmed by direct read) is populated with a literal `now()`**, not any provider-supplied value — silently discarding the one piece of evidence the canonical rule's point 3 depends on (High 1).

**PROPOSED** — one new parameter, one corrected `IF`, one corrected `INSERT` value; nothing else in this ~170-line function changes:
```sql
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
  p_provider_created_at      TIMESTAMPTZ  -- NEW (item 3/Blocker 1, High 1): the provider's OWN
                                            -- payment-completion timestamp, sourced by both callers
                                            -- (webhook and reconciliation) from the corrected
                                            -- NormalizedTransaction.providerCreatedAt (§ below)
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
-- ... unchanged declarations ...
BEGIN
  -- ... unchanged idempotency pre-check ...
  -- ... unchanged SELECT ... FOR UPDATE on the intent ...
  IF v_intent.status NOT IN ('CREATED','PENDING') THEN
    RETURN jsonb_build_object('status','INTENT_ALREADY_RESOLVED','intent_status',v_intent.status,'committed',false);
  END IF;

  -- CORRECTED (Blocker 1, item 3): compare the PROVIDER'S OWN payment
  -- timestamp against expires_at, never wall-clock now(); NEVER mutate
  -- status on this path — status ownership for a rejected-but-possibly-
  -- still-live intent belongs to reconciliation (§7.0's four-part model),
  -- not to a single rejected commit attempt.
  IF p_provider_created_at > v_intent.expires_at THEN
    RETURN jsonb_build_object('status','PAYMENT_AFTER_INTENT_EXPIRY','committed',false);
  END IF;

  -- ... unchanged amount/currency checks, unchanged NON-SUCCESS branch,
  -- unchanged licence-period math, unchanged customer-level advisory lock
  -- (item 6, round 1) ...

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
    v_intent.plan_id,
    p_provider_created_at,  -- CORRECTED: was `now()`; now the real provider timestamp (High 1)
    now(),                  -- event_time (this system's own ledger timestamp) — correctly unchanged
    jsonb_build_object('licence_id',v_licence_id,'period_start',v_period_start,'period_end',v_period_end)
  ) RETURNING id INTO v_event_id;

  -- ... unchanged commercial_licences insert, billing_audit_events insert,
  -- payment_checkout_intents status='SUCCEEDED' update, return value ...
END;
$$;
```
Both callers of `commit_verified_commercial_payment` (`commercial-payment-webhook/index.ts` and `commercial-payment-reconcile/index.ts`) pass `p_provider_created_at` from the SAME `NormalizedTransaction.providerCreatedAt` field `authoriseCommit` already validated moments earlier — no second, independently-derived timestamp, no possibility of the RPC's re-check disagreeing with `authoriseCommit`'s own decision about the same transaction.

**Reconciliation claim/terminal predicates realigned:** §7.2 below drops every `expires_at > now()` reference from both the claim and terminal logic, per point 2 of the canonical rule.

### 7.1 — `payment_reconciliation_attempts`: a dedicated, append-only evidence table (item 4)

**Why a new table, not `payment_webhook_processing_events`:** confirmed in §6 above — that table's `receipt_id` is `NOT NULL`, and reconciliation has no receipt. Reusing it is not an option; a parallel, purpose-built table is required.

```sql
CREATE TABLE public.payment_reconciliation_attempts (
  id                      UUID        NOT NULL DEFAULT gen_random_uuid(),
  checkout_intent_id      UUID        NOT NULL,
  claim_token             UUID        NOT NULL,
  attempt_number          INTEGER     NOT NULL,
  result                  TEXT        NOT NULL
    CONSTRAINT chk_pra_result CHECK (
      -- Corrected round 5: 'RELEASED_RETRIABLE' removed (vestigial — every
      -- retriable outcome is recorded under its own real result value, e.g.
      -- 'NO_TRANSACTION_FOUND', never a generic placeholder); 'PAYMENT_AFTER_
      -- EXPIRY' added (item 7 round 5, §7.0 point 7 — a real, verified
      -- payment found outside the checkout window).
      result IN (
        'CLAIMED','RECONCILED','NO_TRANSACTION_FOUND','AMBIGUOUS_MULTIPLE_TRANSACTIONS',
        'NON_SUCCESS_STATUS','VERIFICATION_TRANSIENT_FAILURE','TERMINAL_FAILURE','PAYMENT_AFTER_EXPIRY',
        'PROVIDER_CREDENTIALS_UNAVAILABLE_FOR_ENVIRONMENT'  -- item 5 (Blocker 5), §12.5
      )
    ),
  provider_transaction_id TEXT        NULL,
  correlation_id          TEXT        NULL,
  started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at            TIMESTAMPTZ NULL,
  error_class             TEXT        NULL,

  CONSTRAINT payment_reconciliation_attempts_pk PRIMARY KEY (id),
  CONSTRAINT fk_pra_intent FOREIGN KEY (checkout_intent_id) REFERENCES public.payment_checkout_intents(id) ON DELETE CASCADE
);

CREATE INDEX idx_pra_intent ON public.payment_reconciliation_attempts (checkout_intent_id, attempt_number DESC);
CREATE INDEX idx_pra_claim_token ON public.payment_reconciliation_attempts (claim_token);

-- Immutable, append-only — the identical pattern already established for
-- payment_webhook_receipts/payment_webhook_processing_events.
CREATE OR REPLACE FUNCTION public.payment_reconciliation_attempts_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: payment_reconciliation_attempts is append-only. % on id=% is not permitted.', TG_OP, OLD.id;
END;
$$;
CREATE TRIGGER trg_pra_immutable
  BEFORE UPDATE OR DELETE ON public.payment_reconciliation_attempts
  FOR EACH ROW EXECUTE FUNCTION public.payment_reconciliation_attempts_immutable();
REVOKE ALL ON FUNCTION public.payment_reconciliation_attempts_immutable() FROM PUBLIC, anon, authenticated;

-- Admin-read / service-role-write — the identical grant/RLS shape as
-- payment_webhook_processing_events.
ALTER TABLE public.payment_reconciliation_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pra_select_admin_only" ON public.payment_reconciliation_attempts
  FOR SELECT USING (public.is_commercial_admin());
REVOKE ALL ON public.payment_reconciliation_attempts FROM anon, authenticated;
GRANT SELECT ON public.payment_reconciliation_attempts TO authenticated;
GRANT ALL    ON public.payment_reconciliation_attempts TO service_role;
```
Each row is a genuine attempt record (`CLAIMED` is written the instant a lease is acquired — see 7.2 — so a crash mid-attempt still leaves durable evidence that an attempt was made, even if it never reaches a terminal `result`; the row is never mutated afterward, a NEW row records the eventual outcome, keyed by the same `claim_token`).

### 7.2 — Durable, token-fenced reconciliation lease, atomic claim evidence, and atomic finalization (items 4, 5, 6 — corrected from round 3's timestamp-only, non-atomic design)

**Defect in round 3, three parts:**
- **(item 4)** The `CLAIMED` evidence row was inserted by the Edge Function, in a SEPARATE statement AFTER the claim RPC returned — a crash in that gap left a claimed, leased row with no evidence any attempt was ever made.
- **(item 5)** `release_reconciliation_lease` only ever cleared lease fields; the terminal (cap-exhaustion) transition lived in a SEPARATE `terminal` CTE inside the CLAIM function, disconnected from whichever worker actually ran the terminal attempt — and (per §7.0) that CTE's `expires_at > now()` predicate made it unreachable for any intent whose 1-hour checkout window had already lapsed, which is true of nearly every intent that ever reaches attempt 8.
- **(item 6)** The backoff anchor was `reconciliation_lease_expires_at - 2 minutes`, an approximation of when the prior attempt started, not when it actually finished.

**All three corrected together, since they are one coherent redesign:** the CLAIM function's job narrows to "claim + record CLAIMED evidence, atomically, including crash-recovery re-claims"; a NEW `finalize_reconciliation_attempt` function becomes the SOLE place any attempt's outcome — including cap-exhaustion — is recorded and, where warranted, propagated to the intent's own `status`.

**Corrected schema on `payment_checkout_intents`:**
```sql
ALTER TABLE public.payment_checkout_intents
  ADD COLUMN reconciliation_claim_token       UUID        NULL,
  ADD COLUMN reconciliation_lease_expires_at  TIMESTAMPTZ NULL,
  ADD COLUMN reconciliation_attempt_count     INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN reconciliation_last_completed_at TIMESTAMPTZ NULL,  -- item 6: the exact instant
    -- finalize_reconciliation_attempt last recorded a real outcome for this
    -- intent — the authoritative backoff anchor. reconciliation_lease_
    -- expires_at is used ONLY to detect a crashed (never-finalized) claim,
    -- never as a backoff anchor.
  ADD COLUMN requires_manual_review           BOOLEAN     NOT NULL DEFAULT false;  -- item 1 round 5
    -- (§7.0's dimension D) — set true ONLY by finalize_reconciliation_attempt's
    -- ambiguous/transient-cap-exhaustion branch and by the crashed-terminal-
    -- attempt sweep below; never cleared automatically.
```

**RPC — `claim_stale_checkout_intents_for_reconciliation`: claim + atomic `CLAIMED` evidence + the crashed-terminal-attempt sweep, `SKIP LOCKED`, correct composite return type (Blockers 2 and 4):**
```sql
CREATE OR REPLACE FUNCTION public.claim_stale_checkout_intents_for_reconciliation(p_batch_size INT DEFAULT 25)
RETURNS TABLE(intent public.payment_checkout_intents, claim_token UUID)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  -- Fixed backoff schedule, indexed by attempt_number about to be made
  -- (1-indexed) — a deterministic table, not a formula (item 6, §7.3).
  v_backoff_minutes CONSTANT INTEGER[] := ARRAY[0,5,10,20,40,60,60,60]; -- index 1..8
BEGIN
  -- STEP 1 (Blocker 2): the crashed-terminal-attempt sweep runs FIRST, as
  -- its own complete statement — not prose, not an omitted CTE. Detects
  -- EXACTLY the shape named in the mission: status='PENDING',
  -- reconciliation_attempt_count>=8, reconciliation_claim_token IS NOT
  -- NULL, reconciliation_lease_expires_at<=now(). FOR UPDATE SKIP LOCKED
  -- so this never blocks on, or double-processes against, a row a
  -- concurrent invocation already holds. The WHERE clause's own
  -- status='PENDING' guard means this can NEVER touch a row that has since
  -- become SUCCEEDED/FAILED/CANCELLED/EXPIRED by any other path — the
  -- mission's explicit "never overwrite" requirement, enforced structurally
  -- by the predicate itself, not by a separate check.
  WITH crashed_terminal AS (
    SELECT t.id, t.reconciliation_claim_token, t.reconciliation_attempt_count, t.billing_customer_id
      FROM public.payment_checkout_intents t
     WHERE t.status = 'PENDING'
       AND t.reconciliation_attempt_count >= 8
       AND t.reconciliation_claim_token IS NOT NULL
       AND t.reconciliation_lease_expires_at <= now()
       FOR UPDATE SKIP LOCKED
  ),
  crashed_evidence AS (
    -- Atomic terminal/manual-review evidence (Blocker 2's "insert terminal/
    -- manual-review evidence atomically"). Never classified NO_TRANSACTION_
    -- FOUND / EXPIRED — no worker ever obtained a final provider result for
    -- this attempt, so §7.0 point 4 (EXPIRED requires a COMPLETED
    -- definitive attempt) is structurally not satisfied here.
    INSERT INTO public.payment_reconciliation_attempts
      (checkout_intent_id, claim_token, attempt_number, result, completed_at, error_class)
    SELECT id, reconciliation_claim_token, reconciliation_attempt_count, 'TERMINAL_FAILURE', now(),
           'WORKER_CRASHED_BEFORE_FINALIZE'
      FROM crashed_terminal
    RETURNING checkout_intent_id
  ),
  crashed_audit AS (
    -- Blocker 3: billing_customer_id (NOT NULL) supplied from the locked
    -- intent row itself; correlation_id (UUID NULL) genuinely has none for
    -- a system-detected crash, so it is correctly omitted (defaults NULL),
    -- never coerced from an unrelated TEXT value.
    INSERT INTO public.billing_audit_events
      (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
    SELECT billing_customer_id, NULL, 'CHECKOUT_INTENT_RECONCILIATION_TERMINAL_UNKNOWN',
           jsonb_build_object('status','PENDING','requires_manual_review',false),
           jsonb_build_object('status','PENDING','requires_manual_review',true),
           'Reconciliation worker crashed before completing the terminal (8th) attempt — no final provider result was ever obtained; escalated for manual review, never classified as no-payment-found'
      FROM crashed_terminal
    RETURNING billing_customer_id
  )
  UPDATE public.payment_checkout_intents t
     SET reconciliation_claim_token = NULL, reconciliation_lease_expires_at = NULL,
         requires_manual_review = true
    FROM crashed_terminal c
   WHERE t.id = c.id AND t.status = 'PENDING';  -- re-asserted: never overwrites a
                                                  -- status that changed between the
                                                  -- CTE read and this UPDATE

  -- STEP 2: ordinary claim, exactly as round 4, with the composite return
  -- type corrected (Blocker 4).
  RETURN QUERY
  WITH claimable AS (
    -- Item 3 (round 4): NO expires_at reference anywhere in this predicate.
    SELECT t.id, t.reconciliation_attempt_count FROM public.payment_checkout_intents t
     WHERE t.status = 'PENDING' AND t.created_at < now() - interval '10 minutes'
       AND t.reconciliation_attempt_count < 8
       AND (
         (t.reconciliation_attempt_count = 0 AND t.reconciliation_claim_token IS NULL)
         OR (
           t.reconciliation_claim_token IS NULL
           AND t.reconciliation_last_completed_at IS NOT NULL
           AND now() >= t.reconciliation_last_completed_at
                         + (v_backoff_minutes[LEAST(t.reconciliation_attempt_count + 1, 8)] * interval '1 minute')
         )
         OR (t.reconciliation_claim_token IS NOT NULL AND t.reconciliation_lease_expires_at <= now())
       )
     ORDER BY t.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT p_batch_size
  ),
  claimed AS (
    UPDATE public.payment_checkout_intents t
       SET reconciliation_attempt_count = t.reconciliation_attempt_count + 1,
           reconciliation_claim_token = gen_random_uuid(),
           reconciliation_lease_expires_at = now() + interval '2 minutes'
      FROM claimable c
     WHERE t.id = c.id
    RETURNING t.*
  ),
  -- Item 4: the CLAIMED evidence row is inserted HERE, in the SAME
  -- statement-level transaction as the claim itself.
  evidence AS (
    INSERT INTO public.payment_reconciliation_attempts (checkout_intent_id, claim_token, attempt_number, result, started_at)
    SELECT id, reconciliation_claim_token, reconciliation_attempt_count, 'CLAIMED', now() FROM claimed
    RETURNING checkout_intent_id, claim_token
  )
  -- Blocker 4 CORRECTED: `claimed` referenced bare (not `claimed.*`) casts
  -- the whole CTE row — whose column set is exactly payment_checkout_
  -- intents' own, via `RETURNING t.*` above — to the named composite type
  -- the function's own signature declares. This is standard, executable
  -- PostgreSQL (the same "whole-row reference cast to a named composite"
  -- idiom used throughout PL/pgSQL RETURNING clauses), not pseudocode. The
  -- INNER JOIN to `evidence` (Blocker 4's "reference the evidence CTE
  -- explicitly") makes the atomicity contract structural: a row is
  -- returned to the caller ONLY if its CLAIMED evidence row was actually
  -- inserted in this same statement — never the reverse.
  SELECT claimed::public.payment_checkout_intents AS intent, claimed.reconciliation_claim_token AS claim_token
    FROM claimed
    JOIN evidence ON evidence.checkout_intent_id = claimed.id
                  AND evidence.claim_token = claimed.reconciliation_claim_token;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_stale_checkout_intents_for_reconciliation(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_stale_checkout_intents_for_reconciliation(INT) TO service_role;
```

**Exact TypeScript decoding shape (Blocker 4's explicit requirement) — `commercial-payment-reconcile/index.ts`:**
```ts
interface ClaimedRow {
  intent: {
    id: string; billing_customer_id: string; commercial_offer_id: string; plan_id: string;
    market_code: string; expected_amount_minor: string /* bigint arrives as string over PostgREST */;
    currency_code: string; currency_exponent: number; billing_interval: string;
    billing_interval_count: number; provider: string; provider_environment: 'SANDBOX' | 'PRODUCTION';
    saff_reference: string; provider_checkout_ref: string | null; provider_checkout_url: string | null;
    status: string; created_by_user_id: string; created_at: string; expires_at: string;
    completed_at: string | null; metadata: Record<string, unknown>;
    creation_token: string | null; lease_expires_at: string | null;
    reconciliation_claim_token: string; reconciliation_lease_expires_at: string;
    reconciliation_attempt_count: number; reconciliation_last_completed_at: string | null;
    requires_manual_review: boolean;
  };
  claim_token: string;
}

const { data, error } = await supabase.rpc('claim_stale_checkout_intents_for_reconciliation', { p_batch_size: 25 });
// data: ClaimedRow[] — each element's `intent` is the full composite row (supabase-js/PostgREST
// decodes a function returning `TABLE(intent public.payment_checkout_intents, ...)` as a nested
// object keyed by the OUT-parameter name, exactly as any other PostgREST composite-returning RPC).
for (const row of (data ?? []) as ClaimedRow[]) {
  await processClaimedIntent(row.intent, row.claim_token);
}
```

**RPC — `finalize_reconciliation_attempt`: the SOLE place an attempt's outcome — including cap-exhaustion — is recorded (item 5), billing-audit inserts corrected against the real schema (Blocker 3):**
```sql
CREATE OR REPLACE FUNCTION public.finalize_reconciliation_attempt(
  p_intent_id              UUID,
  p_claim_token            UUID,
  p_outcome                TEXT,  -- 'RECONCILED' | 'NO_TRANSACTION_FOUND' | 'AMBIGUOUS_MULTIPLE_TRANSACTIONS'
                                   -- | 'NON_SUCCESS_STATUS' | 'VERIFICATION_TRANSIENT_FAILURE'
                                   -- | 'PAYMENT_AFTER_EXPIRY' (new, item 7 round 5, §7.0 point 7)
  p_provider_transaction_id TEXT,
  p_correlation_id          UUID,  -- CORRECTED (Blocker 3): UUID, matching
                                    -- billing_audit_events.correlation_id's real
                                    -- type exactly — never unrestricted TEXT coerced
                                    -- into a UUID column. The Edge Function generates
                                    -- this with crypto.randomUUID() (Deno's own
                                    -- correlationId helper already returns a UUID
                                    -- string, so no format conversion is needed at
                                    -- the call site either).
  p_error_class             TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE v_intent RECORD;
BEGIN
  SELECT * INTO v_intent FROM public.payment_checkout_intents WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id USING ERRCODE = '22023';
  END IF;

  IF p_outcome = 'RECONCILED' THEN
    -- Called AFTER commit_verified_commercial_payment already transitioned
    -- status to SUCCEEDED — the claim-token check alone proves legitimacy.
    IF v_intent.status != 'SUCCEEDED' OR v_intent.reconciliation_claim_token != p_claim_token THEN
      RAISE EXCEPTION 'STALE_OR_INVALID_FINALIZE_CALL' USING ERRCODE = '40001';
    END IF;
  ELSE
    -- Every other outcome requires status still PENDING and the token to
    -- match exactly — item 5's "reject stale workers" and "never overwrite
    -- SUCCEEDED" in one check.
    IF v_intent.status != 'PENDING' OR v_intent.reconciliation_claim_token != p_claim_token THEN
      RAISE EXCEPTION 'STALE_OR_INVALID_FINALIZE_CALL' USING ERRCODE = '40001';
    END IF;
  END IF;

  INSERT INTO public.payment_reconciliation_attempts
    (checkout_intent_id, claim_token, attempt_number, result, provider_transaction_id, correlation_id, completed_at, error_class)
  VALUES
    (p_intent_id, p_claim_token, v_intent.reconciliation_attempt_count, p_outcome, p_provider_transaction_id, p_correlation_id::text, now(), p_error_class);
    -- payment_reconciliation_attempts.correlation_id is TEXT (§7.1's own
    -- DDL, unaffected by this round) — the UUID is cast to text ONLY at
    -- this one boundary, never the reverse; billing_audit_events.correlation_id
    -- (below) receives the UUID value directly, untouched.

  UPDATE public.payment_checkout_intents
     SET reconciliation_claim_token = NULL, reconciliation_lease_expires_at = NULL,
         reconciliation_last_completed_at = now()
   WHERE id = p_intent_id;

  IF p_outcome = 'NON_SUCCESS_STATUS' THEN
    UPDATE public.payment_checkout_intents SET status = 'FAILED' WHERE id = p_intent_id AND status = 'PENDING';
    INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason, correlation_id)
      VALUES (v_intent.billing_customer_id, NULL, 'CHECKOUT_INTENT_RECONCILIATION_FAILED',
        jsonb_build_object('status','PENDING'), jsonb_build_object('status','FAILED'),
        'Reconciliation found a definitive non-success provider transaction', p_correlation_id);
    RETURN jsonb_build_object('finalized', true, 'intent_status', 'FAILED');
  END IF;

  -- NEW (item 7 round 5, §7.0 point 7): a REAL, verified payment exists,
  -- but its own provider timestamp is after expires_at — never silently
  -- discarded, always escalated, status left untouched (commit_verified_
  -- commercial_payment never mutated it either — see §7.0's corrected body).
  IF p_outcome = 'PAYMENT_AFTER_EXPIRY' THEN
    UPDATE public.payment_checkout_intents SET requires_manual_review = true WHERE id = p_intent_id;
    INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason, correlation_id)
      VALUES (v_intent.billing_customer_id, NULL, 'CHECKOUT_INTENT_PAYMENT_AFTER_EXPIRY',
        jsonb_build_object('requires_manual_review',false), jsonb_build_object('requires_manual_review',true),
        'A verified successful provider transaction was found, but its own payment timestamp is after this intent''s expires_at — real funds may have moved; escalated for manual review, never auto-discarded',
        p_correlation_id);
    RETURN jsonb_build_object('finalized', true, 'intent_status', 'PENDING', 'requires_manual_review', true);
  END IF;

  -- Cap exhaustion via a COMPLETED terminal attempt (Blocker 3: billing_customer_id supplied).
  IF v_intent.reconciliation_attempt_count >= 8 AND p_outcome = 'NO_TRANSACTION_FOUND' THEN
    UPDATE public.payment_checkout_intents SET status = 'EXPIRED' WHERE id = p_intent_id AND status = 'PENDING';
    INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason, correlation_id)
      VALUES (v_intent.billing_customer_id, NULL, 'CHECKOUT_INTENT_RECONCILIATION_EXPIRED',
        jsonb_build_object('status','PENDING'), jsonb_build_object('status','EXPIRED'),
        'Reconciliation exhausted (8 completed attempts) with no transaction ever found', p_correlation_id);
    RETURN jsonb_build_object('finalized', true, 'intent_status', 'EXPIRED');
  END IF;
  IF v_intent.reconciliation_attempt_count >= 8 AND p_outcome IN ('VERIFICATION_TRANSIENT_FAILURE','AMBIGUOUS_MULTIPLE_TRANSACTIONS') THEN
    UPDATE public.payment_checkout_intents SET requires_manual_review = true WHERE id = p_intent_id;
    INSERT INTO public.payment_reconciliation_attempts
      (checkout_intent_id, claim_token, attempt_number, result, completed_at)
      VALUES (p_intent_id, p_claim_token, v_intent.reconciliation_attempt_count, 'TERMINAL_FAILURE', now());
    INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason, correlation_id)
      VALUES (v_intent.billing_customer_id, NULL, 'CHECKOUT_INTENT_RECONCILIATION_TERMINAL_UNKNOWN',
        jsonb_build_object('status','PENDING','requires_manual_review',false),
        jsonb_build_object('status','PENDING','requires_manual_review',true),
        'Reconciliation exhausted with no definitive answer', p_correlation_id);
    RETURN jsonb_build_object('finalized', true, 'intent_status', 'PENDING', 'requires_manual_review', true);
  END IF;

  RETURN jsonb_build_object('finalized', true, 'intent_status', v_intent.status);
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_reconciliation_attempt(UUID,UUID,TEXT,TEXT,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_reconciliation_attempt(UUID,UUID,TEXT,TEXT,UUID,TEXT) TO service_role;
```

**Reconciliation Edge Function protocol per claimed row:**
1. Call `verifyTransactionByReference` (§7.4).
2. On a definitive, verified `SUCCEEDED` result: run `authoriseCommit` + `commit_verified_commercial_payment` (passing `p_provider_created_at`, §7.0). If `authoriseCommit`/the RPC rejects with `PAYMENT_AFTER_INTENT_EXPIRY`, call `finalize_reconciliation_attempt(..., 'PAYMENT_AFTER_EXPIRY', ...)`. On a genuine commit, call `finalize_reconciliation_attempt(intent_id, claim_token, 'RECONCILED', providerTransactionId, correlationId, NULL)`.
3. On `NO_TRANSACTION_FOUND`, `AMBIGUOUS_MULTIPLE_TRANSACTIONS`, or `VERIFICATION_TRANSIENT_FAILURE`: call `finalize_reconciliation_attempt(..., <matching outcome>, ...)` — the function decides atomically whether this is retriable or terminal.
4. On a definitive non-retriable provider status (`FAILED`/`CANCELLED`/`REFUNDED` — §7.4): call `finalize_reconciliation_attempt(..., 'NON_SUCCESS_STATUS', ...)`.

**Crash recovery, every case (item 5/Blocker 2's explicit scenarios):**
- **Crash between claim and worker start:** the `CLAIMED` evidence row already exists (item 4); the lease expires after 2 minutes; the next tick's ordinary claim (STEP 2) reclaims it — no special handling needed.
- **Crash on the final (8th) attempt**, before `finalize_reconciliation_attempt` ever runs: the lease expires; `reconciliation_attempt_count` is already 8, so the ordinary claim's `< 8` guard correctly excludes it from a 9th real attempt. **The crashed-terminal-attempt sweep (STEP 1 above, now fully executable) is the dedicated, atomic mechanism that resolves this** — it runs as the FIRST statement of every `claim_stale_checkout_intents_for_reconciliation` invocation, so resolution happens within one `pg_cron` tick (≤5 minutes) of the crash, never left indefinitely, and never classifies the row as `EXPIRED` (no completed terminal attempt ever ran) — only `requires_manual_review = true`.
- **Stale worker terminalization after another worker succeeds:** the second worker's `finalize_reconciliation_attempt` call fails the `status != 'PENDING'` (already `SUCCEEDED`) or token-mismatch check and is rejected with `STALE_OR_INVALID_FINALIZE_CALL` — it never overwrites the successful outcome.

### 7.3 — Corrected backoff arithmetic and exact maximum elapsed window (item 6, round 3; anchor corrected round 4)

Fixed schedule (minutes of delay before each numbered attempt): attempt 1 waits **10** minutes from intent creation (the initial detection gate — `created_at < now() - interval '10 minutes'`, unchanged); attempts 2–8 wait **5, 10, 20, 40, 60, 60, 60** minutes respectively from the **actual completion of the prior attempt** (`reconciliation_last_completed_at`, item 6 round 4 — no longer an approximation via lease-start, since `finalize_reconciliation_attempt` stamps this column at the exact moment each attempt genuinely concludes).

**Exact designed maximum elapsed window, assuming each attempt is claimed and finalized at its earliest eligible instant:** `10 + 5 + 10 + 20 + 40 + 60 + 60 + 60 = 265 minutes = 4 hours 25 minutes` from intent creation to the 8th attempt being finalized. Because `pg_cron` polls every 5 minutes (not continuously), each step's actual eligibility is quantized to the next tick — adding up to 5 minutes of jitter per step. **Worst-case bound including cron-tick quantization: `265 + (8 × 5) = 305 minutes = 5 hours 5 minutes`** from creation to terminal classification (`EXPIRED`, or `PENDING`-with-manual-review-flag per §7.0 point 5). These figures are now **exact**, not conservative approximations — round 3's "~2 minutes of extra, conservative delay per step" caveat no longer applies, since the anchor (`reconciliation_last_completed_at`) is the real completion timestamp rather than a lease-start proxy.

**Explicitly decoupled from `expires_at` (§7.0):** this 265/305-minute window runs in full regardless of the intent's own 1-hour checkout-session `expires_at` — reconciliation's entire purpose is to keep trying well past that point, for exactly the case where the checkout session's own bookkeeping says "expired" but the customer may have paid moments before it did.

### 7.4 — Flutterwave lookup-by-reference: deterministic behavior for every outcome (item 11)

`verifyTransactionByReference(saffReference, expectedMinor, expectedCurrency)` calls Flutterwave's `GET /transactions?tx_ref=...`. Exact behavior, per case:

| Case | Behavior |
|---|---|
| **Zero matches** | `{verified:false, reason:'NO_TRANSACTION_FOUND'}` — not an error; the customer may simply not have paid yet. Reconciliation calls `finalize_reconciliation_attempt(..., 'NO_TRANSACTION_FOUND', ...)`, which retries or terminates per §7.2. |
| **Exactly one match** | Proceeds through the identical amount/currency/reference/status checks `verifyTransaction` (Gate B) already performs — same bigint comparison, same no-fallback reference check, same normalized-status mapping — plus the new `providerCreatedAt` capture (§7.0) used by `authoriseCommit`'s corrected expiry check. |
| **Multiple matches** | `{verified:false, reason:'AMBIGUOUS_MULTIPLE_TRANSACTIONS_FOR_REFERENCE'}` — **never silently picks one**, mirroring `resolve_commercial_offer`'s own AMBIGUOUS-never-guess discipline. `finalize_reconciliation_attempt(..., 'AMBIGUOUS_MULTIPLE_TRANSACTIONS', ...)` retries or, at the terminal attempt, escalates for mandatory human review (§7.0 point 5, §7.2) — never auto-resolved by picking one. |
| **Wrong merchant/account** | **Structurally foreclosed, not separately checked.** Flutterwave's REST API authenticates every call via the deployment's own `FLUTTERWAVE_SECRET_KEY`, which is merchant-account-scoped by Flutterwave's own platform design — a query made with this deployment's key can only ever return this deployment's own account's transactions. No additional cross-tenant check is fabricated here because none is needed; the API's own authentication model already provides this guarantee. |
| **Sandbox/production mismatch** | **Correction, round 4:** round 3 called this out-of-scope, reasoning that no environment tracking existed on `payment_checkout_intents`. Item 1 (round 4) adds exactly that — `provider_environment` (§3.0) — so reconciliation now has a genuine signal: `commercial-payment-reconcile` selects the Flutterwave adapter instance matching the CLAIMED intent's own `provider_environment` (never the currently-configured default), so a sandbox-created intent is always looked up against the sandbox account and a production one against production, regardless of what `commercial_platform_state` happens to be set to at reconciliation time. This closes the mismatch risk directly rather than leaving it to resolve to an indistinguishable `NO_TRANSACTION_FOUND`. |
| **Non-successful status (a real match, but `status` is `pending`/`failed`/`cancelled`/etc.)** | `pending` → treated the same as "not yet confirmed," retriable. `failed`/`cancelled`/`refunded` → a **definitive, non-retriable** outcome — `finalize_reconciliation_attempt(..., 'NON_SUCCESS_STATUS', ...)` transitions the intent directly to `FAILED` without exhausting the remaining backoff schedule (§7.2) — there is no reason to keep polling a transaction the provider itself has already definitively closed out. |
| **Missing, malformed, or impossible `data.created_at`** (new, High 1 round 5) | **Fail closed.** If `data.created_at` is absent, fails `new Date(...)` parsing (`isNaN(parsed.getTime())`), or resolves to a timestamp after the CURRENT moment (a provider clock anomaly — a payment cannot have completed in the future), `verifyTransactionByReference`/`verifyTransaction` return `{verified:false, reason:'PROVIDER_TIMESTAMP_INVALID'}` — the transaction is treated as NOT verified, never defaulted to `now()` or silently accepted with a missing/impossible timestamp. This is the direct enforcement of §7.0's canonical rule depending on a value that must itself be trustworthy before it is trusted. |

**High 1 — `data.created_at` semantics, proven rather than assumed:** Flutterwave's `GET /transactions/:id/verify` and `GET /transactions?tx_ref=...` responses both return, inside `data`, a `created_at` field documented by Flutterwave's own API reference as the transaction record's creation timestamp on their platform, in ISO-8601 format. **This design does not claim independent, first-party confirmation of that documentation beyond what is stated here** — no live sandbox fixture was captured during this design pass (this environment has no Flutterwave sandbox credentials or network access). Recorded honestly, not overstated: `data.created_at` is Flutterwave's own stated field for "when this transaction record was created," which this design treats as the authoritative payment-completion instant for the canonical rule's purposes; if a future implementation pass, working against a real sandbox account, finds Flutterwave's actual behavior differs from the documented contract (e.g. the field reflects checkout-session creation rather than payment-capture completion), `authoriseCommit`'s comparison must be revisited before this design ships — this is recorded as an explicit **pre-implementation verification requirement**, not silently assumed correct. The fail-closed handling above (missing/malformed/impossible values rejected, never defaulted) is what makes this safe to depend on even before that live verification happens: a wrong-but-present timestamp that fails a sanity check is rejected, not silently trusted.

**Timezone, boundary, malformed, and clock-skew handling (High 1's explicit test requirement — executable cases specified in `ACCEPTANCE_MATRIX.md` §9):** `data.created_at` is parsed via `new Date(data.created_at)`, which correctly normalizes any ISO-8601 offset (including a bare `Z`/UTC or an explicit `+03:00`-style offset) to the same UTC instant `expires_at` (a `TIMESTAMPTZ`, always stored/compared in UTC) uses — no separate timezone-conversion logic is needed since JavaScript's `Date` and Postgres's `TIMESTAMPTZ` both operate on absolute instants, never wall-clock-without-zone values. At the exact boundary (`providerCreatedAt === expires_at` to the microsecond), the comparison `providerCreatedAt > expires_at` is `false` — an exact-boundary payment is authorised, consistent with `expires_at` being defined as the moment the session becomes invalid FOR REUSE, not the last valid instant for a payment already in flight on that session. Clock skew between this system and Flutterwave's own clock is not separately compensated — both `expires_at` (set by this system) and `data.created_at` (set by Flutterwave) are absolute UTC instants from two independently-run clocks; any skew is a genuine, if small, source of edge-case disagreement, and is explicitly NOT corrected for in this design (no fabricated tolerance window) — if operational experience after implementation shows this causes real false rejections, a small explicit tolerance (e.g. ±30 seconds) would be a narrow, separately-reviewed follow-up change, not silently built in now.

### 7.5 — Deployable cron authentication (item 7): project-URL provisioning, Vault+Edge secret installation, SHA-256 preflight gate, rotation

**Rejected: putting any credential literal in migration SQL** (unchanged from round 3). **Rejected: using the Supabase service-role key as the cron credential** (unchanged from round 3).

**Rejected, round 5 (Blocker 6): `ALTER DATABASE postgres SET app.settings.project_url = 'https://<project-ref>.supabase.co'` inside a committed migration.** Round 4's own migration file is byte-identical across staging and production (that is the entire point of a migration file — the same SQL applies everywhere) — it cannot simultaneously set the correct value for two different project references. A `<project-ref>` placeholder in committed SQL is exactly as unsafe as a placeholder secret: whichever single value gets committed becomes wrong for every OTHER environment the migration also runs against.

**Corrected: the project URL is provisioned the SAME way the cron secret already is (§ below) — a named Vault entry, installed manually, per-environment, NEVER inside migration SQL.** This is not a new mechanism; it reuses the exact pattern already established for `omega3_reconciliation_cron_secret`, so there is only one provisioning discipline to operate, not two.
```sql
-- One-time setup, per environment, run via the Supabase dashboard's Vault
-- UI or vault.create_secret() — NEVER via a migration file:
--   staging:    SELECT vault.create_secret('https://<staging-project-ref>.supabase.co',
--                 'omega3_reconciliation_project_url', 'Ω3 reconciliation target URL — STAGING');
--   production: SELECT vault.create_secret('https://<production-project-ref>.supabase.co',
--                 'omega3_reconciliation_project_url', 'Ω3 reconciliation target URL — PRODUCTION');
-- Each environment's own Supabase project has its OWN Vault — there is no
-- shared Vault instance across staging and production, so this value is
-- naturally, structurally environment-scoped the moment it is installed
-- via each project's own dashboard/CLI session, never by a value baked
-- into shared source.
```
`cron.schedule(...)`'s body reads the URL from Vault, exactly like the secret header:
```sql
SELECT cron.schedule(
  'omega3_checkout_reconciliation', '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'omega3_reconciliation_project_url')
           || '/functions/v1/commercial-payment-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Reconciliation-Cron-Secret',
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'omega3_reconciliation_cron_secret')
    ),
    body := '{}'::jsonb
  )
  $$
);
```
**This `cron.schedule` call itself is NOT part of the Phase A migration** — see the preflight gate below for why it ships as a separate, later, manually-gated step. The Phase A migration may create the validation FUNCTION below (schema, portable across environments); it embeds no environment-specific URL or project-ref anywhere.

**URL validation, run as part of the SAME deployment preflight as the secret fingerprint check (item 7's explicit HTTPS/hostname/project-ref/no-trailing-path/cross-environment requirements):**
```sql
CREATE OR REPLACE FUNCTION public.reconciliation_validate_project_url(p_expected_project_ref TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog AS $$
DECLARE v_url TEXT;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'omega3_reconciliation_project_url';
  IF v_url IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'PROJECT_URL_NOT_CONFIGURED');
  END IF;
  -- The trailing '$' anchor is what proves "no trailing path injection" —
  -- any path/query/fragment after the hostname fails this exact match.
  -- The literal p_expected_project_ref (supplied by the operator running
  -- THIS preflight, who knows which environment they intend to target —
  -- staging's own runbook names staging's ref, production's names
  -- production's) is what proves cross-environment targeting is
  -- impossible: a staging operator's preflight, run with staging's own
  -- expected ref, fails closed if Vault happens to hold a production URL
  -- (or vice versa) — the check compares WHAT IS CONFIGURED against WHAT
  -- THE OPERATOR INTENDS, never merely "is this syntactically a URL."
  IF v_url !~ ('^https://' || p_expected_project_ref || '\.supabase\.co$') THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'URL_MISMATCH_OR_INVALID', 'configured_url', v_url);
  END IF;
  RETURN jsonb_build_object('valid', true, 'url', v_url);
END;
$$;
REVOKE ALL ON FUNCTION public.reconciliation_validate_project_url(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconciliation_validate_project_url(TEXT) TO service_role;
```
**Deployment preflight procedure, extended:** before EVER running `cron.schedule(...)`, the operator runs `SELECT reconciliation_validate_project_url('<this-environment-own-known-project-ref>');` and confirms `valid: true`, IN ADDITION TO the secret-fingerprint comparison below. Both checks must pass; `cron.schedule(...)` is never executed if either fails. This closes items 14/15 of the required executable validation design ("staging cron configuration cannot target production" / "production cannot target staging") structurally — an operator who runs the staging preflight with staging's own known ref, against a Vault holding a production URL, gets `URL_MISMATCH_OR_INVALID`, not a silent pass.

**Exact secret installation procedure (item 7's own explicit requirement — "define how one generated secret value is installed into Vault and Edge Function secrets"):**
1. An authorized operator generates one cryptographically random value OUTSIDE any committed file (e.g. `openssl rand -base64 32` run locally, never pasted into a commit, PR description, or chat log).
2. The SAME value is stored in Supabase Vault, by name, via an ad-hoc SQL statement run manually by that operator against the target project (never inside a migration file): `SELECT vault.create_secret('<generated-value>', 'omega3_reconciliation_cron_secret', 'Ω3 reconciliation cron trigger secret');`
3. The IDENTICAL value is set as the Edge Function secret via the Supabase CLI: `supabase secrets set RECONCILIATION_CRON_SECRET=<generated-value>` (or the dashboard's Edge Function secrets UI) — deployed to `commercial-payment-reconcile`.
4. Both installations use the SAME one generated value — never independently generated per side, which would guarantee a permanent mismatch.

**SHA-256 fingerprint preflight — compares the two installed values without ever transmitting either in the clear, blocks cron activation on mismatch (item 7's explicit requirement):**
```sql
-- Read-only diagnostic RPC — returns a fingerprint, never the secret itself.
CREATE OR REPLACE FUNCTION public.reconciliation_cron_secret_fingerprint()
RETURNS TEXT LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog, extensions AS $$
  SELECT encode(digest(decrypted_secret, 'sha256'), 'hex')
    FROM vault.decrypted_secrets WHERE name = 'omega3_reconciliation_cron_secret';
$$;
REVOKE ALL ON FUNCTION public.reconciliation_cron_secret_fingerprint() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconciliation_cron_secret_fingerprint() TO service_role;
```
```ts
// commercial-payment-reconcile/index.ts — a dedicated, admin-only diagnostic
// branch, checked via the SAME constant-time-verified header as every other
// request to this function (never a separate, unauthenticated endpoint).
if (req.headers.get('X-Reconciliation-Preflight') === 'fingerprint') {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(RECONCILIATION_CRON_SECRET));
  const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  return new Response(JSON.stringify({ fingerprint: hex }), { status: 200 });
}
```
**Deployment preflight procedure:** after step 3 above (Edge Function secret deployed) but BEFORE running `cron.schedule(...)` at all, the operator runs BOTH: `SELECT reconciliation_cron_secret_fingerprint();` (the Vault side) and a manual authenticated call to the Edge Function's fingerprint branch (the Edge-secret side), and compares the two hex strings by eye or script. **`cron.schedule(...)` is never executed until this comparison matches exactly.** A mismatch means step 2 or step 3 above used different values (or one was mistyped) — the fix is re-running whichever step diverged, never proceeding with a scheduled job that would silently 401 on every single invocation, forever, with reconciliation quietly never running and no other visible symptom.

**Rotation and rollback procedure, extended with the same preflight gate at each phase:** (1) generate a new secret value; (2) install it as a SECOND Vault entry (`omega3_reconciliation_cron_secret_next`) and a second Edge Function secret (`RECONCILIATION_CRON_SECRET_NEXT`); (3) **run the preflight fingerprint comparison against the NEW pair before proceeding** — identical procedure, new secret name; (4) redeploy `commercial-payment-reconcile` to accept EITHER the current `RECONCILIATION_CRON_SECRET` OR `RECONCILIATION_CRON_SECRET_NEXT` (both via the same constant-time comparison) — the same two-phase-acceptance discipline already used throughout this design for the resolver/admin-function overloads; (5) update the `cron.schedule` job (via `cron.alter_job` or unschedule+reschedule) to send the NEW secret value; (6) confirm via Edge Function logs that requests now authenticate against the new value; (7) remove the old value's acceptance in a follow-up deploy, then delete the old Vault entry. **Rollback:** if the new secret causes unexpected failures, revert the Edge Function deploy (step 4) to accept only the original secret — the original Vault entry is never deleted until step 7, so no credential regeneration is needed to roll back, only a code revert.

## 8. `Pricing.tsx` request/response, `CheckoutUpgradeButton`, `commercialRpc.ts` — request/response shape unchanged from round 1; `createCheckoutIntent` gains bounded-retry handling (round 3, item 8)

The `marketCode`-removed, `billingInterval`-required request/response contracts specified in round 1 are unchanged; `CheckoutUpgradeButton`'s display call still targets `resolve_commercial_offer` (§1a, unchanged public signature) and its checkout call still goes through `createCheckoutIntent` → `commercial-create-checkout`, which internally now uses `resolve_commercial_checkout_offer` (§1b) — this internal routing change is invisible to the frontend contract.

**New this round, corrected in round 5 (High 2A) — the exact deadline/attempt-count contract §2 declares, with full `Retry-After` sanitization:**
```ts
const MAX_ATTEMPTS = 3;      // one initial request plus two retries — THE canonical
                              // definition, matching §2's prose and ACCEPTANCE_MATRIX.md
                              // §9 test 16/17 exactly; no other number appears anywhere
const DEADLINE_MS = 15_000;
const DEFAULT_RETRY_SECONDS = 2;
const MAX_RETRY_SECONDS = 10;  // bounded maximum — a hostile or malfunctioning server
                                 // sending an enormous Retry-After can never stall the
                                 // client beyond this, regardless of what it requests

/** Sanitizes a server-supplied Retry-After value: numeric, finite, positive,
 *  bounded, and never allowed to exceed the remaining deadline. */
function sanitizeRetryAfterSeconds(raw: string | null, remainingMs: number): number {
  const parsed = raw === null ? NaN : Number(raw);
  const remainingSeconds = Math.max(0, remainingMs / 1000);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // Missing, non-numeric, NaN, zero, or negative — falls back to the
    // default, itself still capped by whatever time remains.
    return Math.min(DEFAULT_RETRY_SECONDS, remainingSeconds);
  }
  return Math.min(parsed, MAX_RETRY_SECONDS, remainingSeconds);
}

export async function createCheckoutIntent(
  planCode: string, billingInterval: "MONTHLY" | "ANNUAL",
): Promise<{ data: CheckoutIntentResponse | null; error: string | null }> {
  const startedAt = Date.now();
  const TIMEOUT_MESSAGE = 'Checkout is taking longer than expected — please try again in a moment.';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Deadline enforced BEFORE every request, including the first — never
    // issue a request once the 15-second budget is already exhausted.
    if (Date.now() - startedAt >= DEADLINE_MS) return { data: null, error: TIMEOUT_MESSAGE };

    const res = await fetch(/* ... unchanged request construction ... */);

    if (res.status === 202) {
      const remainingMs = DEADLINE_MS - (Date.now() - startedAt);
      if (attempt === MAX_ATTEMPTS || remainingMs <= 0) return { data: null, error: TIMEOUT_MESSAGE };
      const delaySeconds = sanitizeRetryAfterSeconds(res.headers.get('Retry-After'), remainingMs);
      await new Promise(r => setTimeout(r, delaySeconds * 1000));
      continue;
    }

    const json = await res.json();
    if (!res.ok) return { data: null, error: json?.error ?? 'Checkout failed' };
    return { data: json as CheckoutIntentResponse, error: null };
  }
  return { data: null, error: TIMEOUT_MESSAGE };
}
```
`CheckoutUpgradeButton.tsx` itself is unchanged — it only ever sees this function's eventual resolved `{data, error}` shape, never the intermediate 202 responses, exactly as it already handles any other error today.

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
| Any state, when `getConfiguredProviders().find(p => p.provider === provider)` resolves to nothing (round 3, item 9) | — | — | 503 `PROVIDER_CAPABILITY_UNRESOLVED` — fail closed unconditionally, checked BEFORE the environment-mismatch branches below it, so an unresolved capability can never fall through to being silently treated as "not sandbox, therefore fine" (the exact fail-open gap round 2 left, corrected in §2 step 8) |

This table is the literal contract `commercial-create-checkout`'s two-part platform-state gate (§2) implements — Part A's rows (`PAYMENTS_DISABLED`, missing/invalid row) are checked before offer resolution; Part B's rows (provider-capability resolution, provider-environment mismatch, restricted identity) are checked after `selectPaymentProvider` has determined the actual provider for this offer, exactly because that determination is what round 2 corrected and round 3's capability-resolution check now guards unconditionally.

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

**Second, unrelated change to the same function (item 3/Blocker 1 — full CURRENT-vs-PROPOSED SQL, quoted verbatim against the real, live function body, now lives in §7.0):** the existing `IF now() > v_intent.expires_at THEN UPDATE ... SET status='EXPIRED' ...` block is corrected to a new `p_provider_created_at TIMESTAMPTZ` parameter compared against `expires_at` (never `now()`), and — critically — the corrected branch no longer mutates `status` at all on rejection, since status ownership for a rejected-but-possibly-still-live intent belongs to reconciliation's four-part lifecycle model (§7.0), not to a single rejected commit attempt. Scoped to one added parameter, one corrected `IF`, and one corrected `INSERT` value (`payment_events.provider_created_at`, High 1) — the licence-period math, idempotency handling, and customer-level lock above are all unaffected.

## 12. Dual-environment Flutterwave credentials (Blocker 5)

**Confirmed non-implementability, round 5:** the real, live codebase has exactly one `FLUTTERWAVE_SECRET_KEY`/`FLUTTERWAVE_WEBHOOK_SECRET` pair and one `FLUTTERWAVE_ENVIRONMENT` flag, consumed by a single-instance adapter (`getFlutterwaveAdapter()`, a module-level singleton in `flutterwave.ts`) and a single capability entry in `routing.ts`'s `getConfiguredProviders()`. Round 4's claim that reconciliation could "select the Flutterwave adapter instance matching the claimed intent's own `provider_environment`" had nothing to select between — there was only ever one instance, configured with whichever single key pair `FLUTTERWAVE_ENVIRONMENT` currently names. **Chosen architecture: OPTION A — dual environment credentials**, per the mission's own stated preference for uninterrupted transition and forensic resolution of historical sandbox transactions (a real CFOClose requirement: sandbox testing must continue to be reconcilable after a production go-live, not cut off).

### 12.1 — Secrets

```
FLUTTERWAVE_SANDBOX_SECRET_KEY
FLUTTERWAVE_SANDBOX_WEBHOOK_SECRET
FLUTTERWAVE_PRODUCTION_SECRET_KEY
FLUTTERWAVE_PRODUCTION_WEBHOOK_SECRET
```
`FLUTTERWAVE_SECRET_KEY`/`FLUTTERWAVE_WEBHOOK_SECRET`/`FLUTTERWAVE_ENVIRONMENT` are retired (rollout order in §12.5). Never logged, never returned in any response — the existing `flutterwave.ts` header discipline ("FLUTTERWAVE_SECRET_KEY never leaves this module. Never logged.") applies identically to all four new names.

### 12.2 — Adapter construction takes an explicit environment

```ts
// flutterwave.ts — CORRECTED: environment-parameterized construction,
// replacing the single module-level singleton.
export class FlutterwaveAdapter implements ProviderAdapter {
  readonly provider = 'FLUTTERWAVE' as const;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  private readonly secretKey: string;
  private readonly webhookSecret: string;

  constructor(environment: 'SANDBOX' | 'PRODUCTION') {
    const keyVar     = environment === 'PRODUCTION' ? 'FLUTTERWAVE_PRODUCTION_SECRET_KEY'     : 'FLUTTERWAVE_SANDBOX_SECRET_KEY';
    const webhookVar = environment === 'PRODUCTION' ? 'FLUTTERWAVE_PRODUCTION_WEBHOOK_SECRET' : 'FLUTTERWAVE_SANDBOX_WEBHOOK_SECRET';
    const key = Deno.env.get(keyVar);
    const webhookSecret = Deno.env.get(webhookVar);
    if (!key || !webhookSecret) {
      throw new Error(`Iron Dome: ${keyVar} and ${webhookVar} are required for the ${environment} adapter.`);
    }
    this.environment = environment;
    this.secretKey = key;
    this.webhookSecret = webhookSecret;
  }
  // ... createCheckout / verifyTransaction / verifyTransactionByReference /
  // verifyWebhookAuthenticity / normalizeWebhook bodies UNCHANGED from
  // rounds 1–4, operating on THIS instance's own secretKey/webhookSecret ...
}

// Two independent singletons, not one — each constructed lazily, only if
// that environment's secrets are actually configured (never throws at
// module load for an environment nobody is using yet).
let _sandboxAdapter: FlutterwaveAdapter | null = null;
let _productionAdapter: FlutterwaveAdapter | null = null;
export function getFlutterwaveAdapter(environment: 'SANDBOX' | 'PRODUCTION'): FlutterwaveAdapter {
  if (environment === 'PRODUCTION') { _productionAdapter ??= new FlutterwaveAdapter('PRODUCTION'); return _productionAdapter; }
  _sandboxAdapter ??= new FlutterwaveAdapter('SANDBOX'); return _sandboxAdapter;
}
```

### 12.3 — `routing.ts`: up to two capability entries, environment-filtered by the caller before selection

```ts
// getConfiguredProviders() now returns ZERO, ONE, or TWO entries for
// FLUTTERWAVE — one per environment that has BOTH its secrets configured.
// Both may legitimately be configured simultaneously during a transition
// window (item 5's "historical sandbox intents remain verifiable").
export function getConfiguredProviders(): PaymentProviderCapabilities[] {
  const providers: PaymentProviderCapabilities[] = [];
  if (Deno.env.get('FLUTTERWAVE_SANDBOX_SECRET_KEY') && Deno.env.get('FLUTTERWAVE_SANDBOX_WEBHOOK_SECRET')) {
    providers.push({ ...FLUTTERWAVE_CAPABILITIES, environment: 'sandbox' });
  }
  if (Deno.env.get('FLUTTERWAVE_PRODUCTION_SECRET_KEY') && Deno.env.get('FLUTTERWAVE_PRODUCTION_WEBHOOK_SECRET')) {
    providers.push({ ...FLUTTERWAVE_CAPABILITIES, environment: 'production' });
  }
  return providers;
}
```
**New gap this design closes, found while specifying Blocker 5 (not previously identified):** with up to two simultaneously-configured FLUTTERWAVE entries, `selectPaymentProvider`'s existing currency/market-only eligibility filter (unchanged, `routing.ts`) could non-deterministically pick either environment's entry for a NEW checkout — and, separately, Part B's own capability lookup (`getConfiguredProviders().find(p => p.provider === provider)`) would become ambiguous the moment two entries share the same `provider` value. **Both are corrected together, in place, in §2's own steps 7–8** (not shown a second time here to avoid two documents of this package disagreeing about the exact code) — `commercial-create-checkout` computes `requiredEnv` from `state` and filters `getConfiguredProviders()` to `envFilteredProviders` BEFORE calling `selectPaymentProvider`, and Part B's lookup reuses that SAME filtered array rather than re-querying the full list. See §2 for the exact, current code.

### 12.4 — Webhook environment selection: routing-based, never payload-trusted

The mission's explicit requirement — "Webhook verification selects the correct webhook secret without trusting an attacker-supplied environment field... derived from the matched intent/provider account or separately authenticated routing" — is closed by **routing**, not by inspecting the payload: Flutterwave's own dashboard configuration sends sandbox events to one URL and production events to a different URL (the standard, correct pattern for this exact problem — a merchant configures ONE webhook URL per environment in Flutterwave's own settings). `commercial-payment-webhook` is deployed to two distinct routes, each hardcoded (at deploy time, via its own Edge Function environment variable — never inferred from the request) to exactly one environment:
```ts
// commercial-payment-webhook/index.ts
const WEBHOOK_ENVIRONMENT = Deno.env.get('WEBHOOK_ENVIRONMENT'); // 'SANDBOX' | 'PRODUCTION' — set
  // once, at deploy time, per Edge Function deployment target. NEVER read from
  // the incoming request, a header, or any field inside the webhook payload.
if (WEBHOOK_ENVIRONMENT !== 'SANDBOX' && WEBHOOK_ENVIRONMENT !== 'PRODUCTION') {
  throw new Error('Iron Dome: WEBHOOK_ENVIRONMENT must be explicitly configured at deploy time.');
}
const adapter = getFlutterwaveAdapter(WEBHOOK_ENVIRONMENT);
// Gate A (verifyWebhookAuthenticity) now runs against EXACTLY the one
// webhook secret this deployment target was configured for — an attacker
// cannot claim to be "production" by adding a field to the payload, because
// no field in the payload is ever consulted for this decision.
```
Flutterwave's dashboard is configured (an operational step, not code) with two webhook URLs: the sandbox account's events point at the deployment carrying `WEBHOOK_ENVIRONMENT=SANDBOX`, the production account's at the one carrying `WEBHOOK_ENVIRONMENT=PRODUCTION`. Both may be the same Edge Function SOURCE deployed twice (Supabase supports deploying one function under two different slugs/environments) — an operational/deployment-configuration decision, not a second code path to maintain.

### 12.5 — Rollout, secret installation, rotation, rollback

1. Install all four new secrets (`FLUTTERWAVE_SANDBOX_*`, `FLUTTERWAVE_PRODUCTION_*`) via `supabase secrets set`, populated from the SAME values the existing single `FLUTTERWAVE_SECRET_KEY`/`FLUTTERWAVE_WEBHOOK_SECRET` currently hold for whichever environment `FLUTTERWAVE_ENVIRONMENT` currently names, plus the OTHER environment's real credentials (obtained from Flutterwave's dashboard for that environment) — both pairs installed before any code change deploys, so nothing is ever mid-migration with only one pair present.
2. Deploy the corrected adapter/routing/webhook code (§12.2–§12.4) — reads only the four new names; the old three names become unused by the new code but are NOT yet deleted (rollback safety).
3. Configure Flutterwave's dashboard webhook URLs for both environments to point at the two `commercial-payment-webhook` deployment targets.
4. Confirm via staging/production smoke tests (`ACCEPTANCE_MATRIX.md` §9) that a sandbox checkout resolves/reconciles via the sandbox pair and a production one via the production pair.
5. Remove the three old secret names only after step 4 is confirmed — never before, since removing them earlier while any code path still reads them (a rollback scenario) would break that rollback.

**Rollback:** revert the Edge Function deploys (step 2) to the pre-Blocker-5 single-adapter code, which still reads the three old names — since those were never deleted until step 5, rollback requires no credential regeneration, only a code revert. If rollback happens after step 5 (old names already removed), the three old secrets must be re-installed from the same source values before the reverted code can run — documented as the one rollback path with an extra step, not silently assumed always trivial.

**Correction to §7.4's "Sandbox/production mismatch" row:** the prior wording ("`commercial-payment-reconcile` selects the Flutterwave adapter instance matching the CLAIMED intent's own `provider_environment`") is now literally implementable — `getFlutterwaveAdapter(claimedIntent.intent.provider_environment)` — because §12.2 makes "the Flutterwave adapter instance" a real, environment-parameterized thing to select between, not a single instance with nothing to distinguish. If the required environment's secrets were deliberately removed (post-transition, step 5 above) while a historical intent from that environment still awaits reconciliation, `getFlutterwaveAdapter` throws — reconciliation for that specific claimed row fails closed with a clear `PROVIDER_CREDENTIALS_UNAVAILABLE_FOR_ENVIRONMENT` evidence row (a new, additive `payment_reconciliation_attempts.result` value), never silently falling back to the other environment's credentials.
