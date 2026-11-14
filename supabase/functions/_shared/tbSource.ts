/**
 * tbSource — reads an uploaded trial-balance file into source rows and runs the ingestion core on them.
 *
 * The spreadsheet library is passed in (the edge function hands over esm.sh xlsx@0.18.5; the tests hand over the
 * same version from npm), so the edge function and the tests run this exact code on the exact bytes.
 *
 *   · CSV: strict UTF-8, RFC 4180 (tbIngestion.parseCsvText). Row numbers are text lines.
 *   · Workbook: every sheet keeps its own spreadsheet row numbers (blank rows included). The trial-balance sheet is
 *     the ONE sheet with a recognisable trial-balance header; several such sheets are refused rather than picking
 *     the largest, and a workbook with none is refused with the missing columns named.
 *   · XML: only TallyPrime's Trial Balance export (tallyXmlExport.ts), strict UTF-8, under the same byte and table
 *     limits; any other XML is refused. Row numbers are text lines.
 */

import {
  decodeCsvBytes, detectColumns, ingestTrialBalance, parseCsvText, sheetRowsFromMatrix,
  type Cell, type IngestIssue, type IngestResult, type SourceRow,
} from "./tbIngestion.ts";
import { ingestWithLayout, type LayoutProfile, type ResolvedLayout } from "./layoutProfile.ts";
import { readTallyTrialBalanceXml } from "./tallyXmlExport.ts";
import { TB_UPLOAD_POLICY, checkSourceBytes, checkSourceTables } from "./uploadPolicy.ts";

export type SourceFormat = "xlsx" | "csv" | "xml" | "unknown";

export function detectSourceFormat(fileName: string): SourceFormat {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (["xlsx", "xls", "xlsm"].includes(ext)) return "xlsx";
  if (["csv", "tsv", "txt"].includes(ext)) return "csv";
  if (ext === "xml") return "xml";
  return "unknown";
}

// Unchanged wording (pinned by the characterization corpus): the uploader's own file picker names the Tally .xml case.
const UNSUPPORTED_FORMAT_MESSAGE = "Upload the trial balance as .xlsx, .xls or .csv.";

/** The subset of the SheetJS API this module uses. */
export interface XlsxLike {
  read(data: Uint8Array, opts: { type: "array"; cellDates?: boolean; sheetRows?: number; sheetStubs?: boolean }): { SheetNames: string[]; Sheets: Record<string, Record<string, unknown>> };
  utils: {
    decode_range(ref: string): { s: { r: number; c: number }; e: { r: number; c: number } };
    decode_cell(address: string): { r: number; c: number };
    sheet_to_json<T>(ws: Record<string, unknown>, opts: { header: 1; defval: null; raw: true; blankrows: true }): T[];
  };
}

export interface WorkbookSheet {
  name: string;
  rows: SourceRow[];
  /**
   * Cells inside the sheet's read range that carry a formula but no calculated value ("C4"), in row order. Only an Office
   * Open XML package can say so (see readWorkbook); empty otherwise.
   */
  uncalculated: { cell: string; row: number }[];
}

/**
 * Whether the bytes are an Office Open XML package (.xlsx/.xlsm): a ZIP whose central directory lists [Content_Types].xml
 * and none of the parts by which SheetJS reads a ZIP as OpenDocument or Numbers instead (parse_zip's own order). Names
 * are read from the central directory alone; nothing is inflated.
 */
