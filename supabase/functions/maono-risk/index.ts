/**
 * maono-risk · IRON DOME NUCLEAR DESIGN · Phase B
 *
 * Statistical risk detection — deterministic SQL + Z-score.
 * No AI in this function. Pure math.
 *
 * Stages:
 *   1. Load all historical variance_analyses for this company + same P&L category
 *   2. Compute Z-score for each current material variance vs historical distribution
 *   3. Detect TRA audit risk signals (pattern-based, not statistical)
 *   4. Determine if each variance is trend or one-off
 *   5. Write maono_insights(insight_type='risk') rows
 *
 * IRON DOME:
 *   - If trend_confidence='none': return early, no trend analysis
 *   - TRA signals fire on pattern match — they don't require historical data
 *   - All conclusions stored with the data that drove them
 *
 * POST /functions/v1/maono-risk
 * Body: { run_id: string }
 */

import { serve }       from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Z-score ───────────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function zScore(value: number, arr: number[]): number | null {
  if (arr.length < 3) return null; // insufficient data for meaningful Z-score
  const sd = stdDev(arr);
  if (sd === 0) return 0;
  return (value - mean(arr)) / sd;
}

// ── TRA audit signal patterns ─────────────────────────────────────────────────
// Pattern-based — fire regardless of historical data availability.
// Based on TRA enforcement priorities from maono_context.

interface TRASignal {
  key:         string;
  description: string;
  severity:    "info" | "warn" | "critical";
  check:       (data: any) => boolean;
}

