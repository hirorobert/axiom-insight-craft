// ============================================================
// KingaTaxPanel — Module E: ITA Corporate Tax Computation
// Displays the full Tanzania ITA Chapter 332 waterfall:
//   Accounting PBT → ITA Add-backs → Wear & Tear → Taxable Income
//   → CIT 30% / Minimum Tax 0.5% → Provision vs Computed → Gap
// ============================================================

import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Calculator, ChevronDown, ChevronRight, AlertTriangle,
  CheckCircle, Info, Plus, RefreshCw, History,
} from "lucide-react";

// ── ITA CLASS METADATA — VERIFIED: PwC Tanzania (reviewed 14 Jan 2026) ───
// Source: https://taxsummaries.pwc.com/tanzania/corporate/deductions
// ─────────────────────────────────────────────────────────────────────────
// Class 1: 37.5% reducing balance  — Computers, automobiles, buses<30pax, const.equip
// Class 2: 25%   reducing balance  — Heavy vehicles, vessels, aircraft, ag/mfg plant
// Class 3: 12.5% reducing balance  — Furniture, fixtures, equipment; all other assets
// Class 5: 20%   straight-line     — Agricultural/livestock/fish farming buildings
// Class 6: 5%    straight-line     — Commercial/industrial buildings (other)
// Class 7: 1/useful life (rounded down to nearest 0.5 yr) — Intangible assets (PwC Tanzania Jan 2026)
// Class 8: 100% immediate write-off — Agricultural plant & machinery; EFDs; minerals/petroleum exploration equip
// NOTE: There is NO Class 4 in Tanzania ITA (removed Finance Act 2016).
const ITA_CLASS_LABELS: Record<number, string> = {
  1: "Class 1 — Computers, automobiles, buses <30 pax, construction equip (37.5% RB)",
  2: "Class 2 — Heavy vehicles, vessels, aircraft, ag/mfg plant & machinery (25% RB)",
  3: "Class 3 — Furniture, fixtures, equipment; all other assets (12.5% RB)",
  5: "Class 5 — Agricultural/livestock/fish farming buildings & structures (20% SL)",
  6: "Class 6 — Commercial & industrial buildings (all other) (5% SL)",
  7: "Class 7 — Intangible assets (patents, trademarks, licences, software) — 1÷useful life SL",
  8: "Class 8 — Agricultural plant & machinery; EFDs; minerals/petroleum exploration equip (100% immediate)",
};

// ── TYPES ─────────────────────────────────────────────────────────────────
interface TaxAdjustment {
  description: string;
  amount_tzs: number;
  ita_section: string;
  account_names: string[];
  auto_detected: boolean;
  requires_review?: boolean;
}

interface ClassificationWarning {
  category: string;
  message: string;
  accounts_found: string[];
  action_required: string;
}

interface IncomeStatementBreakdown {
  revenue_tzs:            number;
  cost_of_goods_sold_tzs: number;
  gross_profit_tzs:       number;
  operating_expenses_tzs: number;
  other_income_tzs:       number;
  finance_costs_tzs:      number;
  taxes_tzs:              number;
  profit_before_tax_tzs:  number;
}

// ── MODULE D: Deferred Tax (IFRS for SMEs s.29 / IAS 12) ─────────────────
interface ModuleDDeferred {
  // Category A — timing (W&T vs depreciation)
  timing_diff_tzs:               number;   // +ve=accelerated, -ve=decelerated
  wear_tear_tzs:                 number;
  accounting_depreciation_tzs:   number;
  dtl_timing_tzs:                number;   // deferred tax liability from timing
  dta_timing_tzs:                number;   // deferred tax asset from timing
  // Category B — loss carry-forward (ITA s.19)
  current_year_loss_tzs:         number;
  dta_potential_loss_tzs:        number;
  dta_loss_recognized_tzs:       number;
  dta_loss_status:               "full" | "partial" | "not_recognized" | "nil";
  dta_loss_recovery_years:       number | null;
  dta_loss_note:                 string;
  s19_shelter_rate:              number;   // 0.70 — ITA s.19(2) annual shelter cap
  // Net position
  net_dtl_tzs:                   number;
  net_dta_tzs:                   number;
  net_deferred_tax_position_tzs: number;   // +ve=net DTL (SFP liability), -ve=net DTA (SFP asset)
  // SCI total tax charge
  deferred_tax_movement_tzs:     number;   // approximate (opening balance not yet loaded)
  total_tax_expense_tzs:         number;   // current tax + deferred tax movement
  profit_after_full_tax_tzs:     number;
  // Compliance
  opening_balance_required:      boolean;
  ifrs_section:                  string;
  ita_loss_section:              string;
  note:                          string;
}

