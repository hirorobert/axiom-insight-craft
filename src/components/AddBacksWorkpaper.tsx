/**
 * AddBacksWorkpaper.tsx
 * Sprint 8 Item 3 — Iron Dome Nuclear Design
 *
 * ITA Chapter 332 Tax Adjustment Schedule — full add-backs and deductions workpaper.
 *
 * Reads add_backs JSONB + deductions JSONB from latest tax_computations.
 * Each element: { description, amount_tzs, ita_section, account_names[], auto_detected }
 *
 * Displays:
 *   Section A — Add-backs to accounting PBT
 *   Section B — Deductions from accounting PBT
 *   Section C — Wear & Tear (ITA s.34) total
 *   Net impact → Taxable Income
 *
 * CPA can add manual line items (appended via UPDATE to tax_computations JSONB).
 * Auto-detected lines are shown with badge and cannot be removed (Iron Dome).
 *
 * Iron Dome constraints:
 *   - No deletion of auto-detected lines
 *   - Manual lines marked with { auto_detected: false, added_by: userId }
 *   - JSONB append via UPDATE — does not change other computation fields
 */

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "sonner";
import {
  FileText,
  Plus,
  ChevronDown,
  ChevronRight,
  Loader2,
  Lock,
  Printer,
  Zap,
  User,
  RefreshCw,
} from "lucide-react";

// ── ITA section references ─────────────────────────────────────────────────────

