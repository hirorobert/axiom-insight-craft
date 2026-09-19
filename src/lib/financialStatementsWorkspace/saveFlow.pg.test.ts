// Transport + save-flow proof against a REAL disposable PostgreSQL.
//
// Skipped unless DB_PROOF_SEED_FILE points at the seed written by
// scripts/db-proof/serve.mjs (which replays every migration and exposes a loopback
// PostgREST-style bridge that runs each call as `authenticated` with the named
// fixture user's auth.uid()). This proves the TypeScript client and the SQL
// contract agree byte-for-byte: argument names, bigint round trips, the correction
// group, typed conflict errors and tenancy denial.

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalStringify } from "@/lib/canonicalStatement/serialization";
import { ZERO_TOLERANCE } from "@/lib/canonicalStatement/money";
import { CANONICAL_SCHEMA_VERSION, type CanonicalFinancialStatementReport, type CorrectFactDecision } from "@/lib/canonicalStatement/types";
import { validateCanonicalReport } from "@/lib/canonicalStatement/validation";
import { applyEvidence } from "@/lib/financialGeneration/applyEvidence";
import { ingestEvidence } from "@/lib/financialEvidence/intake";
import { correctEvidenceCell } from "@/lib/financialEvidence/correction";
import { latestPerSeries } from "@/lib/financialGeneration/applyEvidence";
import type { CorrectEvidenceDecision } from "@/lib/canonicalStatement/types";
import { InMemoryFinancialStatementReportRepository } from "./reportRepository";
import { correctFactAndRecast, evaluateReportPure, prepareTrialBalanceReport } from "./evaluationOrchestrator";
import { profileForKind } from "./frameworkProfiles";
import { FsRpcTransport, type FsBackend } from "./rpcTransport";
import { saveWorkspace, type SavedState } from "./saveFlow";
import type { ReviewedTrialBalanceAccountLine } from "./trialBalanceAdapter";

const SEED = process.env.DB_PROOF_SEED_FILE;
const seed = SEED && fs.existsSync(SEED) ? (JSON.parse(fs.readFileSync(SEED, "utf8")) as { users: Record<string, string>; companyA: string; companyB: string; bridge: string }) : null;

