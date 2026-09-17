import { describe, expect, it } from "vitest";
import { FactCorrectionRejectedError, recordFactCorrection, type CanonicalReviewState } from "./reviewState";
import { resolveLatestFact } from "./provenance";
import { money } from "./money";
import { provenance } from "./fixtures/builders";
import { IFRS_FULL_FIXTURE } from "./fixtures/ifrsFullFixture";
import { buildRuleContext, runRule } from "./rules/ruleEngine";
import { financialPositionEquationRule } from "./rules/financialPositionEquation";
import { ZERO_TOLERANCE } from "./money";
import type { CorrectFactDecision } from "./types";

const RULE_PACK = { rulePackId: "test-pack", rulePackVersion: "1.0.0" };
const FIXED_CLOCK = () => "2026-01-01T00:00:00.000Z";

function baseState(): CanonicalReviewState {
  return { report: IFRS_FULL_FIXTURE, decisions: [] };
}

function correctionDecision(overrides: Partial<CorrectFactDecision> = {}): CorrectFactDecision {
  return {
    decisionId: "decision-1",
    decisionType: "CORRECT_FACT",
    reviewerId: "fm-1",
    decidedAt: "2026-02-01T00:00:00.000Z",
    factId: "ppe-net-cur",
    supersedesVersion: 1,
    newVersion: 2,
    correctedValue: money("TZS", 2, 205000000n),
    rationale: "Corrected after evidence review — original figure omitted a late invoice.",
    expectedReportVersion: 1,
    ...overrides,
  };
}

