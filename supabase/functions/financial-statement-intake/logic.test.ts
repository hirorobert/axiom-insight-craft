import { assertEquals, assertNotEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  extensionOf,
  isAcceptedExtension,
  verifySignature,
  verifyDeclaredMimeType,
  isCsv,
  deriveServerArtifactClass,
  resolveContentAddressedStoragePath,
  isArtifactClass,
  ARTIFACT_CLASS_ENUM,
} from "./logic.ts";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n...");
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const OLE_BYTES = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const GARBAGE_BYTES = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);

// ── extensionOf / isAcceptedExtension ───────────────────────────────────

Deno.test("extensionOf lowercases and extracts the extension", () => {
  assertEquals(extensionOf("Report.PDF"), "pdf");
  assertEquals(extensionOf("no-extension"), "");
});

Deno.test("isAcceptedExtension accepts exactly the seven listed types, rejects csv", () => {
  for (const ext of ["pdf", "docx", "xlsx", "xhtml", "html", "doc", "xls"]) {
    assertEquals(isAcceptedExtension(ext), true, ext);
  }
  assertEquals(isAcceptedExtension("csv"), false);
  assertEquals(isAcceptedExtension("jpg"), false);
  assertEquals(isAcceptedExtension(""), false);
});

// ── signature mismatch ──────────────────────────────────────────────────

Deno.test("verifySignature: PDF with correct magic bytes passes", () => {
  assertEquals(verifySignature("pdf", PDF_BYTES), null);
});

Deno.test("verifySignature: PDF extension with garbage bytes fails (signature mismatch)", () => {
  const err = verifySignature("pdf", GARBAGE_BYTES);
  assertNotEquals(err, null);
  assertEquals(err!.includes(".pdf"), true);
});

Deno.test("verifySignature: DOCX/XLSX require ZIP magic bytes", () => {
  assertEquals(verifySignature("docx", ZIP_BYTES), null);
  assertEquals(verifySignature("xlsx", ZIP_BYTES), null);
  assertNotEquals(verifySignature("docx", GARBAGE_BYTES), null);
  assertNotEquals(verifySignature("xlsx", PDF_BYTES), null);
});

Deno.test("verifySignature: legacy .doc/.xls require OLE2 magic bytes", () => {
  assertEquals(verifySignature("doc", OLE_BYTES), null);
  assertEquals(verifySignature("xls", OLE_BYTES), null);
  assertNotEquals(verifySignature("doc", ZIP_BYTES), null);
});

Deno.test("verifySignature: HTML/XHTML have no fixed magic number — always passes this check", () => {
  assertEquals(verifySignature("html", GARBAGE_BYTES), null);
  assertEquals(verifySignature("xhtml", GARBAGE_BYTES), null);
});

// ── MIME mismatch ────────────────────────────────────────────────────────

Deno.test("verifyDeclaredMimeType: correct declared type for each extension passes", () => {
  assertEquals(verifyDeclaredMimeType("pdf", "application/pdf"), null);
  assertEquals(verifyDeclaredMimeType("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), null);
  assertEquals(verifyDeclaredMimeType("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), null);
  assertEquals(verifyDeclaredMimeType("html", "text/html"), null);
});

Deno.test("verifyDeclaredMimeType: a declared type that contradicts the extension fails (MIME mismatch)", () => {
  const err = verifyDeclaredMimeType("pdf", "image/jpeg");
  assertNotEquals(err, null);
  assertEquals(err!.includes(".pdf"), true);
});

Deno.test("verifyDeclaredMimeType: empty/octet-stream declared type is not itself a mismatch", () => {
  assertEquals(verifyDeclaredMimeType("pdf", ""), null);
  assertEquals(verifyDeclaredMimeType("pdf", "application/octet-stream"), null);
});

// ── CSV rejection ────────────────────────────────────────────────────────

Deno.test("isCsv: detects by extension or declared mime type", () => {
  assertEquals(isCsv("data.csv", ""), true);
  assertEquals(isCsv("data.txt", "text/csv"), true);
  assertEquals(isCsv("data.pdf", "application/pdf"), false);
});

Deno.test("deriveServerArtifactClass: CSV is always rejected, never classified as financial_statements", () => {
  const result = deriveServerArtifactClass("data.csv", "", undefined, "financial_statements");
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "csv_rejected");
});

Deno.test("deriveServerArtifactClass: CSV rejection holds even with a misleading filename/mime combination", () => {
  const result = deriveServerArtifactClass("statements.pdf", "text/csv", undefined, undefined);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "csv_rejected");
});

// ── unsupported extension ───────────────────────────────────────────────

Deno.test("deriveServerArtifactClass: unsupported extension is rejected, never silently classified", () => {
  const result = deriveServerArtifactClass("photo.jpg", "image/jpeg", undefined, undefined);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "unsupported_extension");
});

// ── PDF/DOCX/legacy Word/HTML/XHTML server-side classification ─────────

Deno.test("deriveServerArtifactClass: PDF/DOCX/DOC always classify as financial_statements, ignoring any hint", () => {
  for (const [name, mime] of [
    ["report.pdf", "application/pdf"],
    ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["report.doc", "application/msword"],
  ] as const) {
    const result = deriveServerArtifactClass(name, mime, undefined, "trial_balance");
    assertEquals(result.ok, true, name);
    if (result.ok) assertEquals(result.artifactClass, "financial_statements", name);
  }
});

Deno.test("deriveServerArtifactClass: HTML/XHTML without XBRL markers classifies as financial_statements", () => {
  const result = deriveServerArtifactClass("report.html", "text/html", "<html><body>Statement</body></html>", undefined);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.artifactClass, "financial_statements");
});

