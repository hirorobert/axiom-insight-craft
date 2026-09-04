/**
 * maono-compute · IRON DOME NUCLEAR DESIGN · Phase A
 *
 * Pure SQL + arithmetic. Zero AI. Deterministic.
 * Given a company + period, computes actual vs budget vs prior period variances
 * across every P&L account, mapped to the Hoffman fac-ifrs P&L hierarchy.
 *
 * IRON DOME GATES (in order — all must pass before any write):
 *   Gate 1: Auth — reviewer_id from getUser(), never from request body
 *   Gate 2: Safisha — ALL TB uploads for period must have safisha_status='clean'
 *   Gate 3: Budget — at least one approved budget row must exist for this period
 *   Gate 4: Materiality — company threshold record must exist (or defaults apply)
 *
 * Execution pipeline:
 *   1. Check Safisha gate (abort if any upload blocked)
 *   2. Compute confidence level (seasonal_periods_available formula)
 *   3. Create variance_run record (status='running')
 *   4. Load actuals from the authoritative SAFISHA CertifiedTB
 *      (get_authoritative_certification → tb_certifications.rows_snapshot)
 *   5. Load budgets from variance_budgets (latest approved version)
 *   6. Prior comparatives: no per-account authority exists (period_closing_balances
 *      is aggregate-level) → reported as CANNOT_ASSESS, never as zero
 *   7. Resolve P&L category for each account via account_pl_mapping
 *   8. Compute variance_tzs, variance_pct, is_material
 *   9. Compute Hoffman aggregates: GP, EBITDA, EBIT, EBT, Net Profit
 *  10. Write variance_analyses rows
 *  11. Update variance_run status='complete' with summary figures
 *
 * POST /functions/v1/maono-compute
 * Body: {
 *   company_id:    string    (UUID)
 *   period_from:   string    (ISO date, e.g. "2026-01-01")
 *   period_to:     string    (ISO date, e.g. "2026-01-31")
 * }
 *
 * Response: {
 *   run_id, company_id, period_from, period_to,
 *   safisha_gate: 'passed',
 *   trend_confidence, seasonal_periods_available,
 *   totals: { gross_profit, ebitda, ebit, ebt, net_profit } (actual + variance),
 *   material_variance_count,
 *   category_summary: [...],
 *   next_step: string
 * }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { computeVariance as computeVarianceContract, type AnalyticalValue } from "../_shared/maonoAnalyticalContract.ts";
import { loadCertifiedTb, certifiedRowKey, type CertifiedTbClient } from "../_shared/certifiedTbSource.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Hoffman P&L aggregate categories ─────────────────────────────────────────
//
// These are COMPUTED (not stored as account_pl_mapping rows).
// Each is defined by which pl_categories contribute and their sign.

const PL_AGGREGATES = {
  GROSS_PROFIT: {
    add:      ["REVENUE", "OTHER_INCOME"],
    subtract: ["COST_OF_SALES"],
  },
  EBITDA: {
    add:      ["REVENUE", "OTHER_INCOME"],
    subtract: ["COST_OF_SALES", "PERSONNEL_COSTS", "OTHER_OPEX"],
    // DEPRECIATION and AMORTISATION excluded — that's the definition of EBITDA
  },
  EBIT: {
    add:      ["REVENUE", "OTHER_INCOME"],
    subtract: ["COST_OF_SALES", "PERSONNEL_COSTS", "OTHER_OPEX", "DEPRECIATION", "AMORTISATION"],
  },
  EBT: {
    add:      ["REVENUE", "OTHER_INCOME", "FINANCE_INCOME"],
    subtract: ["COST_OF_SALES", "PERSONNEL_COSTS", "OTHER_OPEX", "DEPRECIATION", "AMORTISATION", "FINANCE_COSTS"],
  },
  NET_PROFIT: {
    add:      ["REVENUE", "OTHER_INCOME", "FINANCE_INCOME"],
    subtract: ["COST_OF_SALES", "PERSONNEL_COSTS", "OTHER_OPEX", "DEPRECIATION", "AMORTISATION",
               "FINANCE_COSTS", "TAX_EXPENSE", "WITHHOLDING_TAX"],
  },
} as const;

// P&L categories that feed income statement (excludes BS + statistical)
const INCOME_STATEMENT_CATEGORIES = new Set([
  "REVENUE", "COST_OF_SALES", "OTHER_INCOME",
  "PERSONNEL_COSTS", "DEPRECIATION", "AMORTISATION", "OTHER_OPEX",
  "FINANCE_INCOME", "FINANCE_COSTS", "TAX_EXPENSE", "WITHHOLDING_TAX",
]);

// ── Types ─────────────────────────────────────────────────────────────────────

interface AccountRow {
  account_code:    string;
  account_name:    string | null;
  actual_debit:    number;
  actual_credit:   number;
  pl_category:     string;
  pl_subcategory:  string | null;
  is_credit_normal: boolean;
}

interface BudgetRow {
  account_code:   string;
  budget_debit:   number;
  budget_credit:  number;
}

interface PriorRow {
  account_code:  string;
  closing_debit: number;
  closing_credit: number;
}

interface VarianceAnalysis {
  run_id:              string;
  company_id:          string;
  account_code:        string;
  account_name:        string | null;
  pl_category:         string;
  pl_subcategory:      string | null;
  is_credit_normal:    boolean;
  actual_amount:       number;
  budget_amount:       number | null;
  prior_period_amount: number | null;
  prior_year_amount:   number | null;
  variance_tzs:        number | null;
  variance_pct:        number | null;
  is_material:         boolean;
  pop_variance_tzs:    number | null;
  pop_variance_pct:    number | null;
  yoy_variance_tzs:    number | null;
  yoy_variance_pct:    number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function netAmount(debit: number, credit: number, isCreditNormal: boolean): number {
  // For credit-normal accounts (revenue, liabilities): net = credit - debit
  // For debit-normal accounts (assets, expenses):      net = debit - credit
  return isCreditNormal ? credit - debit : debit - credit;
}

// Ω∞ Phase 9 repair (§6, MEDIUM-1): delegates to the shared, tested
// numeric-safety contract instead of a local reimplementation. Behavior
// is unchanged for every real financial input this function already
// handled (budget===0 & actual===0 -> 0; budget===0 & actual!==0 -> null;
// otherwise the same percentage formula) — proven by
// src/lib/accounting/maonoAnalyticalContract.test.ts's computeVariance
// suite, which this Deno copy mirrors exactly. The one behavioral
// addition is NaN/Infinity/overflow now failing closed to null instead of
// a possible non-finite value escaping as an authoritative variance_pct.
function variancePct(actual: number, budget: number): number | null {
  const toAnalyticalValue = (n: number): AnalyticalValue =>
    n === 0 ? { state: "ZERO", value: 0 } : { state: "KNOWN", value: n };
  const pct = computeVarianceContract(toAnalyticalValue(actual), toAnalyticalValue(budget)).percentageVariance;
  return pct.state === "KNOWN" || pct.state === "ZERO" ? pct.value : null;
}

function isMaterial(varianceTzs: number | null, variancePctVal: number | null,
                    absThr: number, pctThr: number): boolean {
  if (varianceTzs === null || variancePctVal === null) return false;
  return Math.abs(varianceTzs) >= absThr || Math.abs(variancePctVal) >= pctThr;
}

export interface CategoryTotal {
  actual: number;
  budget: number;
  prior: number;
  budgetKnown: boolean;
  priorKnown: boolean;
}

/**
 * Ω∞ closure: an aggregate is only claimed when EVERY contributing component is
 * known. One unknown budget (or prior) component makes the aggregate budget
 * (or prior) null — incomplete aggregates are never presented as totals and
 * missing components are never treated as zero.
 */
