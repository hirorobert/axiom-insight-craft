/**
 * CapitalAllowancesRegister.tsx
 * Sprint 8 Item 1 — Iron Dome Nuclear Design
 *
 * Full asset-by-asset ITA Chapter 332 s.34 Wear & Tear register.
 *
 * Groups assets by ITA class. Per row shows:
 *   cost | opening WDV | additions | disposals | W&T | closing WDV | accounting dep'n
 *
 * Class subtotals + grand total at bottom.
 *
 * Add Asset form:
 *   - asset_description, ita_class, cost_tzs, ita_wdv_opening_tzs,
 *     additions_tzs, disposals_at_tax_cost_tzs, accounting_depreciation_tzs,
 *     source_account, notes
 *
 * Iron Dome constraints:
 *   - No delete. Assets marked as disposed via disposals_at_tax_cost_tzs.
 *   - W&T and closing WDV are auto-computed by kinga-tax-engine on next run.
 *     CPA can see current stored values here.
 *   - All figures from capital_allowances table.
 */

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "sonner";
import {
  Calculator,
  Plus,
  ChevronDown,
  ChevronRight,
  Loader2,
  Download,
  Lock,
  RefreshCw,
} from "lucide-react";

// ── Constants ─────────────────────────────────────────────────────────────────

const ITA_CLASSES = [
  { value: 1, label: "Class 1 — Computers, phones, tech",              rate: "37.5% RB",           rateNum: 0.375, method: "RB" },
  { value: 2, label: "Class 2 — Plant & machinery (general)",          rate: "25% RB",              rateNum: 0.25,  method: "RB" },
  { value: 3, label: "Class 3 — General assets",                       rate: "12.5% RB",            rateNum: 0.125, method: "RB" },
  { value: 5, label: "Class 5 — Agricultural buildings",               rate: "20% SL on cost",      rateNum: 0.20,  method: "SL" },
  { value: 6, label: "Class 6 — Commercial buildings",                 rate: "5% SL on cost",       rateNum: 0.05,  method: "SL" },
  { value: 7, label: "Class 7 — Intangibles (1/useful life SL)",       rate: "1/useful life SL",    rateNum: null,  method: "SL" },
  { value: 8, label: "Class 8 — Agricultural plant (100% immediate)",  rate: "100% immediate",      rateNum: 1.0,   method: "SL" },
] as const;

