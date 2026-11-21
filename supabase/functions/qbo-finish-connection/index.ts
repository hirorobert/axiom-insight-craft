// qbo-finish-connection: the last step of "Connect QuickBooks" (charter B9; review r2, S4). The app, signed in, hands back the one-time handoff code the callback put in
// the address fragment. The person is derived from their login (verify_jwt = true, and getUser again here), never from the request. qbo_take_oauth_return gives the
// parked, sealed authorisation code back only if that person is the one who STARTED the attempt, the handoff has not expired and they still hold both rights; every
// answer ends the handoff. Only then is the code exchanged through the read-only guard, the refresh token sealed (bound to workspace + environment + realm) and only
// the envelope stored (qbo_store_connection, which judges the right again). See _shared/qboConnect.ts. The service-role key and every secret stay inside the
// function and are never logged. realmID protection (Intuit case 00232331; after the cutover): the parked realm is read ONLY by opening its envelope and the
// connection is stored with the realm sealed to the workspace and environment plus its keyed index, never in clear; without the realm index key the function
// answers "not configured".

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import { isRotationRefusal, parseFinishRequest, QboRotationInProgress, runQboFinish, type TakenReturn } from "../_shared/qboConnect.ts";
import { readQboEnv } from "../_shared/qboEnv.ts";
import { createGuardedQboFetch } from "../_shared/qboReadOnlyGuard.ts";
import { sha256Hex } from "../_shared/qboPullSummary.ts";
import { createQboTokenClient } from "../_shared/qboTokenClient.ts";
import { openSecret, sealSecret } from "../_shared/qboTokenEnvelope.ts";
import { openParkedRealm, protectRealm, realmIndex } from "../_shared/qboRealmProtection.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-cache, no-store" } });
const REFUSED = new Set(["not_yours", "expired", "forbidden", "unknown"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { outcome: "invalid_request" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const config = readQboEnv((n) => Deno.env.get(n));
  const keys = config.keys();
  const realmKeys = config.realmKeys();
  if (!url || !serviceKey || !keys || !realmKeys) return json(503, { outcome: "not_configured" });

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
      if (row?.outcome === "taken" && row.company_id && row.realm_envelope && row.realm_index && row.code_envelope && (row.environment === "production" || row.environment === "sandbox")) {
        return {
          outcome: "taken", companyId: row.company_id as string, environment: row.environment, codeEnvelope: row.code_envelope as string,
          realmId: (row.realm_id as string | null) ?? null, realmEnvelope: (row.realm_envelope as string | null) ?? null, realmIndex: (row.realm_index as string | null) ?? null,
        };
      }
      return { outcome: REFUSED.has(row?.outcome) ? row.outcome : "unknown" } as TakenReturn;
    },
    openCode: async (envelope, binding) => { try { return await openSecret(envelope, keys.all, binding); } catch { return null; } },
    openParkedRealm: async (envelope, handoffHash) => { try { return await openParkedRealm(envelope, handoffHash, realmKeys.all); } catch { return null; } },
    realmIndex: (realmId, environment) => realmIndex(realmId, environment, realmKeys.index),
    protectRealm: (realmId, environment, companyId) => protectRealm(realmId, environment, companyId, realmKeys),
    oauthConfig: (environment) => config.oauth(environment),
    exchangeCode: async (environment, code, redirectUri) => {
      const creds = config.credentials(environment);
      return creds ? await createQboTokenClient(guardedFetch, creds).exchangeCode(code, redirectUri) : { ok: false as const, reason: "rejected" as const };
    },
    sealRefreshToken: (refreshToken, binding) => sealSecret(refreshToken, keys.current, binding),
    storeConnection: async (companyId, actorUserId, environment, envelope, refreshExpiresAt, hardExpiresAt, realm) => {
      const { data, error } = await service.rpc("qbo_store_connection", {
        p_company_id: companyId, p_actor_user_id: actorUserId, p_realm_id: null, p_environment: environment, p_envelope: envelope,
        p_refresh_expires_at: refreshExpiresAt, p_hard_expires_at: hardExpiresAt, p_realm_envelope: realm.envelope, p_realm_index: realm.index,
      });
      if (isRotationRefusal(error)) throw new QboRotationInProgress();
      if (error || typeof data !== "string") throw new Error("connection not stored");
      return data;
    },
  }, parsed).catch(() => ({ status: 500 as const, outcome: "failed" as const }));

  // OPERATIONAL LOG: never the handoff, the code, a token or an envelope.
  console.log(JSON.stringify({ event: "qbo.finish_connection", status: result.status, outcome: result.outcome }));
  const { status, ...body } = result;
  return json(status, body);
});
