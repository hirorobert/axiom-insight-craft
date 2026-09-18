import { describe, expect, it } from "vitest";
import {
  correctReportFact,
  evaluateReport,
  prepareTrialBalanceReport,
  recordReviewerDecision,
  StaleTrialBalanceInputError,
  UnsupportedFrameworkForTrialBalanceAdapterError,
} from "./evaluationOrchestrator";
import { InMemoryFinancialStatementReportRepository } from "./reportRepository";
import { UnresolvedCurrencyError, UnresolvedFrameworkError } from "./adapterContract";
import type { ReviewedTrialBalanceAccountLine } from "./trialBalanceAdapter";
import type { CorrectFactDecision } from "@/lib/canonicalStatement/types";
import { withoutCreatedAt } from "@/lib/canonicalStatement/serialization";

const SOURCE_HASH = "b".repeat(64);

function row(overrides: Partial<ReviewedTrialBalanceAccountLine> & Pick<ReviewedTrialBalanceAccountLine, "accountKey" | "accountName" | "statement" | "classification" | "normalBalance" | "balance">): ReviewedTrialBalanceAccountLine {
  return {
    currency: "TZS",
    scale: 2,
    periodId: "CURRENT",
    isComparative: false,
    isCashAccount: false,
    isRetainedEarnings: false,
    isPayrollAccount: false,
    sourceUploadId: "upload-1",
    sourceHash: SOURCE_HASH,
    ...overrides,
  };
}

function balancedLines(): ReviewedTrialBalanceAccountLine[] {
  return [
    row({ accountKey: "1000", accountName: "Cash", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 10_000_000, isCashAccount: true }),
    row({ accountKey: "2000", accountName: "Payables", statement: "balance_sheet", classification: "current_liabilities", normalBalance: "credit", balance: 4_000_000 }),
    row({ accountKey: "3000", accountName: "Share Capital", statement: "balance_sheet", classification: "equity", normalBalance: "credit", balance: 6_000_000 }),
  ];
}

function baseParams(overrides: Partial<Parameters<typeof prepareTrialBalanceReport>[0]> = {}) {
  return {
    companyId: "11111111-1111-1111-1111-111111111111",
    periodYear: 2025,
    entityLegalName: "Test Co Ltd",
    framework: "ifrs_for_smes",
    currency: "TZS",
    currentPeriod: { startDate: "2025-01-01", endDate: "2025-12-31" },
    reviewedAccountLines: balancedLines(),
    ...overrides,
  };
}

describe("prepareTrialBalanceReport", () => {
  it("prepares a new report on first call", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    const result = await prepareTrialBalanceReport(baseParams(), repo);
    expect(result.status).toBe("PREPARED");
    expect(result.snapshot.report.reportIdentity.reportVersion).toBe(1);
    expect(result.snapshot.report.framework.kind).toBe("IFRS_FOR_SMES");
  });

  it("is idempotent — an identical re-run returns UNCHANGED, not a duplicate", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    const first = await prepareTrialBalanceReport(baseParams(), repo);
    const second = await prepareTrialBalanceReport(baseParams(), repo);
    expect(second.status).toBe("UNCHANGED");
    expect(second.snapshot.report.reportIdentity.reportId).toBe(first.snapshot.report.reportIdentity.reportId);
  });

  it("always derives the same reportId for the same company/period, independent of call order", async () => {
    const repoA = new InMemoryFinancialStatementReportRepository();
    const repoB = new InMemoryFinancialStatementReportRepository();
    const a = await prepareTrialBalanceReport(baseParams(), repoA);
    const b = await prepareTrialBalanceReport(baseParams({ reviewedAccountLines: [...balancedLines()].reverse() }), repoB);
    expect(a.snapshot.report.reportIdentity.reportId).toBe(b.snapshot.report.reportIdentity.reportId);
  });

  it("refuses to silently overwrite an existing report when the input has genuinely changed", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    await prepareTrialBalanceReport(baseParams(), repo);
    const changedLines = balancedLines();
    changedLines[0] = { ...changedLines[0], balance: 999 };
    await expect(prepareTrialBalanceReport(baseParams({ reviewedAccountLines: changedLines }), repo)).rejects.toThrow(StaleTrialBalanceInputError);
  });

  it("throws UnresolvedFrameworkError rather than defaulting when framework is null", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    await expect(prepareTrialBalanceReport(baseParams({ framework: null }), repo)).rejects.toThrow(UnresolvedFrameworkError);
  });

  it("throws UnresolvedCurrencyError rather than defaulting when currency is null", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    await expect(prepareTrialBalanceReport(baseParams({ currency: null }), repo)).rejects.toThrow(UnresolvedCurrencyError);
  });

  it("rejects IPSAS_CASH — this adapter path cannot honestly serve a cash-basis primary statement", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    await expect(prepareTrialBalanceReport(baseParams({ framework: "ipsas_cash" }), repo)).rejects.toThrow(UnsupportedFrameworkForTrialBalanceAdapterError);
  });
});

