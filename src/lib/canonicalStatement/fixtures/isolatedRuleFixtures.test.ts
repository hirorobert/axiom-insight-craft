// canonicalStatement/fixtures/isolatedRuleFixtures.test.ts — the final
// closure patch's section 3 requirement: for each of the ten rules, an
// isolated mutation of ISOLATED_BASELINE that introduces ONLY that rule's
// defect. Every test proves: the mutated aggregate still passes runtime
// validation; the target rule returns FAIL (or INSUFFICIENT_EVIDENCE where
// that is the correct outcome) exactly as expected; and every OTHER rule
// keeps its baseline outcome COUNT for FAIL/INSUFFICIENT_EVIDENCE at zero
// (i.e. no unrelated rule is pushed into a wrong or new non-PASS state).
// Two mutations have one unavoidable, precisely documented secondary
// effect on a sibling rule's RESULT COUNT (never on its correctness) — see
// isolatedMutations.ts's own comments on Rules 9 and 10, and the two
// dedicated tests below that assert exactly that delta and nothing more.
//
// This is deliberately separate from fixtures/defectiveFixture.ts, which
// remains a useful combined-defect INTEGRATION stress fixture but — as a
// single fixture carrying several interacting defects — cannot by itself
// prove any one rule is independent of the others.

import { describe, expect, it } from "vitest";
import { buildRuleContext } from "../rules/ruleEngine";
import { runCanonicalRulePackV1 } from "../rules/rulePack";
import { ZERO_TOLERANCE } from "../money";
import { validateCanonicalReport } from "../validation";
import { ISOLATED_BASELINE } from "./isolatedBaseline";
import { ISOLATED_MUTATIONS } from "./isolatedMutations";
import type { CanonicalFinancialStatementReport, RuleEvaluationRecord } from "../types";

function run(report: CanonicalFinancialStatementReport): readonly RuleEvaluationRecord[] {
  return runCanonicalRulePackV1(buildRuleContext(report, ZERO_TOLERANCE));
}

function countsByRule(records: readonly RuleEvaluationRecord[]): Map<string, Record<string, number>> {
  const map = new Map<string, Record<string, number>>();
  for (const r of records) {
    const counts = map.get(r.ruleId) ?? {};
    counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
    map.set(r.ruleId, counts);
  }
  return map;
}

function nonPassCount(counts: Record<string, number> | undefined): number {
  if (!counts) return 0;
  return (counts.FAIL ?? 0) + (counts.INSUFFICIENT_EVIDENCE ?? 0);
}

const BASELINE_RECORDS = run(ISOLATED_BASELINE);
const BASELINE_COUNTS = countsByRule(BASELINE_RECORDS);

describe("isolated baseline itself", () => {
  it("passes runtime validation", () => {
    expect(() => validateCanonicalReport(ISOLATED_BASELINE)).not.toThrow();
  });
  it("produces zero FAIL and zero INSUFFICIENT_EVIDENCE across every rule", () => {
    for (const record of BASELINE_RECORDS) {
      expect(["PASS", "NOT_APPLICABLE"]).toContain(record.outcome);
    }
  });
  it("exercises all ten rules", () => {
    expect(BASELINE_COUNTS.size).toBe(10);
  });
});

/**
 * Rules whose isolated mutation produces ZERO change in any other rule's
 * FAIL/INSUFFICIENT_EVIDENCE count — true one-defect-at-a-time isolation.
 */
const CLEANLY_ISOLATED_RULES = [
  "sfp-equation",
  "subtotal-casting",
  "note-to-face-reconciliation",
  "comparative-period-alignment",
  "currency-scale-consistency",
  "cashflow-closing-cash-reconciliation",
  "movement-reconciliation",
  "duplicate-detection",
] as const;

