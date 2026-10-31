/**
 * qboTrialBalance — converts a QuickBooks Online "TrialBalance" report response (the JSON of
 * GET /v3/company/<realm>/reports/TrialBalance) into the canonical trial-balance rows and the canonical CSV file the upload
 * path already reads. Pure and deterministic: no network, no clock, no storage, no credentials, no authority.
 *
 * A connector is another SOURCE OF THE SAME FILE (docs/architecture/QUICKBOOKS_ONLINE_CONNECTOR_PLAN.md §2), so this module
 * only turns one response into one file; the file then goes through the same ingestion (tbIngestion.ts) as any upload.
 *
 * Never guesses. A response is refused, with a stated reason, when anything in it is not exactly the shape the recorded
 * sandbox report has: other report names, summarised columns, nested sections, negative or malformed amounts, a row with both
 * sides, a missing or repeated account id, a missing control total, a control total that disagrees with the rows, or a report
 * whose own debits and credits differ. Amounts are read from the decimal strings as integers of minor units (never floats).
 *
 * The source account ids are returned beside the rows (provenance, charter L1) and are NOT written into the file: they are
 * not account codes, and a column the reader does not know could be taken for a dimension.
 */

export type QboTbRefusalCode =
  | "NOT_A_REPORT"
  | "WRONG_REPORT"
  | "NO_REPORT_DATA"
  | "UNEXPECTED_COLUMNS"
  | "SUMMARISED_COLUMNS"
  | "MISSING_CURRENCY"
  | "BAD_PERIOD"
  | "UNSUPPORTED_STRUCTURE"
  | "MISSING_ACCOUNT_NAME"
  | "MISSING_ACCOUNT_ID"
  | "DUPLICATE_ACCOUNT_ID"
  | "BAD_AMOUNT"
  | "BOTH_SIDES"
  | "NO_CONTROL_TOTAL"
  | "CONTROL_TOTAL_MISMATCH"
  | "UNBALANCED";

export interface QboTbRow {
  /** QuickBooks's own stable id for the account (provenance only). */
  sourceAccountId: string;
  accountName: string;
  debitMinor: bigint;
  creditMinor: bigint;
}

export interface QboTbReport {
  basis: string | null;
  currency: string;
  startPeriod: string;
  endPeriod: string;
  rows: QboTbRow[];
  totals: { debitMinor: bigint; creditMinor: bigint };
}

export type QboTbParse = { ok: true; report: QboTbReport } | { ok: false; code: QboTbRefusalCode; message: string };

const refuse = (code: QboTbRefusalCode, message: string): QboTbParse => ({ ok: false, code, message });

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObj = (v: unknown): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/** "" -> 0; "1201", "1201.5", "1201.50" -> minor units; anything else (sign, exponent, separators, >2 decimals) -> null. */
export function parseMinor(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  if (value === "") return 0n;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) return null;
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
}

