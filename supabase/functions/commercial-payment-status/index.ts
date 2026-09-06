/**
 * commercial-payment-status — Ω2 Edge Function
 *
 * Safe owner-scoped reader for payment return page and billing summary.
 * Returns checkout + licence state without exposing raw provider payloads.
 * Used by the /billing/payment/return page to poll until payment is confirmed.
 *
 * Iron Dome:
 *   - Authenticated only
 *   - Returns UNKNOWN if reference not found (not a 404 — prevents enumeration)
 *   - Never exposes raw provider payload, secrets, or amounts from provider response
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { validateAuth } from '../_shared/auth.ts';
import { generateCorrelationId } from '../_shared/correlationId.ts';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

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

  // 3. Call safe owner-scoped RPC
  const { data, error } = await supabase.rpc('get_checkout_status', {
    p_saff_reference: saffReference,
  });

  if (error) {
    console.error('get_checkout_status failed', { correlationId, error: error.message });
    return new Response(JSON.stringify({
      found: false, status: 'UNKNOWN', correlationId,
    }), { status: 200 });
  }

  return new Response(JSON.stringify({ ...(data ?? {}), correlationId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
});
