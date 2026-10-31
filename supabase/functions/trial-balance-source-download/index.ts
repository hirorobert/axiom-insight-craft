// trial-balance-source-download: lets an AUTHORIZED person retrieve the original file of a trial balance they manage.
//
// The bucket stays private and no client Storage policy is widened (the signer comment in
// trial-balance-source-signer/index.ts explains why clients never touch workspaces/ directly). The caller sends an upload id
// and the company id; the function authenticates the caller, resolves the object path from the upload row, re-authorizes
// with can_user_act_on_workspace on every request (a precheck), signs, and then takes the ISSUANCE DECISION in one database transaction
// (decide_trial_balance_source_download_issuance: locks, authority, freshness and the record). It answers with the signed URL, for exactly that
// object, only if that decision committed as issued. The service-role key never leaves the function. See _shared/sourceDownload.ts for the
// ordering contract and what the record does and does not establish.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { DOWNLOAD_CAPABILITY, parseSourceDownloadRequest, runSourceDownload, signedUrlExpiryMs, storageErrorIsMissingObject, type UploadTarget } from "../_shared/sourceDownload.ts";

const BUCKET = "trial-balance-files";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { outcome: "invalid_request" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json(503, { outcome: "signing_failed" });

  const parsed = parseSourceDownloadRequest(await req.json().catch(() => null));
  if (!parsed) return json(400, { outcome: "invalid_request" });

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let actor: string | null = null;

  const result = await runSourceDownload({
    authenticate: async () => {
      if (!token) return null;
      const { data, error } = await service.auth.getUser(token);
      actor = error ? null : data.user?.id ?? null;
      return actor;
    },
    resolveUpload: async (uploadId) => {
      const { data, error } = await service.from("trial_balance_uploads")
        .select("id, company_id, user_id, file_path, file_name, file_size, source_file_hash").eq("id", uploadId).maybeSingle();
      if (error) throw error;
      return (data as UploadTarget | null) ?? null;
    },
    canDownload: async (userId, companyId) => {
      const { data, error } = await service.rpc("can_user_act_on_workspace", { p_user_id: userId, p_company_id: companyId, p_capability: DOWNLOAD_CAPABILITY });
      return !error && data === true;
    },
    sign: async (path, seconds, downloadName) => {
      const { data, error } = await service.storage.from(BUCKET).createSignedUrl(path, seconds, { download: downloadName });
      if (error) return storageErrorIsMissingObject((error as { message?: string }).message) ? { missing: true as const } : null;
      return data?.signedUrl ? { url: data.signedUrl, expiresAtMs: signedUrlExpiryMs(data.signedUrl) } : null;
    },
    // THE ISSUANCE DECISION: one database transaction (locks, authority, freshness, record). Throws when it cannot be taken or stored; no link is returned then.
    decide: async (r) => {
      const { data, error } = await service.rpc("decide_trial_balance_source_download_issuance", {
        p_user_id: r.userId, p_company_id: r.companyId, p_upload_id: r.uploadId, p_signing_started_at: r.signingStartedAt, p_signing_completed_at: r.signingCompletedAt,
        p_link_lifetime_seconds: r.linkLifetimeSeconds, p_link_expiry_exact_at: r.linkExpiryExactAt, p_min_remaining_seconds: r.minRemainingSeconds, p_object_sha256: r.sha256,
      });
      const outcome = (data as { outcome?: string } | null)?.outcome;
      if (error || !outcome) throw new Error("issuance decision unavailable");
      if (outcome === "issued" || outcome === "withdrawn_before_issue" || outcome === "expired_before_issue" || outcome === "unavailable") return outcome;
      throw new Error("issuance decision refused its inputs");
    },
    // A precheck refusal (best effort; the refusal stands without it). Never the URL or token.
    recordDenial: async (e) => {
      await service.rpc("record_trial_balance_source_download_denial", { p_user_id: e.userId, p_company_id: e.companyId, p_upload_id: e.uploadId, p_object_sha256: e.sha256 });
    },
  }, parsed).catch(() => ({ status: 500, outcome: "signing_failed" as const }));

  // OPERATIONAL LOG, not the audit record (that is the table above): one structured line per request, never the URL or token.
  console.log(JSON.stringify({ event: "trial_balance.source_download", upload_id: parsed.uploadId, company_id: parsed.companyId, actor, status: result.status, outcome: result.outcome }));
  const { status, ...body } = result;
  return json(status, body);
});
