/**
 * AlertCenter · Maono Phase C
 *
 * Alert management UI. Shows all unacknowledged + recently acknowledged alerts
 * across the company. Written by maono-monitor (scheduled) and maono-risk (per-run).
 *
 * IRON DOME:
 *   - Alerts are append-only. Acknowledgment is the ONLY allowed update.
 *   - Acknowledged alerts remain visible (audit trail). Permanent delete: NEVER.
 *   - "Fix" buttons open the relevant section — they do NOT auto-execute anything.
 *   - Showing to all roles. CFO/Director see critical only by default.
 */

import React, { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

interface Alert {
  id:                  string;
  run_id?:             string;
  alert_type:          string;
  severity:            "info" | "warn" | "critical";
  pl_categories?:      string[];
  account_codes?:      string[];
  message:             string;
  detail?:             string;
  created_at:          string;
  acknowledged_at?:    string;
  acknowledged_by?:    string;
  acknowledgment_note?:string;
}

interface AlertCenterProps {
  companyId:       string;
  userRole:        "cfo" | "director" | "manager" | "accountant" | "business";
  supabaseUrl:     string;
  supabaseAnonKey: string;
  onNavigate?:     (section: string, runId?: string) => void;
}

const SEVERITY_CONFIG = {
  critical: {
    bg:     "bg-red-50",
    border: "border-red-300",
    badge:  "bg-red-600 text-white",
    icon:   "🔴",
    text:   "text-red-900",
  },
  warn: {
    bg:     "bg-amber-50",
    border: "border-amber-300",
    badge:  "bg-amber-500 text-white",
    icon:   "🟡",
    text:   "text-amber-900",
  },
  info: {
    bg:     "bg-blue-50",
    border: "border-blue-200",
    badge:  "bg-blue-500 text-white",
    icon:   "🔵",
    text:   "text-blue-900",
  },
};

const ALERT_TYPE_LABELS: Record<string, string> = {
  variance_threshold: "Variance Threshold",
  cash_critical:      "Cash Critical",
  cash_watch:         "Cash Watch",
  tra_risk_signal:    "TRA Audit Risk",
  budget_missing:     "Budget Missing",
  trend_deterioration:"Trend Deterioration",
};

const ALERT_TYPE_ACTION: Record<string, string> = {
  variance_threshold: "View variance analysis",
  cash_critical:      "View cash forecast",
  cash_watch:         "View cash forecast",
  tra_risk_signal:    "Consult tax advisor",
  budget_missing:     "Submit budget",
  trend_deterioration:"View risk radar",
};

function AckModal({
  alert,
  onConfirm,
  onCancel,
}: {
  alert: Alert;
  onConfirm: (note: string) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Acknowledge Alert</h3>
        <p className="text-xs text-gray-600 mb-4">
          You are acknowledging: <em>"{alert.message.substring(0, 80)}…"</em>
        </p>
        <label className="text-xs font-medium text-gray-600 block mb-1">
          Note (required — explain what action was taken or why it's acknowledged)
        </label>
        <textarea
          className="w-full border border-gray-200 rounded px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400 resize-none"
          rows={3}
          placeholder="e.g. 'Investigated and confirmed as seasonal. Revenue expected to recover in Q3.' or 'Tax advisor consulted — remediation plan in progress.'"
          value={note}
          onChange={e => setNote(e.target.value)}
          autoFocus
        />
        <div className="mt-4 flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="text-xs text-gray-500 hover:text-gray-700 px-3 py-1.5 rounded border border-gray-200"
          >
            Cancel
          </button>
          <button
            onClick={() => { if (note.trim().length >= 10) onConfirm(note); }}
            disabled={note.trim().length < 10}
            className="text-xs bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white px-4 py-1.5 rounded-lg"
          >
            Acknowledge
          </button>
        </div>
        {note.trim().length > 0 && note.trim().length < 10 && (
          <p className="text-xs text-red-500 mt-1">Note must be at least 10 characters.</p>
        )}
      </div>
    </div>
  );
}

export function AlertCenter({
  companyId,
  userRole,
  supabaseUrl,
  supabaseAnonKey,
  onNavigate,
}: AlertCenterProps) {
  const [alerts,     setAlerts]     = useState<Alert[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [filter,     setFilter]     = useState<"unacked" | "all">("unacked");
  const [severityF,  setSeverityF]  = useState<"all" | "critical" | "warn" | "info">("all");
  const [ackTarget,  setAckTarget]  = useState<Alert | null>(null);
  const [acking,     setAcking]     = useState<string | null>(null);

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  const loadAlerts = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from("variance_alerts")
      .select("id, run_id, alert_type, severity, pl_categories, account_codes, message, detail, created_at, acknowledged_at, acknowledged_by, acknowledgment_note")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(100);

    if (filter === "unacked") query = query.is("acknowledged_at", null);

    // CFO/Director default: critical only in unacked view
    if ((userRole === "cfo" || userRole === "director") && filter === "unacked") {
      query = query.in("severity", ["critical", "warn"]);
    }

    const { data } = await query;
    setAlerts(data ?? []);
    setLoading(false);
  }, [companyId, filter, userRole]);

  useEffect(() => { loadAlerts(); }, [loadAlerts]);

  const handleAcknowledge = async (alert: Alert, note: string) => {
    setAcking(alert.id);
    const { data: { user } } = await supabase.auth.getUser();

    const { error } = await supabase
      .from("variance_alerts")
      .update({
        acknowledged_by:   user?.id,
        acknowledged_at:   new Date().toISOString(),
        acknowledgment_note: note,
      })
      .eq("id", alert.id);

    if (!error) {
      setAlerts(prev => prev.map(a =>
        a.id === alert.id
          ? { ...a, acknowledged_at: new Date().toISOString(), acknowledgment_note: note }
          : a
      ));
    }
    setAcking(null);
    setAckTarget(null);
  };

  const displayedAlerts = alerts.filter(a => {
    if (severityF !== "all" && a.severity !== severityF) return false;
    return true;
  });

  const critCount  = alerts.filter(a => a.severity === "critical" && !a.acknowledged_at).length;
  const warnCount  = alerts.filter(a => a.severity === "warn"     && !a.acknowledged_at).length;
  const totalUnack = alerts.filter(a => !a.acknowledged_at).length;

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Alert Center</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Monitor-generated alerts. Acknowledgment required — alerts are never auto-resolved.
            </p>
          </div>
          <button
            onClick={loadAlerts}
            className="text-xs text-gray-400 hover:text-gray-700 transition-colors"
            title="Refresh alerts"
          >
            ↻
          </button>
        </div>

        {/* Summary chips */}
        <div className="flex gap-3">
          <div className="flex items-center gap-1.5 rounded-full bg-red-100 text-red-700 px-3 py-1 text-xs font-semibold">
            🔴 {critCount} critical
          </div>
          <div className="flex items-center gap-1.5 rounded-full bg-amber-100 text-amber-700 px-3 py-1 text-xs font-semibold">
            🟡 {warnCount} warnings
          </div>
          <div className="text-xs text-gray-400 flex items-center">
            {totalUnack} unacknowledged
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="px-5 py-2 border-b border-gray-100 flex gap-4 flex-wrap bg-gray-50">
        <div className="flex gap-1">
          {(["unacked", "all"] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-xs rounded-full px-3 py-1 font-medium transition-colors ${
                filter === f
                  ? "bg-indigo-600 text-white"
                  : "bg-white border border-gray-200 text-gray-600 hover:border-indigo-300"
              }`}
            >
              {f === "unacked" ? "Unacknowledged" : "All"}
            </button>
          ))}
        </div>

        <div className="flex gap-1">
          {(["all", "critical", "warn", "info"] as const).map(s => (
            <button
              key={s}
              onClick={() => setSeverityF(s)}
              className={`text-xs rounded-full px-2.5 py-1 font-medium transition-colors ${
                severityF === s
                  ? "bg-gray-700 text-white"
                  : "bg-white border border-gray-200 text-gray-600 hover:border-gray-400"
              }`}
            >
              {s === "all" ? "All severity" : s}
            </button>
          ))}
        </div>
      </div>

      {/* Alert list */}
      <div className="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
        {loading ? (
          <div className="p-6 text-center text-sm text-gray-400 animate-pulse">Loading alerts…</div>
        ) : displayedAlerts.length === 0 ? (
          <div className="p-6 text-center">
            <div className="text-2xl mb-2">✓</div>
            <p className="text-sm text-gray-600">
              {filter === "unacked" ? "No unacknowledged alerts." : "No alerts found."}
            </p>
          </div>
        ) : (
          displayedAlerts.map(alert => {
            const s   = SEVERITY_CONFIG[alert.severity];
            const isAcked = !!alert.acknowledged_at;

            return (
              <div
                key={alert.id}
                className={`p-4 ${isAcked ? "opacity-60" : ""}`}
              >
                <div className={`rounded-lg border ${s.border} ${s.bg} p-3`}>
                  <div className="flex items-start gap-3">
                    <span className="text-base leading-none mt-0.5 flex-shrink-0">{s.icon}</span>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className={`text-xs font-semibold rounded-full px-2 py-0.5 ${s.badge}`}>
                          {alert.severity.toUpperCase()}
                        </span>
                        <span className="text-xs text-gray-600 font-medium">
                          {ALERT_TYPE_LABELS[alert.alert_type] ?? alert.alert_type}
                        </span>
                        <span className="text-xs text-gray-400">
                          {new Date(alert.created_at).toLocaleDateString("en-GB", {
                            day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
                          })}
                        </span>
                        {alert.pl_categories?.slice(0, 2).map(cat => (
                          <span key={cat} className="text-xs bg-gray-200 text-gray-700 rounded px-1.5 py-0.5">
                            {cat.replace(/_/g, " ")}
                          </span>
                        ))}
                      </div>

                      <p className={`text-xs font-medium leading-relaxed ${s.text}`}>
                        {alert.message}
                      </p>

                      {alert.detail && (
                        <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                          {alert.detail}
                        </p>
                      )}

                      {isAcked && alert.acknowledgment_note && (
                        <div className="mt-2 rounded-md bg-green-50 border border-green-200 px-2.5 py-1.5 text-xs text-green-700">
                          <strong>Acknowledged:</strong> {alert.acknowledgment_note}
                          <span className="text-green-500 ml-1">
                            ({new Date(alert.acknowledged_at!).toLocaleDateString("en-GB", { day: "numeric", month: "short" })})
                          </span>
                        </div>
                      )}

                      <div className="flex items-center gap-3 mt-2">
                        {!isAcked && (
                          <>
                            <button
                              onClick={() => setAckTarget(alert)}
                              disabled={acking === alert.id}
                              className="text-xs text-indigo-600 hover:text-indigo-900 font-medium underline transition-colors"
                            >
                              {acking === alert.id ? "Acknowledging…" : "Acknowledge"}
                            </button>

                            {ALERT_TYPE_ACTION[alert.alert_type] && onNavigate && (
                              <button
                                onClick={() => {
                                  const section =
                                    alert.alert_type === "cash_critical" || alert.alert_type === "cash_watch"
                                      ? "cashflow"
                                      : alert.alert_type === "budget_missing"
                                      ? "budget"
                                      : alert.alert_type === "tra_risk_signal"
                                      ? "risk"
                                      : "variance";
                                  onNavigate(section, alert.run_id);
                                }}
                                className="text-xs text-gray-500 hover:text-gray-900 underline transition-colors"
                              >
                                {ALERT_TYPE_ACTION[alert.alert_type]} →
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Iron dome footer */}
      <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 text-xs text-gray-400 flex items-center gap-2">
        <span>🛡</span>
        <span>
          Alerts are append-only. Acknowledgment is logged permanently for audit.
          Acknowledging an alert does not resolve the underlying issue.
        </span>
      </div>

      {/* Ack modal */}
      {ackTarget && (
        <AckModal
          alert={ackTarget}
          onConfirm={note => handleAcknowledge(ackTarget, note)}
          onCancel={() => setAckTarget(null)}
        />
      )}
    </div>
  );
}
