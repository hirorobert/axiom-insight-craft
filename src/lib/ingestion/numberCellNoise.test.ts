import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseAmount } from "../../../supabase/functions/_shared/tbIngestion";
import { readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";

// QuickBooks Online writes arithmetic noise into some Excel number cells (812.429999999999 for 812.43), still inside Excel's 15
// significant digits. A NUMBER cell whose digits beyond the currency's decimals are 000000… or 999999… is within a millionth of a
// minor unit of a whole minor unit and is read as that unit; every other excess digit, and every TEXT cell, is still refused.

describe("number-cell noise (parseAmount)", () => {
  it.each<[string, number, number, bigint]>([
    ["QuickBooks AU credit", 812.429999999999, 2, 81243n],
    ["QuickBooks CA debit", 23.2299999999996, 2, 2323n],
    ["noise above a cent boundary", 812.4300000000001, 2, 81243n],
    ["noise just above whole units", 100.00000000001, 2, 10000n],
    ["noise just below whole units", 99.99999999999, 2, 10000n],
    ["a zero-decimal currency", 1234.9999999999, 0, 1235n],
    ["negative values round by magnitude", -812.429999999999, 2, -81243n],
    ["a clean value is unchanged", 812.43, 2, 81243n],
    ["a clean whole value is unchanged", 5281.52, 2, 528152n],
    ["the 17-digit noise the 15-digit rule already cleaned", 5281.5199999999995, 2, 528152n],
  ])("accepts %s", (_l, cell, exp, minor) => {
    expect(parseAmount(cell, exp)).toEqual({ kind: "amount", minor });
  });

  it("does not touch amounts near zero: a tiny value is still refused (a separate rule, pinned by the characterization corpus)", () => {
    expect(parseAmount(1e-9, 2).kind).toBe("precision");
    expect(parseAmount(1.1e-13, 2).kind).toBe("precision");
    expect(parseAmount(0.000001, 2).kind).toBe("precision");
  });

  it.each<[string, number, number]>([
    ["a genuine third decimal", 12.345, 2],
    ["half a cent", 0.005, 2],
    ["a value one ten-millionth over a cent", 12.3400001, 2],
    ["a value one ten-millionth under a cent", 12.3399999, 2],
    ["a three-decimal value in a two-decimal currency", 1201.005, 2],
    ["a decimal in a zero-decimal currency", 1234.5, 0],
  ])("still refuses %s", (_l, cell, exp) => {
    expect(parseAmount(cell, exp).kind).toBe("precision");
  });

  it("applies only to number cells: the same digits typed as text are still refused", () => {
    expect(parseAmount("812.429999999999", 2).kind).toBe("precision");
    expect(parseAmount("23.2299999999996", 2).kind).toBe("precision");
    expect(parseAmount("12.3400000001", 2).kind).toBe("precision");
  });

  it("does not change amounts that were already accepted", () => {
    for (const [cell, exp, minor] of [["1,234.56", 2, 123456n], ["0.30", 2, 30n], ["(1,000.00)", 2, -100000n], ["12", 0, 12n]] as const) {
      expect(parseAmount(cell, exp)).toEqual({ kind: "amount", minor });
    }
  });
});

describe("number-cell noise through the whole reader", () => {
  const ctx = { fileName: "noisy.xlsx", periodYear: 2026, currency: "AUD" };
  const read = (rows: unknown[][], fileName = "noisy.xlsx") => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
    return readTrialBalanceSource(new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" })), { ...ctx, fileName }, XLSX as unknown as XlsxLike);
  };
  const HEAD = ["Account Name", "Debit", "Credit"];

  it("a balanced workbook whose cells carry noise reads clean, with the cleaned amounts and a matching control total", () => {
    const r = read([HEAD, ["Cash", 1812.429999999999, null], ["Payables", null, 812.429999999999], ["Capital", null, 1000], ["TOTAL", 1812.43, 1812.43]]);
    expect(r.blocking).toBe(false);
    expect(r.issues.filter((i) => i.severity === "blocking")).toEqual([]);
    expect(r.totals).toEqual({ debitMinor: 181243n, creditMinor: 181243n, differenceMinor: 0n });
  });

  it("a genuinely wrong cell is still blocked (noise handling does not hide a real difference)", () => {
    const r = read([HEAD, ["Cash", 1812.43, null], ["Payables", null, 812.44], ["Capital", null, 1000]]);
    expect(r.blocking).toBe(true);
    expect(r.issues.map((i) => i.code)).toContain("TRIAL_BALANCE_IMBALANCE");
  });

  it("a file with a real third decimal in a number cell is still refused", () => {
    const r = read([HEAD, ["Cash", 1812.435, null], ["Payables", null, 812.435], ["Capital", null, 1000]]);
    expect(r.blocking).toBe(true);
    expect(r.issues.map((i) => i.code)).toContain("PRECISION_EXCEEDS_CURRENCY");
  });

  it("the same noisy digits written as CSV text are still refused", () => {
    const csv = ["Account Name,Debit,Credit", "Cash,1812.429999999999,", "Payables,,812.429999999999", "Capital,,1000"].join("\n");
    const r = readTrialBalanceSource(new TextEncoder().encode(csv), { ...ctx, fileName: "noisy.csv" }, XLSX as unknown as XlsxLike);
    expect(r.blocking).toBe(true);
    expect(r.issues.map((i) => i.code)).toContain("PRECISION_EXCEEDS_CURRENCY");
  });
});
