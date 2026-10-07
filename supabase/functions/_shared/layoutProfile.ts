/**
 * layoutProfile — the manual trial-balance layout ("layout-template/1") and its resolution against one file.
 *
 * A layout says, explicitly, where a trial balance is in a file: the sheet (workbooks), the header row, which header
 * holds each column, the number format of text amounts and — for a single Balance column — its sign convention. It is
 * reusable: a template carries no source hash and no row data. Applying it to a file RESOLVES it (exact column indexes
 * for that file) and the resolved form is hashed; a layout confirmation ("layout-confirmation/1") binds that hash to the
 * file's source hash, so the same layout on a different file is a different confirmation.
 *
 * Reuse re-validates everything against the file: a header that moved or changed, a missing column, a sheet that is not
 * there or amounts written in another number format are refused (never guessed around). With no layout, ingestion runs
 * the automatic path exactly as before — this module is not consulted at all.
 *
 * Pure TypeScript (imports: the ingestion core and hash.ts), so the Deno edge functions and the vitest suite run the
 * same code.
 */

import { canonicalJson, sha256Hex, type CanonicalValue } from "./hash.ts";
import {
  ingestTrialBalance, parseAmount, type Cell, type ColumnMap, type IngestInput, type IngestIssue, type IngestLayout,
  type IngestResult, type ParsedAmount, type SourceRow,
} from "./tbIngestion.ts";

export const LAYOUT_TEMPLATE_FORMAT = "layout-template/1";
export const LAYOUT_RESOLVED_FORMAT = "layout-resolved/1";
export const LAYOUT_CONFIRMATION_FORMAT = "layout-confirmation/1";

// ── Number formats ───────────────────────────────────────────────────────────────────────────────────────────────────

export const NUMBER_FORMATS = {
  comma_dot:      { group: ",", decimal: ".", example: "1,234,567.89" },
  space_dot:      { group: " ", decimal: ".", example: "1 234 567.89" },
  apostrophe_dot: { group: "'", decimal: ".", example: "1'234'567.89" },
  plain_dot:      { group: "",  decimal: ".", example: "1234567.89" },
  dot_comma:      { group: ".", decimal: ",", example: "1.234.567,89" },
  space_comma:    { group: " ", decimal: ",", example: "1 234 567,89" },
  plain_comma:    { group: "",  decimal: ",", example: "1234567,89" },
} as const;
export type NumberFormatId = keyof typeof NUMBER_FORMATS;
export const NUMBER_FORMAT_IDS = Object.keys(NUMBER_FORMATS) as NumberFormatId[];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BODY_GRAMMAR: Record<NumberFormatId, RegExp> = Object.fromEntries(NUMBER_FORMAT_IDS.map((id) => {
  const { group, decimal } = NUMBER_FORMATS[id];
  const whole = group ? `(\\d+|\\d{1,3}(?:${escape(group)}\\d{3})+)` : "(\\d+)";
  return [id, new RegExp(`^${whole}(?:${escape(decimal)}(\\d+))?$`)];
})) as Record<NumberFormatId, RegExp>;

const DASH_ONLY = /^[-‐‑‒–—―]$/;
const WRAPPER = /^(\(?)\s*([-+]?)\s*(.*?)\s*(\)?)$/;

function normalizeAmountText(s: string): string {
  // No-break and narrow no-break spaces are group separators as written; a typographic apostrophe is an apostrophe.
  return s.replace(/[   ]/g, " ").replace(/[’‘]/g, "'").trim();
}

/** The body of a text amount in canonical grammar ("1234.56"), or null when it is not written in `format`. */
export function canonicalAmountBody(body: string, format: NumberFormatId): string | null {
  const m = BODY_GRAMMAR[format].exec(body);
  if (!m) return null;
  const group = NUMBER_FORMATS[format].group;
  const whole = group ? m[1].split(group).join("") : m[1];
  return m[2] !== undefined ? `${whole}.${m[2]}` : whole;
}

/**
 * Parses one amount cell under a declared number format. Number cells are read exactly as the automatic path reads
 * them (they carry no separators). A text cell not written in the declared format is "format" when it would read under
 * another known format (a number-format mismatch), and "malformed" otherwise.
 */
