// financialStatementsWorkspace/frameworkProfiles.ts — explicit presentation
// profiles, one per reporting framework. Components and composition logic
// read a profile; nothing framework-specific is hard-coded anywhere else,
// and terminology from one framework is never used for another.
//
// A profile states WHAT the framework expects and WHICH capability this
// workspace can honestly serve. It does not compute or assert accounting
// results. References are to the standards' own structure (not paraphrased
// requirements text) so a reviewer can locate the authority.

import type { ReportingFrameworkKind, StatementType } from "@/lib/canonicalStatement/types";

/** Statements a framework may expect. BUDGET_VS_ACTUAL has no canonical StatementType; it is a workspace-level kind only. */
export type WorkspaceStatementKind = StatementType | "BUDGET_VS_ACTUAL";

export type StatementRequirement = "REQUIRED" | "CONDITIONAL";

export interface ExpectedStatement {
  readonly kind: WorkspaceStatementKind;
  readonly requirement: StatementRequirement;
  readonly title: string;
  readonly reference: string;
  /** For CONDITIONAL statements: the condition that makes it applicable. */
  readonly condition?: string;
}

export interface DisclosureArea {
  readonly id: string;
  readonly label: string;
  readonly reference: string;
}

export interface FrameworkTerminology {
  readonly netResult: string;
  readonly equity: string;
  readonly totalEquity: string;
  readonly totalLiabilitiesAndEquity: string;
  readonly currentPeriodLabel: string;
}

export type TrialBalanceCapability =
  | { readonly status: "SUPPORTED" }
  | {
      readonly status: "UNSUPPORTED";
      /** Precise boundary — why a reviewed trial balance cannot produce this framework's primary statements. */
      readonly reason: string;
      readonly evidenceRequirements: readonly string[];
    };

export interface FrameworkProfile {
  readonly kind: ReportingFrameworkKind;
  readonly dbValue: "full_ifrs" | "ifrs_for_smes" | "ipsas_accrual" | "ipsas_cash";
  readonly displayName: string;
  readonly basis: "ACCRUAL" | "CASH";
  readonly terminology: FrameworkTerminology;
  readonly statementTitles: Readonly<Partial<Record<StatementType, string>>>;
  readonly expectedStatements: readonly ExpectedStatement[];
  readonly disclosureAreas: readonly DisclosureArea[];
  readonly comparativesRequired: boolean;
  readonly comparativesReference: string;
  readonly trialBalance: TrialBalanceCapability;
}

const IFRS_TERMS: FrameworkTerminology = {
  netResult: "Profit/(loss) for the year",
  equity: "Equity",
  totalEquity: "Total equity",
  totalLiabilitiesAndEquity: "Total equity and liabilities",
  currentPeriodLabel: "Current year",
};

const OCI_CONDITION = "Applies only where the entity has other comprehensive income items; account mappings carry no OCI classification, so this cannot be determined from the trial balance.";

const FULL_IFRS: FrameworkProfile = {
  kind: "IFRS",
  dbValue: "full_ifrs",
  displayName: "IFRS",
  basis: "ACCRUAL",
  terminology: IFRS_TERMS,
  statementTitles: {
    STATEMENT_OF_FINANCIAL_POSITION: "Statement of Financial Position",
    STATEMENT_OF_PROFIT_OR_LOSS: "Statement of Profit or Loss",
    STATEMENT_OF_COMPREHENSIVE_INCOME: "Statement of Profit or Loss and Other Comprehensive Income",
    STATEMENT_OF_CHANGES_IN_EQUITY: "Statement of Changes in Equity",
    STATEMENT_OF_CASH_FLOWS: "Statement of Cash Flows",
  },
  expectedStatements: [
    { kind: "STATEMENT_OF_FINANCIAL_POSITION", requirement: "REQUIRED", title: "Statement of Financial Position", reference: "IAS 1.10(a)" },
    { kind: "STATEMENT_OF_PROFIT_OR_LOSS", requirement: "REQUIRED", title: "Statement of Profit or Loss", reference: "IAS 1.10(b)" },
    { kind: "STATEMENT_OF_COMPREHENSIVE_INCOME", requirement: "CONDITIONAL", title: "Statement of Other Comprehensive Income", reference: "IAS 1.10A", condition: OCI_CONDITION },
    { kind: "STATEMENT_OF_CHANGES_IN_EQUITY", requirement: "REQUIRED", title: "Statement of Changes in Equity", reference: "IAS 1.10(c)" },
    { kind: "STATEMENT_OF_CASH_FLOWS", requirement: "REQUIRED", title: "Statement of Cash Flows", reference: "IAS 1.10(d), IAS 7" },
  ],
  disclosureAreas: [
    { id: "basis-of-preparation", label: "Basis of preparation and statement of compliance", reference: "IAS 1.16, 1.112(a)" },
    { id: "accounting-policies", label: "Material accounting policy information", reference: "IAS 1.117" },
    { id: "supporting-notes", label: "Notes supporting line items on the face of the statements", reference: "IAS 1.113" },
  ],
  comparativesRequired: true,
  comparativesReference: "IAS 1.38",
  trialBalance: { status: "SUPPORTED" },
};

