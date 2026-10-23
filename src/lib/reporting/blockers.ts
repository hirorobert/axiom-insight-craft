// reporting/blockers.ts — one plain sentence per server sign-off blocker (fs_publication_blockers v2 and the
// dependencies' own blockers). Pure. The code is always shown beside it; an unknown code is shown as returned.

const EXACT: Readonly<Record<string, string>> = {
  SERVER_COMPILATION_REQUIRED: "Save this report to run its independent server check before approval.",
  SERVER_DOCUMENT_MISMATCH: "This saved report differs from the server-built report. Save a new version from the current records.",
  SERVER_COMPILATION_STALE: "The records changed after the server check. Save a new version before approval.",
  SERVER_COMPILATION_FINDINGS: "The server found unresolved problems in the report. Correct the source records and save a new version.",
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
  CLOSE_REVIEW_FINDINGS_NOT_CHECKED: "Close Review has not been checked for this trial balance. Open Close Review › Findings and run the check.",
  // 20261111100000 — the publication controls.
  FRAMEWORK_EDITION_UNRECORDED: "The version does not record the edition it applies.",
  CASHFLOW_OPENING_CASH_CONFLICT: "Two authorities state different opening cash; nothing is chosen between them.",
  CASH_PERIMETER_NOT_ESTABLISHED: "The cash perimeter of the current period could not be established from the cash account map.",
  // 20261118100000 — sign-off on the current rules.
  TRIAL_BALANCE_RULES_UNAVAILABLE: "Whether the trial balance was checked under the current rules could not be read. Try again.",
};

const PREFIX: readonly (readonly [string, (rest: string) => string])[] = [
  // 20261118100000 — the trial balance in force predates the current checks (engine generation <rest>).
  ["TRIAL_BALANCE_RECHECK_REQUIRED", () => "The trial balance in force for this period was checked before the current checks. Check it again on the Trial balance page (\"Check again under the current checks\"), then save a new version. Statements already signed and packs already issued are unchanged."],
  // 20261112100000 — the reviewer workflow.
  // 20261115100000 — the account capacity (fs_account_capacity): <total>/<bound>.
  ["ACCOUNT_CAPACITY_EXCEEDED", (r) => { const [total, bound] = r.split("/"); return `The statements would read ${Number(total).toLocaleString("en-US")} accounts across the current and comparative trial balances; this release supports up to ${Number(bound).toLocaleString("en-US")}. Saved versions and issued packs stay available; every account keeps its identity - nothing is merged to fit. Statements for a chart of this size are not available in this release.`; }],
  ["REVIEW_COMMENT_UNRESOLVED", (r) => `A reviewer's blocking finding is not resolved for this version (comment ${r.slice(0, 8)}…). The preparer responds and the reviewer resolves it on the Sign-off page.`],
  // 20261111100000 — the publication controls.
  ["PUBLICATION_PATH_UNSUPPORTED", (r) => `Only an IFRS for SMEs report derived from the authoritative trial balance can be reviewed or finalised (${r.replace(/:/g, " / ")}).`],
  ["FRAMEWORK_EDITION_UNSUPPORTED", (r) => `Only the IFRS for SMEs 2015 edition can be reviewed or finalised in this release; this period resolves to ${r}.`],
  ["COMPARATIVE_NOT_AS_ISSUED", (r) => `A comparative figure, as reported, differs from the prior year's issued statements (${r.replace(/:(-?\d+|not_issued|not_presented)$/, ", difference $1")}). A reviewer accepts explained differences on the Comparatives page, or the prior year is re-issued.`],
  ["FRAMEWORK_EDITION_MISMATCH", (r) => `The version records an edition the server does not resolve for this period (${r.replace(/:/g, " vs ")}). Save a new version.`],
  ["EVIDENCE_SERIES_AMBIGUOUS", (r) => `Two usable evidence series exist for one family and period (${r.replace(/:/g, " ")}); withdraw one.`],
  ["EVIDENCE_DENOMINATION_MISMATCH", (r) => `An evidence file is stated in another currency or scale than the statements (${r.replace(/:/g, " ")}); re-state it.`],
  ["EVIDENCE_NOT_BOUND", (r) => `A figure rests on evidence this version is not bound to (${r.replace(/:/g, " ")}). Save a new version.`],
  ["EVIDENCE_STATEMENTS_UNAVAILABLE", (r) => `The server could not compose the cash-flow and equity statements (${r}).`],
  ["CASHFLOW_CLOSING_CASH_TIE", (r) => `Closing cash does not equal the statement of financial position's cash perimeter (${r.replace(/:/g, ", difference ")} minor units).`],
  ["CASHFLOW_OPENING_NOT_PRIOR_CLOSING", (r) => `Opening cash does not equal the comparative period's closing cash (difference ${r} minor units).`],
  ["CASHFLOW_ACCOUNT_ROLLFORWARD", (r) => `The ledger movement of a cash account differs from its trial-balance movement (account ${r.replace(/:/g, ", difference ")} minor units).`],
  ["CASHFLOW_ROLLFORWARD_BALANCE_MISSING", (r) => `A cash account has no balance in one of the two statements of financial position, so its ledger movement cannot be checked (${r}).`],
  ["CASHFLOW_LEDGER_ACCOUNT_NOT_CASH", (r) => `A ledger row names an account the cash review did not establish as cash (${r}).`],
  ["CASH_ACCOUNT_UNMAPPED", (r) => `An account reviewed as cash has no category in the cash account map (${r}).`],
  ["CASH_ACCOUNT_NOT_IN_TRIAL_BALANCE", (r) => `A mapped cash account is not in a presented period's trial balance, or has a balance but no statement line (${r}).`],
  ["CASH_PERIMETER_BALANCE_MISSING", (r) => `A mapped cash account has no figure in the current period (${r}).`],
  ["SOCIE_OPENING_MISSING", (r) => `No opening balance was supplied for an equity component (${r}); opening equity is never inferred.`],
  ["SOCIE_COMPONENT_DOES_NOT_CAST", (r) => `A stated closing equity balance does not equal opening plus movements (${r.replace(/:/g, ", ")} minor units).`],
  ["SOCIE_CLOSING_EQUITY_TIE", (r) => `Total closing equity does not equal the statement of financial position's total equity (${r.replace(/:/g, ", difference ")} minor units).`],
  ["SOCIE_PROFIT_TIE", (r) => `The result recognised in equity does not equal profit or loss (${r.replace(/:/g, ", difference ")} minor units).`],
  ["SOCIE_OPENING_NOT_PRIOR_CLOSING", (r) => `An equity component's opening balance does not equal its comparative closing balance (${r.replace(/:/g, ", difference ")} minor units).`],
  ["REQUIRED_DISCLOSURE_MISSING", (r) => `A required disclosure has no recorded wording (${r}).`],
  ["STATEMENT_EVIDENCE_MISSING", (r) => `The evidence a statement is generated from is missing (${r}).`],
  ["STATEMENT_INCOMPLETE", (r) => `A composed statement is incomplete (${r}).`],
  ["CLOSE_REVIEW_BLOCKING_FINDINGS", (r) => `${r} blocking Close Review finding(s) are unresolved. Resolve them in Close Review › Findings.`],
  ["CLOSE_REVIEW_ADJUSTMENTS_UNDECIDED", (r) => `${r} Close Review adjustment(s) await a decision.`],
  ["CLOSE_REVIEW_ADJUSTMENTS_REQUIRE_REVALIDATION", (r) => `${r} approved adjustment(s) need revalidation after a re-check.`],
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
