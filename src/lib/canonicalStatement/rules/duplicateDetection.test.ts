import { describe, expect, it } from "vitest";
import { duplicateDetectionRule } from "./duplicateDetection";
import { buildRuleContext } from "./ruleEngine";
import { testReport } from "./testReport";
import { fact, line, provenance, CURRENT } from "../fixtures/builders";
import { ZERO_TOLERANCE } from "../money";
import type { Statement } from "../types";

describe("Duplicate line/fact detection", () => {
  it("PASSes (a single synthetic no-duplicates result) when nothing is duplicated", () => {
    const f1 = fact("f1", "100.00", "TZS", 2, CURRENT);
    const f2 = fact("f2", "200.00", "TZS", 2, CURRENT);
    const statement: Statement = {
      statementId: "s",
      type: "STATEMENT_OF_FINANCIAL_POSITION",
      title: "S",
      sections: [{ sectionId: "sec", label: "sec", lines: [line("l1", "A", "concept_a", "DETAIL", f1.factId), line("l2", "B", "concept_b", "DETAIL", f2.factId)] }],
    };
    const report = testReport({ statements: [statement], facts: [f1, f2] });
    const results = duplicateDetectionRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("PASS");
  });

  it("FAILs two lines that share the same (concept, role) even with different lineIds and labels", () => {
    const f1 = fact("f1", "100.00", "TZS", 2, CURRENT);
    const f2 = fact("f2", "200.00", "TZS", 2, CURRENT);
    const statement: Statement = {
      statementId: "s",
      type: "STATEMENT_OF_FINANCIAL_POSITION",
      title: "S",
      sections: [{ sectionId: "sec", label: "sec", lines: [line("l1", "Total", "total_assets", "TOTAL", f1.factId), line("l2", "Grand total", "total_assets", "TOTAL", f2.factId)] }],
    };
    const report = testReport({ statements: [statement], facts: [f1, f2] });
    const results = duplicateDetectionRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(results.some((r) => r.outcome === "FAIL")).toBe(true);
  });

  it("never flags two lines that merely share a printed label but have different concepts", () => {
    const f1 = fact("f1", "100.00", "TZS", 2, CURRENT);
    const f2 = fact("f2", "200.00", "TZS", 2, CURRENT);
    const totalAssetsLine = line("l1", "Total", "total_assets", "TOTAL", f1.factId);
    const totalEquityLine = line("l2", "Total", "total_equity", "TOTAL", f2.factId); // same label "Total", different concept
    const statement: Statement = { statementId: "s", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "S", sections: [{ sectionId: "sec", label: "sec", lines: [totalAssetsLine, totalEquityLine] }] };
    const report = testReport({ statements: [statement], facts: [f1, f2] });
    const results = duplicateDetectionRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(results.every((r) => r.outcome !== "FAIL")).toBe(true);
  });

  it("FAILs two distinct facts sharing an identical value/period/source-locator fingerprint", () => {
    const sharedLocator = { kind: "MANUAL" as const, note: "same-cell" };
    const factA = { ...fact("fa", "500.00", "TZS", 2, CURRENT), provenance: provenance("500.00", sharedLocator) };
    const factB = { ...fact("fb", "500.00", "TZS", 2, CURRENT), provenance: provenance("500.00", sharedLocator) };
    const report = testReport({ facts: [factA, factB] });
    const results = duplicateDetectionRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(results.some((r) => r.outcome === "FAIL" && r.deterministicCalculation.includes("2 distinct factIds"))).toBe(true);
  });

  it("does not flag two facts with the same value but different locators", () => {
    const factA = { ...fact("fa", "500.00", "TZS", 2, CURRENT), provenance: provenance("500.00", { kind: "MANUAL" as const, note: "cell-a" }) };
    const factB = { ...fact("fb", "500.00", "TZS", 2, CURRENT), provenance: provenance("500.00", { kind: "MANUAL" as const, note: "cell-b" }) };
    const report = testReport({ facts: [factA, factB] });
    const results = duplicateDetectionRule.evaluate(buildRuleContext(report, ZERO_TOLERANCE));
    expect(results.every((r) => r.outcome !== "FAIL")).toBe(true);
  });
});
