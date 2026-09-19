// financialStatementsWorkspace/savedVersions.ts — reopening saved work.
//
// Two operations, both pure (the transport reads are done by the caller):
//
//  1. restoreLatestDraft — rebuilds an EDITABLE session from the server's latest stored
//     version: the reviewed trial-balance base, the stored fact corrections, every stored
//     evidence version, the stored decisions. It then RE-COMPOSES the effective report and
//     accepts the restoration only if that report is byte-for-byte the stored one (content
//     hash). Anything else is DIVERGED, and the session continues as a fresh draft that
//     saves as the next version — a stored report is never silently "repaired".
//
//  2. historicalView — presents ANY stored version exactly as stored (report, the evaluation
//     recorded for it, the decisions, the evidence versions it used) for read-only display.
//     It performs no re-computation, so what is shown is what the record says.
//
// Actor authority is never read from the client: reviewer ids on restored decisions are the
// server-derived firm-member ids that the stored rows carry.

import type { CanonicalFinancialStatementReport, CorrectEvidenceDecision, CorrectFactDecision, ReviewerDecision, RuleEvaluationRecord } from "@/lib/canonicalStatement/types";
import type { EvidenceBatch, EvidenceBatchDocument, EvidenceType, PeriodRole, ValidationStatus } from "@/lib/financialEvidence/types";
import type { StoredEvidence } from "@/lib/financialGeneration/applyEvidence";
import { contentHashOf } from "./persistenceContract";
import type { SavedState } from "./saveFlow";
import type { PublicationRow, StoredDecisionRow, StoredEvaluationRow, StoredEvidenceRow, StoredReportRow } from "./rpcTransport";

export function evidenceBatchFromRow(row: StoredEvidenceRow, companyId: string): EvidenceBatch {
  return {
    evidenceBatchId: row.evidenceBatchId,
    companyId,
    evidenceType: row.evidenceType as EvidenceType,
    periodRole: row.periodRole as PeriodRole,
    reportingPeriodId: row.reportingPeriodId,
    seriesKey: row.seriesKey,
    schemaVersion: row.schemaVersion,
    sourceFileName: row.sourceFileName,
    contentHash: row.contentHash,
    replayIdentity: row.replayIdentity,
    currency: row.currency,
    scale: row.scale,
    document: row.document as EvidenceBatchDocument,
    diagnostics: row.diagnostics,
    validationStatus: row.validationStatus as ValidationStatus,
  };
}

const withVersion = (r: CanonicalFinancialStatementReport, version: number): CanonicalFinancialStatementReport => ({ ...r, reportIdentity: { ...r.reportIdentity, reportVersion: version } });

export type RestoreOutcome =
  | { readonly kind: "RESTORED"; readonly session: RestoredSession }
  | { readonly kind: "DIVERGED"; readonly reason: string; readonly storedVersion: number };

export interface RestoredSession {
  /** The trial-balance base with the stored fact corrections applied; null for an evidence-only (cash-basis) report. */
  readonly baseReport: CanonicalFinancialStatementReport | null;
  /** Stored decisions that are not evidence corrections (fact corrections, accept/reject/defer …). */
  readonly baseDecisions: readonly ReviewerDecision[];
  readonly evidenceCorrections: readonly CorrectEvidenceDecision[];
  readonly evidence: readonly (StoredEvidence & { readonly saved: true })[];
  readonly saved: SavedState;
  readonly storedVersion: number;
  /** The effective report the restored session recomposes to (identical to the stored version apart from nothing). */
  readonly effectiveReport: CanonicalFinancialStatementReport;
}

export interface RestoreInput {
  readonly companyId: string;
  /** The freshly prepared trial-balance base with no session corrections; null when the framework has no trial-balance route. */
  readonly freshBase: CanonicalFinancialStatementReport | null;
  readonly stored: StoredReportRow;
  readonly decisions: readonly StoredDecisionRow[];
  /** Every stored evidence version for the report's periods. */
  readonly evidenceRows: readonly StoredEvidenceRow[];
  /** Re-composes the effective report from a base and the evidence the stored version referenced. */
  readonly compose: (base: CanonicalFinancialStatementReport | null, evidence: readonly EvidenceBatch[]) => CanonicalFinancialStatementReport | null;
}

