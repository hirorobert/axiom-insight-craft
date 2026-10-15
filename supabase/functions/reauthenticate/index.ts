// ============================================================
// reauthenticate — recent-reauthentication gate for privileged access-administration actions
//
// Platform-owner grant/revoke RPCs require a FRESH reauthentication (directive §7). This function:
//   1. Identifies the caller from their JWT (never trusts a client-supplied identity).
//   2. Re-verifies the caller's PASSWORD server-side via signInWithPassword on their own email.
//      The password is read once, used once, and NEVER logged. The throwaway session is discarded.
//   3. On success, mints a short-lived (5-minute) single-use nonce via record_privileged_reauth (service role).
//   4. Returns { nonce, expires_in }. The client passes that nonce to the next privileged RPC, which consumes it.
//
// MFA note: if Supabase MFA (AAL2) is enabled for the project, the privileged RPCs also accept an aal2 JWT claim and
// this nonce step becomes optional — see docs/owner-access/DESIGN.md §4.6. No password or nonce is ever logged.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";

    // Caller client identifies the signed-in user from their JWT.
    const caller = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await caller.auth.getUser();
    if (authErr || !user?.id || !user.email) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({})) as { password?: string };
    const password = body.password;
    if (!password || typeof password !== "string") return json({ error: "PASSWORD_REQUIRED" }, 400);

    // Re-verify the password server-side on a throwaway client; discard the session. Never log the password.
    const verifier = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error: pwErr } = await verifier.auth.signInWithPassword({ email: user.email, password });
    if (pwErr) return json({ error: "REAUTH_FAILED" }, 401);
    await verifier.auth.signOut().catch(() => {});

    // Mint a high-entropy single-use nonce (5-minute TTL).
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const ttl = 300;

    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error: rpcErr } = await admin.rpc("record_privileged_reauth", { p_user: user.id, p_nonce: nonce, p_ttl_seconds: ttl });
    if (rpcErr) return json({ error: "REAUTH_MINT_FAILED" }, 500);

    return json({ nonce, expires_in: ttl });
  } catch (_e) {
    // Never include the request body (which carries the password) in any error surface or log.
    return json({ error: "REAUTH_ERROR" }, 500);
  }
});
