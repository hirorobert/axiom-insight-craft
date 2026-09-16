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
      severity: "LOW",
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

describe("buildRuleContext", () => {
  it("indexes facts and carries the report and tolerance through", () => {
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    expect(ctx.report).toBe(IFRS_FULL_FIXTURE);
    expect(ctx.tolerance).toEqual(ZERO_TOLERANCE);
    expect(ctx.latestFacts.size).toBeGreaterThan(0);
  });
});

describe("runRule", () => {
  it("assembles a full ValidationFinding from a rule's minimal evaluation result", () => {
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const findings = runRule(alwaysPassRule, ctx, RULE_PACK, "1.0.0", () => "2026-01-01T00:00:00.000Z");
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.ruleId).toBe("always-pass");
    expect(finding.ruleVersion).toBe("1.0.0");
    expect(finding.rulePack).toEqual(RULE_PACK);
    expect(finding.engineVersion).toBe("1.0.0");
    expect(finding.outcome).toBe("PASS");
    expect(finding.status).toBe("OPEN");
    expect(finding.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(finding.findingId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("gives two different results from the same rule run distinct findingIds", () => {
    const baseResult = {
      outcome: "PASS" as const,
      severity: "LOW" as const,
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
    const findings = runRule(twoResultRule, ctx, RULE_PACK, "1.0.0");
    expect(findings[0].findingId).not.toBe(findings[1].findingId);
  });
});

describe("runRulePack", () => {
  it("concatenates findings from every rule in the pack, in order", () => {
    const secondRule: RuleDefinition = { ...alwaysPassRule, ruleId: "second-rule" };
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const findings = runRulePack(RULE_PACK, [alwaysPassRule, secondRule], ctx, "1.0.0");
    expect(findings.map((f) => f.ruleId)).toEqual(["always-pass", "second-rule"]);
  });
});

describe("stable finding IDs across identical reruns", () => {
  it("the same rule pack against the same report produces identical findingIds regardless of when it runs", () => {
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const run1 = runRule(alwaysPassRule, ctx, RULE_PACK, "1.0.0", () => "2026-01-01T00:00:00.000Z");
    const run2 = runRule(alwaysPassRule, ctx, RULE_PACK, "1.0.0", () => "2099-12-31T23:59:59.999Z");
    expect(run1[0].findingId).toBe(run2[0].findingId);
    expect(run1[0].createdAt).not.toBe(run2[0].createdAt);
  });

  it("byte-identical serialized bodies once createdAt is stripped, even when createdAt differs", () => {
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const run1 = runRule(alwaysPassRule, ctx, RULE_PACK, "1.0.0", () => "2026-01-01T00:00:00.000Z");
    const run2 = runRule(alwaysPassRule, ctx, RULE_PACK, "1.0.0", () => "2099-12-31T23:59:59.999Z");
    expect(JSON.stringify(withoutCreatedAt(run1[0]))).toBe(JSON.stringify(withoutCreatedAt(run2[0])));
  });

  it("a different report identity changes the findingId", () => {
    const ctx1 = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const ctx2 = buildRuleContext({ ...IFRS_FULL_FIXTURE, reportIdentity: { ...IFRS_FULL_FIXTURE.reportIdentity, reportId: "different-report" } }, ZERO_TOLERANCE);
    const f1 = runRule(alwaysPassRule, ctx1, RULE_PACK, "1.0.0")[0];
    const f2 = runRule(alwaysPassRule, ctx2, RULE_PACK, "1.0.0")[0];
    expect(f1.findingId).not.toBe(f2.findingId);
  });
});
