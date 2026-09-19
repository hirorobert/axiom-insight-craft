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
import { equityClosingTieRule, equityProfitTieRule } from "./equityTies";
import { scheduleCastingRule } from "./scheduleCasting";
import { cashPerimeterReconciliationRule } from "./cashPerimeterReconciliation";

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

/**
 * Rule pack v2 = every v1 rule (unchanged) plus the two equity tie rules, the schedule casting rule, and Rule 6 v2 (cash perimeter, which is Rule 6 v1 when no perimeter exists). A
 * separate pack identity, so v1 evaluations remain reproducible byte-for-byte.
 */
export const CANONICAL_RULE_PACK_V2: RulePackIdentity = {
  rulePackId: "canonical-statement-rules",
  rulePackVersion: "2.1.0",
};

export const CANONICAL_RULE_PACK_V2_RULES: readonly RuleDefinition[] = [...CANONICAL_RULE_PACK_V1_RULES.map((r) => (r === cashFlowClosingReconciliationRule ? cashPerimeterReconciliationRule : r)), equityClosingTieRule, equityProfitTieRule, scheduleCastingRule];

export const ENGINE_VERSION_V2 = "2.1.0";

export function runCanonicalRulePackV2(ctx: RuleContext, clock?: Clock) {
  return runRulePack(CANONICAL_RULE_PACK_V2, CANONICAL_RULE_PACK_V2_RULES, ctx, ENGINE_VERSION_V2, clock);
}

export function runCanonicalRulePackV1(ctx: RuleContext, clock?: Clock) {
  return runRulePack(CANONICAL_RULE_PACK_V1, CANONICAL_RULE_PACK_V1_RULES, ctx, ENGINE_VERSION, clock);
}

export {
  cashPerimeterReconciliationRule,
  equityClosingTieRule,
  equityProfitTieRule,
  scheduleCastingRule,
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
