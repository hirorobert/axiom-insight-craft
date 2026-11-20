/**
 * tbIngestion — the ONE pure ingestion core for an uploaded trial balance (process-trial-balance).
 *
 * Plain TypeScript whose only import is the currency registry, so the Deno edge function and the vitest suite run
 * the same code. It turns the
 * rows of a CSV or worksheet into accounts, and accounts for every source row on the way:
 *
 *   · Exact money. Every amount is parsed from its text into integer minor units (bigint) at the reporting
 *     currency's ISO 4217 exponent. Totals, the balance check and every comparison are exact; there is no tolerance.
 *     An amount with more decimal places than the currency allows is refused, never rounded.
 *   · Explicit period and currency. Processing needs the period and currency the trial balance was uploaded for —
 *     there are no defaults. A file whose own headings name only other years, a currency code that contradicts the
 *     reporting currency, or several amount columns with no way to tell which period they belong to are refused.
 *   · One identity per account. A repeated account code (or, in a file without codes, a repeated account name) is
 *     refused, never merged or last-row-wins. A row with amounts but no code, in a file that has codes, is refused.
 *   · Safe totals. Only rows WITHOUT an account code can be read as total or subtotal rows, and a grand-total row
 *     must agree exactly with the accounts above it. A coded row is always an account.
 *   · Complete lineage. Every physical row of the source gets exactly one disposition (header, preamble, blank,
 *     heading, total, zero balance, account, rejected) with its 1-based row number, so the counts always add up to
 *     the rows read.
 *   · Detected vendor adapters, never global relaxations. A QuickBooks Desktop export (heading-less name column,
 *     TOTAL label outside it) and a Tally (TallyPrime) export (group subtotal lines above indented ledgers, Indian
 *     grouping, Dr/Cr suffix, Grand Total) are each read only when positively detected, and the detection is recorded
 *     in `columns`; a file that is not detected is read exactly as before.
 *
 * Issues are "blocking" (the trial balance cannot be accepted until the file is corrected) or "review" (recorded for
 * the reviewer). Messages name the rows and say what to change.
 */

import { CURRENCY_REGISTRY } from "./currencyRegistry.ts";
import { PRINTED_FOOTER_RULES, footerRuleFor, isStandalonePageNumber } from "./printedReportMetadata.ts";

export const TB_INGESTION_VERSION = "tb-ingest-3.4.0";

export type Cell = string | number | boolean | null | undefined;

/** One physical row of the source. rowNumber is 1-based, exactly as a spreadsheet or text editor shows it. */
export interface SourceRow {
  rowNumber: number;
  cells: Cell[];
}

export type IssueCode =
  // The upload policy (uploadPolicy.ts): resource limits checked before any check runs.
  | "FILE_TOO_LARGE" | "WORKBOOK_TOO_LARGE_EXPANDED" | "WORKBOOK_TOO_MANY_PARTS" | "TOO_MANY_ROWS" | "TOO_MANY_CELLS" | "TOO_MANY_ACCOUNTS"
  | "FILE_EMPTY"
  | "UNSUPPORTED_FORMAT"
  | "ENCODING_NOT_UTF8"
  | "CSV_UNTERMINATED_QUOTE"
  // A workbook cell inside the sheet read that has a formula but no calculated value (tbSource.ts): refused as a whole.
  | "FORMULA_WITHOUT_VALUE"
  | "MULTIPLE_TRIAL_BALANCE_SHEETS"
  | "UNSUPPORTED_LAYOUT"
  | "MISSING_COLUMN"
  | "AMBIGUOUS_AMOUNT_COLUMNS"
  | "PERIOD_NOT_SELECTED"
  | "PERIOD_MISMATCH"
  | "CURRENCY_UNRESOLVED"
  | "CURRENCY_UNSUPPORTED"
  | "CURRENCY_MISMATCH"
  | "MALFORMED_NUMERIC_VALUE"
  | "PRECISION_EXCEEDS_CURRENCY"
  | "AMOUNT_OUT_OF_RANGE"
  | "BALANCE_COLUMN_MISMATCH"
  | "MISSING_ACCOUNT_CODE"
  | "DUPLICATE_ACCOUNT_CODE"
  | "DUPLICATE_ACCOUNT_NAME"
  | "TOTAL_ROW_MISMATCH"
  | "TEMPLATE_EXAMPLE_UPLOADED"
  | "NO_ACCOUNT_ROWS"
  | "TRIAL_BALANCE_IMBALANCE"
  // Review only (never blocking): text after the last account that no printed-footer rule recognises.
  | "UNRECOGNISED_TRAILING_TEXT"
  // Review only (never blocking): the title block names an entity that differs from the workspace's entity.
  | "ENTITY_NAME_DIFFERS"
  // Review only (never blocking): a clearing, suspense or in-transit account carries a balance.
  | "CLEARING_ACCOUNT_BALANCE"
  // A confirmed layout (layout-template/1, _shared/layoutProfile.ts) that does not fit the file. Never produced
  // without a layout.
  | "LAYOUT_SHEET_NOT_FOUND"
  | "LAYOUT_HEADER_NOT_FOUND"
  | "LAYOUT_COLUMN_NOT_FOUND"
  | "LAYOUT_COLUMN_DUPLICATED"
  | "LAYOUT_NUMBER_FORMAT_MISMATCH";

export interface IngestIssue {
  code: IssueCode;
  severity: "blocking" | "review";
  message: string;
  rows?: number[];
  field?: string;
  /**
   * A finding that takes a recorded decision (tb_decision_actions) names WHAT it is about, stably: the identity a decision
   * binds to (code + subject), checked by the database against the certification's own findings.
   */
  subject?: string;
  /** ENTITY_NAME_DIFFERS: the entity as the file names it (the confirmation must repeat it exactly). */
  fileEntity?: string;
  /** CLEARING_ACCOUNT_BALANCE: the account the finding is about. */
  accountCode?: string | null;
}

const MAX_LISTED_ROWS = 10;

function listRows(rows: number[]): string {
  const shown = rows.slice(0, MAX_LISTED_ROWS).join(", ");
  return rows.length > MAX_LISTED_ROWS ? `${shown} and ${rows.length - MAX_LISTED_ROWS} more` : shown;
}

// ── Currency ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ISO 4217 minor-unit exponents for the currencies a reporting period may use: currency-registry/1
 * (_shared/currencyRegistry.ts, the same published list as public.currency_registry). A currency missing here is refused
 * (CURRENCY_UNSUPPORTED), never assumed to have two decimals.
 */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = CURRENCY_REGISTRY;

export function currencyExponent(code: string | null | undefined): number | null {
  if (!code) return null;
  const e = CURRENCY_EXPONENTS[code.trim().toUpperCase()];
  return e === undefined ? null : e;
}

// ── Exact amounts ────────────────────────────────────────────────────────────────────────────────────────────────────

export type ParsedAmount =
  | { kind: "blank" }
  | { kind: "amount"; minor: bigint }
  | { kind: "malformed"; text: string }
  | { kind: "precision"; text: string; decimals: number }
  | { kind: "range"; text: string }
  /** Only under a declared number format: the text reads in another known format (layoutProfile.ts). */
  | { kind: "format"; text: string };

const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
/** Leading 0s or 9s beyond a currency's decimals that mark a number cell's excess digits as arithmetic noise (< one millionth of a minor unit). */
const NUMBER_CELL_NOISE_DIGITS = 6;
const DASH_ONLY = /^[-‐‑‒–—―]$/;
// Plain digits, or 1–3 digits followed by comma- or space-separated groups of exactly three; optional fraction.
const AMOUNT_GRAMMAR = /^(\d+|\d{1,3}(?:,\d{3})+|\d{1,3}(?: \d{3})+)(?:\.(\d+))?$/;

function pow10(n: number): bigint {
  let r = 1n;
  for (let i = 0; i < n; i++) r *= 10n;
  return r;
}

/**
 * A spreadsheet number cell is an IEEE double. Excel keeps 15 significant digits, so a value is first reduced to
 * those (0.30000000000000004 → 0.3) and then read through the same exact text grammar as a CSV cell.
 */
function numberCellText(n: number): string | "tiny" | null {
  if (!Number.isFinite(n)) return null;
  const reduced = Number(n.toPrecision(15));
  if (Math.abs(reduced) >= 1e21) return null;
  // A non-zero magnitude below 1e-6 prints in exponent form and has more decimals than any currency allows.
  if (reduced !== 0 && Math.abs(reduced) < 1e-6) return "tiny";
  return String(reduced);
}

/** Parses one amount cell into exact minor units of a currency with `exponent` decimal places. */
export function parseAmount(cell: Cell, exponent: number): ParsedAmount {
  if (cell === null || cell === undefined || cell === "") return { kind: "blank" };
  if (typeof cell === "boolean") return { kind: "malformed", text: String(cell) };
  let text: string;
  if (typeof cell === "number") {
    const t = numberCellText(cell);
    if (t === null) return { kind: "range", text: String(cell) };
    if (t === "tiny") return { kind: "precision", text: String(cell), decimals: 7 };
    text = t;
  } else {
    text = String(cell).replace(/ /g, " ").trim();
  }
  if (text === "" || DASH_ONLY.test(text)) return { kind: "blank" };

  let negative = false;
  let body = text;
  if (/^\(.*\)$/.test(body)) { negative = true; body = body.slice(1, -1).trim(); }
  if (body.startsWith("-")) {
    if (negative) return { kind: "malformed", text };
    negative = true;
    body = body.slice(1).trim();
  } else if (body.startsWith("+")) {
    body = body.slice(1).trim();
  }

  const m = AMOUNT_GRAMMAR.exec(body);
  if (!m) return { kind: "malformed", text };
  const whole = m[1].replace(/[ ,]/g, "");
  let fraction = m[2] ?? "";
  // Trailing zeros carry no value ("1.500" is 1.5); only significant decimals count against the currency.
  fraction = fraction.replace(/0+$/, "");
  // Arithmetic noise in a spreadsheet NUMBER cell (QuickBooks Online writes 812.429999999999 for 812.43, still inside Excel's
  // 15 significant digits): when the digits beyond the currency's decimals are 000000… or 999999…, the value is within a
  // millionth of one minor unit of a whole minor unit and is read as that unit. Exact digit arithmetic, never floating point.
  // Only for number cells: the same digits typed as TEXT (a CSV cell, a text cell) are still refused, and so is anything
  // further from a whole minor unit (0.005, 12.3400001).
  let noiseRoundUp = false;
  if (typeof cell === "number" && fraction.length > exponent) {
    const excess = fraction.slice(exponent);
    if (excess.startsWith("0".repeat(NUMBER_CELL_NOISE_DIGITS))) {
      fraction = fraction.slice(0, exponent).replace(/0+$/, "");
    } else if (excess.startsWith("9".repeat(NUMBER_CELL_NOISE_DIGITS))) {
      fraction = fraction.slice(0, exponent);
      noiseRoundUp = true;
    }
  }
  if (fraction.length > exponent) return { kind: "precision", text, decimals: fraction.length };
  const minorAbs = BigInt(whole) * pow10(exponent) + (fraction ? BigInt(fraction.padEnd(exponent, "0")) : 0n) + (noiseRoundUp ? 1n : 0n);
  if (minorAbs > MAX_SAFE_MINOR) return { kind: "range", text };
  return { kind: "amount", minor: negative ? -minorAbs : minorAbs };
}

/** Exact decimal text of a minor-unit amount, e.g. formatMinor(-123456n, 2) === "-1234.56". */
export function formatMinor(minor: bigint, exponent: number): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const s = abs.toString().padStart(exponent + 1, "0");
  const whole = exponent === 0 ? s : s.slice(0, s.length - exponent);
  const frac = exponent === 0 ? "" : `.${s.slice(s.length - exponent)}`;
  return `${negative ? "-" : ""}${whole}${frac}`;
}

/**
 * The double nearest to a minor-unit amount, for the legacy numeric fields of processing_result. Exact whenever
 * |minor| ≤ 2^53 (the parser refuses anything larger): IEEE division is correctly rounded, so this is the same double
 * that parsing the decimal text would give.
 */
export function minorToNumber(minor: bigint, exponent: number): number {
  return Number(minor) / Number(pow10(exponent));
}

// ── CSV ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type DecodeResult = { ok: true; text: string } | { ok: false; issue: IngestIssue };

