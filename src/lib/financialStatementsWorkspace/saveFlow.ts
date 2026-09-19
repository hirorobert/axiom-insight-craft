// financialStatementsWorkspace/saveFlow.ts — turns the session's working
// statement set into durable, append-only history through FsRpcTransport.
//
// What "Save" means: evidence batches not yet stored are ingested (each a new
// immutable version of its series); the working report is stored as the next
// version of its lineage; every fact correction made in this session becomes one
// contiguous version inside ONE atomic correction group (all or nothing); an
// evaluation of the final stored version is stored; and standalone reviewer
// decisions are appended. Nothing is overwritten. The server, not this module,
// decides staleness: a conflict is surfaced as CONFLICT, never retried blindly.
//
// A correction chain is reconstructed deterministically from the append-only fact
// ledger: report version k is the final report with the facts appended by
// corrections after k removed. No intermediate document is invented.

import type { CanonicalFinancialStatementReport, CorrectFactDecision, ReviewerDecision } from "@/lib/canonicalStatement/types";
import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";
import { contentHashOf } from "./persistenceContract";
import type { EvaluationRunRecord } from "./reportRepository";
import { FsTransportError, type FsRpcTransport } from "./rpcTransport";

const isCorrection = (d: ReviewerDecision): d is CorrectFactDecision => d.decisionType === "CORRECT_FACT";

/** Session-side memory of what has already been stored, so a second Save appends only what is new. */
export interface SavedState {
  readonly storedVersion: number;
  readonly storedDecisionIds: ReadonlySet<string>;
}

export interface ChainPlan {
  /** The report with no session corrections applied. */
  readonly base: CanonicalFinancialStatementReport;
  /** One entry per correction, in order: the report as it stood after that correction. */
  readonly steps: readonly { readonly report: CanonicalFinancialStatementReport; readonly decision: CorrectFactDecision }[];
  readonly standalone: readonly ReviewerDecision[];
}

const withVersion = (r: CanonicalFinancialStatementReport, version: number): CanonicalFinancialStatementReport => ({ ...r, reportIdentity: { ...r.reportIdentity, reportVersion: version } });

/** Deterministically reconstructs the correction chain from the final report and its decision log. */
export function reconstructChain(finalReport: CanonicalFinancialStatementReport, decisions: readonly ReviewerDecision[]): ChainPlan {
  const corrections = decisions.filter(isCorrection);
  const marker = (d: CorrectFactDecision) => `${d.factId}#${d.newVersion}`;
  const withoutAfter = (k: number): CanonicalFinancialStatementReport => {
    const dropped = new Set(corrections.slice(k).map(marker));
    return { ...finalReport, facts: finalReport.facts.filter((f) => !dropped.has(`${f.factId}#${f.version}`)) };
  };
  return {
    base: withoutAfter(0),
    steps: corrections.map((decision, i) => ({ report: withoutAfter(i + 1), decision })),
    standalone: decisions.filter((d) => !isCorrection(d)),
  };
}

export type SaveOutcome =
  | { readonly status: "SAVED"; readonly storedVersion: number; readonly storedDecisionIds: ReadonlySet<string>; readonly evidenceIngested: number; readonly correctionsSaved: number; readonly decisionsAppended: number }
  | { readonly status: "UNCHANGED"; readonly storedVersion: number; readonly storedDecisionIds: ReadonlySet<string> }
  | { readonly status: "FAILED"; readonly kind: FsTransportError["kind"] | "LOCAL"; readonly message: string; readonly isConflict: boolean };

export interface SaveInput {
  readonly transport: FsRpcTransport;
  readonly companyId: string;
  readonly reportingPeriodId: string;
  /** The session's evidence batches (latest per series). */
  readonly evidence: readonly EvidenceBatch[];
  readonly report: CanonicalFinancialStatementReport;
  readonly decisions: readonly ReviewerDecision[];
  /** Evaluates a report at its stored version. Pure; injected so this module holds no rule-engine dependency. */
  readonly evaluate: (report: CanonicalFinancialStatementReport) => EvaluationRunRecord;
  readonly saved: SavedState | null;
}

