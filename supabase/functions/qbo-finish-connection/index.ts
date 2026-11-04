// qbo-finish-connection: the last step of "Connect QuickBooks" (charter B9; review r2, S4). The app, signed in, hands back the one-time handoff code the callback put in
// the address fragment. The person is derived from their login (verify_jwt = true, and getUser again here), never from the request. qbo_take_oauth_return gives the
// parked, sealed authorisation code back only if that person is the one who STARTED the attempt, the handoff has not expired and they still hold both rights; every
// answer ends the handoff. Only then is the code exchanged through the read-only guard, the refresh token sealed (bound to workspace + environment + realm) and only
// the envelope stored (qbo_store_connection, which judges the right again). See _shared/qboConnect.ts. The service-role key and every secret stay inside the
// function and are never logged.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import { parseFinishRequest, runQboFinish, type TakenReturn } from "../_shared/qboConnect.ts";
import { readQboEnv } from "../_shared/qboEnv.ts";
import { createGuardedQboFetch } from "../_shared/qboReadOnlyGuard.ts";
import { sha256Hex } from "../_shared/qboPullSummary.ts";
import { createQboTokenClient } from "../_shared/qboTokenClient.ts";
import { openSecret, sealSecret } from "../_shared/qboTokenEnvelope.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const REFUSED = new Set(["not_yours", "expired", "forbidden", "unknown"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { outcome: "invalid_request" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const config = readQboEnv((n) => Deno.env.get(n));
  const keys = config.keys();
  if (!url || !serviceKey || !keys) return json(503, { outcome: "not_configured" });

  const parsed = parseFinishRequest(await req.json().catch(() => null));
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const guardedFetch = createGuardedQboFetch((u, init) => fetch(u, init));
  let actor: string | null = null;

  const result = await runQboFinish({
    authenticate: async () => {
      if (!token) return null;
      const { data, error } = await service.auth.getUser(token);
      actor = error ? null : data.user?.id ?? null;
      return actor;
    },
    sha256Hex,
    takeReturn: async (handoffHash, actorUserId): Promise<TakenReturn> => {
      const { data, error } = await service.rpc("qbo_take_oauth_return", { p_handoff_hash: handoffHash, p_actor_user_id: actorUserId });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : null;
      if (row?.outcome === "taken" && row.company_id && row.realm_id && row.code_envelope && (row.environment === "production" || row.environment === "sandbox")) {
        return { outcome: "taken", companyId: row.company_id as string, environment: row.environment, realmId: row.realm_id as string, codeEnvelope: row.code_envelope as string };
      }
      return { outcome: REFUSED.has(row?.outcome) ? row.outcome : "unknown" } as TakenReturn;
    },
    openCode: async (envelope, binding) => { try { return await openSecret(envelope, keys.all, binding); } catch { return null; } },
    oauthConfig: (environment) => config.oauth(environment),
    exchangeCode: async (environment, code, redirectUri) => {
      const creds = config.credentials(environment);
      return creds ? await createQboTokenClient(guardedFetch, creds).exchangeCode(code, redirectUri) : { ok: false as const, reason: "rejected" as const };
    },
    sealRefreshToken: (refreshToken, binding) => sealSecret(refreshToken, keys.current, binding),
    storeConnection: async (companyId, actorUserId, realmId, environment, envelope, refreshExpiresAt, hardExpiresAt) => {
      const { data, error } = await service.rpc("qbo_store_connection", {
        p_company_id: companyId, p_actor_user_id: actorUserId, p_realm_id: realmId, p_environment: environment, p_envelope: envelope,
        p_refresh_expires_at: refreshExpiresAt, p_hard_expires_at: hardExpiresAt,
      });
      if (error || typeof data !== "string") throw new Error("connection not stored");
      return data;
    },
  }, parsed).catch(() => ({ status: 500 as const, outcome: "failed" as const }));

  // OPERATIONAL LOG: never the handoff, the code, a token or an envelope.
  console.log(JSON.stringify({ event: "qbo.finish_connection", status: result.status, outcome: result.outcome }));
  const { status, ...body } = result;
  return json(status, body);
});
