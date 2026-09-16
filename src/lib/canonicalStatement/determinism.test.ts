import { describe, expect, it } from "vitest";
import { buildRuleContext } from "./rules/ruleEngine";
import { runCanonicalRulePackV1 } from "./rules/rulePack";
import { canonicalStringify, withoutCreatedAt } from "./serialization";
import { ZERO_TOLERANCE } from "./money";
import { IFRS_FULL_FIXTURE } from "./fixtures/ifrsFullFixture";
import { DEFECTIVE_FIXTURE } from "./fixtures/defectiveFixture";

describe("deterministic replay", () => {
  it("stable finding IDs across identical reruns, for a real fixture", () => {
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const run1 = runCanonicalRulePackV1(ctx, () => "2026-01-01T00:00:00.000Z");
    const run2 = runCanonicalRulePackV1(ctx, () => "2099-06-15T12:00:00.000Z");
    expect(run1.map((f) => f.findingId)).toEqual(run2.map((f) => f.findingId));
  });

  it("byte-identical serialized results for identical input, once createdAt is excluded", () => {
    const ctx = buildRuleContext(DEFECTIVE_FIXTURE, ZERO_TOLERANCE);
    const run1 = runCanonicalRulePackV1(ctx, () => "2026-01-01T00:00:00.000Z");
    const run2 = runCanonicalRulePackV1(ctx, () => "2099-06-15T12:00:00.000Z");
    const serialized1 = canonicalStringify(run1.map(withoutCreatedAt));
    const serialized2 = canonicalStringify(run2.map(withoutCreatedAt));
    expect(serialized1).toBe(serialized2);
  });

  it("createdAt itself legitimately differs between the two runs — proving the clock was actually exercised", () => {
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const run1 = runCanonicalRulePackV1(ctx, () => "2026-01-01T00:00:00.000Z");
    const run2 = runCanonicalRulePackV1(ctx, () => "2099-06-15T12:00:00.000Z");
    expect(run1[0].createdAt).not.toBe(run2[0].createdAt);
    expect(run1[0].createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("no timestamp field ever enters findingId hashing — two runs with different clocks share every findingId", () => {
    const ctx = buildRuleContext(DEFECTIVE_FIXTURE, ZERO_TOLERANCE);
    const run1 = runCanonicalRulePackV1(ctx, () => "2000-01-01T00:00:00.000Z");
    const run2 = runCanonicalRulePackV1(ctx, () => "2100-01-01T00:00:00.000Z");
    const idsToOutcomes1 = new Map(run1.map((f) => [f.findingId, f.outcome]));
    const idsToOutcomes2 = new Map(run2.map((f) => [f.findingId, f.outcome]));
    expect(idsToOutcomes1).toEqual(idsToOutcomes2);
  });

  it("a rerun of the whole rule pack is idempotent (running it twice never accumulates duplicate findings)", () => {
    const ctx = buildRuleContext(IFRS_FULL_FIXTURE, ZERO_TOLERANCE);
    const run1 = runCanonicalRulePackV1(ctx);
    const run2 = runCanonicalRulePackV1(ctx);
    expect(run1).toHaveLength(run2.length);
  });
});