/**
 * Strict UTF-8 (a UTF-8 byte-order mark is removed). Anything else is refused rather than decoded with U+FFFD. The same
 * rule reads a Tally XML export (`kind: "XML"`); only the refusal's wording differs.
 */
export function decodeCsvBytes(bytes: Uint8Array, kind: "CSV" | "XML" = "CSV"): DecodeResult {
  const fix = kind === "CSV" ? "Save it as “CSV UTF-8 (Comma delimited)” and upload it again." : "Save it as UTF-8 text and upload it again.";
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    return { ok: false, issue: { code: "ENCODING_NOT_UTF8", severity: "blocking", message: `The ${kind} is saved as UTF-16. ${fix}` } };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, issue: { code: "ENCODING_NOT_UTF8", severity: "blocking", message: `The ${kind} is not UTF-8 text. ${fix}` } };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { ok: true, text };
}

export type CsvResult = { ok: true; rows: SourceRow[]; delimiter: string } | { ok: false; issue: IngestIssue };

function detectDelimiter(text: string): string {
  const firstLines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "").slice(0, 15);
  const score = (d: string) => firstLines.reduce((n, l) => n + (l.split(d).length - 1), 0);
  const candidates: Array<[string, number]> = [[",", score(",")], [";", score(";")], ["\t", score("\t")]];
  candidates.sort((a, b) => b[1] - a[1]);
  return candidates[0][1] > 0 ? candidates[0][0] : ",";
}

/**
 * RFC 4180 parser: quoted fields, doubled quotes, delimiters and line breaks inside quotes, CRLF/LF/CR. Every record
 * keeps the 1-based line on which it starts; blank lines are kept as empty rows so lineage counts every line.
 */
export function parseCsvText(text: string, maxRows?: number): CsvResult {
  const delimiter = detectDelimiter(text);
  const rows: SourceRow[] = [];
  let cells: Cell[] = [];
  let field = "";
  let quoted = false;
  let fieldWasQuoted = false;
  let line = 1;
  let recordStart = 1;
  let quoteOpenedAt = 0;

  const endField = () => {
    const v = fieldWasQuoted ? field : field.trim();
    cells.push(v === "" ? null : v);
    field = "";
    fieldWasQuoted = false;
  };
  const endRecord = () => {
    endField();
    rows.push({ rowNumber: recordStart, cells: cells.every((c) => c === null) ? [] : cells });
    cells = [];
  };
  // The upload policy's row bound DURING the parse (as sheetRows for workbooks): stop after maxRows records, so an
  // over-limit file is refused by the caller's table check without the whole file ever being materialised.
  const full = () => maxRows !== undefined && rows.length >= maxRows;

  for (let i = 0; i < text.length && !full(); i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.trim() === "") { quoted = true; fieldWasQuoted = true; field = ""; quoteOpenedAt = line; continue; }
    if (ch === delimiter) { endField(); continue; }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordStart = line;
      continue;
    }
    field += ch;
  }
  if (full()) return { ok: true, rows, delimiter };
  if (quoted) {
    return { ok: false, issue: { code: "CSV_UNTERMINATED_QUOTE", severity: "blocking", rows: [quoteOpenedAt], message: `Row ${quoteOpenedAt} opens a quoted value that never closes. Check that row's quotation marks and upload the file again.` } };
  }
  if (field !== "" || cells.length > 0) endRecord();
  return { ok: true, rows, delimiter };
}

/** Worksheet rows from a header:1 matrix whose first entry is spreadsheet row `firstRowNumber` (1-based). */
export function sheetRowsFromMatrix(matrix: Cell[][], firstRowNumber: number): SourceRow[] {
  return matrix.map((cells, i) => ({ rowNumber: firstRowNumber + i, cells: (cells ?? []).every((c) => c === null || c === undefined || c === "") ? [] : cells }));
}

// ── Columns ──────────────────────────────────────────────────────────────────────────────────────────────────────────

type ColumnRole = "account_code" | "account_name" | "debit" | "credit" | "balance";

const COLUMN_MATCHERS: Record<ColumnRole, (s: string) => boolean> = {
  account_code: (s) =>
    s === "code" || s === "natural account" || s.startsWith("a/c") ||
    (s.startsWith("gl") && s.includes("code")) || (s.startsWith("ledger") && s.includes("code")) ||
    (s.startsWith("acc") && s.includes("code")) ||
    (s.startsWith("account") && (s.includes("code") || s.includes("number") || /\bno\.?$/.test(s))),
  account_name: (s) =>
    s === "name" || s === "description" || s === "particulars" || s === "account" ||
    (s.startsWith("gl") && s.includes("name")) || (s.startsWith("ledger") && s.includes("name")) ||
    (s.startsWith("account") && (s.includes("name") || s.includes("description") || s.includes("title"))),
  debit: (s) => /\bdebits?\b/.test(s) || /^dr\b\.?/.test(s),
  credit: (s) => /\bcredits?\b/.test(s) || /^cr\b\.?/.test(s),
  balance: (s) => s.startsWith("amount") || s.startsWith("net amount") || /\bbalance\b/.test(s),
};

function headerText(c: Cell): string {
  return String(c ?? "").replace(/ /g, " ").trim().toLowerCase().replace(/\s+/g, " ");
}

function roleOf(s: string): ColumnRole | null {
  if (!s) return null;
  // Order matters: an account-code header ("Account No") must not be read as a name, and a debit/credit header
  // naming a balance ("Debit balance") is a debit column.
  for (const role of ["account_code", "debit", "credit", "account_name", "balance"] as ColumnRole[]) {
    if (COLUMN_MATCHERS[role](s)) return role;
  }
  return null;
}

export interface ColumnMap {
  account_code: number | null;
  account_name: number | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
  /**
   * Dimension columns (cost centre, department, branch, fund, project, …). A trial balance split by a dimension has one
   * row per account AND dimension value, so the same code may legitimately repeat — its identity includes these values.
   */
  dimensions: number[];
  /** Index into the rows array of the header row. */
  headerIndex: number;
  headerRowNumber: number;
  headers: string[];
}

/** Headers that split a trial balance by a reporting dimension. */
const DIMENSION_HEADER = /\b(cost ?cent(re|er)s?|cost ?cent(re|er) code|department|dept|branch|location|division|fund|project|segment|region|site|programme|program|donor|business unit|profit cent(re|er)s?|sub-?ledger|activity|grant)\b/;
/** Headers that only a transaction listing has — a trial balance has none of them. */
const TRANSACTION_HEADER = /\b(date|posting date|value date|txn date|voucher|journal|jv no|narration|transaction|cheque|invoice no|document no)\b/;

export interface ColumnDetection {
  map: ColumnMap | null;
  /** role → header text as written, for the record. */
  detected: Record<string, string>;
  issues: IngestIssue[];
}

function yearsIn(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/(?<!\d)(19\d{2}|20\d{2}|2100)(?:\s*[/-]\s*(\d{2})(?!\d))?/g)) {
    const y = Number(m[1]);
    out.add(y);
    if (m[2] !== undefined) {
      const tail = Number(m[2]);
      const century = Math.floor(y / 100) * 100;
      const next = century + tail < y ? century + 100 + tail : century + tail;
      if (next === y + 1) out.add(next);
    }
  }
  return [...out];
}

/**
 * QuickBooks Desktop (and some other exports) leave the account-name column's heading BLANK. That is read as the account name
 * only when it is unambiguous, never guessed: exactly one heading-less column (other than the amount columns) holds text — at
 * least two different non-numeric values and at least 90 % of its non-empty cells non-numeric. Zero or several such columns,
 * or a column that is mostly numbers, return null and the file stays refused as before.
 */
function inferUnlabelledNameColumn(rows: SourceRow[], headerIndex: number, headers: string[], amountColumns: number[]): number | null {
  const numericLike = (c: Cell): boolean => typeof c === "number" || (typeof c === "string" && /^[\s(+\-−]*[\d][\d.,\s]*\)?\s*$/.test(c));
  const body = rows.slice(headerIndex + 1, headerIndex + 2001);
  const qualifying: number[] = [];
  headers.forEach((h, col) => {
    if (h !== "" || amountColumns.includes(col)) return;
    const filled = body.map((r) => r.cells[col]).filter((c) => c !== null && c !== undefined && String(c).trim() !== "");
    const text = filled.filter((c) => !numericLike(c)).map((c) => String(c).trim().toLowerCase());
    if (filled.length >= 2 && new Set(text).size >= 2 && text.length / filled.length >= 0.9) qualifying.push(col);
  });
  return qualifying.length === 1 ? qualifying[0] : null;
}

/** Scans the first 15 rows for the header with the most recognised columns, then resolves each role to one column. */
export function detectColumns(rows: SourceRow[], periodYear: number | null): ColumnDetection {
  const scan = Math.min(rows.length, 15);
  let bestIndex = -1;
  let bestScore = 0;
  for (let r = 0; r < scan; r++) {
    const roles = new Set(rows[r].cells.map((c) => roleOf(headerText(c))).filter((x): x is ColumnRole => x !== null));
    if (roles.size > bestScore) { bestScore = roles.size; bestIndex = r; }
  }
  const issues: IngestIssue[] = [];
  if (bestIndex < 0) {
    issues.push({ code: "MISSING_COLUMN", severity: "blocking", field: "header", message: "No header row was found in the first 15 rows. Add a header row with Account Name and Debit/Credit (or Balance) columns." });
    return { map: null, detected: {}, issues };
  }

  const header = rows[bestIndex];
  const headers = header.cells.map((c) => String(c ?? "").trim());
  const byRole: Record<ColumnRole, number[]> = { account_code: [], account_name: [], debit: [], credit: [], balance: [] };
  headers.forEach((h, i) => { const role = roleOf(headerText(h)); if (role) byRole[role].push(i); });

  const detected: Record<string, string> = {};
  const pick = (role: ColumnRole, columns: number[]): number | null => {
    if (columns.length === 0) return null;
    detected[role] = headers[columns[0]];
    return columns[0];
  };

  // Several columns of the same amount kind usually means several periods (2025 / 2024, or opening / closing).
  // The one for the selected period is used only when exactly one of them names that year; otherwise refused.
  const resolveAmount = (role: "debit" | "credit" | "balance"): number | null | "ambiguous" => {
    const cols = byRole[role];
    if (cols.length <= 1) return pick(role, cols);
    if (periodYear !== null) {
      const forPeriod = cols.filter((c) => yearsIn(headers[c]).includes(periodYear));
      if (forPeriod.length === 1) return pick(role, forPeriod);
    }
    if (role === "balance") {
      const closing = cols.filter((c) => /\bclosing\b/i.test(headers[c]));
      if (closing.length === 1) return pick(role, closing);
    }
    return "ambiguous";
  };

  const debit = resolveAmount("debit");
  const credit = resolveAmount("credit");
  const hasDebitCredit = debit !== null && credit !== null;
  // With Debit and Credit columns, ONE balance column is cross-checked against them on every row (BALANCE_COLUMN_MISMATCH).
  // Two or more (an opening and a closing balance, or two years) cannot be checked against one Debit and Credit pair, and
  // beside an opening and a closing balance the Debit and Credit columns are the period's MOVEMENTS, not balances at the
  // reporting date. Refused (S2-I02) — never read on the movements — until a confirmed layout names the closing-balance
  // column, or the file is exported with closing balances only.
  const balanceBesideDebitCredit = hasDebitCredit && byRole.balance.length > 1;
  const balance = hasDebitCredit ? (balanceBesideDebitCredit ? null : pick("balance", byRole.balance)) : resolveAmount("balance");
  if (balanceBesideDebitCredit) {
    const names = byRole.balance.map((c) => `“${headers[c]}”`).join(", ");
    issues.push({
      code: "AMBIGUOUS_AMOUNT_COLUMNS", severity: "blocking", field: "balance", rows: [header.rowNumber],
      message: `Row ${header.rowNumber} has Debit and Credit columns and ${byRole.balance.length} balance columns (${names}). Beside an opening and a closing balance, Debit and Credit are usually the period's movements, not the balances at the reporting date, so this file cannot be read automatically. On the File layout page, choose the closing-balance column as the Balance column and leave Debit and Credit unassigned; or export the trial balance with closing balances only (one Debit and one Credit column, or one Balance column) and upload that.`,
    });
    // The movement columns are not proposed as the trial balance's Debit and Credit (the layout editor starts from this).
    delete detected.debit;
    delete detected.credit;
  }

  for (const [role, value] of [["debit", debit], ["credit", credit], ["balance", balance]] as const) {
    if (value === "ambiguous") {
      const names = byRole[role].map((c) => `“${headers[c]}”`).join(", ");
      issues.push({
        code: "AMBIGUOUS_AMOUNT_COLUMNS", severity: "blocking", field: role, rows: [header.rowNumber],
        message: `Row ${header.rowNumber} has more than one ${role} column (${names}) and none is clearly for ${periodYear ?? "the selected period"}. Keep one ${role} column — for the selected period only — and upload the file again.`,
      });
    }
  }

  const unassigned = headers.map((h, i) => ({ h, i, t: headerText(h) })).filter((x) => x.t && roleOf(x.t) === null);
  const dimensions = unassigned.filter((x) => DIMENSION_HEADER.test(x.t)).map((x) => x.i);
  if (dimensions.length > 0) detected.dimensions = dimensions.map((i) => headers[i]).join(", ");
  const transactional = unassigned.filter((x) => TRANSACTION_HEADER.test(x.t)).map((x) => `“${x.h}”`);
  if (transactional.length > 0) {
    issues.push({
      code: "UNSUPPORTED_LAYOUT", severity: "blocking", rows: [header.rowNumber],
      message: `Row ${header.rowNumber} has transaction columns (${transactional.join(", ")}), so this looks like a general-ledger transaction listing, not a trial balance. Export the trial balance itself — one row per account with its closing debit or credit — and upload that.`,
    });
  }

  const map: ColumnMap = {
    account_code: pick("account_code", byRole.account_code),
    account_name: pick("account_name", byRole.account_name),
    debit: typeof debit === "number" ? debit : null,
    credit: typeof credit === "number" ? credit : null,
    balance: typeof balance === "number" ? balance : null,
    dimensions,
    headerIndex: bestIndex,
    headerRowNumber: header.rowNumber,
    headers,
  };

  // A heading-less account-name column (QuickBooks Desktop export): accepted only when unambiguous, and recorded in `detected` so the
  // read says plainly that the name column had no heading.
  if (map.account_name === null && map.account_code === null && map.debit !== null && map.credit !== null) {
    const inferred = inferUnlabelledNameColumn(rows, bestIndex, headers, [map.debit, map.credit, ...(map.balance !== null ? [map.balance] : [])]);
    if (inferred !== null) { map.account_name = inferred; detected.account_name = `(unlabelled column ${columnLetter(inferred)})`; }
  }
  if (map.account_name === null && map.account_code === null) {
    issues.push({ code: "MISSING_COLUMN", severity: "blocking", field: "account_name", rows: [header.rowNumber], message: "No account name column was found. Name a column “Account Name” (or Description / Particulars)." });
  }
  const amountsAmbiguous = issues.some((i) => i.code === "AMBIGUOUS_AMOUNT_COLUMNS");
  if (!amountsAmbiguous && !(map.debit !== null && map.credit !== null) && map.balance === null) {
    const missing = map.debit === null && map.credit === null ? "Debit and Credit" : map.debit === null ? "Debit" : "Credit";
    issues.push({ code: "MISSING_COLUMN", severity: "blocking", field: "amounts", rows: [header.rowNumber], message: `No ${missing} column was found. Use Debit and Credit columns, or a single Balance column (debits positive, credits negative).` });
  }
  return { map, detected, issues };
}

