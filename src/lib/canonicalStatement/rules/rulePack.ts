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
import { cashLedgerRollforwardRule } from "./cashLedgerRollforward";
import { comprehensiveIncomeActivityRule } from "./comprehensiveIncomeActivity";

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
 * Rule pack v2 = every v1 rule (unchanged) plus the two equity tie rules, the schedule casting rule, and Rule 6 v2 (cash perimeter, which is Rule 6 v1 when no perimeter exists) and the account-by-account cash ledger rollforward. A
 * separate pack identity, so v1 evaluations remain reproducible byte-for-byte.
 */
export const CANONICAL_RULE_PACK_V2: RulePackIdentity = {
  rulePackId: "canonical-statement-rules",
  rulePackVersion: "2.2.0",
};

export const CANONICAL_RULE_PACK_V2_RULES: readonly RuleDefinition[] = [...CANONICAL_RULE_PACK_V1_RULES.map((r) => (r === cashFlowClosingReconciliationRule ? cashPerimeterReconciliationRule : r)), equityClosingTieRule, equityProfitTieRule, scheduleCastingRule, cashLedgerRollforwardRule];

export const ENGINE_VERSION_V2 = "2.2.0";

export function runCanonicalRulePackV2(ctx: RuleContext, clock?: Clock) {
  return runRulePack(CANONICAL_RULE_PACK_V2, CANONICAL_RULE_PACK_V2_RULES, ctx, ENGINE_VERSION_V2, clock);
}

/**
 * Rule pack 2.4.0 = every 2.2.0 rule (unchanged, same versions) plus `comprehensive-income-activity` 1.0.0 (S2-A02: a
 * post-closing trial balance — a nil statement of comprehensive income beside a statement of financial position with balances —
 * is a HIGH finding). The pack in force for new evaluations; 2.2.0 and 1.0.0 stay defined, byte for byte, so every recorded
 * evaluation remains reproducible. (2.3.0 is reserved by another change; this pack does not include it.)
 */
export const CANONICAL_RULE_PACK_V2_4: RulePackIdentity = {
  rulePackId: "canonical-statement-rules",
  rulePackVersion: "2.4.0",
};

export const CANONICAL_RULE_PACK_V2_4_RULES: readonly RuleDefinition[] = [...CANONICAL_RULE_PACK_V2_RULES, comprehensiveIncomeActivityRule];

export const ENGINE_VERSION_V2_4 = "2.4.0";

export function runCanonicalRulePackV2_4(ctx: RuleContext, clock?: Clock) {
  return runRulePack(CANONICAL_RULE_PACK_V2_4, CANONICAL_RULE_PACK_V2_4_RULES, ctx, ENGINE_VERSION_V2_4, clock);
}

export function runCanonicalRulePackV1(ctx: RuleContext, clock?: Clock) {
  return runRulePack(CANONICAL_RULE_PACK_V1, CANONICAL_RULE_PACK_V1_RULES, ctx, ENGINE_VERSION, clock);
}

export {
  comprehensiveIncomeActivityRule,
  cashPerimeterReconciliationRule,
  cashLedgerRollforwardRule,
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
