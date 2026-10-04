/**
 * The card reads the server's exact totals at the currency's recorded precision (shipped with the server change, so
 * the new client × new server pair is exact from the first deploy — scripts/compat/tbMixedVersions.mjs).
 */
import { describe, expect, it } from "vitest";
import { decimalToMinor, formatMinorUnits, formatTotal, isOutOfBalance, readTrialBalanceTotals } from "./trialBalanceVerdict";

const exact = (d: string, c: string, currency: string, currency_exponent?: number) => ({
  validation_report: { tb_balance_check: { passed: d === c, total_debits: Number(d), total_credits: Number(c), exact: { currency, ...(currency_exponent === undefined ? {} : { currency_exponent }), total_debits: d, total_credits: c } } },
});

describe("exact totals at the currency's precision", () => {
  it("three-decimal currencies are exact and a 0.001 difference is out of balance", () => {
    const t = readTrialBalanceTotals(exact("1.234", "1.233", "BHD", 3))!;
    expect([formatTotal(t, t.debitCents), formatTotal(t, t.creditCents), formatTotal(t, t.differenceCents)]).toEqual(["1.234", "1.233", "0.001"]);
    expect(isOutOfBalance(t)).toBe(true);
  });
  it("zero-decimal currencies show whole units; two-decimal currencies are unchanged", () => {
    const ugx = readTrialBalanceTotals(exact("1500", "1500", "UGX", 0))!;
    expect(formatTotal(ugx, ugx.debitCents)).toBe("1,500");
    const tzs = readTrialBalanceTotals(exact("1900.25", "1900.25", "TZS", 2))!;
    expect(formatTotal(tzs, tzs.debitCents)).toBe("1,900.25");
  });
  it("never falls back to rounded doubles: unparseable or over-precise exact totals are refused", () => {
    expect(readTrialBalanceTotals(exact("1.234", "1.234", "BHD"))).toBeNull(); // no recorded exponent, three places
    expect(decimalToMinor("1.2345", 3)).toBeNull();
    expect(formatMinorUnits(-5, 3)).toBe("-0.005");
  });
});
