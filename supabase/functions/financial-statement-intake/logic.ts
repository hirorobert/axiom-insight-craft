// financial-statement-intake/logic.ts — Ω∞ CFOCLOSE Document Review,
// acceptance-repair Phases 5 & 6.
//
// Pure functions only: no fetch, no Supabase client, no Deno-specific API
// beyond the WebCrypto surface (crypto.subtle) already used by
// _shared/hash.ts. Fully unit-testable with `deno test`, no mocking needed
// for anything in this file.

export const ACCEPTED_EXTENSIONS = ["pdf", "docx", "xlsx", "xhtml", "html", "doc", "xls"] as const;
export type AcceptedExtension = (typeof ACCEPTED_EXTENSIONS)[number];

/** The exact seven values chk_fsd_artifact_class allows — never store anything outside this set. */
export const ARTIFACT_CLASS_ENUM = [
  "trial_balance", "financial_statements", "mixed_workbook",
  "scanned_document", "structured_xbrl", "unsupported", "ambiguous",
] as const;
export type ArtifactClass = (typeof ARTIFACT_CLASS_ENUM)[number];

export function isArtifactClass(value: string): value is ArtifactClass {
  return (ARTIFACT_CLASS_ENUM as readonly string[]).includes(value);
}

const PDF_MAGIC = new TextEncoder().encode("%PDF");
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // DOCX/XLSX — OOXML ZIP containers.
const OLE_MAGIC = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // legacy .doc/.xls (OLE2).

function bytesStartWith(bytes: Uint8Array, sig: Uint8Array): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[i] !== sig[i]) return false;
  }
  return true;
}

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

export function isAcceptedExtension(ext: string): ext is AcceptedExtension {
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Verifies the file's magic bytes are consistent with its extension.
 * Returns an error message on mismatch, or null when consistent (or when
 * the format has no fixed binary signature to check — plain HTML/XHTML).
 */
export function verifySignature(ext: string, head: Uint8Array): string | null {
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
  // xhtml/html: text-based, no fixed magic number.
  return null;
}

/** Expected declared Content-Type(s) per accepted extension — a second, independent guard alongside the magic-byte signature check. */
const EXPECTED_MIME_BY_EXTENSION: Record<AcceptedExtension, readonly string[]> = {
  pdf: ["application/pdf"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  xhtml: ["application/xhtml+xml", "text/xhtml", "text/html"],
  html: ["text/html"],
  doc: ["application/msword"],
  xls: ["application/vnd.ms-excel"],
};

/**
 * Flags a declared Content-Type that is inconsistent with the extension —
 * a lightweight, independent check alongside the magic-byte signature
 * verification. An empty/absent declared MIME type is not itself a
 * mismatch (many legitimate clients omit or generalize it); this only
 * flags a declared type that actively contradicts the extension.
 */
export function verifyDeclaredMimeType(ext: string, mimeType: string): string | null {
  if (!mimeType) return null;
  const expected = EXPECTED_MIME_BY_EXTENSION[ext as AcceptedExtension];
  if (!expected) return null;
  const normalized = mimeType.toLowerCase().split(";")[0].trim();
  if (normalized === "application/octet-stream" || normalized === "") return null;
  return expected.includes(normalized)
    ? null
    : `Declared content type "${mimeType}" does not match the .${ext} extension.`;
}

/**
 * CSV is rejected at the extension/MIME layer, before this function is ever
 * reached — this check exists as a second, independent guard so the "CSV
 * must always be rejected from statement review" rule cannot silently stop
 * holding if the extension check above it is ever refactored.
 */
export function isCsv(fileName: string, mimeType: string): boolean {
  return extensionOf(fileName) === "csv" || mimeType.toLowerCase() === "text/csv";
}

const XBRL_MARKERS = ["xmlns:xbrli", "xmlns:ix", "<ix:", "<xbrli:", "http://www.xbrl.org"];

function looksLikeXbrl(contentSample: string | undefined): boolean {
  if (!contentSample) return false;
  return XBRL_MARKERS.some((marker) => contentSample.includes(marker));
}

export type ClassificationOutcome =
  | { ok: true; artifactClass: ArtifactClass }
  | { ok: false; reason: "csv_rejected" | "unsupported_extension" | "untrusted_hint_ignored" };

/**
 * Server-authoritative classification (Phase 5). The client's own
 * artifactClassHint is NEVER treated as truth — it is consulted only for
 * the one case where the server genuinely cannot determine the type from
 * the file alone (XLSX/XLS, where the hint expresses the user's own
 * confirmed answer to the "choose what it contains" prompt), and even then
 * it is validated against a strict allow-list before being accepted. Every
 * other extension is classified purely from its own signature-verified
 * type — the hint has no bearing on the outcome at all for those.
 */
export function deriveServerArtifactClass(
  fileName: string,
  mimeType: string,
  contentSample: string | undefined,
  clientHint: string | undefined,
): ClassificationOutcome {
  if (isCsv(fileName, mimeType)) {
    return { ok: false, reason: "csv_rejected" };
  }

  const ext = extensionOf(fileName);

  if (ext === "pdf" || ext === "docx" || ext === "doc") {
    return { ok: true, artifactClass: "financial_statements" };
  }

  if (ext === "xhtml" || ext === "html") {
    return { ok: true, artifactClass: looksLikeXbrl(contentSample) ? "structured_xbrl" : "financial_statements" };
  }

  if (ext === "xlsx" || ext === "xls") {
    // The only case where a client hint has any bearing at all — and only
    // when it is exactly one of the two legitimate user-confirmation
    // answers the intake UI's "choose what it contains" prompt can produce.
    if (clientHint === "trial_balance" || clientHint === "financial_statements") {
      return { ok: true, artifactClass: clientHint };
    }
    return { ok: true, artifactClass: "ambiguous" };
  }

  return { ok: false, reason: "unsupported_extension" };
}

/**
 * Content-addressed, server-generated storage path (Phase 6). Identical
 * bytes for the same company/period always resolve to the identical path —
 * this is what makes storage upload idempotent by construction, not by
 * convention. `sha256` must already be lowercase hex (chk_fsd_sha256's own
 * shape); `ext` must already be one of ACCEPTED_EXTENSIONS.
 */
export function resolveContentAddressedStoragePath(
  companyId: string,
  periodYear: number,
  sha256: string,
  ext: string,
): string {
  return `${companyId}/${periodYear}/${sha256}.${ext}`;
}
