import { describe, expect, it } from "vitest";
import { affectedLineId, buildFindingViews, countByBucket, filterFindingViews, isApprovalReady } from "./findingsView";
import type { ReviewerDecisionLog, RuleEvaluationRecord } from "@/lib/canonicalStatement/types";

function record(overrides: Partial<RuleEvaluationRecord>): RuleEvaluationRecord {
  return {
    findingKey: "fk-1",
    evaluationId: "ev-1",
    ruleId: "r",
    ruleVersion: "1",
    rulePack: { rulePackId: "p", rulePackVersion: "1" },
    engineVersion: "1",
    outcome: "FAIL",
    actionable: true,
    failureSeverity: "CRITICAL",
    status: "OPEN",
    observedValues: {},
    expectedRelationship: "",
    deterministicCalculation: "",
    evidenceReferences: [],
    affected: {},
    remediationGuidance: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("findingsView", () => {
  it("buckets by outcome and severity", () => {
    const views = buildFindingViews(
      [
        record({ findingKey: "a", failureSeverity: "CRITICAL" }),
        record({ findingKey: "b", failureSeverity: "LOW" }),
        record({ findingKey: "c", outcome: "INSUFFICIENT_EVIDENCE" }),
        record({ findingKey: "d", outcome: "PASS", actionable: false, status: "NOT_ACTIONABLE" }),
      ],
      [],
    );
    expect(views.map((v) => v.bucket)).toEqual(["BLOCKING", "WARNING", "INSUFFICIENT_EVIDENCE", "PASSED"]);
    expect(countByBucket(views)).toEqual({ BLOCKING: 1, WARNING: 1, INSUFFICIENT_EVIDENCE: 1, RESOLVED: 0, PASSED: 1 });
  });

  it("moves an accepted finding to RESOLVED in the read model without altering its outcome", () => {
    const decisions: ReviewerDecisionLog = [{ decisionId: "d1", decisionType: "ACCEPT_FINDING", reviewerId: "fm", decidedAt: "x", target: { kind: "FINDING_KEY", findingKey: "fk-1" } }];
    const [view] = buildFindingViews([record({})], decisions);
    expect(view.bucket).toBe("RESOLVED");
    expect(view.record.outcome).toBe("FAIL");
  });

  it("keeps a deferred finding unresolved and blocks approval readiness", () => {
    const decisions: ReviewerDecisionLog = [{ decisionId: "d1", decisionType: "DEFER", reviewerId: "fm", decidedAt: "x", target: { kind: "FINDING_KEY", findingKey: "fk-1" } }];
    const views = buildFindingViews([record({})], decisions);
    expect(views[0].bucket).toBe("BLOCKING");
    expect(isApprovalReady(views)).toBe(false);
  });

  it("is approval-ready only when nothing blocking or insufficient remains", () => {
    expect(isApprovalReady(buildFindingViews([record({ failureSeverity: "LOW" })], []))).toBe(true);
    expect(isApprovalReady(buildFindingViews([record({ outcome: "INSUFFICIENT_EVIDENCE" })], []))).toBe(false);
  });

  it("filters and resolves the affected line", () => {
    const views = buildFindingViews([record({ affected: { lineId: "L1" } }), record({ findingKey: "z", evidenceReferences: [{ evidenceReferenceId: "e", lineId: "L2" }] })], []);
    expect(filterFindingViews(views, "BLOCKING")).toHaveLength(2);
    expect(filterFindingViews(views, "PASSED")).toHaveLength(0);
    expect(affectedLineId(views[0].record)).toBe("L1");
    expect(affectedLineId(views[1].record)).toBe("L2");
  });
});
