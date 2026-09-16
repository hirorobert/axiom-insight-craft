// Rule 9 — missing comparative detection: when a report declares at least
// one ComparativePeriod (comparatives are expected), every SUBTOTAL/TOTAL
// line should carry a comparative fact with a present value. When the
// report declares NO comparative period at all (e.g. a first-year entity),
// this rule is entirely NOT_APPLICABLE — absence of a comparative is never
// assumed to be a defect when none was ever expected.

import { allLines, resolveFact } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";

export const RULE_ID = "missing-comparative-detection";
export const RULE_VERSION = "1.0.0";

export const missingComparativeDetectionRule: RuleDefinition = {
  ruleId: RULE_ID,
  ruleVersion: RULE_VERSION,
  title: "Missing comparative detection",
  evaluate(ctx: RuleContext): readonly RuleEvaluationResult[] {
    if (ctx.report.comparativePeriods.length === 0) {
      return [
        {
          outcome: "NOT_APPLICABLE",
          severity: "INFORMATIONAL",
          observedValues: {},
          expectedRelationship: "every material (SUBTOTAL/TOTAL) line has a present comparative value",
          deterministicCalculation: "this report declares no comparative period — none is expected",
          evidenceReferences: [],
          affected: {},
          remediationGuidance: "No action required.",
          discriminator: "no-comparative-period-declared",
        },
      ];
    }

    const results: RuleEvaluationResult[] = [];
    for (const statement of ctx.report.statements) {
      for (const line of allLines(statement)) {
        if (line.role === "DETAIL") continue;
        const discriminator = `${statement.statementId}:${line.lineId}`;
        const affected = { statementId: statement.statementId, lineId: line.lineId };
        const resolved = resolveFact(ctx, line.comparativeFactId);

        if (resolved.status === "PRESENT") {
          results.push({
            outcome: "PASS",
            severity: "MEDIUM",
            observedValues: {},
            expectedRelationship: "this line has a present comparative value",
            deterministicCalculation: "comparative fact is present",
            evidenceReferences: [{ evidenceReferenceId: discriminator, factId: line.comparativeFactId ?? undefined, lineId: line.lineId }],
            affected,
            remediationGuidance: "No action required.",
            discriminator,
          });
          continue;
        }

        results.push({
          outcome: "FAIL",
          severity: "MEDIUM",
          observedValues: {},
          expectedRelationship: "this line has a present comparative value",
          deterministicCalculation:
            resolved.status === "NOT_FOUND" ? "no comparative fact is linked to this line at all" : "the linked comparative fact's value is missing",
          evidenceReferences: [],
          affected,
          remediationGuidance: `Provide the comparative-period figure for "${line.lineId}", or record why none exists (e.g. the line is new this period).`,
          discriminator,
        });
      }
    }
    return results;
  },
};
