/**
 * FirmDashboardPanel.tsx
 * Sprint 7 Item 3 — Iron Dome Nuclear Design
 *
 * Partner-level morning dashboard — all accessible companies on one grid.
 *
 * Per-company row shows:
 *   - Company name + TIN
 *   - Latest FY period
 *   - Compliance score (from ComplianceScorecard engine, re-used)
 *   - Period sign-off stage
 *   - Latest committed CIT payable
 *   - Total open findings exposure
 *   - Next upcoming deadline
 *
 * Aggregate strip:
 *   - Total companies
 *   - Total CIT across all companies (committed only)
 *   - Total open exposure (findings)
 *   - Critical companies count (score < 50)
 *
 * Sorted: Critical first, then At Risk, then by score ascending.
 *
 * Iron Dome: all values from DB. No hallucinated figures.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  fetchScoringDataBatch,
  scoreFromData,
  scoreToGrade as libScoreToGrade,
} from "@/lib/computeComplianceScore";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  Building2,
  AlertTriangle,
  CheckCircle,
  TrendingUp,
  Calendar,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  BarChart3,
  Users,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

// ── Types ─────────────────────────────────────────────────────────────────────

type Grade = "Compliant" | "Monitor" | "At Risk" | "Critical";

interface CompanyRow {
  companyId: string;
  companyName: string;
  tin: string | null;
  latestPeriodYear: number | null;
  score: number;
  grade: Grade;
  signOffStatus: string | null;
  citPayable: number;
  openExposure: number;
  nextDeadline: string | null;
  nextDeadlineLabel: string | null;
  criticalFindings: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  n === 0 ? "—" : "TZS " + n.toLocaleString("en-TZ", { maximumFractionDigits: 0 });

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—";

const GRADE_STYLES: Record<Grade, string> = {
  Compliant: "bg-emerald-100 text-emerald-800 border-emerald-200",
  Monitor:   "bg-blue-100 text-blue-800 border-blue-200",
  "At Risk": "bg-amber-100 text-amber-800 border-amber-200",
  Critical:  "bg-red-100 text-red-800 border-red-200",
};

const SIGN_OFF_LABEL: Record<string, string> = {
  draft:            "No signatures",
  preparer_signed:  "Preparer ✓",
  reviewer_signed:  "Reviewer ✓",
  approved:         "Approved",
  locked:           "Locked ✓",
};

const gradeOrder: Record<Grade, number> = { Critical: 0, "At Risk": 1, Monitor: 2, Compliant: 3 };

const scoreToGrade = libScoreToGrade;

// ── Component ─────────────────────────────────────────────────────────────────

export function FirmDashboardPanel() {
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);

  const fetchAll = async () => {
    setLoading(true);

    const { data: companies } = await supabase
      .from("companies")
      .select("id, name, tin")
      .order("name");

    if (!companies || companies.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }

    const companyIds = companies.map(c => c.id);

    // Iron Dome: scoring via canonical batch lib (O(4) queries, correct amount_paid_tzs column)
    const scoringDataMap = await fetchScoringDataBatch(companyIds);

    // Display-only queries (non-scoring data not covered by scorer lib)
    const [
      { data: taxComps },
      { data: findingsDisplay },
      { data: obligations },
    ] = await Promise.all([
      // Latest committed tax computation — for CIT payable display only
      supabase
        .from("tax_computations")
        .select("company_id, cit_payable_tzs, period_year, is_committed, created_at")
        .in("company_id", companyIds)
        .eq("is_committed", true)
        .order("created_at", { ascending: false }),

      // Open findings — for severity/criticalFindings display only
      // (exposure + scoring come from scoringDataMap)
      supabase
        .from("findings")
        .select("company_id, severity")
        .in("company_id", companyIds)
        .in("status", ["open", "in_progress"]),

      // Upcoming filing obligations
      supabase
        .from("filing_obligations")
        .select("company_id, obligation_type, period_end")
        .in("company_id", companyIds)
        .in("status", ["pending", "overdue"])
        .order("period_end", { ascending: true }),
    ]);

    // Build display-only lookup maps
    const taxCompMap = new Map<string, { citPayable: number; periodYear: number }>();
    for (const tc of (taxComps ?? [])) {
      if (!taxCompMap.has(tc.company_id)) {
        taxCompMap.set(tc.company_id, {
          citPayable: Number(tc.cit_payable_tzs ?? 0),
          periodYear: tc.period_year,
        });
      }
    }

    // criticalFindings count (display only — uses severity column)
    const criticalMap = new Map<string, number>();
    for (const f of (findingsDisplay ?? [])) {
      const prev = criticalMap.get(f.company_id) ?? 0;
      criticalMap.set(f.company_id, prev + (["high", "critical"].includes(f.severity) ? 1 : 0));
    }

    const deadlineMap = new Map<string, { label: string; date: string }>();
    for (const o of (obligations ?? [])) {
      if (!deadlineMap.has(o.company_id)) {
        deadlineMap.set(o.company_id, {
          label: o.obligation_type?.replace(/_/g, " ") ?? "Filing",
          date: o.period_end ?? "",
        });
      }
    }

    // ── Score per company — canonical lib, zero inline computation ─────────────
    const built: CompanyRow[] = companies.map(c => {
      const tax      = taxCompMap.get(c.id);
      const deadline = deadlineMap.get(c.id) ?? null;

      // Scoring via canonical lib — same formula as ComplianceScorecard
      const scoringInput = scoringDataMap.get(c.id) ?? {
        openFindings: [], taxCompWarnings: [], totalPaid: 0, signOffStatus: null, now: new Date(),
      };
      const scored = scoreFromData(scoringInput);

      // openExposure derived from scoring data (not a separate query)
      const openExposure = scoringInput.openFindings.reduce(
        (s, f) => s + f.exposure_amount_tzs, 0
      );

      return {
        companyId: c.id,
        companyName: c.name,
        tin: c.tin ?? null,
        latestPeriodYear: tax?.periodYear ?? null,
        score: scored.totalScore,
        grade: scored.grade as Grade,
        signOffStatus: scoringInput.signOffStatus,
        citPayable: tax?.citPayable ?? 0,
        openExposure,
        nextDeadline: deadline?.date ?? null,
        nextDeadlineLabel: deadline?.label ?? null,
        criticalFindings: criticalMap.get(c.id) ?? 0,
      };
    });

    // Sort: Critical → At Risk → Monitor → Compliant, then by score ascending within each
    built.sort((a, b) =>
      gradeOrder[a.grade] !== gradeOrder[b.grade]
        ? gradeOrder[a.grade] - gradeOrder[b.grade]
        : a.score - b.score
    );

    setRows(built);
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []);

  // ── Aggregates ─────────────────────────────────────────────────────────────
  const totalCIT      = rows.reduce((s, r) => s + r.citPayable, 0);
  const totalExposure = rows.reduce((s, r) => s + r.openExposure, 0);
  const criticalCount = rows.filter(r => r.grade === "Critical").length;
  const avgScore      = rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : 0;

  return (
    <Card className="bg-card border-border">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CollapsibleTrigger asChild>
              <button className="flex items-center gap-3 text-left">
                <div className="w-9 h-9 rounded-lg bg-blue-900 flex items-center justify-center flex-shrink-0">
                  <BarChart3 className="w-5 h-5 text-white" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base font-semibold text-foreground">Firm Dashboard</CardTitle>
                    {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    All-company partner view — compliance, exposure, deadlines
                  </p>
                </div>
              </button>
            </CollapsibleTrigger>
            <div className="flex items-center gap-2">
              {criticalCount > 0 && (
                <Badge className="bg-red-100 text-red-800 border-red-200 border text-xs gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  {criticalCount} Critical
                </Badge>
              )}
              <button
                onClick={fetchAll}
                className="p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                title="Refresh"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>

          {/* Aggregate strip */}
          {!loading && rows.length > 0 && (
            <div className="mt-3 grid grid-cols-4 gap-2">
              <div className="rounded-lg bg-muted/30 border border-border px-3 py-2 text-center">
                <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
                  <Users className="w-3 h-3" /> Companies
                </div>
                <p className="text-lg font-bold text-foreground">{rows.length}</p>
              </div>
              <div className="rounded-lg bg-muted/30 border border-border px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground">Total CIT</p>
                <p className="text-sm font-semibold text-foreground mt-0.5">{fmt(totalCIT)}</p>
              </div>
              <div className={`rounded-lg border px-3 py-2 text-center ${totalExposure > 0 ? "bg-amber-50 border-amber-200" : "bg-muted/30 border-border"}`}>
                <p className="text-xs text-muted-foreground">Open Exposure</p>
                <p className={`text-sm font-semibold mt-0.5 ${totalExposure > 0 ? "text-amber-700" : "text-foreground"}`}>
                  {fmt(totalExposure)}
                </p>
              </div>
              <div className="rounded-lg bg-muted/30 border border-border px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground">Avg Score</p>
                <p className={`text-lg font-bold mt-0.5 ${avgScore >= 70 ? "text-emerald-600" : avgScore >= 50 ? "text-amber-600" : "text-red-600"}`}>
                  {avgScore}
                </p>
              </div>
            </div>
          )}
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="pt-0">
            {loading ? (
              <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading firm data…</span>
              </div>
            ) : rows.length === 0 ? (
              <div className="text-center py-8">
                <Building2 className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No companies found.</p>
              </div>
            ) : (
              <div className="rounded-xl border border-border overflow-x-auto">
                <table className="w-full text-xs min-w-[700px]">
                  <thead>
                    <tr className="bg-muted/40 border-b border-border text-muted-foreground">
                      <th className="text-left py-2.5 px-3 font-medium">Company</th>
                      <th className="text-center py-2.5 px-3 font-medium">Score</th>
                      <th className="text-center py-2.5 px-3 font-medium">Period</th>
                      <th className="text-center py-2.5 px-3 font-medium">Sign-off</th>
                      <th className="text-right py-2.5 px-3 font-medium">CIT Payable</th>
                      <th className="text-right py-2.5 px-3 font-medium">Open Exposure</th>
                      <th className="text-left py-2.5 px-3 font-medium">Next Deadline</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => (
                      <tr
                        key={row.companyId}
                        className={`border-b border-border/50 hover:bg-muted/20 ${row.grade === "Critical" ? "bg-red-50/40" : ""}`}
                      >
                        <td className="py-2.5 px-3">
                          <div className="font-semibold text-foreground truncate max-w-[160px]">{row.companyName}</div>
                          {row.tin && <div className="text-muted-foreground/60 text-[10px]">TIN: {row.tin}</div>}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <div className="flex flex-col items-center gap-1">
                            <span className={`text-sm font-bold ${row.score >= 70 ? "text-emerald-600" : row.score >= 50 ? "text-amber-600" : "text-red-600"}`}>
                              {row.score}
                            </span>
                            <Badge className={`text-[10px] border ${GRADE_STYLES[row.grade]}`}>
                              {row.grade}
                            </Badge>
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-center text-muted-foreground font-medium">
                          {row.latestPeriodYear ? `FY${row.latestPeriodYear}` : "—"}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                            row.signOffStatus === "locked" ? "bg-emerald-100 text-emerald-700"
                            : row.signOffStatus === "approved" ? "bg-blue-100 text-blue-700"
                            : row.signOffStatus ? "bg-amber-100 text-amber-700"
                            : "bg-muted text-muted-foreground"
                          }`}>
                            {row.signOffStatus ? SIGN_OFF_LABEL[row.signOffStatus] ?? row.signOffStatus : "Not started"}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono">
                          {row.citPayable > 0 ? fmt(row.citPayable) : "—"}
                        </td>
                        <td className={`py-2.5 px-3 text-right font-mono ${row.openExposure > 0 ? "text-amber-700 font-semibold" : "text-muted-foreground"}`}>
                          {row.openExposure > 0 ? fmt(row.openExposure) : "Nil"}
                          {row.criticalFindings > 0 && (
                            <span className="ml-1 text-[9px] text-red-600">({row.criticalFindings} critical)</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3">
                          {row.nextDeadline ? (
                            <div>
                              <span className={`font-medium ${new Date(row.nextDeadline) < new Date() ? "text-red-600" : "text-foreground"}`}>
                                {fmtDate(row.nextDeadline)}
                              </span>
                              <div className="text-muted-foreground/60 capitalize text-[10px] truncate max-w-[100px]">{row.nextDeadlineLabel}</div>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">No pending</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!loading && rows.length > 0 && (
              <p className="text-[10px] text-muted-foreground/60 mt-2">
                Scores computed via canonical lib: findings (30%), TP risk (20%), payment coverage (20%), filing deadlines (15%), sign-off status (15%). All CIT from committed computations.
              </p>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
