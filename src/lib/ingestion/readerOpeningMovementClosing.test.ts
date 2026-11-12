/**
 * S2-I02 (second-pass audit 2026-11-11): a header "Opening balance | Debit | Credit | Closing balance" made the reader drop
 * both balance columns and read the Debit and Credit columns — the period's MOVEMENTS — as the balances, and certify; the
 * only trace was a review-check notice nothing renders. A trial balance used for financial statements presents closing
 * balances at the reporting date; movement columns are not balances (a data-identity rule, not a recognition or
 * measurement change). Through the exact shared reader (_shared/tbSource.ts + tbIngestion.ts + layoutProfile.ts).
 * Expected figures are worked out by hand from each fixture (TZS, 2 decimals: 1.00 = 100 minor units).
 */
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { MilestoneLog, markIngestionMilestones, type IngestResult } from "../../../supabase/functions/_shared/tbIngestion";
import { readTrialBalanceSource, readTrialBalanceSourceWithLayout, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";
import { LAYOUT_TEMPLATE_FORMAT, profileSha256, type LayoutProfile } from "../../../supabase/functions/_shared/layoutProfile";

const xlsx = XLSX as unknown as XlsxLike;
const ctx = (fileName: string) => ({ fileName, periodYear: 2025, currency: "TZS" });
const codes = (r: IngestResult) => r.issues.map((i) => i.code);
const accounts = (r: IngestResult) => r.accounts.map((a) => [a.accountCode, a.debitMinor, a.creditMinor]);
const enc = (s: string) => new TextEncoder().encode(s);
const lineage = (r: IngestResult) => r.lineage.map((l) => [l.rowNumber, l.disposition]);
function workbook(rows: unknown[][]): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "TB");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

// ── I-2 fixture ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Opening + movements = closing on every row: 1000 500,000 + 120,000 = 620,000; 1100 200,000 − 50,000 = 150,000;
// 3000 −700,000 (no movement); 4000 0 − 70,000 = −70,000. Each column sums to zero (opening, movements, closing).
const TRIAD = [
  "Account Code,Account Name,Opening balance,Debit,Credit,Closing balance",
  "1000,Cash at bank,500000.00,120000.00,,620000.00",
  "1100,Trade receivables,200000.00,,50000.00,150000.00",
  "3000,Share capital,-700000.00,,,-700000.00",
  "4000,Sales,,,70000.00,-70000.00",
].join("\n") + "\n";
// The probe file of the audit (ingestion_architecture.md N-03).
const PROBE_TRIAD = "Account Code,Account Name,Opening balance,Debit,Credit,Closing balance\n1000,Cash,500.00,100.00,,600.00\n2000,Loan,-500.00,,100.00,-600.00\n";
const closingLayout = (sign: "debit_positive" | "credit_positive" = "debit_positive"): LayoutProfile => ({
  format: LAYOUT_TEMPLATE_FORMAT, sheet: { kind: "csv" }, headerRow: 1, numberFormat: "comma_dot", balanceSign: sign,
  columns: { accountCode: "Account Code", accountName: "Account Name", debit: null, credit: null, balance: "Closing balance", dimensions: [] },
});

