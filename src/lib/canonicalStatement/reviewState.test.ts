import { describe, expect, it } from "vitest";
import { FactCorrectionRejectedError, recordFactCorrection, type CanonicalReviewState } from "./reviewState";
import { resolveLatestFact } from "./provenance";
import { money } from "./money";
import { provenance } from "./fixtures/builders";
import { IFRS_FULL_FIXTURE } from "./fixtures/ifrsFullFixture";
import type { CorrectFactDecision } from "./types";

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
    const snapshotJson = JSON.stringify(state.report.facts, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    recordFactCorrection(state, correctionDecision(), provenance("corrected"));
    expect(state.report.facts).toHaveLength(originalFactsLength);
    expect(state.decisions).toHaveLength(originalDecisionsLength);
    expect(JSON.stringify(state.report.facts, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(snapshotJson);
  });

  it("returns a report that itself re-validates cleanly", () => {
    const state = baseState();
    // recordFactCorrection throws (via validateCanonicalReport) if the
    // resulting aggregate is not valid — reaching this line at all is part
    // of the assertion.
    const next = recordFactCorrection(state, correctionDecision(), provenance("corrected"));
    expect(next.report.reportIdentity.reportId).toBe(state.report.reportIdentity.reportId);
  });
});

describe("recordFactCorrection — rejection paths change nothing", () => {
  it("rejects a stale concurrent correction (supersedesVersion no longer the latest)", () => {
    const state = baseState();
    const first = recordFactCorrection(state, correctionDecision(), provenance("first correction"));
    // A second correction still claiming supersedesVersion=1 is now stale — version 2 already exists.
    const staleDecision = correctionDecision({ decisionId: "decision-2", supersedesVersion: 1, newVersion: 2, correctedValue: money("TZS", 2, 999n) });
    expect(() => recordFactCorrection(first, staleDecision, provenance("stale"))).toThrow(FactCorrectionRejectedError);
    // Nothing about `first` (the committed state) changes from the rejected attempt.
    expect(first.report.facts).toHaveLength(state.report.facts.length + 1);
    expect(first.decisions).toHaveLength(1);
  });

  it("rejects a duplicate decisionId", () => {
    const state = baseState();
    const committed = recordFactCorrection(state, correctionDecision(), provenance("first"));
    const duplicateIdDecision = correctionDecision({ supersedesVersion: 2, newVersion: 3, correctedValue: money("TZS", 2, 1n) });
    expect(() => recordFactCorrection(committed, duplicateIdDecision, provenance("duplicate"))).toThrow(FactCorrectionRejectedError);
  });

  it("a failed correction changes neither the fact ledger nor the decision log", () => {
    const state = baseState();
    const badDecision = correctionDecision({ supersedesVersion: 99, newVersion: 100 }); // wrong supersedesVersion
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
    // "contingent-liabilities-cur" is a genuinely MISSING fact in the golden fixture.
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
    // B still believes supersedesVersion=1 is current — but A already moved the fact to version 2.
    expect(() => recordFactCorrection(afterA, decisionB, provenance("B"))).toThrow(FactCorrectionRejectedError);

    // A's result is the sole authoritative state — B never touched it.
    expect(resolveLatestFact(afterA.report.facts, "ppe-net-cur")?.value).toEqual(money("TZS", 2, 111n));
    expect(afterA.decisions).toHaveLength(1);
  });
});
