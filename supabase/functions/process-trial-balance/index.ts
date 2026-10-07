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
import { classifyPublicSectorAccount } from "./publicSectorClassification.ts";
import { resolveProcessingActor, type ProcessingActor } from "../_shared/processingActor.ts";
import { PROCESSING_FORBIDDEN, personalUploadRefusal, processingRefusal, sourceBindingRefusal } from "../_shared/uploadLifecycle.ts";
import { isEntitlementWallError, paidActionRefusal, processingEntitlementRefusal } from "../_shared/paidAction.ts";
// Controlled answers (never a raw database or Storage error) and the source-download failure path (L-1 / L-2).
import { PROCESSING_UNAVAILABLE, classifyDownloadFailure, sourceFailureOutcome } from "../_shared/processingSource.ts";
import { claimIdempotency, failIdempotency } from "../_shared/idempotency.ts";
import { recordEngineRunFailed } from "../_shared/engine-run.ts";
import { canonicalJson, sha256Hex, sha256HexBytes, type CanonicalValue } from "../_shared/hash.ts";
import { computeNormalizedInputHash, type NormalizedInputRow } from "../_shared/safisha-normalize.ts";
// The ingestion core: exact money, explicit period and currency, one identity per account, safe totals, row lineage.
import {
  MilestoneLog, TB_INGESTION_VERSION, classificationNeedsReview, formatMinor, ingestTrialBalance, markIngestionMilestones,
  minorToNumber, sheetRowsFromMatrix, type Cell, type IngestIssue, type IngestResult,
} from "../_shared/tbIngestion.ts";
import { detectSourceFormat, readTrialBalanceSource, type XlsxLike } from "../_shared/tbSource.ts";
// E1: exact class-side amounts ("tb-amounts/1") and the treatment request identity (H1b, 20261007100000).
import { TB_ROW_FORMAT, buildTbAmounts, classSideMinor, classSideOf, type TbAmounts } from "../_shared/tbAmounts.ts";
import { CLOSING_STOCK_RULE, buildTreatmentRequest, type TreatmentRequest } from "../_shared/treatmentRequest.ts";

// processing_result.summary.parser_version — the ingestion core's version (one value on every outcome).
const PARSER_VERSION = TB_INGESTION_VERSION;

// Ω∞ Phase 0 Slice 2 — SAFISHA certification engine identity. Bumped
// independently of parser_version (which tracks the TB parsing/aggregation
// logic below, unchanged this slice).
// E1: v2 — exact class-side aggregation, no closing-stock rescue (a treatment question instead), no silent suppression of
// a non-zero account, an exact accounting equation that is never certified when it fails.
const SAFISHA_ENGINE_VERSION = "safisha-tb-certification-v2";

// The numeric engine generation written on every run (engine_runs.engine_generation, 20261007100000). The database
// refuses runs and certifications below processing_release_control.min_engine_generation; compared as an integer only.
const ENGINE_GENERATION = 2;

// Matches crypto.randomUUID() output (and any standard UUID). Case-
// insensitive: RFC 4122 doesn't mandate lowercase, and rejecting a
// technically-valid uppercase UUID would be an arbitrary tightening.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  source_row_number: number; // 1-based row of the source sheet/file (tbIngestion lineage)
  /** The ingestion identity — code (or name) plus any dimension values; unique within one trial balance. */
  identity:          string;
  /** Dimension values (cost centre, department, …) when the trial balance is split by dimension. */
  dimensions:        Record<string, string>;
  /** E1: the exact amounts in minor units. Every figure that decides anything is computed from these, never the floats. */
  debitMinor:        bigint;
  creditMinor:       bigint;
}

/** An account as written into processing_result.statements (no BigInt: the result is JSON). */
type StatementAccount = Omit<RawAccount, "debitMinor" | "creditMinor">;

function statementAccount(account: RawAccount, balance: number): StatementAccount {
  const { debitMinor: _d, creditMinor: _c, ...rest } = account;
  return { ...rest, balance };
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
  /**
   * S1 (20261006100000): "reviewed" only for THIS company's row linked to a review decision; "unconfirmed_company" for
   * this company's row without that link; "shared" for a global (company_id NULL) row. Only "reviewed" is ever Tier 1/2.
   */
  provenance?: "reviewed" | "unconfirmed_company" | "shared";
  /** S1: the review decision this company's reviewed mapping is linked to (null for any other row). */
  review_decision_id?: string | null;
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
  accounts: StatementAccount[];
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
  stale_non_reporting_reason?: string;
  reason:                    string;
  /** E1: present when the account needs a treatment decision; the request a "keep as mapped" confirmation binds to. */
  treatment_request_id?:     string;
}

// Ω∞ Phase 0 Slice 3 — `tier` carries the REAL classifier tier that fired
// (1-5), fixing the tier-collapse gap Slice 2 had to work around
// (confidenceSourceToEvidenceTier's lossy confidence_source->tier guess,
// which could never distinguish tier 1/2/3 from each other). This is
// additive precision, not a renumbering: the pre-Slice-3 lossy mapping
// NEVER emitted 2 or 3 for any live account (it collapsed every "mapping"
// confidence_source straight to 1) — those two values were reserved but
// unused in every certification committed before this change, so
// populating them now for real does not reinterpret any historical
// tb_certifications.rows_snapshot row. Tier 5 covers BOTH the public-
// sector framework rule and AUTO_CLASSIFICATION_RULES regex — identical
// to the old lossy mapping's own grouping (both were "rule"-sourced and
// both already collapsed to 5), so no compatibility change there either.
type TieredClassifyResult =
  | { status: "classified"; mapping: AccountMapping; confidence: "high" | "medium"; confidence_source: "mapping" | "dictionary_exact" | "dictionary_contains" | "rule"; tier: 1 | 2 | 3 | 4 | 5; fuzzy?: boolean }
  | { status: "needs_review"; suggested_classification?: string; suggested_statement?: string; confidence_source?: string; reason: string };

// Ω∞ Phase 2A: an account whose latest effective professional decision is
// MARK_NON_REPORTING_ACCOUNT (identity-drift guard passed). Distinct from
// both "mapped" and "needs review" — see get_effective_non_reporting_status().
interface NonReportingAccount {
  account_code: string | null;
  account_name: string;
}

// Full processing_result (what engine reads)
interface ProcessingResult {
  status:                    "valid" | "invalid" | "blocked" | "needs_review";
  statements:                Statements | null;
  validation_report:         Record<string, unknown>;
  errors:                    ValidationError[];
  needs_review_accounts?:    NeedsReviewAccount[];
  non_reporting_accounts?:   NonReportingAccount[];
  summary: {
    total_accounts:   number;
    processed_at:     string;
    parser_version:   string;
    columns_detected: Record<string, string>;
    auto_classified:  number;
    rejected_rows?:   unknown;
  };
  /** What ingestion did with every source row, its exact totals, issues and the milestones processing reached. */
  ingestion?:                Record<string, unknown>;
  /** E1: the treatment requests this run emitted (the server binds CONFIRM_ACCOUNT_TREATMENT to these). */
  treatment_requests?:       TreatmentRequest[];
  /** E1: the exact amounts ("tb-amounts/1"); present on every result whose statements were aggregated. */
  amounts?:                  TbAmounts;
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
  // Sentinel / integrity-check rows common in Tanzanian TB exports
  /^balance\s*check/i, /^check\s*figure/i, /^proof\s*of\s*(balance|total)/i,
  /must\s*be\s*zero/i, /^difference/i, /^variance/i,
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
  // #85-FIX: ALL forms of "closing stock/inventory" must route to COGS, not current assets.
  // Patterns cover: "Closing Stock", "Stock — Closing", "Inventory (Closing)",
  // "Less: Closing", "Inventories — End of Year", "End-of-Period Stock", etc.
  { patterns: [
      /\bclosing\s+(?:stock|inventor[yi])/i,            // "Closing Stock / Closing Inventory"
      /\bless[:\s]+closing\b/i,                          // "Less: Closing"
      /(stock|inventor[yi])[\s\-–—]*(?:\(?\s*closing|end|final\s*\)?)/i,  // "Stock — Closing", "Inventory (Closing)"
      /\bend.{0,8}(?:year|period|stock|inventor[yi])/i,  // "End of Year Stock"
      /\bending\s+(?:stock|inventor[yi])\b/i,            // "Ending Stock"
      /\bstock\s+(?:at\s+)?(?:year|period)\s*end\b/i,   // "Stock at Year End"
    ],
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
  // ── FIX A: Water Well / Borehole — capital asset ──────────────────────────
  // MUST precede the Staff Welfare block: /\bwater\b/i in that block would
  // otherwise match "Water Well (Net Book Value)" before this rule can fire.
  // Regression: classification.test.js test 1 (account 1030).
  { patterns: [/\bwater[\s_-]+well\b/i, /\bwater[\s_-]+borehole\b/i, /\bbore[\s_-]+well\b/i],
    result: { statement: "balance_sheet", classification: "non_current_assets", normal_balance: "debit", line_item: "Water Well" }},

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
      /\blong[_\s-]?term\s+(?:bank\s+)?loan[s]?\b/i,
      /\bterm\s+loan\b/i,
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
// `const code = rawCode || name`), but two name-only rows can share
// the same derived code if their account names are identical.
// source_row_number guarantees uniqueness: used as key when code === name.
// ONE helper used by BOTH the write in STEP 6 and the read in aggregateStatements.

// Ω∞ Phase 2A: join key for matching a raw account against
// get_effective_non_reporting_status()'s echoed-back {account_code, account_name}
// rows. Deliberately NOT a normalized/canonical identity — the RPC computes
// review_account_key itself, server-side; this is only a 1:1 correlation key
// between what we sent and what came back, so Deno never re-derives the
// canonical identity formula (avoids the JS/SQL normalization discrepancy).
function accountJoinKey(code: string | null, name: string): string {
  return `${code ?? ""}|||${name}`;
}

// The ingestion identity is unique per trial balance (a repeated identity is refused before this point), including the
// legitimate case of one code split across dimension values. Classification itself is per code: every row of a code
// gets the same mapping.
function accountKey(account: RawAccount): string {
  return account.identity;
}

// ── Account name normalisation ────────────────────────────────────────────────
// Mirrors SQL: lower(trim(regexp_replace(regexp_replace(name,'[[:punct:]]','','g'),'\s+',' ','g')))
// CANONICAL NORMALIZE v1 — keep in sync with
//   src/lib/normalizeAccountName.ts (browser side)
// Golden fixture: supabase/functions/_shared/normalize-golden.json
// Deno test    : supabase/functions/process-trial-balance/normalize.test.ts

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
  reportingFramework: string | null,
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
    return { status: "classified", mapping: companyByCode.get(code)!, confidence: "high", confidence_source: "mapping", tier: 1 };
  }

