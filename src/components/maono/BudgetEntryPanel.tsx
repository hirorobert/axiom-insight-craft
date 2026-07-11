/**
 * BudgetEntryPanel · Maono Phase A UI
 *
 * Option C: CSV upload OR manual grid entry.
 * Feeds variance_budgets table via Supabase.
 *
 * IRON DOME:
 *   - approved_by LOCKS the row (trigger-enforced). Cannot edit after approval.
 *   - New period = new version row. Old rows immutable.
 *   - fiscal_year + period_month + version must be unique per company.
 *   - User can submit, but a different user must approve (RLS enforced).
 *
 * CSV format expected:
 *   account_code, account_name, budget_amount, fiscal_year, period_month
 */

import React, { useState, useRef, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

interface BudgetRow {
  account_code:  string;
  account_name:  string;
  budget_amount: number;
  fiscal_year:   number;
  period_month:  number; // 1–12
}

interface BudgetEntryPanelProps {
  companyId:       string;
  supabaseUrl:     string;
  supabaseAnonKey: string;
  onSubmitted?:    () => void;
}

function parseCSV(text: string): { rows: BudgetRow[]; errors: string[] } {
  const lines  = text.trim().split(/\r?\n/);
  const errors: string[] = [];
  const rows: BudgetRow[] = [];

  if (lines.length < 2) {
    return { rows: [], errors: ["CSV must have a header row and at least one data row."] };
  }

  const header = lines[0].split(",").map(h => h.trim().toLowerCase());
  const required = ["account_code", "account_name", "budget_amount", "fiscal_year", "period_month"];
  for (const r of required) {
    if (!header.includes(r)) {
      errors.push(`Missing required column: ${r}`);
    }
  }
  if (errors.length > 0) return { rows: [], errors };

  const idx = (col: string) => header.indexOf(col);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(",").map(c => c.trim().replace(/^"|"$/g, ""));

    const amount = parseFloat(cols[idx("budget_amount")]?.replace(/[,\s]/g, "") ?? "");
    const year   = parseInt(cols[idx("fiscal_year")] ?? "");
    const month  = parseInt(cols[idx("period_month")] ?? "");

    if (isNaN(amount)) { errors.push(`Row ${i + 1}: invalid budget_amount "${cols[idx("budget_amount")]}"`); continue; }
    if (isNaN(year) || year < 2000 || year > 2099) { errors.push(`Row ${i + 1}: invalid fiscal_year`); continue; }
    if (isNaN(month) || month < 1 || month > 12) { errors.push(`Row ${i + 1}: invalid period_month (1–12)`); continue; }
    if (!cols[idx("account_code")]) { errors.push(`Row ${i + 1}: missing account_code`); continue; }

    rows.push({
      account_code:  cols[idx("account_code")],
      account_name:  cols[idx("account_name")] ?? cols[idx("account_code")],
      budget_amount: amount,
      fiscal_year:   year,
      period_month:  month,
    });
  }

  return { rows, errors };
}

function emptyRow(): BudgetRow {
  return { account_code: "", account_name: "", budget_amount: 0, fiscal_year: new Date().getFullYear(), period_month: new Date().getMonth() + 1 };
}

