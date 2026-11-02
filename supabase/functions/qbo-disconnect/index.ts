import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import { parseDisconnectRequest, runQboDisconnect } from "../_shared/qboDisconnect.ts";
import { readQboEnv } from "../_shared/qboEnv.ts";
import { openSecret } from "../_shared/qboTokenEnvelope.ts";
import { createGuardedQboFetch, QBO_REVOKE_URL } from "../_shared/qboReadOnlyGuard.ts";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });
Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { outcome: "invalid_request" });
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json(503, { outcome: "not_configured" });
  const service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const bearer = req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  const config = readQboEnv(n => Deno.env.get(n));
  const fetcher = createGuardedQboFetch((u, init) => fetch(u, init));
  const result = await runQboDisconnect({
    authenticate: async () => {
      if (!bearer) return null;
      const { data, error } = await service.auth.getUser(bearer); return error ? null : data.user?.id ?? null;
    },
    begin: async (id, actor, request) => {
      const { data, error } = await service.rpc("qbo_begin_disconnect", { p_connection: id, p_actor: actor, p_request: request });
      if (error) throw new Error("disconnect_unconfirmed"); return data;
    },
    open: async (envelope, binding) => {
      const keys = config.keys(); if (!keys) return null;
      try { return await openSecret(envelope, keys.all, binding); } catch { return null; }
    },
    revoke: async (environment, token) => {
      const creds = config.credentials(environment); if (!creds) return false;
      const response = await fetcher({ method: "POST", url: QBO_REVOKE_URL, headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}` }, body: JSON.stringify({ token }) });
      await response.body?.cancel(); return response.status === 200;
    },
    finish: async (id, actor, request, lease) => {
      const { data, error } = await service.rpc("qbo_finish_disconnect", { p_connection: id, p_actor: actor, p_request: request, p_lease: lease }); return !error && data === true;
    },
  }, parseDisconnectRequest(await req.json().catch(() => null))).catch(() => ({ status: 503, outcome: "disconnect_unconfirmed" }));
  return json(result.status, { outcome: result.outcome });
});