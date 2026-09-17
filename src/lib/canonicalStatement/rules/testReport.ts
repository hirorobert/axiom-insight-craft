// canonicalStatement/rules/testReport.ts — a minimal report scaffold for
// per-rule unit tests. Test-only; never imported by production code.

import { CANONICAL_SCHEMA_VERSION } from "../types";
import type { CanonicalFinancialStatementReport, ComparativePeriod, MonetaryFact, Note, NoteReference, Statement } from "../types";
import { indexLatestFacts } from "../provenance";
import type { Tolerance } from "../money";
import type { RuleContext } from "./ruleEngine";

export function testReport(overrides: {
  statements?: readonly Statement[];
  notes?: readonly Note[];
  noteReferences?: readonly NoteReference[];
  facts?: readonly MonetaryFact[];
  comparativePeriods?: readonly ComparativePeriod[];
  currency?: string;
  scale?: number;
}): CanonicalFinancialStatementReport {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    reportIdentity: { reportId: "test-report", companyId: "test-company", reportVersion: 1 },
    entity: { legalName: "Test Entity" },
    period: { periodId: "CURRENT", startDate: "2026-01-01", endDate: "2026-12-31", periodYear: 2026 },
    comparativePeriods: overrides.comparativePeriods ?? [],
    framework: { kind: "IFRS" },
    presentationCurrency: {
      currency: overrides.currency ?? "TZS",
      scale: overrides.scale ?? 2,
      roundingPolicy: { mode: "HALF_UP", scale: overrides.scale ?? 2 },
      presentationMultiplier: 1n,
    },
    statements: overrides.statements ?? [],
    notes: overrides.notes ?? [],
    noteReferences: overrides.noteReferences ?? [],
    accountingPolicies: [],
    textualDisclosures: [],
    facts: overrides.facts ?? [],
    provenanceOrigin: "TRIAL_BALANCE_DERIVED",
  };
}

/**
 * Builds a RuleContext WITHOUT going through `buildRuleContext`'s
 * `validateCanonicalReport` call. Reserved exclusively for per-rule unit
 * tests that deliberately construct a minimal, non-conformant report (e.g.
 * no SFP statement at all, a dangling movement-schedule fact id) to isolate
 * ONE rule's own branch logic — a concern entirely separate from "does this
 * aggregate pass the validation boundary," which validation.test.ts and the
 * full-fixture tests (fixtures.test.ts, multiComparativeFixture.test.ts,
 * isolatedRuleFixtures.test.ts) already cover exhaustively against real,
 * validated aggregates. Production code and any test exercising the actual
 * validated-entry contract must use `buildRuleContext` instead.
 */
export function buildUncheckedRuleContext(report: CanonicalFinancialStatementReport, tolerance: Tolerance): RuleContext {
  return { report, tolerance, latestFacts: indexLatestFacts(report.facts) };
}
