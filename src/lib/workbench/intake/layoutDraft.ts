/**
 * The manual layout editor's draft: what the person has chosen so far, the layout it becomes, and the plain-language
 * problems that stop it being sent. Pure. The server re-validates everything against the whole file
 * (trial-balance-layout); these checks only spare a round trip and name what is missing.
 */
import type { InspectSheet, LayoutProfile, NumberFormatId } from "./layoutClient";

export type ColumnRole = "accountCode" | "accountName" | "debit" | "credit" | "balance";
export const COLUMN_ROLES: readonly { id: ColumnRole; label: string }[] = [
  { id: "accountCode", label: "Account code" },
  { id: "accountName", label: "Account name" },
  { id: "debit", label: "Debit" },
  { id: "credit", label: "Credit" },
  { id: "balance", label: "Balance" },
];

export const NUMBER_FORMAT_CHOICES: readonly { id: NumberFormatId; example: string; label: string }[] = [
  { id: "comma_dot", example: "1,234,567.89", label: "Comma thousands, point decimals" },
  { id: "space_dot", example: "1 234 567.89", label: "Space thousands, point decimals" },
  { id: "apostrophe_dot", example: "1'234'567.89", label: "Apostrophe thousands, point decimals" },
  { id: "plain_dot", example: "1234567.89", label: "No thousands separator, point decimals" },
  { id: "dot_comma", example: "1.234.567,89", label: "Point thousands, comma decimals" },
  { id: "space_comma", example: "1 234 567,89", label: "Space thousands, comma decimals" },
  { id: "plain_comma", example: "1234567,89", label: "No thousands separator, comma decimals" },
];

export interface LayoutDraft {
  /** null for a CSV file. */
  sheetName: string | null;
  headerRow: number | null;
  columns: Record<ColumnRole, string | null>;
  dimensions: string[];
  numberFormat: NumberFormatId | null;
  balanceSign: "debit_positive" | "credit_positive" | null;
}

export const EMPTY_DRAFT: LayoutDraft = {
  sheetName: null, headerRow: null, columns: { accountCode: null, accountName: null, debit: null, credit: null, balance: null },
  dimensions: [], numberFormat: null, balanceSign: null,
};

const SUGGESTED_ROLE: Record<string, ColumnRole> = { account_code: "accountCode", account_name: "accountName", debit: "debit", credit: "credit", balance: "balance" };

/**
 * A starting draft from the server's automatic reading of one sheet. The number format is pre-selected only when the
 * file's text amounts read the same way in every consistent format; an ambiguous file leaves it for the person.
 */
export function draftFromSuggestion(sheet: InspectSheet): LayoutDraft {
  const columns = { ...EMPTY_DRAFT.columns };
  for (const [role, header] of Object.entries(sheet.suggestion?.columns ?? {})) {
    const r = SUGGESTED_ROLE[role];
    if (r) columns[r] = header;
  }
  const dims = sheet.suggestion?.columns.dimensions;
  const evidence = sheet.numberFormats;
  // Pre-selected only from real evidence that allows exactly one reading of every amount. No text amounts (no evidence)
  // or several readings with different values: the person chooses explicitly.
  const numberFormat = evidence.textCells > 0 && !evidence.ambiguous && evidence.consistent.length > 0 ? evidence.consistent[0] : null;
  return {
    sheetName: sheet.name, headerRow: sheet.suggestion?.headerRow ?? null, columns,
    dimensions: dims ? dims.split(", ").filter(Boolean) : [], numberFormat, balanceSign: null,
  };
}

/** The draft from a saved template's layout (re-validated by the server before it can be confirmed). */
export function draftFromProfile(p: LayoutProfile): LayoutDraft {
  return {
    sheetName: p.sheet.kind === "sheet" ? p.sheet.name : null, headerRow: p.headerRow,
    columns: { accountCode: p.columns.accountCode, accountName: p.columns.accountName, debit: p.columns.debit, credit: p.columns.credit, balance: p.columns.balance },
    dimensions: [...p.columns.dimensions], numberFormat: p.numberFormat, balanceSign: p.balanceSign,
  };
}

/** The header cells of the chosen header row, in order (for the column selects). */
/**
 * Up to `max` amounts as written in the file's preview, from the chosen amount columns (debit, credit or balance), for
 * showing the detected number format with the file's own examples. Display only: whole-file validation is the server's.
 */
export function sampleAmounts(sheet: InspectSheet | null, d: Pick<LayoutDraft, "headerRow" | "columns">, max = 2): string[] {
  const header = sheet?.preview.find((r) => r.rowNumber === d.headerRow);
  if (!sheet || !header) return [];
  const idx = [d.columns.debit, d.columns.credit, d.columns.balance].filter((c): c is string => !!c)
    .map((c) => header.cells.findIndex((x) => (x ?? "").trim() === c)).filter((i) => i >= 0);
  const out: string[] = [];
  for (const r of sheet.preview) {
    if (r.rowNumber <= (d.headerRow ?? 0)) continue;
    for (const i of idx) {
      const v = (r.cells[i] ?? "").trim();
      if (v && /\d/.test(v) && !out.includes(v)) out.push(v);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export function headerCells(sheet: InspectSheet | null, headerRow: number | null): string[] {
  const row = sheet?.preview.find((r) => r.rowNumber === headerRow);
  return (row?.cells ?? []).map((c) => (c ?? "").trim()).filter((c) => c !== "");
}

const balanceOnly = (d: LayoutDraft) => !!d.columns.balance && !(d.columns.debit && d.columns.credit);

/** What still stops the draft being a complete layout, in the order a person fixes it. Empty = complete. */
export function draftProblems(d: LayoutDraft, kind: "csv" | "workbook"): string[] {
  const out: string[] = [];
  if (kind === "workbook" && !d.sheetName) out.push("Choose the sheet that holds the trial balance.");
  if (d.headerRow === null) out.push("Choose the row with the column headers.");
  if (!d.columns.accountCode && !d.columns.accountName) out.push("Choose the account code column, the account name column, or both.");
  if (!!d.columns.debit !== !!d.columns.credit) out.push("Choose Debit and Credit together.");
  if (!(d.columns.debit && d.columns.credit) && !d.columns.balance) out.push("Choose Debit and Credit columns, or a single Balance column.");
  const used = [...Object.values(d.columns), ...d.dimensions].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  if (new Set(used).size !== used.length) out.push("Each column of the file can have only one role.");
  if (!d.numberFormat) out.push("Choose how amounts are written (the number format).");
  if (balanceOnly(d) && !d.balanceSign) out.push("Say whether a positive balance is a debit or a credit.");
  return out;
}

/** The layout the draft describes, or null while it is incomplete. */
export function toProfile(d: LayoutDraft, kind: "csv" | "workbook"): LayoutProfile | null {
  if (draftProblems(d, kind).length > 0) return null;
  return {
    format: "layout-template/1",
    sheet: kind === "csv" ? { kind: "csv" } : { kind: "sheet", name: d.sheetName as string },
    headerRow: d.headerRow as number,
    columns: { ...d.columns, dimensions: [...d.dimensions] },
    numberFormat: d.numberFormat as NumberFormatId,
    balanceSign: balanceOnly(d) ? d.balanceSign : null,
  };
}

/** Plain words for a source row's disposition (never colour alone). */
export const DISPOSITION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  preamble: "Above the header", header: "Header", blank: "Blank", heading: "Heading (no amounts)", total: "Total row (checked, not imported)",
  zero_balance: "Zero balance", account: "Account", rejected: "Rejected",
});
