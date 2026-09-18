import { describe, expect, it, vi } from "vitest";
import {
  classifyPersistenceError,
  deserializeReport,
  initialPersistenceState,
  parseDocument,
  PersistencePermissionError,
  PersistenceStaleVersionError,
  PersistenceUnavailableError,
  RemoteFinancialStatementReportRepository,
  serializeDocument,
  toAppendDecisionRequest,
  toSaveReportRequest,
  type PersistenceTransport,
} from "./persistenceContract";
import { FINANCIAL_STATEMENT_PERSISTENCE_ENABLED } from "./persistenceGate";
import { correctFactAndRecast, correctReportFact, evaluateReport, prepareTrialBalanceReport, recordReviewerDecision } from "./evaluationOrchestrator";
import { InMemoryFinancialStatementReportRepository } from "./reportRepository";
import { buildDecisionCommand, DecisionCommandError, isStaleVersionError } from "./reviewerDecisionCommands";
import { buildFindingViews } from "./findingsView";
import type { ReviewedTrialBalanceAccountLine } from "./trialBalanceAdapter";

const base = { currency: "TZS", scale: 2, periodId: "CURRENT", isComparative: false, isCashAccount: null, isRetainedEarnings: null, isPayrollAccount: null, sourceUploadId: "u", sourceHash: "f".repeat(64) };
// Assets 100.00, liabilities 30.00, equity 50.00 -> deliberately does not balance (defect: 20.00).
const unbalanced = (): ReviewedTrialBalanceAccountLine[] => [
  { ...base, accountKey: "1", accountName: "Cash", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 100 },
  { ...base, accountKey: "2", accountName: "Payables", statement: "balance_sheet", classification: "current_liabilities", normalBalance: "credit", balance: 30 },
  { ...base, accountKey: "3", accountName: "Capital", statement: "balance_sheet", classification: "equity", normalBalance: "credit", balance: 50 },
];
const params = { companyId: "c1", periodYear: 2025, entityLegalName: "E", framework: "full_ifrs", currency: "TZS", currentPeriod: { startDate: "2025-01-01", endDate: "2025-12-31" }, reviewedAccountLines: unbalanced() };

describe("persistence gate", () => {
  it("is off in source, so persisted saving is unavailable", () => {
    expect(FINANCIAL_STATEMENT_PERSISTENCE_ENABLED).toBe(false);
    expect(initialPersistenceState()).toBe("UNAVAILABLE");
  });

  it("refuses every write before any network call while disabled", async () => {
    const transport: PersistenceTransport = { select: vi.fn(async () => []), invoke: vi.fn(async () => undefined) };
    const repo = new RemoteFinancialStatementReportRepository(transport);
    const { snapshot } = await prepareTrialBalanceReport(params, new InMemoryFinancialStatementReportRepository());
    await expect(repo.saveReport(snapshot)).rejects.toThrow(PersistenceUnavailableError);
    await expect(repo.appendDecision("x", { decisionId: "d", decisionType: "DEFER", reviewerId: "r", decidedAt: "t" })).rejects.toThrow();
    expect(transport.invoke).not.toHaveBeenCalled();
  });
});

describe("serialization is decimal-safe", () => {
  it("round-trips a report with bigint money exactly and re-validates it", async () => {
    const { snapshot } = await prepareTrialBalanceReport(params, new InMemoryFinancialStatementReportRepository());
    const json = serializeDocument(snapshot.report);
    expect(json).toContain('"__bigint__"');
    expect(json).not.toMatch(/"minorUnits":\d/); // never a JSON number
    const back = deserializeReport(json);
    expect(back).toEqual(snapshot.report);
  });

  it("rejects a tampered stored document rather than trusting it", async () => {
    const { snapshot } = await prepareTrialBalanceReport(params, new InMemoryFinancialStatementReportRepository());
    const tampered = serializeDocument({ ...snapshot.report, framework: { kind: "NOPE" } });
    expect(() => deserializeReport(tampered)).toThrow();
    expect(parseDocument('{"a":{"__bigint__":"12345678901234567890"}}')).toEqual({ a: 12345678901234567890n });
  });
});

describe("write requests never carry an actor id", () => {
  it("strips reviewerId from decisions and none of the request types has an actor field", async () => {
    const { snapshot } = await prepareTrialBalanceReport(params, new InMemoryFinancialStatementReportRepository());
    const req = toAppendDecisionRequest("rid", "c1", { decisionId: "d1", decisionType: "DEFER", reviewerId: "firm-member-secret", decidedAt: "t" });
    expect(JSON.stringify(req)).not.toContain("firm-member-secret");
    expect(JSON.stringify(toSaveReportRequest(snapshot))).not.toMatch(/firm_?member|reviewerId|createdBy/i);
  });
});

