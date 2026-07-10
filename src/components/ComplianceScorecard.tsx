/**
 * ComplianceScorecard.tsx
 * Sprint 5 Item 2 — Iron Dome Nuclear Design
 *
 * Weighted compliance risk score (0–100) per company.
 * All figures from real DB data only — no AI-hallucinated numbers.
 *
 * Risk factors (weighted):
 *   A. Open findings count × severity        (30 pts)
 *   B. Transfer pricing exposure              (20 pts)
 *   C. Payment coverage ratio                 (20 pts)
 *   D. Overdue filing deadlines               (15 pts)
 *   E. Period sign-off / lock status          (15 pts)
 *
 * Score interpretation:
 *   90–100 = Compliant (green)
 *   70–89  = Monitor (amber)
 *   50–69  = At Risk (orange)
 *   0–49   = Critical (red)
 */

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ShieldCheck,
  ShieldAlert,
  Shield,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Clock,
  Building2,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScoreFactor {
  label: string;
  score: number;      // 0–100 for this factor
  weight: number;     // 0–1
  contribution: number; // score × weight → points earned (0 – maxPts)
  maxPts: number;
  detail: string;
  status: "good" | "warn" | "bad";
}

interface CompanyScore {
  companyId: string;
  companyName: string;
  tin?: string;
  totalScore: number;        // 0–100
  grade: "Compliant" | "Monitor" | "At Risk" | "Critical";
  factors: ScoreFactor[];
  computedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const gradeColor = (grade: string) => {
  switch (grade) {
    case "Compliant": return { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-700", ring: "ring-emerald-300", badge: "bg-emerald-100 text-emerald-800 border-emerald-200" };
    case "Monitor":   return { bg: "bg-amber-50",   border: "border-amber-200",   text: "text-amber-700",   ring: "ring-amber-300",   badge: "bg-amber-100 text-amber-800 border-amber-200"   };
    case "At Risk":   return { bg: "bg-orange-50",  border: "border-orange-200",  text: "text-orange-700",  ring: "ring-orange-300",  badge: "bg-orange-100 text-orange-800 border-orange-200" };
    case "Critical":  return { bg: "bg-red-50",     border: "border-red-200",     text: "text-red-700",     ring: "ring-red-300",     badge: "bg-red-100 text-red-800 border-red-200"         };
    default:          return { bg: "bg-slate-50",   border: "border-slate-200",   text: "text-slate-700",   ring: "ring-slate-200",   badge: "bg-slate-100 text-slate-700 border-slate-200"   };
  }
};

const gradeIcon = (grade: string, cls = "w-5 h-5") => {
  switch (grade) {
    case "Compliant": return <ShieldCheck className={`${cls} text-emerald-600`} />;
    case "Monitor":   return <Shield className={`${cls} text-amber-600`} />;
    case "At Risk":   return <ShieldAlert className={`${cls} text-orange-600`} />;
    case "Critical":  return <ShieldAlert className={`${cls} text-red-600`} />;
    default:          return <Shield className={`${cls} text-slate-400`} />;
  }
};

const factorStatusIcon = (status: string) => {
  switch (status) {
    case "good": return <CheckCircle className="w-4 h-4 text-emerald-500 flex-shrink-0" />;
    case "warn": return <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />;
    case "bad":  return <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />;
    default:     return null;
  }
};

const scoreToGrade = (score: number): CompanyScore["grade"] => {
  if (score >= 90) return "Compliant";
  if (score >= 70) return "Monitor";
  if (score >= 50) return "At Risk";
  return "Critical";
};

const progressColor = (score: number) => {
  if (score >= 90) return "bg-emerald-500";
  if (score >= 70) return "bg-amber-500";
  if (score >= 50) return "bg-orange-500";
  return "bg-red-500";
};

const fmt = (n: number) => n.toLocaleString("en-TZ", { maximumFractionDigits: 0 });

// ── Score computation ─────────────────────────────────────────────────────────

async function computeCompanyScore(company: { id: string; name: string; tin?: string }): Promise<CompanyScore> {
  const now = new Date();

  // ── A: Findings (open + in_progress) ─────────────────────────────────────
  const { data: findings } = await supabase
    .from("findings")
    .select("status, exposure_amount_tzs, finding_category")
    .eq("company_id", company.id)
    .in("status", ["open", "in_progress"]);

  const openFindings = findings ?? [];
  const totalExposure = openFindings.reduce((s, f) => s + (Number(f.exposure_amount_tzs) || 0), 0);

  // severity: weight critical categories higher
  const highCats = ["cit_underpayment", "penalty", "minimum_tax_gap", "management_fee_disallowance"];
  const highCount = openFindings.filter(f => highCats.includes(f.finding_category)).length;
  const lowCount = openFindings.length - highCount;

  // Score A: 100 if 0 findings; deduct for each
  const findingDeduction = Math.min(100, highCount * 15 + lowCount * 8);
  const scoreA = Math.max(0, 100 - findingDeduction);
  const factorA: ScoreFactor = {
    label: "Open Findings",
    score: scoreA,
    weight: 0.30,
    contribution: scoreA * 0.30,
    maxPts: 30,
    detail: openFindings.length === 0
      ? "No open compliance findings"
      : `${openFindings.length} open finding${openFindings.length > 1 ? "s" : ""} (${highCount} high severity) — TZS ${fmt(totalExposure)} exposure`,
    status: scoreA >= 80 ? "good" : scoreA >= 50 ? "warn" : "bad",
  };

  // ── B: Transfer Pricing ───────────────────────────────────────────────────
  // Detect from findings categories
  const tpFindings = openFindings.filter(f =>
    ["management_fee_disallowance", "thin_cap_disallowance", "transfer_pricing"].includes(f.finding_category)
  );
  const tpExposure = tpFindings.reduce((s, f) => s + (Number(f.exposure_amount_tzs) || 0), 0);

  // Also check most recent tax computation for TP warnings
  const { data: taxComps } = await supabase
    .from("tax_computations")
    .select("result_json")
    .eq("company_id", company.id)
    .order("created_at", { ascending: false })
    .limit(1);

  const lastResult = taxComps?.[0]?.result_json as any;
  const tpWarnings = (lastResult?.classification_warnings ?? []).filter(
    (w: any) => ["management_fee", "thin_cap", "transfer_pricing"].includes(w?.category)
  ).length;

  const scoreB = tpFindings.length === 0 && tpWarnings === 0 ? 100 :
    Math.max(0, 100 - tpFindings.length * 25 - tpWarnings * 10);
  const factorB: ScoreFactor = {
    label: "Transfer Pricing Risk",
    score: scoreB,
    weight: 0.20,
    contribution: scoreB * 0.20,
    maxPts: 20,
    detail: tpFindings.length === 0 && tpWarnings === 0
      ? "No TP risk detected (ITA s.33 + s.12(2))"
      : `${tpFindings.length} TP finding${tpFindings.length !== 1 ? "s" : ""}, ${tpWarnings} warning${tpWarnings !== 1 ? "s" : ""} — TZS ${fmt(tpExposure)} exposure`,
    status: scoreB >= 90 ? "good" : scoreB >= 60 ? "warn" : "bad",
  };

  // ── C: Payment Coverage ───────────────────────────────────────────────────
  const { data: payments } = await supabase
    .from("tax_payments")
    .select("amount_paid_tzs")
    .eq("company_id", company.id);

  const totalPaid = (payments ?? []).reduce((s, p) => s + (Number(p.amount_paid_tzs) || 0), 0);

  let scoreC: number;
  let paymentDetail: string;
  if (totalExposure <= 0) {
    scoreC = 100;
    paymentDetail = "No outstanding exposure — no payment required";
  } else {
    const coverageRatio = totalPaid / totalExposure;
    scoreC = Math.min(100, Math.round(coverageRatio * 100));
    paymentDetail = `TZS ${fmt(totalPaid)} paid vs TZS ${fmt(totalExposure)} exposure (${Math.round(coverageRatio * 100)}% coverage)`;
  }
  const factorC: ScoreFactor = {
    label: "Payment Coverage",
    score: scoreC,
    weight: 0.20,
    contribution: scoreC * 0.20,
    maxPts: 20,
    detail: paymentDetail,
    status: scoreC >= 80 ? "good" : scoreC >= 50 ? "warn" : "bad",
  };

  // ── D: Overdue Deadlines ──────────────────────────────────────────────────
  // Count findings that are past their implied due date (period_end + grace)
  const { data: allFindings } = await supabase
    .from("findings")
    .select("period_end, status")
    .eq("company_id", company.id)
    .in("status", ["open", "in_progress"]);

  const overdueCount = (allFindings ?? []).filter(f => {
    if (!f.period_end) return false;
    const due = new Date(f.period_end);
    due.setDate(due.getDate() + 30); // 30-day grace
    return due < now;
  }).length;

  const scoreD = Math.max(0, 100 - overdueCount * 20);
  const factorD: ScoreFactor = {
    label: "Filing Deadlines",
    score: scoreD,
    weight: 0.15,
    contribution: scoreD * 0.15,
    maxPts: 15,
    detail: overdueCount === 0
      ? "All filing deadlines on track"
      : `${overdueCount} obligation${overdueCount > 1 ? "s" : ""} past the 30-day grace period`,
    status: scoreD >= 80 ? "good" : scoreD >= 50 ? "warn" : "bad",
  };

  // ── E: Period Sign-off Status ─────────────────────────────────────────────
  const { data: signOffs } = await supabase
    .from("statement_sign_offs")
    .select("status, locked_at")
    .eq("company_id", company.id)
    .order("period_year", { ascending: false })
    .limit(1);

  const latestSignOff = signOffs?.[0];
  let scoreE: number;
  let signOffDetail: string;
  if (!latestSignOff) {
    scoreE = 40;
    signOffDetail = "No sign-off record — statements not yet reviewed";
  } else {
    switch (latestSignOff.status) {
      case "locked":           scoreE = 100; signOffDetail = "Period locked — statements approved and immutable"; break;
      case "approved":         scoreE = 90;  signOffDetail = "Approver signed — awaiting lock"; break;
      case "reviewer_signed":  scoreE = 70;  signOffDetail = "Reviewer signed — awaiting approver"; break;
      case "preparer_signed":  scoreE = 50;  signOffDetail = "Preparer signed — awaiting reviewer"; break;
      default:                 scoreE = 30;  signOffDetail = "Sign-off in draft — no signatures yet";
    }
  }
  const factorE: ScoreFactor = {
    label: "Period Sign-off",
    score: scoreE,
    weight: 0.15,
    contribution: scoreE * 0.15,
    maxPts: 15,
    detail: signOffDetail,
    status: scoreE >= 80 ? "good" : scoreE >= 50 ? "warn" : "bad",
  };

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const totalScore = Math.round(
    factorA.contribution + factorB.contribution +
    factorC.contribution + factorD.contribution + factorE.contribution
  );

  return {
    companyId: company.id,
    companyName: company.name,
    tin: company.tin,
    totalScore,
    grade: scoreToGrade(totalScore),
    factors: [factorA, factorB, factorC, factorD, factorE],
    computedAt: now.toISOString(),
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ComplianceScorecard() {
  const [scores, setScores] = useState<CompanyScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    async function loadScores() {
      setLoading(true);
      const { data: companies } = await supabase
        .from("companies")
        .select("id, name, tin")
        .order("name", { ascending: true });

      if (!companies || companies.length === 0) {
        setScores([]);
        setLoading(false);
        return;
      }

      const results = await Promise.all(
        companies.map((c) => computeCompanyScore({ id: c.id, name: c.name, tin: c.tin ?? undefined }))
      );

      // Sort: Critical first, then by score ascending
      results.sort((a, b) => a.totalScore - b.totalScore);
      setScores(results);
      setLoading(false);
    }
    loadScores();
  }, []);

  const gradeCount = (g: string) => scores.filter(s => s.grade === g).length;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-slate-900 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold text-foreground">
                Compliance Scorecard
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                ITA Cap.332 R.E.2023 — weighted risk score per entity
              </p>
            </div>
          </div>

          {/* Portfolio summary badges */}
          {!loading && scores.length > 0 && (
            <div className="flex items-center gap-1.5">
              {gradeCount("Critical") > 0 && (
                <Badge className="bg-red-100 text-red-800 border border-red-200 text-xs">{gradeCount("Critical")} Critical</Badge>
              )}
              {gradeCount("At Risk") > 0 && (
                <Badge className="bg-orange-100 text-orange-800 border border-orange-200 text-xs">{gradeCount("At Risk")} At Risk</Badge>
              )}
              {gradeCount("Monitor") > 0 && (
                <Badge className="bg-amber-100 text-amber-800 border border-amber-200 text-xs">{gradeCount("Monitor")} Monitor</Badge>
              )}
              {gradeCount("Compliant") > 0 && (
                <Badge className="bg-emerald-100 text-emerald-800 border border-emerald-200 text-xs">{gradeCount("Compliant")} Compliant</Badge>
              )}
            </div>
          )}
        </div>

        {/* Scoring key */}
        <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
          {[
            { g: "Compliant", range: "90–100", cls: "text-emerald-700 bg-emerald-50 border-emerald-200" },
            { g: "Monitor",   range: "70–89",  cls: "text-amber-700 bg-amber-50 border-amber-200"   },
            { g: "At Risk",   range: "50–69",  cls: "text-orange-700 bg-orange-50 border-orange-200" },
            { g: "Critical",  range: "0–49",   cls: "text-red-700 bg-red-50 border-red-200"         },
          ].map(({ g, range, cls }) => (
            <div key={g} className={`rounded-lg border px-2 py-1.5 text-center ${cls}`}>
              <div className="font-semibold">{g}</div>
              <div className="text-[10px] opacity-70">{range}</div>
            </div>
          ))}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Computing compliance scores…</span>
          </div>
        ) : scores.length === 0 ? (
          <div className="text-center py-10">
            <Building2 className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No companies found. Add a company to see compliance scores.</p>
          </div>
        ) : (
          scores.map((company) => {
            const colors = gradeColor(company.grade);
            const isExpanded = expandedId === company.companyId;

            return (
              <Collapsible
                key={company.companyId}
                open={isExpanded}
                onOpenChange={(open) => setExpandedId(open ? company.companyId : null)}
              >
                <div className={`border rounded-xl overflow-hidden ${colors.border}`}>
                  {/* Company header row */}
                  <CollapsibleTrigger asChild>
                    <div className={`flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-muted/20 transition-colors ${colors.bg}`}>
                      {/* Grade icon */}
                      <div className="flex-shrink-0">
                        {gradeIcon(company.grade)}
                      </div>

                      {/* Company name */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-foreground truncate">{company.companyName}</span>
                          {company.tin && (
                            <span className="text-xs text-muted-foreground font-mono">TIN: {company.tin}</span>
                          )}
                        </div>
                      </div>

                      {/* Score gauge */}
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <div className="w-32">
                          <div className="flex justify-between text-xs mb-1">
                            <span className={`font-medium ${colors.text}`}>{company.grade}</span>
                            <span className={`font-bold ${colors.text}`}>{company.totalScore}/100</span>
                          </div>
                          <div className="h-2 bg-muted rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${progressColor(company.totalScore)}`}
                              style={{ width: `${company.totalScore}%` }}
                            />
                          </div>
                        </div>
                        {isExpanded
                          ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                          : <ChevronRight className="w-4 h-4 text-muted-foreground" />
                        }
                      </div>
                    </div>
                  </CollapsibleTrigger>

                  {/* Factor breakdown */}
                  <CollapsibleContent>
                    <div className="border-t border-border px-4 py-3 space-y-2 bg-background">
                      <p className="text-xs font-medium text-muted-foreground mb-3">
                        Score breakdown — computed {new Date(company.computedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} today
                      </p>
                      {company.factors.map((factor) => (
                        <div key={factor.label} className="space-y-1">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              {factorStatusIcon(factor.status)}
                              <span className="text-xs font-medium text-foreground">{factor.label}</span>
                              <span className="text-xs text-muted-foreground">({Math.round(factor.weight * 100)}% weight)</span>
                            </div>
                            <span className="text-xs font-semibold text-foreground">
                              {factor.contribution.toFixed(1)} / {factor.maxPts} pts
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${
                                  factor.status === "good" ? "bg-emerald-500" :
                                  factor.status === "warn" ? "bg-amber-500" : "bg-red-500"
                                }`}
                                style={{ width: `${factor.score}%` }}
                              />
                            </div>
                            <span className="text-[11px] text-muted-foreground w-8 text-right">{factor.score}</span>
                          </div>
                          <p className="text-[11px] text-muted-foreground pl-6">{factor.detail}</p>
                        </div>
                      ))}

                      {/* Trend placeholder */}
                      <div className="mt-3 pt-2 border-t border-border/40 flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="w-3 h-3" />
                        Score computed live from current DB state. Improve score by resolving findings, recording payments, and completing sign-off.
                      </div>
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            );
          })
        )}

        {/* Methodology footer */}
        {scores.length > 0 && (
          <div className="pt-2 border-t border-border/40 text-xs text-muted-foreground/70">
            <span className="font-medium text-muted-foreground">Score methodology: </span>
            Open findings (30%) + Transfer pricing risk (20%) + Payment coverage (20%) + Filing deadlines (15%) + Sign-off status (15%).
            All figures from live DB — no estimates.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