// ── Period and currency evidence ─────────────────────────────────────────────────────────────────────────────────────

/** A title or column label that states the period (not a print, run or export date). */
function describesPeriod(text: string): boolean {
  return /\b(year|period|as\s+at|as\s+of|ended|ending|fy|trial\s+balance|financial|debit|credit|balance|dr|cr|amount)\b/i.test(text)
    && !/\b(print(ed)?|run|generated|exported|report\s+date|date\s+printed)\b/i.test(text);
}

/**
 * Checks what the file says about itself against the period and currency it was uploaded for. Conservative: a file
 * that names no year passes; a file is refused only when every year it names is another one.
 */
export function periodAndCurrencyIssues(rows: SourceRow[], map: ColumnMap, periodYear: number, currency: string): IngestIssue[] {
  const issues: IngestIssue[] = [];
  const preamble = rows.slice(0, map.headerIndex + 1);
  const years = new Set<number>();
  const yearRows: number[] = [];
  for (const row of preamble) {
    const found = row.cells.flatMap((c) => (typeof c === "string" && describesPeriod(c) ? yearsIn(c) : []));
    if (found.length > 0) { found.forEach((y) => years.add(y)); yearRows.push(row.rowNumber); }
  }
  if (years.size > 0 && !years.has(periodYear)) {
    issues.push({
      code: "PERIOD_MISMATCH", severity: "blocking", rows: yearRows,
      message: `The file's heading refers to ${[...years].sort().join(", ")}, but this trial balance is being uploaded for ${periodYear}. Upload the ${periodYear} trial balance, or open the workspace for the year the file belongs to.`,
    });
  }

  const target = currency.toUpperCase();
  const otherCodes = new Set<string>();
  const amountHeaders = [map.debit, map.credit, map.balance].filter((c): c is number => c !== null).map((c) => map.headers[c] ?? "");
  for (const h of amountHeaders) {
    for (const m of h.toUpperCase().matchAll(/\b([A-Z]{3})\b/g)) {
      if (CURRENCY_EXPONENTS[m[1]] !== undefined && m[1] !== target) otherCodes.add(m[1]);
    }
  }
  if (otherCodes.size > 0) {
    issues.push({
      code: "CURRENCY_MISMATCH", severity: "blocking", rows: [map.headerRowNumber],
      message: `The amount columns are labelled ${[...otherCodes].join(", ")}, but this period reports in ${target}. Upload the trial balance in ${target}.`,
    });
  }
  return issues;
}

// ── Title-block evidence (Phase 1 §3.3, §3.4) ────────────────────────────────────────────────────────────────────────

/** One cell of the source, as evidence: its trimmed text and where it is ("B3"-style column letter, 1-based row). */
export interface EvidenceCell { text: string; row: number; column: string }

/**
 * What the file says about itself above the header: an identifiable entity name, the period text and the currency
 * labels. Evidence only. Nothing here sets an entity, a period, a currency or a framework.
 */
export interface TitleBlockEvidence {
  /** The title block's entity name, only when it is identifiable (it carries a legal or organisational form). */
  entity: EvidenceCell | null;
  /** Title-block text that states the period (not a print or run date). */
  period: EvidenceCell[];
  /** ISO 4217 codes the file labels its amounts with (header or label row). */
  currencyLabels: (EvidenceCell & { code: string })[];
}

export const EMPTY_TITLE_BLOCK: TitleBlockEvidence = Object.freeze({ entity: null, period: [], currencyLabels: [] }) as TitleBlockEvidence;

/** A word that marks text as an organisation's name. Arbitrary cell text without one is never compared. */
const ENTITY_FORM = /\b(ltd|limited|plc|inc|incorporated|llc|llp|lp|corp|corporation|company|gmbh|ag|s\.?a\.?|sarl|b\.?v\.?|n\.?v\.?|pty|trust|council|authority|foundation|association|society|co-?operative|cooperative|group|holdings|partners|partnership|ministry|agency|commission|university|college|school|hospital|church|institute)\b|\bco\.?$/i;
const REPORT_TITLE = /\b(trial\s+balance|report|statement|ledger|listing|balances)\b/i;

export function columnLetter(index: number): string {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Reads the title block (the rows above the header) as evidence. */
export function readTitleBlockEvidence(rows: SourceRow[], headerIndex: number): Omit<TitleBlockEvidence, "currencyLabels"> {
  let entity: EvidenceCell | null = null;
  const period: EvidenceCell[] = [];
  for (const row of rows.slice(0, Math.max(0, headerIndex))) {
    row.cells.forEach((c, col) => {
      if (typeof c !== "string") return;
      const text = c.replace(/ /g, " ").replace(/\s+/g, " ").trim();
      if (!text || text.length > 160) return;
      const cell = { text, row: row.rowNumber, column: columnLetter(col) };
      if (describesPeriod(text) && yearsIn(text).length > 0) { period.push(cell); return; }
      if (!entity && ENTITY_FORM.test(text) && !REPORT_TITLE.test(text)) entity = cell;
    });
  }
  return { entity, period };
}

/** Canonical form for comparing entity names: case, punctuation, "the" and common legal-form spellings ignored. */
export function normaliseEntityName(name: string): string {
  return name.toLowerCase()
    .replace(/&/g, " and ").replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\blimited\b/g, "ltd").replace(/\bincorporated\b/g, "inc").replace(/\bcompany\b/g, "co").replace(/\bcorporation\b/g, "corp")
    .replace(/^\s*the\s+/, "").replace(/\s+/g, " ").trim();
}

/**
 * The confirmation a differing title-block entity needs (review, never blocking). It names both, with the source text
 * and its location. Confirming it never renames an entity, moves evidence or bypasses authorisation.
 */
export function entityConfirmation(evidence: TitleBlockEvidence, workspaceEntityName: string | null | undefined): IngestIssue | null {
  const fileEntity = evidence.entity;
  const workspace = (workspaceEntityName ?? "").trim();
  if (!fileEntity || !workspace) return null;
  if (normaliseEntityName(fileEntity.text) === normaliseEntityName(workspace)) return null;
  return {
    code: "ENTITY_NAME_DIFFERS", severity: "review", rows: [fileEntity.row], field: "entity",
    subject: normaliseEntityName(fileEntity.text), fileEntity: fileEntity.text,
    message: `This file names ${fileEntity.text}; this workspace is ${workspace}. Same entity? (From your file: “${fileEntity.text}”, cell ${fileEntity.column}${fileEntity.row}.)`,
  };
}

// ── Rows → accounts ──────────────────────────────────────────────────────────────────────────────────────────────────

export type RowDisposition =
  | "preamble" | "header" | "blank" | "heading" | "total" | "zero_balance" | "account" | "rejected";

export interface RowLineage {
  rowNumber: number;
  disposition: RowDisposition;
  /** The account identity for an "account" row. */
  identity?: string;
  reason?: string;
  /** Total and excluded rows: the amounts the reader parsed from them (exact minor units), for investigation. */
  debitMinor?: bigint;
  creditMinor?: bigint;
}

export interface IngestedAccount {
  /** The code as written, or — in a file without codes — the account name. Legacy key used downstream. */
  accountCode: string;
  accountName: string;
  /** True when the file supplied a real account code for this row. */
  codeProvided: boolean;
  /**
   * "code:<code>" or "name:<normalised name>", followed by "|<dimension>=<value>" for each dimension column with a
   * value — unique within one trial balance.
   */
  identity: string;
  /** Dimension values for this row (header → value), when the trial balance is split by dimension. */
  dimensions: Record<string, string>;
  debitMinor: bigint;
  creditMinor: bigint;
  sourceRowNumber: number;
}

export interface IngestResult {
  version: string;
  currency: string | null;
  exponent: number | null;
  periodYear: number | null;
  sheetName: string | null;
  columns: Record<string, string>;
  accounts: IngestedAccount[];
  lineage: RowLineage[];
  lineageSummary: { rowsRead: number } & Record<RowDisposition, number>;
  totals: { debitMinor: bigint; creditMinor: bigint; differenceMinor: bigint } | null;
  issues: IngestIssue[];
  /** Coded rows whose names read like totals — named in an imbalance message so a double count is easy to find. */
  suspectedTotalRows: number[];
  blocking: boolean;
  /** What the file says about itself above the header (entity, period, currency labels): evidence only. */
  evidence: TitleBlockEvidence;
  /** The review-only rules (§3.6): each says whether it applied and what it found. None blocks or adjusts by itself. */
  reviewChecks: ReviewCheck[];
}

/** One review-only rule's applicability and outcome (Phase 1 §3.6). */
export interface ReviewCheck {
  id: "duplicate_identities" | "residual_balances" | "unexpected_side_balances" | "clearing_account_balances" | "opening_and_movement_columns";
  label: string;
  /** "not_run" always carries the reason it could not run (for example, no configured policy). */
  outcome: "passed" | "review" | "notice" | "blocked" | "not_run";
  reason: string;
  rows?: number[];
}

