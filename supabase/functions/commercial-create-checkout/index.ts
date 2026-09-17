/**
 * commercial-create-checkout — Ω∞ A+ closure Edge Function
 *
 * Creates a checkout intent server-side and returns a hosted payment URL.
 * Browser sends: { planCode: string, billingInterval: string } — nothing
 * else. Server resolves: the commercial offer (plan + interval + market +
 * currency + price), routes to an eligible configured provider, and
 * creates the intent.
 *
 * Browser NEVER supplies price, currency, market, offer identity, product
 * identity, billing owner, provider environment, or entitlements. Market is
 * ALWAYS 'GLOBAL' — the Ω3-CHECKOUT charter's own frozen decision and trust
 * boundary are absolute, not a default a caller could override.
 *
 * Ω∞ A+ closure (BLOCKER-1, BLOCKER-2, BLOCKER-3): the previous revision's
 * acquire-or-reuse logic lived entirely in this function's own
 * read-then-insert-then-update sequence, and returned a live provider
 * checkout URL even when the DB write persisting it had failed. Both gaps
 * are closed by moving acquisition and persistence into two DB-authoritative,
 * token-fenced RPCs:
 *
 *   1. acquire_checkout_attempt() — atomic, advisory-lock-serialized per
 *      (billing_customer_id, product_id) — NOT per offer, so a MONTHLY and
 *      ANNUAL attempt for the same product can never both be payable at
 *      once. Returns a fencing creation_token for a genuinely NEW attempt.
 *      Also enforces the platform-state x provider-environment x
 *      acceptance-identity matrix (assert_platform_state_permits) — a
 *      disallowed combination raises and no attempt row is ever created.
 *   2. begin_provider_checkout_request() — durable point-of-no-return
 *      transition from CREATING to PROVIDER_CREATING before any provider
 *      network request is attempted.
 *   3. persist_checkout_provider_result() — a compare-and-swap keyed on
 *      (intent id, creation_token, status='PROVIDER_CREATING'). Zero affected rows
 *      is a real, checked failure: this function is structurally unable to
 *      return a checkout URL that was not durably persisted under the
 *      exact token it was issued.
 *
 * The provider network call happens BETWEEN these two RPC calls — never
 * while a database transaction is open — and its outcome routes to exactly
 * one of three token-fenced terminal actions: persist (success),
 * mark_checkout_attempt_failed (provider definitively reported no charge —
 * safe to retry), or mark_checkout_attempt_uncertain (network/parse error —
 * genuinely unknown whether the provider created a charge; lands in
 * MANUAL_REVIEW, never automatically retried or superseded).
 *
 * Iron Dome:
 *   - Authenticated only (validateAuth)
 *   - Offer resolved server-side via resolve_commercial_offer() RPC
 *   - Provider selected server-side via selectPaymentProvider() — no fake
 *     checkout when no eligible provider is configured
 *   - No secrets in response
 *   - Returns safe { checkoutUrl, saffReference, expiresAt } only, and only
 *     once durably persisted
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { validateAuth } from '../_shared/auth.ts';
import { generateCorrelationId } from '../_shared/correlationId.ts';
import { selectPaymentProvider, getConfiguredProviders } from '../_shared/payments/routing.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const REDIRECT_URL = Deno.env.get('SAFF_PAYMENT_REDIRECT_URL') ?? 'https://app.cfoclose.com/billing/payment/return';

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

// Flutterwave decommission: no provider adapter is implemented in this
// deployment. getConfiguredProviders() is empty, so selectPaymentProvider()
// returns PAYMENT_PROVIDER_UNAVAILABLE long before this point is reached —
// this exists only so a future provider has one obvious wiring site, and it
// never fabricates a checkout.
function adapterFor(provider: string): never {
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
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // 1. Authenticate.
  const authHeader = req.headers.get('Authorization');
  const { result: authResult, error: authError } = await validateAuth(authHeader, CORS_HEADERS);
  if (authError || !authResult) {
    return jsonResponse({ error: 'Unauthorized', correlationId }, 401);
  }
  const user = { id: authResult.userId, email: authResult.email };

  // 2. Parse request — browser supplies planCode + billingInterval ONLY.
  let planCode: string;
  let billingInterval: string;
  const marketCode = 'GLOBAL';
  try {
    const body = await req.json();
    planCode = body.planCode;
    billingInterval = body.billingInterval;
    if (!planCode || typeof planCode !== 'string') throw new Error('planCode required');
    if (billingInterval !== 'MONTHLY' && billingInterval !== 'ANNUAL') {
      return jsonResponse({ error: 'billingInterval must be MONTHLY or ANNUAL', correlationId }, 400);
    }
  } catch {
    return jsonResponse({ error: 'planCode and billingInterval are required', correlationId }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

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

  const offer = resolution as {
    resolution: 'AVAILABLE' | 'NOT_AVAILABLE' | 'AMBIGUOUS' | 'UNKNOWN';
    offer_id?: string; plan_id?: string; market_code?: string;
    currency_code?: string; amount_minor?: number; currency_exponent?: number;
    billing_interval?: string; billing_interval_count?: number;
    provider_restriction?: string | null;
  };

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

  // 4. Route to an eligible configured provider. No fake checkout if none,
  //    and no silent environment default (getConfiguredProviders() itself
  //    excludes any provider whose environment is not explicitly and
  //    validly declared).
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

  // 5. Resolve billing customer for this user.
  const { data: billingCustomer, error: bcErr } = await supabase
    .from('billing_customers')
    .select('id')
    .eq('owner_user_id', user.id)
    .single();

  if (bcErr || !billingCustomer) {
    return jsonResponse({ error: 'Billing account not found. Please contact support.', correlationId }, 404);
  }

  if (!user.email) {
    console.error('User has no email on record', { correlationId, userId: user.id });
    return jsonResponse({ error: 'Your account has no email on record. Please contact support.', correlationId }, 422);
  }

  // 6. Load plan name + product id. product_id is required by
  //    acquire_checkout_attempt's atomic (customer, product) boundary —
  //    resolve_commercial_offer's own response only carries plan_id, so it
  //    is resolved here via the same read used for the plan's display name.
  const { data: plan, error: planErr } = await supabase
    .from('commercial_plans')
    .select('name, product_id')
    .eq('id', offer.plan_id)
    .maybeSingle();

  if (planErr || !plan) {
    console.error('Could not resolve product_id for plan', { correlationId, planId: offer.plan_id, error: planErr?.message });
    return jsonResponse({ error: 'Pricing configuration error. Please contact support.', correlationId }, 500);
  }

  // 7. Generate unique SAFF reference.
  const saffReference = `SAFF-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;

  // 8. Atomic acquisition — Ω∞ A+ closure BLOCKER-2/BLOCKER-3 fix. The sole
  //    authoritative decision on whether this call starts a new attempt,
  //    safely reuses an existing one, or must be refused, lives entirely
  //    inside this one DB-atomic RPC. No network call has been made yet.
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
    // assert_platform_state_permits raising surfaces here — never a fake
    // checkout when the platform-state/environment/acceptance-identity
    // matrix disallows this attempt.
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
      expiresAt: acquisition.expires_at, provider: acquisition.provider, correlationId,
    }, 200);
  }
  if (acquisition.action === 'ALREADY_IN_PROGRESS') {
    return jsonResponse({ error: 'CHECKOUT_ALREADY_IN_PROGRESS', correlationId }, 409);
  }
  if (acquisition.action === 'MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT') {
    return jsonResponse({ error: 'CHECKOUT_REQUIRES_SUPPORT: a prior attempt for this product needs manual reconciliation before a new one can start.', correlationId }, 409);
  }
  if (acquisition.action === 'CONFLICT_DIFFERENT_INTERVAL') {
    return jsonResponse({
      error: 'CHECKOUT_INTERVAL_CONFLICT: an open checkout attempt already exists for a different billing interval on this product. Finish or cancel it before starting a new one.',
      existingBillingInterval: acquisition.existing_billing_interval,
      correlationId,
    }, 409);
  }

  // acquisition.action === 'NEW_ATTEMPT' — the ONLY branch permitted to
  // proceed to a provider network call. No database transaction is open
  // across this call: acquire_checkout_attempt has already committed.
  const intentId = acquisition.intent_id!;
  const creationToken = acquisition.creation_token!;

  // 9. Resolve customer display info.
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('user_id', user.id)
    .maybeSingle();

  // 10. Cross the durable provider side-effect boundary BEFORE making the
  //     network request. Once PROVIDER_CREATING is committed, a timeout or
  //     worker crash can never be interpreted as "safe to retry".
  const { data: beginData, error: beginErr } = await supabase.rpc('begin_provider_checkout_request', {
    p_checkout_intent_id: intentId,
    p_creation_token: creationToken,
  });
  const beganProviderRequest = !beginErr &&
    (beginData as { transitioned?: boolean } | null)?.transitioned === true;
  if (!beganProviderRequest) {
    console.error('begin_provider_checkout_request failed', {
      correlationId, intentId, error: beginErr?.message,
    });
    return jsonResponse({ error: 'CHECKOUT_ALREADY_IN_PROGRESS', correlationId }, 409);
  }

  // 11. Call the routed provider — create hosted payment page.
  const adapter = adapterFor(provider);
  let checkoutResult;
  try {
    checkoutResult = await adapter.createCheckout({
      saffReference,
      amountMinor:      BigInt(offer.amount_minor!),
      currencyCode:     offer.currency_code!,
      currencyExponent: offer.currency_exponent!,
      planName:         plan.name ?? planCode,
      customerEmail:    user.email,
      customerName:     profile?.display_name ?? null,
      redirectUrl:      `${REDIRECT_URL}?ref=${saffReference}`,
    });
  } catch {
    // Ω∞ A+ closure BLOCKER-1 fix: an exception here means it is GENUINELY
    // UNKNOWN whether the provider created a real charge (e.g. the request
    // reached the provider but the response never arrived) — never
    // auto-retried, never silently marked FAILED. Routed to MANUAL_REVIEW
    // for human reconciliation.
    console.error('Provider checkout threw', { correlationId, provider });
    const { data: uncertainData, error: uncertainErr } = await supabase.rpc('mark_checkout_attempt_uncertain', {
      p_checkout_intent_id: intentId, p_creation_token: creationToken,
      p_reason: 'PROVIDER_CREATE_THROWN_UNCERTAIN',
    });
    if (uncertainErr || !(uncertainData as { updated?: boolean } | null)?.updated) {
      console.error('Could not persist uncertain provider outcome', { correlationId, intentId, error: uncertainErr?.message });
    }
    return jsonResponse({ error: 'CHECKOUT_OUTCOME_UNCERTAIN: please contact support before retrying.', correlationId }, 502);
  }

  if (!checkoutResult.success) {
    const transitionRpc = checkoutResult.outcome === 'DEFINITIVE_FAILURE'
      ? 'mark_checkout_attempt_failed'
      : 'mark_checkout_attempt_uncertain';
    console.error('Provider checkout did not succeed', { correlationId, provider, outcome: checkoutResult.outcome });
    const { data: transitionData, error: transitionErr } = await supabase.rpc(transitionRpc, {
      p_checkout_intent_id: intentId, p_creation_token: creationToken,
      p_reason: checkoutResult.error,
    });
    if (transitionErr || !(transitionData as { updated?: boolean } | null)?.updated) {
      console.error('Could not persist provider failure outcome', { correlationId, intentId, error: transitionErr?.message });
    }
    return checkoutResult.outcome === 'DEFINITIVE_FAILURE'
      ? jsonResponse({ error: 'Payment service rejected the checkout request. Please contact support.', correlationId }, 422)
      : jsonResponse({ error: 'CHECKOUT_OUTCOME_UNCERTAIN: please contact support before retrying.', correlationId }, 502);
  }

  // 12. Ω∞ A+ closure BLOCKER-1 fix: compare-and-swap persistence. A
  //     checkout URL is returned to the browser ONLY if this call reports
  //     persisted:true — there is no code path from here that can return
  //     checkoutResult.checkoutUrl without it having been durably written
  //     first.
  const { data: persistData, error: persistErr } = await supabase.rpc('persist_checkout_provider_result', {
    p_checkout_intent_id: intentId,
    p_creation_token: creationToken,
    p_provider_checkout_ref: checkoutResult.providerRef,
    p_provider_checkout_url: checkoutResult.checkoutUrl,
  });

  const persisted = !persistErr && (persistData as { persisted?: boolean } | null)?.persisted === true;

  if (!persisted) {
    // Zero rows affected (stale token, already-transitioned row) or an
    // RPC error. Either way: a real, provider-created checkout now exists
    // that this response can never safely hand to the browser, because it
    // was not proven durably recorded. Route to MANUAL_REVIEW rather than
    // silently losing track of it — the provider may or may not eventually
    // deliver a webhook for a reference this system can no longer resolve
    // to a PENDING intent, which is exactly why this is an operator
    // reconciliation case, not a customer-safe retry.
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
    return jsonResponse({ error: 'CHECKOUT_OUTCOME_UNCERTAIN: please contact support before retrying.', correlationId }, 502);
  }

  const persistedIntent = persistData as { intent_id: string; saff_reference: string; expires_at: string };

  // 13. Return SAFE response — no secrets, no raw provider data. Only
  //     reachable once persistence has been proven.
  return jsonResponse({
    saffReference: persistedIntent.saff_reference,
    checkoutUrl:   checkoutResult.checkoutUrl,
    expiresAt:     persistedIntent.expires_at,
    provider,
    correlationId,
  }, 200);
});
