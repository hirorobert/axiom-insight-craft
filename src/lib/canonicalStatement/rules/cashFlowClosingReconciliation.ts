// Rule 6 — cash-flow closing cash reconciliation: the closing cash figure
// at the foot of the cash flow statement (or cash receipts and payments
// statement, IPSAS cash basis) must equal cash and cash equivalents as
// presented on the face of the statement of financial position, evaluated
// independently for the current period and for every declared comparative
// period (however many there are).
//
// No array order ever selects accounting authority here. Which statement
// of financial position to reconcile against, and which line within a
// statement carries a given canonical concept, are both resolved with
// explicit cardinality (`resolveUniqueStatementOfType` /
// `resolveLineByConcept`) rather than "take the first one": zero matches is
// handled explicitly (NOT_APPLICABLE where that is honest, otherwise
// INSUFFICIENT_EVIDENCE), and more than one match is always
// INSUFFICIENT_EVIDENCE naming every conflicting id — never a silent pick.

import { equalsWithinTolerance, formatMoney } from "../money";
import { CANONICAL_CONCEPTS } from "../concepts";
import { allPeriodIds, factIdForPeriod, resolveFact, resolveLineByConcept, resolveUniqueStatementOfType, statementsOfType } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";
import type { Statement, StatementLine } from "../types";

export const RULE_ID = "cashflow-closing-cash-reconciliation";
export const RULE_VERSION = "1.0.0";

function ambiguousSfpResult(cashFlowStatementId: string, statements: readonly Statement[]): RuleEvaluationResult {
  // Sorted, never in the input array's own order — the report must be
  // identical no matter how the report's statements happened to be declared.
  const statementIds = statements.map((s) => s.statementId).sort();
  return {
    outcome: "INSUFFICIENT_EVIDENCE",
    failureSeverity: "HIGH",
    observedValues: { conflictingStatementIds: { kind: "TEXT", value: statementIds.join(", ") } },
    expectedRelationship: "exactly one statement of financial position to reconcile cash-flow closing cash against",
    deterministicCalculation: `${statements.length} statements of financial position are present in this report: ${statementIds.join(", ")} — cannot determine which one to reconcile against`,
    evidenceReferences: statementIds.map((id) => ({ evidenceReferenceId: `${cashFlowStatementId}:sfp:${id}`, statementId: id })),
    affected: { statementId: cashFlowStatementId },
    remediationGuidance: "Resolve the ambiguity — more than one statement of financial position is present in this report. A reviewer must merge, remove, or otherwise disambiguate before this rule can run.",
    discriminator: `${cashFlowStatementId}:sfp-ambiguous`,
  };
}

function ambiguousConceptResult(anchorStatementId: string, concept: string, lines: readonly StatementLine[], affectedStatementId: string): RuleEvaluationResult {
  // Sorted, never in the input array's own order — see ambiguousSfpResult.
  const lineIds = lines.map((l) => l.lineId).sort();
  return {
    outcome: "INSUFFICIENT_EVIDENCE",
    failureSeverity: "HIGH",
    observedValues: { conflictingLineIds: { kind: "TEXT", value: lineIds.join(", ") } },
    expectedRelationship: `exactly one line with concept "${concept}" per statement`,
    deterministicCalculation: `${lines.length} lines in statement "${anchorStatementId}" share concept "${concept}": ${lineIds.join(", ")}`,
    evidenceReferences: lineIds.map((lineId) => ({ evidenceReferenceId: `${anchorStatementId}:${concept}:${lineId}`, lineId, statementId: anchorStatementId })),
    affected: { statementId: affectedStatementId },
    remediationGuidance: `Resolve the ambiguity — more than one line in statement "${anchorStatementId}" declares concept "${concept}". A reviewer must merge, re-key, or remove the duplicate before this rule can run.`,
    discriminator: `${affectedStatementId}:${concept}:ambiguous`,
  };
}

function evaluatePeriod(
  ctx: RuleContext,
  cashFlowStatement: Statement,
  sfpStatement: Statement | undefined,
  closingLine: StatementLine | undefined,
  sfpLine: StatementLine | undefined,
  periodId: string,
  isComparative: boolean,
): RuleEvaluationResult | null {
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

    const sfpResolution = resolveUniqueStatementOfType(ctx.report, "STATEMENT_OF_FINANCIAL_POSITION");
    const results: RuleEvaluationResult[] = [];

    for (const cashFlowStatement of cashFlowStatements) {
      if (sfpResolution.status === "AMBIGUOUS") {
        results.push(ambiguousSfpResult(cashFlowStatement.statementId, sfpResolution.statements));
        continue;
      }

      const closingResolution = resolveLineByConcept(cashFlowStatement, CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF);
      if (closingResolution.status === "AMBIGUOUS") {
        results.push(ambiguousConceptResult(cashFlowStatement.statementId, CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF, closingResolution.lines, cashFlowStatement.statementId));
        continue;
      }
      const closingLine = closingResolution.status === "UNIQUE" ? closingResolution.line : undefined;

      const sfpStatement = sfpResolution.status === "UNIQUE" ? sfpResolution.statement : undefined;
      let sfpLine: StatementLine | undefined;
      if (sfpStatement) {
        const sfpLineResolution = resolveLineByConcept(sfpStatement, CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP);
        if (sfpLineResolution.status === "AMBIGUOUS") {
          results.push(ambiguousConceptResult(sfpStatement.statementId, CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP, sfpLineResolution.lines, cashFlowStatement.statementId));
          continue;
        }
        sfpLine = sfpLineResolution.status === "UNIQUE" ? sfpLineResolution.line : undefined;
      }

      for (const periodId of allPeriodIds(ctx.report)) {
        const result = evaluatePeriod(ctx, cashFlowStatement, sfpStatement, closingLine, sfpLine, periodId, periodId !== ctx.report.period.periodId);
        if (result) results.push(result);
      }
    }
    return results;
  },
};
