import { describe, expect, it } from "vitest";
import { appendDecision, decisionsForFact, decisionsForFinding, deriveFindingStatus, DuplicateDecisionIdError } from "./reviewerDecisions";
import type { AcceptFindingDecision, ReviewerDecisionLog, RejectFindingDecision } from "./types";

const accept: AcceptFindingDecision = {
  decisionId: "d-1",
  decisionType: "ACCEPT_FINDING",
  reviewerId: "fm-1",
  decidedAt: "2026-01-01T00:00:00.000Z",
  target: { kind: "FINDING_KEY", findingKey: "finding-key-1" },
};

const reject: RejectFindingDecision = {
  decisionId: "d-2",
  decisionType: "REJECT_FINDING",
  reviewerId: "fm-2",
  decidedAt: "2026-01-02T00:00:00.000Z",
  target: { kind: "FINDING_KEY", findingKey: "finding-key-2" },
  rationale: "Not a genuine defect — reviewed against source.",
};

describe("appendDecision — append-only", () => {
  it("adds to a new array without mutating the original log", () => {
    const log: ReviewerDecisionLog = [];
    const next = appendDecision(log, accept);
    expect(log).toHaveLength(0);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual(accept);
  });

  it("refuses a duplicate decisionId", () => {
    const log = appendDecision([], accept);
    expect(() => appendDecision(log, accept)).toThrow(DuplicateDecisionIdError);
  });

  it("never removes a prior decision when appending a later one", () => {
    let log: ReviewerDecisionLog = [];
    log = appendDecision(log, accept);
    log = appendDecision(log, reject);
    expect(log).toHaveLength(2);
    expect(log[0]).toEqual(accept);
  });
});

describe("decisionsForFinding / decisionsForFact", () => {
  it("filters to only the decisions targeting the given findingKey", () => {
    const log = appendDecision(appendDecision([], accept), reject);
    expect(decisionsForFinding(log, { findingKey: "finding-key-1" })).toEqual([accept]);
    expect(decisionsForFinding(log, { findingKey: "finding-key-2" })).toEqual([reject]);
    expect(decisionsForFinding(log, { findingKey: "finding-key-does-not-exist" })).toEqual([]);
  });

  it("filters by evaluationId independently of findingKey", () => {
    const evaluationTargeted: AcceptFindingDecision = {
      decisionId: "d-eval",
      decisionType: "ACCEPT_FINDING",
      reviewerId: "fm-1",
      decidedAt: "2026-01-01T00:00:00.000Z",
      target: { kind: "EVALUATION_ID", evaluationId: "eval-1" },
    };
    const log = appendDecision([], evaluationTargeted);
    expect(decisionsForFinding(log, { evaluationId: "eval-1" })).toEqual([evaluationTargeted]);
    expect(decisionsForFinding(log, { findingKey: "eval-1" })).toEqual([]); // a findingKey lookup never matches an evaluationId-targeted decision
  });

  it("filters to only the decisions referencing the given fact", () => {
    const correct = {
      decisionId: "d-3",
      decisionType: "CORRECT_FACT" as const,
      reviewerId: "fm-1",
      decidedAt: "2026-01-03T00:00:00.000Z",
      factId: "fact-1",
      supersedesVersion: 1,
      newVersion: 2,
      correctedValue: null,
      rationale: "Was extracted from the wrong cell.",
    };
    // decisionsForFact reads the log directly — appendDecision's type
    // deliberately excludes CORRECT_FACT (see reviewState.ts), so this
    // fixture builds the log array by hand rather than through appendDecision.
    const log: ReviewerDecisionLog = [correct];
    expect(decisionsForFact(log, "fact-1")).toEqual([correct]);
  });
});

describe("deriveFindingStatus", () => {
  it("returns OPEN when no decision references the finding", () => {
    expect(deriveFindingStatus([], { findingKey: "finding-key-1" })).toBe("OPEN");
  });
  it("returns ACCEPTED/REJECTED per the most recent decision", () => {
    expect(deriveFindingStatus(appendDecision([], accept), { findingKey: "finding-key-1" })).toBe("ACCEPTED");
    expect(deriveFindingStatus(appendDecision([], reject), { findingKey: "finding-key-2" })).toBe("REJECTED");
  });
  it("the most recent decision wins when a finding has more than one", () => {
    const later: RejectFindingDecision = { ...reject, decisionId: "d-4", target: { kind: "FINDING_KEY", findingKey: "finding-key-1" }, decidedAt: "2026-02-01T00:00:00.000Z" };
    const log = appendDecision(appendDecision([], accept), later);
    expect(deriveFindingStatus(log, { findingKey: "finding-key-1" })).toBe("REJECTED");
  });
});