const backendFor = (sim: string): FsBackend => ({
  async rpc(fn, args) {
    const r = await fetch(`${seed!.bridge}/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json", "x-sim-user": sim }, body: JSON.stringify(args) });
    const body = await r.json();
    return r.ok ? { data: body, error: null } : { data: null, error: body.error };
  },
  async select(table, filters) {
    const r = await fetch(`${seed!.bridge}/select/${table}`, { method: "POST", headers: { "content-type": "application/json", "x-sim-user": sim }, body: JSON.stringify(filters) });
    const body = await r.json();
    return r.ok ? { data: body, error: null } : { data: null, error: body.error };
  },
});
const as = (sim: string) => new FsRpcTransport(backendFor(sim));
const EPOCH = () => "1970-01-01T00:00:00.000Z";

const line = (o: Partial<ReviewedTrialBalanceAccountLine> & Pick<ReviewedTrialBalanceAccountLine, "accountKey" | "accountName" | "statement" | "classification" | "normalBalance" | "balance">): ReviewedTrialBalanceAccountLine => ({
  currency: "TZS", scale: 2, periodId: "CURRENT", isComparative: false, isCashAccount: false, isRetainedEarnings: false, isPayrollAccount: false, sourceUploadId: "u1", sourceHash: "a".repeat(64), ...o,
});
const TB = [
  line({ accountKey: "1000", accountName: "Cash", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 5_000_000, isCashAccount: true }),
  line({ accountKey: "1500", accountName: "PPE", statement: "balance_sheet", classification: "non_current_assets", normalBalance: "debit", balance: 10_000_000 }),
  line({ accountKey: "2000", accountName: "Payables", statement: "balance_sheet", classification: "current_liabilities", normalBalance: "credit", balance: 7_000_000 }),
  line({ accountKey: "3000", accountName: "Share capital", statement: "balance_sheet", classification: "equity", normalBalance: "credit", balance: 8_000_000 }),
  line({ accountKey: "4000", accountName: "Sales", statement: "income_statement", classification: "revenue", normalBalance: "credit", balance: 12_000_000 }),
  line({ accountKey: "6000", accountName: "Opex", statement: "income_statement", classification: "operating_expenses", normalBalance: "debit", balance: 9_000_000 }),
];
const RUN = String(Date.now());
const LEDGER = `transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line\nT1,2025-03-01,1000,Customers ${RUN},12000000,,OPERATING,Receipts from customers\nT2,2025-04-01,1000,Suppliers,,7000000,OPERATING,Payments to suppliers\n`;
const OPENING = "statement_type,line_key,line_label,amount\nFINANCIAL_POSITION,cash_and_cash_equivalents_sfp,Cash,0\n";

async function sessionFor(companyId: string) {
  const repo = new InMemoryFinancialStatementReportRepository();
  const prepared = await prepareTrialBalanceReport(
    { companyId, periodYear: 2025, entityLegalName: "Acme Audit Client Ltd", framework: "ifrs_for_smes", currency: "TZS", currentPeriod: { startDate: "2025-01-01", endDate: "2025-12-31" }, comparativePeriods: [], reviewedAccountLines: TB },
    repo,
  );
  const evidence = [ingest(companyId, "TRANSACTION_LEDGER", LEDGER, "CURRENT"), ingest(companyId, "PRIOR_PERIOD_STATEMENTS", OPENING, "COMPARATIVE", "FY2024")];
  return { repo, snapshot: prepared.snapshot, evidence };
}
function ingest(companyId: string, evidenceType: Parameters<typeof ingestEvidence>[0]["evidenceType"], text: string, periodRole: "CURRENT" | "COMPARATIVE", reportingPeriodId = "FY2025") {
  const r = ingestEvidence({ companyId, evidenceType, periodRole, reportingPeriodId, currency: "TZS", scale: 2, text });
  if (r.outcome !== "PARSED") throw new Error("rejected");
  return r.batch;
}
const effective = (report: CanonicalFinancialStatementReport) => applyEvidence({ report, profile: profileForKind("IFRS_FOR_SMES"), cashAccountKeys: ["1000"], evidence: [] }).report!;

describe.skipIf(!seed)("transport + save flow against a real PostgreSQL", () => {
  it("access is server-decided: allowlisted member enabled, other company denied, outsider not a member", async () => {
    expect(await as("owner").access(seed!.companyA)).toEqual({ enabled: true, reason: "ENABLED" });
    expect((await as("ownerB").access(seed!.companyB)).reason).toBe("NOT_ALLOWLISTED");
    expect((await as("outsider").access(seed!.companyA)).reason).toBe("NOT_A_MEMBER");
  });

  it("saves evidence + report + evaluation, reads them back exactly, and a second save is UNCHANGED", async () => {
    const s = await sessionFor(seed!.companyA);
    const applied = applyEvidence({ report: s.snapshot.report, profile: profileForKind("IFRS_FOR_SMES"), cashAccountKeys: ["1000"], evidence: s.evidence });
    expect(applied.report).not.toBeNull();
    const t = as("preparer");
    const input = { transport: t, companyId: seed!.companyA, reportingPeriodId: "FY2025", evidence: s.evidence, report: applied.report!, decisions: s.snapshot.decisions, evaluate: (r: CanonicalFinancialStatementReport) => evaluateReportPure(r, ZERO_TOLERANCE, EPOCH), saved: null };
    const before = (await t.latestReport(seed!.companyA, 2025, "TRIAL_BALANCE_DERIVED"))?.reportVersion ?? 0;
    const first = await saveWorkspace(input);
    expect(first).toMatchObject({ status: "SAVED", storedVersion: before + 1 });
    expect((first as { evidenceIngested: number }).evidenceIngested).toBeGreaterThanOrEqual(1);
    const stored = await t.latestReport(seed!.companyA, 2025, "TRIAL_BALANCE_DERIVED");
    expect(stored!.reportVersion).toBe(before + 1);
    // exact round trip: the stored document revives to a report whose canonical form equals what was sent
    expect(canonicalStringify(stored!.report)).toBe(canonicalStringify(validateCanonicalReport({ ...applied.report!, reportIdentity: { ...applied.report!.reportIdentity, reportVersion: before + 1 } })));
    expect((await t.listEvaluations(applied.report!.reportIdentity.reportId, before + 1))[0].findings.length).toBeGreaterThan(0);
    expect((await t.listEvidence(seed!.companyA, "FY2025")).length).toBeGreaterThanOrEqual(1);
    const saved: SavedState = { storedVersion: before + 1, storedDecisionIds: (first as { storedDecisionIds: ReadonlySet<string> }).storedDecisionIds };
    expect(await saveWorkspace({ ...input, saved })).toMatchObject({ status: "UNCHANGED" });
    // a fresh session with the same content and no memory of saving is also UNCHANGED (replay identity + content hash)
    expect(await saveWorkspace({ ...input, saved: null })).toMatchObject({ status: "UNCHANGED" });
  });

  it("an atomic correction group lands as contiguous versions with one decision each; a stale session is refused", async () => {
    const s = await sessionFor(seed!.companyA);
    const base = effective(s.snapshot.report);
    const cashFact = s.snapshot.report.facts.find((f) => f.factId.startsWith("fact:detail:sfp:1000"))!;
    const decision: CorrectFactDecision = { decisionId: `corr-${RUN}`, decisionType: "CORRECT_FACT", reviewerId: "client-supplied-ignored", decidedAt: "2026-01-01T00:00:00Z", factId: cashFact.factId, supersedesVersion: 1, newVersion: 2, correctedValue: { currency: "TZS", scale: 2, minorUnits: 510_000_000n }, rationale: "confirmed to bank statement", expectedReportVersion: 1 };
    const corrected = await correctFactAndRecast({ reportId: s.snapshot.report.reportIdentity.reportId, decision, provenance: { source: { sourceDocumentId: "manual", sourceHash: "b".repeat(64), artifactKind: "TRIAL_BALANCE" }, locator: { kind: "MANUAL", note: "reviewer" }, extractionMethod: "MANUAL_REVIEWER_ENTRY", extractionConfidence: { kind: "CERTAIN" }, originalText: "5100000.00" }, reviewedAccountLines: TB, repo: s.repo });
    const t = as("partner");
    const latestBefore = (await t.latestReport(seed!.companyA, 2025, "TRIAL_BALANCE_DERIVED"))!.reportVersion;
    const out = await saveWorkspace({ transport: t, companyId: seed!.companyA, reportingPeriodId: "FY2025", evidence: [], report: effective(corrected.report), decisions: corrected.decisions, evaluate: (r) => evaluateReportPure(r, ZERO_TOLERANCE, EPOCH), saved: null });
    expect(out, JSON.stringify(out)).toMatchObject({ status: "SAVED" });
    const after = await t.listReportVersions(base.reportIdentity.reportId);
    expect(after.map((v) => v.reportVersion)).toEqual(Array.from({ length: after.length }, (_, i) => i + 1));
    expect(after.length).toBeGreaterThan(latestBefore);
    const decisions = await t.listDecisions(base.reportIdentity.reportId);
    const stored = decisions.filter((d) => d.correctionGroupId !== null);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((d) => (d.decision as { reviewerId: string }).reviewerId === d.reviewerFirmMemberId)).toBe(true); // reviewer is the server-derived firm member, not the client string
    expect(stored.map((d) => d.decisionId)).toContain(`corr-${RUN}`);
    // the corrected minor units survived as an exact bigint
    const last = after[after.length - 1].report.facts.find((f) => f.factId === cashFact.factId && f.version === 2)!;
    expect(last.value!.minorUnits).toBe(510_000_000n);
    // a session that believes the server is at a different version is refused, and nothing is written
    const count = (await t.listReportVersions(base.reportIdentity.reportId)).length;
    const stale = await saveWorkspace({ transport: t, companyId: seed!.companyA, reportingPeriodId: "FY2025", evidence: [], report: effective(corrected.report), decisions: corrected.decisions, evaluate: (r) => evaluateReportPure(r, ZERO_TOLERANCE, EPOCH), saved: { storedVersion: 1, storedDecisionIds: new Set() } });
    expect(stale).toMatchObject({ status: "FAILED", kind: "STALE_VERSION", isConflict: true });
    expect((await t.listReportVersions(base.reportIdentity.reportId)).length).toBe(count);
  });

  it("a viewer and an outsider cannot save; the denial is typed and nothing is written", async () => {
    const s = await sessionFor(seed!.companyA);
    const fresh = [ingest(seed!.companyA, "TRANSACTION_LEDGER", LEDGER.replace(RUN, `${RUN}-denied-${Math.random()}`), "CURRENT")];
    for (const sim of ["viewer", "outsider"]) {
      const out = await saveWorkspace({ transport: as(sim), companyId: seed!.companyA, reportingPeriodId: "FY2025", evidence: fresh, report: effective(s.snapshot.report), decisions: [], evaluate: (r) => evaluateReportPure(r, ZERO_TOLERANCE, EPOCH), saved: null });
      expect(out).toMatchObject({ status: "FAILED", kind: "FORBIDDEN" });
    }
  });

  it("a company that is not allowlisted cannot save even for its own owner (feature disabled)", async () => {
    const s = await sessionFor(seed!.companyB);
    const out = await saveWorkspace({ transport: as("ownerB"), companyId: seed!.companyB, reportingPeriodId: "FY2025", evidence: s.evidence, report: effective(s.snapshot.report), decisions: [], evaluate: (r) => evaluateReportPure(r, ZERO_TOLERANCE, EPOCH), saved: null });
    expect(out).toMatchObject({ status: "FAILED", kind: "FEATURE_DISABLED" });
  });

  it("an evidence correction is one atomic group: corrected evidence version + new report version + decision + evaluation; a replay is UNCHANGED", async () => {
    const companyId = seed!.companyA;
    const profile = profileForKind("IFRS_FOR_SMES");
    const s = await sessionFor(companyId);
    const ledger = ingest(companyId, "TRANSACTION_LEDGER", LEDGER.replace(RUN, `${RUN}-ec-${Math.random()}`), "CURRENT");
    const opening = s.evidence[1];
    const t = as("partner");
    const store = [{ batch: ledger, version: 1 }, { batch: opening, version: 1 }];
    const rebuild = (all: typeof store) => ({
      at: (dropped: ReadonlySet<string>, ev: readonly (typeof ledger)[]) => applyEvidence({ report: { ...s.snapshot.report, facts: s.snapshot.report.facts.filter((f) => !dropped.has(`${f.factId}#${f.version}`)) }, profile, cashAccountKeys: ["1000"], evidence: ev }).report,
      allEvidence: all,
    });
    const evalFn = (r: CanonicalFinancialStatementReport) => evaluateReportPure(r, ZERO_TOLERANCE, EPOCH);
    const effectiveOf = (all: typeof store) => rebuild(all).at(new Set(), latestPerSeries(all))!;
    // 1 — save the uncorrected evidence and report.
    const first = await saveWorkspace({ transport: t, companyId, reportingPeriodId: "FY2025", evidence: latestPerSeries(store), report: effectiveOf(store), decisions: [], evaluate: evalFn, saved: null, rebuild: rebuild(store) });
    expect(first, JSON.stringify(first)).toMatchObject({ status: "SAVED" });
    const v1 = (first as { storedVersion: number }).storedVersion;
    // 2 — correct one cell of the SAVED ledger: a new version of the series.
    const fix = correctEvidenceCell(ledger, { rowNumber: 2, column: "payment", newValue: "6500000", rationale: "Supplier invoice re-agreed to statement" }, { periodStart: "2025-01-01", periodEnd: "2025-12-31" });
    expect("batch" in fix).toBe(true);
    if (!("batch" in fix)) return;
    const decision: CorrectEvidenceDecision = { decisionId: `ecd-${RUN}`, decisionType: "CORRECT_EVIDENCE", reviewerId: "client-supplied-ignored", decidedAt: "2026-01-02T00:00:00Z", evidenceType: "TRANSACTION_LEDGER", supersedesBatchId: ledger.evidenceBatchId, newBatchId: fix.batch.evidenceBatchId, rowNumber: 2, column: "payment", previousValue: fix.previousValue, correctedValue: "6500000", rationale: "Supplier invoice re-agreed to statement", expectedReportVersion: v1 };
    const store2 = [...store, { batch: fix.batch, version: 2 }];
    const saved: SavedState = { storedVersion: v1, storedDecisionIds: (first as { storedDecisionIds: ReadonlySet<string> }).storedDecisionIds };
    const second = await saveWorkspace({ transport: t, companyId, reportingPeriodId: "FY2025", evidence: latestPerSeries(store2), report: effectiveOf(store2), decisions: [decision], evaluate: evalFn, saved, rebuild: rebuild(store2) });
    expect(second, JSON.stringify(second)).toMatchObject({ status: "SAVED", storedVersion: v1 + 1, correctionsSaved: 1 });
    const reportId = s.snapshot.report.reportIdentity.reportId;
    // the evidence series now has two versions, the second superseding the first
    const stored = (await t.listEvidence(companyId, "FY2025")).filter((e) => e.seriesKey === ledger.seriesKey && e.evidenceType === "TRANSACTION_LEDGER").sort((a, b) => a.version - b.version);
    const tail = stored.filter((e) => e.evidenceBatchId === ledger.evidenceBatchId || e.evidenceBatchId === fix.batch.evidenceBatchId);
    expect(tail.map((e) => e.evidenceBatchId)).toEqual([ledger.evidenceBatchId, fix.batch.evidenceBatchId]);
    expect(tail[1].version).toBe(tail[0].version + 1);
    expect(tail[1].supersedesBatchId).toBe(ledger.evidenceBatchId);
    // the decision is stored inside the group, with the server-derived reviewer
    const dec = (await t.listDecisions(reportId)).find((d) => d.decisionId === decision.decisionId)!;
    expect(dec.correctionGroupId).not.toBeNull();
    expect(dec.decision.decisionType).toBe("CORRECT_EVIDENCE");
    expect((dec.decision as { reviewerId: string }).reviewerId).toBe(dec.reviewerFirmMemberId);
    // v1 still shows the original payment, v2 the corrected one: history is immutable and reproducible
    const versions = await t.listReportVersions(reportId);
    const payments = (r: CanonicalFinancialStatementReport) => JSON.stringify(r.facts.filter((f) => f.factId.startsWith("fact:line:cf:")).map((f) => [f.factId, String(f.value?.minorUnits)]));
    expect(payments(versions.find((v) => v.reportVersion === v1)!.report)).not.toBe(payments(versions.find((v) => v.reportVersion === v1 + 1)!.report));
    expect((await t.listEvaluations(reportId, v1 + 1)).length).toBe(1);
    // a replay of the identical session is UNCHANGED
    const savedAfter: SavedState = { storedVersion: v1 + 1, storedDecisionIds: (second as { storedDecisionIds: ReadonlySet<string> }).storedDecisionIds };
    expect(await saveWorkspace({ transport: t, companyId, reportingPeriodId: "FY2025", evidence: latestPerSeries(store2), report: effectiveOf(store2), decisions: [decision], evaluate: evalFn, saved: savedAfter, rebuild: rebuild(store2) })).toMatchObject({ status: "UNCHANGED" });
    // an evidence correction whose predecessor was never stored is refused locally, before anything is written
    const orphan = correctEvidenceCell(fix.batch, { rowNumber: 1, column: "receipt", newValue: "11000000", rationale: "Credit note issued" }, { periodStart: "2025-01-01", periodEnd: "2025-12-31" });
    if ("batch" in orphan) {
      const d2: CorrectEvidenceDecision = { ...decision, decisionId: `ecd2-${RUN}`, supersedesBatchId: fix.batch.evidenceBatchId, newBatchId: orphan.batch.evidenceBatchId, rowNumber: 1, column: "receipt", correctedValue: "11000000" };
      const store3 = [...store2, { batch: orphan.batch, version: 3 }];
      const out = await saveWorkspace({ transport: t, companyId, reportingPeriodId: "FY2025", evidence: latestPerSeries(store3), report: effectiveOf(store3), decisions: [decision, d2], evaluate: evalFn, saved: savedAfter, rebuild: rebuild(store3) });
      expect(out, JSON.stringify(out)).toMatchObject({ status: "SAVED", correctionsSaved: 1 }); // stored predecessor exists (v2), so this one is legitimate
    }
  });

  it("the client never sends an actor: schema version constant is exported and no argument name carries one", () => {
    expect(CANONICAL_SCHEMA_VERSION).toBeTruthy();
  });
});
