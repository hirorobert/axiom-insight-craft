// trial-balance-storage-cleanup: completes an AUTHORIZED source-file removal for a trial balance upload
// operation, whichever authorized user originally uploaded the file. That is a cancelled replacement (at once),
// or a discarded source once the discard is terminal (undo window over, not restored), i.e. the purge.
//
// Storage RLS lets only the uploader delete from their own folder, so a workspace owner (or a collaborator
// holding manage_source_files) cannot remove a file another authorized user uploaded. This function closes
// that gap without trusting the client. The caller sends only an operation id. The function authenticates the
// caller and resolves the operation, workspace and bound Storage path server-side. It authorizes with
// can_user_act_on_workspace (ownership or explicit grant, never a title), deletes exactly that object with
// the service role, verifies it is gone, and then completes the database operation AS THE CALLER, so the
// database re-authorizes and re-reads Storage itself.
// See _shared/storageCleanup.ts for the decision sequence and its guarantees.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { CLEANUP_CAPABILITY, parseCleanupRequest, runStorageCleanup, type CleanupTarget } from "../_shared/storageCleanup.ts";

const BUCKET = "trial-balance-files";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { outcome: "invalid_request" });

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return json(503, { outcome: "completion_failed" });

  const parsed = parseCleanupRequest(await req.json().catch(() => null));
  if (!parsed) return json(400, { outcome: "invalid_request" });

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const service = createClient(url, serviceKey, opts);
  const asCaller = createClient(url, anonKey, { ...opts, global: { headers: { Authorization: authHeader } } });

  const result = await runStorageCleanup({
    authenticate: async () => {
      if (!token) return null;
      const { data, error } = await service.auth.getUser(token);
      return error ? null : data.user?.id ?? null;
    },
    resolveTarget: async (operationId) => {
      const { data, error } = await service.rpc("tbu_storage_cleanup_target", { p_operation_id: operationId });
      if (error) throw error;
      return ((Array.isArray(data) ? data[0] : data) as CleanupTarget | undefined) ?? null;
    },
    canManage: async (userId, companyId) => {
      const { data, error } = await service.rpc("can_user_act_on_workspace", { p_user_id: userId, p_company_id: companyId, p_capability: CLEANUP_CAPABILITY });
      return !error && data === true;
    },
    removeObject: async (path) => {
      const { error } = await service.storage.from(BUCKET).remove([path]);
      return { ok: !error };
    },
    objectExists: async (path) => {
      const { data, error } = await service.rpc("tbu_storage_object_exists", { p_path: path });
      return error ? true : data === true; // an unreadable answer is treated as "still there"
    },
    completeAsCaller: async (kind, operationId) => {
      const fn = kind === "discard" ? "purge_trial_balance_discard" : "confirm_trial_balance_storage_cleanup";
      const { data, error } = await asCaller.rpc(fn, { p_operation_id: operationId });
      if (error) return null;
      const row = Array.isArray(data) ? data[0] : data;
      return row?.outcome ? { outcome: String(row.outcome) } : null;
    },
    claimAsCaller: async (operationId) => {
      const { data, error } = await asCaller.rpc("claim_trial_balance_discard_purge", { p_operation_id: operationId });
      if (error) return null;
      const row = Array.isArray(data) ? data[0] : data;
      return row?.outcome ? { outcome: String(row.outcome) } : null;
    },
  }, parsed.operationId).catch(() => ({ status: 500, outcome: "completion_failed" as const }));

  console.log(JSON.stringify({ event: "trial_balance.storage_cleanup", operation_id: parsed.operationId, status: result.status, outcome: result.outcome }));
  return json(result.status, { outcome: result.outcome });
});