export async function saveWorkspace(input: SaveInput): Promise<SaveOutcome> {
  const { transport, companyId } = input;
  try {
    const reportId = input.report.reportIdentity.reportId;
    const plan = reconstructChain(input.report, input.decisions);

    // 1 — evidence: ingest what the server does not already hold, each as the next version of its series.
    const periods = [...new Set([input.reportingPeriodId, ...input.evidence.map((b) => b.reportingPeriodId)])];
    const storedEvidence = (await Promise.all(periods.map((p) => transport.listEvidence(companyId, p)))).flat();
    let ingested = 0;
    for (const batch of input.evidence) {
      if (storedEvidence.some((s) => s.replayIdentity === batch.replayIdentity)) continue;
      const series = storedEvidence.filter((s) => s.evidenceType === batch.evidenceType && s.periodRole === batch.periodRole && s.seriesKey === batch.seriesKey).sort((a, b) => b.version - a.version);
      const row = await transport.ingestEvidence(batch, series[0]?.evidenceBatchId ?? null);
      storedEvidence.push(row);
      ingested += 1;
    }
    const evidenceIds = input.evidence.map((b) => b.evidenceBatchId);

    // 2 — the report lineage.
    const latest = await transport.latestReport(companyId, input.report.period.periodYear, input.report.provenanceOrigin);
    let storedVersion = latest?.reportVersion ?? 0;
    let alreadySavedCorrections = 0;
    let savedBase = false;

    if (input.saved) {
      if (input.saved.storedVersion !== storedVersion) {
        return { status: "FAILED", kind: "STALE_VERSION", message: `The report was saved by someone else since you opened it (server is at version ${storedVersion}, this session last saw ${input.saved.storedVersion}). Nothing was saved.`, isConflict: true };
      }
      alreadySavedCorrections = plan.steps.filter((s) => input.saved!.storedDecisionIds.has(s.decision.decisionId)).length;
    } else {
      const wouldBe = latest ? contentHashOf(withVersion(plan.steps.length > 0 ? plan.steps[plan.steps.length - 1].report : plan.base, storedVersion)) : null;
      if (latest && latest.contentHash === wouldBe) {
        alreadySavedCorrections = plan.steps.length; // identical content is already stored
      } else {
        const base = withVersion(plan.base, storedVersion + 1);
        await transport.saveReportVersion(base, contentHashOf(base), evidenceIds);
        storedVersion += 1;
        savedBase = true;
      }
    }

    // 3 — corrections, atomically.
    const newSteps = plan.steps.slice(alreadySavedCorrections);
    let finalReport = savedBase || !latest ? withVersion(plan.base, storedVersion) : withVersion(plan.steps[Math.max(0, plan.steps.length - 1)]?.report ?? plan.base, storedVersion);
    if (newSteps.length > 0) {
      const versioned = newSteps.map((s, i) => ({ reportVersion: storedVersion + i + 1, report: withVersion(s.report, storedVersion + i + 1), decision: { ...s.decision, expectedReportVersion: storedVersion + i } as CorrectFactDecision }));
      finalReport = versioned[versioned.length - 1].report;
      const key = sha256Hex(canonicalStringify({ reportId, from: storedVersion, decisions: versioned.map((v) => v.decision.decisionId) }));
      const run = input.evaluate(finalReport);
      await transport.applyCorrectionGroup({
        groupId: `grp-${key.slice(0, 24)}`,
        idempotencyKey: key,
        companyId,
        reportId,
        expectedReportVersion: storedVersion,
        steps: versioned.map((v) => ({ reportVersion: v.reportVersion, report: v.report })),
        decisions: versioned.map((v) => v.decision),
        evaluation: { evaluationRunId: run.evaluationRunId, rulePackId: run.rulePack.rulePackId, rulePackVersion: run.rulePack.rulePackVersion, engineVersion: run.engineVersion, inputHash: run.inputHash, findings: run.findings },
      });
      storedVersion += versioned.length;
    } else if (savedBase || !latest) {
      const run = input.evaluate(finalReport);
      await transport.saveEvaluation({ evaluationRunId: run.evaluationRunId, reportId, reportVersion: storedVersion, companyId, rulePackId: run.rulePack.rulePackId, rulePackVersion: run.rulePack.rulePackVersion, engineVersion: run.engineVersion, inputHash: run.inputHash, findings: run.findings });
    }

    // 4 — standalone decisions not yet stored.
    const storedDecisions = new Set((await transport.listDecisions(reportId)).map((d) => d.decisionId));
    const already = input.saved?.storedDecisionIds ?? new Set<string>();
    let appended = 0;
    for (const d of plan.standalone) {
      if (storedDecisions.has(d.decisionId) || already.has(d.decisionId)) continue;
      await transport.appendDecision(reportId, companyId, d);
      storedDecisions.add(d.decisionId);
      appended += 1;
    }
    const allIds = new Set<string>([...storedDecisions, ...plan.steps.map((s) => s.decision.decisionId)]);
    const wroteAnything = ingested > 0 || savedBase || newSteps.length > 0 || appended > 0;
    return wroteAnything
      ? { status: "SAVED", storedVersion, storedDecisionIds: allIds, evidenceIngested: ingested, correctionsSaved: newSteps.length, decisionsAppended: appended }
      : { status: "UNCHANGED", storedVersion, storedDecisionIds: allIds };
  } catch (e) {
    if (e instanceof FsTransportError) return { status: "FAILED", kind: e.kind, message: e.message, isConflict: e.isConflict };
    return { status: "FAILED", kind: "LOCAL", message: e instanceof Error ? e.message : String(e), isConflict: false };
  }
}