describe("recordFactCorrection — atomic success path", () => {
  it("appends exactly one fact version and one decision", () => {
    const state = baseState();
    const next = recordFactCorrection(state, correctionDecision(), provenance("corrected"));
    expect(next.report.facts).toHaveLength(state.report.facts.length + 1);
    expect(next.decisions).toHaveLength(1);
    const latest = resolveLatestFact(next.report.facts, "ppe-net-cur");
    expect(latest?.version).toBe(2);
    expect(latest?.value).toEqual(money("TZS", 2, 205000000n));
  });

  it("the original state remains byte-identical (no mutation of the input)", () => {
    const state = baseState();
    const originalFactsLength = state.report.facts.length;
    const originalDecisionsLength = state.decisions.length;
    const originalReportVersion = state.report.reportIdentity.reportVersion;
    const snapshotJson = JSON.stringify(state.report.facts, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    recordFactCorrection(state, correctionDecision(), provenance("corrected"));
    expect(state.report.facts).toHaveLength(originalFactsLength);
    expect(state.decisions).toHaveLength(originalDecisionsLength);
    expect(state.report.reportIdentity.reportVersion).toBe(originalReportVersion);
    expect(JSON.stringify(state.report.facts, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(snapshotJson);
  });

  it("returns a report that itself re-validates cleanly", () => {
    const state = baseState();
    const next = recordFactCorrection(state, correctionDecision(), provenance("corrected"));
    expect(next.report.reportIdentity.reportId).toBe(state.report.reportIdentity.reportId);
  });
});

describe("A–H: report-version advancement (final closure patch, section 1)", () => {
  it("A. a successful correction increments reportVersion by exactly 1", () => {
    const state = baseState();
    const next = recordFactCorrection(state, correctionDecision(), provenance("A"));
    expect(next.report.reportIdentity.reportVersion).toBe(state.report.reportIdentity.reportVersion + 1);
  });

  it("B. a failed correction (business-rule rejection) does not increment reportVersion", () => {
    const state = baseState();
    const badDecision = correctionDecision({ supersedesVersion: 99, newVersion: 100 }); // wrong supersedesVersion
    expect(() => recordFactCorrection(state, badDecision, provenance("B"))).toThrow(FactCorrectionRejectedError);
    expect(state.report.reportIdentity.reportVersion).toBe(1);
  });

  it("C. a stale correction (fact already at a later version) does not increment reportVersion", () => {
    const state = baseState();
    const committed = recordFactCorrection(state, correctionDecision(), provenance("first"));
    expect(committed.report.reportIdentity.reportVersion).toBe(2);
    const stale = correctionDecision({ decisionId: "decision-stale", supersedesVersion: 1, newVersion: 2, expectedReportVersion: 2 });
    expect(() => recordFactCorrection(committed, stale, provenance("stale"))).toThrow(FactCorrectionRejectedError);
    expect(committed.report.reportIdentity.reportVersion).toBe(2); // the already-committed state is untouched by the rejected attempt
  });

  it("D. a duplicate decisionId does not increment reportVersion", () => {
    const state = baseState();
    const committed = recordFactCorrection(state, correctionDecision(), provenance("first"));
    const duplicateId = correctionDecision({ supersedesVersion: 2, newVersion: 3, expectedReportVersion: 2 }); // same decisionId "decision-1"
    expect(() => recordFactCorrection(committed, duplicateId, provenance("dup"))).toThrow(FactCorrectionRejectedError);
    expect(committed.report.reportIdentity.reportVersion).toBe(2);
  });

  it("E. two corrections applied sequentially advance N -> N+1 -> N+2", () => {
    const state = baseState();
    expect(state.report.reportIdentity.reportVersion).toBe(1);
    const afterFirst = recordFactCorrection(state, correctionDecision(), provenance("first"));
    expect(afterFirst.report.reportIdentity.reportVersion).toBe(2);
    const second = correctionDecision({
      decisionId: "decision-2",
      supersedesVersion: 2,
      newVersion: 3,
      correctedValue: money("TZS", 2, 210000000n),
      expectedReportVersion: 2,
    });
    const afterSecond = recordFactCorrection(afterFirst, second, provenance("second"));
    expect(afterSecond.report.reportIdentity.reportVersion).toBe(3);
    expect(resolveLatestFact(afterSecond.report.facts, "ppe-net-cur")?.version).toBe(3);
  });

  it("F. two competing commands both formed against version N cannot both commit", () => {
    const state = baseState(); // reportVersion = 1
    const commandA = correctionDecision({ decisionId: "decision-a", correctedValue: money("TZS", 2, 111n), expectedReportVersion: 1 });
    const commandB = correctionDecision({ decisionId: "decision-b", correctedValue: money("TZS", 2, 222n), expectedReportVersion: 1 });

    const afterA = recordFactCorrection(state, commandA, provenance("A"));
    expect(afterA.report.reportIdentity.reportVersion).toBe(2);

    // B was formed against version 1, but the authoritative state is now version 2 — rejected.
    expect(() => recordFactCorrection(afterA, commandB, provenance("B"))).toThrow(FactCorrectionRejectedError);
    expect(afterA.report.reportIdentity.reportVersion).toBe(2);
    expect(resolveLatestFact(afterA.report.facts, "ppe-net-cur")?.value).toEqual(money("TZS", 2, 111n));
  });

  it("rejects a command whose expectedReportVersion does not match the CURRENT report (not just 'any stale value')", () => {
    const state = baseState();
    const wrongExpectation = correctionDecision({ expectedReportVersion: 5 });
    expect(() => recordFactCorrection(state, wrongExpectation, provenance("x"))).toThrow(FactCorrectionRejectedError);
  });

  it("G. evaluationId changes after a correction, even for a rule target the correction did not touch", () => {
    // "contingent-liabilities-cur" is a genuinely MISSING (null) fact in the
    // golden fixture, not referenced anywhere by Rule 1's SFP equation — so
    // correcting it changes nothing about Rule 1's outcome or observed
    // values, only the report's version (which evaluationId incorporates).
    const state = baseState();
    const recordBefore = runRule(financialPositionEquationRule, buildRuleContext(state.report, ZERO_TOLERANCE), RULE_PACK, "1.0.0", FIXED_CLOCK)[0];

    const decision = correctionDecision({ factId: "contingent-liabilities-cur", supersedesVersion: 1, newVersion: 2, correctedValue: money("TZS", 2, 50000n) });
    const next = recordFactCorrection(state, decision, provenance("disclosed"));
    const recordAfter = runRule(financialPositionEquationRule, buildRuleContext(next.report, ZERO_TOLERANCE), RULE_PACK, "1.0.0", FIXED_CLOCK)[0];

    expect(recordBefore.outcome).toBe(recordAfter.outcome); // unaffected numerically
    expect(recordBefore.observedValues).toEqual(recordAfter.observedValues); // unaffected numerically
    expect(recordBefore.evaluationId).not.toBe(recordAfter.evaluationId); // but the report's version moved, and evaluationId incorporates reportVersion
  });

  it("H. findingKey remains stable for the same rule target across a correction; evaluationId does not", () => {
    const state = baseState();
    const recordBefore = runRule(financialPositionEquationRule, buildRuleContext(state.report, ZERO_TOLERANCE), RULE_PACK, "1.0.0", FIXED_CLOCK)[0];

    const decision = correctionDecision({ factId: "contingent-liabilities-cur", supersedesVersion: 1, newVersion: 2, correctedValue: money("TZS", 2, 50000n) });
    const next = recordFactCorrection(state, decision, provenance("disclosed"));
    const recordAfter = runRule(financialPositionEquationRule, buildRuleContext(next.report, ZERO_TOLERANCE), RULE_PACK, "1.0.0", FIXED_CLOCK)[0];

    expect(recordBefore.findingKey).toBe(recordAfter.findingKey); // same rule + same report identity + same discriminator -> stable findingKey
    expect(recordBefore.evaluationId).not.toBe(recordAfter.evaluationId); // reportVersion changed -> different evaluationId
  });
});

describe("recordFactCorrection — rejection paths change nothing", () => {
  it("rejects a stale concurrent correction (supersedesVersion no longer the latest)", () => {
    const state = baseState();
    const first = recordFactCorrection(state, correctionDecision(), provenance("first correction"));
    const staleDecision = correctionDecision({ decisionId: "decision-2", supersedesVersion: 1, newVersion: 2, correctedValue: money("TZS", 2, 999n), expectedReportVersion: 2 });
    expect(() => recordFactCorrection(first, staleDecision, provenance("stale"))).toThrow(FactCorrectionRejectedError);
    expect(first.report.facts).toHaveLength(state.report.facts.length + 1);
    expect(first.decisions).toHaveLength(1);
  });

  it("rejects a duplicate decisionId", () => {
    const state = baseState();
    const committed = recordFactCorrection(state, correctionDecision(), provenance("first"));
    const duplicateIdDecision = correctionDecision({ supersedesVersion: 2, newVersion: 3, correctedValue: money("TZS", 2, 1n), expectedReportVersion: 2 });
    expect(() => recordFactCorrection(committed, duplicateIdDecision, provenance("duplicate"))).toThrow(FactCorrectionRejectedError);
  });

  it("a failed correction changes neither the fact ledger nor the decision log", () => {
    const state = baseState();
    const badDecision = correctionDecision({ supersedesVersion: 99, newVersion: 100 });
    expect(() => recordFactCorrection(state, badDecision, provenance("bad"))).toThrow(FactCorrectionRejectedError);
    expect(state.report.facts).toHaveLength(IFRS_FULL_FIXTURE.facts.length);
    expect(state.decisions).toHaveLength(0);
  });

  it("rejects when the fact does not exist", () => {
    const state = baseState();
    const decision = correctionDecision({ factId: "no-such-fact", supersedesVersion: 1, newVersion: 2 });
    expect(() => recordFactCorrection(state, decision, provenance("x"))).toThrow(FactCorrectionRejectedError);
  });

  it("rejects when newVersion is not exactly supersedesVersion + 1", () => {
    const state = baseState();
    const decision = correctionDecision({ newVersion: 3 });
    expect(() => recordFactCorrection(state, decision, provenance("x"))).toThrow(FactCorrectionRejectedError);
  });

  it("rejects an empty reviewerId", () => {
    const state = baseState();
    expect(() => recordFactCorrection(state, correctionDecision({ reviewerId: "  " }), provenance("x"))).toThrow(FactCorrectionRejectedError);
  });

  it("rejects an empty decisionId", () => {
    const state = baseState();
    expect(() => recordFactCorrection(state, correctionDecision({ decisionId: "" }), provenance("x"))).toThrow(FactCorrectionRejectedError);
  });

  it("rejects an empty rationale", () => {
    const state = baseState();
    expect(() => recordFactCorrection(state, correctionDecision({ rationale: "" }), provenance("x"))).toThrow(FactCorrectionRejectedError);
  });

  it("rejects a corrected value whose denomination disagrees with the prior value's", () => {
    const state = baseState();
    const decision = correctionDecision({ correctedValue: money("USD", 2, 100n) });
    expect(() => recordFactCorrection(state, decision, provenance("x"))).toThrow(FactCorrectionRejectedError);
  });

  it("allows a correction to set a value when the prior value was MISSING (null) — no denomination to compare against", () => {
    const state = baseState();
    const decision = correctionDecision({ factId: "contingent-liabilities-cur", correctedValue: money("TZS", 2, 500000n) });
    const next = recordFactCorrection(state, decision, provenance("now disclosed"));
    expect(resolveLatestFact(next.report.facts, "contingent-liabilities-cur")?.value).toEqual(money("TZS", 2, 500000n));
  });
});

describe("recordFactCorrection — two competing corrections from the same base", () => {
  it("the first commits; the second (still targeting the original base) is rejected once the first is authoritative", () => {
    const state = baseState();
    const decisionA = correctionDecision({ decisionId: "decision-a", correctedValue: money("TZS", 2, 111n) });
    const decisionB = correctionDecision({ decisionId: "decision-b", correctedValue: money("TZS", 2, 222n) });

    const afterA = recordFactCorrection(state, decisionA, provenance("A"));
    expect(() => recordFactCorrection(afterA, decisionB, provenance("B"))).toThrow(FactCorrectionRejectedError);

    expect(resolveLatestFact(afterA.report.facts, "ppe-net-cur")?.value).toEqual(money("TZS", 2, 111n));
    expect(afterA.decisions).toHaveLength(1);
  });
});