/** Account names that hold amounts only until they are cleared: a balance on them needs reconciliation evidence. */
const CLEARING_ACCOUNT_NAME = /\b(clearing|suspense|in\s+transit|transit|holding\s+account|unallocated|unidentified\s+(receipts?|deposits?)|control\s+clearing)\b/i;

const TOTAL_NAME_PATTERNS: RegExp[] = [
  /^(grand\s+)?totals?\b/i, /^sub[-\s]?totals?\b/i, /\btotals?\s*:?$/i,
  /^net\s+(assets|liabilities|equity|income|profit|loss|surplus|deficit)\b/i,
  /^balance\s*check\b/i, /^check\s*figure\b/i, /^proof\s+of\s+(balance|totals?)\b/i, /must\s*be\s*zero/i,
  /^difference\b/i, /^suspense\s+check\b/i,
];
const GRAND_TOTAL_PATTERN = /^(grand\s+)?totals?(\s+(for\s+the\s+)?(trial\s+balance|tb))?\s*:?$|^(trial\s+balance|tb)\s+totals?\s*:?$/i;
const EXAMPLE_MARKER = /^example\b/i;

export function normalizeIdentityName(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

function cellString(c: Cell): string {
  if (c === null || c === undefined) return "";
  return String(c).replace(/ /g, " ").trim();
}

// ── Tally (TallyPrime) export adapter ────────────────────────────────────────────────────────────────────────────────
//
// TallyPrime's Trial Balance export (docs/release/tally-export-r1/README.md) has no account codes, a "Particulars"
// column, group lines whose own subtotal sits above their indented ledgers, Indian lakh grouping ("1,00,000.00"),
// Tally's "(-)" negative, a "Dr"/"Cr" suffix in a single Closing Balance column, and a Grand Total. The generic path
// reads none of that — a group line would be summed with its ledgers and the file would still balance. The adapter is
// applied only when the file is POSITIVELY detected (a "Trial Balance" title and a Tally period line above a
// "Particulars" header, detectTallyGrid) or when the rows came from the Tally XML reader (tallyXmlExport.ts), and the
// detection is recorded in `columns.source`. Under it:
//   · a group line (a named row followed by deeper-indented rows) is excluded exactly once and must equal, exactly, the
//     gross debit and credit totals of the ledgers beneath it or their net on one side ("Nett Debit/Credit Balances for
//     Reporting" is a per-group Tally option); anything else refuses the file (TOTAL_ROW_MISMATCH);
//   · a group line without its ledgers is refused, never read as an account: a depth-0 leaf other than Tally's
//     predefined "Profit & Loss A/c" ledger, or a leaf named as one of Tally's 28 predefined groups (UNSUPPORTED_LAYOUT);
//   · the Grand Total is required for a grid export and must equal the ledgers exactly;
//   · the amount grammar extensions apply to the detected file only — the generic path is byte-for-byte unchanged.

export type TallyAmountMode = "debit_credit" | "closing_drcr";
export type AmountField = "debit" | "credit" | "balance";

/** Tally's 28 predefined groups (help.tallysolutions.com, Pre-Defined Groups), in identity-normalised form. */
export const TALLY_PREDEFINED_GROUPS: ReadonlySet<string> = new Set([
  "Branch / Divisions", "Capital Account", "Current Assets", "Current Liabilities", "Direct Expenses", "Direct Incomes",
  "Fixed Assets", "Indirect Expenses", "Indirect Incomes", "Investments", "Loans (Liability)", "Misc. Expenses (ASSET)",
  "Purchase Accounts", "Sales Accounts", "Suspense A/c",
  "Bank Accounts", "Bank OD A/c", "Cash-in-hand", "Deposits (Asset)", "Duties & Taxes", "Loans & Advances (Asset)",
  "Provisions", "Reserves & Surplus", "Secured Loans", "Stock-in-hand", "Sundry Creditors", "Sundry Debtors", "Unsecured Loans",
].map(normalizeIdentityName));
/** Tally's predefined ledger that sits directly under Primary, so it is the one legitimate top-level leaf line. */
const TALLY_PL_LEDGER = normalizeIdentityName("Profit & Loss A/c");
const TALLY_DIFFERENCE_LINE = /^difference in opening balances?$/i;
const TALLY_GRAND_TOTAL = /^grand\s+total$/i;
/** Tally's period line, d-Mon-yyyy to d-Mon-yyyy (the date style of Tally's own XML samples). */
const TALLY_PERIOD_LINE = /^\d{1,2}-[A-Za-z]{3}-\d{4}\s+to\s+\d{1,2}-[A-Za-z]{3}-\d{4}$/;
/** Plain digits, international grouping, or Indian grouping (groups of two before a final group of three). */
const TALLY_AMOUNT_BODY = /^(\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3})(?:\.(\d+))?$/;

/**
 * One amount cell of a detected Tally grid export. Number cells are read exactly as the generic path reads them. Text
 * is read in Tally's own writing: plain, international or Indian grouping; "(-)" or "-" for a negative; and, in the
 * single Closing Balance column only, a required "Dr"/"Cr" suffix (a Debit or Credit column carries none).
 */
export function parseTallyAmount(cell: Cell, exponent: number, mode: TallyAmountMode, field?: AmountField): ParsedAmount {
  if (typeof cell !== "string") return parseAmount(cell, exponent);
  const text = cell.replace(/[  ]/g, " ").trim();
  if (text === "" || DASH_ONLY.test(text)) return { kind: "blank" };
  const suffix = /^(.*?)\s*(dr|cr)\.?$/i.exec(text);
  let body = suffix ? suffix[1].trim() : text;
  const side = suffix ? (suffix[2].toLowerCase() === "dr" ? "Dr" : "Cr") : null;
  if ((mode === "closing_drcr" && field === "balance") !== (side !== null)) return { kind: "malformed", text };
  let negative = false;
  if (body.startsWith("(-)")) { negative = true; body = body.slice(3).trim(); }
  else if (body.startsWith("-")) { negative = true; body = body.slice(1).trim(); }
  // A negative amount with a side suffix is contradictory; refused rather than resolved.
  if (negative && side) return { kind: "malformed", text };
  const m = TALLY_AMOUNT_BODY.exec(body);
  if (!m) return { kind: "malformed", text };
  const p = parseAmount(`${negative ? "-" : ""}${m[1].replace(/,/g, "")}${m[2] !== undefined ? `.${m[2]}` : ""}`, exponent);
  if (p.kind !== "amount") return p.kind === "blank" ? p : { ...p, text };
  return side === "Cr" ? { kind: "amount", minor: -p.minor } : p;
}

/**
 * One amount of a Tally XML export, as the XML reader hands it over (plain text, Tally's sign): a closing debit is
 * written negative (or empty) and a closing credit positive (or empty) — the only documented sample. The opposite sign
 * contradicts it and is refused, never flipped.
 */
export function parseTallyXmlAmount(cell: Cell, exponent: number, field?: AmountField): ParsedAmount {
  const p = parseAmount(cell, exponent);
  if (p.kind !== "amount") return p;
  if (field === "debit") return p.minor > 0n ? { kind: "malformed", text: cellString(cell) } : { kind: "amount", minor: -p.minor };
  if (field === "credit" && p.minor < 0n) return { kind: "malformed", text: cellString(cell) };
  return p;
}

export interface TallyAdapter {
  kind: "grid" | "xml";
  mode: TallyAmountMode;
  map: ColumnMap;
  /** The second row of a two-row Tally header ("Closing Balance" over "Debit" / "Credit"), as a row index; else null. */
  headerContinuation: number | null;
  detected: Record<string, string>;
  parse: (cell: Cell, exponent: number, field?: AmountField) => ParsedAmount;
}

/**
 * Positive detection of a Tally grid export: no account-code column, the name column headed exactly "Particulars", and
 * above it both a "Trial Balance" title cell and a Tally period line. Amounts are Debit and Credit columns (on the header
 * row, or on the row beneath a "Closing Balance" header) or one "Closing Balance" column read with Dr/Cr. Anything else
 * returns null and the file is read by the generic path exactly as before.
 */
export function detectTallyGrid(rows: SourceRow[], detection: ColumnDetection): TallyAdapter | null {
  const map = detection.map;
  if (!map || map.account_code !== null || map.account_name === null || map.dimensions.length > 0) return null;
  if (headerText(map.headers[map.account_name]) !== "particulars") return null;
  let title = false;
  let period = false;
  for (const row of rows.slice(0, map.headerIndex)) {
    for (const c of row.cells) {
      if (typeof c !== "string") continue;
      const t = c.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
      if (/^trial balance$/i.test(t)) title = true;
      if (TALLY_PERIOD_LINE.test(t)) period = true;
    }
  }
  if (!title || !period) return null;
  const detected = { ...detection.detected };
  if (map.debit !== null && map.credit !== null && map.balance === null) {
    detected.source = "Tally trial balance export (Debit / Credit columns)";
    return { kind: "grid", mode: "debit_credit", map, headerContinuation: null, detected, parse: (c, e, f) => parseTallyAmount(c, e, "debit_credit", f) };
  }
  if (map.balance !== null && map.debit === null && map.credit === null && /^closing balance$/i.test(headerText(map.headers[map.balance]))) {
    // A two-row header: "Closing Balance" over "Debit" and "Credit" on the next row, with nothing else on that row.
    const next = rows[map.headerIndex + 1];
    if (next && next.cells.length > 0) {
      const roles = next.cells.map((c) => ({ text: cellString(c), role: roleOf(headerText(c)) }));
      const debit = roles.flatMap((r, i) => (r.role === "debit" ? [i] : []));
      const credit = roles.flatMap((r, i) => (r.role === "credit" ? [i] : []));
      const other = roles.some((r, i) => r.text !== "" && !debit.includes(i) && !credit.includes(i));
      if (debit.length === 1 && credit.length === 1 && !other) {
        const headers = map.headers.slice();
        while (headers.length <= Math.max(debit[0], credit[0])) headers.push("");
        headers[debit[0]] = roles[debit[0]].text;
        headers[credit[0]] = roles[credit[0]].text;
        const twoRow: ColumnMap = { ...map, debit: debit[0], credit: credit[0], balance: null, headers };
        delete detected.balance;
        detected.debit = headers[debit[0]];
        detected.credit = headers[credit[0]];
        detected.source = "Tally trial balance export (Closing Balance: Debit / Credit columns)";
        return { kind: "grid", mode: "debit_credit", map: twoRow, headerContinuation: map.headerIndex + 1, detected, parse: (c, e, f) => parseTallyAmount(c, e, "debit_credit", f) };
      }
    }
    detected.source = "Tally trial balance export (Closing Balance with Dr/Cr)";
    return { kind: "grid", mode: "closing_drcr", map, headerContinuation: null, detected, parse: (c, e, f) => parseTallyAmount(c, e, "closing_drcr", f) };
  }
  return null;
}

/** What the Tally adapter decided about one named row of the body. Ledger rows then take the generic account path. */
export interface TallyRole {
  kind: "group" | "ledger" | "grand_total" | "refused";
  reason: string;
  debitMinor?: bigint;
  creditMinor?: bigint;
}

/**
 * The structural pass of the Tally adapter, before any row is classified: which named rows are group lines (excluded,
 * each checked against its own ledgers), which are ledgers, which is the Grand Total (checked against all ledgers), and
 * which cannot be resolved and refuse the file. Every amount is parsed here with the adapter's own parser; a row whose
 * amount cannot be read leaves its group "not checked" (the main pass refuses the file for that amount anyway).
 */
