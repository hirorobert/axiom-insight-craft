/**
 * TRAAuditReadinessPanel.tsx
 * Sprint 7 Item 1 — Iron Dome Nuclear Design
 *
 * Pre-TRA audit readiness checklist.
 * Checks 6 gates from live DB state. No hallucinated statuses.
 *
 * Gates:
 *   G1 — Tax computation committed (tax_computations row exists + is_committed = true)
 *   G2 — All AJEs approved (no draft adjusting_journal_entries for this period)
 *   G3 — Period sign-off locked (statement_sign_offs.status = 'locked')
 *   G4 — Findings reviewed (no 'open' findings older than 30 days)
 *   G5 — EFDMS records present (at least one efdms_z_reports row for this period)
 *   G6 — Evidence requests closed (no open evidence_requests for this company)
 *
 * Iron Dome constraints:
 *   - All gate states from DB only — no UI inference
 *   - "Print Manifest" generates a timestamped text manifest, does not delete anything
 */

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  ShieldCheck,
  Printer,
  RefreshCw,
  Clock,
  FileText,
  BookOpen,
  Receipt,
  UserCheck,
  ClipboardList,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "sonner";

// ── Types ─────────────────────────────────────────────────────────────────────

type GateStatus = "pass" | "fail" | "warn" | "loading";

