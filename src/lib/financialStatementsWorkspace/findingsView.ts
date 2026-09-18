// financialStatementsWorkspace/findingsView.ts — pure read-model over canonical
// findings + the append-only reviewer decision log. No accounting logic:
// buckets are derived from each record's own outcome/severity and from
// deriveFindingStatus, never re-evaluated here.

import { deriveFindingStatus } from "@/lib/canonicalStatement/reviewerDecisions";
import type { FindingSeverity, ReviewerDecisionLog, RuleEvaluationRecord } from "@/lib/canonicalStatement/types";

export type FindingBucket = "BLOCKING" | "WARNING" | "INSUFFICIENT_EVIDENCE" | "RESOLVED" | "PASSED";
export type FindingFilter = "ALL" | FindingBucket;

export type EffectiveStatus = "OPEN" | "ACCEPTED" | "REJECTED" | "DEFERRED" | "AWAITING_EVIDENCE" | "NOT_ACTIONABLE";

export interface FindingView {
  readonly record: RuleEvaluationRecord;
  readonly effectiveStatus: EffectiveStatus;
  readonly bucket: FindingBucket;
}

const BLOCKING_SEVERITIES: ReadonlySet<FindingSeverity> = new Set(["CRITICAL", "HIGH"]);

/**
 * A recorded ACCEPT/REJECT decision moves an actionable finding to RESOLVED —
 * but only in the READ MODEL. The underlying record's outcome is unchanged and
 * still visible on the finding, so "resolved" can never conceal an unchanged
 * accounting defect (a decision documents judgement; only a fact correction
 * that produces a new report version changes the outcome).
 */
export function buildFindingViews(findings: readonly RuleEvaluationRecord[], decisions: ReviewerDecisionLog): readonly FindingView[] {
  return findings.map((record) => {
    if (!record.actionable) {
      return { record, effectiveStatus: "NOT_ACTIONABLE", bucket: "PASSED" };
    }
    const effectiveStatus = deriveFindingStatus(decisions, { findingKey: record.findingKey });
    if (effectiveStatus === "ACCEPTED" || effectiveStatus === "REJECTED") {
      return { record, effectiveStatus, bucket: "RESOLVED" };
    }
    if (record.outcome === "INSUFFICIENT_EVIDENCE") {
      return { record, effectiveStatus, bucket: "INSUFFICIENT_EVIDENCE" };
    }
    return { record, effectiveStatus, bucket: BLOCKING_SEVERITIES.has(record.failureSeverity) ? "BLOCKING" : "WARNING" };
  });
}

export function filterFindingViews(views: readonly FindingView[], filter: FindingFilter): readonly FindingView[] {
  return filter === "ALL" ? views : views.filter((v) => v.bucket === filter);
}

export function countByBucket(views: readonly FindingView[]): Readonly<Record<FindingBucket, number>> {
  const counts: Record<FindingBucket, number> = { BLOCKING: 0, WARNING: 0, INSUFFICIENT_EVIDENCE: 0, RESOLVED: 0, PASSED: 0 };
  for (const v of views) counts[v.bucket] += 1;
  return counts;
}

/** Approval readiness is derived, never asserted: no unresolved blocking finding and no unresolved insufficient-evidence finding. */
export function isApprovalReady(views: readonly FindingView[]): boolean {
  return !views.some((v) => v.bucket === "BLOCKING" || v.bucket === "INSUFFICIENT_EVIDENCE");
}

/** The line to focus for a finding, if it names one. */
export function affectedLineId(record: RuleEvaluationRecord): string | undefined {
  return record.affected.lineId ?? record.evidenceReferences.find((e) => e.lineId)?.lineId;
}

/** Stable DOM anchor for a statement line, shared by the renderer and the findings list. */
export function statementLineDomId(lineId: string): string {
  return `fs-line-${lineId}`;
}
