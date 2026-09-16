import { describe, expect, it } from "vitest";
import { appendDecision, decisionsForFact, decisionsForFinding, deriveFindingStatus, DuplicateDecisionIdError } from "./reviewerDecisions";
import type { AcceptFindingDecision, ReviewerDecisionLog, RejectFindingDecision } from "./types";

const accept: AcceptFindingDecision = {
  decisionId: "d-1",
  decisionType: "ACCEPT_FINDING",
  reviewerId: "fm-1",
  decidedAt: "2026-01-01T00:00:00.000Z",
  findingId: "finding-1",
};

const reject: RejectFindingDecision = {
  decisionId: "d-2",
  decisionType: "REJECT_FINDING",
  reviewerId: "fm-2",
  decidedAt: "2026-01-02T00:00:00.000Z",
  findingId: "finding-2",
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
  it("filters to only the decisions referencing the given finding", () => {
    const log = appendDecision(appendDecision([], accept), reject);
    expect(decisionsForFinding(log, "finding-1")).toEqual([accept]);
    expect(decisionsForFinding(log, "finding-2")).toEqual([reject]);
    expect(decisionsForFinding(log, "finding-does-not-exist")).toEqual([]);
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
    const log = appendDecision([], correct);
    expect(decisionsForFact(log, "fact-1")).toEqual([correct]);
  });
});

describe("deriveFindingStatus", () => {
  it("returns OPEN when no decision references the finding", () => {
    expect(deriveFindingStatus([], "finding-1")).toBe("OPEN");
  });
  it("returns ACCEPTED/REJECTED per the most recent decision", () => {
    expect(deriveFindingStatus(appendDecision([], accept), "finding-1")).toBe("ACCEPTED");
    expect(deriveFindingStatus(appendDecision([], reject), "finding-2")).toBe("REJECTED");
  });
  it("the most recent decision wins when a finding has more than one", () => {
    const later: RejectFindingDecision = { ...reject, decisionId: "d-4", findingId: "finding-1", decidedAt: "2026-02-01T00:00:00.000Z" };
    const log = appendDecision(appendDecision([], accept), later);
    expect(deriveFindingStatus(log, "finding-1")).toBe("REJECTED");
  });
});
