// ============================================================
// TRAFilingChecklist — Roadmap Item 5H
// TRA e-Filing Readiness Checklist, auto-generated from the
// findings table + latest tax_computation for the selected upload.
//
// NO new engine, NO new edge function. Pure read-and-render.
// Reads: findings (by category), tax_computations (CIT dates).
//
// CONSTRAINTS (active):
//   • Do not build PAYE engine. Do not build VAT engine.
//   • Do not modify findings engine or tax engine.
//   • No silent status changes.
//
// PAYE / VAT appear as checklist items ONLY if open findings
// exist for those categories — derived from what the engine
// already surfaced, not generated fresh here.
// ============================================================

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CheckCircle, XCircle, AlertTriangle, Clock,
  RefreshCw, FileCheck, ExternalLink,
} from "lucide-react";
import { toast } from "sonner";

// ── Types ─────────────────────────────────────────────────────

type ItemStatus = "clear" | "open_finding" | "overdue" | "no_data";

interface ChecklistItem {
  id: string;
  label: string;
  description: string;
  status: ItemStatus;
  dueDate?: string;
  exposureTzs?: number;
  itraRef: string;        // statutory reference
  note?: string;
}

interface TRAFilingChecklistProps {
  uploadId: string | null;
  companyId: string | null;
  periodYear?: number;
  periodMonth?: number;   // 1–12 (fiscal year end month)
  companyName?: string;
}

// ── Helpers ───────────────────────────────────────────────────

const fmt = (n: number) =>
  new Intl.NumberFormat("en-TZ", { maximumFractionDigits: 0 }).format(Math.abs(n));

