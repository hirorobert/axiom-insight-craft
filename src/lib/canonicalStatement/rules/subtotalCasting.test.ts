import { describe, expect, it } from "vitest";
import { subtotalCastingRule } from "./subtotalCasting";
import { buildRuleContext } from "./ruleEngine";
import { testReport } from "./testReport";
import { fact, line, CURRENT } from "../fixtures/builders";
import { ZERO_TOLERANCE } from "../money";
import type { Statement } from "../types";

function statementWithTotal(childAmounts: string[], totalAmount: string, castingChildLineIds?: string[]) {
  const childFacts = childAmounts.map((amount, i) => fact(`child-${i}`, amount, "TZS", 2, CURRENT));
  const totalFact = fact("total", totalAmount, "TZS", 2, CURRENT);
  const childLines = childFacts.map((f, i) => line(`l-child-${i}`, `Child ${i}`, `child_${i}`, "DETAIL", f.factId));
  const totalLine = line("l-total", "Total", "a_total", "TOTAL", totalFact.factId, {
    castingChildLineIds: castingChildLineIds ?? childLines.map((l) => l.lineId),
  });
  const statement: Statement = {
    statementId: "s",
    type: "STATEMENT_OF_FINANCIAL_POSITION",
    title: "S",
    sections: [{ sectionId: "sec", label: "sec", lines: [...childLines, totalLine] }],
  };
  return { statement, facts: [...childFacts, totalFact] };
}

describe("Statement subtotal and total casting", () => {
  it("PASSes when the total equals the sum of its declared children", () => {
    const { statement, facts } = statementWithTotal(["100.00", "200.00"], "300.00");
    const report = testReport({ statements: [statement], facts });
    const results = subtotalCastingRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("PASS");
  });

  it("FAILs when the total does not equal the sum of its declared children", () => {
    const { statement, facts } = statementWithTotal(["100.00", "200.00"], "301.00");
    const report = testReport({ statements: [statement], facts });
    const [result] = subtotalCastingRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("FAIL");
  });

  it("DETAIL lines are never evaluated by this rule", () => {
    const { statement, facts } = statementWithTotal(["100.00"], "100.00");
    const report = testReport({ statements: [statement], facts });
    const results = subtotalCastingRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    // Only the TOTAL line produces a result — the DETAIL child does not.
    expect(results).toHaveLength(1);
  });

  it("is INSUFFICIENT_EVIDENCE, never a silent PASS, when a TOTAL line declares no casting children", () => {
    const { statement, facts } = statementWithTotal(["100.00"], "100.00", []);
    const report = testReport({ statements: [statement], facts });
    const [result] = subtotalCastingRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("is INSUFFICIENT_EVIDENCE when a declared child's value is missing (never treated as zero)", () => {
    const child1 = fact("c1", "100.00", "TZS", 2, CURRENT);
    const child2 = fact("c2", null, "TZS", 2, CURRENT); // MISSING
    const total = fact("t", "100.00", "TZS", 2, CURRENT);
    const l1 = line("l1", "C1", "c1", "DETAIL", child1.factId);
    const l2 = line("l2", "C2", "c2", "DETAIL", child2.factId);
    const totalLine = line("lt", "Total", "t", "TOTAL", total.factId, { castingChildLineIds: [l1.lineId, l2.lineId] });
    const statement: Statement = { statementId: "s", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "S", sections: [{ sectionId: "sec", label: "sec", lines: [l1, l2, totalLine] }] };
    const report = testReport({ statements: [statement], facts: [child1, child2, total] });
    const [result] = subtotalCastingRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("respects tolerance", () => {
    const { statement, facts } = statementWithTotal(["100.00", "200.00"], "300.01");
    const report = testReport({ statements: [statement], facts });
    const passing = subtotalCastingRule.evaluate(buildRuleContext(report, { absoluteMinorUnits: 1n }))[0];
    expect(passing.outcome).toBe("PASS");
  });
});
