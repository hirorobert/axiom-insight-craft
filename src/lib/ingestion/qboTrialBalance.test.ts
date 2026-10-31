import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";
import { formatMinor, normalisedAccountingResult, parseMinor, parseQboTrialBalanceReport, toCanonicalCsv } from "../../../supabase/functions/_shared/qboTrialBalance";

// The fixtures are Intuit's own sandbox company (invented data, US/USD); see __fixtures__/qbo/README.md.
const DIR = path.resolve(__dirname, "__fixtures__/qbo");
const JSON_TEXT = fs.readFileSync(path.join(DIR, "qbo-sandbox-trial-balance.json"), "utf8");
const XLSX_BYTES = new Uint8Array(fs.readFileSync(path.join(DIR, "qbo-sandbox-trial-balance.xlsx")));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mutable = any;
const sandbox = (): Mutable => JSON.parse(JSON_TEXT);
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const ctx = (fileName: string) => ({ fileName, periodYear: 2026, currency: "USD" });
const readFile = (bytes: Uint8Array, name: string) => readTrialBalanceSource(bytes, ctx(name), XLSX as unknown as XlsxLike);
const csvBytes = (csv: string) => new TextEncoder().encode(csv);
const must = (input: unknown) => {
  const r = parseQboTrialBalanceReport(input);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.report;
};
const refusalOf = (mutate: (j: Mutable) => void) => {
  const j = sandbox();
  mutate(j);
  const r = parseQboTrialBalanceReport(j);
  return r.ok ? "ACCEPTED" : r.code;
};

describe("QuickBooks Online trial balance report: conversion", () => {
  it("reads the recorded sandbox report: 46 accounts, USD, the period it states, balanced, with the control total checked", () => {
    const rep = must(sandbox());
    expect(rep.rows).toHaveLength(46);
    expect(rep).toMatchObject({ currency: "USD", basis: "Accrual", startPeriod: "2026-10-01", endPeriod: "2026-10-31" });
    expect(rep.totals).toEqual({ debitMinor: 4142160n, creditMinor: 4142160n });
  });

  it("keeps QuickBooks's own account ids (provenance), one per account, and does not write them into the file", () => {
    const rep = must(sandbox());
    expect(new Set(rep.rows.map((r) => r.sourceAccountId)).size).toBe(46);
    expect(rep.rows[0]).toMatchObject({ sourceAccountId: "35", accountName: "Checking" });
    const csv = toCanonicalCsv(rep);
    expect(csv.split("\n")[0]).toBe("Account Name,Debit,Credit");
    expect(csv).not.toMatch(/\bid\b/i);
  });

  it("writes plain decimals, blank for an empty side, and quotes a name that contains a comma or a quote", () => {
    const rep = must(sandbox());
    const csv = toCanonicalCsv(rep);
    expect(csv).toContain("Checking,1201.00,\n");
    expect(csv).toContain("Accounts Payable (A/P),,1602.67\n");
    const quoted = toCanonicalCsv({
      ...rep,
      rows: [
        { sourceAccountId: "1", accountName: 'Rent, "HQ"', debitMinor: 100n, creditMinor: 0n },
        { sourceAccountId: "2", accountName: "Capital", debitMinor: 0n, creditMinor: 100n },
      ],
    });
    expect(quoted).toContain('"Rent, ""HQ""",1.00,\n');
  });

  it("the converted file passes the same reader as any upload: not blocked, balanced, totals equal the report", () => {
    const r = readFile(csvBytes(toCanonicalCsv(must(sandbox()))), "qbo-trial-balance.csv");
    expect(r.blocking).toBe(false);
    expect(r.totals).toEqual({ debitMinor: 4142160n, creditMinor: 4142160n, differenceMinor: 0n });
    expect(r.columns).toMatchObject({ account_name: "Account Name", debit: "Debit", credit: "Credit" });
  });
});

describe("charter A2 parity: the same company through the connector path and through a manual Excel export", () => {
  const viaConnector = () => readFile(csvBytes(toCanonicalCsv(must(sandbox()))), "qbo-trial-balance.csv");
  const viaExcel = () => readFile(XLSX_BYTES, "qbo-sandbox-trial-balance.xlsx");

  it("both read, neither is blocked, and both have the same accounts and totals", () => {
    const a = viaConnector();
    const b = viaExcel();
    expect(a.blocking).toBe(false);
    expect(b.blocking).toBe(false);
    expect(a.accounts).toHaveLength(b.accounts.length);
    expect(a.totals).toEqual(b.totals);
  });

  it("the normalised accounting result is identical, so its hash is identical; only the provenance (raw bytes) differs", () => {
    const a = normalisedAccountingResult(viaConnector().accounts);
    const b = normalisedAccountingResult(viaExcel().accounts);
    expect(a).toBe(b);
    expect(sha(a)).toBe(sha(b));
    expect(sha(JSON_TEXT)).not.toBe(sha(Buffer.from(XLSX_BYTES).toString("latin1")));
  });

  it("negative control: one cent moved on both sides of one pair of accounts gives a different result and hash", () => {
    const j = sandbox();
    j.Rows.Row[0].ColData[1].value = "1201.01"; // Checking debit +0.01
    j.Rows.Row[6].ColData[2].value = "1602.68"; // Accounts Payable credit +0.01
    j.Rows.Row.at(-1).Summary.ColData[1].value = "41421.61";
    j.Rows.Row.at(-1).Summary.ColData[2].value = "41421.61";
    const a = normalisedAccountingResult(readFile(csvBytes(toCanonicalCsv(must(j))), "x.csv").accounts);
    const b = normalisedAccountingResult(viaExcel().accounts);
    expect(a).not.toBe(b);
    expect(sha(a)).not.toBe(sha(b));
  });
});