Deno.test("deriveServerArtifactClass: XHTML with XBRL markers classifies as structured_xbrl", () => {
  const result = deriveServerArtifactClass(
    "instance.xhtml",
    "application/xhtml+xml",
    '<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL">',
    undefined,
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.artifactClass, "structured_xbrl");
});

// ── untrusted artifact hint ──────────────────────────────────────────────

Deno.test("deriveServerArtifactClass: XLSX with no hint is ambiguous — never assumed to be a trial balance", () => {
  const result = deriveServerArtifactClass("workbook.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", undefined, undefined);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.artifactClass, "ambiguous");
});

Deno.test("deriveServerArtifactClass: XLSX with a valid confirmed hint (trial_balance/financial_statements) is honored", () => {
  const tb = deriveServerArtifactClass("workbook.xlsx", "", undefined, "trial_balance");
  assertEquals(tb.ok, true);
  if (tb.ok) assertEquals(tb.artifactClass, "trial_balance");

  const fs = deriveServerArtifactClass("workbook.xls", "", undefined, "financial_statements");
  assertEquals(fs.ok, true);
  if (fs.ok) assertEquals(fs.artifactClass, "financial_statements");
});

Deno.test("deriveServerArtifactClass: an untrusted/out-of-vocabulary XLSX hint is ignored, falls back to ambiguous", () => {
  for (const hint of ["mixed_workbook", "structured_xbrl", "scanned_document", "unsupported", "definitely-not-real", ""]) {
    const result = deriveServerArtifactClass("workbook.xlsx", "", undefined, hint);
    assertEquals(result.ok, true, hint);
    if (result.ok) assertEquals(result.artifactClass, "ambiguous", hint);
  }
});

Deno.test("deriveServerArtifactClass: a hint is completely ignored for non-XLSX extensions, even a hostile one", () => {
  const result = deriveServerArtifactClass("report.pdf", "application/pdf", undefined, "trial_balance");
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.artifactClass, "financial_statements");
});

Deno.test("isArtifactClass / ARTIFACT_CLASS_ENUM: exactly the seven database-enum values, nothing else", () => {
  assertEquals(ARTIFACT_CLASS_ENUM.length, 7);
  for (const cls of ARTIFACT_CLASS_ENUM) assertEquals(isArtifactClass(cls), true);
  assertEquals(isArtifactClass("not_a_real_class"), false);
});

// ── deterministic (content-addressed) storage path — identity depends ONLY
// on company_id + period_year + sha256, never filename/extension ─────────

Deno.test("resolveContentAddressedStoragePath: identical inputs always produce the identical path", () => {
  const a = resolveContentAddressedStoragePath("company-1", 2025, "a".repeat(64));
  const b = resolveContentAddressedStoragePath("company-1", 2025, "a".repeat(64));
  assertEquals(a, b);
  assertEquals(a, `company-1/2025/${"a".repeat(64)}`);
});

Deno.test("resolveContentAddressedStoragePath: different hash, company, or period all produce different paths", () => {
  const base = resolveContentAddressedStoragePath("company-1", 2025, "a".repeat(64));
  assertNotEquals(base, resolveContentAddressedStoragePath("company-2", 2025, "a".repeat(64)));
  assertNotEquals(base, resolveContentAddressedStoragePath("company-1", 2026, "a".repeat(64)));
  assertNotEquals(base, resolveContentAddressedStoragePath("company-1", 2025, "b".repeat(64)));
});

Deno.test("resolveContentAddressedStoragePath: the extension is not a parameter at all — it cannot influence identity", () => {
  const path = resolveContentAddressedStoragePath("company-1", 2025, "c".repeat(64));
  assertEquals(path, `company-1/2025/${"c".repeat(64)}`);
  assertEquals(path.includes("."), false);
});
