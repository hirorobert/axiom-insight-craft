/**
 * tbIngestion — the ONE pure ingestion core for an uploaded trial balance (process-trial-balance).
 *
 * Plain TypeScript with no imports, so the Deno edge function and the vitest suite run the same code. It turns the
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
 *
 * Issues are "blocking" (the trial balance cannot be accepted until the file is corrected) or "review" (recorded for
 * the reviewer). Messages name the rows and say what to change.
 */

export const TB_INGESTION_VERSION = "tb-ingest-3.0.0";

export type Cell = string | number | boolean | null | undefined;

/** One physical row of the source. rowNumber is 1-based, exactly as a spreadsheet or text editor shows it. */
export interface SourceRow {
  rowNumber: number;
  cells: Cell[];
}

export type IssueCode =
  | "FILE_EMPTY"
  | "UNSUPPORTED_FORMAT"
  | "ENCODING_NOT_UTF8"
  | "CSV_UNTERMINATED_QUOTE"
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
  | "TRIAL_BALANCE_IMBALANCE";

export interface IngestIssue {
  code: IssueCode;
  severity: "blocking" | "review";
  message: string;
  rows?: number[];
  field?: string;
}

const MAX_LISTED_ROWS = 10;

function listRows(rows: number[]): string {
  const shown = rows.slice(0, MAX_LISTED_ROWS).join(", ");
  return rows.length > MAX_LISTED_ROWS ? `${shown} and ${rows.length - MAX_LISTED_ROWS} more` : shown;
}

// ── Currency ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ISO 4217 minor-unit exponents for the currencies a reporting period may use. A currency missing here is refused
 * (CURRENCY_UNSUPPORTED), never assumed to have two decimals.
 */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  TZS: 2, KES: 2, UGX: 0, RWF: 0, BIF: 0, ETB: 2, ZAR: 2, ZMW: 2, MWK: 2, MZN: 2, NGN: 2, GHS: 2, XOF: 0, XAF: 0,
  EGP: 2, MAD: 2, MUR: 2, SCR: 2, CDF: 2, SSP: 2, SDG: 2, SOS: 2, DJF: 0, BWP: 2, NAD: 2, LSL: 2, SZL: 2, AOA: 2,
  USD: 2, EUR: 2, GBP: 2, CHF: 2, CAD: 2, AUD: 2, NZD: 2, SEK: 2, NOK: 2, DKK: 2, CNY: 2, INR: 2, PKR: 2, AED: 2,
  SAR: 2, QAR: 2, JPY: 0, KRW: 0, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3, LYD: 3, IQD: 3,
});

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
  | { kind: "range"; text: string };

const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
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
  if (fraction.length > exponent) return { kind: "precision", text, decimals: fraction.length };
  const minorAbs = BigInt(whole) * pow10(exponent) + (fraction ? BigInt(fraction.padEnd(exponent, "0")) : 0n);
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

