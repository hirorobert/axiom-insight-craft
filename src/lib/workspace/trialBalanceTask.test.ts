import { describe, expect, it } from "vitest";
import { currentTrialBalanceTask } from "./trialBalanceTask";
import { readIngestionIssues, readMilestones, readTrialBalanceTotals, isOutOfBalance, deriveTrialBalanceVerdict } from "./trialBalanceVerdict";

const noEvidence = { safishaStatus: null, reconciliation: null };
const evaluated = { safishaStatus: "clean", reconciliation: { status: "clean", matched_count: 3, exception_count: 0, total_tb_lines: 3 } };
const v = (status: string, extra: Record<string, unknown> = {}) => ({ status, failedCheckId: null, issues: [], ...extra }) as never;

describe("current service and task", () => {
  it("names the service, the step of four and one instruction for every verdict", () => {
    expect(currentTrialBalanceTask(v("none"), noEvidence)).toEqual({ service: "Trial balance review", step: 1, of: 4, label: "Upload trial balance", instruction: "Upload the trial balance for this period." });
    expect(currentTrialBalanceTask(v("processing"), noEvidence).step).toBe(1);
    expect(currentTrialBalanceTask(v("blocked", { issues: [{}, {}] }), noEvidence).instruction).toBe("Correct the 2 issues listed below in your file, then replace it.");
    expect(currentTrialBalanceTask(v("blocked", { failedCheckId: "l4_classification" }), noEvidence)).toMatchObject({ step: 2, label: "Review accounts needing attention" });
    expect(currentTrialBalanceTask(v("needs_review"), noEvidence)).toMatchObject({ step: 2 });
    expect(currentTrialBalanceTask(v("accepted"), noEvidence)).toMatchObject({ step: 3, label: "Reconcile supporting evidence" });
    expect(currentTrialBalanceTask(v("accepted"), evaluated)).toMatchObject({ step: 4, label: "Trial balance ready" });
  });

  it("a clean status that compared nothing stays on the reconcile step", () => {
    const empty = { safishaStatus: "clean", reconciliation: { status: "clean", matched_count: 0, exception_count: 0, total_tb_lines: 0 } };
    expect(currentTrialBalanceTask(v("accepted"), empty)).toMatchObject({ step: 3, instruction: "No trial-balance line has been matched to evidence yet." });
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

  it("refuses exact totals it cannot show exactly (three-decimal currencies) instead of falling back to rounded doubles", () => {
    expect(readTrialBalanceTotals(exactResult("1.234", "1.234", "BHD"))).toBeNull();
    expect(readTrialBalanceTotals(exactResult("abc", "1"))).toBeNull();
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
