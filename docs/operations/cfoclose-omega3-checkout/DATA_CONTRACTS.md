# Ω3-CHECKOUT — Data Contracts

Design document. SQL/TypeScript blocks marked **CURRENT** are verbatim quotations of live source (file:line given). Blocks marked **PROPOSED** are design only — not applied anywhere.

**Design-correction round (this revision):** every block below was re-derived after independent review found the first draft's resolver signature was invalid Postgres, the concurrency design was not database-atomic, the commit design locked at the wrong granularity, and the checkout contract leaked a client-supplied market. Fixed in place; nothing here has been applied to source.

## 1. `resolve_commercial_offer` — current vs. corrected proposal

**CURRENT** (`supabase/migrations/20260906083524_eca6c272-4a62-4468-995b-1c70e2cd67e5.sql:100-102`):
```sql
CREATE OR REPLACE FUNCTION public.resolve_commercial_offer(
  p_plan_code   TEXT,
  p_market_code TEXT DEFAULT 'GLOBAL'
) RETURNS JSONB ...
```
Two confirmed defects beyond the missing interval discriminant (already known from the prior round):
1. **No product scoping.** Line 117: `SELECT id INTO v_plan_id FROM public.commercial_plans WHERE code = p_plan_code AND is_active;` — but `commercial_plans`' own uniqueness constraint is `UNIQUE (product_id, code)` (`20260905093408...sql:68`), not `UNIQUE (code)` alone. `code` is only unique **within** a product. Today there is exactly one product (`commercial_products.code = 'SAFF_ERP'`, seeded at `:312`), so this happens to be safe by accident, not by design — a second product with its own `'PAID'` plan code would make this `SELECT INTO` non-deterministic (Postgres does not raise on multiple matches for a bare `SELECT ... INTO` without `STRICT`; it silently picks one, unordered). The correct precedent already exists in this same migration: `admin_grant_commercial_licence` (`:573-580`) resolves `v_product_id` from `billing_customers.product_id` first, then scopes the plan lookup to it. `resolve_commercial_offer` and `admin_upsert_commercial_offer` (`:215`, same defect) never adopted that pattern.
2. **The prior design-correction draft of this function was invalid Postgres.** It proposed `resolve_commercial_offer(p_plan_code TEXT, p_market_code TEXT DEFAULT 'GLOBAL', p_billing_interval TEXT)` — a required parameter (`p_billing_interval`, no default) declared *after* a defaulted one (`p_market_code`). Postgres rejects this at `CREATE FUNCTION` time: once a parameter has a `DEFAULT`, every parameter after it must also have one. It also used `TEXT NOT NULL` as a parameter-type annotation in the draft's prose — `NOT NULL` is not valid syntax in a `CREATE FUNCTION` parameter list at all (it is not silently ignored; it is a parse error). Both are corrected below.

**PROPOSED — corrected signature:**
```sql
CREATE OR REPLACE FUNCTION public.resolve_commercial_offer(
  p_plan_code        TEXT,
  p_billing_interval TEXT,                    -- required: no default. Ordered before p_market_code
                                                -- so no required parameter follows a defaulted one.
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
  -- Explicit NULL/invalid-value handling in the BODY, never via a NOT NULL
  -- parameter annotation (invalid syntax) and never via a silent default.
  IF p_billing_interval IS NULL OR p_billing_interval NOT IN ('MONTHLY', 'ANNUAL') THEN
    RETURN jsonb_build_object('resolution', 'UNKNOWN', 'reason', 'UNKNOWN_OR_MISSING_BILLING_INTERVAL');
  END IF;

  IF p_market_code IS NULL OR p_market_code NOT IN ('GLOBAL','TZ','MU','GB','EU') THEN
    RETURN jsonb_build_object('resolution','UNKNOWN','reason','UNKNOWN_MARKET_CODE');
  END IF;

  -- Product binding (closes the cross-product ambiguity defect, item 3):
  -- resolved from the CALLING USER's own billing_customer row when one
  -- exists (authenticated path); the caller never supplies a product
  -- identifier directly. An anonymous/pre-signup caller (public /pricing)
  -- has no billing_customer yet, so falls back to this deployment's single
  -- default product via commercial_default_product_code() (a tiny SECURITY
  -- DEFINER STABLE helper reading a single-row config table — NOT a second
  -- guess mechanism; see the deployment-config note below). This mirrors
  -- admin_grant_commercial_licence's already-established
  -- billing_customers.product_id-first pattern.
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
    RETURN jsonb_build_object('resolution','NOT_AVAILABLE','plan_code',p_plan_code,'billing_interval',p_billing_interval,'requested_market',p_market_code);
  END IF;
  IF v_count > 1 THEN
    RETURN jsonb_build_object('resolution','AMBIGUOUS','plan_code',p_plan_code,'billing_interval',p_billing_interval,'market_code',v_used_market);
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
    'resolution','AVAILABLE','offer_id',v_offer.id,'offer_code',v_offer.offer_code,
    'plan_code',p_plan_code,'market_code',v_offer.market_code,'requested_market',p_market_code,
    'fallback_to_global',(v_used_market = 'GLOBAL' AND p_market_code != 'GLOBAL'),
    'currency_code',v_offer.currency_code,'amount_minor',v_offer.amount_minor,
    'currency_exponent',v_offer.currency_exponent,'billing_interval',v_offer.billing_interval,
    'billing_interval_count',v_offer.billing_interval_count,'provider_restriction',v_offer.provider_restriction
  );
END;
$$;
```

