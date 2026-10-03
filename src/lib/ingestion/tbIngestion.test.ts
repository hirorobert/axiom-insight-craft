/**
 * The trial-balance ingestion core (supabase/functions/_shared/tbIngestion.ts + tbSource.ts) — the exact code the
 * process-trial-balance edge function runs on an uploaded file. Representative sanitized files live in __fixtures__;
 * workbooks are built here with the same SheetJS version the edge function uses (0.18.5).
 */
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import {
  MilestoneLog, classificationNeedsReview, currencyExponent, decodeCsvBytes, formatMinor, ingestTrialBalance,
  markIngestionMilestones, minorToNumber, parseAmount, parseCsvText, type IngestResult,
} from "../../../supabase/functions/_shared/tbIngestion";
import { readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";

const FIX = path.join(__dirname, "__fixtures__");
const xlsx = XLSX as unknown as XlsxLike;
const enc = (s: string) => new TextEncoder().encode(s);
const ctx = (fileName: string, over: Partial<{ periodYear: number | null; currency: string | null }> = {}) => ({ fileName, periodYear: 2025, currency: "TZS", ...over });
const readCsv = (text: string, over = {}) => readTrialBalanceSource(enc(text), ctx("tb.csv", over), xlsx);
const readFixture = (name: string, over = {}) => readTrialBalanceSource(new Uint8Array(fs.readFileSync(path.join(FIX, name))), ctx(name, over), xlsx);
const codes = (r: IngestResult) => r.issues.map((i) => i.code);
function workbook(sheets: Record<string, unknown[][]>): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}
const readXlsx = (sheets: Record<string, unknown[][]>, over = {}) => readTrialBalanceSource(workbook(sheets), ctx("tb.xlsx", over), xlsx);
const lineageAddsUp = (r: IngestResult) => {
  const s = r.lineageSummary;
  return s.preamble + s.header + s.blank + s.heading + s.total + s.zero_balance + s.account + s.rejected === s.rowsRead;
};

describe("exact monetary arithmetic", () => {
  it("parses amounts into exact minor units at the currency's exponent", () => {
    expect(parseAmount("1,234.56", 2)).toEqual({ kind: "amount", minor: 123456n });
    expect(parseAmount("1 234 567.5", 2)).toEqual({ kind: "amount", minor: 123456750n });
    expect(parseAmount("(950,000.50)", 2)).toEqual({ kind: "amount", minor: -95000050n });
    expect(parseAmount("-12", 0)).toEqual({ kind: "amount", minor: -12n });
    expect(parseAmount("1.500", 2)).toEqual({ kind: "amount", minor: 150n });
    expect(parseAmount(0.1 + 0.2, 2)).toEqual({ kind: "amount", minor: 30n }); // float noise from a formula cell
    expect(parseAmount(1234.56, 2)).toEqual({ kind: "amount", minor: 123456n });
  });

  it("treats empty and dash-only cells as no posting, and refuses anything else that is not a number", () => {
    for (const blank of [null, undefined, "", "  ", "-", "–", "—"]) expect(parseAmount(blank, 2)).toEqual({ kind: "blank" });
    for (const bad of ["12abc", "1,2,3", "$100", "TZS 100", "1.234,56", "N/A", "=SUM(B2:B9)", "--5", "(-5)", "1e5", true]) {
      expect(parseAmount(bad as never, 2).kind, String(bad)).toBe("malformed");
    }
  });

  it("refuses more decimals than the currency allows instead of rounding, and refuses amounts too large to be exact", () => {
    expect(parseAmount("10.005", 2)).toMatchObject({ kind: "precision", decimals: 3 });
    expect(parseAmount("10.5", 0)).toMatchObject({ kind: "precision", decimals: 1 });
    expect(parseAmount("1.0005", 3)).toMatchObject({ kind: "precision" });
    expect(parseAmount("99999999999999999", 2)).toMatchObject({ kind: "range" });
    expect(parseAmount(1e-9, 2)).toMatchObject({ kind: "precision" });
  });

  it("formats and converts exactly", () => {
    expect(formatMinor(-123456n, 2)).toBe("-1234.56");
    expect(formatMinor(5n, 3)).toBe("0.005");
    expect(formatMinor(7n, 0)).toBe("7");
    expect(minorToNumber(123456n, 2)).toBe(1234.56);
    expect(minorToNumber(30n, 2)).toBe(0.3);
  });

  it("balances to the last minor unit — a one-cent difference is refused (no tolerance)", () => {
    const r = readCsv("Code,Name,Debit,Credit\n1,Cash,100.01,\n2,Capital,,100.00\n");
    expect(codes(r)).toEqual(["TRIAL_BALANCE_IMBALANCE"]);
    expect(r.issues[0].message).toContain("the difference is 0.01");
  });

  it("a thousand 0.10 debits against one 100.00 credit balance exactly (float summation would drift)", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `${1000 + i},Item ${i},0.10,`);
    const r = readCsv(`Code,Name,Debit,Credit\n${lines.join("\n")}\n9999,Capital,,100.00\n`);
    expect(r.blocking).toBe(false);
    expect(r.totals).toEqual({ debitMinor: 10000n, creditMinor: 10000n, differenceMinor: 0n });
  });
});

