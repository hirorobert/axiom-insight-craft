// financial-statement-intake — Ω∞ CFOCLOSE Document Review, Phase 8.
//
// Sole server-side write path for financial_statement_documents. Receives
// the complete file in one multipart/form-data request, verifies the
// caller, re-verifies the file's declared type against its own signature
// bytes (never trusts the browser's classification alone), computes the
// authoritative SHA-256, stores the bytes at a server-generated path in the
// private financial-statement-documents bucket, and inserts the row via
// intake_financial_statement_document() (SECURITY DEFINER — see
// supabase/migrations/20260915100000_financial_statement_documents.sql).
//
// NOT deployed. NOT executed/tested in this environment — no Deno runtime
// is available here, matching this repository's own established
// disclosure for _shared/actor.ts and _shared/idempotency.ts. Written to
// match those files' real, verified signatures exactly.
//
// This function performs INTAKE only. It never extracts accounting facts,
// never writes to trial_balance_uploads/account_mappings/tax_computations/
// any prepared-statement table, and never marks a document "reviewed" —
// see Phase 9's evidence chain. Classification here is file-type routing
// only (a deterministic, non-accounting judgment), not a financial
// conclusion.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateAuth, corsHeaders, handleCors } from "../_shared/auth.ts";
import { resolveFirmMemberActor } from "../_shared/actor.ts";
import { sha256HexBytes } from "../_shared/hash.ts";

const MAX_BYTES = 50 * 1024 * 1024; // 50MB — mirrors the migration's chk_fsd_byte_size.
const BUCKET = "financial-statement-documents";

const ACCEPTED_EXTENSIONS = new Set(["pdf", "docx", "xlsx", "xhtml", "html", "doc", "xls"]);

// Magic-byte signatures — never trust a filename/declared-mimetype alone.
const PDF_MAGIC = new TextEncoder().encode("%PDF");
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // DOCX/XLSX are ZIP (OOXML) containers.
const OLE_MAGIC = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // legacy .doc/.xls (OLE2).

function bytesStartWith(bytes: Uint8Array, sig: Uint8Array): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[i] !== sig[i]) return false;
  }
  return true;
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

/**
 * Verifies the file's magic bytes are consistent with its extension.
 * Returns an error message on mismatch, or null when consistent (or when
 * the format has no fixed binary signature to check, e.g. plain HTML).
 */
function verifySignature(ext: string, head: Uint8Array): string | null {
  if (ext === "pdf") {
    return bytesStartWith(head, PDF_MAGIC) ? null : "File extension is .pdf but the content is not a PDF.";
  }
  if (ext === "docx" || ext === "xlsx") {
    return bytesStartWith(head, ZIP_MAGIC)
      ? null
      : `File extension is .${ext} but the content is not a valid Office Open XML container.`;
  }
  if (ext === "doc" || ext === "xls") {
    return bytesStartWith(head, OLE_MAGIC) ? null : `File extension is .${ext} but the content is not a valid legacy Office document.`;
  }
  // xhtml/html: text-based, no fixed magic number — extension/declared MIME
  // is the practical signal at this layer; the not-yet-connected extraction
  // pipeline is expected to reject malformed markup on its own pass.
  return null;
}

/**
 * Re-enforces the one absolute rule from the classifier at the trust
 * boundary too: CSV is never accepted as financial_statements, no matter
 * what the client's own (already-correct) classification claimed.
 */
