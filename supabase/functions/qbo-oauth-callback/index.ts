// qbo-oauth-callback: where Intuit sends the browser back after the person approves (or declines) the connection (charter B9).
//
// THERE IS NO LOGIN ON THIS REQUEST (a browser redirect from another site carries no Supabase token), so verify_jwt is false for this function in config.toml and
// the single-use state is the only credential. The state proves who STARTED the attempt, not who approved it, so NOTHING IS EXCHANGED HERE (review r2, S4): the
// authorisation code is sealed and parked with the state (qbo_record_oauth_return, which consumes the state exactly once), and the browser is sent back to the app
// with a one-time handoff code in the address fragment. The app, signed in, finishes through qbo-finish-connection, which exchanges the code only for the person
// who started. A decline or an unusable return comes back as a status word. An unknown, expired or used state is a plain 400.
// This function never calls Intuit. See _shared/qboConnect.ts. The service-role key and every secret stay inside the function and are never logged.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseCallbackQuery, runQboCallback } from "../_shared/qboConnect.ts";
import { readQboEnv } from "../_shared/qboEnv.ts";
import { sha256Hex } from "../_shared/qboPullSummary.ts";
import { sealSecret } from "../_shared/qboTokenEnvelope.ts";

const noStore = { "Cache-Control": "no-cache, no-store", "Referrer-Policy": "no-referrer" };
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

  const result = await runQboCallback({
    sha256Hex,
    randomHandoff: () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join(""),
    sealCode: (code, binding) => sealSecret(code, keys.current, binding),
    recordReturn: async (stateHash, parked) => {
      const { data, error } = await service.rpc("qbo_record_oauth_return", {
        p_state_hash: stateHash, p_realm_id: parked?.realmId ?? null, p_code_envelope: parked?.codeEnvelope ?? null, p_handoff_hash: parked?.handoffHash ?? null,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : null;
      return row ? { companyId: row.company_id as string, environment: row.environment as "production" | "sandbox", returnPeriodYear: Number(row.return_period_year) } : null;
    },
    // The handoff travels ONLY in the fragment: a browser never sends it to a server, so it is in no Referer and no access log. A status word is a plain query.
    returnTo: (companyId, periodYear, back) =>
      `${appUrl}/workspace/${companyId}/${periodYear}/trial-balance/review${"handoff" in back ? `#qbo_handoff=${back.handoff}` : `?qbo=${back.status}`}`,
  }, parseCallbackQuery(new URL(req.url).searchParams)).catch(() => ({ status: 400 as const, outcome: "invalid_request" as const }));

  // OPERATIONAL LOG: never the code, the state, the handoff, a token or an envelope.
  console.log(JSON.stringify({ event: "qbo.oauth_callback", status: result.status, outcome: result.outcome }));
  if (result.status === 302) return new Response(null, { status: 302, headers: { ...noStore, Location: result.location } });
  return plain(400, "This link is not valid or has expired. Start the connection again from the app.");
});
