// ============================================================
// Kinga Findings Engine — Module B: Rule Trigger
// Edge Function: kinga-findings-engine
// Version: Module B+C v2.1 — Universal Account Detection
// Date: 2026-06-26
//
// Architecture:
//   Module B fires on GL account balances.  For each active,
//   verified statutory rule that has a trigger_account_classification,
//   the engine:
//     1. Reads the trial balance processing_result for the period.
//     2. Sums the balances of all accounts in the matching
//        classification section.
//     3. Applies the obligation formula:
//           pure rate:  obligation = (rate_pct / 100) × base
//           flat only:  obligation = flat_tax_tzs
//           compound:   obligation = flat_tax_tzs + (rate_pct / 100) × base
//     4. Compares against declared amount (v1.0: 0 — no payment
//        store exists yet; see open decision OD-1).
//     5. Inserts a finding if |variance| > VARIANCE_THRESHOLD_TZS.
//
// Trigger guard:
//   enforce_verified_statutory_rule fires BEFORE INSERT on findings.
//   V1: rule_trigger findings must have statutory_rule_id IS NOT NULL.
//   V2: referenced rule must have verified_at IS NOT NULL.
//   Engine only reads rules where verified_at IS NOT NULL, so V2
//   should never fire — but the trigger is the final DB-layer gate.
//
// Service-role note:
//   This function calls supabase with the service role key.
//   Service role bypasses ALL RLS.  The trigger layer (not RLS)
//   enforces data integrity invariants.  Never relax a trigger
//   thinking RLS provides equivalent protection here.
//
// Universal account detection (v2.1):
//   Steps C1b and C1c use TWO-TIER detection — no manual configuration needed
//   for standard naming conventions (QuickBooks, Sage, Tally, Swahili names,
//   manual Excel, GFS codes with descriptive names).
//   TIER 1: explicit account_mappings flags (is_payroll_account, is_retained_earnings)
//           as override for edge-case account names.
//   TIER 2: semantic name pattern matching on account names from the JSONB.
//           "Salaries and Wages" → payroll. "Retained Earnings" → retained equity.
//           NHIF/NSSF/WCF/SDL excluded from payroll base automatically.
//   Only if BOTH tiers find nothing: emit config error.
//
// Module C (statutory payables):
//   Reads current_liabilities from processing_result, pattern-matches
//   account names against known statutory payable categories (SDL, NSSF,
//   NHIF, WCF, PAYE, VAT, TRA assessments, Service Levy).  Any non-zero
//   balance creates a 'statutory_payable' finding — no statutory_rule
//   required, no verified_at check.  The outstanding balance IS the
//   obligation.  Bypasses enforce_verified_statutory_rule trigger safely
//   (V1 only gates rule_trigger; V2 only gates non-null statutory_rule_id).
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Constants ────────────────────────────────────────────────────────────

const ENGINE_VERSION = "Module B+C v2.0";

/**
 * Minimum absolute variance (TZS) below which a finding is not raised.
 * Prevents noise from rounding and sub-threshold discrepancies.
 * Open decision OD-3: adjust after first reconciliation cycle.
 */
const VARIANCE_THRESHOLD_TZS = 10_000;

/**
 * Maps account_classification enum values to their parent financial statement
 * section in processing_result.statements.
 * Source: account_classification enum in migration 20260122083339.
 */
const CLASSIFICATION_TO_STATEMENT: Record<string, keyof ProcessingResultStatements> = {
  revenue:               "income_statement",
  cost_of_goods_sold:    "income_statement",
  operating_expenses:    "income_statement",
  other_income:          "income_statement",
  taxes:                 "income_statement",
  current_assets:        "balance_sheet",
  non_current_assets:    "balance_sheet",
  current_liabilities:   "balance_sheet",
  non_current_liabilities: "balance_sheet",
  equity:                "balance_sheet",
  operating_activities:  "cash_flow",
  investing_activities:  "cash_flow",
  financing_activities:  "cash_flow",
};

// ── Types ────────────────────────────────────────────────────────────────

interface EngineRequest {
  company_id:   string;
  upload_id:    string;   // trial_balance_uploads.id — identifies the GL period
  period_year:  number;
  period_month: number;
  triggered_by: string;   // UUID of the user who initiated the run
  dry_run?:     boolean;  // if true: compute but do not write findings
}

interface EngineResponse {
  engine_run_id:    string;
  company_id:       string;
  period_year:      number;
  period_month:     number;
  // Module B — rule-trigger findings
  rules_evaluated:  number;
  rules_skipped:    number;
  findings_created: number;
  findings_skipped: number;
  // Module C — statutory payables from balance sheet
  payables_scanned: number;
  payables_found:   number;
  payables_created: number;
  payables_skipped: number;
  // Combined
  total_findings:   number;
  errors:           EngineError[];
  dry_run:          boolean;
  findings_preview?:  FindingPreview[];         // Module B dry_run
  payables_preview?:  ModuleCFindingPreview[];  // Module C dry_run
}

interface EngineError {
  rule_id:         string | null;
  trigger_category: string | null;
  error_message:   string;
  stage:           "rule_fetch" | "gl_read" | "obligation_compute" | "finding_insert";
}

interface TrialBalanceAccount {
  account_code: string;
  account_name: string;
  debit:        number;
  credit:       number;
  balance:      number;
}

interface ProcessingResultStatements {
  balance_sheet:     Record<string, { accounts: TrialBalanceAccount[]; total: number }> | null;
  income_statement:  Record<string, { accounts: TrialBalanceAccount[]; total: number }> | null;
  cash_flow:         Record<string, { accounts: TrialBalanceAccount[]; total: number }> | null;
}

interface ProcessingResult {
  status:     "valid" | "invalid" | "blocked";
  statements: ProcessingResultStatements | null;
  summary:    { total_accounts: number; processed_at: string };
}

interface StatutoryRule {
  id:                             string;
  trigger_category:               string;
  trigger_account_classification: string;
  statute:                        string;
  obligation:                     string;
  rate_is_threshold:              boolean;
  rate_pct:                       number | null;
  flat_tax_tzs:                   number | null;
  threshold_amount:               number | null;
  jurisdiction:                   string;
  effective_from:                 string;
  effective_to:                   string | null;
  notes:                          string | null;
  verified_at:                    string;  // NOT NULL — engine only fetches verified rules
}

interface FindingPreview {
  trigger_category:        string;
  statutory_rule_id:       string;
  base_amount_tzs:         number;
  computed_obligation_tzs: number;
  declared_amount_tzs:     number;
  variance_tzs:            number;
  variance_pct:            number | null;
  account_count:           number;
}