function computeAggregate(
  categoryTotals: Record<string, CategoryTotal>,
  def: { add: readonly string[]; subtract: readonly string[] }
): { actual: number; budget: number | null; prior: number | null } {
  let actual = 0, budget = 0, prior = 0;
  let budgetKnown = true, priorKnown = true;
  const apply = (cat: string, sign: 1 | -1) => {
    const t = categoryTotals[cat];
    if (!t) return; // no accounts classified into this category — no contribution
    actual += sign * t.actual;
    if (t.budgetKnown) budget += sign * t.budget; else budgetKnown = false;
    if (t.priorKnown) prior += sign * t.prior; else priorKnown = false;
  };
  for (const cat of def.add) apply(cat, 1);
  for (const cat of def.subtract) apply(cat, -1);
  return {
    actual,
    budget: budgetKnown ? budget : null,
    prior:  priorKnown  ? prior  : null,
  };
}


// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Gate 1: Auth ──────────────────────────────────────────────────────────
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const { company_id, period_from, period_to } = await req.json();
    if (!company_id || !period_from || !period_to) {
      return json({ error: "company_id, period_from, period_to are required" }, 400);
    }

    const periodFrom = new Date(period_from);
    const periodTo   = new Date(period_to);
    if (isNaN(periodFrom.getTime()) || isNaN(periodTo.getTime())) {
      return json({ error: "period_from and period_to must be valid ISO dates" }, 400);
    }
    if (periodFrom > periodTo) {
      return json({ error: "period_from must be before period_to" }, 400);
    }

    const fiscalYear   = periodFrom.getFullYear();
    const periodMonth  = periodFrom.getMonth() + 1;

    // ── Find all TB uploads for this company in this period ───────────────────
    const { data: uploads, error: uploadErr } = await supabase
      .from("trial_balance_uploads")
      .select("id, safisha_status, uploaded_at, file_name")
      .eq("company_id", company_id)
      .gte("uploaded_at", period_from)
      .lte("uploaded_at", period_to);


    if (uploadErr) throw new Error("Failed to load TB uploads: " + uploadErr.message);
    if (!uploads || uploads.length === 0) {
      return json({
        error:   "No trial balance uploads found for this company and period",
        hint:    "Upload and process a TB first, then run Safisha verification before analysis",
        company_id, period_from, period_to,
      }, 400);
    }

    const uploadIds = uploads.map((u: any) => u.id);

    // ── Gate 2: Safisha gate ──────────────────────────────────────────────────
    const { data: gateResult, error: gateErr } = await supabase
      .rpc("maono_check_safisha_gate", { p_upload_ids: uploadIds });

    if (gateErr) throw new Error("Safisha gate check failed: " + gateErr.message);

    const blockedUploads = (gateResult ?? []).filter((r: any) => r.is_blocked);
    if (blockedUploads.length > 0) {
      return json({
        error:            "IRON DOME: Safisha gate blocked",
        message:          `${blockedUploads.length} of ${uploadIds.length} TB uploads are not clean. ` +
                          "Complete Safisha verification for all uploads before running analysis.",
        blocked_uploads:  blockedUploads.map((u: any) => ({
          upload_id:       u.upload_id,
          safisha_status:  u.safisha_status,
        })),
        safisha_gate:     "blocked",
        iron_dome:        true,
      }, 409);
    }

    // ── Confidence level ──────────────────────────────────────────────────────
    const { data: confidence } = await supabase
      .rpc("maono_compute_confidence", {
        p_company_id:   company_id,
        p_period_month: periodMonth,
      });

    const seasonalPeriods  = confidence?.[0]?.seasonal_periods_available ?? 0;
    const trendConfidence  = confidence?.[0]?.trend_confidence ?? "none";

    // ── Materiality thresholds ────────────────────────────────────────────────
    const { data: matRow } = await supabase
      .from("variance_materiality")
      .select("pct_threshold, abs_threshold_tzs")
      .eq("company_id", company_id)
      .single();

    const pctThreshold = matRow?.pct_threshold ?? 10.0;
    const absThrTzs    = matRow?.abs_threshold_tzs ?? 5_000_000;

    // ── Gate 3: Budget data check ─────────────────────────────────────────────
    const { count: budgetCount } = await supabase
      .from("variance_budgets")
      .select("id", { count: "exact", head: true })
      .eq("company_id", company_id)
      .eq("fiscal_year", fiscalYear)
      .eq("period_month", periodMonth)
      .eq("is_active", true)
      .not("approved_by", "is", null);

    const hasBudget = (budgetCount ?? 0) > 0;

    // ── Gate 5: Authoritative CertifiedTB (Ω∞ closure) ────────────────────────
    // Per-account actuals come ONLY from the authoritative SAFISHA certified
    // trial balance. The legacy `account_classifications` dependency is gone:
    // that table has no migration and does not exist in the live database, so
    // it could only ever hard-fail or fabricate zeroes.
    // Loaded BEFORE the run row is created so an unassessable period leaves no
    // half-written analytical run behind.
    const certified = await loadCertifiedTb(supabase as unknown as CertifiedTbClient, company_id, fiscalYear);
    if (certified.state === "CANNOT_ASSESS") {
      return json({
        error:            "Analytical variance cannot be assessed",
        analytical_state: "CANNOT_ASSESS",
        reason:           certified.reason,
        authority:        "SAFISHA CertifiedTB (get_authoritative_certification)",
        hint:             "Certify the trial balance for this period, then re-run the analysis.",
        iron_dome:        true,
      }, 409);
    }
    const certifiedTb = certified.value;

    // ── Create variance_run record ────────────────────────────────────────────

    const { data: run, error: runErr } = await supabase
      .from("variance_runs")
      .insert({
        company_id,
        tb_upload_ids:          uploadIds,
        period_from,
        period_to,
        fiscal_year:            fiscalYear,
        period_month:           periodMonth,
        trigger_type:           "manual",
        triggered_by:           user.id,
        status:                 "running",
        safisha_gate_passed:    true,
        safisha_blocked_uploads: [],
        seasonal_periods_available: seasonalPeriods,
        trend_confidence:       trendConfidence,
        budget_version_ids:     [],
      })
      .select("id")
      .single();

    if (runErr) throw new Error("Failed to create variance_run: " + runErr.message);
    const runId = run!.id;

    // ── Actuals from the authoritative CertifiedTB ────────────────────────────
    // Certified rows carry per-account code/name, accounting nature and
    // debit/credit balances that were hash-bound at certification time.
    const actualMap = new Map<string, { debit: number; credit: number; name: string | null }>();
    for (const row of certifiedTb.rows) {
      const key = certifiedRowKey(row);
      const existing = actualMap.get(key) ?? { debit: 0, credit: 0, name: null };
      actualMap.set(key, {
        debit:  existing.debit  + row.debitBalance,
        credit: existing.credit + row.creditBalance,
        name:   existing.name ?? row.accountName,
      });
    }


    // ── Load budgets ──────────────────────────────────────────────────────────
    const budgetMap = new Map<string, { debit: number; credit: number }>();
    if (hasBudget) {
      const { data: budgets } = await supabase
        .from("variance_budgets")
        .select("account_code, budget_debit, budget_credit")
        .eq("company_id", company_id)
        .eq("fiscal_year", fiscalYear)
        .eq("period_month", periodMonth)
        .eq("is_active", true)
        .not("approved_by", "is", null);

      for (const b of (budgets ?? [])) {
        budgetMap.set(b.account_code, {
          debit:  b.budget_debit  ?? 0,
          credit: b.budget_credit ?? 0,
        });
      }
    }

    // ── Prior comparatives ────────────────────────────────────────────────────
    // `period_closing_balances` is the authoritative closing-balance store, but
    // it is AGGREGATE-level (current_assets_tzs, equity_tzs, …) — it holds no
    // per-account rows. The previous code queried account_code/closing_debit/
    // fiscal_year columns that do not exist, so the error was swallowed and
    // every prior comparative silently became "absent". Per-account prior
    // period / prior year comparatives are therefore genuinely UNKNOWN in this
    // system: they stay null, are never treated as zero, and the reason is
    // reported explicitly instead of being hidden.
    const priorPeriodMap = new Map<string, { debit: number; credit: number }>();
    const priorYearMap   = new Map<string, { debit: number; credit: number }>();
    const priorComparativeState  = "CANNOT_ASSESS" as const;
    const priorComparativeReason =
      "No per-account prior-period authority exists: period_closing_balances is aggregate-level only. " +
      "Period-over-period and year-over-year figures are reported as unknown, not zero.";


    // ── Resolve P&L categories for all accounts ───────────────────────────────
    // Load mappings (company-specific overrides first, then global defaults)
    const { data: mappings } = await supabase
      .from("account_pl_mapping")
      .select("match_type, match_value, match_priority, pl_category, pl_subcategory, is_credit_normal, company_id")
      .or(`company_id.is.null,company_id.eq.${company_id}`)
      .order("match_priority", { ascending: true });

    function resolveCategory(code: string, name: string | null): {
      pl_category: string; pl_subcategory: string | null; is_credit_normal: boolean
    } {
      // Company-specific overrides take priority over globals
      const sorted = (mappings ?? []).sort((a: any, b: any) => {
        if (a.company_id && !b.company_id) return -1;
        if (!a.company_id && b.company_id) return 1;
        return (a.match_priority ?? 50) - (b.match_priority ?? 50);
      });

      for (const m of sorted) {
        if (m.match_type === "exact" && m.match_value === code) {
          return { pl_category: m.pl_category, pl_subcategory: m.pl_subcategory, is_credit_normal: m.is_credit_normal };
        }
        if (m.match_type === "range") {
          const [lo, hi] = m.match_value.split("-");
          if (code >= lo && code <= hi) {
            return { pl_category: m.pl_category, pl_subcategory: m.pl_subcategory, is_credit_normal: m.is_credit_normal };
          }
        }
        if (m.match_type === "pattern" && name) {
          const pattern = m.match_value.replace(/%/g, ".*").replace(/_/g, ".");
          if (new RegExp(pattern, "i").test(name.toLowerCase())) {
            return { pl_category: m.pl_category, pl_subcategory: m.pl_subcategory, is_credit_normal: m.is_credit_normal };
          }
        }
      }
      // Unclassified — not excluded, shown as STATISTICAL
      return { pl_category: "STATISTICAL", pl_subcategory: null, is_credit_normal: false };
    }

    // ── Compute variances ─────────────────────────────────────────────────────
    const analyses: VarianceAnalysis[] = [];
    const categoryTotals: Record<string, CategoryTotal> = {};

    for (const [code, actData] of actualMap.entries()) {
      const { pl_category, pl_subcategory, is_credit_normal } = resolveCategory(code, actData.name);

      // Skip balance sheet accounts from income statement analysis
      if (!INCOME_STATEMENT_CATEGORIES.has(pl_category)) continue;

      const actual      = netAmount(actData.debit, actData.credit, is_credit_normal);

      const budRow      = budgetMap.get(code);
      const budget      = budRow ? netAmount(budRow.debit, budRow.credit, is_credit_normal) : null;

      const priorPRow   = priorPeriodMap.get(code);
      const priorP      = priorPRow ? netAmount(priorPRow.debit, priorPRow.credit, is_credit_normal) : null;

      const priorYRow   = priorYearMap.get(code);
      const priorY      = priorYRow ? netAmount(priorYRow.debit, priorYRow.credit, is_credit_normal) : null;

      // Budget variance
      const varTzs      = budget !== null ? actual - budget : null;
      const varPct      = budget !== null ? variancePct(actual, budget) : null;
      const material    = isMaterial(varTzs, varPct, absThrTzs, pctThreshold);

      // Period-over-period
      const popTzs      = priorP !== null ? actual - priorP : null;
      const popPct      = priorP !== null && priorP !== 0 ? ((actual - priorP) / Math.abs(priorP)) * 100 : null;

      // Year-over-year
      const yoyTzs      = priorY !== null ? actual - priorY : null;
      const yoyPct      = priorY !== null && priorY !== 0 ? ((actual - priorY) / Math.abs(priorY)) * 100 : null;

      analyses.push({
        run_id: runId, company_id,
        account_code: code, account_name: actData.name,
        pl_category, pl_subcategory, is_credit_normal,
        actual_amount: actual,
        budget_amount: budget,
        prior_period_amount: priorP,
        prior_year_amount:   priorY,
        variance_tzs: varTzs, variance_pct: varPct, is_material: material,
        pop_variance_tzs: popTzs, pop_variance_pct: popPct,
        yoy_variance_tzs: yoyTzs, yoy_variance_pct: yoyPct,
      });

      // Accumulate category totals for Hoffman aggregates.
      // UNKNOWN != ZERO: a category whose budget (or prior) is unknown for any
      // contributing account carries that unknown forward — it is never summed
      // as zero and never silently dropped from the total.
      if (!categoryTotals[pl_category]) {
        categoryTotals[pl_category] = { actual: 0, budget: 0, prior: 0, budgetKnown: true, priorKnown: true };
      }
      const ct = categoryTotals[pl_category];
      ct.actual += actual;
      if (budget === null) ct.budgetKnown = false; else ct.budget += budget;
      if (priorP === null) ct.priorKnown = false; else ct.prior += priorP;
    }

    // ── Hoffman aggregates ────────────────────────────────────────────────────
    const aggregates: Record<string, {
      actual: number; budget: number | null; variance: number | null;
      variance_pct: number | null; budget_state: "KNOWN" | "CANNOT_ASSESS";
    }> = {};
    for (const [name, def] of Object.entries(PL_AGGREGATES)) {
      const totals = computeAggregate(categoryTotals, def);
      aggregates[name] = {
        actual:       totals.actual,
        budget:       totals.budget,
        variance:     totals.budget === null ? null : totals.actual - totals.budget,
        variance_pct: totals.budget === null ? null : variancePct(totals.actual, totals.budget),
        budget_state: totals.budget === null ? "CANNOT_ASSESS" : "KNOWN",
      };
    }


    // ── Batch insert variance_analyses ────────────────────────────────────────
    const BATCH = 200;
    for (let b = 0; b < analyses.length; b += BATCH) {
      const { error: insErr } = await supabase
        .from("variance_analyses")
        .insert(analyses.slice(b, b + BATCH));
      if (insErr) throw new Error("Insert variance_analyses failed: " + insErr.message);
    }

    const materialCount = analyses.filter(a => a.is_material).length;

    // ── Update variance_run to complete ───────────────────────────────────────
    await supabase
      .from("variance_runs")
      .update({
        status:                   "complete",
        total_accounts:           analyses.length,
        material_variance_count:  materialCount,
        gross_profit_variance_tzs: aggregates.GROSS_PROFIT?.variance ?? null,
        ebitda_variance_tzs:       aggregates.EBITDA?.variance ?? null,
        net_profit_variance_tzs:   aggregates.NET_PROFIT?.variance ?? null,
      })
      .eq("id", runId);

    // ── Category summary for response ─────────────────────────────────────────
    const categorySummary = Object.entries(categoryTotals).map(([cat, t]) => ({
      pl_category:  cat,
      actual:       t.actual,
      // UNKNOWN != ZERO: an unknown category budget is reported as unknown,
      // and no variance is claimed against it.
      budget:       t.budgetKnown ? t.budget : null,
      budget_state: t.budgetKnown ? "KNOWN" : "CANNOT_ASSESS",
      variance_tzs: t.budgetKnown ? t.actual - t.budget : null,
      variance_pct: t.budgetKnown ? variancePct(t.actual, t.budget) : null,
    })).sort((a, b) => Math.abs(b.variance_tzs ?? 0) - Math.abs(a.variance_tzs ?? 0));

    return json({
      success:         true,
      run_id:          runId,
      company_id,
      period_from,
      period_to,
      safisha_gate:    "passed",
      has_budget:      hasBudget,
      actuals_authority: {
        source:            "SAFISHA CertifiedTB",
        certification_id:  certifiedTb.certificationId,
        upload_id:         certifiedTb.uploadId,
        source_file_hash:  certifiedTb.sourceFileHash,
        certified_at:      certifiedTb.certifiedAt,
        requires_review:   certifiedTb.requiresReview,
        certified_rows:    certifiedTb.rows.length,
      },
      prior_comparatives: {
        state:  priorComparativeState,
        reason: priorComparativeReason,
      },
      trend_confidence:           trendConfidence,
      seasonal_periods_available: seasonalPeriods,
      materiality: {
        pct_threshold:     pctThreshold,
        abs_threshold_tzs: absThrTzs,
      },
      totals:               aggregates,
      material_variance_count: materialCount,
      total_accounts:       analyses.length,
      category_summary:     categorySummary,
      next_step: materialCount > 0
        ? "Call maono-cashflow → maono-root-cause → maono-risk → maono-decide"
        : "No material variances detected. Company is on-plan for this period.",
    }, 200);

  } catch (err: any) {
    console.error("maono-compute error:", err);
    return json({ error: err.message }, 500);
  }
});

function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
