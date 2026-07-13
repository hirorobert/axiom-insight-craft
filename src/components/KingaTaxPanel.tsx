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
  CheckCircle, Info, Plus, RefreshCw, History, Lock, Unlock,
  TrendingUp, ArrowUpDown, PenLine, Calendar,
} from "lucide-react";
import { TaxLossPanel } from "@/components/TaxLossPanel";
import { HesabuAssurancePanel } from "@/components/HesabuAssurancePanel";
import { generateTaxComputationPDF } from "@/lib/generateTaxComputationPDF";
import { FileDown, ShieldCheck, ShieldX, ShieldAlert } from "lucide-react";

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

// ── MODULE F: Statement of Cash Flows ────────────────────────────────────
interface SCFEngine {
  operating_activities: {
    profit_before_tax_tzs:             number;
    add_depreciation_amortisation_tzs: number;
    add_finance_costs_tzs:             number;
    working_capital_changes: {
      delta_current_assets_excl_cash_tzs: number;
      delta_current_liabilities_tzs:      number;
    };
    cash_generated_from_operations_tzs: number;
    finance_costs_paid_tzs:            number;
    income_taxes_paid_tzs:             number;
    net_cash_from_operating_tzs:       number;
  };
  investing_activities: {
    ppe_additions_tzs:           number;
    ppe_disposal_proceeds_tzs:   number;
    net_cash_from_investing_tzs: number;
  };
  financing_activities: {
    change_in_long_term_debt_tzs: number;
    dividends_paid_tzs:           number;
    net_cash_from_financing_tzs:  number;
  };
  net_change_in_cash_tzs:  number;
  opening_cash_tzs:        number;
  closing_cash_tzs:        number;
  reconciles_to_sfp:       boolean;
  reconciliation_difference_tzs?: number;
  note:                    string;
  cpa_note:                string;
  opening_data_available:  boolean;
  is_first_year_draft:     boolean;   // D9-FIX: true when no prior-year closing balances
  scf_disposal_proceeds_missing?: boolean; // D2-FIX: engine fell back to tax cost for SCF proceeds
}

// ── MODULE G: Statement of Changes in Equity ─────────────────────────────
interface SOCIEEngine {
  share_capital:     { opening_tzs: number; issued_tzs: number;           closing_tzs: number; };
  retained_earnings: { opening_tzs: number; profit_for_year_tzs: number; dividends_declared_tzs: number; closing_tzs: number; };
  other_reserves:    { opening_tzs: number; movement_tzs: number;         closing_tzs: number; };
  total:             { opening_tzs: number; profit_for_year_tzs: number; other_movements_tzs: number; closing_derived_tzs: number; sfp_closing_tzs: number; };
  reconciles_to_sfp:              boolean;
  reconciliation_difference_tzs:  number;
  opening_data_available:         boolean;
  cpa_note:                       string;
}

// ── SIGN-OFF STATE ────────────────────────────────────────────────────────
interface SignOff {
  id?: string;
  status:             string;
  preparer_id?:       string | null;
  preparer_signed_at?: string | null;
  preparer_note?:     string | null;
  reviewer_id?:       string | null;
  reviewer_signed_at?: string | null;
  reviewer_note?:     string | null;
  approver_id?:       string | null;
  approver_signed_at?: string | null;
  approver_note?:     string | null;
  locked_at?:         string | null;
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
  // Module F — Statement of Cash Flows (IFRS for SMEs s.7)
  scf_engine?: SCFEngine;
  // Module G — Statement of Changes in Equity (IFRS for SMEs s.6)
  socie_engine?: SOCIEEngine;
  // Auto-AJEs written on commit
  auto_ajes_created?: number;
  // D3 — Loss pool (ITA s.19)
  opening_cumulative_loss_tzs?: number;
  loss_absorbed_this_year_tzs?: number;
  closing_cumulative_loss_tzs?: number;
  // D8 — AMT 3-year auto-detection
  amt_applies?: boolean;
  amt_computed_tzs?: number;
}

interface CapAllowanceForm {
  asset_description: string;
  ita_class: number;
  cost_tzs: string;
  ita_wdv_opening_tzs: string;
  additions_tzs: string;
  disposals_at_tax_cost_tzs: string;
  disposal_proceeds_tzs: string;   // D2-FIX: actual IFRS SCF proceeds (≠ tax cost)
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
  periodEndMonth?: number;    // D7-FIX: fiscal year-end month (1-12), default 12
  companyName?: string;
  companyTin?: string;        // TRA Tax Identification Number — appears in instalment schedule
  userId: string;
  onResultChange?: (result: TaxResult | null) => void;
}

