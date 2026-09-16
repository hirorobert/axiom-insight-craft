import { describe, expect, it } from "vitest";
import { applyFactCorrection, FactVersionConflictError, indexLatestFacts, resolveLatestFact } from "./provenance";
import { fact, provenance, CURRENT } from "./fixtures/builders";
import { money } from "./money";
import type { CanonicalFinancialStatementReport, CorrectFactDecision } from "./types";
import { CANONICAL_SCHEMA_VERSION } from "./types";

const v1 = fact("f-1", "100.00", "TZS", 2, CURRENT);
const v2 = { ...fact("f-1", "150.00", "TZS", 2, CURRENT), version: 2, supersedesVersion: 1 };

function baseReport(facts: (typeof v1)[]): CanonicalFinancialStatementReport {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    reportIdentity: { reportId: "r-1", companyId: "company-1", reportVersion: 1 },
    entity: { legalName: "Test Co" },
    period: { periodId: "CURRENT", startDate: "2026-01-01", endDate: "2026-12-31", periodYear: 2026 },
    comparativePeriods: [],
    framework: { kind: "IFRS" },
    presentationCurrency: { currency: "TZS", scale: 2, roundingPolicy: { mode: "HALF_UP", scale: 2 }, presentationMultiplier: 1n },
    statements: [],
    notes: [],
    noteReferences: [],
    accountingPolicies: [],
    textualDisclosures: [],
    facts,
    provenanceOrigin: "TRIAL_BALANCE_DERIVED",
  };
}

describe("resolveLatestFact", () => {
  it("returns undefined for an unknown factId", () => {
    expect(resolveLatestFact([v1], "no-such-fact")).toBeUndefined();
  });
  it("returns the single version when only one exists", () => {
    expect(resolveLatestFact([v1], "f-1")).toEqual(v1);
  });
  it("returns the highest version, regardless of array order", () => {
    expect(resolveLatestFact([v2, v1], "f-1")).toEqual(v2);
    expect(resolveLatestFact([v1, v2], "f-1")).toEqual(v2);
  });
  it("never returns a superseded version once a later one exists", () => {
    const resolved = resolveLatestFact([v1, v2], "f-1");
    expect(resolved?.version).toBe(2);
    expect(resolved?.value).toEqual(money("TZS", 2, 15000n));
  });
});

describe("indexLatestFacts", () => {
  it("indexes every distinct factId to its own latest version", () => {
    const other = fact("f-2", "5.00", "TZS", 2, CURRENT);
    const index = indexLatestFacts([v1, v2, other]);
    expect(index.get("f-1")?.version).toBe(2);
    expect(index.get("f-2")?.version).toBe(1);
    expect(index.size).toBe(2);
  });
});

describe("applyFactCorrection — append-only, never mutates", () => {
  const decision: CorrectFactDecision = {
    decisionId: "d-1",
    decisionType: "CORRECT_FACT",
    reviewerId: "fm-1",
    decidedAt: "2026-01-02T00:00:00.000Z",
    factId: "f-1",
    supersedesVersion: 1,
    newVersion: 2,
    correctedValue: money("TZS", 2, 15000n),
    rationale: "Corrected after evidence review.",
  };

  it("appends a new version without removing the prior one", () => {
    const report = baseReport([v1]);
    const corrected = applyFactCorrection(report, decision, provenance("corrected"));
    expect(corrected.facts).toHaveLength(2);
    expect(corrected.facts).toContainEqual(v1); // original untouched
    expect(resolveLatestFact(corrected.facts, "f-1")?.value).toEqual(money("TZS", 2, 15000n));
  });

  it("does not mutate the report it was given", () => {
    const report = baseReport([v1]);
    applyFactCorrection(report, decision, provenance("corrected"));
    expect(report.facts).toHaveLength(1);
  });

  it("refuses a correction whose supersedesVersion is stale", () => {
    const report = baseReport([v1, v2]); // v2 already exists
    expect(() => applyFactCorrection(report, decision, provenance("corrected"))).toThrow(FactVersionConflictError);
  });

  it("refuses a correction for a fact that does not exist", () => {
    const report = baseReport([]);
    expect(() => applyFactCorrection(report, decision, provenance("corrected"))).toThrow(FactVersionConflictError);
  });

  it("refuses when newVersion is not exactly supersedesVersion + 1", () => {
    const report = baseReport([v1]);
    const badDecision: CorrectFactDecision = { ...decision, newVersion: 3 };
    expect(() => applyFactCorrection(report, badDecision, provenance("corrected"))).toThrow(FactVersionConflictError);
  });
});
