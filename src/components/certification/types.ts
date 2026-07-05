// Shared read-only types for the Certification Console.
// snake_case reads only — mirrors the engine payload.

export interface StatementAccount {
  account_code?: string;
  account_name: string;
  balance?: number;
}

export interface StatementSection {
  accounts: StatementAccount[];
  total: number;
}

export interface Statements {
  balance_sheet?: Record<string, StatementSection>;
  income_statement?: Record<string, StatementSection>;
  cash_flow?: Record<string, StatementSection> | null;
}

export interface TbBalanceCheck {
  passed: boolean;
  total_debits: number;
  total_credits: number;
  difference: number;
}

export interface BalanceSheetEquation {
  passed: boolean;
  assets: number;
  liabilities: number;
  equity: number;
  difference: number;
  net_income?: number;
  closing_equity?: number;
}

export interface ValidationReport {
  tb_balance_check?: TbBalanceCheck;
  balance_sheet_equation?: BalanceSheetEquation | null;
  mapping_completeness?: {
    total_accounts?: number;
    mapped_accounts?: number;
    auto_classified?: number;
  };
}

export interface ProcessingResult {
  status?: "valid" | "invalid" | "blocked" | "needs_review";
  statements?: Statements | null;
  validation_report?: ValidationReport;
  needs_review_accounts?: unknown[];
  summary?: {
    total_accounts?: number;
    processed_at?: string;
    auto_classified?: number;
  };
}

export interface CertUpload {
  id: string;
  file_name: string;
  uploaded_at: string;
  processed_at: string | null;
  status: string;
  is_valid: boolean | null;
  company_name: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processing_result: any;
}

// Number formatter with tabular numerals.
export const fmtNum = (n: number | undefined | null, digits = 0): string | null => {
  if (n === undefined || n === null || Number.isNaN(n)) return null;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

export const fmtDateTime = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};