describe.each(CLEANLY_ISOLATED_RULES)("isolated mutation for rule: %s", (targetRuleId) => {
  const mutate = ISOLATED_MUTATIONS[targetRuleId];
  const mutatedReport = mutate();
  const mutatedRecords = run(mutatedReport);
  const mutatedCounts = countsByRule(mutatedRecords);

  it("still passes runtime structural validation", () => {
    expect(() => validateCanonicalReport(mutatedReport)).not.toThrow();
  });

  it("the target rule now reports at least one FAIL (or INSUFFICIENT_EVIDENCE)", () => {
    const targetCounts = mutatedCounts.get(targetRuleId);
    expect(nonPassCount(targetCounts)).toBeGreaterThan(0);
  });

  it("every OTHER rule's FAIL/INSUFFICIENT_EVIDENCE count is unchanged (zero) — no unrelated rule is pushed into failure", () => {
    for (const ruleId of BASELINE_COUNTS.keys()) {
      if (ruleId === targetRuleId) continue;
      expect(nonPassCount(mutatedCounts.get(ruleId))).toBe(0);
    }
  });
});

describe("isolated mutation for rule: missing-comparative-detection", () => {
  const mutatedReport = ISOLATED_MUTATIONS["missing-comparative-detection"]();
  const mutatedRecords = run(mutatedReport);
  const mutatedCounts = countsByRule(mutatedRecords);

  it("still passes runtime structural validation", () => {
    expect(() => validateCanonicalReport(mutatedReport)).not.toThrow();
  });

  it("Rule 9 now reports exactly one FAIL (the profit line's removed COMPARATIVE_1 binding)", () => {
    expect(mutatedCounts.get("missing-comparative-detection")?.FAIL).toBe(1);
  });

  it("documented secondary effect: Rule 2's PASS count drops by exactly 1 (an absent result, not a wrong one) — every other rule is untouched", () => {
    for (const ruleId of BASELINE_COUNTS.keys()) {
      if (ruleId === "missing-comparative-detection") continue;
      expect(nonPassCount(mutatedCounts.get(ruleId))).toBe(0); // no rule anywhere reports a new FAIL/INSUFFICIENT_EVIDENCE
      if (ruleId === "subtotal-casting") {
        expect((mutatedCounts.get(ruleId)?.PASS ?? 0)).toBe((BASELINE_COUNTS.get(ruleId)?.PASS ?? 0) - 1); // exactly one fewer PASS: the removed COMPARATIVE_1 casting check for "profit"
      } else {
        expect(mutatedCounts.get(ruleId)).toEqual(BASELINE_COUNTS.get(ruleId));
      }
    }
  });
});

describe("isolated mutation for rule: orphaned-note-reference-detection", () => {
  const mutatedReport = ISOLATED_MUTATIONS["orphaned-note-reference-detection"]();
  const mutatedRecords = run(mutatedReport);
  const mutatedCounts = countsByRule(mutatedRecords);

  it("still passes runtime structural validation", () => {
    expect(() => validateCanonicalReport(mutatedReport)).not.toThrow();
  });

  it("Rule 10 now reports exactly one FAIL, and the existing valid reference still PASSes", () => {
    expect(mutatedCounts.get("orphaned-note-reference-detection")).toEqual({ PASS: 1, FAIL: 1 });
  });

  it("documented secondary effect: Rule 3 gains exactly one NOT_APPLICABLE (never a FAIL) for the new unresolvable reference — every other rule is untouched", () => {
    for (const ruleId of BASELINE_COUNTS.keys()) {
      if (ruleId === "orphaned-note-reference-detection") continue;
      expect(nonPassCount(mutatedCounts.get(ruleId))).toBe(0); // no rule anywhere reports a new FAIL/INSUFFICIENT_EVIDENCE
      if (ruleId === "note-to-face-reconciliation") {
        expect(mutatedCounts.get(ruleId)).toEqual({ PASS: 1, NOT_APPLICABLE: 1 });
      } else {
        expect(mutatedCounts.get(ruleId)).toEqual(BASELINE_COUNTS.get(ruleId));
      }
    }
  });
});

describe("no isolated mutation ever satisfies its target rule via an unrelated cascade", () => {
  it("every mutation's target rule is the ONLY rule whose non-PASS count is nonzero (rules 9 and 10 aside, whose one documented sibling delta is itself asserted above to never include a FAIL)", () => {
    for (const [targetRuleId, mutate] of Object.entries(ISOLATED_MUTATIONS)) {
      const counts = countsByRule(run(mutate()));
      for (const [ruleId, c] of counts) {
        if (ruleId === targetRuleId) continue;
        expect(nonPassCount(c), `mutation for "${targetRuleId}" unexpectedly caused a FAIL/INSUFFICIENT_EVIDENCE in "${ruleId}"`).toBe(0);
      }
    }
  });
});