export function analyseTallyRows(rows: SourceRow[], adapter: TallyAdapter, exponent: number, requireGrandTotal: boolean): { roles: Map<number, TallyRole>; issues: IngestIssue[] } {
  const { map, mode } = adapter;
  const nameCol = map.account_name as number;
  const roles = new Map<number, TallyRole>();
  const issues: IngestIssue[] = [];
  const fmt = (m: bigint) => formatMinor(m, exponent);
  interface Line { i: number; row: number; name: string; key: string; indent: number; debit: bigint; credit: bigint; readable: boolean }
  const readAmount = (row: SourceRow, col: number | null, field: AmountField): { ok: boolean; minor: bigint | null } => {
    if (col === null) return { ok: true, minor: null };
    const p = adapter.parse(row.cells[col], exponent, field);
    if (p.kind === "blank") return { ok: true, minor: null };
    if (p.kind === "amount") return { ok: true, minor: p.minor };
    return { ok: false, minor: null };
  };
  const lines: Line[] = [];
  for (let i = map.headerIndex + 1; i < rows.length; i++) {
    if (i === adapter.headerContinuation) continue;
    const row = rows[i];
    if (row.cells.length === 0) continue;
    const raw = row.cells[nameCol];
    const rawText = typeof raw === "string" ? raw.replace(/[  ]/g, " ").replace(/[\r\n\t]+/g, " ") : cellString(raw);
    const name = rawText.trim();
    if (!name) continue; // nameless rows (currency labels, stray amounts) keep their generic treatment
    const indent = rawText.length - rawText.trimStart().length;
    let debit = 0n, credit = 0n, readable = true;
    if (mode === "debit_credit") {
      const d = readAmount(row, map.debit, "debit");
      const c = readAmount(row, map.credit, "credit");
      readable = d.ok && c.ok;
      debit = d.minor ?? 0n;
      credit = c.minor ?? 0n;
    } else {
      const b = readAmount(row, map.balance, "balance");
      readable = b.ok;
      const bal = b.minor ?? 0n;
      debit = bal > 0n ? bal : 0n;
      credit = bal < 0n ? -bal : 0n;
    }
    lines.push({ i, row: row.rowNumber, name, key: normalizeIdentityName(name), indent, debit, credit, readable });
  }
  const grand = lines.filter((l) => TALLY_GRAND_TOTAL.test(l.name));
  const body = lines.filter((l) => !TALLY_GRAND_TOTAL.test(l.name));

  let ledgerDebit = 0n, ledgerCredit = 0n, topDebit = 0n, topCredit = 0n, ledgerCount = 0;
  const condensed: Line[] = [];      // predefined group lines in a file without any indentation (group-wise, not ledger-wise)
  const unexpanded: Line[] = [];     // group lines whose ledgers are not beneath them
  const badIndent: Line[] = [];
  const difference: Line[] = [];
  const mismatch: { line: Line; ledgers: number; ledgerDebit: bigint; ledgerCredit: bigint }[] = [];
  const asLedger = (l: Line) => { roles.set(l.i, { kind: "ledger", reason: "Tally ledger line" }); ledgerDebit += l.debit; ledgerCredit += l.credit; ledgerCount++; };
  const refuse = (l: Line, reason: string) => roles.set(l.i, { kind: "refused", reason, ...(l.readable ? { debitMinor: l.debit, creditMinor: l.credit } : {}) });

  if (!body.some((l) => l.indent > 0)) {
    // No indentation anywhere: a ledger-wise export, every line a ledger — unless a line names a predefined group, which
    // proves a group-wise (condensed) export whose ledgers are not in the file.
    for (const l of body) {
      if (TALLY_PREDEFINED_GROUPS.has(l.key)) { condensed.push(l); refuse(l, `Tally group line “${l.name}” in a file without ledger indentation`); continue; }
      if (TALLY_DIFFERENCE_LINE.test(l.name)) { difference.push(l); refuse(l, "Tally “Difference in opening balances” line"); continue; }
      asLedger(l);
      topDebit += l.debit; topCredit += l.credit;
    }
  } else {
    interface Group { line: Line; childIndent: number | null; ledgers: number; debit: bigint; credit: bigint; unreadable: boolean }
    const stack: Group[] = [];
    const isGroup = (idx: number) => idx + 1 < body.length && body[idx + 1].indent > body[idx].indent;
    const finalize = (g: Group) => {
      const l = g.line;
      const label = `Tally group subtotal “${l.name}”`;
      if (g.unreadable) { roles.set(l.i, { kind: "group", reason: `${label}: not checked, an amount beneath it could not be read`, debitMinor: l.debit, creditMinor: l.credit }); return; }
      const net = g.debit - g.credit;
      const netDebit = net > 0n ? net : 0n;
      const netCredit = net < 0n ? -net : 0n;
      const gross = mode === "debit_credit" && l.debit === g.debit && l.credit === g.credit;
      const netted = l.debit === netDebit && l.credit === netCredit;
      if (!gross && !netted) mismatch.push({ line: l, ledgers: g.ledgers, ledgerDebit: g.debit, ledgerCredit: g.credit });
      const how = gross && netted ? "the total" : gross ? "the gross debit and credit totals" : netted ? "the net balance" : "neither the gross totals nor the net balance";
      roles.set(l.i, { kind: "group", reason: `${label}: ${gross || netted ? "equals" : "does not equal"} ${how} of its ${g.ledgers} ledger${g.ledgers === 1 ? "" : "s"}; excluded from the accounts`, debitMinor: l.debit, creditMinor: l.credit });
    };
    for (let idx = 0; idx < body.length; idx++) {
      const l = body[idx];
      while (stack.length > 0 && stack[stack.length - 1].line.indent >= l.indent) finalize(stack.pop() as Group);
      const parent = stack.length > 0 ? stack[stack.length - 1] : null;
      if (parent === null && l.indent > 0) badIndent.push(l);
      if (parent !== null) {
        if (parent.childIndent === null) parent.childIndent = l.indent;
        else if (parent.childIndent !== l.indent) badIndent.push(l);
      }
      if (isGroup(idx)) {
        stack.push({ line: l, childIndent: null, ledgers: 0, debit: 0n, credit: 0n, unreadable: false });
        if (parent === null) { topDebit += l.debit; topCredit += l.credit; }
        continue;
      }
      if (TALLY_DIFFERENCE_LINE.test(l.name)) { difference.push(l); refuse(l, "Tally “Difference in opening balances” line"); continue; }
      if (parent === null) {
        if (l.key === TALLY_PL_LEDGER) { asLedger(l); topDebit += l.debit; topCredit += l.credit; continue; }
        unexpanded.push(l);
        refuse(l, `Tally group line “${l.name}” with no ledgers beneath it`);
        continue;
      }
      if (TALLY_PREDEFINED_GROUPS.has(l.key)) { unexpanded.push(l); refuse(l, `Tally predefined group “${l.name}” with no ledgers beneath it`); continue; }
      asLedger(l);
      for (const g of stack) { g.ledgers++; g.debit += l.debit; g.credit += l.credit; if (!l.readable) g.unreadable = true; }
    }
    while (stack.length > 0) finalize(stack.pop() as Group);
  }

  const rowsOf = (ls: Line[]) => ls.map((l) => l.row);
  const namesOf = (ls: Line[]) => ls.slice(0, MAX_LISTED_ROWS).map((l) => `“${l.name}”`).join(", ");
  if (condensed.length > 0) {
    const one = condensed.length === 1;
    issues.push({ code: "UNSUPPORTED_LAYOUT", severity: "blocking", rows: rowsOf(condensed), message: `Row${one ? "" : "s"} ${listRows(rowsOf(condensed))} name${one ? "s" : ""} Tally's predefined group${one ? "" : "s"} ${namesOf(condensed)} with no ledgers indented beneath, so this is a group-wise export, not a list of ledgers. In Tally, open the Trial Balance, press F5 (Ledger-wise) — or Alt+F5 (Detailed) with “Expand all levels in Detailed format” set to Yes — export it again as Excel, and upload that file.` });
  }
  if (unexpanded.length > 0) {
    const one = unexpanded.length === 1;
    issues.push({ code: "UNSUPPORTED_LAYOUT", severity: "blocking", rows: rowsOf(unexpanded), message: `Row${one ? "" : "s"} ${listRows(rowsOf(unexpanded))} (${namesOf(unexpanded)}) ${one ? "is a Tally group line" : "are Tally group lines"} with no ledgers beneath ${one ? "it" : "them"}, so ${one ? "its" : "their"} ledgers are not in the file. In Tally, set “Expand all levels in Detailed format” to Yes (and “Group behaves like a sub-ledger” to No for those groups), export the Trial Balance again, and upload that file.` });
  }
  if (badIndent.length > 0) {
    issues.push({ code: "UNSUPPORTED_LAYOUT", severity: "blocking", rows: rowsOf(badIndent), message: `Row${badIndent.length === 1 ? "" : "s"} ${listRows(rowsOf(badIndent))} ${badIndent.length === 1 ? "is" : "are"} indented in a way that does not line up with a group above, so the groups and ledgers cannot be told apart. Export the Trial Balance again from Tally without editing the file.` });
  }
  if (difference.length > 0) {
    issues.push({ code: "TRIAL_BALANCE_IMBALANCE", severity: "blocking", rows: rowsOf(difference), message: `Row${difference.length === 1 ? "" : "s"} ${listRows(rowsOf(difference))} ${difference.length === 1 ? "is" : "are"} Tally's “Difference in opening balances” line: the ledgers' opening balances do not balance. Correct the opening balances in Tally (F12 > Show Opening Balance shows which), export the Trial Balance again, and upload it.` });
  }
  for (const m of mismatch) {
    const l = m.line;
    const net = m.ledgerDebit - m.ledgerCredit;
    issues.push({
      code: "TOTAL_ROW_MISMATCH", severity: "blocking", rows: [l.row],
      message: `The Tally group “${l.name}” on row ${l.row} shows debit ${fmt(l.debit)}, credit ${fmt(l.credit)}, but the ${m.ledgers} ledger${m.ledgers === 1 ? "" : "s"} beneath it total debit ${fmt(m.ledgerDebit)}, credit ${fmt(m.ledgerCredit)} (net ${fmt(net < 0n ? -net : net)} ${net < 0n ? "Cr" : "Dr"}). A ledger may be missing, hidden or edited — export the Trial Balance again from Tally with all levels expanded and upload that file.`,
    });
  }
  if (grand.length === 0 && requireGrandTotal) {
    issues.push({ code: "UNSUPPORTED_LAYOUT", severity: "blocking", message: "This Tally export has no Grand Total row, so its ledgers cannot be checked against Tally's own total. Export the Trial Balance again from Tally without removing rows, and upload that file." });
  }
  if (grand.length > 1) {
    issues.push({ code: "UNSUPPORTED_LAYOUT", severity: "blocking", rows: rowsOf(grand), message: `Rows ${listRows(rowsOf(grand))} are all labelled Grand Total. A Tally Trial Balance export has one; upload one export at a time.` });
  }
  for (const g of grand) {
    const after = body.filter((l) => l.i > g.i);
    if (after.length > 0) {
      issues.push({ code: "UNSUPPORTED_LAYOUT", severity: "blocking", rows: rowsOf(after), message: `Row${after.length === 1 ? "" : "s"} ${listRows(rowsOf(after))} come${after.length === 1 ? "s" : ""} after the Grand Total on row ${g.row}. A Tally export ends with its Grand Total; upload one export at a time, unedited.` });
    }
    if (!g.readable) { roles.set(g.i, { kind: "grand_total", reason: "Tally Grand Total: not checked, its amount could not be read" }); continue; }
    // With a line that could not be resolved the ledger sums are partial and the file is already refused above; the
    // Grand Total is then recorded, not compared. The top-level reading is valid only when every group passed its check.
    if (condensed.length + unexpanded.length + badIndent.length + difference.length > 0) {
      roles.set(g.i, { kind: "grand_total", reason: "Tally Grand Total: not checked, a line above it could not be resolved", debitMinor: g.debit, creditMinor: g.credit });
      continue;
    }
    const byLedgers = mode === "debit_credit" ? g.debit === ledgerDebit && g.credit === ledgerCredit : g.debit - g.credit === ledgerDebit - ledgerCredit;
    const byTop = mismatch.length === 0 && (mode === "debit_credit" ? g.debit === topDebit && g.credit === topCredit : g.debit - g.credit === topDebit - topCredit);
    if (!byLedgers && !byTop) {
      issues.push({
        code: "TOTAL_ROW_MISMATCH", severity: "blocking", rows: [g.row],
        message: `The Grand Total on row ${g.row} (debit ${fmt(g.debit)}, credit ${fmt(g.credit)}) does not equal the ${ledgerCount} ledger lines (debit ${fmt(ledgerDebit)}, credit ${fmt(ledgerCredit)}) nor the top-level lines (debit ${fmt(topDebit)}, credit ${fmt(topCredit)}). A row may be missing, duplicated or hidden — export the Trial Balance again from Tally and upload that file.`,
      });
    }
    roles.set(g.i, { kind: "grand_total", reason: `Tally Grand Total: ${byLedgers ? "equals the ledger lines" : byTop ? "equals the top-level lines (groups reported net)" : "does not equal the ledger lines"}; checked, excluded from the accounts`, debitMinor: g.debit, creditMinor: g.credit });
  }
  return { roles, issues };
}

