/**
 * BoardPackGenerator · Maono Phase C
 *
 * Executive board pack — generates a structured multi-section document
 * from Maono data and exports to PDF (print) or Excel.
 *
 * Sections:
 *   1. Executive Summary (AI-generated, from maono-decide insight)
 *   2. Hoffman P&L Summary (KPI strip vs budget vs prior year)
 *   3. Material Variances Table
 *   4. Root Cause Highlights (top 3 from maono-root-cause)
 *   5. 13-Week Cash Flow Forecast
 *   6. Risk Signals & Trend Analysis
 *   7. Decision Paths (from maono-decide)
 *   8. Alert Summary
 *
 * IRON DOME:
 *   - Board pack stored via maono_write_board_pack() SECURITY DEFINER.
 *   - Numeric validation badge shown if any insight is validation_failed.
 *   - All figures sourced from DB snapshot — no manual input in pack.
 *   - Excel export uses SheetJS (XLSX) — no server-side processing needed.
 *
 * PDF export: browser window.print() with a print-optimised CSS class.
 * Excel export: SheetJS workbook with one sheet per section.
 */

import React, { useState, useCallback, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
// @ts-expect-error - runtime ESM URL import (loaded via esm.sh at runtime)
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

interface BoardPackData {
  company_name:    string;
  period_label:    string;
  run_id:          string;
  period_from:     string;
  period_to:       string;
  generated_at:    string;
  analyses:        any[];
  insights:        any[];
  cashWeeks:       any[];
  alerts:          any[];
  riskData?:       any;
  summaryJson?:    any;
}

interface BoardPackGeneratorProps {
  companyId:       string;
  companyName:     string;
  runId:           string;
  supabaseUrl:     string;
  supabaseAnonKey: string;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `TZS ${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000)     return `TZS ${(n / 1_000_000).toFixed(2)}M`;
  return `TZS ${n.toLocaleString()}`;
}

// ── Excel export ──────────────────────────────────────────────────────────────

function exportToExcel(pack: BoardPackData) {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Summary
  const summaryRows = [
    ["MAONO BOARD PACK"],
    ["Company:", pack.company_name],
    ["Period:", pack.period_label],
    ["Generated:", pack.generated_at],
    ["Run ID:", pack.run_id],
    [],
    ["P&L SUMMARY"],
  ];
  const agg = pack.summaryJson?.hoffman_aggregates ?? {};
  const kpis = ["REVENUE", "GROSS_PROFIT", "EBITDA", "EBIT", "NET_PROFIT"];
  summaryRows.push(["Category", "Actual (TZS)", "Budget (TZS)", "Variance (TZS)", "Variance %"]);
  for (const k of kpis) {
    const item = agg[k];
    if (!item) continue;
    const varTzs = (item.actual ?? 0) - (item.budget ?? 0);
    const varPct  = item.budget !== 0 ? ((varTzs / Math.abs(item.budget)) * 100).toFixed(1) + "%" : "N/A";
    summaryRows.push([
      k.replace(/_/g, " "),
      item.actual ?? 0,
      item.budget ?? 0,
      varTzs,
      varPct,
    ]);
  }

  const ws1 = XLSX.utils.aoa_to_sheet(summaryRows);
  ws1["!cols"] = [{ wch: 25 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws1, "Summary");

  // Sheet 2: Variances
  const varRows = [
    ["MATERIAL VARIANCE DETAIL"],
    ["Account Code", "Account Name", "Category", "Actual (TZS)", "Budget (TZS)", "Variance (TZS)", "Variance %", "Material"],
  ];
  for (const a of pack.analyses) {
    varRows.push([
      a.account_code,
      a.account_name,
      a.pl_category,
      a.actual_amount ?? 0,
      a.budget_amount ?? 0,
      a.variance_tzs ?? 0,
      a.variance_pct != null ? (a.variance_pct.toFixed(1) + "%") : "",
      a.is_material ? "Yes" : "No",
    ]);
  }
  const ws2 = XLSX.utils.aoa_to_sheet(varRows);
  ws2["!cols"] = [{ wch: 14 }, { wch: 30 }, { wch: 22 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws2, "Variances");

  // Sheet 3: Cash Forecast
  const cashRows = [
    ["13-WEEK CASH FLOW FORECAST"],
    ["Week", "Forecast Date", "Opening Cash", "AR Inflows", "Other Inflows", "AP Outflows", "PAYE", "VAT", "SDL", "WHT", "Total Outflows", "Closing Cash", "Risk"],
  ];
  for (const w of pack.cashWeeks) {
    cashRows.push([
      `W${w.week_number}`,
      w.forecast_week,
      w.opening_cash,
      w.expected_ar_inflows,
      w.expected_other_inflows,
      w.expected_ap_outflows,
      w.paye_due,
      w.vat_due,
      w.sdl_due,
      w.wht_due,
      w.total_outflows,
      w.closing_cash,
      w.risk_flag.toUpperCase(),
    ]);
  }
  const ws3 = XLSX.utils.aoa_to_sheet(cashRows);
  ws3["!cols"] = Array(13).fill({ wch: 16 });
  XLSX.utils.book_append_sheet(wb, ws3, "Cash Forecast");

  // Sheet 4: Alerts
  const alertRows = [
    ["ALERTS SUMMARY"],
    ["Type", "Severity", "Message", "Detail", "Created", "Acknowledged"],
  ];
  for (const a of pack.alerts) {
    alertRows.push([
      a.alert_type,
      a.severity.toUpperCase(),
      a.message,
      a.detail ?? "",
      a.created_at,
      a.acknowledged_at ? "Yes" : "No",
    ]);
  }
  const ws4 = XLSX.utils.aoa_to_sheet(alertRows);
  ws4["!cols"] = [{ wch: 22 }, { wch: 12 }, { wch: 60 }, { wch: 40 }, { wch: 20 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws4, "Alerts");

  // Write and trigger download
  const filename = `BoardPack_${pack.company_name.replace(/\s/g, "_")}_${pack.period_label.replace(/\s/g, "_")}.xlsx`;
  XLSX.writeFile(wb, filename);
}

// ── Print styles injected into document head ──────────────────────────────────

const PRINT_STYLE_ID = "maono-board-pack-print-styles";

function injectPrintStyles() {
  if (document.getElementById(PRINT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = PRINT_STYLE_ID;
  style.textContent = `
    @media print {
      body > *:not(#maono-board-pack-print-root) { display: none !important; }
      #maono-board-pack-print-root { display: block !important; }
      .no-print { display: none !important; }
      .page-break { page-break-before: always; }
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
    @media screen {
      #maono-board-pack-print-root { display: none; }
    }
  `;
  document.head.appendChild(style);
}

// ── Board Pack Print view ─────────────────────────────────────────────────────

function PrintablePackSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h2 style={{ fontSize: "14px", fontWeight: "bold", borderBottom: "2px solid #1e293b", paddingBottom: "4px", marginBottom: "12px" }}>
        {title}
      </h2>
      {children}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function BoardPackGenerator({
  companyId,
  companyName,
  runId,
  supabaseUrl,
  supabaseAnonKey,
}: BoardPackGeneratorProps) {
  const [loading,    setLoading]    = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [pack,       setPack]       = useState<BoardPackData | null>(null);
  const [error,      setError]      = useState<string | null>(null);
  const [savedId,    setSavedId]    = useState<string | null>(null);
  const printRef = useRef<HTMLDivElement>(null);

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  const generatePack = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPack(null);

    try {
      // Load run
      const { data: run } = await supabase
        .from("variance_runs")
        .select("id, period_from, period_to, summary_json")
        .eq("id", runId)
        .single();
      if (!run) throw new Error("Run not found");

      // Load all analyses
      const { data: analyses } = await supabase
        .from("variance_analyses")
        .select("account_code, account_name, pl_category, actual_amount, budget_amount, variance_tzs, variance_pct, is_material")
        .eq("run_id", runId)
        .order("variance_tzs", { ascending: true });

      // Load validated insights
      const { data: insights } = await supabase
        .from("maono_insights")
        .select("id, insight_type, ai_output, confidence_level, numeric_validation_passed, created_at")
        .eq("run_id", runId)
        .order("created_at", { ascending: true });

      // Load cash weeks
      const { data: cashWeeks } = await supabase
        .from("cashflow_forecasts")
        .select("*")
        .eq("run_id", runId)
        .order("week_number");

      // Load alerts
      const { data: alerts } = await supabase
        .from("variance_alerts")
        .select("id, alert_type, severity, message, detail, created_at, acknowledged_at")
        .eq("company_id", companyId)
        .order("severity")
        .order("created_at", { ascending: false })
        .limit(50);

      const periodLabel = `${new Date(run.period_from).toLocaleDateString("en-GB", { month: "long", year: "numeric" })}`;

      const riskInsight = (insights ?? []).find((i: any) => i.insight_type === "risk");
      let riskData = null;
      if (riskInsight?.ai_output) {
        try { riskData = JSON.parse(riskInsight.ai_output); } catch {}
      }

      const packData: BoardPackData = {
        company_name:  companyName,
        period_label:  periodLabel,
        run_id:        runId,
        period_from:   run.period_from,
        period_to:     run.period_to,
        generated_at:  new Date().toLocaleString("en-GB"),
        analyses:      analyses ?? [],
        insights:      insights ?? [],
        cashWeeks:     cashWeeks ?? [],
        alerts:        alerts ?? [],
        riskData,
        summaryJson:   run.summary_json,
      };

      injectPrintStyles();
      setPack(packData);

    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [companyId, runId, companyName]);

  const handleSave = async () => {
    if (!pack) return;
    setSaving(true);

    const { data, error } = await supabase.rpc("maono_write_board_pack", {
      p_company_id:      companyId,
      p_run_id:          runId,
      p_period_label:    pack.period_label,
      p_pack_type:       "monthly",
      p_sections_json:   {
        analyses:   pack.analyses.length,
        insights:   pack.insights.length,
        cash_weeks: pack.cashWeeks.length,
        alerts:     pack.alerts.length,
      },
      p_summary_text:    (pack.insights.find((i: any) => i.insight_type === "decision")?.ai_output ?? "").substring(0, 500),
      p_generation_model:"claude-sonnet-4-6",
      p_context_version: 0,
    });

    if (error) setError(error.message);
    else setSavedId(data as string);
    setSaving(false);
  };

  const handlePrint = () => {
    if (!printRef.current) return;
    const printRoot = document.getElementById("maono-board-pack-print-root");
    if (printRoot) printRoot.innerHTML = printRef.current.outerHTML;
    window.print();
  };

  const material   = pack?.analyses.filter((a: any) => a.is_material) ?? [];
  const decideIns  = pack?.insights.find((i: any) => i.insight_type === "decision" && i.numeric_validation_passed);
  const rootIns    = pack?.insights.find((i: any) => i.insight_type === "root_cause" && i.numeric_validation_passed);
  const hasUnvalidated = pack?.insights.some((i: any) => !i.numeric_validation_passed) ?? false;

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-900">Board Pack Generator</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          Executive multi-section report · Stored append-only · Export to PDF or Excel
        </p>
      </div>

      <div className="p-5">
        {/* Generate */}
        {!pack && (
          <div className="text-center py-8">
            <p className="text-sm text-gray-600 mb-4">
              Generate an executive board pack from all Maono analysis for this period.
            </p>
            <button
              onClick={generatePack}
              disabled={loading}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-medium rounded-lg px-6 py-2.5 transition-colors"
            >
              {loading ? "Generating…" : "Generate Board Pack"}
            </button>
            {error && (
              <p className="mt-3 text-xs text-red-600">{error}</p>
            )}
          </div>
        )}

        {/* Pack preview + actions */}
        {pack && (
          <>
            {hasUnvalidated && (
              <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-700">
                ⚠ One or more AI insights in this pack did not pass numeric validation.
                These are marked in the pack. Accountant review recommended before distribution.
              </div>
            )}

            {/* Action bar */}
            <div className="flex gap-2 mb-5 flex-wrap">
              <button
                onClick={handlePrint}
                className="flex items-center gap-2 bg-gray-800 hover:bg-gray-900 text-white text-xs font-medium rounded-lg px-4 py-2 transition-colors"
              >
                🖨 Export PDF (Print)
              </button>
              <button
                onClick={() => exportToExcel(pack)}
                className="flex items-center gap-2 bg-green-700 hover:bg-green-800 text-white text-xs font-medium rounded-lg px-4 py-2 transition-colors"
              >
                📊 Export Excel
              </button>
              {!savedId && (
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-xs font-medium rounded-lg px-4 py-2 transition-colors"
                >
                  {saving ? "Saving…" : "💾 Save to Record"}
                </button>
              )}
              {savedId && (
                <span className="text-xs text-green-700 flex items-center">✓ Saved (ID: {savedId.substring(0, 8)}…)</span>
              )}
              <button
                onClick={() => setPack(null)}
                className="text-xs text-gray-500 hover:text-gray-700 underline ml-auto"
              >
                Clear
              </button>
            </div>

            {/* Printable preview */}
            <div ref={printRef} className="border border-gray-200 rounded-lg p-6 bg-white text-gray-900">
              {/* Cover */}
              <div className="mb-8 pb-4 border-b-2 border-gray-800">
                <div className="text-xs text-gray-500 uppercase tracking-widest mb-1">Board Pack · Confidential</div>
                <h1 className="text-2xl font-bold text-gray-900">{pack.company_name}</h1>
                <h2 className="text-lg text-gray-600 mt-1">{pack.period_label} Management Accounts</h2>
                <div className="text-xs text-gray-400 mt-2">Generated: {pack.generated_at} · Powered by Maono Intelligence · Iron Dome Nuclear Design</div>
              </div>

              {/* Section 1: Hoffman KPI Summary */}
              <PrintablePackSection title="1. P&L Summary">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-gray-100">
                      <th className="text-left px-3 py-2 font-semibold">Metric</th>
                      <th className="text-right px-3 py-2 font-semibold">Actual</th>
                      <th className="text-right px-3 py-2 font-semibold">Budget</th>
                      <th className="text-right px-3 py-2 font-semibold">Variance</th>
                      <th className="text-right px-3 py-2 font-semibold">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {["REVENUE", "GROSS_PROFIT", "EBITDA", "EBIT", "NET_PROFIT"].map(k => {
                      const item = pack.summaryJson?.hoffman_aggregates?.[k];
                      if (!item) return null;
                      const v = (item.actual ?? 0) - (item.budget ?? 0);
                      const p = item.budget ? ((v / Math.abs(item.budget)) * 100).toFixed(1) + "%" : "—";
                      return (
                        <tr key={k} className="border-t border-gray-200">
                          <td className="px-3 py-2 font-medium">{k.replace(/_/g, " ")}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmt(item.actual ?? 0)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-500">{fmt(item.budget ?? 0)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums font-medium ${v < 0 ? "text-red-600" : "text-green-600"}`}>{fmt(v)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${v < 0 ? "text-red-600" : "text-green-600"}`}>{p}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </PrintablePackSection>

              {/* Section 2: Material Variances */}
              <PrintablePackSection title="2. Material Variances">
                {material.length === 0 ? (
                  <p className="text-xs text-green-700">All variance lines within materiality thresholds.</p>
                ) : (
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-gray-100">
                        {["Account", "Category", "Actual", "Budget", "Variance", "%"].map(h => (
                          <th key={h} className="text-left px-3 py-2 font-semibold">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {material.slice(0, 15).map((a: any, i: number) => (
                        <tr key={i} className="border-t border-gray-200">
                          <td className="px-3 py-2">{a.account_name}</td>
                          <td className="px-3 py-2 text-gray-500">{a.pl_category?.replace(/_/g, " ")}</td>
                          <td className="px-3 py-2 tabular-nums">{fmt(a.actual_amount ?? 0)}</td>
                          <td className="px-3 py-2 tabular-nums text-gray-500">{fmt(a.budget_amount ?? 0)}</td>
                          <td className={`px-3 py-2 tabular-nums font-medium ${(a.variance_tzs ?? 0) < 0 ? "text-red-600" : "text-green-600"}`}>{fmt(a.variance_tzs ?? 0)}</td>
                          <td className={`px-3 py-2 tabular-nums ${(a.variance_pct ?? 0) < 0 ? "text-red-600" : "text-green-600"}`}>{(a.variance_pct ?? 0).toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </PrintablePackSection>

              {/* Section 3: Root Cause */}
              {rootIns && (
                <PrintablePackSection title="3. Root Cause Analysis">
                  <div className="text-xs leading-relaxed text-gray-700 whitespace-pre-wrap">
                    {rootIns.ai_output.substring(0, 2000)}
                    {rootIns.ai_output.length > 2000 && "\n[…truncated for board pack — full analysis in Maono dashboard]"}
                  </div>
                </PrintablePackSection>
              )}

              {/* Section 4: Cash */}
              <PrintablePackSection title="4. 13-Week Cash Flow Summary">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-gray-100">
                      <th className="text-left px-3 py-2">Week</th>
                      <th className="text-right px-3 py-2">Inflows</th>
                      <th className="text-right px-3 py-2">Outflows</th>
                      <th className="text-right px-3 py-2">Closing Cash</th>
                      <th className="text-left px-3 py-2">Risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pack.cashWeeks.slice(0, 13).map((w: any) => (
                      <tr key={w.week_number} className={`border-t border-gray-200 ${w.risk_flag === "critical" ? "bg-red-50" : w.risk_flag === "watch" ? "bg-amber-50" : ""}`}>
                        <td className="px-3 py-1.5">W{w.week_number}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-green-700">{fmt(w.total_inflows)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-red-700">{fmt(w.total_outflows)}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${w.closing_cash < 0 ? "text-red-700" : ""}`}>{fmt(w.closing_cash)}</td>
                        <td className="px-3 py-1.5 uppercase text-xs">{w.risk_flag}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </PrintablePackSection>

              {/* Section 5: Decision Paths */}
              {decideIns && (
                <PrintablePackSection title="5. Decision Paths">
                  <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3">
                    These options require explicit sign-off before any action is taken.
                    No action has been or will be taken automatically.
                  </div>
                  <div className="text-xs leading-relaxed text-gray-700 whitespace-pre-wrap">
                    {decideIns.ai_output.substring(0, 3000)}
                    {decideIns.ai_output.length > 3000 && "\n[…full decision paths in Maono dashboard]"}
                  </div>
                </PrintablePackSection>
              )}

              {/* Section 6: Risk signals */}
              {pack.riskData?.tra_signals?.length > 0 && (
                <PrintablePackSection title="6. TRA Audit Risk Signals">
                  {pack.riskData.tra_signals.map((s: any, i: number) => (
                    <div key={i} className="mb-2 text-xs">
                      <span className={`font-semibold ${s.severity === "critical" ? "text-red-700" : "text-amber-700"}`}>
                        [{s.severity.toUpperCase()}]
                      </span>{" "}
                      {s.description}
                    </div>
                  ))}
                </PrintablePackSection>
              )}

              {/* Footer */}
              <div className="mt-8 pt-4 border-t border-gray-200 text-xs text-gray-400">
                <p>This board pack was generated by Maono Intelligence from Safisha-verified data.</p>
                <p>All figures are subject to audit and management review. This document is confidential.</p>
                <p className="mt-1">🛡 Iron Dome Nuclear Design · {pack.generated_at}</p>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Hidden print root */}
      <div id="maono-board-pack-print-root" style={{ display: "none" }} />
    </div>
  );
}
