/**
 * commercial-payment-status — Ω∞ A+ closure Edge Function
 *
 * HIGH-1 fix: GET and POST are now genuinely separate contracts.
 *
 *   GET  — owner-scoped, READ-ONLY. Calls get_checkout_status() only.
 *          Never calls the provider, never mutates anything, never commits
 *          a payment. Safe to poll at any frequency from the browser.
 *
 *   POST — authenticated recovery request that may claim ONE bounded
 *          verification attempt. Proves ownership via the caller's own
 *          JWT (through the identical get_checkout_status() read used by
 *          GET; a commercial administrator passes the same read), then calls
 *          claim_verification_attempt() — a DB-atomic, row-locked,
 *          durably-throttled claim. Only on a successful claim does this
 *          function ask the provider and settle through the shared path
 *          (_shared/payments/settle.ts — the same one the webhooks use). If
 *          the claim is refused (already verified recently, already in
 *          flight, or the intent is not in a verifiable state), this returns
 *          202 with a bounded Retry-After — never silently ignored, never an
 *          unbounded retry loop.
 *
 * The prior revision ran independent provider verification and a
 * commit attempt INSIDE the GET handler itself, gated only by an
 * in-process status check with no durable throttle — an unbounded number
 * of browser GETs could each trigger a fresh provider API call. That
 * is now impossible: GET never calls the provider at all.
 *
 * Iron Dome:
 *   - Authenticated only
 *   - GET returns UNKNOWN if reference not found (not a 404 — prevents enumeration)
 *   - Never exposes raw provider payload, secrets, or amounts from provider response
 *   - service_role used ONLY inside POST's claimed-verification branch,
 *     scoped to the exact intent the owner-scoped read already resolved
 *   - No in-process rate limiting anywhere — claim_verification_attempt is
 *     the sole, durable throttle authority
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { validateAuth } from '../_shared/auth.ts';
import { generateCorrelationId } from '../_shared/correlationId.ts';
import { getAdapterForProvider } from '../_shared/payments/routing.ts';
import { SETTLEMENT_INTENT_COLUMNS, settleIntent, type ServiceDb } from '../_shared/payments/settle.ts';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_KEY       = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

Deno.serve(async (req: Request) => {
  const correlationId = generateCorrelationId();

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { ...CORS_HEADERS, 'Access-Control-Allow-Origin': '*' } });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const authHeader = req.headers.get('Authorization');
  const { result: authResult, error: authError } = await validateAuth(authHeader, CORS_HEADERS);
  if (authError || !authResult) {
    return jsonResponse({ error: 'Unauthorized', correlationId }, 401);
  }

  let saffReference = new URL(req.url).searchParams.get('ref');
  if (!saffReference && req.method === 'POST') {
    try {
      const body = await req.json();
      saffReference = body.saffReference ?? body.ref ?? null;
    } catch { /* ignore */ }
  }

  if (!saffReference) {
    return jsonResponse({ error: 'ref parameter required', correlationId }, 400);
  }

  // get_checkout_status() is SECURITY DEFINER but scopes ITSELF internally
  // via auth.uid() — must be called AS the caller's own JWT, never
  // service_role (which would leave auth.uid() NULL and silently return
  // "not found" for every genuine owner too).
  const readClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader! } },
  });

  const { data, error } = await readClient.rpc('get_checkout_status', {
    p_saff_reference: saffReference,
  });

  if (error) {
    console.error('get_checkout_status failed', { correlationId, error: error.message });
    return jsonResponse({ found: false, status: 'UNKNOWN', correlationId }, 200);
  }

  const responseData = (data ?? {}) as {
    found?: boolean; status?: string; intent_id?: string; provider?: string;
    saff_reference?: string; expected_amount_minor?: number; currency_code?: string;
  };

  // ── GET: read-only, full stop. ────────────────────────────────────────────
  if (req.method === 'GET') {
    return jsonResponse({ ...responseData, correlationId }, 200);
  }

  // ── POST: bounded, durably-throttled recovery attempt. ────────────────────
  if (!responseData.found || !responseData.intent_id) {
    return jsonResponse({ error: 'UNKNOWN_REFERENCE', correlationId }, 404);
  }

  const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: claimData, error: claimErr } = await serviceClient.rpc('claim_verification_attempt', {
    p_checkout_intent_id: responseData.intent_id,
    p_requesting_user_id: authResult.userId,
  });

  if (claimErr) {
    console.error('claim_verification_attempt failed', { correlationId, error: claimErr.message });
    return jsonResponse({ error: 'RECOVERY_UNAVAILABLE', correlationId }, 500);
  }

  const claim = claimData as {
    claimed: boolean; reason?: string; retry_after_seconds?: number; status?: string;
    provider?: string; saff_reference?: string; expected_amount_minor?: number; currency_code?: string;
  };

  if (!claim.claimed) {
    if (claim.reason === 'NOT_FOUND_OR_NOT_OWNER') {
      return jsonResponse({ error: 'UNKNOWN_REFERENCE', correlationId }, 404);
    }
    if (claim.reason === 'INTENT_NOT_VERIFIABLE') {
      // Already terminal (SUCCEEDED/FAILED/CANCELLED/EXPIRED) or still
      // CREATING (no provider checkout exists yet to verify) — nothing for
      // a recovery attempt to do. Return the current status, not an error.
      return jsonResponse({ ...responseData, correlationId }, 200);
    }
    // THROTTLED — a verification attempt for this exact intent is already
    // in flight or was attempted too recently. Never an unbounded retry
    // loop: the browser is told exactly how long to wait.
    const retryAfter = claim.retry_after_seconds ?? 60;
    return jsonResponse(
      { status: 'VERIFICATION_IN_PROGRESS', retryAfterSeconds: retryAfter, correlationId },
      202,
      { 'Retry-After': String(retryAfter) },
    );
  }

  // Claimed — this request is the sole holder of the verification attempt for this intent for the cooldown window.
  // It goes through the SAME settlement path as a provider webhook (_shared/payments/settle.ts): Gate B against the
  // provider's own record of this checkout (adapter.verifyTransactionByReference), then commit_verified_commercial_payment
  // under the canonical idempotency key — so a recovery and a late webhook converge on one payment and one licence.
  try {
    const adapter = claim.provider ? getAdapterForProvider(claim.provider) : null;
    if (!adapter) {
      // The intent's provider is not configured in this deployment: no new information, never a guessed outcome.
      return jsonResponse({ ...responseData, recovery: 'PROVIDER_UNAVAILABLE', correlationId }, 200);
    }
    const { data: intent, error: intentErr } = await serviceClient.from('payment_checkout_intents')
      .select(SETTLEMENT_INTENT_COLUMNS).eq('id', responseData.intent_id).maybeSingle();
    if (intentErr || !intent) return jsonResponse({ ...responseData, recovery: 'ERROR', correlationId }, 200);

    const outcome = await settleIntent(serviceClient as unknown as ServiceDb, adapter, intent);
    const { data: refreshed } = await readClient.rpc('get_checkout_status', { p_saff_reference: saffReference });
    return jsonResponse({ ...((refreshed ?? responseData) as Record<string, unknown>), recovery: outcome.result, correlationId }, 200);
  } catch (fallbackErr) {
    console.error('POST recovery verification threw', { correlationId, error: String(fallbackErr) });
    return jsonResponse({ ...responseData, recovery: 'ERROR', correlationId }, 200);
  }
});