export interface IngestInput {
  rows: SourceRow[];
  sheetName: string | null;
  /** The reporting period the upload was made for — required. */
  periodYear: number | null;
  /** ISO 4217 code of the period's reporting currency — required. */
  currency: string | null;
  /** The workspace's entity name, compared only with an identifiable title-block entity (§3.3). Optional. */
  workspaceEntityName?: string | null;
  /**
   * A confirmed layout, resolved against these rows (layoutProfile.resolveLayout). Absent: the automatic path, exactly
   * as before — column detection and the default amount grammar.
   */
  layout?: IngestLayout;
  /**
   * "tally_xml": the rows were produced by the Tally XML reader (tallyXmlExport.ts) — Particulars / Debit / Credit with
   * Tally's signs — and are read by the Tally adapter as a ledger-wise export. Absent for every file read from a grid.
   */
  source?: "tally_xml";
}

/** The columns and amount reading a confirmed layout fixes for one file (built only by layoutProfile.ts). */
export interface IngestLayout {
  /** null when the layout does not fit the file; `issues` then says why. */
  map: ColumnMap | null;
  detected: Record<string, string>;
  issues: IngestIssue[];
  parse: (cell: Cell, exponent: number, field?: AmountField) => ParsedAmount;
  /** A single Balance column whose positive values are credits. */
  creditPositiveBalance: boolean;
  /** The declared number format, as an example ("1.234.567,89"), for messages. */
  formatLabel: string;
}

function emptySummary(rowsRead: number): IngestResult["lineageSummary"] {
  return { rowsRead, preamble: 0, header: 0, blank: 0, heading: 0, total: 0, zero_balance: 0, account: 0, rejected: 0 };
}