describe("currency precision and period selection are explicit — never defaulted", () => {
  it("knows ISO 4217 exponents and refuses unknown currencies", () => {
    expect(currencyExponent("tzs")).toBe(2);
    expect(currencyExponent("UGX")).toBe(0);
    expect(currencyExponent("BHD")).toBe(3);
    expect(currencyExponent("XYZ")).toBeNull();
    expect(codes(readCsv("Code,Name,Debit,Credit\n1,Cash,1,\n2,Cap,,1\n", { currency: "XYZ" }))).toEqual(["CURRENCY_UNSUPPORTED"]);
  });

  it("refuses processing without a selected period or a reporting currency", () => {
    expect(codes(readCsv("Code,Name,Debit,Credit\n1,Cash,1,\n2,Cap,,1\n", { periodYear: null }))).toEqual(["PERIOD_NOT_SELECTED"]);
    expect(codes(readCsv("Code,Name,Debit,Credit\n1,Cash,1,\n2,Cap,,1\n", { currency: null }))).toEqual(["CURRENCY_UNRESOLVED"]);
  });

  it("UGX has no minor unit: 10.50 is refused, 10 is fine", () => {
    expect(codes(readCsv("Code,Name,Debit,Credit\n1,Cash,10.50,\n2,Cap,,10.50\n", { currency: "UGX" }))).toEqual(["PRECISION_EXCEEDS_CURRENCY"]);
    expect(readCsv("Code,Name,Debit,Credit\n1,Cash,10,\n2,Cap,,10\n", { currency: "UGX" }).blocking).toBe(false);
  });

  it("refuses a file whose heading names only another year, and accepts one naming the selected year or none", () => {
    const r = readCsv("Trial balance for the year ended 31 December 2024\nCode,Name,Debit,Credit\n1,Cash,1,\n2,Cap,,1\n");
    expect(codes(r)).toEqual(["PERIOD_MISMATCH"]);
    expect(r.issues[0].rows).toEqual([1]);
    expect(readCsv("FY 2024/25 trial balance\nCode,Name,Debit,Credit\n1,Cash,1,\n2,Cap,,1\n").blocking).toBe(false);
    expect(readCsv("Code,Name,Debit,Credit\n1,Cash,1,\n2,Cap,,1\n").blocking).toBe(false);
    // A print date is not a period statement.
    expect(readCsv("Printed 2026-01-15\nCode,Name,Debit,Credit\n1,Cash,1,\n2,Cap,,1\n").blocking).toBe(false);
  });

  it("several amount columns are resolved only by the selected year; otherwise refused", () => {
    const twoYears = [["Code", "Name", "Debit 2025", "Credit 2025", "Debit 2024", "Credit 2024"], ["1", "Cash", 5, null, 9, null], ["2", "Cap", null, 5, null, 9]];
    const ok = readXlsx({ TB: twoYears });
    expect(ok.blocking).toBe(false);
    expect(ok.columns).toMatchObject({ debit: "Debit 2025", credit: "Credit 2025" });
    expect(ok.totals?.debitMinor).toBe(500n);
    expect(codes(readXlsx({ TB: twoYears }, { periodYear: 2023 }))).toEqual(["AMBIGUOUS_AMOUNT_COLUMNS", "AMBIGUOUS_AMOUNT_COLUMNS"]);
    expect(codes(readCsv("Code,Name,Debit,Credit,Debit,Credit\n1,Cash,1,,1,\n2,Cap,,1,,1\n"))).toContain("AMBIGUOUS_AMOUNT_COLUMNS");
  });

  it("refuses amounts labelled in a different currency", () => {
    expect(codes(readCsv("Code,Name,Debit (USD),Credit (USD)\n1,Cash,1,\n2,Cap,,1\n"))).toEqual(["CURRENCY_MISMATCH"]);
    expect(readCsv("Code,Name,Debit (TZS),Credit (TZS)\n1,Cash,1,\n2,Cap,,1\n").blocking).toBe(false);
  });
});

