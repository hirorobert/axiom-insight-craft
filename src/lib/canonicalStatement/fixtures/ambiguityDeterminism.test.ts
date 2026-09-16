// canonicalStatement/fixtures/ambiguityDeterminism.test.ts — the
// deterministic-ambiguity-closure requirement: proves that removing
// first-match authority (Rules 1 and 6, and the underlying
// resolveLineByConcept/resolveUniqueStatementOfType helpers) is genuinely
// order-independent, not just "usually" order-independent. Three proofs:
//
//   1. The Rule 8 isolated duplicate-concept mutation still produces
//      byte-identical output (outcomes, findingKeys, evaluationIds, and
//      their ORDER) after reversing the duplicate-bearing lines, shuffling
//      their sections, and reversing the statement order.
//   2. A report with two statements of financial position, declared in
//      opposite order, makes Rule 6 report the SAME deterministic ambiguity
//      result (INSUFFICIENT_EVIDENCE, naming both statementIds) either way.
//   3. No two findings within one rule-pack run ever share a findingKey or
//      an evaluationId.

import { describe, expect, it } from "vitest";
import { buildRuleContext } from "../rules/ruleEngine";
import { runCanonicalRulePackV1 } from "../rules/rulePack";
import { withoutCreatedAt } from "../serialization";
import { ZERO_TOLERANCE } from "../money";
import { validateCanonicalReport } from "../validation";
import { ISOLATED_MUTATIONS } from "./isolatedMutations";
import { buildMultipleSfpFixture } from "./multipleSfpFixture";
import { IFRS_FULL_FIXTURE } from "./ifrsFullFixture";
import { DEFECTIVE_FIXTURE } from "./defectiveFixture";
import type { CanonicalFinancialStatementReport, RuleEvaluationRecord, Statement } from "../types";

function run(report: CanonicalFinancialStatementReport): readonly RuleEvaluationRecord[] {
  return runCanonicalRulePackV1(buildRuleContext(report, ZERO_TOLERANCE), () => "2026-01-01T00:00:00.000Z");
}

function assertNoDuplicateIdentities(records: readonly RuleEvaluationRecord[]): void {
  const findingKeys = records.map((r) => r.findingKey);
  const evaluationIds = records.map((r) => r.evaluationId);
  expect(new Set(findingKeys).size).toBe(findingKeys.length);
  expect(new Set(evaluationIds).size).toBe(evaluationIds.length);
}

describe("1. Rule 8 isolated duplicate-concept mutation — permutation proof", () => {
  const original = ISOLATED_MUTATIONS["duplicate-detection"]();

  // Reverse the duplicate-bearing lines (the assets section, where both
  // total_assets lines live), shuffle the SFP statement's own section
  // order, and reverse the whole statements array.
  const [sfp, pnl, cf] = original.statements;
  const assetsSection = sfp.sections[0];
  const permutedSfp: Statement = {
    ...sfp,
    sections: [sfp.sections[2], sfp.sections[0], sfp.sections[1]].map((section) =>
      section.sectionId === assetsSection.sectionId ? { ...section, lines: [...section.lines].reverse() } : section,
    ),
  };
  const permuted: CanonicalFinancialStatementReport = { ...original, statements: [cf, pnl, permutedSfp] };

  it("both the original and the permuted aggregate pass runtime validation", () => {
    expect(() => validateCanonicalReport(original)).not.toThrow();
    expect(() => validateCanonicalReport(permuted)).not.toThrow();
  });

  it("the permutation is genuine — statement order, section order, and line order all actually differ", () => {
    expect(permuted.statements.map((s) => s.statementId)).not.toEqual(original.statements.map((s) => s.statementId));
    expect(permutedSfp.sections.map((s) => s.sectionId)).not.toEqual(sfp.sections.map((s) => s.sectionId));
    const originalAssetsLineIds = assetsSection.lines.map((l) => l.lineId);
    const permutedAssetsSection = permutedSfp.sections.find((s) => s.sectionId === assetsSection.sectionId)!;
    expect(permutedAssetsSection.lines.map((l) => l.lineId)).not.toEqual(originalAssetsLineIds);
    expect(permutedAssetsSection.lines.map((l) => l.lineId).sort()).toEqual([...originalAssetsLineIds].sort());
  });

  it("produces byte-identical output (outcomes, findingKeys, evaluationIds, and their order) once createdAt is stripped", () => {
    const originalResults = run(original).map(withoutCreatedAt);
    const permutedResults = run(permuted).map(withoutCreatedAt);
    expect(permutedResults).toEqual(originalResults);
  });

  it("the ambiguous total_assets finding itself is present and identical in both runs", () => {
    const originalAmbiguous = run(original).find((r) => r.ruleId === "sfp-equation" && r.outcome === "INSUFFICIENT_EVIDENCE");
    const permutedAmbiguous = run(permuted).find((r) => r.ruleId === "sfp-equation" && r.outcome === "INSUFFICIENT_EVIDENCE");
    expect(originalAmbiguous).toBeDefined();
    expect(withoutCreatedAt(originalAmbiguous!)).toEqual(withoutCreatedAt(permutedAmbiguous!));
  });
});