/** Strict UTF-8 (a UTF-8 byte-order mark is removed). Anything else is refused rather than decoded with U+FFFD. */
export function decodeCsvBytes(bytes: Uint8Array): DecodeResult {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    return { ok: false, issue: { code: "ENCODING_NOT_UTF8", severity: "blocking", message: "The CSV is saved as UTF-16. Save it as “CSV UTF-8 (Comma delimited)” and upload it again." } };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, issue: { code: "ENCODING_NOT_UTF8", severity: "blocking", message: "The CSV is not UTF-8 text. Save it as “CSV UTF-8 (Comma delimited)” and upload it again." } };
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
export function parseCsvText(text: string): CsvResult {
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

  for (let i = 0; i < text.length; i++) {
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
    s === "code" || s.startsWith("a/c") ||
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
  // With Debit and Credit columns, balance columns are not used for arithmetic, so their number does not matter.
  const balance = hasDebitCredit ? (byRole.balance.length === 1 ? pick("balance", byRole.balance) : null) : resolveAmount("balance");

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

// ── Rows → accounts ──────────────────────────────────────────────────────────────────────────────────────────────────

export type RowDisposition =
  | "preamble" | "header" | "blank" | "heading" | "total" | "zero_balance" | "account" | "rejected";

export interface RowLineage {
  rowNumber: number;
  disposition: RowDisposition;
  /** The account identity for an "account" row. */
  identity?: string;
  reason?: string;
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
}

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

export interface IngestInput {
  rows: SourceRow[];
  sheetName: string | null;
  /** The reporting period the upload was made for — required. */
  periodYear: number | null;
  /** ISO 4217 code of the period's reporting currency — required. */
  currency: string | null;
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

  const detection = detectColumns(rows, periodYear);
  issues.push(...detection.issues);
  if (!detection.map || detection.issues.some((i) => i.severity === "blocking")) return result({ columns: detection.detected });
  const map = detection.map;
  issues.push(...periodAndCurrencyIssues(rows, map, periodYear as number, currency as string));
  const exp = exponent as number;

  const lineage: RowLineage[] = [];
  const accounts: IngestedAccount[] = [];
  const suspectedTotalRows: number[] = [];
  const malformed: { row: number; field: string; text: string }[] = [];
  const precision: { row: number; field: string; text: string; decimals: number }[] = [];
  const range: { row: number; field: string; text: string }[] = [];
  const balanceMismatch: number[] = [];
  const missingCode: number[] = [];
  const exampleRows: number[] = [];
  const totalRowsChecked: { row: number; debit: bigint; credit: bigint; accountsDebit: bigint; accountsCredit: bigint }[] = [];
  let runningDebit = 0n;
  let runningCredit = 0n;
  const hasCodeColumn = map.account_code !== null;
  const useDebitCredit = map.debit !== null && map.credit !== null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i < map.headerIndex) { lineage.push({ rowNumber: row.rowNumber, disposition: row.cells.length === 0 ? "blank" : "preamble" }); continue; }
    if (i === map.headerIndex) { lineage.push({ rowNumber: row.rowNumber, disposition: "header" }); continue; }
    if (row.cells.length === 0) { lineage.push({ rowNumber: row.rowNumber, disposition: "blank" }); continue; }

    const code = hasCodeColumn ? cellString(row.cells[map.account_code as number]) : "";
    const name = map.account_name !== null ? cellString(row.cells[map.account_name]) : "";
    const read = (col: number | null, field: string): bigint | null | "bad" => {
      if (col === null) return null;
      const p = parseAmount(row.cells[col], exp);
      if (p.kind === "blank") return null;
      if (p.kind === "amount") return p.minor;
      if (p.kind === "malformed") malformed.push({ row: row.rowNumber, field, text: p.text });
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
      lineage.push(anyAmount
        ? { rowNumber: row.rowNumber, disposition: "rejected", reason: "amounts without an account code or name" }
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
      const bal = b ?? 0n;
      debit = bal > 0n ? bal : 0n;
      credit = bal < 0n ? -bal : 0n;
    }
    const allBlank = (useDebitCredit ? d === null && c === null : true) && b === null;

    if (!code) {
      const looksTotal = TOTAL_NAME_PATTERNS.some((p) => p.test(name));
      if (looksTotal) {
        if (GRAND_TOTAL_PATTERN.test(name) && !allBlank) {
          totalRowsChecked.push({ row: row.rowNumber, debit, credit, accountsDebit: runningDebit, accountsCredit: runningCredit });
        }
        lineage.push({ rowNumber: row.rowNumber, disposition: "total", reason: name });
        continue;
      }
    }
    // No amounts at all: a coded account with no postings, or a group heading.
    if (allBlank) { lineage.push({ rowNumber: row.rowNumber, disposition: code ? "zero_balance" : "heading", reason: name || code }); continue; }
    if (hasCodeColumn && !code) {
      missingCode.push(row.rowNumber);
      lineage.push({ rowNumber: row.rowNumber, disposition: "rejected", reason: "amounts without an account code" });
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
    issues.push({ code: "MALFORMED_NUMERIC_VALUE", severity: "blocking", rows: malformed.map((x) => x.row), message: `Some amounts are not numbers: ${describe(malformed)}. Use plain numbers such as 1234.50 or 1,234.50 — no currency symbols or letters — and leave a cell empty (or “-”) for zero.` });
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
  const integrityBlocked = issues.some((i) => i.severity === "blocking");
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

  return result({ columns: detection.detected, accounts, lineage, totals, suspectedTotalRows });
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

const AMOUNT_ISSUES = new Set<IssueCode>(["MALFORMED_NUMERIC_VALUE", "PRECISION_EXCEEDS_CURRENCY", "AMOUNT_OUT_OF_RANGE", "BALANCE_COLUMN_MISMATCH", "CURRENCY_MISMATCH"]);
const ROW_ISSUES = new Set<IssueCode>(["MISSING_ACCOUNT_CODE", "DUPLICATE_ACCOUNT_CODE", "DUPLICATE_ACCOUNT_NAME", "TOTAL_ROW_MISMATCH", "TEMPLATE_EXAMPLE_UPLOADED", "NO_ACCOUNT_ROWS"]);
const COLUMN_ISSUES = new Set<IssueCode>(["MISSING_COLUMN", "AMBIGUOUS_AMOUNT_COLUMNS", "PERIOD_MISMATCH", "MULTIPLE_TRIAL_BALANCE_SHEETS", "UNSUPPORTED_LAYOUT"]);

/** Marks the ingestion milestones (read → balance) from an ingest result. */
export function markIngestionMilestones(log: MilestoneLog, r: IngestResult): void {
  const codes = new Set(r.issues.filter((i) => i.severity === "blocking").map((i) => i.code));
  const has = (set: Set<IssueCode>) => [...codes].some((c) => set.has(c));
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
