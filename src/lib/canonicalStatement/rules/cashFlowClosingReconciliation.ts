// Rule 6 — cash-flow closing cash reconciliation: the closing cash figure
// at the foot of the cash flow statement (or cash receipts and payments
// statement, IPSAS cash basis) must equal cash and cash equivalents as
// presented on the face of the statement of financial position, evaluated
// independently for the current period and for every declared comparative
// period (however many there are).

import { equalsWithinTolerance, formatMoney } from "../money";
import { CANONICAL_CONCEPTS } from "../concepts";
import { allPeriodIds, factIdForPeriod, findLineByConcept, resolveFact, statementsOfType } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";
import type { Statement } from "../types";

export const RULE_ID = "cashflow-closing-cash-reconciliation";
export const RULE_VERSION = "1.0.0";

function evaluatePeriod(
  ctx: RuleContext,
  cashFlowStatement: Statement,
  sfpStatement: Statement | undefined,
  periodId: string,
  isComparative: boolean,
): RuleEvaluationResult | null {
  const closingLine = findLineByConcept(cashFlowStatement, CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF);
  const sfpLine = sfpStatement ? findLineByConcept(sfpStatement, CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP) : undefined;
  const discriminator = `${cashFlowStatement.statementId}:${periodId}`;
  const affected = { statementId: cashFlowStatement.statementId };

  const closingFactId = closingLine ? factIdForPeriod(closingLine, periodId) : undefined;
  const sfpFactId = sfpLine ? factIdForPeriod(sfpLine, periodId) : undefined;

  if (!sfpStatement) {
    if (isComparative) return null;
    return {
      outcome: "NOT_APPLICABLE",
      failureSeverity: "INFORMATIONAL",
      observedValues: {},
      expectedRelationship: "cash flow statement closing cash = SFP cash and cash equivalents",
      deterministicCalculation: "this report has no statement of financial position to reconcile against — expected for pure cash-basis reporting",
      evidenceReferences: [],
      affected,
      remediationGuidance: "No action required.",
      discriminator,
      periodId,
    };
  }

  if (!closingLine || !sfpLine || !closingFactId || !sfpFactId) {
    if (isComparative) return null; // only report the comparative gap when a comparative binding actually exists
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      failureSeverity: "MEDIUM",
      observedValues: {},
      expectedRelationship: "cash flow statement closing cash = SFP cash and cash equivalents",
      deterministicCalculation: !closingLine || !closingFactId ? "no cash-flow closing-cash binding found for this period" : "no SFP cash-and-cash-equivalents binding found for this period",
      evidenceReferences: [],
      affected,
      remediationGuidance: "Declare both the cash-flow closing-cash line and the SFP cash-and-cash-equivalents line, each bound to this period, with their canonical concepts.",
      discriminator,
      periodId,
    };
  }

  const closing = resolveFact(ctx, closingFactId);
  const sfpCash = resolveFact(ctx, sfpFactId);

  if (closing.status !== "PRESENT" || sfpCash.status !== "PRESENT") {
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      failureSeverity: "MEDIUM",
      observedValues: {
        closingCash: { kind: "MONEY", value: closing.status === "PRESENT" ? closing.money : null },
        sfpCash: { kind: "MONEY", value: sfpCash.status === "PRESENT" ? sfpCash.money : null },
      },
      expectedRelationship: "cash flow statement closing cash = SFP cash and cash equivalents",
      deterministicCalculation: "one or both figures are missing for this period",
      evidenceReferences: [],
      affected,
      remediationGuidance: "Ensure both figures are extracted for this period before this rule can run.",
      discriminator,
      periodId,
    };
  }

  const denominationMatches = closing.money.currency === sfpCash.money.currency && closing.money.scale === sfpCash.money.scale;
  const pass = denominationMatches && equalsWithinTolerance(closing.money, sfpCash.money, ctx.tolerance);

  return {
    outcome: denominationMatches ? (pass ? "PASS" : "FAIL") : "INSUFFICIENT_EVIDENCE",
    failureSeverity: "CRITICAL",
    observedValues: {
      closingCash: { kind: "MONEY", value: closing.money },
      sfpCash: { kind: "MONEY", value: sfpCash.money },
    },
    expectedRelationship: "cash flow statement closing cash = SFP cash and cash equivalents",
    deterministicCalculation: denominationMatches ? `${formatMoney(closing.money)} vs ${formatMoney(sfpCash.money)}` : "denominated differently — cannot compare",
    evidenceReferences: [
      { evidenceReferenceId: `${discriminator}:closing`, factId: closingFactId },
      { evidenceReferenceId: `${discriminator}:sfp`, factId: sfpFactId },
    ],
    affected,
    remediationGuidance: pass ? "No action required." : "Reconcile the cash flow statement's closing cash against the SFP's cash and cash equivalents for this period.",
    discriminator,
    periodId,
  };
}

export const cashFlowClosingReconciliationRule: RuleDefinition = {
  ruleId: RULE_ID,
  ruleVersion: RULE_VERSION,
  title: "Cash-flow closing cash reconciliation",
  evaluate(ctx: RuleContext): readonly RuleEvaluationResult[] {
    const cashFlowStatements = [
      ...statementsOfType(ctx.report, "STATEMENT_OF_CASH_FLOWS"),
      ...statementsOfType(ctx.report, "STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS"),
    ];
    if (cashFlowStatements.length === 0) {
      return [
        {
          outcome: "NOT_APPLICABLE",
          failureSeverity: "INFORMATIONAL",
          observedValues: {},
          expectedRelationship: "cash flow statement closing cash = SFP cash and cash equivalents",
          deterministicCalculation: "no cash flow / cash receipts and payments statement is present in this report",
          evidenceReferences: [],
          affected: {},
          remediationGuidance: "No action required.",
          discriminator: "no-cashflow-statement",
        },
      ];
    }

    const [sfpStatement] = statementsOfType(ctx.report, "STATEMENT_OF_FINANCIAL_POSITION");
    const results: RuleEvaluationResult[] = [];
    for (const cashFlowStatement of cashFlowStatements) {
      for (const periodId of allPeriodIds(ctx.report)) {
        const result = evaluatePeriod(ctx, cashFlowStatement, sfpStatement, periodId, periodId !== ctx.report.period.periodId);
        if (result) results.push(result);
      }
    }
    return results;
  },
};
