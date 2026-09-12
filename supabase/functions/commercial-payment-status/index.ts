/**
 * commercial-payment-status — Ω2 Edge Function
 *
 * Safe owner-scoped reader for payment return page and billing summary.
 * Returns checkout + licence state without exposing raw provider payloads.
 * Used by the /billing/payment/return page to poll until payment is confirmed.
 *
 * Ω3-CHECKOUT correction (BLOCKER fix — webhook/status convergence): the
 * prior revision ONLY read whatever the webhook had already written — if
 * Flutterwave's webhook was lost, delayed, or never configured/reachable
 * for a given deployment, a genuinely-paid customer polled this endpoint
 * forever and always got back a non-terminal status, with NOTHING in the
 * system ever independently re-checking with the provider. This function
 * now ALSO independently re-verifies (Gate B, by reference — the same
 * discipline the webhook applies, via the SAME adapter method) whenever
 * the intent it reads is still non-terminal, and commits it itself if
 * verification succeeds — using a SEPARATE, narrowly-scoped service-role
 * client ONLY for that one verify+commit step. The read path that proves
 * OWNERSHIP of the reference being polled is completely unchanged: it
 * still runs entirely through the caller's own JWT via get_checkout_
 * status()'s own auth.uid() scoping, exactly as before. The service-role
 * client can only ever affect the SAME intent that read step has already
 * proven belongs to the calling user — it never enumerates or reads by a
 * different key.
 *
 * Iron Dome:
 *   - Authenticated only
 *   - Returns UNKNOWN if reference not found (not a 404 — prevents enumeration)
 *   - Never exposes raw provider payload, secrets, or amounts from provider response
 *   - service_role used ONLY for the independent verify+commit fallback,
 *     scoped to the exact intent the owner-scoped read already resolved
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { validateAuth } from '../_shared/auth.ts';
import { generateCorrelationId } from '../_shared/correlationId.ts';
import { getFlutterwaveAdapter } from '../_shared/payments/providers/flutterwave.ts';
import { authoriseCommit, sha256Hex } from '../_shared/payments/authority.ts';
import { FLUTTERWAVE_CAPABILITIES } from '../_shared/payments/routing.ts';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_KEY       = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function adapterFor(provider: string) {
  if (provider === 'FLUTTERWAVE') return getFlutterwaveAdapter();
  return null;
}

// Shared CORS header set for the auth section below — the real
// _shared/auth.ts contract is validateAuth(authHeader, corsHeaders), and its
// 401 fail-closed response (constructed here, not by validateAuth itself,
// so it can carry this function's own correlationId) must carry these too.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  const correlationId = generateCorrelationId();

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' },
    });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  // 1. Authenticate. Real contract (verified against _shared/auth.ts
  //    directly): validateAuth(authHeader: string | null, corsHeaders) ->
  //    { result?: { userId, email? }; error?: Response }. It never takes the
  //    Request itself — passing `req` throws inside authHeader.startsWith()
  //    and was silently caught into a bare, CORS-less 401 below, masking
  //    every real auth outcome as "Unauthorized".
  const authHeader = req.headers.get('Authorization');
  const { result: authResult, error: authError } = await validateAuth(authHeader, CORS_HEADERS);
  if (authError || !authResult) {
    return new Response(JSON.stringify({ error: 'Unauthorized', correlationId }), {
      status: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // 2. Get saff_reference from query param or body
  const url = new URL(req.url);
  let saffReference = url.searchParams.get('ref');
  if (!saffReference && req.method === 'POST') {
    try {
      const body = await req.json();
      saffReference = body.saffReference ?? body.ref ?? null;
    } catch { /* ignore */ }
  }

  if (!saffReference) {
    return new Response(JSON.stringify({ error: 'ref parameter required', correlationId }), { status: 400 });
  }

  // get_checkout_status() is SECURITY DEFINER but scopes ITSELF internally
  // via auth.uid() (owner_user_id = auth.uid() OR is_commercial_admin()) and
  // is GRANTed to `authenticated` only, never `service_role` — so it must be
  // called AS the caller's own JWT (anon key + their bearer token), the same
  // idiom _shared/auth.ts's own validateAuth() already uses to verify that
  // JWT. A service-role client leaves auth.uid() NULL inside Postgres,
  // which would silently return "not found" for every genuine owner too —
  // fail-closed against leakage, but also fail-closed against ever working.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader! } },
  });

  // 3. Call safe owner-scoped RPC — this is the ONLY read that proves the
  //    caller owns `saffReference`. Everything below operates strictly on
  //    the SAME intent this call already resolved.
  const { data, error } = await supabase.rpc('get_checkout_status', {
    p_saff_reference: saffReference,
  });

  if (error) {
    console.error('get_checkout_status failed', { correlationId, error: error.message });
    return new Response(JSON.stringify({
      found: false, status: 'UNKNOWN', correlationId,
    }), { status: 200 });
  }

  let responseData = data ?? {};

  // 4. Ω3-CHECKOUT (BLOCKER fix): if the intent is still non-terminal, the
  //    webhook may have been lost, delayed, or never delivered — attempt
  //    an independent Gate-B re-verification BY REFERENCE and commit it
  //    ourselves if Flutterwave confirms success. Never attempted for a
  //    terminal status (SUCCEEDED/FAILED/CANCELLED/EXPIRED) — nothing to
  //    re-verify, and commit_verified_commercial_payment's own idempotency
  //    check would reject it as ALREADY_COMMITTED or INTENT_ALREADY_RESOLVED
  //    regardless.
  const status = (responseData as { status?: string }).status;
  if (status === 'CREATED' || status === 'PENDING') {
    try {
      const intentData = responseData as {
        intent_id?: string; provider?: string; saff_reference?: string;
        expected_amount_minor?: number; currency_code?: string;
      };
      const adapter = intentData.provider ? adapterFor(intentData.provider) : null;
      if (adapter && intentData.intent_id && intentData.expected_amount_minor != null && intentData.currency_code) {
        const verifyResult = await adapter.verifyTransactionByReference(
          saffReference,
          BigInt(intentData.expected_amount_minor),
          intentData.currency_code,
        );
        if (verifyResult.verified) {
          const tx = verifyResult.transaction;
          const authority = authoriseCommit(
            {
              id: intentData.intent_id,
              expected_amount_minor: BigInt(intentData.expected_amount_minor),
              currency_code: intentData.currency_code,
              saff_reference: intentData.saff_reference ?? saffReference,
              status,
              expires_at: (responseData as { expires_at?: string }).expires_at ?? new Date().toISOString(),
            },
            tx,
          );
          if (authority.authorised) {
            // Separate, narrowly-scoped service-role client — used ONLY
            // for this one RPC call, on the EXACT intent the owner-scoped
            // read above already resolved. It never performs any other
            // read or write, and never accepts a caller-supplied id that
            // bypassed the ownership check.
            const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY);
            const idempotencyKey = await sha256Hex(
              `STATUS_POLL:${tx.provider}:${tx.providerTransactionId}:${intentData.intent_id}`,
            );
            const { data: commitData, error: commitErr } = await serviceClient.rpc(
              'commit_verified_commercial_payment',
              {
                p_checkout_intent_id:      intentData.intent_id,
                p_provider:                tx.provider,
                p_provider_transaction_id: tx.providerTransactionId,
                p_provider_status:         tx.providerStatus,
                p_normalized_status:       tx.normalizedStatus,
                p_amount_minor:            tx.amountMinor,
                p_currency_code:           tx.currencyCode,
                p_payload_hash:            tx.payloadHash,
                p_verified_at:             tx.verifiedAt,
                p_verification_method:     tx.verificationMethod,
                p_idempotency_key:         idempotencyKey,
                p_saff_reference:          tx.saffReference,
                p_provider_environment:    FLUTTERWAVE_CAPABILITIES.environment,
              },
            );
            if (commitErr) {
              console.error('Status-poll-triggered commit failed', { correlationId, error: commitErr.message });
            } else if ((commitData as { committed?: boolean } | null)?.committed) {
              // Re-read through the SAME owner-scoped RPC so the response
              // reflects the freshly-committed state (licence fields
              // included) rather than patching fields in by hand here.
              const { data: refreshed } = await supabase.rpc('get_checkout_status', {
                p_saff_reference: saffReference,
              });
              if (refreshed) responseData = refreshed;
            }
          }
        }
        // Any other outcome (NOT_FOUND_YET, a genuine verification
        // failure, or an unauthorised result) is deliberately silent here
        // — the customer is still shown their existing non-terminal
        // status and will simply poll again; this is not a public
        // status-check for the CALLER's own request, it is a best-effort
        // opportunistic recovery for a lost/delayed webhook.
      }
    } catch (fallbackErr) {
      // Never let the fallback's own failure break the underlying read
      // this endpoint already successfully produced.
      console.error('Independent status-poll verification threw', { correlationId, error: String(fallbackErr) });
    }
  }

  return new Response(JSON.stringify({ ...responseData, correlationId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
});
