// ============================================================
// Kinga Tax Engine — Module E: ITA Corporate Tax Computation
// Edge Function: kinga-tax-engine
// Version: Module E v1.0
// Date: 2026-06-28
//
// Tanzania Income Tax Act (Chapter 332) Implementation
//
// WATERFALL:
//   1. Accounting Profit Before Tax           (from TB income statement)
//   2. ADD: Non-deductible expenses           (auto-detected by name pattern)
//      + Accounting depreciation              (s.34 — replaced by wear & tear)
//      + Entertainment (50% disallowed)       (s.11(3))
//      + Penalties & fines                    (not deductible)
//      + Provisions for bad/doubtful debt     (only write-offs allowed)
//      + Excess management fees               (s.33(3) — >2% of turnover)
//      + Thin cap disallowed interest         (s.24A — 70:30 debt:equity)
//   3. DEDUCT: ITA allowances
//      - Wear & tear (capital_allowances)     (s.34 — by asset class)
//      - Prior year losses                    (s.19 — 5 year carry-forward)
//   4. Taxable Income
//   5. CIT = 30% × max(0, Taxable Income)
//   6. Minimum Tax = 0.5% × Gross Income     (s.65 — if CIT < min tax)
//   7. Tax Payable = max(CIT, Minimum Tax)
//   8. Gap = Tax Payable − Income Tax Provision (from balance sheet)
//   9. Penalty = Gap × 5%/month × months_overdue (TAA 2015 s.76)
//  10. Commit → tax_computations table + findings table
//
// dry_run: returns computation preview without writing to DB.
// commit:  writes tax_computations row + creates finding if gap > threshold.
//
// Account detection uses pattern matching on account names from
// processing_result.statements — zero configuration required.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ENGINE_VERSION = "Module E v1.0";

// ── ITA CONSTANTS ────────────────────────────────────────────────────────
const CIT_RATE                  = 0.30;   // ITA s.4 — standard CIT rate
const MINIMUM_TAX_RATE          = 0.005;  // ITA s.65 — 0.5% of gross income
const ENTERTAINMENT_DISALLOWED  = 0.50;   // ITA s.11(3) — 50% of entertainment
const MGMT_FEE_TURNOVER_LIMIT   = 0.02;  // ITA s.33(3) — 2% of turnover
const THIN_CAP_MAX_RATIO        = 70/30; // ITA s.24A — 2.333... debt:equity
const PENALTY_RATE_PER_MONTH    = 0.05;  // TAA 2015 s.76 — 5%/month on unpaid tax
const VARIANCE_THRESHOLD_TZS    = 500_000; // Don't raise a finding below 500K

// ── WEAR & TEAR RATES (ITA s.34) ─────────────────────────────────────────
const ITA_CLASS_RATES: Record<number, number> = {
  1: 0.500,   // Computers & data-handling equipment
  2: 0.375,   // Commercial vehicles & aircraft
  3: 0.250,   // Plant, machinery & equipment
  4: 0.125,   // Furniture, fixtures & fittings
  5: 0.050,   // Buildings (straight-line on cost)
};

const ITA_CLASS_NAMES: Record<number, string> = {
  1: "Computers & data equipment (50%)",
  2: "Commercial vehicles & aircraft (37.5%)",
  3: "Plant, machinery & equipment (25%)",
  4: "Furniture & fittings (12.5%)",
  5: "Buildings — straight-line (5%)",
};

// ── ACCOUNT NAME DETECTION PATTERNS ─────────────────────────────────────

