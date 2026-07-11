/**
 * ClientSummaryPanel.tsx
 * Sprint 7 Item 2 — Iron Dome Nuclear Design
 *
 * One-page client-facing tax position summary.
 * Plain language — the CLIENT reads this, not the CPA.
 *
 * Shows:
 *   - Company name, period, CPA firm (from profiles)
 *   - Total CIT payable (from latest committed tax_computations)
 *   - Payments made to date (from tax_payments)
 *   - Balance remaining
 *   - Key compliance issues by severity (from findings)
 *   - Next 3 upcoming deadlines (from filing_obligations)
 *   - Prepared by + date
 *
 * Print-ready via window.print() with @media print CSS.
 * Iron Dome: all figures from DB only. No hallucinated amounts.
 */

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Printer,
  Loader2,
  AlertTriangle,
  CheckCircle,
  Calendar,
  TrendingDown,
  Banknote,
  ShieldCheck,
  ChevronDown,
  ChevronRight,
  Building2,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SummaryData {
  companyTin: string | null;
  citPayable: number;
  citCommitted: boolean;
  totalPayments: number;
  balanceDue: number;
  highFindings: number;
  lowFindings: number;
  topFindings: string[];
  upcomingDeadlines: Array<{ label: string; dueDate: string; overdue: boolean }>;
  cpaName: string;
  cpaFirm: string;
  generatedAt: string;
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

const fmtDate = (d: string) =>
  new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

// ── Component ─────────────────────────────────────────────────────────────────

export function ClientSummaryPanel({ companyId, uploadId, periodYear, companyName, userId }: Props) {
  const [data, setData] = useState<SummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);

    const [
      { data: companies },
      { data: taxComps },
      { data: payments },
      { data: highFinds },
      { data: allFinds },
      { data: obligations },
      { data: profile },
      { data: firmProf },
    ] = await Promise.all([
      supabase.from("companies").select("tin").eq("id", companyId).limit(1),
      supabase
        .from("tax_computations")
        .select("cit_payable_tzs, is_committed")
        .eq("company_id", companyId)
        .eq("upload_id", uploadId)
        .order("created_at", { ascending: false })
        .limit(1),
      supabase
        .from("tax_payments")
        .select("amount_tzs")
        .eq("company_id", companyId)
        .gte("payment_date", `${periodYear}-01-01`)
        .lte("payment_date", `${periodYear}-12-31`),
      supabase
        .from("findings")
        .select("title")
        .eq("company_id", companyId)
        .in("severity", ["high", "critical"])
        .in("status", ["open", "in_progress"])
        .order("exposure_amount_tzs", { ascending: false })
        .limit(3),
      supabase
        .from("findings")
        .select("severity")
        .eq("company_id", companyId)
        .in("status", ["open", "in_progress"]),
      supabase
        .from("filing_obligations")
        .select("obligation_type, period_end, status")
        .eq("company_id", companyId)
        .in("status", ["pending", "overdue"])
        .order("period_end", { ascending: true })
        .limit(3),
      supabase
        .from("profiles")
        .select("display_name, company_name")
        .eq("user_id", userId)
        .limit(1),
      supabase
        .from("profiles")
        .select("company_name")
        .eq("user_id", userId)
        .limit(1),
    ]);

    const comp = taxComps?.[0];
    const citPayable = Number(comp?.cit_payable_tzs ?? 0);
    const totalPayments = (payments ?? []).reduce((s, p) => s + Number(p.amount_tzs ?? 0), 0);
    const balanceDue = Math.max(0, citPayable - totalPayments);

    const allFindsArr = allFinds ?? [];
    const highCount = allFindsArr.filter(f => ["high", "critical"].includes(f.severity)).length;
    const lowCount  = allFindsArr.filter(f => ["low", "medium"].includes(f.severity)).length;

    const today = new Date();
    const deadlines = (obligations ?? []).map(o => ({
      label: o.obligation_type?.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()) ?? "Obligation",
      dueDate: o.period_end ?? "",
      overdue: o.status === "overdue" || (o.period_end && new Date(o.period_end) < today),
    }));

    setData({
      companyTin: companies?.[0]?.tin ?? null,
      citPayable,
      citCommitted: comp?.is_committed ?? false,
      totalPayments,
      balanceDue,
      highFindings: highCount,
      lowFindings: lowCount,
      topFindings: (highFinds ?? []).map(f => f.title),
      upcomingDeadlines: deadlines,
      cpaName: profile?.[0]?.display_name ?? "Your CPA",
      cpaFirm: firmProf?.[0]?.company_name ?? "SAFF ERP",
      generatedAt: new Date().toISOString(),
    });

    setLoading(false);
  }, [companyId, uploadId, periodYear, userId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handlePrint = () => window.print();

  return (
    <Card className="bg-card border-border print:shadow-none print:border-none" id="client-summary-print">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CardHeader className="pb-3 print:hidden">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CollapsibleTrigger asChild>
              <button className="flex items-center gap-3 text-left">
                <div className="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center flex-shrink-0">
                  <Building2 className="w-5 h-5 text-white" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-semibold text-foreground">Client Summary Report</span>
                    {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {companyName ? `${companyName} · ` : ""}FY{periodYear} — client-facing tax position summary
                  </p>
                </div>
              </button>
            </CollapsibleTrigger>
            <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={handlePrint} disabled={loading || !expanded}>
              <Printer className="w-3.5 h-3.5" />
              Print / PDF
            </Button>
          </div>
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="pt-0">
            {loading ? (
              <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading summary…</span>
              </div>
            ) : data ? (
              <div className="space-y-6">
                {/* ── Header ──────────────────────────────────────────── */}
                <div className="border-b border-border/60 pb-4">
                  <div className="flex items-start justify-between flex-wrap gap-3">
                    <div>
                      <h2 className="text-xl font-bold text-foreground">{companyName ?? "Company"}</h2>
                      {data.companyTin && <p className="text-xs text-muted-foreground mt-0.5">TIN: {data.companyTin}</p>}
                      <p className="text-sm text-muted-foreground">Financial Year {periodYear} — Tax Position Summary</p>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <p>Prepared by: <span className="font-medium text-foreground">{data.cpaName}</span></p>
                      <p>{data.cpaFirm}</p>
                      <p>{fmtDate(data.generatedAt)}</p>
                    </div>
                  </div>
                </div>

                {/* ── Tax Position ─────────────────────────────────────── */}
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                    <Banknote className="w-4 h-4 text-muted-foreground" />
                    Your Tax Position for FY{periodYear}
                  </h3>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-xl border border-border bg-muted/20 px-4 py-3 text-center">
                      <p className="text-xs text-muted-foreground">Corporate Tax Computed</p>
                      <p className="text-lg font-bold text-foreground mt-1">{fmt(data.citPayable)}</p>
                      {!data.citCommitted && (
                        <p className="text-[10px] text-amber-600 mt-0.5">Estimate — not yet committed</p>
                      )}
                    </div>
                    <div className="rounded-xl border border-border bg-muted/20 px-4 py-3 text-center">
                      <p className="text-xs text-muted-foreground">Payments Made</p>
                      <p className="text-lg font-bold text-emerald-600 mt-1">{fmt(data.totalPayments)}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">Recorded in system</p>
                    </div>
                    <div className={`rounded-xl border px-4 py-3 text-center ${data.balanceDue > 0 ? "border-red-200 bg-red-50" : "border-emerald-200 bg-emerald-50"}`}>
                      <p className="text-xs text-muted-foreground">Balance Remaining</p>
                      <p className={`text-lg font-bold mt-1 ${data.balanceDue > 0 ? "text-red-700" : "text-emerald-700"}`}>
                        {data.balanceDue > 0 ? fmt(data.balanceDue) : "Nil"}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {data.balanceDue > 0 ? "Outstanding" : "Fully settled"}
                      </p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Corporate Income Tax rate: 30% of taxable income (ITA Chapter 332, R.E. 2023). Computed by Kinga Engine.
                  </p>
                </div>

                {/* ── Compliance Issues ────────────────────────────────── */}
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-muted-foreground" />
                    Compliance Status
                  </h3>
                  {data.highFindings === 0 && data.lowFindings === 0 ? (
                    <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                      <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-emerald-800">No compliance issues identified</p>
                        <p className="text-xs text-emerald-700/70">All statutory obligations appear to be in order for this period.</p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {data.highFindings > 0 && (
                        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
                          <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                          <div>
                            <p className="text-sm font-semibold text-red-800">
                              {data.highFindings} significant issue{data.highFindings > 1 ? "s" : ""} require{data.highFindings === 1 ? "s" : ""} attention
                            </p>
                            <ul className="mt-1 space-y-0.5">
                              {data.topFindings.map((t, i) => (
                                <li key={i} className="text-xs text-red-700">• {t}</li>
                              ))}
                            </ul>
                            <p className="text-xs text-red-700/70 mt-1">
                              These may result in penalties if not resolved before TRA assessment. Please contact your CPA to discuss next steps.
                            </p>
                          </div>
                        </div>
                      )}
                      {data.lowFindings > 0 && (
                        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                          <div>
                            <p className="text-sm font-medium text-amber-800">
                              {data.lowFindings} minor item{data.lowFindings > 1 ? "s" : ""} noted for your records
                            </p>
                            <p className="text-xs text-amber-700/70 mt-0.5">
                              Lower-risk observations. Your CPA will advise if any action is needed.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* ── Upcoming Deadlines ───────────────────────────────── */}
                {data.upcomingDeadlines.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-muted-foreground" />
                      Upcoming Filing Deadlines
                    </h3>
                    <div className="space-y-2">
                      {data.upcomingDeadlines.map((d, i) => (
                        <div key={i} className={`flex items-center justify-between rounded-xl border px-4 py-2.5 ${d.overdue ? "border-red-200 bg-red-50" : "border-border bg-muted/20"}`}>
                          <span className="text-sm text-foreground">{d.label}</span>
                          <div className="flex items-center gap-2">
                            {d.overdue && <Badge className="text-[10px] bg-red-100 text-red-700 border-red-200 border">Overdue</Badge>}
                            <span className={`text-xs font-medium ${d.overdue ? "text-red-700" : "text-muted-foreground"}`}>
                              {d.dueDate ? fmtDate(d.dueDate) : "—"}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Disclaimer ───────────────────────────────────────── */}
                <div className="border-t border-border/40 pt-4">
                  <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
                    This summary was prepared by {data.cpaName} ({data.cpaFirm}) using SAFF ERP / Kinga Engine on {fmtDate(data.generatedAt)}.
                    It is intended for the use of {companyName ?? "the company"} only and should not be shared with third parties
                    without the written consent of your CPA. Figures are based on the trial balance provided and are subject to
                    review by the Tanzania Revenue Authority. This document does not constitute a final tax assessment.
                    © SAFF ERP | Powered by Kinga | ITA Chapter 332, R.E. 2023 compliant.
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-6 text-center">Could not load summary data.</p>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>

      {/* Print-only styles */}
      <style>{`
        @media print {
          body > *:not(#client-summary-print) { display: none !important; }
          #client-summary-print { display: block !important; box-shadow: none !important; border: none !important; }
          .print\\:hidden { display: none !important; }
        }
      `}</style>
    </Card>
  );
}