  // ── Tier 2: company mapping, normalised name — exact then fuzzy ≤ 2 ───────
  if (normName) {
    if (companyByName.has(normName)) {
      return { status: "classified", mapping: companyByName.get(normName)!, confidence: "high", confidence_source: "mapping", tier: 2 };
    }
    const fuzzyC = fuzzyMapLookup(normName, companyByName);
    if (fuzzyC) return { status: "classified", mapping: fuzzyC, confidence: "high", confidence_source: "mapping", tier: 2, fuzzy: true };
  }

  // ── Tier 3: global mapping (company_id IS NULL) — code exact, then name exact/fuzzy ─
  if (code && globalByCode.has(code)) {
    return { status: "classified", mapping: globalByCode.get(code)!, confidence: "high", confidence_source: "mapping", tier: 3 };
  }
  if (normName) {
    if (globalByName.has(normName)) {
      return { status: "classified", mapping: globalByName.get(normName)!, confidence: "high", confidence_source: "mapping", tier: 3 };
    }
    const fuzzyG = fuzzyMapLookup(normName, globalByName);
    if (fuzzyG) return { status: "classified", mapping: fuzzyG, confidence: "high", confidence_source: "mapping", tier: 3, fuzzy: true };
  }

  // ── Framework vocabulary: IPSAS/GFRS only ────────────────────────────────
  // A public-sector chart is not a private-company chart with unusual labels.
  // Apply deterministic government vocabulary only when the engagement has
  // explicitly declared an IPSAS/GFRS framework. Unknown terms still go to
  // review; there is no balance-sign guessing.
  const publicSector = classifyPublicSectorAccount(account.account_name, reportingFramework);
  if (publicSector) {
    return {
      status: "classified",
      mapping: {
        account_code: account.account_code,
        account_name: account.account_name,
        statement: publicSector.statement,
        classification: publicSector.classification,
        line_item: publicSector.line_item,
        normal_balance: publicSector.normal_balance,
        is_cash_account: publicSector.is_cash ?? false,
        is_retained_earnings: false,
        is_payroll_account: false,
      },
      confidence: "high",
      confidence_source: "rule",
      tier: 5,
    };
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
      confidence: "high", confidence_source: "dictionary_exact", tier: 4,
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
      // ── FIX B: Expense-over-asset override ──────────────────────────────────
      // Longest-match-wins can let a balance-sheet asset keyword (e.g.
      // "motor vehicles", 14 chars) beat a shorter expense keyword (e.g.
      // "maintenance", 11 chars).  That is wrong for accounts like
      // "Repair & Maintenance — Motor Vehicles", which are always operating
      // expenses regardless of the asset qualifier in the name.
      // Rule: if the winner is a balance-sheet asset class AND any match
      // (any length) signals operating_expenses, fall through to Tier 5 regex,
      // which handles compound account names deterministically.
      // Regression: classification.test.js tests 4–5 (account 6054),
      //             tests 11–14 (Equipment Repairs, Motor Vehicle Insurance).
      const winnerClass = classes[0];
      const hasOpexConflict =
        (winnerClass === "non_current_assets" || winnerClass === "non_current_liabilities") &&
        hits.some(k => k.classification === "operating_expenses");
      if (!hasOpexConflict) {
        const meta = classificationMeta(winnerClass);
        return {
          status: "classified",
          mapping: {
            account_code: account.account_code, account_name: account.account_name,
            statement: meta.statement, classification: winnerClass,
            line_item: account.account_name, normal_balance: meta.normal_balance,
            is_cash_account: false, is_retained_earnings: false, is_payroll_account: false,
          },
          confidence: "high", confidence_source: "dictionary_contains", tier: 4,
        };
      }
      // hasOpexConflict → fall through to Tier 4c / Tier 5
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
        reason: `Fuzzy keyword match (Delta${bestDist}): "${normName}" ~ "${bestKwd.term}" -> ${bestKwd.classification}`,
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
      confidence: "high", confidence_source: "rule", tier: 5,
    };
  }

  // ── Tier 6: needs_review ───────────────────────────────────────────────────
  return {
    status: "needs_review",
    reason: `No classification found for "${account.account_name}"${code ? ` (${code})` : ""}`,
  };
}

// ── Statements Aggregator ─────────────────────────────────────────────────────

// E1: class-side signing from the exact amounts. Assets and expenses are debit − credit; liabilities, equity and income
// are credit − debit. normal_balance only marks contra behaviour and never re-signs a class (a contra asset such as
// accumulated depreciation reduces assets; a contra liability reduces liabilities). Nothing is moved between classes: the
// closing-stock "rescue" that used to re-route a current-asset credit into cost of sales is gone — the same pattern now
// raises a treatment question (STEP 6b) and the figures stay as mapped. Every account reaching here is on a
// balance-sheet or income-statement class (STEP 6b sends anything else to review); anything else is an internal error.
function aggregateStatements(
  accounts:  RawAccount[],
  mappings:  Map<string, AccountMapping>,
  exponent:  number,
): { statements: Statements; totals: { assets: number; liabilities: number; equity: number; revenue: number; expenses: number } } {
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
  const sectionMinor = new Map<string, bigint>();

  for (const account of accounts) {
    const m = mappings.get(accountKey(account));
    if (!m) continue;
    const side = classSideOf(m.classification);
    const section = bs[m.classification] ?? is[m.classification];
    if (!side || !section) {
      throw new Error(`[PTB] Internal invariant violation: account "${accountKey(account)}" reached aggregation on classification "${m.classification}", which is not on the balance sheet or income statement.`);
    }
    const classSide = classSideMinor(side, account.debitMinor, account.creditMinor);
    section.accounts.push(statementAccount(account, minorToNumber(classSide, exponent)));
    sectionMinor.set(m.classification, (sectionMinor.get(m.classification) ?? 0n) + classSide);
  }
  for (const [cls, total] of sectionMinor) (bs[cls] ?? is[cls]).total = minorToNumber(total, exponent);

  const sum = (...classes: string[]) => minorToNumber(classes.reduce((t, c) => t + (sectionMinor.get(c) ?? 0n), 0n), exponent);
  return {
    statements: { balance_sheet: bs, income_statement: is, cash_flow: null },
    totals: {
      assets:      sum("current_assets", "non_current_assets"),
      liabilities: sum("current_liabilities", "non_current_liabilities"),
      equity:      sum("equity"),
      revenue:     sum("revenue", "other_income"),
      expenses:    sum("cost_of_goods_sold", "operating_expenses", "taxes"),
    },
  };
}

// ── Treatment rule closing_stock_credit/1 (E1) ────────────────────────────────
// The name and code patterns the deleted rescue used. They no longer move money: a reviewed current-asset account
// whose combined balance is a credit and that matches them needs a TREATMENT decision — keep it as mapped (with a
// recorded reason, CONFIRM_ACCOUNT_TREATMENT) or reclassify it through the ordinary review.
const CLOSING_STOCK_NAME_PATTERNS = [
  /\bclosing\s+(?:stock|inventor[yi])/i,
  /\bless[:\s]+closing\b/i,
  /(stock|inventor[yi])[\s\-–—]*(?:\(?\s*closing|end|final\s*\)?)/i,
  /\bend.{0,8}(?:year|period)\s+(?:stock|inventor[yi])/i,
  /\bending\s+(?:stock|inventor[yi])\b/i,
  /\bstock\s+(?:at\s+)?(?:year|period)\s*end\b/i,
];

function matchesClosingStockRule(account: RawAccount): boolean {
  return /^[4-9]/.test(account.account_code?.trim() ?? "") ||
    CLOSING_STOCK_NAME_PATTERNS.some((p) => p.test(account.account_name ?? ""));
}

