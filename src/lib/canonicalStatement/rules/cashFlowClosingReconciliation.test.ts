import { describe, expect, it } from "vitest";
import { cashFlowClosingReconciliationRule } from "./cashFlowClosingReconciliation";
import { buildRuleContext } from "./ruleEngine";
import { testReport } from "./testReport";
import { CANONICAL_CONCEPTS } from "../concepts";
import { fact, line, CURRENT } from "../fixtures/builders";
import { ZERO_TOLERANCE } from "../money";
import type { Statement } from "../types";

function reportWithCashFlowAndSfp(closingAmount: string, sfpAmount: string | undefined, includeSfp = true) {
  const closingFact = fact("closing", closingAmount, "TZS", 2, CURRENT);
  const cashFlowStatement: Statement = {
    statementId: "cf",
    type: "STATEMENT_OF_CASH_FLOWS",
    title: "CF",
    sections: [{ sectionId: "s", label: "s", lines: [line("l-closing", "Closing cash", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF, "DETAIL", closingFact.factId)] }],
  };
  const facts = [closingFact];
  const statements: Statement[] = [cashFlowStatement];
  if (includeSfp && sfpAmount !== undefined) {
    const sfpFact = fact("sfp-cash", sfpAmount, "TZS", 2, CURRENT);
    facts.push(sfpFact);
    statements.push({
      statementId: "sfp",
      type: "STATEMENT_OF_FINANCIAL_POSITION",
      title: "SFP",
      sections: [{ sectionId: "s", label: "s", lines: [line("l-sfp-cash", "Cash", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP, "DETAIL", sfpFact.factId)] }],
    });
  } else if (includeSfp) {
    statements.push({ statementId: "sfp", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "SFP", sections: [] });
  }
  return testReport({ statements, facts });
}

describe("Cash-flow closing cash reconciliation", () => {
  it("PASSes when the two figures match", () => {
    const report = reportWithCashFlowAndSfp("500.00", "500.00");
    const [result] = cashFlowClosingReconciliationRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("PASS");
  });

  it("FAILs when the two figures disagree", () => {
    const report = reportWithCashFlowAndSfp("550.00", "500.00");
    const [result] = cashFlowClosingReconciliationRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("FAIL");
  });

  it("is NOT_APPLICABLE when no cash flow (or cash receipts and payments) statement exists at all", () => {
    const report = testReport({ statements: [] });
    const [result] = cashFlowClosingReconciliationRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("NOT_APPLICABLE");
  });

  it("is NOT_APPLICABLE (not INSUFFICIENT_EVIDENCE) when there is no SFP at all — expected for cash-basis reporting", () => {
    const report = reportWithCashFlowAndSfp("500.00", undefined, false);
    const [result] = cashFlowClosingReconciliationRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("NOT_APPLICABLE");
  });

  it("is INSUFFICIENT_EVIDENCE when an SFP exists but lacks the expected cash line", () => {
    const report = reportWithCashFlowAndSfp("500.00", undefined, true);
    const [result] = cashFlowClosingReconciliationRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });
});
