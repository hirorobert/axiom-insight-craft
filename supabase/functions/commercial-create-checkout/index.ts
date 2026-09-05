/**
 * commercial-create-checkout — Ω2 Edge Function
 *
 * Creates a checkout intent server-side and returns a hosted payment URL.
 * Browser sends: { planId: string }
 * Server derives: billing customer, plan details, price, currency, redirect URL.
 * Browser NEVER supplies price, currency, billing owner, or entitlements.
 *
 * Iron Dome:
 *   - Authenticated only (validateAuth)
 *   - firmMemberId NOT used here — this is commercial identity (billing_customer anchors to auth.uid)
 *   - Price derived from commercial_plans server-side
 *   - No secrets in response
 *   - Returns safe { checkoutUrl, saffReference, expiresAt } only
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { validateAuth } from '../_shared/auth.ts';
import { getFlutterwaveAdapter } from '../_shared/payments/providers/flutterwave.ts';
import { generateCorrelationId } from '../_shared/correlationId.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const REDIRECT_URL = Deno.env.get('SAFF_PAYMENT_REDIRECT_URL') ?? 'https://app.cfoclose.com/billing/payment/return';

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

  // 1. Authenticate — derive user from JWT
  let authResult: Awaited<ReturnType<typeof validateAuth>>;
  try {
    authResult = await validateAuth(req);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Unauthorized', correlationId }), { status: 401 });
  }
  const { user } = authResult;

  // 2. Parse request — browser supplies ONLY planId
  let planId: string;
  try {
    const body = await req.json();
    planId = body.planId;
    if (!planId || typeof planId !== 'string') throw new Error('planId required');
  } catch {
    return new Response(JSON.stringify({ error: 'planId is required', correlationId }), { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // 3. Load plan server-side — price/currency never from browser
  const { data: plan, error: planErr } = await supabase
    .from('commercial_plans')
    .select('id, code, name, price_amount_minor, currency_code, currency_exponent, is_purchasable, is_active, billing_period')
    .eq('id', planId)
    .single();

  if (planErr || !plan) {
    return new Response(JSON.stringify({ error: 'Plan not found', correlationId }), { status: 404 });
  }
  if (!plan.is_active || !plan.is_purchasable) {
    return new Response(JSON.stringify({ error: 'Plan is not currently available for purchase', correlationId }), { status: 422 });
  }
  if (plan.price_amount_minor === null || plan.price_amount_minor === undefined) {
    return new Response(JSON.stringify({
      error: 'PRODUCT_PRICING_DECISION_REQUIRED: no price configured for this plan',
      correlationId
    }), { status: 422 });
  }

  // 4. Resolve billing customer for this user
  const { data: billingCustomer, error: bcErr } = await supabase
    .from('billing_customers')
    .select('id')
    .eq('owner_user_id', user.id)
    .single();

  if (bcErr || !billingCustomer) {
    return new Response(JSON.stringify({ error: 'Billing account not found. Please contact support.', correlationId }), { status: 404 });
  }

  // 5. Generate unique SAFF reference
  const saffReference = `SAFF-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;

  // 6. Create checkout intent in DB (before contacting Flutterwave)
  const { data: intent, error: intentErr } = await supabase
    .from('payment_checkout_intents')
    .insert({
      billing_customer_id:   billingCustomer.id,
      plan_id:               planId,
      provider:              'FLUTTERWAVE',
      saff_reference:        saffReference,
      expected_amount_minor: plan.price_amount_minor,
      currency_code:         plan.currency_code,
      currency_exponent:     plan.currency_exponent,
      status:                'CREATED',
      created_by_user_id:    user.id,
    })
    .select('id, saff_reference, expires_at')
    .single();

  if (intentErr || !intent) {
    console.error('Intent creation failed', { correlationId, error: intentErr?.message });
    return new Response(JSON.stringify({ error: 'Could not initiate checkout. Please try again.', correlationId }), { status: 500 });
  }

  // 7. Resolve customer display info
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('user_id', user.id)
    .maybeSingle();

  // 8. Call Flutterwave — create hosted payment page
  const adapter = getFlutterwaveAdapter();
  const checkoutResult = await adapter.createCheckout({
    saffReference,
    amountMinor:      BigInt(plan.price_amount_minor),
    currencyCode:     plan.currency_code,
    currencyExponent: plan.currency_exponent,
    planName:         plan.name,
    customerEmail:    user.email ?? 'customer@saff.co.tz',
    customerName:     profile?.display_name ?? null,
    redirectUrl:      `${REDIRECT_URL}?ref=${saffReference}`,
  });

  if (!checkoutResult.success) {
    console.error('Flutterwave checkout failed', { correlationId, error: checkoutResult.error });
    // Expire the intent since provider failed
    await supabase.from('payment_checkout_intents')
      .update({ status: 'FAILED', completed_at: new Date().toISOString() })
      .eq('id', intent.id);
    return new Response(JSON.stringify({ error: 'Payment service temporarily unavailable. Please try again.', correlationId }), { status: 502 });
  }

  // 9. Update intent with provider checkout reference
  await supabase.from('payment_checkout_intents')
    .update({
      status:               'PENDING',
      provider_checkout_ref: checkoutResult.providerRef,
      provider_checkout_url: checkoutResult.checkoutUrl,
    })
    .eq('id', intent.id);

  // 10. Return SAFE response — no secrets, no raw provider data
  return new Response(JSON.stringify({
    saffReference:  saffReference,
    checkoutUrl:    checkoutResult.checkoutUrl,
    expiresAt:      intent.expires_at,
    provider:       'FLUTTERWAVE',
    correlationId,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
});