// ── Main handler ─────────────────────────────────────────────────────────

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ── 1. Auth ──────────────────────────────────────────────────────────
  const supabaseAuth = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return respond(401, { error: "Missing Authorization header" });
  }
  const { data: { user }, error: authErr } = await supabaseAuth.auth.getUser(
    authHeader.replace("Bearer ", ""),
  );
  if (authErr || !user) {
    return respond(401, { error: "Unauthorized" });
  }

  // ── 2. Parse request ──────────────────────────────────────────────────
  let body: EngineRequest;
  try {
    body = await req.json();
  } catch {
    return respond(400, { error: "Invalid JSON body" });
  }

  const { company_id, upload_id, period_year, period_month, dry_run = false } = body;
  if (!company_id || !upload_id || !period_year || !period_month) {
    return respond(400, {
      error: "Required fields: company_id, upload_id, period_year, period_month",
    });
  }
  if (period_month < 1 || period_month > 12) {
    return respond(400, { error: "period_month must be between 1 and 12" });
  }

  // ── 3. Verify caller owns the company ─────────────────────────────────
  // Use anon client so RLS applies — confirms caller has access to this company.
  const supabaseAnon = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: company, error: companyErr } = await supabaseAnon
    .from("companies")
    .select("id, user_id")
    .eq("id", company_id)
    .single();

  if (companyErr || !company) {
    return respond(403, { error: "Company not found or not accessible" });
  }

  // ── 4. Service role client for all DB writes ───────────────────────────
  // Service role bypasses RLS.  Trigger layer enforces all integrity invariants.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── 5. Generate engine run ID ─────────────────────────────────────────
  const engineRunId = crypto.randomUUID();
  const triggeredBy = body.triggered_by ?? user.id;

  // ── 6. Run Module B — rule-trigger findings ───────────────────────────
  const moduleBResult = await runModuleB({
    supabase,
    companyId:      company_id,
    companyUserId:  company.user_id,
    uploadId:       upload_id,
    periodYear:     period_year,
    periodMonth:    period_month,
    engineRunId,
    triggeredBy,
    dryRun:         dry_run,
  });

  // ── 6b. Run Module C — statutory payables from balance sheet ──────────
  const moduleCResult = await runModuleC({
    supabase,
    companyId:   company_id,
    uploadId:    upload_id,
    periodYear:  period_year,
    periodMonth: period_month,
    engineRunId,
    triggeredBy,
    dryRun:      dry_run,
  });

  const allErrors      = [...moduleBResult.errors, ...moduleCResult.errors];
  const totalFindings  = moduleBResult.findings_created + moduleCResult.findings_created;

  // ── 7. Write audit log ────────────────────────────────────────────────
  if (!dry_run) {
    await supabase.from("audit_logs").insert({
      user_id:     triggeredBy,
      action:      allErrors.length === 0
        ? "reconciliation_engine_completed"
        : "reconciliation_engine_partial",
      entity_type: "company",
      entity_id:   company_id,
      metadata: {
        engine_run_id:      engineRunId,
        engine_version:     ENGINE_VERSION,
        upload_id,
        period_year,
        period_month,
        // Module B
        rules_evaluated:    moduleBResult.rules_evaluated,
        findings_created:   moduleBResult.findings_created,
        findings_skipped:   moduleBResult.findings_skipped,
        // Module C
        payables_scanned:   moduleCResult.accounts_scanned,
        payables_found:     moduleCResult.payables_found,
        payables_created:   moduleCResult.findings_created,
        // Combined
        total_findings:     totalFindings,
        error_count:        allErrors.length,
      },
    });
  }

  return respond(200, {
    engine_run_id:    engineRunId,
    company_id,
    period_year,
    period_month,
    // Module B
    rules_evaluated:  moduleBResult.rules_evaluated,
    rules_skipped:    moduleBResult.rules_skipped,
    findings_created: moduleBResult.findings_created,
    findings_skipped: moduleBResult.findings_skipped,
    // Module C
    payables_scanned: moduleCResult.accounts_scanned,
    payables_found:   moduleCResult.payables_found,
    payables_created: moduleCResult.findings_created,
    payables_skipped: moduleCResult.findings_skipped,
    // Combined
    total_findings:   totalFindings,
    errors:           allErrors,
    dry_run,
    ...(dry_run ? {
      findings_preview:  moduleBResult.findings_preview,
      payables_preview:  moduleCResult.findings_preview,
    } : {}),
  });
});

// ── Module B core ─────────────────────────────────────────────────────────

/**
 * Rules that require a secondary account_mappings filter beyond the
 * broad classification grouping in processing_result.statements.
 *
 * WHT_RETAINED_EARNINGS_CATEGORIES:
 *   processing_result.statements.balance_sheet['equity'] contains ALL equity
 *   accounts (share capital, reserves, retained earnings, accumulated deficit).
 *   WHT on undistributed earnings applies only to the retained-earnings subset.
 *   account_mappings.is_retained_earnings = true identifies those accounts.
 *   Without this filter, the engine would compute WHT on total equity —
 *   a potentially 10×–50× over-estimation (share capital >> retained earnings).
 */
const WHT_RETAINED_EARNINGS_CATEGORIES = new Set([
  "wht_undistributed_earnings",
  "retained_earnings_deemed_distribution",
]);

/**
 * SDL_PAYROLL_CATEGORIES + PAYROLL_NAME_PATTERNS:
 *
 *   SDL (CAP 441) is levied on gross emoluments only.
 *
 *   The engine auto-detects payroll accounts by matching account NAMES
 *   against PAYROLL_NAME_PATTERNS — no manual is_payroll_account flag needed.
 *   This works for any chart of accounts: QuickBooks, Sage, Tally, manual Excel,
 *   GFS-coded or not.  "Salaries and Wages", "Mishahara", "Employee Costs",
 *   "Basic Pay" — all match.
 *
 *   NON_PAYROLL_EXCLUSION_PATTERNS removes statutory levies that are often
 *   named inside the payroll section of accounts but are NOT emoluments:
 *   NHIF, NSSF, WCF, SDL expense itself (which is circular), PAYE.
 *
 *   is_payroll_account column on account_mappings is still available as an
 *   OVERRIDE for edge cases — if set to true on an account whose name does
 *   not match PAYROLL_NAME_PATTERNS, the engine includes it. But zero
 *   manual configuration is required for standard naming conventions.
 */
const SDL_PAYROLL_CATEGORIES = new Set([
  "sdl",
]);

