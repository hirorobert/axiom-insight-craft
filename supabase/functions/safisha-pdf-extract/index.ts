/**
 * safisha-pdf-extract · IRON DOME NUCLEAR DESIGN · Deno Edge Function
 *
 * Thin proxy: receives a PDF bank statement from the browser,
 * forwards to the Python Cloud Run worker (`SAFISHA_PDF_WORKER_URL`),
 * receives canonical row data, then hands off to safisha-ingest as `parsed_rows`.
 *
 * This function never stores the raw PDF.
 * The PDF bytes travel: Browser → Edge Function → Cloud Run → /dev/null.
 * Only the extracted row JSON proceeds into the Safisha pipeline.
 *
 * IRON DOME:
 *   - Auth is verified here AND re-verified in the Cloud Run worker.
 *   - The JWT forwarded to Cloud Run is the USER's own token — not a service key.
 *   - parsed_rows are passed as JSON to safisha-ingest (same path as CSV).
 *   - No rows written here — all writes remain inside safisha-ingest.
 *
 * POST /functions/v1/safisha-pdf-extract
 * Body: multipart/form-data
 *   upload_id:    string    (existing trial_balance_uploads.id)
 *   source_type:  string    ('bank' | 'momo' | 'subledger', default 'bank')
 *   file:         File      (.pdf)
 *   password?:    string    (optional: password for encrypted PDF)
 *
 * Response: same shape as safisha-ingest (success | needs_mapping | error)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");

  try {
    // ── Auth ────────────────────────────────────────────────────────────────

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader! } } }
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Parse multipart ─────────────────────────────────────────────────────

    const form       = await req.formData();
    const uploadId   = form.get("upload_id") as string | null;
    const sourceType = (form.get("source_type") as string) || "bank";
    const file       = form.get("file") as File | null;
    const password   = form.get("password") as string | null;

    if (!uploadId || !file) {
      return new Response(JSON.stringify({ error: "upload_id and file are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return new Response(JSON.stringify({
        error: "This endpoint only accepts PDF files. "
               + "For CSV/Excel files use safisha-ingest directly.",
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Forward to Cloud Run PDF worker ─────────────────────────────────────

    const workerUrl = Deno.env.get("SAFISHA_PDF_WORKER_URL");
    if (!workerUrl) {
      return new Response(JSON.stringify({
        error: "SAFISHA_PDF_WORKER_URL env var is not set. "
               + "Deploy the safisha-pdf-worker to Cloud Run and set this secret.",
      }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Build multipart form for Cloud Run
    const workerForm = new FormData();
    workerForm.append("file",        file);
    workerForm.append("source_type", sourceType);
    if (password) workerForm.append("password", password);

    const workerResp = await fetch(`${workerUrl}/extract`, {
      method:  "POST",
      headers: { Authorization: authHeader! },  // pass user JWT — worker re-verifies
      body:    workerForm,
    });

    if (!workerResp.ok) {
      const errBody = await workerResp.json().catch(() => ({ detail: workerResp.statusText }));
      const detail  = errBody.detail ?? JSON.stringify(errBody);
      return new Response(JSON.stringify({
        error:        "PDF extraction worker failed",
        worker_error: detail,
        status:       workerResp.status,
      }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const workerResult = await workerResp.json();
    // workerResult = { rows, row_count, source_type, filename, sha256_source, pages_parsed, warnings }

    if (!workerResult.rows || workerResult.rows.length < 2) {
      return new Response(JSON.stringify({
        error:    "PDF worker returned no rows",
        warnings: workerResult.warnings ?? [],
      }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Hand off to safisha-ingest via parsed_rows ───────────────────────────
    //
    // We call safisha-ingest as an internal Supabase function invocation.
    // This keeps all DB writes inside safisha-ingest (single write path).
    // We pass `parsed_rows` as JSON (same as the XLSX fallback path).

    const ingestForm = new FormData();
    ingestForm.append("upload_id",    uploadId);
    ingestForm.append("source_type",  sourceType);
    ingestForm.append("parsed_rows",  JSON.stringify(workerResult.rows));

    // Use a synthetic "file" so safisha-ingest has a filename for evidence tracking
    const syntheticFile = new File([""], workerResult.filename ?? file.name, { type: "text/csv" });
    ingestForm.append("file", syntheticFile);

    const ingestUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/safisha-ingest`;
    const ingestResp = await fetch(ingestUrl, {
      method:  "POST",
      headers: { Authorization: authHeader! },
      body:    ingestForm,
    });

    const ingestResult = await ingestResp.json();

    // Enrich response with PDF metadata
    return new Response(JSON.stringify({
      ...ingestResult,
      pdf_metadata: {
        pages_parsed:   workerResult.pages_parsed,
        rows_extracted: workerResult.row_count,
        sha256_source:  workerResult.sha256_source,
        warnings:       workerResult.warnings ?? [],
      },
    }), {
      status:  ingestResp.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("safisha-pdf-extract error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
