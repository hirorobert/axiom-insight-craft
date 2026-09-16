// canonicalStatement/rules/rulePack.ts — the first deterministic rule pack.
// Exactly the ten structural/arithmetic rules the mission specifies. No
// jurisdiction, no AI conclusion, no rule outside this list.

import type { RulePackIdentity } from "../types";
import type { Clock, RuleContext, RuleDefinition } from "./ruleEngine";
import { runRulePack } from "./ruleEngine";
import { financialPositionEquationRule } from "./financialPositionEquation";
import { subtotalCastingRule } from "./subtotalCasting";
import { noteToFaceReconciliationRule } from "./noteToFaceReconciliation";
import { comparativePeriodAlignmentRule } from "./comparativePeriodAlignment";
import { currencyScaleConsistencyRule } from "./currencyScaleConsistency";
import { cashFlowClosingReconciliationRule } from "./cashFlowClosingReconciliation";
import { movementReconciliationRule } from "./movementReconciliation";
import { duplicateDetectionRule } from "./duplicateDetection";
import { missingComparativeDetectionRule } from "./missingComparativeDetection";
import { orphanedNoteReferenceDetectionRule } from "./orphanedNoteReferenceDetection";

export const ENGINE_VERSION = "1.0.0";

export const CANONICAL_RULE_PACK_V1: RulePackIdentity = {
  rulePackId: "canonical-statement-rules",
  rulePackVersion: "1.0.0",
};

export const CANONICAL_RULE_PACK_V1_RULES: readonly RuleDefinition[] = [
  financialPositionEquationRule,
  subtotalCastingRule,
  noteToFaceReconciliationRule,
  comparativePeriodAlignmentRule,
  currencyScaleConsistencyRule,
  cashFlowClosingReconciliationRule,
  movementReconciliationRule,
  duplicateDetectionRule,
  missingComparativeDetectionRule,
  orphanedNoteReferenceDetectionRule,
];

export function runCanonicalRulePackV1(ctx: RuleContext, clock?: Clock) {
  return runRulePack(CANONICAL_RULE_PACK_V1, CANONICAL_RULE_PACK_V1_RULES, ctx, ENGINE_VERSION, clock);
}

export {
  financialPositionEquationRule,
  subtotalCastingRule,
  noteToFaceReconciliationRule,
  comparativePeriodAlignmentRule,
  currencyScaleConsistencyRule,
  cashFlowClosingReconciliationRule,
  movementReconciliationRule,
  duplicateDetectionRule,
  missingComparativeDetectionRule,
  orphanedNoteReferenceDetectionRule,
};
