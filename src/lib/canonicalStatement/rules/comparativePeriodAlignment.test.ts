import { describe, expect, it } from "vitest";
import { comparativePeriodAlignmentRule } from "./comparativePeriodAlignment";
import { buildUncheckedRuleContext, testReport } from "./testReport";
import { fact, line, CURRENT, COMPARATIVE_1 } from "../fixtures/builders";
import { ZERO_TOLERANCE } from "../money";
import type { ReportingPeriodRef, Statement } from "../types";

const DECLARED_COMPARATIVE = { periodId: "COMPARATIVE_1", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025, isRestated: false };

function statementWithComparatives(periods: ReportingPeriodRef[]) {
  const currentFacts = periods.map((_, i) => fact(`cur-${i}`, "100.00", "TZS", 2, CURRENT));
  const comparativeFacts = periods.map((p, i) => fact(`cmp-${i}`, "90.00", "TZS", 2, p));
  const lines = periods.map((_, i) => line(`l-${i}`, `Line ${i}`, `concept_${i}`, "DETAIL", currentFacts[i].factId, { comparativeFactId: comparativeFacts[i].factId }));
  const statement: Statement = { statementId: "s", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "S", sections: [{ sectionId: "sec", label: "sec", lines }] };
  return { statement, facts: [...currentFacts, ...comparativeFacts] };
}

describe("Current-period/comparative-period alignment", () => {
  it("PASSes when every comparative fact consistently references the one declared comparative period", () => {
    const { statement, facts } = statementWithComparatives([COMPARATIVE_1, COMPARATIVE_1]);
    const report = testReport({ statements: [statement], facts, comparativePeriods: [DECLARED_COMPARATIVE] });
    const [result] = comparativePeriodAlignmentRule.evaluate(buildUncheckedRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("PASS");
  });

  it("FAILs when a statement mixes two distinct comparative periods", () => {
    const { statement, facts } = statementWithComparatives([COMPARATIVE_1, { periodId: "COMPARATIVE_ROGUE", isComparative: true }]);
    const report = testReport({
      statements: [statement],
      facts,
      comparativePeriods: [DECLARED_COMPARATIVE, { periodId: "COMPARATIVE_ROGUE", startDate: "2024-01-01", endDate: "2024-12-31", periodYear: 2024, isRestated: false }],
    });
    const [result] = comparativePeriodAlignmentRule.evaluate(buildUncheckedRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("FAIL");
  });

  it("FAILs when a comparative fact references an undeclared period", () => {
    const { statement, facts } = statementWithComparatives([{ periodId: "COMPARATIVE_UNDECLARED", isComparative: true }]);
    const report = testReport({ statements: [statement], facts, comparativePeriods: [DECLARED_COMPARATIVE] });
    const [result] = comparativePeriodAlignmentRule.evaluate(buildUncheckedRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("FAIL");
  });

  it("is NOT_APPLICABLE when a statement declares no comparative facts at all", () => {
    const line1 = line("l-1", "Line", "concept_1", "DETAIL", fact("cur", "100.00", "TZS", 2, CURRENT).factId);
    const statement: Statement = { statementId: "s", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "S", sections: [{ sectionId: "sec", label: "sec", lines: [line1] }] };
    const report = testReport({ statements: [statement], comparativePeriods: [DECLARED_COMPARATIVE] });
    const [result] = comparativePeriodAlignmentRule.evaluate(buildUncheckedRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("NOT_APPLICABLE");
  });
});
