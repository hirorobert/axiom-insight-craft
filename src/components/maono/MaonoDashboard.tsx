/**
 * MaonoDashboard · Maono Intelligence Engine · Phase B
 *
 * Role-aware intelligence router.
 *
 * Roles → views:
 *   CFO       → Executive Summary: Hoffman P&L KPIs + Top 3 risks + Cash runway + Decision paths
 *   Director  → Strategic view: Category-level trends + Risk radar + Priority decisions
 *   Manager   → Operational view: Account-level variances + root cause explanations
 *   Accountant→ Full view: Everything + validation badges + raw insight output
 *   Business  → Simplified: Plain-language summary + cash position + 2 action options
 *
 * IRON DOME:
 *   - validation_failed insights NOT shown to CFO/Director/Manager
 *   - Accountant sees all + validation badges
 *   - Business sees cash-flagged weeks and priority actions only
 *   - Actions marked "Requires sign-off" — no auto-execute anywhere
 *   - All data from Supabase, not props-drilled (each view queries its own slice)
 */

import React, { useState, useEffect, useCallback } from "react";
import { createClient }  from "@supabase/supabase-js";
import { InsightCard, InsightRow }   from "./InsightCard";
import { CashFlowForecast, CashWeek } from "./CashFlowForecast";
import { RiskRadar, RiskData }        from "./RiskRadar";

// ── Types ─────────────────────────────────────────────────────────────────────

type UserRole = "cfo" | "director" | "manager" | "accountant" | "business";

interface VarianceRun {
  id:                      string;
  company_id:              string;
  period_from:             string;
  period_to:               string;
  trend_confidence:        string;
  seasonal_periods_available: number;
  status:                  string;
  summary_json?:           any;
  created_at:              string;
}

interface VarianceAnalysis {
  account_code:    string;
  account_name:    string;
  pl_category:     string;
  actual_amount:   number;
  budget_amount:   number;
  variance_tzs:    number;
  variance_pct:    number;
  is_material:     boolean;
  pl_aggregate?:   string;
}

interface Alert {
  id:           string;
  alert_type:   string;
  severity:     "info" | "warn" | "critical";
  message:      string;
  detail?:      string;
  created_at:   string;
  acknowledged_at?: string;
}

interface MaonoDashboardProps {
  companyId:  string;
  userRole:   UserRole;
  runId?:     string; // if provided, load this run; otherwise load latest
  supabaseUrl:     string;
  supabaseAnonKey: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, compact = true): string {
  const abs = Math.abs(n);
  if (compact) {
    if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (abs >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000)         return `${(n / 1_000).toFixed(0)}K`;
    return n.toLocaleString();
  }
  return `TZS ${n.toLocaleString()}`;
}

function varianceColor(tzs: number): string {
  return tzs >= 0 ? "text-green-700" : "text-red-700";
}

function varSign(tzs: number): string {
  return tzs >= 0 ? "+" : "";
}

// ── Alert Banner ──────────────────────────────────────────────────────────────