describe("persistence error states", () => {
  it("distinguishes permission, stale version and unavailable", () => {
    expect(classifyPersistenceError(new PersistencePermissionError())).toBe("PERMISSION_DENIED");
    expect(classifyPersistenceError(new PersistenceStaleVersionError())).toBe("STALE_VERSION");
    expect(classifyPersistenceError(new PersistenceUnavailableError())).toBe("UNAVAILABLE");
    expect(classifyPersistenceError({ code: "42501", message: "FORBIDDEN: firm member x is not an accepted member" })).toBe("PERMISSION_DENIED");
    expect(classifyPersistenceError({ code: "PT409", message: "STALE_REPORT_VERSION: expected version 3" })).toBe("STALE_VERSION");
    expect(classifyPersistenceError(new Error("network down"))).toBe("UNAVAILABLE");
  });

  it("maps server errors from an enabled repository to typed errors, never to success", async () => {
    const { snapshot } = await prepareTrialBalanceReport(params, new InMemoryFinancialStatementReportRepository());
    for (const [serverError, expected] of [
      [{ code: "42501", message: "FORBIDDEN" }, PersistencePermissionError],
      [{ code: "PT409", message: "STALE_REPORT_VERSION" }, PersistenceStaleVersionError],
    ] as const) {
      const repo = new RemoteFinancialStatementReportRepository({ select: async () => [], invoke: async () => { throw serverError; } }, true);
      await expect(repo.saveReport(snapshot)).rejects.toThrow(expected);
    }
  });
});