export function BudgetEntryPanel({ companyId, supabaseUrl, supabaseAnonKey, onSubmitted }: BudgetEntryPanelProps) {
  const [mode,        setMode]        = useState<"csv" | "manual">("csv");
  const [rows,        setRows]        = useState<BudgetRow[]>([emptyRow()]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [notes,       setNotes]       = useState("");
  const [submitting,  setSubmitting]  = useState(false);
  const [result,      setResult]      = useState<{ version: number; rows: number } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  const handleCSVUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      const { rows: parsed, errors } = parseCSV(text);
      setParseErrors(errors);
      if (parsed.length > 0) setRows(parsed);
    };
    reader.readAsText(file);
  };

  const updateRow = (i: number, field: keyof BudgetRow, value: string) => {
    setRows(prev => {
      const next = [...prev];
      const row  = { ...next[i] };
      if (field === "budget_amount") row.budget_amount = parseFloat(value.replace(/,/g, "")) || 0;
      else if (field === "fiscal_year") row.fiscal_year = parseInt(value) || 0;
      else if (field === "period_month") row.period_month = parseInt(value) || 0;
      else (row as any)[field] = value;
      next[i] = row;
      return next;
    });
  };

  const addRow = () => setRows(prev => [...prev, emptyRow()]);
  const removeRow = (i: number) => setRows(prev => prev.filter((_, j) => j !== i));

  const handleSubmit = async () => {
    setSubmitError(null);
    const valid = rows.filter(r => r.account_code && r.budget_amount !== 0 && r.fiscal_year && r.period_month);
    if (valid.length === 0) { setSubmitError("No valid rows to submit."); return; }

    setSubmitting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated.");

      // Determine next version for this period
      const { data: existing } = await supabase
        .from("variance_budgets")
        .select("version")
        .eq("company_id", companyId)
        .eq("fiscal_year", valid[0].fiscal_year)
        .eq("period_month", valid[0].period_month)
        .order("version", { ascending: false })
        .limit(1)
        .single();

      const nextVersion = (existing?.version ?? 0) + 1;

      const toInsert = valid.map(r => ({
        company_id:    companyId,
        account_code:  r.account_code,
        account_name:  r.account_name,
        fiscal_year:   r.fiscal_year,
        period_month:  r.period_month,
        budget_amount: r.budget_amount,
        version:       nextVersion,
        submitted_by:  user.id,
        notes:         notes || null,
        // approved_by is NULL — requires separate approval action
      }));

      const { error } = await supabase.from("variance_budgets").insert(toInsert);
      if (error) throw new Error(error.message);

      setResult({ version: nextVersion, rows: toInsert.length });
      onSubmitted?.();
    } catch (err: any) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <div className="rounded-lg border border-green-300 bg-green-50 p-6 text-center">
        <div className="text-2xl mb-2">✓</div>
        <p className="text-sm font-semibold text-green-800">
          Budget v{result.version} submitted — {result.rows} accounts
        </p>
        <p className="text-xs text-green-700 mt-1">
          Awaiting approval from an authorised approver. The budget is locked after approval.
        </p>
        <button
          onClick={() => { setResult(null); setRows([emptyRow()]); setNotes(""); }}
          className="mt-4 text-xs text-green-700 underline"
        >
          Submit another period
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-900">Budget Entry</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          Upload CSV or enter accounts manually. Budget locks permanently after approval.
        </p>
      </div>

      {/* Mode toggle */}
      <div className="flex border-b border-gray-100">
        {(["csv", "manual"] as const).map(m => (
          <button
            key={m}
            onClick={() => { setMode(m); setParseErrors([]); }}
            className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
              mode === m
                ? "text-indigo-700 border-b-2 border-indigo-600 bg-indigo-50"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {m === "csv" ? "Upload CSV" : "Manual Entry"}
          </button>
        ))}
      </div>

      <div className="p-5">
        {/* CSV upload */}
        {mode === "csv" && (
          <div>
            <div
              className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-indigo-400 hover:bg-indigo-50 transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              <div className="text-gray-400 text-lg mb-2">📄</div>
              <p className="text-sm text-gray-600 font-medium">Click to upload budget CSV</p>
              <p className="text-xs text-gray-400 mt-1">
                Required columns: account_code, account_name, budget_amount, fiscal_year, period_month
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={handleCSVUpload}
              />
            </div>

            {parseErrors.length > 0 && (
              <div className="mt-3 rounded-lg bg-red-50 border border-red-200 p-3">
                <div className="text-xs font-semibold text-red-800 mb-1">Parse errors</div>
                {parseErrors.map((e, i) => <div key={i} className="text-xs text-red-700">{e}</div>)}
              </div>
            )}

            {rows.length > 1 && parseErrors.length === 0 && (
              <div className="mt-3 rounded-lg bg-green-50 border border-green-200 p-3 text-xs text-green-700">
                ✓ {rows.length} rows loaded successfully. Review below before submitting.
              </div>
            )}
          </div>
        )}

        {/* Preview / manual grid */}
        {(mode === "manual" || rows.length > 1) && (
          <div className={mode === "csv" ? "mt-4" : ""}>
            <div className="rounded-lg border border-gray-200 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {["Account Code", "Account Name", "Budget Amount (TZS)", "Year", "Month"].map(h => (
                      <th key={h} className="px-3 py-2.5 text-left text-gray-600 font-medium">{h}</th>
                    ))}
                    {mode === "manual" && <th className="px-2 py-2.5" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((row, i) => (
                    <tr key={i}>
                      {mode === "manual" ? (
                        <>
                          <td className="px-2 py-1.5">
                            <input
                              className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
                              value={row.account_code}
                              onChange={e => updateRow(i, "account_code", e.target.value)}
                              placeholder="e.g. 4001"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
                              value={row.account_name}
                              onChange={e => updateRow(i, "account_name", e.target.value)}
                              placeholder="Account name"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
                              value={row.budget_amount || ""}
                              onChange={e => updateRow(i, "budget_amount", e.target.value)}
                              placeholder="0"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              className="w-20 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
                              value={row.fiscal_year}
                              onChange={e => updateRow(i, "fiscal_year", e.target.value)}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <select
                              className="border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
                              value={row.period_month}
                              onChange={e => updateRow(i, "period_month", e.target.value)}
                            >
                              {Array.from({ length: 12 }, (_, j) => (
                                <option key={j + 1} value={j + 1}>
                                  {new Date(2000, j, 1).toLocaleString("default", { month: "short" })}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2 py-1.5">
                            <button onClick={() => removeRow(i)} className="text-red-400 hover:text-red-600 text-xs px-1">✕</button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-3 py-2 text-gray-800 font-mono">{row.account_code}</td>
                          <td className="px-3 py-2 text-gray-700">{row.account_name}</td>
                          <td className="px-3 py-2 text-gray-700 tabular-nums">{row.budget_amount.toLocaleString()}</td>
                          <td className="px-3 py-2 text-gray-600">{row.fiscal_year}</td>
                          <td className="px-3 py-2 text-gray-600">{row.period_month}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {mode === "manual" && (
              <button
                onClick={addRow}
                className="mt-2 text-xs text-indigo-600 hover:text-indigo-800 underline"
              >
                + Add row
              </button>
            )}
          </div>
        )}

        {/* Notes */}
        <div className="mt-4">
          <label className="text-xs font-medium text-gray-600 block mb-1">Notes (optional)</label>
          <textarea
            className="w-full border border-gray-200 rounded px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400 resize-none"
            rows={2}
            placeholder="Reason for this budget version, key assumptions, etc."
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </div>

        {submitError && (
          <div className="mt-3 rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700">
            {submitError}
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-gray-400">
            After submit, a separate approver must sign off. You cannot approve your own budget.
          </p>
          <button
            onClick={handleSubmit}
            disabled={submitting || rows.filter(r => r.account_code).length === 0}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-xs font-medium rounded-lg px-4 py-2 transition-colors"
          >
            {submitting ? "Submitting…" : "Submit for Approval"}
          </button>
        </div>
      </div>
    </div>
  );
}
