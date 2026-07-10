/**
 * EFDMSReconciliationPanel.tsx
 * Sprint 6 Item 3 — Iron Dome Nuclear Design
 *
 * Manual EFDMS record entry + reconciliation against Kinga findings.
 *
 * Until live TRA EFDMS sync (Roadmap 5G) is confirmed, preparers can:
 *   1. Enter EFDMS reported figures manually from TRA portal exports
 *   2. See how EFDMS amounts compare to what Kinga's engine detected
 *   3. Identify reconciling items (gap = engine exposure − EFDMS reported)
 *
 * Record types covered:
 *   - sales_invoice (revenue per EFDMS)
 *   - purchase_invoice (input VAT per EFDMS)
 *   - sdl_payment (SDL per EFDMS)
 *   - other
 *
 * Iron Dome constraints:
 *   - No delete. Records are permanent (TRA audit trail).
 *   - No silent status changes.
 *   - All figures from DB or explicit user entry — never hallucinated.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  Receipt,
  Plus,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  CheckCircle,
  Info,
  Loader2,
  TrendingDown,
  TrendingUp,
  Lock,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EFDMSRecord {
  id: string;
  efdms_transaction_id: string;
  record_type: string;
  transaction_date: string;
  amount_tzs: number;
  vat_amount_tzs: number;
  counterparty_name: string | null;
  counterparty_tin: string | null;
  efd_device_id: string | null;
  period_year: number;
  period_month: number;
  created_at: string;
}

interface ReconciliationRow {
  category: string;
  label: string;
  efdmsAmount: number;
  kingaAmount: number;
  gap: number;         // kinga − efdms; positive = kinga found MORE
  recordCount: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const RECORD_TYPES = [
  { value: "sales_invoice",    label: "Sales Invoice (Revenue)" },
  { value: "purchase_invoice", label: "Purchase Invoice (Input VAT)" },
  { value: "sdl_payment",      label: "SDL Payment" },
  { value: "other",            label: "Other" },
];

const MONTHS = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  "TZS " + Math.abs(n).toLocaleString("en-TZ", { maximumFractionDigits: 0 });

const gapColor = (gap: number) => {
  if (Math.abs(gap) < 1) return "text-emerald-700";
  if (gap > 0) return "text-red-700";   // Kinga found more — potential exposure
  return "text-amber-700";              // EFDMS higher — investigate
};

const gapLabel = (gap: number) => {
  if (Math.abs(gap) < 1) return "Reconciled";
  if (gap > 0) return `Engine gap: ${fmt(gap)}`;
  return `EFDMS surplus: ${fmt(Math.abs(gap))}`;
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  companyId: string;
  uploadId: string;
  periodYear: number;
  periodMonth: number;
  companyName?: string;
  userId: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function EFDMSReconciliationPanel({
  companyId, uploadId, periodYear, periodMonth, companyName, userId
}: Props) {
  const [records, setRecords] = useState<EFDMSRecord[]>([]);
  const [findings, setFindings] = useState<Array<{ finding_category: string; exposure_amount_tzs: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [expandedRec, setExpandedRec] = useState(false);

  // Form state
  const [fTxnId, setFTxnId] = useState("");
  const [fType, setFType] = useState("sales_invoice");
  const [fDate, setFDate] = useState("");
  const [fAmount, setFAmount] = useState("");
  const [fVat, setFVat] = useState("");
  const [fCounterparty, setFCounterparty] = useState("");
  const [fTin, setFTin] = useState("");
  const [fDevice, setFDevice] = useState("");

  // ── Fetch ──────────────────────────────────────────────────────────────
  const fetchData = async () => {
    setLoading(true);
    const [{ data: recs }, { data: finds }] = await Promise.all([
      supabase
        .from("efdms_records")
        .select("*")
        .eq("company_id", companyId)
        .eq("period_year", periodYear)
        .eq("period_month", periodMonth)
        .order("transaction_date", { ascending: false }),
      supabase
        .from("findings")
        .select("finding_category, exposure_amount_tzs")
        .eq("company_id", companyId)
        .in("status", ["open", "in_progress"]),
    ]);
    setRecords((recs ?? []) as EFDMSRecord[]);
    setFindings((finds ?? []).map(f => ({
      finding_category: f.finding_category,
      exposure_amount_tzs: Number(f.exposure_amount_tzs ?? 0),
    })));
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, [companyId, periodYear, periodMonth]);

  // ── Reconciliation rows ────────────────────────────────────────────────
  const reconciliation: ReconciliationRow[] = [
    {
      category: "revenue",
      label: "Revenue (Sales)",
      efdmsAmount: records.filter(r => r.record_type === "sales_invoice").reduce((s, r) => s + r.amount_tzs, 0),
      kingaAmount: 0, // Revenue isn't a "finding" — it's the income. Just show EFDMS figure.
      gap: 0,
      recordCount: records.filter(r => r.record_type === "sales_invoice").length,
    },
    {
      category: "vat",
      label: "VAT (Output)",
      efdmsAmount: records.filter(r => r.record_type === "sales_invoice").reduce((s, r) => s + (r.vat_amount_tzs ?? 0), 0),
      kingaAmount: findings.filter(f => f.finding_category === "vat_shortfall").reduce((s, f) => s + f.exposure_amount_tzs, 0),
      get gap() { return this.kingaAmount - this.efdmsAmount; },
      recordCount: records.filter(r => r.record_type === "sales_invoice").length,
    },
    {
      category: "sdl",
      label: "SDL Payments",
      efdmsAmount: records.filter(r => r.record_type === "sdl_payment").reduce((s, r) => s + r.amount_tzs, 0),
      kingaAmount: findings.filter(f => f.finding_category === "sdl_shortfall").reduce((s, f) => s + f.exposure_amount_tzs, 0),
      get gap() { return this.kingaAmount - this.efdmsAmount; },
      recordCount: records.filter(r => r.record_type === "sdl_payment").length,
    },
    {
      category: "input_vat",
      label: "Input VAT (Purchases)",
      efdmsAmount: records.filter(r => r.record_type === "purchase_invoice").reduce((s, r) => s + (r.vat_amount_tzs ?? 0), 0),
      kingaAmount: 0,
      gap: 0,
      recordCount: records.filter(r => r.record_type === "purchase_invoice").length,
    },
  ].map(r => ({ ...r, gap: typeof r.gap === 'function' ? (r as any).gap : r.gap }));

  // ── Submit new record ──────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!fTxnId.trim()) { toast.error("Transaction ID is required"); return; }
    if (!fDate) { toast.error("Transaction date is required"); return; }
    if (!fAmount || isNaN(parseFloat(fAmount))) { toast.error("Valid amount required"); return; }

    setSubmitting(true);
    const { error } = await supabase.from("efdms_records").insert({
      company_id: companyId,
      efdms_transaction_id: fTxnId.trim(),
      record_type: fType,
      transaction_date: fDate,
      amount_tzs: parseFloat(fAmount),
      vat_amount_tzs: parseFloat(fVat) || 0,
      counterparty_name: fCounterparty.trim() || null,
      counterparty_tin: fTin.trim() || null,
      efd_device_id: fDevice.trim() || null,
      period_year: periodYear,
      period_month: periodMonth,
      ingested_by: userId,
      source_batch_id: `MANUAL-${uploadId.slice(0, 8)}`,
    });

    if (error) {
      if (error.code === "23505") toast.error("Transaction ID already exists for this period");
      else toast.error("Failed to save: " + error.message);
    } else {
      toast.success("EFDMS record saved");
      setFTxnId(""); setFType("sales_invoice"); setFDate("");
      setFAmount(""); setFVat(""); setFCounterparty(""); setFTin(""); setFDevice("");
      setShowForm(false);
      fetchData();
    }
    setSubmitting(false);
  };

  // ── Totals ─────────────────────────────────────────────────────────────
  const totalEFDMS = records.reduce((s, r) => s + r.amount_tzs, 0);
  const totalVAT = records.reduce((s, r) => s + (r.vat_amount_tzs ?? 0), 0);
  const hasGaps = reconciliation.some(r => Math.abs(r.gap) > 0.01 && r.recordCount > 0);

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-900 flex items-center justify-center">
              <Receipt className="w-5 h-5 text-white" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold text-foreground">
                EFDMS Reconciliation
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {companyName ? `${companyName} · ` : ""}{MONTHS[periodMonth - 1]} {periodYear} — Manual entry + engine comparison
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {hasGaps && (
              <Badge className="bg-amber-100 text-amber-800 border border-amber-200 text-xs gap-1">
                <AlertTriangle className="w-3 h-3" />Gaps detected
              </Badge>
            )}
            {!showForm && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setShowForm(true)}>
                <Plus className="w-3.5 h-3.5" />
                Add EFDMS Record
              </Button>
            )}
          </div>
        </div>

        {/* Summary strip */}
        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2 text-center">
            <p className="text-xs text-muted-foreground">Records</p>
            <p className="text-lg font-bold text-emerald-700">{records.length}</p>
          </div>
          <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-center">
            <p className="text-xs text-muted-foreground">Total EFDMS Amt</p>
            <p className="text-sm font-semibold text-foreground">{fmt(totalEFDMS)}</p>
          </div>
          <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-center">
            <p className="text-xs text-muted-foreground">Total VAT</p>
            <p className="text-sm font-semibold text-foreground">{fmt(totalVAT)}</p>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* ── Manual entry form ─────────────────────────────────────── */}
        {showForm && (
          <div className="border border-emerald-200 rounded-xl bg-emerald-50/30 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Plus className="w-4 h-4 text-emerald-600" />
                New EFDMS Record
              </h3>
              <Button variant="ghost" size="sm" onClick={() => setShowForm(false)} className="text-xs">
                Cancel
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 sm:col-span-1">
                <Label className="text-xs font-medium">Transaction ID *</Label>
                <Input className="mt-1 text-sm" placeholder="EFD-2025-001234" value={fTxnId} onChange={e => setFTxnId(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs font-medium">Record Type</Label>
                <Select value={fType} onValueChange={setFType}>
                  <SelectTrigger className="mt-1 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {RECORD_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs font-medium">Transaction Date *</Label>
                <Input type="date" className="mt-1 text-sm" value={fDate} onChange={e => setFDate(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs font-medium">Amount (TZS) *</Label>
                <Input type="number" min={0} className="mt-1 text-sm" placeholder="0" value={fAmount} onChange={e => setFAmount(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs font-medium">VAT Amount (TZS)</Label>
                <Input type="number" min={0} className="mt-1 text-sm" placeholder="0" value={fVat} onChange={e => setFVat(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs font-medium">Counterparty Name</Label>
                <Input className="mt-1 text-sm" placeholder="Supplier / Customer" value={fCounterparty} onChange={e => setFCounterparty(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs font-medium">Counterparty TIN</Label>
                <Input className="mt-1 text-sm" placeholder="123-456-789" value={fTin} onChange={e => setFTin(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs font-medium">EFD Device ID</Label>
                <Input className="mt-1 text-sm" placeholder="TRA-EFD-001" value={fDevice} onChange={e => setFDevice(e.target.value)} />
              </div>
            </div>

            <div className="flex items-center gap-2 pt-1 border-t border-emerald-200">
              <Button
                size="sm"
                disabled={submitting || !fTxnId || !fDate || !fAmount}
                onClick={handleSubmit}
                className="bg-emerald-700 hover:bg-emerald-800 text-white gap-1.5"
              >
                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Receipt className="w-3.5 h-3.5" />}
                Save Record
              </Button>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock className="w-3 h-3" />
                Records are permanent (TRA audit trail) — no deletion.
              </div>
            </div>
          </div>
        )}

        {/* ── Reconciliation table ───────────────────────────────── */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-foreground">Engine vs EFDMS Reconciliation</h3>
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Info className="w-3 h-3" />
              Gap = Kinga exposure − EFDMS reported
            </div>
          </div>
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/40 border-b border-border">
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground">Category</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">EFDMS</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Kinga Engine</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Gap / Status</th>
                </tr>
              </thead>
              <tbody>
                {reconciliation.map(row => {
                  const isRevenue = row.category === "revenue" || row.category === "input_vat";
                  const gap = isRevenue ? 0 : row.gap;
                  const reconciled = Math.abs(gap) < 0.01;
                  return (
                    <tr key={row.category} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="py-2 px-3 font-medium">
                        {row.label}
                        {row.recordCount > 0 && <span className="text-muted-foreground font-normal ml-1">({row.recordCount} records)</span>}
                      </td>
                      <td className="py-2 px-3 text-right font-mono">{row.efdmsAmount > 0 ? fmt(row.efdmsAmount) : "—"}</td>
                      <td className="py-2 px-3 text-right font-mono">
                        {isRevenue ? <span className="text-muted-foreground">N/A</span> : row.kingaAmount > 0 ? fmt(row.kingaAmount) : "—"}
                      </td>
                      <td className={`py-2 px-3 text-right font-medium ${gapColor(gap)}`}>
                        {isRevenue ? (
                          <span className="text-muted-foreground text-[10px]">Info only</span>
                        ) : reconciled ? (
                          <span className="flex items-center justify-end gap-1"><CheckCircle className="w-3 h-3 text-emerald-500" />Reconciled</span>
                        ) : (
                          <span className="flex items-center justify-end gap-1">
                            {gap > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                            {gapLabel(gap)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Record list ───────────────────────────────────────────── */}
        {loading ? (
          <div className="flex items-center justify-center py-6 gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading EFDMS records…</span>
          </div>
        ) : records.length > 0 && (
          <Collapsible open={expandedRec} onOpenChange={setExpandedRec}>
            <CollapsibleTrigger asChild>
              <button className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground w-full py-1">
                {expandedRec ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                {records.length} EFDMS record{records.length !== 1 ? "s" : ""} for {MONTHS[periodMonth - 1]} {periodYear}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 rounded-xl border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/40 border-b border-border text-muted-foreground">
                      <th className="text-left py-2 px-3 font-medium">Txn ID</th>
                      <th className="text-left py-2 px-3 font-medium">Type</th>
                      <th className="text-left py-2 px-3 font-medium">Date</th>
                      <th className="text-right py-2 px-3 font-medium">Amount</th>
                      <th className="text-right py-2 px-3 font-medium">VAT</th>
                      <th className="text-left py-2 px-3 font-medium hidden sm:table-cell">Counterparty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map(r => (
                      <tr key={r.id} className="border-b border-border/50 hover:bg-muted/20">
                        <td className="py-1.5 px-3 font-mono text-muted-foreground">{r.efdms_transaction_id}</td>
                        <td className="py-1.5 px-3">
                          <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-medium">
                            {RECORD_TYPES.find(t => t.value === r.record_type)?.label.split(" ")[0] ?? r.record_type}
                          </span>
                        </td>
                        <td className="py-1.5 px-3 text-muted-foreground">{r.transaction_date}</td>
                        <td className="py-1.5 px-3 text-right font-mono">{fmt(r.amount_tzs)}</td>
                        <td className="py-1.5 px-3 text-right font-mono">{r.vat_amount_tzs > 0 ? fmt(r.vat_amount_tzs) : "—"}</td>
                        <td className="py-1.5 px-3 text-muted-foreground hidden sm:table-cell truncate max-w-[120px]">
                          {r.counterparty_name ?? "—"}
                          {r.counterparty_tin && <span className="ml-1 text-[10px] opacity-60">({r.counterparty_tin})</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {!loading && records.length === 0 && !showForm && (
          <div className="text-center py-6">
            <Receipt className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No EFDMS records for this period.</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Add records manually from your TRA portal export, or wait for the live EFDMS sync (Roadmap 5G).
            </p>
          </div>
        )}

        {/* Footer */}
        <div className="pt-2 border-t border-border/40 text-xs text-muted-foreground/70 flex items-center gap-1.5">
          <Lock className="w-3 h-3" />
          EFDMS records are permanent and cannot be deleted (TRA audit trail). Contact TRA to correct erroneous device records.
        </div>
      </CardContent>
    </Card>
  );
}
