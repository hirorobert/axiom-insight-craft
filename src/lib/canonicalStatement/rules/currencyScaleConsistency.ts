// Rule 5 — currency and scale consistency: every non-null monetary fact
// must share the report's declared presentation currency and scale. A
// missing (null) fact is outside this rule's scope entirely — there is no
// currency/scale to check on a value that was never extracted.

import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";

export const RULE_ID = "currency-scale-consistency";
export const RULE_VERSION = "1.0.0";

export const currencyScaleConsistencyRule: RuleDefinition = {
  ruleId: RULE_ID,
  ruleVersion: RULE_VERSION,
  title: "Currency and scale consistency",
  evaluate(ctx: RuleContext): readonly RuleEvaluationResult[] {
    const results: RuleEvaluationResult[] = [];
    const { currency: expectedCurrency, scale: expectedScale } = ctx.report.presentationCurrency;

    for (const fact of ctx.latestFacts.values()) {
      if (fact.value === null) continue;
      const discriminator = `${fact.factId}:${fact.version}`;
      const matches = fact.value.currency === expectedCurrency && fact.value.scale === expectedScale;
      results.push({
        outcome: matches ? "PASS" : "FAIL",
        failureSeverity: "CRITICAL",
        observedValues: {
          factCurrency: { kind: "TEXT", value: fact.value.currency },
          factScale: { kind: "COUNT", value: fact.value.scale },
          expectedCurrency: { kind: "TEXT", value: expectedCurrency },
          expectedScale: { kind: "COUNT", value: expectedScale },
        },
        expectedRelationship: `fact.currency = "${expectedCurrency}" and fact.scale = ${expectedScale}`,
        deterministicCalculation: matches
          ? `${fact.value.currency}@${fact.value.scale} matches the presentation currency`
          : `${fact.value.currency}@${fact.value.scale} does not match the declared presentation currency ${expectedCurrency}@${expectedScale}`,
        evidenceReferences: [{ evidenceReferenceId: discriminator, factId: fact.factId, factVersion: fact.version }],
        affected: {},
        remediationGuidance: matches ? "No action required." : `Fact "${fact.factId}" (v${fact.version}) must be re-denominated into the report's presentation currency/scale, or the presentation currency itself corrected.`,
        discriminator,
      });
    }

    if (results.length === 0) {
      return [
        {
          outcome: "NOT_APPLICABLE",
          failureSeverity: "INFORMATIONAL",
          observedValues: {},
          expectedRelationship: `fact.currency = "${expectedCurrency}" and fact.scale = ${expectedScale}`,
          deterministicCalculation: "no non-null facts exist to check",
          evidenceReferences: [],
          affected: {},
          remediationGuidance: "No action required.",
          discriminator: "no-facts",
        },
      ];
    }
    return results;
  },
};