const ITA_SECTIONS = [
  { value: "s.11",  label: "s.11 — Non-deductible expenditure (fines, penalties)" },
  { value: "s.11(2)",label:"s.11(2) — Entertainment (non-deductible)" },
  { value: "s.19(2)",label:"s.19(2) — Loss carry-forward utilisation" },
  { value: "s.24A", label: "s.24A — Thin cap interest disallowance" },
  { value: "s.33",  label: "s.33 — Management fees (arm's length)" },
  { value: "s.34",  label: "s.34 — Wear & tear (tax depreciation)" },
  { value: "s.65",  label: "s.65 — Minimum tax (AMT)" },
  { value: "s.76",  label: "TAA s.76 — Penalty on late payment" },
  { value: "other", label: "Other (specify in description)" },
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdjItem {
  description: string;
  amount_tzs: number;
  ita_section?: string;
  account_names?: string[];
  auto_detected?: boolean;
  added_by?: string;
}

interface CompData {
  id: string;
  accounting_profit_before_tax_tzs: number | null;
  add_backs: AdjItem[];
  deductions: AdjItem[];
  total_add_backs_tzs: number;
  total_deductions_tzs: number;
  total_wear_tear_tzs: number;
  taxable_income_tzs: number | null;
  cit_at_30pct_tzs: number | null;
  is_committed: boolean;
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

const fmt = (n: number) =>
  "TZS " + Math.abs(n).toLocaleString("en-TZ", { maximumFractionDigits: 0 });

// ── Component ─────────────────────────────────────────────────────────────────

export function AddBacksWorkpaper({ companyId, uploadId, periodYear, companyName, userId }: Props) {
  const [comp, setComp] = useState<CompData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formType, setFormType] = useState<"add_back" | "deduction">("add_back");
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [fDesc, setFDesc] = useState("");
  const [fAmount, setFAmount] = useState("");
  const [fSection, setFSection] = useState("other");

  const fetchComp = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("tax_computations")
      .select("id, accounting_profit_before_tax_tzs, add_backs, deductions, total_add_backs_tzs, total_deductions_tzs, total_wear_tear_tzs, taxable_income_tzs, cit_at_30pct_tzs, is_committed")
      .eq("company_id", companyId)
      .eq("upload_id", uploadId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (data?.[0]) {
      setComp({
        id: data[0].id,
        accounting_profit_before_tax_tzs: data[0].accounting_profit_before_tax_tzs !== null ? Number(data[0].accounting_profit_before_tax_tzs) : null,
        add_backs: (data[0].add_backs as AdjItem[]) ?? [],
        deductions: (data[0].deductions as AdjItem[]) ?? [],
        total_add_backs_tzs: Number(data[0].total_add_backs_tzs ?? 0),
        total_deductions_tzs: Number(data[0].total_deductions_tzs ?? 0),
        total_wear_tear_tzs: Number(data[0].total_wear_tear_tzs ?? 0),
        taxable_income_tzs: data[0].taxable_income_tzs !== null ? Number(data[0].taxable_income_tzs) : null,
        cit_at_30pct_tzs: data[0].cit_at_30pct_tzs !== null ? Number(data[0].cit_at_30pct_tzs) : null,
        is_committed: Boolean(data[0].is_committed),
      });
    }
    setLoading(false);
  }, [companyId, uploadId]);

  useEffect(() => { fetchComp(); }, [fetchComp]);

  // ── Add manual line ────────────────────────────────────────────────────────
  const handleAddLine = async () => {
    if (!fDesc.trim()) { toast.error("Description required"); return; }
    if (!fAmount || isNaN(parseFloat(fAmount))) { toast.error("Valid amount required"); return; }
    if (!comp) return;

    setSubmitting(true);
    const newItem: AdjItem = {
      description: fDesc.trim(),
      amount_tzs: parseFloat(fAmount),
      ita_section: fSection,
      auto_detected: false,
      added_by: userId,
    };

    const field = formType === "add_back" ? "add_backs" : "deductions";
    const existing: AdjItem[] = formType === "add_back" ? comp.add_backs : comp.deductions;
    const updated = [...existing, newItem];

    // Recompute totals
    const newAddBacks   = formType === "add_back" ? updated : comp.add_backs;
    const newDeductions = formType === "deduction" ? updated : comp.deductions;
    const newTotalAB    = newAddBacks.reduce((s, i) => s + i.amount_tzs, 0);
    const newTotalDed   = newDeductions.reduce((s, i) => s + i.amount_tzs, 0);
    const pbt           = comp.accounting_profit_before_tax_tzs ?? 0;
    const newTaxableInc = pbt + newTotalAB - newTotalDed - comp.total_wear_tear_tzs;
    const newCIT        = Math.max(0, newTaxableInc) * 0.30;

    const { error } = await supabase
      .from("tax_computations")
      .update({
        [field]: updated,
        [`total_${field === "add_backs" ? "add_backs" : "deductions"}_tzs`]: field === "add_backs" ? newTotalAB : newTotalDed,
        taxable_income_tzs: newTaxableInc,
        cit_at_30pct_tzs: newCIT,
        // Note: is_committed is NOT changed — this is a CPA adjustment, not a re-run
      })
      .eq("id", comp.id);

    if (error) {
      toast.error("Failed to save: " + error.message);
    } else {
      toast.success(`Manual ${formType === "add_back" ? "add-back" : "deduction"} saved — taxable income updated`);
      setFDesc(""); setFAmount(""); setFSection("other"); setShowForm(false);
      fetchComp();
    }
    setSubmitting(false);
  };

  if (!comp && !loading) return null;

  const pbt = comp?.accounting_profit_before_tax_tzs ?? 0;
  const taxInc = comp?.taxable_income_tzs ?? 0;
  const cit = comp?.cit_at_30pct_tzs ?? 0;

  const AdjTable = ({ items, type }: { items: AdjItem[]; type: "add_back" | "deduction" }) => (
    <div className="rounded-xl border border-border overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/40 border-b border-border text-muted-foreground">
            <th className="text-left py-2 px-3 font-medium">Description</th>
            <th className="text-left py-2 px-3 font-medium hidden sm:table-cell">ITA Reference</th>
            <th className="text-right py-2 px-3 font-medium">Amount (TZS)</th>
            <th className="text-center py-2 px-3 font-medium">Source</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={4} className="py-4 text-center text-muted-foreground text-xs">
                No {type === "add_back" ? "add-backs" : "deductions"} — engine found none, and no manual entries yet.
              </td>
            </tr>
          ) : (
            items.map((item, i) => (
              <tr key={i} className="border-b border-border/50 hover:bg-muted/20">
                <td className="py-2 px-3 text-foreground">
                  {item.description}
                  {item.account_names?.length ? (
                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">{item.account_names.join(", ")}</p>
                  ) : null}
                </td>
                <td className="py-2 px-3 text-muted-foreground hidden sm:table-cell">{item.ita_section ?? "—"}</td>
                <td className={`py-2 px-3 text-right font-mono font-medium ${type === "add_back" ? "text-amber-700" : "text-emerald-700"}`}>
                  {fmt(item.amount_tzs)}
                </td>
                <td className="py-2 px-3 text-center">
                  {item.auto_detected !== false ? (
                    <Badge className="bg-blue-100 text-blue-800 border-blue-200 border text-[10px] gap-1 px-1.5">
                      <Zap className="w-2.5 h-2.5" />Auto
                    </Badge>
                  ) : (
                    <Badge className="bg-slate-100 text-slate-700 border-slate-200 border text-[10px] gap-1 px-1.5">
                      <User className="w-2.5 h-2.5" />Manual
                    </Badge>
                  )}
                </td>
              </tr>
            ))
          )}
          {items.length > 0 && (
            <tr className="bg-muted/30 border-t border-border font-semibold text-xs">
              <td colSpan={2} className="py-2 px-3 text-foreground">
                Total {type === "add_back" ? "Add-backs" : "Deductions"}
              </td>
              <td className={`py-2 px-3 text-right font-mono ${type === "add_back" ? "text-amber-700" : "text-emerald-700"}`}>
                {fmt(items.reduce((s, i) => s + i.amount_tzs, 0))}
              </td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <Card className="bg-card border-border">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CollapsibleTrigger asChild>
              <button className="flex items-center gap-3 text-left">
                <div className="w-9 h-9 rounded-lg bg-teal-900 flex items-center justify-center flex-shrink-0">
                  <FileText className="w-5 h-5 text-white" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base font-semibold text-foreground">
                      Tax Adjustment Schedule
                    </CardTitle>
                    {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {companyName ? `${companyName} · ` : ""}FY{periodYear} — ITA add-backs & deductions workpaper
                  </p>
                </div>
              </button>
            </CollapsibleTrigger>
            <div className="flex items-center gap-2">
              {comp?.is_committed && (
                <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200 border text-xs">Committed</Badge>
              )}
              <button onClick={fetchComp} className="p-1 rounded hover:bg-muted/50 text-muted-foreground">
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
              <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => window.print()}>
                <Printer className="w-3.5 h-3.5" />Print
              </Button>
            </div>
          </div>
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="space-y-5 pt-0">
            {loading ? (
              <div className="flex items-center gap-2 py-6 justify-center text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading tax computation…</span>
              </div>
            ) : !comp ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                No tax computation found for this period. Run the Kinga Tax Engine first.
              </div>
            ) : (
              <>
                {/* Add manual line form */}
                {showForm ? (
                  <div className="border border-teal-200 rounded-xl bg-teal-50/30 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                        <Plus className="w-4 h-4 text-teal-600" />Add Manual Adjustment
                      </h3>
                      <Button variant="ghost" size="sm" onClick={() => setShowForm(false)} className="text-xs">Cancel</Button>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs font-medium">Type</Label>
                        <Select value={formType} onValueChange={v => setFormType(v as "add_back" | "deduction")}>
                          <SelectTrigger className="mt-1 text-sm"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="add_back">Add-back (increases taxable income)</SelectItem>
                            <SelectItem value="deduction">Deduction (reduces taxable income)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-xs font-medium">ITA Reference</Label>
                        <Select value={fSection} onValueChange={setFSection}>
                          <SelectTrigger className="mt-1 text-sm"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {ITA_SECTIONS.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="col-span-2">
                        <Label className="text-xs font-medium">Description *</Label>
                        <Input className="mt-1 text-sm" placeholder="e.g. Disallowed management fee — exceeds arm's length" value={fDesc} onChange={e => setFDesc(e.target.value)} />
                      </div>
                      <div>
                        <Label className="text-xs font-medium">Amount (TZS) *</Label>
                        <Input type="number" min={0} className="mt-1 text-sm" placeholder="0" value={fAmount} onChange={e => setFAmount(e.target.value)} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 pt-1 border-t border-teal-200">
                      <Button
                        size="sm"
                        disabled={submitting || !fDesc || !fAmount}
                        onClick={handleAddLine}
                        className="bg-teal-700 hover:bg-teal-800 text-white gap-1.5"
                      >
                        {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                        Save Adjustment
                      </Button>
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Lock className="w-3 h-3" />
                        Auto-detected lines cannot be removed (Iron Dome).
                      </p>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => setShowForm(true)}>
                    <Plus className="w-3.5 h-3.5" />Add Manual Adjustment
                  </Button>
                )}

                {/* Section A — Add-backs */}
                <div className="space-y-1.5">
                  <h3 className="text-xs font-semibold text-foreground uppercase tracking-wide text-amber-700">
                    Section A — Add-backs to Accounting PBT
                  </h3>
                  <AdjTable items={comp.add_backs} type="add_back" />
                </div>

                {/* Section B — Deductions */}
                <div className="space-y-1.5">
                  <h3 className="text-xs font-semibold text-foreground uppercase tracking-wide text-emerald-700">
                    Section B — Deductions from Accounting PBT
                  </h3>
                  <AdjTable items={comp.deductions} type="deduction" />
                </div>

                {/* Section C — Summary waterfall */}
                <div className="space-y-1.5">
                  <h3 className="text-xs font-semibold text-foreground uppercase tracking-wide">
                    Section C — Taxable Income Waterfall
                  </h3>
                  <div className="rounded-xl border border-border overflow-hidden">
                    <table className="w-full text-sm">
                      <tbody>
                        {[
                          { label: "Accounting profit before tax (PBT)", value: pbt, note: "From trial balance", bold: false },
                          { label: "Add: total add-backs (Section A)", value: comp.total_add_backs_tzs, note: "ITA non-deductibles", bold: false, plus: true, amber: true },
                          { label: "Less: deductions (Section B)", value: -comp.total_deductions_tzs, note: "ITA allowances", bold: false, green: true },
                          { label: "Less: wear & tear (ITA s.34)", value: -comp.total_wear_tear_tzs, note: "Capital Allowances Register", bold: false, green: true, divider: true },
                          { label: "Taxable Income", value: taxInc, note: "Subject to 30% CIT", bold: true, divider: true },
                          { label: "Corporate Income Tax (30% × max(0, TI))", value: cit, note: "ITA Chapter 332, R.E. 2023", bold: true, highlight: true },
                        ].map((row, i) => (
                          <tr key={i} className={`border-b border-border/50 ${(row as any).divider ? "border-b-2 border-border" : ""} ${(row as any).highlight ? "bg-slate-50" : ""}`}>
                            <td className={`py-2.5 px-4 ${(row as any).bold ? "font-semibold" : ""} text-foreground`}>{row.label}</td>
                            <td className={`py-2.5 px-4 text-right font-mono ${(row as any).bold ? "font-bold" : ""} ${(row as any).amber ? "text-amber-700" : (row as any).green ? "text-emerald-700" : "text-foreground"}`}>
                              {row.value < 0 ? `(${fmt(Math.abs(row.value))})` : fmt(row.value)}
                            </td>
                            <td className="py-2.5 px-4 text-xs text-muted-foreground hidden sm:table-cell">{row.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Footer */}
                <p className="text-[10px] text-muted-foreground/70 border-t border-border/40 pt-2 flex items-center gap-1">
                  <Lock className="w-3 h-3 flex-shrink-0" />
                  Auto-detected adjustments ({comp.add_backs.filter(i => i.auto_detected !== false).length + comp.deductions.filter(i => i.auto_detected !== false).length} lines) cannot be removed. Manual adjustments are appended and marked with user ID. Kinga engine re-runs will refresh auto-detected lines only.
                </p>
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
