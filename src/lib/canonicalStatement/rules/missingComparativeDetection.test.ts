import { describe, expect, it } from "vitest";
import { missingComparativeDetectionRule } from "./missingComparativeDetection";
import { buildRuleContext } from "./ruleEngine";
import { testReport } from "./testReport";
import { fact, line, CURRENT, COMPARATIVE_1 } from "../fixtures/builders";
import { ZERO_TOLERANCE } from "../money";
import type { Statement } from "../types";

const DECLARED_COMPARATIVE = { periodId: "COMPARATIVE_1", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025, isRestated: false };

describe("Missing comparative detection", () => {
  it("is NOT_APPLICABLE entirely when the report declares no comparative period", () => {
    const report = testReport({ comparativePeriods: [] });
    const [result] = missingComparativeDetectionRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("NOT_APPLICABLE");
  });

  it("PASSes a TOTAL line that has a present comparative value", () => {
    const cur = fact("cur", "100.00", "TZS", 2, CURRENT);
    const cmp = fact("cmp", "90.00", "TZS", 2, COMPARATIVE_1);
    const totalLine = line("l-total", "Total", "total_x", "TOTAL", cur.factId, { comparativeFactId: cmp.factId });
    const statement: Statement = { statementId: "s", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "S", sections: [{ sectionId: "sec", label: "sec", lines: [totalLine] }] };
    const report = testReport({ statements: [statement], facts: [cur, cmp], comparativePeriods: [DECLARED_COMPARATIVE] });
    const [result] = missingComparativeDetectionRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("PASS");
  });

  it("FAILs a TOTAL line with no comparative fact linked at all", () => {
    const cur = fact("cur", "100.00", "TZS", 2, CURRENT);
    const totalLine = line("l-total", "Total", "total_x", "TOTAL", cur.factId); // no comparativeFactId
    const statement: Statement = { statementId: "s", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "S", sections: [{ sectionId: "sec", label: "sec", lines: [totalLine] }] };
    const report = testReport({ statements: [statement], facts: [cur], comparativePeriods: [DECLARED_COMPARATIVE] });
    const [result] = missingComparativeDetectionRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("FAIL");
  });

  it("FAILs a TOTAL line whose comparative fact exists but has a null (MISSING) value", () => {
    const cur = fact("cur", "100.00", "TZS", 2, CURRENT);
    const cmp = fact("cmp", null, "TZS", 2, COMPARATIVE_1);
    const totalLine = line("l-total", "Total", "total_x", "TOTAL", cur.factId, { comparativeFactId: cmp.factId });
    const statement: Statement = { statementId: "s", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "S", sections: [{ sectionId: "sec", label: "sec", lines: [totalLine] }] };
    const report = testReport({ statements: [statement], facts: [cur, cmp], comparativePeriods: [DECLARED_COMPARATIVE] });
    const [result] = missingComparativeDetectionRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("FAIL");
  });

  it("never evaluates DETAIL lines", () => {
    const cur = fact("cur", "100.00", "TZS", 2, CURRENT);
    const detailLine = line("l-detail", "Detail", "detail_x", "DETAIL", cur.factId); // no comparative, but DETAIL role
    const statement: Statement = { statementId: "s", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "S", sections: [{ sectionId: "sec", label: "sec", lines: [detailLine] }] };
    const report = testReport({ statements: [statement], facts: [cur], comparativePeriods: [DECLARED_COMPARATIVE] });
    const results = missingComparativeDetectionRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(results).toHaveLength(0);
  });
});
