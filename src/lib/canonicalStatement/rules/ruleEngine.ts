// canonicalStatement/rules/ruleEngine.ts — the deterministic validation
// kernel. A RuleDefinition never returns an outcome the engine invents on
// its behalf: PASS/FAIL/NOT_APPLICABLE/INSUFFICIENT_EVIDENCE all come from
// rule code, never from an LLM and never guessed by the engine. Every
// ValidationFinding's `findingId` is a deterministic hash over the rule
// pack, rule, report identity and the rule's own discriminator — explicitly
// EXCLUDING `createdAt`, so identical reruns produce identical IDs.

import type {
  CanonicalFinancialStatementReport,
  EvidenceReference,
  FindingSeverity,
  MonetaryFact,
  ObservedValue,
  RuleOutcome,
  RulePackIdentity,
  ValidationFinding,
} from "../types";
import type { Tolerance } from "../money";
import { indexLatestFacts } from "../provenance";
import { canonicalStringify, hashDeterministic } from "../serialization";

export interface RuleContext {
  readonly report: CanonicalFinancialStatementReport;
  readonly tolerance: Tolerance;
  readonly latestFacts: ReadonlyMap<string, MonetaryFact>;
}

export function buildRuleContext(report: CanonicalFinancialStatementReport, tolerance: Tolerance): RuleContext {
  return { report, tolerance, latestFacts: indexLatestFacts(report.facts) };
}

export interface RuleEvaluationResult {
  readonly outcome: RuleOutcome;
  readonly severity: FindingSeverity;
  readonly observedValues: Readonly<Record<string, ObservedValue>>;
  readonly expectedRelationship: string;
  readonly deterministicCalculation: string;
  readonly evidenceReferences: readonly EvidenceReference[];
  readonly affected: { readonly statementId?: string; readonly noteId?: string; readonly lineId?: string };
  readonly remediationGuidance: string;
  /** Distinguishes multiple results from one rule run (e.g. per-line) inside the findingId hash. */
  readonly discriminator: string;
}

export interface RuleDefinition {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly title: string;
  evaluate(ctx: RuleContext): readonly RuleEvaluationResult[];
}

export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();

function buildFindingId(
  rulePack: RulePackIdentity,
  rule: RuleDefinition,
  reportId: string,
  reportVersion: number,
  result: RuleEvaluationResult,
): string {
  const material = canonicalStringify({
    rulePackId: rulePack.rulePackId,
    rulePackVersion: rulePack.rulePackVersion,
    ruleId: rule.ruleId,
    ruleVersion: rule.ruleVersion,
    reportId,
    reportVersion,
    discriminator: result.discriminator,
    outcome: result.outcome,
  });
  return hashDeterministic(material);
}

export function runRule(
  rule: RuleDefinition,
  ctx: RuleContext,
  rulePack: RulePackIdentity,
  engineVersion: string,
  clock: Clock = systemClock,
): readonly ValidationFinding[] {
  const results = rule.evaluate(ctx);
  const createdAt = clock();
  return results.map((result) => ({
    findingId: buildFindingId(rulePack, rule, ctx.report.reportIdentity.reportId, ctx.report.reportIdentity.reportVersion, result),
    ruleId: rule.ruleId,
    ruleVersion: rule.ruleVersion,
    rulePack,
    engineVersion,
    outcome: result.outcome,
    severity: result.severity,
    status: "OPEN",
    observedValues: result.observedValues,
    expectedRelationship: result.expectedRelationship,
    deterministicCalculation: result.deterministicCalculation,
    evidenceReferences: result.evidenceReferences,
    affected: result.affected,
    remediationGuidance: result.remediationGuidance,
    createdAt,
  }));
}

export function runRulePack(
  rulePack: RulePackIdentity,
  rules: readonly RuleDefinition[],
  ctx: RuleContext,
  engineVersion: string,
  clock: Clock = systemClock,
): readonly ValidationFinding[] {
  return rules.flatMap((rule) => runRule(rule, ctx, rulePack, engineVersion, clock));
}
