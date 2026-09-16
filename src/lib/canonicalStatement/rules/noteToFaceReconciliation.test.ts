import { describe, expect, it } from "vitest";
import { noteToFaceReconciliationRule } from "./noteToFaceReconciliation";
import { buildUncheckedRuleContext, testReport } from "./testReport";
import { fact, line, CURRENT } from "../fixtures/builders";
import { ZERO_TOLERANCE } from "../money";
import type { Statement } from "../types";

function reportWithFaceAndNote(faceAmount: string, noteTotalAmount: string | undefined) {
  const faceFact = fact("face", faceAmount, "TZS", 2, CURRENT);
  const faceLine = line("l-face", "PPE", "ppe_net", "DETAIL", faceFact.factId);
  const statement: Statement = { statementId: "s", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "S", sections: [{ sectionId: "sec", label: "sec", lines: [faceLine] }] };
  const facts = [faceFact];
  let totalFactId: string | undefined;
  if (noteTotalAmount !== undefined) {
    const noteFact = fact("note-total", noteTotalAmount, "TZS", 2, CURRENT);
    facts.push(noteFact);
    totalFactId = noteFact.factId;
  }
  return testReport({
    statements: [statement],
    notes: [{ noteId: "note-1", noteNumber: "5", title: "PPE", monetaryFactIds: [], totalFactId }],
    noteReferences: [{ noteReferenceId: "nr-1", fromLineId: faceLine.lineId, toNoteId: "note-1" }],
    facts,
  });
}

describe("Note-to-face reconciliation", () => {
  it("PASSes when the face value equals the note's declared total", () => {
    const report = reportWithFaceAndNote("2000000.00", "2000000.00");
    const [result] = noteToFaceReconciliationRule.evaluate(buildUncheckedRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("PASS");
  });

  it("FAILs when the face value and the note's total disagree", () => {
    const report = reportWithFaceAndNote("2000000.00", "2100000.00");
    const [result] = noteToFaceReconciliationRule.evaluate(buildUncheckedRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("FAIL");
  });

  it("is NOT_APPLICABLE for a narrative-only note with no total to reconcile", () => {
    const report = reportWithFaceAndNote("2000000.00", undefined);
    const [result] = noteToFaceReconciliationRule.evaluate(buildUncheckedRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("NOT_APPLICABLE");
  });

  it("falls back to the movement schedule's closing balance when no totalFactId is declared", () => {
    const faceFact = fact("face", "500.00", "TZS", 2, CURRENT);
    const closingFact = fact("closing", "500.00", "TZS", 2, CURRENT);
    const faceLine = line("l-face", "PPE", "ppe_net", "DETAIL", faceFact.factId);
    const statement: Statement = { statementId: "s", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "S", sections: [{ sectionId: "sec", label: "sec", lines: [faceLine] }] };
    const report = testReport({
      statements: [statement],
      notes: [
        {
          noteId: "note-1",
          noteNumber: "5",
          title: "PPE",
          monetaryFactIds: [],
          movementSchedule: { scheduleId: "sch", openingBalanceFactId: "x", additionFactIds: [], disposalFactIds: [], otherMovements: [], closingBalanceFactId: closingFact.factId },
        },
      ],
      noteReferences: [{ noteReferenceId: "nr-1", fromLineId: faceLine.lineId, toNoteId: "note-1" }],
      facts: [faceFact, closingFact],
    });
    const [result] = noteToFaceReconciliationRule.evaluate(buildUncheckedRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("PASS");
  });

  it("is NOT_APPLICABLE (no duplicate finding) when the reference is broken — that is Rule 10's job", () => {
    const report = testReport({
      statements: [],
      notes: [],
      noteReferences: [{ noteReferenceId: "nr-1", fromLineId: "no-such-line", toNoteId: "no-such-note" }],
    });
    const [result] = noteToFaceReconciliationRule.evaluate(buildUncheckedRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("NOT_APPLICABLE");
  });
});