// D6-FIX: role weights for sign-off tier enforcement
const ROLE_WEIGHT: Record<string, number> = { viewer: 0, preparer: 1, partner: 2, owner: 3 };
const TIER_MIN_WEIGHT: Record<string, number> = {
  preparer: 1,  // preparer, partner, owner can sign as Tier 1
  reviewer: 2,  // only partner or owner for Tier 2
  approver: 2,  // only partner or owner can lock (Tier 3)
};

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
    disposals_at_tax_cost_tzs: "0", disposal_proceeds_tzs: "",
    accounting_depreciation_tzs: "0", source_account: "", notes: "",
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
      disposal_proceeds_tzs:         form.disposal_proceeds_tzs !== "" ? parseNum(form.disposal_proceeds_tzs) : null,
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
      setForm({ asset_description: "", ita_class: 3, cost_tzs: "", ita_wdv_opening_tzs: "", additions_tzs: "0", disposals_at_tax_cost_tzs: "0", disposal_proceeds_tzs: "", accounting_depreciation_tzs: "0", source_account: "", notes: "" });
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
                  <label className="text-xs font-medium text-gray-600">Disposals at Tax Cost / WDV (TZS) — ITA s.34</label>
                  <input className={inputClass} placeholder="0"
                    value={form.disposals_at_tax_cost_tzs} onChange={e => setForm(f => ({ ...f, disposals_at_tax_cost_tzs: e.target.value }))} />
                  <p className="text-xs text-gray-400 mt-0.5">ITA written-down value of disposed asset — for wear &amp; tear pool reduction.</p>
                </div>
              </div>
              {/* D2-FIX: IFRS SCF disposal proceeds — separate from ITA tax cost */}
              <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
                <label className="text-xs font-semibold text-blue-800">Disposal Proceeds — IFRS SCF (TZS)</label>
                <input className={inputClass + " mt-1"} placeholder="Actual cash received on disposal (leave blank if no disposal)"
                  value={form.disposal_proceeds_tzs} onChange={e => setForm(f => ({ ...f, disposal_proceeds_tzs: e.target.value }))} />
                <p className="text-xs text-blue-600 mt-0.5">
                  This is the <strong>actual sale proceeds</strong> for the IFRS Statement of Cash Flows (investing activities).
                  It differs from the tax cost above. If blank and a disposal exists, the engine uses ITA WDV as a fallback and flags a warning.
                </p>
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
  companyId, uploadId, periodYear, periodEndMonth = 12, companyName, companyTin, userId, onResultChange,
}: KingaTaxPanelProps) {
  type Phase = "idle" | "running" | "preview" | "committing" | "done";

  const [phase, setPhase]               = useState<Phase>("idle");
  const [result, setResult]             = useState<TaxResult | null>(null);
  const [showConfirm, setShowConfirm]   = useState(false);
  const [monthsOverdue, setMonthsOverdue] = useState(0);
  const [error, setError]               = useState<string | null>(null);
  const [stored, setStored]             = useState<StoredComputation | null>(null);
  const [signOff, setSignOff]           = useState<SignOff | null>(null);
  const [signOffLoading, setSignOffLoading] = useState(false);
  const [signOffNote, setSignOffNote]   = useState("");
  // D6-FIX: current user's firm_members role (for sign-off enforcement)
  const [firmMemberRole, setFirmMemberRole] = useState<string>("preparer");
  const [firmMemberId, setFirmMemberId]     = useState<string | null>(null);
  // D4-FIX: management inputs (dividends, share capital, loan movements)
  const [mgmtInputs, setMgmtInputs]         = useState({ dividends: "", shareCapital: "", loanRepaid: "", newBorrowings: "", otherEquity: "" });
  const [savingMgmtInputs, setSavingMgmtInputs] = useState(false);

  // HESABU: gate state
  // hesabuGatePassed  — latest validation run has gate_satisfied = true
  // hesabuStale       — latest tax_computations.created_at is AFTER the last validation
  // hesabuRefreshKey  — incremented after engine commit to force HesabuAssurancePanel reload
  const [hesabuGatePassed,  setHesabuGatePassed]  = useState<boolean | null>(null);
  const [hesabuStale,       setHesabuStale]        = useState(false);
  const [hesabuValidating,  setHesabuValidating]   = useState(false);
  const [hesabuError,       setHesabuError]        = useState<string | null>(null);
  const [hesabuRefreshKey,  setHesabuRefreshKey]   = useState(0);

  // HESABU: load gate status from DB (latest validation vs latest computation)
  const loadHesabuStatus = async () => {
    const [{ data: valRow }, { data: compRow }] = await Promise.all([
      supabase
        .from("hesabu_validations")
        .select("gate_satisfied, validated_at")
        .eq("upload_id", uploadId)
        .order("validated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("tax_computations")
        .select("created_at")
        .eq("upload_id", uploadId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (!valRow) {
      setHesabuGatePassed(null);
      setHesabuStale(false);
    } else {
      setHesabuGatePassed(valRow.gate_satisfied);
      // Stale if a newer computation exists after the last validation
      const validatedAt  = new Date(valRow.validated_at).getTime();
      const computedAt   = compRow ? new Date(compRow.created_at).getTime() : 0;
      setHesabuStale(computedAt > validatedAt);
    }
  };

  // HESABU: run hesabu-validate and reload status
  const runHesabuValidation = async () => {
    setHesabuValidating(true);
    setHesabuError(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("hesabu-validate", {
        body: { upload_id: uploadId },
      });
      if (fnErr) throw fnErr;
      if (data?.status === "BLOCKED") throw new Error(data.message ?? "HESABU blocked — missing input data");
      setHesabuGatePassed(data?.gate_satisfied ?? false);
      setHesabuStale(false);
      setHesabuRefreshKey(k => k + 1);
    } catch (e: unknown) {
      setHesabuError(e instanceof Error ? e.message : String(e));
    } finally {
      setHesabuValidating(false);
    }
  };

  // Load existing computation + sign-off state + firm member role + management inputs
  useEffect(() => {
    supabase
      .from("tax_computations")
      .select("id,period_year,taxable_income_tzs,tax_payable_tzs,cit_gap_tzs,total_exposure_tzs,minimum_tax_applies,effective_tax_rate_pct,engine_version,created_at")
      .eq("company_id", companyId).eq("upload_id", uploadId).maybeSingle()
      .then(({ data }) => { if (data) setStored(data); });

    loadHesabuStatus();

    supabase
      .from("statement_sign_offs")
      .select("*")
      .eq("company_id", companyId).eq("period_year", periodYear).maybeSingle()
      .then(({ data }) => { if (data) setSignOff(data as SignOff); });

    // D6-FIX: load current user's role in this company
    supabase
      .from("firm_members")
      .select("id, role")
      .eq("company_id", companyId).eq("user_id", userId).maybeSingle()
      .then(({ data }) => {
        if (data) { setFirmMemberRole(data.role); setFirmMemberId(data.id); }
      });

    // D4-FIX: load saved management inputs if they exist
    supabase
      .from("management_inputs")
      .select("*")
      .eq("company_id", companyId).eq("upload_id", uploadId).maybeSingle()
      .then(({ data }) => {
        if (data) setMgmtInputs({
          dividends:     String(data.dividends_declared_tzs   ?? ""),
          shareCapital:  String(data.share_capital_issued_tzs  ?? ""),
          loanRepaid:    String(data.loan_repayments_tzs       ?? ""),
          newBorrowings: String(data.new_borrowings_tzs        ?? ""),
          otherEquity:   String(data.other_equity_movements_tzs ?? ""),
        });
      });
  }, [companyId, uploadId, periodYear, userId]);

  const handleSign = async (tier: "preparer" | "reviewer" | "approver") => {
    // D6-FIX: enforce minimum role weight for each sign-off tier
    const userWeight = ROLE_WEIGHT[firmMemberRole] ?? 0;
    const requiredWeight = TIER_MIN_WEIGHT[tier] ?? 99;
    if (userWeight < requiredWeight) {
      setError(
        `Role "${firmMemberRole}" cannot sign off as ${tier}. ` +
        `This action requires at least ${tier === "preparer" ? "preparer" : "partner or owner"} role.`
      );
      return;
    }

    setSignOffLoading(true);
    const now = new Date().toISOString();
    const updates: Record<string, string | null> = {
      [`${tier}_id`]:                  userId,
      [`${tier}_signed_at`]:           now,
      [`${tier}_note`]:                signOffNote || null,
      [`${tier}_firm_member_id`]:      firmMemberId,   // D6: audit trail via firm_members FK
    };

    const newStatus =
      tier === "preparer" ? "preparer_signed" :
      tier === "reviewer" ? "reviewer_signed" : "approved";

    if (tier === "approver") {
      updates.locked_at           = now;
      updates.locked_by           = userId;         // legacy: auth.users.id (Phase 1 → 2 transition)
      updates.locked_by_member_id = firmMemberId;   // v2.3: firm_members.id
      updates.status              = "locked";
    } else {
      updates.status = newStatus;
    }

    if (!signOff?.id) {
      // Create the sign-off record first
      const { data: newSO } = await supabase
        .from("statement_sign_offs")
        .insert({
          company_id:  companyId,
          period_year: periodYear,
          upload_id:   uploadId,
          status:      "draft",
          ...updates,
        })
        .select("*")
        .single();
      if (newSO) setSignOff(newSO as SignOff);
    } else {
      const { data: updated } = await supabase
        .from("statement_sign_offs")
        .update(updates)
        .eq("id", signOff.id)
        .select("*")
        .single();
      if (updated) setSignOff(updated as SignOff);
    }
    setSignOffNote("");
    setSignOffLoading(false);
  };

  const isLocked = !!signOff?.locked_at;

  const runEngine = async (dryRun: boolean) => {
    setPhase(dryRun ? "running" : "committing");
    setError(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("kinga-tax-engine", {
        body: { uploadId, companyId, periodYear, periodEndMonth, dry_run: dryRun, months_overdue: monthsOverdue },
        // v2.3: userId removed — kinga-tax-engine derives firmMemberId from JWT internally
      });
      if (fnErr) throw fnErr;
      if (!data?.success) throw new Error(data?.error ?? "Engine returned no result");
      setResult(data.result);
      onResultChange?.(data.result);
      setPhase(dryRun ? "preview" : "done");
      if (!dryRun) {
        // Reload stored computation
        const { data: stored } = await supabase
          .from("tax_computations")
          .select("id,period_year,taxable_income_tzs,tax_payable_tzs,cit_gap_tzs,total_exposure_tzs,minimum_tax_applies,effective_tax_rate_pct,engine_version,created_at")
          .eq("company_id", companyId).eq("upload_id", uploadId).maybeSingle();
        if (stored) setStored(stored);

        // Auto-run HESABU validation after successful commit
        // This keeps the gate status current without requiring a manual step
        await runHesabuValidation();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  const reset = () => { setPhase("idle"); setResult(null); setError(null); };

  // D4-FIX: save management inputs (dividends, share capital, loan movements) before engine run
  const saveMgmtInputs = async () => {
    setSavingMgmtInputs(true);
    const payload = {
      company_id:                  companyId,
      upload_id:                   uploadId,
      period_year:                 periodYear,
      dividends_declared_tzs:      parseFloat(mgmtInputs.dividends || "0") || 0,
      share_capital_issued_tzs:    parseFloat(mgmtInputs.shareCapital || "0") || 0,
      loan_repayments_tzs:         parseFloat(mgmtInputs.loanRepaid || "0") || 0,
      new_borrowings_tzs:          parseFloat(mgmtInputs.newBorrowings || "0") || 0,
      other_equity_movements_tzs:  parseFloat(mgmtInputs.otherEquity || "0") || 0,
      created_by:                  userId,
    };
    await supabase.from("management_inputs").upsert(payload, { onConflict: "company_id,upload_id" });
    setSavingMgmtInputs(false);
  };

  const gapColor = result ? severityColor(result.cit_gap_tzs) : "";
  const exposureLabel = result
    ? result.total_exposure_tzs >= 50_000_000 ? "CRITICAL"
    : result.total_exposure_tzs >= 10_000_000 ? "HIGH"
    : result.total_exposure_tzs >= 1_000_000  ? "MEDIUM" : "LOW"
    : "";

  return (
    <div className="space-y-4">
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-lg flex items-center gap-2 flex-wrap">
            <Calculator className="w-5 h-5 text-primary" />
            Kinga — Corporate Tax (ITA Chapter 332)
            {companyName && <span className="text-sm font-normal text-muted-foreground">· {companyName}</span>}
            <Badge variant="outline" className="text-xs ml-1">FY {periodYear}</Badge>
            {isLocked && (
              <span className="flex items-center gap-1 text-xs bg-red-100 text-red-700 border border-red-300 rounded-full px-2 py-0.5 font-semibold">
                <Lock className="w-3 h-3" /> PERIOD LOCKED
              </span>
            )}
            {signOff && !isLocked && signOff.status !== "draft" && (
              <span className="flex items-center gap-1 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2 py-0.5">
                <PenLine className="w-3 h-3" />
                {signOff.status === "preparer_signed" ? "Preparer signed" :
                 signOff.status === "reviewer_signed" ? "Reviewer signed" :
                 signOff.status === "approved"         ? "Approved" : signOff.status}
              </span>
            )}
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
          <div className="space-y-4">
            {/* D4-FIX: Management Inputs — CPA must fill before running engine */}
            <div className="border border-amber-200 bg-amber-50 rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-2">
                <PenLine className="w-4 h-4 text-amber-600" />
                <span className="text-sm font-semibold text-amber-800">Management Inputs (IFRS for SMEs — SOCIE &amp; SCF Financing)</span>
              </div>
              <p className="text-xs text-amber-700">
                These items cannot be derived from the trial balance. Enter them before running the engine.
                Zeros are used if left blank. Fields are auto-saved when you click Save.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-700">Dividends Declared (TZS)</label>
                  <input className="w-full mt-0.5 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                    placeholder="0" type="number" min="0"
                    value={mgmtInputs.dividends}
                    onChange={e => setMgmtInputs(m => ({ ...m, dividends: e.target.value }))} />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-700">Share Capital Issued (TZS)</label>
                  <input className="w-full mt-0.5 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                    placeholder="0" type="number" min="0"
                    value={mgmtInputs.shareCapital}
                    onChange={e => setMgmtInputs(m => ({ ...m, shareCapital: e.target.value }))} />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-700">Loan Repayments (TZS)</label>
                  <input className="w-full mt-0.5 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                    placeholder="0" type="number" min="0"
                    value={mgmtInputs.loanRepaid}
                    onChange={e => setMgmtInputs(m => ({ ...m, loanRepaid: e.target.value }))} />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-700">New Borrowings (TZS)</label>
                  <input className="w-full mt-0.5 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                    placeholder="0" type="number" min="0"
                    value={mgmtInputs.newBorrowings}
                    onChange={e => setMgmtInputs(m => ({ ...m, newBorrowings: e.target.value }))} />
                </div>
                <div className="col-span-2">
                  <label className="text-xs font-medium text-gray-700">Other Equity Movements / OCI (TZS)</label>
                  <input className="w-full mt-0.5 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                    placeholder="0 — revaluations, FX translation, etc."
                    value={mgmtInputs.otherEquity}
                    onChange={e => setMgmtInputs(m => ({ ...m, otherEquity: e.target.value }))} />
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={saveMgmtInputs} disabled={savingMgmtInputs} className="border-amber-400 text-amber-800 hover:bg-amber-100">
                {savingMgmtInputs ? "Saving…" : "Save Management Inputs"}
              </Button>
            </div>

            {/* Run Engine controls */}
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

                {/* ITA s.19 Loss carry-forward relief */}
                {(result.loss_absorbed_this_year_tzs ?? 0) > 0 && (
                  <div className="mt-2">
                    <div className="text-xs font-semibold text-muted-foreground uppercase px-2 mb-1">DEDUCT: ITA s.19 Loss Relief</div>
                    <WaterfallRow
                      label={`Prior-year loss absorbed (70% cap applied) — opening pool TZS ${fmt(result.opening_cumulative_loss_tzs ?? 0)}`}
                      value={`− ${fmt(result.loss_absorbed_this_year_tzs ?? 0)}`}
                      indent={1}
                    />
                    <WaterfallRow
                      label={`Closing unrelieved loss pool`}
                      value={fmt(result.closing_cumulative_loss_tzs ?? 0)}
                      indent={2}
                    />
                  </div>
                )}

                {result.thin_cap_disallowed_tzs > 0 && (
                  <div className="mt-1">
                    <div className="text-xs font-semibold text-muted-foreground uppercase px-2 mb-1">THIN CAP (ITA s.12(2))</div>
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

            {/* ── ITA s.88 INSTALMENT TAX SCHEDULE ───────────────────────────── */}
            {result.tax_payable_tzs > 0 && (() => {
              // ITA s.88: 4 equal instalments due at end of 3rd, 6th, 9th month
              // of income year and at year-end. Income year starts month after FYE.
              const estTax = result.tax_payable_tzs;
              const instalment = Math.round(estTax / 4);
              // Income year start: month after periodEndMonth
              const startM = (periodEndMonth % 12) + 1;
              const startY = periodEndMonth === 12 ? periodYear : periodYear - 1;
              // Add n months then get last day of that month
              const addM = (m: number, y: number, n: number): string => {
                const total = (y * 12 + m - 1) + n;
                const rm = (total % 12) + 1;
                const ry = Math.floor(total / 12);
                const last = new Date(ry, rm, 0).getDate();
                return `${String(last).padStart(2,"0")}/${String(rm).padStart(2,"0")}/${ry}`;
              };
              const dues = [
                { label: "1st Instalment (3rd month)", date: addM(startM, startY, 3), amount: instalment },
                { label: "2nd Instalment (6th month)", date: addM(startM, startY, 6), amount: instalment },
                { label: "3rd Instalment (9th month)", date: addM(startM, startY, 9), amount: instalment },
                { label: "Final Balance (year-end)",   date: addM(startM, startY, 12), amount: estTax - instalment * 3 },
              ];
              return (
                <div className="border border-[#0E1D30]/20 rounded-xl overflow-hidden">
                  <div className="bg-[#0E1D30]/5 px-3 py-2 border-b border-[#0E1D30]/20 flex items-center gap-2 flex-wrap">
                    <Calendar className="w-3.5 h-3.5 text-[#0E1D30] flex-shrink-0" />
                    <span className="text-xs font-semibold text-[#0E1D30] uppercase tracking-wide">
                      ITA s.88 — Instalment Tax Schedule (FY{periodYear})
                    </span>
                    {companyTin && (
                      <span className="text-[10px] font-mono text-[#0E1D30]/70 bg-[#0E1D30]/10 px-1.5 py-0.5 rounded">
                        TIN: {companyTin}
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      Estimated tax TZS {fmt(estTax)} ÷ 4 equal instalments
                    </span>
                  </div>
                  <div className="p-3">
                    <div className="overflow-hidden rounded-lg border border-border">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-muted/40 border-b border-border">
                            <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Instalment</th>
                            <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Due Date</th>
                            <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Amount (TZS)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {dues.map((d, i) => (
                            <tr key={i} className={i === 3 ? "bg-[#0E1D30]/5 font-semibold" : ""}>
                              <td className="px-3 py-1.5">{d.label}</td>
                              <td className="px-3 py-1.5 font-mono">{d.date}</td>
                              <td className="px-3 py-1.5 text-right font-mono">{fmt(d.amount)}</td>
                            </tr>
                          ))}
                          <tr className="bg-muted/20 font-bold border-t-2 border-border">
                            <td className="px-3 py-2" colSpan={2}>Total Instalment Tax</td>
                            <td className="px-3 py-2 text-right font-mono">{fmt(estTax)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-2">
                      ITA Cap.332 R.E.2023 s.88 — Self-assessment. Late payment: TAA s.76 interest at 5%/month on unpaid balance.
                      Final balance = total tax less instalments paid. Adjust if estimated tax changes during the year.
                    </p>
                  </div>
                </div>
              );
            })()}

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

            {/* ── MODULE F: Statement of Cash Flows ──────────────────────────────── */}
            {result.scf_engine && (
              <div className="border border-blue-200 rounded-xl overflow-hidden">
                <div className="bg-blue-50 px-3 py-2 border-b border-blue-200 flex items-center gap-2">
                  <TrendingUp className="w-3.5 h-3.5 text-blue-700" />
                  <span className="text-xs font-semibold text-blue-800 uppercase tracking-wide">
                    Module F — Statement of Cash Flows (IFRS for SMEs s.7 — Indirect Method)
                  </span>
                  {result.scf_engine.is_first_year_draft && (
                    <span className="ml-auto text-xs text-amber-700 bg-amber-100 border border-amber-300 rounded px-1.5 py-0.5 font-semibold">⚠ First Year — Draft</span>
                  )}
                </div>
                <div className="p-3 space-y-0.5">
                  {/* D9-FIX: mandatory first-year disclaimer */}
                  {result.scf_engine.is_first_year_draft && (
                    <div className="mb-3 rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-1">
                      <div className="font-bold uppercase tracking-wide">⚠ First-Year SCF — Draft Only. Not for Publication.</div>
                      <div>
                        This Statement of Cash Flows is produced for the <strong>first period</strong> in Kinga for this entity.
                        Opening cash, working capital, and balance-sheet movements are <strong>estimated as nil</strong> because
                        no prior-year closing balance is stored in the system. The resulting SCF will not reconcile to the
                        balance sheet and will always show a non-reconciled status.
                      </div>
                      <div>
                        <strong>CPA action required before publication:</strong> Enter the prior-year closing
                        balances (cash, receivables, payables, PPE) via the period registry, run the engine for the
                        prior year first, or manually override the SCF working-capital movements via an AJE.
                        Reference: IFRS for SMEs s.7.7 — comparative statements require consistent period data.
                      </div>
                    </div>
                  )}
                  <div className="text-xs font-semibold text-muted-foreground uppercase px-2 mb-1">OPERATING ACTIVITIES</div>
                  <WaterfallRow label="Profit before tax" value={fmtSigned(result.scf_engine.operating_activities.profit_before_tax_tzs)} indent={1} />
                  <WaterfallRow label="Add: Depreciation & amortisation" value={`+ ${fmt(result.scf_engine.operating_activities.add_depreciation_amortisation_tzs)}`} indent={1} />
                  <WaterfallRow label="Add: Finance costs (reclassified)" value={`+ ${fmt(result.scf_engine.operating_activities.add_finance_costs_tzs)}`} indent={1} />
                  <WaterfallRow label="Δ Working capital assets (excl. cash)" value={fmtSigned(result.scf_engine.operating_activities.working_capital_changes.delta_current_assets_excl_cash_tzs)} indent={1} />
                  <WaterfallRow label="Δ Current liabilities" value={fmtSigned(result.scf_engine.operating_activities.working_capital_changes.delta_current_liabilities_tzs)} indent={1} />
                  <WaterfallRow label="Cash generated from operations" value={fmtSigned(result.scf_engine.operating_activities.cash_generated_from_operations_tzs)} bold highlight />
                  <WaterfallRow label="Finance costs paid" value={fmtSigned(result.scf_engine.operating_activities.finance_costs_paid_tzs)} indent={1} />
                  <WaterfallRow label="Income taxes paid" value={fmtSigned(result.scf_engine.operating_activities.income_taxes_paid_tzs)} indent={1} />
                  <WaterfallRow label="NET CASH FROM OPERATING ACTIVITIES" value={fmtSigned(result.scf_engine.operating_activities.net_cash_from_operating_tzs)} bold highlight />

                  <div className="text-xs font-semibold text-muted-foreground uppercase px-2 mb-1 mt-3">INVESTING ACTIVITIES</div>
                  <WaterfallRow label="PPE additions / capex" value={fmtSigned(result.scf_engine.investing_activities.ppe_additions_tzs)} indent={1} />
                  <WaterfallRow label="PPE disposal proceeds" value={fmtSigned(result.scf_engine.investing_activities.ppe_disposal_proceeds_tzs)} indent={1} />
                  {result.scf_engine.scf_disposal_proceeds_missing && (
                    <div className="mx-2 mt-0.5 mb-1 text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded px-2 py-1">
                      ⚠ D2 Warning: One or more asset disposals have no IFRS proceeds entered. Engine used ITA tax cost (WDV) as fallback.
                      Enter actual sale proceeds in the capital allowance modal for each disposed asset.
                    </div>
                  )}
                  <WaterfallRow label="NET CASH FROM INVESTING ACTIVITIES" value={fmtSigned(result.scf_engine.investing_activities.net_cash_from_investing_tzs)} bold highlight />

                  <div className="text-xs font-semibold text-muted-foreground uppercase px-2 mb-1 mt-3">FINANCING ACTIVITIES</div>
                  <WaterfallRow label="Δ Long-term borrowings" value={fmtSigned(result.scf_engine.financing_activities.change_in_long_term_debt_tzs)} indent={1} />
                  <WaterfallRow label="Dividends paid" value={fmtSigned(result.scf_engine.financing_activities.dividends_paid_tzs)} indent={1} />
                  <WaterfallRow label="NET CASH FROM FINANCING ACTIVITIES" value={fmtSigned(result.scf_engine.financing_activities.net_cash_from_financing_tzs)} bold highlight />

                  <div className="my-2 border-t border-dashed border-blue-200 mx-2" />
                  <WaterfallRow label="NET INCREASE/(DECREASE) IN CASH" value={fmtSigned(result.scf_engine.net_change_in_cash_tzs)} bold />
                  <WaterfallRow label="Opening cash & bank" value={fmt(result.scf_engine.opening_cash_tzs)} indent={1} />
                  <WaterfallRow label="CLOSING CASH & BANK (per SFP)" value={fmt(result.scf_engine.closing_cash_tzs)} bold highlight />

                  <div className={`mt-3 mx-1 text-xs rounded-lg px-3 py-2 space-y-1 ${
                    result.scf_engine.reconciles_to_sfp
                      ? "text-green-800 bg-green-50 border border-green-200"
                      : "text-orange-800 bg-orange-50 border border-orange-200"
                  }`}>
                    <div className="font-semibold">
                      {result.scf_engine.reconciles_to_sfp
                        ? "✓ Reconciles to SFP cash balance"
                        : "⚠ SCF does not reconcile — review cash account classification"}
                    </div>
                    <div className="text-xs">{result.scf_engine.cpa_note}</div>
                  </div>
                </div>
              </div>
            )}

            {/* ── MODULE G: Statement of Changes in Equity ───────────────────────── */}
            {result.socie_engine && (
              <div className="border border-emerald-200 rounded-xl overflow-hidden">
                <div className="bg-emerald-50 px-3 py-2 border-b border-emerald-200 flex items-center gap-2">
                  <ArrowUpDown className="w-3.5 h-3.5 text-emerald-700" />
                  <span className="text-xs font-semibold text-emerald-800 uppercase tracking-wide">
                    Module G — Statement of Changes in Equity (IFRS for SMEs s.6)
                  </span>
                  {!result.socie_engine.opening_data_available && (
                    <span className="ml-auto text-xs text-emerald-600 bg-emerald-100 rounded px-1.5 py-0.5">First year — opening = closing detected</span>
                  )}
                </div>
                <div className="p-3 space-y-0.5">
                  {/* mini table */}
                  <div className="grid grid-cols-5 text-xs font-semibold text-muted-foreground uppercase px-2 mb-1 gap-1">
                    <span className="col-span-2"></span>
                    <span className="text-right">Share Cap</span>
                    <span className="text-right">Ret. Earn.</span>
                    <span className="text-right">Total</span>
                  </div>
                  {[
                    { label: "Opening balance",   a: result.socie_engine.share_capital.opening_tzs, b: result.socie_engine.retained_earnings.opening_tzs, t: result.socie_engine.total.opening_tzs, bold: false },
                    { label: "Profit for year",   a: 0, b: result.socie_engine.retained_earnings.profit_for_year_tzs, t: result.socie_engine.total.profit_for_year_tzs, bold: true },
                    { label: "Dividends declared",a: 0, b: result.socie_engine.retained_earnings.dividends_declared_tzs, t: result.socie_engine.retained_earnings.dividends_declared_tzs, bold: false },
                    { label: "Share cap. issued", a: result.socie_engine.share_capital.issued_tzs, b: 0, t: result.socie_engine.share_capital.issued_tzs, bold: false },
                    { label: "Closing balance",   a: result.socie_engine.share_capital.closing_tzs, b: result.socie_engine.retained_earnings.closing_tzs, t: result.socie_engine.total.closing_derived_tzs, bold: true },
                  ].map((row, i) => (
                    <div key={i} className={`grid grid-cols-5 text-xs py-1 px-2 rounded gap-1 ${row.bold ? "bg-muted/60 font-semibold" : ""}`}>
                      <span className="col-span-2 text-foreground">{row.label}</span>
                      <span className="text-right font-mono text-muted-foreground">{row.a !== 0 ? fmtSigned(row.a) : "—"}</span>
                      <span className="text-right font-mono text-muted-foreground">{row.b !== 0 ? fmtSigned(row.b) : "—"}</span>
                      <span className="text-right font-mono">{fmtSigned(row.t)}</span>
                    </div>
                  ))}
                  <div className={`mt-3 mx-1 text-xs rounded-lg px-3 py-2 ${
                    result.socie_engine.reconciles_to_sfp
                      ? "text-green-800 bg-green-50 border border-green-200"
                      : "text-orange-800 bg-orange-50 border border-orange-200"
                  }`}>
                    {result.socie_engine.reconciles_to_sfp
                      ? `✓ Closing equity reconciles to SFP equity balance (TZS ${result.socie_engine.total.sfp_closing_tzs.toLocaleString()}).`
                      : `⚠ Closing equity does not reconcile — difference TZS ${result.socie_engine.reconciliation_difference_tzs.toLocaleString()}. ` + result.socie_engine.cpa_note
                    }
                  </div>
                </div>
              </div>
            )}

            {/* ── HESABU ASSURANCE PANEL ─────────────────────────────────────────── */}
            {(phase === "done" || stored) && (
              <div className="space-y-2">
                <HesabuAssurancePanel
                  uploadId={uploadId}
                  companyId={companyId}
                  refreshKey={hesabuRefreshKey}
                />
                {/* HESABU gate controls */}
                {!isLocked && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {hesabuGatePassed === null && (
                      <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
                        <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0" />
                        No HESABU validation yet — sign-off is blocked until validation passes.
                      </div>
                    )}
                    {hesabuGatePassed === false && (
                      <div className="flex items-center gap-1.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">
                        <ShieldX className="w-3.5 h-3.5 flex-shrink-0" />
                        HESABU validation failed — resolve all assertions before signing off.
                      </div>
                    )}
                    {hesabuStale && hesabuGatePassed && (
                      <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
                        <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0" />
                        Tax computation has changed since last validation — rerun before signing off.
                      </div>
                    )}
                    {hesabuError && (
                      <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">
                        HESABU error: {hesabuError}
                      </div>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs h-7 gap-1.5 ml-auto"
                      onClick={runHesabuValidation}
                      disabled={hesabuValidating}
                    >
                      {hesabuValidating
                        ? <><RefreshCw className="w-3 h-3 animate-spin" />Validating…</>
                        : <><ShieldCheck className="w-3 h-3" />Run HESABU Validation</>
                      }
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* ── SIGN-OFF CHAIN + PERIOD LOCK ───────────────────────────────────── */}
            {(phase === "done" || stored) && (
              <div className={`border rounded-xl overflow-hidden ${isLocked ? "border-red-300" : "border-slate-200"}`}>
                <div className={`px-3 py-2 border-b flex items-center gap-2 ${isLocked ? "bg-red-50 border-red-300" : "bg-slate-50 border-slate-200"}`}>
                  {isLocked ? <Lock className="w-3.5 h-3.5 text-red-700" /> : <PenLine className="w-3.5 h-3.5 text-slate-600" />}
                  <span className={`text-xs font-semibold uppercase tracking-wide ${isLocked ? "text-red-800" : "text-slate-700"}`}>
                    {isLocked ? "Period Locked — Statements Signed Off" : "CPA Sign-Off Chain"}
                  </span>
                  {isLocked && (
                    <span className="ml-auto text-xs text-red-600">Locked {signOff?.locked_at ? new Date(signOff.locked_at).toLocaleDateString() : ""}</span>
                  )}
                </div>
                <div className="p-3 space-y-2">
                  {[
                    {
                      tier: "preparer" as const,
                      label: "Tier 1 — Preparer",
                      signed: !!signOff?.preparer_signed_at,
                      at: signOff?.preparer_signed_at,
                      // HESABU gate: Tier 1 requires gate_satisfied=true and not stale
                      enabled: !signOff?.preparer_signed_at && !isLocked
                               && hesabuGatePassed === true && !hesabuStale,
                    },
                    {
                      tier: "reviewer" as const,
                      label: "Tier 2 — Reviewer",
                      signed: !!signOff?.reviewer_signed_at,
                      at: signOff?.reviewer_signed_at,
                      enabled: !!signOff?.preparer_signed_at && !signOff?.reviewer_signed_at && !isLocked,
                    },
                    {
                      tier: "approver" as const,
                      label: "Tier 3 — Approver ★ Lock Period",
                      signed: !!signOff?.approver_signed_at,
                      at: signOff?.approver_signed_at,
                      enabled: !!signOff?.reviewer_signed_at && !signOff?.approver_signed_at && !isLocked,
                    },
                  ].map(({ tier, label, signed, at, enabled }) => (
                    <div key={tier} className={`flex items-center gap-3 text-xs rounded-lg px-3 py-2 ${signed ? "bg-green-50 border border-green-200" : enabled ? "bg-white border border-slate-200" : "bg-muted/20 border border-muted text-muted-foreground"}`}>
                      {signed
                        ? <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />
                        : <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${enabled ? "border-blue-400" : "border-gray-300"}`} />
                      }
                      <div className="flex-1">
                        <span className={`font-semibold ${signed ? "text-green-800" : enabled ? "text-foreground" : "text-muted-foreground"}`}>{label}</span>
                        {signed && at && (
                          <span className="ml-2 text-green-600">— signed {new Date(at).toLocaleDateString()}</span>
                        )}
                        {/* Show HESABU gate reason when Tier 1 is blocked */}
                        {tier === "preparer" && !signed && !isLocked && (
                          hesabuGatePassed === null ? (
                            <span className="ml-2 text-amber-600">— awaiting HESABU validation</span>
                          ) : hesabuGatePassed === false ? (
                            <span className="ml-2 text-red-600">— HESABU gate failed</span>
                          ) : hesabuStale ? (
                            <span className="ml-2 text-amber-600">— HESABU validation is stale (rerun required)</span>
                          ) : null
                        )}
                      </div>
                      {enabled && !isLocked && (
                        <Button
                          size="sm"
                          variant={tier === "approver" ? "default" : "outline"}
                          className={`text-xs h-7 gap-1 ${tier === "approver" ? "bg-red-600 hover:bg-red-700" : ""}`}
                          onClick={() => handleSign(tier)}
                          disabled={signOffLoading}
                        >
                          {tier === "approver" ? <Lock className="w-3 h-3" /> : <PenLine className="w-3 h-3" />}
                          {tier === "approver" ? "Approve & Lock" : "Sign"}
                        </Button>
                      )}
                    </div>
                  ))}
                  {!isLocked && (
                    <div className="mt-1">
                      <input
                        className="w-full text-xs border border-input rounded px-2 py-1.5"
                        placeholder="Optional note for this signature…"
                        value={signOffNote}
                        onChange={e => setSignOffNote(e.target.value)}
                      />
                    </div>
                  )}
                  {isLocked && (
                    <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                      <strong>Period is LOCKED.</strong> Financial statements are signed off and immutable.
                      New trial balance uploads for FY{periodYear} are blocked at the database level.
                      To reopen, unlock via Supabase admin with explicit CPA authorisation.
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Auto-AJE notice */}
            {result.auto_ajes_created && result.auto_ajes_created > 0 && (
              <div className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                ✓ {result.auto_ajes_created} adjusting journal entr{result.auto_ajes_created === 1 ? "y" : "ies"} auto-generated
                (AJE-E001 = CIT gap, AJE-D001 = Deferred Tax). Review and approve in the AJE register.
              </div>
            )}

            {/* Actions */}
            {phase === "preview" && (
              <div className="flex items-center gap-3 pt-2 flex-wrap">
                <Button onClick={() => setShowConfirm(true)} className="gap-2">
                  <CheckCircle className="w-4 h-4" />
                  Commit Computation
                </Button>
                <Button
                  variant="outline"
                  className="gap-1.5"
                  onClick={async () => {
                    const [{ data: allowances }, { data: findings }] = await Promise.all([
                      supabase
                        .from("capital_allowances")
                        .select("asset_description, ita_class, cost_tzs, ita_wdv_opening_tzs, additions_tzs, disposals_at_tax_cost_tzs, wear_tear_allowance_tzs, ita_wdv_closing_tzs")
                        .eq("upload_id", uploadId),
                      supabase
                        .from("findings")
                        .select("title, finding_category, exposure_amount_tzs, status")
                        .eq("company_id", companyId)
                        .in("status", ["open", "in_progress"]),
                    ]);
                    generateTaxComputationPDF({
                      result,
                      companyName: companyName ?? "Company",
                      companyTin,
                      periodYear,
                      periodEndMonth: periodEndMonth ?? 12,
                      allowances: (allowances ?? []) as Parameters<typeof generateTaxComputationPDF>[0]["allowances"],
                      findings:   (findings   ?? []) as Parameters<typeof generateTaxComputationPDF>[0]["findings"],
                    });
                  }}
                >
                  <FileDown className="w-3.5 h-3.5" />
                  Download PDF
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
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-3">
                  <CheckCircle className="w-4 h-4" />
                  Computation saved.
                  {result.finding_created && " CIT gap finding created in findings table."}
                  <Button variant="ghost" size="sm" onClick={reset} className="ml-auto">Run Again</Button>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 w-full"
                  onClick={async () => {
                    // Fetch supporting data for the PDF
                    const [{ data: allowances }, { data: findings }] = await Promise.all([
                      supabase
                        .from("capital_allowances")
                        .select("asset_description, ita_class, cost_tzs, ita_wdv_opening_tzs, additions_tzs, disposals_at_tax_cost_tzs, wear_tear_allowance_tzs, ita_wdv_closing_tzs")
                        .eq("upload_id", uploadId),
                      supabase
                        .from("findings")
                        .select("title, finding_category, exposure_amount_tzs, status")
                        .eq("company_id", companyId)
                        .in("status", ["open", "in_progress"]),
                    ]);
                    generateTaxComputationPDF({
                      result,
                      companyName: companyName ?? "Company",
                      companyTin,
                      periodYear,
                      periodEndMonth: periodEndMonth ?? 12,
                      allowances: (allowances ?? []) as Parameters<typeof generateTaxComputationPDF>[0]["allowances"],
                      findings:   (findings   ?? []) as Parameters<typeof generateTaxComputationPDF>[0]["findings"],
                    });
                  }}
                >
                  <FileDown className="w-3.5 h-3.5" />
                  Download Tax Computation Report (PDF)
                </Button>
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

    {/* ── ITA s.19 LOSS CARRY-FORWARD POOL PANEL ──────────────── */}
    {result && (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <TaxLossPanel result={result as any} periodYear={periodYear} companyName={companyName} />
    )}
    </div>
  );
}