const DEPRECIATION_PATTERNS = [
  /depreciation/i, /amortis[ae]tion/i, /amortiz[ae]tion/i,
  /\bD&A\b/i, /thamani\s+ya\s+mali/i,
];
const ENTERTAINMENT_PATTERNS = [
  /entertainment/i, /hospitality/i, /\bfunction\b/i, /team.?build/i,
  /refreshment/i, /client\s*(lunch|dinner|meal)/i, /staff\s*party/i,
  /\bbusiness\s*meal/i,
];
const PENALTY_PATTERNS = [
  /\bpenalt/i, /\bfine[s]?\b/i, /\bsurcharge\b/i,
  /interest\s+on\s+tax/i, /tax\s+interest/i, /late\s+payment\s+interest/i,
];
const PROVISION_PATTERNS = [
  /provision\s+for\s+(bad|doubtful|debt|impairment|loss)/i,
  /bad\s+debt\s+provision/i, /doubtful\s+debt/i,
  /impairment\s+(loss|of\s+(trade|receivable))/i,
  /akiba\s+ya\s+madeni/i,
];
const MGMT_FEE_PATTERNS = [
  /management\s+fee/i, /head\s+office\s+(charge|fee|cost)/i,
  /technical\s+service\s+fee/i, /\b(royalt)/i,
  /\bHO\s+(fee|charge|cost)\b/i,
];
const INTEREST_EXPENSE_PATTERNS = [
  /interest\s+expense/i, /interest\s+on\s+(loan|borrow|overdraft|debt)/i,
  /finance\s+(charge|cost)/i, /\bfinance\s+costs?\b/i,
  /riba\b/i,
];
const INCOME_TAX_PROVISION_PATTERNS = [
  /income\s+tax\s+payable/i, /current\s+tax\s+payable/i,
  /corporate\s+tax\s+payable/i, /corporation\s+tax/i,
  /\bCIT\s+payable/i, /provision\s+for\s+(income\s+)?tax/i,
  /tax\s+provision/i,
];
const LONG_TERM_DEBT_PATTERNS = [
  /\bterm\s+loan/i, /long.?term\s+(loan|borrowing|debt)/i,
  /\bdebenture/i, /\bbond\s+payable/i,
  /mortgage\s+(payable|loan)/i, /bank\s+loan\b/i,
  /mkopo\s+wa\s+muda\s+mrefu/i,
];
const SHORT_TERM_DEBT_PATTERNS = [
  /short.?term\s+(loan|borrowing)/i, /\boverdraft/i,
  /bank\s+overdraft/i, /credit\s+facilit/i,
  /current\s+portion.*loan/i,
];
const EQUITY_PATTERNS = [
  /share\s+capital/i, /paid.{0,4}up\s+capital/i, /ordinary\s+share/i,
  /retained\s+earn/i, /accumulated\s+(profit|surplus|deficit)/i,
  /capital\s+reserve/i, /hisa\s+la\s+mtaji/i, /faida\s+iliyobakiwa/i,
  /\bequity\b/i, /shareholders.*fund/i,
];

// ── TYPE DEFINITIONS ─────────────────────────────────────────────────────

interface TBAccount {
  name: string;
  balance: number;
  code?: string;
  is_payroll_account?: boolean;
  is_retained_earnings?: boolean;
}

interface TBSection {
  accounts: TBAccount[];
  total: number;
}

interface ProcessingResult {
  statements: {
    income_statement: {
      revenue:           TBSection;
      cost_of_goods_sold:TBSection;
      gross_profit:      number;
      operating_expenses:TBSection;
      operating_profit:  number;
      other_income:      TBSection;
      finance_costs:     TBSection;
      profit_before_tax: number;
      taxes:             TBSection;
      profit_after_tax:  number;
    };
    balance_sheet: {
      current_assets:        TBSection;
      non_current_assets:    TBSection;
      current_liabilities:   TBSection;
      non_current_liabilities:TBSection;
      equity:                TBSection;
    };
  };
}

interface TaxAdjustment {
  description: string;
  amount_tzs: number;
  ita_section: string;
  account_names: string[];
  auto_detected: boolean;
}

interface TaxComputationResult {
  engine_version:                   string;
  company_id:                       string;
  upload_id:                        string;
  period_year:                      number;
  dry_run:                          boolean;

  // Waterfall
  accounting_profit_before_tax_tzs: number;
  gross_income_tzs:                 number;
  add_backs:                        TaxAdjustment[];
  deductions:                       TaxAdjustment[];
  total_add_backs_tzs:              number;
  total_deductions_tzs:             number;
  total_wear_tear_tzs:              number;

  // Thin cap
  total_debt_tzs:                   number;
  total_equity_tzs:                 number;
  debt_equity_ratio:                number;
  allowable_debt_tzs:               number;
  interest_expense_tzs:             number;
  thin_cap_disallowed_tzs:          number;

  // Tax charge
  taxable_income_tzs:               number;
  cit_at_30pct_tzs:                 number;
  minimum_tax_tzs:                  number;
  tax_payable_tzs:                  number;
  minimum_tax_applies:              boolean;
  effective_tax_rate_pct:           number;

  // Gap
  income_tax_provision_tzs:         number;
  cit_gap_tzs:                      number;

  // Penalty
  months_overdue:                   number;
  penalty_tzs:                      number;
  total_exposure_tzs:               number;

  // Meta
  warnings:                         string[];
  finding_created:                  boolean;
}

