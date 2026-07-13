// ============================================================
// FilingCalendarPanel — Sprint 4 Item 3
// Multi-company deadline view: what is due, when, how much.
//
// Data sources (no new edge function — pure read-and-render):
//   • findings       → open statutory obligations (SDL, NSSF, service levy…)
//   • tax_computations.computation_detail → ITA s.88 CIT instalment dates
//   • companies      → name + TIN
//
// Renders: month-grouped table of upcoming obligations across
// ALL companies the user manages. Sorted by due date ascending.
// ============================================================

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Calendar, AlertTriangle, CheckCircle, Clock,
  RefreshCw, Building2, TrendingUp,
} from "lucide-react";
import { toast } from "sonner";

// ── Types ─────────────────────────────────────────────────────

interface CalendarEntry {
  id: string;
  companyId: string;
  companyName: string;
  companyTin: string | null;
  obligationType: string;           // "SDL Underpayment", "CIT Instalment 1", …
  obligationCategory: string;       // "statutory_finding" | "cit_instalment"
  dueDate: Date;
  amountTzs: number;
  status: "open" | "in_progress" | "overdue" | "paid";
  findingId?: string;
  uploadId?: string;
}

interface Company {
  id: string;
  name: string;
  tin: string | null;
}

interface FindingRow {
  id: string;
  company_id: string;
  upload_id: string;
  title: string;
  finding_category: string | null;
  status: string;
  period_end: string | null;
  exposure_amount_tzs: number;
}

interface TaxCompRow {
  company_id: string;
  upload_id: string;
  period_year: number;
  period_month: number;
  computation_detail: Record<string, unknown>;
}

// ── Helpers ───────────────────────────────────────────────────

const fmt = (n: number) =>
  new Intl.NumberFormat("en-TZ", { maximumFractionDigits: 0 }).format(Math.abs(n));

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

/** ITA s.88: compute the last day of (startMonth+n) months */
function addMonths(startM: number, startY: number, n: number): Date {
  const total = startY * 12 + startM - 1 + n;
  const rm    = (total % 12) + 1;
  const ry    = Math.floor(total / 12);
  return new Date(ry, rm - 1 + 1, 0); // last day of the resulting month
}