const CLASS_COLORS: Record<number, string> = {
  1: "text-blue-700 bg-blue-50",
  2: "text-indigo-700 bg-indigo-50",
  3: "text-violet-700 bg-violet-50",
  5: "text-emerald-700 bg-emerald-50",
  6: "text-teal-700 bg-teal-50",
  7: "text-amber-700 bg-amber-50",
  8: "text-orange-700 bg-orange-50",
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface Asset {
  id: string;
  asset_description: string;
  ita_class: number;
  cost_tzs: number;
  ita_wdv_opening_tzs: number;
  additions_tzs: number;
  disposals_at_tax_cost_tzs: number;
  wear_tear_tzs: number;
  ita_wdv_closing_tzs: number;
  accounting_depreciation_tzs: number;
  source_account: string | null;
  notes: string | null;
  created_at: string;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  companyId: string;
  uploadId: string;
  periodYear: number;
  companyName?: string;
  userId: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n: number) => n === 0 ? "—" : n.toLocaleString("en-TZ", { maximumFractionDigits: 0 });
const parseTZS = (s: string) => parseFloat(s.replace(/,/g, "")) || 0;

// ── Component ─────────────────────────────────────────────────────────────────

export function CapitalAllowancesRegister({
  companyId, uploadId, periodYear, companyName, userId
}: Props) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [expandedClasses, setExpandedClasses] = useState<Set<number>>(new Set([1, 2, 3]));

  // Form state
  const [fDesc, setFDesc] = useState("");
  const [fClass, setFClass] = useState<string>("1");
  const [fCost, setFCost] = useState("");
  const [fOpenWDV, setFOpenWDV] = useState("");
  const [fAdditions, setFAdditions] = useState("");
  const [fDisposals, setFDisposals] = useState("");
  const [fAccDep, setFAccDep] = useState("");
  const [fSourceAccount, setFSourceAccount] = useState("");
  const [fNotes, setFNotes] = useState("");

  const fetchAssets = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("capital_allowances")
      .select("*")
      .eq("company_id", companyId)
      .eq("period_year", periodYear)
      .order("ita_class")
      .order("created_at");
    setAssets((data ?? []) as Asset[]);
    setLoading(false);
  }, [companyId, periodYear]);

  useEffect(() => { fetchAssets(); }, [fetchAssets]);

  // ── Submit new asset ───────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!fDesc.trim()) { toast.error("Asset description required"); return; }
    if (!fCost) { toast.error("Cost required"); return; }

    setSubmitting(true);
    const classNum = parseInt(fClass);
    const classInfo = ITA_CLASSES.find(c => c.value === classNum);
    const cost     = parseTZS(fCost);
    const openWDV  = parseTZS(fOpenWDV) || cost; // default opening WDV = cost if first year
    const additions = parseTZS(fAdditions);
    const disposals = parseTZS(fDisposals);
    const accDep   = parseTZS(fAccDep);

    // Pre-compute W&T for display (engine will recompute on next run)
    let wearTear = 0;
    if (classInfo && classInfo.rateNum !== null) {
      if (classInfo.method === "RB") {
        const pool = openWDV + additions - disposals;
        wearTear = pool * classInfo.rateNum;
      } else {
        wearTear = cost * classInfo.rateNum;
      }
    }
    const closingWDV = Math.max(0, openWDV + additions - disposals - wearTear);

    const { error } = await supabase.from("capital_allowances").insert({
      company_id: companyId,
      upload_id: uploadId,
      period_year: periodYear,
      asset_description: fDesc.trim(),
      ita_class: classNum,
      cost_tzs: cost,
      ita_wdv_opening_tzs: openWDV,
      additions_tzs: additions,
      disposals_at_tax_cost_tzs: disposals,
      wear_tear_tzs: wearTear,
      ita_wdv_closing_tzs: closingWDV,
      accounting_depreciation_tzs: accDep,
      source_account: fSourceAccount.trim() || null,
      notes: fNotes.trim() || null,
      created_by: userId,
    });

    if (error) {
      toast.error("Failed to save: " + error.message);
    } else {
      toast.success(`Asset added — W&T: TZS ${fmt(wearTear)} (${classInfo?.rate})`);
      setFDesc(""); setFClass("1"); setFCost(""); setFOpenWDV(""); setFAdditions("");
      setFDisposals(""); setFAccDep(""); setFSourceAccount(""); setFNotes("");
      setShowForm(false);
      fetchAssets();
    }
    setSubmitting(false);
  };

  // ── CSV export ─────────────────────────────────────────────────────────────
  const handleExport = () => {
    const header = "Asset,Class,Rate,Cost TZS,Opening WDV,Additions,Disposals,W&T,Closing WDV,Acc Dep'n,Notes";
    const rows = assets.map(a => {
      const cls = ITA_CLASSES.find(c => c.value === a.ita_class);
      return [
        `"${a.asset_description}"`,
        `Class ${a.ita_class}`,
        cls?.rate ?? "",
        a.cost_tzs, a.ita_wdv_opening_tzs, a.additions_tzs,
        a.disposals_at_tax_cost_tzs, a.wear_tear_tzs,
        a.ita_wdv_closing_tzs, a.accounting_depreciation_tzs,
        `"${a.notes ?? ""}"`,
      ].join(",");
    });
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `capital_allowances_${companyName?.replace(/\s+/g, "_") ?? companyId}_FY${periodYear}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV downloaded");
  };

  // ── Group by class ─────────────────────────────────────────────────────────
  const byClass = ITA_CLASSES.map(cls => ({
    cls,
    assets: assets.filter(a => a.ita_class === cls.value),
  })).filter(g => g.assets.length > 0);

  // Grand totals
  const grand = {
    cost:       assets.reduce((s, a) => s + a.cost_tzs, 0),
    openWDV:    assets.reduce((s, a) => s + a.ita_wdv_opening_tzs, 0),
    additions:  assets.reduce((s, a) => s + a.additions_tzs, 0),
    disposals:  assets.reduce((s, a) => s + a.disposals_at_tax_cost_tzs, 0),
    wearTear:   assets.reduce((s, a) => s + a.wear_tear_tzs, 0),
    closingWDV: assets.reduce((s, a) => s + a.ita_wdv_closing_tzs, 0),
    accDep:     assets.reduce((s, a) => s + a.accounting_depreciation_tzs, 0),
  };

  const addBackDiff = grand.accDep - grand.wearTear; // positive = add back, negative = deduction

  const toggleClass = (cls: number) => {
    setExpandedClasses(prev => {
      const next = new Set(prev);
      next.has(cls) ? next.delete(cls) : next.add(cls);
      return next;
    });
  };

  return (
    <Card className="bg-card border-border">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CollapsibleTrigger asChild>
              <button className="flex items-center gap-3 text-left">
                <div className="w-9 h-9 rounded-lg bg-violet-900 flex items-center justify-center flex-shrink-0">
                  <Calculator className="w-5 h-5 text-white" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base font-semibold text-foreground">
                      Capital Allowances Register
                    </CardTitle>
                    {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {companyName ? `${companyName} · ` : ""}FY{periodYear} — ITA s.34 Wear & Tear schedule · {assets.length} asset{assets.length !== 1 ? "s" : ""}
                  </p>
                </div>
              </button>
            </CollapsibleTrigger>
            <div className="flex items-center gap-2">
              {assets.length > 0 && (
                <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={handleExport}>
                  <Download className="w-3.5 h-3.5" />CSV
                </Button>
              )}
              <button onClick={fetchAssets} className="p-1 rounded hover:bg-muted/50 text-muted-foreground">
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
              {!showForm && (
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setShowForm(true)}>
                  <Plus className="w-3.5 h-3.5" />Add Asset
                </Button>
              )}
            </div>
          </div>

          {/* KPI strip */}
          {!loading && assets.length > 0 && (
            <div className="mt-3 grid grid-cols-4 gap-2">
              <div className="rounded-lg bg-muted/30 border border-border px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground">Total W&T Deduction</p>
                <p className="text-sm font-bold text-violet-700">TZS {fmt(grand.wearTear)}</p>
              </div>
              <div className="rounded-lg bg-muted/30 border border-border px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground">Closing WDV Pool</p>
                <p className="text-sm font-semibold text-foreground">TZS {fmt(grand.closingWDV)}</p>
              </div>
              <div className="rounded-lg bg-muted/30 border border-border px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground">Acc Dep'n (TB)</p>
                <p className="text-sm font-semibold text-foreground">TZS {fmt(grand.accDep)}</p>
              </div>
              <div className={`rounded-lg border px-3 py-2 text-center ${addBackDiff >= 0 ? "bg-amber-50 border-amber-200" : "bg-emerald-50 border-emerald-200"}`}>
                <p className="text-xs text-muted-foreground">
                  {addBackDiff >= 0 ? "Add-back to PBT" : "Extra deduction"}
                </p>
                <p className={`text-sm font-semibold ${addBackDiff >= 0 ? "text-amber-700" : "text-emerald-700"}`}>
                  TZS {fmt(Math.abs(addBackDiff))}
                </p>
              </div>
            </div>
          )}
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="space-y-4 pt-0">
            {/* ── Add Asset form ────────────────────────────────────── */}
            {showForm && (
              <div className="border border-violet-200 rounded-xl bg-violet-50/30 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <Plus className="w-4 h-4 text-violet-600" />New Asset
                  </h3>
                  <Button variant="ghost" size="sm" onClick={() => setShowForm(false)} className="text-xs">Cancel</Button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <Label className="text-xs font-medium">Asset Description *</Label>
                    <Input className="mt-1 text-sm" placeholder="e.g. Dell Laptop × 3, Toyota Hiace van" value={fDesc} onChange={e => setFDesc(e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs font-medium">ITA Class *</Label>
                    <Select value={fClass} onValueChange={setFClass}>
                      <SelectTrigger className="mt-1 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {ITA_CLASSES.map(c => (
                          <SelectItem key={c.value} value={String(c.value)}>
                            {c.label} ({c.rate})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs font-medium">Cost (TZS) *</Label>
                    <Input type="number" min={0} className="mt-1 text-sm" placeholder="0" value={fCost} onChange={e => setFCost(e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs font-medium">Opening ITA WDV (TZS)</Label>
                    <Input type="number" min={0} className="mt-1 text-sm" placeholder="= cost if first year" value={fOpenWDV} onChange={e => setFOpenWDV(e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs font-medium">Additions this year (TZS)</Label>
                    <Input type="number" min={0} className="mt-1 text-sm" placeholder="0" value={fAdditions} onChange={e => setFAdditions(e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs font-medium">Disposals at tax cost (TZS)</Label>
                    <Input type="number" min={0} className="mt-1 text-sm" placeholder="0" value={fDisposals} onChange={e => setFDisposals(e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs font-medium">Accounting Depreciation (TB) (TZS)</Label>
                    <Input type="number" min={0} className="mt-1 text-sm" placeholder="0" value={fAccDep} onChange={e => setFAccDep(e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs font-medium">Source TB Account</Label>
                    <Input className="mt-1 text-sm" placeholder="e.g. 1400 — Plant & Equipment" value={fSourceAccount} onChange={e => setFSourceAccount(e.target.value)} />
                  </div>
                  <div className="col-span-2">
                    <Label className="text-xs font-medium">Notes</Label>
                    <Textarea className="mt-1 text-sm" rows={2} placeholder="e.g. Disposed Dec 2024 — tax cost TZS X" value={fNotes} onChange={e => setFNotes(e.target.value)} />
                  </div>
                </div>
                <div className="flex items-center gap-2 pt-1 border-t border-violet-200">
                  <Button
                    size="sm"
                    disabled={submitting || !fDesc || !fCost}
                    onClick={handleSubmit}
                    className="bg-violet-700 hover:bg-violet-800 text-white gap-1.5"
                  >
                    {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Calculator className="w-3.5 h-3.5" />}
                    Save & Compute W&T
                  </Button>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Lock className="w-3 h-3" />
                    W&T auto-computed. Kinga engine re-verifies on next run.
                  </p>
                </div>
              </div>
            )}

            {/* ── Asset register by class ───────────────────────────── */}
            {loading ? (
              <div className="flex items-center gap-2 py-6 justify-center text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading register…</span>
              </div>
            ) : assets.length === 0 && !showForm ? (
              <div className="text-center py-8">
                <Calculator className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No assets in register for FY{periodYear}.</p>
                <p className="text-xs text-muted-foreground/70 mt-1">Add assets manually or run the Kinga Tax Engine — it auto-populates Class 1–3 assets from the trial balance.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {byClass.map(({ cls, assets: clsAssets }) => {
                  const sub = {
                    cost:      clsAssets.reduce((s, a) => s + a.cost_tzs, 0),
                    openWDV:   clsAssets.reduce((s, a) => s + a.ita_wdv_opening_tzs, 0),
                    additions: clsAssets.reduce((s, a) => s + a.additions_tzs, 0),
                    disposals: clsAssets.reduce((s, a) => s + a.disposals_at_tax_cost_tzs, 0),
                    wearTear:  clsAssets.reduce((s, a) => s + a.wear_tear_tzs, 0),
                    closingWDV:clsAssets.reduce((s, a) => s + a.ita_wdv_closing_tzs, 0),
                    accDep:    clsAssets.reduce((s, a) => s + a.accounting_depreciation_tzs, 0),
                  };
                  const isExpanded = expandedClasses.has(cls.value);
                  const colorCls = CLASS_COLORS[cls.value] ?? "text-slate-700 bg-slate-50";
                  return (
                    <div key={cls.value} className="rounded-xl border border-border overflow-hidden">
                      {/* Class header */}
                      <button
                        className="w-full flex items-center justify-between px-4 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors"
                        onClick={() => toggleClass(cls.value)}
                      >
                        <div className="flex items-center gap-2">
                          {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded ${colorCls}`}>
                            Class {cls.value}
                          </span>
                          <span className="text-xs text-muted-foreground">{cls.rate}</span>
                          <span className="text-xs text-muted-foreground">({clsAssets.length} asset{clsAssets.length !== 1 ? "s" : ""})</span>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-right">
                          <span className="text-muted-foreground">W&T: <span className={`font-semibold ${colorCls.split(" ")[0]}`}>TZS {fmt(sub.wearTear)}</span></span>
                          <span className="text-muted-foreground">Closing WDV: <span className="font-semibold text-foreground">TZS {fmt(sub.closingWDV)}</span></span>
                        </div>
                      </button>

                      {/* Asset rows */}
                      {isExpanded && (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs min-w-[750px]">
                            <thead>
                              <tr className="border-b border-border text-muted-foreground bg-muted/10">
                                <th className="text-left py-2 px-3 font-medium">Asset</th>
                                <th className="text-right py-2 px-3 font-medium">Cost</th>
                                <th className="text-right py-2 px-3 font-medium">Open WDV</th>
                                <th className="text-right py-2 px-3 font-medium">Additions</th>
                                <th className="text-right py-2 px-3 font-medium">Disposals</th>
                                <th className="text-right py-2 px-3 font-medium">W&T</th>
                                <th className="text-right py-2 px-3 font-medium">Closing WDV</th>
                                <th className="text-right py-2 px-3 font-medium">Acc Dep</th>
                              </tr>
                            </thead>
                            <tbody>
                              {clsAssets.map(a => (
                                <tr key={a.id} className="border-b border-border/50 hover:bg-muted/20">
                                  <td className="py-1.5 px-3">
                                    <span className="font-medium text-foreground">{a.asset_description}</span>
                                    {a.source_account && <span className="text-muted-foreground/60 ml-1 text-[10px]">({a.source_account})</span>}
                                    {a.notes && <p className="text-[10px] text-muted-foreground/60 italic mt-0.5">{a.notes}</p>}
                                  </td>
                                  <td className="py-1.5 px-3 text-right font-mono">{fmt(a.cost_tzs)}</td>
                                  <td className="py-1.5 px-3 text-right font-mono">{fmt(a.ita_wdv_opening_tzs)}</td>
                                  <td className="py-1.5 px-3 text-right font-mono">{fmt(a.additions_tzs)}</td>
                                  <td className="py-1.5 px-3 text-right font-mono">{a.disposals_at_tax_cost_tzs > 0 ? `(${fmt(a.disposals_at_tax_cost_tzs)})` : "—"}</td>
                                  <td className={`py-1.5 px-3 text-right font-mono font-semibold ${colorCls.split(" ")[0]}`}>{fmt(a.wear_tear_tzs)}</td>
                                  <td className="py-1.5 px-3 text-right font-mono font-semibold text-foreground">{fmt(a.ita_wdv_closing_tzs)}</td>
                                  <td className="py-1.5 px-3 text-right font-mono text-muted-foreground">{fmt(a.accounting_depreciation_tzs)}</td>
                                </tr>
                              ))}
                              {/* Class subtotal */}
                              <tr className="bg-muted/20 border-t border-border font-semibold text-xs">
                                <td className="py-1.5 px-3 text-muted-foreground">Class {cls.value} total</td>
                                <td className="py-1.5 px-3 text-right font-mono">{fmt(sub.cost)}</td>
                                <td className="py-1.5 px-3 text-right font-mono">{fmt(sub.openWDV)}</td>
                                <td className="py-1.5 px-3 text-right font-mono">{fmt(sub.additions)}</td>
                                <td className="py-1.5 px-3 text-right font-mono">{sub.disposals > 0 ? `(${fmt(sub.disposals)})` : "—"}</td>
                                <td className={`py-1.5 px-3 text-right font-mono ${colorCls.split(" ")[0]}`}>{fmt(sub.wearTear)}</td>
                                <td className="py-1.5 px-3 text-right font-mono">{fmt(sub.closingWDV)}</td>
                                <td className="py-1.5 px-3 text-right font-mono text-muted-foreground">{fmt(sub.accDep)}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Grand total */}
                {byClass.length > 1 && (
                  <div className="rounded-xl border-2 border-violet-200 bg-violet-50/30 overflow-hidden">
                    <table className="w-full text-xs min-w-[750px]">
                      <tbody>
                        <tr className="font-bold text-foreground">
                          <td className="py-2.5 px-3">Grand Total — All Classes</td>
                          <td className="py-2.5 px-3 text-right font-mono">TZS {fmt(grand.cost)}</td>
                          <td className="py-2.5 px-3 text-right font-mono">TZS {fmt(grand.openWDV)}</td>
                          <td className="py-2.5 px-3 text-right font-mono">{grand.additions > 0 ? `TZS ${fmt(grand.additions)}` : "—"}</td>
                          <td className="py-2.5 px-3 text-right font-mono">{grand.disposals > 0 ? `(TZS ${fmt(grand.disposals)})` : "—"}</td>
                          <td className="py-2.5 px-3 text-right font-mono text-violet-700">TZS {fmt(grand.wearTear)}</td>
                          <td className="py-2.5 px-3 text-right font-mono">TZS {fmt(grand.closingWDV)}</td>
                          <td className="py-2.5 px-3 text-right font-mono text-muted-foreground">TZS {fmt(grand.accDep)}</td>
                        </tr>
                        <tr className="border-t border-violet-200 text-xs">
                          <td colSpan={8} className="py-2 px-3 text-muted-foreground">
                            ITA add-back: accounting dep'n TZS {fmt(grand.accDep)} − tax W&T TZS {fmt(grand.wearTear)} = {addBackDiff >= 0 ? "add-back" : "extra deduction"} TZS {fmt(Math.abs(addBackDiff))} to accounting PBT.
                            Verified by kinga-tax-engine on each run.
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Footer */}
            <p className="text-[10px] text-muted-foreground/60 border-t border-border/40 pt-2 flex items-center gap-1">
              <Lock className="w-3 h-3 flex-shrink-0" />
              Assets cannot be deleted (Iron Dome audit trail). Record disposals via the Disposals field. Class 4 assets are not recognised under ITA since Finance Act 2016.
            </p>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
