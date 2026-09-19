// Rules 11 and 12 (rule pack v2) — the statement of changes in equity must
// agree with the statements it is built beside:
//
//   11. equity-closing-tie   SOCIE closing total equity  = SFP total equity
//   12. equity-profit-tie    SOCIE profit-or-loss movement = statement of profit or loss net result
//
// Both are evaluated independently for the current period and for every
// declared comparative period. As everywhere in this rule pack: a missing
// figure is INSUFFICIENT_EVIDENCE, never zero; an ambiguous anchor is
// INSUFFICIENT_EVIDENCE naming every candidate; and a FAIL is reported with
// both figures — the rule never balances, plugs or adjusts anything.

import { CANONICAL_CONCEPTS } from "../concepts";
import { equalsWithinTolerance, formatMoney } from "../money";
import type { Statement, StatementLine, StatementType } from "../types";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";
import { allPeriodIds, factIdForPeriod, resolveFact, resolveLineByConcept, resolveUniqueStatementOfType } from "./shared";

interface TieSpec {
  readonly ruleId: string;
  readonly title: string;
  readonly leftType: StatementType;
  readonly leftConcept: string;
  readonly leftName: string;
  readonly rightType: StatementType;
  readonly rightConcept: string;
  readonly rightName: string;
  readonly failureSeverity: "CRITICAL" | "HIGH";
}

function anchor(ctx: RuleContext, type: StatementType, concept: string): { statement?: Statement; line?: StatementLine; ambiguousIds?: readonly string[] } {
  const st = resolveUniqueStatementOfType(ctx.report, type);
  if (st.status === "NONE") return {};
  if (st.status === "AMBIGUOUS") return { ambiguousIds: st.statements.map((s) => s.statementId).sort() };
  const ln = resolveLineByConcept(st.statement, concept);
  if (ln.status === "AMBIGUOUS") return { statement: st.statement, ambiguousIds: ln.lines.map((l) => l.lineId).sort() };
  return { statement: st.statement, line: ln.status === "UNIQUE" ? ln.line : undefined };
}

