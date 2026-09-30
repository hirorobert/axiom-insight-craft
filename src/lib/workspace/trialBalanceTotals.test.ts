/**
 * Trial-balance totals in integer minor units. Every amount is converted to cents once (Math.round(value * 100), a
 * non-negative safe integer); subtraction and comparison happen only on those integers; the balance tolerance is the
 * engine's own (process-trial-balance STEP 4, TOLERANCE = 1.00 TZS → 100 cents). The arithmetic explains the server's
 * certification verdict and never replaces it.
 *
 * The runtime representation: process-trial-balance stores total_debits / total_credits / difference as JSON numbers
 * (floating-point sums of the line amounts), so values such as 0.1 + 0.2 = 0.30000000000000004 are what arrive.
 */
import { describe, expect, it } from "vitest";
import type { PreflightCheck } from "./computePreflight";
import {
  BALANCE_TOLERANCE_CENTS, deriveTrialBalanceVerdict, formatCents, isOutOfBalance, plainBlockReason, readTrialBalanceTotals, toMinorUnits,
} from "./trialBalanceVerdict";

const pr = (tb: unknown) => ({ validation_report: { tb_balance_check: tb } });
const read = (tb: unknown) => readTrialBalanceTotals(pr(tb));

describe("above TZS 100 billion with cents", () => {
  it("exact balance", () => {
    const t = read({ total_debits: 174776903504.08, total_credits: 174776903504.08, difference: 0 });
    expect(t).toEqual({ debitCents: 17_477_690_350_408, creditCents: 17_477_690_350_408, differenceCents: 0 });
    expect(isOutOfBalance(t)).toBe(false);
  });
  it("debit excess", () => {
    const t = read({ total_debits: 174776903504.08, total_credits: 174677256055.37, difference: 99647448.71 });
    expect(t).toEqual({ debitCents: 17_477_690_350_408, creditCents: 17_467_725_605_537, differenceCents: 9_964_744_871 });
    expect(isOutOfBalance(t)).toBe(true);
    expect(plainBlockReason({ blocker: null, totals: t })).toBe("Debits exceed credits by 99,647,448.71. Correct the file and replace it.");
  });
  it("credit excess", () => {
    const t = read({ total_debits: 174677256055.37, total_credits: 174776903504.08, difference: 99647448.71 });
    expect(t?.differenceCents).toBe(-9_964_744_871);
    expect(isOutOfBalance(t)).toBe(true);
    expect(plainBlockReason({ blocker: null, totals: t })).toBe("Credits exceed debits by 99,647,448.71. Correct the file and replace it.");
  });
  it("formats the large totals exactly from cents", () => {
    expect(formatCents(17_477_690_350_408)).toBe("174,776,903,504.08");
    expect(formatCents(17_467_725_605_537)).toBe("174,677,256,055.37");
    expect(formatCents(-5)).toBe("-0.05");
    expect(formatCents(0)).toBe("0.00");
    expect(() => formatCents(0.5)).toThrow(RangeError);
  });
});

describe("the engine's tolerance, matched exactly (≤ 100 cents balanced, > 100 cents out of balance)", () => {
  it("is 100 cents (TZS 1.00)", () => expect(BALANCE_TOLERANCE_CENTS).toBe(100));
  it.each([
    ["0.60", 1000.6, 60, false],
    ["exactly 1.00", 1001, 100, false],
    ["1.01", 1001.01, 101, true],
  ])("difference %s", (_label, debits, cents, out) => {
    const t = read({ total_debits: debits, total_credits: 1000 });
    expect(t?.differenceCents).toBe(cents);
    expect(isOutOfBalance(t)).toBe(out);
  });
});

describe("floating-point representation", () => {
  it("0.1 + 0.2 against 0.3 is exactly balanced in cents", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(read({ total_debits: 0.1 + 0.2, total_credits: 0.3, difference: Math.abs(0.1 + 0.2 - 0.3) })).toEqual({ debitCents: 30, creditCents: 30, differenceCents: 0 });
  });
  it("engine-style float sums of many cent lines", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => 174776903.5 + (i % 7) * 0.01);
    const d = lines.reduce((s, x) => s + x, 0);
    const c = [...lines].reverse().reduce((s, x) => s + x, 0);
    const t = read({ total_debits: d, total_credits: c, difference: Math.abs(d - c) });
    expect(t).not.toBeNull();
    expect(Number.isSafeInteger(t!.debitCents) && Number.isSafeInteger(t!.creditCents)).toBe(true);
    expect(isOutOfBalance(t)).toBe(false);
  });
});

