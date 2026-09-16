import { describe, expect, it } from "vitest";
import { currencyScaleConsistencyRule } from "./currencyScaleConsistency";
import { buildRuleContext } from "./ruleEngine";
import { testReport } from "./testReport";
import { fact, CURRENT } from "../fixtures/builders";
import { ZERO_TOLERANCE } from "../money";

describe("Currency and scale consistency", () => {
  it("PASSes every fact that matches the report's presentation currency and scale", () => {
    const f = fact("f-1", "100.00", "TZS", 2, CURRENT);
    const report = testReport({ facts: [f], currency: "TZS", scale: 2 });
    const results = currencyScaleConsistencyRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("PASS");
  });

  it("FAILs a fact denominated in a different currency", () => {
    const f = fact("f-1", "100.00", "USD", 2, CURRENT);
    const report = testReport({ facts: [f], currency: "TZS", scale: 2 });
    const [result] = currencyScaleConsistencyRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("FAIL");
  });

  it("FAILs a fact at a different scale", () => {
    const f = fact("f-1", "100", "TZS", 0, CURRENT);
    const report = testReport({ facts: [f], currency: "TZS", scale: 2 });
    const [result] = currencyScaleConsistencyRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("FAIL");
  });

  it("never evaluates a MISSING (null) fact — it is simply outside this rule's scope", () => {
    const missing = fact("f-1", null, "TZS", 2, CURRENT);
    const report = testReport({ facts: [missing], currency: "TZS", scale: 2 });
    const results = currencyScaleConsistencyRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("NOT_APPLICABLE"); // no non-null facts to check
  });

  it("is NOT_APPLICABLE when the report has no facts at all", () => {
    const report = testReport({ facts: [] });
    const [result] = currencyScaleConsistencyRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(result.outcome).toBe("NOT_APPLICABLE");
  });
});