// ── HELPERS ──────────────────────────────────────────────────────────────

function matchesAny(name: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(name));
}

function sumMatchingAccounts(accounts: TBAccount[], patterns: RegExp[]): {
  total: number;
  names: string[];
} {
  const matched = accounts.filter(a => matchesAny(a.name, patterns));
  return {
    total: matched.reduce((s, a) => s + Math.abs(a.balance), 0),
    names: matched.map(a => a.name),
  };
}

function flattenAll(pr: ProcessingResult): TBAccount[] {
  const is = pr.statements.income_statement;
  const bs = pr.statements.balance_sheet;
  return [
    ...(is.revenue?.accounts           ?? []),
    ...(is.cost_of_goods_sold?.accounts?? []),
    ...(is.operating_expenses?.accounts?? []),
    ...(is.other_income?.accounts      ?? []),
    ...(is.finance_costs?.accounts     ?? []),
    ...(is.taxes?.accounts             ?? []),
    ...(bs.current_assets?.accounts    ?? []),
    ...(bs.non_current_assets?.accounts?? []),
    ...(bs.current_liabilities?.accounts??[]),
    ...(bs.non_current_liabilities?.accounts??[]),
    ...(bs.equity?.accounts            ?? []),
  ];
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { uploadId, companyId, periodYear, dry_run = true, months_overdue = 0 } = await req.json();

    if (!uploadId || !companyId || !periodYear) {
      return new Response(JSON.stringify({ error: "uploadId, companyId, periodYear required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const warnings: string[] = [];

    // ── STEP 1: Load processing_result ───────────────────────────────────
    const { data: upload, error: uploadErr } = await supabase
      .from("trial_balance_uploads")
      .select("processing_result, company_id, company_name")
      .eq("id", uploadId)
      .eq("company_id", companyId)
      .single();

    if (uploadErr || !upload?.processing_result) {
      return new Response(JSON.stringify({ error: "Upload not found or not processed" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const pr = upload.processing_result as ProcessingResult;
    const is = pr?.statements?.income_statement;
    const bs = pr?.statements?.balance_sheet;

    if (!is || !bs) {
      return new Response(JSON.stringify({
        error: "processing_result missing statements. Re-process the trial balance first.",
      }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── STEP 2: Accounting Profit Before Tax ─────────────────────────────
    const accountingPBT = is.profit_before_tax ?? 0;
    const grossIncome   = Math.abs(is.revenue?.total ?? 0);

    if (grossIncome === 0) warnings.push("Revenue is zero — minimum tax computation may be incorrect.");
    if (accountingPBT === 0) warnings.push("Profit before tax is zero — check that income statement is complete.");

    // ── STEP 3: Gather ALL accounts for pattern matching ─────────────────
    const opexAccounts   = is.operating_expenses?.accounts ?? [];
    const financeAccounts= is.finance_costs?.accounts      ?? [];
    const allISAccounts  = [
      ...opexAccounts, ...financeAccounts,
      ...(is.other_income?.accounts ?? []),
      ...(is.taxes?.accounts ?? []),
    ];
    const bsCLAccounts   = bs.current_liabilities?.accounts     ?? [];
    const bsNCLAccounts  = bs.non_current_liabilities?.accounts ?? [];
    const bsEquityAccounts = bs.equity?.accounts                ?? [];
    const allBSAccounts  = [...bsCLAccounts, ...bsNCLAccounts, ...bsEquityAccounts,
                            ...(bs.current_assets?.accounts ?? []),
                            ...(bs.non_current_assets?.accounts ?? [])];

    const addBacks: TaxAdjustment[] = [];

    // ── STEP 4a: Add-back — Accounting Depreciation (ITA s.34) ───────────
    const { total: deprAmount, names: deprNames } =
      sumMatchingAccounts(allISAccounts, DEPRECIATION_PATTERNS);
    if (deprAmount > 0) {
      addBacks.push({
        description: "Accounting depreciation & amortisation (disallowed; replaced by ITA s.34 wear & tear)",
        amount_tzs: deprAmount,
        ita_section: "s.34",
        account_names: deprNames,
        auto_detected: true,
      });
    } else {
      warnings.push("No depreciation accounts detected. If the company has fixed assets, enter them in Capital Allowances.");
    }

    // ── STEP 4b: Add-back — Entertainment 50% (ITA s.11(3)) ─────────────
    const { total: entTotal, names: entNames } =
      sumMatchingAccounts(allISAccounts, ENTERTAINMENT_PATTERNS);
    if (entTotal > 0) {
      addBacks.push({
        description: "Entertainment expenses — 50% disallowed (ITA s.11(3))",
        amount_tzs: Math.round(entTotal * ENTERTAINMENT_DISALLOWED),
        ita_section: "s.11(3)",
        account_names: entNames,
        auto_detected: true,
      });
    }

    // ── STEP 4c: Add-back — Penalties & Fines ────────────────────────────
    const { total: penAmount, names: penNames } =
      sumMatchingAccounts(allISAccounts, PENALTY_PATTERNS);
    if (penAmount > 0) {
      addBacks.push({
        description: "Penalties, fines and interest on taxes (non-deductible)",
        amount_tzs: penAmount,
        ita_section: "s.11(1)",
        account_names: penNames,
        auto_detected: true,
      });
    }

    // ── STEP 4d: Add-back — Provisions for bad/doubtful debt ─────────────
    const { total: provAmount, names: provNames } =
      sumMatchingAccounts(allISAccounts, PROVISION_PATTERNS);
    if (provAmount > 0) {
      addBacks.push({
        description: "Provision for bad/doubtful debts (only actual write-offs deductible under ITA s.25)",
        amount_tzs: provAmount,
        ita_section: "s.25",
        account_names: provNames,
        auto_detected: true,
      });
    }

    // ── STEP 4e: Add-back — Excess Management Fees (ITA s.33(3)) ─────────
    const { total: mgmtFeeTotal, names: mgmtFeeNames } =
      sumMatchingAccounts(allISAccounts, MGMT_FEE_PATTERNS);
    if (mgmtFeeTotal > 0) {
      const allowableMgmtFee = Math.round(grossIncome * MGMT_FEE_TURNOVER_LIMIT);
      const excessMgmtFee = Math.max(0, mgmtFeeTotal - allowableMgmtFee);
      if (excessMgmtFee > 0) {
        addBacks.push({
          description: `Excess management/technical service fees (ITA s.33(3): allowed up to 2% of turnover = TZS ${allowableMgmtFee.toLocaleString()})`,
          amount_tzs: excessMgmtFee,
          ita_section: "s.33(3)",
          account_names: mgmtFeeNames,
          auto_detected: true,
        });
      }
    }

    // ── STEP 5: Thin Capitalisation (ITA s.24A — 70:30 debt:equity) ──────
    const { total: ltDebt }  = sumMatchingAccounts(allBSAccounts, LONG_TERM_DEBT_PATTERNS);
    const { total: stDebt }  = sumMatchingAccounts(allBSAccounts, SHORT_TERM_DEBT_PATTERNS);
    const { total: equity }  = sumMatchingAccounts(bsEquityAccounts, EQUITY_PATTERNS);
    const { total: interestExpense } = sumMatchingAccounts(
      [...allISAccounts, ...financeAccounts], INTEREST_EXPENSE_PATTERNS
    );

    const totalDebt = ltDebt + stDebt;
    const debtEquityRatio = equity > 0 ? totalDebt / equity : 0;
    const allowableDebt = equity * THIN_CAP_MAX_RATIO; // 70/30 × equity
    let thinCapDisallowed = 0;

    if (equity > 0 && totalDebt > allowableDebt && interestExpense > 0) {
      const excessDebtPct = (totalDebt - allowableDebt) / totalDebt;
      thinCapDisallowed = Math.round(interestExpense * excessDebtPct);
      addBacks.push({
        description: `Excess interest disallowed — debt (TZS ${totalDebt.toLocaleString()}) exceeds 70:30 of equity (TZS ${equity.toLocaleString()}). Disallowed: ${(excessDebtPct * 100).toFixed(1)}% of TZS ${interestExpense.toLocaleString()} interest.`,
        amount_tzs: thinCapDisallowed,
        ita_section: "s.24A",
        account_names: [],
        auto_detected: true,
      });
    } else if (equity === 0 && totalDebt > 0) {
      warnings.push("Equity is zero — thin cap test skipped. Check balance sheet equity accounts.");
    }

    // ── STEP 6: Wear & Tear from capital_allowances table ────────────────
    const { data: wearTearRows } = await supabase
      .from("capital_allowances")
      .select("ita_class, wear_tear_tzs, asset_description, ita_wdv_opening_tzs, additions_tzs, disposals_at_tax_cost_tzs, cost_tzs")
      .eq("company_id", companyId)
      .eq("period_year", periodYear);

    let totalWearTear = 0;
    const wearTearDeductions: TaxAdjustment[] = [];

    if (wearTearRows && wearTearRows.length > 0) {
      // Group by class and sum
      const byClass: Record<number, { wear_tear: number; descriptions: string[] }> = {};
      for (const row of wearTearRows) {
        // Compute wear_tear if not already stored
        const poolBalance = row.ita_wdv_opening_tzs + row.additions_tzs - row.disposals_at_tax_cost_tzs;
        const rate = ITA_CLASS_RATES[row.ita_class] ?? 0;
        const wearTear = row.ita_class === 5
          ? Math.round(row.cost_tzs * rate)
          : Math.round(poolBalance * rate);

        if (!byClass[row.ita_class]) byClass[row.ita_class] = { wear_tear: 0, descriptions: [] };
        byClass[row.ita_class].wear_tear += wearTear;
        byClass[row.ita_class].descriptions.push(row.asset_description);
        totalWearTear += wearTear;
      }

      for (const [cls, data] of Object.entries(byClass)) {
        wearTearDeductions.push({
          description: `Wear & tear — ${ITA_CLASS_NAMES[Number(cls)]}`,
          amount_tzs: data.wear_tear,
          ita_section: "s.34",
          account_names: data.descriptions,
          auto_detected: false,
        });
      }
    } else {
      warnings.push("No capital allowances entered. Add assets via the Capital Allowances form to deduct wear & tear.");
    }

    // ── STEP 7: Income Tax Provision from balance sheet ───────────────────
    const { total: itProvision } = sumMatchingAccounts(
      [...bsCLAccounts, ...bsNCLAccounts], INCOME_TAX_PROVISION_PATTERNS
    );

    // ── STEP 8: Compute Taxable Income ────────────────────────────────────
    const totalAddBacks = addBacks.reduce((s, a) => s + a.amount_tzs, 0);
    const totalDeductions = wearTearDeductions.reduce((s, d) => s + d.amount_tzs, 0);
    const taxableIncome = accountingPBT + totalAddBacks - totalDeductions;

    // ── STEP 9: CIT & Minimum Tax ─────────────────────────────────────────
    const citAt30 = Math.round(Math.max(0, taxableIncome) * CIT_RATE);
    const minimumTax = Math.round(grossIncome * MINIMUM_TAX_RATE);
    const minimumTaxApplies = minimumTax > citAt30;
    const taxPayable = Math.max(citAt30, minimumTax);

    if (minimumTaxApplies) {
      warnings.push(`Minimum tax applies (ITA s.65): TZS ${minimumTax.toLocaleString()} > CIT of TZS ${citAt30.toLocaleString()}. Company may be making a loss or very low profit.`);
    }

    const effectiveRate = grossIncome > 0 ? (taxPayable / grossIncome) * 100 : 0;

    // ── STEP 10: Gap & Penalty ────────────────────────────────────────────
    const citGap = taxPayable - itProvision;
    const effectiveMonthsOverdue = Math.max(0, months_overdue);
    const penaltyTzs = citGap > 0 && effectiveMonthsOverdue > 0
      ? Math.round(citGap * PENALTY_RATE_PER_MONTH * effectiveMonthsOverdue)
      : 0;
    const totalExposure = Math.max(0, citGap) + penaltyTzs;

    const result: TaxComputationResult = {
      engine_version:                   ENGINE_VERSION,
      company_id:                       companyId,
      upload_id:                        uploadId,
      period_year:                      periodYear,
      dry_run,

      accounting_profit_before_tax_tzs: accountingPBT,
      gross_income_tzs:                 grossIncome,
      add_backs:                        addBacks,
      deductions:                       wearTearDeductions,
      total_add_backs_tzs:              totalAddBacks,
      total_deductions_tzs:             totalDeductions,
      total_wear_tear_tzs:              totalWearTear,

      total_debt_tzs:                   totalDebt,
      total_equity_tzs:                 equity,
      debt_equity_ratio:                equity > 0 ? Math.round((totalDebt / equity) * 1000) / 1000 : 0,
      allowable_debt_tzs:               allowableDebt,
      interest_expense_tzs:             interestExpense,
      thin_cap_disallowed_tzs:          thinCapDisallowed,

      taxable_income_tzs:               taxableIncome,
      cit_at_30pct_tzs:                 citAt30,
      minimum_tax_tzs:                  minimumTax,
      tax_payable_tzs:                  taxPayable,
      minimum_tax_applies:              minimumTaxApplies,
      effective_tax_rate_pct:           Math.round(effectiveRate * 100) / 100,

      income_tax_provision_tzs:         itProvision,
      cit_gap_tzs:                      citGap,

      months_overdue:                   effectiveMonthsOverdue,
      penalty_tzs:                      penaltyTzs,
      total_exposure_tzs:               totalExposure,

      warnings,
      finding_created:                  false,
    };

    // ── DRY RUN — return preview only ────────────────────────────────────
    if (dry_run) {
      return new Response(JSON.stringify({ success: true, result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── COMMIT — write to DB ──────────────────────────────────────────────

    // Upsert tax_computation record
    const { error: computeErr } = await supabase
      .from("tax_computations")
      .upsert({
        company_id:                       companyId,
        upload_id:                        uploadId,
        period_year:                      periodYear,
        accounting_profit_before_tax_tzs: accountingPBT,
        gross_income_tzs:                 grossIncome,
        add_backs:                        addBacks,
        deductions:                       wearTearDeductions,
        total_add_backs_tzs:              totalAddBacks,
        total_deductions_tzs:             totalDeductions,
        total_wear_tear_tzs:              totalWearTear,
        total_debt_tzs:                   totalDebt,
        total_equity_tzs:                 equity,
        debt_equity_ratio:                equity > 0 ? totalDebt / equity : null,
        allowable_debt_tzs:               allowableDebt,
        interest_expense_tzs:             interestExpense,
        thin_cap_disallowed_tzs:          thinCapDisallowed,
        taxable_income_tzs:               taxableIncome,
        cit_at_30pct_tzs:                 citAt30,
        minimum_tax_tzs:                  minimumTax,
        tax_payable_tzs:                  taxPayable,
        minimum_tax_applies:              minimumTaxApplies,
        effective_tax_rate_pct:           effectiveRate,
        income_tax_provision_tzs:         itProvision,
        cit_gap_tzs:                      citGap,
        months_overdue:                   effectiveMonthsOverdue,
        penalty_tzs:                      penaltyTzs,
        total_exposure_tzs:               totalExposure,
        engine_version:                   ENGINE_VERSION,
        warnings:                         warnings,
        computation_detail:               result,
      }, { onConflict: "company_id,upload_id" });

    if (computeErr) {
      console.error("tax_computations upsert error:", computeErr);
    }

    // Create finding if gap exceeds threshold
    let findingCreated = false;
    if (Math.abs(citGap) > VARIANCE_THRESHOLD_TZS) {
      const severity = totalExposure >= 50_000_000 ? "critical"
                     : totalExposure >= 10_000_000 ? "high"
                     : totalExposure >= 1_000_000  ? "medium" : "low";

      const periodStart = `${periodYear}-01-01`;
      const periodEnd   = `${periodYear}-12-31`;

      const { error: findingErr } = await supabase
        .from("findings")
        .upsert({
          company_id:              companyId,
          upload_id:               uploadId,
          finding_type:            "statutory_payable",
          finding_category:        "corporate_tax",
          statutory_rule_id:       null,
          period_start:            periodStart,
          period_end:              periodEnd,
          amount_tzs:              taxPayable,
          variance_amount_tzs:     citGap,
          penalty_amount_tzs:      penaltyTzs,
          severity,
          status:                  "open",
          description:             `ITA corporate tax gap: computed TZS ${taxPayable.toLocaleString()} vs provision TZS ${itProvision.toLocaleString()}. Net gap: TZS ${citGap.toLocaleString()}${minimumTaxApplies ? " (minimum tax applies)" : ""}.`,
          source_detail: {
            engine:               ENGINE_VERSION,
            taxable_income_tzs:   taxableIncome,
            cit_at_30pct_tzs:     citAt30,
            minimum_tax_tzs:      minimumTax,
            minimum_tax_applies:  minimumTaxApplies,
            total_add_backs_tzs:  totalAddBacks,
            total_wear_tear_tzs:  totalWearTear,
            thin_cap_disallowed:  thinCapDisallowed,
            months_overdue:       effectiveMonthsOverdue,
            estimated_penalty:    penaltyTzs,
            total_exposure:       totalExposure,
          },
        }, { onConflict: "company_id,finding_category,period_start,period_end" });

      if (!findingErr) findingCreated = true;
      else console.error("findings upsert error:", findingErr);
    }

    result.finding_created = findingCreated;
    result.dry_run = false;

    return new Response(JSON.stringify({ success: true, result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("kinga-tax-engine error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  }
});