/** The review account key the server derives (resolve_account_review_batch): the trimmed code, else the normalized name. */
function reviewAccountKey(account: RawAccount): string {
  const code = account.account_code?.trim() ?? "";
  return code !== "" ? code : normalizeAccountName(account.account_name ?? "");
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

// ── Ω∞ Phase 0 Slice 2 — SAFISHA certification wiring ─────────────────────
// Mirrors src/lib/safisha/types.ts's SafishaException/CertifiedTBRow shapes
// (no cross-import exists between src/ and supabase/functions/ — this is
// the authoritative, server-side copy; the browser copy is provable-only).

interface SafishaExceptionRecord {
  code:        string;
  layer:       1 | 2 | 3 | 4 | 5 | 6;
  severity:    "error" | "warning" | "info";
  accountCode: string | null;
  message:     string;
}

interface CertifiedTBRowRecord {
  accountCode:    string | null;
  accountName:    string;
  nature:         "asset" | "liability" | "equity" | "income" | "expense";
  subNature:      string;
  debitBalance:   number;
  creditBalance:  number;
  netBalance:     number;
  // Ω∞ Phase 0 Slice 3 — reconciliation: 1-5 only, matching
  // TieredClassifyResult's "classified" variant exactly. A
  // CertifiedTBRowRecord is, by construction, ALWAYS a positively
  // classified account — buildCertifiedRows only ever runs after STEP 7
  // has confirmed zero needs_review accounts exist (see the early
  // `return` there), so no row here can ever represent an unmatched or
  // needs_review account. There is no "tier 6" state a certified row can
  // legitimately be in; the type no longer permits one.
  evidenceTier:   1 | 2 | 3 | 4 | 5;
  ruleId:         string | null;
  requiresReview: boolean;
  /** Present only for a trial balance split by dimension: the row's dimension values (several rows may share a code). */
  dimensions?:    Record<string, string>;
  /** E1: "tb-row/1" — the exact fields below are present. Rows without it are legacy. */
  rowContract?:   "tb-row/1";
  /** E1: exact debit and credit in minor units, as canonical decimal strings. */
  debitMinor?:    string;
  creditMinor?:   string;
  /** E1: the class-side amount (assets and expenses debit − credit; liabilities, equity, income credit − debit). */
  classSideMinor?: string;
}

function classificationToNature(cls: string): "asset" | "liability" | "equity" | "income" | "expense" {
  if (cls === "current_assets" || cls === "non_current_assets")           return "asset";
  if (cls === "current_liabilities" || cls === "non_current_liabilities") return "liability";
  if (cls === "equity")                                                  return "equity";
  if (cls === "revenue" || cls === "other_income")                       return "income";
  return "expense"; // cost_of_goods_sold, operating_expenses, taxes
}

// Ω∞ Phase 0 Slice 3 — D2: real per-account tier, no approximation. The
// classifier itself now tracks and returns the exact tier (1-5) that
// fired for each account (see TieredClassifyResult); this simply carries
// it through to the certified snapshot. Replaces the Slice 2 lossy
// confidence_source->tier guess entirely — that function collapsed
// tiers 1/2/3 into a single "1" and never actually emitted 2 or 3 for
// any live account, so no historical evidenceTier value is reinterpreted
// by removing it.

function buildCertifiedRows(
  accounts: RawAccount[],
  mappings: Map<string, AccountMapping>,
  tiers: Map<string, 1 | 2 | 3 | 4 | 5>,
): CertifiedTBRowRecord[] {
  const rows: CertifiedTBRowRecord[] = [];
  for (const account of accounts) {
    const key = accountKey(account);
    const m = mappings.get(key);
    if (!m) continue;
    // Invariant (relied on, not merely hoped for): resolvedMappings and
    // resolvedTiers are populated together, in the same STEP 6 branch, for
    // every account — and buildCertifiedRows itself is only ever called
    // after STEP 7 has confirmed needsReviewAccounts is empty (it returns
    // early otherwise). So a mapping existing for `key` here structurally
    // guarantees a tier also exists. If that guarantee were ever broken by
    // a future change, silently defaulting to a fabricated tier value
    // would write false provenance into an append-only, immutable
    // certification row — fail loudly instead, exactly like every other
    // "this should be structurally impossible" guard in this function.
    const tier = tiers.get(key);
    if (tier === undefined) {
      throw new Error(
        `[PTB] Internal invariant violation: account "${key}" has a resolved classification mapping but no tracked evidence tier. This should be structurally impossible — resolvedMappings and resolvedTiers must be populated together.`,
      );
    }
    // LEGACY meaning, unchanged: netBalance is signed by normal_balance (MAONO and every older certification read it this
    // way). The exact, class-side figure is classSideMinor; consumers move to it in E2.
    const signed = m.normal_balance === "debit"
      ? account.debit - account.credit
      : account.credit - account.debit;
    const side = classSideOf(m.classification);
    if (!side) {
      throw new Error(`[PTB] Internal invariant violation: certified account "${key}" is on classification "${m.classification}", which is not on the balance sheet or income statement.`);
    }
    rows.push({
      accountCode:    account.account_code,
      accountName:    account.account_name,
      nature:         classificationToNature(m.classification),
      subNature:      m.classification,
      debitBalance:   account.debit,
      creditBalance:  account.credit,
      netBalance:     signed,
      evidenceTier:   tier,
      ruleId:         null,
      requiresReview: false,
      ...(Object.keys(account.dimensions).length > 0 ? { dimensions: account.dimensions } : {}),
      rowContract:    TB_ROW_FORMAT,
      debitMinor:     account.debitMinor.toString(),
      creditMinor:    account.creditMinor.toString(),
      classSideMinor: classSideMinor(side, account.debitMinor, account.creditMinor).toString(),
    });
  }
  return rows;
}

// ── Ω∞ Phase 0 Slice 4A — L5 (supporting evidence) / L6 (prior-period
// evidence), jurisdiction-neutral by construction ─────────────────────────
//
// PHASE0-GLOBAL-L5-RECONCILIATION-001: SAFF core is jurisdiction-neutral.
// L5 reads ONLY trial_balance_uploads.safisha_status and
// safisha_reconciliations' generic counts — both written exclusively by
// the generic bank/subledger pipeline (safisha-ingest / safisha-match /
// the safisha_resolve_exception() RPC; confirmed by exhaustive repo grep:
// safisha-efdms-ingest never touches either). Zero references to
// efdms_z_reports, efdms_reconciliation, variance_materiality, or
// tax_computations exist anywhere below — that is a hard invariant, not
// an implementation detail (see l5l6Evidence.test.ts's contamination
// check, which greps this file for exactly those names).
//
// PHASE0-ARCHITECTURE-RECONCILIATION-001: no safisha-validate-tb function
// is created. process-trial-balance remains the evolved authoritative
// certification path; this is additive evidence collection inside it.

type Phase0EvidenceState =
  | "NOT_EVALUATED" | "INSUFFICIENT_CONTEXT" | "NO_EVIDENCE"
  | "NO_DIFFERENCE" | "UNRESOLVED_EVIDENCE";

interface Phase0Evidence {
  layer5Exceptions: SafishaExceptionRecord[];
  layer6Exceptions: SafishaExceptionRecord[];
}

/**
 * L5 — supporting evidence. Informational/review only, never authoritative:
 * this function only ever returns severity "info"/"warning" entries and
 * NEVER influences is_blocking/requires_review at any call site — that
 * remains entirely the calling branch's own decision, made independently
 * before this evidence is appended.
 *
 * NO_EVIDENCE vs NO_DIFFERENCE (hard invariant, never collapsed): a
 * 'clean' safisha_status only becomes NO_DIFFERENCE if the reconciliation
 * actually evaluated something (total_tb_lines/matched_count+exception_
 * count > 0). A 'clean' status with nothing actually evaluated — which
 * should not occur given safisha-ingest's own flow, but is not assumed —
 * is reported as the LESS assuring NO_EVIDENCE instead, per "never
 * manufacture assurance."
 */
async function collectLayer5SupportingEvidence(
  supabase: ReturnType<typeof createClient>,
  uploadId: string,
): Promise<SafishaExceptionRecord[]> {
  const { data: uploadRow } = await supabase
    .from("trial_balance_uploads")
    .select("safisha_status")
    .eq("id", uploadId)
    .maybeSingle();
  const status = (uploadRow as { safisha_status: string | null } | null)?.safisha_status ?? null;

  let state: Phase0EvidenceState;
  let severity: "info" | "warning";
  let detail = "";

  if (status === null) {
    state = "NOT_EVALUATED";
    severity = "info";
    detail = "no supporting-evidence reconciliation has been run for this upload";
  } else if (status === "processing") {
    state = "INSUFFICIENT_CONTEXT";
    severity = "warning";
    detail = "supporting-evidence reconciliation is in progress and has not concluded";
  } else if (status === "clean") {
    const { data: reconRow } = await supabase
      .from("safisha_reconciliations")
      .select("matched_count, exception_count, total_tb_lines")
      .eq("tb_upload_id", uploadId)
      .maybeSingle();
    const recon = reconRow as { matched_count: number; exception_count: number; total_tb_lines: number } | null;
    const evaluatedSomething = !!recon && (recon.total_tb_lines > 0 || recon.matched_count > 0 || recon.exception_count > 0);
    if (evaluatedSomething) {
      state = "NO_DIFFERENCE";
      severity = "info";
      detail = `supporting evidence evaluated with no unresolved difference (matched=${recon!.matched_count}, exceptions=${recon!.exception_count})`;
    } else {
      // 'clean' but nothing was actually evaluated -- never claim a
      // successful reconciliation over an empty comparison.
      state = "NO_EVIDENCE";
      severity = "info";
      detail = "no meaningful supporting evidence was available to evaluate";
    }
  } else if (status === "needs_review" || status === "blocked") {
    state = "UNRESOLVED_EVIDENCE";
    severity = "warning";
    detail = status === "blocked"
      ? "supporting-evidence reconciliation reported BLOCKED (unresolved exceptions rejected on review) -- observed as evidence only, does not itself block this certification"
      : "supporting-evidence reconciliation has unresolved exceptions pending review";
  } else {
    // Any unrecognized value -- fail toward the least-assuring state
    // rather than guess at its meaning.
    state = "INSUFFICIENT_CONTEXT";
    severity = "warning";
    detail = `unrecognized supporting-evidence status value "${status}"`;
  }

  return [{
    code: "L5_SUPPORTING_EVIDENCE",
    layer: 5,
    severity,
    accountCode: null,
    message: `${state}: ${detail}`,
  }];
}

/**
 * L6 — prior-period evidence. Minimum three-state signal only
 * (prior_certified | no_prior | insufficient_evidence) -- no balance
 * comparison, no movement analysis, no Phase 4 comparative engine.
 * Reuses get_authoritative_certification exactly as designed; no
 * authority predicate is reproduced here.
 */
async function collectLayer6PriorPeriodEvidence(
  supabase: ReturnType<typeof createClient>,
  companyId: string,
  periodYear: number | null,
): Promise<SafishaExceptionRecord[]> {
  if (periodYear === null) {
    return [{
      code: "L6_PRIOR_PERIOD_SIGNAL", layer: 6, severity: "info", accountCode: null,
      message: "INSUFFICIENT_EVIDENCE: current period identity is unavailable, prior period cannot be derived",
    }];
  }

  // period_year is a real annual calendar-year integer (server-synced from
  // fiscal_year_end via trg_sync_upload_period_year, migration
  // 20260709082906; CLAUDE.md's own documented convention: "periodYear =
  // 4-digit integer ... NEVER a DB timestamp or upload ID") -- period_year
  // - 1 is therefore a proven, deterministic "immediately prior period"
  // under the CURRENT single-annual-period model. This is not re-derived
  // for a future multi-period-per-year model without new evidence.
  const priorPeriodYear = periodYear - 1;

  const { data: priorCert } = await supabase.rpc("get_authoritative_certification", {
    p_company_id: companyId,
    p_period_year: priorPeriodYear,
  } as never);
  const priorCertRows = priorCert as unknown[] | null;
  const hasAuthoritativePrior = Array.isArray(priorCertRows) && priorCertRows.length > 0;

  return [{
    code: "L6_PRIOR_PERIOD_SIGNAL", layer: 6, severity: "info", accountCode: null,
    message: hasAuthoritativePrior
      ? `PRIOR_CERTIFIED: an authoritative certification exists for period ${priorPeriodYear}`
      : `NO_PRIOR: no authoritative certification exists for period ${priorPeriodYear}`,
  }];
}

/**
 * ONE deterministic collection path for L5+L6, called exactly once per
 * request (right after the idempotency claim succeeds) and reused
 * verbatim on every certification-construction branch that follows
 * (blocking, needs_review, valid) -- never re-queried per branch, never
 * copy-pasted. Fixed L5-then-L6 append order keeps output deterministic
 * for the same input/evidence state; no timestamp is ever included in
 * either message.
 */
async function collectPhase0Evidence(
  supabase: ReturnType<typeof createClient>,
  params: { companyId: string; periodYear: number | null; uploadId: string },
): Promise<Phase0Evidence> {
  const layer5Exceptions = await collectLayer5SupportingEvidence(supabase, params.uploadId);
  const layer6Exceptions = await collectLayer6PriorPeriodEvidence(supabase, params.companyId, params.periodYear);
  return { layer5Exceptions, layer6Exceptions };
}

/**
 * Commits a SAFISHA certification and terminates this engine_run —
 * commit_tb_certification completes both engine_runs and idempotency_keys
 * atomically inside one transaction (Slice 1 design); this function never
 * calls completeIdempotency/recordEngineRunComplete separately (Slice 2
 * directive Priority 6). If the RPC itself fails (thrown exception — the
 * whole RPC call rolls back, nothing is written), that is a genuine system
 * failure, not a SAFISHA outcome — falls back to recordEngineRunFailed +
 * failIdempotency so the run/claim are never left stuck at running/reserved.
 */
async function commitSafishaCertification(
  supabase: ReturnType<typeof createClient>,
  params: {
    engineRunId: string;
    idempotencyKeyId: string;
    engineStartedAt: string;
    uploadId: string;
    companyId: string;
    periodYear: number | null;
    sourceFileHash: string;
    normalizedInputHash: string;
    isBlocking: boolean;
    requiresReview: boolean;
    exceptions: SafishaExceptionRecord[];
    rowsSnapshot: CertifiedTBRowRecord[];
  },
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const outputHashSource: CanonicalValue = (params.rowsSnapshot.length > 0
    ? params.rowsSnapshot
    : params.exceptions) as unknown as CanonicalValue;
  const outputHash = await sha256Hex(canonicalJson(outputHashSource));

  const { error } = await supabase.rpc("commit_tb_certification", {
    p_engine_run_id:         params.engineRunId,
    p_expected_function_name: "process-trial-balance",
    p_upload_id:              params.uploadId,
    p_company_id:             params.companyId,
    p_period_year:            params.periodYear,
    p_source_file_hash:       params.sourceFileHash,
    p_normalized_input_hash:  params.normalizedInputHash,
    p_output_hash:            outputHash,
    p_is_blocking:            params.isBlocking,
    p_requires_review:        params.requiresReview,
    p_exceptions:             params.exceptions,
    p_rows_snapshot:          params.rowsSnapshot,
  } as never);

  if (error) {
    console.error("[PTB] commit_tb_certification failed:", error.message);
    await recordEngineRunFailed(supabase as never, params.engineRunId, {
      startedAt: params.engineStartedAt,
      errorCode: "CERTIFICATION_COMMIT_FAILED",
      errorDetail: { stage: "commit_tb_certification", safe_message: String(error.message ?? "unknown").slice(0, 200) },
    });
    await failIdempotency(supabase as never, params.idempotencyKeyId, "CERTIFICATION_COMMIT_FAILED");
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ status: "blocked", error: "Certification could not be recorded" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      ),
    };
  }
  return { ok: true };
}

