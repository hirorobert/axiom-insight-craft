import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";

// The QuickBooks Desktop "export to Excel" trial balance has a layout the reader used to refuse: the account-name column has NO
// heading, and the last row's TOTAL label sits in another column (column A), not in the name column. The reader now accepts both,
// each only under strict conditions, and keeps every other safeguard (a wrong total or an unbalanced file still blocks).
// Every name and amount here is invented; the shape (date row, Debit/Credit row, Parent:Child names, empty spacer column,
// final TOTAL row) is what the real exports have.

const DATE_ROW = [null, null, "31 Dec 25"];
const HEAD = [null, null, "Debit", null, "Credit"];
const BODY = [
  [null, "ASSETS", 0, null, null],
  [null, "ASSETS:Cash at bank", 1000.5, null, null],
  [null, "ASSETS:Petty cash", 49.5, null, null],
  [null, "LIABILITIES:Trade payables", null, null, 400.1],
  [null, "EQUITY:Capital", null, null, 599.9],
  [null, "INCOME:Sales", null, null, 1000],
  [null, "EXPENSES:Rent", 450.25, null, null],
  [null, "EXPENSES:Salaries", 499.75, null, null],
];
const TOTAL = ["TOTAL", null, 2000, null, 2000];

function readSheet(rows: unknown[][], fileName = "synthetic.xlsx") {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[""]]), "QuickBooks Desktop Export Tips");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
  return readTrialBalanceSource(bytes, { fileName, periodYear: 2025, currency: "TZS" }, XLSX as unknown as XlsxLike);
}
const codes = (r: ReturnType<typeof readSheet>) => r.issues.map((i) => `${i.severity}:${i.code}`);
const standard = () => readSheet([DATE_ROW, HEAD, ...BODY, TOTAL]);

describe("QuickBooks Desktop export layout", () => {
  it("reads a heading-less name column and a TOTAL label outside it: not blocked, balanced, nothing missing", () => {
    const r = standard();
    expect(r.blocking).toBe(false);
    expect(r.issues).toEqual([]);
    expect(r.accounts.map((a) => a.accountName)).toEqual([
      "ASSETS:Cash at bank", "ASSETS:Petty cash", "LIABILITIES:Trade payables", "EQUITY:Capital", "INCOME:Sales", "EXPENSES:Rent", "EXPENSES:Salaries",
    ]);
    expect(r.totals).toEqual({ debitMinor: 200000n, creditMinor: 200000n, differenceMinor: 0n });
  });

  it("says plainly that the name column had no heading", () => {
    expect(standard().columns).toMatchObject({ debit: "Debit", credit: "Credit", account_name: "(unlabelled column B)" });
  });

  it("treats the final TOTAL row as a control total, never as an account, and records why", () => {
    const r = standard();
    expect(r.accounts.some((a) => /total/i.test(a.accountName))).toBe(false);
    const last = r.lineage[r.lineage.length - 1];
    expect(last.disposition).toBe("total");
    expect(last.reason).toMatch(/outside the name column/);
    expect(r.lineageSummary.rejected).toBe(0);
  });

  it("still checks the TOTAL row against the accounts: a total that is one cent out blocks", () => {
    const r = readSheet([DATE_ROW, HEAD, ...BODY, ["TOTAL", null, 2000.01, null, 2000]]);
    expect(r.blocking).toBe(true);
    expect(codes(r)).toContain("blocking:TOTAL_ROW_MISMATCH");
  });

  it("still blocks an unbalanced trial balance whose TOTAL row agrees with its accounts, and says so as an imbalance", () => {
    const body = BODY.map((row) => (row[1] === "INCOME:Sales" ? [null, "INCOME:Sales", null, null, 913.6] : row)); // credits now 1913.60
    const r = readSheet([DATE_ROW, HEAD, ...body, ["TOTAL", null, 2000, null, 1913.6]]);
    expect(r.blocking).toBe(true);
    expect(codes(r)).toContain("blocking:TRIAL_BALANCE_IMBALANCE");
    expect(codes(r)).not.toContain("blocking:TOTAL_ROW_MISMATCH");
    expect(r.totals?.differenceMinor).toBe(8640n);
  });

  it("does not guess when two heading-less columns both hold text: the file stays refused", () => {
    const notes = ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"];
    const body = BODY.map((row, i) => [notes[i], ...row.slice(1)]);
    const r = readSheet([DATE_ROW, HEAD, ...body, TOTAL]);
    expect(r.blocking).toBe(true);
    expect(codes(r)).toContain("blocking:MISSING_COLUMN");
    expect(r.columns.account_name).toBeUndefined();
  });

  it("does not take a heading-less column that is mostly numbers for the account name", () => {
    const body = BODY.map((row, i) => [null, i + 1, ...row.slice(2)]);
    const r = readSheet([DATE_ROW, HEAD, ...body, TOTAL]);
    expect(r.blocking).toBe(true);
    expect(codes(r)).toContain("blocking:MISSING_COLUMN");
  });

  it("accepts a TOTAL label outside the name column only on the LAST row: in the middle it is still refused", () => {
    const middle = [...BODY.slice(0, 5), TOTAL, ...BODY.slice(5)];
    const r = readSheet([DATE_ROW, HEAD, ...middle]);
    expect(r.blocking).toBe(true);
    expect(codes(r)).toContain("blocking:MISSING_ACCOUNT_CODE");
  });

  it("does not accept any other text outside the name column as a total label", () => {
    const r = readSheet([DATE_ROW, HEAD, ...BODY, ["Prepared by A. Clerk", null, 2000, null, 2000]]);
    expect(r.blocking).toBe(true);
    expect(codes(r)).toContain("blocking:MISSING_ACCOUNT_CODE");
  });

  it("is unchanged for a file whose name column HAS a heading", () => {
    const r = readSheet([DATE_ROW, [null, "Account Name", "Debit", null, "Credit"], ...BODY, [null, "TOTAL", 2000, null, 2000]]);
    expect(r.blocking).toBe(false);
    expect(r.columns.account_name).toBe("Account Name");
    expect(r.accounts).toHaveLength(7);
  });

  it("reads the same layout exported as CSV", () => {
    const line = (cells: unknown[]) => cells.map((c) => (c === null ? "" : String(c))).join(",");
    const csv = [DATE_ROW, HEAD, ...BODY, TOTAL].map(line).join("\n");
    const r = readTrialBalanceSource(new TextEncoder().encode(csv), { fileName: "synthetic.csv", periodYear: 2025, currency: "TZS" }, XLSX as unknown as XlsxLike);
    expect(r.blocking).toBe(false);
    expect(r.accounts).toHaveLength(7);
    expect(r.totals?.differenceMinor).toBe(0n);
  });
});
