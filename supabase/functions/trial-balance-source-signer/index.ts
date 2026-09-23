// trial-balance-source-signer: issues a short-lived, single-object signed upload URL for a trial balance source
// in WORKSPACE-scoped storage (workspaces/<workspace>/<source>/<name>). This is what lets the workspace owner, or a
// collaborator holding manage_source_files, upload a source without the object belonging to their personal
// folder, and without any client Storage policy being widened.
//
// The caller sends only a reservation id, issued by reserve_trial_balance_source() after authorization. The
// function authenticates the caller, resolves the reservation server-side, re-authorizes with
// can_user_act_on_workspace, and signs exactly the reserved path. The object only becomes a trial balance when
// register_trial_balance_upload() or retire_trial_balance_upload() sees it in storage.objects.
// See _shared/sourceUpload.ts for the decision sequence.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { SOURCE_CAPABILITY, parseSourceUploadRequest, runSourceUpload, type ReservationTarget } from "../_shared/sourceUpload.ts";

const BUCKET = "trial-balance-files";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { outcome: "invalid_request" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json(503, { outcome: "signing_failed" });

  const parsed = parseSourceUploadRequest(await req.json().catch(() => null));
  if (!parsed) return json(400, { outcome: "invalid_request" });

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const result = await runSourceUpload({
    authenticate: async () => {
      if (!token) return null;
      const { data, error } = await service.auth.getUser(token);
      return error ? null : data.user?.id ?? null;
    },
    resolveReservation: async (reservationId) => {
      const { data, error } = await service.rpc("tbu_source_reservation_target", { p_reservation_id: reservationId });
      if (error) throw error;
      return ((Array.isArray(data) ? data[0] : data) as ReservationTarget | undefined) ?? null;
    },
    canManage: async (userId, companyId) => {
      const { data, error } = await service.rpc("can_user_act_on_workspace", { p_user_id: userId, p_company_id: companyId, p_capability: SOURCE_CAPABILITY });
      return !error && data === true;
    },
    signUpload: async (path) => {
      const { data, error } = await service.storage.from(BUCKET).createSignedUploadUrl(path);
      return error || !data ? null : { path: data.path, token: data.token };
    },
  }, parsed.reservationId).catch(() => ({ status: 500, outcome: "signing_failed" as const }));

  console.log(JSON.stringify({ event: "trial_balance.source_upload", reservation_id: parsed.reservationId, status: result.status, outcome: result.outcome }));
  return json(result.status, { outcome: result.outcome, path: result.path, token: result.token });
});