function lastDayOfMonth(year: number, month: number): string {
  return new Date(year, month, 0).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

/** ITA s.88: CIT return is due 6 months after fiscal year end */
function citReturnDueDate(periodYear: number, periodMonth: number): string {
  const fyEndDate = new Date(periodYear, periodMonth - 1, 1);
  fyEndDate.setMonth(fyEndDate.getMonth() + 6);
  return lastDayOfMonth(fyEndDate.getFullYear(), fyEndDate.getMonth() + 1);
}

/** ITA s.88: Instalment 1 is 3 months after fiscal year START */
function citInstalment1Due(periodYear: number, periodMonth: number): string {
  const startM = (periodMonth % 12) + 1;
  const startY = periodMonth === 12 ? periodYear : periodYear - 1;
  const due = new Date(startY, startM - 1 + 3, 0);
  return due.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function statusIcon(s: ItemStatus) {
  switch (s) {
    case "clear":        return <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />;
    case "open_finding": return <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />;
    case "overdue":      return <XCircle className="w-4 h-4 text-red-600 flex-shrink-0" />;
    case "no_data":      return <Clock className="w-4 h-4 text-muted-foreground flex-shrink-0" />;
  }
}

function statusBadge(s: ItemStatus) {
  const map: Record<ItemStatus, { label: string; className: string }> = {
    clear:        { label: "Clear",          className: "bg-green-500/10 text-green-700 border-green-500/30" },
    open_finding: { label: "Finding open",   className: "bg-amber-500/10 text-amber-700 border-amber-500/30" },
    overdue:      { label: "Overdue",        className: "bg-red-500/10 text-red-700 border-red-500/30" },
    no_data:      { label: "No data yet",    className: "bg-secondary text-muted-foreground border-border" },
  };
  const { label, className } = map[s];
  return <Badge className={`text-[10px] ${className}`}>{label}</Badge>;
}

// ── Category → checklist item label map ───────────────────────

const CATEGORY_LABELS: Record<string, { label: string; itraRef: string }> = {
  sdl:                 { label: "SDL Returns & Payments",        itraRef: "Skills & Development Levy Act s.11" },
  nssf:                { label: "NSSF Contributions",            itraRef: "NSSF Act s.27" },
  service_levy:        { label: "Service Levy",                  itraRef: "Local Government Finance Act s.6" },
  paye:                { label: "PAYE Remittances",              itraRef: "ITA Cap.332 s.81" },
  vat:                 { label: "VAT Returns",                   itraRef: "VAT Act Cap.148" },
  wht:                 { label: "Withholding Tax",               itraRef: "ITA Cap.332 s.82" },
  thin_cap:            { label: "Thin Capitalisation (ITA s.12)", itraRef: "ITA Cap.332 s.12" },
  entertainment:       { label: "Entertainment Disallowance",    itraRef: "ITA Cap.332 s.11(j)" },
  management_fee:      { label: "Management Fee Cap",            itraRef: "ITA Cap.332 s.33" },
  presumptive_tax:     { label: "Presumptive Tax Assessment",    itraRef: "ITA Cap.332 s.67" },
  penalties:           { label: "Outstanding Penalties",         itraRef: "TAA 2015 s.76" },
  unknown:             { label: "Other Statutory Finding",       itraRef: "ITA Cap.332" },
};

// ── Component ─────────────────────────────────────────────────

export function TRAFilingChecklist({
  uploadId,
  companyId,
  periodYear,
  periodMonth,
  companyName,
}: TRAFilingChecklistProps) {
  const [items, setItems]     = useState<ChecklistItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasTax, setHasTax]   = useState(false);

  const build = async () => {
    if (!uploadId || !companyId) return;
    setLoading(true);

    try {
      // ── 1. Findings for this company (all open + in_progress) ──────
      const { data: findingsRaw } = await supabase
        .from("findings")
        .select("id, finding_category, status, period_end, exposure_amount_tzs, title")
        .eq("company_id", companyId)
        .in("status", ["open", "in_progress"]);

      // Group by category
      const byCategory = new Map<string, {
        totalExposure: number;
        latestPeriodEnd: string | null;
        hasOverdue: boolean;
      }>();

      const now = new Date();
      for (const f of findingsRaw ?? []) {
        const cat = (f.finding_category as string) ?? "unknown";
        const exposure = Number(f.exposure_amount_tzs ?? 0);
        const pd = f.period_end ? new Date(f.period_end) : null;
        const existing = byCategory.get(cat);
        byCategory.set(cat, {
          totalExposure: (existing?.totalExposure ?? 0) + exposure,
          latestPeriodEnd: pd
            ? !existing?.latestPeriodEnd || pd > new Date(existing.latestPeriodEnd)
              ? f.period_end
              : existing.latestPeriodEnd
            : existing?.latestPeriodEnd ?? null,
          hasOverdue: (existing?.hasOverdue ?? false) || (pd ? pd < now : false),
        });
      }

      // ── 2. Check if a committed tax computation exists ─────────────
      const { data: taxRow } = await supabase
        .from("tax_computations")
        .select("id, period_year, period_month, computation_detail")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const hasTaxComp = !!taxRow;
      setHasTax(hasTaxComp);

      const effYear  = periodYear  ?? (taxRow?.period_year  as number | undefined);
      const effMonth = periodMonth ?? (taxRow?.period_month as number | undefined);

      // ── 3. Build checklist items ───────────────────────────────────

      const result: ChecklistItem[] = [];

      // A. SDL
      const sdl = byCategory.get("sdl");
      result.push({
        id: "sdl",
        label: "SDL Returns & Payments",
        description: "Monthly 4.5% of gross emoluments — due by last working day of following month.",
        status: sdl
          ? (sdl.hasOverdue ? "overdue" : "open_finding")
          : "clear",
        dueDate: sdl?.latestPeriodEnd ?? undefined,
        exposureTzs: sdl?.totalExposure,
        itraRef: "Skills & Development Levy Act s.11",
      });

      // B. NSSF
      const nssf = byCategory.get("nssf");
      result.push({
        id: "nssf",
        label: "NSSF Contributions",
        description: "Employee + employer NSSF contributions — 10% + 10% of basic salary.",
        status: nssf
          ? (nssf.hasOverdue ? "overdue" : "open_finding")
          : "clear",
        dueDate: nssf?.latestPeriodEnd ?? undefined,
        exposureTzs: nssf?.totalExposure,
        itraRef: "NSSF Act s.27",
      });

      // C. Service Levy
      const sl = byCategory.get("service_levy");
      result.push({
        id: "service_levy",
        label: "Service Levy",
        description: "0.3% of annual turnover — payable to local government authority.",
        status: sl
          ? (sl.hasOverdue ? "overdue" : "open_finding")
          : "clear",
        dueDate: sl?.latestPeriodEnd ?? undefined,
        exposureTzs: sl?.totalExposure,
        itraRef: "Local Government Finance Act s.6",
      });

      // D. PAYE — shown only if engine surfaced a finding
      const paye = byCategory.get("paye");
      if (paye) {
        result.push({
          id: "paye",
          label: "PAYE Remittances",
          description: "Pay-As-You-Earn — deducted and remitted monthly to TRA.",
          status: paye.hasOverdue ? "overdue" : "open_finding",
          dueDate: paye.latestPeriodEnd ?? undefined,
          exposureTzs: paye.totalExposure,
          itraRef: "ITA Cap.332 s.81",
          note: "PAYE not computed by this engine — finding from prior run shown.",
        });
      }

      // E. WHT
      const wht = byCategory.get("wht");
      if (wht) {
        result.push({
          id: "wht",
          label: "Withholding Tax",
          description: "WHT on service payments, dividends, or interest — remitted to TRA.",
          status: wht.hasOverdue ? "overdue" : "open_finding",
          dueDate: wht.latestPeriodEnd ?? undefined,
          exposureTzs: wht.totalExposure,
          itraRef: "ITA Cap.332 s.82",
        });
      }

      // F. CIT Provisional Return (ITA s.88) — only if tax computation exists
      result.push({
        id: "cit_provisional",
        label: "CIT Provisional Return (ITA s.88)",
        description: "Quarterly instalment payments — due 3, 6, 9, 12 months after fiscal year start.",
        status: hasTaxComp ? "clear" : "no_data",
        dueDate: effYear && effMonth ? citInstalment1Due(effYear, effMonth) : undefined,
        itraRef: "ITA Cap.332 s.88",
        note: hasTaxComp
          ? "Tax computation committed — instalment schedule generated."
          : "Commit a tax computation to generate the instalment schedule.",
      });

      // G. CIT Final Return
      result.push({
        id: "cit_final",
        label: "CIT Final Return (ITA s.89)",
        description: "Annual corporate income tax return — due 6 months after fiscal year end.",
        status: hasTaxComp ? "clear" : "no_data",
        dueDate: effYear && effMonth ? citReturnDueDate(effYear, effMonth) : undefined,
        itraRef: "ITA Cap.332 s.89",
      });

      // H. Penalties from findings
      const pen = byCategory.get("penalties");
      if (pen) {
        result.push({
          id: "penalties",
          label: "Outstanding TRA Penalties",
          description: "5% per month on unpaid tax (TAA 2015 s.76) — accruing daily.",
          status: "overdue",
          exposureTzs: pen.totalExposure,
          itraRef: "TAA 2015 s.76",
        });
      }

      // I. Any other categories found
      for (const [cat, data] of byCategory.entries()) {
        if (["sdl","nssf","service_levy","paye","wht","penalties"].includes(cat)) continue;
        const meta = CATEGORY_LABELS[cat];
        result.push({
          id: `other-${cat}`,
          label: meta?.label ?? `Finding: ${cat}`,
          description: "Open finding — review and resolve via the Findings panel.",
          status: data.hasOverdue ? "overdue" : "open_finding",
          dueDate: data.latestPeriodEnd ?? undefined,
          exposureTzs: data.totalExposure,
          itraRef: meta?.itraRef ?? "ITA Cap.332",
        });
      }

      setItems(result);
    } catch (err) {
      console.error("TRAFilingChecklist build error:", err);
      toast.error("Failed to build filing checklist");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    build();
  }, [uploadId, companyId]);

  // ── Summary counts ────────────────────────────────────────────

  const clearCount   = items.filter((i) => i.status === "clear").length;
  const overdueCount = items.filter((i) => i.status === "overdue").length;
  const openCount    = items.filter((i) => i.status === "open_finding").length;
  const noDataCount  = items.filter((i) => i.status === "no_data").length;

  const readinessScore =
    items.length > 0
      ? Math.round((clearCount / (items.length - noDataCount || 1)) * 100)
      : 0;

  if (!uploadId || !companyId) return null;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <FileCheck className="w-5 h-5 text-primary" />
              TRA e-Filing Readiness
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {companyName ?? "Selected company"} — auto-generated from findings and tax computation
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={build}
            disabled={loading}
            className="gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Readiness bar */}
        {items.length > 0 && !loading && (
          <div className="pt-2 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Filing readiness</span>
              <span className={`font-bold ${
                readinessScore >= 80 ? "text-green-700"
                : readinessScore >= 50 ? "text-amber-700"
                : "text-red-700"
              }`}>
                {readinessScore}%
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  readinessScore >= 80 ? "bg-green-500"
                  : readinessScore >= 50 ? "bg-amber-500"
                  : "bg-red-500"
                }`}
                style={{ width: `${readinessScore}%` }}
              />
            </div>
            <div className="flex gap-3 text-[10px] text-muted-foreground">
              {clearCount > 0 && <span className="text-green-700">{clearCount} clear</span>}
              {openCount  > 0 && <span className="text-amber-700">{openCount} open</span>}
              {overdueCount > 0 && <span className="text-red-700">{overdueCount} overdue</span>}
              {noDataCount > 0 && <span>{noDataCount} pending data</span>}
            </div>
          </div>
        )}
      </CardHeader>

      <CardContent className="pt-0">
        {loading ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
            Building checklist…
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-8">
            <FileCheck className="w-7 h-7 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              No findings or tax computation found for this upload.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={item.id}
                className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                  item.status === "overdue"
                    ? "bg-red-500/5 border-red-500/20"
                    : item.status === "open_finding"
                    ? "bg-amber-500/5 border-amber-500/20"
                    : item.status === "clear"
                    ? "bg-green-500/5 border-green-500/20"
                    : "bg-secondary/30 border-border"
                }`}
              >
                <div className="mt-0.5">{statusIcon(item.status)}</div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-xs font-semibold text-foreground">{item.label}</p>
                    {statusBadge(item.status)}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
                    {item.description}
                  </p>
                  {item.note && (
                    <p className="text-[10px] text-primary mt-0.5 italic">{item.note}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5 font-mono">
                    {item.itraRef}
                  </p>
                </div>

                <div className="text-right flex-shrink-0 space-y-0.5">
                  {item.exposureTzs !== undefined && item.exposureTzs > 0 && (
                    <p className="text-xs font-bold font-mono text-red-700">
                      TZS {fmt(item.exposureTzs)}
                    </p>
                  )}
                  {item.dueDate && (
                    <p className={`text-[10px] ${
                      item.status === "overdue" ? "text-red-600 font-semibold" : "text-muted-foreground"
                    }`}>
                      Due: {item.dueDate}
                    </p>
                  )}
                </div>
              </div>
            ))}

            {/* Footer note */}
            <div className="flex items-start gap-2 pt-2 border-t border-border">
              <ExternalLink className="w-3 h-3 text-muted-foreground flex-shrink-0 mt-0.5" />
              <p className="text-[10px] text-muted-foreground">
                This checklist is derived from open findings and committed tax computations.
                Resolve findings via the <strong>Compliance Findings</strong> panel.
                CIT dates are computed per ITA Cap.332 s.88–89 from the fiscal year end.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
