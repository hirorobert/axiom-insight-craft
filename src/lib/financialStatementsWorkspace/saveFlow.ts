// financialStatementsWorkspace/saveFlow.ts — turns the session's working
// statement set into durable, append-only history through FsRpcTransport.
//
// What "Save" means: evidence batches not yet stored are ingested (each a new
// immutable version of its series); the working report is stored as the next
// version of its lineage; every correction made in this session — of a source
// figure (CORRECT_FACT) or of source evidence (CORRECT_EVIDENCE) — becomes one
// contiguous version inside ONE atomic correction group (all or nothing); an
// evaluation of the final stored version is stored; and standalone reviewer
// decisions are appended. Nothing is overwritten. The server, not this module,
// decides staleness: a conflict is surfaced as CONFLICT, never retried blindly.
//
// A correction chain is reconstructed deterministically from the append-only
// ledgers. Fact corrections: report version k is the base with the facts appended
// by later corrections removed. Evidence corrections: the evidence set at version k
// excludes the corrected batches of later corrections, so the previous version of
// each series feeds the statements again; the report is re-composed by the injected
// `rebuild`. No intermediate document is invented.

import type { CanonicalFinancialStatementReport, CorrectEvidenceDecision, CorrectFactDecision, ReviewerDecision } from "@/lib/canonicalStatement/types";
import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";
import { latestPerSeries, type StoredEvidence } from "@/lib/financialGeneration/applyEvidence";
import { contentHashOf } from "./persistenceContract";
import type { EvaluationRunRecord } from "./reportRepository";
import { FsTransportError, type FsRpcTransport } from "./rpcTransport";

export type CorrectionDecision = CorrectFactDecision | CorrectEvidenceDecision;
const isCorrection = (d: ReviewerDecision): d is CorrectionDecision => d.decisionType === "CORRECT_FACT" || d.decisionType === "CORRECT_EVIDENCE";
const isEvidenceCorrection = (d: ReviewerDecision): d is CorrectEvidenceDecision => d.decisionType === "CORRECT_EVIDENCE";

/** Session-side memory of what has already been stored, so a second Save appends only what is new. */
export interface SavedState {
  readonly storedVersion: number;
  readonly storedDecisionIds: ReadonlySet<string>;
}

/** Re-composes the effective report from the trial-balance base and an evidence set. Supplied by the workspace. */
export interface ChainRebuild {
  /** `droppedFactMarkers` are `factId#version` markers of base facts appended by corrections that must not be applied. */
  readonly at: (droppedFactMarkers: ReadonlySet<string>, evidence: readonly EvidenceBatch[]) => CanonicalFinancialStatementReport | null;
  /** Every evidence batch the session knows, every version. */
  readonly allEvidence: readonly StoredEvidence[];
}

export interface ChainStep {
  readonly report: CanonicalFinancialStatementReport;
  readonly decision: CorrectionDecision;
  /** Present exactly when the decision is CORRECT_EVIDENCE. */
  readonly evidenceBatch?: EvidenceBatch;
  readonly evidenceIds?: readonly string[];
}

export interface ChainPlan {
  /** The report with no session corrections applied. */
  readonly base: CanonicalFinancialStatementReport;
  readonly baseEvidenceIds?: readonly string[];
  /** One entry per correction, in order: the report as it stood after that correction. */
  readonly steps: readonly ChainStep[];
  readonly standalone: readonly ReviewerDecision[];
  /** Batches that arrive only through a correction step and must never be ingested on their own. */
  readonly correctionBatchIds: ReadonlySet<string>;
}

const withVersion = (r: CanonicalFinancialStatementReport, version: number): CanonicalFinancialStatementReport => ({ ...r, reportIdentity: { ...r.reportIdentity, reportVersion: version } });
const marker = (d: CorrectFactDecision) => `${d.factId}#${d.newVersion}`;

export class ChainReconstructionError extends Error {}

