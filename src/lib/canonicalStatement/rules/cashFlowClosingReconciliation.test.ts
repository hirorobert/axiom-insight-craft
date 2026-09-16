import { describe, expect, it } from "vitest";
import { cashFlowClosingReconciliationRule } from "./cashFlowClosingReconciliation";
import { buildUncheckedRuleContext, testReport } from "./testReport";
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
    sections: [{ sectionId: "cf-s", label: "s", lines: [line("l-closing", "Closing cash", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF, "DETAIL", closingFact.factId)] }],
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
      sections: [{ sectionId: "sfp-s", label: "s", lines: [line("l-sfp-cash", "Cash", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP, "DETAIL", sfpFact.factId)] }],
    });
  } else if (includeSfp) {
    statements.push({ statementId: "sfp", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "SFP", sections: [] });
  }
  return testReport({ statements, facts });
}

describe("Cash-flow closing cash reconciliation", () => {
  it("PASSes when the two figures match", () => {
    const report = reportWithCashFlowAndSfp("500.00", "500.00");
    const [result] = cashFlowClosingReconciliationRule.evaluate(buildUncheckedRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("PASS");
  });

  it("FAILs when the two figures disagree", () => {
    const report = reportWithCashFlowAndSfp("550.00", "500.00");
    const [result] = cashFlowClosingReconciliationRule.evaluate(buildUncheckedRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("FAIL");
  });

  it("is NOT_APPLICABLE when no cash flow (or cash receipts and payments) statement exists at all", () => {
    const report = testReport({ statements: [] });
    const [result] = cashFlowClosingReconciliationRule.evaluate(buildUncheckedRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("NOT_APPLICABLE");
  });

  it("is NOT_APPLICABLE (not INSUFFICIENT_EVIDENCE) when there is no SFP at all — expected for cash-basis reporting", () => {
    const report = reportWithCashFlowAndSfp("500.00", undefined, false);
    const [result] = cashFlowClosingReconciliationRule.evaluate(buildUncheckedRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("NOT_APPLICABLE");
  });

  it("is INSUFFICIENT_EVIDENCE when an SFP exists but lacks the expected cash line", () => {
    const report = reportWithCashFlowAndSfp("500.00", undefined, true);
    const [result] = cashFlowClosingReconciliationRule.evaluate(buildUncheckedRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("Cash-flow closing cash reconciliation — no first-statement authority (multiple SFP statements)", () => {
  it("is INSUFFICIENT_EVIDENCE, naming every conflicting statementId, when more than one SFP statement is present", () => {
    const closingFact = fact("closing", "500.00", "TZS", 2, CURRENT);
    const cashFlowStatement: Statement = {
      statementId: "cf",
      type: "STATEMENT_OF_CASH_FLOWS",
      title: "CF",
      sections: [{ sectionId: "cf-s", label: "s", lines: [line("l-closing", "Closing cash", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF, "DETAIL", closingFact.factId)] }],
    };
    const sfpFactA = fact("sfp-cash-a", "500.00", "TZS", 2, CURRENT);
    const sfpFactB = fact("sfp-cash-b", "400.00", "TZS", 2, CURRENT);
    const sfpA: Statement = { statementId: "sfp-a", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "SFP A", sections: [{ sectionId: "sfp-a-s", label: "s", lines: [line("l-a", "Cash", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP, "DETAIL", sfpFactA.factId)] }] };
    const sfpB: Statement = { statementId: "sfp-b", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "SFP B", sections: [{ sectionId: "sfp-b-s", label: "s", lines: [line("l-b", "Cash", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP, "DETAIL", sfpFactB.factId)] }] };
    const report = testReport({ statements: [cashFlowStatement, sfpA, sfpB], facts: [closingFact, sfpFactA, sfpFactB] });

    const [result] = cashFlowClosingReconciliationRule.evaluate(buildUncheckedRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.deterministicCalculation).toContain("sfp-a");
    expect(result.deterministicCalculation).toContain("sfp-b");
    expect(result.evidenceReferences.map((e) => e.statementId).sort()).toEqual(["sfp-a", "sfp-b"]);
  });

  it("never silently picks the first SFP statement — the result is the SAME (INSUFFICIENT_EVIDENCE, both ids named) regardless of declaration order", () => {
    const closingFact = fact("closing", "500.00", "TZS", 2, CURRENT);
    const cashFlowStatement: Statement = {
      statementId: "cf",
      type: "STATEMENT_OF_CASH_FLOWS",
      title: "CF",
      sections: [{ sectionId: "cf-s", label: "s", lines: [line("l-closing", "Closing cash", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF, "DETAIL", closingFact.factId)] }],
    };
    const sfpFactA = fact("sfp-cash-a", "500.00", "TZS", 2, CURRENT);
    const sfpFactB = fact("sfp-cash-b", "400.00", "TZS", 2, CURRENT);
    const sfpA: Statement = { statementId: "sfp-a", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "SFP A", sections: [{ sectionId: "sfp-a-s", label: "s", lines: [line("l-a", "Cash", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP, "DETAIL", sfpFactA.factId)] }] };
    const sfpB: Statement = { statementId: "sfp-b", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "SFP B", sections: [{ sectionId: "sfp-b-s", label: "s", lines: [line("l-b", "Cash", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP, "DETAIL", sfpFactB.factId)] }] };

    const forwardOrder = testReport({ statements: [cashFlowStatement, sfpA, sfpB], facts: [closingFact, sfpFactA, sfpFactB] });
    const reverseOrder = testReport({ statements: [cashFlowStatement, sfpB, sfpA], facts: [closingFact, sfpFactA, sfpFactB] });

    const [forwardResult] = cashFlowClosingReconciliationRule.evaluate(buildUncheckedRuleContext(forwardOrder, ZERO_TOLERANCE));
    const [reverseResult] = cashFlowClosingReconciliationRule.evaluate(buildUncheckedRuleContext(reverseOrder, ZERO_TOLERANCE));

    expect(forwardResult.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(reverseResult.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(forwardResult.evidenceReferences.map((e) => e.statementId).sort()).toEqual(reverseResult.evidenceReferences.map((e) => e.statementId).sort());
  });
});

describe("Cash-flow closing cash reconciliation — no first-match concept authority", () => {
  it("is INSUFFICIENT_EVIDENCE, naming every conflicting lineId, when the cash-flow statement has more than one closing-cash line", () => {
    const closingFactA = fact("closing-a", "500.00", "TZS", 2, CURRENT);
    const closingFactB = fact("closing-b", "999.00", "TZS", 2, CURRENT);
    const cashFlowStatement: Statement = {
      statementId: "cf",
      type: "STATEMENT_OF_CASH_FLOWS",
      title: "CF",
      sections: [
        {
          sectionId: "cf-s",
          label: "s",
          lines: [
            line("l-closing-a", "Closing cash A", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF, "DETAIL", closingFactA.factId),
            line("l-closing-b", "Closing cash B", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF, "DETAIL", closingFactB.factId),
          ],
        },
      ],
    };
    const sfpFact = fact("sfp-cash", "500.00", "TZS", 2, CURRENT);
    const sfp: Statement = { statementId: "sfp", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "SFP", sections: [{ sectionId: "sfp-s", label: "s", lines: [line("l-sfp-cash", "Cash", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP, "DETAIL", sfpFact.factId)] }] };
    const report = testReport({ statements: [cashFlowStatement, sfp], facts: [closingFactA, closingFactB, sfpFact] });

    const [result] = cashFlowClosingReconciliationRule.evaluate(buildUncheckedRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.evidenceReferences.map((e) => e.lineId).sort()).toEqual(["l-closing-a", "l-closing-b"]);
  });
});
