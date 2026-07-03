// ============================================================
// Axiom — process-trial-balance Edge Function
// Version: v2.2 — BS Equation includes current-year net income (closing equity)
// Date: 2026-06-27
//
// CHANGES FROM v1.0:
//   1. XLSX support (SheetJS) — not just CSV
//   2. Generic column detection — auto-detects debit/credit/balance columns
//      from any header row without hardcoded column positions
//   3. Auto-classification — unmapped accounts classified by name pattern
//      matching before the mapping completeness check runs.
//      Reduces BLOCK rate to near-zero for standard naming conventions.
//   4. processing_result structure aligned with kinga-findings-engine:
//      BEFORE: pr.mapping.incomeStatement.operatingExpenses (array)
//      NOW:    pr.statements.income_statement.operating_expenses.accounts + .total
//      This was a critical misalignment — every real upload was unreadable
//      by the findings engine. The engine only worked on manually seeded data.
//   5. is_auto_classified flag saved to account_mappings for all auto-detected
//      accounts so the preparer can review and correct if needed.
// ============================================================

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX        from "https://esm.sh/xlsx@0.18.5";
import {
  isAuditedAccountsFormat,
  parseAuditedAccounts,
  getAuditedAccountsMetadata,
} from "./auditedAccountsAdapter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Interfaces ────────────────────────────────────────────────────────────────

interface RawAccount {
  account_code:      string;
  account_name:      string;
  debit:             number;
  credit:            number;
  balance:           number;
  source_row_number: number; // raw file row index (1-based from header_row + 1)
}

interface AccountMapping {
  account_code:       string;
  account_name:       string;
  statement:          string;
  classification:     string;
  line_item:          string;
  normal_balance:     string;
  is_cash_account:    boolean;
  is_retained_earnings: boolean;
  is_payroll_account: boolean;
}

interface ValidationError {
  code:      string;
  message:   string;
  field?:    string;
  expected?: string | number;
  actual?:   string | number;
}

// Engine-compatible section structure
interface StatementSection {
  accounts: RawAccount[];
  total:    number;
}

// Engine-compatible statements shape
interface Statements {
  balance_sheet:    Record<string, StatementSection>;
  income_statement: Record<string, StatementSection>;
  cash_flow:        Record<string, StatementSection> | null;
}

// Keyword dictionary row (fetched once per run)
interface KeywordRow {
  id:             string;
  term:           string;
  language:       string;
  classification: string;
  match_type:     "exact" | "contains";
}

// Account that could not be confidently classified
interface NeedsReviewAccount {
  account_code:              string;
  account_name:              string;
  debit:                     number;
  credit:                    number;
  balance:                   number;
  suggested_classification?: string;
  suggested_statement?:      string;
  confidence_source?:        string;
  reason:                    string;
}

type TieredClassifyResult =
  | { status: "classified"; mapping: AccountMapping; confidence: "high" | "medium"; confidence_source: "mapping" | "dictionary_exact" | "dictionary_contains" | "rule" }
  | { status: "needs_review"; suggested_classification?: string; suggested_statement?: string; confidence_source?: string; reason: string };

// Full processing_result (what engine reads)
interface ProcessingResult {
  status:                 "valid" | "invalid" | "blocked" | "needs_review";
  statements:             Statements | null;
  validation_report:      Record<string, unknown>;
  errors:                 ValidationError[];
  needs_review_accounts?: NeedsReviewAccount[];
  summary: {
    total_accounts:   number;
    processed_at:     string;
    parser_version:   string;
    columns_detected: Record<string, string>;
    auto_classified:  number;
  };
}

// ── Pattern libraries (mirrors kinga-findings-engine) ─────────────────────────

/** Column header matchers — strip, lowercase, then startsWith/includes core keyword.
 *  Covers common real-world variations: "Debit (TZS)", "Dr.", "Account No", etc. */
const COLUMN_MATCHERS: Record<string, (s: string) => boolean> = {
  account_code: (s) =>
    s === "code" ||
    s.startsWith("a/c") ||
    (s.startsWith("gl")      && s.includes("code")) ||
    (s.startsWith("ledger")  && s.includes("code")) ||
    (s.startsWith("acc")     && s.includes("code")) ||
    (s.startsWith("account") && (s.includes("code") || s.includes("number") || s.endsWith("no"))),
  account_name: (s) =>
    s === "name"        ||
    s === "description" ||
    s === "particulars" ||
    (s.startsWith("gl")      && s.includes("name")) ||
    (s.startsWith("ledger")  && s.includes("name")) ||
    (s.startsWith("account") && (s.includes("name") || s.includes("description") || s.includes("title"))),
  debit: (s) =>
    s.includes("debit") ||
    s.startsWith("dr"),
  credit: (s) =>
    s.includes("credit") ||
    s.startsWith("cr"),
  balance: (s) =>
    s.startsWith("amount")     ||
    s.startsWith("net amount") ||
    s.includes("balance"),
};

/** Accounts that represent total/subtotal rows — stripped during parsing */
const SUBTOTAL_ROW_PATTERNS = [
  /^total/i, /^sub[- ]?total/i, /^grand[- ]?total/i, /^sum/i,
  /total$/i, /^net\s+(assets|liabilities|equity|income|profit)/i,
];

/** Auto-classification patterns — name → { statement, classification, normal_balance } */
interface AutoClass { statement: string; classification: string; normal_balance: "debit"|"credit"; line_item: string; is_payroll?: boolean; is_retained?: boolean; is_cash?: boolean; }