describe("I-2: opening, movement and closing columns (S2-I02)", () => {
  it("is refused on the automatic reading: the Debit and Credit movements are never certified as balances", () => {
    const r = readTrialBalanceSource(enc(TRIAD), ctx("tb.csv"), xlsx);
    // Before the fix (hand-worked): accounts 1000 Dr 12,000,000; 1100 Cr 5,000,000 (a debit-balance asset as a credit);
    // 4000 Cr 7,000,000; share capital (no movement) a zero balance; totals 12,000,000 = 12,000,000; no issue — certified.
    expect(r.blocking).toBe(true);
    expect(codes(r)).toEqual(["AMBIGUOUS_AMOUNT_COLUMNS"]);
    const issue = r.issues[0];
    expect(issue).toMatchObject({ severity: "blocking", field: "balance", rows: [1] });
    expect(issue.message).toContain("“Opening balance”");
    expect(issue.message).toContain("“Closing balance”");
    expect(issue.message).toMatch(/movements/);
    expect(issue.message).toMatch(/file layout/i);
    expect(r.accounts).toEqual([]);
    expect(r.totals).toBeNull();
    // The movement columns are not offered as the trial balance's Debit and Credit (the layout editor starts from this).
    expect(r.columns).toEqual({ account_code: "Account Code", account_name: "Account Name" });
    const log = new MilestoneLog();
    markIngestionMilestones(log, r);
    expect(log.list().find((m) => m.id === "columns")?.status).toBe("failed");
  });

  it("the audit's probe file is refused the same way", () => {
    const r = readTrialBalanceSource(enc(PROBE_TRIAD), ctx("tb.csv"), xlsx);
    expect(codes(r)).toEqual(["AMBIGUOUS_AMOUNT_COLUMNS"]);
    expect(r.accounts).toEqual([]);
  });

  it("is refused as a workbook too", () => {
    const rows = TRIAD.trim().split("\n").map((l, row) => l.split(",").map((c, i) => (c === "" ? null : row > 0 && i >= 2 ? Number(c) : c)));
    const r = readTrialBalanceSource(workbook(rows), ctx("tb.xlsx"), xlsx);
    expect(codes(r)).toEqual(["AMBIGUOUS_AMOUNT_COLUMNS"]);
  });

  it("certifies on the closing balances once a layout names “Closing balance” as the Balance column", async () => {
    const p = closingLayout();
    const { result, resolved } = readTrialBalanceSourceWithLayout(enc(TRIAD), ctx("tb.csv"), xlsx, p, await profileSha256(p));
    expect(resolved).not.toBeNull();
    expect(result.blocking).toBe(false);
    // Hand-worked closing balances: Dr 620,000.00 + 150,000.00 = 770,000.00; Cr 700,000.00 + 70,000.00 = 770,000.00.
    expect(accounts(result)).toEqual([["1000", 62000000n, 0n], ["1100", 15000000n, 0n], ["3000", 0n, 70000000n], ["4000", 0n, 7000000n]]);
    expect(result.totals).toEqual({ debitMinor: 77000000n, creditMinor: 77000000n, differenceMinor: 0n });
    expect(lineage(result)).toEqual([[1, "header"], [2, "account"], [3, "account"], [4, "account"], [5, "account"]]);

    const probe = readTrialBalanceSourceWithLayout(enc(PROBE_TRIAD), ctx("tb.csv"), xlsx, p, await profileSha256(p));
    // 600.00 Dr cash and 600.00 Cr loan (the closing balances), not the 100.00 movements.
    expect(accounts(probe.result)).toEqual([["1000", 60000n, 0n], ["2000", 0n, 60000n]]);
  });

  it("refuses Debit and Credit beside any two balance columns (for example two years), naming them", () => {
    const r = readTrialBalanceSource(enc("Code,Account Name,Debit,Credit,Balance 2025,Balance 2024\n1000,Cash,10.00,,10.00,8.00\n2000,Loan,,10.00,-10.00,-8.00\n"), ctx("tb.csv"), xlsx);
    expect(codes(r)).toEqual(["AMBIGUOUS_AMOUNT_COLUMNS"]);
    expect(r.issues[0].message).toContain("“Balance 2025”, “Balance 2024”");
  });
});

describe("I-2 regression: the normal layouts read exactly as before", () => {
  it("Debit and Credit only", () => {
    const r = readTrialBalanceSource(enc("Account Code,Account Name,Debit,Credit\n1000,Cash at bank,620000.00,\n3000,Share capital,,620000.00\n"), ctx("tb.csv"), xlsx);
    expect(r.blocking).toBe(false);
    expect(r.columns).toEqual({ account_code: "Account Code", account_name: "Account Name", debit: "Debit", credit: "Credit" });
    expect(accounts(r)).toEqual([["1000", 62000000n, 0n], ["3000", 0n, 62000000n]]);
  });

  it("a single Balance column", () => {
    const r = readTrialBalanceSource(enc("Account Code,Account Name,Balance\n1000,Cash at bank,620000.00\n3000,Share capital,-620000.00\n"), ctx("tb.csv"), xlsx);
    expect(r.blocking).toBe(false);
    expect(r.columns).toEqual({ account_code: "Account Code", account_name: "Account Name", balance: "Balance" });
    expect(accounts(r)).toEqual([["1000", 62000000n, 0n], ["3000", 0n, 62000000n]]);
  });

  it("Debit and Credit with one Balance column still cross-checks it (agreeing: read; contradicting: refused as before)", () => {
    const agree = readTrialBalanceSource(enc("Account Code,Account Name,Debit,Credit,Balance\n1000,Cash,620000.00,,620000.00\n3000,Capital,,620000.00,-620000.00\n"), ctx("tb.csv"), xlsx);
    expect(agree.blocking).toBe(false);
    expect(accounts(agree)).toEqual([["1000", 62000000n, 0n], ["3000", 0n, 62000000n]]);
    const contradict = readTrialBalanceSource(enc("Account Code,Account Name,Debit,Credit,Closing balance\n1000,Cash,120000.00,,620000.00\n3000,Capital,,120000.00,-620000.00\n"), ctx("tb.csv"), xlsx);
    expect(codes(contradict)).toEqual(["BALANCE_COLUMN_MISMATCH"]);
  });

  it("Opening and Closing balance columns without Debit and Credit read the closing balance, as before", () => {
    const r = readTrialBalanceSource(enc("Account Code,Account Name,Opening Balance,Closing Balance\n1000,Cash,10,100\n2000,Payables,-10,-100\n"), ctx("tb.csv"), xlsx);
    expect(r.blocking).toBe(false);
    expect(r.columns.balance).toBe("Closing Balance");
    expect(accounts(r)).toEqual([["1000", 10000n, 0n], ["2000", 0n, 10000n]]);
  });
});
