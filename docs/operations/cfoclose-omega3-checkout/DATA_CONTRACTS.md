# Ω3-CHECKOUT — Data Contracts

Design document. SQL/TypeScript blocks marked **CURRENT** are verbatim quotations of live source (file:line given). Blocks marked **PROPOSED** are design only — not applied anywhere.

## 1. `resolve_commercial_offer` — current vs. proposed

**CURRENT** (`supabase/migrations/20260906083524_eca6c272-4a62-4468-995b-1c70e2cd67e5.sql`):
```sql
CREATE OR REPLACE FUNCTION public.resolve_commercial_offer(
  p_plan_code TEXT,
  p_market_code TEXT DEFAULT 'GLOBAL'
) RETURNS JSONB ...
```
Counts currently-effective purchasable offers for `(plan, market)` only — no interval discriminant. Two live offers (MONTHLY + ANNUAL) for the same plan/market/currency → `v_count > 1` → `AMBIGUOUS`.

**PROPOSED** (interval becomes required, no default; see `COMMERCIAL_ARCHITECTURE_AUDIT.md` §4 for the rationale):
```sql
CREATE OR REPLACE FUNCTION public.resolve_commercial_offer(
  p_plan_code TEXT,
  p_market_code TEXT DEFAULT 'GLOBAL',
  p_billing_interval TEXT   -- NOT NULL, no default: every caller must state intent explicitly
) RETURNS JSONB ...
```
Filter clause gains `AND billing_interval = p_billing_interval` alongside the existing plan/market/purchasable/effective-date predicates. `AMBIGUOUS` becomes reachable only if two purchasable offers exist for the identical 5-column family within an overlapping effective range — a state the Ω3.0 constraints (audit §5) already prevent at the storage layer, so in practice `AMBIGUOUS` becomes a pure defense-in-depth signal, not routine behavior.

Response shape gains no new field (interval is already echoed back via `billing_interval`/`billing_interval_count` on `AVAILABLE`); the *request* shape changes — every caller must now state which interval it means.

**PROPOSED, new, separate function** (for the legitimate interval-independent read need):
```sql
CREATE OR REPLACE FUNCTION public.list_purchasable_commercial_offers(
  p_plan_code TEXT,
  p_market_code TEXT DEFAULT 'GLOBAL'
) RETURNS SETOF JSONB
LANGUAGE sql STABLE
AS $$
  SELECT jsonb_build_object(
    'offer_id', id, 'offer_code', offer_code, 'billing_interval', billing_interval,
    'billing_interval_count', billing_interval_count, 'currency_code', currency_code,
    'amount_minor', amount_minor, 'currency_exponent', currency_exponent
  )
  FROM public.commercial_offers
  WHERE plan_id = (SELECT id FROM public.commercial_plans WHERE code = p_plan_code)
    AND market_code = p_market_code
    AND is_purchasable
    AND now() <@ effective_range
$$;
GRANT EXECUTE ON FUNCTION public.list_purchasable_commercial_offers(TEXT, TEXT) TO anon, authenticated;
```
No `AVAILABLE`/`AMBIGUOUS`/`NOT_AVAILABLE`/`UNKNOWN` discriminant — a plain list. Checkout code must never call this to resolve a chargeable offer; it exists solely for "what could I buy" display use cases (e.g. a future Pricing page rendering both prices from one call instead of two).

## 2. `commercial-create-checkout` request/response — current vs. proposed

**CURRENT** (`supabase/functions/commercial-create-checkout/index.ts`):
```ts
// request body
{ planCode: string, marketCode?: string }
// calls
supabase.rpc('resolve_commercial_offer', { p_plan_code: planCode, p_market_code: marketCode })
```

**PROPOSED:**
```ts
// request body
{ planCode: string, marketCode?: string, billingInterval: 'MONTHLY' | 'ANNUAL' }
// calls
supabase.rpc('resolve_commercial_offer', {
  p_plan_code: planCode,
  p_market_code: marketCode,
  p_billing_interval: billingInterval,
})
```
`billingInterval` is a new **required** field on the request body. A missing/invalid value fails with a 400 `INVALID_BILLING_INTERVAL` before any offer resolution — the function must not default it, exactly mirroring the resolver's own new required-parameter contract (a defaulted Edge Function param feeding a required SQL param would just move the ambiguity one layer up, not remove it).

## 3. `CheckoutUpgradeButton` prop contract — current vs. proposed

**CURRENT** (`src/components/commercial/CheckoutUpgradeButton.tsx`):
```ts
interface Props {
  billingStatus: LicenceStatus | null;
  currentPlanCode?: string | null;
  planCode?: string;
  marketCode?: string;
}
```
Single resolve call: `callCommercialRpc("resolve_commercial_offer", { p_plan_code: planCode, p_market_code: marketCode })`.

