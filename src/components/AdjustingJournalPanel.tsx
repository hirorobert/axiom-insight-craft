/**
 * AdjustingJournalPanel.tsx
 * Sprint 5 Item 1 — Iron Dome Nuclear Design
 *
 * Displays and manages Adjusting Journal Entries (AJEs) for a given upload.
 * - Auto-generated AJEs (Module D deferred tax, Module E CIT gap): read-only view
 * - Manual AJEs: postable by preparer/partner; double-entry balance enforced
 * - Approval: partner/owner role only; approved AJEs cannot be edited
 * - Reverse: creates a mirror AJE; does NOT delete (no silent deletes)
 * - All figures from DB only — no AI-hallucinated numbers
 */

import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "sonner";
import {
  BookOpen,
  Plus,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  Clock,
  RotateCcw,
  Zap,
  User,
  AlertTriangle,
  Info,
  Loader2,
  Shield,
} from "lucide-react";

// ── Types ───────────────────────────────────────────────────────────────────

interface AJELine {
  id: string;
  aje_id: string;
  line_number: number;
  account_code: string;
  account_name: string;
  classification: string;
  debit_tzs: number;
  credit_tzs: number;
  narration: string | null;
}

interface AJE {
  id: string;
  company_id: string;
  upload_id: string;
  period_year: number;
  aje_number: string;
  description: string;
  aje_type: string;
  source: string;
  auto_generated: boolean;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  status: "draft" | "approved" | "reversed";
  created_at: string;
  updated_at: string;
  lines?: AJELine[];
}

interface FirmRole {
  role: "owner" | "partner" | "preparer" | "viewer";
}

// Manual AJE line form state
interface ManualLine {
  account_code: string;
  account_name: string;
  classification: string;
  debit_tzs: string;
  credit_tzs: string;
  narration: string;
}

const EMPTY_LINE: ManualLine = {
  account_code: "",
  account_name: "",
  classification: "operating_expenses",
  debit_tzs: "",
  credit_tzs: "",
  narration: "",
};

const CLASSIFICATIONS = [
  { value: "current_assets", label: "Current Assets" },
  { value: "non_current_assets", label: "Non-Current Assets" },
  { value: "current_liabilities", label: "Current Liabilities" },
  { value: "non_current_liabilities", label: "Non-Current Liabilities" },
  { value: "equity", label: "Equity" },
  { value: "revenue", label: "Revenue" },
  { value: "cost_of_goods_sold", label: "Cost of Goods Sold" },
  { value: "operating_expenses", label: "Operating Expenses" },
  { value: "taxes", label: "Taxes" },
  { value: "other_income", label: "Other Income" },
];

