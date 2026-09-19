import { describe, expect, it } from "vitest";
import { ZERO_TOLERANCE } from "@/lib/canonicalStatement/money";
import type { CanonicalFinancialStatementReport, CorrectFactDecision } from "@/lib/canonicalStatement/types";
import { applyEvidence } from "@/lib/financialGeneration/applyEvidence";
import { ingestEvidence } from "@/lib/financialEvidence/intake";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";
import { correctFactAndRecast, evaluateReportPure, prepareTrialBalanceReport } from "./evaluationOrchestrator";
import { profileForKind } from "./frameworkProfiles";
import { contentHashOf } from "./persistenceContract";
import { InMemoryFinancialStatementReportRepository } from "./reportRepository";
import type { StoredDecisionRow, StoredEvidenceRow, StoredReportRow } from "./rpcTransport";
import { generatedFromStoredReport, historicalView, restoreLatestDraft } from "./savedVersions";
import type { ReviewedTrialBalanceAccountLine } from "./trialBalanceAdapter";

const COMPANY = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const EPOCH = () => "1970-01-01T00:00:00.000Z";
const profile = profileForKind("IFRS_FOR_SMES");

const line = (o: Partial<ReviewedTrialBalanceAccountLine> & Pick<ReviewedTrialBalanceAccountLine, "accountKey" | "accountName" | "statement" | "classification" | "normalBalance" | "balance">): ReviewedTrialBalanceAccountLine => ({
  currency: "TZS", scale: 2, periodId: "CURRENT", isComparative: false, isCashAccount: false, isRetainedEarnings: false, isPayrollAccount: false, sourceUploadId: "u1", sourceHash: "a".repeat(64), ...o,
});
const TB = (cash = 5_000_000) => [
  line({ accountKey: "1000", accountName: "Cash", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: cash, isCashAccount: true }),
  line({ accountKey: "1500", accountName: "PPE", statement: "balance_sheet", classification: "non_current_assets", normalBalance: "debit", balance: 10_000_000 }),
  line({ accountKey: "2000", accountName: "Payables", statement: "balance_sheet", classification: "current_liabilities", normalBalance: "credit", balance: 7_000_000 }),
  line({ accountKey: "3000", accountName: "Share capital", statement: "balance_sheet", classification: "equity", normalBalance: "credit", balance: 8_000_000 }),
  line({ accountKey: "4000", accountName: "Sales", statement: "income_statement", classification: "revenue", normalBalance: "credit", balance: 12_000_000 }),
  line({ accountKey: "6000", accountName: "Opex", statement: "income_statement", classification: "operating_expenses", normalBalance: "debit", balance: 9_000_000 }),
];
async function base(cash?: number) {
  const repo = new InMemoryFinancialStatementReportRepository();
  return (await prepareTrialBalanceReport({ companyId: COMPANY, periodYear: 2025, entityLegalName: "Acme", framework: "ifrs_for_smes", currency: "TZS", currentPeriod: { startDate: "2025-01-01", endDate: "2025-12-31" }, comparativePeriods: [], reviewedAccountLines: TB(cash) }, repo)).snapshot.report;
}
const LEDGER = "transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line\nT1,2025-03-01,1000,Customers,12000000,,OPERATING,Receipts from customers\nT2,2025-04-01,1000,Suppliers,,7000000,OPERATING,Payments to suppliers\n";
const OPENING = "statement_type,line_key,line_label,amount\nFINANCIAL_POSITION,cash_and_cash_equivalents_sfp,Cash,0\n";
function batch(evidenceType: "TRANSACTION_LEDGER" | "PRIOR_PERIOD_STATEMENTS", text: string, periodRole: "CURRENT" | "COMPARATIVE", reportingPeriodId: string): EvidenceBatch {
  const r = ingestEvidence({ companyId: COMPANY, evidenceType, periodRole, reportingPeriodId, currency: "TZS", scale: 2, text });
  if (r.outcome !== "PARSED") throw new Error("rejected");
  return r.batch;
}
const evidenceRow = (b: EvidenceBatch, version = 1): StoredEvidenceRow => ({
  evidenceBatchId: b.evidenceBatchId, evidenceType: b.evidenceType, periodRole: b.periodRole, reportingPeriodId: b.reportingPeriodId, seriesKey: b.seriesKey, schemaVersion: b.schemaVersion, version,
  validationStatus: b.validationStatus, contentHash: b.contentHash, replayIdentity: b.replayIdentity, supersedesBatchId: null, diagnostics: b.diagnostics, document: b.document, sourceFileName: b.sourceFileName, currency: b.currency, scale: b.scale, createdAt: "2026-01-01T00:00:00Z",
});
const compose = (b: CanonicalFinancialStatementReport | null, ev: readonly EvidenceBatch[]) => (b ? applyEvidence({ report: b, profile, evidence: ev, cashAccountKeys: ["1000"] }).report : null);
const withVersion = (r: CanonicalFinancialStatementReport, v: number) => ({ ...r, reportIdentity: { ...r.reportIdentity, reportVersion: v } });

