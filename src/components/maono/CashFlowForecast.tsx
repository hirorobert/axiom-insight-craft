/**
 * CashFlowForecast · Maono Intelligence Engine
 *
 * 13-week cash runway visualisation.
 * Data comes from cashflow_forecasts table via props.
 *
 * Visual design:
 *   - Bar chart: stacked inflows (green) / outflows (red) per week
 *   - Line overlay: closing cash balance
 *   - Risk flag weeks highlighted (watch=amber, critical=red)
 *   - Statutory payments shown as a separate section below chart
 *
 * Pure presentational — no Supabase calls here. Parent passes rows.
 */

import React, { useState } from "react";

export interface CashWeek {
  week_number:            number;
  forecast_week:          string;  // ISO date (Monday of week)
  opening_cash:           number;
  expected_ar_inflows:    number;
  expected_other_inflows: number;
  expected_ap_outflows:   number;
  expected_other_outflows:number;
  paye_due:               number;
  vat_due:                number;
  sdl_due:                number;
  wht_due:                number;
  other_statutory_due:    number;
  total_inflows:          number;
  total_outflows:         number;
  closing_cash:           number;
  risk_flag:              "ok" | "watch" | "critical";
  risk_reason?:           string;
  ar_confidence:          "actual" | "estimated" | "low";
}

interface CashFlowForecastProps {
  weeks:     CashWeek[];
  currency?: string;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000)         return `${(n / 1_000).toFixed(0)}K`;
  return n.toFixed(0);
}

function fmtFull(n: number): string {
  return `TZS ${Math.abs(n).toLocaleString()}`;
}

const RISK_COLORS = {
  ok:       "bg-green-50  border-green-200  text-green-700",
  watch:    "bg-amber-50  border-amber-200  text-amber-700",
  critical: "bg-red-50    border-red-200    text-red-700",
};

const CONF_LABEL = {
  actual:    "Actual receipts",
  estimated: "Estimated (collection model)",
  low:       "Low confidence (< 3 periods data)",
};