function makeTieRule(spec: TieSpec): RuleDefinition {
  const relationship = `${spec.leftName} = ${spec.rightName}`;
  return {
    ruleId: spec.ruleId,
    ruleVersion: "1.0.0",
    title: spec.title,
    evaluate(ctx: RuleContext): readonly RuleEvaluationResult[] {
      const left = anchor(ctx, spec.leftType, spec.leftConcept);
      if (!left.statement && !left.ambiguousIds) {
        return [
          {
            outcome: "NOT_APPLICABLE",
            failureSeverity: "INFORMATIONAL",
            observedValues: {},
            expectedRelationship: relationship,
            deterministicCalculation: "no statement of changes in equity is present in this report",
            evidenceReferences: [],
            affected: {},
            remediationGuidance: "No action required.",
            discriminator: "no-left-statement",
          },
        ];
      }
      const right = anchor(ctx, spec.rightType, spec.rightConcept);
      const ambiguous = left.ambiguousIds ?? right.ambiguousIds;
      if (ambiguous) {
        return [
          {
            outcome: "INSUFFICIENT_EVIDENCE",
            failureSeverity: spec.failureSeverity,
            observedValues: { conflictingIds: { kind: "TEXT", value: ambiguous.join(", ") } },
            expectedRelationship: relationship,
            deterministicCalculation: `more than one candidate statement or line was found: ${ambiguous.join(", ")}`,
            evidenceReferences: ambiguous.map((id) => ({ evidenceReferenceId: `${spec.ruleId}:amb:${id}`, lineId: id })),
            affected: { statementId: left.statement?.statementId },
            remediationGuidance: "Resolve the duplicate statement or line so exactly one anchor exists.",
            discriminator: "ambiguous",
          },
        ];
      }
      const affected = { statementId: left.statement?.statementId };
      const results: RuleEvaluationResult[] = [];
      for (const periodId of allPeriodIds(ctx.report)) {
        const isComparative = periodId !== ctx.report.period.periodId;
        const leftFactId = left.line ? factIdForPeriod(left.line, periodId) : undefined;
        if (!leftFactId && isComparative) continue; // a comparative gap is Rule 9's business
        const rightFactId = right.line ? factIdForPeriod(right.line, periodId) : undefined;
        const l = resolveFact(ctx, leftFactId);
        const r = resolveFact(ctx, rightFactId);
        const discriminator = `${spec.ruleId}:${periodId}`;
        if (l.status !== "PRESENT" || r.status !== "PRESENT") {
          results.push({
            outcome: "INSUFFICIENT_EVIDENCE",
            failureSeverity: spec.failureSeverity,
            observedValues: { left: { kind: "MONEY", value: l.status === "PRESENT" ? l.money : null }, right: { kind: "MONEY", value: r.status === "PRESENT" ? r.money : null } },
            expectedRelationship: relationship,
            deterministicCalculation: `${l.status !== "PRESENT" ? spec.leftName : spec.rightName} is missing for this period`,
            evidenceReferences: [],
            affected,
            remediationGuidance: `Provide ${l.status !== "PRESENT" ? spec.leftName : spec.rightName} for this period; nothing is assumed in its place.`,
            discriminator,
            periodId,
          });
          continue;
        }
        const same = l.money.currency === r.money.currency && l.money.scale === r.money.scale;
        const pass = same && equalsWithinTolerance(l.money, r.money, ctx.tolerance);
        results.push({
          outcome: same ? (pass ? "PASS" : "FAIL") : "INSUFFICIENT_EVIDENCE",
          failureSeverity: spec.failureSeverity,
          observedValues: { left: { kind: "MONEY", value: l.money, factId: l.fact.factId }, right: { kind: "MONEY", value: r.money, factId: r.fact.factId } },
          expectedRelationship: relationship,
          deterministicCalculation: same ? `${formatMoney(l.money)} vs ${formatMoney(r.money)}` : "denominated differently — cannot compare",
          evidenceReferences: [
            { evidenceReferenceId: `${discriminator}:left`, factId: l.fact.factId, lineId: left.line?.lineId },
            { evidenceReferenceId: `${discriminator}:right`, factId: r.fact.factId, lineId: right.line?.lineId },
          ],
          affected,
          remediationGuidance: pass ? "No action required." : `Reconcile ${spec.leftName} to ${spec.rightName}. The difference is reported, never adjusted.`,
          discriminator,
          periodId,
        });
      }
      return results;
    },
  };
}

export const equityClosingTieRule = makeTieRule({
  ruleId: "equity-closing-tie",
  title: "Statement of changes in equity closing balance ties to the statement of financial position",
  leftType: "STATEMENT_OF_CHANGES_IN_EQUITY",
  leftConcept: CANONICAL_CONCEPTS.SOCIE_CLOSING_TOTAL,
  leftName: "closing total equity per the statement of changes in equity",
  rightType: "STATEMENT_OF_FINANCIAL_POSITION",
  rightConcept: CANONICAL_CONCEPTS.TOTAL_EQUITY,
  rightName: "total equity per the statement of financial position",
  failureSeverity: "CRITICAL",
});

export const equityProfitTieRule = makeTieRule({
  ruleId: "equity-profit-tie",
  title: "Result recorded in equity ties to the statement of profit or loss",
  leftType: "STATEMENT_OF_CHANGES_IN_EQUITY",
  leftConcept: CANONICAL_CONCEPTS.SOCIE_PROFIT_OR_LOSS_TOTAL,
  leftName: "profit or loss recognised in equity",
  rightType: "STATEMENT_OF_PROFIT_OR_LOSS",
  rightConcept: CANONICAL_CONCEPTS.NET_RESULT,
  rightName: "net result per the statement of profit or loss",
  failureSeverity: "HIGH",
});
