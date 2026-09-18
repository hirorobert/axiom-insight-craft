import { describe, expect, it } from "vitest";
import { correctableFacts } from "./correctableFacts";
import { correctFactAndRecast, evaluateReport, prepareTrialBalanceReport } from "./evaluationOrchestrator";
import { InMemoryFinancialStatementReportRepository } from "./reportRepository";
import { buildDecisionCommand } from "./reviewerDecisionCommands";
import type { ReviewedTrialBalanceAccountLine } from "./trialBalanceAdapter";

const base = { currency: "TZS", scale: 2, periodId: "CURRENT", isComparative: false, isCashAccount: null, isRetainedEarnings: null, isPayrollAccount: null, sourceUploadId: "u", sourceHash: "a".repeat(64) };
const lines: ReviewedTrialBalanceAccountLine[] = [
  { ...base, accountKey: "1", accountName: "Cash", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 100 },
  { ...base, accountKey: "2", accountName: "Payables", statement: "balance_sheet", classification: "current_liabilities", normalBalance: "credit", balance: 30 },
  { ...base, accountKey: "3", accountName: "Capital", statement: "balance_sheet", classification: "equity", normalBalance: "credit", balance: 50 },
];

describe("correctableFacts", () => {
  it("expands a finding's total lines to the source-account facts underneath, never to derived facts", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    const { snapshot } = await prepareTrialBalanceReport({ companyId: "c", periodYear: 2025, entityLegalName: "E", framework: "full_ifrs", currency: "TZS", currentPeriod: { startDate: "2025-01-01", endDate: "2025-12-31" }, reviewedAccountLines: lines }, repo);
    const run = await evaluateReport(snapshot, repo);
    const finding = run.findings.find((f) => f.ruleId === "sfp-equation")!;
    const facts = correctableFacts(snapshot.report, finding);
    expect(facts.map((f) => f.label)).toEqual(["Capital (2025)", "Cash (2025)", "Payables (2025)"]);
    expect(facts.every((f) => f.factId.startsWith("fact:detail:"))).toBe(true);
    expect(facts.find((f) => f.label.startsWith("Payables"))?.currentAmount).toBe("30.00");

    // the reviewer picks a source figure; the correction is accepted and totals re-derive
    const cmd = buildDecisionCommand({ outcome: "CORRECTED", finding, rationale: "Payables per confirmed ledger", report: snapshot.report, decisionId: "d1", decidedAt: "t", reviewerId: "r", correctableFactIds: facts.map((f) => f.factId), correction: { factId: "fact:detail:sfp:2:CURRENT", correctedAmount: "50.00" } });
    if (cmd.kind !== "CORRECTION") throw new Error("expected correction");
    const next = await correctFactAndRecast({ reportId: snapshot.report.reportIdentity.reportId, decision: cmd.decision, provenance: cmd.provenance, reviewedAccountLines: lines, repo });
    expect((await evaluateReport(next, repo)).findings.find((f) => f.findingKey === finding.findingKey)?.outcome).toBe("PASS");
  });

  it("refuses a correction to a figure outside the offered set", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    const { snapshot } = await prepareTrialBalanceReport({ companyId: "c", periodYear: 2025, entityLegalName: "E", framework: "full_ifrs", currency: "TZS", currentPeriod: { startDate: "2025-01-01", endDate: "2025-12-31" }, reviewedAccountLines: lines }, repo);
    const finding = (await evaluateReport(snapshot, repo)).findings.find((f) => f.ruleId === "sfp-equation")!;
    expect(() => buildDecisionCommand({ outcome: "CORRECTED", finding, rationale: "x", report: snapshot.report, decisionId: "d", decidedAt: "t", reviewerId: "r", correctableFactIds: ["fact:detail:sfp:1:CURRENT"], correction: { factId: "fact:detail:sfp:3:CURRENT", correctedAmount: "1.00" } })).toThrow(/not part of this finding/);
  });
});
