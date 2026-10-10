/**
 * commercial-create-checkout — server-authoritative checkout creation (and, on GET, the payment options for a plan).
 *
 * Browser sends: { planCode, billingInterval, paymentRoute, phoneNumber? } — nothing else. paymentRoute is the
 * customer's choice of HOW to pay ('CARD' | 'MOBILE_MONEY'); the server maps it to a commercial market (ROUTE_MARKET:
 * CARD → GLOBAL, MOBILE_MONEY → TZ) and resolves that market's offer itself. The browser NEVER supplies price,
 * currency, market, offer identity, product identity, billing owner, provider environment, or entitlements; a market or
 * currency it sends is never read. phoneNumber (mobile money only) is passed to the provider and never stored.
 *
 * Flow (unchanged authority, Ω∞ A+ closure):
 *   1. acquire_checkout_attempt() — atomic, advisory-lock-serialized per (billing_customer_id, product_id); enforces
 *      the platform-state × provider-environment × acceptance-identity matrix; returns a fencing creation_token for a
 *      genuinely NEW attempt, or the existing attempt to reuse (no second charge is ever started for an open one);
 *   2. begin_provider_checkout_request() — durable point-of-no-return before any provider request;
 *   3. the provider call (no database transaction open), then exactly one token-fenced terminal action:
 *      persist_checkout_provider_result (success) | mark_checkout_attempt_failed (provider definitively created nothing)
 *      | mark_checkout_attempt_uncertain (unknown — lands in MANUAL_REVIEW, never auto-retried).
 * A checkout URL is returned ONLY once persisted under the exact token. "Checkout created" is never "paid": access is
 * granted only by commit_verified_commercial_payment after the provider is independently verified (webhook or
 * recovery), never here.
 *
 * Before acquiring, the server checks where the paid term would go (_commercial_licence_placement): a purchase that
 * could not be placed automatically (an open-ended agreement, an upgrade over a queued term) is refused BEFORE any
 * charge and sent to support.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { validateAuth } from '../_shared/auth.ts';
import { generateCorrelationId } from '../_shared/correlationId.ts';
import { selectPaymentProvider, getConfiguredProviders, getAdapterForProvider, returnUrlFrom, ROUTE_MARKET, type PaymentRoute } from '../_shared/payments/routing.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

type Offer = {
  resolution: 'AVAILABLE' | 'NOT_AVAILABLE' | 'AMBIGUOUS' | 'UNKNOWN';
  offer_id?: string; plan_id?: string; market_code?: string;
  currency_code?: string; amount_minor?: number; currency_exponent?: number;
  billing_interval?: string; billing_interval_count?: number;
  provider_restriction?: string | null;
};
const ROUTES: readonly PaymentRoute[] = ['CARD', 'MOBILE_MONEY'];

Deno.serve(async (req: Request) => {
  const correlationId = generateCorrelationId();

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' },
    });
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // 1. Authenticate.
  const authHeader = req.headers.get('Authorization');
  const { result: authResult, error: authError } = await validateAuth(authHeader, CORS_HEADERS);
  if (authError || !authResult) {
    return jsonResponse({ error: 'Unauthorized', correlationId }, 401);
  }
  const user = { id: authResult.userId, email: authResult.email };
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── GET: what this plan costs on each route, which routes are available, and where the term would go. ──────────
  if (req.method === 'GET') {
    const planCode = new URL(req.url).searchParams.get('planCode');
    if (!planCode) return jsonResponse({ error: 'planCode required', correlationId }, 400);
    const configured = getConfiguredProviders();
    const { data: bc } = await supabase.from('billing_customers').select('id').eq('owner_user_id', user.id).maybeSingle();
    const options = [];
    let placement: unknown = null;
    for (const route of ROUTES) {
      // Display only: the annual offer of the market each route maps to (the POST path below resolves again itself).
      const displayArgs = { p_plan_code: planCode, p_billing_interval: 'ANNUAL', p_market_code: ROUTE_MARKET[route] };
      const { data } = await supabase.rpc('resolve_commercial_offer', displayArgs);
      const offer = (data ?? { resolution: 'UNKNOWN' }) as Offer;
      if (offer.resolution !== 'AVAILABLE') { options.push({ paymentRoute: route, available: false, reason: 'NO_PURCHASABLE_OFFER' }); continue; }
      const sel = selectPaymentProvider({ currencyCode: offer.currency_code!, marketCode: offer.market_code!, providerRestriction: offer.provider_restriction ?? null }, configured);
      if (bc && placement === null) {
        const { data: place } = await supabase.rpc('_commercial_licence_placement', { p_billing_customer_id: bc.id, p_plan_id: offer.plan_id, p_at: new Date().toISOString() });
        placement = place;
      }
      options.push(sel.selected
        ? { paymentRoute: route, available: true, provider: sel.provider, environment: sel.environment, amountMinor: offer.amount_minor,
            currencyCode: offer.currency_code, currencyExponent: offer.currency_exponent, billingInterval: offer.billing_interval,
            billingIntervalCount: offer.billing_interval_count }
        : { paymentRoute: route, available: false, reason: sel.reason, amountMinor: offer.amount_minor, currencyCode: offer.currency_code,
            currencyExponent: offer.currency_exponent });
    }
    const { data: state } = await supabase.from('commercial_platform_state').select('state').eq('id', true).maybeSingle();
    return jsonResponse({ planCode, options, placement: placement ?? { kind: 'NEW' }, platformState: state?.state ?? null, correlationId }, 200);
  }

  // 2. Parse request — browser supplies planCode + billingInterval + paymentRoute (+ phoneNumber) ONLY.
  let planCode: string;
  let billingInterval: string;
  let paymentRoute: PaymentRoute;
  let phoneNumber: string | null = null;
  try {
    const body = await req.json();
    planCode = body.planCode;
    billingInterval = body.billingInterval;
    if (!planCode || typeof planCode !== 'string') throw new Error('planCode required');
    if (billingInterval !== 'MONTHLY' && billingInterval !== 'ANNUAL') {
      return jsonResponse({ error: 'billingInterval must be MONTHLY or ANNUAL', correlationId }, 400);
    }
    if (body.paymentRoute !== 'CARD' && body.paymentRoute !== 'MOBILE_MONEY') {
      return jsonResponse({ error: 'paymentRoute must be CARD or MOBILE_MONEY', correlationId }, 400);
    }
    paymentRoute = body.paymentRoute;
    if (paymentRoute === 'MOBILE_MONEY') phoneNumber = typeof body.phoneNumber === 'string' ? body.phoneNumber : null;
  } catch {
    return jsonResponse({ error: 'planCode, billingInterval and paymentRoute are required', correlationId }, 400);
  }
  // The market follows ONLY from the server's own mapping of the chosen route.
  const marketCode = ROUTE_MARKET[paymentRoute];

  const returnUrl = returnUrlFrom((n) => Deno.env.get(n));
  if (!returnUrl) {
    return jsonResponse({ error: 'PAYMENT_PROVIDER_UNAVAILABLE', correlationId }, 503);
  }

  // 3. Resolve the commercial offer server-side.
  const { data: resolution, error: resolveErr } = await supabase.rpc('resolve_commercial_offer', {
    p_plan_code: planCode,
    p_billing_interval: billingInterval,
    p_market_code: marketCode,
  });

  if (resolveErr) {
    console.error('resolve_commercial_offer failed', { correlationId, error: resolveErr.message });
    return jsonResponse({ error: 'Could not resolve a commercial offer.', correlationId }, 500);
  }

  const offer = resolution as Offer;

  if (offer.resolution === 'UNKNOWN') {
    return jsonResponse({ error: 'Unknown plan or market.', correlationId }, 404);
  }
  if (offer.resolution === 'NOT_AVAILABLE') {
    return jsonResponse({ error: 'PRODUCT_PRICING_DECISION_REQUIRED: no purchasable offer configured for this plan/market', correlationId }, 402);
  }
  if (offer.resolution === 'AMBIGUOUS') {
    console.error('Ambiguous offer resolution — refusing to guess', { correlationId, planCode, marketCode });
    return jsonResponse({ error: 'Pricing configuration error. Please contact support.', correlationId }, 500);
  }

  // 4. Route to the eligible configured provider. No fake checkout if none, and no silent environment default.
  const providerSelection = selectPaymentProvider(
    {
      currencyCode: offer.currency_code!,
      marketCode: offer.market_code!,
      providerRestriction: offer.provider_restriction ?? null,
    },
    getConfiguredProviders(),
  );

  if (!providerSelection.selected) {
    console.error('No eligible payment provider', { correlationId, reason: providerSelection.reason, offerId: offer.offer_id });
    return jsonResponse({ error: 'PAYMENT_PROVIDER_UNAVAILABLE', correlationId }, 503);
  }
  const provider = providerSelection.provider;
  const providerEnvironment = providerSelection.environment;
  const adapter = getAdapterForProvider(provider);
  if (!adapter || adapter.environment !== providerEnvironment) {
    return jsonResponse({ error: 'PAYMENT_PROVIDER_UNAVAILABLE', correlationId }, 503);
  }

  if (!user.email) {
    console.error('User has no email on record', { correlationId, userId: user.id });
    return jsonResponse({ error: 'Your account has no email on record. Please contact support.', correlationId }, 422);
  }

  // 5. The account's billing record (created on first checkout for a user without a workspace).
  const { data: billingCustomerId, error: bcErr } = await supabase.rpc('ensure_checkout_billing_customer', { p_user_id: user.id });
  if (bcErr || !billingCustomerId) {
    console.error('ensure_checkout_billing_customer failed', { correlationId, error: bcErr?.message });
    return jsonResponse({ error: 'Billing account not available. Please contact support.', correlationId }, 500);
  }
  const billingCustomer = { id: billingCustomerId as string };

  // 6. Load plan name + product id.
  const { data: plan, error: planErr } = await supabase
    .from('commercial_plans')
    .select('name, product_id')
    .eq('id', offer.plan_id)
    .maybeSingle();

  if (planErr || !plan) {
    console.error('Could not resolve product_id for plan', { correlationId, planId: offer.plan_id, error: planErr?.message });
    return jsonResponse({ error: 'Pricing configuration error. Please contact support.', correlationId }, 500);
  }

  // 7. Where would the paid term go? Refuse BEFORE any charge when it could not be placed automatically.
  const { data: placement, error: placeErr } = await supabase.rpc('_commercial_licence_placement', {
    p_billing_customer_id: billingCustomer.id, p_plan_id: offer.plan_id, p_at: new Date().toISOString(),
  });
  const placementKind = (placement as { kind?: string } | null)?.kind;
  if (placeErr || !placementKind) {
    return jsonResponse({ error: 'Checkout is not currently available. Please contact support.', correlationId }, 503);
  }
  if (placementKind.startsWith('BLOCKED')) {
    return jsonResponse({ error: 'CHECKOUT_REQUIRES_SUPPORT: this plan change needs to be arranged with us.', placement: placementKind, correlationId }, 409);
  }

  // 8. Generate the order reference (≤ 30 characters: it is also the provider idempotency key).
  const saffReference = `SAFF-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;

  // 9. Atomic acquisition. No network call has been made yet.
  const { data: acquireData, error: acquireErr } = await supabase.rpc('acquire_checkout_attempt', {
    p_billing_customer_id: billingCustomer.id,
    p_product_id: plan.product_id,
    p_plan_id: offer.plan_id,
    p_commercial_offer_id: offer.offer_id,
    p_market_code: offer.market_code,
    p_currency_code: offer.currency_code,
    p_currency_exponent: offer.currency_exponent,
    p_amount_minor: offer.amount_minor,
    p_billing_interval: offer.billing_interval,
    p_billing_interval_count: offer.billing_interval_count,
    p_provider: provider,
    p_provider_environment: providerEnvironment,
    p_created_by_user_id: user.id,
    p_saff_reference: saffReference,
  });

  if (acquireErr) {
    // assert_platform_state_permits raising surfaces here — never a fake checkout when the platform-state matrix
    // disallows this attempt (e.g. PAYMENTS_DISABLED).
    console.error('acquire_checkout_attempt failed', { correlationId, error: acquireErr.message });
    return jsonResponse({ error: 'Checkout is not currently available. Please contact support.', correlationId }, 503);
  }

  const acquisition = acquireData as {
    action: 'REUSE_EXISTING' | 'NEW_ATTEMPT' | 'ALREADY_IN_PROGRESS' | 'CONFLICT_DIFFERENT_INTERVAL' | 'MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT';
    intent_id?: string; saff_reference?: string; creation_token?: string;
    checkout_url?: string; expires_at?: string; provider?: string;
    existing_billing_interval?: string;
  };

  if (acquisition.action === 'REUSE_EXISTING') {
    return jsonResponse({
      saffReference: acquisition.saff_reference, checkoutUrl: acquisition.checkout_url,
      expiresAt: acquisition.expires_at, provider: acquisition.provider, reused: true, correlationId,
    }, 200);
  }
  if (acquisition.action === 'ALREADY_IN_PROGRESS') {
    return jsonResponse({ error: 'CHECKOUT_ALREADY_IN_PROGRESS', correlationId }, 409);
  }
  if (acquisition.action === 'MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT') {
    // The earlier attempt must be checked with the provider first (the status page's "Check again" does exactly that,
    // and frees the way when the provider confirms nothing was paid). Never a second charge.
    const { data: blocking } = await supabase.from('payment_checkout_intents').select('saff_reference')
      .eq('id', acquisition.intent_id).eq('billing_customer_id', billingCustomer.id).maybeSingle();
    return jsonResponse({ error: 'CHECKOUT_REQUIRES_SUPPORT: a prior attempt for this product needs manual reconciliation before a new one can start.',
      previousSaffReference: blocking?.saff_reference ?? null, correlationId }, 409);
  }
  if (acquisition.action === 'CONFLICT_DIFFERENT_INTERVAL') {
    return jsonResponse({
      error: 'CHECKOUT_INTERVAL_CONFLICT: an open checkout attempt already exists for a different billing interval on this product. Finish or cancel it before starting a new one.',
      existingBillingInterval: acquisition.existing_billing_interval,
      correlationId,
    }, 409);
  }

  // acquisition.action === 'NEW_ATTEMPT' — the ONLY branch permitted to proceed to a provider network call.
  const intentId = acquisition.intent_id!;
  const creationToken = acquisition.creation_token!;

  // 10. Customer display info.
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('user_id', user.id)
    .maybeSingle();

  // 11. Cross the durable provider side-effect boundary BEFORE making the network request.
  const { data: beginData, error: beginErr } = await supabase.rpc('begin_provider_checkout_request', {
    p_checkout_intent_id: intentId,
    p_creation_token: creationToken,
  });
  const beganProviderRequest = !beginErr &&
    (beginData as { transitioned?: boolean } | null)?.transitioned === true;
  if (!beganProviderRequest) {
    console.error('begin_provider_checkout_request failed', { correlationId, intentId, error: beginErr?.message });
    return jsonResponse({ error: 'CHECKOUT_ALREADY_IN_PROGRESS', correlationId }, 409);
  }

  // 12. Call the routed provider.
  let checkoutResult;
  try {
    checkoutResult = await adapter.createCheckout({
      saffReference,
      intentId,
      billingCustomerId: billingCustomer.id,
      amountMinor:      BigInt(offer.amount_minor!),
      currencyCode:     offer.currency_code!,
      currencyExponent: offer.currency_exponent!,
      planCode,
      planName:         plan.name ?? planCode,
      customerEmail:    user.email,
      customerName:     profile?.display_name ?? null,
      redirectUrl:      `${returnUrl}?ref=${saffReference}`,
      phoneNumber,
    });
  } catch {
    // GENUINELY UNKNOWN whether the provider created a charge — never auto-retried, never silently FAILED.
    console.error('Provider checkout threw', { correlationId, provider });
    const { data: uncertainData, error: uncertainErr } = await supabase.rpc('mark_checkout_attempt_uncertain', {
      p_checkout_intent_id: intentId, p_creation_token: creationToken,
      p_reason: 'PROVIDER_CREATE_THROWN_UNCERTAIN',
    });
    if (uncertainErr || !(uncertainData as { updated?: boolean } | null)?.updated) {
      console.error('Could not persist uncertain provider outcome', { correlationId, intentId, error: uncertainErr?.message });
    }
    return jsonResponse({ error: 'CHECKOUT_OUTCOME_UNCERTAIN: please contact support before retrying.', saffReference, correlationId }, 502);
  }

  if (!checkoutResult.success) {
    const transitionRpc = checkoutResult.outcome === 'DEFINITIVE_FAILURE'
      ? 'mark_checkout_attempt_failed'
      : 'mark_checkout_attempt_uncertain';
    console.error('Provider checkout did not succeed', { correlationId, provider, outcome: checkoutResult.outcome, error: checkoutResult.error });
    const { data: transitionData, error: transitionErr } = await supabase.rpc(transitionRpc, {
      p_checkout_intent_id: intentId, p_creation_token: creationToken,
      p_reason: checkoutResult.error,
    });
    if (transitionErr || !(transitionData as { updated?: boolean } | null)?.updated) {
      console.error('Could not persist provider failure outcome', { correlationId, intentId, error: transitionErr?.message });
    }
    return checkoutResult.outcome === 'DEFINITIVE_FAILURE'
      ? jsonResponse({ error: checkoutResult.error === 'SNIPPE_PHONE_INVALID'
          ? 'PHONE_NUMBER_INVALID: enter a Tanzanian mobile number, for example 0712 345 678.'
          : 'Payment service rejected the checkout request. Please contact support.', correlationId }, 422)
      : jsonResponse({ error: 'CHECKOUT_OUTCOME_UNCERTAIN: please contact support before retrying.', saffReference, correlationId }, 502);
  }

  // 13. Compare-and-swap persistence. A checkout URL is returned ONLY if this call reports persisted:true.
  const { data: persistData, error: persistErr } = await supabase.rpc('persist_checkout_provider_result', {
    p_checkout_intent_id: intentId,
    p_creation_token: creationToken,
    p_provider_checkout_ref: checkoutResult.providerRef,
    p_provider_checkout_url: checkoutResult.checkoutUrl,
  });

  const persisted = !persistErr && (persistData as { persisted?: boolean } | null)?.persisted === true;

  if (!persisted) {
    console.error('persist_checkout_provider_result did not persist — routing to manual review', {
      correlationId, intentId, error: persistErr?.message,
    });
    const { data: uncertainData, error: uncertainErr } = await supabase.rpc('mark_checkout_attempt_uncertain', {
      p_checkout_intent_id: intentId, p_creation_token: creationToken,
      p_reason: 'PROVIDER_RESULT_PERSISTENCE_UNCERTAIN',
    });
    if (uncertainErr || !(uncertainData as { updated?: boolean } | null)?.updated) {
      console.error('Could not persist provider-result uncertainty', { correlationId, intentId, error: uncertainErr?.message });
    }
    return jsonResponse({ error: 'CHECKOUT_OUTCOME_UNCERTAIN: please contact support before retrying.', saffReference, correlationId }, 502);
  }

  const persistedIntent = persistData as { intent_id: string; saff_reference: string; expires_at: string };

  // 14. Return SAFE response — no secrets, no raw provider data. Only reachable once persistence has been proven.
  return jsonResponse({
    saffReference: persistedIntent.saff_reference,
    checkoutUrl:   checkoutResult.checkoutUrl,
    expiresAt:     persistedIntent.expires_at,
    provider,
    paymentRoute,
    correlationId,
  }, 200);
});