const AUTO_CLASSIFICATION_RULES: Array<{ patterns: RegExp[]; result: AutoClass }> = [
  // ── INCOME STATEMENT — Revenue ─────────────────────────────────────────────
  { patterns: [/\brevenue\b/i, /\bsale[s]?\b/i, /\bincome(?!\s+tax)\b/i, /\bmapato\b/i, /\bturnover\b/i],
    result: { statement: "income_statement", classification: "revenue", normal_balance: "credit", line_item: "Revenue" }},

  // ── INCOME STATEMENT — Cost of Goods Sold ──────────────────────────────────
  // Must come BEFORE operating_expenses so "cost of sales" routes to cogs not opex
  { patterns: [/\bcost\s+of\s+(?:goods\s+)?sold\b/i, /\bcost\s+of\s+sales\b/i, /\bcost\s+of\s+revenue\b/i, /\bcogs\b/i, /\bdirect\s+cost[s]?\b/i, /\bghara\s+za\s+bidhaa\b/i],
    result: { statement: "income_statement", classification: "cost_of_goods_sold", normal_balance: "debit", line_item: "Cost of Sales" }},
  { patterns: [/\bpurchases?\s*(?:[-—–]|\s)\s*(?:drugs?|medic|goods|stock|supplies?)\b/i, /\bstock\s+purchases?\b/i],
    result: { statement: "income_statement", classification: "cost_of_goods_sold", normal_balance: "debit", line_item: "Purchases" }},
  { patterns: [/\bopening\s+(?:stock|inventor[yi])\b/i],
    result: { statement: "income_statement", classification: "cost_of_goods_sold", normal_balance: "debit", line_item: "Opening Stock" }},
  { patterns: [/\bclosing\s+(?:stock|inventor[yi])\b/i, /\bless[:\s]+closing\b/i],
    result: { statement: "income_statement", classification: "cost_of_goods_sold", normal_balance: "credit", line_item: "Less: Closing Stock" }},

  // ── INCOME STATEMENT — Tax Charge (P&L below PBT line) ─────────────────────
  // Must come BEFORE the BS income-tax-payable rule to avoid misclassification
  { patterns: [/\bincome\s+tax\s+(?:charge|provision|expense)\b/i, /\bcorporate\s+(?:income\s+)?tax\s+(?:charge|provision|expense)\b/i, /\bcit\s+(?:charge|provision|expense)\b/i, /\btax\s+(?:charge|provision|expense)\b/i],
    result: { statement: "income_statement", classification: "taxes", normal_balance: "debit", line_item: "Income Tax Charge" }},

  // ── INCOME STATEMENT — Operating Expenses (PAYROLL) ────────────────────────
  { patterns: [/\bsalar[yi]/i, /\bwage[s]?\b/i, /\bmishahara\b/i, /\bbasic[_\s]pay\b/i, /\bremuneration\b/i, /\bstaff[_\s]cost[s]?\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Staff Costs", is_payroll: true }},

  { patterns: [/\ballowance[s]?\b/i, /\bposho\b/i, /\bstipend\b/i, /\bovertim[e]?\b/i, /\bextra[_\s]duty\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Allowances & Overtime", is_payroll: true }},

  // ── INCOME STATEMENT — Operating Expenses (STATUTORY LEVIES — NOT payroll) ─
  { patterns: [/\bnhif\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "NHIF Employer Contribution" }},
  { patterns: [/\bnssf\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "NSSF Employer Contribution" }},
  { patterns: [/\bwcf\b/i, /\bworkers?[_\s]comp/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "WCF" }},
  { patterns: [/\bsdl\b.*expense/i, /\bskill[s]?\s+develop/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "SDL Expense" }},
  { patterns: [/\bpaye\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "PAYE" }},

  // ── INCOME STATEMENT — Operating Expenses (GENERAL) ───────────────────────
  { patterns: [/\brent\b/i, /\boffice[_\s]rent\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Rent" }},
  { patterns: [/\belectric/i, /\butility\b/i, /\butilities\b/i, /\bpower\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Utilities" }},
  { patterns: [/\bfuel\b/i, /\boil\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Fuel & Oil" }},
  { patterns: [/\bsecurity\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Security" }},
  { patterns: [/\bdepreciation\b/i, /\bamortis/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Depreciation & Amortisation" }},
  { patterns: [/\brepair[s]?\b/i, /\bmaintenance\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Repairs & Maintenance" }},
  { patterns: [/\btraining\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Staff Training" }},
  { patterns: [/\bwelfare\b/i, /\btea\b/i, /\bwater\b/i, /\buniform[s]?\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Staff Welfare" }},
  { patterns: [/\badmin(?:istrat\w+)?\s+(?:exp|cost)/i, /\bgeneral\s+(?:exp|admin)/i, /\bexpenditure\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Administrative Expenses" }},
  { patterns: [/\bfinance\s+(?:exp|cost|charge)/i, /\binterest\s+(?:exp|charge)/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Finance Expenses" }},
  // ── Additional finance expense patterns ────────────────────────────────────
  { patterns: [/\binterest\s+(?:on|paid|expense)?\s*(?:loan|borrow|overdraft|debt)\b/i, /\bloan\s+interest\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Finance Expenses" }},
  { patterns: [/\bbank\s+charge[s]?\b/i, /\bbank\s+fee[s]?\b/i, /\bborrowing\s+cost[s]?\b/i, /\bloan\s+(?:fee[s]?|charge[s]?|cost[s]?|documentation)\b/i, /\bdocumentation\s+fee[s]?\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Finance Expenses" }},
  // ── Insurance ──────────────────────────────────────────────────────────────
  { patterns: [/\binsurance\b/i, /\bpremium[s]?\s+(?:exp|paid|charge)\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Insurance" }},
  // ── Entertainment / Meetings ────────────────────────────────────────────────
  { patterns: [/\bentertain(?:ment)?\b/i, /\bmeeting[s]?\b/i, /\bhospitality\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Entertainment & Meetings" }},
  // ── Office Supplies / Stationery ────────────────────────────────────────────
  { patterns: [/\bstation[e]?r/i, /\boffice\s+suppli\b/i, /\bprinting\b/i, /\bstamp[s]?\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Office Supplies & Stationery" }},
  // ── Telephone / Communication ────────────────────────────────────────────────
  { patterns: [/\btelephon[e]?\b/i, /\binternet\b/i, /\bpostage\b/i, /\bcommunication\b/i, /\bdata\s+(?:plan|bundle|cost)\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Telephone & Communication" }},
  // ── Travel & Transport ────────────────────────────────────────────────────────
  { patterns: [/\btravel(?:ling|ing)?\b/i, /\btransport\b/i, /\bvehicle\s+(?:hire|rental)\b/i, /\bairfare\b/i, /\baccommodation\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Travel & Transport" }},
  // ── Cleaning / Sanitation ────────────────────────────────────────────────────
  { patterns: [/\bclean(?:ing)?\b/i, /\bgarden(?:ing)?\b/i, /\bsanit(?:ation|ary)\b/i, /\bwaste\s+(?:management|disposal)\b/i, /\bfumigat/i, /\bpest\s+control\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Cleaning & Sanitation" }},
  // ── Service Levy (P&L expense — MUST come before BS service levy payable rule)
  { patterns: [/\bservice\s+levy\b/i, /\bmunicipal\s+(?:levy|tax)\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Service Levy" }},
  // ── Professional & Legal Fees ────────────────────────────────────────────────
  { patterns: [/\baudit\s+fee[s]?\b/i, /\baccounting\s+fee[s]?\b/i, /\blegal\s+fee[s]?\b/i, /\bprofessional\s+fee[s]?\b/i, /\bconsulting\s+fee[s]?\b/i, /\bbrela\b/i, /\bvaluation\b/i, /\bsurvey\b/i, /\binspection\s+fee[s]?\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Professional & Legal Fees" }},
  // ── Licences & Permits ───────────────────────────────────────────────────────
  { patterns: [/\blicen[sc]e[s]?\b/i, /\bpermit[s]?\b/i, /\bregistration\s+fee[s]?\b/i, /\bmembership\s+fee[s]?\b/i, /\bregistration\b/i, /\bmembership\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Licences & Permits" }},
  // ── Safety & Maintenance (catch-all for specialist opex) ─────────────────────
  { patterns: [/\bfire\s+extinguisher\b/i, /\bsafety\b/i, /\bstock[_\s]?tak(?:ing)?\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Safety & Administration" }},
  // ── Hospital / Clinical Direct Expenses (sector-specific) ────────────────────
  { patterns: [/\bpatient[s]?\s+(?:meal|food|refund|invest)/i, /\bhiring\s+cost\b/i, /\bambulance\b/i, /\bclinical\b/i, /\bhospital\s+system\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Hospital Direct Expenses" }},
  // ── Miscellaneous / Unallocated ──────────────────────────────────────────────
  { patterns: [/\bunallocated\b/i, /\bmiscellaneous\b/i, /\bsundry\b/i, /\bcontract\s+renewal\b/i, /\bother\s+(?:admin|operating)\s+exp/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Miscellaneous Expenses" }},

  // ── BALANCE SHEET — Current Assets ────────────────────────────────────────
  { patterns: [/\bcash\b/i, /\bbank\b/i, /\bpetty[_\s]cash\b/i, /\bfedha\b/i],
    result: { statement: "balance_sheet", classification: "current_assets", normal_balance: "debit", line_item: "Cash & Bank", is_cash: true }},
  { patterns: [/\baccounts?\s+receivable\b/i, /\btrade\s+(?:receivable[s]?|debtor[s]?)\b/i, /\bdebtor[s]?\b/i, /\breceivable[s]?\b/i, /\bwadai\b/i],
    result: { statement: "balance_sheet", classification: "current_assets", normal_balance: "debit", line_item: "Trade Receivables" }},
  { patterns: [/\binventor[yi]/i, /\bstock\b/i, /\bgoods\b/i],
    result: { statement: "balance_sheet", classification: "current_assets", normal_balance: "debit", line_item: "Inventories" }},
  { patterns: [/\bprepay/i, /\bdeposit[s]?\b/i, /\badvance[s]?\b/i],
    result: { statement: "balance_sheet", classification: "current_assets", normal_balance: "debit", line_item: "Prepayments & Deposits" }},
  { patterns: [/\bvat\s+receivable\b/i, /\btax\s+refund\b/i, /\btax\s+receivable\b/i],
    result: { statement: "balance_sheet", classification: "current_assets", normal_balance: "debit", line_item: "Tax Receivables" }},

  // ── BALANCE SHEET — Non-Current Assets ────────────────────────────────────
  { patterns: [/\bproperty\b/i, /\bplant\b/i, /\bequipment\b/i, /\bfurniture\b/i, /\bfixture[s]?\b/i, /\bmotor\s+vehicle\b/i, /\bvehicle[s]?\b/i, /\bland\b/i, /\bbuilding[s]?\b/i, /\bwater\s+well\b/i, /\bwork\s+in\s+progress\b/i, /\bwip\b/i, /\bcomputer[s]?\b/i],
    result: { statement: "balance_sheet", classification: "non_current_assets", normal_balance: "debit", line_item: "Property, Plant & Equipment" }},
  { patterns: [/\baccumulated\s+depreciation\b/i, /\bacc\s+depr/i],
    result: { statement: "balance_sheet", classification: "non_current_assets", normal_balance: "credit", line_item: "Accumulated Depreciation" }},
  { patterns: [/\bintangible\b/i, /\bgoodwill\b/i, /\bsoftware\b/i, /\blicense[s]?\b/i],
    result: { statement: "balance_sheet", classification: "non_current_assets", normal_balance: "debit", line_item: "Intangible Assets" }},

  // ── BALANCE SHEET — Current Liabilities ───────────────────────────────────
  { patterns: [/\baccounts?\s+payable\b/i, /\btrade\s+(?:payable[s]?|creditor[s]?)\b/i, /\bcreditor[s]?\b/i, /\bwadaiwa\b/i],
    result: { statement: "balance_sheet", classification: "current_liabilities", normal_balance: "credit", line_item: "Trade Payables" }},
  { patterns: [/\bvat\s+payable\b/i, /\bvat\s+(?:outstand|due)\b/i],
    result: { statement: "balance_sheet", classification: "current_liabilities", normal_balance: "credit", line_item: "VAT Payable" }},
  { patterns: [/\bnssf\s+(?:payable|outstand|due|arrear)/i],
    result: { statement: "balance_sheet", classification: "current_liabilities", normal_balance: "credit", line_item: "NSSF Payable" }},
  { patterns: [/\bnhif\s+(?:payable|outstand|due|arrear)/i],
    result: { statement: "balance_sheet", classification: "current_liabilities", normal_balance: "credit", line_item: "NHIF Payable" }},
  { patterns: [/\bwcf\s+(?:payable|outstand|due|arrear)/i],
    result: { statement: "balance_sheet", classification: "current_liabilities", normal_balance: "credit", line_item: "WCF Payable" }},
  { patterns: [/\bsdl\s+(?:payable|outstand|due|arrear)/i],
    result: { statement: "balance_sheet", classification: "current_liabilities", normal_balance: "credit", line_item: "SDL Payable" }},
  { patterns: [/\bpaye\s+(?:payable|outstand|due|arrear)/i],
    result: { statement: "balance_sheet", classification: "current_liabilities", normal_balance: "credit", line_item: "PAYE Payable" }},
  { patterns: [/\bservice\s+levy/i],
    result: { statement: "balance_sheet", classification: "current_liabilities", normal_balance: "credit", line_item: "Service Levy Payable" }},
  { patterns: [/\btra\s+(?:assess|payable|due)/i, /\btax\s+(?:assess|due|payable)\b/i, /\bcorporate\s+tax\b/i, /\bincome\s+tax\s+payable\b/i],
    result: { statement: "balance_sheet", classification: "current_liabilities", normal_balance: "credit", line_item: "Tax Payable" }},
  { patterns: [/\baccrued\b/i, /\bdeferred\b/i],
    result: { statement: "balance_sheet", classification: "current_liabilities", normal_balance: "credit", line_item: "Accruals & Deferrals" }},
  { patterns: [/\bcurrent\s+portion\b/i, /\bshort[_-]term\s+loan\b/i, /\boverdraft\b/i],
    result: { statement: "balance_sheet", classification: "current_liabilities", normal_balance: "credit", line_item: "Short-term Borrowings" }},

  // ── BALANCE SHEET — Non-Current Liabilities ────────────────────────────────
  { patterns: [
      /\blong[_\s-]?term\s+(?:bank\s+)?loan[s]?\b/i,   // "long term bank loan"
      /\bterm\s+loan\b/i,                                  // "term loan"
      /\bmortgage\b/i,
      /\bbond[s]?\s+(?:payable|issued)\b/i,
      /\bdebenture[s]?\b/i,
    ],
    result: { statement: "balance_sheet", classification: "non_current_liabilities", normal_balance: "credit", line_item: "Long-term Borrowings" }},

  // ── BALANCE SHEET — Equity ─────────────────────────────────────────────────
  { patterns: [/\bshare\s+capital\b/i, /\bpaid[_-]?up\s+capital\b/i, /\bordinary\s+share[s]?\b/i, /\bmtaji\b/i],
    result: { statement: "balance_sheet", classification: "equity", normal_balance: "credit", line_item: "Share Capital" }},
  { patterns: [/\bshare\s+premium\b/i],
    result: { statement: "balance_sheet", classification: "equity", normal_balance: "credit", line_item: "Share Premium" }},
  { patterns: [/\bretained\s+earning[s]?\b/i, /\baccumulated\s+(?:profit|surplus|deficit)\b/i, /\bprofit\s+b[/]?[fo]\b/i, /\bfaida\s+iliyobakiwa\b/i, /\bundistributed\s+(?:profit|earning)/i],
    result: { statement: "balance_sheet", classification: "equity", normal_balance: "credit", line_item: "Retained Earnings", is_retained: true }},
  { patterns: [/\bcurrent\s+year\s+(?:profit|income|surplus)\b/i, /\bnet\s+(?:profit|income|loss)\s+for\s+(?:the\s+)?year\b/i],
    result: { statement: "balance_sheet", classification: "equity", normal_balance: "credit", line_item: "Current Year Profit" }},
];

// ── Format Detection ──────────────────────────────────────────────────────────

function detectFormat(fileName: string): "xlsx" | "csv" | "unknown" {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (["xlsx", "xls", "xlsm", "xlsb"].includes(ext)) return "xlsx";
  if (["csv", "tsv", "txt"].includes(ext))            return "csv";
  return "unknown";
}

// ── Generic Column Detector ───────────────────────────────────────────────────

interface ColumnMap {
  account_code: number | null;
  account_name: number | null;
  debit:        number | null;
  credit:       number | null;
  balance:      number | null;
  header_row:   number;
}

function detectColumns(rows: (string | number | null)[][]): { map: ColumnMap; detected: Record<string, string> } {
  // Scan first 15 rows for a header-like row
  const scan = Math.min(rows.length, 15);
  let bestRow = 0;
  let bestScore = 0;

  for (let r = 0; r < scan; r++) {
    const row = rows[r];
    let score = 0;
    for (const cell of row) {
      const s = String(cell ?? "").trim().toLowerCase();
      for (const matcher of Object.values(COLUMN_MATCHERS)) {
        if (matcher(s)) { score++; break; }
      }
    }
    if (score > bestScore) { bestScore = score; bestRow = r; }
  }

  const headerRow = rows[bestRow];
  const map: ColumnMap = { account_code: null, account_name: null, debit: null, credit: null, balance: null, header_row: bestRow };
  const detected: Record<string, string> = {};

  for (let c = 0; c < headerRow.length; c++) {
    const cell = String(headerRow[c] ?? "").trim();
    const lower = cell.toLowerCase();
    for (const [key, matcher] of Object.entries(COLUMN_MATCHERS)) {
      if (map[key as keyof typeof map] === null && matcher(lower)) {
        (map as Record<string, number | null>)[key] = c;
        detected[key] = cell;
        break;
      }
    }
  }

  return { map, detected };
}

// ── Row-to-RawAccount parser ──────────────────────────────────────────────────

function isSubtotalRow(accountName: string, accountCode: string): boolean {
  return SUBTOTAL_ROW_PATTERNS.some(p => p.test(accountName) || p.test(accountCode));
}

function parseNumber(v: string | number | null): number {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v;
  return parseFloat(String(v).replace(/[,$\s]/g, "")) || 0;
}

function rowsToRawAccounts(
  rows: (string | number | null)[][],
  map: ColumnMap
): { accounts: RawAccount[]; errors: ValidationError[] } {
  const accounts: RawAccount[] = [];
  const errors: ValidationError[] = [];
  const dataStart = map.header_row + 1;

  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    const rawCode = String(row[map.account_code ?? -1] ?? "").trim();
    const name    = String(row[map.account_name ?? -1] ?? "").trim();

    // Skip blank rows and subtotal rows
    if (!rawCode && !name) continue;
    if (isSubtotalRow(name, rawCode)) continue;

    // Fall back to account_name as the key when no account_code column exists.
    // This handles CSVs/XLSXs that only have an account name column (e.g. trial
    // balance exports without GL codes, or reconstructed TBs from audited accounts).
    const code = rawCode || name;
    if (!code) continue;

    const debit  = parseNumber(map.debit   !== null ? row[map.debit]   : null);
    const credit = parseNumber(map.credit  !== null ? row[map.credit]  : null);

    let balance: number;
    if (map.balance !== null && row[map.balance] !== null && row[map.balance] !== "") {
      balance = parseNumber(row[map.balance]);
    } else {
      balance = debit - credit;
    }

    accounts.push({ account_code: code, account_name: name || code, debit, credit, balance, source_row_number: i });
  }

  return { accounts, errors };
}

// ── XLSX Parser ───────────────────────────────────────────────────────────────

function parseXLSX(buffer: ArrayBuffer): { rows: (string | number | null)[][]; sheetName: string } {
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array", cellDates: false });

  // Pick the sheet with the most data rows (usually the trial balance sheet)
  let bestSheet = wb.SheetNames[0];
  let bestCount = 0;

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1:A1");
    const count = range.e.r - range.s.r;
    if (count > bestCount) { bestCount = count; bestSheet = name; }
  }

  const ws  = wb.Sheets[bestSheet];
  const raw = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, { header: 1, defval: null, raw: true }) as (string | number | null)[][];
  return { rows: raw, sheetName: bestSheet };
}

// ── CSV Parser ────────────────────────────────────────────────────────────────

function parseCSV(content: string): (string | number | null)[][] {
  const lines = content.split(/\r?\n/);
  return lines.map(line => {
    // Handle quoted fields
    const result: (string | number | null)[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === "," && !inQuotes) {
        result.push(current.trim() || null);
        current = "";
      } else {
        current += ch;
      }
    }
    result.push(current.trim() || null);
    return result;
  }).filter(row => row.some(cell => cell !== null && cell !== ""));
}

// ── Auto-Classification ───────────────────────────────────────────────────────

interface ClassificationResult extends AutoClass {
  confidence: "high" | "medium";
}

function autoClassifyAccount(name: string): ClassificationResult | null {
  const normalized = name.trim();
  for (const rule of AUTO_CLASSIFICATION_RULES) {
    if (rule.patterns.some(p => p.test(normalized))) {
      return { ...rule.result, confidence: "high" };
    }
  }
  return null;
}

// ── Stable per-row map key ────────────────────────────────────────────────────
// account_code is always non-empty in the current parser (falls back to name on
// line 391: `const code = rawCode || name`), but two name-only rows can share
// the same derived code if their account names are identical.
// source_row_number guarantees uniqueness: used as key when code === name.
// ONE helper used by BOTH the write in STEP 6 and the read in aggregateStatements.

function accountKey(account: RawAccount): string {
  return account.account_code !== account.account_name
    ? account.account_code                // real GL code — safe to key directly
    : `row:${account.source_row_number}`; // name-derived code — disambiguate by row
}

// ── Account name normalisation ────────────────────────────────────────────────
// Mirrors SQL: lower(trim(regexp_replace(regexp_replace(name,'[[:punct:]]','','g'),'\s+',' ','g')))

function normalizeAccountName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, "")   // strip punctuation
    .replace(/\s+/g, " ")      // collapse whitespace
    .trim();
}

// ── Levenshtein distance (O(n) space) ─────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const row: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const curr = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = curr;
    }
  }
  return row[n];
}

// ── Fuzzy lookup over a normalised-name → AccountMapping map (distance ≤ 2) ───

function fuzzyMapLookup(
  normName: string,
  nameMap:  Map<string, AccountMapping>,
): AccountMapping | null {
  let best = 3; // must be strictly less than 3 (i.e., ≤ 2) to win
  let hit: AccountMapping | null = null;
  for (const [key, mapping] of nameMap) {
    const d = levenshtein(normName, key);
    if (d < best) { best = d; hit = mapping; }
  }
  return hit;
}

// ── Derive statement + normal_balance from classification ─────────────────────

function classificationMeta(cls: string): { statement: string; normal_balance: "debit" | "credit" } {
  const table: Record<string, { statement: string; normal_balance: "debit" | "credit" }> = {
    current_assets:          { statement: "balance_sheet",    normal_balance: "debit"  },
    non_current_assets:      { statement: "balance_sheet",    normal_balance: "debit"  },
    current_liabilities:     { statement: "balance_sheet",    normal_balance: "credit" },
    non_current_liabilities: { statement: "balance_sheet",    normal_balance: "credit" },
    equity:                  { statement: "balance_sheet",    normal_balance: "credit" },
    revenue:                 { statement: "income_statement", normal_balance: "credit" },
    cost_of_goods_sold:      { statement: "income_statement", normal_balance: "debit"  },
    operating_expenses:      { statement: "income_statement", normal_balance: "debit"  },
    other_income:            { statement: "income_statement", normal_balance: "credit" },
    taxes:                   { statement: "income_statement", normal_balance: "debit"  },
  };
  return table[cls] ?? { statement: "income_statement", normal_balance: "debit" };
}

// ── 6-tier account classifier ─────────────────────────────────────────────────
// Tier 1–3: account_mappings (company-scoped then global) — code exact, then name exact/fuzzy.
// Tier 4:   keyword_dictionary — exact → contains longest-match-wins → fuzzy (exact terms only).
// Tier 5:   AUTO_CLASSIFICATION_RULES regex (autoClassifyAccount, unchanged).
// Tier 6:   needs_review.
//
// All four maps and both kwd arrays are fetched once before this is called.
// No per-account DB queries.

function classifyAccountTiered(
  account:       RawAccount,
  companyByCode: Map<string, AccountMapping>,
  companyByName: Map<string, AccountMapping>,
  globalByCode:  Map<string, AccountMapping>,
  globalByName:  Map<string, AccountMapping>,
  kwdExact:      KeywordRow[],
  kwdContains:   KeywordRow[],
): TieredClassifyResult {
  const normName = normalizeAccountName(account.account_name);
  const code     = account.account_code?.trim() ?? "";

  // ── Tier 1: company mapping, exact code (NEVER fuzzy-match codes) ─────────
  if (code && companyByCode.has(code)) {
    return { status: "classified", mapping: companyByCode.get(code)!, confidence: "high", confidence_source: "mapping" };
  }

  // ── Tier 2: company mapping, normalised name — exact then fuzzy ≤ 2 ───────
  if (normName) {
    if (companyByName.has(normName)) {
      return { status: "classified", mapping: companyByName.get(normName)!, confidence: "high", confidence_source: "mapping" };
    }
    const fuzzyC = fuzzyMapLookup(normName, companyByName);
    if (fuzzyC) return { status: "classified", mapping: fuzzyC, confidence: "high", confidence_source: "mapping" };
  }

  // ── Tier 3: global mapping (company_id IS NULL) — code exact, then name exact/fuzzy ─
  if (code && globalByCode.has(code)) {
    return { status: "classified", mapping: globalByCode.get(code)!, confidence: "high", confidence_source: "mapping" };
  }
  if (normName) {
    if (globalByName.has(normName)) {
      return { status: "classified", mapping: globalByName.get(normName)!, confidence: "high", confidence_source: "mapping" };
    }
    const fuzzyG = fuzzyMapLookup(normName, globalByName);
    if (fuzzyG) return { status: "classified", mapping: fuzzyG, confidence: "high", confidence_source: "mapping" };
  }

  // ── Tier 4a: keyword_dictionary — exact match ──────────────────────────────
  const exactHit = kwdExact.find(k => k.term === normName);
  if (exactHit) {
    const meta = classificationMeta(exactHit.classification);
    return {
      status: "classified",
      mapping: {
        account_code: account.account_code, account_name: account.account_name,
        statement: meta.statement, classification: exactHit.classification,
        line_item: account.account_name, normal_balance: meta.normal_balance,
        is_cash_account: false, is_retained_earnings: false, is_payroll_account: false,
      },
      confidence: "high", confidence_source: "dictionary_exact",
    };
  }

  // ── Tier 4b: keyword_dictionary — contains, longest-match-wins ────────────
  if (normName) {
    const hits = kwdContains.filter(k => normName.includes(k.term));
    if (hits.length > 0) {
      hits.sort((a, b) => b.term.length - a.term.length);
      const maxLen  = hits[0].term.length;
      const topHits = hits.filter(k => k.term.length === maxLen);
      const classes = [...new Set(topHits.map(k => k.classification))];
      if (classes.length > 1) {
        // Equal-length conflicting matches → needs_review, never a guess
        return {
          status: "needs_review",
          confidence_source: "dictionary_contains_conflict",
          reason: `Conflicting keyword matches (length ${maxLen}): ${classes.join(" vs ")}`,
        };
      }
      const meta = classificationMeta(hits[0].classification);
      return {
        status: "classified",
        mapping: {
          account_code: account.account_code, account_name: account.account_name,
          statement: meta.statement, classification: hits[0].classification,
          line_item: account.account_name, normal_balance: meta.normal_balance,
          is_cash_account: false, is_retained_earnings: false, is_payroll_account: false,
        },
        confidence: "high", confidence_source: "dictionary_contains",
      };
    }

    // ── Tier 4c: keyword_dictionary — fuzzy on exact-type terms only (≤ 2) ──
    // Medium confidence → needs_review per doctrine (suggestion recorded for review screen).
    let bestDist = 3;
    let bestKwd: KeywordRow | null = null;
    for (const k of kwdExact) {
      const d = levenshtein(normName, k.term);
      if (d <= 2 && d < bestDist) { bestDist = d; bestKwd = k; }
    }
    if (bestKwd) {
      const meta = classificationMeta(bestKwd.classification);
      return {
        status: "needs_review",
        suggested_classification: bestKwd.classification,
        suggested_statement:      meta.statement,
        confidence_source:        "dictionary_fuzzy",
        reason: `Fuzzy keyword match (Δ${bestDist}): "${normName}" ≈ "${bestKwd.term}" → ${bestKwd.classification}`,
      };
    }
  }

  // ── Tier 5: AUTO_CLASSIFICATION_RULES regex (autoClassifyAccount, unchanged) ─
  const auto = autoClassifyAccount(account.account_name);
  if (auto) {
    return {
      status: "classified",
      mapping: {
        account_code:         account.account_code,
        account_name:         account.account_name,
        statement:            auto.statement,
        classification:       auto.classification,
        line_item:            auto.line_item,
        normal_balance:       auto.normal_balance,
        is_cash_account:      auto.is_cash     ?? false,
        is_retained_earnings: auto.is_retained ?? false,
        is_payroll_account:   auto.is_payroll  ?? false,
      },
      confidence: "high", confidence_source: "rule",
    };
  }

  // ── Tier 6: needs_review ───────────────────────────────────────────────────
  return {
    status: "needs_review",
    reason: `No classification found for "${account.account_name}"${code ? ` (${code})` : ""}`,
  };
}

// ── Statements Aggregator ─────────────────────────────────────────────────────

function aggregateStatements(
  accounts:  RawAccount[],
  mappings:  Map<string, AccountMapping>
): { statements: Statements; totals: { assets: number; liabilities: number; equity: number; revenue: number; expenses: number }; cashBalance: number } {
  const bs: Record<string, StatementSection> = {
    current_assets:         { accounts: [], total: 0 },
    non_current_assets:     { accounts: [], total: 0 },
    current_liabilities:    { accounts: [], total: 0 },
    non_current_liabilities:{ accounts: [], total: 0 },
    equity:                 { accounts: [], total: 0 },
  };
  const is: Record<string, StatementSection> = {
    revenue:             { accounts: [], total: 0 },
    cost_of_goods_sold:  { accounts: [], total: 0 },
    operating_expenses:  { accounts: [], total: 0 },
    other_income:        { accounts: [], total: 0 },
    taxes:               { accounts: [], total: 0 },
  };
  const cf: Record<string, StatementSection> = {
    operating_activities:  { accounts: [], total: 0 },
    investing_activities:  { accounts: [], total: 0 },
    financing_activities:  { accounts: [], total: 0 },
  };

  let cashBalance = 0;

  for (const account of accounts) {
    const m = mappings.get(accountKey(account));
    if (!m) continue;

    const signed = m.normal_balance === "debit"
      ? account.debit - account.credit
      : account.credit - account.debit;

    const enriched = { ...account, balance: signed };

    if (m.is_cash_account) cashBalance = signed;

    if (bs[m.classification]) {
      bs[m.classification].accounts.push(enriched);
      bs[m.classification].total += signed;
    } else if (is[m.classification]) {
      is[m.classification].accounts.push(enriched);
      is[m.classification].total += signed;
    } else if (cf[m.classification]) {
      cf[m.classification].accounts.push(enriched);
      cf[m.classification].total += signed;
    }
  }

  const totalAssets       = bs.current_assets.total + bs.non_current_assets.total;
  const totalLiabilities  = bs.current_liabilities.total + bs.non_current_liabilities.total;
  const totalEquity       = bs.equity.total;
  const totalRevenue      = is.revenue.total + is.other_income.total;
  const totalExpenses     = is.cost_of_goods_sold.total + is.operating_expenses.total + is.taxes.total;

  const hasCashFlow = cf.operating_activities.accounts.length > 0 ||
                      cf.investing_activities.accounts.length  > 0 ||
                      cf.financing_activities.accounts.length  > 0;

  return {
    statements: {
      balance_sheet:    bs,
      income_statement: is,
      cash_flow:        hasCashFlow ? cf : null,
    },
    totals: { assets: totalAssets, liabilities: totalLiabilities, equity: totalEquity, revenue: totalRevenue, expenses: totalExpenses },
    cashBalance,
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function validateAuth(authHeader: string | null): Promise<{ userId?: string; error?: Response }> {
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: new Response(JSON.stringify({ error: "Missing authorization header" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }) };
  }
  const token = authHeader.replace("Bearer ", "");
  if (!token || token.split(".").length !== 3) {
    return { error: new Response(JSON.stringify({ error: "Malformed token" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }) };
  }
  const supabaseUrl     = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const authClient      = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: authHeader } } });
  try {
    const { data: claims, error: authError } = await authClient.auth.getClaims(token);
    if (authError || !claims?.claims?.sub) {
      return { error: new Response(JSON.stringify({ error: "Invalid or expired token" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }) };
    }
    const exp = claims.claims.exp as number | undefined;
    if (exp && Date.now() / 1000 > exp) {
      return { error: new Response(JSON.stringify({ error: "Token has expired" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }) };
    }
    return { userId: claims.claims.sub as string };
  } catch {
    return { error: new Response(JSON.stringify({ error: "Authentication failed" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }) };
  }
}

// ── Main Handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const allErrors: ValidationError[] = [];

  try {
    const auth = await validateAuth(req.headers.get("Authorization"));
    if (auth.error) return auth.error;
    const userId = auth.userId!;

    const { uploadId } = await req.json();
    if (!uploadId) throw new Error("uploadId is required");

    console.log(`[PTB v2.0] Processing upload ${uploadId} for user ${userId}`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase    = createClient(supabaseUrl, supabaseKey);

    await supabase.from("trial_balance_uploads").update({ status: "validating" }).eq("id", uploadId);

    const { data: upload, error: uploadError } = await supabase
      .from("trial_balance_uploads").select("*").eq("id", uploadId).single();
    if (uploadError || !upload) throw new Error("Upload not found");

    const { data: fileData, error: downloadError } = await supabase.storage
      .from("trial-balance-files").download(upload.file_path);
    if (downloadError || !fileData) throw new Error(`Failed to download file: ${downloadError?.message}`);

    // ── STEP 1: Format detection + parsing ────────────────────────────────────
    console.log(`[PTB] Detected file: ${upload.file_name}`);
    const format = detectFormat(upload.file_name ?? "");
    let rawRows: (string | number | null)[][] = [];
    let sheetName = "";

    if (format === "xlsx") {
      const buffer = await fileData.arrayBuffer();

      // ── Detect audited financial statements vs. flat trial balance ──────────
      // Audited accounts (SCI + SFP sheets) are converted to a flat TB format
      // by the AuditedAccountsAdapter before entering the normal pipeline.
      const wb = XLSX.read(new Uint8Array(buffer), { type: "array", cellDates: false });

      if (isAuditedAccountsFormat(wb)) {
        const meta = getAuditedAccountsMetadata(wb);
        console.log(`[PTB] Detected AUDITED ACCOUNTS format — SCI: "${meta.sci_sheet}", SFP: "${meta.sfp_sheet}", Notes: "${meta.notes_sheet}"`);
        rawRows   = parseAuditedAccounts(wb);
        sheetName = `AUDITED_ACCOUNTS (SCI="${meta.sci_sheet}", SFP="${meta.sfp_sheet}")`;
      } else {
        const parsed = parseXLSX(buffer);
        rawRows    = parsed.rows;
        sheetName  = parsed.sheetName;
      }
      console.log(`[PTB] XLSX: sheet="${sheetName}", ${rawRows.length} raw rows`);
    } else {
      const content = await fileData.text();
      rawRows = parseCSV(content);
      console.log(`[PTB] CSV: ${rawRows.length} raw rows`);
    }

    if (rawRows.length < 2) {
      throw new Error("File appears empty or has no data rows. Minimum 2 rows required (header + 1 account).");
    }

    // ── STEP 2: Column detection ───────────────────────────────────────────────
    const { map: colMap, detected: detectedCols } = detectColumns(rawRows);
    console.log(`[PTB] Columns detected:`, detectedCols);

    if (!colMap.account_name) {
      allErrors.push({ code: "MISSING_COLUMN", message: "Could not detect an account name column. Ensure the file has a column header containing 'Account Name', 'Description', or similar.", field: "account_name" });
    }
    if (colMap.debit === null && colMap.balan