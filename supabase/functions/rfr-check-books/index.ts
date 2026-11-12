/**
 * rfr-check-books — "Check my books": runs the readiness engine over the stored rows of one company and period and records
 * the result (rfr_record_run), which refuses a run made over rows that changed after they were loaded.
 *
 * The caller must be a signed-in member with prepare_close. The engine and all writes run with the service credential; the
 * browser never writes a financial or readiness table. The actor is derived from the JWT here, never taken from the body.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import { runReadinessCheck } from "../_shared/readiness/index.ts";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-cache, no-store" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { outcome: "invalid_request" });
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json(503, { outcome: "not_configured" });
  const service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const bearer = req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  if (!bearer) return json(401, { outcome: "unauthenticated" });
  const { data: who, error: authError } = await service.auth.getUser(bearer);
  if (authError || !who.user) return json(401, { outcome: "unauthenticated" });

  const body = await req.json().catch(() => null) as { companyId?: unknown; periodYear?: unknown } | null;
  const companyId = typeof body?.companyId === "string" && UUID.test(body.companyId) ? body.companyId : null;
  const periodYear = typeof body?.periodYear === "number" && Number.isInteger(body.periodYear) && body.periodYear >= 1990 && body.periodYear <= 2200 ? body.periodYear : null;
  if (!companyId || periodYear === null) return json(400, { outcome: "invalid_request" });

  const allowed = await service.rpc("workspace_capability_allowed", { p_company_id: companyId, p_user: who.user.id, p_capability: "prepare_close" });
  if (allowed.error) return json(503, { outcome: "unavailable" });
  if (allowed.data !== true) return json(403, { outcome: "forbidden" });

  try {
    const r = await runReadinessCheck(service, companyId, periodYear);
    if (r.outcome === "recorded") return json(200, { outcome: "recorded", runId: r.runId, balancesAgree: r.balancesAgree });
    return json(r.outcome === "input_changed" ? 409 : 422, { outcome: r.outcome });
  } catch {
    return json(503, { outcome: "unavailable" });
  }
});