async function savedFixture() {
  const b = await base();
  const ledger = batch("TRANSACTION_LEDGER", LEDGER, "CURRENT", "FY2025");
  const opening = batch("PRIOR_PERIOD_STATEMENTS", OPENING, "COMPARATIVE", "FY2024");
  const effective = withVersion(compose(b, [ledger, opening])!, 3);
  const stored: StoredReportRow = { report: effective, reportVersion: 3, contentHash: contentHashOf(effective), createdAt: "2026-01-01T00:00:00Z", companyId: COMPANY, evidenceBatchIds: [ledger.evidenceBatchId, opening.evidenceBatchId] };
  return { b, ledger, opening, effective, stored, rows: [evidenceRow(ledger), evidenceRow(opening)] };
}

describe("restoreLatestDraft", () => {
  it("rebuilds an editable session that reproduces the stored version exactly", async () => {
    const f = await savedFixture();
    const out = restoreLatestDraft({ companyId: COMPANY, freshBase: f.b, stored: f.stored, decisions: [], evidenceRows: f.rows, compose });
    expect(out.kind).toBe("RESTORED");
    if (out.kind !== "RESTORED") return;
    expect(out.session.saved.storedVersion).toBe(3);
    expect(out.session.evidence.every((e) => e.saved)).toBe(true);
    expect(contentHashOf(withVersion(out.session.effectiveReport, 3))).toBe(f.stored.contentHash);
  });

  it("restores stored fact corrections (taken from the stored report) and marks their decisions as already saved", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    const prepared = (await prepareTrialBalanceReport({ companyId: COMPANY, periodYear: 2025, entityLegalName: "Acme", framework: "ifrs_for_smes", currency: "TZS", currentPeriod: { startDate: "2025-01-01", endDate: "2025-12-31" }, comparativePeriods: [], reviewedAccountLines: TB() }, repo)).snapshot;
    const b = prepared.report;
    const cashFact = b.facts.find((f) => f.factId.startsWith("fact:detail:sfp:1000"))!;
    const decision: CorrectFactDecision = { decisionId: "corr-1", decisionType: "CORRECT_FACT", reviewerId: "fm-1", decidedAt: "2026-01-01T00:00:00Z", factId: cashFact.factId, supersedesVersion: 1, newVersion: 2, correctedValue: { ...cashFact.value!, minorUnits: 510_000_000n }, rationale: "agreed to bank", expectedReportVersion: 1 };
    const fixed = await correctFactAndRecast({ reportId: b.reportIdentity.reportId, decision, provenance: { source: { sourceDocumentId: "manual", sourceHash: "b".repeat(64), artifactKind: "TRIAL_BALANCE" }, locator: { kind: "MANUAL", note: "reviewer" }, extractionMethod: "MANUAL_REVIEWER_ENTRY", extractionConfidence: { kind: "CERTAIN" }, originalText: "5100000.00" }, reviewedAccountLines: TB(), repo });
    const ledger = batch("TRANSACTION_LEDGER", LEDGER, "CURRENT", "FY2025");
    const opening = batch("PRIOR_PERIOD_STATEMENTS", OPENING, "COMPARATIVE", "FY2024");
    const effective = withVersion(compose(fixed.report, [ledger, opening])!, 2);
    const stored: StoredReportRow = { report: effective, reportVersion: 2, contentHash: contentHashOf(effective), createdAt: "t", companyId: COMPANY, evidenceBatchIds: [ledger.evidenceBatchId, opening.evidenceBatchId] };
    const rows: StoredDecisionRow[] = fixed.decisions.map((d, i) => ({ decisionId: d.decisionId, decision: d, reviewerFirmMemberId: "fm-1", correctionGroupId: "g1", seq: i + 1 }));
    expect(rows.length).toBeGreaterThan(0);
    const out = restoreLatestDraft({ companyId: COMPANY, freshBase: b, stored, decisions: rows, evidenceRows: [evidenceRow(ledger), evidenceRow(opening)], compose });
    expect(out.kind, JSON.stringify(out.kind === "DIVERGED" ? out.reason : "")).toBe("RESTORED");
    if (out.kind !== "RESTORED") return;
    expect(out.session.baseReport!.facts.some((x) => x.factId === cashFact.factId && x.version === 2)).toBe(true);
    expect(out.session.saved.storedDecisionIds.has("corr-1")).toBe(true);
    expect(out.session.baseDecisions.map((d) => d.decisionId)).toEqual(fixed.decisions.map((d) => d.decisionId));
  });

  it("a correction from an earlier lineage state that the latest report does not contain is history, not part of the draft", async () => {
    const f = await savedFixture();
    const decision: CorrectFactDecision = { decisionId: "old-corr", decisionType: "CORRECT_FACT", reviewerId: "fm-1", decidedAt: "2025-12-01T00:00:00Z", factId: "fact:detail:sfp:1000:CURRENT", supersedesVersion: 1, newVersion: 2, correctedValue: null, rationale: "earlier session", expectedReportVersion: 1 };
    const out = restoreLatestDraft({ companyId: COMPANY, freshBase: f.b, stored: f.stored, decisions: [{ decisionId: "old-corr", decision, reviewerFirmMemberId: "fm-1", correctionGroupId: "g0", seq: 1 }], evidenceRows: f.rows, compose });
    expect(out.kind).toBe("RESTORED");
    if (out.kind === "RESTORED") {
      expect(out.session.baseDecisions).toEqual([]);
      expect(out.session.saved.storedDecisionIds.has("old-corr")).toBe(true); // stored, so never re-sent
    }
  });

  it("DIVERGED when the trial balance changed since saving (never silently repaired)", async () => {
    const f = await savedFixture();
    const changed = await base(5_100_000);
    const out = restoreLatestDraft({ companyId: COMPANY, freshBase: changed, stored: f.stored, decisions: [], evidenceRows: f.rows, compose });
    expect(out).toMatchObject({ kind: "DIVERGED", storedVersion: 3 });
    expect(out.kind === "DIVERGED" && out.reason).toMatch(/no longer reproduces/);
  });

  it("DIVERGED when a referenced evidence version cannot be read", async () => {
    const f = await savedFixture();
    expect(restoreLatestDraft({ companyId: COMPANY, freshBase: f.b, stored: f.stored, decisions: [], evidenceRows: [f.rows[0]], compose })).toMatchObject({ kind: "DIVERGED" });
  });

  it("newer evidence stored after the saved version is applied to the draft, which is then honestly unsaved", async () => {
    const f = await savedFixture();
    const newer = batch("TRANSACTION_LEDGER", LEDGER.replace("12000000", "12500000").replace("7000000", "7500000"), "CURRENT", "FY2025");
    const out = restoreLatestDraft({ companyId: COMPANY, freshBase: f.b, stored: f.stored, decisions: [], evidenceRows: [...f.rows, evidenceRow(newer, 2)], compose });
    expect(out.kind).toBe("RESTORED");
    if (out.kind !== "RESTORED") return;
    expect(out.session.unsavedChanges).toBe(true);
    expect(contentHashOf(withVersion(out.session.effectiveReport, 3))).not.toBe(f.stored.contentHash);
    expect(out.session.evidence.map((e) => e.batch.evidenceBatchId)).toContain(newer.evidenceBatchId);
  });

  it("an exact restore reports no unsaved changes", async () => {
    const f = await savedFixture();
    const out = restoreLatestDraft({ companyId: COMPANY, freshBase: f.b, stored: f.stored, decisions: [], evidenceRows: f.rows, compose });
    expect(out.kind === "RESTORED" && out.session.unsavedChanges).toBe(false);
  });

  it("refuses a stored report of another company", async () => {
    const f = await savedFixture();
    expect(restoreLatestDraft({ companyId: OTHER, freshBase: f.b, stored: f.stored, decisions: [], evidenceRows: f.rows, compose })).toMatchObject({ kind: "DIVERGED" });
  });
});

