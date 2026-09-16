import { describe, expect, it } from "vitest";
import { buildRuleContext, runRule, runRulePack, type RuleContext, type RuleDefinition } from "./ruleEngine";
import { withoutCreatedAt } from "../serialization";
import { ZERO_TOLERANCE } from "../money";
import { IFRS_FULL_FIXTURE } from "../fixtures/ifrsFullFixture";

const RULE_PACK = { rulePackId: "test-pack", rulePackVersion: "1.0.0" };

const alwaysPassRule: RuleDefinition = {
  ruleId: "always-pass",
  ruleVersion: "1.0.0",
  title: "Always passes",
  evaluate: (_ctx: RuleContext) => [
    {
      outcome: "PASS",
      failureSeverity: "LOW",
      observedValues: {},
      expectedRelationship: "trivially true",
      deterministicCalculation: "1 = 1",
      evidenceReferences: [],
      affected: {},
      remediationGuidance: "None.",
      discriminator: "trivial",
    },
  ],
};

const alwaysFailRule: RuleDefinition = {
  ruleId: "always-fail",
  ruleVersion: "1.0.0",
  title: "Always fails",
  evaluate: (_ctx: RuleContext) => [
    {
      outcome: "FAIL",
      failureSeverity: "CRITICAL",
      observedValues: {},
      expectedRelationship: "trivially false",
      deterministicCalculation: "1 = 2",
      evidenceReferences: [],
      affected: {},
      remediationGuidance: "Fix it.",
      discriminator: "trivial",
    },
  ],
};

describe("buildRuleContext", () => {
  it("indexes facts and carries the report and tolerance through", () => {
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    expect(ctx.report).toBe(IFRS_FULL_FIXTURE);
    expect(ctx.tolerance).toEqual(ZERO_TOLERANCE);
    expect(ctx.latestFacts.size).toBeGreaterThan(0);
  });
});