export function isOfficeOpenXmlPackage(b: Uint8Array): boolean {
  if (b.byteLength < 22) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== 0x04034b50) return false;
  const min = Math.max(0, b.byteLength - 22 - 65_535);
  let eocd = -1;
  for (let i = b.byteLength - 22; i >= min; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return false;
  const entries = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const names = new Set<string>();
  for (let n = 0; n < entries; n++) {
    if (p + 46 > b.byteLength || dv.getUint32(p, true) !== 0x02014b50) return false;
    const len = dv.getUint16(p + 28, true);
    if (p + 46 + len > b.byteLength) return false;
    // The names compared are ASCII; one byte per character is exact for them.
    names.add(String.fromCharCode(...b.subarray(p + 46, p + 46 + len)).toLowerCase());
    p += 46 + len + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return names.has("[content_types].xml")
    && !names.has("meta-inf/manifest.xml") && !names.has("objectdata.xml") && !names.has("index/document.iwa");
}

/**
 * Reads a workbook. For an Office Open XML package the read keeps "stub" cells (sheetStubs): that is the only way SheetJS
 * keeps a cell that has a formula but no calculated value (<f> with no or an empty <v>, as written by a library that does
 * not calculate, such as openpyxl) — without it the cell is dropped and later reads as empty (S2-I01). Every stub is
 * removed again in workbookSheets after the formula ones are noted, so the rows read are the same cells as before.
 * Other formats keep the read exactly as before: OpenDocument stubs would expand repeated empty columns into cells, and
 * a legacy .xls formula always stores its result.
 */
export function readWorkbook(xlsx: XlsxLike, bytes: Uint8Array): ReturnType<XlsxLike["read"]> {
  return xlsx.read(bytes, { type: "array", cellDates: false, sheetRows: SHEET_ROWS, ...(isOfficeOpenXmlPackage(bytes) ? { sheetStubs: true } : {}) });
}

export function workbookSheets(xlsx: XlsxLike, wb: ReturnType<XlsxLike["read"]>): WorkbookSheet[] {
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const ref = typeof ws?.["!ref"] === "string" ? (ws["!ref"] as string) : null;
    if (!ref) return { name, rows: [], uncalculated: [] };
    const range = xlsx.utils.decode_range(ref);
    // A formula cell without a calculated value inside the range that is read (any column: the header, the title block,
    // a dimension or a total label decide as much as an amount does). Stubs (type "z") carry no value and are removed,
    // so sheet_to_json sees exactly the cells a read without stubs keeps.
    const uncalculated: { cell: string; row: number; col: number }[] = [];
    for (const address of Object.keys(ws)) {
      if (address.startsWith("!")) continue;
      const cell = ws[address] as { t?: unknown; v?: unknown; f?: unknown; F?: unknown } | undefined;
      if (!cell || typeof cell !== "object") continue;
      const formula = typeof cell.f === "string" || typeof cell.F === "string";
      if (formula && (cell.t === "z" || cell.v === undefined)) {
        const at = xlsx.utils.decode_cell(address);
        if (at.r >= range.s.r && at.r <= range.e.r && at.c >= range.s.c && at.c <= range.e.c) uncalculated.push({ cell: address, row: at.r + 1, col: at.c });
      }
      if (cell.t === "z") delete ws[address];
    }
    uncalculated.sort((a, b) => a.row - b.row || a.col - b.col);
    const matrix = xlsx.utils.sheet_to_json<Cell[]>(ws, { header: 1, defval: null, raw: true, blankrows: true });
    return { name, rows: sheetRowsFromMatrix(matrix, range.s.r + 1), uncalculated: uncalculated.map(({ cell, row }) => ({ cell, row })) };
  });
}

/**
 * The read sheet's formulas without a calculated value, as one blocking issue (S2-I01), or null. Such a cell would read as
 * empty: its row a zero balance that silently leaves the trial balance (still balancing when the missing amounts offset).
 * Refused before any row is read, never treated as blank.
 */
export function uncalculatedFormulaIssue(sheet: WorkbookSheet): IngestIssue | null {
  const cells = sheet.uncalculated;
  if (cells.length === 0) return null;
  const one = cells.length === 1;
  const shown = cells.slice(0, 10).map((c) => c.cell).join(", ") + (cells.length > 10 ? ` and ${cells.length - 10} more` : "");
  return {
    code: "FORMULA_WITHOUT_VALUE", severity: "blocking", rows: [...new Set(cells.map((c) => c.row))],
    message: `Cell${one ? "" : "s"} ${shown} on sheet “${sheet.name}” ${one ? "has a formula" : "have formulas"} but no calculated value, so ${one ? "it" : "they"} cannot be read — an account could silently drop out of the trial balance. The file was saved by a program that does not calculate formulas. Open it in Excel (or another spreadsheet program), let it calculate, save it, and upload it again.`,
  };
}

export type SheetChoice = { ok: true; sheet: WorkbookSheet } | { ok: false; issue: IngestIssue };

/** The one sheet that carries a trial-balance header (an account column and amount columns). */
export function selectTrialBalanceSheet(sheets: WorkbookSheet[], periodYear: number | null): SheetChoice {
  const nonEmpty = sheets.filter((s) => s.rows.some((r) => r.cells.length > 0));
  if (nonEmpty.length === 0) {
    return { ok: false, issue: { code: "FILE_EMPTY", severity: "blocking", message: "The workbook has no rows. Upload a trial balance with a header row and one row per account." } };
  }
  if (nonEmpty.length === 1) return { ok: true, sheet: nonEmpty[0] };
  const candidates = nonEmpty.filter((s) => {
    const d = detectColumns(s.rows, periodYear);
    return !!d.map && (d.map.account_name !== null || d.map.account_code !== null)
      && (d.map.balance !== null || (d.map.debit !== null && d.map.credit !== null));
  });
  if (candidates.length === 1) return { ok: true, sheet: candidates[0] };
  if (candidates.length === 0) {
    return { ok: false, issue: { code: "MISSING_COLUMN", severity: "blocking", field: "header", message: `None of the sheets (${nonEmpty.map((s) => `“${s.name}”`).join(", ")}) has a trial-balance header. Add Account Name and Debit/Credit (or Balance) column headers.` } };
  }
  return {
    ok: false,
    issue: { code: "MULTIPLE_TRIAL_BALANCE_SHEETS", severity: "blocking", message: `More than one sheet looks like a trial balance (${candidates.map((s) => `“${s.name}”`).join(", ")}). Upload a workbook with only the trial balance for this period, or save that sheet as its own file.` },
  };
}

