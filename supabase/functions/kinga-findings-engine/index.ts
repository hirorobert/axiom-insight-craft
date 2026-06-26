// ============================================================
// Kinga Findings Engine — Module B: Rule Trigger
// Edge Function: kinga-findings-engine
// Version: Module B v1.0
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
// SDL v1.0 limitation:
//   trigger_account_classification = 'operating_expenses' captures
//   ALL operating expense accounts (rent, utilities, etc.), not
//   payroll only.  SDL base is over-estimated until a payroll flag
//   is implemented on account_mappings (open decision OD-2).
//   This limitation is documented in source_detail.payroll_limitation_note
//   on every SDL finding so reviewers are not misled.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Constants ────────────────────────────────────────────────────────────

const ENGINE_VERSION = "Module B v1.0";

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
  rules_evaluated:  number;
  rules_skipped:    number;   // no matching GL accounts or amount too small
  findings_created: number;
  findings_skipped: number;   // variance below threshold
  errors:           EngineError[];
  dry_run:          boolean;
  findings_preview?: FindingPreview[];  // populated when dry_run = true
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

  // ── 6. Run the engine ─────────────────────────────────────────────────
  const result = await runModuleB({
    supabase,
    companyId:      company_id,
    companyUserId:  company.user_id,  // for account_mappings retained_earnings filter
    uploadId:       upload_id,
    periodYear:     period_year,
    periodMonth:    period_month,
    engineRunId,
    triggeredBy,
    dryRun:         dry_run,
  });

  // ── 7. Write audit log ────────────────────────────────────────────────
  if (!dry_run) {
    await supabase.from("audit_logs").insert({
      user_id:     triggeredBy,
      action:      result.errors.length === 0
        ? "reconciliation_engine_completed"
        : "reconciliation_engine_partial",
      entity_type: "company",
      entity_id:   company_id,
      metadata: {
        engine_run_id:    engineRunId,
        engine_version:   ENGINE_VERSION,
        upload_id,
        period_year,
        period_month,
        rules_evaluated:  result.rules_evaluated,
        findings_created: result.findings_created,
        findings_skipped: result.findings_skipped,
        error_count:      result.errors.length,
      },
    });
  }

  return respond(200, {
    engine_run_id:    engineRunId,
    company_id,
    period_year,
    period_month,
    rules_evaluated:  result.rules_evaluated,
    rules_skipped:    result.rules_skipped,
    findings_created: result.findings_created,
    findings_skipped: result.findings_skipped,
    errors:           result.errors,
    dry_run,
    ...(dry_run ? { findings_preview: result.findings_preview } : {}),
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
      // BLOCKER ADDRESSED: processing_result.statements.balance_sheet.equity
      // contains ALL equity accounts (share capital, retained earnings, reserves,
      // accumulated deficit). For WHT on undistributed earnings, the obligation
      // base is ONLY retained earnings — not total equity.
      //
      // Without this filter, a company with TZS 500M share capital and TZS 10M
      // retained earnings would have WHT computed on TZS 510M instead of TZS 10M.
      //
      // Fix: for WHT retained-earnings categories, do a secondary query to
      // account_mappings (keyed on user_id) and filter classificationSection.accounts
      // to only those where is_retained_earnings = true.
      //
      // If NO accounts are flagged is_retained_earnings = true, abort with an error.
      // The finding cannot be computed safely without knowing which accounts are
      // retained earnings — a silent zero-base finding would be misleading.

      let effectiveAccounts = classificationSection.accounts;
      let effectiveTotal    = classificationSection.total;

      if (WHT_RETAINED_EARNINGS_CATEGORIES.has(rule.trigger_category)) {
        const { data: retainedMappings, error: retainedErr } = await supabase
          .from("account_mappings")
          .select("account_code")
          .eq("user_id", companyUserId)
          .eq("is_retained_earnings", true);

        if (retainedErr) {
          result.errors.push({
            rule_id:          rule.id,
            trigger_category: rule.trigger_category,
            error_message:    `Failed to query account_mappings for retained earnings filter: ${retainedErr.message}`,
            stage:            "gl_read",
          });
          result.rules_skipped++;
          continue;
        }

        if (!retainedMappings || retainedMappings.length === 0) {
          // No accounts are flagged as retained earnings for this company.
          // Cannot compute WHT — emit a configuration error finding, not a silent skip.
          // A silent skip would hide the gap from the preparer.
          result.errors.push({
            rule_id:          rule.id,
            trigger_category: rule.trigger_category,
            error_message:
              `Cannot compute ${rule.trigger_category}: no account_mappings rows have ` +
              `is_retained_earnings = true for company ${companyId} (user_id: ${companyUserId}). ` +
              `Flag the retained earnings account(s) in account_mappings and re-run.`,
            stage:            "gl_read",
          });
          result.rules_skipped++;
          continue;
        }

        const retainedCodes = new Set(retainedMappings.map((m: { account_code: string }) => m.account_code));

        effectiveAccounts = classificationSection.accounts.filter(
          (a: TrialBalanceAccount) => retainedCodes.has(a.account_code)
        );

        if (effectiveAccounts.length === 0) {
          // Retained earnings accounts exist in mappings but NONE appear in the GL
          // for this upload period (zero balance or not included in TB).
          // This is a skip — no retained earnings balance, no WHT obligation.
          result.rules_skipped++;
          continue;
        }

        effectiveTotal = effectiveAccounts.reduce(
          (sum: number, a: TrialBalanceAccount) => sum + a.balance, 0
        );

        // If total is zero or negative, no undistributed earnings to tax.
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

      // Step C3: Declared amount ─────────────────────────────────────────
      //
      // OD-1 (Open Decision): There is currently no tax_payments table or
      // SDL returns table in the schema. Declared amount defaults to 0.
      // This means every SDL finding will show 100% variance until payment
      // data is added.  The evidence_requests workflow handles collection
      // of actual payment evidence.  This is intentional for v1.0: it is
      // safer to flag and collect evidence than to silently assume 0 variance.
      const declaredAmount = 0;

      // Step C4: Variance ───────────────────────────────────────────────
      const variance    = computedObligation - declaredAmount;
      const variancePct = computedObligation > 0
        ? Math.round((variance / computedObligation) * 10_000) / 100  // 2dp
        : null;

      // Step C5: Threshold gate ─────────────────────────────────────────
      if (!rule.rate_is_threshold && Math.abs(variance) < VARIANCE_THRESHOLD_TZS) {
        result.findings_skipped++;
        continue;
      }

      // Step C6: SDL-specific payroll limitation note ───────────────────
      const isSDL = rule.trigger_category === "sdl";
      const payrollLimitationNote = isSDL
        ? `v1.0 limitation: SDL base = sum of ALL operating_expenses-classified GL accounts ` +
          `(TZS ${baseAmount.toFixed(2)}). This includes non-payroll costs (rent, utilities, depreciation). ` +
          `Actual SDL base = payroll/salary costs only. Obligation is likely OVER-ESTIMATED ` +
          `until a payroll flag is added to account_mappings (open decision OD-2).`
        : undefined;

      // Step C7: Build the finding row ──────────────────────────────────
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
        exposure_amount_tzs:     Math.max(0, variance),  // CHECK: must be >= 0
        base_amount_tzs:         baseAmount,
        comparison_amount_tzs:   declaredAmount,
        computed_obligation_tzs: computedObligation,
        interest_amount_tzs:     null,   // computed on TRA notice receipt
        penalty_amount_tzs:      null,   // computed on TRA notice receipt
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
          // ── Open decisions ────
          declared_amount_source:
            "OD-1: No tax_payments table exists in v1.0. Declared = 0. Collect via evidence_requests.",
          ...(payrollLimitationNote ? { payroll_limitation_note: payrollLimitationNote } : {}),
        },
        status:        "open",
        engine_run_id: engineRunId,  // column added by migration 20260626190000
        created_by:    triggeredBy,  // explicit: auth.uid() returns NULL under service_role
      };

      // Step C8: Insert finding (or preview if dry_run) ─────────────────
      if (dryRun) {
        result.findings_preview.push({
          trigger_category:        rule.trigger_category,
          statutory_rule_id:       rule.id,
          base_amount_tzs:         baseAmount,
          computed_obligation_tzs: computedObligation,
          declared_amount_tzs:     declaredAmount,
          variance_tzs:            variance,
          variance_pct:            variancePct,
          account_count:           accounts.length,
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

function respond(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
