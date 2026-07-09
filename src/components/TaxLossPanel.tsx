// ============================================================
// TaxLossPanel — ITA s.19 Loss Carry-Forward UI Panel
// Displays: opening pool, current year result, absorbed amount
//           (70% cap), closing pool, estimated recovery years,
//           DTA recognition status.
// Data sourced entirely from engine TaxResult — no AI inference.
// ============================================================

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingDown, TrendingUp, Clock, BookOpen, AlertTriangle, CheckCircle } from "lucide-react";

interface TaxResult {
  taxable_income_tzs?: number;
  loss_absorbed_this_year_tzs?: number;
  opening_cumulative_loss_tzs?: number;
  closing_cumulative_loss_tzs?: number;
  // Turnover proxy for recovery estimate
  total_revenue_tzs?: number;
  // Module D deferred tax
  module_d_deferred?: {
    dta_recognised?: boolean;
    dta_amount_tzs?: number;
    dtl_amount_tzs?: number;
    net_deferred_position?: number;
    recognition_note?: string;
  };
  [key: string]: unknown;
}

interface TaxLossPanelProps {
  result: TaxResult;
  periodYear: number;
  companyName?: string;
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-TZ", { maximumFractionDigits: 0 }).format(Math.abs(n));

const LOSS_SHELTER_CAP = 0.70; // ITA s.19(2)

export function TaxLossPanel({ result, periodYear, companyName }: TaxLossPanelProps) {
  const openingLoss = result.opening_cumulative_loss_tzs ?? 0;
  const absorbed = result.loss_absorbed_this_year_tzs ?? 0;
  const closingLoss = result.closing_cumulative_loss_tzs ?? 0;
  const taxableIncome = result.taxable_income_tzs ?? 0;

  // Panel is only relevant if there's a loss position (opening or closing)
  if (openingLoss <= 0 && closingLoss <= 0 && absorbed <= 0) return null;

  // Current year result — was it a profit or loss year?
  const isProfitYear = taxableIncome > 0;
  // Estimated gross taxable income for recovery rate estimation
  // Uses turnover × 5% pre-tax margin proxy if no better data
  const revenueProxy = (result.total_revenue_tzs as number | undefined) ?? 0;
  const annualProfitProxy = revenueProxy > 0 ? revenueProxy * 0.05 : 0;
  const maxAnnualRelief = annualProfitProxy * LOSS_SHELTER_CAP;
  const estimatedYearsToRecovery =
    maxAnnualRelief > 0 && closingLoss > 0
      ? Math.ceil(closingLoss / maxAnnualRelief)
      : null;

  const dta = result.module_d_deferred;
  const dtaRecognised = dta?.dta_recognised ?? false;
  const dtaAmount = dta?.dta_amount_tzs ?? 0;

  return (
    <Card className="border border-[#0E1D30]/20 rounded-xl overflow-hidden bg-card">
      <CardHeader className="bg-[#0E1D30]/5 border-b border-[#0E1D30]/20 px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-[#0E1D30] uppercase tracking-wide">
          <BookOpen className="w-4 h-4" />
          ITA s.19 — Tax Loss Carry-Forward Pool
          {companyName && (
            <span className="ml-auto text-[10px] font-normal text-muted-foreground normal-case tracking-normal">
              {companyName} · FY{periodYear}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-4">

        {/* ── Pool Timeline ── */}
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Item</th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground">TZS</th>
                <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Ref</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr>
                <td className="px-3 py-2">Opening unrelieved loss pool (b/f)</td>
                <td className="px-3 py-2 text-right font-mono text-destructive">
                  ({fmt(openingLoss)})
                </td>
                <td className="px-3 py-2 text-muted-foreground">ITA s.19(1)</td>
              </tr>
              <tr className={isProfitYear ? "" : "bg-destructive/5"}>
                <td className="px-3 py-2">
                  {isProfitYear ? "Current year taxable income (profit)" : "Current year tax loss added to pool"}
                </td>
                <td className={`px-3 py-2 text-right font-mono ${isProfitYear ? "text-green-700" : "text-destructive"}`}>
                  {isProfitYear ? fmt(taxableIncome) : `(${fmt(Math.abs(taxableIncome))})`}
                </td>
                <td className="px-3 py-2 text-muted-foreground">ITA s.19(2)</td>
              </tr>
              {absorbed > 0 && (
                <tr className="bg-green-50">
                  <td className="px-3 py-2">
                    Less: Prior-year loss absorbed this year
                    <span className="ml-1 text-[10px] text-muted-foreground">(70% cap of taxable income)</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-green-700">
                    − {fmt(absorbed)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">ITA s.19(2)</td>
                </tr>
              )}
              <tr className="bg-muted/20 font-bold border-t-2 border-border">
                <td className="px-3 py-2">Closing unrelieved loss pool (c/f)</td>
                <td className="px-3 py-2 text-right font-mono text-destructive">
                  ({fmt(closingLoss)})
                </td>
                <td className="px-3 py-2 text-muted-foreground">ITA s.19(3)</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* ── 70% Cap Explanation ── */}
        {absorbed > 0 && (
          <div className="flex items-start gap-2 text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-amber-800">
              <span className="font-semibold">ITA s.19(2) — Annual shelter cap:</span> Loss absorbed (TZS {fmt(absorbed)})
              is limited to 70% of taxable income. Remaining unrelieved loss (TZS {fmt(closingLoss)}) carries forward
              indefinitely under ITA s.19(3) — no expiry under Tanzania ITA Cap.332 R.E.2023.
            </p>
          </div>
        )}

        {/* ── Recovery Horizon — ILLUSTRATIVE ONLY ── */}
        {closingLoss > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <Clock className="w-3.5 h-3.5 text-amber-600" />
              <span className="text-xs font-semibold text-amber-800 uppercase tracking-wide">
                Indicative Recovery Horizon
              </span>
              <span className="ml-auto text-[10px] font-semibold text-amber-700 bg-amber-100 border border-amber-300 rounded px-1.5 py-0.5">
                ILLUSTRATIVE — NOT AN ACCOUNTING MEASUREMENT
              </span>
            </div>
            {estimatedYearsToRecovery !== null ? (
              <>
                <div className="flex items-end gap-3 mb-1">
                  <div>
                    <span className="text-2xl font-bold text-amber-900">{estimatedYearsToRecovery}</span>
                    <span className="text-sm text-amber-700 ml-1">years</span>
                  </div>
                  <p className="text-[11px] text-amber-700 pb-0.5">
                    Assumes TZS {fmt(annualProfitProxy)}/yr taxable profit (revenue × 5% margin proxy)
                    × 70% ITA s.19(2) shelter cap = TZS {fmt(maxAnnualRelief)}/yr absorption.
                  </p>
                </div>
                <p className="text-[10px] text-amber-700 border-t border-amber-200 pt-1.5 mt-1">
                  ⚠ Illustrative only. Based on an assumed 5% profit margin — not an accounting measurement.
                  Actual recovery depends on future taxable profits, which cannot be predicted.
                  Do not use this figure in financial statements or TRA submissions.
                </p>
              </>
            ) : (
              <p className="text-xs text-amber-700">
                Recovery horizon cannot be estimated — revenue data not available from the trial balance.
              </p>
            )}
          </div>
        )}

        {/* ── DTA Recognition Status ── */}
        <div className="rounded-lg border border-border px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            {dtaRecognised ? (
              <CheckCircle className="w-3.5 h-3.5 text-green-600" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
            )}
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Deferred Tax Asset (DTA) — IAS 12 / IFRS for SMEs s.29
            </span>
            <Badge
              className={
                dtaRecognised
                  ? "ml-auto bg-green-100 text-green-800 border-green-300"
                  : "ml-auto bg-amber-100 text-amber-800 border-amber-300"
              }
            >
              {dtaRecognised ? "Recognised" : "Not Recognised"}
            </Badge>
          </div>
          {dtaRecognised && dtaAmount > 0 ? (
            <div className="flex items-center gap-4 text-xs">
              <div>
                <span className="text-muted-foreground">DTA amount: </span>
                <span className="font-mono font-semibold">TZS {fmt(dtaAmount)}</span>
              </div>
              <div className="text-muted-foreground">
                (closing loss TZS {fmt(closingLoss)} × 30% CIT rate)
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {dta?.recognition_note ??
                "DTA not recognised — insufficient probability of future taxable profits (IFRS for SMEs s.29.7 / IAS 12.35). " +
                "Reassess each period as profit trajectory improves."}
            </p>
          )}
        </div>

        {/* ── Statutory Footer ── */}
        <p className="text-[10px] text-muted-foreground">
          ITA Cap.332 R.E.2023 s.19 — losses carry forward indefinitely, capped at 70% of taxable income per year.
          No carry-back. AMT (s.89) may apply if company reports a loss for 3+ consecutive years.
          DTA recognition per IFRS for SMEs Section 29 / IAS 12.
        </p>
      </CardContent>
    </Card>
  );
}
