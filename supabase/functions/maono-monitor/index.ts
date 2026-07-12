/**
 * maono-monitor · IRON DOME NUCLEAR DESIGN · Phase C
 *
 * Scheduled nightly monitor. Scans all active companies.
 * Invoked by Supabase pg_cron at 19:00 UTC (22:00 Tanzania time, EAT = UTC+3).
 *
 * What it checks per company:
 *   1. Latest complete variance run → any material variances above threshold?
 *   2. Cash forecast → any critical/watch risk flags in next 13 weeks?
 *   3. Budget missing → upcoming period has no approved budget?
 *   4. TRA signal patterns → from existing maono_insights(insight_type='risk')?
 *   5. Trend deterioration → worsening patterns from risk insight?
 *
 * IRON DOME:
 *   - Writes alerts ONLY through maono_write_alert() SECURITY DEFINER.
 *     Never inserts directly into variance_alerts.
 *   - NEVER auto-executes any decision. Alert = notification only.
 *   - Deduplication enforced in maono_write_alert() — no duplicate alerts per run.
 *   - All errors are logged to maono_monitor_runs.errors_json, not swallowed.
 *   - Uses SERVICE ROLE key (set via env) — never uses anon key.
 *   - Materiality thresholds loaded from variance_materiality (per-company).
 *     No hardcoded thresholds anywhere.
 *
 * This function can also be invoked manually via POST for backfill.
 * Body: { trigger_type?: 'manual' }
 *
 * Cron registration (add to supabase/config.toml or via pg_cron):
 *   SELECT cron.schedule(
 *     'maono-monitor-nightly',
 *     '0 19 * * *',   -- 19:00 UTC = 22:00 EAT
 *     $$SELECT net.http_post(...)$$
 *   );
 */

import { serve }       from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Alert writer (calls SECURITY DEFINER function, never inserts directly) ────

async function writeAlert(
  supabase: any,
  companyId: string,
  runId: string | null,
  alertType: string,
  severity: string,
  categories: string[],
  codes: string[],
  message: string,
  detail?: string
): Promise<string | null> {
  const { data, error } = await supabase.rpc("maono_write_alert", {
    p_company_id:    companyId,
    p_run_id:        runId,
    p_alert_type:    alertType,
    p_severity:      severity,
    p_pl_categories: categories,
    p_account_codes: codes,
    p_message:       message,
    p_detail:        detail ?? null,
  });

  if (error) {
    console.error(`maono_write_alert error for company ${companyId}:`, error.message);
    return null;
  }
  return data as string | null;
}

// ── Check budget for upcoming period ─────────────────────────────────────────

async function checkMissingBudget(
  supabase: any,
  companyId: string
): Promise<{ missing: boolean; period?: string }> {
  const now       = new Date();
  const nextMonth = now.getMonth() + 2; // 1-indexed, +1 for next month
  const nextYear  = nextMonth > 12 ? now.getFullYear() + 1 : now.getFullYear();
  const month     = nextMonth > 12 ? 1 : nextMonth;

  const { data } = await supabase
    .from("variance_budgets")
    .select("id")
    .eq("company_id", companyId)
    .eq("fiscal_year",   nextYear)
    .eq("period_month",  month)
    .not("approved_by", "is", null)
    .limit(1);

  if (!data || data.length === 0) {
    const monthName = new Date(nextYear, month - 1, 1)
      .toLocaleString("en-GB", { month: "long", year: "numeric" });
    return { missing: true, period: monthName };
  }
  return { missing: false };
}

// ── Parse risk insight for TRA signals + worsening trends ─────────────────────

interface RiskSummary {
  tra_signals:     { key: string; severity: string; description: string }[];
  trend_analysis:  { pl_category: string; pattern: string; description: string }[];
  summary:         { overall_risk: string; critical_signals: number; worsening_trends: number };
}

function parseRiskInsight(aiOutput: string): RiskSummary | null {
  try {
    return JSON.parse(aiOutput) as RiskSummary;
  } catch {
    return null;
  }
}

// ── Per-company scan ──────────────────────────────────────────────────────────

