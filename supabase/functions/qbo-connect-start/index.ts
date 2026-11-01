// qbo-connect-start: begins "Connect QuickBooks" for a workspace (charter B9). An authenticated person asks to connect; the function stores only the SHA-256 of an
// unguessable single-use state (qbo_start_oauth_state, which judges that the person may prepare a trial balance in that workspace) and answers with the authorisation
// address for the browser to open. No token exists yet. See _shared/qboConnect.ts for the flow and _shared/qboEnv.ts for the configuration (secrets are never logged).

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { parseConnectStartRequest, runQboConnectStart } from "../_shared/qboConnect.ts";
import { readQboEnv } from "../_shared/qboEnv.ts";
import { sha256Hex } from "../_shared/qboPullSummary.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { outcome: "invalid_request" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json(503, { outcome: "not_configured" });

  const parsed = parseConnectStartRequest(await req.json().catch(() => null));
  if (!parsed) return json(400, { outcome: "invalid_request" });

  const config = readQboEnv((n) => Deno.env.get(n));
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let actor: string | null = null;

  const result = await runQboConnectStart({
    authenticate: async () => {
      if (!token) return null;
      const { data, error } = await service.auth.getUser(token);
      actor = error ? null : data.user?.id ?? null;
      return actor;
    },
    oauthConfig: (environment) => config.oauth(environment),
    randomState: () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join(""),
    sha256Hex,
    startState: async (stateHash, companyId, actorUserId, environment, ttlSeconds, returnPeriodYear) => {
      const { data, error } = await service.rpc("qbo_start_oauth_state", { p_state_hash: stateHash, p_company_id: companyId, p_actor_user_id: actorUserId, p_environment: environment, p_ttl_seconds: ttlSeconds, p_return_period_year: returnPeriodYear });
      if (error) throw error;
      return data === "created" || data === "forbidden" ? data : "invalid";
    },
  }, parsed).catch(() => ({ status: 500 as const, outcome: "state_failed" as const }));

  // OPERATIONAL LOG: never the state, the hash or the address.
  console.log(JSON.stringify({ event: "qbo.connect_start", company_id: parsed.companyId, period_year: parsed.periodYear, environment: parsed.environment, actor, status: result.status, outcome: result.outcome }));
  const { status, ...body } = result;
  return json(status, body);
});