// ── Main Handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const allErrors: ValidationError[] = [];
  // Declared here (not inside the try block) so the catch block below can
  // fail an already-claimed engine_run/idempotency reservation on a fatal,
  // unhandled error — never leave one stuck at running/reserved.
  let engineRunId: string | null = null;
  let idempotencyKeyId: string | null = null;
  let engineStartedAt: string | null = null;
  // Ω∞ Phase 0 Slice 4A — collected once (see collectPhase0Evidence), reused
  // verbatim on every certification-construction branch that follows.
  let phase0Evidence: Phase0Evidence | null = null;
  // What processing actually reached, in order (returned and stored in processing_result.ingestion.milestones).
  const milestones = new MilestoneLog();
  // The status the upload had when this request arrived, and whether this request has replaced it with
  // "validating" — so no exit (an exception, a replay, a conflict) leaves an upload stuck at "validating".
  let priorStatus: string | null = null;
  let statusClaimed = false;
  let claimedUploadId: string | null = null;

  try {
    const auth = await validateAuth(req.headers.get("Authorization"));
    if (auth.error) return auth.error;
    const userId = auth.userId!;

    const { uploadId, clientRequestId } = await req.json();
    if (!uploadId) throw new Error("uploadId is required");

    // Ω∞ Phase 0 Slice 2 — caller-supplied request identity. A server-
    // generated UUID here defeats real request-level idempotency (a retry
    // of the same logical action always got a fresh, unmatchable identity)
    // — this must come from the caller so a genuine network retry reuses
    // it while a new user-triggered processing action gets a new one.
    // REQUIRED, no server-generated fallback: a fallback would silently
    // preserve the exact broken replay semantics this closes. Distinct
    // from request_hash/source_file_hash/normalized_input_hash — this is
    // the request's own identity/key, not a proof of what it contains.
    if (typeof clientRequestId !== "string" || !UUID_PATTERN.test(clientRequestId)) {
      return new Response(
        JSON.stringify({ error: "Bad Request", message: "clientRequestId is required and must be a valid UUID" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(`[PTB v2.0] Processing upload ${uploadId} for user ${userId}`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase    = createClient(supabaseUrl, supabaseKey);

    const { data: upload, error: uploadError } = await supabase
      .from("trial_balance_uploads").select("*").eq("id", uploadId).single();
    // A missing row answers exactly like someone else's upload: 403, same body (existence is never revealed).
    if (uploadError || !upload) {
      return new Response(JSON.stringify(PROCESSING_FORBIDDEN), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Authorization (user-based, PR #32 / 20260923120000) ──
    // A company-scoped upload may be validated by an accepted firm member of upload.company_id (unchanged), or
    // by the workspace owner / an explicit prepare_trial_balance or manage_source_files grant holder with no
    // firm membership at all (actor_type 'workspace_user', actor_user_id = the JWT user). The database decides
    // (tbu_resolve_processing_actor); nothing in the request body is read. Legacy uploads with no company_id
    // keep the original-uploader rule.
    // Ω∞ Phase 0 Slice 2: company-scoped uploads now resolve the canonical
    // firmMemberId actor (Iron Dome §4.3) via the shared resolver instead of
    // an inline membership check that only proved membership, never derived
    // an actor identity. Legacy uploads with no company_id (upload.company_id
    // null) cannot be SAFISHA-certified — tb_certifications.company_id is
    // NOT NULL — so that branch is preserved exactly as-is and SAFISHA
    // wiring below is skipped entirely for them (resolvedActor stays null).
    let resolvedActor: ProcessingActor | null = null;
    if (upload.company_id) {
      resolvedActor = await resolveProcessingActor(
        (name, args) => supabase.rpc(name, args), userId, upload.company_id,
      );
      if (!resolvedActor) {
        return new Response(
          JSON.stringify({ error: "Forbidden", message: "You don't have permission to validate trial balances in this workspace." }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    } else {
      // P-01 (PR #32): a PERSONAL upload (no workspace) is processed only for its own uploader, trial_balance_uploads.user_id.
      // A NULL or malformed owner, or any other caller, is refused here: before any actor lookup, storage read, parse,
      // database write or disclosure of the row. (The table has no uploaded_by column; the previous check read it and
      // therefore never refused anyone.)
      const notOwner = personalUploadRefusal((upload as { user_id?: unknown }).user_id, userId);
      if (notOwner) {
        return new Response(JSON.stringify(notOwner), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // P-1 (PR #34): processing needs a current plan for the upload's governing account (the workspace account, or the
    // uploader of a personal upload). Asked of the database authority right after authorization and BEFORE the
    // lifecycle and source-binding lookups, any Storage access, any write, hash, parse, validation or engine run, for
    // every upload (workspace or personal, active or historical). Existing records remain readable.
    const noPlan = await processingEntitlementRefusal((name, args) => supabase.rpc(name, args), userId, uploadId);
    if (noPlan) {
      // A 403 here (authorization changed in between) answers exactly like any other refusal of access.
      const body = noPlan.httpStatus === 403 ? PROCESSING_FORBIDDEN : noPlan.body;
      return new Response(JSON.stringify(body), { status: noPlan.httpStatus, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // F-01 (PR #32): only an ACTIVE upload is processed. A retired, superseded, discarded or discard_pending upload
    // is history; the database refuses these writes too (trg_tbu_history_immutable). Refused before any mutation.
    const notActive = processingRefusal((upload as { lifecycle_state?: unknown }).lifecycle_state);
    if (notActive) {
      return new Response(JSON.stringify(notActive), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // N-02 (PR #32): the source path must be canonically bound to THIS upload (its own consumed workspace
    // reservation, or its uploader's own folder). Checked before storage is touched, so the answer never reveals
    // whether some other object exists.
    const { data: sourceBound, error: bindErr } = await supabase.rpc("tbu_upload_source_bound", { p_upload_id: uploadId });
    const unbound = sourceBindingRefusal(bindErr ? null : sourceBound);
    if (unbound) {
      return new Response(JSON.stringify(unbound), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // The reporting period and currency this trial balance was uploaded for. Read before anything is mutated; a
    // lookup error is a processing failure (thrown), never "no currency".
    const reportingCurrency = await resolveReportingCurrency(supabase as never, upload as { company_id?: string | null; period_id?: string | null; engagement_id?: string | null });

    // The status as it is BEFORE this request writes anything — what every early exit restores.
    priorStatus = (upload as { status?: string | null }).status ?? null;

    // Only after ownership AND the plan are confirmed do we mutate the upload row. The database processing wall
    // (trg_tbu_processing_wall) refuses this write too without a current plan: the error is checked, never ignored,
    // so a plan that ended in between answers the same structured 402 and Storage is never touched.
    const { error: claimErr } = await supabase.from("trial_balance_uploads").update({ status: "validating" }).eq("id", uploadId);
    if (claimErr) {
      if (isEntitlementWallError(claimErr)) {
        const wall = paidActionRefusal("CLOSE_ASSURANCE", { allowed: false, code: "ENTITLEMENT_REQUIRED", required_plan: "SOLO" })!;
        return new Response(JSON.stringify(wall.body), { status: wall.httpStatus, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      console.error("[PTB] status claim failed:", (claimErr as { code?: string }).code ?? "unknown");
      return new Response(JSON.stringify(PROCESSING_UNAVAILABLE), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    statusClaimed = true;
    claimedUploadId = uploadId;

    const { data: fileData, error: downloadError } = await supabase.storage
      .from("trial-balance-files").download(upload.file_path);
    if (downloadError || !fileData) {
      // L-1 / L-2: classify from structured fields (confirmed not-found → source_missing; anything else →
      // processing_unavailable), restore the previous status with a CHECKED write, and answer from its result (a plan
      // that ended concurrently → the controlled 402). Nothing else is written; no raw error reaches the response.
      const classification = classifyDownloadFailure(downloadError);
      const { error: restoreErr } = await supabase.from("trial_balance_uploads").update({ status: upload.status }).eq("id", uploadId);
      statusClaimed = false;
      const outcome = sourceFailureOutcome(classification, restoreErr, downloadError);
      console.error("[PTB] source download failed", JSON.stringify({ upload_id: uploadId, ...outcome.log }));
      return new Response(JSON.stringify(outcome.body), { status: outcome.httpStatus, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── STEP 1: Read the source and run the ingestion core ────────────────────
    // _shared/tbIngestion.ts (exact minor-unit money, explicit period and currency, one identity per account, safe
    // totals, complete row lineage) via _shared/tbSource.ts — the same code the vitest suite runs on representative
    // and adversarial files (src/lib/ingestion/tbIngestion.test.ts).
    console.log(`[PTB] Detected file: ${upload.file_name}`);

    // Ω∞ Phase 0 Slice 2 — Priority 3: server-authoritative source_file_hash, computed from the exact downloaded
    // bytes before any format-specific parsing touches them (raw bytes, never a re-encoded copy). Persisted
    // immediately and independently of everything downstream: it is observational truth about the current Storage
    // bytes, and Slice 1R's source-hash-drift check in get_authoritative_certification depends on it being recorded
    // even when this attempt later blocks or fails. The write is checked and hard-stops on failure
    // (DEFECT-SAFISHA-SOURCE-HASH-WRITE-FAILURE-STALE-AUTHORITY-001).
    const fileBuffer = await fileData.arrayBuffer();
    const sourceFileHash = await sha256HexBytes(fileBuffer);
    const { error: sourceHashUpdateError } = await supabase
      .from("trial_balance_uploads")
      .update({ source_file_hash: sourceFileHash })
      .eq("id", uploadId);
    if (sourceHashUpdateError) {
      throw new Error(`Failed to persist source_file_hash: ${sourceHashUpdateError.message}`);
    }

    const fileBytes = new Uint8Array(fileBuffer);
    const readContext = { fileName: upload.file_name ?? "", periodYear: upload.period_year ?? null, currency: reportingCurrency };
    let ingest: IngestResult;
    const workbook = detectSourceFormat(readContext.fileName) === "xlsx" ? tryReadWorkbook(fileBytes) : null;
    if (workbook && isAuditedAccountsFormat(workbook)) {
      // Audited financial statements (SCI + SFP sheets) are converted to a flat trial balance first; its row numbers
      // are positions in that reconstructed table.
      const meta = getAuditedAccountsMetadata(workbook);
      console.log(`[PTB] Detected AUDITED ACCOUNTS format — SCI: "${meta.sci_sheet}", SFP: "${meta.sfp_sheet}", Notes: "${meta.notes_sheet}"`);
      ingest = ingestTrialBalance({
        rows: sheetRowsFromMatrix(parseAuditedAccounts(workbook) as Cell[][], 1),
        sheetName: `AUDITED_ACCOUNTS (SCI="${meta.sci_sheet}", SFP="${meta.sfp_sheet}")`,
        periodYear: readContext.periodYear, currency: readContext.currency,
      });
    } else {
      ingest = readTrialBalanceSource(fileBytes, readContext, XLSX as unknown as XlsxLike);
    }
    markIngestionMilestones(milestones, ingest);
    for (const issue of ingest.issues) allErrors.push(issueToValidationError(issue));
    const detectedCols = ingest.columns;
    const exponent = ingest.exponent ?? 0;
    const rawAccounts: RawAccount[] = ingest.accounts.map((a) => ({
      account_code: a.accountCode,
      account_name: a.accountName,
      debit: minorToNumber(a.debitMinor, exponent),
      credit: minorToNumber(a.creditMinor, exponent),
      balance: minorToNumber(a.debitMinor - a.creditMinor, exponent),
      source_row_number: a.sourceRowNumber,
      identity: a.identity,
      dimensions: a.dimensions,
      debitMinor: a.debitMinor,
      creditMinor: a.creditMinor,
    }));
    const rejectedRows = ingest.lineage.filter((l) => l.disposition === "rejected" || l.disposition === "total" || l.disposition === "zero_balance");
    console.log(`[PTB] Ingested ${ingest.lineageSummary.rowsRead} rows → ${rawAccounts.length} accounts; ${ingest.issues.length} issue(s)`);

    if (rawAccounts.length === 0) {
      // Nothing identifiable as an account (unreadable file, missing columns, no period or currency, …). A pre-flight
      // input-shape failure: no idempotency claim has happened, so there is no engine_run to fail.
      milestones.mark("recorded", "passed");
      const result: Partial<ProcessingResult> = {
        status: "blocked", statements: null, errors: allErrors,
        validation_report: { ingestion_check: { passed: false } },
        summary: { total_accounts: 0, processed_at: new Date().toISOString(), parser_version: PARSER_VERSION, columns_detected: detectedCols, auto_classified: 0 },
        ingestion: ingestionRecord(ingest, milestones),
      };
      const failed = await writeOutcome(supabase as never, uploadId, { status: "blocked", is_valid: false, accounting_errors: allErrors, processing_result: result, processed_at: new Date().toISOString() });
      if (failed) return failed;
      return new Response(JSON.stringify(result), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Ω∞ Phase 0 Slice 2 — idempotency claim + engine_run creation ─────────
    // Deliberately placed HERE, not before download/parse: normalized_input_hash is the true input identity.
    // source_file_hash, normalized_input_hash and client_request_id are three separate identities (exact bytes /
    // canonical parsed input / retry identity); none stands in for another. Skipped for legacy company_id-null uploads.
    const normalizedInputHash = await computeNormalizedInputHash(
      rawAccounts.map((a): NormalizedInputRow => ({ accountCode: a.account_code, accountName: a.account_name, debit: a.debit, credit: a.credit })),
    );

    if (resolvedActor && upload.company_id) {
      const requestHash = await sha256Hex(canonicalJson({ uploadId, sourceFileHash, normalizedInputHash } as unknown as CanonicalValue));
      const claim = await claimIdempotency(supabase as never, {
        companyId: upload.company_id,
        actor: resolvedActor,
        actorType: resolvedActor.actorType,
        functionName: "process-trial-balance",
        engineVersion: SAFISHA_ENGINE_VERSION,
        engineGeneration: ENGINE_GENERATION,
        clientRequestId,
        requestHash,
        inputHash: normalizedInputHash,
        periodYear: upload.period_year ?? null,
        sourceTable: "trial_balance_uploads",
        sourceRecordId: uploadId,
      });

      if (claim.outcome !== "claimed") {
        // A retry of a request that already ran (replay) or that reused its identity for different content
        // (conflict) does not process — and must not leave behind the "validating" mark this attempt set: the upload
        // returns to the status it had when this request arrived, so a replay keeps the original run's recorded
        // outcome. An in-progress run keeps "validating"; it is genuinely running.
        if (claim.outcome !== "in_progress") await restoreStatus(supabase as never, uploadId, priorStatus);
        statusClaimed = false;
      }
      if (claim.outcome === "conflict") {
        return new Response(
          JSON.stringify({ status: "blocked", error: "Idempotency conflict", message: "This request was already used for different file content. Start a new check of the current file." }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (claim.outcome === "in_progress") {
        return new Response(
          JSON.stringify({ status: "in_progress", message: "This upload is already being checked." }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (claim.outcome === "replay") {
        return new Response(
          JSON.stringify({ status: claim.result.status, replay: true, reference_id: claim.result.reference_id ?? null }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      engineRunId      = claim.engineRunId;
      idempotencyKeyId = claim.keyId;
      engineStartedAt  = claim.startedAt;

      // E1 (Amendment 2, C6): a new run on an upload whose latest certification is still in force is refused. Every
      // re-check goes through tbu_request_reprocess, which invalidates that certification first, so a failed re-run
      // can never leave the earlier result current. Checked after the claim, so a retry of the SAME request replays
      // above instead; the claimed run is recorded as failed and the upload returns to its prior status.
      const { data: latestCert, error: latestCertError } = await supabase
        .from("tb_certifications").select("id").eq("upload_id", uploadId).order("sequence_no", { ascending: false }).limit(1).maybeSingle();
      if (latestCertError) throw new Error(`latest certification lookup failed: ${latestCertError.message}`);
      if (latestCert) {
        const { data: invalidation, error: invalidationError } = await supabase
          .from("tb_certification_invalidations").select("id").eq("certification_id", (latestCert as { id: string }).id).maybeSingle();
        if (invalidationError) throw new Error(`invalidation lookup failed: ${invalidationError.message}`);
        if (!invalidation) {
          await recordEngineRunFailed(supabase as never, engineRunId, {
            startedAt: engineStartedAt, errorCode: "REPROCESS_REQUIRED",
            errorDetail: { stage: "reprocess_gate", safe_message: "the latest certification is still in force" },
          });
          await failIdempotency(supabase as never, idempotencyKeyId, "REPROCESS_REQUIRED");
          await restoreStatus(supabase as never, uploadId, priorStatus);
          statusClaimed = false;
          return new Response(
            JSON.stringify({ status: "blocked", code: "REPROCESS_REQUIRED", message: "This trial balance already has a recorded result. Request a new check to process it again." }),
            { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Ω∞ Phase 0 Slice 4A — ONE collection path, called exactly once here, reused on every certification branch.
      phase0Evidence = await collectPhase0Evidence(supabase as never, {
        companyId: upload.company_id, periodYear: upload.period_year ?? null, uploadId,
      });
    }

    // ── STEP 2: Ingestion integrity gate ──────────────────────────────────────
    // Any blocking ingestion issue (malformed or over-precise amounts, a duplicate identity, a missing code, a total
    // row that disagrees, a contradicting period or currency, an imbalance by even one minor unit) is a real SAFISHA
    // outcome, not an infrastructure exception: the engine executed and reached a definitive, describable conclusion,
    // so a blocking certification is committed. Nothing is rounded, merged or defaulted to make the file pass.
    const ingestTotals = ingest.totals!;
    const exactTotals = {
      currency: ingest.currency,
      currency_exponent: ingest.exponent,
      total_debits: formatMinor(ingestTotals.debitMinor, exponent),
      total_credits: formatMinor(ingestTotals.creditMinor, exponent),
      difference: formatMinor(ingestTotals.differenceMinor < 0n ? -ingestTotals.differenceMinor : ingestTotals.differenceMinor, exponent),
    };
    const totalDebits  = minorToNumber(ingestTotals.debitMinor, exponent);
    const totalCredits = minorToNumber(ingestTotals.creditMinor, exponent);
    const blockingIssues = ingest.issues.filter((i) => i.severity === "blocking");
    if (blockingIssues.length > 0) {
      const imbalanced = blockingIssues.some((i) => i.code === "TRIAL_BALANCE_IMBALANCE");
      const result: Partial<ProcessingResult> = {
        status: "blocked",
        statements: null,
        errors: allErrors,
        validation_report: {
          ingestion_check: { passed: false, blocking_issues: blockingIssues.length },
          // The balance check runs only on a complete, readable set of accounts; otherwise it is not computed (null).
          tb_balance_check: imbalanced
            ? { passed: false, total_debits: totalDebits, total_credits: totalCredits, difference: minorToNumber(ingestTotals.differenceMinor < 0n ? -ingestTotals.differenceMinor : ingestTotals.differenceMinor, exponent), exact: exactTotals }
            : null,
        },
        summary: { total_accounts: rawAccounts.length, processed_at: new Date().toISOString(), parser_version: PARSER_VERSION, columns_detected: detectedCols, auto_classified: 0, rejected_rows: rejectedRows },
      };
      if (engineRunId && idempotencyKeyId && engineStartedAt && upload.company_id) {
        const commit = await commitSafishaCertification(supabase as never, {
          engineRunId, idempotencyKeyId, engineStartedAt,
          uploadId, companyId: upload.company_id, periodYear: upload.period_year ?? null,
          sourceFileHash, normalizedInputHash,
          isBlocking: true, requiresReview: false,
          exceptions: [
            ...blockingIssues.map((i): SafishaExceptionRecord => ({
              code: i.code, layer: i.code === "TRIAL_BALANCE_IMBALANCE" ? 3 : 2, severity: "error", accountCode: null, message: i.message,
            })),
            ...(phase0Evidence?.layer5Exceptions ?? []),
            ...(phase0Evidence?.layer6Exceptions ?? []),
          ],
          rowsSnapshot: [],
        });
        if (!commit.ok) return commit.response;
      }
      milestones.mark("recorded", "passed");
      result.ingestion = ingestionRecord(ingest, milestones);
      const failed = await writeOutcome(supabase as never, uploadId, { status: "blocked", is_valid: false, accounting_errors: allErrors, processing_result: result, processed_at: new Date().toISOString() });
      if (failed) return failed;
      return new Response(JSON.stringify(result), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── STEP 5: Load account_mappings (company-scoped + global) and keyword_dictionary ──
    // All data fetched ONCE; all matching is in-memory (no per-account DB queries).

    const companyId: string | null = upload.company_id ?? null;
    console.log(`[PTB] company_id: ${companyId ?? "none"}`);

    const { data: company } = companyId
      ? await supabase
          .from("companies")
          .select("reporting_framework")
          .eq("id", companyId)
          .single()
      : { data: null };
    const reportingFramework = company?.reporting_framework ?? null;
    console.log(`[PTB] reporting_framework: ${reportingFramework ?? "not set"}`);

    const { data: rawMappings } = await supabase
      .from("account_mappings")
      .select("*")
      .or(companyId ? `company_id.eq.${companyId},company_id.is.null` : "company_id.is.null");

    const companyByCode = new Map<string, AccountMapping>(); // Tier 1
    const companyByName = new Map<string, AccountMapping>(); // Tier 2
    const globalByCode  = new Map<string, AccountMapping>(); // Tier 3 (code)
    const globalByName  = new Map<string, AccountMapping>(); // Tier 3 (name)

    for (const m of (rawMappings ?? [])) {
      const mapping: AccountMapping = {
        account_code:         m.account_code,
        account_name:         m.account_name,
        statement:            m.statement,
        classification:       m.classification,
        line_item:            m.line_item,
        normal_balance:       m.normal_balance,
        is_cash_account:      m.is_cash_account      ?? false,
        is_retained_earnings: m.is_retained_earnings ?? false,
        is_payroll_account:   m.is_payroll_account   ?? false,
        review_decision_id:   typeof m.review_decision_id === "string" && m.review_decision_id.length > 0 ? m.review_decision_id : null,
      };
      // S1 provenance: a company row is the company's REVIEWED mapping only when it carries review_decision_id. The
      // database (trg_account_mappings_provenance) accepts that link only for a decision of the same company and account
      // key, with an approving action and identical seven-field content, and clears it on any later content, company or
      // key change — so a present link is the contract. Anything else is a suggestion (Tier 3: always needs review). A
      // database without the column (pre-S1) has no links: every company row is a suggestion (fails safe).
      const isCompanyRow = companyId != null && m.company_id === companyId;
      const reviewed     = isCompanyRow && typeof m.review_decision_id === "string" && m.review_decision_id.length > 0;
      if (reviewed) {
        mapping.provenance = "reviewed";
        if (m.account_code)            companyByCode.set(m.account_code, mapping);
        if (m.normalized_account_name) companyByName.set(m.normalized_account_name, mapping);
      } else if (isCompanyRow || m.company_id == null) {
        mapping.provenance = isCompanyRow ? "unconfirmed_company" : "shared";
        // Deterministic precedence among suggestions: this company's own unconfirmed row over a shared row.
        const put = (map: Map<string, AccountMapping>, key: string) => {
          if (!isCompanyRow && map.get(key)?.provenance === "unconfirmed_company") return;
          map.set(key, mapping);
        };
        if (m.account_code)            put(globalByCode, m.account_code);
        if (m.normalized_account_name) put(globalByName, m.normalized_account_name);
      }
      // Any other company's row is never used (the query already excludes it; this is the second guard).
    }
    console.log(`[PTB] Mappings loaded — reviewed company: ${companyByCode.size} by code / ${companyByName.size} by name, suggestions (unconfirmed company + shared): ${globalByCode.size} / ${globalByName.size}`);

    const { data: rawKwd } = await supabase
      .from("keyword_dictionary")
      .select("id, term, language, classification, match_type");
    const kwdExact:    KeywordRow[] = [];
    const kwdContains: KeywordRow[] = [];
    for (const k of (rawKwd ?? [])) {
      if (k.match_type === "exact") kwdExact.push(k as KeywordRow);
      else                          kwdContains.push(k as KeywordRow);
    }
    console.log(`[PTB] keyword_dictionary: ${kwdExact.length} exact, ${kwdContains.length} contains`);

    // ── STEP 5.5 (Ω∞ Phase 2A): pre-classifier professional authority ─────────
    // Batched (not N+1) authoritative lookup for the latest effective
    // MARK_NON_REPORTING_ACCOUNT professional decision, per account. This runs
    // BEFORE classifyAccountTiered is ever invoked — professional decision
    // authority sits above machine/rule classification. classifyAccountTiered
    // itself, its 6 tiers, and every existing mapping/keyword/regex path below
    // are untouched; this only decides whether that function is called at all
    // for a given account. Identity-drift guard is applied server-side inside
    // get_effective_non_reporting_status() — see migration 20260816120000.
    const professionalState = new Map<string, { suppressed: boolean; staleReason: string | null }>();
    if (companyId && rawAccounts.length > 0) {
      const { data: effectiveStatus, error: effectiveStatusError } = await supabase.rpc(
        "get_effective_non_reporting_status",
        {
          p_company_id: companyId,
          p_accounts: rawAccounts.map(a => ({ account_code: a.account_code, account_name: a.account_name })),
        },
      );
      if (effectiveStatusError) {
        console.error("[PTB] get_effective_non_reporting_status failed:", effectiveStatusError.message);
        // Fail open to the pre-existing classifier path — never block processing
        // on this new, additive check; professional decisions simply won't
        // suppress anything for this run if the lookup itself errors.
      } else {
        for (const row of (effectiveStatus ?? [])) {
          const key = accountJoinKey(row.account_code, row.account_name);
          professionalState.set(key, { suppressed: row.suppressed, staleReason: row.stale_reason });
        }
      }
    }
    console.log(`[PTB] Professional non-reporting state: ${[...professionalState.values()].filter(v => v.suppressed).length} effective suppressions`);

    // ── STEP 6: 6-tier classification (in-memory only) ────────────────────────
    // account_mappings is NOT written here. That table holds user-approved mappings
    // only. Auto-classified and dictionary-matched results live in processing_result
    // tagged with confidence_source. The PART 4 review screen is the sole writer.

    const resolvedMappings     = new Map<string, AccountMapping>();
    // Ω∞ Phase 0 Slice 3 — D2: the REAL tier (1-5) per resolved account,
    // keyed identically to resolvedMappings — feeds CertifiedTBRow.
    // evidenceTier (buildCertifiedRows) with the classifier's own actual
    // evidence tier, not a confidence_source-derived guess.
    const resolvedTiers = new Map<string, 1 | 2 | 3 | 4 | 5>();
    const needsReviewAccounts: NeedsReviewAccount[]       = [];
    const nonReportingAccounts: NonReportingAccount[]     = [];
    let autoClassifiedCount = 0;
    // A classification decision is per account code (account_mappings.account_key), so rows of one code split by a
    // dimension (cost centre, department, …) are reviewed ONCE: one entry per code, amounts combined. Their own rows
    // stay separate in the lineage and, once reviewed, in the certified rows.
    const reviewByCode = new Map<string, NeedsReviewAccount>();
    const queueReview = (entry: NeedsReviewAccount) => {
      const existing = reviewByCode.get(entry.account_code);
      if (!existing) {
        reviewByCode.set(entry.account_code, entry);
        needsReviewAccounts.push(entry);
        return;
      }
      existing.debit += entry.debit;
      existing.credit += entry.credit;
      existing.balance += entry.balance;
    };

    for (const account of rawAccounts) {
      const eff = professionalState.get(accountJoinKey(account.account_code, account.account_name));
      if (eff?.suppressed) {
        // E1 (OD3): only a zero-balance account may be left out of the trial balance. A non-zero account marked as
        // non-reporting goes to review with its amounts intact; it is never silently dropped.
        if (account.debitMinor === account.creditMinor) {
          nonReportingAccounts.push({ account_code: account.account_code, account_name: account.account_name });
          continue; // classifyAccountTiered() is never invoked for this account
        }
        queueReview({
          account_code: account.account_code,
          account_name: account.account_name,
          debit:        account.debit,
          credit:       account.credit,
          balance:      account.balance,
          reason:       `Marked as non-reporting, but it carries a balance of ${formatMinor(account.debitMinor - account.creditMinor, exponent)}. A non-zero account can't be left out of the trial balance: classify it.`,
        });
        continue;
      }

      const result = classifyAccountTiered(
        account,
        reportingFramework,
        companyByCode, companyByName,
        globalByCode,  globalByName,
        kwdExact, kwdContains,
      );

      // Review policy (_shared/tbIngestion.classificationNeedsReview): only this company's own reviewed mapping,
      // matched exactly, stands without a reviewer. Any other classifier result is a SUGGESTION — the account goes
      // to review with it pre-selected, and the trial balance is not accepted until a reviewer confirms it.
      if (result.status === "classified" && classificationNeedsReview(result.tier, result.fuzzy === true)) {
        autoClassifiedCount++;
        queueReview({
          account_code:             account.account_code,
          account_name:             account.account_name,
          debit:                    account.debit,
          credit:                   account.credit,
          balance:                  account.balance,
          suggested_classification: result.mapping.classification,
          suggested_statement:      result.mapping.statement,
          confidence_source:        result.fuzzy ? `${result.confidence_source}_fuzzy` : result.confidence_source,
          reason:                   suggestionReason(result),
          stale_non_reporting_reason: eff?.staleReason ?? undefined,
        });
      } else if (result.status === "classified") {
        resolvedMappings.set(accountKey(account), result.mapping);
        resolvedTiers.set(accountKey(account), result.tier);
      } else {
        queueReview({
          account_code:             account.account_code,
          account_name:             account.account_name,
          debit:                    account.debit,
          credit:                   account.credit,
          balance:                  account.balance,
          suggested_classification: result.suggested_classification,
          suggested_statement:      result.suggested_statement,
          confidence_source:        result.confidence_source,
          reason:                   result.reason,
          stale_non_reporting_reason: eff?.staleReason ?? undefined,
        });
      }
    }
    // ── STEP 6b (E1): accounts on a reviewed mapping that still need a person ──
    // 1. A mapping to anything other than a balance-sheet or income-statement class (legacy cash-flow classes; S1
    //    already refuses new ones) would leave the account's amount out of the statements: review.
    // 2. A cash account must be an asset or a liability (C2): review otherwise.
    // 3. Treatment rule closing_stock_credit/1: review with a treatment request, unless a CONFIRM_ACCOUNT_TREATMENT for
    //    exactly that request (same facts, same mapping link) is on record.
    const takeForReview = (account: RawAccount, mapping: AccountMapping, reason: string, extra: Partial<NeedsReviewAccount> = {}) => {
      resolvedMappings.delete(accountKey(account));
      resolvedTiers.delete(accountKey(account));
      queueReview({
        account_code:             account.account_code,
        account_name:             account.account_name,
        debit:                    account.debit,
        credit:                   account.credit,
        balance:                  account.balance,
        suggested_classification: mapping.classification,
        suggested_statement:      mapping.statement,
        confidence_source:        "mapping",
        reason,
        ...extra,
      });
    };
    for (const account of rawAccounts) {
      const m = resolvedMappings.get(accountKey(account));
      if (!m) continue;
      const side = classSideOf(m.classification);
      if (!side) {
        takeForReview(account, m, `Mapped to "${m.classification}", which is not a balance-sheet or income-statement class, so its amount would be left out of the statements. Choose the statement class for this account.`);
      } else if (m.is_cash_account && side !== "assets" && side !== "liabilities") {
        takeForReview(account, m, `Marked as a cash account but classified as ${m.classification}. A cash account must be an asset or a liability.`);
      }
    }

    // Treatment: per review account key (rows of one code split by dimension are one decision, amounts combined).
    type TreatmentGroup = { accounts: RawAccount[]; mapping: AccountMapping; debit: bigint; credit: bigint };
    const treatmentGroups = new Map<string, TreatmentGroup>();
    for (const account of rawAccounts) {
      const m = resolvedMappings.get(accountKey(account));
      if (!m || m.classification !== "current_assets") continue;
      const key = reviewAccountKey(account);
      const g = treatmentGroups.get(key) ?? { accounts: [], mapping: m, debit: 0n, credit: 0n };
      g.accounts.push(account);
      g.debit += account.debitMinor;
      g.credit += account.creditMinor;
      treatmentGroups.set(key, g);
    }
    const treatmentRequests: TreatmentRequest[] = [];
    const treatmentPending: { group: TreatmentGroup; request: TreatmentRequest | null }[] = [];
    for (const [key, g] of treatmentGroups) {
      if (g.debit >= g.credit || !matchesClosingStockRule(g.accounts[0])) continue;
      // Only a reviewed mapping resolves without review, so the link is always present here; without a company (legacy
      // personal upload) or a link no request can be bound, and the account simply stays in review.
      const request = companyId && g.mapping.review_decision_id
        ? await buildTreatmentRequest({
            ...CLOSING_STOCK_RULE,
            company_id:          companyId,
            upload_id:           uploadId,
            source_file_hash:    sourceFileHash,
            account_key:         key,
            account_code:        g.accounts[0].account_code?.trim() || null,
            debit_minor:         g.debit.toString(),
            credit_minor:        g.credit.toString(),
            mapping_decision_id: g.mapping.review_decision_id,
          })
        : null;
      if (request) treatmentRequests.push(request);
      treatmentPending.push({ group: g, request });
    }
    let confirmedTreatments = new Set<string>();
    if (treatmentRequests.length > 0 && companyId) {
      const { data: confirmedRows, error: confirmedError } = await supabase.rpc("get_confirmed_treatments", {
        p_company_id: companyId,
        p_request_ids: treatmentRequests.map((r) => r.request_id),
      });
      // Fails closed: without the answer no treatment is assumed confirmed and no result is recorded.
      if (confirmedError) throw new Error(`get_confirmed_treatments failed: ${confirmedError.message}`);
      confirmedTreatments = new Set(((confirmedRows ?? []) as { request_id: string }[]).map((r) => r.request_id));
    }
    for (const { group, request } of treatmentPending) {
      if (request && confirmedTreatments.has(request.request_id)) continue; // kept as mapped, on record
      const credit = formatMinor(group.credit - group.debit, exponent);
      for (const account of group.accounts) {
        takeForReview(
          account, group.mapping,
          `A current asset with a credit balance of ${credit} that looks like a closing-stock adjustment. Keep it as mapped (record why) or reclassify it.`,
          request ? { treatment_request_id: request.request_id } : {},
        );
      }
    }

    console.log(`[PTB] Classification: ${resolvedMappings.size} reviewed, ${needsReviewAccounts.length} needs_review (${autoClassifiedCount} suggested), ${nonReportingAccounts.length} non_reporting`);
    milestones.mark(
      "classification",
      needsReviewAccounts.length > 0 ? "needs_review" : "passed",
      needsReviewAccounts.length > 0
        ? `${needsReviewAccounts.length} of ${rawAccounts.length} accounts need a reviewer's confirmation`
        : `${resolvedMappings.size} accounts on reviewed mappings${nonReportingAccounts.length ? `, ${nonReportingAccounts.length} non-reporting` : ""}`,
    );
    const balanceCheck = { passed: true, total_debits: totalDebits, total_credits: totalCredits, difference: 0, exact: exactTotals };

    // ── STEP 7: Mapping completeness ──────────────────────────────────────────
    // needs_review replaces the hard block. The upload can be opened in the review
    // screen (PART 4) where each account gets a dropdown + Save & Reprocess.
    // FS generation and exports remain blocked (is_valid: false) until all accounts
    // are resolved. Gate audit confirmed: is_valid: false is the export catch-all.

    if (needsReviewAccounts.length > 0) {
      const result: Partial<ProcessingResult> = {
        status:                 "needs_review",
        statements:             null,
        errors:                 allErrors,
        needs_review_accounts:  needsReviewAccounts,
        non_reporting_accounts: nonReportingAccounts,
        ...(treatmentRequests.length > 0 ? { treatment_requests: treatmentRequests } : {}),
        validation_report: {
          tb_balance_check: balanceCheck,
          mapping_completeness: {
            passed:          false,
            total_accounts:  rawAccounts.length,
            mapped_accounts: rawAccounts.length - needsReviewAccounts.length - nonReportingAccounts.length,
            needs_review:    needsReviewAccounts.length,
            non_reporting:   nonReportingAccounts.length,
            auto_classified: autoClassifiedCount,
            review_accounts: needsReviewAccounts.map(r => ({
              account_code:             r.account_code,
              account_name:             r.account_name,
              suggested_classification: r.suggested_classification,
              confidence_source:        r.confidence_source,
              reason:                   r.reason,
            })),
          },
        },
        summary: {
          total_accounts:   rawAccounts.length,
          processed_at:     new Date().toISOString(),
          parser_version:   PARSER_VERSION,
          columns_detected: detectedCols,
          auto_classified:  autoClassifiedCount,
          rejected_rows:    rejectedRows,
        },
      };
      if (engineRunId && idempotencyKeyId && engineStartedAt && upload.company_id) {
        const commit = await commitSafishaCertification(supabase as never, {
          engineRunId, idempotencyKeyId, engineStartedAt,
          uploadId, companyId: upload.company_id, periodYear: upload.period_year ?? null,
          sourceFileHash, normalizedInputHash,
          isBlocking: false, requiresReview: true,
          exceptions: [
            ...needsReviewAccounts.map((r): SafishaExceptionRecord => ({
              code: "NEEDS_REVIEW", layer: 4, severity: "warning", accountCode: r.account_code, message: r.reason,
            } as SafishaExceptionRecord)),
            ...(phase0Evidence?.layer5Exceptions ?? []),
            ...(phase0Evidence?.layer6Exceptions ?? []),
          ],
          rowsSnapshot: [],
        });
        if (!commit.ok) return commit.response;
      }
      milestones.mark("recorded", "passed");
      result.ingestion = ingestionRecord(ingest, milestones);
      // source_file_hash already persisted independently above.
      const failed = await writeOutcome(supabase as never, uploadId, {
        status:            "needs_review",
        is_valid:           false,
        accounting_errors:  allErrors,
        processing_result:  result,
        processed_at:       new Date().toISOString(),
      });
      if (failed) return failed;
      return new Response(JSON.stringify(result), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── STEP 8: Statement aggregation (exact, class-side) ───────────────────────
    const { statements, totals } = aggregateStatements(rawAccounts, resolvedMappings, exponent);
    if (!ingest.currency) throw new Error("[PTB] Internal invariant violation: an accepted trial balance has no currency.");
    const amounts = buildTbAmounts({
      currency:         ingest.currency,
      exponent,
      debitTotalMinor:  ingestTotals.debitMinor,
      creditTotalMinor: ingestTotals.creditMinor,
      accounts: rawAccounts.flatMap((a) => {
        const m = resolvedMappings.get(accountKey(a));
        return m ? [{ classification: m.classification, isCash: m.is_cash_account, debitMinor: a.debitMinor, creditMinor: a.creditMinor }] : [];
      }),
    });

    // ── STEP 9: Accounting equation — exact ───────────────────────────────────
    // assets = liabilities + equity + income − expenses, in minor units, with no tolerance. In an unadjusted trial
    // balance P&L accounts are not yet closed, so income − expenses is the current-year result.
    // Every account is now either on a statement class or a zero-balance non-reporting account, and the trial balance
    // balances to the minor unit (STEP 2), so class-side sums make the difference zero by construction. A non-zero
    // difference can only be an engine defect: the run fails, nothing is certified, and the upload is never accepted.
    const netIncome     = totals.revenue - totals.expenses;
    const closingEquity = totals.equity + netIncome;
    const fmt = (minor: string) => formatMinor(BigInt(minor), exponent);
    const equationReport = {
      passed: amounts.equation.status === "balanced",
      assets: totals.assets, liabilities: totals.liabilities, equity: totals.equity,
      revenue_total: totals.revenue, expenses_total: totals.expenses,
      net_income: netIncome, closing_equity: closingEquity,
      difference: minorToNumber(BigInt(amounts.equation.difference_minor), exponent),
      exact: amounts.equation,
    };
    const mappingCompleteness = { passed: true, total_accounts: rawAccounts.length, mapped_accounts: resolvedMappings.size, non_reporting: nonReportingAccounts.length, unmapped: [], auto_classified: autoClassifiedCount };

    if (amounts.equation.status !== "balanced") {
      const message = `Assets (${fmt(amounts.equation.lhs_minor)}) do not equal liabilities + equity + income − expenses (${fmt(amounts.equation.rhs_minor)}). Difference: ${fmt(amounts.equation.difference_minor)}. The trial balance balances and every account is on a statement, so this is not a classification matter: processing stopped and nothing was accepted.`;
      allErrors.push({ code: "INVARIANT_VIOLATION", message, expected: "0", actual: amounts.equation.difference_minor });
      console.error(`[PTB] INVARIANT_VIOLATION: equation difference ${amounts.equation.difference_minor} minor units`);
      if (engineRunId && idempotencyKeyId && engineStartedAt) {
        await recordEngineRunFailed(supabase as never, engineRunId, {
          startedAt: engineStartedAt,
          errorCode: "INVARIANT_VIOLATION",
          errorDetail: { stage: "accounting_equation", safe_message: `difference_minor=${amounts.equation.difference_minor}` },
        });
        await failIdempotency(supabase as never, idempotencyKeyId, "INVARIANT_VIOLATION");
      }
      milestones.mark("recorded", "failed", "The accounting equation did not hold; nothing was accepted.");
      const failedValidation = {
        tb_balance_check:       balanceCheck,
        mapping_completeness:   mappingCompleteness,
        balance_sheet_equation: equationReport,
        profit_equity_linkage:  null,
        cash_reconciliation:    null,
      };
      const failedResult: ProcessingResult = {
        status: "invalid",
        statements: null,
        validation_report: failedValidation,
        errors: allErrors,
        non_reporting_accounts: nonReportingAccounts,
        amounts,
        summary: {
          total_accounts:   rawAccounts.length,
          processed_at:     new Date().toISOString(),
          parser_version:   PARSER_VERSION,
          columns_detected: detectedCols,
          auto_classified:  autoClassifiedCount,
          rejected_rows:    rejectedRows,
        },
      };
      failedResult.ingestion = ingestionRecord(ingest, milestones);
      const failedWrite = await writeOutcome(supabase as never, uploadId, {
        status:            "error",
        is_valid:          false,
        validation_report: failedValidation,
        accounting_errors: allErrors,
        processing_result: failedResult,
        processed_at:      new Date().toISOString(),
      });
      if (failedWrite) return failedWrite;
      return new Response(JSON.stringify(failedResult), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const allValid   = true;
    const finalStatus: "valid" | "invalid" = allValid ? "valid" : "invalid";
    console.log(`[PTB] Final status: ${finalStatus.toUpperCase()} | BS equation: exact PASS | Auto-classified: ${autoClassifiedCount}`);

    const validationReport = {
      tb_balance_check:     balanceCheck,
      mapping_completeness: mappingCompleteness,
      balance_sheet_equation: equationReport,
      profit_equity_linkage: null,
      // The trial balance alone never proves cash against a bank: no reconciliation is claimed (amounts.reconciliation
      // is "not_checked"). The old self-comparison of one figure with itself is gone.
      cash_reconciliation:  null,
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
      non_reporting_accounts: nonReportingAccounts,
      amounts,
      ...(treatmentRequests.length > 0 ? { treatment_requests: treatmentRequests } : {}),
      summary: {
        total_accounts:    rawAccounts.length,
        processed_at:      new Date().toISOString(),
        parser_version:    PARSER_VERSION,
        columns_detected:  detectedCols,
        auto_classified:   autoClassifiedCount,
        rejected_rows:     rejectedRows,
      },
    };

    if (engineRunId && idempotencyKeyId && engineStartedAt && upload.company_id) {
      const rowsSnapshot = buildCertifiedRows(rawAccounts, resolvedMappings, resolvedTiers);
      const commit = await commitSafishaCertification(supabase as never, {
        engineRunId, idempotencyKeyId, engineStartedAt,
        uploadId, companyId: upload.company_id, periodYear: upload.period_year ?? null,
        sourceFileHash, normalizedInputHash,
        isBlocking: false, requiresReview: false,
        exceptions: [
          ...(phase0Evidence?.layer5Exceptions ?? []),
          ...(phase0Evidence?.layer6Exceptions ?? []),
        ],
        rowsSnapshot,
      });
      if (!commit.ok) return commit.response;
    }

    milestones.mark("recorded", "passed");
    processingResult.ingestion = ingestionRecord(ingest, milestones);
    // source_file_hash already persisted independently above.
    const failedFinal = await writeOutcome(supabase as never, uploadId, {
      status:             allValid ? "complete" : "error",
      is_valid:           allValid,
      validation_report:  validationReport,
      accounting_errors:  allErrors,
      processing_result:  processingResult,
      processed_at:       new Date().toISOString(),
    });
    if (failedFinal) return failedFinal;

    return new Response(JSON.stringify(processingResult), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[PTB] Fatal error:", error);
    // Never leave the upload at "validating" after an unhandled failure: put back the status it had, so the person
    // can retry from where they were (the checked write that claimed it is the only thing this request changed).
    if (statusClaimed && claimedUploadId) {
      try {
        const cleanupClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        await restoreStatus(cleanupClient as never, claimedUploadId, priorStatus);
      } catch (restoreError) {
        console.error("[PTB] status restore after failure did not complete:", restoreError instanceof Error ? restoreError.name : "unknown");
      }
    }
    // Ω∞ Phase 0 Slice 2: a claimed engine_run/idempotency reservation must
    // never be left stuck at running/reserved by an unhandled exception —
    // this is a genuine system failure, not a SAFISHA outcome, so no
    // certification is committed here.
    if (engineRunId && idempotencyKeyId && engineStartedAt) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase    = createClient(supabaseUrl, supabaseKey);
      try {
        await recordEngineRunFailed(supabase as never, engineRunId, {
          startedAt: engineStartedAt,
          errorCode: "UNHANDLED_EXCEPTION",
          errorDetail: { stage: "process-trial-balance", safe_message: String(error instanceof Error ? error.message : "Processing failed").slice(0, 200) },
        });
        await failIdempotency(supabase as never, idempotencyKeyId, "UNHANDLED_EXCEPTION");
      } catch (cleanupError) {
        console.error("[PTB] Failed to record engine_run failure during cleanup:", cleanupError);
      }
    }
    return new Response(
      // A controlled answer: the raw error (database or Storage detail) is logged and recorded above, never returned.
      JSON.stringify({ status: "blocked", error: "Processing failed", message: PROCESSING_UNAVAILABLE.message, errors: allErrors }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// ── Ingestion helpers (declared after the handler; hoisted) ─────────────────────────────────────────────────────────

/**
 * The reporting currency of the period this upload was made for: the upload's own period, or its engagement's
 * period, and only when that period belongs to the upload's company. null when none can be established — the
 * ingestion core then refuses (CURRENCY_UNRESOLVED); a currency is never assumed. A database error is thrown, not
 * read as "no currency".
 */
async function resolveReportingCurrency(
  supabase: ReturnType<typeof createClient>,
  upload: { company_id?: string | null; period_id?: string | null; engagement_id?: string | null },
): Promise<string | null> {
  if (!upload.company_id) return null;
  let periodId = upload.period_id ?? null;
  if (!periodId && upload.engagement_id) {
    const { data, error } = await supabase.from("engagements").select("fiscal_period_id, company_id").eq("id", upload.engagement_id).maybeSingle();
    if (error) throw new Error(`engagement lookup failed: ${error.code ?? "unknown"}`);
    const engagement = data as { fiscal_period_id: string | null; company_id: string } | null;
    if (engagement && engagement.company_id === upload.company_id) periodId = engagement.fiscal_period_id;
  }
  if (!periodId) return null;
  const { data, error } = await supabase.from("fiscal_periods").select("company_id, reporting_currency").eq("id", periodId).maybeSingle();
  if (error) throw new Error(`period lookup failed: ${error.code ?? "unknown"}`);
  const period = data as { company_id: string; reporting_currency: string | null } | null;
  if (!period || period.company_id !== upload.company_id) return null;
  return typeof period.reporting_currency === "string" && period.reporting_currency.trim() ? period.reporting_currency : null;
}

function tryReadWorkbook(bytes: Uint8Array): XLSX.WorkBook | null {
  try {
    return XLSX.read(bytes, { type: "array", cellDates: false });
  } catch {
    return null;
  }
}

function issueToValidationError(issue: IngestIssue): ValidationError & { severity: string; rows?: number[] } {
  return { code: issue.code, message: issue.message, severity: issue.severity, ...(issue.field ? { field: issue.field } : {}), ...(issue.rows ? { rows: issue.rows } : {}) };
}

/** JSON-safe record of ingestion for processing_result.ingestion (amounts as exact decimal strings). */
function ingestionRecord(ingest: IngestResult, milestones: MilestoneLog): Record<string, unknown> {
  const e = ingest.exponent ?? 0;
  return {
    version: ingest.version,
    currency: ingest.currency,
    currency_exponent: ingest.exponent,
    period_year: ingest.periodYear,
    sheet: ingest.sheetName,
    columns: ingest.columns,
    totals: ingest.totals
      ? { debit: formatMinor(ingest.totals.debitMinor, e), credit: formatMinor(ingest.totals.creditMinor, e), difference: formatMinor(ingest.totals.differenceMinor, e) }
      : null,
    lineage_summary: ingest.lineageSummary,
    // Compact per-row lineage: [row number, disposition, account identity or reason].
    lineage: ingest.lineage.map((l) => [l.rowNumber, l.disposition, l.identity ?? l.reason ?? null]),
    issues: ingest.issues,
    milestones: milestones.list(),
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

/**
 * Writes the outcome to the upload row and checks the write. null when written; otherwise the controlled answer to
 * return — a result is never reported as recorded when the row did not take it.
 */
async function writeOutcome(supabase: ReturnType<typeof createClient>, uploadId: string, fields: Record<string, unknown>): Promise<Response | null> {
  const { error } = await supabase.from("trial_balance_uploads").update(fields as never).eq("id", uploadId);
  if (!error) return null;
  console.error("[PTB] outcome write failed:", (error as { code?: string }).code ?? "unknown");
  if (isEntitlementWallError(error)) {
    const wall = paidActionRefusal("CLOSE_ASSURANCE", { allowed: false, code: "ENTITLEMENT_REQUIRED", required_plan: "SOLO" })!;
    return jsonResponse(wall.body, wall.httpStatus);
  }
  return jsonResponse(PROCESSING_UNAVAILABLE, 500);
}

/** Puts back the status the upload had when this request arrived (best effort; logged, never thrown). */
async function restoreStatus(supabase: ReturnType<typeof createClient>, uploadId: string, status: string | null): Promise<void> {
  if (status === null) return;
  const { error } = await supabase.from("trial_balance_uploads").update({ status } as never).eq("id", uploadId);
  if (error) console.error("[PTB] status restore failed:", (error as { code?: string }).code ?? "unknown");
}

/** Plain-language reason a classifier suggestion still needs a reviewer. */
function suggestionReason(result: Extract<TieredClassifyResult, { status: "classified" }>): string {
  const label = result.mapping.line_item || result.mapping.classification;
  if (result.mapping.provenance === "unconfirmed_company") {
    return `Saved for this company as ${label}, but no recorded review decision confirms it — confirm the classification before the trial balance is accepted.`;
  }
  if (result.fuzzy) return `Close to a saved mapping (${result.mapping.account_name}) — confirm it applies to this account.`;
  if (result.tier === 3) return `Matched the shared chart of accounts (${label}) — confirm it for this company.`;
  if (result.tier === 4) return `Suggested from the account-name dictionary (${label}) — confirm before the trial balance is accepted.`;
  return `Suggested from the account name (${label}) — confirm before the trial balance is accepted.`;
}