function AlertBanner({ alerts, onAcknowledge }: { alerts: Alert[]; onAcknowledge: (id: string) => void }) {
  const critical = alerts.filter(a => a.severity === "critical" && !a.acknowledged_at);
  if (critical.length === 0) return null;

  return (
    <div className="rounded-lg border border-red-300 bg-red-50 p-4 mb-4">
      <div className="text-sm font-semibold text-red-800 mb-2">
        {critical.length} critical alert{critical.length > 1 ? "s" : ""} require attention
      </div>
      <div className="space-y-2">
        {critical.map(a => (
          <div key={a.id} className="flex items-start gap-3">
            <span className="text-xs font-medium bg-red-200 text-red-800 rounded px-1.5 py-0.5 flex-shrink-0 mt-0.5">
              {a.alert_type.replace(/_/g, " ")}
            </span>
            <span className="text-xs text-red-700 flex-1">{a.message}</span>
            <button
              onClick={() => onAcknowledge(a.id)}
              className="text-xs text-red-600 hover:text-red-900 underline flex-shrink-0"
            >
              Acknowledge
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Hoffman KPI strip ─────────────────────────────────────────────────────────

function HoffmanStrip({ summary }: { summary: any }) {
  if (!summary?.hoffman_aggregates) return null;

  const agg = summary.hoffman_aggregates;
  const kpis = [
    { label: "Revenue",     key: "REVENUE"     },
    { label: "Gross Profit",key: "GROSS_PROFIT" },
    { label: "EBITDA",      key: "EBITDA"       },
    { label: "EBIT",        key: "EBIT"         },
    { label: "Net Profit",  key: "NET_PROFIT"   },
  ];

  return (
    <div className="grid grid-cols-5 gap-2">
      {kpis.map(kpi => {
        const item = agg[kpi.key];
        if (!item) return null;
        const varTzs = (item.actual ?? 0) - (item.budget ?? 0);
        return (
          <div key={kpi.key} className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
            <div className="text-xs text-gray-500 font-medium">{kpi.label}</div>
            <div className="text-lg font-bold text-gray-900 mt-1">{fmt(item.actual ?? 0)}</div>
            <div className={`text-xs font-medium mt-0.5 ${varianceColor(varTzs)}`}>
              {varSign(varTzs)}{fmt(varTzs)} vs budget
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Variance table ────────────────────────────────────────────────────────────

function VarianceTable({ analyses, showAll = false }: { analyses: VarianceAnalysis[]; showAll?: boolean }) {
  const [expanded, setExpanded] = useState(showAll);
  const displayed = expanded ? analyses : analyses.slice(0, 8);

  if (analyses.length === 0) return (
    <div className="text-sm text-gray-500 text-center py-4">All variances within materiality thresholds.</div>
  );

  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            {["Account", "Category", "Actual", "Budget", "Variance", "%"].map(h => (
              <th key={h} className="px-3 py-2.5 text-left text-gray-600 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {displayed.map((a, i) => (
            <tr key={i} className={`${!a.is_material ? "opacity-60" : ""} hover:bg-gray-50`}>
              <td className="px-3 py-2 text-gray-900 font-medium">{a.account_name}</td>
              <td className="px-3 py-2">
                <span className="bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">
                  {a.pl_category.replace(/_/g, " ")}
                </span>
              </td>
              <td className="px-3 py-2 text-gray-700 tabular-nums">{fmt(a.actual_amount)}</td>
              <td className="px-3 py-2 text-gray-700 tabular-nums">{fmt(a.budget_amount)}</td>
              <td className={`px-3 py-2 font-medium tabular-nums ${varianceColor(a.variance_tzs)}`}>
                {varSign(a.variance_tzs)}{fmt(a.variance_tzs)}
              </td>
              <td className={`px-3 py-2 font-medium tabular-nums ${varianceColor(a.variance_pct)}`}>
                {varSign(a.variance_pct)}{a.variance_pct?.toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {analyses.length > 8 && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full py-2 text-xs text-indigo-600 hover:bg-indigo-50 border-t border-gray-200 transition-colors"
        >
          Show all {analyses.length} accounts
        </button>
      )}
    </div>
  );
}

// ── Role view: CFO ────────────────────────────────────────────────────────────

function CFOView({ run, analyses, insights, riskData, cashWeeks, alerts, onAck }: any) {
  const material = analyses.filter((a: VarianceAnalysis) => a.is_material);
  const decisionInsight = insights.find((i: InsightRow) =>
    i.insight_type === "decision" && i.numeric_validation_passed
  );

  return (
    <div className="space-y-5">
      <AlertBanner alerts={alerts} onAcknowledge={onAck} />
      <HoffmanStrip summary={run?.summary_json} />

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Material Variances
          </div>
          <VarianceTable analyses={material} />
        </div>
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Risk Signals
          </div>
          <RiskRadar riskData={riskData} />
        </div>
      </div>

      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          13-Week Cash Runway
        </div>
        <CashFlowForecast weeks={cashWeeks} />
      </div>

      {decisionInsight && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Decision Paths
          </div>
          <InsightCard insight={decisionInsight} defaultExpanded />
        </div>
      )}
    </div>
  );
}

// ── Role view: Director ───────────────────────────────────────────────────────

function DirectorView({ run, analyses, insights, riskData, cashWeeks, alerts, onAck }: any) {
  const material = analyses.filter((a: VarianceAnalysis) => a.is_material);
  const rootCause = insights.find((i: InsightRow) =>
    i.insight_type === "root_cause" && i.numeric_validation_passed
  );
  const decision = insights.find((i: InsightRow) =>
    i.insight_type === "decision" && i.numeric_validation_passed
  );

  return (
    <div className="space-y-5">
      <AlertBanner alerts={alerts} onAcknowledge={onAck} />
      <HoffmanStrip summary={run?.summary_json} />

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Risk Radar</div>
          <RiskRadar riskData={riskData} />
        </div>
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Cash Forecast</div>
          <CashFlowForecast weeks={cashWeeks} />
        </div>
      </div>

      {rootCause && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Root Cause Analysis</div>
          <InsightCard insight={rootCause} />
        </div>
      )}

      {decision && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Strategic Decision Paths</div>
          <InsightCard insight={decision} defaultExpanded />
        </div>
      )}
    </div>
  );
}

// ── Role view: Manager ────────────────────────────────────────────────────────

function ManagerView({ analyses, insights, cashWeeks, alerts, onAck }: any) {
  const material = analyses.filter((a: VarianceAnalysis) => a.is_material);
  const rootCause = insights.find((i: InsightRow) =>
    i.insight_type === "root_cause" && i.numeric_validation_passed
  );

  return (
    <div className="space-y-5">
      <AlertBanner alerts={alerts} onAcknowledge={onAck} />

      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Material Variances This Period
        </div>
        <VarianceTable analyses={material} showAll />
      </div>

      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Cash Position</div>
        <CashFlowForecast weeks={cashWeeks.slice(0, 4)} />
      </div>

      {rootCause && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Root Cause Explanations
          </div>
          <InsightCard insight={rootCause} defaultExpanded />
        </div>
      )}
    </div>
  );
}

// ── Role view: Accountant ─────────────────────────────────────────────────────

function AccountantView({ analyses, insights, riskData, cashWeeks, alerts, onAck }: any) {
  // Accountants see everything including validation_failed
  return (
    <div className="space-y-5">
      <AlertBanner alerts={alerts} onAcknowledge={onAck} />

      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          All Variance Analyses
        </div>
        <VarianceTable analyses={analyses} showAll />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Risk + TRA Signals</div>
          <RiskRadar riskData={riskData} />
        </div>
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Cash Forecast</div>
          <CashFlowForecast weeks={cashWeeks} />
        </div>
      </div>

      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          All AI Insights (including validation-flagged)
        </div>
        <div className="space-y-3">
          {insights.length === 0 ? (
            <div className="text-sm text-gray-500">No insights generated yet for this run.</div>
          ) : (
            insights.map((ins: InsightRow) => (
              <InsightCard key={ins.id} insight={ins} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ── Role view: Business Personnel ─────────────────────────────────────────────

function BusinessView({ run, analyses, insights, cashWeeks, alerts, onAck }: any) {
  const critical = cashWeeks.filter((w: CashWeek) => w.risk_flag === "critical");
  const watch    = cashWeeks.filter((w: CashWeek) => w.risk_flag === "watch");
  const material = analyses.filter((a: VarianceAnalysis) => a.is_material);

  const decision = insights.find((i: InsightRow) =>
    i.insight_type === "decision" && i.numeric_validation_passed
  );

  const periodLabel = run
    ? `${new Date(run.period_from).toLocaleDateString("en-GB", { month: "short", year: "numeric" })} — ${new Date(run.period_to).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}`
    : "";

  return (
    <div className="space-y-5">
      <AlertBanner alerts={alerts} onAcknowledge={onAck} />

      {/* Plain-language summary */}
      <div className="rounded-lg border border-gray-200 bg-white shadow-sm p-5">
        <div className="text-xs text-gray-500 mb-1">Period: {periodLabel}</div>
        <h3 className="text-base font-semibold text-gray-900 mb-3">Business Summary</h3>

        {material.length === 0 ? (
          <p className="text-sm text-green-700">All spending and income lines are on track against budget this period.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-gray-700">
              There are <strong>{material.length}</strong> areas where actual results differ significantly from the budget this period:
            </p>
            <div className="space-y-1.5">
              {material.slice(0, 5).map((a: VarianceAnalysis, i: number) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className={`font-medium ${varianceColor(a.variance_tzs)}`}>
                    {a.variance_tzs >= 0 ? "▲" : "▼"}
                  </span>
                  <span className="text-gray-800">{a.account_name}</span>
                  <span className={`text-xs font-medium ${varianceColor(a.variance_tzs)}`}>
                    {varSign(a.variance_tzs)}{fmt(a.variance_tzs)} vs budget
                  </span>
                </div>
              ))}
              {material.length > 5 && (
                <p className="text-xs text-gray-500">+{material.length - 5} more items</p>
              )}
            </div>
          </div>
        )}

        {(critical.length > 0 || watch.length > 0) && (
          <div className={`mt-4 rounded-lg p-3 ${critical.length > 0 ? "bg-red-50 border border-red-200" : "bg-amber-50 border border-amber-200"}`}>
            <p className="text-sm font-medium text-gray-800">
              {critical.length > 0
                ? `Cash flow is tight in ${critical.length} upcoming week${critical.length > 1 ? "s" : ""}. Management attention needed.`
                : `Cash flow is below the comfortable threshold in ${watch.length} upcoming week${watch.length > 1 ? "s" : ""}. Monitor closely.`
              }
            </p>
          </div>
        )}
      </div>

      {/* Cash bar (simplified — just opening + closing) */}
      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">4-Week Cash Position</div>
        <CashFlowForecast weeks={cashWeeks.slice(0, 4)} />
      </div>

      {/* Decision paths (if available) — plain language framing */}
      {decision && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            What the Business Can Do Next
          </div>
          <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-800 mb-2">
            The options below have been prepared by the finance team. None of them will be acted on
            automatically — a sign-off from the appropriate person is required for each one.
          </div>
          <InsightCard insight={decision} defaultExpanded />
        </div>
      )}
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export function MaonoDashboard({
  companyId,
  userRole,
  runId,
  supabaseUrl,
  supabaseAnonKey,
}: MaonoDashboardProps) {
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [run,       setRun]       = useState<VarianceRun | null>(null);
  const [analyses,  setAnalyses]  = useState<VarianceAnalysis[]>([]);
  const [insights,  setInsights]  = useState<InsightRow[]>([]);
  const [riskData,  setRiskData]  = useState<RiskData | null>(null);
  const [cashWeeks, setCashWeeks] = useState<CashWeek[]>([]);
  const [alerts,    setAlerts]    = useState<Alert[]>([]);

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Load run
      let runQuery = supabase
        .from("variance_runs")
        .select("id, company_id, period_from, period_to, trend_confidence, seasonal_periods_available, status, summary_json, created_at")
        .eq("company_id", companyId)
        .eq("status", "complete");

      if (runId) {
        runQuery = runQuery.eq("id", runId);
      } else {
        runQuery = runQuery.order("created_at", { ascending: false }).limit(1);
      }

      const { data: runData, error: runErr } = await runQuery.single();
      if (runErr) throw new Error("Could not load variance run: " + runErr.message);
      setRun(runData);

      const activeRunId = runData.id;

      // Load analyses
      const { data: analysisData } = await supabase
        .from("variance_analyses")
        .select("account_code, account_name, pl_category, actual_amount, budget_amount, variance_tzs, variance_pct, is_material, pl_aggregate")
        .eq("run_id", activeRunId)
        .order("variance_tzs", { ascending: true });
      setAnalyses(analysisData ?? []);

      // Load insights — accountants see all, others see validated only
      const insightQuery = supabase
        .from("maono_insights")
        .select("id, insight_type, ai_output, confidence_level, numeric_validation_passed, numeric_validation_detail, subject_pl_categories, created_at, ai_model_used")
        .eq("run_id", activeRunId)
        .order("created_at", { ascending: true });

      if (userRole !== "accountant") {
        // Don't show validation_failed to non-accountants
        insightQuery.neq("confidence_level", "validation_failed");
      }

      const { data: insightData } = await insightQuery;
      setInsights(insightData ?? []);

      // Parse risk data from risk insight
      const riskInsight = (insightData ?? []).find((i: any) => i.insight_type === "risk");
      if (riskInsight?.ai_output) {
        try {
          setRiskData(JSON.parse(riskInsight.ai_output));
        } catch {
          // deterministic risk output is JSON — if parse fails, show nothing
        }
      }

      // Load cash weeks
      const { data: cashData } = await supabase
        .from("cashflow_forecasts")
        .select("*")
        .eq("run_id", activeRunId)
        .order("week_number", { ascending: true });
      setCashWeeks(cashData ?? []);

      // Load unacknowledged alerts
      const { data: alertData } = await supabase
        .from("variance_alerts")
        .select("id, alert_type, severity, message, detail, created_at, acknowledged_at")
        .eq("company_id", companyId)
        .order("severity", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(20);
      setAlerts(alertData ?? []);

    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [companyId, runId, userRole]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleAcknowledge = async (alertId: string) => {
    await supabase
      .from("variance_alerts")
      .update({
        acknowledged_by:   (await supabase.auth.getUser()).data.user?.id,
        acknowledged_at:   new Date().toISOString(),
        acknowledgment_note: "Acknowledged from dashboard",
      })
      .eq("id", alertId);

    setAlerts(prev => prev.map(a =>
      a.id === alertId ? { ...a, acknowledged_at: new Date().toISOString() } : a
    ));
  };

  const ROLE_LABELS: Record<UserRole, string> = {
    cfo:        "CFO View",
    director:   "Director View",
    manager:    "Manager View",
    accountant: "Accountant View",
    business:   "Business View",
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-sm text-gray-400 animate-pulse">Loading intelligence…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6">
        <p className="text-sm font-medium text-red-800">Failed to load Maono dashboard</p>
        <p className="text-xs text-red-700 mt-1">{error}</p>
        <button
          onClick={loadData}
          className="mt-3 text-xs text-red-700 underline hover:text-red-900"
        >
          Retry
        </button>
      </div>
    );
  }

  const commonProps = { run, analyses, insights, riskData, cashWeeks, alerts, onAck: handleAcknowledge };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Topbar */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="h-6 w-6 rounded bg-indigo-600 flex items-center justify-center">
            <span className="text-white text-xs font-bold">M</span>
          </div>
          <span className="text-sm font-semibold text-gray-900">Maono Intelligence</span>
          {run && (
            <span className="text-xs text-gray-500">
              {new Date(run.period_from).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}
              {" — "}
              {new Date(run.period_to).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs bg-indigo-100 text-indigo-700 rounded-full px-2.5 py-1 font-medium">
            {ROLE_LABELS[userRole]}
          </span>
          <button
            onClick={loadData}
            className="text-xs text-gray-500 hover:text-gray-800 transition-colors"
            title="Refresh"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Iron Dome notice */}
      {userRole !== "accountant" && (
        <div className="mx-6 mt-3 rounded-md bg-blue-50 border border-blue-200 px-4 py-2 text-xs text-blue-700 flex items-center gap-2">
          <span>🛡</span>
          <span>
            All figures sourced from verified, Safisha-clean trial balance data.
            {userRole === "cfo" || userRole === "director"
              ? " AI insights shown here have passed numeric validation."
              : " Decisions require explicit sign-off — nothing executes automatically."}
          </span>
        </div>
      )}

      {/* Main content */}
      <div className="mx-6 mt-4 pb-12">
        {userRole === "cfo"        && <CFOView       {...commonProps} />}
        {userRole === "director"   && <DirectorView  {...commonProps} />}
        {userRole === "manager"    && <ManagerView   {...commonProps} />}
        {userRole === "accountant" && <AccountantView {...commonProps} />}
        {userRole === "business"   && <BusinessView  {...commonProps} />}
      </div>
    </div>
  );
}

export default MaonoDashboard;
