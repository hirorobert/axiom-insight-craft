// Rule 8 — duplicate line/fact detection.
//
// (a) Two lines within the same statement sharing the same `concept` AND
//     `role` are a structural duplicate — even if their printed labels
//     differ. Two lines merely sharing a printed LABEL with different
//     concepts (e.g. two rows both labeled "Total") are never flagged: only
//     `concept` identity matters here, by design (see types.ts's comment on
//     StatementLine.concept).
// (b) Two different facts (different factId) whose value, reportingPeriod
//     and exact source locator all coincide indicate the same source cell
//     was extracted twice under two different fact identities.

import { canonicalStringify } from "../serialization";
import { allLines } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";

export const RULE_ID = "duplicate-detection";
export const RULE_VERSION = "1.0.0";

function detectDuplicateConceptLines(ctx: RuleContext): RuleEvaluationResult[] {
  const results: RuleEvaluationResult[] = [];
  for (const statement of ctx.report.statements) {
    const groups = new Map<string, string[]>();
    for (const line of allLines(statement)) {
      const key = `${line.concept}::${line.role}`;
      groups.set(key, [...(groups.get(key) ?? []), line.lineId]);
    }
    for (const [key, lineIds] of groups) {
      if (lineIds.length <= 1) continue;
      results.push({
        outcome: "FAIL",
        failureSeverity: "HIGH",
        observedValues: { duplicateLineIds: { kind: "TEXT", value: lineIds.join(", ") } },
        expectedRelationship: "each (concept, role) pair appears at most once per statement",
        deterministicCalculation: `${lineIds.length} lines share concept/role "${key}" in statement "${statement.statementId}"`,
        evidenceReferences: lineIds.map((lineId) => ({ evidenceReferenceId: `${statement.statementId}:${key}:${lineId}`, lineId, statementId: statement.statementId })),
        affected: { statementId: statement.statementId },
        remediationGuidance: "Merge or re-key the duplicate lines so each canonical concept appears at most once per statement.",
        discriminator: `concept:${statement.statementId}:${key}`,
      });
    }
  }
  return results;
}

function detectDuplicateFactFingerprints(ctx: RuleContext): RuleEvaluationResult[] {
  const results: RuleEvaluationResult[] = [];
  const groups = new Map<string, string[]>();
  for (const fact of ctx.latestFacts.values()) {
    if (fact.value === null) continue;
    const fingerprint = canonicalStringify({
      value: fact.value,
      reportingPeriod: fact.reportingPeriod,
      source: fact.provenance.source,
      locator: fact.provenance.locator,
    });
    groups.set(fingerprint, [...(groups.get(fingerprint) ?? []), fact.factId]);
  }
  for (const [fingerprint, factIds] of groups) {
    const distinctFactIds = [...new Set(factIds)];
    if (distinctFactIds.length <= 1) continue;
    results.push({
      outcome: "FAIL",
      failureSeverity: "MEDIUM",
      observedValues: { duplicateFactIds: { kind: "TEXT", value: distinctFactIds.join(", ") } },
      expectedRelationship: "no two distinct facts share the same value, period and source locator",
      deterministicCalculation: `${distinctFactIds.length} distinct factIds resolve to the identical extraction fingerprint`,
      evidenceReferences: distinctFactIds.map((factId) => ({ evidenceReferenceId: `fact-fingerprint:${factId}`, factId })),
      affected: {},
      remediationGuidance: "The same source cell/element appears to have been extracted twice under two different fact identities — deduplicate.",
      discriminator: `fact:${hashKey(fingerprint)}`,
    });
  }
  return results;
}

function hashKey(fingerprint: string): string {
  // A short, stable discriminator suffix — the fingerprint itself is already unique per group.
  return fingerprint.length > 40 ? `${fingerprint.slice(0, 40)}...` : fingerprint;
}

export const duplicateDetectionRule: RuleDefinition = {
  ruleId: RULE_ID,
  ruleVersion: RULE_VERSION,
  title: "Duplicate line/fact detection",
  evaluate(ctx: RuleContext): readonly RuleEvaluationResult[] {
    const results = [...detectDuplicateConceptLines(ctx), ...detectDuplicateFactFingerprints(ctx)];
    if (results.length === 0) {
      return [
        {
          outcome: "PASS",
          failureSeverity: "INFORMATIONAL",
          observedValues: {},
          expectedRelationship: "no duplicate (concept, role) lines and no duplicate fact fingerprints",
          deterministicCalculation: "no duplicates found",
          evidenceReferences: [],
          affected: {},
          remediationGuidance: "No action required.",
          discriminator: "no-duplicates",
        },
      ];
    }
    return results;
  },
};