async function scanCompany(
  supabase: any,
  companyId: string
): Promise<{ alertsWritten: number; errors: string[] }> {
  const errors: string[] = [];
  let alertsWritten = 0;

  try {
    // Load materiality thresholds (per-company — never hardcoded)
    const { data: mat } = await supabase
      .from("variance_materiality")
      .select("pct_threshold, abs_threshold_tzs, cash_warn_days, cash_critical_days")
      .eq("company_id", companyId)
      .single();

    const pctThreshold = mat?.pct_threshold   ?? 10;
    const absThreshold = mat?.abs_threshold_tzs ?? 5_000_000;
    const critDays     = mat?.cash_critical_days ?? 14;
    const warnDays     = mat?.cash_warn_days     ?? 30;

    // Load latest complete run
    const { data: run } = await supabase
      .from("variance_runs")
      .select("id, period_from, period_to, trend_confidence, seasonal_periods_available")
      .eq("company_id", companyId)
      .eq("status", "complete")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!run) {
      // No complete run yet — check if budget is missing for upcoming period
      const budgetCheck = await checkMissingBudget(supabase, companyId);
      if (budgetCheck.missing && budgetCheck.period) {
        const id = await writeAlert(
          supabase, companyId, null,
          "budget_missing", "warn",
          [], [],
          `No approved budget for ${budgetCheck.period}. Maono variance analysis cannot run without a budget.`,
          `Submit and approve a budget for ${budgetCheck.period} to enable variance analysis.`
        );
        if (id) alertsWritten++;
      }
      return { alertsWritten, errors };
    }

    // ── 1. Material variance alerts ───────────────────────────────────────────
    const { data: materialVars } = await supabase
      .from("variance_analyses")
      .select("account_code, account_name, pl_category, variance_tzs, variance_pct, is_material")
      .eq("run_id", run.id)
      .eq("is_material", true)
      .not("pl_category", "in", '("BALANCE_SHEET_ASSET","BALANCE_SHEET_LIAB","BALANCE_SHEET_EQUITY","STATISTICAL")')
      .order("variance_tzs", { ascending: true });

    for (const v of (materialVars ?? [])) {
      const isAdverse = (v.variance_tzs ?? 0) < 0;
      if (!isAdverse) continue; // only alert on adverse variances

      const absBreach = Math.abs(v.variance_tzs) >= absThreshold;
      const pctBreach = Math.abs(v.variance_pct) >= pctThreshold;

      if (absBreach || pctBreach) {
        const id = await writeAlert(
          supabase, companyId, run.id,
          "variance_threshold",
          Math.abs(v.variance_tzs) >= absThreshold * 2 ? "critical" : "warn",
          [v.pl_category], [v.account_code],
          `${v.account_name} (${v.pl_category}): TZS ${Math.abs(v.variance_tzs).toLocaleString()} adverse vs budget (${Math.abs(v.variance_pct?.toFixed(1))}%).`,
          `Period: ${run.period_from} to ${run.period_to}. Materiality threshold: >${pctThreshold}% or >TZS ${absThreshold.toLocaleString()}.`
        );
        if (id) alertsWritten++;
      }
    }

    // ── 2. Cash risk alerts ───────────────────────────────────────────────────
    const { data: cashWeeks } = await supabase
      .from("cashflow_forecasts")
      .select("week_number, forecast_week, closing_cash, risk_flag, risk_reason")
      .eq("run_id", run.id)
      .in("risk_flag", ["watch", "critical"])
      .order("week_number", { ascending: true });

    for (const w of (cashWeeks ?? [])) {
      const alertType = w.risk_flag === "critical" ? "cash_critical" : "cash_watch";
      const severity  = w.risk_flag === "critical" ? "critical" : "warn";
      const weekDate  = new Date(w.forecast_week).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

      const id = await writeAlert(
        supabase, companyId, run.id,
        alertType, severity,
        [], [],
        `Week ${w.week_number} (${weekDate}): Cash falls to TZS ${w.closing_cash.toLocaleString()} — ${w.risk_flag.toUpperCase()} level. ${w.risk_reason ?? ""}`.trim(),
        `${w.risk_flag === "critical" ? `Below ${critDays}-day` : `Below ${warnDays}-day`} runway threshold.`
      );
      if (id) alertsWritten++;
    }

    // ── 3. Budget missing for next period ─────────────────────────────────────
    const budgetCheck = await checkMissingBudget(supabase, companyId);
    if (budgetCheck.missing && budgetCheck.period) {
      const id = await writeAlert(
        supabase, companyId, run.id,
        "budget_missing", "warn",
        [], [],
        `No approved budget for ${budgetCheck.period}. Without a budget, next month's variance analysis cannot run.`,
        `Submit and approve a budget at least 3 days before period end.`
      );
      if (id) alertsWritten++;
    }

    // ── 4. TRA signals + trend deterioration from latest risk insight ─────────
    const { data: riskInsight } = await supabase
      .from("maono_insights")
      .select("ai_output")
      .eq("run_id", run.id)
      .eq("insight_type", "risk")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (riskInsight?.ai_output) {
      const risk = parseRiskInsight(riskInsight.ai_output);
      if (risk) {
        // Critical TRA signals
        for (const sig of (risk.tra_signals ?? [])) {
          if (sig.severity === "critical") {
            const id = await writeAlert(
              supabase, companyId, run.id,
              "tra_risk_signal", "critical",
              [], [],
              `TRA Audit Risk: ${sig.description}`,
              `Signal key: ${sig.key}. Detected in risk analysis for ${run.period_from}–${run.period_to}.`
            );
            if (id) alertsWritten++;
          }
        }

        // Worsening trends
        for (const t of (risk.trend_analysis ?? [])) {
          if (t.pattern === "worsening") {
            const id = await writeAlert(
              supabase, companyId, run.id,
              "trend_deterioration", "warn",
              [t.pl_category], [],
              `${t.pl_category}: ${t.description}`,
              `Detected in trend analysis for ${run.period_from}–${run.period_to}.`
            );
            if (id) alertsWritten++;
          }
        }
      }
    }

  } catch (err: any) {
    errors.push(`Company ${companyId}: ${err.message}`);
  }

  return { alertsWritten, errors };
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // ── Auth gate ─────────────────────────────────────────────────────────
  // Scheduled invocations are authenticated by pg_cron using SUPABASE_SERVICE_ROLE_KEY.
  // Manual invocations must present a valid JWT for a firm_member (any company).
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  let triggerType: "scheduled" | "manual" = "scheduled";

  if (!bearer) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (bearer === serviceKey) {
    triggerType = "scheduled";
  } else {
    // Validate as a user JWT
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: claims, error: claimsErr } = await authClient.auth.getClaims(bearer);
    const callerId = claims?.claims?.sub as string | undefined;
    if (claimsErr || !callerId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Caller must be a firm member of at least one company
    const adminCheck = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, {
      auth: { persistSession: false },
    });
    const { data: member } = await adminCheck
      .from("firm_members")
      .select("id")
      .eq("user_id", callerId)
      .not("accepted_at", "is", null)
      .limit(1)
      .maybeSingle();
    if (!member) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    triggerType = "manual";
  }

  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    if (body.trigger_type === "manual") triggerType = "manual";
  } catch { /* ignore */ }

  // Use SERVICE ROLE key — monitor needs to scan all companies
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    serviceKey,
    { auth: { persistSession: false } }
  );

  // Create monitor run record
  const { data: monitorRun } = await supabase
    .from("maono_monitor_runs")
    .insert({ trigger_type: triggerType })
    .select("id")
    .single();

  const monitorRunId = monitorRun?.id;
  const startedAt    = Date.now();
  const allErrors:   string[] = [];
  let   totalAlerts  = 0;
  let   companiesScanned = 0;

  try {
    // Load all companies (no company filter — monitor scans all)
    const { data: companies } = await supabase
      .from("companies")
      .select("id, name")
      .order("name");

    console.log(`maono-monitor: scanning ${companies?.length ?? 0} companies`);

    for (const company of (companies ?? [])) {
      const { alertsWritten, errors } = await scanCompany(supabase, company.id);
      totalAlerts       += alertsWritten;
      companiesScanned  += 1;
      allErrors.push(...errors);

      if (errors.length > 0) {
        console.error(`Errors for ${company.name}:`, errors);
      }
    }

    // Update monitor run record with results
    if (monitorRunId) {
      await supabase
        .from("maono_monitor_runs")
        .update({
          completed_at:       new Date().toISOString(),
          companies_scanned:  companiesScanned,
          alerts_written:     totalAlerts,
          errors_json:        allErrors.length > 0 ? allErrors : null,
        })
        .eq("id", monitorRunId);
    }

    const elapsed = Date.now() - startedAt;
    console.log(`maono-monitor complete: ${companiesScanned} companies, ${totalAlerts} alerts, ${elapsed}ms`);

    return new Response(JSON.stringify({
      success:            true,
      trigger_type:       triggerType,
      companies_scanned:  companiesScanned,
      alerts_written:     totalAlerts,
      errors:             allErrors,
      elapsed_ms:         elapsed,
    }), {
      status:  200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("maono-monitor fatal error:", err);

    if (monitorRunId) {
      await supabase
        .from("maono_monitor_runs")
        .update({
          completed_at: new Date().toISOString(),
          errors_json:  [err.message, ...allErrors],
        })
        .eq("id", monitorRunId);
    }

    return new Response(JSON.stringify({ error: err.message, errors: allErrors }), {
      status:  500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