describe("account identity", () => {
  it("refuses a repeated account code — never merged, never last-row-wins", () => {
    const r = readCsv("Code,Name,Debit,Credit\n1000,Cash,10,\n1000,Cash at bank,5,\n3000,Capital,,15\n");
    expect(codes(r)).toEqual(["DUPLICATE_ACCOUNT_CODE"]);
    expect(r.issues[0].rows).toEqual([2, 3]);
  });

  it("without a code column, a repeated (normalised) account name is refused", () => {
    const r = readCsv("Account Name,Debit,Credit\nCash at bank,10,\nCASH AT BANK.,5,\nCapital,,15\n");
    expect(codes(r)).toEqual(["DUPLICATE_ACCOUNT_NAME"]);
  });

  it("in a coded file, a row with amounts but no code is refused (not keyed by its name)", () => {
    const r = readCsv("Code,Name,Debit,Credit\n1000,Cash,10,\n,Suspense,5,\n3000,Capital,,15\n");
    expect(codes(r)).toEqual(["MISSING_ACCOUNT_CODE"]);
    expect(r.issues[0].rows).toEqual([3]);
  });

  it("codes are distinct strings: 0100 and 100 are two accounts", () => {
    const r = readCsv("Code,Name,Debit,Credit\n0100,Cash,10,\n100,Bank,5,\n3000,Capital,,15\n");
    expect(r.blocking).toBe(false);
    expect(r.accounts.map((a) => a.identity)).toEqual(["code:0100", "code:100", "code:3000"]);
  });
});

describe("subtotals and totals", () => {
  it("excludes code-less total rows, verifies the grand total, and keeps headings out of the accounts", () => {
    const r = readFixture("grouped-subtotals-fy2025.csv");
    expect(r.blocking).toBe(false);
    expect(r.accounts.map((a) => a.accountCode)).toEqual(["1000", "1100", "2000", "3000", "4000", "6000"]);
    expect(r.lineageSummary).toMatchObject({ rowsRead: 14, preamble: 1, header: 1, heading: 3, total: 3, account: 6 });
    expect(lineageAddsUp(r)).toBe(true);
  });

  it("a grand-total row that disagrees with the accounts above it is refused (a row is missing or hidden)", () => {
    const r = readCsv("Code,Name,Debit,Credit\n1,Cash,100,\n2,Capital,,100\n,Total,120,100\n");
    expect(codes(r)).toEqual(["TOTAL_ROW_MISMATCH"]);
    expect(r.issues[0].rows).toEqual([4]);
  });

  it("a row WITH a code is always an account even if it reads like a total; the imbalance message names it", () => {
    const r = readCsv("Code,Name,Debit,Credit\n1000,Cash,100,\n1001,Bank,50,\n1999,Total current assets,150,\n3000,Capital,,150\n");
    expect(r.accounts.map((a) => a.accountCode)).toContain("1999");
    expect(codes(r)).toEqual(["TRIAL_BALANCE_IMBALANCE"]);
    expect(r.issues[0].message).toMatch(/Rows 4 have account codes but read like totals/);
  });

  it("does not mistake real account names for totals (Sundry, Summit, Variance account with a code)", () => {
    const r = readCsv("Account Name,Debit,Credit\nSundry debtors,10,\nSummit lease,5,\nCapital,,15\n");
    expect(r.blocking).toBe(false);
    expect(r.accounts).toHaveLength(3);
  });
});

