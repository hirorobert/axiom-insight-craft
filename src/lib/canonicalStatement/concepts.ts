// canonicalStatement/concepts.ts — a minimal, framework-neutral controlled
// vocabulary of the structural anchors the deterministic rule pack needs to
// locate unambiguously. This is NOT a taxonomy (not XBRL, not a chart of
// accounts) — just enough canonical `StatementLine.concept` keys for Rules
// 1 and 6 to find the right lines without guessing from a printed label.
// Everything else about a line (its label, ordering, wording) is free-form
// presentation and is never inspected by rule logic.

export const CANONICAL_CONCEPTS = {
  TOTAL_ASSETS: "total_assets",
  TOTAL_LIABILITIES: "total_liabilities",
  TOTAL_EQUITY: "total_equity",
  TOTAL_LIABILITIES_AND_EQUITY: "total_liabilities_and_equity",
  CASH_AND_CASH_EQUIVALENTS_CLOSING_CF: "cash_and_cash_equivalents_closing_cf",
  CASH_AND_CASH_EQUIVALENTS_SFP: "cash_and_cash_equivalents_sfp",
} as const;

export type CanonicalConcept = (typeof CANONICAL_CONCEPTS)[keyof typeof CANONICAL_CONCEPTS];