/** Gross emolument patterns — accounts whose balance IS the SDL base. */
const PAYROLL_NAME_PATTERNS: RegExp[] = [
  /\bsalar[yi]/i,
  /\bwage/i,
  /\ballowance/i,
  /\bemolument/i,
  /\bbasic\s*pay/i,
  /\bovertime\b/i,
  /\bextra\s*duty\b/i,
  /\bmishahara\b/i,           // Swahili: salary
  /\bposho\b/i,               // Swahili: allowance
  /\bstipend\b/i,
  /\bstaff\s*pay\b/i,
  /\bpayroll\b/i,
  /\bremuneration\b/i,
  /\bcompensation\b/i,
  /\bsalary\s*&\s*wages?\b/i,
];

/**
 * Statutory levy accounts that LOOK like payroll but are NOT emoluments.
 * If an account name matches any of these, it is excluded from the SDL base
 * even if it also matches a PAYROLL_NAME_PATTERN.
 * SDL expense itself is explicitly excluded — computing SDL on SDL is circular.
 */
const NON_PAYROLL_EXCLUSION_PATTERNS: RegExp[] = [
  /\bnhif\b/i,
  /\bnssf\b/i,
  /\bwcf\b/i,
  /\bsdl\b/i,      // SDL expense ≠ emolument (it is a levy ON emoluments)
  /\bpaye\b/i,
  /\bpension\s*fund\b/i,
  /\bprovident\s*fund\b/i,
  /\bworkers?\s*comp/i,
  /\btraining\s*levy\b/i,
];

/**
 * Returns true if an account name represents gross emoluments (SDL base).
 * Logic: matches PAYROLL_NAME_PATTERNS AND does NOT match NON_PAYROLL_EXCLUSION_PATTERNS.
 */
function isGrossEmolumentAccount(accountName: string): boolean {
  const matchesPayroll = PAYROLL_NAME_PATTERNS.some(p => p.test(accountName));
  if (!matchesPayroll) return false;
  const excluded = NON_PAYROLL_EXCLUSION_PATTERNS.some(p => p.test(accountName));
  return !excluded;
}

/**
 * Retained earnings name patterns — used as fallback when is_retained_earnings
 * flag is not set in account_mappings.  Covers standard naming conventions
 * across QuickBooks, Sage, Tally, GFS, and manual charts of accounts.
 */
const RETAINED_EARNINGS_NAME_PATTERNS: RegExp[] = [
  /retained\s*earning/i,
  /accumulated\s*(profit|surplus|deficit|loss)/i,
  /profit\s*b[\/]?[fo]/i,      // Profit b/f, Profit b/o
  /surplus\s*b[\/]?[fo]/i,
  /net\s*(profit|loss)\s*b[\/]?[fo]/i,
  /faida\s*iliyobakiwa\b/i,    // Swahili: retained profit
  /undistributed\s*(profit|earning)/i,
  /income\s*surplus\b/i,
];

/**
 * Module C: statutory payable account name patterns.
 * Matched against current_liabilities account names in the balance sheet.
 * Any non-zero balance in a matching account creates a statutory_payable finding.
 */
const STATUTORY_PAYABLE_PATTERNS: Array<{
  pattern:      RegExp;
  category:     string;
  title_prefix: string;
}> = [
  { pattern: /\bsdl\b/i,                         category: "sdl_outstanding",           title_prefix: "SDL Outstanding" },
  { pattern: /\bnssf\b/i,                        category: "nssf_outstanding",          title_prefix: "NSSF Outstanding" },
  { pattern: /\bnhif\b/i,                        category: "nhif_outstanding",          title_prefix: "NHIF Outstanding" },
  { pattern: /\bwcf\b/i,                         category: "wcf_outstanding",           title_prefix: "WCF Outstanding" },
  { pattern: /\bpaye\b/i,                        category: "paye_outstanding",          title_prefix: "PAYE Outstanding" },
  { pattern: /\bvat\b/i,                         category: "vat_outstanding",           title_prefix: "VAT Outstanding" },
  { pattern: /tra|tax\s*(payab|assess|due)/i,    category: "tra_assessment",            title_prefix: "TRA Tax Assessment Outstanding" },
  { pattern: /service\s*levy/i,                  category: "service_levy_outstanding",  title_prefix: "Service Levy Outstanding" },
  { pattern: /corporate\s*tax|income\s*tax/i,    category: "corporate_tax_outstanding", title_prefix: "Corporate Tax Outstanding" },
  { pattern: /\bzssf\b/i,                        category: "zssf_outstanding",          title_prefix: "ZSSF Outstanding" },
];

interface ModuleBParams {
  supabase:       SupabaseClient;
  companyId:      string;
  companyUserId:  string;  // needed for account_mappings join (keyed on user_id)
  uploadId:       string;
  periodYear:     number;
  periodMonth:    number;
  engineRunId:    string;
  triggeredBy:    string;
  dryRun:         boolean;
}

interface ModuleBResult {
  rules_evaluated:  number;
  rules_skipped:    number;
  findings_created: number;
  findings_skipped: number;
  errors:           EngineError[];
  findings_preview: FindingPreview[];
}

interface ModuleCFindingPreview {
  account_code: string;
  account_name: string;
  category:     string;
  balance_tzs:  number;
}

interface ModuleCParams {
  supabase:     SupabaseClient;
  companyId:    string;
  uploadId:     string;
  periodYear:   number;
  periodMonth:  number;
  engineRunId:  string;
  triggeredBy:  string;
  dryRun:       boolean;
}

interface ModuleCResult {
  accounts_scanned:   number;
  payables_found:     number;
  findings_created:   number;
  findings_skipped:   number;
  errors:             EngineError[];
  findings_preview:   ModuleCFindingPreview[];
}

