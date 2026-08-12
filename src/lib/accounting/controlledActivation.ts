/**
 * controlledActivation.ts — Ω∞ public-sector / framework intelligence
 * engine, Slice 13: controlled activation of AUTO_MAPPED_RULE for
 * deterministic cases only.
 *
 * Pure, READ ONLY — no Supabase I/O, no edge function, no actual write.
 * This is a deliberate scope boundary, not an oversight:
 *
 *   This module decides WHETHER a classification is eligible to be
 *   auto-written and BUILDS the exact record that would be written
 *   (validated against Slice 12's own validator). It does NOT perform the
 *   write. Doing so requires a Supabase Edge Function (CLAUDE.md §4.2: sole
 *   write authority) — Deno runtime code this session cannot execute or
 *   integration-test, because the Supabase CLI session has no access to
 *   the live project (unrelated project linked; the real project rejects
 *   this account — see Task #106 and Slice 12's migration header). Writing
 *   untested database-write code for a live financial system and calling
 *   it "activated" would itself violate the directive's own C4/Section
 *   XVIII discipline: never present unverified capability as certain.
 *
 * "Controlled" activation, concretely: AUTO_MAPPED_RULE alone (i.e. HIGH
 * confidence from museClassifier) is NOT sufficient to auto-write. A rule
 * must ALSO appear on an explicit, caller-supplied allowlist of activated
 * rule IDs — defaulting to EMPTY. Nothing auto-writes until a rule is
 * deliberately, individually activated; this session does not populate
 * that allowlist for any of the 294 real Arusha rules (Section XXI: "Do
 * not tune rules to hit a target count" — the corollary is also true: do
 * not unilaterally flip real rules live either).
 */

import type { ClassificationOutcome } from "./museClassifier";
import {
  validateMappingMemoryRecord,
  type MappingMemoryRecord,
  type MappingMemoryValidationResult,
} from "./mappingMemory";
import type { EntityAccountingContext } from "./entityContext";

export type ActivationDecisionKind =
  | "ELIGIBLE_FOR_AUTO_WRITE"
  | "BLOCKED_NOT_AUTO_MAPPED"
  | "BLOCKED_RULE_NOT_ACTIVATED"
  | "BLOCKED_INVALID_RECORD"
  | "BLOCKED_FRAMEWORK_NOT_CONFIRMED";

export interface ActivationDecision {
  naturalAccountCode: string;
  decision: ActivationDecisionKind;
  reason: string;
  /** Present only when decision = ELIGIBLE_FOR_AUTO_WRITE — the exact record ready for an edge function to write. */
  record?: MappingMemoryRecord;
  validation?: MappingMemoryValidationResult;
}

export interface ActivationInput {
  companyId: string;
  effectivePeriodYear: number;
  entityContext: EntityAccountingContext;
  /** Rule IDs explicitly permitted to auto-write — empty by default. */
  activatedRuleIds: ReadonlySet<string>;
}

/**
 * Decide whether one classification outcome may be auto-written, and if
 * so, build the exact record. Every rejection path returns a reason —
 * nothing is silently dropped.
 */
export function assessActivationEligibility(
  outcome: ClassificationOutcome,
  input: ActivationInput,
): ActivationDecision {
  if (outcome.outcome !== "AUTO_MAPPED_RULE") {
    return {
      naturalAccountCode: outcome.naturalAccountCode,
      decision: "BLOCKED_NOT_AUTO_MAPPED",
      reason: `Classifier outcome is '${outcome.outcome}', not AUTO_MAPPED_RULE — requires human review, never auto-written.`,
    };
  }

  // Section XVIII: never let a weak framework signal drive an automatic
  // write. If the entity's reportingFramework isn't at least MEDIUM
  // confidence (a deliberate, non-default choice — see detectEntityContext.ts),
  // no classification for this entity auto-writes, regardless of how
  // confident the account-level rule itself is.
  const frameworkConfidence = input.entityContext.reportingFramework.confidence;
  if (frameworkConfidence !== "HIGH" && frameworkConfidence !== "MEDIUM") {
    return {
      naturalAccountCode: outcome.naturalAccountCode,
      decision: "BLOCKED_FRAMEWORK_NOT_CONFIRMED",
      reason:
        `Entity reportingFramework confidence is '${frameworkConfidence}' — an account-level ` +
        `rule cannot auto-write while the entity's own framework is unconfirmed.`,
    };
  }

  if (!outcome.ruleId || !input.activatedRuleIds.has(outcome.ruleId)) {
    return {
      naturalAccountCode: outcome.naturalAccountCode,
      decision: "BLOCKED_RULE_NOT_ACTIVATED",
      reason: outcome.ruleId
        ? `Rule '${outcome.ruleId}' is AUTO_MAPPED_RULE-eligible but not on the activated-rule allowlist.`
        : `Outcome has no ruleId to check against the activation allowlist.`,
    };
  }

  const record: MappingMemoryRecord = {
    companyId: input.companyId,
    sourceSystem: "MUSE",
    naturalAccountCode: outcome.naturalAccountCode,
    normalizedAccountName: outcome.accountName,
    reportingFramework: input.entityContext.reportingFramework.value,
    accountNature: outcome.accountNature!,
    presentationCode: outcome.presentationCode!,
    effectivePeriodYear: input.effectivePeriodYear,
    evidenceSource: outcome.confidenceSource,
    auditStatus: "system_rule",
    ruleId: outcome.ruleId,
    ruleVersion: outcome.ruleVersion,
  };

  const validation = validateMappingMemoryRecord(record);
  if (!validation.valid) {
    return {
      naturalAccountCode: outcome.naturalAccountCode,
      decision: "BLOCKED_INVALID_RECORD",
      reason: `Record fails validation: ${validation.errors.join("; ")}`,
      validation,
    };
  }

  return {
    naturalAccountCode: outcome.naturalAccountCode,
    decision: "ELIGIBLE_FOR_AUTO_WRITE",
    reason: `Rule '${outcome.ruleId}' is activated and the record validates.`,
    record,
    validation,
  };
}

export function assessActivationBatch(
  outcomes: ClassificationOutcome[],
  input: ActivationInput,
): ActivationDecision[] {
  return outcomes.map((o) => assessActivationEligibility(o, input));
}

export interface ActivationBatchSummary {
  total: number;
  eligible: number;
  blockedNotAutoMapped: number;
  blockedRuleNotActivated: number;
  blockedInvalidRecord: number;
  blockedFrameworkNotConfirmed: number;
}

export function summarizeActivationBatch(decisions: ActivationDecision[]): ActivationBatchSummary {
  return {
    total: decisions.length,
    eligible: decisions.filter((d) => d.decision === "ELIGIBLE_FOR_AUTO_WRITE").length,
    blockedNotAutoMapped: decisions.filter((d) => d.decision === "BLOCKED_NOT_AUTO_MAPPED").length,
    blockedRuleNotActivated: decisions.filter((d) => d.decision === "BLOCKED_RULE_NOT_ACTIVATED").length,
    blockedInvalidRecord: decisions.filter((d) => d.decision === "BLOCKED_INVALID_RECORD").length,
    blockedFrameworkNotConfirmed: decisions.filter((d) => d.decision === "BLOCKED_FRAMEWORK_NOT_CONFIRMED").length,
  };
}
