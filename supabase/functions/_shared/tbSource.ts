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
 */

import {
  decodeCsvBytes, detectColumns, ingestTrialBalance, parseCsvText, sheetRowsFromMatrix,
  type Cell, type IngestIssue, type IngestResult, type SourceRow,
} from "./tbIngestion.ts";

export type SourceFormat = "xlsx" | "csv" | "unknown";

export function detectSourceFormat(fileName: string): SourceFormat {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (["xlsx", "xls", "xlsm"].includes(ext)) return "xlsx";
  if (["csv", "tsv", "txt"].includes(ext)) return "csv";
  return "unknown";
}

/** The subset of the SheetJS API this module uses. */
export interface XlsxLike {
  read(data: Uint8Array, opts: { type: "array"; cellDates?: boolean }): { SheetNames: string[]; Sheets: Record<string, Record<string, unknown>> };
  utils: {
    decode_range(ref: string): { s: { r: number; c: number }; e: { r: number; c: number } };
    sheet_to_json<T>(ws: Record<string, unknown>, opts: { header: 1; defval: null; raw: true; blankrows: true }): T[];
  };
}

export interface WorkbookSheet { name: string; rows: SourceRow[] }

export function workbookSheets(xlsx: XlsxLike, wb: ReturnType<XlsxLike["read"]>): WorkbookSheet[] {
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const ref = typeof ws?.["!ref"] === "string" ? (ws["!ref"] as string) : null;
    if (!ref) return { name, rows: [] };
    const start = xlsx.utils.decode_range(ref).s.r + 1;
    const matrix = xlsx.utils.sheet_to_json<Cell[]>(ws, { header: 1, defval: null, raw: true, blankrows: true });
    return { name, rows: sheetRowsFromMatrix(matrix, start) };
  });
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

export interface ReadContext { fileName: string; periodYear: number | null; currency: string | null }

/** A result with no rows: the file could not be read at all. Lineage and totals are empty; the one issue says why. */
function unreadable(ctx: ReadContext, sheetName: string | null, issue: IngestIssue): IngestResult {
  const r = ingestTrialBalance({ rows: [], sheetName, periodYear: ctx.periodYear, currency: ctx.currency });
  // Replace the generic "file has no rows" with the actual reason, keeping any prerequisite issue (period/currency).
  const kept = r.issues.filter((i) => i.code !== "FILE_EMPTY");
  return { ...r, issues: [...kept, issue], blocking: true };
}

/** Bytes → ingest result, for a flat trial balance (CSV or workbook). */
export function readTrialBalanceSource(bytes: Uint8Array, ctx: ReadContext, xlsx: XlsxLike): IngestResult {
  const format = detectSourceFormat(ctx.fileName);
  if (format === "unknown") {
    return unreadable(ctx, null, { code: "UNSUPPORTED_FORMAT", severity: "blocking", message: "Upload the trial balance as .xlsx, .xls or .csv." });
  }
  if (format === "csv") {
    const decoded = decodeCsvBytes(bytes);
    if (!decoded.ok) return unreadable(ctx, null, decoded.issue);
    const parsed = parseCsvText(decoded.text);
    if (!parsed.ok) return unreadable(ctx, null, parsed.issue);
    return ingestTrialBalance({ rows: parsed.rows, sheetName: null, periodYear: ctx.periodYear, currency: ctx.currency });
  }
  let wb: ReturnType<XlsxLike["read"]>;
  try {
    wb = xlsx.read(bytes, { type: "array", cellDates: false });
  } catch {
    return unreadable(ctx, null, { code: "UNSUPPORTED_FORMAT", severity: "blocking", message: "The workbook could not be opened. Save it again from Excel as .xlsx and upload it." });
  }
  const choice = selectTrialBalanceSheet(workbookSheets(xlsx, wb), ctx.periodYear);
  if (!choice.ok) return unreadable(ctx, null, choice.issue);
  return ingestTrialBalance({ rows: choice.sheet.rows, sheetName: choice.sheet.name, periodYear: ctx.periodYear, currency: ctx.currency });
}
