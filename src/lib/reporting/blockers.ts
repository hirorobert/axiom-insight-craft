// reporting/blockers.ts — one plain sentence per server sign-off blocker (fs_publication_blockers v2 and the
// dependencies' own blockers). Pure. The code is always shown beside it; an unknown code is shown as returned.

const EXACT: Readonly<Record<string, string>> = {
  NOT_LATEST_VERSION: "A newer version exists; only the latest version can be signed.",
  REPORTING_DEPENDENCIES_UNBOUND: "The version is not bound to the statements, notes and comparatives it was built from.",
  REPORTING_DEPENDENCIES_STALE: "The statements, notes or comparatives changed after this version was saved. Save a new version.",
  REPORTING_DEPENDENCIES_UNAVAILABLE: "The current statements, notes or comparatives cannot be read.",
  COMPARATIVE_NOT_APPROVED: "The comparatives are not approved.",
  CASHFLOW_CLOSING_CASH_MISSING: "The cash-flow statement has no closing cash.",
  CASHFLOW_LEDGER_AUTHORITY_MISSING: "The transaction ledger's completeness has not been shown account by account.",
  CASHFLOW_LEDGER_AUTHORITY_UNRESOLVED: "The transaction ledger does not reconcile to the cash accounts' movement.",
  MAPPING_REVIEW_UNRECORDED: "The trial-balance mapping coverage is not recorded in the report.",
  EXPENSE_ANALYSIS_MIXED: "Expenses are presented both by nature and by function.",
  BALANCE_DIFFERENCE: "The statement of financial position does not balance.",
  BUDGET_COMPARISON_GAP: "The budget comparison has a gap.",
  BUDGET_COMPARISON_MISSING: "The budget comparison is missing.",
  TOTAL_COMPREHENSIVE_INCOME_NOT_COMPOSED: "Total comprehensive income is not composed because profit or loss is not.",
};

const PREFIX: readonly (readonly [string, (rest: string) => string])[] = [
  ["REPORTING_CASE_UNSUPPORTED", (r) => `This reporting case is not supported, so the report cannot be finalised (${r}).`],
  ["REQUIREMENT_UNDECIDED", (r) => `A requirement needs a recorded decision (${r}); missing is never treated as not applicable.`],
  ["STATEMENT_FIGURE_MISMATCH", (r) => `A statement figure differs from the composed figure (${r}).`],
  ["STATEMENT_FIGURE_NOT_COMPOSED", (r) => `A figure on the statements was not composed by the server (${r}).`],
  ["BLOCKING_FINDINGS", (r) => `${r} blocking finding(s) from the canonical rule pack.`],
  ["RECONCILIATION_UNMET", (r) => `${r} reconciliation(s) of the rule pack are not met.`],
  ["COMPARATIVE_FIGURES_MISSING", (r) => `Comparative figures are missing (${r.replace(/:/g, ", ")}).`],
  ["MISSING_STATEMENT", (r) => `A required statement is missing (${r}).`],
  ["REQUIRED_EVIDENCE_MISSING", (r) => `Required evidence is missing (${r}).`],
  ["EVIDENCE_NOT_VALID", (r) => `An evidence file is not valid (${r}).`],
  ["EVIDENCE_SUPERSEDED", (r) => `An evidence file was replaced by a newer one (${r}); save a new version.`],
  ["EVIDENCE_MISSING", (r) => `An evidence file is missing (${r}).`],
  ["DISCLOSURE_CHECKLIST_ABSENT", (r) => `The disclosure checklist has no entry for ${r}.`],
  ["DISCLOSURE_CHECKLIST_INCOMPLETE", (r) => `A required disclosure area is incomplete (${r}).`],
  ["MAPPING_UNREVIEWED", (r) => `Some accounts are not reviewed or are ambiguous (${r}).`],
  ["PRESENTATION_UNASSIGNED", (r) => `${r} account(s) are not on a presentation line.`],
  ["PRESENTATION_INCOMPATIBLE", (r) => `${r} account(s) are on an incompatible line.`],
  ["ACCOUNTS_NOT_PRESENTABLE", (r) => `${r} account(s) cannot be presented.`],
  ["NOTE_REQUIREMENT", (r) => `A note requirement is open (${r}).`],
  ["SCHEDULE", (r) => `A schedule is open (${r}).`],
  ["COMPARATIVE", (r) => `Comparatives: ${r.replace(/_/g, " ").toLowerCase()}.`],
];

export function blockerText(code: string): string {
  if (EXACT[code]) return EXACT[code];
  for (const [p, f] of PREFIX) if (code === p || code.startsWith(`${p}:`) || code.startsWith(`${p}_`)) return f(code.slice(p.length).replace(/^[:_]/, ""));
  return "The server reports a blocker.";
}
