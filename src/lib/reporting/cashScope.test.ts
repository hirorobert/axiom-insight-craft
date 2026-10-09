import { describe, expect, it } from "vitest";
import { cashScopeFromReportingInput, reviewedCashKeys } from "./cashScope";

const acc = (accountKey: string, isCashAccount: boolean | null, debitMinor = "0", creditMinor = "0") => ({ accountKey, isCashAccount, debitMinor, creditMinor, statement: "balance_sheet" });

describe("cash scope from fs_reporting_input (DEFECT D-3)", () => {
  it("each period's accounts, with its own reviewed cash flags and exact-zero detection; arbitrary codes", () => {
    const s = cashScopeFromReportingInput({
      current: { accounts: [acc("91000", true, "1250000"), acc("AB-7", true), acc("3000", false, "0", "1250000")] },
      comparative: { state: "available", accounts: [acc("1010", true, "800000"), acc("3000", null, "0", "800000")] },
    })!;
    expect(reviewedCashKeys(s.current)).toEqual(["91000", "AB-7"]);
    expect(s.current.find((a) => a.accountKey === "AB-7")!.zero).toBe(true);
    expect(s.current.find((a) => a.accountKey === "91000")!.zero).toBe(false);
    expect(reviewedCashKeys(s.comparative!)).toEqual(["1010"]);
    expect(s.comparative!.find((a) => a.accountKey === "3000")!.isCashAccount).toBeNull();
  });
  it("debit and credit that net to zero are zero; no comparative when the input has none available", () => {
    const s = cashScopeFromReportingInput({ current: { accounts: [acc("1000", true, "500", "500")] }, comparative: { state: "missing", periodYear: 2024 } })!;
    expect(s.current[0].zero).toBe(true);
    expect(s.comparative).toBeNull();
  });
  it("refuses an input that does not carry its accounts in the expected shape (never read as no cash accounts)", () => {
    expect(cashScopeFromReportingInput({ current: {} })).toBeNull();
    expect(cashScopeFromReportingInput({ current: { accounts: [{ accountKey: "1000", isCashAccount: "yes", debitMinor: "0", creditMinor: "0" }] } })).toBeNull();
    expect(cashScopeFromReportingInput({ current: { accounts: [acc("1000", true, "1.5")] } })).toBeNull();
    expect(cashScopeFromReportingInput({ current: { accounts: [] }, comparative: { state: "available" } })).toBeNull();
  });
});
