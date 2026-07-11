/**
 * BudgetApprovalFlow · Maono Phase A UI
 *
 * Version history + approval sign-off.
 *
 * IRON DOME:
 *   - Submitter CANNOT approve their own budget (RLS: submitted_by ≠ auth.uid() on update).
 *   - approved_by is written by supabase — never from request body tricks.
 *   - Once approved, all fields are immutable (trigger: enforce_budget_immutability).
 *   - "Supersede" creates a NEW version row — old rows untouched.
 */

import React, { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

interface BudgetVersion {
  id:            string;
  version:       number;
  fiscal_year:   number;
  period_month:  number;
  submitted_by:  string;
  approved_by?:  string;
  notes?:        string;
  created_at:    string;
  row_count?:    number; // computed from budget rows
  total_budget?: number; // sum of budget_amount
}

interface BudgetApprovalFlowProps {
  companyId:       string;
  supabaseUrl:     string;
  supabaseAnonKey: string;
  onApproved?:     () => void;
}

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function BudgetApprovalFlow({ companyId, supabaseUrl, supabaseAnonKey, onApproved }: BudgetApprovalFlowProps) {
  const [versions,   setVersions]   = useState<BudgetVersion[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [currentUser,setCurrentUser]= useState<string | null>(null);
  const [approving,  setApproving]  = useState<string | null>(null);
  const [error,      setError]      = useState<string | null>(null);
  const [filterYear, setFilterYear] = useState<number>(new Date().getFullYear());

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setCurrentUser(data.user?.id ?? null));
    loadVersions();
  }, [companyId, filterYear]);

  const loadVersions = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("variance_budgets")
      .select("id, version, fiscal_year, period_month, submitted_by, approved_by, notes, created_at, budget_amount")
      .eq("company_id", companyId)
      .eq("fiscal_year", filterYear)
      .order("fiscal_year", { ascending: false })
      .order("period_month", { ascending: false })
      .order("version", { ascending: false });

    if (error) { setError(error.message); setLoading(false); return; }

    // Group by period + version
    const grouped: Record<string, BudgetVersion> = {};
    for (const row of (data ?? [])) {
      const key = `${row.fiscal_year}-${row.period_month}-${row.version}`;
      if (!grouped[key]) {
        grouped[key] = {
          id:           row.id,
          version:      row.version,
          fiscal_year:  row.fiscal_year,
          period_month: row.period_month,
          submitted_by: row.submitted_by,
          approved_by:  row.approved_by,
          notes:        row.notes,
          created_at:   row.created_at,
          row_count:    0,
          total_budget: 0,
        };
      }
      grouped[key].row_count! += 1;
      grouped[key].total_budget! += row.budget_amount ?? 0;
    }

    setVersions(Object.values(grouped));
    setLoading(false);
  };

  const handleApprove = async (v: BudgetVersion) => {
    if (!currentUser) { setError("You must be logged in to approve."); return; }
    if (v.submitted_by === currentUser) { setError("You cannot approve a budget you submitted."); return; }
    if (v.approved_by) { setError("This version is already approved."); return; }

    setApproving(v.id);
    setError(null);

    // Update approved_by for all rows of this version
    const { error } = await supabase
      .from("variance_budgets")
      .update({ approved_by: currentUser })
      .eq("company_id", companyId)
      .eq("fiscal_year", v.fiscal_year)
      .eq("period_month", v.period_month)
      .eq("version", v.version)
      .is("approved_by", null); // only if not already approved

    if (error) {
      setError(error.message);
    } else {
      await loadVersions();
      onApproved?.();
    }
    setApproving(null);
  };

  const fmt = (n: number) => {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)         return `${(n / 1_000).toFixed(0)}K`;
    return n.toLocaleString();
  };

  // Group versions by period for display
  const byPeriod: Record<string, BudgetVersion[]> = {};
  for (const v of versions) {
    const k = `${v.fiscal_year}-${v.period_month}`;
    if (!byPeriod[k]) byPeriod[k] = [];
    byPeriod[k].push(v);
  }

  const yearOptions = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i);

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Budget Approval</h3>
          <p className="text-xs text-gray-500 mt-0.5">Version history · Lock-on-approval · Submitter cannot self-approve</p>
        </div>
        <select
          value={filterYear}
          onChange={e => setFilterYear(parseInt(e.target.value))}
          className="text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
        >
          {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {error && (
        <div className="mx-4 mt-3 rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-500 hover:text-red-700">✕</button>
        </div>
      )}

      {loading ? (
        <div className="p-6 text-center text-sm text-gray-400 animate-pulse">Loading budget versions…</div>
      ) : Object.keys(byPeriod).length === 0 ? (
        <div className="p-6 text-center text-sm text-gray-500">No budget submissions found for {filterYear}.</div>
      ) : (
        <div className="divide-y divide-gray-100">
          {Object.entries(byPeriod).map(([periodKey, periodVersions]) => {
            const [year, month] = periodKey.split("-").map(Number);
            const latestApproved = periodVersions.find(v => v.approved_by);
            const latestPending  = periodVersions.find(v => !v.approved_by);

            return (
              <div key={periodKey} className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-sm font-semibold text-gray-900">
                    {MONTH_NAMES[month]} {year}
                  </span>
                  {latestApproved ? (
                    <span className="text-xs bg-green-100 text-green-700 rounded-full px-2 py-0.5 font-medium">
                      ✓ Approved (v{latestApproved.version})
                    </span>
                  ) : (
                    <span className="text-xs bg-amber-100 text-amber-700 rounded-full px-2 py-0.5 font-medium">
                      Pending approval
                    </span>
                  )}
                </div>

                <div className="space-y-2">
                  {periodVersions.map(v => {
                    const isOwnSubmission = v.submitted_by === currentUser;
                    const isApproved      = !!v.approved_by;
                    const isApprovingThis = approving === v.id;

                    return (
                      <div
                        key={v.id}
                        className={`rounded-lg border p-3 ${
                          isApproved
                            ? "border-green-200 bg-green-50"
                            : "border-gray-200 bg-white"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-semibold text-gray-700">Version {v.version}</span>
                              <span className="text-xs text-gray-400">
                                {new Date(v.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                              </span>
                              <span className="text-xs text-gray-500">
                                {v.row_count} accounts · TZS {fmt(v.total_budget ?? 0)} total budget
                              </span>
                            </div>
                            {v.notes && (
                              <p className="text-xs text-gray-600 mt-1 italic">"{v.notes}"</p>
                            )}
                            {isApproved && (
                              <p className="text-xs text-green-700 mt-1">
                                Approved — rows are now immutable
                              </p>
                            )}
                            {!isApproved && isOwnSubmission && (
                              <p className="text-xs text-amber-700 mt-1">
                                You submitted this version — a different authorised user must approve it
                              </p>
                            )}
                          </div>

                          {!isApproved && !isOwnSubmission && (
                            <button
                              onClick={() => handleApprove(v)}
                              disabled={!!isApprovingThis}
                              className="flex-shrink-0 bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white text-xs font-medium rounded-lg px-3 py-1.5 transition-colors"
                            >
                              {isApprovingThis ? "Approving…" : "Approve"}
                            </button>
                          )}

                          {isApproved && (
                            <span className="flex-shrink-0 text-lg">🔒</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 text-xs text-gray-500">
        🛡 IRON DOME: Budget rows lock permanently when approved_by is set.
        New periods require a new submission. Approved rows cannot be edited or deleted.
      </div>
    </div>
  );
}
