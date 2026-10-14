/**
 * commercial-provider-diagnostics — administrator-only, read-only: whether each payment provider's settings are
 * complete. Returns setting NAMES only, never values. Says nothing about provider acceptance, merchant approval or
 * whether checkout is open (that is the platform state and the checkout resolver). Writes nothing.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { validateAuth } from '../_shared/auth.ts';
import { generateCorrelationId } from '../_shared/correlationId.ts';
import { providerConfigDiagnostics } from '../_shared/payments/routing.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const correlationId = generateCorrelationId();
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'GET') return json({ error: 'Method not allowed', correlationId }, 405);

  const authHeader = req.headers.get('Authorization');
  const { result, error } = await validateAuth(authHeader, CORS_HEADERS);
  if (error || !result) return json({ error: 'Unauthorized', correlationId }, 401);

  // Active commercial administrator, decided by the database for the caller's own session.
  const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader! } },
  });
  const { data: isAdmin, error: adminErr } = await asCaller.rpc('is_commercial_admin');
  if (adminErr) return json({ error: 'ADMIN_CHECK_FAILED', correlationId }, 500);
  if (isAdmin !== true) return json({ error: 'NOT_A_COMMERCIAL_ADMIN', correlationId }, 403);

  return json({ providers: providerConfigDiagnostics((n) => Deno.env.get(n)), correlationId }, 200);
});
