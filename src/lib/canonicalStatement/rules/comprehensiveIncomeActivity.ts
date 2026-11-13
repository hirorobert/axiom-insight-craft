// Rule — the statement of comprehensive income carries the period's income and expenses (S2-A02).
//
// A trial balance exported AFTER closing entries (profit or loss already closed into retained earnings) composes a nil
// statement of comprehensive income beside a statement of financial position that still balances, because the year's result
// sits inside equity. Every other rule passes: the totals cast, the position balances. This rule detects that shape:
//
//   current period: no line of the statement of comprehensive income carries a non-zero amount
//                   AND at least one line of the statement of financial position does   →  FAIL, HIGH
//
// It tests presence, not the result: income and expenses that happen to net to nil are activity and PASS. Only the current
// period decides. HIGH makes the finding a sign-off blocker (fs_unresolved_blocking_count, and the server compilation's findings
// through fs_server_compilation_blocker) until a reviewer records ACCEPT_FINDING with a documented reason — the legitimate case
// is a genuinely dormant entity. Detection only: nothing is netted, moved or presented differently.
//
// NOT_APPLICABLE when there is no statement of comprehensive income (e.g. a cash-basis report) or nothing at all is presented
// in the statement of financial position (an empty position has nothing to contradict). Ambiguous statements (two of a type)
// are INSUFFICIENT_EVIDENCE: the rule never picks one.

import { formatMoney, isZeroMoney } from "../money";
import type { Statement } from "../types";
import { allLines, resolveFactForPeriod, resolveUniqueStatementOfType } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";

export const RULE_ID = "comprehensive-income-activity";
export const RULE_VERSION = "1.0.0";
const EXPECTATION = "when the statement of financial position carries balances, the statement of comprehensive income of the same period presents at least one non-zero income or expense";

/** The lines of a statement that carry a non-zero figure for the period, with their figures (in line order). */
function nonZeroLines(ctx: RuleContext, statement: Statement, periodId: string) {
  const out: { lineId: string; factId: string; text: string }[] = [];
  for (const line of allLines(statement)) {
    const f = resolveFactForPeriod(ctx, line, periodId);
    if (f.status === "PRESENT" && !isZeroMoney(f.money)) out.push({ lineId: line.lineId, factId: f.fact.factId, text: formatMoney(f.money) });
  }
  return out;
}

export const comprehensiveIncomeActivityRule: RuleDefinition = {
  ruleId: RULE_ID,
  ruleVersion: RULE_VERSION,
  title: "Statement of comprehensive income carries the period's income and expenses",
  evaluate(ctx: RuleContext): readonly RuleEvaluationResult[] {
    const periodId = ctx.report.period.periodId;
    const base = { expectedRelationship: EXPECTATION, periodId } as const;
    const sci = resolveUniqueStatementOfType(ctx.report, "STATEMENT_OF_PROFIT_OR_LOSS");
    const sfp = resolveUniqueStatementOfType(ctx.report, "STATEMENT_OF_FINANCIAL_POSITION");
    if (sci.status === "NONE" || sfp.status === "NONE") {
      return [{ ...base, outcome: "NOT_APPLICABLE", failureSeverity: "INFORMATIONAL", observedValues: {}, deterministicCalculation: "the report has no statement of comprehensive income or no statement of financial position", evidenceReferences: [], affected: {}, remediationGuidance: "No action required.", discriminator: `${periodId}:not-applicable` }];
    }
    if (sci.status === "AMBIGUOUS" || sfp.status === "AMBIGUOUS") {
      const ids = [...(sci.status === "AMBIGUOUS" ? sci.statements : []), ...(sfp.status === "AMBIGUOUS" ? sfp.statements : [])].map((s) => s.statementId).sort();
      return [{ ...base, outcome: "INSUFFICIENT_EVIDENCE", failureSeverity: "HIGH", observedValues: { statementIds: { kind: "TEXT", value: ids.join(", ") } }, deterministicCalculation: `more than one statement of a type: ${ids.join(", ")}`, evidenceReferences: [], affected: {}, remediationGuidance: "Remove the duplicate statement; the rule cannot choose between them.", discriminator: `${periodId}:ambiguous` }];
    }
    const sciStatement = sci.statement;
    const position = nonZeroLines(ctx, sfp.statement, periodId);
    const activity = nonZeroLines(ctx, sciStatement, periodId);
    const affected = { statementId: sciStatement.statementId };
    const observedValues = {
      nonZeroComprehensiveIncomeLines: { kind: "COUNT", value: activity.length },
      nonZeroFinancialPositionLines: { kind: "COUNT", value: position.length },
    } as const;
    if (position.length === 0) {
      return [{ ...base, outcome: "NOT_APPLICABLE", failureSeverity: "INFORMATIONAL", observedValues, deterministicCalculation: `no line of the statement of financial position carries a non-zero amount for ${periodId}`, evidenceReferences: [], affected, remediationGuidance: "No action required.", discriminator: periodId }];
    }
    if (activity.length > 0) {
      return [{ ...base, outcome: "PASS", failureSeverity: "HIGH", observedValues, deterministicCalculation: `${activity.length} line(s) of the statement of comprehensive income carry a non-zero amount for ${periodId} (first: ${activity[0].lineId} ${activity[0].text})`, evidenceReferences: [], affected, remediationGuidance: "No action required.", discriminator: periodId }];
    }
    return [{
      ...base,
      outcome: "FAIL",
      failureSeverity: "HIGH",
      observedValues,
      deterministicCalculation: `no line of the statement of comprehensive income carries a non-zero amount for ${periodId}, while ${position.length} line(s) of the statement of financial position do (first: ${position[0].lineId} ${position[0].text})`,
      evidenceReferences: position.slice(0, 5).map((p) => ({ evidenceReferenceId: `${sfp.statement.statementId}:${p.lineId}`, factId: p.factId, lineId: p.lineId, statementId: sfp.statement.statementId })),
      affected,
      remediationGuidance: "The trial balance looks post-closing: the year's income and expenses were already closed into retained earnings, so the statement of comprehensive income shows nothing. Import the pre-closing trial balance (before the closing entries) for this period. Only if the entity was genuinely dormant, with no income and no expense at all in the period, may a reviewer accept this finding with the reason recorded.",
      discriminator: periodId,
    }];
  },
};
