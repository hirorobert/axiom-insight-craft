// canonicalStatement/fixtures/multipleSfpFixture.ts — a report with TWO
// statements of financial position, used to prove Rule 6
// (cashflow-closing-cash-reconciliation) never picks "the first SFP" by
// array order. `buildMultipleSfpFixture("forward" | "reverse")` returns the
// identical two SFP statements in opposite declaration order — Rule 6 must
// report the exact same deterministic ambiguity (INSUFFICIENT_EVIDENCE,
// naming both statementIds) either way. This is intentionally still a
// schema-valid aggregate: validation does not restrict how many statements
// of a given type a report may declare, only that every statementId/
// sectionId/lineId stays unique and every reference resolves — the
// ambiguity itself is squarely a Rule 6 (and, independently, Rule 1)
// concern, never a validation rejection.

import { CANONICAL_CONCEPTS } from "../concepts";
import { CANONICAL_SCHEMA_VERSION } from "../types";
import type { CanonicalFinancialStatementReport } from "../types";
import { CURRENT, fact, line } from "./builders";

const CCY = "TZS";
const SCALE = 2;

export function buildMultipleSfpFixture(order: "forward" | "reverse"): CanonicalFinancialStatementReport {
  const closingCashFact = fact("mssfp-closing-cash", "500000.00", CCY, SCALE, CURRENT);
  const cashFlowStatement = {
    statementId: "mssfp-stmt-cf",
    type: "STATEMENT_OF_CASH_FLOWS" as const,
    title: "Statement of Cash Flows",
    sections: [
      {
        sectionId: "mssfp-cf-body",
        label: "Cash flow",
        lines: [line("mssfp-cf-closing", "Cash and cash equivalents at end of period", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF, "DETAIL", closingCashFact.factId)],
      },
    ],
  };

  const sfpCashFactA = fact("mssfp-cash-a", "500000.00", CCY, SCALE, CURRENT);
  const sfpA = {
    statementId: "mssfp-stmt-sfp-a",
    type: "STATEMENT_OF_FINANCIAL_POSITION" as const,
    title: "Statement of Financial Position (A)",
    sections: [
      { sectionId: "mssfp-sfp-a-assets", label: "Assets", lines: [line("mssfp-sfp-a-cash", "Cash and cash equivalents", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP, "DETAIL", sfpCashFactA.factId)] },
    ],
  };

  const sfpCashFactB = fact("mssfp-cash-b", "400000.00", CCY, SCALE, CURRENT);
  const sfpB = {
    statementId: "mssfp-stmt-sfp-b",
    type: "STATEMENT_OF_FINANCIAL_POSITION" as const,
    title: "Statement of Financial Position (B)",
    sections: [
      { sectionId: "mssfp-sfp-b-assets", label: "Assets", lines: [line("mssfp-sfp-b-cash", "Cash and cash equivalents", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP, "DETAIL", sfpCashFactB.factId)] },
    ],
  };

  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    reportIdentity: { reportId: "fixture-multiple-sfp", companyId: "company-multiple-sfp", reportVersion: 1 },
    entity: { legalName: "Example Multiple-SFP Preparer Ltd" },
    period: { periodId: "CURRENT", startDate: "2026-01-01", endDate: "2026-12-31", periodYear: 2026 },
    comparativePeriods: [],
    framework: { kind: "IFRS" },
    presentationCurrency: { currency: CCY, scale: SCALE, roundingPolicy: { mode: "HALF_UP", scale: SCALE }, presentationMultiplier: 1n },
    statements: order === "forward" ? [cashFlowStatement, sfpA, sfpB] : [cashFlowStatement, sfpB, sfpA],
    notes: [],
    noteReferences: [],
    accountingPolicies: [],
    textualDisclosures: [],
    facts: [closingCashFact, sfpCashFactA, sfpCashFactB],
    provenanceOrigin: "TRIAL_BALANCE_DERIVED",
  };
}