export function restoreLatestDraft(input: RestoreInput): RestoreOutcome {
  const { stored } = input;
  const diverged = (reason: string): RestoreOutcome => ({ kind: "DIVERGED", reason, storedVersion: stored.reportVersion });
  if (stored.companyId !== input.companyId) return diverged("The stored report does not belong to this company.");

  // A lineage can hold corrections that a later session started without (it began from a fresh base): a correction whose
  // corrected figure is not in the latest stored report is history, not part of the working draft.
  const applicableFact = (d: ReviewerDecision) => d.decisionType !== "CORRECT_FACT" || stored.report.facts.some((f) => f.factId === d.factId && f.version === d.newVersion);
  const decisions = input.decisions.map((d) => d.decision).filter(applicableFact);
  const factCorrections = decisions.filter((d): d is CorrectFactDecision => d.decisionType === "CORRECT_FACT");
  const evidenceCorrections = decisions.filter((d): d is CorrectEvidenceDecision => d.decisionType === "CORRECT_EVIDENCE");

  let baseReport: CanonicalFinancialStatementReport | null = null;
  if (input.freshBase) {
    const facts = [];
    for (const d of factCorrections) {
      const fact = stored.report.facts.find((f) => f.factId === d.factId && f.version === d.newVersion);
      if (!fact) return diverged(`The stored report does not contain the corrected figure ${d.factId} (version ${d.newVersion}).`);
      facts.push(fact);
    }
    baseReport = { ...input.freshBase, facts: [...input.freshBase.facts, ...facts] };
  } else if (factCorrections.length > 0) {
    return diverged("The stored report has corrected source figures, but no trial balance is available to rebuild it from.");
  }

  const byId = new Map(input.evidenceRows.map((r) => [r.evidenceBatchId, r]));
  const referenced: EvidenceBatch[] = [];
  for (const id of stored.evidenceBatchIds) {
    const row = byId.get(id);
    if (!row) return diverged(`Evidence version ${id} that this report was composed from cannot be read.`);
    referenced.push(evidenceBatchFromRow(row, input.companyId));
  }
  const referencedIds = new Set(stored.evidenceBatchIds);
  // A newer version of a referenced series that the saved report does not use means the evidence moved on after this version was saved.
  for (const row of input.evidenceRows) {
    if (referencedIds.has(row.evidenceBatchId)) continue;
    const series = referenced.find((b) => b.evidenceType === row.evidenceType && b.periodRole === row.periodRole && b.reportingPeriodId === row.reportingPeriodId && b.seriesKey === row.seriesKey);
    const usedVersion = series ? byId.get(series.evidenceBatchId)?.version ?? 0 : 0;
    if (row.version > usedVersion && row.validationStatus !== "INVALID" && row.validationStatus !== "REQUIRES_REVIEW") {
      return diverged(`Evidence changed after this version was saved (a newer ${row.evidenceType} version exists that the report does not use).`);
    }
  }

  const effective = input.compose(baseReport, referenced);
  if (!effective) return diverged("The saved statements could not be recomposed from their stored sources.");
  if (contentHashOf(withVersion(effective, stored.reportVersion)) !== stored.contentHash) {
    return diverged("The source data no longer reproduces the saved statements exactly (the trial balance or its reviewed mapping changed).");
  }

  return {
    kind: "RESTORED",
    session: {
      baseReport,
      baseDecisions: decisions.filter((d) => d.decisionType !== "CORRECT_EVIDENCE"),
      evidenceCorrections,
      evidence: input.evidenceRows.map((r) => ({ batch: evidenceBatchFromRow(r, input.companyId), version: r.version, saved: true as const })),
      saved: { storedVersion: stored.reportVersion, storedDecisionIds: new Set(input.decisions.map((d) => d.decisionId)) },
      storedVersion: stored.reportVersion,
      effectiveReport: effective,
    },
  };
}

// ─── historical (read-only) view ───────────────────────────────────────────

export interface HistoricalView {
  readonly reportId: string;
  readonly reportVersion: number;
  readonly createdAt: string;
  readonly isLatest: boolean;
  readonly state: "DRAFT" | "REVIEWED" | "FINAL";
  readonly report: CanonicalFinancialStatementReport;
  /** Exactly the evaluation recorded for this version (the newest run), never a fresh computation. */
  readonly findings: readonly RuleEvaluationRecord[];
  readonly evaluation: StoredEvaluationRow | null;
  readonly decisions: readonly ReviewerDecision[];
  readonly evidence: readonly EvidenceBatch[];
  readonly publication: PublicationRow | null;
}

export function historicalView(input: {
  readonly companyId: string;
  readonly version: StoredReportRow;
  readonly isLatest: boolean;
  readonly state: HistoricalView["state"];
  readonly evaluations: readonly StoredEvaluationRow[];
  readonly decisions: readonly StoredDecisionRow[];
  readonly evidenceRows: readonly StoredEvidenceRow[];
  readonly publications: readonly PublicationRow[];
}): HistoricalView | null {
  const v = input.version;
  if (v.companyId !== input.companyId) return null;
  const evaluation = input.evaluations.length > 0 ? input.evaluations[input.evaluations.length - 1] : null;
  const used = new Set(v.evidenceBatchIds);
  const publication = [...input.publications].filter((p) => p.reportVersion === v.reportVersion).sort((a, b) => b.seq - a.seq)[0] ?? null;
  return {
    reportId: v.report.reportIdentity.reportId,
    reportVersion: v.reportVersion,
    createdAt: v.createdAt,
    isLatest: input.isLatest,
    state: publication?.state ?? input.state,
    report: v.report,
    findings: evaluation?.findings ?? [],
    evaluation,
    decisions: input.decisions.map((d) => d.decision),
    evidence: input.evidenceRows.filter((r) => used.has(r.evidenceBatchId)).map((r) => evidenceBatchFromRow(r, input.companyId)),
    publication,
  };
}

/** The `generated` map statementComposition expects, read from the statements a stored report already contains. */
export function generatedFromStoredReport(report: CanonicalFinancialStatementReport): Readonly<Record<string, { status: "GENERATED"; statement: CanonicalFinancialStatementReport["statements"][number]; facts: readonly []; evidenceIndex: Readonly<Record<string, never[]>>; diagnostics: readonly [] }>> {
  const out: Record<string, { status: "GENERATED"; statement: CanonicalFinancialStatementReport["statements"][number]; facts: readonly []; evidenceIndex: Readonly<Record<string, never[]>>; diagnostics: readonly [] }> = {};
  for (const st of report.statements) {
    if (st.type === "STATEMENT_OF_CASH_FLOWS" || st.type === "STATEMENT_OF_CHANGES_IN_EQUITY" || st.type === "STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS") out[st.type] = { status: "GENERATED", statement: st, facts: [], evidenceIndex: {}, diagnostics: [] };
  }
  return out;
}