interface Gate {
  id: string;
  label: string;
  detail: string;
  status: GateStatus;
  icon: React.ElementType;
  actionHint?: string;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  companyId: string;
  uploadId: string;
  periodYear: number;
  periodMonth: number;
  companyName?: string;
  userId: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<GateStatus, { bg: string; icon: string; badge: string; label: string }> = {
  pass:    { bg: "bg-emerald-50 border-emerald-200", icon: "text-emerald-600", badge: "bg-emerald-100 text-emerald-800 border-emerald-200", label: "Pass" },
  fail:    { bg: "bg-red-50 border-red-200",         icon: "text-red-600",     badge: "bg-red-100 text-red-800 border-red-200",             label: "Action required" },
  warn:    { bg: "bg-amber-50 border-amber-200",     icon: "text-amber-600",   badge: "bg-amber-100 text-amber-800 border-amber-200",       label: "Review" },
  loading: { bg: "bg-muted/30 border-border",        icon: "text-muted-foreground", badge: "bg-muted text-muted-foreground border-border",  label: "Checking…" },
};

const GateIcon: Record<GateStatus, React.ElementType> = {
  pass:    CheckCircle,
  fail:    XCircle,
  warn:    AlertTriangle,
  loading: Loader2,
};

// ── Component ─────────────────────────────────────────────────────────────────

export function TRAAuditReadinessPanel({
  companyId, uploadId, periodYear, periodMonth, companyName, userId
}: Props) {
  const [gates, setGates] = useState<Gate[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);

  const runChecks = useCallback(async () => {
    setLoading(true);

    // Run all checks in parallel
    const [
      { data: taxComps },
      { data: draftAjes },
      { data: signOff },
      { data: staleFindings },
      { data: efdmsRows },
      { data: openEvidence },
    ] = await Promise.all([
      // G1: Tax computation committed
      supabase
        .from("tax_computations")
        .select("id, is_committed")
        .eq("company_id", companyId)
        .eq("upload_id", uploadId)
        .order("created_at", { ascending: false })
        .limit(1),

      // G2: Draft AJEs for this period
      supabase
        .from("adjusting_journal_entries")
        .select("id, aje_number")
        .eq("company_id", companyId)
        .eq("period_year", periodYear)
        .eq("status", "draft")
        .limit(10),

      // G3: Statement sign-off locked
      supabase
        .from("statement_sign_offs")
        .select("id, status")
        .eq("company_id", companyId)
        .eq("period_year", periodYear)
        .limit(1),

      // G4: Open findings older than 30 days
      supabase
        .from("findings")
        .select("id, title")
        .eq("company_id", companyId)
        .eq("status", "open")
        .lt("created_at", new Date(Date.now() - 30 * 86400_000).toISOString())
        .limit(10),

      // G5: EFDMS Z-Reports for this period (data now in efdms_z_reports via safisha-efdms-ingest)
      supabase
        .from("efdms_z_reports")
        .select("id")
        .eq("company_id", companyId)
        .gte("report_date", `${periodYear}-${String(periodMonth).padStart(2, "0")}-01`)
        .lte("report_date", `${periodYear}-${String(periodMonth).padStart(2, "0")}-31`)
        .limit(1),

      // G6: Open evidence requests
      supabase
        .from("evidence_requests")
        .select("id, request_title")
        .eq("company_id", companyId)
        .in("status", ["open", "pending"])
        .limit(10),
    ]);

    // G1 evaluation
    const latestComp = taxComps?.[0];
    const g1: Gate = {
      id: "tax_committed",
      label: "Tax computation committed",
      icon: BookOpen,
      status: latestComp?.is_committed
        ? "pass"
        : latestComp
        ? "fail"
        : "fail",
      detail: latestComp?.is_committed
        ? "ITA Chapter 332 tax computation has been committed and locked."
        : latestComp
        ? "Tax computation exists but has not been committed. Open Kinga Tax Panel and click Commit Computation."
        : "No tax computation found for this period. Run the Kinga Tax Engine first.",
      actionHint: latestComp?.is_committed ? undefined : "Open the Corporate Tax (ITA) panel → Commit Computation",
    };

    // G2 evaluation
    const draftCount = (draftAjes ?? []).length;
    const g2: Gate = {
      id: "ajes_approved",
      label: "Adjusting Journal Entries approved",
      icon: FileText,
      status: draftCount === 0 ? "pass" : "fail",
      detail: draftCount === 0
        ? "All AJEs for this period are approved — none in draft state."
        : `${draftCount} draft AJE${draftCount > 1 ? "s" : ""} pending approval: ${(draftAjes ?? []).slice(0, 3).map(a => a.aje_number).join(", ")}${draftCount > 3 ? "…" : ""}.`,
      actionHint: draftCount > 0 ? "Open Adjusting Journal Entries → approve each draft (partner/owner role required)" : undefined,
    };

    // G3 evaluation
    const signOffRow = signOff?.[0];
    const g3Status: GateStatus = !signOffRow
      ? "fail"
      : signOffRow.status === "locked"
      ? "pass"
      : signOffRow.status === "approved"
      ? "warn"
      : "fail";
    const g3: Gate = {
      id: "period_locked",
      label: "Period sign-off locked",
      icon: UserCheck,
      status: g3Status,
      detail: !signOffRow
        ? "No sign-off record found. Period close has not been initiated — open Period Close Manager in Settings."
        : signOffRow.status === "locked"
        ? "Period has been through 3-tier review and is locked. The DB prevents further changes (RLS enforced)."
        : signOffRow.status === "approved"
        ? "Period is approved but not yet locked. Lock it in Period Close Manager (Settings) to prevent further changes."
        : `Period is at '${signOffRow.status}' stage — 3-tier review not yet complete.`,
      actionHint: g3Status !== "pass" ? "Settings → Period Close Manager → complete sign-off chain → Lock" : undefined,
    };

    // G4 evaluation
    const staleCount = (staleFindings ?? []).length;
    const g4: Gate = {
      id: "findings_reviewed",
      label: "Findings reviewed (no stale open items)",
      icon: ClipboardList,
      status: staleCount === 0 ? "pass" : "warn",
      detail: staleCount === 0
        ? "No findings have been open for more than 30 days without action."
        : `${staleCount} finding${staleCount > 1 ? "s" : ""} have been open for over 30 days: ${(staleFindings ?? []).slice(0, 2).map(f => f.title).join("; ")}${staleCount > 2 ? "…" : ""}`,
      actionHint: staleCount > 0 ? "Open Kinga Findings → mark each item in_progress or resolved with a note" : undefined,
    };

    // G5 evaluation
    const hasEFDMS = (efdmsRows ?? []).length > 0;
    const g5: Gate = {
      id: "efdms_present",
      label: "EFDMS records present for period",
      icon: Receipt,
      status: hasEFDMS ? "pass" : "warn",
      detail: hasEFDMS
        ? "At least one EFDMS record has been logged for this period — EFDMS reconciliation is possible."
        : "No EFDMS records for this period/month. Add records from the EFDMS Reconciliation panel (from TRA portal export).",
      actionHint: !hasEFDMS ? "EFDMS Reconciliation panel → Add EFDMS Record" : undefined,
    };

    // G6 evaluation
    const openEvCount = (openEvidence ?? []).length;
    const g6: Gate = {
      id: "evidence_closed",
      label: "Evidence requests closed",
      icon: FileText,
      status: openEvCount === 0 ? "pass" : "warn",
      detail: openEvCount === 0
        ? "No open evidence requests — all outstanding evidence has been collected or closed."
        : `${openEvCount} open evidence request${openEvCount > 1 ? "s" : ""} — response pending from client.`,
      actionHint: openEvCount > 0 ? "Kinga Findings → Evidence Requests → follow up or close each item" : undefined,
    };

    setGates([g1, g2, g3, g4, g5, g6]);
    setLoading(false);
  }, [companyId, uploadId, periodYear, periodMonth]);

  useEffect(() => { runChecks(); }, [runChecks]);

  // ── Score ──────────────────────────────────────────────────────────────────
  const passes   = gates.filter(g => g.status === "pass").length;
  const fails    = gates.filter(g => g.status === "fail").length;
  const warns    = gates.filter(g => g.status === "warn").length;
  const total    = gates.length;
  const score    = total > 0 ? Math.round((passes / total) * 100) : 0;
  const ready    = fails === 0 && warns === 0;
  const partialOk = fails === 0 && warns > 0;

  // ── Print manifest ─────────────────────────────────────────────────────────
  const handlePrintManifest = () => {
    const lines = [
      `TRA AUDIT READINESS MANIFEST`,
      `Generated: ${new Date().toLocaleString("en-TZ", { timeZone: "Africa/Dar_es_Salaam" })} (EAT)`,
      `Company: ${companyName ?? companyId}`,
      `Period: FY${periodYear}`,
      `Prepared by user: ${userId}`,
      ``,
      `GATE STATUS`,
      `───────────`,
      ...gates.map(g => `[${g.status.toUpperCase().padEnd(7)}] ${g.label}`),
      ``,
      `Score: ${passes}/${total} gates passed`,
      `Readiness: ${ready ? "AUDIT READY" : partialOk ? "REVIEW ITEMS BEFORE SUBMISSION" : "NOT READY — ACTION REQUIRED"}`,
      ``,
      `IRON DOME NUCLEAR DESIGN — All statuses read from live DB at time of generation.`,
      `This manifest does not alter any records.`,
    ];
    const text = lines.join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit_manifest_${companyName?.replace(/\s+/g, "_") ?? companyId}_FY${periodYear}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Audit manifest downloaded");
  };

  // ── Overall badge ──────────────────────────────────────────────────────────
  const overallBadge = ready
    ? { label: "Audit Ready", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" }
    : partialOk
    ? { label: "Review items", cls: "bg-amber-100 text-amber-800 border-amber-200" }
    : { label: "Not ready", cls: "bg-red-100 text-red-800 border-red-200" };

  return (
    <Card className="bg-card border-border">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CollapsibleTrigger asChild>
              <button className="flex items-center gap-3 text-left">
                <div className="w-9 h-9 rounded-lg bg-indigo-900 flex items-center justify-center flex-shrink-0">
                  <ShieldCheck className="w-5 h-5 text-white" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base font-semibold text-foreground">
                      TRA Audit Readiness
                    </CardTitle>
                    {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {companyName ? `${companyName} · ` : ""}FY{periodYear} — {total} pre-submission gates
                  </p>
                </div>
              </button>
            </CollapsibleTrigger>

            <div className="flex items-center gap-2">
              {!loading && (
                <Badge className={`text-xs border ${overallBadge.cls}`}>
                  {ready
                    ? <CheckCircle className="w-3 h-3 mr-1" />
                    : partialOk
                    ? <AlertTriangle className="w-3 h-3 mr-1" />
                    : <XCircle className="w-3 h-3 mr-1" />
                  }
                  {overallBadge.label}
                </Badge>
              )}
              <button
                onClick={() => runChecks()}
                className="p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
                title="Refresh"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>

          {/* Progress bar */}
          {!loading && total > 0 && (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{passes}/{total} gates passed</span>
                <span className={`font-semibold ${ready ? "text-emerald-600" : fails > 0 ? "text-red-600" : "text-amber-600"}`}>{score}%</span>
              </div>
              <Progress
                value={score}
                className={`h-2 ${ready ? "[&>div]:bg-emerald-500" : fails > 0 ? "[&>div]:bg-red-500" : "[&>div]:bg-amber-500"}`}
              />
            </div>
          )}
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="space-y-2 pt-0">
            {loading ? (
              <div className="flex items-center gap-2 py-6 justify-center text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Running readiness checks…</span>
              </div>
            ) : (
              <>
                {/* Gate list */}
                <div className="space-y-2">
                  {gates.map(gate => {
                    const styles = STATUS_STYLES[gate.status];
                    const StatusIcon = GateIcon[gate.status];
                    const FieldIcon = gate.icon;
                    return (
                      <div
                        key={gate.id}
                        className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${styles.bg}`}
                      >
                        <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
                          <FieldIcon className="w-4 h-4 text-muted-foreground" />
                          <StatusIcon className={`w-4 h-4 ${styles.icon} ${gate.status === "loading" ? "animate-spin" : ""}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-foreground">{gate.label}</span>
                            <Badge className={`text-[10px] px-1.5 py-0 border ${styles.badge}`}>
                              {styles.label}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">{gate.detail}</p>
                          {gate.actionHint && (
                            <p className="text-xs text-indigo-600 mt-1 flex items-center gap-1">
                              <Clock className="w-3 h-3 flex-shrink-0" />
                              {gate.actionHint}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Actions */}
                <div className="pt-2 border-t border-border/40 flex items-center justify-between flex-wrap gap-2">
                  <p className="text-xs text-muted-foreground">
                    {ready
                      ? "All gates passed — this period is ready for TRA submission or audit defense."
                      : fails > 0
                      ? `${fails} gate${fails > 1 ? "s" : ""} must be resolved before audit submission.`
                      : `${warns} item${warns > 1 ? "s" : ""} to review — not blocking but recommended.`}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 text-xs"
                    onClick={handlePrintManifest}
                    disabled={loading}
                  >
                    <Printer className="w-3.5 h-3.5" />
                    Download Manifest
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
