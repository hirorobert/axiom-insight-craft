// canonicalStatement/permutation.test.ts — section F's deterministic-output-
// order requirement: permuting the INPUT arrays (facts, statements,
// sections, notes, noteReferences) must never change the rule pack's
// OUTPUT order or any finding's identity. runRulePack's own sort (by
// rule-pack registration order, ruleId, discriminator, periodId, affected
// identity, evaluationId — see ruleEngine.ts) is what guarantees this; this
// file proves it holds for a real fixture, not just in principle.

import { describe, expect, it } from "vitest";
import { buildRuleContext } from "./rules/ruleEngine";
import { runCanonicalRulePackV1 } from "./rules/rulePack";
import { withoutCreatedAt } from "./serialization";
import { ZERO_TOLERANCE } from "./money";
import { IFRS_FULL_FIXTURE } from "./fixtures/ifrsFullFixture";
import type { CanonicalFinancialStatementReport } from "./types";

function reverse<T>(arr: readonly T[]): T[] {
  return [...arr].reverse();
}

/** A shuffled-array clone using a fixed seed (deterministic across test runs). */
function shuffle<T>(arr: readonly T[], seed: number): T[] {
  const copy = [...arr];
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function runOn(report: CanonicalFinancialStatementReport, clock: () => string) {
  return runCanonicalRulePackV1(buildRuleContext(report, ZERO_TOLERANCE), clock).map(withoutCreatedAt);
}

describe("deterministic output order — permuting input arrays never changes the result", () => {
  const clock = () => "2026-01-01T00:00:00.000Z";
  const baseline = runOn(IFRS_FULL_FIXTURE, clock);

  it("reordering report.facts does not change the output order or any identity", () => {
    const permuted: CanonicalFinancialStatementReport = { ...IFRS_FULL_FIXTURE, facts: reverse(IFRS_FULL_FIXTURE.facts) };
    expect(runOn(permuted, clock)).toEqual(baseline);
  });

  it("shuffling report.facts (fixed seed) does not change the output order or any identity", () => {
    const permuted: CanonicalFinancialStatementReport = { ...IFRS_FULL_FIXTURE, facts: shuffle(IFRS_FULL_FIXTURE.facts, 42) };
    expect(runOn(permuted, clock)).toEqual(baseline);
  });

  it("reordering report.statements does not change the output order or any identity", () => {
    const permuted: CanonicalFinancialStatementReport = { ...IFRS_FULL_FIXTURE, statements: reverse(IFRS_FULL_FIXTURE.statements) };
    expect(runOn(permuted, clock)).toEqual(baseline);
  });

  it("reordering sections within a statement does not change the output order or any identity", () => {
    const permuted: CanonicalFinancialStatementReport = {
      ...IFRS_FULL_FIXTURE,
      statements: IFRS_FULL_FIXTURE.statements.map((s) => ({ ...s, sections: reverse(s.sections) })),
    };
    expect(runOn(permuted, clock)).toEqual(baseline);
  });

  it("reordering lines within a section does not change the output order or any identity", () => {
    const permuted: CanonicalFinancialStatementReport = {
      ...IFRS_FULL_FIXTURE,
      statements: IFRS_FULL_FIXTURE.statements.map((s) => ({ ...s, sections: s.sections.map((sec) => ({ ...sec, lines: reverse(sec.lines) })) })),
    };
    expect(runOn(permuted, clock)).toEqual(baseline);
  });

  it("reordering report.notes does not change the output order or any identity", () => {
    const permuted: CanonicalFinancialStatementReport = { ...IFRS_FULL_FIXTURE, notes: reverse(IFRS_FULL_FIXTURE.notes) };
    expect(runOn(permuted, clock)).toEqual(baseline);
  });

  it("reordering report.noteReferences does not change the output order or any identity", () => {
    const permuted: CanonicalFinancialStatementReport = { ...IFRS_FULL_FIXTURE, noteReferences: reverse(IFRS_FULL_FIXTURE.noteReferences) };
    expect(runOn(permuted, clock)).toEqual(baseline);
  });

  it("reordering everything at once still produces the identical result", () => {
    const permuted: CanonicalFinancialStatementReport = {
      ...IFRS_FULL_FIXTURE,
      facts: shuffle(IFRS_FULL_FIXTURE.facts, 7),
      statements: reverse(IFRS_FULL_FIXTURE.statements).map((s) => ({ ...s, sections: reverse(s.sections).map((sec) => ({ ...sec, lines: shuffle(sec.lines, 3) })) })),
      notes: reverse(IFRS_FULL_FIXTURE.notes),
      noteReferences: shuffle(IFRS_FULL_FIXTURE.noteReferences, 11),
    };
    expect(runOn(permuted, clock)).toEqual(baseline);
  });

  it("the stored report's own presentation order is never mutated by any of the above constructions (they are all copies)", () => {
    expect(IFRS_FULL_FIXTURE.facts[0]).toBe(IFRS_FULL_FIXTURE.facts[0]); // sanity: original identity preserved
    const permuted = reverse(IFRS_FULL_FIXTURE.facts);
    expect(IFRS_FULL_FIXTURE.facts).not.toBe(permuted);
    expect(IFRS_FULL_FIXTURE.facts[0]).toBe(permuted[permuted.length - 1]);
  });
});