describe("2. Two SFP statements in opposite orders — Rule 6 determinism proof", () => {
  const forward = buildMultipleSfpFixture("forward");
  const reverse = buildMultipleSfpFixture("reverse");

  it("both orderings pass runtime validation", () => {
    expect(() => validateCanonicalReport(forward)).not.toThrow();
    expect(() => validateCanonicalReport(reverse)).not.toThrow();
  });

  it("the two fixtures genuinely declare their SFP statements in opposite order", () => {
    const sfpIdsForward = forward.statements.filter((s) => s.type === "STATEMENT_OF_FINANCIAL_POSITION").map((s) => s.statementId);
    const sfpIdsReverse = reverse.statements.filter((s) => s.type === "STATEMENT_OF_FINANCIAL_POSITION").map((s) => s.statementId);
    expect(sfpIdsForward).toEqual(["mssfp-stmt-sfp-a", "mssfp-stmt-sfp-b"]);
    expect(sfpIdsReverse).toEqual(["mssfp-stmt-sfp-b", "mssfp-stmt-sfp-a"]);
  });

  it("Rule 6 reports the SAME ambiguity — INSUFFICIENT_EVIDENCE naming both statementIds — regardless of declaration order", () => {
    const forwardResult = run(forward).find((r) => r.ruleId === "cashflow-closing-cash-reconciliation")!;
    const reverseResult = run(reverse).find((r) => r.ruleId === "cashflow-closing-cash-reconciliation")!;
    expect(forwardResult.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(reverseResult.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(forwardResult.deterministicCalculation).toContain("mssfp-stmt-sfp-a");
    expect(forwardResult.deterministicCalculation).toContain("mssfp-stmt-sfp-b");
    expect(withoutCreatedAt(forwardResult)).toEqual(withoutCreatedAt(reverseResult));
  });

  it("byte-identical whole-rule-pack output between the two orderings, once createdAt is stripped", () => {
    expect(run(forward).map(withoutCreatedAt)).toEqual(run(reverse).map(withoutCreatedAt));
  });
});

describe("3. No duplicate findingKey or evaluationId within one run", () => {
  it.each([
    ["IFRS full golden fixture", IFRS_FULL_FIXTURE],
    ["defective fixture", DEFECTIVE_FIXTURE],
    ["rule-8 duplicate-concept mutation", ISOLATED_MUTATIONS["duplicate-detection"]()],
    ["multiple-SFP fixture (forward)", buildMultipleSfpFixture("forward")],
    ["multiple-SFP fixture (reverse)", buildMultipleSfpFixture("reverse")],
  ])("%s: every findingKey and every evaluationId is unique across the whole run", (_name, report) => {
    assertNoDuplicateIdentities(run(report as CanonicalFinancialStatementReport));
  });
});
