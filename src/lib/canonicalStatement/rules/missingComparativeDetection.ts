// Rule 9 — missing comparative detection: when a report declares one or
// more ComparativePeriods (comparatives are expected), every SUBTOTAL/TOTAL
// line should carry a present-value binding for EACH declared comparative
// period independently — a line missing only its second of two comparative
// periods is still a genuine, individually-reportable gap, never masked by
// the presence of its first comparative. When the report declares NO
// comparative period at all (e.g. a first-year entity), this rule is
// entirely NOT_APPLICABLE — absence of a comparative is never assumed to be
// a defect when none was ever expected.

import { allLines, factIdForPeriod, resolveFact } from "./shared";
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
          failureSeverity: "INFORMATIONAL",
          observedValues: {},
          expectedRelationship: "every material (SUBTOTAL/TOTAL) line has a present value for every declared comparative period",
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
        for (const comparative of ctx.report.comparativePeriods) {
          const discriminator = `${statement.statementId}:${line.lineId}:${comparative.periodId}`;
          const affected = { statementId: statement.statementId, lineId: line.lineId };
          const factId = factIdForPeriod(line, comparative.periodId);
          const resolved = resolveFact(ctx, factId);

          if (resolved.status === "PRESENT") {
            results.push({
              outcome: "PASS",
              failureSeverity: "MEDIUM",
              observedValues: { periodId: { kind: "PERIOD", value: comparative.periodId } },
              expectedRelationship: "this line has a present value for this comparative period",
              deterministicCalculation: `comparative fact for period "${comparative.periodId}" is present`,
              evidenceReferences: [{ evidenceReferenceId: discriminator, factId, lineId: line.lineId }],
              affected,
              remediationGuidance: "No action required.",
              discriminator,
              periodId: comparative.periodId,
            });
            continue;
          }

          results.push({
            outcome: "FAIL",
            failureSeverity: "MEDIUM",
            observedValues: { periodId: { kind: "PERIOD", value: comparative.periodId } },
            expectedRelationship: "this line has a present value for this comparative period",
            deterministicCalculation:
              resolved.status === "NOT_FOUND"
                ? `no fact is bound to this line for comparative period "${comparative.periodId}"`
                : `the fact bound for comparative period "${comparative.periodId}" has a missing (null) value`,
            evidenceReferences: [],
            affected,
            remediationGuidance: `Provide the "${comparative.periodId}" figure for "${line.lineId}", or record why none exists (e.g. the line is new this period).`,
            discriminator,
            periodId: comparative.periodId,
          });
        }
      }
    }
    return results;
  },
};