describe("runRule", () => {
  it("assembles a full RuleEvaluationRecord from a rule's minimal evaluation result", () => {
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const records = runRule(alwaysPassRule, ctx, RULE_PACK, "1.0.0", () => "2026-01-01T00:00:00.000Z");
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.ruleId).toBe("always-pass");
    expect(record.ruleVersion).toBe("1.0.0");
    expect(record.rulePack).toEqual(RULE_PACK);
    expect(record.engineVersion).toBe("1.0.0");
    expect(record.outcome).toBe("PASS");
    expect(record.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(record.findingKey).toMatch(/^[0-9a-f]{64}$/);
    expect(record.evaluationId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a PASS record is never actionable and is forced to status NOT_ACTIONABLE, regardless of failureSeverity", () => {
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const [record] = runRule(alwaysPassRule, ctx, RULE_PACK, "1.0.0");
    expect(record.actionable).toBe(false);
    expect(record.status).toBe("NOT_ACTIONABLE");
    expect(record.failureSeverity).toBe("LOW"); // the field still carries a value — it just must never be read as "open"
  });

  it("a FAIL record is actionable and starts OPEN", () => {
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const [record] = runRule(alwaysFailRule, ctx, RULE_PACK, "1.0.0");
    expect(record.actionable).toBe(true);
    expect(record.status).toBe("OPEN");
  });

  it("gives two different results from the same rule run distinct findingKeys and evaluationIds", () => {
    const baseResult = {
      outcome: "PASS" as const,
      failureSeverity: "LOW" as const,
      observedValues: {},
      expectedRelationship: "trivially true",
      deterministicCalculation: "1 = 1",
      evidenceReferences: [],
      affected: {},
      remediationGuidance: "None.",
    };
    const twoResultRule: RuleDefinition = {
      ruleId: "two-results",
      ruleVersion: "1.0.0",
      title: "Two results",
      evaluate: () => [
        { ...baseResult, discriminator: "a" },
        { ...baseResult, discriminator: "b" },
      ],
    };
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const records = runRule(twoResultRule, ctx, RULE_PACK, "1.0.0");
    expect(records[0].findingKey).not.toBe(records[1].findingKey);
    expect(records[0].evaluationId).not.toBe(records[1].evaluationId);
  });
});

describe("runRulePack", () => {
  it("returns findings from every rule in the pack, deterministically ordered by rule-pack registration order first", () => {
    const secondRule: RuleDefinition = { ...alwaysPassRule, ruleId: "second-rule" };
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const records = runRulePack(RULE_PACK, [alwaysPassRule, secondRule], ctx, "1.0.0");
    expect(records.map((r) => r.ruleId)).toEqual(["always-pass", "second-rule"]);
  });
});

describe("stable finding identity across identical reruns", () => {
  it("the same rule pack against the same report produces identical findingKeys and evaluationIds regardless of when it runs", () => {
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const run1 = runRule(alwaysPassRule, ctx, RULE_PACK, "1.0.0", () => "2026-01-01T00:00:00.000Z");
    const run2 = runRule(alwaysPassRule, ctx, RULE_PACK, "1.0.0", () => "2099-12-31T23:59:59.999Z");
    expect(run1[0].findingKey).toBe(run2[0].findingKey);
    expect(run1[0].evaluationId).toBe(run2[0].evaluationId);
    expect(run1[0].createdAt).not.toBe(run2[0].createdAt);
  });

  it("byte-identical serialized bodies once createdAt is stripped, even when createdAt differs", () => {
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const run1 = runRule(alwaysPassRule, ctx, RULE_PACK, "1.0.0", () => "2026-01-01T00:00:00.000Z");
    const run2 = runRule(alwaysPassRule, ctx, RULE_PACK, "1.0.0", () => "2099-12-31T23:59:59.999Z");
    expect(JSON.stringify(withoutCreatedAt(run1[0]))).toBe(JSON.stringify(withoutCreatedAt(run2[0])));
  });

  it("a different report identity changes both findingKey and evaluationId", () => {
    const ctx1 = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const ctx2 = buildRuleContext({ ...IFRS_FULL_FIXTURE, reportIdentity: { ...IFRS_FULL_FIXTURE.reportIdentity, reportId: "different-report" } }, ZERO_TOLERANCE);
    const f1 = runRule(alwaysPassRule, ctx1, RULE_PACK, "1.0.0")[0];
    const f2 = runRule(alwaysPassRule, ctx2, RULE_PACK, "1.0.0")[0];
    expect(f1.findingKey).not.toBe(f2.findingKey);
    expect(f1.evaluationId).not.toBe(f2.evaluationId);
  });

  it("a changed reportVersion changes evaluationId but NOT findingKey — the check is the same, the evaluated state differs", () => {
    const ctx1 = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const ctx2 = buildRuleContext({ ...IFRS_FULL_FIXTURE, reportIdentity: { ...IFRS_FULL_FIXTURE.reportIdentity, reportVersion: 2 } }, ZERO_TOLERANCE);
    const f1 = runRule(alwaysPassRule, ctx1, RULE_PACK, "1.0.0")[0];
    const f2 = runRule(alwaysPassRule, ctx2, RULE_PACK, "1.0.0")[0];
    expect(f1.findingKey).toBe(f2.findingKey);
    expect(f1.evaluationId).not.toBe(f2.evaluationId);
  });

  it("a changed outcome changes evaluationId but NOT findingKey — same check, different result", () => {
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const passRecord = runRule(alwaysPassRule, ctx, RULE_PACK, "1.0.0")[0];
    const failRecord = runRule(alwaysFailRule, ctx, RULE_PACK, "1.0.0")[0]; // same discriminator ("trivial"), same ruleId is different though — use a same-ruleId pair instead
    // Compare within the same ruleId to isolate outcome as the only variable:
    const sameRuleFail: RuleDefinition = { ...alwaysPassRule, evaluate: () => alwaysFailRule.evaluate({} as RuleContext) };
    const failSameRule = runRule(sameRuleFail, ctx, RULE_PACK, "1.0.0")[0];
    expect(passRecord.findingKey).toBe(failSameRule.findingKey);
    expect(passRecord.evaluationId).not.toBe(failSameRule.evaluationId);
    expect(failRecord.ruleId).not.toBe(passRecord.ruleId); // sanity: confirms alwaysFailRule is indeed a different rule than alwaysPassRule
  });
});