export function parseAmountInFormat(cell: Cell, exponent: number, format: NumberFormatId): ParsedAmount {
  if (typeof cell !== "string") return parseAmount(cell, exponent);
  const text = normalizeAmountText(cell);
  if (text === "" || DASH_ONLY.test(text)) return { kind: "blank" };
  const w = WRAPPER.exec(text);
  if (!w || !/^\d/.test(w[3]) || !/\d$/.test(w[3])) return { kind: "malformed", text };
  const body = canonicalAmountBody(w[3], format);
  if (body === null) {
    const elsewhere = NUMBER_FORMAT_IDS.some((f) => f !== format && canonicalAmountBody(w[3], f) !== null);
    return elsewhere ? { kind: "format", text } : { kind: "malformed", text };
  }
  const parsed = parseAmount(`${w[1]}${w[2]}${body}${w[4]}`, exponent);
  // The wrapper (parentheses, sign) is validated by the exact parser; report the cell as written.
  return parsed.kind === "malformed" || parsed.kind === "precision" || parsed.kind === "range" ? { ...parsed, text } : parsed;
}

/**
 * Which number formats every text amount in `cells` can be read in, and whether the choice changes a value. Used to
 * pre-select a format and to say when the person must choose (e.g. "1.234" is 1234 or 1.234).
 */
export function numberFormatEvidence(cells: Cell[]): { consistent: NumberFormatId[]; ambiguous: boolean; textCells: number } {
  const texts = cells.filter((c): c is string => typeof c === "string").map(normalizeAmountText)
    .filter((t) => t !== "" && !DASH_ONLY.test(t));
  const bodies = texts.map((t) => WRAPPER.exec(t)?.[3] ?? t);
  const consistent = NUMBER_FORMAT_IDS.filter((f) => bodies.every((b) => canonicalAmountBody(b, f) !== null));
  const values = new Set(consistent.map((f) => bodies.map((b) => canonicalAmountBody(b, f)).join("|")));
  return { consistent, ambiguous: values.size > 1, textCells: texts.length };
}

// ── The profile ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LayoutColumns {
  accountCode: string | null;
  accountName: string | null;
  debit: string | null;
  credit: string | null;
  balance: string | null;
  dimensions: string[];
}

export interface LayoutProfile {
  format: typeof LAYOUT_TEMPLATE_FORMAT;
  /** CSV files have no sheets; a workbook layout names its sheet exactly. */
  sheet: { kind: "csv" } | { kind: "sheet"; name: string };
  /** 1-based, as a spreadsheet or text editor shows it. */
  headerRow: number;
  columns: LayoutColumns;
  numberFormat: NumberFormatId;
  /** Required for a single Balance column (no Debit and Credit); null otherwise. */
  balanceSign: "debit_positive" | "credit_positive" | null;
}

export type ProfileValidation = { ok: true; profile: LayoutProfile } | { ok: false; errors: string[] };

const MAX_HEADER = 200;
const MAX_DIMENSIONS = 10;
const MAX_HEADER_ROW = 1000;

