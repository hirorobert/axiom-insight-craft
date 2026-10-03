/**
 * trialBalanceTemplate — the downloadable trial-balance files and the file contract shown beside the uploader. Pure.
 *
 *   · trial-balance-template.csv — the header row only. Nothing to delete before use.
 *   · trial-balance-example.csv — a small, balanced sample whose every account name starts with "Example —". Uploaded
 *     unchanged it is refused (TEMPLATE_EXAMPLE_UPLOADED), so sample figures can never become a client's trial balance.
 *
 * Both are the same for every workspace: no company name, year or other workspace data in the file or its name. Cells
 * that a spreadsheet would run as a formula (= + - @ and control characters) are neutralised. The rules in FILE_RULES
 * describe what the server's ingestion core (supabase/functions/_shared/tbIngestion.ts) actually does — they are tested
 * against it.
 */

export const TEMPLATE_FILE_NAME = "trial-balance-template.csv";
export const EXAMPLE_FILE_NAME = "trial-balance-example.csv";

export const TEMPLATE_HEADER: readonly string[] = ["Account Code", "Account Name", "Debit", "Credit"];

/** Balanced: debits 61,500,000.00 = credits 61,500,000.00. Neutral names; every one marked as an example. */
export const EXAMPLE_ROWS: readonly (readonly string[])[] = [
  ["1000", "Example — Cash at bank", "12500000.00", ""],
  ["1100", "Example — Trade receivables", "8400000.00", ""],
  ["1500", "Example — Office equipment", "11000000.00", ""],
  ["2000", "Example — Trade payables", "", "6200000.00"],
  ["2100", "Example — Accrued expenses", "", "1150000.00"],
  ["3000", "Example — Share capital", "", "20000000.00"],
  ["3100", "Example — Retained earnings", "", "6150000.00"],
  ["4000", "Example — Revenue", "", "28000000.00"],
  ["5000", "Example — Cost of sales", "19300000.00", ""],
  ["6000", "Example — Staff costs", "7040000.00", ""],
  ["6200", "Example — Rent", "3260000.00", ""],
];

/** A cell a spreadsheet would evaluate (= + - @, tab, CR) is prefixed with an apostrophe so it stays text. */
export function neutraliseCell(cell: string): string {
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
}

const BOM = String.fromCharCode(0xfeff);

export function toCsv(rows: readonly (readonly string[])[]): string {
  const line = (row: readonly string[]) =>
    row.map((raw) => {
      const cell = neutraliseCell(raw);
      return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
    }).join(",");
  // A UTF-8 byte-order mark so spreadsheet programs open the em dashes correctly (the importer removes it).
  return `${BOM}${rows.map(line).join("\r\n")}\r\n`;
}

export const templateCsv = (): string => toCsv([TEMPLATE_HEADER]);
export const exampleCsv = (): string => toCsv([TEMPLATE_HEADER, ...EXAMPLE_ROWS]);

export interface FieldSpec {
  column: string;
  requirement: "Required" | "Optional";
  rule: string;
  accepted: string;
}

export const FILE_FIELDS: readonly FieldSpec[] = [
  { column: "Account Code", requirement: "Required", rule: "Your ledger code, kept exactly as exported. Each code may appear once.", accepted: "Account Code · A/C No · GL Code · Code" },
  { column: "Account Name", requirement: "Required", rule: "The ledger description. Used to suggest a classification for your review.", accepted: "Account Name · Description · Particulars · Name" },
  { column: "Debit", requirement: "Required", rule: "Debit amount; leave blank (or “-”) when there is none. Numbers only — no currency symbols.", accepted: "Debit · Dr · Debit Amount" },
  { column: "Credit", requirement: "Required", rule: "Credit amount; leave blank (or “-”) when there is none. Numbers only.", accepted: "Credit · Cr · Credit Amount" },
  { column: "Balance", requirement: "Optional", rule: "Only if your export has no separate Debit and Credit columns: debits positive, credits negative, -1000 or (1000).", accepted: "Balance · Closing Balance · Amount" },
];

/** What the importer does — each line is enforced by the server's ingestion core. */
export const FILE_RULES: readonly string[] = [
  "One trial balance for the period you are working in. A file whose heading names only another year is refused.",
  "Amounts in the period's reporting currency, with no more decimal places than that currency has. Nothing is rounded.",
  "Debits must equal credits exactly — to the last cent.",
  "Total and subtotal rows without an account code are left out; a grand-total row must agree with the accounts above it.",
  "A row with an account code is always read as an account, never as a total.",
  "Group headings, blank rows and title rows are allowed. Use one header row and no merged cells.",
];
