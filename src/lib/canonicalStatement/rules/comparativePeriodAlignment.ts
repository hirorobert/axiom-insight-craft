// Rule 4 — current-period/comparative-period alignment: every comparative
// fact referenced by a statement must point at a declared ComparativePeriod,
// and a single statement must never mix more than one distinct comparative
// period across its own lines (that would silently present two different
// prior years as if they were one comparative column).

import { allLines } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";

export const RULE_ID = "comparative-period-alignment";
export const RULE_VERSION = "1.0.0";

export const comparativePeriodAlignmentRule: RuleDefinition = {
  ruleId: RULE_ID,
  ruleVersion: RULE_VERSION,
  title: "Current-period/comparative-period alignment",
  evaluate(ctx: RuleContext): readonly RuleEvaluationResult[] {
    const results: RuleEvaluationResult[] = [];
    const declaredPeriodIds = new Set(ctx.report.comparativePeriods.map((p) => p.periodId));

    for (const statement of ctx.report.statements) {
      const linesWithComparative = allLines(statement).filter((line) => line.comparativeFactId !== null);
      const discriminator = statement.statementId;
      const affected = { statementId: statement.statementId };

      if (linesWithComparative.length === 0) {
        results.push({
          outcome: "NOT_APPLICABLE",
          severity: "INFORMATIONAL",
          observedValues: {},
          expectedRelationship: "every comparative fact belongs to exactly one declared, consistent comparative period",
          deterministicCalculation: "this statement declares no comparative facts",
          evidenceReferences: [],
          affected,
          remediationGuidance: "No action required.",
          discriminator,
        });
        continue;
      }

      const periodIdsInUse = new Set(
        linesWithComparative
          .map((line) => ctx.latestFacts.get(line.comparativeFactId as string)?.reportingPeriod.periodId)
          .filter((id): id is string => Boolean(id)),
      );

      const undeclared = [...periodIdsInUse].filter((id) => !declaredPeriodIds.has(id));
      const mixed = periodIdsInUse.size > 1;

      if (undeclared.length > 0 || mixed) {
        results.push({
          outcome: "FAIL",
          severity: "HIGH",
          observedValues: {
            periodIdsInUse: { kind: "TEXT", value: [...periodIdsInUse].join(", ") },
            undeclaredPeriodIds: { kind: "TEXT", value: undeclared.join(", ") },
          },
          expectedRelationship: "every comparative fact belongs to exactly one declared, consistent comparative period",
          deterministicCalculation:
            undeclared.length > 0
              ? `comparative fact(s) reference undeclared period id(s): ${undeclared.join(", ")}`
              : `statement mixes multiple distinct comparative periods: ${[...periodIdsInUse].join(", ")}`,
          evidenceReferences: linesWithComparative.map((line) => ({ evidenceReferenceId: `${discriminator}:${line.lineId}`, lineId: line.lineId, factId: line.comparativeFactId ?? undefined })),
          affected,
          remediationGuidance: undeclared.length > 0
            ? "Declare the missing comparative period in report.comparativePeriods, or correct the fact's reportingPeriod."
            : "Ensure every comparative fact on this statement refers to the same single comparative period.",
          discriminator,
        });
        continue;
      }

      results.push({
        outcome: "PASS",
        severity: "HIGH",
        observedValues: { periodIdsInUse: { kind: "TEXT", value: [...periodIdsInUse].join(", ") } },
        expectedRelationship: "every comparative fact belongs to exactly one declared, consistent comparative period",
        deterministicCalculation: `all comparative facts on this statement consistently reference period "${[...periodIdsInUse][0]}"`,
        evidenceReferences: [],
        affected,
        remediationGuidance: "No action required.",
        discriminator,
      });
    }
    return results;
  },
};