const TRA_SIGNALS: TRASignal[] = [
  {
    key:         "sdl_base_erosion",
    description: "SDL base is significantly below PAYE base (>20% difference) without documented exemptions. TRA may query the SDL computation.",
    severity:    "warn",
    check:       (d) => {
      const paye = Math.abs(d.personnelCosts ?? 0);
      const sdl  = d.sdlLiability ?? 0;
      if (paye < 1_000_000) return false; // small company, not material
      const impliedSDLBase = sdl / 0.045;
      return impliedSDLBase < paye * 0.80;
    },
  },
  {
    key:         "thin_capitalisation",
    description: "Finance costs are high relative to equity. ITA s.24A caps deductible interest at a 70:30 debt-to-equity ratio. Excess is non-deductible.",
    severity:    "warn",
    check:       (d) => {
      const finCosts = Math.abs(d.financeCosts ?? 0);
      const revenue  = Math.abs(d.revenue ?? 0);
      if (revenue < 10_000_000) return false;
      return finCosts / revenue > 0.15; // finance costs > 15% of revenue is a flag
    },
  },
  {
    key:         "vat_gap",
    description: "VAT output implied by revenue is significantly higher than VAT liability recorded. May indicate underreporting or incorrect exemption application.",
    severity:    "critical",
    check:       (d) => {
      const revenue    = Math.abs(d.revenue ?? 0);
      const vatLiab    = d.vatLiability ?? 0;
      const impliedVAT = revenue * 0.18;
      if (revenue < 10_000_000) return false;
      return vatLiab < impliedVAT * 0.5; // VAT is less than half of what revenue implies
    },
  },
  {
    key:         "paye_zero_with_personnel_costs",
    description: "Personnel costs appear in the TB but PAYE liability is zero. TRA will query payroll compliance.",
    severity:    "critical",
    check:       (d) => {
      const personnel = Math.abs(d.personnelCosts ?? 0);
      const paye      = d.payeLiability ?? 0;
      return personnel > 5_000_000 && paye === 0;
    },
  },
  {
    key:         "large_unexplained_opex",
    description: "Other operating expenses increased >50% vs prior period with no evident business reason. Large unexplained expenses are a standard TRA audit query.",
    severity:    "warn",
    check:       (d) => {
      const current = Math.abs(d.currentOpex ?? 0);
      const prior   = Math.abs(d.priorOpex ?? 0);
      if (prior < 5_000_000) return false;
      return current > prior * 1.5;
    },
  },
  {
    key:         "revenue_below_prior_no_explanation",
    description: "Revenue is more than 30% below same period last year. TRA may treat this as a revenue understatement risk.",
    severity:    "info",
    check:       (d) => {
      const current = d.revenue ?? 0;
      const prior   = d.priorYearRevenue ?? 0;
      if (prior <= 0) return false;
      return current < prior * 0.70;
    },
  },
];

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const { run_id } = await req.json();
    if (!run_id) return json({ error: "run_id is required" }, 400);

    const { data: run } = await supabase
      .from("variance_runs")
      .select("id, company_id, period_from, period_to, trend_confidence, seasonal_periods_available, fiscal_year, period_month")
      .eq("id", run_id)
      .single();
    if (!run) return json({ error: "Run not found" }, 404);

    const companyId = run.company_id;

    // Load current material variances
    const { data: current } = await supabase
      .from("variance_analyses")
      .select("account_code, account_name, pl_category, actual_amount, budget_amount, variance_tzs, variance_pct, prior_period_amount, prior_year_amount")
      .eq("run_id", run_id)
      .eq("is_material", true);

    if (!current || current.length === 0) {
      return json({ success: true, run_id, message: "No material variances — risk analysis skipped", signals: [], trends: [] }, 200);
    }

    // Category totals for TRA signal checks
    const catTotals: Record<string, number> = {};
    for (const a of current) {
      catTotals[a.pl_category] = (catTotals[a.pl_category] ?? 0) + (a.actual_amount ?? 0);
    }

    // Load tax_computations for SDL/VAT/PAYE figures
    const { data: taxComp } = await supabase
      .from("tax_computations")
      .select("computation_json")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    const taxJson = taxComp?.computation_json ?? {};

    const traCheckData = {
      personnelCosts:   catTotals["PERSONNEL_COSTS"]  ?? 0,
      revenue:          catTotals["REVENUE"]           ?? 0,
      financeCosts:     catTotals["FINANCE_COSTS"]     ?? 0,
      currentOpex:      catTotals["OTHER_OPEX"]        ?? 0,
      priorOpex:        (current.find((a: any) => a.pl_category === "OTHER_OPEX")?.prior_period_amount ?? 0),
      priorYearRevenue: (current.find((a: any) => a.pl_category === "REVENUE")?.prior_year_amount ?? 0),
      sdlLiability:     taxJson?.sdl_liability ?? 0,
      vatLiability:     taxJson?.vat_liability ?? 0,
      payeLiability:    taxJson?.paye_total ?? 0,
    };

    // ── TRA audit signal detection ────────────────────────────────────────────
    const firedSignals = TRA_SIGNALS
      .filter(sig => sig.check(traCheckData))
      .map(sig => ({
        key:         sig.key,
        description: sig.description,
        severity:    sig.severity,
        data:        traCheckData,
      }));

    // ── Trend analysis (only if trend_confidence != 'none') ───────────────────
    const trends: any[] = [];

    if (run.trend_confidence !== "none") {
      // Load historical variance_pct for same P&L categories across prior runs
      const { data: historical } = await supabase
        .from("variance_analyses")
        .select("pl_category, variance_pct, variance_tzs, run_id")
        .eq("company_id", companyId)
        .neq("run_id", run_id)
        .order("run_id", { ascending: true });

      // Group historical variance_pct by pl_category
      const histByCategory: Record<string, number[]> = {};
      for (const h of (historical ?? [])) {
        if (h.variance_pct == null) continue;
        if (!histByCategory[h.pl_category]) histByCategory[h.pl_category] = [];
        histByCategory[h.pl_category].push(h.variance_pct);
      }

      // For each current material variance, compute Z-score
      const analysedCategories = new Set<string>();
      for (const a of current) {
        if (analysedCategories.has(a.pl_category)) continue;
        analysedCategories.add(a.pl_category);

        const hist = histByCategory[a.pl_category] ?? [];
        const z    = zScore(a.variance_pct ?? 0, hist);

        let pattern: "one_off" | "trend" | "worsening" | "unknown" = "unknown";
        let description = "";

        if (z === null) {
          pattern     = "unknown";
          description = `Insufficient historical data (${hist.length} prior periods) for statistical analysis.`;
        } else if (Math.abs(z) < 1.5) {
          pattern     = "one_off";
          description = `Z-score ${z.toFixed(2)}: This variance is within normal historical range. Likely a one-off event.`;
        } else if (z <= -1.5) {
          // Check if it's getting worse over time
          const lastThree = hist.slice(-3);
          const isWorsening = lastThree.length >= 3 &&
            lastThree[0] > lastThree[1] && lastThree[1] > lastThree[2];
          pattern     = isWorsening ? "worsening" : "trend";
          description = isWorsening
            ? `Z-score ${z.toFixed(2)}: Adverse variance has been worsening over the last ${lastThree.length} periods. Structural issue likely.`
            : `Z-score ${z.toFixed(2)}: This adverse variance is statistically unusual (${hist.length} prior periods reviewed). Investigate root cause.`;
        } else {
          pattern     = "one_off";
          description = `Z-score ${z.toFixed(2)}: Favourable variance — above historical norm.`;
        }

        trends.push({
          pl_category:             a.pl_category,
          current_variance_pct:    a.variance_pct,
          current_variance_tzs:    a.variance_tzs,
          z_score:                 z,
          periods_analysed:        hist.length,
          pattern,
          description,
        });
      }
    } else {
      trends.push({
        skipped:   true,
        reason:    "insufficient_history",
        message:   "Trend analysis requires at least 2 complete periods of data. " +
                   "No trend conclusions can be drawn from this company's current history.",
      });
    }

    // ── Write risk insight ────────────────────────────────────────────────────
    const confidenceLevel: string =
      run.seasonal_periods_available >= 8 ? "high"
      : run.seasonal_periods_available >= 4 ? "medium"
      : run.seasonal_periods_available >= 2 ? "low"
      : "none";

    const riskOutput = {
      tra_signals:        firedSignals,
      trend_analysis:     trends,
      trend_confidence:   run.trend_confidence,
      periods_available:  run.seasonal_periods_available,
      summary: {
        signal_count:    firedSignals.length,
        critical_signals: firedSignals.filter((s: any) => s.severity === "critical").length,
        worsening_trends: trends.filter((t: any) => t.pattern === "worsening").length,
        overall_risk:    firedSignals.some((s: any) => s.severity === "critical")  ? "HIGH"
                       : firedSignals.length > 0 || trends.some((t: any) => t.pattern === "worsening") ? "MEDIUM"
                       : "LOW",
      },
    };

    const inputSnapshot = { current_analyses: current, tra_check_data: traCheckData };

    const { data: insight, error: insErr } = await supabase
      .from("maono_insights")
      .insert({
        run_id,
        company_id:                companyId,
        insight_type:              "risk",
        subject_account_codes:     current.map((a: any) => a.account_code),
        subject_pl_categories:     [...new Set(current.map((a: any) => a.pl_category))],
        input_snapshot:            inputSnapshot,
        ai_output:                 JSON.stringify(riskOutput, null, 2),
        ai_model_used:             "deterministic_zscore",
        confidence_level:          confidenceLevel,
        numeric_validation_passed: true, // deterministic — no AI numbers to validate
        numeric_validation_detail: { method: "deterministic", ai_involved: false },
        context_version:           0,
      })
      .select("id")
      .single();

    if (insErr) throw new Error("Insert risk insight failed: " + insErr.message);

    // Write variance_alerts for critical signals
    const alertInserts = [];
    for (const sig of firedSignals) {
      alertInserts.push({
        run_id,
        company_id:   companyId,
        alert_type:   "tra_risk_signal",
        severity:     sig.severity,
        account_codes: current.map((a: any) => a.account_code),
        pl_categories: Object.keys(catTotals),
        message:      sig.description,
        detail:       `Signal key: ${sig.key}`,
      });
    }
    for (const t of trends) {
      if (t.pattern === "worsening") {
        alertInserts.push({
          run_id,
          company_id:   companyId,
          alert_type:   "trend_deterioration",
          severity:     "warn",
          pl_categories: [t.pl_category],
          message:      `${t.pl_category}: ${t.description}`,
          detail:       `Z-score: ${t.z_score?.toFixed(2)} over ${t.periods_analysed} periods`,
        });
      }
    }
    if (alertInserts.length > 0) {
      await supabase.from("variance_alerts").insert(alertInserts);
    }

    return json({
      success:             true,
      run_id,
      insight_id:          insight?.id,
      tra_signals_fired:   firedSignals.length,
      critical_signals:    firedSignals.filter((s: any) => s.severity === "critical").length,
      trend_confidence:    run.trend_confidence,
      worsening_trends:    trends.filter((t: any) => t.pattern === "worsening").length,
      overall_risk:        riskOutput.summary.overall_risk,
      next_step:           "Call maono-decide",
    }, 200);

  } catch (err: any) {
    console.error("maono-risk error:", err);
    return json({ error: err.message }, 500);
  }
});

function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
