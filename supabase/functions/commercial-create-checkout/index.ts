/**
 * commercial-create-checkout — Ω2-G Edge Function
 *
 * Creates a checkout intent server-side and returns a hosted payment URL.
 * Browser sends: { planCode: string, marketCode?: string }
 * Server resolves: the commercial offer (plan + market + currency + price),
 * routes to an eligible configured provider, and creates the intent.
 *
 * Browser NEVER supplies price, currency, offer identity, billing owner, or
 * entitlements. Browser may suggest a market (e.g. from a UI toggle a user
 * explicitly picked) but the server independently RESOLVES the offer via
 * resolve_commercial_offer() — it never trusts a browser-supplied amount or
 * currency, and never derives market from IP/locale.
 *
 * Iron Dome:
 *   - Authenticated only (validateAuth)
 *   - Offer resolved server-side via resolve_commercial_offer() RPC
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

  // 2. Parse request — browser supplies planCode + an optional market
  //    suggestion. Neither price nor currency is ever accepted here.
  let planCode: string;
  let marketCode: string;
  try {
    const body = await req.json();
    planCode = body.planCode;
    marketCode = typeof body.marketCode === 'string' && body.marketCode ? body.marketCode : 'GLOBAL';
    if (!planCode || typeof planCode !== 'string') throw new Error('planCode required');
  } catch {
    return new Response(JSON.stringify({ error: 'planCode is required', correlationId }), { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // 3. Resolve the commercial offer server-side. Never trust a browser-
  //    supplied amount/currency; never derive market from IP/locale.
  const { data: resolution, error: resolveErr } = await supabase.rpc('resolve_commercial_offer', {
    p_plan_code: planCode,
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

  // 7. Generate unique SAFF reference
  const saffReference = `SAFF-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;

  // 8. Create checkout intent — snapshots the offer's economic facts NOW,
  //    so a later offer edit can never mutate this in-flight or historical
  //    checkout.
  const { data: intent, error: intentErr } = await supabase
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

  if (intentErr || !intent) {
    console.error('Intent creation failed', { correlationId, error: intentErr?.message });
    return new Response(JSON.stringify({ error: 'Could not initiate checkout. Please try again.', correlationId }), { status: 500 });
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

  if (!checkoutResult.success) {
    console.error('Provider checkout failed', { correlationId, provider, error: checkoutResult.error });
    await supabase.from('payment_checkout_intents')
      .update({ status: 'FAILED', completed_at: new Date().toISOString() })
      .eq('id', intent.id);
    return new Response(JSON.stringify({ error: 'Payment service temporarily unavailable. Please try again.', correlationId }), { status: 502 });
  }

  // 11. Update intent with provider checkout reference
  await supabase.from('payment_checkout_intents')
    .update({
      status:                'PENDING',
      provider_checkout_ref: checkoutResult.providerRef,
      provider_checkout_url: checkoutResult.checkoutUrl,
    })
    .eq('id', intent.id);

  // 12. Return SAFE response — no secrets, no raw provider data
  return new Response(JSON.stringify({
    saffReference: saffReference,
    checkoutUrl:   checkoutResult.checkoutUrl,
    expiresAt:     intent.expires_at,
    provider,
    correlationId,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
});