describe("complete source-row lineage", () => {
  it("the representative coded file: every row has one disposition and the counts add up to the rows read", () => {
    const r = readFixture("coded-fy2025.csv");
    expect(r.issues).toEqual([]);
    expect(r.lineageSummary).toMatchObject({ rowsRead: 25, preamble: 2, blank: 1, header: 1, account: 19, zero_balance: 1, total: 1, heading: 0 });
    expect(lineageAddsUp(r)).toBe(true);
    expect(r.totals).toEqual({ debitMinor: 8938550050n, creditMinor: 8938550050n, differenceMinor: 0n });
    // A quoted name with a comma is one cell; the source row number is the line in the file.
    const accruals = r.accounts.find((a) => a.accountCode === "2100")!;
    expect(accruals).toMatchObject({ accountName: "Accruals, other", sourceRowNumber: 12, creditMinor: 118000000n });
    expect(r.lineage.find((l) => l.rowNumber === 24)).toMatchObject({ disposition: "zero_balance" });
  });

  it("worksheet row numbers are spreadsheet rows, blank rows included, even when the sheet starts below row 1", () => {
    const ws = XLSX.utils.aoa_to_sheet([["Code", "Name", "Debit", "Credit"], ["1", "Cash", 5, null], [], ["2", "Capital", null, 5]], { origin: "B3" });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "TB");
    const r = readTrialBalanceSource(new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" })), ctx("tb.xlsx"), xlsx);
    expect(r.blocking).toBe(false);
    expect(r.accounts.map((a) => a.sourceRowNumber)).toEqual([4, 6]);
    expect(r.lineage.find((l) => l.rowNumber === 5)).toMatchObject({ disposition: "blank" });
    expect(r.sheetName).toBe("TB");
  });

  it("balance-only files: debits positive, credits negative, parentheses negative — and the balance check is real", () => {
    const r = readFixture("balance-only-fy2025.csv");
    expect(r.blocking).toBe(false);
    expect(r.totals).toEqual({ debitMinor: 745000050n, creditMinor: 745000050n, differenceMinor: 0n });
    // Previously a balance-only file always "balanced" (debit and credit were both zero). Now it does not:
    expect(codes(readCsv("Name,Balance\nCash,100\nCapital,-90\n"))).toEqual(["TRIAL_BALANCE_IMBALANCE"]);
  });
});

describe("source formats and template safety", () => {
  it("decodes UTF-8 with a BOM, CRLF line endings and quoted fields with doubled quotes and line breaks", () => {
    const text = "\uFEFFCode,Name,Debit,Credit\r\n1,\"Cash \"\"main\"\"\r\naccount\",10,\r\n2,Capital,,10\r\n";
    const r = readCsv(text);
    expect(r.blocking).toBe(false);
    expect(r.columns.account_code).toBe("Code");
    expect(r.accounts[0]).toMatchObject({ accountName: "Cash \"main\"\r\naccount", sourceRowNumber: 2 });
    expect(r.accounts[1].sourceRowNumber).toBe(4);
  });

  it("refuses non-UTF-8 and UTF-16 text instead of decoding it with replacement characters", () => {
    expect(decodeCsvBytes(new Uint8Array([0x43, 0x61, 0x73, 0x68, 0xe9, 0x0a])).ok).toBe(false);
    expect(decodeCsvBytes(new Uint8Array([0xff, 0xfe, 0x43, 0x00])).ok).toBe(false);
    expect(codes(readTrialBalanceSource(new Uint8Array([0x43, 0xe9, 0x0a]), ctx("tb.csv"), xlsx))).toEqual(["ENCODING_NOT_UTF8"]);
  });

  it("an unterminated quote names its row; semicolon and tab files are read", () => {
    const bad = parseCsvText("Code,Name\n1,\"Cash\n");
    expect(bad.ok).toBe(false);
    expect(readCsv("Code;Name;Debit;Credit\n1;Cash;10;\n2;Capital;;10\n").blocking).toBe(false);
    expect(readCsv("Code\tName\tDebit\tCredit\n1\tCash\t10\t\n2\tCapital\t\t10\n").blocking).toBe(false);
  });

  it("refuses the unedited example file, unsupported formats and empty files", () => {
    expect(codes(readCsv("Code,Name,Debit,Credit\n1000,Example — Cash at bank,10,\n3000,Example — Capital,,10\n"))).toEqual(["TEMPLATE_EXAMPLE_UPLOADED"]);
    expect(codes(readTrialBalanceSource(enc("x"), ctx("tb.pdf"), xlsx))).toEqual(["UNSUPPORTED_FORMAT"]);
    expect(codes(readCsv(""))).toEqual(["FILE_EMPTY"]);
    expect(codes(readCsv("Code,Name,Debit,Credit\n"))).toEqual(["NO_ACCOUNT_ROWS"]);
    expect(codes(readCsv("Foo,Bar\n1,2\n"))).toEqual(["MISSING_COLUMN"]);
  });

  it("a workbook with several trial-balance sheets is refused; one TB sheet beside a notes sheet is chosen", () => {
    const tb = [["Code", "Name", "Debit", "Credit"], ["1", "Cash", 5, null], ["2", "Cap", null, 5]];
    expect(codes(readXlsx({ "TB 2025": tb, "TB 2024": tb }))).toEqual(["MULTIPLE_TRIAL_BALANCE_SHEETS"]);
    const chosen = readXlsx({ Notes: [["Prepared by"], ["Finance team"], ["Reviewed"], ["Yes"], ["More"], ["Rows"]], TB: tb });
    expect(chosen.blocking).toBe(false);
    expect(chosen.sheetName).toBe("TB");
  });

  it("refuses a Balance column that contradicts Debit and Credit", () => {
    expect(codes(readCsv("Code,Name,Debit,Credit,Balance\n1,Cash,10,,10\n2,Cap,,10,-7\n"))).toEqual(["BALANCE_COLUMN_MISMATCH"]);
  });

  it("every malformed amount is reported with its row and value, and the balance check is not run on partial data", () => {
    const r = readCsv("Code,Name,Debit,Credit\n1,Cash,12abc,\n2,Bank,10.123,\n3,Cap,,1\n");
    expect(codes(r)).toEqual(["MALFORMED_NUMERIC_VALUE", "PRECISION_EXCEEDS_CURRENCY"]);
    expect(r.issues[0].message).toContain("row 2 debit “12abc”");
    expect(r.issues[1].rows).toEqual([3]);
  });
});

