// financial-statement-intake/handleIntake.ts — Ω∞ CFOCLOSE Document Review.
//
// The full orchestration, in the exact order the acceptance-repair
// directive requires:
//   1. Authenticate.                    (index.ts, before this module)
//   2. Resolve firmMemberId.            \_ one call: resolveFirmMemberActor
//   3. Validate company membership.     /
//   4. Validate size/signature/type.
//   5. Complete malware scan (fail-closed — see scanForMalware.ts).
//   6. Compute SHA-256.
//   7. Resolve deterministic (content-addressed) storage path.
//   8. Upload idempotently.
//   9. Insert-or-return the document row.
//  10. On database failure, remove only an object created by this request.
//  11. On duplicate replay, return the existing document and object.
//  12. Never leave a second object for the same company/period/hash.
//
// Deliberately has NO import of "https://deno.land/std/http/server.ts" or
// "@supabase/supabase-js" and calls no Deno.serve/Deno.listen — importing
// this module (for its types or to call handleIntake directly in a test)
// has zero side effects and needs zero permissions. index.ts is the only
// file in this function that binds a listener or reaches a real database.
//
// This function performs INTAKE only. It never extracts accounting facts,
// never writes to trial_balance_uploads/account_mappings/tax_computations/
// any prepared-statement table, and never marks a document "reviewed."
// Classification here is file-type routing only (server-authoritative —
// see logic.ts), never a financial conclusion.

import { corsHeaders } from "../_shared/auth.ts";
import type { FirmMemberActor } from "../_shared/actor.ts";
import type { sha256HexBytes } from "../_shared/hash.ts";
import {
  isAcceptedExtension,
  extensionOf,
  verifySignature,
  verifyDeclaredMimeType,
  deriveServerArtifactClass,
  resolveContentAddressedStoragePath,
  isArtifactClass,
} from "./logic.ts";
import type { scanForMalware } from "./scanForMalware.ts";

const MAX_BYTES = 50 * 1024 * 1024; // 50MB — mirrors the migration's chk_fsd_byte_size.
const BUCKET = "financial-statement-documents";
const CONTENT_SAMPLE_BYTES = 512 * 1024; // bounded markup scan window for XBRL-marker detection — Phase 5.

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Minimal surface this module calls on the admin client — lets tests inject a fake. */
export interface AdminClientLike {
  storage: {
    from(bucket: string): {
      upload(path: string, body: Uint8Array, opts: { contentType: string; upsert: boolean }): Promise<{ error: { message?: string; statusCode?: string } | null }>;
      remove(paths: string[]): Promise<unknown>;
    };
  };
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message?: string } | null }>;
}

export interface IntakeDeps {
  // deno-lint-ignore no-explicit-any
  // `admin` is deliberately `any` here: the real resolveFirmMemberActor
  // expects a full SupabaseClient (it calls .from("firm_members")...), while
  // tests inject a much narrower AdminClientLike fake exercising only
  // storage/rpc. This is the one deliberate type-erasure point at this
  // dependency-injection boundary — everywhere else in this file is fully
  // typed.
  resolveFirmMemberActor: (
    admin: any,
    userId: string,
    companyId: string,
    corsHeaders: Record<string, string>,
  ) => Promise<FirmMemberActor | Response>;
  scanForMalware: typeof scanForMalware;
  sha256HexBytes: typeof sha256HexBytes;
  admin: AdminClientLike;
  malwareScanWebhookUrl: string | undefined;
}

export interface IntakeRequest {
  userId: string;
  companyId: string;
  periodYear: number;
  file: { name: string; type: string; size: number; bytes: Uint8Array };
  artifactClassHint: string | undefined;
}

