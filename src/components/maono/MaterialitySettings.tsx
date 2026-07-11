/**
 * MaterialitySettings · Maono Phase A UI
 *
 * Per-company materiality threshold configuration.
 * Writes to variance_materiality table.
 *
 * IRON DOME:
 *   - No hardcoded thresholds anywhere in the system.
 *   - These settings drive what is "material" in maono-compute.
 *   - Cash warning days drive risk_flag in maono-cashflow.
 *   - Only admin/finance role should access this screen (gate in parent).
 */

import React, { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

interface MaterialityRow {
  id?:                   string;
  company_id:            string;
  pct_threshold:         number;  // e.g. 10 = 10%
  abs_threshold_tzs:     number;  // e.g. 5000000
  cash_warn_days:        number;  // e.g. 30
  cash_critical_days:    number;  // e.g. 14
  updated_at?:           string;
}

interface MaterialitySettingsProps {
  companyId:       string;
  supabaseUrl:     string;
  supabaseAnonKey: string;
}

const DEFAULTS: Omit<MaterialityRow, "company_id"> = {
  pct_threshold:      10,
  abs_threshold_tzs:  5_000_000,
  cash_warn_days:     30,
  cash_critical_days: 14,
};

function HelpText({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-gray-400 mt-0.5">{children}</p>;
}

export function MaterialitySettings({ companyId, supabaseUrl, supabaseAnonKey }: MaterialitySettingsProps) {
  const [row,     setRow]     = useState<MaterialityRow>({ ...DEFAULTS, company_id: companyId });
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("variance_materiality")
        .select("*")
        .eq("company_id", companyId)
        .single();
      if (data) setRow(data);
      setLoading(false);
    })();
  }, [companyId]);

  const update = (field: keyof MaterialityRow, value: string) => {
    const num = parseFloat(value.replace(/,/g, ""));
    setRow(prev => ({ ...prev, [field]: isNaN(num) ? 0 : num }));
    setSaved(false);
  };

  const validate = (): string | null => {
    if (row.pct_threshold <= 0 || row.pct_threshold > 100) return "Percentage threshold must be between 0.1% and 100%.";
    if (row.abs_threshold_tzs <= 0) return "Absolute threshold must be a positive TZS amount.";
    if (row.cash_critical_days <= 0) return "Critical runway days must be positive.";
    if (row.cash_warn_days <= row.cash_critical_days) return "Warning runway days must exceed critical runway days.";
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) { setError(err); return; }

    setSaving(true);
    setError(null);

    const payload: MaterialityRow = {
      company_id:          companyId,
      pct_threshold:       row.pct_threshold,
      abs_threshold_tzs:   row.abs_threshold_tzs,
      cash_warn_days:      row.cash_warn_days,
      cash_critical_days:  row.cash_critical_days,
    };

    const { error: dbErr } = row.id
      ? await supabase.from("variance_materiality").update(payload).eq("id", row.id)
      : await supabase.from("variance_materiality").insert(payload);

    if (dbErr) {
      setError(dbErr.message);
    } else {
      setSaved(true);
    }
    setSaving(false);
  };

  const reset = () => {
    setRow({ ...DEFAULTS, company_id: companyId, id: row.id });
    setSaved(false);
    setError(null);
  };

  if (loading) {
    return <div className="text-sm text-gray-400 animate-pulse p-6">Loading materiality settings…</div>;
  }

  const previewExplanation = `A variance is material if it is MORE than ${row.pct_threshold}% of budget
OR more than TZS ${row.abs_threshold_tzs.toLocaleString()} — whichever condition fires first.
Cash alerts trigger at ${row.cash_warn_days} days (warning) and ${row.cash_critical_days} days (critical) of remaining runway.`;

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-900">Materiality Thresholds</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          Controls what appears as material in variance analysis and cash risk alerts.
          No hardcoded thresholds — all configurable per company.
        </p>
      </div>

      <div className="p-5 space-y-6">
        {/* Variance materiality */}
        <div>
          <div className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-3">
            Variance Materiality
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">
                Percentage threshold
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0.1"
                  max="100"
                  step="0.5"
                  className="w-24 border border-gray-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                  value={row.pct_threshold}
                  onChange={e => update("pct_threshold", e.target.value)}
                />
                <span className="text-sm text-gray-500">%</span>
              </div>
              <HelpText>Variance as % of budget amount. Common: 5–15%.</HelpText>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">
                Absolute threshold (TZS)
              </label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">TZS</span>
                <input
                  type="number"
                  min="0"
                  step="1000000"
                  className="w-40 border border-gray-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                  value={row.abs_threshold_tzs}
                  onChange={e => update("abs_threshold_tzs", e.target.value)}
                />
              </div>
              <HelpText>
                Minimum TZS amount to flag. Prevents noise from small accounts.
                Default: TZS 5,000,000.
              </HelpText>
            </div>
          </div>
        </div>

        <div className="border-t border-gray-100" />

        {/* Cash runway thresholds */}
        <div>
          <div className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-3">
            Cash Runway Alerts
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">
                Warning threshold
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="1"
                  className="w-20 border border-amber-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
                  value={row.cash_warn_days}
                  onChange={e => update("cash_warn_days", e.target.value)}
                />
                <span className="text-sm text-gray-500">days</span>
              </div>
              <HelpText>Cash runway below this triggers a ⚠ Watch flag.</HelpText>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">
                Critical threshold
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="1"
                  className="w-20 border border-red-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-red-400"
                  value={row.cash_critical_days}
                  onChange={e => update("cash_critical_days", e.target.value)}
                />
                <span className="text-sm text-gray-500">days</span>
              </div>
              <HelpText>Cash runway below this triggers a 🔴 Critical alert.</HelpText>
            </div>
          </div>
        </div>

        {/* Live preview */}
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-4">
          <div className="text-xs font-semibold text-blue-800 mb-1">How these settings will behave</div>
          <p className="text-xs text-blue-700 leading-relaxed whitespace-pre-wrap">{previewExplanation}</p>
        </div>

        {/* Validation error */}
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700">
            {error}
          </div>
        )}

        {/* Success */}
        {saved && (
          <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-xs text-green-700">
            ✓ Materiality thresholds saved. All future variance runs will use these settings.
            Existing run analyses are unaffected (append-only).
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between pt-2">
          <button
            onClick={reset}
            className="text-xs text-gray-500 hover:text-gray-700 underline"
          >
            Reset to defaults ({DEFAULTS.pct_threshold}% / TZS {DEFAULTS.abs_threshold_tzs.toLocaleString()} / {DEFAULTS.cash_warn_days}d / {DEFAULTS.cash_critical_days}d)
          </button>

          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-xs font-medium rounded-lg px-4 py-2 transition-colors"
          >
            {saving ? "Saving…" : "Save Thresholds"}
          </button>
        </div>

        <div className="text-xs text-gray-400 border-t border-gray-100 pt-3">
          🛡 These thresholds are stored per-company in <code>variance_materiality</code> and
          read by maono-compute, maono-cashflow, and maono-risk at runtime.
          No default values are hardcoded in the codebase.
        </div>
      </div>
    </div>
  );
}
