/**
 * HesabuAssurancePanel.tsx · IRON DOME NUCLEAR DESIGN
 *
 * Displays the results of the latest HESABU cross-statement validation run
 * (hesabu-validate Edge Function output) for the current upload.
 *
 * Shows H-01 to H-12 assertion results: expected value, actual value,
 * difference, tolerance, result (pass / fail / skip), severity.
 *
 * Pure display component — no business logic, no data writes.
 * All data from hesabu_validations + hesabu_validation_assertions (read-only).
 *
 * Iron Dome: reads only. Never writes. Never re-runs validation itself.
 * Caller (KingaTaxPanel) controls when to run hesabu-validate.
 */

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  CheckCircle,
  XCircle,
  MinusCircle,
  AlertTriangle,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface HesabuValidation {
  id:                     string;
  status:                 "all_pass" | "some_fail" | "blocked_missing_data";
  assertions_total:       number;
  assertions_passed:      number;
  assertions_failed:      number;
  assertions_skipped:     number;
  gate_satisfied:         boolean;
  validated_at:           string;
  function_version:       string;
  sfp_tolerance_tzs_used:  number | null;
  scf_tolerance_pct_used:  number | null;
  socie_tolerance_pct_used: number | null;
}

interface HesabuAssertion {
  id:              string;
  assertion_id:    string;
  assertion_name:  string;
  source_standard: string;
  result:          "pass" | "fail" | "skip";
  skip_reason:     string | null;
  expected_value:  number | null;
  actual_value:    number | null;
  difference:      number | null;
  tolerance_used:  number | null;
  within_tolerance: boolean | null;
  severity:        "critical" | "warn" | "info";
  detail:          string | null;
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface HesabuAssurancePanelProps {
  uploadId:  string;
  companyId: string;
  /** Called by parent after running hesabu-validate to reload latest results */
  refreshKey?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n: number | null, decimals = 0) => {
  if (n === null || n === undefined) return "—";
  return "TZS " + Math.abs(n).toLocaleString("en-TZ", { maximumFractionDigits: decimals });
};

const fmtDiff = (n: number | null) => {
  if (n === null || n === undefined) return "—";
  const abs = Math.abs(n).toLocaleString("en-TZ", { maximumFractionDigits: 0 });
  return n >= 0 ? `+TZS ${abs}` : `−TZS ${abs}`;
};

const severityColor: Record<string, string> = {
  critical: "text-red-700 bg-red-50 border-red-200",
  warn:     "text-amber-700 bg-amber-50 border-amber-200",
  info:     "text-sky-700 bg-sky-50 border-sky-200",
};

// ── Component ─────────────────────────────────────────────────────────────────

export function HesabuAssurancePanel({
  uploadId,
  companyId,
  refreshKey = 0,
}: HesabuAssurancePanelProps) {
  const [validation,  setValidation]  = useState<HesabuValidation | null>(null);
  const [assertions,  setAssertions]  = useState<HesabuAssertion[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [expanded,    setExpanded]    = useState(false);

  const fetchLatest = useCallback(async () => {
    setLoading(true);

    // Latest validation run for this upload
    const { data: valRow } = await supabase
      .from("hesabu_validations")
      .select("id, status, assertions_total, assertions_passed, assertions_failed, assertions_skipped, gate_satisfied, validated_at, function_version, sfp_tolerance_tzs_used, scf_tolerance_pct_used, socie_tolerance_pct_used")
      .eq("upload_id", uploadId)
      .order("validated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (valRow) {
      setValidation(valRow as HesabuValidation);

      const { data: aRows } = await supabase
        .from("hesabu_validation_assertions")
        .select("id, assertion_id, assertion_name, source_standard, result, skip_reason, expected_value, actual_value, difference, tolerance_used, within_tolerance, severity, detail")
        .eq("validation_id", valRow.id)
        .order("assertion_id", { ascending: true });

      setAssertions((aRows ?? []) as HesabuAssertion[]);
    } else {
      setValidation(null);
      setAssertions([]);
    }

    setLoading(false);
  }, [uploadId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchLatest(); }, [fetchLatest]);

  // ── Render helpers ─────────────────────────────────────────────────────────

  const gateIcon = () => {
    if (!validation) return <ShieldAlert className="w-5 h-5 text-amber-500" />;
    if (validation.gate_satisfied)  return <ShieldCheck className="w-5 h-5 text-emerald-500" />;
    if (validation.status === "blocked_missing_data") return <ShieldAlert className="w-5 h-5 text-amber-500" />;
    return <ShieldX className="w-5 h-5 text-red-500" />;
  };

  const gateBadge = () => {
    if (!validation) return (
      <Badge className="text-xs bg-amber-100 text-amber-800 border border-amber-200">Not validated</Badge>
    );
    if (validation.gate_satisfied) return (
      <Badge className="text-xs bg-emerald-100 text-emerald-800 border border-emerald-200">
        <CheckCircle className="w-3 h-3 mr-1" />Gate satisfied
      </Badge>
    );
    if (validation.status === "blocked_missing_data") return (
      <Badge className="text-xs bg-amber-100 text-amber-800 border border-amber-200">
        <AlertTriangle className="w-3 h-3 mr-1" />Missing data
      </Badge>
    );
    return (
      <Badge className="text-xs bg-red-100 text-red-800 border border-red-200">
        <XCircle className="w-3 h-3 mr-1" />{validation.assertions_failed} assertion{validation.assertions_failed !== 1 ? "s" : ""} failed
      </Badge>
    );
  };

  const resultIcon = (r: "pass" | "fail" | "skip") => {
    if (r === "pass") return <CheckCircle className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />;
    if (r === "fail") return <XCircle    className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />;
    return               <MinusCircle  className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />;
  };

  return (
    <Card className="bg-card border-border">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CollapsibleTrigger asChild>
              <button className="flex items-center gap-3 text-left">
                <div className="w-9 h-9 rounded-lg bg-indigo-900 flex items-center justify-center flex-shrink-0">
                  {gateIcon()}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base font-semibold text-foreground">
                      HESABU Assurance
                    </CardTitle>
                    {expanded
                      ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                      : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Cross-statement arithmetic validation · H-01 to H-12
                  </p>
                </div>
              </button>
            </CollapsibleTrigger>
            <div className="flex items-center gap-2">
              {gateBadge()}
              <button
                onClick={fetchLatest}
                className="p-1 rounded hover:bg-muted/50 text-muted-foreground"
                title="Refresh"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>

          {/* Summary strip */}
          {!loading && validation && (
            <div className="mt-3 grid grid-cols-4 gap-2">
              {[
                { label: "Total",   value: validation.assertions_total,   color: "text-foreground" },
                { label: "Passed",  value: validation.assertions_passed,  color: "text-emerald-700" },
                { label: "Failed",  value: validation.assertions_failed,  color: validation.assertions_failed > 0 ? "text-red-700" : "text-foreground" },
                { label: "Skipped", value: validation.assertions_skipped, color: "text-muted-foreground" },
              ].map(s => (
                <div key={s.label} className="rounded-lg bg-muted/30 border border-border px-3 py-2 text-center">
                  <p className="text-[10px] text-muted-foreground">{s.label}</p>
                  <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
                </div>
              ))}
            </div>
          )}

          {!loading && !validation && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3">
              <p className="text-xs font-medium text-amber-800 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" />
                HESABU validation has not been run for this upload.
              </p>
              <p className="text-xs text-amber-700 mt-1">
                Validation runs automatically after committing a tax computation. The sign-off
                gate requires a passing HESABU run before Tier 1 can be signed.
              </p>
            </div>
          )}
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="pt-0 space-y-3">
            {loading ? (
              <div className="flex items-center gap-2 py-6 justify-center text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading assertion results…</span>
              </div>
            ) : assertions.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No assertion detail available.
              </p>
            ) : (
              <>
                {/* Assertion table */}
                <div className="rounded-xl border border-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/40 border-b border-border text-muted-foreground">
                        <th className="text-left py-2 px-3 font-medium w-14">ID</th>
                        <th className="text-left py-2 px-3 font-medium">Assertion</th>
                        <th className="text-right py-2 px-3 font-medium hidden md:table-cell">Expected</th>
                        <th className="text-right py-2 px-3 font-medium hidden md:table-cell">Actual</th>
                        <th className="text-right py-2 px-3 font-medium hidden lg:table-cell">Difference</th>
                        <th className="text-center py-2 px-3 font-medium w-20">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {assertions.map((a) => (
                        <tr
                          key={a.id}
                          className={`border-b border-border/50 ${a.result === "fail" ? "bg-red-50/50" : ""}`}
                        >
                          <td className="py-2 px-3 font-mono font-semibold text-muted-foreground">
                            {a.assertion_id}
                          </td>
                          <td className="py-2 px-3">
                            <div className="flex items-start gap-1.5">
                              {resultIcon(a.result)}
                              <div>
                                <p className="font-medium text-foreground leading-tight">{a.assertion_name}</p>
                                {a.result === "fail" && a.detail && (
                                  <p className="text-[10px] text-red-700 mt-0.5 leading-snug">{a.detail}</p>
                                )}
                                {a.result === "skip" && a.skip_reason && (
                                  <p className="text-[10px] text-muted-foreground mt-0.5">{a.skip_reason}</p>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="py-2 px-3 text-right font-mono text-muted-foreground hidden md:table-cell">
                            {fmt(a.expected_value)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono hidden md:table-cell">
                            {fmt(a.actual_value)}
                          </td>
                          <td className={`py-2 px-3 text-right font-mono hidden lg:table-cell ${
                            a.difference !== null && Math.abs(a.difference) > 0 ? "text-amber-700" : "text-muted-foreground"
                          }`}>
                            {fmtDiff(a.difference)}
                          </td>
                          <td className="py-2 px-3 text-center">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border ${
                              a.result === "pass" ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                            : a.result === "fail" ? `border ${severityColor[a.severity] ?? "bg-red-100 text-red-800 border-red-200"}`
                            : "bg-muted text-muted-foreground border-border"
                            }`}>
                              {a.result.toUpperCase()}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Footer meta */}
                {validation && (
                  <p className="text-[10px] text-muted-foreground/70 pt-1 border-t border-border/40">
                    Run {new Date(validation.validated_at).toLocaleString()} ·{" "}
                    {validation.function_version} ·{" "}
                    SFP tolerance: {validation.sfp_tolerance_tzs_used !== null ? `TZS ${validation.sfp_tolerance_tzs_used}` : "default (1,000)"} ·{" "}
                    SCF tolerance: {validation.scf_tolerance_pct_used !== null ? `${(validation.scf_tolerance_pct_used * 100).toFixed(1)}%` : "default (1%)"} ·{" "}
                    SOCIE tolerance: {validation.socie_tolerance_pct_used !== null ? `${(validation.socie_tolerance_pct_used * 100).toFixed(1)}%` : "default (5%)"}
                  </p>
                )}
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