describe("historicalView", () => {
  it("shows a stored version exactly as stored: its own recorded evaluation, not a recomputation", async () => {
    const f = await savedFixture();
    const run = evaluateReportPure(f.effective, ZERO_TOLERANCE, EPOCH);
    const recorded = { evaluationRunId: run.evaluationRunId, reportVersion: 3, rulePackId: "OLD-PACK", rulePackVersion: "0.9.0", engineVersion: "old", inputHash: run.inputHash, findings: run.findings.slice(0, 1), createdAt: "2026-01-01T00:00:00Z" };
    const view = historicalView({ companyId: COMPANY, version: f.stored, isLatest: false, state: "REVIEWED", evaluations: [recorded], decisions: [], evidenceRows: [...f.rows, evidenceRow(batch("TRANSACTION_LEDGER", LEDGER.replace("Customers", "Other"), "CURRENT", "FY2025"))], publications: [] });
    expect(view).not.toBeNull();
    expect(view!.report).toBe(f.stored.report);
    expect(view!.findings).toEqual(run.findings.slice(0, 1)); // the recorded (older) evaluation, not today's rule pack
    expect(view!.evaluation!.rulePackVersion).toBe("0.9.0");
    expect(view!.evidence.map((b) => b.evidenceBatchId).sort()).toEqual(f.stored.evidenceBatchIds.slice().sort()); // only the evidence that version used
    expect(view!.state).toBe("REVIEWED");
    expect(view!.isLatest).toBe(false);
  });

  it("reports NO findings (not a fabricated pass) for a version that was never evaluated", async () => {
    const f = await savedFixture();
    const view = historicalView({ companyId: COMPANY, version: f.stored, isLatest: true, state: "DRAFT", evaluations: [], decisions: [], evidenceRows: f.rows, publications: [] });
    expect(view!.evaluation).toBeNull();
    expect(view!.findings).toEqual([]);
  });

  it("the newest publication row decides the state", async () => {
    const f = await savedFixture();
    const pubs = [{ reportVersion: 3, state: "REVIEWED" as const, reason: "r", createdAt: "t", seq: 1 }, { reportVersion: 3, state: "DRAFT" as const, reason: "reopened", createdAt: "t", seq: 2 }, { reportVersion: 2, state: "FINAL" as const, reason: "x", createdAt: "t", seq: 9 }];
    expect(historicalView({ companyId: COMPANY, version: f.stored, isLatest: true, state: "FINAL", evaluations: [], decisions: [], evidenceRows: f.rows, publications: pubs })!.state).toBe("DRAFT");
  });

  it("returns nothing for a version that belongs to another company", async () => {
    const f = await savedFixture();
    expect(historicalView({ companyId: OTHER, version: f.stored, isLatest: true, state: "DRAFT", evaluations: [], decisions: [], evidenceRows: f.rows, publications: [] })).toBeNull();
  });

  it("derives which generated statements a stored report already contains", async () => {
    const f = await savedFixture();
    const g = generatedFromStoredReport(f.effective);
    expect(Object.keys(g)).toContain("STATEMENT_OF_CASH_FLOWS");
    expect(Object.keys(generatedFromStoredReport(f.b))).toEqual([]);
  });
});
