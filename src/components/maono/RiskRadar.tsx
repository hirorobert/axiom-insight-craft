/**
 * RiskRadar · Maono Intelligence Engine
 *
 * Visual risk summary: TRA audit signals + trend patterns.
 * No SVG radar chart (requires d3 — overkill). Instead: severity matrix + signal list.
 *
 * Pure presentational. Parent passes parsed risk insight JSON.
 */

import React, { useState } from "react";

export interface TRASignal {
  key:         string;
  description: string;
  severity:    "info" | "warn" | "critical";
}

export interface TrendResult {
  pl_category:          string;
  current_variance_pct: number;
  z_score:              number | null;
  periods_analysed:     number;
  pattern:              "one_off" | "trend" | "worsening" | "unknown";
  description:          string;
  skipped?:             boolean;
  reason?:              string;
}

export interface RiskSummary {
  overall_risk:     "HIGH" | "MEDIUM" | "LOW";
  signal_count:     number;
  critical_signals: number;
  worsening_trends: number;
}

export interface RiskData {
  tra_signals:      TRASignal[];
  trend_analysis:   TrendResult[];
  trend_confidence: string;
  summary:          RiskSummary;
}

interface RiskRadarProps {
  riskData:       RiskData | null;
  isLoading?:     boolean;
}

const SEVERITY_STYLE = {
  critical: { bar: "bg-red-500",    badge: "bg-red-100 text-red-700",    icon: "🔴" },
  warn:     { bar: "bg-amber-500",  badge: "bg-amber-100 text-amber-700",icon: "🟡" },
  info:     { bar: "bg-blue-500",   badge: "bg-blue-100 text-blue-700",  icon: "🔵" },
};

const PATTERN_STYLE = {
  worsening: { badge: "bg-red-100 text-red-700",    icon: "↘" },
  trend:     { badge: "bg-amber-100 text-amber-700",icon: "→" },
  one_off:   { badge: "bg-green-100 text-green-700",icon: "•" },
  unknown:   { badge: "bg-gray-100 text-gray-600",  icon: "?" },
};

const OVERALL_RISK_STYLE = {
  HIGH:   "bg-red-600   text-white",
  MEDIUM: "bg-amber-500 text-white",
  LOW:    "bg-green-600 text-white",
};

export function RiskRadar({ riskData, isLoading }: RiskRadarProps) {
  const [activeTab, setActiveTab] = useState<"signals" | "trends">("signals");

  if (isLoading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white shadow-sm p-6 text-center">
        <div className="text-sm text-gray-400 animate-pulse">Analysing risk signals…</div>
      </div>
    );
  }

  if (!riskData) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-6 text-center text-sm text-gray-500">
        Risk analysis not yet available. Run maono-risk to generate.
      </div>
    );
  }

  const { tra_signals, trend_analysis, summary, trend_confidence } = riskData;
  const realTrends = trend_analysis.filter(t => !t.skipped);
  const trendsSkipped = trend_analysis.some(t => t.skipped);

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
      {/* Header strip */}
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Risk Radar</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Statistical + TRA compliance signals
          </p>
        </div>
        <div className={`rounded-full px-3 py-1 text-sm font-semibold ${OVERALL_RISK_STYLE[summary.overall_risk]}`}>
          {summary.overall_risk} RISK
        </div>
      </div>

      {/* Summary chips */}
      <div className="px-5 py-3 flex gap-3 flex-wrap border-b border-gray-100 bg-gray-50">
        <div className="text-center">
          <div className="text-xl font-bold text-red-600">{summary.critical_signals}</div>
          <div className="text-xs text-gray-500">Critical signals</div>
        </div>
        <div className="w-px bg-gray-200" />
        <div className="text-center">
          <div className="text-xl font-bold text-amber-600">{summary.signal_count - summary.critical_signals}</div>
          <div className="text-xs text-gray-500">Warnings</div>
        </div>
        <div className="w-px bg-gray-200" />
        <div className="text-center">
          <div className="text-xl font-bold text-red-500">{summary.worsening_trends}</div>
          <div className="text-xs text-gray-500">Worsening trends</div>
        </div>
        <div className="w-px bg-gray-200" />
        <div className="text-center">
          <div className="text-xl font-bold text-gray-700">{trend_confidence}</div>
          <div className="text-xs text-gray-500">Trend confidence</div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-100">
        {(["signals", "trends"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
              activeTab === tab
                ? "text-indigo-700 border-b-2 border-indigo-600 bg-indigo-50"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab === "signals" ? `TRA Signals (${tra_signals.length})` : `Trends (${realTrends.length})`}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-4">
        {activeTab === "signals" && (
          <>
            {tra_signals.length === 0 ? (
              <div className="text-sm text-green-700 bg-green-50 rounded-lg p-4 text-center">
                ✓ No TRA audit risk signals detected for this period.
              </div>
            ) : (
              <div className="space-y-3">
                {tra_signals.map(sig => {
                  const s = SEVERITY_STYLE[sig.severity];
                  return (
                    <div key={sig.key} className="rounded-lg border border-gray-200 overflow-hidden">
                      <div className={`flex items-center gap-2 px-3 py-2 ${
                        sig.severity === "critical" ? "bg-red-50" : sig.severity === "warn" ? "bg-amber-50" : "bg-blue-50"
                      }`}>
                        <span>{s.icon}</span>
                        <span className={`text-xs font-semibold rounded px-1.5 py-0.5 ${s.badge}`}>
                          {sig.severity.toUpperCase()}
                        </span>
                        <span className="text-xs text-gray-600 font-mono">{sig.key}</span>
                      </div>
                      <div className="px-3 py-2.5 text-xs text-gray-700 leading-relaxed">
                        {sig.description}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {activeTab === "trends" && (
          <>
            {trendsSkipped && (
              <div className="mb-3 rounded-lg bg-gray-50 border border-gray-200 p-3 text-xs text-gray-600">
                <strong>Trend analysis not available:</strong> This company has fewer than 2 periods
                of historical data. Statistical trend detection requires at least 2 complete periods.
                TRA signals above still apply.
              </div>
            )}

            {realTrends.length === 0 && !trendsSkipped && (
              <div className="text-sm text-green-700 bg-green-50 rounded-lg p-4 text-center">
                ✓ No statistical trend anomalies detected.
              </div>
            )}

            {realTrends.length > 0 && (
              <div className="space-y-2">
                {realTrends.map((t, i) => {
                  const p = PATTERN_STYLE[t.pattern];
                  return (
                    <div key={i} className="flex items-start gap-3 rounded-lg border border-gray-200 p-3">
                      <span className="text-lg font-mono leading-none mt-0.5">{p.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-gray-800">
                            {t.pl_category.replace(/_/g, " ")}
                          </span>
                          <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${p.badge}`}>
                            {t.pattern.replace(/_/g, " ")}
                          </span>
                          {t.z_score !== null && (
                            <span className="text-xs text-gray-400">
                              Z = {t.z_score.toFixed(2)} ({t.periods_analysed} periods)
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-600 leading-relaxed">{t.description}</p>
                        {t.current_variance_pct != null && (
                          <div className="mt-1.5 flex items-center gap-1">
                            <span className="text-xs text-gray-500">Current variance:</span>
                            <span className={`text-xs font-medium ${
                              t.current_variance_pct < 0 ? "text-red-600" : "text-green-600"
                            }`}>
                              {t.current_variance_pct > 0 ? "+" : ""}{t.current_variance_pct.toFixed(1)}%
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
