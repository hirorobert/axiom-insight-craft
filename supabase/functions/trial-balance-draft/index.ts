// trial-balance-draft: a trial balance stored privately as a draft before it belongs to an entity (Phase 2 P2-2,
// migration 20261106100000).
//
//   sign    a short-lived, single-object signed upload URL for the caller's own reserved draft
//           (drafts/<owner>/<draft>/<name>); the draft was reserved by reserve_trial_balance_draft().
//   commit  adds the draft to an entity: the caller's current authority is re-checked, the workspace reservation and
//           the registration run AS THE USER through the existing workspace functions, the file is copied to the
//           workspace object and its bytes verified; every step is recorded and resumable.
//   cancel  cancels a commit that was never registered.
//
// The service-role key never leaves the function and no client Storage policy is widened. See _shared/draftUpload.ts
// for the decision sequence.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import { DRAFT_CAPABILITY, parseDraftRequest, runDraftRequest, type BeginResult } from "../_shared/draftUpload.ts";

const BUCKET = "trial-balance-files";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const first = <T>(data: unknown): T | null => ((Array.isArray(data) ? data[0] : data) as T | undefined) ?? null;
const fail = (error: { code?: string; message?: string } | null) => { if (error) throw Object.assign(new Error(error.message ?? "rpc failed"), { code: error.code }); };
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { outcome: "invalid_request" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !serviceKey || !anonKey) return json(503, { outcome: "drafts_unavailable" });

  const parsed = parseDraftRequest(await req.json().catch(() => null));
  if (!parsed) return json(400, { outcome: "invalid_request" });

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  // The caller's own session: workspace reservation and registration are decided by the database as this user.
  const asUser = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
  const storage = service.storage.from(BUCKET);

  const result = await runDraftRequest({
    authenticate: async () => {
      if (!token) return null;
      const { data, error } = await service.auth.getUser(token);
      return error ? null : data.user?.id ?? null;
    },
    signTarget: async (draftId, userId) => {
      const { data, error } = await service.rpc("tbd_sign_target", { p_draft_id: draftId, p_user_id: userId });
      fail(error); return first(data);
    },
    signUpload: async (path) => {
      const { data, error } = await storage.createSignedUploadUrl(path);
      return error || !data ? null : { path: data.path, token: data.token };
    },
    canManage: async (userId, companyId) => {
      const { data, error } = await service.rpc("can_user_act_on_workspace", { p_user_id: userId, p_company_id: companyId, p_capability: DRAFT_CAPABILITY });
      fail(error); return data === true;
    },
    beginCommit: async (userId, r) => {
      const { data, error } = await service.rpc("tbd_begin_commit", {
        p_draft_id: r.draftId, p_user_id: userId, p_commit_key: r.commitKey, p_company_id: r.companyId, p_period_year: r.periodYear,
        p_period_id: r.periodId, p_engagement_id: r.engagementId, p_confirmation: r.confirmation,
      });
      fail(error); return first<BeginResult>(data) ?? ({ outcome: "not_found" } as BeginResult);
    },
    reserveSource: async (companyId, fileName) => {
      const { data, error } = await asUser.rpc("reserve_trial_balance_source", { p_company_id: companyId, p_file_name: fileName });
      fail(error); return first(data) ?? { outcome: "invalid_request", reservation_id: null, object_path: null };
    },
    recordReservation: async (commitId, userId, reservationId) => {
      const { data, error } = await service.rpc("tbd_record_commit_reservation", { p_commit_id: commitId, p_user_id: userId, p_reservation_id: reservationId });
      fail(error); return String(data);
    },
    reservationPath: async (reservationId) => {
      const { data, error } = await service.rpc("tbu_source_reservation_target", { p_reservation_id: reservationId });
      fail(error); return first<{ object_path: string }>(data)?.object_path ?? null;
    },
    readObject: async (path) => {
      const { data, error } = await storage.download(path);
      if (error) {
        const status = (error as { status?: number; statusCode?: string | number }).status ?? Number((error as { statusCode?: string | number }).statusCode);
        if (status === 400 || status === 404) return null; // absent
        throw error;
      }
      return new Uint8Array(await data.arrayBuffer());
    },
    copyObject: async (from, to) => {
      const { error } = await storage.copy(from, to);
      return !error;
    },
    removeObject: async (path) => {
      const { error } = await storage.remove([path]);
      return !error;
    },
    // Every byte array here comes from Blob.arrayBuffer() (never a SharedArrayBuffer); narrowing avoids copying up to 50 MB.
    sha256: async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
    recordCopyVerified: async (commitId, userId, sha, size) => {
      const { data, error } = await service.rpc("tbd_record_copy_verified", { p_commit_id: commitId, p_user_id: userId, p_copy_sha256: sha, p_copy_size: size });
      fail(error); return String(data);
    },
    register: async (reservationId, size, periodYear, periodId, engagementId) => {
      const { data, error } = await asUser.rpc("register_trial_balance_upload", {
        p_reservation_id: reservationId, p_file_size: size, p_period_year: periodYear, p_period_id: periodId, p_engagement_id: engagementId,
      });
      fail(error); return first(data) ?? { outcome: "invalid_request", upload_id: null, detail: null };
    },
    finish: async (commitId, userId, uploadId) => {
      const { data, error } = await service.rpc("tbd_finish_commit", { p_commit_id: commitId, p_user_id: userId, p_upload_id: uploadId });
      fail(error); return String(data);
    },
    rejectDraft: async (draftId, userId) => {
      const { data, error } = await service.rpc("tbd_reject_draft", { p_draft_id: draftId, p_user_id: userId });
      fail(error); return String(data);
    },
    cancelCommit: async (commitId, userId) => {
      const { data, error } = await service.rpc("tbd_cancel_commit", { p_commit_id: commitId, p_user_id: userId });
      fail(error); return String(data);
    },
  }, parsed);

  // Ids and outcomes only: never a file name, a path or a token.
  console.log(JSON.stringify({ event: "trial_balance.draft", action: parsed.action, status: result.status, outcome: result.outcome, retryable: result.retryable ?? false }));
  const { token: signedToken, path, ...rest } = result;
  return json(result.status, parsed.action === "sign" ? { ...rest, path, token: signedToken } : rest);
});
