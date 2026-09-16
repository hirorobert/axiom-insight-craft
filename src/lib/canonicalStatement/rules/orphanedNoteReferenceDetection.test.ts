import { describe, expect, it } from "vitest";
import { orphanedNoteReferenceDetectionRule } from "./orphanedNoteReferenceDetection";
import { buildRuleContext } from "./ruleEngine";
import { testReport } from "./testReport";
import { fact, line, CURRENT } from "../fixtures/builders";
import { ZERO_TOLERANCE } from "../money";
import type { Statement } from "../types";

function reportWithLineAndNote() {
  const f = fact("f", "100.00", "TZS", 2, CURRENT);
  const l = line("l-1", "Line", "concept", "DETAIL", f.factId);
  const statement: Statement = { statementId: "s", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "S", sections: [{ sectionId: "sec", label: "sec", lines: [l] }] };
  return { statement, line: l, facts: [f] };
}

describe("Broken or orphaned note-reference detection", () => {
  it("is NOT_APPLICABLE when the report declares no note references at all", () => {
    const report = testReport({ noteReferences: [] });
    const [result] = orphanedNoteReferenceDetectionRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("NOT_APPLICABLE");
  });

  it("PASSes a reference whose line and note both resolve", () => {
    const { statement, line: l, facts } = reportWithLineAndNote();
    const report = testReport({
      statements: [statement],
      notes: [{ noteId: "note-1", noteNumber: "1", title: "N", monetaryFactIds: [] }],
      noteReferences: [{ noteReferenceId: "nr-1", fromLineId: l.lineId, toNoteId: "note-1" }],
      facts,
    });
    const [result] = orphanedNoteReferenceDetectionRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("PASS");
  });

  it('FAILs a "broken" reference — toNoteId does not resolve to any note', () => {
    const { statement, line: l, facts } = reportWithLineAndNote();
    const report = testReport({
      statements: [statement],
      notes: [],
      noteReferences: [{ noteReferenceId: "nr-1", fromLineId: l.lineId, toNoteId: "note-does-not-exist" }],
      facts,
    });
    const [result] = orphanedNoteReferenceDetectionRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("FAIL");
    expect(result.deterministicCalculation).toMatch(/broken reference/);
  });

  it('FAILs an "orphaned" reference — fromLineId does not resolve to any line', () => {
    const report = testReport({
      statements: [],
      notes: [{ noteId: "note-1", noteNumber: "1", title: "N", monetaryFactIds: [] }],
      noteReferences: [{ noteReferenceId: "nr-1", fromLineId: "line-does-not-exist", toNoteId: "note-1" }],
    });
    const [result] = orphanedNoteReferenceDetectionRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("FAIL");
    expect(result.deterministicCalculation).toMatch(/orphaned reference/);
  });

  it("a Note with zero inbound references is never itself flagged", () => {
    const { statement, line: l, facts } = reportWithLineAndNote();
    const report = testReport({
      statements: [statement],
      notes: [
        { noteId: "note-1", noteNumber: "1", title: "Referenced", monetaryFactIds: [] },
        { noteId: "note-2", noteNumber: "2", title: "Basis of preparation — never referenced, and that's normal", monetaryFactIds: [] },
      ],
      noteReferences: [{ noteReferenceId: "nr-1", fromLineId: l.lineId, toNoteId: "note-1" }],
      facts,
    });
    const results = orphanedNoteReferenceDetectionRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(results.every((r) => r.outcome !== "FAIL")).toBe(true);
  });
});