interface TaxResult {
  engine_version: string;
  dry_run: boolean;
  income_statement_breakdown?: IncomeStatementBreakdown;
  accounting_profit_before_tax_tzs: number;
  gross_income_tzs: number;
  add_backs: TaxAdjustment[];
  deductions: TaxAdjustment[];
  total_add_backs_tzs: number;
  total_deductions_tzs: number;
  total_wear_tear_tzs: number;
  total_debt_tzs: number;
  total_equity_tzs: number;
  debt_equity_ratio: number;
  thin_cap_disallowed_tzs: number;
  taxable_income_tzs: number;
  cit_at_30pct_tzs: number;
  minimum_tax_tzs: number;
  tax_payable_tzs: number;
  minimum_tax_applies: boolean;
  effective_tax_rate_pct: number;
  income_tax_provision_tzs: number;
  cit_gap_tzs: number;
  months_overdue: number;
  penalty_tzs: number;
  total_exposure_tzs: number;
  warnings: string[];
  classification_warnings: ClassificationWarning[];
  review_required: boolean;
  amt_trigger_note: string;
  finding_created: boolean;
  // Module D — Deferred Tax (IFRS for SMEs s.29 / IAS 12)
  module_d_deferred?: ModuleDDeferred;
}

interface CapAllowanceForm {
  asset_description: string;
  ita_class: number;
  cost_tzs: string;
  ita_wdv_opening_tzs: string;
  additions_tzs: string;
  disposals_at_tax_cost_tzs: string;
  accounting_depreciation_tzs: string;
  source_account: string;
  notes: string;
}

interface StoredComputation {
  id: string;
  period_year: number;
  taxable_income_tzs: number;
  tax_payable_tzs: number;
  cit_gap_tzs: number;
  total_exposure_tzs: number;
  minimum_tax_applies: boolean;
  effective_tax_rate_pct: number;
  engine_version: string;
  created_at: string;
}

// ── PROPS ─────────────────────────────────────────────────────────────────
interface KingaTaxPanelProps {
  companyId: string;
  uploadId: string;
  periodYear: number;
  companyName?: string;
  userId: string;
}

// ── HELPERS ───────────────────────────────────────────────────────────────
function fmt(n: number): string {
  if (!n && n !== 0) return "—";
  return `TZS ${Math.abs(n).toLocaleString()}`;
}

function fmtSigned(n: number): string {
  if (!n && n !== 0) return "—";
  return n < 0
    ? `(TZS ${Math.abs(n).toLocaleString()})`
    : `TZS ${n.toLocaleString()}`;
}

function severityColor(gap: number): string {
  const abs = Math.abs(gap);
  if (abs >= 50_000_000) return "text-red-600 bg-red-50 border-red-200";
  if (abs >= 10_000_000) return "text-orange-600 bg-orange-50 border-orange-200";
  if (abs >= 1_000_000)  return "text-yellow-600 bg-yellow-50 border-yellow-200";
  return "text-green-600 bg-green-50 border-green-200";
}