export async function handleIntake(deps: IntakeDeps, req: IntakeRequest): Promise<Response> {
  const { userId, companyId, periodYear, file, artifactClassHint } = req;

  // Steps 2+3: resolve firmMemberId AND verify company membership.
  const actor = await deps.resolveFirmMemberActor(deps.admin, userId, companyId, corsHeaders);
  if (actor instanceof Response) return actor;

  // Step 4: validate size/signature/type.
  if (file.size <= 0) {
    return jsonResponse({ error: "BadRequest", message: "The selected file is empty." }, 400);
  }
  if (file.size > MAX_BYTES) {
    return jsonResponse({ error: "PayloadTooLarge", message: `File exceeds the ${MAX_BYTES / (1024 * 1024)}MB limit.` }, 413);
  }
  const ext = extensionOf(file.name);
  if (!isAcceptedExtension(ext)) {
    return jsonResponse({ error: "UnsupportedMediaType", message: `"${ext || "unknown"}" is not a supported format.` }, 415);
  }
  const signatureError = verifySignature(ext, file.bytes.subarray(0, 8));
  if (signatureError) {
    console.log(JSON.stringify({ event: "financial_statement_intake_rejected", reason: "signature_mismatch", companyId, firmMemberId: actor.firmMemberId, ext }));
    return jsonResponse({ error: "UnprocessableEntity", message: signatureError }, 422);
  }
  const mimeError = verifyDeclaredMimeType(ext, file.type);
  if (mimeError) {
    console.log(JSON.stringify({ event: "financial_statement_intake_rejected", reason: "mime_mismatch", companyId, firmMemberId: actor.firmMemberId, ext }));
    return jsonResponse({ error: "UnprocessableEntity", message: mimeError }, 422);
  }

  // Step 5: malware scan — fail CLOSED on every non-"clean" outcome. No
  // bytes reach storage unless this is exactly { outcome: "clean" }.
  const scan = await deps.scanForMalware({ bytes: file.bytes, webhookUrl: deps.malwareScanWebhookUrl });
  if (scan.outcome === "unavailable") {
    console.log(JSON.stringify({ event: "financial_statement_intake_scan_unavailable", reason: scan.reason, companyId, firmMemberId: actor.firmMemberId }));
    return jsonResponse({ error: "IntakeUnavailable", message: "Statement review intake is temporarily unavailable. Try again shortly." }, 503);
  }
  if (scan.outcome === "dirty") {
    console.log(JSON.stringify({ event: "financial_statement_intake_rejected", reason: "malware_scan_dirty", companyId, firmMemberId: actor.firmMemberId }));
    return jsonResponse({ error: "Rejected", message: "This file failed the malware scan and cannot be reviewed." }, 422);
  }
  // scan.outcome === "clean" from here — nothing is stored before this point.

  // Step 5b: server-authoritative classification (Phase 5). CSV is rejected
  // outright; the client's hint is never trusted except for the one
  // legitimate ambiguous-XLSX-confirmation case (see logic.ts).
  const contentSample =
    ext === "xhtml" || ext === "html"
      ? new TextDecoder().decode(file.bytes.subarray(0, CONTENT_SAMPLE_BYTES))
      : undefined;
  const classification = deriveServerArtifactClass(file.name, file.type, contentSample, artifactClassHint);
  if (!classification.ok) {
    const message =
      classification.reason === "csv_rejected"
        ? "CSV cannot be classified as a financial statement document."
        : `"${ext}" is not a supported format for this intake surface.`;
    return jsonResponse({ error: "UnprocessableEntity", message }, 422);
  }
  if (!isArtifactClass(classification.artifactClass)) {
    // Defensive — deriveServerArtifactClass's own return type already
    // guarantees this, but a value outside the database enum must never
    // reach the RPC under any circumstance.
    return jsonResponse({ error: "InternalError", message: "Could not determine a valid classification." }, 500);
  }

  // Step 6: compute SHA-256 server-side — the browser never supplies an
  // authoritative hash.
  const sha256 = await deps.sha256HexBytes(file.bytes);

  // Step 7: resolve the deterministic, content-addressed storage path.
  const storagePath = resolveContentAddressedStoragePath(companyId, periodYear, sha256, ext);

  // Step 8: upload idempotently. `upsert: false` — if the object already
  // exists, the storage provider rejects the write; that rejection is not
  // a failure here, it is proof this exact content was already stored by
  // an earlier request (the path is content-addressed, so two different
  // uploads can never collide at the same path with different bytes).
  const objectAlreadyExisted = { current: false };
  const { error: uploadError } = await deps.admin.storage
    .from(BUCKET)
    .upload(storagePath, file.bytes, { contentType: file.type || "application/octet-stream", upsert: false });
  if (uploadError) {
    const alreadyExists =
      /already exists/i.test(uploadError.message ?? "") || uploadError.statusCode === "409";
    if (!alreadyExists) {
      return jsonResponse({ error: "StorageError", message: "Could not store the file. Try again." }, 502);
    }
    objectAlreadyExisted.current = true;
  }

  // Step 9: insert-or-return the document row (the RPC itself performs the
  // idempotent SELECT-before-INSERT atomically — see the migration).
  const { data: row, error: intakeError } = await deps.admin.rpc("intake_financial_statement_document", {
    p_company_id: companyId,
    p_period_year: periodYear,
    p_uploaded_by_firm_member_id: actor.firmMemberId,
    p_original_file_name: file.name,
    p_mime_type: file.type || "application/octet-stream",
    p_byte_size: file.size,
    p_sha256: sha256,
    p_artifact_class: classification.artifactClass,
    p_storage_path: storagePath,
  });

  if (intakeError || !row) {
    // Step 10: on database failure, remove ONLY an object this request
    // itself created. A pre-existing object (exact replay) is left alone —
    // it is still legitimately referenced by whatever request created it.
    if (!objectAlreadyExisted.current) {
      await deps.admin.storage.from(BUCKET).remove([storagePath]);
    }
    return jsonResponse({ error: "DatabaseError", message: "Could not record the upload. Try again." }, 502);
  }

  const documentRow = row as { id: string; status: string };

  console.log(JSON.stringify({
    event: "financial_statement_intake_stored",
    companyId, periodYear, documentId: documentRow.id, firmMemberId: actor.firmMemberId,
    byteSize: file.size, artifactClass: classification.artifactClass,
    replay: objectAlreadyExisted.current,
  }));

  // Step 11: exact replay returns the existing document (and its existing
  // object — nothing new was written to storage). Step 12 (never a second
  // object for the same company/period/hash) holds by construction: the
  // storage path is a pure function of (companyId, periodYear, sha256, ext).
  return jsonResponse({ documentId: documentRow.id, status: documentRow.status }, 200);
}
