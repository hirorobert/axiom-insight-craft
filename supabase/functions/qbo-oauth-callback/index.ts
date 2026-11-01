// qbo-oauth-callback: where Intuit sends the browser back after the person approves (or declines) the connection (charter B9).
//
// THERE IS NO LOGIN ON THIS REQUEST (a browser redirect from another site carries no Supabase token), so verify_jwt is false for this function in config.toml and
// the single-use state is the only credential: it is consumed first (qbo_consume_oauth_state: unused, unexpired, the person still holds the right), the code is
// exchanged through the read-only guard, the refresh token is sealed (AES-256-GCM, bound to workspace + environment + realm) and only the envelope is stored. The browser
// is sent back to the app with a status word and nothing else: never the code, the state or a token. An unknown, expired or used state is a plain 400.
// See _shared/qboConnect.ts. The service-role key and every secret stay inside the function and are never logged.

import { createClient } from "npm:@supabase/supabase-js@2";
import { parseCallbackQuery, runQboCallback } from "../_shared/qboConnect.ts";
import { readQboEnv } from "../_shared/qboEnv.ts";
import { createGuardedQboFetch } from "../_shared/qboReadOnlyGuard.ts";
import { sha256Hex } from "../_shared/qboPullSummary.ts";
import { createQboTokenClient } from "../_shared/qboTokenClient.ts";
import { sealSecret } from "../_shared/qboTokenEnvelope.ts";

const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const plain = (status: number, text: string) => new Response(text, { status, headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });

Deno.serve(async (req) => {
  if (req.method !== "GET") return plain(405, "Not allowed.");

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const config = readQboEnv((n) => Deno.env.get(n));
  const appUrl = config.appUrl();
  const keys = config.keys();
  if (!url || !serviceKey || !appUrl || !keys) return plain(503, "QuickBooks connection is not configured.");

  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const guardedFetch = createGuardedQboFetch((u, init) => fetch(u, init));

  const result = await runQboCallback({
    sha256Hex,
    consumeState: async (stateHash) => {
      const { data, error } = await service.rpc("qbo_consume_oauth_state", { p_state_hash: stateHash });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : null;
      return row ? { companyId: row.company_id as string, actorUserId: row.actor_user_id as string, environment: row.environment as "production" | "sandbox", returnPeriodYear: Number(row.return_period_year) } : null;
    },
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
    returnTo: (companyId, periodYear, status) => `${appUrl}/workspace/${companyId}/${periodYear}/trial-balance/review?qbo=${status}`,
  }, parseCallbackQuery(new URL(req.url).searchParams)).catch(() => ({ status: 400 as const, outcome: "invalid_request" as const }));

  // OPERATIONAL LOG: never the code, the state, a token or an envelope.
  console.log(JSON.stringify({ event: "qbo.oauth_callback", status: result.status, outcome: result.outcome, connection_id: "connectionId" in result ? result.connectionId : undefined }));
  if (result.status === 302) return new Response(null, { status: 302, headers: { ...noStore, Location: result.location } });
  return plain(400, "This link is not valid or has expired. Start the connection again from the app.");
});
