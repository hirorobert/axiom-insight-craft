// The ONE trial balance upload policy (Phase 2): what a source file may be before anything reads it, and what a read
// table may hold before any check runs. Every enforcement point imports this module:
//   * the shared reader (tbSource.readSourceTables → process-trial-balance, trial-balance-layout, layout-assist);
//   * the drafts migration's CHECK and reserve RPC (20261106100000; kept equal by src/lib/workspace/uploadPolicy.test.ts);
//   * the browser (src/lib/workspace/trialBalanceDraft.ts and the first-visit copy).
//
// PROVISIONAL limits (owner decision pending; measured by scripts/bench/tbUploadPolicyBench.mjs, see roadmap.md). They
// bound resource use; they are not accounting rules. A refusal names the limit and the next step; nothing is truncated.
//
// Workbook expansion is checked from the ZIP central directory alone (declared uncompressed sizes; nothing is inflated),
// so a highly compressed .xlsx is refused before the spreadsheet library ever sees it.

export const TB_UPLOAD_POLICY = Object.freeze({
  version: "tb-upload-policy-1",
  extensions: Object.freeze([".csv", ".xlsx", ".xls"] as const),
  /** Bytes of the file as uploaded. */
  maxFileBytes: 52_428_800,
  /** .xlsx: the sum of every entry's declared uncompressed size. */
  maxExpandedBytes: 209_715_200,
  /** .xlsx: entries in the package. */
  maxZipEntries: 2_000,
  /** Rows across every sheet (or the CSV table) after reading. */
  maxRows: 200_000,
  /** Cells across every sheet after reading. */
  maxCells: 4_000_000,
});

export type PolicyIssueCode = "FILE_TOO_LARGE" | "WORKBOOK_TOO_LARGE_EXPANDED" | "WORKBOOK_TOO_MANY_PARTS" | "TOO_MANY_ROWS" | "TOO_MANY_CELLS";
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
