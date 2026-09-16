// Rule 4 — current-period/comparative-period alignment. Evaluated once per
// (statement, comparative periodId actually used by that statement) — a
// statement may legitimately use any number of comparative periods
// simultaneously (this rule no longer treats "more than one" as a defect;
// that was the very ambiguity fixed by replacing a single
// `comparativeFactId` with `factBindings`). For each such pairing this rule
// checks two things: (a) the periodId is one this report actually declared
// in `comparativePeriods`, and (b) every line bound to that periodId points
// at a fact whose own `reportingPeriod.periodId` agrees with the binding —
// a binding that silently points at the wrong period's fact is exactly the
// defect this rule exists to catch.

import { allLines, factIdForPeriod } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";
import { CURRENT_PERIOD_ID } from "../types";

export const RULE_ID = "comparative-period-alignment";
export const RULE_VERSION = "1.0.0";

export const comparativePeriodAlignmentRule: RuleDefinition = {
  ruleId: RULE_ID,
  ruleVersion: RULE_VERSION,
  title: "Current-period/comparative-period alignment",
  evaluate(ctx: RuleContext): readonly RuleEvaluationResult[] {
    const results: RuleEvaluationResult[] = [];
    const currentPeriodId = ctx.report.period.periodId;
    const declaredComparativePeriodIds = new Set(ctx.report.comparativePeriods.map((p) => p.periodId));

    for (const statement of ctx.report.statements) {
      const lines = allLines(statement);
      const usedComparativePeriodIds = new Set<string>();
      for (const line of lines) {
        for (const binding of line.factBindings) {
          if (binding.periodId !== currentPeriodId && binding.periodId !== CURRENT_PERIOD_ID) {
            usedComparativePeriodIds.add(binding.periodId);
          }
        }
      }

      if (usedComparativePeriodIds.size === 0) {
        results.push({
          outcome: "NOT_APPLICABLE",
          failureSeverity: "INFORMATIONAL",
          observedValues: {},
          expectedRelationship: "every comparative fact binding belongs to a declared, consistent comparative period",
          deterministicCalculation: "this statement declares no comparative facts",
          evidenceReferences: [],
          affected: { statementId: statement.statementId },
          remediationGuidance: "No action required.",
          discriminator: statement.statementId,
        });
        continue;
      }

      for (const periodId of usedComparativePeriodIds) {
        const discriminator = `${statement.statementId}:${periodId}`;
        const affected = { statementId: statement.statementId };
        const linesForPeriod = lines.filter((line) => factIdForPeriod(line, periodId) !== undefined);

        if (!declaredComparativePeriodIds.has(periodId)) {
          results.push({
            outcome: "FAIL",
            failureSeverity: "HIGH",
            observedValues: { periodId: { kind: "PERIOD", value: periodId } },
            expectedRelationship: "every comparative fact binding belongs to a declared, consistent comparative period",
            deterministicCalculation: `periodId "${periodId}" is used by ${linesForPeriod.length} line(s) but is not declared in comparativePeriods`,
            evidenceReferences: linesForPeriod.map((line) => ({ evidenceReferenceId: `${discriminator}:${line.lineId}`, lineId: line.lineId })),
            affected,
            remediationGuidance: `Declare "${periodId}" in report.comparativePeriods, or correct the binding to reference a declared period.`,
            discriminator,
            periodId,
          });
          continue;
        }

        const mismatched = linesForPeriod.filter((line) => {
          const factId = factIdForPeriod(line, periodId);
          const fact = factId ? ctx.latestFacts.get(factId) : undefined;
          return fact !== undefined && fact.reportingPeriod.periodId !== periodId;
        });

        if (mismatched.length > 0) {
          results.push({
            outcome: "FAIL",
            failureSeverity: "HIGH",
            observedValues: { periodId: { kind: "PERIOD", value: periodId }, mismatchedLineCount: { kind: "COUNT", value: mismatched.length } },
            expectedRelationship: "every comparative fact binding belongs to a declared, consistent comparative period",
            deterministicCalculation: `${mismatched.length} line(s) bound to periodId "${periodId}" reference a fact whose own reportingPeriod disagrees`,
            evidenceReferences: mismatched.map((line) => ({ evidenceReferenceId: `${discriminator}:${line.lineId}`, lineId: line.lineId, factId: factIdForPeriod(line, periodId) })),
            affected,
            remediationGuidance: "Correct the binding (or the fact's own reportingPeriod) so they agree.",
            discriminator,
            periodId,
          });
          continue;
        }

        results.push({
          outcome: "PASS",
          failureSeverity: "HIGH",
          observedValues: { periodId: { kind: "PERIOD", value: periodId } },
          expectedRelationship: "every comparative fact binding belongs to a declared, consistent comparative period",
          deterministicCalculation: `all ${linesForPeriod.length} line(s) bound to periodId "${periodId}" agree with their fact's own period`,
          evidenceReferences: [],
          affected,
          remediationGuidance: "No action required.",
          discriminator,
          periodId,
        });
      }
    }
    return results;
  },
};