export interface ReadContext {
  fileName: string; periodYear: number | null; currency: string | null;
  /** The workspace's entity name, compared only with an identifiable title-block entity (§3.3). Optional. */
  workspaceEntityName?: string | null;
}

/**
 * The spreadsheet library stops reading each sheet after this many rows, so a sheet over the row limit is refused
 * (checkSourceTables sees limit + 1) without the whole sheet ever being materialised in memory.
 */
export const SHEET_ROWS = TB_UPLOAD_POLICY.maxRows + 1;

/** A blocked read for an upload-policy refusal found before any reader ran (checkSourceBytesActual). */
export function refusedRead(ctx: ReadContext, issue: IngestIssue): IngestResult {
  return unreadable(ctx, null, issue);
}

/** A result with no rows: the file could not be read at all. Lineage and totals are empty; the one issue says why. */
function unreadable(ctx: ReadContext, sheetName: string | null, issue: IngestIssue): IngestResult {
  const r = ingestTrialBalance({ rows: [], sheetName, periodYear: ctx.periodYear, currency: ctx.currency, workspaceEntityName: ctx.workspaceEntityName });
  // Replace the generic "file has no rows" with the actual reason, keeping any prerequisite issue (period/currency).
  const kept = r.issues.filter((i) => i.code !== "FILE_EMPTY");
  return { ...r, issues: [...kept, issue], blocking: true };
}

/** Bytes → ingest result, for a flat trial balance (CSV or workbook). */
export function readTrialBalanceSource(bytes: Uint8Array, ctx: ReadContext, xlsx: XlsxLike): IngestResult {
  const format = detectSourceFormat(ctx.fileName);
  if (format === "unknown") {
    return unreadable(ctx, null, { code: "UNSUPPORTED_FORMAT", severity: "blocking", message: UNSUPPORTED_FORMAT_MESSAGE });
  }
  // The upload policy, before anything parses the bytes.
  const tooBig = checkSourceBytes(bytes, ctx.fileName);
  if (tooBig) return unreadable(ctx, null, tooBig);
  if (format === "xml") {
    // Tally's Trial Balance XML export, and nothing else: same encoding rule and table limits as a CSV.
    const decoded = decodeCsvBytes(bytes, "XML");
    if (!decoded.ok) return unreadable(ctx, null, decoded.issue);
    const read = readTallyTrialBalanceXml(decoded.text, SHEET_ROWS);
    if (!read.ok) return unreadable(ctx, null, read.issue);
    const tooMany = checkSourceTables([{ rows: read.rows.map((r) => r.cells) }]);
    if (tooMany) return unreadable(ctx, null, tooMany);
    return ingestTrialBalance({ rows: read.rows, sheetName: null, periodYear: ctx.periodYear, currency: ctx.currency, workspaceEntityName: ctx.workspaceEntityName, source: "tally_xml" });
  }
  if (format === "csv") {
    const decoded = decodeCsvBytes(bytes);
    if (!decoded.ok) return unreadable(ctx, null, decoded.issue);
    const parsed = parseCsvText(decoded.text, SHEET_ROWS);
    if (!parsed.ok) return unreadable(ctx, null, parsed.issue);
    const tooMany = checkSourceTables([{ rows: parsed.rows.map((r) => r.cells) }]);
    if (tooMany) return unreadable(ctx, null, tooMany);
    return ingestTrialBalance({ rows: parsed.rows, sheetName: null, periodYear: ctx.periodYear, currency: ctx.currency, workspaceEntityName: ctx.workspaceEntityName });
  }
  let wb: ReturnType<XlsxLike["read"]>;
  try {
    wb = readWorkbook(xlsx, bytes);
  } catch {
    return unreadable(ctx, null, { code: "UNSUPPORTED_FORMAT", severity: "blocking", message: "The workbook could not be opened. Save it again from Excel as .xlsx and upload it." });
  }
  const sheets = workbookSheets(xlsx, wb);
  const tooMany = checkSourceTables(sheets.map((s) => ({ rows: s.rows.map((r) => r.cells) })));
  if (tooMany) return unreadable(ctx, null, tooMany);
  const choice = selectTrialBalanceSheet(sheets, ctx.periodYear);
  if (!choice.ok) return unreadable(ctx, null, choice.issue);
  const uncalculated = uncalculatedFormulaIssue(choice.sheet);
  if (uncalculated) return unreadable(ctx, choice.sheet.name, uncalculated);
  return ingestTrialBalance({ rows: choice.sheet.rows, sheetName: choice.sheet.name, periodYear: ctx.periodYear, currency: ctx.currency, workspaceEntityName: ctx.workspaceEntityName });
}