describe("evaluateReport", () => {
  it("evaluates a prepared report and finds the SFP equation passes", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    const { snapshot } = await prepareTrialBalanceReport(baseParams(), repo);
    const run = await evaluateReport(snapshot, repo);
    const equation = run.findings.find((f) => f.ruleId === "sfp-equation");
    expect(equation?.outcome).toBe("PASS");
  });

  it("is idempotent — evaluating the same report twice returns the identical evaluationRunId and does not create a duplicate run", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    const { snapshot } = await prepareTrialBalanceReport(baseParams(), repo);
    const runA = await evaluateReport(snapshot, repo);
    const runB = await evaluateReport(snapshot, repo);
    expect(runA.evaluationRunId).toBe(runB.evaluationRunId);
    expect(runA.createdAt).toBe(runB.createdAt); // second call returned the cached record, never recomputed
  });

  it("produces the identical evaluationRunId and identical findings (modulo wall-clock createdAt) for two independent evaluations of the same report content", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    const { snapshot } = await prepareTrialBalanceReport(baseParams(), repo);
    const [runA, runB] = await Promise.all([evaluateReport(snapshot, new InMemoryFinancialStatementReportRepository()), evaluateReport(snapshot, repo)]);
    expect(runA.evaluationRunId).toBe(runB.evaluationRunId);
    expect(runA.findings.map(withoutCreatedAt)).toEqual(runB.findings.map(withoutCreatedAt));
  });
});

describe("correctReportFact", () => {
  it("advances reportVersion by exactly 1 and produces a still-valid report", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    const { snapshot } = await prepareTrialBalanceReport(baseParams(), repo);
    const cashFact = snapshot.report.facts.find((f) => f.factId === "fact:detail:sfp:1000:CURRENT")!;

    const decision: CorrectFactDecision = {
      decisionId: "decision-1",
      decisionType: "CORRECT_FACT",
      reviewerId: "firm-member-1",
      decidedAt: "2025-06-01T00:00:00.000Z",
      factId: cashFact.factId,
      supersedesVersion: cashFact.version,
      newVersion: cashFact.version + 1,
      correctedValue: { currency: "TZS", scale: 2, minorUnits: 999_999_00n },
      rationale: "Bank reconciliation adjustment",
      expectedReportVersion: snapshot.report.reportIdentity.reportVersion,
    };

    const corrected = await correctReportFact(snapshot.report.reportIdentity.reportId, decision, {
      source: { sourceDocumentId: "upload-1", sourceHash: SOURCE_HASH, artifactKind: "TRIAL_BALANCE" },
      locator: { kind: "MANUAL", note: "reviewer correction" },
      extractionMethod: "MANUAL_REVIEWER_ENTRY",
      extractionConfidence: { kind: "CERTAIN" },
      originalText: "999999.00",
    }, repo);

    expect(corrected.report.reportIdentity.reportVersion).toBe(snapshot.report.reportIdentity.reportVersion + 1);
    expect(corrected.decisions).toHaveLength(1);
  });

  it("rejects a correction formed against a stale reportVersion", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    const { snapshot } = await prepareTrialBalanceReport(baseParams(), repo);
    const cashFact = snapshot.report.facts.find((f) => f.factId === "fact:detail:sfp:1000:CURRENT")!;
    const staleDecision: CorrectFactDecision = {
      decisionId: "decision-stale",
      decisionType: "CORRECT_FACT",
      reviewerId: "firm-member-1",
      decidedAt: "2025-06-01T00:00:00.000Z",
      factId: cashFact.factId,
      supersedesVersion: cashFact.version,
      newVersion: cashFact.version + 1,
      correctedValue: { currency: "TZS", scale: 2, minorUnits: 1n },
      rationale: "stale",
      expectedReportVersion: 999, // deliberately wrong
    };
    await expect(
      correctReportFact(
        snapshot.report.reportIdentity.reportId,
        staleDecision,
        { source: { sourceDocumentId: "upload-1", sourceHash: SOURCE_HASH, artifactKind: "TRIAL_BALANCE" }, locator: { kind: "MANUAL", note: "x" }, extractionMethod: "MANUAL_REVIEWER_ENTRY", extractionConfidence: { kind: "CERTAIN" }, originalText: "1" },
        repo,
      ),
    ).rejects.toThrow();
  });
});

describe("recordReviewerDecision", () => {
  it("appends a standalone decision and rejects a duplicate decisionId", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    const { snapshot } = await prepareTrialBalanceReport(baseParams(), repo);
    await recordReviewerDecision(snapshot.report.reportIdentity.reportId, { decisionId: "d1", decisionType: "DEFER", reviewerId: "firm-member-1", decidedAt: "2025-06-01T00:00:00.000Z" }, repo);
    const stored = await repo.getByReportId(snapshot.report.reportIdentity.reportId);
    expect(stored?.decisions).toHaveLength(1);
    await expect(recordReviewerDecision(snapshot.report.reportIdentity.reportId, { decisionId: "d1", decisionType: "DEFER", reviewerId: "firm-member-1", decidedAt: "2025-06-01T00:00:00.000Z" }, repo)).rejects.toThrow();
  });
});