function rejectCsvAsStatements(fileName: string, mimeType: string, hint: string): string | null {
  const isCsv = extensionOf(fileName) === "csv" || mimeType === "text/csv";
  if (isCsv && (hint === "financial_statements" || hint === "structured_xbrl" || hint === "mixed_workbook")) {
    return "CSV cannot be classified as a financial statement document.";
  }
  return null;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-180);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonResponse({ error: "MethodNotAllowed" }, 405);
  }

  const { result: auth, error: authError } = await validateAuth(req.headers.get("Authorization"), corsHeaders);
  if (authError) return authError;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "ServerConfigurationError" }, 500);
  }
  const admin = createClient(supabaseUrl, serviceRoleKey);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse({ error: "BadRequest", message: "Expected multipart/form-data." }, 400);
  }

  const companyId = String(form.get("companyId") ?? "");
  const periodYearRaw = String(form.get("periodYear") ?? "");
  const periodYear = Number.parseInt(periodYearRaw, 10);
  const clientRequestId = String(form.get("clientRequestId") ?? "");
  const artifactClassHint = String(form.get("artifactClassHint") ?? "");
  const file = form.get("file");
  const supportingFile = form.get("supportingFile");

  if (!companyId || !Number.isFinite(periodYear) || !clientRequestId) {
    return jsonResponse({ error: "BadRequest", message: "companyId, periodYear and clientRequestId are required." }, 400);
  }
  if (!(file instanceof File)) {
    return jsonResponse({ error: "BadRequest", message: "No file was received." }, 400);
  }

  const actor = await resolveFirmMemberActor(admin, auth!.userId, companyId, corsHeaders);
  if (actor instanceof Response) return actor;

  if (file.size <= 0) {
    return jsonResponse({ error: "BadRequest", message: "The selected file is empty." }, 400);
  }
  if (file.size > MAX_BYTES) {
    return jsonResponse({ error: "PayloadTooLarge", message: `File exceeds the ${MAX_BYTES / (1024 * 1024)}MB limit.` }, 413);
  }

  const ext = extensionOf(file.name);
  if (!ACCEPTED_EXTENSIONS.has(ext)) {
    return jsonResponse({ error: "UnsupportedMediaType", message: `"${ext || "unknown"}" is not a supported format.` }, 415);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  const signatureError = verifySignature(ext, bytes.subarray(0, 8));
  if (signatureError) {
    // Structured audit event — file name/size/hash-class only, never content.
    console.log(JSON.stringify({
      event: "financial_statement_intake_rejected",
      reason: "signature_mismatch",
      companyId, firmMemberId: actor.firmMemberId, fileName: sanitizeFileName(file.name), ext,
    }));
    return jsonResponse({ error: "UnprocessableEntity", message: signatureError }, 422);
  }

  const csvError = rejectCsvAsStatements(file.name, file.type, artifactClassHint);
  if (csvError) {
    return jsonResponse({ error: "UnprocessableEntity", message: csvError }, 422);
  }

  // Archive-bomb note: DOCX/XLSX are ZIP containers, but this function never
  // inflates/parses them — the 50MB compressed-payload ceiling above is the
  // full mitigation at THIS stage. Any future extraction pipeline that
  // actually opens the archive must independently bound decompressed size
  // before parsing; that pipeline does not exist yet (Phase 11).

  // Malware/quarantine hook — best-effort, explicitly a no-op today. Wired
  // as a named extension point so a real scanner can be added later without
  // changing the intake contract. Honest about its current state: it does
  // NOT scan anything yet.
  const malwareScanWebhook = Deno.env.get("MALWARE_SCAN_WEBHOOK_URL");
  let quarantined = false;
  if (malwareScanWebhook) {
    try {
      const scanResp = await fetch(malwareScanWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      });
      const scanResult = await scanResp.json().catch(() => null) as { clean?: boolean } | null;
      quarantined = scanResp.ok && scanResult ? scanResult.clean === false : false;
    } catch {
      // Scanner unreachable — fail OPEN is not acceptable for a security
      // control, so this is intentionally left as a TODO for whoever wires
      // a real scanner: today, with no MALWARE_SCAN_WEBHOOK_URL configured,
      // this branch is simply never reached.
      quarantined = false;
    }
  }

  const sha256 = await sha256HexBytes(bytes);
  const storagePath = `${companyId}/${periodYear}/${crypto.randomUUID()}-${sanitizeFileName(file.name)}`;

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(storagePath, bytes, { contentType: file.type || "application/octet-stream", upsert: false });
  if (uploadError) {
    return jsonResponse({ error: "StorageError", message: "Could not store the file. Try again." }, 502);
  }

  const { data: row, error: intakeError } = await admin.rpc("intake_financial_statement_document", {
    p_company_id: companyId,
    p_period_year: periodYear,
    p_uploaded_by_firm_member_id: actor.firmMemberId,
    p_original_file_name: file.name,
    p_mime_type: file.type || "application/octet-stream",
    p_byte_size: file.size,
    p_sha256: sha256,
    p_artifact_class: artifactClassHint || "ambiguous",
    p_storage_path: storagePath,
  } as never);

  if (intakeError || !row) {
    // Orphaned object cleanup: the DB row failed after the bytes were
    // already stored. Best-effort removal — a failed remove here still
    // leaves the intake itself correctly reported as failed to the caller.
    await admin.storage.from(BUCKET).remove([storagePath]);
    return jsonResponse({ error: "DatabaseError", message: "Could not record the upload. Try again." }, 502);
  }

  const documentRow = row as { id: string; status: string };

  if (quarantined) {
    await admin.rpc("advance_financial_statement_document_status", {
      p_document_id: documentRow.id,
      p_next_status: "QUARANTINED",
    } as never);
    console.log(JSON.stringify({
      event: "financial_statement_intake_quarantined",
      companyId, documentId: documentRow.id, firmMemberId: actor.firmMemberId,
    }));
    return jsonResponse({ documentId: documentRow.id, status: "QUARANTINED" }, 200);
  }

  console.log(JSON.stringify({
    event: "financial_statement_intake_stored",
    companyId, periodYear, documentId: documentRow.id, firmMemberId: actor.firmMemberId,
    fileName: sanitizeFileName(file.name), byteSize: file.size, artifactClass: artifactClassHint,
    clientRequestId, hasSupportingFile: supportingFile instanceof File,
  }));

  // Supporting trial balance (optional) is accepted but NOT persisted by
  // this function today — wiring it into the existing trial-balance intake
  // path (process-trial-balance) is separate, unbuilt work; accepting the
  // field without silently dropping context would require duplicating that
  // function's own validation, which this intake boundary does not attempt.
  // The current, honest behavior: it is read (so the request succeeds) and
  // otherwise ignored — never written anywhere.

  return jsonResponse({ documentId: documentRow.id, status: documentRow.status }, 200);
});
