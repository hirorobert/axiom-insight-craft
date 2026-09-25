// seal-reporting-pack — the only way a Reporting Pack file becomes OFFICIAL (security correction B-4).
//
// POST multipart/form-data: issuance_id, company_id, period_year, pack_kind, output_ref, file (the exact bytes).
//   → the server hashes the received bytes, stores them (private bucket, no overwrite) and seals the issuance.
// POST application/json { action: "verify", issuance_id }
//   → re-hashes the stored object: intact | substituted | missing | not_found (workspace access required).
// The user id comes from the verified JWT only. No client-supplied hash is accepted anywhere.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { MAX_PACK_BYTES, sealPack, verifyStoredPack, type SealDeps } from "../_shared/reportingPackSeal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { outcome: "invalid_request" });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user }, error: authErr } = await caller.auth.getUser();
    if (authErr || !user) return json(401, { outcome: "unauthenticated" });

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });
    const bucket = admin.storage.from("reporting-packs");
    const deps: SealDeps = {
      rpc: (fn, args) => admin.rpc(fn, args),
      put: async (path, bytes, contentType) => ({ error: (await bucket.upload(path, bytes, { contentType, upsert: false })).error }),
      remove: (path) => bucket.remove([path]),
      get: async (path) => {
        const { data, error } = await bucket.download(path);
        return error || !data ? null : new Uint8Array(await data.arrayBuffer());
      },
      sha256Hex: async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map((b) => b.toString(16).padStart(2, "0")).join(""),
    };

    const type = req.headers.get("content-type") ?? "";
    if (type.startsWith("application/json")) {
      const body = await req.json().catch(() => ({})) as { action?: string; issuance_id?: string };
      if (body.action !== "verify") return json(400, { outcome: "invalid_request" });
      const r = await verifyStoredPack(deps, String(body.issuance_id ?? ""));
      if (!r.company_id) return json(404, { outcome: "not_found" });
      // Anyone with access to the workspace may verify (also after the plan has ended); others learn nothing.
      const { data: access } = await admin.rpc("authorize_paid_action_for_user", { p_user: user.id, p_company_id: r.company_id, p_capability: "CLOSE_ASSURANCE" });
      const code = (access as { code?: string } | null)?.code;
      if (!code || code === "WORKSPACE_ACCESS_DENIED" || code === "UNAUTHENTICATED") return json(404, { outcome: "not_found" });
      return json(200, { outcome: r.outcome });
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size > MAX_PACK_BYTES) return json(400, { outcome: "invalid_request" });
    const result = await sealPack(deps, {
      userId: user.id,
      issuanceId: String(form.get("issuance_id") ?? ""),
      companyId: String(form.get("company_id") ?? ""),
      periodYear: Number(form.get("period_year")),
      packKind: String(form.get("pack_kind") ?? ""),
      outputRef: String(form.get("output_ref") ?? ""),
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return json(result.httpStatus, result.body);
  } catch (err) {
    console.error("seal-reporting-pack error:", (err as Error)?.message ?? "unknown");
    return json(500, { outcome: "seal_failed" });
  }
});
