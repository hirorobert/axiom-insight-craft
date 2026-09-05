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

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

  // 1. Authenticate
  try {
    await validateAuth(req);
  } catch {
    return new Response(JSON.stringify({ error: 'Unauthorized', correlationId }), { status: 401 });
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

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

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