export function normalizeHeader(s: unknown): string {
  return String(s ?? "").replace(/[  ]/g, " ").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Validates an untrusted layout (from a request) and returns it in canonical form. */
export function validateProfile(input: unknown): ProfileValidation {
  const errors: string[] = [];
  const o = (input ?? {}) as Record<string, unknown>;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, errors: ["The layout must be an object."] };
  const allowed = new Set(["format", "sheet", "headerRow", "columns", "numberFormat", "balanceSign"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) errors.push(`Unknown layout field “${k}”.`);
  if (o.format !== LAYOUT_TEMPLATE_FORMAT) errors.push(`The layout format must be ${LAYOUT_TEMPLATE_FORMAT}.`);

  let sheet: LayoutProfile["sheet"] | null = null;
  const sh = o.sheet as Record<string, unknown> | undefined;
  if (sh && typeof sh === "object" && sh.kind === "csv" && Object.keys(sh).length === 1) sheet = { kind: "csv" };
  else if (sh && typeof sh === "object" && sh.kind === "sheet" && typeof sh.name === "string" && sh.name.trim() !== ""
           && sh.name.length <= 31 && Object.keys(sh).length === 2) sheet = { kind: "sheet", name: sh.name };
  else errors.push("Choose the sheet (or CSV).");

  const headerRow = o.headerRow;
  if (!Number.isInteger(headerRow) || (headerRow as number) < 1 || (headerRow as number) > MAX_HEADER_ROW) errors.push(`The header row must be a row number from 1 to ${MAX_HEADER_ROW}.`);

  const c = (o.columns ?? {}) as Record<string, unknown>;
  const col = (k: keyof Omit<LayoutColumns, "dimensions">): string | null => {
    const v = c[k];
    if (v === null || v === undefined) return null;
    if (typeof v !== "string" || v.trim() === "" || v.length > MAX_HEADER) { errors.push(`The ${k} column must be a header from the file.`); return null; }
    return v.trim();
  };
  const columns: LayoutColumns = {
    accountCode: col("accountCode"), accountName: col("accountName"), debit: col("debit"), credit: col("credit"), balance: col("balance"),
    dimensions: [],
  };
  if (c.dimensions !== undefined) {
    if (!Array.isArray(c.dimensions) || c.dimensions.length > MAX_DIMENSIONS
        || c.dimensions.some((d) => typeof d !== "string" || d.trim() === "" || d.length > MAX_HEADER)) {
      errors.push(`Dimension columns must be up to ${MAX_DIMENSIONS} headers from the file.`);
    } else columns.dimensions = (c.dimensions as string[]).map((d) => d.trim());
  }
  for (const k of Object.keys(c)) if (!["accountCode", "accountName", "debit", "credit", "balance", "dimensions"].includes(k)) errors.push(`Unknown column role “${k}”.`);
  if (!columns.accountCode && !columns.accountName) errors.push("Choose the account code column, the account name column, or both.");
  const debitCredit = !!columns.debit && !!columns.credit;
  if (!debitCredit && !columns.balance) errors.push("Choose Debit and Credit columns, or a single Balance column.");
  if ((!!columns.debit) !== (!!columns.credit)) errors.push("Debit and Credit are chosen together.");
  const assigned = [columns.accountCode, columns.accountName, columns.debit, columns.credit, columns.balance, ...columns.dimensions]
    .filter((x): x is string => !!x).map(normalizeHeader);
  if (new Set(assigned).size !== assigned.length) errors.push("Each column of the file can have only one role.");

  const numberFormat = o.numberFormat;
  if (typeof numberFormat !== "string" || !(numberFormat in NUMBER_FORMATS)) errors.push("Choose the number format of the amounts.");

  const balanceOnly = !debitCredit && !!columns.balance;
  const balanceSign = o.balanceSign ?? null;
  if (balanceOnly && balanceSign !== "debit_positive" && balanceSign !== "credit_positive") errors.push("Say whether a positive balance is a debit or a credit.");
  if (!balanceOnly && balanceSign !== null) errors.push("A balance sign applies only to a single Balance column.");

  if (errors.length > 0 || !sheet) return { ok: false, errors };
  return {
    ok: true,
    profile: {
      format: LAYOUT_TEMPLATE_FORMAT, sheet, headerRow: headerRow as number, columns,
      numberFormat: numberFormat as NumberFormatId, balanceSign: balanceSign as LayoutProfile["balanceSign"],
    },
  };
}

export function profileCanonicalJson(profile: LayoutProfile): string {
  return canonicalJson(profile as unknown as CanonicalValue);
}
export function profileSha256(profile: LayoutProfile): Promise<string> {
  return sha256Hex(profileCanonicalJson(profile));
}

// ── Resolution against one file ──────────────────────────────────────────────────────────────────────────────────────

export interface ResolvedLayout {
  format: typeof LAYOUT_RESOLVED_FORMAT;
  profileSha256: string;
  sheetName: string | null;
  headerRowNumber: number;
  columns: { accountCode: number | null; accountName: number | null; debit: number | null; credit: number | null; balance: number | null };
  dimensions: number[];
  numberFormat: NumberFormatId;
  balanceSign: LayoutProfile["balanceSign"];
}

export type Resolution =
  | { ok: true; resolved: ResolvedLayout; layout: IngestLayout }
  | { ok: false; issues: IngestIssue[] };

/** Applies a profile to the rows of the chosen sheet: every named column must be in the header row exactly once. */
export function resolveLayout(rows: SourceRow[], sheetName: string | null, profile: LayoutProfile, profileHash: string): Resolution {
  const headerIndex = rows.findIndex((r) => r.rowNumber === profile.headerRow);
  if (headerIndex < 0 || rows[headerIndex].cells.length === 0) {
    return { ok: false, issues: [{ code: "LAYOUT_HEADER_NOT_FOUND", severity: "blocking", rows: [profile.headerRow], field: "header", message: `Row ${profile.headerRow} is not a header row in this file. The layout expects the column headers on row ${profile.headerRow}; check the file, or confirm a new layout.` }] };
  }
  const header = rows[headerIndex];
  const headers = header.cells.map((c) => String(c ?? "").trim());
  const normalized = headers.map(normalizeHeader);
  const issues: IngestIssue[] = [];
  const find = (role: string, name: string | null): number | null => {
    if (name === null) return null;
    const hits = normalized.flatMap((h, i) => (h === normalizeHeader(name) ? [i] : []));
    if (hits.length === 1) return hits[0];
    issues.push(hits.length === 0
      ? { code: "LAYOUT_COLUMN_NOT_FOUND", severity: "blocking", rows: [header.rowNumber], field: role, message: `Row ${header.rowNumber} has no “${name}” column (the layout's ${role} column). The file's headers changed; check the file, or confirm a new layout.` }
      : { code: "LAYOUT_COLUMN_DUPLICATED", severity: "blocking", rows: [header.rowNumber], field: role, message: `Row ${header.rowNumber} has “${name}” more than once, so the layout's ${role} column is ambiguous. Rename one of them, or confirm a new layout.` });
    return null;
  };
  const cols = {
    accountCode: find("account code", profile.columns.accountCode),
    accountName: find("account name", profile.columns.accountName),
    debit: find("debit", profile.columns.debit),
    credit: find("credit", profile.columns.credit),
    balance: find("balance", profile.columns.balance),
  };
  const dimensions = profile.columns.dimensions.map((d) => find("dimension", d)).filter((x): x is number => x !== null);
  if (issues.length > 0) return { ok: false, issues };

  const map: ColumnMap = {
    account_code: cols.accountCode, account_name: cols.accountName, debit: cols.debit, credit: cols.credit, balance: cols.balance,
    dimensions, headerIndex, headerRowNumber: header.rowNumber, headers,
  };
  const detected: Record<string, string> = {};
  for (const [role, i] of [["account_code", cols.accountCode], ["account_name", cols.accountName], ["debit", cols.debit], ["credit", cols.credit], ["balance", cols.balance]] as const) {
    if (i !== null) detected[role] = headers[i];
  }
  if (dimensions.length > 0) detected.dimensions = dimensions.map((i) => headers[i]).join(", ");
  const format = profile.numberFormat;
  return {
    ok: true,
    resolved: {
      format: LAYOUT_RESOLVED_FORMAT, profileSha256: profileHash, sheetName, headerRowNumber: header.rowNumber,
      columns: cols, dimensions, numberFormat: format, balanceSign: profile.balanceSign,
    },
    layout: {
      map, detected, issues: [],
      parse: (cell, exponent) => parseAmountInFormat(cell, exponent, format),
      creditPositiveBalance: profile.balanceSign === "credit_positive",
      formatLabel: NUMBER_FORMATS[format].example,
    },
  };
}

export function resolvedLayoutSha256(resolved: ResolvedLayout): Promise<string> {
  return sha256Hex(canonicalJson(resolved as unknown as CanonicalValue));
}

/** Ingests `rows` under a layout. A layout that does not fit the file yields a blocking result naming why. */
export function ingestWithLayout(input: Omit<IngestInput, "layout">, profile: LayoutProfile, profileHash: string): { result: IngestResult; resolved: ResolvedLayout | null } {
  const r = resolveLayout(input.rows, input.sheetName, profile, profileHash);
  if (!r.ok) {
    const result = ingestTrialBalance({ ...input, layout: { map: null, detected: {}, issues: r.issues, parse: parseAmount, creditPositiveBalance: false, formatLabel: "" } });
    return { result, resolved: null };
  }
  return { result: ingestTrialBalance({ ...input, layout: r.layout }), resolved: r.resolved };
}
