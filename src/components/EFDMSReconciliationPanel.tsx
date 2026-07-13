/**
 * EFDMSReconciliationPanel.tsx
 * Sprint 6 Item 3 — Iron Dome Nuclear Design
 *
 * Manual Z-Report entry + reconciliation against Kinga tax engine output.
 *
 * REMEDIATION B (2026-07-13): Fixed to write Z-Report rows through
 * safisha-efdms-ingest (Iron Dome gatekeeper) and read from efdms_z_reports
 * + efdms_reconciliation, replacing the broken direct writes to efdms_records.
 *
 * Only shown when isVatRegistered = true (non-VAT companies have no EFDMS obligation).
 *
 * Iron Dome constraints:
 *   - No direct table writes from this component (all writes via safisha-efdms-ingest).
 *   - No delete. Z-Reports are permanent (TRA audit trail).
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

/** Matches efdms_z_reports schema */
interface EFDMSZReport {
  id:               string;
  serial_number:    string;
  trader_tin:       string;
  report_date:      string;
  gross_sales:      number;
  net_sales:        number;
  vat_collected:    number;
  exempt_sales:     number;
  zero_rated_sales: number;
  receipt_count:    number;
  cancelled_count:  number;
  import_source:    string;
  created_at:       string;
}

interface ReconciliationRow {
  category:     string;
  label:        string;
  efdmsAmount:  number;
  kingaAmount:  number;
  gap:          number;   // kinga − efdms; positive = kinga found MORE
  recordCount:  number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

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

// Period date range helpers
const periodStart = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, "0")}-01`;
const periodEnd = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, "0")}-31`;

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  companyId:        string;
  uploadId:         string;
  periodYear:       number;
  periodMonth:      number;
  companyName?:     string;
  userId:           string;
  isVatRegistered:  boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function EFDMSReconciliationPanel({
  companyId, uploadId, periodYear, periodMonth, companyName, userId, isVatRegistered,
}: Props) {
  // Not shown for non-VAT-registered companies — no EFDMS obligation
  if (!isVatRegistered) return null;

  const [records,     setRecords]     = useState<EFDMSZReport[]>([]);
  const [findings,    setFindings]    = useState<Array<{ finding_category: string; exposure_amount_tzs: number }>>([]);
  const [loading,     setLoading]     = useState(true);
  const [showForm,    setShowForm]    = useState(false);
  const [submitting,  setSubmitting]  = useState(false);
  const [expandedRec, setExpandedRec] = useState(false);

  // Form state — Z-Report entry fields
  const [fSerial,   setFSerial]   = useState("");   // EFD device serial number
  const [fDate,     setFDate]     = useState("");   // Z-Report date
  const [fGross,    setFGross]    = useState("");   // Gross sales
  const [fVat,      setFVat]      = useState("");   // VAT collected
  const [fTin,      setFTin]      = useState("");   // Trader TIN (pre-fill from company)

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchData = async () => {
    setLoading(true);
    const [{ data: zReps }, { data: finds }] = await Promise.all([
      supabase
        .from("efdms_z_reports")
        .select("id, serial_number, trader_tin, report_date, gross_sales, net_sales, vat_collected, exempt_sales, zero_rated_sales, receipt_count, cancelled_count, import_source, created_at")
        .eq("company_id", companyId)
        .gte("report_date", periodStart(periodYear, periodMonth))
        .lte("report_date", periodEnd(periodYear, periodMonth))
        .order("report_date", { ascending: false }),
      supabase
        .from("findings")
        .select("finding_category, exposure_amount_tzs")
        .eq("company_id", companyId)
        .in("status", ["open", "in_progress"]),
    ]);
    setRecords((zReps ?? []) as EFDMSZReport[]);
    setFindings((finds ?? []).map(f => ({
      finding_category:    f.finding_category,
      exposure_amount_tzs: Number(f.exposure_amount_tzs ?? 0),
    })));
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, [companyId, periodYear, periodMonth]);

  // ── Reconciliation rows (Z-Report totals vs Kinga findings) ───────────────
  const totalGross = records.reduce((s, r) => s + Number(r.gross_sales),    0);
  const totalVat   = records.reduce((s, r) => s + Number(r.vat_collected),  0);

  const reconciliation: ReconciliationRow[] = [
    {
      category:    "revenue",
      label:       "Revenue (EFDMS Gross Sales)",
      efdmsAmount: totalGross,
      kingaAmount: 0,   // revenue not a "finding" — info only
      gap:         0,
      recordCount: records.length,
    },
    {
      category:    "vat",
      label:       "VAT Output (EFDMS Z-Reports)",
      efdmsAmount: totalVat,
      kingaAmount: findings
        .filter(f => f.finding_category === "vat_shortfall")
        .reduce((s, f) => s + f.exposure_amount_tzs, 0),
      get gap() { return this.kingaAmount - this.efdmsAmount; },
      recordCount: records.length,
    },
    {
      category:    "exempt",
      label:       "Exempt Sales",
      efdmsAmount: records.reduce((s, r) => s + Number(r.exempt_sales), 0),
      kingaAmount: 0,
      gap:         0,
      recordCount: records.length,
    },
    {
      category:    "zero_rated",
      label:       "Zero-Rated Sales",
      efdmsAmount: records.reduce((s, r) => s + Number(r.zero_rated_sales), 0),
      kingaAmount: 0,
      gap:         0,
      recordCount: records.length,
    },
  ].map(r => ({ ...r, gap: typeof (r as any).gap === "function" ? (r as any).gap : r.gap }));

  const hasGaps = reconciliation.some(r => Math.abs(r.gap) > 0.01 && r.recordCount > 0);

  // ── Submit Z-Report via safisha-efdms-ingest ───────────────────────────────
  const handleSubmit = async () => {
    if (!fSerial.trim()) { toast.error("EFD Serial Number is required"); return; }
    if (!fDate)           { toast.error("Z-Report Date is required");    return; }
    if (!fGross || isNaN(parseFloat(fGross))) { toast.error("Valid Gross Sales amount required"); return; }

    setSubmitting(true);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("safisha-efdms-ingest", {
        body: {
          company_id:   companyId,
          fiscal_year:  periodYear,
          period_month: periodMonth,
          source_type:  "MANUAL_CONFIRMED",
          z_reports: [{
            serial_number:    fSerial.trim(),
            trader_tin:       fTin.trim() || "",
            report_date:      fDate,
            gross_sales:      parseFloat(fGross) || 0,
            net_sales:        (parseFloat(fGross) || 0) - (parseFloat(fVat) || 0),
            vat_collected:    parseFloat(fVat)   || 0,
            exempt_sales:     0,
            zero_rated_sales: 0,
            receipt_count:    0,
            cancelled_count:  0,
          }],
        },
      });

      if (fnErr) throw fnErr;
      if (data?.error) throw new Error(data.error + (data.message ? ": " + data.message : ""));

      if (data?.rows_skipped > 0 && data?.rows_inserted === 0) {
        toast.warning("Z-Report already imported for this serial + date (duplicate skipped)");
      } else {
        toast.success("Z-Report entry saved");
      }

      setFSerial(""); setFDate(""); setFGross(""); setFVat(""); setFTin("");
      setShowForm(false);
      fetchData();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("23505")) toast.error("Duplicate: Z-Report already imported for this serial + date");
      else toast.error("Failed to save: " + msg);
    } finally {
      setSubmitting(false);
    }
  };

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
                {companyName ? `${companyName} · ` : ""}{MONTHS[periodMonth - 1]} {periodYear} — Z-Report import + engine comparison
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
                Add Z-Report Entry
              </Button>
            )}
          </div>
        </div>

        {/* Summary strip */}
        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2 text-center">
            <p className="text-xs text-muted-foreground">Z-Reports</p>
            <p className="text-lg font-bold text-emerald-700">{records.length}</p>
          </div>
          <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-center">
            <p className="text-xs text-muted-foreground">EFDMS Gross Sales</p>
            <p className="text-sm font-semibold text-foreground">{fmt(totalGross)}</p>
          </div>
          <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-center">
            <p className="text-xs text-muted-foreground">EFDMS VAT</p>
            <p className="text-sm font-semibold text-foreground">{fmt(totalVat)}</p>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* ── Manual Z-Report entry form ─────────────────────────────────── */}
        {showForm && (
          <div className="border border-emerald-200 rounded-xl bg-emerald-50/30 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Plus className="w-4 h-4 text-emerald-600" />
                New Z-Report Entry
              </h3>
              <Button variant="ghost" size="sm" onClick={() => setShowForm(false)} className="text-xs">
                Cancel
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 sm:col-span-1">
                <Label className="text-xs font-medium">EFD Serial Number *</Label>
                <Input
                  className="mt-1 text-sm"
                  placeholder="TRA-EFD-001 / Z-20250615-001"
                  value={fSerial}
                  onChange={e => setFSerial(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs font-medium">Z-Report Date *</Label>
                <Input
                  type="date"
                  className="mt-1 text-sm"
                  value={fDate}
                  onChange={e => setFDate(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs font-medium">Gross Sales (TZS) *</Label>
                <Input
                  type="number"
                  min={0}
                  className="mt-1 text-sm"
                  placeholder="0"
                  value={fGross}
                  onChange={e => setFGross(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs font-medium">VAT Collected (TZS)</Label>
                <Input
                  type="number"
                  min={0}
                  className="mt-1 text-sm"
                  placeholder="0"
                  value={fVat}
                  onChange={e => setFVat(e.target.value)}
                />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <Label className="text-xs font-medium">Trader TIN</Label>
                <Input
                  className="mt-1 text-sm"
                  placeholder="123-456-789"
                  value={fTin}
                  onChange={e => setFTin(e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center gap-2 pt-1 border-t border-emerald-200">
              <Button
                size="sm"
                disabled={submitting || !fSerial || !fDate || !fGross}
                onClick={handleSubmit}
                className="bg-emerald-700 hover:bg-emerald-800 text-white gap-1.5"
              >
                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Receipt className="w-3.5 h-3.5" />}
                Save Z-Report
              </Button>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock className="w-3 h-3" />
                Z-Report entries are permanent (TRA audit trail) — no deletion.
              </div>
            </div>
          </div>
        )}

        {/* ── Reconciliation table ───────────────────────────────────────── */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-foreground">Engine vs EFDMS Reconciliation</h3>
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Info className="w-3 h-3" />
              Gap = Kinga engine exposure − EFDMS Z-Report total
            </div>
          </div>
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/40 border-b border-border">
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground">Category</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">EFDMS Total</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Kinga Engine</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Gap / Status</th>
                </tr>
              </thead>
              <tbody>
                {reconciliation.map(row => {
                  const isInfoOnly = row.category === "revenue" || row.category === "exempt" || row.category === "zero_rated";
                  const gap = isInfoOnly ? 0 : row.gap;
                  const reconciled = Math.abs(gap) < 0.01;
                  return (
                    <tr key={row.category} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="py-2 px-3 font-medium">
                        {row.label}
                        {row.recordCount > 0 && (
                          <span className="text-muted-foreground font-normal ml-1">({row.recordCount} Z-reports)</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right font-mono">
                        {row.efdmsAmount > 0 ? fmt(row.efdmsAmount) : "—"}
                      </td>
                      <td className="py-2 px-3 text-right font-mono">
                        {isInfoOnly
                          ? <span className="text-muted-foreground">N/A</span>
                          : row.kingaAmount > 0 ? fmt(row.kingaAmount) : "—"
                        }
                      </td>
                      <td className={`py-2 px-3 text-right font-medium ${gapColor(gap)}`}>
                        {isInfoOnly ? (
                          <span className="text-muted-foreground text-[10px]">Info only</span>
                        ) : reconciled ? (
                          <span className="flex items-center justify-end gap-1">
                            <CheckCircle className="w-3 h-3 text-emerald-500" />Reconciled
                          </span>
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

        {/* ── Z-Report list ─────────────────────────────────────────────── */}
        {loading ? (
          <div className="flex items-center justify-center py-6 gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading Z-Reports…</span>
          </div>
        ) : records.length > 0 && (
          <Collapsible open={expandedRec} onOpenChange={setExpandedRec}>
            <CollapsibleTrigger asChild>
              <button className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground w-full py-1">
                {expandedRec ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                {records.length} Z-Report{records.length !== 1 ? "s" : ""} for {MONTHS[periodMonth - 1]} {periodYear}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 rounded-xl border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/40 border-b border-border text-muted-foreground">
                      <th className="text-left py-2 px-3 font-medium">Serial</th>
                      <th className="text-left py-2 px-3 font-medium">Date</th>
                      <th className="text-right py-2 px-3 font-medium">Gross Sales</th>
                      <th className="text-right py-2 px-3 font-medium">VAT</th>
                      <th className="text-right py-2 px-3 font-medium hidden sm:table-cell">Receipts</th>
                      <th className="text-left py-2 px-3 font-medium hidden sm:table-cell">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map(r => (
                      <tr key={r.id} className="border-b border-border/50 hover:bg-muted/20">
                        <td className="py-1.5 px-3 font-mono text-muted-foreground">{r.serial_number}</td>
                        <td className="py-1.5 px-3 text-muted-foreground">{r.report_date}</td>
                        <td className="py-1.5 px-3 text-right font-mono">{fmt(Number(r.gross_sales))}</td>
                        <td className="py-1.5 px-3 text-right font-mono">
                          {Number(r.vat_collected) > 0 ? fmt(Number(r.vat_collected)) : "—"}
                        </td>
                        <td className="py-1.5 px-3 text-right hidden sm:table-cell">
                          {r.receipt_count > 0 ? r.receipt_count.toLocaleString() : "—"}
                        </td>
                        <td className="py-1.5 px-3 hidden sm:table-cell">
                          <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-medium">
                            {r.import_source}
                          </span>
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
            <p className="text-sm text-muted-foreground">No Z-Reports imported for this period.</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Add daily Z-Report summaries manually from your EFD device or TRA portal, or import a CSV file via the Upload panel.
            </p>
          </div>
        )}

        {/* Footer */}
        <div className="pt-2 border-t border-border/40 text-xs text-muted-foreground/70 flex items-center gap-1.5">
          <Lock className="w-3 h-3" />
          Z-Report entries are permanent and cannot be deleted (TRA audit trail). All writes go through the safisha-efdms-ingest Iron Dome gatekeeper.
        </div>
      </CardContent>
    </Card>
  );
}
