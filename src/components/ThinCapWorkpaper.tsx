/**
 * ThinCapWorkpaper.tsx
 * Sprint 8 Item 2 — Iron Dome Nuclear Design
 *
 * ITA Chapter 332 s.12(2) Thin Capitalisation Analysis.
 *
 * Rule: Total qualifying debt must not exceed 70:30 debt-to-equity ratio for
 * exempt-controlled resident entities (25%+ non-resident/exempt ownership).
 * Local bank debt excluded by s.12(5)(ii).
 *
 * Reads latest tax_computations row for pre-filled values.
 * CPA enters resident bank debt (excluded from ratio) manually.
 *
 * GATED: total_debt_tzs and interest_expense_tzs are null when the thin cap
 * rate has not been verified in statutory_rules. When gated, the panel shows an
 * amber GATED notice — no computed tax position is shown. Do not display
 * "Within limit" when either debt or interest is null.
 *
 * Iron Dome: all DB figures from tax_computations only. No hardcoded threshold
 * used in a tax-position conclusion. Frontend computation is CPA workpaper only.
 */

import { useEffect, useState, useCallback } from "react";
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
import {
  Scale,
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle,
  AlertTriangle,
  Info,
  RefreshCw,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TaxComp {
  total_debt_tzs: number | null;
  total_equity_tzs: number | null;
  interest_expense_tzs: number | null;
  thin_cap_disallowed_tzs: number;
  debt_equity_ratio: number | null;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  companyId: string;
  uploadId: string;
  periodYear: number;
  companyName?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  "TZS " + Math.abs(n).toLocaleString("en-TZ", { maximumFractionDigits: 0 });

const pct = (n: number) => (n * 100).toFixed(1) + "%";

// MAX_RATIO is intentionally not a named constant — the rate must be verified in
// statutory_rules before being used. When total_debt_tzs is null, the panel is
// GATED and no computation is shown. Do not restore MAX_RATIO as a constant.

// ── Component ─────────────────────────────────────────────────────────────────

export function ThinCapWorkpaper({ companyId, uploadId, periodYear, companyName }: Props) {
  const [comp, setComp] = useState<TaxComp | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  // CPA inputs
  const [residentBankDebt, setResidentBankDebt] = useState("0");
  const [interestRate, setInterestRate] = useState("10");

  const fetchComp = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("tax_computations")
      .select("total_debt_tzs, total_equity_tzs, interest_expense_tzs, thin_cap_disallowed_tzs, debt_equity_ratio")
      .eq("company_id", companyId)
      .eq("upload_id", uploadId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (data?.[0]) {
      setComp({
        total_debt_tzs: data[0].total_debt_tzs !== null ? Number(data[0].total_debt_tzs) : null,
        total_equity_tzs: data[0].total_equity_tzs !== null ? Number(data[0].total_equity_tzs) : null,
        interest_expense_tzs: data[0].interest_expense_tzs !== null ? Number(data[0].interest_expense_tzs) : null,
        thin_cap_disallowed_tzs: Number(data[0].thin_cap_disallowed_tzs ?? 0),
        debt_equity_ratio: data[0].debt_equity_ratio !== null ? Number(data[0].debt_equity_ratio) : null,
      });
    }
    setLoading(false);
  }, [companyId, uploadId]);

  useEffect(() => { fetchComp(); }, [fetchComp]);

  // ── Gating check ───────────────────────────────────────────────────────────
  // When total_debt_tzs or interest_expense_tzs is null, the engine was unable to
  // compute thin cap because the rate has not been verified in statutory_rules.
  // Do NOT show a tax position conclusion (e.g. "Within limit") in this case.
  const isGated = comp !== null
    && (comp.total_debt_tzs === null || comp.interest_expense_tzs === null);

  // ── Computation (workpaper only — CPA reference, not authoritative tax position) ──
  // Only run when NOT gated. Uses 70:30 ratio per ITA s.12(2) as CPA reference.
  const totalDebt      = comp?.total_debt_tzs ?? 0;
  const residentDebt   = parseFloat(residentBankDebt) || 0;
  const qualifyingDebt = Math.max(0, totalDebt - residentDebt);
  const equity         = Math.max(0, comp?.total_equity_tzs ?? 0);
  // 70:30 = 2.333 — used only in CPA workpaper, not in any stored tax position
  const maxAllowable   = equity * (70 / 30);
  const excessDebt     = Math.max(0, qualifyingDebt - maxAllowable);
  const interest       = comp?.interest_expense_tzs ?? 0;

  // Disallowed interest = (excess debt / qualifying debt) × total interest expense
  const disallowedInterest = qualifyingDebt > 0
    ? Math.min(interest, (excessDebt / qualifyingDebt) * interest)
    : 0;

  const thinCapTriggered = !isGated && excessDebt > 0.01;
  const noDebtData = !isGated && totalDebt === 0 && equity === 0;

  // Actual ratio
  const actualRatio = !isGated && equity > 0 ? qualifyingDebt / equity : null;

  return (
    <Card className="bg-card border-border">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CollapsibleTrigger asChild>
              <button className="flex items-center gap-3 text-left">
                <div className="w-9 h-9 rounded-lg bg-rose-900 flex items-center justify-center flex-shrink-0">
                  <Scale className="w-5 h-5 text-white" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base font-semibold text-foreground">
                      Thin Capitalisation Workpaper
                    </CardTitle>
                    {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {companyName ? `${companyName} · ` : ""}FY{periodYear} — ITA s.12(2) thin cap interest limitation (70:30 rule)
                  </p>
                </div>
              </button>
            </CollapsibleTrigger>
            <div className="flex items-center gap-2">
              {!loading && isGated && (
                <Badge className="text-xs border bg-amber-100 text-amber-800 border-amber-200">
                  <AlertTriangle className="w-3 h-3 mr-1" />GATED — Rates Unverified
                </Badge>
              )}
              {!loading && !isGated && !noDebtData && (
                <Badge className={`text-xs border ${thinCapTriggered ? "bg-red-100 text-red-800 border-red-200" : "bg-emerald-100 text-emerald-800 border-emerald-200"}`}>
                  {thinCapTriggered
                    ? <><AlertTriangle className="w-3 h-3 mr-1" />Thin cap triggered</>
                    : <><CheckCircle className="w-3 h-3 mr-1" />Within limit</>}
                </Badge>
              )}
              <button onClick={fetchComp} className="p-1 rounded hover:bg-muted/50 text-muted-foreground">
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="space-y-4 pt-0">
            {loading ? (
              <div className="flex items-center gap-2 py-6 justify-center text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading tax computation data…</span>
              </div>
            ) : isGated ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 flex items-start gap-3">
                <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-amber-800">
                    GATED — Thin Cap rate not yet verified
                  </p>
                  <p className="text-xs text-amber-700 mt-1 leading-relaxed">
                    The thin capitalisation ratio (ITA s.12(2)) has not been confirmed against
                    the primary source text. The Kinga engine returned null for total_debt and
                    interest_expense — no tax position has been calculated.
                  </p>
                  <p className="text-xs text-amber-700 mt-1 leading-relaxed">
                    <strong>CPA action required:</strong> Confirm the correct debt:equity ratio against
                    ITA Cap.332 s.12(2) R.E.2023, and whether Finance Act 2026 amended this section.
                    Once confirmed, set <code className="bg-amber-100 px-1 rounded">verified_at</code> on
                    the <code className="bg-amber-100 px-1 rounded">thin_cap</code> row in
                    <code className="bg-amber-100 px-1 rounded">statutory_rules</code> via Supabase admin.
                    The engine will recompute on next run.
                  </p>
                  <p className="text-xs font-semibold text-amber-800 mt-2">
                    No tax position calculated. Do not conclude "Within limit."
                  </p>
                </div>
              </div>
            ) : noDebtData ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 flex items-start gap-3">
                <Info className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-amber-800">No debt/equity data from engine</p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    Thin cap data is populated by the Kinga Tax Engine on each run. If total debt and equity
                    are both zero, either (a) the engine has not been run yet, or (b) the company has no
                    interest-bearing debt — in which case ITA s.12(2) does not apply.
                  </p>
                </div>
              </div>
            ) : (
              <>
                {/* CPA inputs */}
                <div className="grid grid-cols-2 gap-3 p-3 rounded-xl bg-muted/20 border border-border">
                  <div>
                    <Label className="text-xs font-medium">Resident bank debt to exclude (TZS)</Label>
                    <p className="text-[10px] text-muted-foreground mb-1">ITA s.12 — resident bank lending excluded from 70:30 ratio</p>
                    <Input
                      type="number" min={0}
                      className="text-sm"
                      value={residentBankDebt}
                      onChange={e => setResidentBankDebt(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label className="text-xs font-medium">Assumed interest rate (%)</Label>
                    <p className="text-[10px] text-muted-foreground mb-1">Used to estimate disallowed interest on excess debt</p>
                    <Input
                      type="number" min={0} max={100} step={0.5}
                      className="text-sm"
                      value={interestRate}
                      onChange={e => setInterestRate(e.target.value)}
                    />
                  </div>
                </div>

                {/* Waterfall table */}
                <div className="rounded-xl border border-border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/40 border-b border-border text-xs text-muted-foreground">
                        <th className="text-left py-2 px-4 font-medium">ITA s.12(2) Computation</th>
                        <th className="text-right py-2 px-4 font-medium">TZS</th>
                        <th className="text-left py-2 px-4 font-medium hidden sm:table-cell">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        {
                          label: "Total interest-bearing debt (from TB)",
                          value: totalDebt,
                          note: "Per Kinga engine — balance sheet",
                          indent: false, bold: false,
                        },
                        {
                          label: "Less: resident bank debt (CPA entry)",
                          value: -residentDebt,
                          note: "ITA s.12 — excluded from thin cap ratio",
                          indent: true, bold: false,
                        },
                        {
                          label: "Net qualifying debt",
                          value: qualifyingDebt,
                          note: "Debt subject to 70:30 test",
                          indent: false, bold: true, divider: true,
                        },
                        {
                          label: "Total equity",
                          value: equity,
                          note: "Per Kinga engine — balance sheet",
                          indent: false, bold: false,
                        },
                        {
                          label: "Maximum allowable qualifying debt (70/30 × equity)",
                          value: maxAllowable,
                          note: `= ${equity > 0 ? fmt(equity) : "0"} × 2.333`,
                          indent: false, bold: false,
                        },
                        {
                          label: "Excess debt (qualifying − max allowable)",
                          value: excessDebt,
                          note: excessDebt > 0 ? "Thin cap triggered — interest add-back required" : "Within ITA s.12(2) limit",
                          indent: false, bold: true, divider: true,
                          highlight: excessDebt > 0 ? "red" : "green",
                        },
                        {
                          label: "Total interest expense (from TB)",
                          value: interest,
                          note: "Per Kinga engine",
                          indent: false, bold: false,
                        },
                        {
                          label: `Disallowed interest (${qualifyingDebt > 0 ? pct(excessDebt / qualifyingDebt) : "0%"} × interest)`,
                          value: disallowedInterest,
                          note: "= add-back to accounting PBT",
                          indent: false, bold: true, divider: true,
                          highlight: disallowedInterest > 0 ? "red" : "green",
                        },
                      ].map((row, i) => (
                        <tr key={i} className={`border-b border-border/50 ${(row as any).divider ? "border-b-2 border-border" : ""} ${(row as any).highlight === "red" ? "bg-red-50" : (row as any).highlight === "green" ? "bg-emerald-50" : ""}`}>
                          <td className={`py-2.5 px-4 ${(row as any).indent ? "pl-8" : ""} ${(row as any).bold ? "font-semibold" : ""} text-foreground`}>
                            {row.label}
                          </td>
                          <td className={`py-2.5 px-4 text-right font-mono ${(row as any).bold ? "font-semibold" : ""} ${(row as any).highlight === "red" ? "text-red-700" : (row as any).highlight === "green" ? "text-emerald-700" : "text-foreground"}`}>
                            {row.value < 0 ? `(${fmt(Math.abs(row.value))})` : fmt(row.value)}
                          </td>
                          <td className="py-2.5 px-4 text-xs text-muted-foreground hidden sm:table-cell">{row.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
<<<<<<< HEAD
=======

                {/* Ratio indicator */}
                <div className={`rounded-xl border px-4 py-3 flex items-start gap-3 ${thinCapTriggered ? "border-red-200 bg-red-50" : "border-emerald-200 bg-emerald-50"}`}>
                  {thinCapTriggered
                    ? <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                    : <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                  }
                  <div>
                    <p className={`text-sm font-semibold ${thinCapTriggered ? "text-red-800" : "text-emerald-800"}`}>
                      {actualRatio !== null
                        ? `Actual ratio: ${actualRatio.toFixed(2)}:1 (limit: 2.33:1)`
                        : "Ratio: N/A (equity is zero)"}
                    </p>
                    {thinCapTriggered ? (
                      <>
                        <p className="text-xs text-red-700 mt-0.5">
                          Thin cap applies — {fmt(disallowedInterest)} of interest expense must be added back to accounting PBT (ITA s.12(2)).
                        </p>
                        <p className="text-xs text-red-700 mt-1 font-medium">
                          Suggested AJE (if not already booked): Dr Interest Expense add-back / Cr Disallowed interest liability — {fmt(disallowedInterest)}.
                          Include note: "ITA s.12(2) thin cap disallowance — FY{periodYear}."
                        </p>
                      </>
                    ) : (
                      <p className="text-xs text-emerald-700 mt-0.5">
                        Debt:equity ratio is within the ITA s.12(2) 70:30 limit. All interest expense is deductible.
                      </p>
                    )}
                  </div>
                </div>

                {/* Footnote */}
                <p className="text-[10px] text-muted-foreground/70 border-t border-border/40 pt-2">
                  Source: ITA Chapter 332 s.12(2) (as amended); Deloitte Tanzania Transfer Pricing Guide Aug 2025.
                  Resident bank debt exclusion per ITA s.12. Maximum debt:equity ratio 70:30 (2.333:1).
                  Interest rate assumption is indicative only — use actual weighted average rate from loan agreements.
                  Kinga engine pre-populates debt/equity from balance sheet; CPA must confirm resident bank debt exclusion.
                </p>
>>>>>>> 331bb78 (fix(platform): enforce member identity, EFDMS controls, and statutory gating)
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
<<<<<<< HEAD
}
=======
}
>>>>>>> 331bb78 (fix(platform): enforce member identity, EFDMS controls, and statutory gating)