export function ingestTrialBalance(input: IngestInput): IngestResult {
  const { rows, sheetName, periodYear } = input;
  const issues: IngestIssue[] = [];
  const currency = input.currency ? input.currency.trim().toUpperCase() : null;
  const exponent = currencyExponent(currency);
  const result = (partial: Partial<IngestResult>): IngestResult => {
    const lineage = partial.lineage ?? [];
    const summary = emptySummary(rows.length);
    for (const l of lineage) summary[l.disposition]++;
    return {
      version: TB_INGESTION_VERSION, currency, exponent, periodYear, sheetName,
      columns: partial.columns ?? {}, accounts: partial.accounts ?? [], lineage, lineageSummary: summary,
      totals: partial.totals ?? null, issues, suspectedTotalRows: partial.suspectedTotalRows ?? [],
      blocking: issues.some((i) => i.severity === "blocking"),
      evidence: partial.evidence ?? EMPTY_TITLE_BLOCK,
      reviewChecks: partial.reviewChecks ?? [],
    };
  };

  if (periodYear === null || !Number.isInteger(periodYear)) {
    issues.push({ code: "PERIOD_NOT_SELECTED", severity: "blocking", message: "This trial balance is not attached to a reporting period. Upload it from the workspace of the year it belongs to." });
  }
  if (!currency) {
    issues.push({ code: "CURRENCY_UNRESOLVED", severity: "blocking", message: "The reporting period has no reporting currency, so amounts cannot be checked. Set the period's currency, then process the trial balance again." });
  } else if (exponent === null) {
    issues.push({ code: "CURRENCY_UNSUPPORTED", severity: "blocking", message: `The reporting currency ${currency} is not supported yet, so amounts cannot be checked exactly.` });
  }
  if (rows.every((r) => r.cells.length === 0)) {
    issues.push({ code: "FILE_EMPTY", severity: "blocking", message: "The file has no rows. Upload a trial balance with a header row and one row per account." });
  }
  if (issues.length > 0) return result({});

  const detection = input.layout
    ? { map: input.layout.map, detected: input.layout.detected, issues: input.layout.issues }
    : detectColumns(rows, periodYear);
  issues.push(...detection.issues);
  if (!detection.map || detection.issues.some((i) => i.severity === "blocking")) return result({ columns: detection.detected });
  // The Tally adapter: only for rows from the Tally XML reader, or a positively detected Tally grid; never under a
  // confirmed layout (the layout is the authority there) and never for any other file.
  let tally: TallyAdapter | null = null;
  if (!input.layout && input.source === "tally_xml") {
    const m = detection.map;
    if (m.account_name !== null && m.debit !== null && m.credit !== null) {
      tally = { kind: "xml", mode: "debit_credit", map: m, headerContinuation: null, detected: { ...detection.detected, source: "Tally XML export (Trial Balance envelope), read as a ledger-wise export" }, parse: parseTallyXmlAmount };
    }
  } else if (!input.layout) {
    tally = detectTallyGrid(rows, detection);
  }
  const map = tally ? tally.map : detection.map;
  const columns = tally ? tally.detected : detection.detected;
  issues.push(...periodAndCurrencyIssues(rows, map, periodYear as number, currency as string));
  // Title-block evidence (§3.3, §3.4): the entity text, period text and currency labels, with their locations.
  const titleBlock = readTitleBlockEvidence(rows, map.headerIndex);
  if (tally?.kind === "grid") {
    // Tally's period line ("1-Apr-2025 to 31-Mar-2026") names no period word, so the generic check above does not read
    // it; under the adapter it is period evidence and must name the selected year.
    const periodCells: EvidenceCell[] = [];
    for (const row of rows.slice(0, map.headerIndex)) {
      row.cells.forEach((c, col) => {
        if (typeof c !== "string") return;
        const t = c.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
        if (TALLY_PERIOD_LINE.test(t)) periodCells.push({ text: t, row: row.rowNumber, column: columnLetter(col) });
      });
    }
    titleBlock.period.push(...periodCells.filter((p) => !titleBlock.period.some((e) => e.row === p.row && e.column === p.column)));
    const years = new Set(periodCells.flatMap((p) => yearsIn(p.text)));
    if (years.size > 0 && !years.has(periodYear as number) && !issues.some((i) => i.code === "PERIOD_MISMATCH")) {
      issues.push({
        code: "PERIOD_MISMATCH", severity: "blocking", rows: periodCells.map((p) => p.row),
        message: `The Tally export is for ${periodCells[0].text}, but this trial balance is being uploaded for ${periodYear}. Upload the ${periodYear} export, or open the workspace for the year the file belongs to.`,
      });
    }
  }
  const currencyLabels: TitleBlockEvidence["currencyLabels"] = [];
  for (const col of [map.debit, map.credit, map.balance]) {
    if (col === null) continue;
    for (const m of (map.headers[col] ?? "").toUpperCase().matchAll(/\b([A-Z]{3})\b/g)) {
      if (CURRENCY_EXPONENTS[m[1]] !== undefined) currencyLabels.push({ code: m[1], text: map.headers[col], row: map.headerRowNumber, column: columnLetter(col) });
    }
  }
  const exp = exponent as number;

  const lineage: RowLineage[] = [];
  const accounts: IngestedAccount[] = [];
  const suspectedTotalRows: number[] = [];
  const malformed: { row: number; field: string; text: string }[] = [];
  const precision: { row: number; field: string; text: string; decimals: number }[] = [];
  const range: { row: number; field: string; text: string }[] = [];
  const formatMismatch: { row: number; field: string; text: string }[] = [];
  const parse: (cell: Cell, exponent: number, field?: AmountField) => ParsedAmount = input.layout ? input.layout.parse : tally ? tally.parse : parseAmount;
  // The Tally structural pass (group lines, Grand Total) runs before any row is classified; its findings are reported
  // after the row findings below.
  const tallyAnalysis = tally ? analyseTallyRows(rows, tally, exp, tally.kind === "grid") : null;
  const tallyRoles = tallyAnalysis?.roles ?? new Map<number, TallyRole>();
  const balanceMismatch: number[] = [];
  const missingCode: number[] = [];
  const exampleRows: number[] = [];
  const totalRowsChecked: { row: number; debit: bigint; credit: bigint; accountsDebit: bigint; accountsCredit: bigint }[] = [];
  let runningDebit = 0n;
  let runningCredit = 0n;
  const hasCodeColumn = map.account_code !== null;
  const useDebitCredit = map.debit !== null && map.credit !== null;

  // Printed exports may finish with a footer: page numbers, print or run dates, end-of-report markers, signature
  // and date lines (printedReportMetadata.ts). A footer needs positional AND structural evidence: it lies after the
  // last substantive row (one with an amount or an account code) and it has neither. Only then is its text compared
  // with the rule set. A trailing row no rule recognises is kept in lineage and held for review, never dropped.
  const amountColumns = [map.debit, map.credit, map.balance].filter((c): c is number => c !== null);
  // An account code is a single token with at least one digit ("4010", "4010-01", "A100", "4.1.2"); a sentence in the
  // code column (a report attribution, a signature caption) is not one.
  const codeLike = (t: string): boolean => /^[\p{L}\p{N}][\p{L}\p{N}._/:-]{0,39}$/u.test(t) && /\p{N}/u.test(t);
  const isSubstantive = (r: SourceRow): boolean =>
    amountColumns.some((c) => cellString(r.cells[c]) !== "") || (hasCodeColumn && codeLike(cellString(r.cells[map.account_code as number])));
  let lastSubstantive = map.headerIndex;
  for (let j = map.headerIndex + 1; j < rows.length; j++) if (isSubstantive(rows[j])) lastSubstantive = j;
  /** For a row after the last substantive row: the footer rules its cells match ([] when empty), or null when a cell is unrecognised. */
  const trailingFooterRules = (r: SourceRow): string[] | null => {
    const filled = r.cells.filter((c) => cellString(c) !== "");
    if (filled.length === 0) return [];
    const labels: string[] = [];
    for (const c of filled) {
      if (typeof c !== "number") {
        const rule = footerRuleFor(cellString(c), PRINTED_FOOTER_RULES);
        if (rule) { labels.push(rule.label); continue; }
      }
      // A standalone page number: a whole number alone on the row, or beside recognised footer text.
      if (isStandalonePageNumber(c) && (filled.length === 1 || filled.some((o) => o !== c && typeof o !== "number"))) { labels.push("Page number"); continue; }
      return null;
    }
    return [...new Set(labels)];
  };
  const unrecognisedTrailing: number[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i < map.headerIndex) { lineage.push({ rowNumber: row.rowNumber, disposition: row.cells.length === 0 ? "blank" : "preamble" }); continue; }
    if (i === map.headerIndex) { lineage.push({ rowNumber: row.rowNumber, disposition: "header" }); continue; }
    if (row.cells.length === 0) { lineage.push({ rowNumber: row.rowNumber, disposition: "blank" }); continue; }

    if (tally) {
      if (i === tally.headerContinuation) { lineage.push({ rowNumber: row.rowNumber, disposition: "header" }); continue; }
      const role = tallyRoles.get(i);
      // Group subtotal and Grand Total lines are excluded exactly once (checked in analyseTallyRows); an unresolved line is
      // rejected, never read as an account. Ledger lines fall through to the generic account path.
      if (role && role.kind !== "ledger") {
        lineage.push({
          rowNumber: row.rowNumber, disposition: role.kind === "refused" ? "rejected" : "total", reason: role.reason,
          ...(role.debitMinor !== undefined ? { debitMinor: role.debitMinor, creditMinor: role.creditMinor } : {}),
        });
        continue;
      }
    }

    if (i > lastSubstantive) {
      const rules = trailingFooterRules(row);
      if (rules && rules.length === 0) { lineage.push({ rowNumber: row.rowNumber, disposition: "blank" }); continue; }
      if (rules) { lineage.push({ rowNumber: row.rowNumber, disposition: "heading", reason: `Printed report footer: ${rules.join(", ")}` }); continue; }
      unrecognisedTrailing.push(row.rowNumber);
      lineage.push({ rowNumber: row.rowNumber, disposition: "heading", reason: "Text after the last account, not recognised as a report footer" });
      continue;
    }
    // Standalone ISO currency labels under amount headers are metadata, never postings. Mixed rows are not skipped.
    const currencyCells = row.cells.map((c, index) => ({ text: cellString(c), index })).filter(c => c.text);
    if (currencyCells.length > 0 && currencyCells.every(c => amountColumns.includes(c.index) && /^[A-Z]{3}$/.test(c.text) && currencyExponent(c.text) !== null)) {
      for (const c of currencyCells) currencyLabels.push({ code: c.text, text: c.text, row: row.rowNumber, column: columnLetter(c.index) });
      if (currencyCells.some(c => c.text !== currency)) issues.push({ code: "CURRENCY_MISMATCH", severity: "blocking", rows: [row.rowNumber], message: `The currency labels on row ${row.rowNumber} do not match the selected currency ${currency}. Confirm the trial balance currency before processing.` });
      lineage.push({ rowNumber: row.rowNumber, disposition: "heading", reason: "Amount currency labels" });
      continue;
    }
    const code = hasCodeColumn ? cellString(row.cells[map.account_code as number]) : "";
    const name = map.account_name !== null ? cellString(row.cells[map.account_name]) : "";
    const read = (col: number | null, field: AmountField): bigint | null | "bad" => {
      if (col === null) return null;
      const p = parse(row.cells[col], exp, field);
      if (p.kind === "blank") return null;
      if (p.kind === "amount") return p.minor;
      if (p.kind === "malformed") malformed.push({ row: row.rowNumber, field, text: p.text });
      else if (p.kind === "format") formatMismatch.push({ row: row.rowNumber, field, text: p.text });
      else if (p.kind === "precision") precision.push({ row: row.rowNumber, field, text: p.text, decimals: p.decimals });
      else range.push({ row: row.rowNumber, field, text: p.text });
      return "bad";
    };
    const d = useDebitCredit ? read(map.debit, "debit") : null;
    const c = useDebitCredit ? read(map.credit, "credit") : null;
    const b = read(map.balance, "balance");

    if (!code && !name) {
      // No label at all: either an empty row with stray formatting, or amounts with nothing to attach them to.
      const anyAmount = [d, c, b].some((v) => v !== null);
      const onlyAmounts = row.cells.every((v, col) => !cellString(v) || amountColumns.includes(col));
      // QuickBooks Desktop writes the word TOTAL in a column other than the account-name column (the last row, with the two sums).
      // Accepted only when every non-amount cell on the row is exactly a grand-total label; a note or any other text still fails.
      const onlyAmountsOrGrandTotalLabel = row.cells.every((v, col) => !cellString(v) || amountColumns.includes(col) || GRAND_TOTAL_PATTERN.test(cellString(v)));
      if (useDebitCredit && typeof d === "bigint" && typeof c === "bigint" && b !== "bad"
        && accounts.length > 0 && onlyAmountsOrGrandTotalLabel && i === lastSubstantive) {
        totalRowsChecked.push({ row: row.rowNumber, debit: d, credit: c, accountsDebit: runningDebit, accountsCredit: runningCredit });
        lineage.push({ rowNumber: row.rowNumber, disposition: "total", reason: onlyAmounts ? "Terminal unlabelled control total; checked against account rows" : "Terminal control total labelled outside the name column; checked against account rows", debitMinor: d, creditMinor: c });
        continue;
      }
      lineage.push(anyAmount
        ? { rowNumber: row.rowNumber, disposition: "rejected", reason: "amounts without an account code or name",
            ...(typeof d === "bigint" ? { debitMinor: d } : {}), ...(typeof c === "bigint" ? { creditMinor: c } : {}) }
        : { rowNumber: row.rowNumber, disposition: "blank" });
      if (anyAmount) missingCode.push(row.rowNumber);
      continue;
    }
    if (d === "bad" || c === "bad" || b === "bad") { lineage.push({ rowNumber: row.rowNumber, disposition: "rejected", reason: "amount could not be read" }); continue; }

    let debit: bigint;
    let credit: bigint;
    if (useDebitCredit) {
      debit = d ?? 0n;
      credit = c ?? 0n;
      // A single Balance column beside Debit and Credit must agree with them (either sign convention, consistently
      // checked per row); a contradiction means the file is not one trial balance.
      if (typeof b === "bigint" && b !== debit - credit && b !== credit - debit) balanceMismatch.push(row.rowNumber);
    } else {
      const bal = input.layout?.creditPositiveBalance ? -(b ?? 0n) : b ?? 0n;
      debit = bal > 0n ? bal : 0n;
      credit = bal < 0n ? -bal : 0n;
    }
    const allBlank = (useDebitCredit ? d === null && c === null : true) && b === null;

    // A Tally ledger line is a ledger whatever its name says (the structural pass settled totals and groups).
    if (!code && tallyRoles.get(i)?.kind !== "ledger") {
      const looksTotal = TOTAL_NAME_PATTERNS.some((p) => p.test(name));
      if (looksTotal) {
        if (GRAND_TOTAL_PATTERN.test(name) && !allBlank) {
          totalRowsChecked.push({ row: row.rowNumber, debit, credit, accountsDebit: runningDebit, accountsCredit: runningCredit });
        }
        lineage.push({ rowNumber: row.rowNumber, disposition: "total", reason: name, ...(allBlank ? {} : { debitMinor: debit, creditMinor: credit }) });
        continue;
      }
    }
    // No amounts at all: a coded account with no postings, or a group heading.
    if (allBlank) { lineage.push({ rowNumber: row.rowNumber, disposition: code ? "zero_balance" : "heading", reason: name || code }); continue; }
    if (hasCodeColumn && !code) {
      missingCode.push(row.rowNumber);
      lineage.push({ rowNumber: row.rowNumber, disposition: "rejected", reason: "amounts without an account code", debitMinor: debit, creditMinor: credit });
      continue;
    }
    if (debit === 0n && credit === 0n) { lineage.push({ rowNumber: row.rowNumber, disposition: "zero_balance", reason: name || code }); continue; }

    if (code && TOTAL_NAME_PATTERNS.some((p) => p.test(name))) suspectedTotalRows.push(row.rowNumber);
    if (EXAMPLE_MARKER.test(name)) exampleRows.push(row.rowNumber);
    const dimensions: Record<string, string> = {};
    for (const c of map.dimensions) {
      const v = cellString(row.cells[c]);
      if (v) dimensions[map.headers[c]] = v;
    }
    const dimensionKey = Object.entries(dimensions).map(([h, v]) => `|${normalizeIdentityName(h)}=${normalizeIdentityName(v)}`).join("");
    const identity = (code ? `code:${code}` : `name:${normalizeIdentityName(name)}`) + dimensionKey;
    accounts.push({ accountCode: code || name, accountName: name || code, codeProvided: !!code, identity, dimensions, debitMinor: debit, creditMinor: credit, sourceRowNumber: row.rowNumber });
    lineage.push({ rowNumber: row.rowNumber, disposition: "account", identity });
    runningDebit += debit;
    runningCredit += credit;
  }

  const fmt = (m: bigint) => formatMinor(m, exp);
  const describe = (list: { row: number; field: string; text: string }[]) =>
    list.slice(0, MAX_LISTED_ROWS).map((x) => `row ${x.row} ${x.field} “${x.text}”`).join("; ") + (list.length > MAX_LISTED_ROWS ? `; and ${list.length - MAX_LISTED_ROWS} more` : "");

  if (malformed.length > 0) {
    const fix = tally?.kind === "xml"
      ? "In a Tally XML export a closing debit is written as a negative amount and a closing credit as a positive one; an amount on the other side cannot be read. Export the Trial Balance again from Tally and upload that file."
      : tally?.mode === "closing_drcr"
        ? "In a Tally Closing Balance column each amount carries its side, for example 1,00,000.00 Dr or 25,000.00 Cr; an amount without Dr/Cr, or a negative one, cannot be read."
        : tally
          ? "Tally amounts are read as plain digits, 1,00,000.00 or 100,000.00, with (-) or - for a negative and no currency symbol."
          : "Use plain numbers such as 1234.50 or 1,234.50 — no currency symbols or letters — and leave a cell empty (or “-”) for zero.";
    issues.push({ code: "MALFORMED_NUMERIC_VALUE", severity: "blocking", rows: malformed.map((x) => x.row), message: `Some amounts are not numbers: ${describe(malformed)}. ${fix}` });
  }
  if (formatMismatch.length > 0) {
    issues.push({ code: "LAYOUT_NUMBER_FORMAT_MISMATCH", severity: "blocking", rows: formatMismatch.map((x) => x.row), message: `The confirmed layout reads amounts written like ${input.layout?.formatLabel ?? "the declared format"}, but ${describe(formatMismatch)} ${formatMismatch.length === 1 ? "is" : "are"} written in another number format. Check the file, or confirm the layout again with the right number format.` });
  }
  if (precision.length > 0) {
    issues.push({ code: "PRECISION_EXCEEDS_CURRENCY", severity: "blocking", rows: precision.map((x) => x.row), message: `${currency} amounts have at most ${exp} decimal place${exp === 1 ? "" : "s"}, but ${describe(precision)} ${precision.length === 1 ? "has" : "have"} more. Round them in your accounting system so the trial balance still balances, then upload again.` });
  }
  if (range.length > 0) {
    issues.push({ code: "AMOUNT_OUT_OF_RANGE", severity: "blocking", rows: range.map((x) => x.row), message: `Some amounts are too large to check exactly: ${describe(range)}.` });
  }
  if (balanceMismatch.length > 0) {
    issues.push({ code: "BALANCE_COLUMN_MISMATCH", severity: "blocking", rows: balanceMismatch, message: `On row${balanceMismatch.length === 1 ? "" : "s"} ${listRows(balanceMismatch)} the Balance column does not equal Debit minus Credit. Remove the Balance column or correct those rows.` });
  }
  if (missingCode.length > 0) {
    issues.push({ code: "MISSING_ACCOUNT_CODE", severity: "blocking", rows: missingCode, message: `Row${missingCode.length === 1 ? "" : "s"} ${listRows(missingCode)} ${missingCode.length === 1 ? "has" : "have"} amounts but no account code. Add the code, or remove the row if it is a subtotal.` });
  }

  const byIdentity = new Map<string, number[]>();
  for (const a of accounts) byIdentity.set(a.identity, [...(byIdentity.get(a.identity) ?? []), a.sourceRowNumber]);
  // A repeated identity is ambiguous and refused (fail closed). Rows of one code that differ in a dimension column
  // (cost centre, department, branch, fund, project, …) are different identities and are kept, each with its own lineage.
  const dimensionNames = map.dimensions.map((c) => `“${map.headers[c]}”`).join(", ");
  for (const [identity, rowNumbers] of byIdentity) {
    if (rowNumbers.length < 2) continue;
    const sample = accounts.find((a) => a.identity === identity)!;
    const isCode = sample.codeProvided;
    const label = isCode ? `Account code ${sample.accountCode}` : `The account “${sample.accountName}”`;
    const split = map.dimensions.length > 0
      ? ` with the same ${dimensionNames}. Each account and ${dimensionNames} combination must appear once — combine or correct those rows.`
      : `. A trial balance has one row per account. If these rows are split by cost centre, department, branch, fund or project, include that column so each row can be told apart; otherwise combine them.${isCode ? "" : " Adding account codes also makes each row unambiguous."}`;
    issues.push({
      code: isCode ? "DUPLICATE_ACCOUNT_CODE" : "DUPLICATE_ACCOUNT_NAME", severity: "blocking", rows: rowNumbers,
      message: `${label} appears on rows ${listRows(rowNumbers)}${split}`,
    });
  }

  for (const t of totalRowsChecked) {
    if (t.debit !== t.accountsDebit || t.credit !== t.accountsCredit) {
      issues.push({
        code: "TOTAL_ROW_MISMATCH", severity: "blocking", rows: [t.row],
        message: `The total on row ${t.row} (debit ${fmt(t.debit)}, credit ${fmt(t.credit)}) does not equal the accounts above it (debit ${fmt(t.accountsDebit)}, credit ${fmt(t.accountsCredit)}). A row may be missing, duplicated or hidden — check the file against your accounting system.`,
      });
    }
  }
  if (tallyAnalysis) issues.push(...tallyAnalysis.issues);
  if (unrecognisedTrailing.length > 0) {
    const one = unrecognisedTrailing.length === 1;
    issues.push({ code: "UNRECOGNISED_TRAILING_TEXT", severity: "review", rows: unrecognisedTrailing, subject: `rows:${[...unrecognisedTrailing].sort((a, b) => a - b).join(",")}`, message: `Row${one ? "" : "s"} ${listRows(unrecognisedTrailing)} after the last account contain${one ? "s" : ""} text that is not a recognised report footer and no amounts. Confirm ${one ? "it is" : "they are"} not part of the trial balance.` });
  }
  if (exampleRows.length > 0) {
    issues.push({ code: "TEMPLATE_EXAMPLE_UPLOADED", severity: "blocking", rows: exampleRows, message: "This file still contains the example rows from the CFOClose sample. Replace them with your own accounts before uploading." });
  }
  if (accounts.length === 0 && !issues.some((i) => i.severity === "blocking")) {
    issues.push({ code: "NO_ACCOUNT_ROWS", severity: "blocking", message: "No account rows were found below the header. Check that each account is on its own row with an amount." });
  }

  const totals = { debitMinor: runningDebit, creditMinor: runningCredit, differenceMinor: runningDebit - runningCredit };
  if (totals.debitMinor > MAX_SAFE_MINOR || totals.creditMinor > MAX_SAFE_MINOR) {
    issues.push({ code: "AMOUNT_OUT_OF_RANGE", severity: "blocking", message: "The trial balance totals are too large to check exactly." });
  }
  // A printed control mismatch does not invalidate the independently summed account arithmetic.
  const integrityBlocked = issues.some((i) => i.severity === "blocking" && i.code !== "TOTAL_ROW_MISMATCH");
  if (!integrityBlocked && totals.differenceMinor !== 0n) {
    const diff = totals.differenceMinor < 0n ? -totals.differenceMinor : totals.differenceMinor;
    const hint = suspectedTotalRows.length > 0
      ? ` Rows ${listRows(suspectedTotalRows)} have account codes but read like totals; if they are subtotals, remove them.`
      : "";
    issues.push({
      code: "TRIAL_BALANCE_IMBALANCE", severity: "blocking",
      message: `Debits (${fmt(totals.debitMinor)}) do not equal credits (${fmt(totals.creditMinor)}); the difference is ${fmt(diff)}.${hint} Correct the trial balance in your accounting system and upload it again.`,
      rows: suspectedTotalRows.length > 0 ? suspectedTotalRows : undefined,
    });
  }

  const evidence: TitleBlockEvidence = { ...titleBlock, currencyLabels };
  const entityIssue = entityConfirmation(evidence, input.workspaceEntityName);
  if (entityIssue) issues.push(entityIssue);

  // ── Review-only rules (§3.6): each reports applicability and outcome; none blocks or adjusts by itself ──────────────
  const reviewChecks: ReviewCheck[] = [];
  const duplicateRows = issues.filter((i) => i.code === "DUPLICATE_ACCOUNT_CODE" || i.code === "DUPLICATE_ACCOUNT_NAME").flatMap((i) => i.rows ?? []);
  reviewChecks.push({
    id: "duplicate_identities", label: "Duplicate accounts",
    outcome: duplicateRows.length ? "blocked" : "passed",
    reason: duplicateRows.length
      ? "The same account identity (code and every dimension) appears more than once."
      : "Each account identity (code and every dimension) appears once. The same description under different codes is not a duplicate.",
    ...(duplicateRows.length ? { rows: duplicateRows } : {}),
  });
  reviewChecks.push({ id: "residual_balances", label: "Residual balances", outcome: "not_run", reason: "No residual-balance policy is configured, so residual balances are not assessed." });
  reviewChecks.push({ id: "unexpected_side_balances", label: "Balances on an unexpected side", outcome: "not_run", reason: "Needs an approved classification or a verified chart rule, which this check does not have yet." });
  const clearing = accounts.filter((a) => CLEARING_ACCOUNT_NAME.test(a.accountName) && a.debitMinor !== a.creditMinor);
  // One finding per account: each balance is explained (with evidence) on its own.
  for (const a of clearing) {
    const label = a.codeProvided ? `${a.accountCode} ${a.accountName}` : a.accountName;
    issues.push({
      code: "CLEARING_ACCOUNT_BALANCE", severity: "review", rows: [a.sourceRowNumber], accountCode: a.codeProvided ? a.accountCode : null,
      // The account's identity in this file (code or normalised name, with any dimensions): unique, and stable across checks.
      subject: a.identity,
      message: `${label} (row ${a.sourceRowNumber}) is a clearing, suspense or in-transit account with a balance. It needs an explanation and reconciliation evidence.`,
    });
  }
  reviewChecks.push({
    id: "clearing_account_balances", label: "Clearing, suspense and in-transit balances",
    outcome: clearing.length ? "review" : "passed",
    reason: clearing.length ? "Needs reconciliation evidence." : "No clearing, suspense or in-transit account carries a balance.",
    ...(clearing.length ? { rows: clearing.map((a) => a.sourceRowNumber) } : {}),
  });
  const openingHeaders = map.headers.map((h, col) => ({ h, col })).filter(({ h }) => /\b(opening|b\/?f|brought\s+forward)\b/i.test(h));
  const movementHeaders = map.headers.map((h, col) => ({ h, col })).filter(({ h }) => /\b(movement|movements|activity|period|closing|c\/?f|carried\s+forward)\b/i.test(h) && !/\bopening\b/i.test(h));
  if (openingHeaders.length > 0 && movementHeaders.length > 0) {
    const cols = [...openingHeaders, ...movementHeaders].map(({ h, col }) => `“${h}” (column ${columnLetter(col)})`).join(", ");
    reviewChecks.push({ id: "opening_and_movement_columns", label: "Opening and movement content", outcome: "notice", rows: [map.headerRowNumber], reason: `The header has opening-balance and movement or closing columns: ${cols}. They are not combined, and no closing balance is derived from them.` });
  } else {
    reviewChecks.push({ id: "opening_and_movement_columns", label: "Opening and movement content", outcome: "passed", reason: "The file does not combine opening balances with movements." });
  }

  return result({ columns, accounts, lineage, totals, suspectedTotalRows, evidence, reviewChecks });
}

