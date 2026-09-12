/**
 * commercial-create-checkout — Ω2-G Edge Function
 *
 * Creates a checkout intent server-side and returns a hosted payment URL.
 * Browser sends: { planCode: string, billingInterval: string, marketCode?: string }
 * Server resolves: the commercial offer (plan + interval + market + currency
 * + price), routes to an eligible configured provider, and creates the
 * intent.
 *
 * Browser NEVER supplies price, currency, offer identity, billing owner, or
 * entitlements. Browser may suggest a market (e.g. from a UI toggle a user
 * explicitly picked) but the server independently RESOLVES the offer via
 * resolve_commercial_offer() — it never trusts a browser-supplied amount or
 * currency, and never derives market from IP/locale.
 *
 * Ω3-CHECKOUT correction: billingInterval (MONTHLY or ANNUAL — the ONLY two
 * values the Ω3-CHECKOUT charter authorizes) is now MANDATORY from the
 * browser and is passed through, unmodified, to resolve_commercial_offer's
 * own mandatory p_billing_interval argument — never defaulted, never
 * inferred. This function also now acquires the checkout intent atomically:
 * a customer can never hold two open (CREATED/PENDING) intents against the
 * SAME resolved offer at once — a concurrent duplicate request (double-
 * click, retried POST) safely reuses the still-open intent instead of
 * creating (and potentially provider-charging) a second one.
 *
 * Iron Dome:
 *   - Authenticated only (validateAuth)
 *   - Offer resolved server-side via resolve_commercial_offer() RPC,
 *     which itself now also gates on commercial_platform_state
 *   - Provider selected server-side via selectPaymentProvider() — no
 *     fake checkout when no eligible provider is configured
 *   - No secrets in response
 *   - Returns safe { checkoutUrl, saffReference, expiresAt } only
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { validateAuth } from '../_shared/auth.ts';
import { getFlutterwaveAdapter } from '../_shared/payments/providers/flutterwave.ts';
import { generateCorrelationId } from '../_shared/correlationId.ts';
import { selectPaymentProvider, getConfiguredProviders } from '../_shared/payments/routing.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const REDIRECT_URL = Deno.env.get('SAFF_PAYMENT_REDIRECT_URL') ?? 'https://app.cfoclose.com/billing/payment/return';

// Shared CORS header set for the auth section below — the real
// _shared/auth.ts contract is validateAuth(authHeader, corsHeaders), and its
// 401 fail-closed response (constructed here, not by validateAuth itself,
// so it can carry this function's own correlationId) must carry these too.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function adapterFor(provider: string) {
  // Only one adapter exists today. Adding Stripe: add a branch here that
  // returns getStripeAdapter() — no other file in this function changes.
  if (provider === 'FLUTTERWAVE') return getFlutterwaveAdapter();
  throw new Error(`No adapter implemented for provider: ${provider}`);
}

Deno.serve(async (req: Request) => {
  const correlationId = generateCorrelationId();

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  // 1. Authenticate — derive user from JWT. Real contract (verified against
  //    _shared/auth.ts directly): validateAuth(authHeader: string | null,
  //    corsHeaders) -> { result?: { userId, email? }; error?: Response }.
  //    It never takes the Request itself — passing `req` throws inside
  //    authHeader.startsWith() and was silently caught into a bare,
  //    CORS-less 401 below, masking every real auth outcome as "Unauthorized".
  const authHeader = req.headers.get('Authorization');
  const { result: authResult, error: authError } = await validateAuth(authHeader, CORS_HEADERS);
  if (authError || !authResult) {
    return new Response(JSON.stringify({ error: 'Unauthorized', correlationId }), {
      status: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  const user = { id: authResult.userId, email: authResult.email };

  // 2. Parse request — browser supplies planCode + billingInterval + an
  //    optional market suggestion. Neither price nor currency is ever
  //    accepted here. billingInterval is the ONLY other economic-shaping
  //    input the browser may supply (Ω3-CHECKOUT trust boundary), and it
  //    is validated against the exact same two-value vocabulary the
  //    charter authorizes — never passed through unchecked.
  let planCode: string;
  let billingInterval: string;
  let marketCode: string;
  try {
    const body = await req.json();
    planCode = body.planCode;
    billingInterval = body.billingInterval;
    marketCode = typeof body.marketCode === 'string' && body.marketCode ? body.marketCode : 'GLOBAL';
    if (!planCode || typeof planCode !== 'string') throw new Error('planCode required');
    if (billingInterval !== 'MONTHLY' && billingInterval !== 'ANNUAL') {
      return new Response(JSON.stringify({ error: 'billingInterval must be MONTHLY or ANNUAL', correlationId }), { status: 400 });
    }
  } catch {
    return new Response(JSON.stringify({ error: 'planCode and billingInterval are required', correlationId }), { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // 3. Resolve the commercial offer server-side. Never trust a browser-
  //    supplied amount/currency; never derive market from IP/locale.
  //    billingInterval is passed through exactly as validated above —
  //    resolve_commercial_offer treats it as mandatory and will itself
  //    refuse an unsupported value, but this function never relies on
  //    that as its only line of defense.
  const { data: resolution, error: resolveErr } = await supabase.rpc('resolve_commercial_offer', {
    p_plan_code: planCode,
    p_billing_interval: billingInterval,
    p_market_code: marketCode,
  });

  if (resolveErr) {
    console.error('resolve_commercial_offer failed', { correlationId, error: resolveErr.message });
    return new Response(JSON.stringify({ error: 'Could not resolve a commercial offer.', correlationId }), { status: 500 });
  }

  const offer = resolution as {
    resolution: 'AVAILABLE' | 'NOT_AVAILABLE' | 'AMBIGUOUS' | 'UNKNOWN';
    offer_id?: string; plan_id?: string; market_code?: string;
    currency_code?: string; amount_minor?: number; currency_exponent?: number;
    billing_interval?: string; billing_interval_count?: number;
    provider_restriction?: string | null;
  };

  if (offer.resolution === 'UNKNOWN') {
    return new Response(JSON.stringify({ error: 'Unknown plan or market.', correlationId }), { status: 404 });
  }
  if (offer.resolution === 'NOT_AVAILABLE') {
    return new Response(JSON.stringify({
      error: 'PRODUCT_PRICING_DECISION_REQUIRED: no purchasable offer configured for this plan/market',
      correlationId,
    }), { status: 402 });
  }
  if (offer.resolution === 'AMBIGUOUS') {
    // Never silently choose between equally authoritative offers.
    console.error('Ambiguous offer resolution — refusing to guess', { correlationId, planCode, marketCode });
    return new Response(JSON.stringify({ error: 'Pricing configuration error. Please contact support.', correlationId }), { status: 500 });
  }

  // 4. Route to an eligible configured provider. No fake checkout if none.
  const providerSelection = selectPaymentProvider(
    {
      currencyCode: offer.currency_code!,
      marketCode: offer.market_code!,
      providerRestriction: offer.provider_restriction ?? null,
    },
    getConfiguredProviders(),
  );

  if (!providerSelection.selected) {
    console.error('No eligible payment provider', { correlationId, reason: providerSelection.reason, offer: offer.offer_code });
    return new Response(JSON.stringify({ error: 'PAYMENT_PROVIDER_UNAVAILABLE', correlationId }), { status: 503 });
  }
  const provider = providerSelection.provider;

  // 5. Resolve billing customer for this user
  const { data: billingCustomer, error: bcErr } = await supabase
    .from('billing_customers')
    .select('id')
    .eq('owner_user_id', user.id)
    .single();

  if (bcErr || !billingCustomer) {
    return new Response(JSON.stringify({ error: 'Billing account not found. Please contact support.', correlationId }), { status: 404 });
  }

  if (!user.email) {
    // A payment provider needs a real customer email — never fabricate one
    // (e.g. a Tanzania-flavoured placeholder domain), which would silently
    // encode a market assumption into a global checkout path.
    console.error('User has no email on record', { correlationId, userId: user.id });
    return new Response(JSON.stringify({ error: 'Your account has no email on record. Please contact support.', correlationId }), { status: 422 });
  }

  // 6. Load plan name for the provider-hosted checkout page display only
  //    (never used for price/currency — those come from the resolved offer).
  const { data: plan } = await supabase
    .from('commercial_plans')
    .select('name')
    .eq('id', offer.plan_id)
    .maybeSingle();

  // 6.5. Atomic checkout-intent acquisition — Ω3-CHECKOUT correction.
  //    A billing customer may hold at most one open (CREATED/PENDING)
  //    intent against this exact resolved offer at once (enforced by the
  //    uq_pci_one_open_intent_per_customer_offer partial unique index).
  //    Check for an already-open intent FIRST (the common, non-racing
  //    case never needs to hit the unique-constraint path at all); the
  //    genuinely concurrent case is still caught atomically below.
  const nowIso = new Date().toISOString();
  const { data: existingIntent } = await supabase
    .from('payment_checkout_intents')
    .select('id, saff_reference, expires_at, status, provider_checkout_url')
    .eq('billing_customer_id', billingCustomer.id)
    .eq('commercial_offer_id', offer.offer_id)
    .in('status', ['CREATED', 'PENDING'])
    .maybeSingle();

  if (existingIntent) {
    if (existingIntent.expires_at > nowIso) {
      if (existingIntent.status === 'PENDING' && existingIntent.provider_checkout_url) {
        // Safe reuse: the SAME checkout the customer already started for
        // this exact offer is still open — return it again rather than
        // creating (and potentially provider-charging) a second one.
        return new Response(JSON.stringify({
          saffReference: existingIntent.saff_reference,
          checkoutUrl:   existingIntent.provider_checkout_url,
          expiresAt:     existingIntent.expires_at,
          provider,
          correlationId,
        }), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }
      // status === 'CREATED': another request for this exact offer is
      // mid-flight (the provider call below hasn't completed yet). Never
      // start a second, concurrent provider-side checkout for the same
      // offer — ask the caller to retry shortly instead.
      return new Response(JSON.stringify({ error: 'CHECKOUT_ALREADY_IN_PROGRESS', correlationId }), { status: 409 });
    }
    // Expired but never resolved by the customer — self-heal so a new
    // attempt is never blocked by a stale row.
    await supabase.from('payment_checkout_intents')
      .update({ status: 'EXPIRED', completed_at: nowIso })
      .eq('id', existingIntent.id);
  }

  // 7. Generate unique SAFF reference
  const saffReference = `SAFF-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;

  // 8. Create checkout intent — snapshots the offer's economic facts NOW,
  //    so a later offer edit can never mutate this in-flight or historical
  //    checkout. A 23505 unique-constraint violation here means a
  //    concurrent request for the SAME offer won the acquisition race
  //    between our check above and this insert — that is not an error;
  //    it is exactly what the atomic index exists to catch. Re-fetch and
  //    respond the same way the pre-check above would have.
  let intent: { id: string; saff_reference: string; expires_at: string } | null = null;
  {
    const { data: insertedIntent, error: intentErr } = await supabase
      .from('payment_checkout_intents')
      .insert({
        billing_customer_id:    billingCustomer.id,
        commercial_offer_id:    offer.offer_id,
        plan_id:                offer.plan_id,
        market_code:            offer.market_code,
        expected_amount_minor:  offer.amount_minor,
        currency_code:          offer.currency_code,
        currency_exponent:      offer.currency_exponent,
        billing_interval:       offer.billing_interval,
        billing_interval_count: offer.billing_interval_count,
        provider,
        saff_reference:         saffReference,
        status:                 'CREATED',
        created_by_user_id:     user.id,
      })
      .select('id, saff_reference, expires_at')
      .single();

    if (intentErr?.code === '23505') {
      console.warn('Concurrent checkout-intent acquisition race lost — another request already holds an open intent for this offer', { correlationId, offerId: offer.offer_id });
      return new Response(JSON.stringify({ error: 'CHECKOUT_ALREADY_IN_PROGRESS', correlationId }), { status: 409 });
    }
    if (intentErr || !insertedIntent) {
      console.error('Intent creation failed', { correlationId, error: intentErr?.message });
      return new Response(JSON.stringify({ error: 'Could not initiate checkout. Please try again.', correlationId }), { status: 500 });
    }
    intent = insertedIntent;
  }

  // 9. Resolve customer display info
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('user_id', user.id)
    .maybeSingle();

  // 10. Call the routed provider — create hosted payment page
  const adapter = adapterFor(provider);
  const checkoutResult = await adapter.createCheckout({
    saffReference,
    amountMinor:      BigInt(offer.amount_minor!),
    currencyCode:     offer.currency_code!,
    currencyExponent: offer.currency_exponent!,
    planName:         plan?.name ?? planCode,
    customerEmail:    user.email,
    customerName:     profile?.display_name ?? null,
    redirectUrl:      `${REDIRECT_URL}?ref=${saffReference}`,
  });

  // intent is guaranteed non-null here: every branch above that could
  // leave it null returns a Response immediately instead of falling
  // through.
  const acquiredIntent = intent!;

  if (!checkoutResult.success) {
    console.error('Provider checkout failed', { correlationId, provider, error: checkoutResult.error });
    await supabase.from('payment_checkout_intents')
      .update({ status: 'FAILED', completed_at: new Date().toISOString() })
      .eq('id', acquiredIntent.id);
    return new Response(JSON.stringify({ error: 'Payment service temporarily unavailable. Please try again.', correlationId }), { status: 502 });
  }

  // 11. Update intent with provider checkout reference
  await supabase.from('payment_checkout_intents')
    .update({
      status:                'PENDING',
      provider_checkout_ref: checkoutResult.providerRef,
      provider_checkout_url: checkoutResult.checkoutUrl,
    })
    .eq('id', acquiredIntent.id);

  // 12. Return SAFE response — no secrets, no raw provider data
  return new Response(JSON.stringify({
    saffReference: saffReference,
    checkoutUrl:   checkoutResult.checkoutUrl,
    expiresAt:     acquiredIntent.expires_at,
    provider,
    correlationId,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
});