describe("a response that is not exactly the recorded shape is refused, never repaired", () => {
  it.each<[string, (j: Mutable) => void, string]>([
    ["not an object", (j) => { for (const k of Object.keys(j)) delete j[k]; }, "NOT_A_REPORT"],
    ["another report", (j) => { j.Header.ReportName = "ProfitAndLoss"; }, "WRONG_REPORT"],
    ["the French variant", (j) => { j.Header.ReportName = "TrialBalanceFR"; }, "WRONG_REPORT"],
    ["no report data", (j) => { j.Header.Option[0].Value = "true"; }, "NO_REPORT_DATA"],
    ["columns summarised by month", (j) => { j.Header.SummarizeColumnsBy = "Month"; }, "SUMMARISED_COLUMNS"],
    ["no currency", (j) => { delete j.Header.Currency; }, "MISSING_CURRENCY"],
    ["lower-case currency", (j) => { j.Header.Currency = "usd"; }, "MISSING_CURRENCY"],
    ["an impossible date", (j) => { j.Header.EndPeriod = "2026-13-45"; }, "BAD_PERIOD"],
    ["start after end", (j) => { j.Header.StartPeriod = "2026-11-01"; }, "BAD_PERIOD"],
    ["an extra column", (j) => { j.Columns.Column.push({ ColTitle: "Note", ColType: "String" }); }, "UNEXPECTED_COLUMNS"],
    ["columns swapped", (j) => { j.Columns.Column.reverse(); }, "UNEXPECTED_COLUMNS"],
    ["a nested section", (j) => { j.Rows.Row[3] = { type: "Section", group: "Assets", Rows: { Row: [] } }; }, "UNSUPPORTED_STRUCTURE"],
    ["a row with two cells", (j) => { j.Rows.Row[1].ColData.pop(); }, "UNSUPPORTED_STRUCTURE"],
    ["the grand total not last", (j) => { const t = j.Rows.Row.pop(); j.Rows.Row.unshift(t); }, "UNSUPPORTED_STRUCTURE"],
    ["a blank account name", (j) => { j.Rows.Row[2].ColData[0].value = "  "; }, "MISSING_ACCOUNT_NAME"],
    ["a missing account id", (j) => { delete j.Rows.Row[2].ColData[0].id; }, "MISSING_ACCOUNT_ID"],
    ["a repeated account id", (j) => { j.Rows.Row[3].ColData[0].id = "35"; }, "DUPLICATE_ACCOUNT_ID"],
    ["a negative amount", (j) => { j.Rows.Row[0].ColData[1].value = "-1201.00"; }, "BAD_AMOUNT"],
    ["a thousands separator", (j) => { j.Rows.Row[0].ColData[1].value = "1,201.00"; }, "BAD_AMOUNT"],
    ["three decimals", (j) => { j.Rows.Row[0].ColData[1].value = "1201.005"; }, "BAD_AMOUNT"],
    ["an exponent", (j) => { j.Rows.Row[0].ColData[1].value = "1.2e3"; }, "BAD_AMOUNT"],
    ["both sides on one account", (j) => { j.Rows.Row[0].ColData[2].value = "5.00"; }, "BOTH_SIDES"],
    ["no grand total", (j) => { j.Rows.Row.pop(); }, "NO_CONTROL_TOTAL"],
    ["a grand total that disagrees", (j) => { j.Rows.Row.at(-1).Summary.ColData[1].value = "41421.61"; }, "CONTROL_TOTAL_MISMATCH"],
    ["rows that do not balance (the total agrees with them)", (j) => {
      j.Rows.Row[0].ColData[1].value = "1202.00";
      j.Rows.Row.at(-1).Summary.ColData[1].value = "41422.60";
    }, "UNBALANCED"],
  ])("%s -> %s", (_label, mutate, code) => {
    expect(refusalOf(mutate)).toBe(code);
  });

  it("the unchanged recorded report is accepted (the table above refuses each change on its own)", () => {
    expect(refusalOf(() => {})).toBe("ACCEPTED");
  });
});

describe("amounts are exact integers of minor units", () => {
  it("parses plain decimals and nothing else", () => {
    expect(parseMinor("")).toBe(0n);
    expect(parseMinor("0")).toBe(0n);
    expect(parseMinor("12")).toBe(1200n);
    expect(parseMinor("12.5")).toBe(1250n);
    expect(parseMinor("12.05")).toBe(1205n);
    expect(parseMinor("9007199254740993.01")).toBe(900719925474099301n); // beyond float precision, still exact
    for (const bad of ["-1", "+1", "1.", ".5", "1,000", "1.234", " 1", "1e2", "NaN", null, 5, undefined]) expect(parseMinor(bad as unknown)).toBeNull();
  });
  it("formats back to two decimals", () => {
    expect(formatMinor(0n)).toBe("0.00");
    expect(formatMinor(5n)).toBe("0.05");
    expect(formatMinor(900719925474099301n)).toBe("9007199254740993.01");
  });
});
