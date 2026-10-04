import { describe, expect, it } from "vitest";
import { currentTrialBalanceTask } from "./trialBalanceTask";
import { decimalToMinor, formatMinorUnits, formatTotal, readIngestionIssues, readMilestones, readTrialBalanceTotals, isOutOfBalance, deriveTrialBalanceVerdict } from "./trialBalanceVerdict";

const v = (status: string, extra: Record<string, unknown> = {}) => ({ status, failedCheckId: null, issues: [], ...extra }) as never;

describe("current service and task", () => {
  it("names the service, the step of three and one instruction for every verdict", () => {
    expect(currentTrialBalanceTask(v("none"))).toEqual({ service: "Trial balance review", step: 1, of: 3, label: "Upload and validate trial balance", instruction: "Upload the trial balance for this period." });
    expect(currentTrialBalanceTask(v("processing")).step).toBe(1);
    expect(currentTrialBalanceTask(v("blocked", { issues: [{}, {}] })).instruction).toBe("Correct the 2 issues shown below in your file, then replace it.");
    expect(currentTrialBalanceTask(v("blocked", { failedCheckId: "l4_classification" }))).toMatchObject({ step: 2, label: "Review and confirm account classifications" });
    expect(currentTrialBalanceTask(v("needs_review"))).toMatchObject({ step: 2 });
  });

  it("an accepted trial balance is the final step: a Reviewed trial balance, never reconciled, never an approval", () => {
    const t = currentTrialBalanceTask(v("accepted"));
    expect(t).toMatchObject({ step: 3, of: 3, label: "Trial balance ready for statement preparation" });
    expect(t.instruction).toBe("Reviewed trial balance: checks passed and every account classification confirmed. This is not an approval of financial statements.");
    expect(t.instruction).not.toMatch(/reconcil|audit|assur|signed off/i);
  });
});

describe("the verdict reads what the exact ingestion core recorded", () => {
  const exactResult = (debit: string, credit: string, currency = "USD") => ({
    validation_report: { tb_balance_check: { passed: false, total_debits: Number(debit), total_credits: Number(credit), exact: { currency, total_debits: debit, total_credits: credit, difference: "0" } } },
  });

  it("exact totals carry no tolerance: one cent is out of balance (the earlier engine allowed 1.00)", () => {
    const t = readTrialBalanceTotals(exactResult("1000.01", "1000.00"));
    expect(t).toEqual({ debitCents: 100001, creditCents: 100000, differenceCents: 1, toleranceCents: 0, currency: "USD" });
    expect(isOutOfBalance(t)).toBe(true);
    expect(isOutOfBalance(readTrialBalanceTotals({ validation_report: { tb_balance_check: { total_debits: 1000.01, total_credits: 1000 } } }))).toBe(false);
  });

  it("presentation uses the currency precision the server recorded: three-decimal and zero-decimal currencies are exact", () => {
    const withExponent = (d: string, c: string, currency: string, currency_exponent: number) => ({
      validation_report: { tb_balance_check: { passed: true, total_debits: Number(d), total_credits: Number(c), exact: { currency, currency_exponent, total_debits: d, total_credits: c, difference: "0" } } },
    });
    const bhd = readTrialBalanceTotals(withExponent("1234.567", "1234.566", "BHD", 3))!;
    expect(bhd).toEqual({ debitCents: 1234567, creditCents: 1234566, differenceCents: 1, toleranceCents: 0, exponent: 3, currency: "BHD" });
    expect([formatTotal(bhd, bhd.debitCents), formatTotal(bhd, bhd.differenceCents)]).toEqual(["1,234.567", "0.001"]);
    expect(isOutOfBalance(bhd)).toBe(true); // 0.001 BHD is a real difference, never rounded away
    const ugx = readTrialBalanceTotals(withExponent("1500", "1500", "UGX", 0))!;
    expect([ugx.exponent, formatTotal(ugx, ugx.debitCents)]).toEqual([0, "1,500"]);
    const tzs = readTrialBalanceTotals(withExponent("1900.25", "1900.25", "TZS", 2))!;
    expect([tzs.exponent, formatTotal(tzs, tzs.debitCents)]).toEqual([undefined, "1,900.25"]);
    expect(formatMinorUnits(-5, 3)).toBe("-0.005");
  });

  it("refuses exact totals it cannot show exactly instead of falling back to rounded doubles", () => {
    expect(readTrialBalanceTotals(exactResult("1.234", "1.234", "BHD"))).toBeNull(); // no recorded exponent, three places
    expect(readTrialBalanceTotals(exactResult("abc", "1"))).toBeNull();
    expect(decimalToMinor("1.2345", 3)).toBeNull();
  });

  it("reads blocking issues with their rows, and milestones, ignoring malformed entries", () => {
    const pr = { ingestion: {
      issues: [
        { code: "DUPLICATE_ACCOUNT_CODE", severity: "blocking", message: "Account code 1000 appears on rows 2, 3.", rows: [2, 3] },
        { code: "X", severity: "review", message: "not blocking" },
        { code: 5, severity: "blocking", message: "bad" },
      ],
      milestones: [
        { id: "read", label: "File read", status: "passed", detail: "25 rows" },
        { id: "rows", label: "Every row accounted for", status: "failed" },
        { id: "zzz", label: "x", status: "exploded" },
      ],
    } };
    expect(readIngestionIssues(pr)).toEqual([{ code: "DUPLICATE_ACCOUNT_CODE", message: "Account code 1000 appears on rows 2, 3.", rows: [2, 3] }]);
    expect(readMilestones(pr)).toEqual([
      { id: "read", label: "File read", status: "passed", detail: "25 rows" },
      { id: "rows", label: "Every row accounted for", status: "failed", detail: null },
    ]);
    expect(readIngestionIssues({})).toEqual([]);
    expect(readMilestones(null)).toEqual([]);
  });

  it("issues are attached to a blocked verdict only", () => {
    const upload = { id: "u", status: "blocked", processing_result: { ingestion: { issues: [{ code: "TOTAL_ROW_MISMATCH", severity: "blocking", message: "The total on row 40 …", rows: [40] }], milestones: [] } } };
    const blocked = deriveTrialBalanceVerdict({ upload, readiness: { verdict: "blocked", blocker: "TOTAL_ROW_MISMATCH: The total on row 40 …", checks: [] }, canRetry: true });
    expect(blocked.issues).toHaveLength(1);
    const accepted = deriveTrialBalanceVerdict({ upload: { ...upload, status: "complete" }, readiness: { verdict: "certified", blocker: null, checks: [] }, canRetry: true });
    expect(accepted.issues).toEqual([]);
  });
});
