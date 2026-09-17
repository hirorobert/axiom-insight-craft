import { describe, expect, it } from "vitest";
import { buildRuleContext } from "../rules/ruleEngine";
import { financialPositionEquationRule } from "../rules/financialPositionEquation";
import { subtotalCastingRule } from "../rules/subtotalCasting";
import { comparativePeriodAlignmentRule } from "../rules/comparativePeriodAlignment";
import { missingComparativeDetectionRule } from "../rules/missingComparativeDetection";
import { ZERO_TOLERANCE } from "../money";
import { validateCanonicalReport } from "../validation";
import { MULTI_COMPARATIVE_FIXTURE } from "./multiComparativeFixture";
import type { RuleEvaluationResult } from "../rules/ruleEngine";

const ctx = buildRuleContext(MULTI_COMPARATIVE_FIXTURE, ZERO_TOLERANCE);

function byPeriod(results: readonly RuleEvaluationResult[]): Map<string, RuleEvaluationResult> {
  const map = new Map<string, RuleEvaluationResult>();
  for (const r of results) {
    if (r.periodId) map.set(r.periodId, r);
  }
  return map;
}

describe("multi-comparative fixture: three genuinely distinct periods", () => {
  it("passes runtime validation as a well-formed aggregate", () => {
    expect(() => validateCanonicalReport(MULTI_COMPARATIVE_FIXTURE)).not.toThrow();
  });

  it("declares exactly two comparative periods with distinct periodIds", () => {
    expect(MULTI_COMPARATIVE_FIXTURE.comparativePeriods.map((p) => p.periodId)).toEqual(["COMPARATIVE_1", "COMPARATIVE_2"]);
  });

  describe("Rule 1 (SFP equation) — evaluates the correct fact for each of the three periods, exactly once", () => {
    const results = financialPositionEquationRule.evaluate(ctx);
    const byPeriodId = byPeriod(results);

    it("produces exactly three results — one per period, no more, no fewer", () => {
      expect(results).toHaveLength(3);
      expect([...byPeriodId.keys()].sort()).toEqual(["COMPARATIVE_1", "COMPARATIVE_2", "CURRENT"]);
    });

    it("every period independently PASSes with its own distinct figures", () => {
      for (const periodId of ["CURRENT", "COMPARATIVE_1", "COMPARATIVE_2"]) {
        expect(byPeriodId.get(periodId)?.outcome).toBe("PASS");
      }
    });

    it("the three periods' observed totalAssets are genuinely different values (never the same fact reused)", () => {
      const cur = byPeriodId.get("CURRENT")?.observedValues.totalAssets;
      const p1 = byPeriodId.get("COMPARATIVE_1")?.observedValues.totalAssets;
      const p2 = byPeriodId.get("COMPARATIVE_2")?.observedValues.totalAssets;
      expect(cur).not.toEqual(p1);
      expect(p1).not.toEqual(p2);
      expect(cur).not.toEqual(p2);
    });
  });

  describe("Rule 2 (subtotal casting) — casts total_assets correctly per period", () => {
    const results = subtotalCastingRule.evaluate(ctx).filter((r) => r.affected.lineId === "mc-assets");
    const byPeriodId = byPeriod(results);

    it("produces one casting result per period for the assets total", () => {
      expect([...byPeriodId.keys()].sort()).toEqual(["COMPARATIVE_1", "COMPARATIVE_2", "CURRENT"]);
    });

    it("every period's casting PASSes independently", () => {
      for (const periodId of ["CURRENT", "COMPARATIVE_1", "COMPARATIVE_2"]) {
        expect(byPeriodId.get(periodId)?.outcome).toBe("PASS");
      }
    });
  });

  describe("Rule 4 (comparative-period alignment) — both comparative periods align independently", () => {
    const results = comparativePeriodAlignmentRule.evaluate(ctx);
    const byPeriodId = byPeriod(results);

    it("produces one result per comparative period used (never conflating them into one)", () => {
      expect([...byPeriodId.keys()].sort()).toEqual(["COMPARATIVE_1", "COMPARATIVE_2"]);
    });

    it("both comparative periods PASS — multiple comparatives are no longer treated as a defect", () => {
      expect(byPeriodId.get("COMPARATIVE_1")?.outcome).toBe("PASS");
      expect(byPeriodId.get("COMPARATIVE_2")?.outcome).toBe("PASS");
    });
  });

  describe("Rule 9 (missing comparative detection) — checks presence for each declared comparative period separately", () => {
    const results = missingComparativeDetectionRule.evaluate(ctx).filter((r) => r.affected.lineId === "mc-assets");

    it("produces exactly two results for the assets total — one per comparative period", () => {
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.periodId).sort()).toEqual(["COMPARATIVE_1", "COMPARATIVE_2"]);
    });

    it("both PASS — the assets total has a present binding for both comparative periods", () => {
      expect(results.every((r) => r.outcome === "PASS")).toBe(true);
    });
  });
});
