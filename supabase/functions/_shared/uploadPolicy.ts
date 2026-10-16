// The ONE trial balance upload policy (Phase 2): what a source file may be before anything reads it, and what a read
// table may hold before any check runs. Every enforcement point imports this module:
//   * the shared reader (tbSource.readSourceTables → process-trial-balance, trial-balance-layout, layout-assist);
//   * the drafts migration's CHECK and reserve RPC (20261106100000; kept equal by src/lib/workspace/uploadPolicy.test.ts);
//   * the browser (src/lib/workspace/trialBalanceDraft.ts and the first-visit copy).
//
// PROVISIONAL limits (owner decision pending), set from MEASUREMENT: the Deno/V8 probe under a hard 150 MB heap cap
// (scripts/bench/tbUploadPolicyDenoProbe.ts, CI) terminated a 100,000-row workbook (16.3 MB expanded); and in the REAL
// process-trial-balance on the local Edge Runtime a 25,000-row workbook exhausted the worker (HTTP 546 after 2.3 s) while
// the bare parser handled it — so the limits follow the real function, proven at the limit by scripts/e2e/draftJourney.mjs
// (rows count the header; 10,000 lines is about twice a large trial balance). Raw upload/storage size is a separate, larger number than the safe-parse limits. They bound
// resource use; they are not accounting rules. A refusal names the limit and the next step; nothing is truncated.
//
// Workbook expansion is checked from the ZIP central directory alone (declared uncompressed sizes; nothing is inflated),
// so a highly compressed .xlsx is refused before the spreadsheet library ever sees it.

export const TB_UPLOAD_POLICY = Object.freeze({
  version: "tb-upload-policy-3",
  extensions: Object.freeze([".csv", ".xlsx", ".xls"] as const),
  /** Bytes of the file as uploaded and stored (raw upload/storage limit). */
  maxFileBytes: 10_485_760,
  /** .xlsx/.xlsm: the ACTUAL inflated size of every entry together (declared sizes are only a first filter). */
  maxExpandedBytes: 2_097_152,
  /** .xlsx: entries in the package. */
  maxZipEntries: 2_000,
  /** Rows across every sheet (or the CSV table); also the bound DURING the parse (limit + 1 rows are read at most). */
  maxRows: 10_000,
  /** Cells across every sheet after reading. */
  maxCells: 120_000,
  /**
   * Accounts in one trial balance (after reading). A SEPARATE bound from rows and cells: one certification holds every
   * certified account (tb_certifications.rows_snapshot, CHECK 1 MiB stored; measured about 400 bytes per account with
   * realistic names, so about 2,600 fit) and a run records four dependency keys per account (tb_snapshot_dependencies
   * accepts 20,000). Over it the file is refused whole before any check runs.
   */
  maxAccounts: 2_000,
  /** Bytes (JSON text) of the certified rows of one certification; the stored CHECK is 1,048,576 bytes of jsonb. */
  maxCertifiedRowsBytes: 900_000,
});

export type PolicyIssueCode = "FILE_TOO_LARGE" | "WORKBOOK_TOO_LARGE_EXPANDED" | "WORKBOOK_TOO_MANY_PARTS" | "TOO_MANY_ROWS" | "TOO_MANY_CELLS" | "TOO_MANY_ACCOUNTS" | "UNSUPPORTED_FORMAT";
export interface PolicyIssue { code: PolicyIssueCode; severity: "blocking"; message: string }

const mb = (n: number) => `${Math.round(n / 1_048_576)} MB`;
const thousands = (n: number) => n.toLocaleString("en-US");

/** Bytes-level checks, before any parse. */
export function checkSourceBytes(bytes: Uint8Array, fileName: string): PolicyIssue | null {
  const P = TB_UPLOAD_POLICY;
  if (bytes.byteLength > P.maxFileBytes) {
    return { code: "FILE_TOO_LARGE", severity: "blocking", message: `The file is larger than ${mb(P.maxFileBytes)}. Export only the trial balance (one sheet, no images) and upload it again.` };
  }
  if (!/\.(xlsx|xlsm)$/i.test(fileName)) return null;
  const z = zipDeclaredSizes(bytes);
  // Not a readable ZIP: the existing path decides exactly as before (the spreadsheet library refuses it as unreadable);
  // the file-size limit above has already applied.
  if (!z.ok) return null;
  if (z.entries > P.maxZipEntries) {
    return { code: "WORKBOOK_TOO_MANY_PARTS", severity: "blocking", message: `The workbook has more than ${thousands(P.maxZipEntries)} parts. Save only the trial balance sheet in a new workbook and upload it.` };
  }
  if (z.uncompressed > P.maxExpandedBytes) {
    return { code: "WORKBOOK_TOO_LARGE_EXPANDED", severity: "blocking", message: `The workbook expands to more than ${mb(P.maxExpandedBytes)} when opened. Save only the trial balance sheet in a new workbook, or export it as CSV, and upload it.` };
  }
  return null;
}

/** Table-level checks, after reading and before any check runs. */
export function checkSourceTables(sheets: readonly { rows: readonly (readonly unknown[])[] }[]): PolicyIssue | null {
  const P = TB_UPLOAD_POLICY;
  let rows = 0, cells = 0;
  for (const s of sheets) {
    rows += s.rows.length;
    for (const r of s.rows) cells += r.length;
    if (rows > P.maxRows) return { code: "TOO_MANY_ROWS", severity: "blocking", message: `The file has more than ${thousands(P.maxRows)} rows. A trial balance lists one row per account; export only the trial balance and upload it again.` };
    if (cells > P.maxCells) return { code: "TOO_MANY_CELLS", severity: "blocking", message: `The file has more than ${thousands(P.maxCells)} cells. Export only the trial balance columns and upload it again.` };
  }
  return null;
}