// ── Classification review policy ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Which classifier results stand without a reviewer. Only this company's own reviewed mapping, matched exactly (by
 * code, or by exact normalised name), is authoritative. A fuzzy match, a global mapping, a keyword-dictionary hit and
 * a naming rule are SUGGESTIONS: the account goes to review with the suggestion pre-selected, and the trial balance is
 * not accepted until a reviewer confirms it.
 */
export function classificationNeedsReview(tier: 1 | 2 | 3 | 4 | 5, fuzzy: boolean): boolean {
  return tier > 2 || fuzzy;
}

// ── Processing milestones ────────────────────────────────────────────────────────────────────────────────────────────

export type MilestoneId = "read" | "columns" | "rows" | "amounts" | "balance" | "classification" | "recorded";
export type MilestoneStatus = "passed" | "failed" | "needs_review" | "not_reached";

export interface Milestone {
  id: MilestoneId;
  label: string;
  status: MilestoneStatus;
  detail?: string;
}

export const MILESTONE_LABELS: Readonly<Record<MilestoneId, string>> = Object.freeze({
  read: "File read",
  columns: "Columns identified",
  rows: "Every row accounted for",
  amounts: "Amounts checked",
  balance: "Debits equal credits",
  classification: "Accounts classified",
  recorded: "Result recorded",
});

const MILESTONE_ORDER: MilestoneId[] = ["read", "columns", "rows", "amounts", "balance", "classification", "recorded"];

/** Records what processing actually reached, in order. Anything never marked is "not_reached". */
export class MilestoneLog {
  private readonly marks = new Map<MilestoneId, { status: MilestoneStatus; detail?: string }>();
  mark(id: MilestoneId, status: MilestoneStatus, detail?: string): void {
    this.marks.set(id, { status, detail });
  }
  list(): Milestone[] {
    return MILESTONE_ORDER.map((id) => ({ id, label: MILESTONE_LABELS[id], status: this.marks.get(id)?.status ?? "not_reached", ...(this.marks.get(id)?.detail ? { detail: this.marks.get(id)!.detail } : {}) }));
  }
}

const AMOUNT_ISSUES = new Set<IssueCode>(["MALFORMED_NUMERIC_VALUE", "LAYOUT_NUMBER_FORMAT_MISMATCH", "PRECISION_EXCEEDS_CURRENCY", "AMOUNT_OUT_OF_RANGE", "BALANCE_COLUMN_MISMATCH", "CURRENCY_MISMATCH"]);
const ROW_ISSUES = new Set<IssueCode>(["MISSING_ACCOUNT_CODE", "DUPLICATE_ACCOUNT_CODE", "DUPLICATE_ACCOUNT_NAME", "TOTAL_ROW_MISMATCH", "TEMPLATE_EXAMPLE_UPLOADED", "NO_ACCOUNT_ROWS"]);
const COLUMN_ISSUES = new Set<IssueCode>(["LAYOUT_SHEET_NOT_FOUND", "LAYOUT_HEADER_NOT_FOUND", "LAYOUT_COLUMN_NOT_FOUND", "LAYOUT_COLUMN_DUPLICATED", "MISSING_COLUMN", "AMBIGUOUS_AMOUNT_COLUMNS", "PERIOD_MISMATCH", "MULTIPLE_TRIAL_BALANCE_SHEETS", "UNSUPPORTED_LAYOUT"]);
// The file was refused as a whole before any check ran: an upload-policy limit (uploadPolicy.ts) or a file that cannot be
// read as a trial balance. The record stops at "read" with the reason — never a later step (no totals is not an
// arithmetic failure).
const READ_REFUSALS = new Set<IssueCode>(["FILE_TOO_LARGE", "WORKBOOK_TOO_LARGE_EXPANDED", "WORKBOOK_TOO_MANY_PARTS", "TOO_MANY_ROWS", "TOO_MANY_CELLS", "TOO_MANY_ACCOUNTS", "UNSUPPORTED_FORMAT", "ENCODING_NOT_UTF8", "CSV_UNTERMINATED_QUOTE", "FORMULA_WITHOUT_VALUE"]);

/** Marks the ingestion milestones (read → balance) from an ingest result. */
export function markIngestionMilestones(log: MilestoneLog, r: IngestResult): void {
  const codes = new Set(r.issues.filter((i) => i.severity === "blocking").map((i) => i.code));
  const has = (set: Set<IssueCode>) => [...codes].some((c) => set.has(c));
  const refusal = r.issues.find((i) => i.severity === "blocking" && READ_REFUSALS.has(i.code));
  if (refusal) { log.mark("read", "failed", refusal.message); return; }
  const prereq = codes.has("PERIOD_NOT_SELECTED") || codes.has("CURRENCY_UNRESOLVED") || codes.has("CURRENCY_UNSUPPORTED") || codes.has("FILE_EMPTY");
  if (prereq) { log.mark("read", "failed"); return; }
  log.mark("read", "passed", `${r.lineageSummary.rowsRead} rows${r.sheetName ? ` on sheet “${r.sheetName}”` : ""}`);
  if (has(COLUMN_ISSUES)) { log.mark("columns", "failed"); return; }
  log.mark("columns", "passed", Object.values(r.columns).join(", "));
  const s = r.lineageSummary;
  const accounted = s.preamble + s.header + s.blank + s.heading + s.total + s.zero_balance + s.account + s.rejected;
  const rowDetail = `${s.account} accounts, ${s.total} total rows, ${s.heading} headings, ${s.zero_balance} zero-balance, ${s.blank + s.preamble} other` + (s.rejected ? `, ${s.rejected} rejected` : "");
  if (accounted !== s.rowsRead || has(ROW_ISSUES)) { log.mark("rows", "failed", rowDetail); return; }
  log.mark("rows", "passed", rowDetail);
  if (has(AMOUNT_ISSUES)) { log.mark("amounts", "failed"); return; }
  log.mark("amounts", "passed", `exact to ${r.exponent} decimal place${r.exponent === 1 ? "" : "s"} (${r.currency})`);
  if (codes.has("TRIAL_BALANCE_IMBALANCE") || !r.totals) { log.mark("balance", "failed"); return; }
  log.mark("balance", "passed", `${formatMinor(r.totals.debitMinor, r.exponent as number)} = ${formatMinor(r.totals.creditMinor, r.exponent as number)}`);
}