export function CashFlowForecast({ weeks, currency = "TZS" }: CashFlowForecastProps) {
  const [selectedWeek, setSelectedWeek] = useState<CashWeek | null>(null);
  const [showStatutory, setShowStatutory] = useState(false);

  if (!weeks || weeks.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-6 text-sm text-gray-500 text-center">
        Cash flow forecast not available. Run maono-cashflow to generate.
      </div>
    );
  }

  const maxAbsValue = Math.max(
    ...weeks.map(w => Math.max(w.total_inflows, w.total_outflows, Math.abs(w.closing_cash)))
  );

  const barHeight = 120; // px max bar height
  const barWidth  = `${Math.floor(100 / weeks.length)}%`;

  function barPx(value: number): number {
    if (maxAbsValue === 0) return 0;
    return Math.round((Math.abs(value) / maxAbsValue) * barHeight);
  }

  const criticalWeeks = weeks.filter(w => w.risk_flag === "critical");
  const watchWeeks    = weeks.filter(w => w.risk_flag === "watch");

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">13-Week Cash Flow Forecast</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Deterministic model — AR aging × collection rates + Tanzania statutory calendar
          </p>
        </div>
        <div className="flex gap-2">
          {criticalWeeks.length > 0 && (
            <span className="text-xs bg-red-100 text-red-700 rounded-full px-2.5 py-1 font-medium">
              {criticalWeeks.length} critical week{criticalWeeks.length > 1 ? "s" : ""}
            </span>
          )}
          {watchWeeks.length > 0 && (
            <span className="text-xs bg-amber-100 text-amber-700 rounded-full px-2.5 py-1 font-medium">
              {watchWeeks.length} watch
            </span>
          )}
        </div>
      </div>

      {/* Chart */}
      <div className="px-5 pt-4 pb-2">
        <div className="flex items-end gap-0.5" style={{ height: `${barHeight + 32}px` }}>
          {weeks.map(week => {
            const inH  = barPx(week.total_inflows);
            const outH = barPx(week.total_outflows);
            const riskBg =
              week.risk_flag === "critical" ? "bg-red-100"
              : week.risk_flag === "watch"  ? "bg-amber-100"
              : "";
            const isSelected = selectedWeek?.week_number === week.week_number;

            return (
              <div
                key={week.week_number}
                className={`flex-1 flex flex-col items-center cursor-pointer group ${riskBg} rounded-sm transition-all`}
                onClick={() => setSelectedWeek(isSelected ? null : week)}
              >
                {/* Bars */}
                <div className="w-full flex items-end justify-center gap-px" style={{ height: `${barHeight}px` }}>
                  <div
                    className="flex-1 bg-green-400 group-hover:bg-green-500 rounded-t-sm transition-colors"
                    style={{ height: `${inH}px` }}
                    title={`Inflows: ${fmtFull(week.total_inflows)}`}
                  />
                  <div
                    className="flex-1 bg-red-400 group-hover:bg-red-500 rounded-t-sm transition-colors"
                    style={{ height: `${outH}px` }}
                    title={`Outflows: ${fmtFull(week.total_outflows)}`}
                  />
                </div>

                {/* Week label */}
                <div className={`text-xs mt-1 font-medium transition-colors ${
                  isSelected ? "text-indigo-700" : "text-gray-500"
                }`}>
                  W{week.week_number}
                </div>
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex gap-4 mt-2 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="h-2 w-3 rounded-sm bg-green-400 inline-block" /> Inflows
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-3 rounded-sm bg-red-400 inline-block" /> Outflows
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-3 rounded-sm bg-amber-200 inline-block" /> Watch
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-3 rounded-sm bg-red-100 inline-block" /> Critical
          </span>
        </div>
      </div>

      {/* Closing cash strip */}
      <div className="px-5 py-2 bg-gray-50 border-t border-gray-100 overflow-x-auto">
        <div className="flex gap-0.5 min-w-0">
          {weeks.map(week => (
            <div
              key={week.week_number}
              className="flex-1 text-center"
              style={{ minWidth: "40px" }}
            >
              <div className={`text-xs font-medium ${
                week.closing_cash < 0  ? "text-red-700"
                : week.risk_flag === "critical" ? "text-red-600"
                : week.risk_flag === "watch"    ? "text-amber-700"
                : "text-gray-700"
              }`}>
                {fmt(week.closing_cash)}
              </div>
            </div>
          ))}
        </div>
        <div className="text-xs text-gray-400 mt-0.5 text-center">Closing cash ({currency})</div>
      </div>

      {/* Selected week detail */}
      {selectedWeek && (
        <div className={`mx-4 my-3 rounded-lg border p-4 ${RISK_COLORS[selectedWeek.risk_flag]}`}>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold">
              Week {selectedWeek.week_number} — {new Date(selectedWeek.forecast_week).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
            </span>
            {selectedWeek.risk_reason && (
              <span className="text-xs italic">{selectedWeek.risk_reason}</span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-gray-600">Opening cash</span>
              <span className="font-medium">{fmtFull(selectedWeek.opening_cash)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">AR inflows</span>
              <span className="font-medium text-green-700">{fmtFull(selectedWeek.expected_ar_inflows)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">AP outflows</span>
              <span className="font-medium text-red-700">{fmtFull(selectedWeek.expected_ap_outflows)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Other inflows</span>
              <span className="font-medium text-green-700">{fmtFull(selectedWeek.expected_other_inflows)}</span>
            </div>

            {/* Statutory line items */}
            {selectedWeek.paye_due > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-600">PAYE due</span>
                <span className="font-medium text-red-700">{fmtFull(selectedWeek.paye_due)}</span>
              </div>
            )}
            {selectedWeek.vat_due > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-600">VAT due</span>
                <span className="font-medium text-red-700">{fmtFull(selectedWeek.vat_due)}</span>
              </div>
            )}
            {selectedWeek.sdl_due > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-600">SDL due</span>
                <span className="font-medium text-red-700">{fmtFull(selectedWeek.sdl_due)}</span>
              </div>
            )}
            {selectedWeek.wht_due > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-600">WHT due</span>
                <span className="font-medium text-red-700">{fmtFull(selectedWeek.wht_due)}</span>
              </div>
            )}

            <div className="col-span-2 border-t border-current/20 pt-1.5 flex justify-between font-semibold">
              <span>Closing cash</span>
              <span className={selectedWeek.closing_cash < 0 ? "text-red-800" : ""}>{fmtFull(selectedWeek.closing_cash)}</span>
            </div>
          </div>

          <div className="mt-2 text-xs opacity-70">
            AR confidence: {CONF_LABEL[selectedWeek.ar_confidence]}
          </div>
        </div>
      )}

      {/* Statutory summary toggle */}
      <div className="px-5 pb-4 pt-1">
        <button
          className="text-xs text-indigo-600 hover:text-indigo-800 underline"
          onClick={() => setShowStatutory(s => !s)}
        >
          {showStatutory ? "Hide" : "Show"} statutory payment schedule
        </button>

        {showStatutory && (
          <div className="mt-3 rounded-md bg-gray-50 border border-gray-200 overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-gray-100">
                <tr>
                  {["Week", "PAYE", "VAT", "SDL", "WHT", "Total Statutory"].map(h => (
                    <th key={h} className="px-3 py-2 text-left text-gray-600 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weeks.map((w, i) => {
                  const total = w.paye_due + w.vat_due + w.sdl_due + w.wht_due + w.other_statutory_due;
                  if (total === 0) return null;
                  return (
                    <tr key={w.week_number} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                      <td className="px-3 py-1.5 text-gray-700">W{w.week_number}</td>
                      <td className="px-3 py-1.5 text-gray-700">{w.paye_due > 0 ? fmt(w.paye_due) : "—"}</td>
                      <td className="px-3 py-1.5 text-gray-700">{w.vat_due  > 0 ? fmt(w.vat_due)  : "—"}</td>
                      <td className="px-3 py-1.5 text-gray-700">{w.sdl_due  > 0 ? fmt(w.sdl_due)  : "—"}</td>
                      <td className="px-3 py-1.5 text-gray-700">{w.wht_due  > 0 ? fmt(w.wht_due)  : "—"}</td>
                      <td className="px-3 py-1.5 font-medium text-red-700">{fmt(total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