describe("reviewer decisions", () => {
  async function setup() {
    const repo = new InMemoryFinancialStatementReportRepository();
    const { snapshot } = await prepareTrialBalanceReport(params, repo);
    const run = await evaluateReport(snapshot, repo);
    const finding = run.findings.find((f) => f.ruleId === "sfp-equation")!;
    return { repo, snapshot, run, finding };
  }
  const input = (over: Partial<Parameters<typeof buildDecisionCommand>[0]> & Pick<Parameters<typeof buildDecisionCommand>[0], "outcome" | "finding" | "report">) => ({ rationale: "documented reason", decisionId: "d-" + Math.random(), decidedAt: "2026-01-01T00:00:00.000Z", reviewerId: "fm-1", ...over });

  it("the seeded defect is a blocking FAIL", async () => {
    const { finding } = await setup();
    expect(finding.outcome).toBe("FAIL");
  });

  it("requires a documented rationale for every outcome", async () => {
    const { snapshot, finding } = await setup();
    for (const outcome of ["ACCEPT_WITH_JUDGEMENT", "NOT_APPLICABLE", "UNRESOLVED", "CORRECTED"] as const) {
      expect(() => buildDecisionCommand(input({ outcome, finding, report: snapshot.report, rationale: "   " }))).toThrow(DecisionCommandError);
    }
  });

  it("'accepted with judgement' moves the finding to Resolved but never conceals the unchanged defect", async () => {
    const { repo, snapshot, run, finding } = await setup();
    const cmd = buildDecisionCommand(input({ outcome: "ACCEPT_WITH_JUDGEMENT", finding, report: snapshot.report }));
    expect(cmd.kind).toBe("STANDALONE");
    if (cmd.kind === "STANDALONE" && cmd.decision.decisionType !== "CORRECT_FACT") await recordReviewerDecision(snapshot.report.reportIdentity.reportId, cmd.decision as never, repo);
    const stored = (await repo.getByReportId(snapshot.report.reportIdentity.reportId))!;
    const view = buildFindingViews(run.findings, stored.decisions).find((v) => v.record.findingKey === finding.findingKey)!;
    expect(view.bucket).toBe("RESOLVED");
    expect(view.reviewLabel).toBe("Accepted with documented judgement");
    expect(view.record.outcome).toBe("FAIL"); // the defect is still visible
    // Re-evaluating the unchanged report still FAILs.
    const rerun = await evaluateReport(stored, repo);
    expect(rerun.findings.find((f) => f.findingKey === finding.findingKey)?.outcome).toBe("FAIL");
  });

  it("maps 'not applicable' and 'unresolved' onto the canonical decision types", async () => {
    const { snapshot, finding } = await setup();
    expect((buildDecisionCommand(input({ outcome: "NOT_APPLICABLE", finding, report: snapshot.report })) as { decision: { decisionType: string } }).decision.decisionType).toBe("REJECT_FINDING");
    expect((buildDecisionCommand(input({ outcome: "UNRESOLVED", finding, report: snapshot.report })) as { decision: { decisionType: string } }).decision.decisionType).toBe("DEFER");
  });

  it("a correction is the only path that changes the outcome: it re-derives dependent totals atomically and the finding follows by findingKey", async () => {
    const { repo, snapshot, finding, run } = await setup();
    const detail = "fact:detail:sfp:2:CURRENT"; // payables 30.00 -> 50.00 so that 100 = 50 + 50
    const cmd = buildDecisionCommand(input({ outcome: "CORRECTED", finding: { ...finding, evidenceReferences: [...finding.evidenceReferences, { evidenceReferenceId: "x", factId: detail }] }, report: snapshot.report, correction: { factId: detail, correctedAmount: "50.00" } }));
    if (cmd.kind !== "CORRECTION") throw new Error("expected a correction");
    const corrected = await correctFactAndRecast({ reportId: snapshot.report.reportIdentity.reportId, decision: cmd.decision, provenance: cmd.provenance, reviewedAccountLines: unbalanced(), repo });
    // leaf + subtotal(current liabilities) + total_liabilities + total_liabilities_and_equity = 4 corrections, one version each.
    expect(corrected.decisions).toHaveLength(4);
    expect(corrected.report.reportIdentity.reportVersion).toBe(5);
    expect(corrected.decisions.slice(1).every((d) => d.decisionType === "CORRECT_FACT" && d.rationale!.includes(cmd.decision.decisionId))).toBe(true);

    const run2 = await evaluateReport(corrected, repo);
    expect(run2.reportVersion).toBe(5);
    expect(run2.evaluationRunId).not.toBe(run.evaluationRunId);
    const after = run2.findings.find((f) => f.findingKey === finding.findingKey)!;
    expect(after.outcome).toBe("PASS"); // same durable findingKey, now passing
    expect(run2.findings.filter((f) => f.ruleId === "subtotal-casting").every((f) => f.outcome === "PASS")).toBe(true);
    const view = buildFindingViews(run2.findings, corrected.decisions).find((v) => v.record.findingKey === finding.findingKey)!;
    expect(view.bucket).toBe("PASSED");
  });

  it("refuses to correct a derived total directly (correct the source account instead)", async () => {
    const { repo, snapshot } = await setup();
    const derived = "fact:total:sfp:total_liabilities:CURRENT";
    const derivedFact = snapshot.report.facts.find((f) => f.factId === derived)!;
    await expect(
      correctFactAndRecast({
        reportId: snapshot.report.reportIdentity.reportId,
        decision: { decisionId: "d", decisionType: "CORRECT_FACT", reviewerId: "r", decidedAt: "t", factId: derived, supersedesVersion: 1, newVersion: 2, correctedValue: { ...derivedFact.value!, minorUnits: 1n }, rationale: "x", expectedReportVersion: 1 },
        provenance: derivedFact.provenance,
        reviewedAccountLines: unbalanced(),
        repo,
      }),
    ).rejects.toThrow(/derived figure/);
  });

  it("a correction formed against a stale report version is refused", async () => {
    const { repo, snapshot, finding } = await setup();
    const detail = "fact:detail:sfp:2:CURRENT";
    const f = { ...finding, evidenceReferences: [{ evidenceReferenceId: "x", factId: detail }] };
    const first = buildDecisionCommand(input({ outcome: "CORRECTED", finding: f, report: snapshot.report, correction: { factId: detail, correctedAmount: "50.00" } }));
    const second = buildDecisionCommand(input({ outcome: "CORRECTED", finding: f, report: snapshot.report, correction: { factId: detail, correctedAmount: "40.00" } }));
    if (first.kind !== "CORRECTION" || second.kind !== "CORRECTION") throw new Error("expected corrections");
    await correctReportFact(snapshot.report.reportIdentity.reportId, first.decision, first.provenance, repo);
    let error: unknown;
    try {
      await correctReportFact(snapshot.report.reportIdentity.reportId, second.decision, second.provenance, repo);
    } catch (e) {
      error = e;
    }
    expect(isStaleVersionError(error)).toBe(true);
  });

  it("rejects corrections to figures outside the finding's evidence, bad amounts and no-ops", async () => {
    const { snapshot, finding } = await setup();
    const detail = "fact:detail:sfp:2:CURRENT";
    const f = { ...finding, evidenceReferences: [{ evidenceReferenceId: "x", factId: detail }] };
    const code = (c: Parameters<typeof buildDecisionCommand>[0]) => { try { buildDecisionCommand(c); } catch (e) { return (e as DecisionCommandError).code; } return "none"; };
    expect(code(input({ outcome: "CORRECTED", finding: f, report: snapshot.report, correction: { factId: "fact:detail:sfp:1:CURRENT", correctedAmount: "1.00" } }))).toBe("FACT_NOT_IN_FINDING");
    expect(code(input({ outcome: "CORRECTED", finding: f, report: snapshot.report, correction: { factId: detail, correctedAmount: "12.345" } }))).toBe("INVALID_AMOUNT");
    expect(code(input({ outcome: "CORRECTED", finding: f, report: snapshot.report, correction: { factId: detail, correctedAmount: "30.00" } }))).toBe("NO_CHANGE");
    expect(code(input({ outcome: "CORRECTED", finding: f, report: snapshot.report }))).toBe("FACT_REQUIRED");
  });
});