function monthLabel(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function isOverdue(d: Date): boolean {
  return d < new Date();
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

// ── Component ─────────────────────────────────────────────────

export function FilingCalendarPanel() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "overdue" | "upcoming">("upcoming");

  const fetchCalendar = async () => {
    if (!user) return;
    setLoading(true);

    try {
      // 1. Companies
      const { data: companiesRaw, error: cErr } = await supabase
        .from("companies")
        .select("id, name, tin")
        .eq("is_active", true)
        .order("name");
      if (cErr) throw cErr;
      const companies: Company[] = (companiesRaw ?? []) as Company[];
      const companyMap = new Map<string, Company>(
        companies.map((c) => [c.id, c])
      );

      const all: CalendarEntry[] = [];

      // 2. Open/in-progress findings → statutory due dates
      const { data: findingsRaw } = await supabase
        .from("findings")
        .select(
          "id, company_id, upload_id, title, finding_category, status, period_end, exposure_amount_tzs"
        )
        .in("status", ["open", "in_progress"])
        .not("period_end", "is", null)
        .gt("exposure_amount_tzs", 0)
        .order("period_end", { ascending: true });

      for (const f of (findingsRaw ?? []) as FindingRow[]) {
        const company = companyMap.get(f.company_id);
        if (!company) continue;
        const dueDate = new Date(f.period_end!);
        all.push({
          id: `finding-${f.id}`,
          companyId: f.company_id,
          companyName: company.name,
          companyTin: company.tin,
          obligationType: f.title,
          obligationCategory: "statutory_finding",
          dueDate,
          amountTzs: Number(f.exposure_amount_tzs),
          status: isOverdue(dueDate) ? "overdue" : "open",
          findingId: f.id,
          uploadId: f.upload_id,
        });
      }

      // 3. Latest committed tax computations → CIT instalment dates (ITA s.88)
      const { data: taxRaw } = await supabase
        .from("tax_computations")
        .select("company_id, upload_id, period_year, period_month, computation_detail")
        .order("created_at", { ascending: false });

      // Deduplicate: one per company (latest committed)
      const seenCompanyCIT = new Set<string>();
      for (const tc of (taxRaw ?? []) as TaxCompRow[]) {
        if (seenCompanyCIT.has(tc.company_id)) continue;
        seenCompanyCIT.add(tc.company_id);

        const r = tc.computation_detail as Record<string, unknown>;
        const taxPayable = Number(r.tax_payable_tzs ?? 0);
        if (taxPayable <= 0) continue;

        const company = companyMap.get(tc.company_id);
        if (!company) continue;

        const startM = (tc.period_month % 12) + 1;
        const startY = tc.period_month === 12 ? tc.period_year : tc.period_year - 1;
        const instalment = Math.round(taxPayable / 4);

        const instalments = [
          { label: "CIT Instalment 1 (ITA s.88)", n: 3,  amount: instalment },
          { label: "CIT Instalment 2 (ITA s.88)", n: 6,  amount: instalment },
          { label: "CIT Instalment 3 (ITA s.88)", n: 9,  amount: instalment },
          { label: "CIT Final Balance (ITA s.88)", n: 12, amount: taxPayable - instalment * 3 },
        ];

        for (const ins of instalments) {
          const dueDate = addMonths(startM, startY, ins.n);
          all.push({
            id: `cit-${tc.company_id}-${ins.n}`,
            companyId: tc.company_id,
            companyName: company.name,
            companyTin: company.tin,
            obligationType: ins.label,
            obligationCategory: "cit_instalment",
            dueDate,
            amountTzs: ins.amount,
            status: isOverdue(dueDate) ? "overdue" : "open",
            uploadId: tc.upload_id,
          });
        }
      }

      // Sort by due date ascending
      all.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
      setEntries(all);
    } catch (err) {
      console.error("FilingCalendarPanel fetch error:", err);
      toast.error("Failed to load filing calendar");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCalendar();
  }, [user]);

  // ── Filter ───────────────────────────────────────────────────

  const now = new Date();
  const sixMonthsOut = new Date();
  sixMonthsOut.setMonth(sixMonthsOut.getMonth() + 6);

  const filtered = entries.filter((e) => {
    if (filter === "overdue")  return e.dueDate < now;
    if (filter === "upcoming") return e.dueDate >= now && e.dueDate <= sixMonthsOut;
    return true;
  });

  // Group by month label
  const grouped = new Map<string, CalendarEntry[]>();
  for (const e of filtered) {
    const key = monthLabel(e.dueDate);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(e);
  }

  // ── Summary badges ────────────────────────────────────────────

  const overdueCount = entries.filter((e) => e.dueDate < now).length;
  const overdueTotal = entries
    .filter((e) => e.dueDate < now)
    .reduce((s, e) => s + e.amountTzs, 0);
  const upcomingCount = entries.filter(
    (e) => e.dueDate >= now && e.dueDate <= sixMonthsOut
  ).length;

  // ── Status badge ─────────────────────────────────────────────

  const statusBadge = (e: CalendarEntry) => {
    if (e.status === "overdue") {
      return (
        <Badge className="text-[10px] bg-red-500/10 text-red-700 border-red-500/30 flex items-center gap-1">
          <AlertTriangle className="w-2.5 h-2.5" />
          Overdue
        </Badge>
      );
    }
    return (
      <Badge className="text-[10px] bg-primary/10 text-primary border-primary/30 flex items-center gap-1">
        <Clock className="w-2.5 h-2.5" />
        Upcoming
      </Badge>
    );
  };

  const categoryBadge = (cat: string) =>
    cat === "cit_instalment" ? (
      <Badge variant="outline" className="text-[10px] border-[#0E1D30]/30 text-[#0E1D30]">
        CIT
      </Badge>
    ) : (
      <Badge variant="outline" className="text-[10px]">
        Statutory
      </Badge>
    );

  // ── Render ────────────────────────────────────────────────────

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Calendar className="w-5 h-5 text-primary" />
              Filing Calendar
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Upcoming obligations across all companies — statutory findings + CIT instalments
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchCalendar}
            disabled={loading}
            className="gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Summary strip */}
        <div className="flex flex-wrap gap-3 pt-2">
          {overdueCount > 0 && (
            <div className="flex items-center gap-1.5 bg-red-500/10 rounded-lg px-3 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-red-600" />
              <span className="text-xs font-semibold text-red-700">
                {overdueCount} overdue · TZS {fmt(overdueTotal)}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1.5 bg-primary/10 rounded-lg px-3 py-1.5">
            <Clock className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-semibold text-primary">
              {upcomingCount} due in 6 months
            </span>
          </div>
          <div className="flex items-center gap-1.5 bg-secondary rounded-lg px-3 py-1.5">
            <TrendingUp className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              {entries.length} total obligations tracked
            </span>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1 pt-1">
          {(["upcoming", "overdue", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-xs px-3 py-1 rounded-md font-medium transition-colors capitalize ${
                filter === f
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary"
              }`}
            >
              {f === "upcoming" ? "Next 6 months" : f === "overdue" ? "Overdue" : "All"}
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {loading ? (
          <div className="text-center py-10 text-sm text-muted-foreground">
            <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
            Loading obligations…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-10">
            <CheckCircle className="w-8 h-8 text-accent mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              {filter === "overdue"
                ? "No overdue obligations found."
                : "No obligations in the selected period."}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Run the findings engine and commit a tax computation to populate this calendar.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {Array.from(grouped.entries()).map(([month, items]) => (
              <div key={month}>
                {/* Month header */}
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    {month}
                  </span>
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-[10px] text-muted-foreground">
                    {items.length} item{items.length !== 1 ? "s" : ""} ·{" "}
                    TZS {fmt(items.reduce((s, e) => s + e.amountTzs, 0))}
                  </span>
                </div>

                {/* Entries */}
                <div className="space-y-1.5">
                  {items.map((e) => (
                    <div
                      key={e.id}
                      className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 ${
                        e.status === "overdue"
                          ? "bg-red-500/5 border-red-500/20"
                          : "bg-card border-border hover:border-primary/30"
                      } transition-colors`}
                    >
                      {/* Company */}
                      <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-primary/10 flex-shrink-0 mt-0.5">
                        <Building2 className="w-3.5 h-3.5 text-primary" />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2 flex-wrap">
                          <div>
                            <p className="text-xs font-semibold text-foreground leading-tight">
                              {e.obligationType}
                            </p>
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                              {e.companyName}
                              {e.companyTin && (
                                <span className="ml-1.5 font-mono bg-secondary px-1 py-0.5 rounded text-[9px]">
                                  TIN: {e.companyTin}
                                </span>
                              )}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            {categoryBadge(e.obligationCategory)}
                            {statusBadge(e)}
                          </div>
                        </div>
                      </div>

                      {/* Amount + date */}
                      <div className="text-right flex-shrink-0">
                        <p className="text-xs font-bold font-mono text-foreground">
                          TZS {fmt(e.amountTzs)}
                        </p>
                        <p className={`text-[10px] mt-0.5 ${
                          e.status === "overdue" ? "text-red-600 font-semibold" : "text-muted-foreground"
                        }`}>
                          {formatDate(e.dueDate)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}