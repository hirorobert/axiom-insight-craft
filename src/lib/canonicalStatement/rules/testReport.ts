// canonicalStatement/rules/testReport.ts — a minimal report scaffold for
// per-rule unit tests. Test-only; never imported by production code.

import { CANONICAL_SCHEMA_VERSION } from "../types";
import type { CanonicalFinancialStatementReport, ComparativePeriod, MonetaryFact, Note, NoteReference, Statement } from "../types";

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