/** The account bound, after reading and before any check runs. */
export function checkAccountCount(accounts: number): PolicyIssue | null {
  const P = TB_UPLOAD_POLICY;
  if (accounts <= P.maxAccounts) return null;
  return { code: "TOO_MANY_ACCOUNTS", severity: "blocking", message: `The trial balance has more than ${thousands(P.maxAccounts)} accounts, the most one check can certify today. Nothing from this file was recorded.` };
}

/**
 * ZIP central directory: entry count and the sum of declared uncompressed sizes, read from the End Of Central Directory
 * record without inflating anything. ZIP64 (sizes beyond 4 GiB) is treated as over the limit.
 */
export function zipDeclaredSizes(b: Uint8Array): { ok: true; entries: number; uncompressed: number } | { ok: false } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const min = Math.max(0, b.byteLength - 22 - 65_535);
  let eocd = -1;
  for (let i = b.byteLength - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return { ok: false };
  const entries = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (entries === 0xffff || cdOffset === 0xffffffff) return { ok: true, entries: Number.MAX_SAFE_INTEGER, uncompressed: Number.MAX_SAFE_INTEGER };
  if (cdOffset + cdSize > b.byteLength) return { ok: false };
  let p = cdOffset, total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > b.byteLength || dv.getUint32(p, true) !== 0x02014b50) return { ok: false };
    const size = dv.getUint32(p + 24, true);
    if (size === 0xffffffff) return { ok: true, entries, uncompressed: Number.MAX_SAFE_INTEGER };
    total += size;
    p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return { ok: true, entries, uncompressed: total };
}

// ── ACTUAL expansion (declared sizes are only a first filter) ────────────────────────────────────────────────────────

/**
 * Every entry of an .xlsx/.xlsm package is inflated as a STREAM and its real output counted; the count stops (and the
 * stream is cancelled) as soon as the total passes the limit, so a package whose directory understates its sizes is
 * refused after at most `limit` bytes of output — the spreadsheet library never sees it. Web-standard
 * DecompressionStream ("deflate-raw"): the same code in the Edge Runtime (Deno), Node 20.12+ and Bun; no dependency.
 */
export async function zipActualExpansion(b: Uint8Array, limit: number): Promise<{ kind: "not_zip" } | { kind: "unsupported" } | { kind: "measured"; total: number; over: boolean }> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const min = Math.max(0, b.byteLength - 22 - 65_535);
  let eocd = -1;
  for (let i = b.byteLength - 22; i >= min; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return { kind: "not_zip" };
  const entries = dv.getUint16(eocd + 10, true), cdOffset = dv.getUint32(eocd + 16, true);
  if (entries === 0xffff || cdOffset === 0xffffffff || cdOffset >= b.byteLength) return { kind: "unsupported" };
  let p = cdOffset, total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > b.byteLength || dv.getUint32(p, true) !== 0x02014b50) return { kind: "unsupported" };
    const method = dv.getUint16(p + 10, true), compressed = dv.getUint32(p + 20, true), local = dv.getUint32(p + 42, true);
    p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    if (local + 30 > b.byteLength || dv.getUint32(local, true) !== 0x04034b50) return { kind: "unsupported" };
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    if (start + compressed > b.byteLength) return { kind: "unsupported" };
    if (method === 0) { total += compressed; }
    else if (method === 8) {
      // (Bytes downloaded from Storage are ArrayBuffer-backed; the narrowing satisfies Deno's strict BlobPart type.)
      const reader = new Blob([b.subarray(start, start + compressed) as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > limit) { await reader.cancel().catch(() => {}); return { kind: "measured", total, over: true }; }
        }
      } catch {
        return { kind: "unsupported" };
      }
    } else return { kind: "unsupported" };
    if (total > limit) return { kind: "measured", total, over: true };
  }
  return { kind: "measured", total, over: false };
}

/**
 * The gate every entry point runs on the downloaded bytes BEFORE any reader: the declared checks, then the ACTUAL
 * expansion of a workbook package. Bytes that are not a ZIP at all keep their existing behaviour (the reader refuses
 * them as unreadable).
 */
export async function checkSourceBytesActual(bytes: Uint8Array, fileName: string): Promise<PolicyIssue | null> {
  const declared = checkSourceBytes(bytes, fileName);
  if (declared) return declared;
  if (!/\.(xlsx|xlsm)$/i.test(fileName)) return null;
  const m = await zipActualExpansion(bytes, TB_UPLOAD_POLICY.maxExpandedBytes);
  if (m.kind === "not_zip") return null;
  if (m.kind === "unsupported") return { code: "UNSUPPORTED_FORMAT", severity: "blocking", message: "The workbook could not be opened. Save it again from Excel as .xlsx and upload it." };
  if (m.over) return { code: "WORKBOOK_TOO_LARGE_EXPANDED", severity: "blocking", message: `The workbook expands to more than ${mb(TB_UPLOAD_POLICY.maxExpandedBytes)} when opened. Save only the trial balance sheet in a new workbook, or export it as CSV, and upload it.` };
  return null;
}