**Overload/replacement hazard (item 1, "a changed argument list creates an overload"):** `CREATE OR REPLACE FUNCTION` matches on the **exact parameter type list**. `resolve_commercial_offer(TEXT, TEXT)` (2 args) and `resolve_commercial_offer(TEXT, TEXT, TEXT)` (3 args, corrected order above) are two **distinct** entries in `pg_proc` — deploying the migration above does not replace the old function, it adds a second, overloaded one. The old 2-arg version remains callable (still `GRANT EXECUTE ... TO anon, authenticated` from Ω2-G) and still exhibits the unscoped, interval-blind, non-product-scoped behavior this whole design exists to close. **Explicit REVOKE/DROP treatment, required in the same or a tightly-sequenced follow-up migration:**
```sql
REVOKE ALL ON FUNCTION public.resolve_commercial_offer(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
DROP FUNCTION public.resolve_commercial_offer(TEXT, TEXT);
```

**Safe migration/Edge-Function deployment order (item 1's final requirement) — two phases, not one atomic swap:**
1. **Phase A (schema):** deploy the migration that (a) creates the new 3-arg `resolve_commercial_offer(TEXT, TEXT, TEXT)` alongside the still-live 2-arg version, and (b) creates `commercial_default_product_id()`. At this point both overloads exist; nothing yet calls the new one, so behavior is unchanged for every live caller.
2. **Phase B (application):** deploy the updated `commercial-create-checkout` Edge Function (§2 below) and the updated frontend (`CheckoutUpgradeButton`, §3) that call the new 3-arg overload exclusively. Confirm via Edge Function logs / a staging smoke test that no caller invokes the 2-arg overload anymore — the only caller of either overload in this entire repository is `commercial-create-checkout` (confirmed by repository-wide search in the prior audit round), so this confirmation is a single-function check, not a fleet-wide migration.
3. **Phase C (cleanup, separate migration, deployed only after Phase B is confirmed live and stable):** `REVOKE`+`DROP` the 2-arg overload as shown above. This is deliberately a **separate**, later migration file — collapsing B and C into one deployment would risk a window where the Edge Function has already redeployed calling 3 args while the DROP has not yet landed (harmless, both exist) **or**, worse, the DROP lands before the Edge Function redeploy completes (the Edge Function's in-flight 2-arg calls would start failing with "function does not exist" until its own redeploy finishes) — sequencing the DROP strictly after Phase B's confirmed rollout removes this window entirely.

**`commercial_default_product_id()` — new, minimal helper (not a second guessing mechanism):**
```sql
CREATE OR REPLACE FUNCTION public.commercial_default_product_id()
RETURNS UUID LANGUAGE sql STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT id FROM public.commercial_products WHERE code = 'SAFF_ERP' LIMIT 1;
$$;
```
This reuses the exact same hardcoded `'SAFF_ERP'` lookup `provision_billing_customer_for_company` already performs today (`20260905093408...sql:897`) — it introduces no new default-selection logic, it only names the existing one so `resolve_commercial_offer` and any future anonymous-caller code path can share it instead of re-deriving it ad hoc. **Separately flagged, not addressed by this design pass:** the product code value itself, `'SAFF_ERP'`, is a stale SAFF-era literal — the same class of finding as the Flutterwave branding issue (§9), but renaming a `commercial_products.code` value touches a UNIQUE-constrained column referenced by `commercial_plans.product_id` FK joins throughout Ω1/Ω2-G/Ω3.0 and `billing_customers` rows already provisioned against it in production. This is real but explicitly **out of scope for Ω3-CHECKOUT** — tracked as a future, separately-audited rename operation, not silently bundled here.

**Removed from this design entirely (item 9):** the prior draft's proposed `list_purchasable_commercial_offers()` read-only listing function is **withdrawn**. No caller was ever proven for it in the current codebase or in this design's own implementation slice — it was speculative "might be useful for a future admin view" scope creep, and Step 10's own discipline ("do not broaden scope") applies to functions as much as to files. If a genuine interval-independent listing need materializes later, it gets its own design pass with its own proven caller.

## 2. `commercial-create-checkout` request/response — corrected

**CURRENT** (`supabase/functions/commercial-create-checkout/index.ts`):
```ts
// request body
{ planCode: string, marketCode?: string }
```

**PROPOSED — corrected (item 2: market removed from the browser contract entirely):**
```ts
// request body — exactly these two fields, nothing else
{ planCode: string, billingInterval: 'MONTHLY' | 'ANNUAL' }
```
`marketCode` is **removed**, not made optional-and-ignored. For this launch, market is server-owned and fixed at `'GLOBAL'` — never inferred from `Accept-Language`, `CF-IPCountry` or any other geolocation header, the customer's billing currency, or the company's accounting jurisdiction (this prohibition already existed in the prior draft and is unchanged; what changes is that it is no longer even an *input the browser can attempt to influence* — the field does not exist in the request schema at all). The Edge Function calls:
```ts
supabase.rpc('resolve_commercial_offer', {
  p_plan_code: planCode,
  p_billing_interval: billingInterval,
  p_market_code: 'GLOBAL',   // literal, server-side constant — not read from the request body
})
```
**Future scope, explicitly deferred, not designed here:** a persisted, admin-controlled per-customer market (e.g. a `billing_customers.market_code` column, settable only by `admin_billing_lookup`/a future admin tool, never by the customer or by client-side inference) is a legitimate later need — e.g. once a GB/EU Stripe path exists and a customer's market genuinely differs from GLOBAL. That is new schema and new admin tooling; it is not part of Ω3-CHECKOUT and must not be conflated with removing `marketCode` from the browser contract now.

**Platform-state gate (item 4) — new, first check in the function body, before offer resolution:**
```ts
const { data: platformState, error: platformStateErr } = await supabaseService
  .from('commercial_platform_state')
  .select('state')
  .eq('id', true)
  .maybeSingle();

// Fail closed on ANY of: missing row, query error, or a value outside the
// 4-value vocabulary the Ω3.0 CHECK constraint already enforces at the DB
// level — this is defense in depth, not redundant, because an Edge
// Function-level bug (a typo'd column name, a stale generated type) must
// never silently treat "I couldn't read the gate" as "proceed".
const KNOWN_STATES = ['PAYMENTS_DISABLED', 'SANDBOX_ONLY', 'LIVE_ACCEPTANCE', 'CUSTOMER_PAYMENTS_ENABLED'];
if (platformStateErr || !platformState || !KNOWN_STATES.includes(platformState.state)) {
  return json(503, { error: 'PAYMENTS_UNAVAILABLE', correlationId });
}

const state = platformState.state;
if (state === 'PAYMENTS_DISABLED') {
  return json(503, { error: 'PAYMENTS_DISABLED', correlationId });
}

// Provider-environment / caller-identity matrix (rest of item 4):
const provider = getConfiguredProviders()[0]; // existing selection logic, unchanged
const providerIsSandbox = provider?.environment === 'sandbox';

if (state === 'SANDBOX_ONLY') {
  if (!providerIsSandbox) {
    // Fail closed: a SANDBOX_ONLY platform state must never route through a
    // production-configured provider, regardless of which secrets happen
    // to be present in this deployment.
    return json(503, { error: 'PROVIDER_ENVIRONMENT_MISMATCH', correlationId });
  }
  if (!isRestrictedAcceptanceIdentity(user)) {
    // "Restricted acceptance identities" = an explicit allowlist of
    // internal/QA user ids or a commercial-admin flag — SANDBOX_ONLY exists
    // to let the team exercise the real path before any real customer can,
    // so an ordinary authenticated customer must still be rejected here.
    return json(403, { error: 'SANDBOX_RESTRICTED', correlationId });
  }
}

if (state === 'LIVE_ACCEPTANCE') {
  if (providerIsSandbox) {
    return json(503, { error: 'PROVIDER_ENVIRONMENT_MISMATCH', correlationId });
  }
  if (!isRestrictedAcceptanceIdentity(user)) {
    return json(403, { error: 'LIVE_ACCEPTANCE_RESTRICTED', correlationId });
  }
}

if (state === 'CUSTOMER_PAYMENTS_ENABLED') {
  if (providerIsSandbox) {
    return json(503, { error: 'PROVIDER_ENVIRONMENT_MISMATCH', correlationId });
  }
  // Normal authenticated customers — no additional restriction beyond the
  // existing validateAuth() check already performed earlier.
}
```
`isRestrictedAcceptanceIdentity(user)` is new, narrowly-scoped code: a check against either a small hardcoded allowlist of internal user ids (staging-only, never shipped to a customer-facing production build) or, more durably, `is_commercial_admin()` reused as-is (an admin can exercise SANDBOX_ONLY/LIVE_ACCEPTANCE flows without a separate allowlist table) — exact mechanism is an implementation-time decision, not a schema change; both options reuse existing primitives.

**Product binding (item 3) — inside `resolve_commercial_offer` itself (§1 above), not duplicated in the Edge Function.** The Edge Function does not need its own product lookup because the RPC already derives `v_product_id` from the authenticated caller's `billing_customers` row.

## 3. `CheckoutUpgradeButton` prop contract — corrected

**PROPOSED (supersedes the prior round's `marketCode` + `billingInterval` combined proposal):**
```ts
interface Props {
  billingStatus: LicenceStatus | null;
  currentPlanCode?: string | null;
  planCode?: string;
  billingInterval: "MONTHLY" | "ANNUAL";   // required — no default
  // marketCode REMOVED. Market is server-owned GLOBAL for this launch;
  // there is no client-facing concept of market to propagate.
}
```
Both call sites (display `resolve_commercial_offer` call + `createCheckoutIntent`) thread only `planCode` and `billingInterval` — the existing `DISPLAY_MARKET == CHECKOUT_MARKET` invariant and its test (`marketPropagation.test.ts`) are retired along with the prop; a new `DISPLAY_INTERVAL == CHECKOUT_INTERVAL` static guard replaces it (`ACCEPTANCE_MATRIX.md` item 13).

## 4. `createCheckoutIntent` client helper — corrected

**PROPOSED:**
```ts
export async function createCheckoutIntent(
  planCode: string,
  billingInterval: "MONTHLY" | "ANNUAL",
): Promise<{ data: CheckoutIntentResponse | null; error: string | null }> {
  ...
  body: JSON.stringify({ planCode, billingInterval })
  ...
}
```
No `marketCode` parameter at all — removed, not defaulted.

## 5. Offer-family identity and seeding — corrected for non-purchasable initial state (item 12)

| offer_code (proposed) | plan | market | currency | interval | interval_count | amount_minor | exponent | **is_purchasable at seed** |
|---|---|---|---|---|---|---|---|---|
| `CFOCLOSE-PAID-GLOBAL-USD-MONTHLY` | PAID | GLOBAL | USD | MONTHLY | 1 | 4900 | 2 | **false** |
| `CFOCLOSE-PAID-GLOBAL-USD-ANNUAL` | PAID | GLOBAL | USD | ANNUAL | 1 | 49900 | 2 | **false** |

Both rows are created via `admin_upsert_commercial_offer(..., p_is_active := true, p_is_purchasable := false, p_reason := 'Ω3-CHECKOUT: seed non-purchasable USD offers pending staging acceptance')`. `is_active = true` so the row is a real, addressable catalogue entry (visible to admin tooling, subject to the Ω3.0 economic-integrity trigger's post-creation immutability of price/currency/interval fields immediately), but `is_purchasable = false` means `resolve_commercial_offer` returns `NOT_AVAILABLE` for both — checkout cannot be reached even if every other piece of this design were somehow deployed early or out of order. **Activation is a separate, later, explicitly audited operation**: `admin_supersede_commercial_offer` (or a narrower future `admin_set_offer_purchasable`) flips `is_purchasable` to `true` only after every staging acceptance gate in `ACCEPTANCE_MATRIX.md` passes, and only alongside advancing `commercial_platform_state` out of `PAYMENTS_DISABLED`. Creating the rows and activating them are two different admin actions, on two different days if needed, each independently reversible and each independently audited via `commercial_catalog_audit_events`.

## 6. Checkout-intent concurrency — corrected to an atomic, database-enforced design (item 5)

**Rejected: the prior round's `SELECT` (in the Edge Function) `then INSERT`.** That is a classic check-then-act race with no atomicity — two near-simultaneous requests can both pass the `SELECT ... maybeSingle()` reuse check (finding nothing) before either has inserted, and both proceed to `INSERT`, defeating the entire point. It also could not express "what does *stale* mean" deterministically, could not distinguish CREATED-without-a-provider-URL from a genuinely reusable PENDING intent, and had no defined recovery if the process crashed between calling Flutterwave and writing the row.

**PROPOSED — a single atomic RPC, `acquire_or_reuse_checkout_intent`, called from `commercial-create-checkout` in place of a raw `INSERT`:**
```sql
CREATE OR REPLACE FUNCTION public.acquire_or_reuse_checkout_intent(
  p_billing_customer_id UUID,
  p_offer_id            UUID,
  p_expected_amount_minor BIGINT,
  p_currency_code       TEXT,
  p_currency_exponent   SMALLINT,
  p_billing_interval    TEXT,
  p_billing_interval_count SMALLINT,
  p_saff_reference      TEXT,          -- pre-generated by the caller (see §9 for the CFOCLOSE- prefix)
  p_ttl_minutes         INTEGER DEFAULT 60
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_lock_key BIGINT := hashtextextended(p_billing_customer_id::text || ':' || p_offer_id::text, 0);
  v_existing RECORD;
BEGIN
  -- Serialize per (billing_customer, offer): a transaction-scoped advisory
  -- lock, released automatically at COMMIT/ROLLBACK, on a key derived from
  -- the exact pair this function must serialize on. Two concurrent calls
  -- for the SAME customer+offer block here in strict sequence; calls for
  -- DIFFERENT customers or DIFFERENT offers never contend.
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Deterministic staleness: expire, inline, any CREATED/PENDING intent for
  -- this customer+offer whose expires_at has already passed, before doing
  -- anything else. This is the ONLY place intents transition to EXPIRED for
  -- this reason, so "deterministic" means exactly this function's own
  -- comparison against now(), not a separate cron job's clock.
  UPDATE public.payment_checkout_intents
     SET status = 'EXPIRED'
   WHERE billing_customer_id = p_billing_customer_id
     AND commercial_offer_id = p_offer_id
     AND status IN ('CREATED','PENDING')
     AND expires_at <= now();

  -- Look for a still-live, REUSABLE intent: CREATED/PENDING, not expired,
  -- AND carrying a usable checkout_url. A CREATED-without-URL row (the
  -- crash-recovery case below) is deliberately NOT reusable — handing the
  -- browser a stale/empty URL is worse than creating a fresh row.
  SELECT * INTO v_existing
    FROM public.payment_checkout_intents
   WHERE billing_customer_id = p_billing_customer_id
     AND commercial_offer_id = p_offer_id
     AND status IN ('CREATED','PENDING')
     AND expires_at > now()
     AND checkout_url IS NOT NULL
   ORDER BY created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'acquired', 'REUSED', 'intent_id', v_existing.id,
      'saff_reference', v_existing.saff_reference, 'checkout_url', v_existing.checkout_url,
      'expires_at', v_existing.expires_at
    );
  END IF;

  -- No reusable intent: also check for a CREATED-without-URL row (a prior
  -- attempt that crashed between this function's own INSERT below and the
  -- provider call that would have set checkout_url — see the two-step
  -- protocol note beneath this function). Such a row is superseded, not
  -- reused, because its provider-side checkout session (if the crash
  -- happened AFTER Flutterwave created one) cannot be safely re-presented
  -- without re-verifying it — simpler and safe: mark it FAILED and proceed
  -- to create a fresh row.
  UPDATE public.payment_checkout_intents
     SET status = 'FAILED'
   WHERE billing_customer_id = p_billing_customer_id
     AND commercial_offer_id = p_offer_id
     AND status IN ('CREATED','PENDING')
     AND expires_at > now()
     AND checkout_url IS NULL;

  -- Insert the new intent WITHOUT a checkout_url yet (status CREATED). The
  -- calling Edge Function commits this row, THEN calls the provider, THEN
  -- writes the returned URL via a second, narrow UPDATE (below) — never a
  -- single combined "create intent with URL" step. This is what makes the
  -- crash-between-provider-creation-and-persistence case (item 5's own
  -- requirement) recoverable: if the process dies after the provider call
  -- succeeds but before the UPDATE lands, the row is left CREATED/NULL-url,
  -- which the block above will safely supersede on the next attempt rather
  -- than serve a URL nobody ever recorded.
  INSERT INTO public.payment_checkout_intents (
    billing_customer_id, commercial_offer_id, expected_amount_minor, currency_code,
    currency_exponent, billing_interval, billing_interval_count, saff_reference,
    status, expires_at
  ) VALUES (
    p_billing_customer_id, p_offer_id, p_expected_amount_minor, p_currency_code,
    p_currency_exponent, p_billing_interval, p_billing_interval_count, p_saff_reference,
    'CREATED', now() + make_interval(mins => p_ttl_minutes)
  )
  RETURNING id INTO v_existing;   -- reusing v_existing as a scratch RECORD for the new id only

  RETURN jsonb_build_object('acquired', 'NEW', 'intent_id', (v_existing).id);
END;
$$;
```
**Two-step Edge Function protocol this RPC requires** (replaces the old single-`INSERT`-then-`createCheckout` sequence):
1. Call `acquire_or_reuse_checkout_intent(...)`. If `acquired = 'REUSED'`, return its `checkout_url` immediately — no provider call, no customer-visible 409, a legitimate double-click or retry gets back the exact link it would have gotten the first time.
2. If `acquired = 'NEW'`, call `adapter.createCheckout(...)` with the new `intent_id`'s already-committed economics. On success, run a narrow, single-purpose `UPDATE public.payment_checkout_intents SET checkout_url = $1, status = 'PENDING' WHERE id = $2 AND status = 'CREATED'` (the `AND status = 'CREATED'` guard means this UPDATE is a no-op, not an error, if something else already superseded the row — e.g. a concurrent retry's staleness sweep). On provider failure, `UPDATE ... SET status = 'FAILED' WHERE id = $2 AND status = 'CREATED'`.

**Why an advisory lock and not a hard partial unique index:** a unique index on `(billing_customer_id, commercial_offer_id) WHERE status IN ('CREATED','PENDING')` would need to be checked-and-caught via `ON CONFLICT`, which cannot express "return the *other* row's data on conflict" without a second `SELECT` anyway (Postgres `ON CONFLICT DO UPDATE ... RETURNING` returns the row as it now stands, not cleanly distinguishing "I created this" from "I collided with an existing one" for the caller's benefit) — the advisory lock plus explicit `SELECT ... FOR UPDATE` inside one transaction gives full, readable control over exactly which case (`REUSED` vs `NEW`) occurred, which the atomic function above surfaces directly to the caller instead of making it re-derive that fact from a second query.

## 7. Payment-commit design — corrected to customer-level serialization (item 6)

**Defect in the prior round:** `commit_verified_commercial_payment` was listed as **MUST NOT CHANGE** in the prior `IMPLEMENTATION_PLAN.md`, on the reasoning that its existing `SELECT ... FOR UPDATE` on the **intent** row was sufficient. It is sufficient for "two webhook deliveries for the *same* intent" (Threat Model scenario 4/6/7) but **not** for scenario 8 — two *different*, both-successful intents for the *same customer* (e.g. MONTHLY paid, then ANNUAL paid, racing) — because each commit only locks its own intent row; two different intents can be locked and processed **concurrently** by two different transactions, both reading `commercial_licences`' current row *before either has written it*, and both then racing to close it out and insert their own new period. The GiST EXCLUDE constraint (`excl_cl_no_overlapping_authoritative_periods`) is the last-resort safety net that would catch an actual overlapping-period conflict — but "caught by an exclusion constraint" means the second transaction's `INSERT` throws, and **the prior design never specified what happens to a provider charge that has already been verified as SUCCEEDED when its licence-side commit throws** — that is exactly the "silently discarded charge" risk item 6 calls out.

**PROPOSED — `commit_verified_commercial_payment` gains a customer-level lock, acquired BEFORE selecting the current licence, with a re-read AFTER the lock:**
```sql
-- Inside commit_verified_commercial_payment, immediately after the existing
-- idempotency-key pre-check (unchanged — still the first thing checked) and
-- immediately after the existing SELECT ... FOR UPDATE on the intent row
-- (unchanged — still required to validate the intent's own status/amount):

v_lock_key := hashtextextended(v_intent.billing_customer_id::text || ':licence', 0);
PERFORM pg_advisory_xact_lock(v_lock_key);

-- RE-READ current licence state AFTER acquiring the lock — the existing
-- "SELECT * INTO v_current_lic FROM commercial_licences WHERE ... LIMIT 1"
-- lookup (Ω2-G) must be repeated here, not reused from before the lock,
-- because a concurrent transaction may have committed a different
-- successful intent for this same customer in the window between this
-- transaction's start and this lock acquisition.
SELECT * INTO v_current_lic FROM public.commercial_licences
 WHERE billing_customer_id = v_intent.billing_customer_id
   AND status IN ('ACTIVE','GRACE')
 ORDER BY effective_start DESC LIMIT 1
 FOR UPDATE;

-- ... existing closeout + insert logic, now provably serialized per
-- customer, continues unchanged from here ...
```
**Deterministic behavior for two paid intents (item 6's explicit requirement) — "last successful commit to acquire the customer lock wins, and nothing is ever silently discarded":** with the lock now held for the licence-mutation portion of every commit, two successful payments for the same customer commit strictly one after the other, never concurrently. The second commit to acquire the lock sees the first commit's already-closed-out licence row (via the re-read above) and proceeds normally — it closes that row and inserts its own new period, exactly as the existing single-payment closeout logic already does today. **No exclusion-constraint violation is reachable this way** (the GiST EXCLUDE constraint was only ever at risk from the *concurrent, unlocked* path this fix removes) — so "prove no provider charge can be silently discarded by a licence exclusion failure" is satisfied structurally: the failure mode that could throw is now impossible by construction, not merely caught-and-logged after the fact. The RPC's return value for the second (now-serialized, still-successful) commit remains `COMMITTED` — it is not `ALREADY_COMMITTED` (that status is reserved for the true idempotency-key replay case), because it genuinely is a new, distinct, real payment for a new, distinct period; the product/support question of "the customer meant to only buy one of these" (scenario 8's original framing) remains a support runbook concern, but the **data integrity** question item 6 asks about is now fully closed at the schema/RPC level.

This is the one item in this design package that changes a function previously marked **MUST NOT CHANGE** — moved to **MUST CHANGE** in `IMPLEMENTATION_PLAN.md`, with the change scoped narrowly to adding the lock-and-re-read, touching no other line of the function's existing amount/currency/status validation, idempotency check, or audit-row insertion.

## 8. Webhook reliability — transient vs. definitive, plus reconciliation (item 7)

**Corrected classification — Gate B (`verifyTransaction`) failures are not a single bucket:**

| Gate B outcome | Prior classification | Corrected classification |
|---|---|---|
| `REFERENCE_MISSING` / `REFERENCE_MISMATCH` / `AMOUNT_MISMATCH` / `CURRENCY_MISMATCH` / provider explicitly returns a non-SUCCEEDED status | Rejected, no commit | **Unchanged — definitive, remains rejected.** These are facts about the transaction itself, not about the verification call's own reliability; retrying does not change them. |
| Network error contacting Flutterwave's verify endpoint, a 5xx from Flutterwave, or a timeout | Previously folded into the same "VERIFICATION_FAILED, no commit" bucket as the definitive cases above | **Corrected: a distinct `VERIFICATION_TRANSIENT_FAILURE` outcome, retriable.** The webhook handler records this to `payment_webhook_processing_events` as its own enum value (extends the existing CHECK constraint's vocabulary — additive, no existing value removed) and returns a 500 to Flutterwave (not 200) specifically for this case, so Flutterwave's own webhook-retry mechanism redelivers it — the existing receipt row (already durably recorded before Gate A/B ever ran) means a redelivery is naturally idempotent via the existing `idempotency_key` mechanism once verification eventually succeeds. |

**New: deterministic reconciliation for paid-but-uncommitted transactions.** A scheduled job (design only — no implementation performed; a future `commercial-payment-reconcile` Edge Function or a `pg_cron` job calling a new `reconcile_uncommitted_checkout_intents()` RPC) that:
1. Selects every `payment_checkout_intents` row in `PENDING` status whose `expires_at` has not yet passed but which has had no corresponding `payment_events` row for longer than a defined threshold (e.g. 10 minutes) since its `created_at`.
2. For each, calls the provider's own transaction-lookup-by-reference (not by transaction id, since none may be known yet) if the adapter interface supports it, or leaves it for manual `admin_billing_lookup` review if it does not (Flutterwave's adapter today only exposes verify-by-transaction-id; extending it to a lookup-by-reference call is implementation-time work, not a schema change).
3. Never auto-commits a licence from this path directly — reconciliation feeds the **same** `commit_verified_commercial_payment` RPC through the **same** two-gate verification a genuine webhook would have used, so a transaction discovered via reconciliation is committed with identical authority guarantees, never a lesser "trust the reconciliation job" shortcut.

This closes item 7's explicit instruction not to classify webhook reliability as "already mitigated" — the *security* properties (Gates A/B, idempotency) were and remain correctly mitigated; the *reliability* property (a transient provider outage must not silently strand a genuinely-paid customer with an uncommitted licence) was not previously designed at all, and is now a named, if not-yet-implemented, mechanism.

## 9. CFOClose payment identity correction (item 11)

**CURRENT** (`supabase/functions/_shared/payments/providers/flutterwave.ts:137-156`):
```ts
const body = {
  tx_ref: params.saffReference, amount: displayAmount, currency: params.currencyCode,
  redirect_url: params.redirectUrl, payment_options: paymentOptions,
  customer: { email: params.customerEmail, name: params.customerName ?? params.customerEmail },
  customizations: {
    title: 'SAFF ERP',
    description: `Firm Licence — ${params.planName}`,
    logo: 'https://cfoclose.com/favicon.ico',
  },
  meta: { saff_reference: params.saffReference, source: 'SAFF_ERP_OMEGA2' },
};
```

**PROPOSED:**
```ts
const body = {
  tx_ref: params.saffReference, amount: displayAmount, currency: params.currencyCode,
  redirect_url: params.redirectUrl, payment_options: paymentOptions,
  customer: { email: params.customerEmail, name: params.customerName ?? params.customerEmail },
  customizations: {
    title: 'CFOClose',
    description: `Professional Licence — ${params.planName}`,
    logo: 'https://cfoclose.com/logo-payment.png',   // NEW asset — a raster (PNG) export of the
                                                       // CFOClose mark; favicon.svg is not usable
                                                       // here (Flutterwave expects a raster image).
                                                       // Prerequisite, tracked as a dependency, not
                                                       // solved by this design pass.
  },
  meta: { checkout_reference: params.saffReference, source: 'CFOCLOSE_OMEGA3' },
};
```
**New payment references use `CFOCLOSE-`, not `SAFF-` (item 11's own instruction), applied only going forward:** the `saff_reference` generator (wherever it constructs the human-readable prefix of the reference string — not the column name, see below) changes its literal prefix from whatever `SAFF-`-style value it used previously to `CFOCLOSE-`. **Historical database column names and historical references remain intact, unconditionally:** the column is named `saff_reference` in `payment_checkout_intents`/`payment_events`/`commercial_licences.source` today, and **stays named that** — renaming a column is a schema change with migration/rollback/replay implications wildly disproportionate to a cosmetic prefix fix, and every historical row's *value* (any already-issued `SAFF-...` reference) is evidence that must never be rewritten (this repository's own append-only/no-mutation discipline, applied here as much as to `payment_events`). Only **new** reference values, generated after this change ships, get the `CFOCLOSE-` prefix; old rows keep their `SAFF-...` values forever, and any code that parses/displays a reference must not assume a fixed prefix.

**Customer-facing response naming:** `CheckoutIntentResponse`'s field is named `saffReference` in `commercialRpc.ts` today — same reasoning as the column: the **field name** is an internal API contract detail, not customer-visible text, and is left unchanged to avoid a disproportionate ripple through every consumer of that type for a cosmetic win. What customers actually **see** (Flutterwave's hosted page title/description/logo, `PaymentReturn.tsx`'s copy, Settings' billing display) already reads "CFOClose"/"Professional" throughout (confirmed in the prior audit round) except for the Flutterwave payload fixed above — so this item is fully closed by the `customizations`/`meta` fix plus the forward-only reference-prefix change, without a field-rename.

**Redirect environment-variable migration, backward-compatible rollout:** if any `REDIRECT_URL`/return-URL environment variable currently encodes a SAFF-era domain or path convention (not confirmed present in this repo's Edge Function env usage as read in the prior audit round — `commercial-create-checkout` builds `redirect_url` from `params.redirectUrl`, itself passed in by the caller, not read from an env var directly in the code inspected) — **if** such a variable is found at implementation time, the migration path is: introduce the new variable name alongside the old one, have the function prefer the new name and fall back to the old one for one deploy cycle, confirm via logs that the new name is set in every environment, then remove the fallback in a follow-up change. This is the same two-phase discipline as the resolver overload deployment (§1) — never a single cutover that assumes every environment's configuration updated atomically.

## 10. Platform-state × provider-environment × acceptance-identity matrix (item 4, full contract)

| `commercial_platform_state` | Allowed provider environment | Allowed caller | Edge Function behavior on mismatch |
|---|---|---|---|
| `PAYMENTS_DISABLED` | none | none | Reject with 503 `PAYMENTS_DISABLED`, before any offer resolution |
| `SANDBOX_ONLY` | sandbox only | restricted acceptance identities only (internal/QA/`is_commercial_admin()`) | 503 `PROVIDER_ENVIRONMENT_MISMATCH` if a production provider is configured; 403 `SANDBOX_RESTRICTED` for an ordinary customer |
| `LIVE_ACCEPTANCE` | production only | restricted acceptance identities only | 503 `PROVIDER_ENVIRONMENT_MISMATCH` if a sandbox provider is configured; 403 `LIVE_ACCEPTANCE_RESTRICTED` for an ordinary customer |
| `CUSTOMER_PAYMENTS_ENABLED` | production only | any authenticated customer | 503 `PROVIDER_ENVIRONMENT_MISMATCH` if a sandbox provider is configured (fail closed rather than silently accepting real customer traffic against a sandbox key) |
| Missing row / query error / value outside the 4-value vocabulary | — | — | 503 `PAYMENTS_UNAVAILABLE` — fail closed, never "proceed as if enabled" |

This table is the literal contract `commercial-create-checkout`'s new platform-state gate (§2) implements; nothing in it is discretionary at implementation time.