const AJE_TYPES = [
  { value: "accrual", label: "Accrual" },
  { value: "reclassification", label: "Reclassification" },
  { value: "tax", label: "Tax Adjustment" },
  { value: "depreciation", label: "Depreciation" },
  { value: "correction", label: "Correction" },
  { value: "deferred_tax", label: "Deferred Tax" },
  { value: "loss_provision", label: "Loss Provision" },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  "TZS " + Math.abs(n).toLocaleString("en-TZ", { maximumFractionDigits: 0 });

const sourceLabel = (source: string) => {
  switch (source) {
    case "kinga_auto": return "Auto (Engine)";
    case "module_d":   return "Module D (Deferred Tax)";
    case "module_e":   return "Module E (CIT Gap)";
    case "cpa_manual": return "Manual (CPA)";
    default:           return source;
  }
};

const typeColor = (aje_type: string) => {
  switch (aje_type) {
    case "tax":          return "bg-amber-100 text-amber-800 border-amber-200";
    case "deferred_tax": return "bg-purple-100 text-purple-800 border-purple-200";
    case "correction":   return "bg-red-100 text-red-800 border-red-200";
    case "accrual":      return "bg-blue-100 text-blue-800 border-blue-200";
    default:             return "bg-slate-100 text-slate-700 border-slate-200";
  }
};

const statusBadge = (status: string) => {
  switch (status) {
    case "approved":
      return <Badge className="bg-emerald-100 text-emerald-800 border border-emerald-200"><CheckCircle className="w-3 h-3 mr-1" />Approved</Badge>;
    case "reversed":
      return <Badge className="bg-slate-200 text-slate-600 border border-slate-300"><RotateCcw className="w-3 h-3 mr-1" />Reversed</Badge>;
    default:
      return <Badge className="bg-amber-100 text-amber-800 border border-amber-200"><Clock className="w-3 h-3 mr-1" />Draft</Badge>;
  }
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  companyId: string;
  uploadId: string;
  periodYear: number;
  companyName?: string;
  userId: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AdjustingJournalPanel({ companyId, uploadId, periodYear, companyName, userId }: Props) {
  const [ajeList, setAjeList] = useState<AJE[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<FirmRole["role"] | null>(null);

  // Manual AJE form state
  const [showForm, setShowForm] = useState(false);
  const [formDesc, setFormDesc] = useState("");
  const [formType, setFormType] = useState("accrual");
  const [formLines, setFormLines] = useState<ManualLine[]>([{ ...EMPTY_LINE }, { ...EMPTY_LINE }]);
  const [submitting, setSubmitting] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  // ── Fetch user role ──────────────────────────────────────────────────────
  useEffect(() => {
    supabase
      .from("firm_members")
      .select("role")
      .eq("company_id", companyId)
      .eq("user_id", userId)
      .maybeSingle()
      .then(({ data }) => setUserRole(data?.role ?? null));
  }, [companyId, userId]);

  // ── Fetch AJEs ───────────────────────────────────────────────────────────
  const fetchAJEs = async () => {
    setLoading(true);
    const { data: ajeData, error } = await supabase
      .from("adjusting_journal_entries")
      .select("*")
      .eq("upload_id", uploadId)
      .order("aje_number", { ascending: true });

    if (error) {
      toast.error("Failed to load adjusting journal entries");
      setLoading(false);
      return;
    }

    if (!ajeData || ajeData.length === 0) {
      setAjeList([]);
      setLoading(false);
      return;
    }

    // Fetch all lines in one query
    const ajeIds = ajeData.map((a) => a.id);
    const { data: lineData } = await supabase
      .from("aje_lines")
      .select("*")
      .in("aje_id", ajeIds)
      .order("line_number", { ascending: true });

    const lineMap = new Map<string, AJELine[]>();
    (lineData ?? []).forEach((l) => {
      if (!lineMap.has(l.aje_id)) lineMap.set(l.aje_id, []);
      lineMap.get(l.aje_id)!.push(l);
    });

    setAjeList(ajeData.map((a) => ({ ...a, lines: lineMap.get(a.id) ?? [] })));
    setLoading(false);
  };

  useEffect(() => { fetchAJEs(); }, [uploadId]);

  // ── Derived totals ────────────────────────────────────────────────────────
  const totals = useMemo(() => {
    const active = ajeList.filter((a) => a.status !== "reversed");
    let totalDr = 0, totalCr = 0;
    active.forEach((a) => {
      (a.lines ?? []).forEach((l) => {
        totalDr += l.debit_tzs;
        totalCr += l.credit_tzs;
      });
    });
    return { count: active.length, totalDr, totalCr };
  }, [ajeList]);

  // ── Manual AJE helpers ────────────────────────────────────────────────────
  const lineDebit = formLines.reduce((s, l) => s + (parseFloat(l.debit_tzs) || 0), 0);
  const lineCrdit = formLines.reduce((s, l) => s + (parseFloat(l.credit_tzs) || 0), 0);
  const balanced = Math.abs(lineDebit - lineCrdit) < 0.01;

  const updateLine = (idx: number, field: keyof ManualLine, value: string) => {
    setFormLines((prev) => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  };

  const addLine = () => setFormLines((p) => [...p, { ...EMPTY_LINE }]);
  const removeLine = (idx: number) => {
    if (formLines.length <= 2) return;
    setFormLines((p) => p.filter((_, i) => i !== idx));
  };

  const resetForm = () => {
    setFormDesc("");
    setFormType("accrual");
    setFormLines([{ ...EMPTY_LINE }, { ...EMPTY_LINE }]);
    setShowForm(false);
  };

  // ── Post manual AJE ──────────────────────────────────────────────────────
  const handleSubmitAJE = async () => {
    if (!formDesc.trim()) { toast.error("Description is required"); return; }
    if (!balanced) { toast.error("Debit total must equal credit total"); return; }
    if (formLines.some(l => !l.account_name.trim())) { toast.error("All lines need an account name"); return; }

    setSubmitting(true);
    try {
      // Next AJE number: AJE-M001, AJE-M002 …
      const manualExisting = ajeList.filter((a) => a.aje_number.startsWith("AJE-M")).length;
      const aje_number = `AJE-M${String(manualExisting + 1).padStart(3, "0")}`;

      const { data: ajeRow, error: ajeErr } = await supabase
        .from("adjusting_journal_entries")
        .insert({
          company_id: companyId,
          upload_id: uploadId,
          period_year: periodYear,
          aje_number,
          description: formDesc.trim(),
          aje_type: formType,
          source: "cpa_manual",
          auto_generated: false,
          created_by: userId,
          status: "draft",
        })
        .select()
        .single();

      if (ajeErr || !ajeRow) throw ajeErr ?? new Error("AJE insert failed");

      const lineInserts = formLines
        .filter(l => l.account_name.trim())
        .map((l, i) => ({
          aje_id: ajeRow.id,
          line_number: i + 1,
          account_code: l.account_code.trim() || `MANUAL-${i + 1}`,
          account_name: l.account_name.trim(),
          classification: l.classification,
          debit_tzs: parseFloat(l.debit_tzs) || 0,
          credit_tzs: parseFloat(l.credit_tzs) || 0,
          narration: l.narration.trim() || null,
        }));

      const { error: lineErr } = await supabase.from("aje_lines").insert(lineInserts);
      if (lineErr) throw lineErr;

      toast.success(`${aje_number} posted successfully`);
      resetForm();
      fetchAJEs();
    } catch (err: any) {
      toast.error("Failed to post AJE: " + (err?.message ?? "Unknown error"));
    } finally {
      setSubmitting(false);
    }
  };

  // ── Approve AJE ──────────────────────────────────────────────────────────
  const handleApprove = async (ajeId: string, ajeNumber: string) => {
    setApprovingId(ajeId);
    const { error } = await supabase
      .from("adjusting_journal_entries")
      .update({ status: "approved", approved_by: userId, approved_at: new Date().toISOString() })
      .eq("id", ajeId);

    if (error) { toast.error("Approval failed: " + error.message); }
    else { toast.success(`${ajeNumber} approved`); fetchAJEs(); }
    setApprovingId(null);
  };

  // ── Reverse AJE ──────────────────────────────────────────────────────────
  const handleReverse = async (aje: AJE) => {
    if (!aje.lines || aje.lines.length === 0) { toast.error("Cannot reverse: no lines found"); return; }

    try {
      const reversedExisting = ajeList.filter((a) => a.aje_number.startsWith("AJE-R")).length;
      const rev_number = `AJE-R${String(reversedExisting + 1).padStart(3, "0")}`;

      const { data: revRow, error: revErr } = await supabase
        .from("adjusting_journal_entries")
        .insert({
          company_id: companyId,
          upload_id: uploadId,
          period_year: periodYear,
          aje_number: rev_number,
          description: `REVERSAL of ${aje.aje_number}: ${aje.description}`,
          aje_type: aje.aje_type,
          source: "cpa_manual",
          auto_generated: false,
          created_by: userId,
          status: "approved",
          approved_by: userId,
          approved_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (revErr || !revRow) throw revErr ?? new Error("Reversal AJE insert failed");

      // Mirror lines: flip Dr ↔ Cr
      const mirrorLines = aje.lines.map((l) => ({
        aje_id: revRow.id,
        line_number: l.line_number,
        account_code: l.account_code,
        account_name: l.account_name,
        classification: l.classification,
        debit_tzs: l.credit_tzs,   // flipped
        credit_tzs: l.debit_tzs,   // flipped
        narration: `REVERSAL — ${l.narration ?? ""}`.trim(),
      }));

      const { error: lineErr } = await supabase.from("aje_lines").insert(mirrorLines);
      if (lineErr) throw lineErr;

      // Mark original as reversed
      await supabase
        .from("adjusting_journal_entries")
        .update({ status: "reversed" })
        .eq("id", aje.id);

      toast.success(`${aje.aje_number} reversed → ${rev_number}`);
      fetchAJEs();
    } catch (err: any) {
      toast.error("Reversal failed: " + (err?.message ?? "Unknown error"));
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const canPost = userRole === "owner" || userRole === "partner" || userRole === "preparer";
  const canApprove = userRole === "owner" || userRole === "partner";

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-indigo-50 border border-indigo-200 flex items-center justify-center">
              <BookOpen className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold text-foreground">
                Adjusting Journal Entries
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {companyName ? `${companyName} · ` : ""}FY{periodYear} — ITA Cap.332 / IAS 8
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canPost && !showForm && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setShowForm(true)}>
                <Plus className="w-3.5 h-3.5" />
                Post Manual AJE
              </Button>
            )}
          </div>
        </div>

        {/* Summary strip */}
        <div className="mt-3 grid grid-cols-3 gap-3">
          <div className="rounded-lg bg-indigo-50 border border-indigo-100 px-3 py-2 text-center">
            <p className="text-xs text-muted-foreground">Active AJEs</p>
            <p className="text-lg font-bold text-indigo-700">{totals.count}</p>
          </div>
          <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-center">
            <p className="text-xs text-muted-foreground">Total Debits</p>
            <p className="text-sm font-semibold text-foreground">{fmt(totals.totalDr)}</p>
          </div>
          <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-center">
            <p className="text-xs text-muted-foreground">Total Credits</p>
            <p className="text-sm font-semibold text-foreground">{fmt(totals.totalCr)}</p>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* ── Manual AJE Form ─────────────────────────────────── */}
        {showForm && (
          <div className="border border-indigo-200 rounded-xl bg-indigo-50/30 p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Plus className="w-4 h-4 text-indigo-600" />
                New Manual AJE
              </h3>
              <Button variant="ghost" size="sm" onClick={resetForm} className="text-xs text-muted-foreground">
                Cancel
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label className="text-xs font-medium">Description *</Label>
                <Input
                  value={formDesc}
                  onChange={(e) => setFormDesc(e.target.value)}
                  placeholder="e.g. Accrue legal fees for Q4 2025"
                  className="mt-1 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs font-medium">AJE Type</Label>
                <Select value={formType} onValueChange={setFormType}>
                  <SelectTrigger className="mt-1 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AJE_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <div className={`rounded-lg px-3 py-2 border text-xs font-medium w-full text-center ${balanced ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-red-50 border-red-200 text-red-700"}`}>
                  {balanced ? "✓ Balanced" : `Imbalance: ${fmt(Math.abs(lineDebit - lineCrdit))}`}
                </div>
              </div>
            </div>

            {/* Lines table */}
            <div className="space-y-2">
              <div className="grid grid-cols-12 gap-1 text-xs font-medium text-muted-foreground px-1">
                <span className="col-span-2">Account Code</span>
                <span className="col-span-3">Account Name *</span>
                <span className="col-span-2">Classification</span>
                <span className="col-span-2">Debit (TZS)</span>
                <span className="col-span-2">Credit (TZS)</span>
                <span className="col-span-1" />
              </div>
              {formLines.map((line, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-1 items-center">
                  <Input
                    className="col-span-2 text-xs h-8"
                    placeholder="1100"
                    value={line.account_code}
                    onChange={(e) => updateLine(idx, "account_code", e.target.value)}
                  />
                  <Input
                    className="col-span-3 text-xs h-8"
                    placeholder="Cash at Bank"
                    value={line.account_name}
                    onChange={(e) => updateLine(idx, "account_name", e.target.value)}
                  />
                  <Select value={line.classification} onValueChange={(v) => updateLine(idx, "classification", v)}>
                    <SelectTrigger className="col-span-2 text-xs h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CLASSIFICATIONS.map((c) => (
                        <SelectItem key={c.value} value={c.value} className="text-xs">{c.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    className="col-span-2 text-xs h-8"
                    placeholder="0"
                    type="number"
                    min={0}
                    value={line.debit_tzs}
                    onChange={(e) => updateLine(idx, "debit_tzs", e.target.value)}
                  />
                  <Input
                    className="col-span-2 text-xs h-8"
                    placeholder="0"
                    type="number"
                    min={0}
                    value={line.credit_tzs}
                    onChange={(e) => updateLine(idx, "credit_tzs", e.target.value)}
                  />
                  <button
                    className="col-span-1 text-xs text-red-500 hover:text-red-700 disabled:opacity-30"
                    onClick={() => removeLine(idx)}
                    disabled={formLines.length <= 2}
                  >✕</button>
                </div>
              ))}
              <Button variant="ghost" size="sm" className="text-xs text-indigo-600 h-7" onClick={addLine}>
                + Add line
              </Button>
            </div>

            <div className="flex items-center gap-2 pt-2 border-t border-indigo-200">
              <Button
                size="sm"
                disabled={!balanced || !formDesc.trim() || submitting}
                onClick={handleSubmitAJE}
                className="bg-indigo-600 hover:bg-indigo-700 text-white gap-1.5"
              >
                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookOpen className="w-3.5 h-3.5" />}
                Post AJE
              </Button>
              <p className="text-xs text-muted-foreground">
                Will be saved as <strong>draft</strong> — requires partner/owner approval to affect statements.
              </p>
            </div>
          </div>
        )}

        {/* ── AJE List ─────────────────────────────────────────── */}
        {loading ? (
          <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading entries…</span>
          </div>
        ) : ajeList.length === 0 ? (
          <div className="text-center py-8">
            <BookOpen className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No adjusting journal entries yet.</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              The tax engine auto-generates AJEs when you commit a tax computation. Manual entries can be posted by preparers and partners.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Auto-generated notice */}
            {ajeList.some((a) => a.auto_generated) && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground bg-indigo-50/50 border border-indigo-100 rounded-lg p-2.5">
                <Zap className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0 mt-0.5" />
                <span>Auto-generated AJEs (Module D/E) are read-only. They reflect the committed tax computation and cannot be edited — only reversed if needed.</span>
              </div>
            )}

            {ajeList.map((aje) => {
              const isExpanded = expandedId === aje.id;
              const totalDr = (aje.lines ?? []).reduce((s, l) => s + l.debit_tzs, 0);
              const totalCr = (aje.lines ?? []).reduce((s, l) => s + l.credit_tzs, 0);

              return (
                <Collapsible
                  key={aje.id}
                  open={isExpanded}
                  onOpenChange={(open) => setExpandedId(open ? aje.id : null)}
                >
                  <div className={`border rounded-xl overflow-hidden ${aje.status === "reversed" ? "opacity-60" : ""}`}>
                    {/* AJE header row */}
                    <CollapsibleTrigger asChild>
                      <div className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors">
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          {isExpanded
                            ? <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                            : <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          }
                          <span className="text-sm font-mono font-semibold text-foreground">{aje.aje_number}</span>
                          <span className="text-sm text-foreground truncate">{aje.description}</span>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${typeColor(aje.aje_type)}`}>
                            {AJE_TYPES.find(t => t.value === aje.aje_type)?.label ?? aje.aje_type}
                          </span>
                          {aje.auto_generated
                            ? <Badge variant="outline" className="text-xs gap-1"><Zap className="w-3 h-3" />Auto</Badge>
                            : <Badge variant="outline" className="text-xs gap-1"><User className="w-3 h-3" />Manual</Badge>
                          }
                          {statusBadge(aje.status)}
                        </div>
                      </div>
                    </CollapsibleTrigger>

                    <CollapsibleContent>
                      <div className="border-t border-border px-4 py-3 space-y-3 bg-muted/10">
                        {/* Meta */}
                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          <span>Source: <span className="font-medium text-foreground">{sourceLabel(aje.source)}</span></span>
                          <span>Posted: <span className="font-medium text-foreground">{new Date(aje.created_at).toLocaleDateString("en-GB")}</span></span>
                          {aje.approved_at && (
                            <span>Approved: <span className="font-medium text-foreground">{new Date(aje.approved_at).toLocaleDateString("en-GB")}</span></span>
                          )}
                        </div>

                        {/* Lines table */}
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs border-collapse">
                            <thead>
                              <tr className="border-b border-border text-muted-foreground">
                                <th className="text-left py-1.5 pr-3 font-medium w-20">Code</th>
                                <th className="text-left py-1.5 pr-3 font-medium">Account</th>
                                <th className="text-left py-1.5 pr-3 font-medium">Classification</th>
                                <th className="text-right py-1.5 pr-3 font-medium w-32">Debit (TZS)</th>
                                <th className="text-right py-1.5 font-medium w-32">Credit (TZS)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(aje.lines ?? []).map((line) => (
                                <tr key={line.id} className="border-b border-border/50 hover:bg-muted/20">
                                  <td className="py-1.5 pr-3 font-mono text-muted-foreground">{line.account_code}</td>
                                  <td className="py-1.5 pr-3 font-medium text-foreground">
                                    {line.account_name}
                                    {line.narration && <span className="text-muted-foreground ml-1 font-normal">— {line.narration}</span>}
                                  </td>
                                  <td className="py-1.5 pr-3 text-muted-foreground capitalize">
                                    {CLASSIFICATIONS.find(c => c.value === line.classification)?.label ?? line.classification}
                                  </td>
                                  <td className="py-1.5 pr-3 text-right font-mono">
                                    {line.debit_tzs > 0 ? line.debit_tzs.toLocaleString() : "—"}
                                  </td>
                                  <td className="py-1.5 text-right font-mono">
                                    {line.credit_tzs > 0 ? line.credit_tzs.toLocaleString() : "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot>
                              <tr className="border-t-2 border-border font-semibold">
                                <td colSpan={3} className="pt-2 text-right text-xs text-muted-foreground">TOTAL</td>
                                <td className="pt-2 pr-3 text-right font-mono text-foreground">{totalDr.toLocaleString()}</td>
                                <td className="pt-2 text-right font-mono text-foreground">{totalCr.toLocaleString()}</td>
                              </tr>
                              {Math.abs(totalDr - totalCr) > 0.01 && (
                                <tr>
                                  <td colSpan={5} className="pt-1">
                                    <div className="flex items-center gap-1 text-xs text-red-600">
                                      <AlertTriangle className="w-3 h-3" />
                                      Imbalance detected: {fmt(Math.abs(totalDr - totalCr))}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </tfoot>
                          </table>
                        </div>

                        {/* Actions */}
                        {aje.status !== "reversed" && (
                          <div className="flex items-center gap-2 pt-1">
                            {/* Approve — partner/owner only, draft only */}
                            {canApprove && aje.status === "draft" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-1.5 text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                                disabled={approvingId === aje.id}
                                onClick={() => handleApprove(aje.id, aje.aje_number)}
                              >
                                {approvingId === aje.id
                                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  : <CheckCircle className="w-3.5 h-3.5" />
                                }
                                Approve
                              </Button>
                            )}

                            {/* Reverse — partner/owner only, approved only */}
                            {canApprove && aje.status === "approved" && (
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button size="sm" variant="outline" className="gap-1.5 text-amber-700 border-amber-300 hover:bg-amber-50">
                                    <RotateCcw className="w-3.5 h-3.5" />
                                    Reverse
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Reverse {aje.aje_number}?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      A mirror AJE will be created (Dr ↔ Cr swapped) and auto-approved. The original will be marked as Reversed. This cannot be undone.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => handleReverse(aje)} className="bg-amber-600 hover:bg-amber-700">
                                      Confirm Reversal
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            )}

                            {aje.status === "draft" && !canApprove && (
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Shield className="w-3.5 h-3.5" />
                                Awaiting partner/owner approval
                              </div>
                            )}

                            {aje.auto_generated && (
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto">
                                <Info className="w-3.5 h-3.5" />
                                Engine-generated — cannot be edited
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </CollapsibleContent>
                  </div>
                </Collapsible>
              );
            })}
          </div>
        )}

        {/* IAS 8 reference footer */}
        <div className="pt-2 border-t border-border/40 text-xs text-muted-foreground/70 flex items-center gap-1.5">
          <BookOpen className="w-3 h-3" />
          AJEs prepared under IAS 8 (Accounting Policies, Changes in Accounting Estimates and Errors). Engine AJEs reference ITA Cap.332 R.E.2023.
        </div>
      </CardContent>
    </Card>
  );
}