const IFRS_FOR_SMES: FrameworkProfile = {
  kind: "IFRS_FOR_SMES",
  dbValue: "ifrs_for_smes",
  displayName: "IFRS for SMEs",
  basis: "ACCRUAL",
  terminology: { ...IFRS_TERMS, netResult: "Profit or loss for the year" },
  statementTitles: {
    STATEMENT_OF_FINANCIAL_POSITION: "Statement of Financial Position",
    STATEMENT_OF_PROFIT_OR_LOSS: "Statement of Comprehensive Income",
    STATEMENT_OF_COMPREHENSIVE_INCOME: "Statement of Comprehensive Income",
    STATEMENT_OF_CHANGES_IN_EQUITY: "Statement of Changes in Equity",
    STATEMENT_OF_CASH_FLOWS: "Statement of Cash Flows",
  },
  expectedStatements: [
    { kind: "STATEMENT_OF_FINANCIAL_POSITION", requirement: "REQUIRED", title: "Statement of Financial Position", reference: "IFRS for SMEs 3.17(a), Section 4" },
    { kind: "STATEMENT_OF_PROFIT_OR_LOSS", requirement: "REQUIRED", title: "Statement of Comprehensive Income", reference: "IFRS for SMEs 3.17(b), Section 5" },
    { kind: "STATEMENT_OF_CHANGES_IN_EQUITY", requirement: "REQUIRED", title: "Statement of Changes in Equity", reference: "IFRS for SMEs 3.17(d), Section 6", condition: "May be replaced by a statement of income and retained earnings only where the Section 6 conditions are met." },
    { kind: "STATEMENT_OF_CASH_FLOWS", requirement: "REQUIRED", title: "Statement of Cash Flows", reference: "IFRS for SMEs 3.17(e), Section 7" },
  ],
  disclosureAreas: [
    { id: "basis-of-preparation", label: "Statement of compliance with the IFRS for SMEs", reference: "IFRS for SMEs 3.3" },
    { id: "accounting-policies", label: "Summary of significant accounting policies", reference: "IFRS for SMEs 8.5" },
    { id: "supporting-notes", label: "Notes supporting line items on the face of the statements", reference: "IFRS for SMEs 8.6" },
  ],
  comparativesRequired: true,
  comparativesReference: "IFRS for SMEs 3.14",
  trialBalance: { status: "SUPPORTED" },
};

const IPSAS_ACCRUAL: FrameworkProfile = {
  kind: "IPSAS_ACCRUAL",
  dbValue: "ipsas_accrual",
  displayName: "IPSAS (accrual basis)",
  basis: "ACCRUAL",
  terminology: {
    netResult: "Surplus/(deficit) for the period",
    equity: "Net assets/equity",
    totalEquity: "Total net assets/equity",
    totalLiabilitiesAndEquity: "Total liabilities and net assets/equity",
    currentPeriodLabel: "Current period",
  },
  statementTitles: {
    STATEMENT_OF_FINANCIAL_POSITION: "Statement of Financial Position",
    STATEMENT_OF_PROFIT_OR_LOSS: "Statement of Financial Performance",
    STATEMENT_OF_CHANGES_IN_EQUITY: "Statement of Changes in Net Assets/Equity",
    STATEMENT_OF_CASH_FLOWS: "Cash Flow Statement",
  },
  expectedStatements: [
    { kind: "STATEMENT_OF_FINANCIAL_POSITION", requirement: "REQUIRED", title: "Statement of Financial Position", reference: "IPSAS 1.21(a)" },
    { kind: "STATEMENT_OF_PROFIT_OR_LOSS", requirement: "REQUIRED", title: "Statement of Financial Performance", reference: "IPSAS 1.21(b)" },
    { kind: "STATEMENT_OF_CHANGES_IN_EQUITY", requirement: "REQUIRED", title: "Statement of Changes in Net Assets/Equity", reference: "IPSAS 1.21(c)" },
    { kind: "STATEMENT_OF_CASH_FLOWS", requirement: "REQUIRED", title: "Cash Flow Statement", reference: "IPSAS 1.21(d), IPSAS 2" },
    { kind: "BUDGET_VS_ACTUAL", requirement: "CONDITIONAL", title: "Statement of Comparison of Budget and Actual Amounts", reference: "IPSAS 1.21(e), IPSAS 24", condition: "Applies where the entity makes its approved budget publicly available." },
  ],
  disclosureAreas: [
    { id: "basis-of-preparation", label: "Statement of compliance with IPSAS and basis of preparation", reference: "IPSAS 1.28, 1.132" },
    { id: "accounting-policies", label: "Significant accounting policies", reference: "IPSAS 1.132" },
    { id: "supporting-notes", label: "Notes supporting line items on the face of the statements", reference: "IPSAS 1.127" },
  ],
  comparativesRequired: true,
  comparativesReference: "IPSAS 1.53",
  trialBalance: { status: "SUPPORTED" },
};