describe("classification review policy and milestones", () => {
  it("only this company's exact reviewed mapping stands without review", () => {
    expect(classificationNeedsReview(1, false)).toBe(false);
    expect(classificationNeedsReview(2, false)).toBe(false);
    expect(classificationNeedsReview(2, true)).toBe(true);
    for (const tier of [3, 4, 5] as const) expect(classificationNeedsReview(tier, false)).toBe(true);
  });

  it("milestones record exactly how far ingestion got", () => {
    const ok = new MilestoneLog();
    markIngestionMilestones(ok, readFixture("coded-fy2025.csv"));
    expect(ok.list().map((m) => m.status)).toEqual(["passed", "passed", "passed", "passed", "passed", "not_reached", "not_reached"]);
    expect(ok.list()[4].detail).toBe("89385500.50 = 89385500.50");

    const dup = new MilestoneLog();
    markIngestionMilestones(dup, readCsv("Code,Name,Debit,Credit\n1,Cash,1,\n1,Cash,1,\n2,Cap,,2\n"));
    expect(dup.list().map((m) => m.status)).toEqual(["passed", "passed", "failed", "not_reached", "not_reached", "not_reached", "not_reached"]);

    const noPeriod = new MilestoneLog();
    markIngestionMilestones(noPeriod, readCsv("Code,Name,Debit,Credit\n1,Cash,1,\n", { periodYear: null }));
    expect(noPeriod.list()[0].status).toBe("failed");
  });

  it("is deterministic: the same bytes give the same result", () => {
    const a = readFixture("coded-fy2025.csv");
    const b = readFixture("coded-fy2025.csv");
    expect(JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(JSON.stringify(b, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  });

  it("direct ingest without columns for the selected sheet still accounts for every row", () => {
    const r = ingestTrialBalance({ rows: [{ rowNumber: 1, cells: ["Name", "Balance"] }, { rowNumber: 2, cells: [] }, { rowNumber: 3, cells: ["Cash", "0"] }], sheetName: null, periodYear: 2025, currency: "TZS" });
    expect(codes(r)).toEqual(["NO_ACCOUNT_ROWS"]);
    expect(lineageAddsUp(r)).toBe(true);
  });
});
