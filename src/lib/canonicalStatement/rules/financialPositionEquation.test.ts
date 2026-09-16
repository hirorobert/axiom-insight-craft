import { describe, expect, it } from "vitest";
import { financialPositionEquationRule } from "./financialPositionEquation";
import { buildRuleContext } from "./ruleEngine";
import { testReport } from "./testReport";
import { CANONICAL_CONCEPTS } from "../concepts";
import { fact, line, CURRENT } from "../fixtures/builders";
import { ZERO_TOLERANCE } from "../money";

function sfpStatement(assetsAmount: string, liabilitiesAmount: string, equityAmount: string) {
  const assets = fact("assets", assetsAmount, "TZS", 2, CURRENT);
  const liabilities = fact("liabilities", liabilitiesAmount, "TZS", 2, CURRENT);
  const equity = fact("equity", equityAmount, "TZS", 2, CURRENT);
  return {
    facts: [assets, liabilities, equity],
    statement: {
      statementId: "sfp",
      type: "STATEMENT_OF_FINANCIAL_POSITION" as const,
      title: "SFP",
      sections: [
        {
          sectionId: "s",
          label: "s",
          lines: [
            line("l-assets", "Total assets", CANONICAL_CONCEPTS.TOTAL_ASSETS, "TOTAL", assets.factId),
            line("l-liabilities", "Total liabilities", CANONICAL_CONCEPTS.TOTAL_LIABILITIES, "TOTAL", liabilities.factId),
            line("l-equity", "Total equity", CANONICAL_CONCEPTS.TOTAL_EQUITY, "TOTAL", equity.factId),
          ],
        },
      ],
    },
  };
}

describe("Statement of financial position equation", () => {
  it("PASSes when assets = liabilities + equity exactly", () => {
    const { statement, facts } = sfpStatement("1000.00", "400.00", "600.00");
    const report = testReport({ statements: [statement], facts });
    const [result] = financialPositionEquationRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("PASS");
  });

  it("FAILs when the equation does not balance", () => {
    const { statement, facts } = sfpStatement("1000.00", "400.00", "550.00");
    const report = testReport({ statements: [statement], facts });
    const [result] = financialPositionEquationRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("FAIL");
  });

  it("is INSUFFICIENT_EVIDENCE, never FAIL, when a required total is missing (never coerced to zero)", () => {
    const assets = fact("assets", "1000.00", "TZS", 2, CURRENT);
    const liabilities = fact("liabilities", null, "TZS", 2, CURRENT); // MISSING, not zero
    const equity = fact("equity", "600.00", "TZS", 2, CURRENT);
    const statement = {
      statementId: "sfp",
      type: "STATEMENT_OF_FINANCIAL_POSITION" as const,
      title: "SFP",
      sections: [
        {
          sectionId: "s",
          label: "s",
          lines: [
            line("l-assets", "Total assets", CANONICAL_CONCEPTS.TOTAL_ASSETS, "TOTAL", assets.factId),
            line("l-liabilities", "Total liabilities", CANONICAL_CONCEPTS.TOTAL_LIABILITIES, "TOTAL", liabilities.factId),
            line("l-equity", "Total equity", CANONICAL_CONCEPTS.TOTAL_EQUITY, "TOTAL", equity.factId),
          ],
        },
      ],
    };
    const report = testReport({ statements: [statement], facts: [assets, liabilities, equity] });
    const [result] = financialPositionEquationRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("is NOT_APPLICABLE when no statement of financial position exists at all", () => {
    const report = testReport({ statements: [] });
    const [result] = financialPositionEquationRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("NOT_APPLICABLE");
  });

  it("respects tolerance for a small rounding drift, but not beyond it", () => {
    const { statement, facts } = sfpStatement("1000.01", "400.00", "600.00");
    const report = testReport({ statements: [statement], facts });
    const passing = financialPositionEquationRule.evaluate(buildRuleContext(report, { absoluteMinorUnits: 1n }))[0];
    expect(passing.outcome).toBe("PASS");
    const failing = financialPositionEquationRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE))[0];
    expect(failing.outcome).toBe("FAIL");
  });
});
