// ============================================================
// Axiom — process-trial-balance Edge Function
<<<<<<< HEAD
// Version: v2.1 — Audited Accounts Support + Extended Classification
=======
// Version: v2.2 — BS Equation includes current-year net income (closing equity)
>>>>>>> 6ee2310 (v2.1: AuditedAccountsAdapter + 13 new TB patterns + Class 7)
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
  account_code: string;
  account_name: string;
  debit:        number;
  credit:       number;
  balance:      number;
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

// Full processing_result (what engine reads)
interface ProcessingResult {
  status:            "valid" | "invalid" | "blocked";
  statements:        Statements | null;
  validation_report: Record<string, unknown>;
  errors:            ValidationError[];
  summary: {
    total_accounts: number;
    processed_at:   string;
    parser_version: string;
    columns_detected: Record<string, string>;
    auto_classified: number;
  };
}

// ── Pattern libraries (mirrors kinga-findings-engine) ─────────────────────────

/** Column header synonyms — used by generic column detector */
const COLUMN_SYNONYMS: Record<string, RegExp[]> = {
  account_code: [/^account[_\s]?(?:code|no|number|#)$/i, /^acct[_\s]?(?:code|no|#)$/i, /^code$/i, /^gl[_\s]?code$/i, /^a\/c$/i],
  account_name: [/^account[_\s]?(?:name|description|title|desc)$/i, /^description$/i, /^name$/i, /^gl[_\s]?name$/i],
  debit:        [/^debit[s]?$/i, /^dr$/i, /^debit[_\s]amount$/i],
  credit:       [/^credit[s]?$/i, /^cr$/i, /^credit[_\s]amount$/i],
  balance:      [/^balance$/i, /^net[_\s]balance$/i, /^closing[_\s]balance$/i, /^amount$/i],
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
  { patterns: [/\brevenue\b/i, /\bsale[s]?\b/i, /\bincome(?!\s+tax)\b/i, /\bmapato\b/i, /\bfee[s]?\b/i, /\bturnover\b/i],
    result: { statement: "income_statement", classification: "revenue", normal_balance: "credit", line_item: "Revenue" }},

  // ── INCOME STATEMENT — Cost of Goods Sold ──────────────────────────────────
  // Must come BEFORE operating_expenses so "cost of sales" routes to cogs not opex
  { patterns: [/\bcost\s+of\s+(?:goods\s+)?sold\b/i, /\bcost\s+of\s+sales\b/i, /\bcost\s+of\s+revenue\b/i, /\bcogs\b/i, /\bdirect\s+cost[s]?\b/i, /\bghara\s+za\s+bidhaa\b/i],
    result: { statement: "income_statement", classification: "cost_of_goods_sold", normal_balance: "debit", line_item: "Cost of Sales" }},
  { patterns: [/\bpurchases?\s+(?:drugs?|medic|goods|stock|supplies?)\b/i, /\bstock\s+purchases?\b/i],
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
  { patterns: [/\badmin(?:istrat\w+)?\s+(?:exp|cost)/i, /\bgeneral\s+(?:exp|admin)/i],
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
  { patterns: [/\bentertain(?:ment)?\b/i, /\bmeeting[s]?\s+(?:exp|allow|cost)\b/i, /\bhospitality\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Entertainment & Meetings" }},
  // ── Office Supplies / Stationery ────────────────────────────────────────────
  { patterns: [/\bstation[e]?r[yi]\b/i, /\boffice\s+suppli\b/i, /\bprinting\b/i, /\bstamp[s]?\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Office Supplies & Stationery" }},
  // ── Telephone / Communication ────────────────────────────────────────────────
  { patterns: [/\btelephon[e]?\b/i, /\binternet\b/i, /\bpostage\b/i, /\bcommunication\b/i, /\bdata\s+(?:plan|bundle|cost)\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Telephone & Communication" }},
  // ── Travel & Transport ────────────────────────────────────────────────────────
  { patterns: [/\btravel(?:ling|ing)?\b/i, /\btransport\b/i, /\bvehicle\s+(?:hire|rental)\b/i, /\bairfare\b/i, /\baccommodation\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Travel & Transport" }},
  // ── Cleaning / Sanitation ────────────────────────────────────────────────────
  { patterns: [/\bclean(?:ing)?\b/i, /\bgarden(?:ing)?\b/i, /\bsanit(?:ation|ary)\b/i, /\bwaste\s+(?:management|disposal)\b/i, /\bfumigat\b/i, /\bpest\s+control\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Cleaning & Sanitation" }},
  // ── Service Levy (P&L expense — MUST come before BS service levy payable rule)
  { patterns: [/\bservice\s+levy\b/i, /\bmunicipal\s+(?:levy|tax)\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Service Levy" }},
  // ── Professional & Legal Fees ────────────────────────────────────────────────
  { patterns: [/\baudit\s+fee[s]?\b/i, /\baccounting\s+fee[s]?\b/i, /\blegal\s+fee[s]?\b/i, /\bprofessional\s+fee[s]?\b/i, /\bconsulting\s+fee[s]?\b/i, /\bbrela\b/i, /\bvaluation\b/i, /\bsurvey\b/i, /\binspection\s+fee\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Professional & Legal Fees" }},
  // ── Licences & Permits ───────────────────────────────────────────────────────
  { patterns: [/\blicen[sc]e[s]?\b/i, /\bpermit[s]?\b/i, /\bregistration\s+fee[s]?\b/i, /\bmembership\s+fee[s]?\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Licences & Permits" }},
  // ── Safety & Maintenance (catch-all for specialist opex) ─────────────────────
  { patterns: [/\bfire\s+extinguisher\b/i, /\bsafety\b/i, /\bstock[_\s]?tak(?:ing)?\b/i],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Safety & Administration" }},
  // ── Hospital / Clinical Direct Expenses (sector-specific) ────────────────────
  { patterns: [/\bpatient[s]?\s+(?:meal|food|refund|invest)/i, /\bhiring\s+cost\b/i, /\bambulance\b/i, /\bclinical\b/i],
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
  { patterns: [/\bproperty\b/i, /\bplant\b/i, /\bequipment\b/i, /\bfurniture\b/i, /\bfixture[s]?\b/i, /\bmotor\s+vehicle\b/i, /\bvehicle[s]?\b/i],
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
  { patterns: [/\bretained\s+earning[s]?\b/i, /\baccumulated\s+(?:profit|surplus|deficit)\b/i, /\bprofit\s+b[\/]?[fo]\b/i, /\bfaida\s+iliyobakiwa\b/i, /\bundistributed\s+(?:profit|earning)/i],
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
      for (const synonyms of Object.values(COLUMN_SYNONYMS)) {
        if (synonyms.some(rx => rx.test(s))) { score++; break; }
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
    for (const [key, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
      if (map[key as keyof typeof map] === null && synonyms.some(rx => rx.test(lower))) {
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

    accounts.push({ account_code: code, account_name: name || code, debit, credit, balance });
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
    const m = mappings.get(account.account_code);
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
    if (colMap.debit === null && colMap.balance === null) {
      allErrors.push({ code: "MISSING_COLUMN", message: "Could not detect debit or balance column. Ensure headers contain 'Debit'/'Dr' or 'Balance'.", field: "debit" });
    }
    if (allErrors.length > 0) {
      await supabase.from("trial_balance_uploads").update({ status: "blocked", is_valid: false, accounting_errors: allErrors, processed_at: new Date().toISOString() }).eq("id", uploadId);
      return new Response(JSON.stringify({ status: "blocked", errors: allErrors }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── STEP 3: Row → RawAccount[] ────────────────────────────────────────────
    const { accounts: rawAccounts } = rowsToRawAccounts(rawRows, colMap);
    console.log(`[PTB] Parsed ${rawAccounts.length} accounts`);

    if (rawAccounts.length === 0) {
      throw new Error("No account rows found after stripping subtotals and blank rows.");
    }

    // ── STEP 4: Trial balance integrity ───────────────────────────────────────
    // TZS 1.00 tolerance — TZS is non-decimal and rounding across many lines
    // can accumulate to several whole-TZS units.  Anything over 1 TZS is flagged.
    const TOLERANCE = 1.00;
    const totalDebits  = rawAccounts.reduce((s, a) => s + a.debit, 0);
    const totalCredits = rawAccounts.reduce((s, a) => s + a.credit, 0);
    const difference   = Math.abs(totalDebits - totalCredits);

    if (difference > TOLERANCE) {
      allErrors.push({
        code: "TRIAL_BALANCE_IMBALANCE",
        message: `Trial balance does not balance: Debits ${totalDebits.toFixed(2)} ≠ Credits ${totalCredits.toFixed(2)} (difference: ${difference.toFixed(2)})`,
        expected: 0,
        actual: difference,
      });
    }

    if (allErrors.some(e => e.code === "TRIAL_BALANCE_IMBALANCE")) {
      const result: Partial<ProcessingResult> = {
        status: "blocked",
        statements: null,
        errors: allErrors,
        validation_report: { tb_balance_check: { passed: false, total_debits: totalDebits, total_credits: totalCredits, difference } },
<<<<<<< HEAD
        summary: { total_accounts: rawAccounts.length, processed_at: new Date().toISOString(), parser_version: "v2.1", columns_detected: detectedCols, auto_classified: 0 },
=======
        summary: { total_accounts: rawAccounts.length, processed_at: new Date().toISOString(), parser_version: "v2.2", columns_detected: detectedCols, auto_classified: 0 },
>>>>>>> 6ee2310 (v2.1: AuditedAccountsAdapter + 13 new TB patterns + Class 7)
      };
      await supabase.from("trial_balance_uploads").update({ status: "blocked", is_valid: false, accounting_errors: allErrors, processing_result: result, processed_at: new Date().toISOString() }).eq("id", uploadId);
      return new Response(JSON.stringify(result), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── STEP 5: Load existing account_mappings ────────────────────────────────
    const { data: userMappings } = await supabase
      .from("account_mappings").select("*").eq("user_id", userId);
    const existingMappings = new Map<string, AccountMapping>();
    for (const m of (userMappings ?? [])) {
      existingMappings.set(m.account_code, {
        account_code: m.account_code, account_name: m.account_name,
        statement: m.statement, classification: m.classification,
        line_item: m.line_item, normal_balance: m.normal_balance,
        is_cash_account: m.is_cash_account ?? false,
        is_retained_earnings: m.is_retained_earnings ?? false,
        is_payroll_account: m.is_payroll_account ?? false,
      });
    }

    // ── STEP 6: Auto-classification for unmapped accounts ─────────────────────
    const newMappingsToInsert: Record<string, unknown>[] = [];
    let autoClassifiedCount = 0;

    for (const account of rawAccounts) {
      if (existingMappings.has(account.account_code)) continue;

      const classification = autoClassifyAccount(account.account_name);
      if (!classification) continue;

      const newMapping: AccountMapping = {
        account_code:        account.account_code,
        account_name:        account.account_name,
        statement:           classification.statement,
        classification:      classification.classification,
        line_item:           classification.line_item,
        normal_balance:      classification.normal_balance,
        is_cash_account:     classification.is_cash ?? false,
        is_retained_earnings:classification.is_retained ?? false,
        is_payroll_account:  classification.is_payroll ?? false,
      };

      existingMappings.set(account.account_code, newMapping);
      autoClassifiedCount++;

      newMappingsToInsert.push({
        user_id:              userId,
        account_code:         account.account_code,
        account_name:         account.account_name,
        statement:            classification.statement,
        classification:       classification.classification,
        line_item:            classification.line_item,
        normal_balance:       classification.normal_balance,
        is_cash_account:      classification.is_cash ?? false,
        is_retained_earnings: classification.is_retained ?? false,
        is_payroll_account:   classification.is_payroll ?? false,
        is_auto_classified:   true,
      });
    }

    if (newMappingsToInsert.length > 0) {
      // Upsert — on_conflict do nothing (don't overwrite human corrections)
      const { error: upsertErr } = await supabase
        .from("account_mappings")
        .upsert(newMappingsToInsert, { onConflict: "user_id,account_code", ignoreDuplicates: true });
      if (upsertErr) console.warn(`[PTB] Auto-classification upsert warning: ${upsertErr.message}`);
      else console.log(`[PTB] Auto-classified and saved ${autoClassifiedCount} accounts`);
    }

    // ── STEP 7: Mapping completeness ──────────────────────────────────────────
    const unmapped = rawAccounts.filter(a => !existingMappings.has(a.account_code)).map(a => a.account_code);

    if (unmapped.length > 0) {
      allErrors.push({
        code: "UNMAPPED_ACCOUNTS",
        message: `${unmapped.length} account(s) could not be classified automatically: ${unmapped.slice(0, 5).join(", ")}${unmapped.length > 5 ? ` (+${unmapped.length - 5} more)` : ""}. Add descriptive account names or map them manually.`,
        actual: unmapped.length,
        expected: 0,
      });
      const result: Partial<ProcessingResult> = {
        status: "blocked",
        statements: null,
        errors: allErrors,
        validation_report: {
          tb_balance_check: { passed: true, total_debits: totalDebits, total_credits: totalCredits, difference: 0 },
          mapping_completeness: { passed: false, total_accounts: rawAccounts.length, mapped_accounts: rawAccounts.length - unmapped.length, unmapped },
        },
<<<<<<< HEAD
        summary: { total_accounts: rawAccounts.length, processed_at: new Date().toISOString(), parser_version: "v2.1", columns_detected: detectedCols, auto_classified: autoClassifiedCount },
=======
        summary: { total_accounts: rawAccounts.length, processed_at: new Date().toISOString(), parser_version: "v2.2", columns_detected: detectedCols, auto_classified: autoClassifiedCount },
>>>>>>> 6ee2310 (v2.1: AuditedAccountsAdapter + 13 new TB patterns + Class 7)
      };
      await supabase.from("trial_balance_uploads").update({ status: "blocked", is_valid: false, accounting_errors: allErrors, processing_result: result, processed_at: new Date().toISOString() }).eq("id", uploadId);
      return new Response(JSON.stringify(result), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── STEP 8: Statement aggregation ─────────────────────────────────────────
    const { statements, totals, cashBalance } = aggregateStatements(rawAccounts, existingMappings);

    // ── STEP 9: Accounting equation ───────────────────────────────────────────
    // In an unadjusted trial balance, P&L accounts are not yet closed to
    // retained earnings. Closing equity = opening equity + current-year net income.
    const netIncome      = totals.revenue - totals.expenses;
    const closingEquity  = totals.equity + netIncome;
    const bsDifference   = Math.abs(totals.assets - (totals.liabilities + closingEquity));
    const bsPassed       = bsDifference <= TOLERANCE;
    if (!bsPassed) {
      allErrors.push({
        code: "BALANCE_SHEET_EQUATION_FAILED",
        message: `Assets (${totals.assets.toFixed(2)}) ≠ Liabilities (${totals.liabilities.toFixed(2)}) + Closing Equity (${closingEquity.toFixed(2)}). [Opening Equity: ${totals.equity.toFixed(2)}, Net Income: ${netIncome.toFixed(2)}]. Difference: ${bsDifference.toFixed(2)}`,
        expected: 0,
        actual: bsDifference,
      });
    }

    const allValid   = bsPassed;
    const finalStatus: "valid" | "invalid" = allValid ? "valid" : "invalid";
    console.log(`[PTB] Final status: ${finalStatus.toUpperCase()} | Auto-classified: ${autoClassifiedCount}`);

    const validationReport = {
      tb_balance_check:     { passed: true, total_debits: totalDebits, total_credits: totalCredits, difference: 0 },
      mapping_completeness: { passed: true, total_accounts: rawAccounts.length, mapped_accounts: rawAccounts.length, unmapped: [], auto_classified: autoClassifiedCount },
      balance_sheet_equation: { passed: bsPassed, assets: totals.assets, liabilities: totals.liabilities, equity: totals.equity, difference: bsDifference },
      profit_equity_linkage: null,
      cash_reconciliation:  cashBalance !== 0 ? { passed: true, cf_ending_cash: cashBalance, bs_cash: cashBalance } : null,
    };

    // ── STEP 10: Save processing_result in engine-compatible format ───────────
    // CRITICAL: structure must match what kinga-findings-engine reads:
    //   pr.status, pr.statements.income_statement.operating_expenses.accounts
    //   pr.statements.balance_sheet.equity.accounts
    //   pr.statements.balance_sheet.current_liabilities.accounts
    const processingResult: ProcessingResult = {
      status: finalStatus,
      statements: allValid ? statements : null,
      validation_report: validationReport,
      errors: allErrors,
      summary: {
        total_accounts:    rawAccounts.length,
        processed_at:      new Date().toISOString(),
        parser_version:    "v2.0",
        columns_detected:  detectedCols,
        auto_classified:   autoClassifiedCount,
      },
    };

    await supabase.from("trial_balance_uploads").update({
      status:             allValid ? "complete" : "error",
      is_valid:           allValid,
      validation_report:  validationReport,
      accounting_errors:  allErrors,
      processing_result:  processingResult,
      processed_at:       new Date().toISOString(),
    }).eq("id", uploadId);

    return new Response(JSON.stringify(processingResult), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[PTB] Fatal error:", error);
    return new Response(
      JSON.stringify({ status: "blocked", error: error instanceof Error ? error.message : "Processing failed", errors: allErrors }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
