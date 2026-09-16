import { describe, expect, it } from "vitest";
import { movementReconciliationRule } from "./movementReconciliation";
import { buildRuleContext } from "./ruleEngine";
import { testReport } from "./testReport";
import { fact, CURRENT } from "../fixtures/builders";
import { ZERO_TOLERANCE } from "../money";
import type { MovementSchedule, Note } from "../types";

function noteWithSchedule(opening: string, additions: string[], disposals: string[], other: { amount: string; sign: "ADD" | "SUBTRACT" }[], closing: string) {
  const openingFact = fact("opening", opening, "TZS", 2, CURRENT);
  const additionFacts = additions.map((a, i) => fact(`add-${i}`, a, "TZS", 2, CURRENT));
  const disposalFacts = disposals.map((d, i) => fact(`dis-${i}`, d, "TZS", 2, CURRENT));
  const otherFacts = other.map((o, i) => fact(`other-${i}`, o.amount, "TZS", 2, CURRENT));
  const closingFact = fact("closing", closing, "TZS", 2, CURRENT);

  const schedule: MovementSchedule = {
    scheduleId: "sch-1",
    openingBalanceFactId: openingFact.factId,
    additionFactIds: additionFacts.map((f) => f.factId),
    disposalFactIds: disposalFacts.map((f) => f.factId),
    otherMovements: otherFacts.map((f, i) => ({ factId: f.factId, sign: other[i].sign })),
    closingBalanceFactId: closingFact.factId,
  };
  const note: Note = { noteId: "note-1", noteNumber: "5", title: "PPE", monetaryFactIds: [], movementSchedule: schedule };
  return { note, facts: [openingFact, ...additionFacts, ...disposalFacts, ...otherFacts, closingFact] };
}

describe("Movement reconciliation", () => {
  it("PASSes a simple opening + additions - disposals = closing schedule", () => {
    const { note, facts } = noteWithSchedule("1800000.00", ["300000.00"], ["100000.00"], [], "2000000.00");
    const report = testReport({ notes: [note], facts });
    const [result] = movementReconciliationRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("PASS");
  });

  it("PASSes with an ADD other-movement (e.g. a revaluation surplus)", () => {
    const { note, facts } = noteWithSchedule("5000000", ["800000"], ["200000"], [{ amount: "400000", sign: "ADD" }], "6000000");
    const report = testReport({ notes: [note], facts, scale: 0 });
    const [result] = movementReconciliationRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("PASS");
  });

  it("PASSes with a SUBTRACT other-movement (e.g. an impairment)", () => {
    const { note, facts } = noteWithSchedule("1000.00", ["0.00"], ["0.00"], [{ amount: "100.00", sign: "SUBTRACT" }], "900.00");
    const report = testReport({ notes: [note], facts });
    const [result] = movementReconciliationRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("PASS");
  });

  it("FAILs when the roll-forward does not sum to the reported closing balance", () => {
    const { note, facts } = noteWithSchedule("1800000.00", ["200000.00"], ["100000.00"], [], "2100000.00");
    const report = testReport({ notes: [note], facts });
    const [result] = movementReconciliationRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("FAIL");
  });

  it("is INSUFFICIENT_EVIDENCE when a movement fact is missing (never treated as zero)", () => {
    const opening = fact("opening", "1000.00", "TZS", 2, CURRENT);
    const addition = fact("add-0", null, "TZS", 2, CURRENT); // MISSING
    const closing = fact("closing", "1000.00", "TZS", 2, CURRENT);
    const note: Note = {
      noteId: "n",
      noteNumber: "1",
      title: "N",
      monetaryFactIds: [],
      movementSchedule: { scheduleId: "s", openingBalanceFactId: opening.factId, additionFactIds: [addition.factId], disposalFactIds: [], otherMovements: [], closingBalanceFactId: closing.factId },
    };
    const report = testReport({ notes: [note], facts: [opening, addition, closing] });
    const [result] = movementReconciliationRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("is NOT_APPLICABLE when no note declares a movement schedule", () => {
    const report = testReport({ notes: [{ noteId: "n", noteNumber: "1", title: "Narrative", monetaryFactIds: [] }] });
    const [result] = movementReconciliationRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("NOT_APPLICABLE");
  });
});