/** Deterministically reconstructs the correction chain from the final report and its decision log. */
export function reconstructChain(finalReport: CanonicalFinancialStatementReport, decisions: readonly ReviewerDecision[], rebuild?: ChainRebuild): ChainPlan {
  const corrections = decisions.filter(isCorrection);
  const standalone = decisions.filter((d) => !isCorrection(d));
  const correctionBatchIds = new Set(corrections.filter(isEvidenceCorrection).map((d) => d.newBatchId));

  if (correctionBatchIds.size === 0) {
    const withoutAfter = (k: number): CanonicalFinancialStatementReport => {
      const dropped = new Set(corrections.slice(k).map((d) => marker(d as CorrectFactDecision)));
      return { ...finalReport, facts: finalReport.facts.filter((f) => !dropped.has(`${f.factId}#${f.version}`)) };
    };
    return { base: withoutAfter(0), steps: corrections.map((decision, i) => ({ report: withoutAfter(i + 1), decision })), standalone, correctionBatchIds };
  }

  if (!rebuild) throw new ChainReconstructionError("Evidence corrections can only be saved with a report rebuilder.");
  const at = (k: number) => {
    const droppedFacts = new Set(corrections.slice(k).filter((d): d is CorrectFactDecision => d.decisionType === "CORRECT_FACT").map(marker));
    const droppedBatches = new Set(corrections.slice(k).filter(isEvidenceCorrection).map((d) => d.newBatchId));
    const evidence = latestPerSeries(rebuild.allEvidence.filter((e) => !droppedBatches.has(e.batch.evidenceBatchId)));
    const report = rebuild.at(droppedFacts, evidence);
    if (!report) throw new ChainReconstructionError(`The report as it stood after correction ${k} could not be recomposed.`);
    return { report, evidenceIds: evidence.map((b) => b.evidenceBatchId) };
  };
  const first = at(0);
  return {
    base: first.report,
    baseEvidenceIds: first.evidenceIds,
    steps: corrections.map((decision, i) => {
      const s = at(i + 1);
      const batch = isEvidenceCorrection(decision) ? rebuild.allEvidence.find((e) => e.batch.evidenceBatchId === decision.newBatchId)?.batch : undefined;
      if (isEvidenceCorrection(decision) && !batch) throw new ChainReconstructionError(`The corrected evidence version ${decision.newBatchId} is not part of this session.`);
      return { report: s.report, decision, evidenceBatch: batch, evidenceIds: s.evidenceIds };
    }),
    standalone,
    correctionBatchIds,
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
  /** Required only when `decisions` contains a CORRECT_EVIDENCE decision. */
  readonly rebuild?: ChainRebuild;
}

export async function saveWorkspace(input: SaveInput): Promise<SaveOutcome> {
  const { transport, companyId } = input;
  try {
    const reportId = input.report.reportIdentity.reportId;
    const plan = reconstructChain(input.report, input.decisions, input.rebuild);

    // 1 — evidence: ingest what the server does not already hold, each as the next version of its series.
    //     A corrected version travels inside its correction step, never on its own.
    const periods = [...new Set([input.reportingPeriodId, ...input.evidence.map((b) => b.reportingPeriodId)])];
    const storedEvidence = (await Promise.all(periods.map((p) => transport.listEvidence(companyId, p)))).flat();
    // A correction supersedes stored evidence. If that evidence was never saved there is nothing durable to correct: refuse BEFORE anything is written.
    const pendingCorrections = plan.steps.filter((st) => !input.saved?.storedDecisionIds.has(st.decision.decisionId));
    for (const st of pendingCorrections) {
      const superseded = st.decision.decisionType === "CORRECT_EVIDENCE" ? st.decision.supersedesBatchId : null;
      if (superseded !== null && !storedEvidence.some((e) => e.evidenceBatchId === superseded)) {
        return { status: "FAILED", kind: "LOCAL", message: "A corrected evidence version can only supersede evidence that has already been saved. Save the evidence first.", isConflict: false };
      }
    }
    const seriesOf = (b: EvidenceBatch) => storedEvidence.filter((s) => s.evidenceType === b.evidenceType && s.periodRole === b.periodRole && s.seriesKey === b.seriesKey && s.reportingPeriodId === b.reportingPeriodId).sort((a, b2) => b2.version - a.version);
    // Evidence the server does not hold yet. It is NOT written on its own: it travels inside the revision that creates the
    // report version referencing it (fs_commit_revision), so no accepted evidence can exist without a version, evaluation and audit event.
    const pendingEvidence = input.evidence.filter((b) => !plan.correctionBatchIds.has(b.evidenceBatchId) && !storedEvidence.some((s) => s.replayIdentity === b.replayIdentity));
    let ingested = 0;
    const evidenceIds = plan.baseEvidenceIds ?? input.evidence.map((b) => b.evidenceBatchId);

    // 2 — the report lineage.
    const latest = await transport.latestReport(companyId, input.report.period.periodYear, input.report.provenanceOrigin);
    let storedVersion = latest?.reportVersion ?? 0;
    let alreadySavedCorrections = 0;
    let savedBase = false;
    let savedBaseReport: CanonicalFinancialStatementReport = plan.base;

    /** One atomic call: evidence + the next report version + its evaluation + the audit event. */
    const commit = async (state: CanonicalFinancialStatementReport, ids: readonly string[]) => {
      const next = withVersion(state, storedVersion + 1);
      const run = input.evaluate(next);
      const key = sha256Hex(canonicalStringify({ kind: "revision", reportId, from: storedVersion, contentHash: contentHashOf(next), ids, evidence: pendingEvidence.map((b) => b.evidenceBatchId) }));
      const out = await transport.commitRevision({
        companyId,
        reportId,
        expectedReportVersion: storedVersion,
        idempotencyKey: key,
        report: next,
        evidence: pendingEvidence.map((batch) => ({ batch, expectedPreviousBatchId: seriesOf(batch)[0]?.evidenceBatchId ?? null })),
        evidenceBatchIds: ids,
        evaluation: { evaluationRunId: run.evaluationRunId, rulePackId: run.rulePack.rulePackId, rulePackVersion: run.rulePack.rulePackVersion, engineVersion: run.engineVersion, inputHash: run.inputHash, findings: run.findings },
      });
      ingested = pendingEvidence.length;
      if (out.created) {
        storedVersion = out.reportVersion;
        savedBase = true;
        savedBaseReport = state;
      }
    };

    if (input.saved) {
      if (input.saved.storedVersion !== storedVersion) {
        return { status: "FAILED", kind: "STALE_VERSION", message: `The report was saved by someone else since you opened it (server is at version ${storedVersion}, this session last saw ${input.saved.storedVersion}). Nothing was saved.`, isConflict: true };
      }
      alreadySavedCorrections = plan.steps.filter((s) => input.saved!.storedDecisionIds.has(s.decision.decisionId)).length;
      // Evidence added or replaced since the last save changes the report without any correction: that is a new version too.
      const atSaved = alreadySavedCorrections > 0 ? plan.steps[alreadySavedCorrections - 1] : null;
      const stateAfterSaved = atSaved ? atSaved.report : plan.base;
      if ((latest && contentHashOf(withVersion(stateAfterSaved, storedVersion)) !== latest.contentHash) || pendingEvidence.length > 0) {
        await commit(stateAfterSaved, atSaved ? atSaved.evidenceIds ?? evidenceIds : evidenceIds);
      }
    } else {
      const wouldBe = latest ? contentHashOf(withVersion(plan.steps.length > 0 ? plan.steps[plan.steps.length - 1].report : plan.base, storedVersion)) : null;
      if (latest && latest.contentHash === wouldBe && pendingEvidence.length === 0) {
        alreadySavedCorrections = plan.steps.length; // identical content and evidence are already stored
      } else {
        await commit(plan.base, evidenceIds);
      }
    }

    // 3 — corrections, atomically.
    const newSteps = plan.steps.slice(alreadySavedCorrections);
    let finalReport = savedBase || !latest ? withVersion(savedBaseReport, storedVersion) : withVersion(plan.steps[Math.max(0, plan.steps.length - 1)]?.report ?? plan.base, storedVersion);
    if (newSteps.length > 0) {
      const versioned = newSteps.map((s, i) => ({
        reportVersion: storedVersion + i + 1,
        report: withVersion(s.report, storedVersion + i + 1),
        decision: { ...s.decision, expectedReportVersion: storedVersion + i } as CorrectionDecision,
        evidenceBatch: s.evidenceBatch,
        evidenceIds: s.evidenceIds,
        expectedPreviousBatchId: s.decision.decisionType === "CORRECT_EVIDENCE" ? s.decision.supersedesBatchId : undefined,
      }));
      finalReport = versioned[versioned.length - 1].report;
      const key = sha256Hex(canonicalStringify({ reportId, from: storedVersion, decisions: versioned.map((v) => v.decision.decisionId) }));
      const run = input.evaluate(finalReport);
      await transport.applyCorrectionGroup({
        groupId: `grp-${key.slice(0, 24)}`,
        idempotencyKey: key,
        companyId,
        reportId,
        expectedReportVersion: storedVersion,
        steps: versioned.map((v) => ({ reportVersion: v.reportVersion, report: v.report, evidenceBatch: v.evidenceBatch, expectedPreviousBatchId: v.expectedPreviousBatchId, evidenceBatchIds: v.evidenceIds })),
        decisions: versioned.map((v) => v.decision),
        evaluation: { evaluationRunId: run.evaluationRunId, rulePackId: run.rulePack.rulePackId, rulePackVersion: run.rulePack.rulePackVersion, engineVersion: run.engineVersion, inputHash: run.inputHash, findings: run.findings },
      });
      storedVersion += versioned.length;
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