export function formatMinor(minor: bigint): string {
  const whole = minor / 100n;
  const frac = (minor % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}`;
}

export function parseQboTrialBalanceReport(input: unknown): QboTbParse {
  if (!isObj(input) || !isObj(input.Header) || !isObj(input.Columns) || !isObj(input.Rows)) {
    return refuse("NOT_A_REPORT", "The response is not a QuickBooks report (Header, Columns and Rows are all required).");
  }
  const header = input.Header;
  if (header.ReportName !== "TrialBalance") {
    return refuse("WRONG_REPORT", `Only the TrialBalance report is read (this one is "${String(header.ReportName)}").`);
  }
  const options = Array.isArray(header.Option) ? header.Option : [];
  if (options.some((o) => isObj(o) && o.Name === "NoReportData" && String(o.Value).toLowerCase() === "true")) {
    return refuse("NO_REPORT_DATA", "QuickBooks says the report has no data for this period.");
  }
  if (header.SummarizeColumnsBy !== undefined && header.SummarizeColumnsBy !== "Total") {
    return refuse("SUMMARISED_COLUMNS", "The report is split into columns; only a single total column is read.");
  }
  if (typeof header.Currency !== "string" || !/^[A-Z]{3}$/.test(header.Currency)) {
    return refuse("MISSING_CURRENCY", "The report does not state its currency.");
  }
  if (!isDate(header.StartPeriod) || !isDate(header.EndPeriod) || header.StartPeriod > header.EndPeriod) {
    return refuse("BAD_PERIOD", "The report does not state a valid start and end date.");
  }

  const cols = Array.isArray(input.Columns.Column) ? input.Columns.Column : [];
  const shape = cols.map((c) => (isObj(c) ? `${String(c.ColType)}:${String(c.ColTitle)}` : "?")).join("|");
  if (shape !== "Account:|Money:Debit|Money:Credit") {
    return refuse("UNEXPECTED_COLUMNS", "The report columns are not exactly Account, Debit, Credit.");
  }

  const rawRows = Array.isArray(input.Rows.Row) ? input.Rows.Row : null;
  if (!rawRows) return refuse("UNSUPPORTED_STRUCTURE", "The report has no row list.");

  const rows: QboTbRow[] = [];
  const seen = new Set<string>();
  let debit = 0n;
  let credit = 0n;
  let control: { debitMinor: bigint; creditMinor: bigint } | null = null;

  for (let i = 0; i < rawRows.length; i++) {
    const r = rawRows[i];
    if (!isObj(r)) return refuse("UNSUPPORTED_STRUCTURE", `Row ${i + 1} is not an object.`);
    if (isObj(r.Summary) && r.group === "GrandTotal") {
      if (i !== rawRows.length - 1 || control) return refuse("UNSUPPORTED_STRUCTURE", "The grand total must appear exactly once, last.");
      const cells = Array.isArray(r.Summary.ColData) ? r.Summary.ColData : [];
      const d = isObj(cells[1]) ? parseMinor(cells[1].value) : null;
      const c = isObj(cells[2]) ? parseMinor(cells[2].value) : null;
      if (cells.length !== 3 || d === null || c === null) return refuse("NO_CONTROL_TOTAL", "The grand total row is not readable.");
      control = { debitMinor: d, creditMinor: c };
      continue;
    }
    if (r.Rows !== undefined || r.Header !== undefined || r.Summary !== undefined || r.group !== undefined || r.type !== undefined) {
      return refuse("UNSUPPORTED_STRUCTURE", `Row ${i + 1} is a section or group; only flat account rows are read.`);
    }
    const cells = Array.isArray(r.ColData) ? r.ColData : [];
    if (cells.length !== 3 || !cells.every(isObj)) return refuse("UNSUPPORTED_STRUCTURE", `Row ${i + 1} does not have exactly three cells.`);
    const [nameCell, debitCell, creditCell] = cells as { [k: string]: Json }[];
    const name = typeof nameCell.value === "string" ? nameCell.value.trim() : "";
    if (name === "") return refuse("MISSING_ACCOUNT_NAME", `Row ${i + 1} has no account name.`);
    const id = typeof nameCell.id === "string" ? nameCell.id.trim() : "";
    if (id === "") return refuse("MISSING_ACCOUNT_ID", `Row ${i + 1} ("${name}") has no account id.`);
    if (seen.has(id)) return refuse("DUPLICATE_ACCOUNT_ID", `Account id ${id} appears more than once.`);
    seen.add(id);
    const d = parseMinor(debitCell.value);
    const c = parseMinor(creditCell.value);
    if (d === null || c === null) return refuse("BAD_AMOUNT", `Row ${i + 1} ("${name}") has an amount that is not a plain non-negative decimal.`);
    if (d !== 0n && c !== 0n) return refuse("BOTH_SIDES", `Row ${i + 1} ("${name}") has both a debit and a credit.`);
    rows.push({ sourceAccountId: id, accountName: name, debitMinor: d, creditMinor: c });
    debit += d;
    credit += c;
  }

  if (!control) return refuse("NO_CONTROL_TOTAL", "The report has no grand total row to check against.");
  if (control.debitMinor !== debit || control.creditMinor !== credit) {
    return refuse("CONTROL_TOTAL_MISMATCH", "The grand total does not equal the sum of the account rows.");
  }
  if (debit !== credit) return refuse("UNBALANCED", "The report's debits and credits are not equal.");

  return {
    ok: true,
    report: {
      basis: typeof header.ReportBasis === "string" ? header.ReportBasis : null,
      currency: header.Currency,
      startPeriod: header.StartPeriod,
      endPeriod: header.EndPeriod,
      rows,
      totals: { debitMinor: debit, creditMinor: credit },
    },
  };
}

const csvCell = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The canonical file: Account Name, Debit, Credit (header, then one line per account, LF endings, plain decimals). */
export function toCanonicalCsv(report: QboTbReport): string {
  const lines = ["Account Name,Debit,Credit"];
  for (const r of report.rows) {
    lines.push([csvCell(r.accountName), r.debitMinor === 0n ? "" : formatMinor(r.debitMinor), r.creditMinor === 0n ? "" : formatMinor(r.creditMinor)].join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * The normalised accounting result of an ingested trial balance: the accounts (by identity) with their minor-unit amounts,
 * and nothing else (no row numbers, file names, hashes or times). Two sources of the same books give the same string;
 * the caller hashes it (charter A2 parity, and "up to date" on refresh).
 */
export function normalisedAccountingResult(accounts: readonly { identity: string; accountName: string; debitMinor: bigint; creditMinor: bigint }[]): string {
  const sorted = [...accounts].sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  return JSON.stringify(sorted.map((a) => [a.identity, a.accountName, a.debitMinor.toString(), a.creditMinor.toString()]));
}