// ── CAPITAL ALLOWANCE MODAL ────────────────────────────────────────────────
function AddCapAllowanceModal({
  companyId, userId, periodYear, onSaved,
}: {
  companyId: string; userId: string; periodYear: number; onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<CapAllowanceForm>({
    asset_description: "", ita_class: 3, cost_tzs: "",
    ita_wdv_opening_tzs: "", additions_tzs: "0",
    disposals_at_tax_cost_tzs: "0", accounting_depreciation_tzs: "0",
    source_account: "", notes: "",
  });

  const parseNum = (s: string) => parseFloat(s.replace(/,/g, "")) || 0;

  // Compute preview wear & tear — VERIFIED RATES (PwC Tanzania, Jan 2026)
  const pool = parseNum(form.ita_wdv_opening_tzs || form.cost_tzs)
             + parseNum(form.additions_tzs)
             - parseNum(form.disposals_at_tax_cost_tzs);
  const rbRates: Record<number, number> = { 1: 0.375, 2: 0.25, 3: 0.125, 8: 1.00 };
  const wt = form.ita_class === 5
    ? Math.round(parseNum(form.cost_tzs) * 0.20)       // 20% SL on cost
    : form.ita_class === 6
    ? Math.round(parseNum(form.cost_tzs) * 0.05)       // 5% SL on cost
    : form.ita_class === 8
    ? Math.round(pool)                                  // 100% immediate
    : form.ita_class === 7
    ? 0                                                  // Class 7: 1/useful_life — CPA must confirm useful life (v1.3)
    : Math.round(pool * (rbRates[form.ita_class] ?? 0)); // RB classes 1, 2, 3

  const handleSave = async () => {
    if (!form.asset_description || !form.cost_tzs) return;
    setSaving(true);
    const { error } = await supabase.from("capital_allowances").insert({
      company_id:                    companyId,
      period_year:                   periodYear,
      asset_description:             form.asset_description,
      ita_class:                     form.ita_class,
      cost_tzs:                      parseNum(form.cost_tzs),
      ita_wdv_opening_tzs:           parseNum(form.ita_wdv_opening_tzs) || parseNum(form.cost_tzs),
      additions_tzs:                 parseNum(form.additions_tzs),
      disposals_at_tax_cost_tzs:     parseNum(form.disposals_at_tax_cost_tzs),
      accounting_depreciation_tzs:   parseNum(form.accounting_depreciation_tzs),
      wear_tear_tzs:                 wt,
      ita_wdv_closing_tzs:           pool - wt,
      source_account:                form.source_account || null,
      notes:                         form.notes || null,
      created_by:                    userId,
    });
    setSaving(false);
    if (!error) {
      setOpen(false);
      setForm({ asset_description: "", ita_class: 3, cost_tzs: "", ita_wdv_opening_tzs: "", additions_tzs: "0", disposals_at_tax_cost_tzs: "0", accounting_depreciation_tzs: "0", source_account: "", notes: "" });
      onSaved();
    }
  };

  const inputClass = "w-full mt-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-1">
        <Plus className="w-3 h-3" /> Capital Allowance
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-lg space-y-4 max-h-[90vh] overflow-y-auto">
            <div>
              <h3 className="font-semibold text-lg">Add Capital Allowance (ITA s.34)</h3>
              <p className="text-xs text-gray-500 mt-1">
                Enter assets for wear & tear deduction. WDV Opening = prior year closing WDV (or cost if first year).
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-600">Asset Description</label>
                <input className={inputClass} placeholder="e.g. Office computers (HP ProBook × 12)"
                  value={form.asset_description} onChange={e => setForm(f => ({ ...f, asset_description: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">ITA Asset Class</label>
                <select className={inputClass} value={form.ita_class}
                  onChange={e => setForm(f => ({ ...f, ita_class: Number(e.target.value) }))}>
                  {Object.entries(ITA_CLASS_LABELS).map(([k, v]) =>
                    <option key={k} value={k}>{v}</option>
                  )}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-600">Original Cost (TZS)</label>
                  <input className={inputClass} placeholder="e.g. 45000000"
                    value={form.cost_tzs} onChange={e => setForm(f => ({ ...f, cost_tzs: e.target.value }))} />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600">ITA WDV Opening (TZS)</label>
                  <input className={inputClass} placeholder="Opening tax written-down value"
                    value={form.ita_wdv_opening_tzs} onChange={e => setForm(f => ({ ...f, ita_wdv_opening_tzs: e.target.value }))} />
                  <p className="text-xs text-gray-400 mt-0.5">Leave blank if first year (uses cost)</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-600">Additions in Period (TZS)</label>
                  <input className={inputClass} placeholder="0"
                    value={form.additions_tzs} onChange={e => setForm(f => ({ ...f, additions_tzs: e.target.value }))} />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600">Disposals at Tax Cost (TZS)</label>
                  <input className={inputClass} placeholder="0"
                    value={form.disposals_at_tax_cost_tzs} onChange={e => setForm(f => ({ ...f, disposals_at_tax_cost_tzs: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Accounting Depreciation (TZS) — for add-back reconciliation</label>
                <input className={inputClass} placeholder="Per TB"
                  value={form.accounting_depreciation_tzs} onChange={e => setForm(f => ({ ...f, accounting_depreciation_tzs: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">TB Account Name (optional)</label>
                <input className={inputClass} placeholder="e.g. Office Equipment — Cost"
                  value={form.source_account} onChange={e => setForm(f => ({ ...f, source_account: e.target.value }))} />
              </div>
            </div>
            {form.ita_class === 7 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
                <strong>Class 7 — CPA action required:</strong> Rate = 1 ÷ useful life (rounded down to nearest 0.5 yr per ITA Third Schedule). The engine cannot compute Class 7 wear & tear without the asset's useful life in years. Record this asset now; enter useful life in the Notes field. Deduction computation will be added in v1.3.
              </div>
            )}
            {wt > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
                <strong>Preview:</strong> ITA wear & tear = <strong>TZS {wt.toLocaleString()}</strong>
                {" "}| WDV closing = TZS {(pool - wt).toLocaleString()}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving || !form.asset_description || !form.cost_tzs}>
                {saving ? "Saving…" : "Save Asset"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── WATERFALL ROW ─────────────────────────────────────────────────────────
function WaterfallRow({
  label, value, indent = 0, bold = false, highlight = false, expandable = false, children,
}: {
  label: string; value: string; indent?: number; bold?: boolean;
  highlight?: boolean; expandable?: boolean; children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <div
        className={`flex items-center justify-between py-1.5 px-2 rounded text-sm
          ${highlight ? "bg-muted/60 font-semibold" : ""}
          ${bold ? "font-medium" : ""}
          ${expandable ? "cursor-pointer hover:bg-muted/40" : ""}
        `}
        style={{ paddingLeft: `${8 + indent * 16}px` }}
        onClick={() => expandable && setExpanded(!expanded)}
      >
        <span className="flex items-center gap-1 text-foreground">
          {expandable && (expanded
            ? <ChevronDown className="w-3 h-3 text-muted-foreground" />
            : <ChevronRight className="w-3 h-3 text-muted-foreground" />
          )}
          {label}
        </span>
        <span className={`font-mono text-right ${bold ? "text-foreground" : "text-muted-foreground"}`}>
          {value}
        </span>
      </div>
      {expandable && expanded && (
        <div className="border-l-2 border-muted ml-4 pl-2 mt-1 mb-1">
          {children}
        </div>
      )}
    </div>
  );
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────────
export function KingaTaxPanel({
  companyId, uploadId, periodYear, companyName, userId,
}: KingaTaxPanelProps) {
  type Phase = "idle" | "running" | "preview" | "committing" | "done";

  const [phase, setPhase]               = useState<Phase>("idle");
  const [result, setResult]             = useState<TaxResult | null>(null);
  const [showConfirm, setShowConfirm]   = useState(false);
  const [history, setHistory]           = useState<StoredComputation[]>([]);
  const [monthsOverdue, setMonthsOverdue] = useState(0);
  const [error, setError]               = useState<string | null>(null);
  const [stored, setStored]             = useState<StoredComputation | null>(null);

  // Load any existing committed computation
  useEffect(() => {
    supabase
      .from("tax_computations")
      .select("id,period_year,taxable_income_tzs,tax_payable_tzs,cit_gap_tzs,total_exposure_tzs,minimum_tax_applies,effective_tax_rate_pct,engine_version,created_at")
      .eq("company_id", companyId)
      .eq("upload_id", uploadId)
      .maybeSingle()
      .then(({ data }) => { if (data) setStored(data); });
  }, [companyId, uploadId]);

  const runEngine = async (dryRun: boolean) => {
    setPhase(dryRun ? "running" : "committing");
    setError(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("kinga-tax-engine", {
        body: { uploadId, companyId, periodYear, dry_run: dryRun, months_overdue: monthsOverdue },
      });
      if (fnErr) throw fnErr;
      if (!data?.success) throw new Error(data?.error ?? "Engine returned no result");
      setResult(data.result);
      setPhase(dryRun ? "preview" : "done");
      if (!dryRun) {
        // Reload stored computation
        const { data: stored } = await supabase
          .from("tax_computations")
          .select("id,period_year,taxable_income_tzs,tax_payable_tzs,cit_gap_tzs,total_exposure_tzs,minimum_tax_applies,effective_tax_rate_pct,engine_version,created_at")
          .eq("company_id", companyId).eq("upload_id", uploadId).maybeSingle();
        if (stored) setStored(stored);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  const reset = () => { setPhase("idle"); setResult(null); setError(null); };

  const gapColor = result ? severityColor(result.cit_gap_tzs) : "";
  const exposureLabel = result
    ? result.total_exposure_tzs >= 50_000_000 ? "CRITICAL"
    : result.total_exposure_tzs >= 10_000_000 ? "HIGH"
    : result.total_exposure_tzs >= 1_000_000  ? "MEDIUM" : "LOW"
    : "";

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-lg flex items-center gap-2">
            <Calculator className="w-5 h-5 text-primary" />
            Kinga — Corporate Tax (ITA Chapter 332)
            {companyName && <span className="text-sm font-normal text-muted-foreground">· {companyName}</span>}
            <Badge variant="outline" className="text-xs ml-1">FY {periodYear}</Badge>
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <AddCapAllowanceModal companyId={companyId} userId={userId} periodYear={periodYear} onSaved={reset} />
            {phase !== "idle" && (
              <Button variant="ghost" size="sm" onClick={reset} className="gap-1">
                <RefreshCw className="w-3 h-3" /> Reset
              </Button>
            )}
          </div>
        </div>
        {stored && phase === "idle" && (
          <div className="mt-2 text-xs text-muted-foreground border border-border rounded-lg px-3 py-2 bg-muted/30">
            Last computation: {new Date(stored.created_at).toLocaleDateString()} —
            Tax payable TZS {stored.tax_payable_tzs?.toLocaleString()} |
            Gap TZS {stored.cit_gap_tzs?.toLocaleString()}
            {stored.minimum_tax_applies && " (min tax applies)"}
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {/* ── IDLE ───────────────────────────────────────────────── */}
        {phase === "idle" && (
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-sm text-muted-foreground">Months overdue:</label>
              <input
                type="number" min={0} max={60}
                value={monthsOverdue}
                onChange={e => setMonthsOverdue(Number(e.target.value))}
                className="w-16 border rounded px-2 py-1 text-sm text-center"
              />
            </div>
            <Button onClick={() => runEngine(true)} className="gap-2">
              <Calculator className="w-4 h-4" />
              Run Tax Analysis
            </Button>
            <p className="text-xs text-muted-foreground">
              Preview ITA computation — nothing saved until you confirm.
            </p>
          </div>
        )}

        {/* ── RUNNING ────────────────────────────────────────────── */}
        {(phase === "running" || phase === "committing") && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground py-4">
            <RefreshCw className="w-4 h-4 animate-spin text-primary" />
            {phase === "running" ? "Computing ITA waterfall…" : "Saving computation & findings…"}
          </div>
        )}

        {/* ── ERROR ──────────────────────────────────────────────── */}
        {error && (
          <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* ── WARNINGS ──────────────────────────────────────────── */}
        {result && result.warnings.length > 0 && (
          <div className="space-y-1">
            {result.warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-3 py-2">
                <Info className="w-3 h-3 flex-shrink-0 mt-0.5" />
                {w}
              </div>
            ))}
          </div>
        )}

        {/* ── CLASSIFICATION WARNINGS (CPA Review Required) ─────── */}
        {result && result.classification_warnings && result.classification_warnings.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-semibold text-orange-700 uppercase tracking-wide flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              CPA Review Required ({result.classification_warnings.length} item{result.classification_warnings.length > 1 ? "s" : ""})
            </div>
            {result.classification_warnings.map((w, i) => (
              <div key={i} className="text-xs bg-orange-50 border border-orange-200 rounded-lg p-3 space-y-1">
                <div className="font-semibold text-orange-800">[{w.category}]</div>
                <div className="text-orange-700">{w.message}</div>
                {w.accounts_found.length > 0 && (
                  <div className="text-orange-600 font-mono">
                    Accounts: {w.accounts_found.join(", ")}
                  </div>
                )}
                <div className="text-orange-800 font-medium">→ {w.action_required}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── WATERFALL ─────────────────────────────────────────── */}
        {result && (phase === "preview" || phase === "done") && (
          <div className="space-y-4">
            {/* ITA Waterfall */}
            <div className="border border-border rounded-xl overflow-hidden">
              <div className="bg-muted/40 px-3 py-2 border-b border-border">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  ITA Corporate Tax Waterfall — {result.engine_version}
                </span>
              </div>
              <div className="p-3 space-y-0.5">
                {/* ── Accounting P&L breakdown (TB-sourced, transparent) ── */}
                {result.income_statement_breakdown && (
                  <div className="mb-2">
                    <div className="text-xs font-semibold text-muted-foreground uppercase px-2 mb-1">ACCOUNTING P&L (from Trial Balance)</div>
                    <WaterfallRow label="Revenue / Turnover" value={fmt(result.income_statement_breakdown.revenue_tzs)} indent={1} />
                    {result.income_statement_breakdown.cost_of_goods_sold_tzs > 0 && (
                      <WaterfallRow label="Less: Cost of Goods Sold" value={`− ${fmt(result.income_statement_breakdown.cost_of_goods_sold_tzs)}`} indent={1} />
                    )}
                    {result.income_statement_breakdown.cost_of_goods_sold_tzs > 0 && (
                      <WaterfallRow label="Gross Profit" value={fmtSigned(result.income_statement_breakdown.gross_profit_tzs)} bold indent={1} />
                    )}
                    {result.income_statement_breakdown.operating_expenses_tzs > 0 && (
                      <WaterfallRow label="Less: Operating Expenses" value={`− ${fmt(result.income_statement_breakdown.operating_expenses_tzs)}`} indent={1} />
                    )}
                    {result.income_statement_breakdown.other_income_tzs > 0 && (
                      <WaterfallRow label="Add: Other Income" value={`+ ${fmt(result.income_statement_breakdown.other_income_tzs)}`} indent={1} />
                    )}
                    {result.income_statement_breakdown.finance_costs_tzs > 0 && (
                      <WaterfallRow label="Less: Finance Costs" value={`− ${fmt(result.income_statement_breakdown.finance_costs_tzs)}`} indent={1} />
                    )}
                    {result.income_statement_breakdown.taxes_tzs > 0 && (
                      <WaterfallRow label="Less: Income Tax Provision" value={`− ${fmt(result.income_statement_breakdown.taxes_tzs)}`} indent={1} />
                    )}
                    <div className="my-1 border-t border-dashed border-muted mx-2" />
                  </div>
                )}

                <WaterfallRow label="Accounting Profit Before Tax" value={fmtSigned(result.accounting_profit_before_tax_tzs)} bold highlight />
                <WaterfallRow label="Gross Income (revenue base)" value={fmt(result.gross_income_tzs)} />

                {/* Add-backs */}
                {result.add_backs.length > 0 && (
                  <div className="mt-2">
                    <div className="text-xs font-semibold text-muted-foreground uppercase px-2 mb-1">ADD: Non-deductible Expenses</div>
                    {result.add_backs.map((adj, i) => (
                      <WaterfallRow
                        key={i}
                        label={adj.description}
                        value={`+ ${fmt(adj.amount_tzs)}`}
                        indent={1}
                        expandable={adj.account_names.length > 0}
                      >
                        {adj.account_names.map((n, j) => (
                          <div key={j} className="text-xs text-muted-foreground py-0.5 pl-2">{n}</div>
                        ))}
                      </WaterfallRow>
                    ))}
                    <WaterfallRow label="Total add-backs" value={fmt(result.total_add_backs_tzs)} bold />
                  </div>
                )}

                {/* Deductions */}
                {result.deductions.length > 0 && (
                  <div className="mt-2">
                    <div className="text-xs font-semibold text-muted-foreground uppercase px-2 mb-1">DEDUCT: ITA Allowances</div>
                    {result.deductions.map((d, i) => (
                      <WaterfallRow key={i} label={d.description} value={`− ${fmt(d.amount_tzs)}`} indent={1} />
                    ))}
                    <WaterfallRow label="Total wear & tear (ITA s.34)" value={`− ${fmt(result.total_wear_tear_tzs)}`} bold />
                  </div>
                )}

                {result.thin_cap_disallowed_tzs > 0 && (
                  <div className="mt-1">
                    <div className="text-xs font-semibold text-muted-foreground uppercase px-2 mb-1">THIN CAP (ITA s.24A)</div>
                    <WaterfallRow label={`Debt:equity = ${result.debt_equity_ratio.toFixed(2)}:1 (limit 2.33:1)`}
                      value={`+ ${fmt(result.thin_cap_disallowed_tzs)}`} indent={1} />
                  </div>
                )}

                {/* Taxable Income */}
                <div className="my-2 border-t border-border" />
                <WaterfallRow label="TAXABLE INCOME" value={fmtSigned(result.taxable_income_tzs)} bold highlight />

                {/* CIT */}
                <div className="mt-3 space-y-0.5">
                  <WaterfallRow label="CIT @ 30%" value={fmt(result.cit_at_30pct_tzs)} indent={1} />
                  <WaterfallRow
                    label={`AMT @ 1% of turnover${result.minimum_tax_applies ? " ← CPA CONFIRMED APPLIES" : " (indicative — requires 3-year loss history verification)"}`}
                    value={fmt(result.minimum_tax_tzs)}
                    indent={1}
                  />
                  <WaterfallRow
                    label={result.minimum_tax_applies ? "TAX PAYABLE (AMT basis — CPA confirmed)" : "TAX PAYABLE (standard CIT)"}
                    value={fmt(result.tax_payable_tzs)}
                    bold highlight
                  />
                  <WaterfallRow label={`Effective rate: ${result.effective_tax_rate_pct}% of turnover`} value="" />
                </div>

                {/* Gap */}
                <div className="my-2 border-t border-border" />
                <WaterfallRow label="Income Tax Provision (balance sheet)" value={fmt(result.income_tax_provision_tzs)} />
                <WaterfallRow
                  label={result.cit_gap_tzs > 0 ? "UNDER-PROVISION (GAP)" : result.cit_gap_tzs < 0 ? "OVER-PROVISION" : "FULLY PROVIDED"}
                  value={fmtSigned(result.cit_gap_tzs)}
                  bold highlight
                />
              </div>
            </div>

            {/* Exposure Card */}
            {Math.abs(result.cit_gap_tzs) > 500_000 && (
              <div className={`border rounded-xl p-4 space-y-2 ${gapColor}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-semibold">
                    <AlertTriangle className="w-4 h-4" />
                    CIT Gap — {exposureLabel}
                  </div>
                  <Badge className={gapColor}>{exposureLabel}</Badge>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="opacity-70 text-xs">Net CIT Gap</p>
                    <p className="font-bold font-mono">{fmt(result.cit_gap_tzs)}</p>
                  </div>
                  <div>
                    <p className="opacity-70 text-xs">TAA Penalty ({result.months_overdue} months × 5%)</p>
                    <p className="font-bold font-mono">{result.months_overdue > 0 ? fmt(result.penalty_tzs) : "—"}</p>
                  </div>
                  <div className="col-span-2">
                    <p className="opacity-70 text-xs">Total Exposure</p>
                    <p className="text-lg font-bold font-mono">{fmt(result.total_exposure_tzs)}</p>
                  </div>
                </div>
              </div>
            )}

            {result.cit_gap_tzs <= 500_000 && result.cit_gap_tzs >= -500_000 && !result.review_required && (
              <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-3">
                <CheckCircle className="w-4 h-4" />
                Corporate tax provision is adequate — no material gap detected.
              </div>
            )}
            {result.cit_gap_tzs <= 500_000 && result.cit_gap_tzs >= -500_000 && result.review_required && (
              <div className="flex items-center gap-2 text-sm text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                <AlertTriangle className="w-4 h-4" />
                Gap is within threshold but CPA review is required before this computation can be certified. Resolve the items above first.
              </div>
            )}

            {/* ── MODULE D: Section 29 Deferred Tax Disclosure ────────────────── */}
            {result.module_d_deferred && (
              <div className="border border-amber-300 rounded-xl overflow-hidden">
                <div className="bg-amber-50 px-3 py-2 border-b border-amber-300 flex items-center gap-2">
                  <Info className="w-3.5 h-3.5 text-amber-700" />
                  <span className="text-xs font-semibold text-amber-800 uppercase tracking-wide">
                    Module D — Deferred Tax Disclosure (IFRS for SMEs s.29 / IAS 12)
                  </span>
                </div>
                <div className="p-3 space-y-0.5">

                  {/* Category A: Timing differences */}
                  <div className="text-xs font-semibold text-muted-foreground uppercase px-2 mb-1 mt-1">
                    Category A — Timing Differences (W&amp;T vs Depreciation)
                  </div>
                  <WaterfallRow label="ITA Wear &amp; Tear this period" value={fmt(result.module_d_deferred.wear_tear_tzs)} indent={1} />
                  <WaterfallRow label="Accounting Depreciation (from TB)" value={fmt(result.module_d_deferred.accounting_depreciation_tzs)} indent={1} />
                  {result.module_d_deferred.dtl_timing_tzs > 0 && (
                    <WaterfallRow
                      label="→ DTL: Accelerated W&T creates future taxable amount (× 30%)"
                      value={fmt(result.module_d_deferred.dtl_timing_tzs)}
                      indent={2} bold
                    />
                  )}
                  {result.module_d_deferred.dta_timing_tzs > 0 && (
                    <WaterfallRow
                      label="→ DTA: Decelerated W&T creates future deductible amount (× 30%)"
                      value={fmt(result.module_d_deferred.dta_timing_tzs)}
                      indent={2} bold
                    />
                  )}
                  {result.module_d_deferred.dtl_timing_tzs === 0 && result.module_d_deferred.dta_timing_tzs === 0 && (
                    <div className="text-xs text-muted-foreground px-8 py-1 italic">
                      No timing difference — enter capital allowances to populate this section.
                    </div>
                  )}

                  {/* Category B: Loss carry-forward DTA */}
                  {result.module_d_deferred.current_year_loss_tzs > 0 && (
                    <>
                      <div className="text-xs font-semibold text-muted-foreground uppercase px-2 mb-1 mt-3">
                        Category B — Loss Carry-Forward DTA (ITA s.19 + IFRS for SMEs s.29.9)
                      </div>
                      <WaterfallRow label="Current year unrelieved tax loss" value={fmt(result.module_d_deferred.current_year_loss_tzs)} indent={1} />
                      <WaterfallRow label="Potential DTA (loss × 30%)" value={fmt(result.module_d_deferred.dta_potential_loss_tzs)} indent={1} />
                      <WaterfallRow
                        label={`ITA s.19(2) — 70% annual shelter cap recovery: ~${result.module_d_deferred.dta_loss_recovery_years !== null ? result.module_d_deferred.dta_loss_recovery_years.toFixed(1) + " yrs" : "∞ yrs"} at 5% margin proxy`}
                        value=""
                        indent={2}
                      />
                      <WaterfallRow
                        label={
                          result.module_d_deferred.dta_loss_status === "full"          ? "→ DTA Recognized in FULL" :
                          result.module_d_deferred.dta_loss_status === "partial"       ? "→ DTA Recognized PARTIALLY (70% haircut — CPA must verify)" :
                          result.module_d_deferred.dta_loss_status === "not_recognized"? "→ DTA NOT Recognized — horizon exceeded (disclose in notes)" :
                          "→ No loss this period"
                        }
                        value={
                          result.module_d_deferred.dta_loss_recognized_tzs > 0
                            ? fmt(result.module_d_deferred.dta_loss_recognized_tzs)
                            : "TZS 0"
                        }
                        indent={2} bold
                      />
                    </>
                  )}

                  {/* Net deferred tax position */}
                  <div className="my-2 border-t border-dashed border-amber-200 mx-2" />
                  <div className="text-xs font-semibold text-muted-foreground uppercase px-2 mb-1">
                    Net Deferred Tax Position — Year-End (SFP)
                  </div>
                  <WaterfallRow label="Gross DTL (SFP: non-current liabilities)" value={result.module_d_deferred.net_dtl_tzs > 0 ? fmt(result.module_d_deferred.net_dtl_tzs) : "Nil"} indent={1} />
                  <WaterfallRow label="Gross DTA (SFP: non-current assets)" value={result.module_d_deferred.net_dta_tzs > 0 ? fmt(result.module_d_deferred.net_dta_tzs) : "Nil"} indent={1} />
                  <WaterfallRow
                    label={result.module_d_deferred.net_deferred_tax_position_tzs > 0
                      ? "NET DEFERRED TAX LIABILITY (post to SFP non-current liabilities)"
                      : result.module_d_deferred.net_deferred_tax_position_tzs < 0
                      ? "NET DEFERRED TAX ASSET (post to SFP non-current assets)"
                      : "Net Deferred Tax Position: Nil"}
                    value={fmtSigned(result.module_d_deferred.net_deferred_tax_position_tzs)}
                    bold highlight
                  />

                  {/* SCI total tax charge */}
                  <div className="my-2 border-t border-dashed border-amber-200 mx-2" />
                  <div className="text-xs font-semibold text-muted-foreground uppercase px-2 mb-1">
                    SCI Total Tax Charge (IFRS for SMEs s.29.1)
                  </div>
                  <WaterfallRow label="Current tax payable (CIT)" value={fmt(result.tax_payable_tzs)} indent={1} />
                  <WaterfallRow label="Deferred tax movement † (approx.)" value={fmtSigned(result.module_d_deferred.deferred_tax_movement_tzs)} indent={1} />
                  <WaterfallRow label="TOTAL TAX EXPENSE (SCI)" value={fmtSigned(result.module_d_deferred.total_tax_expense_tzs)} bold highlight />
                  <WaterfallRow label="PROFIT AFTER FULL TAX — PAT" value={fmtSigned(result.module_d_deferred.profit_after_full_tax_tzs)} bold />

                  {/* Opening balance notice */}
                  <div className="mt-3 mx-1 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 space-y-1">
                    <div className="font-semibold">† CPA Action Required — Opening Balance</div>
                    <div>
                      Deferred tax movement is approximated as the closing position because no prior-year
                      deferred tax schedule (opening DTL/DTA) is loaded yet. True movement =
                      closing DTL/DTA minus opening DTL/DTA. Obtain the prior-year schedule before
                      publishing the SCI. Loss-DTA recovery uses a 5% net margin proxy — replace with
                      management's profit forecast per IFRS for SMEs s.29.9.
                    </div>
                    <div className="text-amber-600 font-medium">
                      Primary source: {result.module_d_deferred.ifrs_section} · {result.module_d_deferred.ita_loss_section}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Actions */}
            {phase === "preview" && (
              <div className="flex items-center gap-3 pt-2 flex-wrap">
                <Button onClick={() => setShowConfirm(true)} className="gap-2">
                  <CheckCircle className="w-4 h-4" />
                  Commit Computation
                </Button>
                <Button variant="outline" onClick={reset}>Discard</Button>
                <p className="text-xs text-muted-foreground">
                  Saves ITA waterfall + creates finding in the DB.
                </p>
                {stored && (
                  <div className="w-full mt-1 flex items-center gap-1.5 text-xs text-muted-foreground border border-border rounded px-2 py-1.5 bg-muted/20">
                    <History className="w-3 h-3 flex-shrink-0" />
                    <span className="font-medium">Previous commit:</span>
                    {new Date(stored.created_at).toLocaleString()} —
                    Engine {stored.engine_version ?? "unknown"} —
                    Tax payable TZS {stored.tax_payable_tzs?.toLocaleString() ?? "—"} |
                    Gap TZS {stored.cit_gap_tzs?.toLocaleString() ?? "—"}
                    <span className="ml-1 text-orange-600 font-medium">
                      (Committing will replace this record)
                    </span>
                  </div>
                )}
              </div>
            )}

            {phase === "done" && (
              <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-3">
                <CheckCircle className="w-4 h-4" />
                Computation saved.
                {result.finding_created && " CIT gap finding created in findings table."}
                <Button variant="ghost" size="sm" onClick={reset} className="ml-auto">Run Again</Button>
              </div>
            )}
          </div>
        )}
      </CardContent>

      {/* ── COMMIT CONFIRM DIALOG ─────────────────────────────────── */}
      {result && (
        <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle className="w-5 h-5 text-primary" />
                Confirm — Commit ITA Computation to Database
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-3 text-sm">
              <div className="text-muted-foreground">
                Committing will write the following computation to the <code>tax_computations</code> table
                and create a formal finding record in the audit database.
                {stored && <span className="text-orange-600 font-medium"> This will replace the previous commit from {new Date(stored.created_at).toLocaleDateString()}.</span>}
              </div>

              <div className="bg-muted/40 border border-border rounded-lg p-3 space-y-1.5 font-mono text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Company</span>
                  <span className="font-semibold">{companyName ?? companyId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Period</span>
                  <span>FY {periodYear}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Engine</span>
                  <span>{result.engine_version}</span>
                </div>
                <div className="my-1 border-t border-dashed border-muted" />
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Taxable Income</span>
                  <span>TZS {result.taxable_income_tzs?.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">CIT @ 30%</span>
                  <span>TZS {result.cit_at_30pct_tzs?.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tax Provision (booked)</span>
                  <span>TZS {result.income_tax_provision_tzs?.toLocaleString()}</span>
                </div>
                <div className={`flex justify-between font-bold ${Math.abs(result.cit_gap_tzs) > 500_000 ? "text-destructive" : "text-green-700"}`}>
                  <span>CIT Gap</span>
                  <span>TZS {result.cit_gap_tzs?.toLocaleString()}</span>
                </div>
              </div>

              {result.review_required && (
                <div className="flex items-start gap-2 text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded px-3 py-2">
                  <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                  CPA Review Required — {result.classification_warnings?.length ?? 0} classification warning(s) unresolved.
                  Committing will save this as a provisional computation.
                </div>
              )}
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setShowConfirm(false)}>Cancel</Button>
              <Button
                onClick={() => {
                  setShowConfirm(false);
                  runEngine(false);
                }}
                className="gap-2"
              >
                <CheckCircle className="w-4 h-4" />
                Yes, Commit to Database
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