async function runModuleB(params: ModuleBParams): Promise<ModuleBResult> {
  const { supabase, companyId, companyUserId, uploadId, periodYear, periodMonth,
          engineRunId, triggeredBy, dryRun } = params;

  const result: ModuleBResult = {
    rules_evaluated:  0,
    rules_skipped:    0,
    findings_created: 0,
    findings_skipped: 0,
    errors:           [],
    findings_preview: [],
  };

  // ── Step A: Fetch active, verified Module B rules ─────────────────────
  //
  // "Active for period" means effective_from <= period_end AND
  // (effective_to IS NULL OR effective_to >= period_start).
  //
  // Engine only fetches rules where:
  //   • trigger_account_classification IS NOT NULL  (Module B rules)
  //   • verified_at IS NOT NULL                     (gate: no draft rules)
  //   • jurisdiction = 'TZ'                         (v1.0 scope)
  //
  // The enforce_verified_statutory_rule trigger is the DB-layer final gate.
  // The engine filter is a pre-check to avoid round-trips on rules that
  // would definitely fail the trigger.

  const periodStart = `${periodYear}-${String(periodMonth).padStart(2, "0")}-01`;
  const periodEnd   = new Date(periodYear, periodMonth, 0)
    .toISOString().substring(0, 10);  // last day of month

  const { data: rules, error: ruleErr } = await supabase
    .from("statutory_rules")
    .select(`
      id, trigger_category, trigger_account_classification,
      statute, obligation, rate_is_threshold, rate_pct,
      flat_tax_tzs, threshold_amount, jurisdiction,
      effective_from, effective_to, notes, verified_at
    `)
    .not("trigger_account_classification", "is", null)
    .not("verified_at", "is", null)
    .lte("effective_from", periodEnd)
    .or(`effective_to.is.null,effective_to.gte.${periodStart}`)
    .eq("jurisdiction", "TZ");

  if (ruleErr) {
    result.errors.push({
      rule_id:          null,
      trigger_category: null,
      error_message:    `Failed to fetch statutory rules: ${ruleErr.message}`,
      stage:            "rule_fetch",
    });
    return result;
  }

  if (!rules || rules.length === 0) {
    return result;  // no verified Module B rules — nothing to do
  }

  // ── Step B: Fetch and validate trial balance processing_result ─────────
  //
  // processing_result is set by the process-trial-balance Edge Function.
  // It contains the full classified GL account structure:
  //   processing_result.statements.income_statement['operating_expenses']
  //     = { accounts: TrialBalanceAccount[], total: number }
  //
  // Guard: if processing_result.status != 'valid', the trial balance
  // failed internal accounting validation (debit ≠ credit, mapping
  // incomplete, etc.) and is not safe to use as an obligation base.
  // Abort the run — findings on an invalid GL would be misleading.

  const { data: upload, error: uploadErr } = await supabase
    .from("trial_balance_uploads")
    .select("id, processing_result, status, company_id, file_name")
    .eq("id", uploadId)
    .single();

  if (uploadErr || !upload) {
    result.errors.push({
      rule_id:          null,
      trigger_category: null,
      error_message:    `Trial balance upload ${uploadId} not found: ${uploadErr?.message ?? "no row returned"}`,
      stage:            "gl_read",
    });
    return result;
  }

  // Verify the upload belongs to the same company
  if (upload.company_id !== companyId) {
    result.errors.push({
      rule_id:          null,
      trigger_category: null,
      error_message: `Upload ${uploadId} belongs to company ${upload.company_id}, not ${companyId}. Refusing to cross-company GL read.`,
      stage:            "gl_read",
    });
    return result;
  }

  const processingResult = upload.processing_result as ProcessingResult | null;

  if (!processingResult) {
    result.errors.push({
      rule_id:          null,
      trigger_category: null,
      error_message:    `Trial balance upload ${uploadId} has no processing_result. Run process-trial-balance first.`,
      stage:            "gl_read",
    });
    return result;
  }

  if (processingResult.status !== "valid") {
    result.errors.push({
      rule_id:          null,
      trigger_category: null,
      error_message:    `Trial balance upload ${uploadId} has status '${processingResult.status}'. Only 'valid' trial balances may be used as an obligation base. Resolve validation errors first.`,
      stage:            "gl_read",
    });
    return result;
  }

  if (!processingResult.statements) {
    result.errors.push({
      rule_id:          null,
      trigger_category: null,
      error_message:    `Trial balance upload ${uploadId} has null statements despite status='valid'. Data integrity issue in process-trial-balance output.`,
      stage:            "gl_read",
    });
    return result;
  }

  // ── Step C: Evaluate each rule ─────────────────────────────────────────

  for (const rule of rules as StatutoryRule[]) {
    result.rules_evaluated++;

    try {
      // Step C1: Resolve the GL section for this rule's classification ──
      const statementKey = CLASSIFICATION_TO_STATEMENT[rule.trigger_account_classification];
      if (!statementKey) {
        result.errors.push({
          rule_id:          rule.id,
          trigger_category: rule.trigger_category,
          error_message: `Unknown account classification '${rule.trigger_account_classification}' — no mapping to financial statement. Update CLASSIFICATION_TO_STATEMENT.`,
          stage:            "gl_read",
        });
        result.rules_skipped++;
        continue;
      }

      const statementSection = processingResult.statements[statementKey];
      if (!statementSection) {
        // This statement type was not present in the trial balance (e.g.
        // no income statement accounts at all). Not an error — just skip.
        result.rules_skipped++;
        continue;
      }

      const classificationSection =
        statementSection[rule.trigger_account_classification];

      if (!classificationSection || classificationSection.accounts.length === 0) {
        // No accounts of this classification in the GL for this period.
        // Skip silently — no obligation can arise from a zero balance.
        result.rules_skipped++;
        continue;
      }

      // Step C1b: Retained earnings filter (WHT equity rules only) ──────
      //
      // UNIVERSAL DESIGN — same two-tier approach as Step C1c.
      //
      // PROBLEM: equity bucket contains ALL equity accounts:
      //   share capital, share premium, retained earnings, reserves,
      //   accumulated deficit. WHT on undistributed earnings applies only
      //   to retained earnings — not total equity.
      //
      // Detection priority:
      //
      //   TIER 1 — OVERRIDE: is_retained_earnings = true in account_mappings
      //     Explicit flag for edge-case names or code-only accounts.
      //
      //   TIER 2 — AUTO-DETECT: RETAINED_EARNINGS_NAME_PATTERNS on account name
      //     Matches: "Retained Earnings", "Accumulated Profit", "Profit b/f",
      //     "Faida Iliyobakiwa", "Undistributed Earnings", etc.
      //     Zero configuration required for standard naming conventions.
      //
      // If NEITHER tier finds any accounts: emit config error and skip.

      let effectiveAccounts = classificationSection.accounts;
      let effectiveTotal    = classificationSection.total;

      if (WHT_RETAINED_EARNINGS_CATEGORIES.has(rule.trigger_category)) {
        // TIER 1: explicit is_retained_earnings overrides from account_mappings
        const { data: retainedMappings, error: retainedErr } = await supabase
          .from("account_mappings")
          .select("account_code")
          .eq("user_id", companyUserId)
          .eq("is_retained_earnings", true);

        if (retainedErr) {
          result.errors.push({
            rule_id:          rule.id,
            trigger_category: rule.trigger_category,
            error_message:    `WHT retained earnings filter: account_mappings query failed: ${retainedErr.message}`,
            stage:            "gl_read",
          });
          result.rules_skipped++;
          continue;
        }

        const overrideRetainedCodes = new Set(
          (retainedMappings ?? []).map((m: { account_code: string }) => m.account_code)
        );

        // TIER 2: semantic name-based auto-detection
        const autoDetectedRetained = classificationSection.accounts.filter(
          (a: TrialBalanceAccount) =>
            RETAINED_EARNINGS_NAME_PATTERNS.some(p => p.test(a.account_name))
        );
        const autoDetectedRetainedCodes = new Set(
          autoDetectedRetained.map((a: TrialBalanceAccount) => a.account_code)
        );

        const retainedCodes = new Set([...overrideRetainedCodes, ...autoDetectedRetainedCodes]);

        effectiveAccounts = classificationSection.accounts.filter(
          (a: TrialBalanceAccount) => retainedCodes.has(a.account_code)
        );

        if (effectiveAccounts.length === 0) {
          result.errors.push({
            rule_id:          rule.id,
            trigger_category: rule.trigger_category,
            error_message:
              `Cannot compute ${rule.trigger_category}: no retained earnings accounts found ` +
              `for company ${companyId}. ` +
              `Auto-detection checked all equity account names against retained earnings patterns ` +
              `(retained earnings, accumulated profit, profit b/f, faida iliyobakiwa, etc.) — ` +
              `no matches found. ` +
              `Options: (1) rename the account to include "Retained Earnings" or "Accumulated Profit", ` +
              `OR (2) set is_retained_earnings = true on the account row in account_mappings.`,
            stage:            "gl_read",
          });
          result.rules_skipped++;
          continue;
        }

        effectiveTotal = effectiveAccounts.reduce(
          (sum: number, a: TrialBalanceAccount) => sum + a.balance, 0
        );

        if (effectiveTotal <= 0) {
          result.rules_skipped++;
          continue;
        }
      }

      // Step C1c: SDL payroll filter ────────────────────────────────────
      //
      // UNIVERSAL DESIGN — works for ANY chart of accounts, any ERP, any
      // naming convention.  No manual configuration required in the default case.
      //
      // Detection priority (first match wins):
      //
      //   TIER 1 — OVERRIDE: account_mappings.is_payroll_account = true
      //     Explicit preparer override.  Takes precedence over name patterns.
      //     Used for edge-case account names (e.g. "7106 Call & Extra Duty"
      //     which may or may not be gross emoluments depending on company policy).
      //     Also used when the company has accounts with non-descriptive codes
      //     only (e.g. "Account 401" with no semantic name).
      //
      //   TIER 2 — AUTO-DETECT: isGrossEmolumentAccount(account_name)
      //     Semantic pattern matching on the account name from the JSONB.
      //     Matches: "Salaries and Wages", "Basic Pay", "Mishahara", etc.
      //     Excludes: "NHIF", "NSSF", "WCF", "SDL", "PAYE" — statutory levies.
      //     Requires ZERO configuration.  Works for QuickBooks exports, Sage,
      //     Tally, manual Excel, GFS-coded accounts, Swahili names, etc.
      //
      // If NEITHER tier produces any accounts: emit config error.
      // Silently using the full opex total would produce an 83%+ over-estimate.
      //
      // Legal reference: CAP 441 s.5(1) — SDL on "gross emoluments paid to
      // employees". NHIF, NSSF, WCF, SDL expense itself are NOT emoluments.

      if (SDL_PAYROLL_CATEGORIES.has(rule.trigger_category)) {

        // TIER 1: explicit is_payroll_account overrides from account_mappings
        const { data: payrollMappings, error: payrollErr } = await supabase
          .from("account_mappings")
          .select("account_code")
          .eq("user_id", companyUserId)
          .eq("is_payroll_account", true);

        if (payrollErr) {
          result.errors.push({
            rule_id:          rule.id,
            trigger_category: rule.trigger_category,
            error_message:    `SDL payroll filter: account_mappings query failed: ${payrollErr.message}`,
            stage:            "gl_read",
          });
          result.rules_skipped++;
          continue;
        }

        const overrideCodes = new Set(
          (payrollMappings ?? []).map((m: { account_code: string }) => m.account_code)
        );

        // TIER 2: semantic name-based auto-detection
        // Scan accounts array from JSONB — same data that was always there,
        // just now the engine reads the NAME, not only the bucket total.
        const autoDetected = classificationSection.accounts.filter(
          (a: TrialBalanceAccount) => isGrossEmolumentAccount(a.account_name)
        );
        const autoDetectedCodes = new Set(autoDetected.map((a: TrialBalanceAccount) => a.account_code));

        // Merge: union of override codes and auto-detected codes
        const payrollCodes = new Set([...overrideCodes, ...autoDetectedCodes]);

        effectiveAccounts = classificationSection.accounts.filter(
          (a: TrialBalanceAccount) => payrollCodes.has(a.account_code)
        );

        if (effectiveAccounts.length === 0) {
          result.errors.push({
            rule_id:          rule.id,
            trigger_category: rule.trigger_category,
            error_message:
              `Cannot compute SDL: no payroll accounts detected for company ${companyId}. ` +
              `Auto-detection checked all operating_expenses account names against ` +
              `gross emolument patterns (salaries, wages, allowances, mishahara, etc.) — ` +
              `no matches found. ` +
              `Options: (1) rename accounts to include standard payroll terminology, ` +
              `OR (2) set is_payroll_account = true on salary/wages rows in account_mappings. ` +
              `Do NOT include NHIF, NSSF, WCF, or SDL expense — those are statutory levies, ` +
              `not gross emoluments (CAP 441 s.5(1)).`,
            stage: "gl_read",
          });
          result.rules_skipped++;
          continue;
        }

        effectiveTotal = effectiveAccounts.reduce(
          (sum: number, a: TrialBalanceAccount) => sum + a.balance, 0
        );

        if (effectiveTotal <= 0) {
          result.rules_skipped++;
          continue;
        }
      }

      // Step C2: Compute the obligation ─────────────────────────────────
      //
      // Three formula variants (per flat_tax_tzs architecture):
      //   Pure rate:   rate_pct IS NOT NULL, flat_tax_tzs IS NULL
      //   Flat only:   flat_tax_tzs IS NOT NULL, rate_pct IS NULL
      //   Compound:    both set → flat + rate × base
      //
      // Threshold rules (rate_is_threshold = true) are eligibility checks,
      // not obligation computations. They set computed_obligation = 0 and
      // the finding type is 'rule_trigger' with exposure = 0.
      // The finding flags the threshold breach; obligation is advisory.

      // Use effectiveAccounts / effectiveTotal — these are either:
      //   • The full classificationSection values (for most rules), or
      //   • The retained-earnings-filtered subset (for WHT equity rules).
      const baseAmount = effectiveTotal;
      const accounts   = effectiveAccounts;

      let computedObligation: number;
      let obligationFormula: string;

      if (rule.rate_is_threshold) {
        // Advisory threshold: check whether base exceeds threshold_amount.
        // Example: vat_registration_threshold (TZS 200M) — if revenue > 200M,
        // company should be VAT-registered. Not a tax computation.
        if (baseAmount <= (rule.threshold_amount ?? 0)) {
          // Threshold not breached — no finding
          result.rules_skipped++;
          continue;
        }
        computedObligation = 0;  // advisory — no monetary obligation computed
        obligationFormula  = `threshold_breach: base(${baseAmount.toFixed(2)}) > threshold(${rule.threshold_amount?.toFixed(2)})`;
      } else if (rule.flat_tax_tzs !== null && rule.rate_pct !== null) {
        // Compound: flat + rate × base
        computedObligation = rule.flat_tax_tzs + (rule.rate_pct / 100) * baseAmount;
        obligationFormula  = `compound: flat(${rule.flat_tax_tzs}) + rate(${rule.rate_pct}%) × base(${baseAmount.toFixed(2)})`;
      } else if (rule.flat_tax_tzs !== null) {
        // Flat only
        computedObligation = rule.flat_tax_tzs;
        obligationFormula  = `flat: ${rule.flat_tax_tzs}`;
      } else if (rule.rate_pct !== null) {
        // Pure rate
        computedObligation = (rule.rate_pct / 100) * baseAmount;
        obligationFormula  = `rate: ${rule.rate_pct}% × base(${baseAmount.toFixed(2)})`;
      } else {
        result.errors.push({
          rule_id:          rule.id,
          trigger_category: rule.trigger_category,
          error_message: `Rule has no rate_pct, flat_tax_tzs, or rate_is_threshold=true. Cannot compute obligation. Check chk_rate_or_threshold constraint — this row should not exist.`,
          stage:            "obligation_compute",
        });
        result.rules_skipped++;
        continue;
      }

      // Step C3: Payment deduction ───────────────────────────────────────
      //
      // OD-1 CLOSED (migration 20260627110000 — tax_payments table).
      //
      // Query tax_payments for the sum of all payments this company made
      // for this statutory category in this period (year + month).
      //
      // Payment sources:
      //   'preparer_declared' — CPA entered from bank statements / TRA receipts
      //   'efdms_matched'     — derived from EFDMS receipt reconciliation
      //   'tra_receipt'       — from TRA official ITAX receipt
      //
      // If no tax_payments rows exist: declaredAmount = 0 (same as v1.0 default).
      // The finding will show gross obligation. Preparer then adds payment records
      // and re-runs — next run produces the correct net figure.
      //
      // Kamanga Medics example:
      //   gross_obligation:  103,072,691
      //   declared_paid:      61,930,070  (from tax_payments for period 2025-12)
      //   net_variance:       41,142,621  ← matches Note 6 SDL outstanding exactly

      let declaredAmount    = 0;
      let paymentSource     = "none";
      let paymentRecords: { amount: number; source: string; ref: string | null }[] = [];

      const { data: payments, error: paymentsErr } = await supabase
        .from("tax_payments")
        .select("amount_paid_tzs, payment_source, payment_reference")
        .eq("company_id",  companyId)
        .eq("tax_category", rule.trigger_category)
        .eq("period_year",  periodYear)
        .eq("period_month", periodMonth);

      if (paymentsErr) {
        // Non-fatal: log warning, proceed with declaredAmount = 0
        console.warn(`[Engine] tax_payments query failed for ${rule.trigger_category}: ${paymentsErr.message}`);
      } else if (payments && payments.length > 0) {
        declaredAmount  = payments.reduce((s: number, p: { amount_paid_tzs: number }) => s + (p.amount_paid_tzs ?? 0), 0);
        paymentSource   = payments.map((p: { payment_source: string }) => p.payment_source).join(", ");
        paymentRecords  = payments.map((p: { amount_paid_tzs: number; payment_source: string; payment_reference: string | null }) => ({
          amount: p.amount_paid_tzs,
          source: p.payment_source,
          ref:    p.payment_reference,
        }));
      }

      // Step C4: Penalty calculation ─────────────────────────────────────
      //
      // TAA 2015 s.76: TRA charges 5% per month on unpaid tax from the
      // due date. For SDL: due date = 7th of the month following the
      // payroll period. We compute from period_end to today.
      //
      // IMPORTANT: This is an ESTIMATE only.  Actual penalty is assessed by
      // TRA.  The finding records computed_penalty_tzs as an advisory figure
      // for the preparer's risk assessment.  Do not use as a TRA invoice.
      const PENALTY_RATE_PER_MONTH = 0.05;  // 5% per month (TAA 2015 s.76)
      const periodEndDate  = new Date(Date.UTC(periodYear, periodMonth, 0));
      const today          = new Date();
      const msPerMonth     = 1000 * 60 * 60 * 24 * 30.44;
      const monthsOverdue  = Math.max(0, (today.getTime() - periodEndDate.getTime()) / msPerMonth);
      const netVarianceBeforePenalty = Math.max(0, computedObligation - declaredAmount);
      const penaltyTzs    = Math.round(netVarianceBeforePenalty * PENALTY_RATE_PER_MONTH * monthsOverdue);
      const totalExposure  = netVarianceBeforePenalty + penaltyTzs;

      // Step C5: Variance ────────────────────────────────────────────────
      const variance    = computedObligation - declaredAmount;
      const variancePct = computedObligation > 0
        ? Math.round((variance / computedObligation) * 10_000) / 100  // 2dp
        : null;

      // Step C6: Threshold gate ─────────────────────────────────────────
      // Gate on NET variance (after declared payments), not gross obligation.
      // A company that paid in full (net_variance ≤ threshold) has no finding.
      if (!rule.rate_is_threshold && Math.abs(variance) < VARIANCE_THRESHOLD_TZS) {
        result.findings_skipped++;
        continue;
      }

      // Step C7: SDL payroll filter confirmation note ──────────────────
      // OD-2 closed. SDL base is now the is_payroll_account-filtered subset.
      // The note records which accounts were included so reviewers can verify
      // that the payroll flag is correct for this company.
      const isSDL = rule.trigger_category === "sdl";
      const payrollBaseNote = isSDL
        ? `SDL base filtered to is_payroll_account=true accounts only ` +
          `(OD-2 closed, migration 20260626200000). ` +
          `Base TZS ${baseAmount.toFixed(2)} = sum of ${effectiveAccounts.length} payroll account(s). ` +
          `Non-emolument accounts (NHIF, NSSF, WCF, SDL expense, rent, utilities) excluded.`
        : undefined;

      // Step C8: Build the finding row ──────────────────────────────────
      //
      // Exactly matches the findings table schema from migration 20260625100000.
      // Key constraints to satisfy:
      //   • finding_type = 'rule_trigger' → statutory_rule_id MUST NOT be NULL (V1 trigger)
      //   • statutory_rule_id IS NOT NULL → referenced rule.verified_at IS NOT NULL (V2 trigger)
      //   • exposure_amount_tzs >= 0 (CHECK constraint)
      //   • created_by must be a valid UUID (auth.uid() returns NULL under service role)

      const periodLabel   = `${periodYear}-${String(periodMonth).padStart(2, "0")}`;
      const periodStart_d = new Date(Date.UTC(periodYear, periodMonth - 1, 1))
        .toISOString().substring(0, 10);
      const periodEnd_d   = new Date(Date.UTC(periodYear, periodMonth, 0))
        .toISOString().substring(0, 10);

      const finding = {
        company_id:              companyId,
        statutory_rule_id:       rule.id,       // REQUIRED for 'rule_trigger' — V1 satisfied
        upload_id:               uploadId,
        finding_type:            "rule_trigger",
        title:                   buildFindingTitle(rule, periodLabel),
        statute_reference:       rule.statute,
        period_start:            periodStart_d,
        period_end:              periodEnd_d,
        exposure_amount_tzs:     Math.max(0, variance),   // net variance (after payments)
        base_amount_tzs:         baseAmount,
        comparison_amount_tzs:   declaredAmount,
        computed_obligation_tzs: computedObligation,
        interest_amount_tzs:     null,                    // assessed by TRA on notice
        penalty_amount_tzs:      penaltyTzs > 0 ? penaltyTzs : null,  // TAA s.76 estimate
        source_detail: {
          // ── Engine provenance ──
          engine_version:   ENGINE_VERSION,
          engine_run_id:    engineRunId,
          upload_id:        uploadId,
          upload_file_name: upload.file_name,
          // ── Rule snapshot ─────
          rule_id:                         rule.id,
          trigger_category:                rule.trigger_category,
          trigger_account_classification:  rule.trigger_account_classification,
          statute:                         rule.statute,
          rate_pct:                        rule.rate_pct,
          flat_tax_tzs:                    rule.flat_tax_tzs,
          rate_is_threshold:               rule.rate_is_threshold,
          threshold_amount:                rule.threshold_amount,
          rule_effective_from:             rule.effective_from,
          // ── Obligation computation ──
          obligation_formula:              obligationFormula,
          base_amount_tzs:                 baseAmount,
          computed_obligation_tzs:         computedObligation,
          declared_amount_tzs:             declaredAmount,
          variance_tzs:                    variance,
          variance_pct:                    variancePct,
          // ── Payment deduction (OD-1 closed) ───
          payment_records:                 paymentRecords,
          payment_source:                  paymentSource,
          months_overdue:                  Math.round(monthsOverdue * 10) / 10,
          estimated_penalty_tzs:           penaltyTzs,
          estimated_total_exposure_tzs:    totalExposure,
          penalty_basis:                   "TAA 2015 s.76: 5% per month on unpaid tax from period_end",
          penalty_disclaimer:              "Advisory estimate only. Actual penalty assessed by TRA on written notice.",
          // ── GL evidence ───────
          period_year:                     periodYear,
          period_month:                    periodMonth,
          account_balances:                accounts.map((a: TrialBalanceAccount) => ({
            account_code: a.account_code,
            account_name: a.account_name,
            debit:        a.debit,
            credit:       a.credit,
            balance:      a.balance,
          })),
          account_count:                   accounts.length,
          ...(payrollBaseNote ? { sdl_payroll_base_note: payrollBaseNote } : {}),
        },
        status:        "open",
        engine_run_id: engineRunId,  // column added by migration 20260626190000
        created_by:    triggeredBy,  // explicit: auth.uid() returns NULL under service_role
      };

      // Step C9: Insert finding (or preview if dry_run) ─────────────────
      if (dryRun) {
        result.findings_preview.push({
          trigger_category:            rule.trigger_category,
          statutory_rule_id:           rule.id,
          base_amount_tzs:             baseAmount,
          computed_obligation_tzs:     computedObligation,
          declared_amount_tzs:         declaredAmount,
          net_variance_tzs:            Math.max(0, variance),
          variance_pct:                variancePct,
          estimated_penalty_tzs:       penaltyTzs,
          estimated_total_exposure_tzs:totalExposure,
          months_overdue:              Math.round(monthsOverdue * 10) / 10,
          account_count:               accounts.length,
          payment_records:             paymentRecords,
        });
        result.findings_created++;
        continue;
      }

      const { error: insertErr } = await supabase
        .from("findings")
        .insert(finding);

      if (insertErr) {
        // Duplicate: a finding for this rule + period + company already exists.
        // ON CONFLICT is not available on findings (no unique constraint scoped
        // to company+rule+period). Log and skip to avoid double-counting.
        if (insertErr.code === "23505") {
          result.findings_skipped++;
          continue;
        }
        // Trigger violation (23514): enforce_verified_statutory_rule fired.
        // This should not happen given pre-flight rule filter, but if it does,
        // it is a hard stop — log the error and move on.
        result.errors.push({
          rule_id:          rule.id,
          trigger_category: rule.trigger_category,
          error_message:    `INSERT into findings failed: ${insertErr.message} (code: ${insertErr.code})`,
          stage:            "finding_insert",
        });
        continue;
      }

      result.findings_created++;

    } catch (err) {
      result.errors.push({
        rule_id:          rule.id,
        trigger_category: rule.trigger_category,
        error_message:    `Unexpected error: ${(err as Error).message}`,
        stage:            "obligation_compute",
      });
      result.rules_skipped++;
    }
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function buildFindingTitle(rule: StatutoryRule, periodLabel: string): string {
  const labels: Record<string, string> = {
    sdl:                                   "Skills Development Levy (SDL)",
    wht_undistributed_earnings:            "WHT — Undistributed Earnings",
    retained_earnings_deemed_distribution: "WHT — Retained Earnings Deemed Distribution",
    presumptive_tax_threshold:             "Presumptive Tax — Eligibility Threshold",
    presumptive_tax_top_band_rate:         "Presumptive Tax — Top Band Rate",
    presumptive_tax_band1:                 "Presumptive Tax — Band 1",
    presumptive_tax_band2_new_tin:         "Presumptive Tax — Band 2 (New TIN)",
    presumptive_tax_band3_compliant:       "Presumptive Tax — Band 3 (Compliant)",
    presumptive_tax_band3_noncompliant:    "Presumptive Tax — Band 3 (Non-Compliant)",
    presumptive_tax_band4_compliant:       "Presumptive Tax — Band 4 (Compliant)",
    presumptive_tax_band4_noncompliant:    "Presumptive Tax — Band 4 (Non-Compliant)",
    vat_registration_threshold:            "VAT Registration Threshold Breach (Advisory)",
  };
  const label = labels[rule.trigger_category] ?? rule.trigger_category;
  return `${label} — ${periodLabel}`;
}

// ── Module C: Statutory Payables Detector ────────────────────────────────
//
// Reads current_liabilities from the trial balance processing_result.
// Pattern-matches account names against known statutory payable categories.
// Any non-zero balance creates a 'statutory_payable' finding automatically.
//
// This module requires NO statutory_rules rows and NO verified_at check.
// The outstanding balance IS the obligation — the company owes it today.
//
// Trigger compatibility:
//   finding_type = 'statutory_payable', statutory_rule_id = NULL
//   V1 trigger: only fires when finding_type = 'rule_trigger' AND
//               statutory_rule_id IS NULL → does NOT fire here
//   V2 trigger: only fires when statutory_rule_id IS NOT NULL AND
//               verified_at IS NULL → does NOT fire here (rule_id is null)
//
// Dedup note (OD-13):
//   uq_finding_per_rule_per_period is scoped to statutory_rule_id IS NOT NULL.
//   Module C findings (null rule_id) are NOT deduplicated by that constraint.
//   Running Module C twice creates duplicates. Fix in v1.1: add
//   UNIQUE(company_id, upload_id, finding_type, source_detail->>'account_code').

async function runModuleC(params: ModuleCParams): Promise<ModuleCResult> {
  const { supabase, companyId, uploadId, periodYear, periodMonth,
          engineRunId, triggeredBy, dryRun } = params;

  const result: ModuleCResult = {
    accounts_scanned:   0,
    payables_found:     0,
    findings_created:   0,
    findings_skipped:   0,
    errors:             [],
    findings_preview:   [],
  };

  // Fetch the processing_result for current_liabilities
  const { data: upload, error: uploadErr } = await supabase
    .from("trial_balance_uploads")
    .select("processing_result, file_name, company_id")
    .eq("id", uploadId)
    .single();

  if (uploadErr || !upload) {
    result.errors.push({
      rule_id:          null,
      trigger_category: null,
      error_message:    `Module C: failed to fetch upload ${uploadId}: ${uploadErr?.message ?? "not found"}`,
      stage:            "gl_read",
    });
    return result;
  }

  if (upload.company_id !== companyId) {
    result.errors.push({
      rule_id:          null,
      trigger_category: null,
      error_message:    `Module C: upload ${uploadId} belongs to different company. Refusing.`,
      stage:            "gl_read",
    });
    return result;
  }

  const pr = upload.processing_result as ProcessingResult | null;
  if (!pr || pr.status !== "valid" || !pr.statements) return result;

  const currentLiabilities = pr.statements.balance_sheet?.["current_liabilities"];
  if (!currentLiabilities || currentLiabilities.accounts.length === 0) {
    // No current_liabilities in this TB — Module C produces no findings.
    // Common for TB uploads that only map income statement accounts.
    return result;
  }

  const periodStart_d = new Date(Date.UTC(periodYear, periodMonth - 1, 1))
    .toISOString().substring(0, 10);
  const periodEnd_d   = new Date(Date.UTC(periodYear, periodMonth, 0))
    .toISOString().substring(0, 10);
  const periodLabel   = `${periodYear}-${String(periodMonth).padStart(2, "0")}`;

  for (const account of currentLiabilities.accounts) {
    result.accounts_scanned++;

    // Payables have credit-normal balances; positive balance = amount owed
    if (account.balance <= 0) continue;

    const match = STATUTORY_PAYABLE_PATTERNS.find(p => p.pattern.test(account.account_name));
    if (!match) continue;

    result.payables_found++;

    if (account.balance < VARIANCE_THRESHOLD_TZS) {
      result.findings_skipped++;
      continue;
    }

    if (dryRun) {
      result.findings_preview.push({
        account_code: account.account_code,
        account_name: account.account_name,
        category:     match.category,
        balance_tzs:  account.balance,
      });
      result.findings_created++;
      continue;
    }

    const { error: insertErr } = await supabase
      .from("findings")
      .insert({
        company_id:              companyId,
        statutory_rule_id:       null,         // no rule — bypasses V1/V2 trigger checks
        upload_id:               uploadId,
        finding_type:            "statutory_payable",
        title:                   `${match.title_prefix} — ${periodLabel}`,
        statute_reference:       null,
        period_start:            periodStart_d,
        period_end:              periodEnd_d,
        exposure_amount_tzs:     account.balance,
        base_amount_tzs:         account.balance,
        comparison_amount_tzs:   0,
        computed_obligation_tzs: account.balance,
        interest_amount_tzs:     null,
        penalty_amount_tzs:      null,
        source_detail: {
          module:            "C",
          engine_version:    ENGINE_VERSION,
          engine_run_id:     engineRunId,
          upload_id:         uploadId,
          upload_file_name:  upload.file_name,
          category:          match.category,
          account_code:      account.account_code,
          account_name:      account.account_name,
          balance_tzs:       account.balance,
          detection_method:  "balance_sheet_current_liabilities_pattern_match",
          note:
            "Outstanding statutory payable detected from balance sheet current_liabilities. " +
            "The balance IS the obligation — this amount is already due to the authority. " +
            "Collect payment evidence and settlement details via evidence_requests.",
        },
        status:        "open",
        engine_run_id: engineRunId,
        created_by:    triggeredBy,
      });

    if (insertErr) {
      result.errors.push({
        rule_id:          null,
        trigger_category: match.category,
        error_message:    `Module C INSERT failed: ${insertErr.message} (code: ${insertErr.code})`,
        stage:            "finding_insert",
      });
      continue;
    }

    result.findings_created++;
  }

  return result;
}

function respond(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