describe("maximum safe minor-unit boundary", () => {
  it("the largest whole amount whose cents are a safe integer converts; the next does not", () => {
    expect(toMinorUnits(90_071_992_547_409)).toBe(9_007_199_254_740_900);
    expect(toMinorUnits(90_071_992_547_410)).toBeNull();
    expect(toMinorUnits(1e20)).toBeNull();
    expect(toMinorUnits(Number.MAX_VALUE)).toBeNull();
    expect(read({ total_debits: 90_071_992_547_410, total_credits: 1 })).toBeNull();
  });
});

describe("refused inputs → NOT COMPUTED (null), never zero", () => {
  it.each([
    ["negative", { total_debits: -0.01, total_credits: 1 }],
    ["NaN", { total_debits: Number.NaN, total_credits: 1 }],
    ["Infinity", { total_debits: 1, total_credits: Number.POSITIVE_INFINITY }],
    ["numeric string", { total_debits: "174776903504.08", total_credits: "174677256055.37" }],
    ["numeric-string difference", { total_debits: 10, total_credits: 8, difference: "2" }],
    ["non-finite difference", { total_debits: 10, total_credits: 8, difference: Number.NaN }],
    ["boolean", { total_debits: true, total_credits: 1 }],
    ["null total", { total_debits: null, total_credits: 1 }],
    ["missing total", { total_credits: 1 }],
    ["array block", [1, 2]],
  ])("%s", (_label, tb) => {
    expect(read(tb)).toBeNull();
  });
  it("malformed paths", () => {
    expect(readTrialBalanceTotals(null)).toBeNull();
    expect(readTrialBalanceTotals({ validation_report: "x" })).toBeNull();
    expect(readTrialBalanceTotals({ validation_report: { tb_balance_check: "x" } })).toBeNull();
  });
});

describe("recorded difference, compared in cents", () => {
  it("a one-cent discrepancy from independent rounding is accepted", () => {
    expect(read({ total_debits: 1000.6, total_credits: 1000, difference: 0.61 })?.differenceCents).toBe(60);
    expect(read({ total_debits: 1000.6, total_credits: 1000, difference: 0.59 })?.differenceCents).toBe(60);
  });
  it("more than one cent fails closed; the certification's own reason is then used", () => {
    expect(read({ total_debits: 1000.6, total_credits: 1000, difference: 0.62 })).toBeNull();
    // The engine records difference: 0 on its balanced path even when the true difference is within its tolerance.
    expect(read({ total_debits: 1000.6, total_credits: 1000, difference: 0 })).toBeNull();
    const v = deriveTrialBalanceVerdict({
      upload: { status: "blocked", processing_result: pr({ total_debits: 1250000, total_credits: 1247500, difference: 2500.02 }) },
      readiness: { verdict: "blocked", blocker: "L3_TB_IMBALANCE: the trial balance does not balance", checks: [] }, canRetry: true,
    });
    expect(v.totals).toBeNull();
    expect(v.reason).toBe("the trial balance does not balance");
  });
});

describe("the arithmetic explains the server's verdict; it never decides it", () => {
  const L = (id: string, state: PreflightCheck["state"]): PreflightCheck => ({ id, label: id, state, detail: "server detail" });
  const balanced = pr({ total_debits: 980000, total_credits: 980000, difference: 0 });
  it("balanced totals never turn a server refusal into acceptance", () => {
    const v = deriveTrialBalanceVerdict({
      upload: { status: "blocked", processing_result: balanced },
      readiness: { verdict: "blocked", blocker: "L2_BAD_NUMBER: Row 14 has a non-numeric amount.", checks: [L("l2_data_quality", "failed")] }, canRetry: true,
    });
    expect(v.status).toBe("blocked");
    expect(v.evidenceUnlocked).toBe(false);
    expect(v.reason).toBe("Row 14 has a non-numeric amount.");
  });
  it("balanced totals never grant acceptance while the certification is pending", () => {
    const v = deriveTrialBalanceVerdict({ upload: { status: "complete", processing_result: balanced }, readiness: { verdict: "pending", blocker: null, checks: [] }, canRetry: true });
    expect(v.status).not.toBe("accepted");
    expect(v.evidenceUnlocked).toBe(false);
  });
  it("a within-tolerance difference is never stated as the block reason", () => {
    const t = read({ total_debits: 1000.6, total_credits: 1000 });
    expect(plainBlockReason({ blocker: "L3_TB_IMBALANCE: server reason", totals: t })).toBe("server reason");
  });
});