// ── With a confirmed layout ──────────────────────────────────────────────────────────────────────────────────────────

export interface LayoutRead { result: IngestResult; resolved: ResolvedLayout | null }

/** The rows of every sheet (workbook) or the one CSV table, for the layout editor and for layout validation. */
export type SourceTables = { ok: true; kind: "csv" | "workbook"; sheets: WorkbookSheet[] } | { ok: false; issue: IngestIssue };

export function readSourceTables(bytes: Uint8Array, fileName: string, xlsx: XlsxLike): SourceTables {
  const format = detectSourceFormat(fileName);
  if (format === "unknown") return { ok: false, issue: { code: "UNSUPPORTED_FORMAT", severity: "blocking", message: UNSUPPORTED_FORMAT_MESSAGE } };
  // A Tally XML export has no grid to lay out: it is read as it is (readTrialBalanceSource), never under a layout.
  if (format === "xml") return { ok: false, issue: { code: "UNSUPPORTED_FORMAT", severity: "blocking", message: "A confirmed layout applies to CSV and workbook files. A Tally XML export is read as it is and takes no layout." } };
  // The upload policy, before anything parses the bytes, and on the read tables before anything uses them.
  const tooBig = checkSourceBytes(bytes, fileName);
  if (tooBig) return { ok: false, issue: tooBig };
  if (format === "csv") {
    const decoded = decodeCsvBytes(bytes);
    if (!decoded.ok) return { ok: false, issue: decoded.issue };
    const parsed = parseCsvText(decoded.text, SHEET_ROWS);
    if (!parsed.ok) return { ok: false, issue: parsed.issue };
    const tooMany = checkSourceTables([{ rows: parsed.rows.map((r) => r.cells) }]);
    if (tooMany) return { ok: false, issue: tooMany };
    return { ok: true, kind: "csv", sheets: [{ name: "", rows: parsed.rows, uncalculated: [] }] };
  }
  try {
    const sheets = workbookSheets(xlsx, readWorkbook(xlsx, bytes));
    const tooMany = checkSourceTables(sheets.map((s) => ({ rows: s.rows.map((r) => r.cells) })));
    if (tooMany) return { ok: false, issue: tooMany };
    return { ok: true, kind: "workbook", sheets };
  } catch {
    return { ok: false, issue: { code: "UNSUPPORTED_FORMAT", severity: "blocking", message: "The workbook could not be opened. Save it again from Excel as .xlsx and upload it." } };
  }
}

/**
 * Bytes → ingest result under a confirmed layout: the layout's sheet (exactly that name, or the CSV table), its header
 * row and columns, its number format. Every row of that table gets a disposition. Nothing is detected or guessed.
 */
export function readTrialBalanceSourceWithLayout(bytes: Uint8Array, ctx: ReadContext, xlsx: XlsxLike, profile: LayoutProfile, profileHash: string): LayoutRead {
  const tables = readSourceTables(bytes, ctx.fileName, xlsx);
  if (!tables.ok) return { result: unreadable(ctx, null, tables.issue), resolved: null };
  let sheet: WorkbookSheet | undefined;
  if (tables.kind === "csv" && profile.sheet.kind === "csv") sheet = tables.sheets[0];
  if (tables.kind === "workbook" && profile.sheet.kind === "sheet") {
    const name = profile.sheet.name;
    sheet = tables.sheets.find((s) => s.name === name);
  }
  if (!sheet) {
    const wanted = profile.sheet.kind === "csv" ? "a CSV file" : `a sheet named “${profile.sheet.name}”`;
    return { result: unreadable(ctx, null, { code: "LAYOUT_SHEET_NOT_FOUND", severity: "blocking", message: `The confirmed layout is for ${wanted}, which this file does not have. Check the file, or confirm a new layout.` }), resolved: null };
  }
  // A layout says where the columns are; it cannot supply a value the file does not hold (S2-I01).
  const uncalculated = uncalculatedFormulaIssue(sheet);
  if (uncalculated) return { result: unreadable(ctx, tables.kind === "csv" ? null : sheet.name, uncalculated), resolved: null };
  return ingestWithLayout({ rows: sheet.rows, sheetName: tables.kind === "csv" ? null : sheet.name, periodYear: ctx.periodYear, currency: ctx.currency, workspaceEntityName: ctx.workspaceEntityName }, profile, profileHash);
}
