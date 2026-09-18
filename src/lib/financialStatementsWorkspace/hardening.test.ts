import { describe, expect, it } from "vitest";
import { evaluateReport, prepareTrialBalanceReport } from "./evaluationOrchestrator";
import { InMemoryFinancialStatementReportRepository } from "./reportRepository";
import type { ReviewedTrialBalanceAccountLine } from "./trialBalanceAdapter";

const base = { currency: "TZS", scale: 2, periodId: "CURRENT", isComparative: false, isCashAccount: null, isRetainedEarnings: null, isPayrollAccount: null, sourceUploadId: "u", sourceHash: "d".repeat(64) };
const lines = (): ReviewedTrialBalanceAccountLine[] => [
  { ...base, accountKey: "1", accountName: "Cash", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 100 },
  { ...base, accountKey: "3", accountName: "Capital", statement: "balance_sheet", classification: "equity", normalBalance: "credit", balance: 100 },
];
const params = (companyId: string, l: unknown[] = lines()) => ({ companyId, periodYear: 2025, entityLegalName: "X", framework: "full_ifrs", currency: "TZS", currentPeriod: { startDate: "2025-01-01", endDate: "2025-12-31" }, reviewedAccountLines: l });

describe("hardening", () => {
  it("keeps two companies' reports isolated in the same repository", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    const a = await prepareTrialBalanceReport(params("company-a"), repo);
    const b = await prepareTrialBalanceReport(params("company-b", [{ ...lines()[0], balance: 5 }, { ...lines()[1], balance: 5 }]), repo);
    expect(a.snapshot.report.reportIdentity.reportId).not.toBe(b.snapshot.report.reportIdentity.reportId);
    expect((await repo.getLatestByCompanyPeriod("company-a", 2025, "TRIAL_BALANCE_DERIVED"))?.report.reportIdentity.companyId).toBe("company-a");
    expect(await repo.getLatestByCompanyPeriod("company-c", 2025, "TRIAL_BALANCE_DERIVED")).toBeNull();
  });

  it("yields identical evaluation identities for reordered input and repeated adapter runs", async () => {
    const r1 = new InMemoryFinancialStatementReportRepository();
    const r2 = new InMemoryFinancialStatementReportRepository();
    const e1 = await evaluateReport((await prepareTrialBalanceReport(params("c"), r1)).snapshot, r1);
    const e2 = await evaluateReport((await prepareTrialBalanceReport(params("c", [...lines()].reverse()), r2)).snapshot, r2);
    expect(e1.evaluationRunId).toBe(e2.evaluationRunId);
    expect(e1.findings.map((f) => f.evaluationId)).toEqual(e2.findings.map((f) => f.evaluationId));
  });

  it("rejects malformed monetary input, unsupported scale mixes and missing period data without persisting anything", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    await expect(prepareTrialBalanceReport(params("c", [{ ...lines()[0], balance: "12,5" }]), repo)).rejects.toThrow();
    await expect(prepareTrialBalanceReport(params("c", [{ ...lines()[0], scale: 3 }, lines()[1]]), repo)).rejects.toThrow();
    await expect(prepareTrialBalanceReport(params("c", lines().map((l) => ({ ...l, periodId: "COMPARATIVE_1", isComparative: true }))), repo)).rejects.toThrow();
    expect(await repo.getLatestByCompanyPeriod("c", 2025, "TRIAL_BALANCE_DERIVED")).toBeNull();
  });
});