const IPSAS_CASH: FrameworkProfile = {
  kind: "IPSAS_CASH",
  dbValue: "ipsas_cash",
  displayName: "IPSAS (cash basis)",
  basis: "CASH",
  terminology: {
    netResult: "Net cash receipts less payments",
    equity: "Net assets/equity",
    totalEquity: "Total net assets/equity",
    totalLiabilitiesAndEquity: "Total liabilities and net assets/equity",
    currentPeriodLabel: "Current period",
  },
  statementTitles: {
    STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS: "Statement of Cash Receipts and Payments",
  },
  expectedStatements: [
    { kind: "STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS", requirement: "REQUIRED", title: "Statement of Cash Receipts and Payments", reference: "IPSAS Financial Reporting Under the Cash Basis of Accounting, Part 1" },
    { kind: "BUDGET_VS_ACTUAL", requirement: "CONDITIONAL", title: "Comparison of Budget and Actual Amounts", reference: "IPSAS Cash Basis, Part 1", condition: "Applies where the entity makes its approved budget publicly available." },
  ],
  disclosureAreas: [
    { id: "basis-of-preparation", label: "Statement of compliance with the IPSAS cash basis and basis of preparation", reference: "IPSAS Cash Basis, Part 1" },
    { id: "accounting-policies", label: "Accounting policies", reference: "IPSAS Cash Basis, Part 1" },
    { id: "supporting-notes", label: "Explanatory notes", reference: "IPSAS Cash Basis, Part 1" },
  ],
  comparativesRequired: true,
  comparativesReference: "IPSAS Cash Basis, Part 1",
  trialBalance: {
    status: "UNSUPPORTED",
    reason:
      "A cash-basis primary statement reports cash actually received and paid, classified by nature, with the opening and closing cash balances. A reviewed accrual-style trial balance carries neither a classified cash-movement record nor an opening cash position, and presenting its revenue/expense balances as cash receipts and payments would misstate the statement. No accrual statement is shown in its place.",
    evidenceRequirements: [
      "A period-complete record of cash receipts and cash payments, classified by nature (e.g. taxes, grants, salaries, supplies).",
      "The opening cash and cash-equivalent balance for the period, agreed to the prior period's closing balance.",
      "Confirmation of which accounts form the cash perimeter (reviewed cash-account flags).",
      "The prior-period cash receipts and payments for the comparative column.",
    ],
  },
};

export const FRAMEWORK_PROFILES: Readonly<Record<ReportingFrameworkKind, FrameworkProfile>> = {
  IFRS: FULL_IFRS,
  IFRS_FOR_SMES: IFRS_FOR_SMES,
  IPSAS_ACCRUAL: IPSAS_ACCRUAL,
  IPSAS_CASH: IPSAS_CASH,
};

export function profileForKind(kind: ReportingFrameworkKind): FrameworkProfile {
  return FRAMEWORK_PROFILES[kind];
}

/** Resolves a raw companies.reporting_framework value; null/unknown returns null — never a default framework. */
export function profileForDbValue(dbValue: string | null | undefined): FrameworkProfile | null {
  return Object.values(FRAMEWORK_PROFILES).find((p) => p.dbValue === dbValue) ?? null;
}

/** Title for a canonical statement type under a profile; falls back to the statement's own title, never another framework's wording. */
export function statementTitle(profile: FrameworkProfile, type: StatementType, fallback: string): string {
  return profile.statementTitles[type] ?? fallback;
}