**PROPOSED:**
```ts
interface Props {
  billingStatus: LicenceStatus | null;
  currentPlanCode?: string | null;
  planCode?: string;
  marketCode?: string;
  billingInterval: "MONTHLY" | "ANNUAL";   // new, required — no default, mirrors the server contract
}
```
Both call sites (display resolve + `createCheckoutIntent`) thread the identical `billingInterval` value, exactly as `marketCode` is threaded today (the existing `DISPLAY_MARKET == CHECKOUT_MARKET` invariant, proven by `marketPropagation.test.ts`, gains a `DISPLAY_INTERVAL == CHECKOUT_INTERVAL` sibling and should be proven the same way — see `ACCEPTANCE_MATRIX.md`).

Where does `billingInterval` come from at the call site? `Pricing.tsx` already holds interval as local `useState<BillingInterval>` (`"monthly" | "annual"`, lowercase, presentation-only today) — the implementation slice threads this state (mapped to the uppercase `"MONTHLY"|"ANNUAL"` server vocabulary) into a `CheckoutUpgradeButton` instance once checkout is enabled there. `Settings.tsx`'s own current use of `CheckoutUpgradeButton` (if any interval-agnostic instance exists) must be updated to pass an explicit interval, never a hardcoded one — see `IMPLEMENTATION_PLAN.md` §2 for the exact call-site list.

## 4. `createCheckoutIntent` client helper — current vs. proposed

**CURRENT** (`src/lib/commercial/commercialRpc.ts:155-177`):
```ts
export async function createCheckoutIntent(
  planCode: string,
  marketCode?: string,
): Promise<{ data: CheckoutIntentResponse | null; error: string | null }> { ... body: JSON.stringify({ planCode, marketCode }) ... }
```

**PROPOSED:**
```ts
export async function createCheckoutIntent(
  planCode: string,
  billingInterval: "MONTHLY" | "ANNUAL",
  marketCode?: string,
): Promise<{ data: CheckoutIntentResponse | null; error: string | null }> { ... body: JSON.stringify({ planCode, marketCode, billingInterval }) ... }
```
`CheckoutIntentResponse` itself is unchanged (`saffReference`, `checkoutUrl`, `expiresAt`, `provider`) — interval is not something the browser needs echoed back; it already knows what it asked for, and the authoritative record lives in `payment_checkout_intents`.

## 5. Offer-family identity (unchanged concept, restated for this design)

A "family" is the 5-column tuple `(plan_id, market_code, currency_code, billing_interval, billing_interval_count)` — the key both `uq_co_current_offer` and `excl_co_no_overlapping_purchasable_periods` are built on as of Ω3.0. The two new USD offers this design will seed (see `IMPLEMENTATION_PLAN.md` §3) are two *distinct* families:

| offer_code (proposed) | plan | market | currency | interval | interval_count | amount_minor | exponent |
|---|---|---|---|---|---|---|---|
| `CFOCLOSE-PAID-GLOBAL-USD-MONTHLY` | PAID | GLOBAL | USD | MONTHLY | 1 | 4900 | 2 |
| `CFOCLOSE-PAID-GLOBAL-USD-ANNUAL` | PAID | GLOBAL | USD | ANNUAL | 1 | 49900 | 2 |

These do not collide with each other (different `billing_interval`) or with the existing TZS sandbox rows (different `currency_code`, different `market_code` for one of them).

## 6. Concurrency guard for checkout intents (see `THREAT_AND_FAILURE_MODEL.md` for the scenario analysis; contract shape only here)

**PROPOSED** — `commercial-create-checkout` gains a pre-insert check, not a new hard constraint:
```ts
// Before creating a new intent, look for an existing open one for the same
// (billing_customer_id, commercial_offer_id) pair:
const { data: existing } = await supabase
  .from('payment_checkout_intents')
  .select('*')
  .eq('billing_customer_id', billingCustomerId)
  .eq('commercial_offer_id', offer.offer_id)
  .in('status', ['CREATED', 'PENDING'])
  .gt('expires_at', new Date().toISOString())
  .maybeSingle();

if (existing) {
  // Re-issue the SAME checkout — do not create a second concurrent intent,
  // and do not error the customer out of a legitimate double-click/retry.
  return existingCheckoutResponse(existing);
}
```
This is a **reuse**, not a **rejection** — the alternative (a hard partial unique index on `payment_checkout_intents(billing_customer_id) WHERE status IN ('CREATED','PENDING')`) would 409 a legitimate retry (e.g. the customer's first tab is still open, they open a second) instead of handing them back the same checkout link, which is the better user-facing behavior and still closes plan.md's finding #7. See `IMPLEMENTATION_PLAN.md` §2 for why this is application-level logic, not a migration.
