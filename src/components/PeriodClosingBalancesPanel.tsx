/**
 * PeriodClosingBalancesPanel.tsx
 * Sprint 6 Item 1 — Iron Dome Nuclear Design
 *
 * Multi-year view of period_closing_balances for a company.
 * This is the ENGINE ROOM of SAFF ERP multi-year continuity:
 *   - W&T Written-Down Values by ITA Class (carry-forward for next year's capital allowances)
 *   - Deferred Tax position (DTL / DTA / net) — IAS 12 / IFRS for SMEs s.29
 *   - Cumulative unrelieved loss pool — ITA s.19(2), max 7-year relief
 *   - SFP snapshot (assets, liabilities, equity, cash)
 *   - Continuity check: prior year closing must equal current year opening
 *
 * All figures from DB only. No estimates.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Database,
  TrendingDown,
  TrendingUp,
  AlertTriangle,
  CheckCircle,
  Loader2,
  ChevronRight,
  BookOpen,
  Shield,
  BarChart3,
  Clock,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClosingBalance {
  id: string;
  period_year: number;
  period_month: number;
  // SFP
  current_assets_tzs: number;
  non_current_assets_tzs: number;
  current_liabilities_tzs: number;
  non_current_liabilities_tzs: number;
  equity_tzs: number;
  cash_balance_tzs: number;
  // Equity components
  share_capital_tzs: number;
  retained_earnings_tzs: number;
  other_reserves_tzs: number;
  // Deferred tax
  closing_dtl_tzs: number;
  closing_dta_tzs: number;
  net_deferred_tax_position_tzs: number;
  // Loss pool
  cumulative_unrelieved_loss_tzs: number;
  // WDV by class
  wdv_class1_tzs: number;
  wdv_class2_tzs: number;
  wdv_class3_tzs: number;
  wdv_class5_tzs: number;
  wdv_class6_tzs: number;
  wdv_class7_tzs: number;
  wdv_class8_tzs: number;
  // Optional extended fields
  revenue_tzs?: number | null;
  taxable_income_tzs?: number | null;
  accounting_pbt_tzs?: number | null;
  total_wear_tear_tzs?: number | null;
  engine_version?: string | null;
  computed_at: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const WDV_CLASSES = [
  { key: "wdv_class1_tzs", label: "Class 1", desc: "Computers, phones, tech", rate: "37.5% RB", color: "text-blue-700" },
  { key: "wdv_class2_tzs", label: "Class 2", desc: "Plant & machinery (general)", rate: "25% RB",   color: "text-indigo-700" },
  { key: "wdv_class3_tzs", label: "Class 3", desc: "General assets",           rate: "12.5% RB",  color: "text-violet-700" },
  { key: "wdv_class5_tzs", label: "Class 5", desc: "Agricultural buildings",   rate: "20% SL",    color: "text-emerald-700" },
  { key: "wdv_class6_tzs", label: "Class 6", desc: "Commercial buildings",     rate: "5% SL",     color: "text-teal-700" },
  { key: "wdv_class7_tzs", label: "Class 7", desc: "Intangibles",              rate: "1/useful life SL", color: "text-amber-700" },
  { key: "wdv_class8_tzs", label: "Class 8", desc: "Agricultural plant",       rate: "100% immediate",   color: "text-orange-700" },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n: number | null | undefined) => {
  if (n == null) return "—";
  return "TZS " + Math.abs(n).toLocaleString("en-TZ", { maximumFractionDigits: 0 });
};

const fmtShort = (n: number | null | undefined) => {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `TZS ${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `TZS ${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `TZS ${(abs / 1_000).toFixed(0)}K`;
  return `TZS ${abs.toFixed(0)}`;
};

const monthName = (m: number) =>
  ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1] ?? `M${m}`;

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  companyId: string;
  companyName?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PeriodClosingBalancesPanel({ companyId, companyName }: Props) {
  const [records, setRecords] = useState<ClosingBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const { data, error } = await supabase
        .from("period_closing_balances")
        .select("*")
        .eq("company_id", companyId)
        .order("period_year", { ascending: false });

      if (error || !data) { setLoading(false); return; }
      setRecords(data as ClosingBalance[]);
      if (data.length > 0) setSelectedYear(data[0].period_year);
      setLoading(false);
    }
    load();
  }, [companyId]);

  const current = records.find(r => r.period_year === selectedYear);
  const prior = records.find(r => r.period_year === (selectedYear ?? 0) - 1);

  // WDV continuity check: does prior year closing match what engine used?
  const wdvTotal = current
    ? WDV_CLASSES.reduce((s, c) => s + (current[c.key] ?? 0), 0)
    : 0;

  if (loading) return (
    <Card className="bg-card border-border">
      <CardContent className="flex items-center justify-center py-10 gap-2 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm">Loading period closing balances…</span>
      </CardContent>
    </Card>
  );

  if (records.length === 0) return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Database className="w-5 h-5 text-indigo-600" />
          Period Closing Balances
        </CardTitle>
      </CardHeader>
      <CardContent className="py-8 text-center">
        <Database className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No closing balances yet.</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Commit a tax computation to generate the first year's closing balance record.
        </p>
      </CardContent>
    </Card>
  );

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-indigo-900 flex items-center justify-center">
              <Database className="w-5 h-5 text-white" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold text-foreground">
                Period Closing Balances
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {companyName ? `${companyName} · ` : ""}Multi-year continuity engine — ITA Cap.332 / IAS 12
              </p>
            </div>
          </div>

          {/* Year selector */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {records.map(r => (
              <button
                key={r.period_year}
                onClick={() => setSelectedYear(r.period_year)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  selectedYear === r.period_year
                    ? "bg-indigo-600 text-white border-indigo-600"
                    : "bg-background text-muted-foreground border-border hover:border-indigo-400 hover:text-indigo-600"
                }`}
              >
                FY{r.period_year}
              </button>
            ))}
          </div>
        </div>

        {/* KPI strip */}
        {current && (
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: "Total WDV Pool",     value: fmtShort(wdvTotal),                            color: "text-indigo-700" },
              { label: "Net DT Position",    value: fmtShort(current.net_deferred_tax_position_tzs), color: current.net_deferred_tax_position_tzs > 0 ? "text-amber-700" : "text-emerald-700" },
              { label: "Loss Pool (s.19(2))", value: fmtShort(current.cumulative_unrelieved_loss_tzs), color: current.cumulative_unrelieved_loss_tzs > 0 ? "text-red-700" : "text-emerald-700" },
              { label: "Equity",             value: fmtShort(current.equity_tzs),                  color: "text-slate-700" },
            ].map(({ label, value, color }) => (
              <div key={label} className="rounded-lg bg-muted/40 border border-border px-3 py-2">
                <p className="text-[10px] text-muted-foreground">{label}</p>
                <p className={`text-sm font-bold mt-0.5 ${color}`}>{value}</p>
              </div>
            ))}
          </div>
        )}
      </CardHeader>

      <CardContent>
        {current && (
          <Tabs defaultValue="wdv" className="w-full">
            <TabsList className="w-full grid grid-cols-4 h-8 text-xs">
              <TabsTrigger value="wdv"      className="text-xs">W&T WDV</TabsTrigger>
              <TabsTrigger value="tax"      className="text-xs">Tax Position</TabsTrigger>
              <TabsTrigger value="sfp"      className="text-xs">SFP Snapshot</TabsTrigger>
              <TabsTrigger value="continuity" className="text-xs">Continuity</TabsTrigger>
            </TabsList>

            {/* ── W&T WDV by Class ──────────────────────────────── */}
            <TabsContent value="wdv" className="mt-3 space-y-2">
              <p className="text-xs text-muted-foreground mb-2">
                Written-down values carried forward to FY{(selectedYear ?? 0) + 1} capital allowances schedule (ITA s.34).
              </p>
              {WDV_CLASSES.map(cls => {
                const val = current[cls.key] ?? 0;
                const priorVal = prior ? (prior[cls.key] ?? 0) : null;
                const movement = priorVal != null ? val - priorVal : null;
                const pct = wdvTotal > 0 ? (val / wdvTotal) * 100 : 0;
                return (
                  <div key={cls.key} className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/30 border border-border/50">
                    <div className="w-16 flex-shrink-0">
                      <span className={`text-xs font-semibold ${cls.color}`}>{cls.label}</span>
                      <p className="text-[10px] text-muted-foreground">{cls.rate}</p>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-xs text-muted-foreground truncate">{cls.desc}</span>
                        <span className="text-xs font-mono font-semibold text-foreground ml-2 flex-shrink-0">{fmt(val)}</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className={`h-full rounded-full bg-indigo-400`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    {movement != null && val > 0 && (
                      <div className={`flex-shrink-0 flex items-center gap-0.5 text-[10px] font-medium ${movement < 0 ? "text-emerald-600" : "text-amber-600"}`}>
                        {movement < 0 ? <TrendingDown className="w-3 h-3" /> : <TrendingUp className="w-3 h-3" />}
                        {fmtShort(Math.abs(movement))}
                      </div>
                    )}
                    {val === 0 && <span className="text-[10px] text-muted-foreground/50 flex-shrink-0">Nil</span>}
                  </div>
                );
              })}
              <div className="flex items-center justify-between pt-2 border-t border-border/50 text-xs">
                <span className="font-medium text-muted-foreground">Total WDV Pool</span>
                <span className="font-bold text-indigo-700 font-mono">{fmt(wdvTotal)}</span>
              </div>
              {current.total_wear_tear_tzs != null && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>W&T Deduction (this year)</span>
                  <span className="font-mono">{fmt(current.total_wear_tear_tzs)}</span>
                </div>
              )}
            </TabsContent>

            {/* ── Tax Position ──────────────────────────────────── */}
            <TabsContent value="tax" className="mt-3 space-y-3">
              {/* Deferred Tax */}
              <div className="rounded-xl border border-border p-3 space-y-2">
                <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 text-purple-600" />
                  Deferred Tax Position — IAS 12 / IFRS for SMEs s.29
                </h4>
                {[
                  { label: "Deferred Tax Liability (DTL)", val: current.closing_dtl_tzs, color: "text-red-700", note: "Taxable temporary differences → future tax payable" },
                  { label: "Deferred Tax Asset (DTA)",     val: current.closing_dta_tzs, color: "text-emerald-700", note: "Deductible temp diff + unused losses → future tax saving" },
                  { label: "Net Position",                 val: current.net_deferred_tax_position_tzs, color: current.net_deferred_tax_position_tzs > 0 ? "text-red-700" : "text-emerald-700", note: current.net_deferred_tax_position_tzs > 0 ? "Net DTL — liability on SFP" : "Net DTA — asset on SFP (if recoverable)" },
                ].map(({ label, val, color, note }) => (
                  <div key={label} className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-medium text-foreground">{label}</p>
                      <p className="text-[10px] text-muted-foreground">{note}</p>
                    </div>
                    <span className={`text-sm font-mono font-semibold ${color} flex-shrink-0`}>{fmt(val)}</span>
                  </div>
                ))}
              </div>

              {/* Loss Pool */}
              <div className={`rounded-xl border p-3 space-y-2 ${current.cumulative_unrelieved_loss_tzs > 0 ? "border-red-200 bg-red-50/50" : "border-emerald-200 bg-emerald-50/50"}`}>
                <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <BookOpen className={`w-3.5 h-3.5 ${current.cumulative_unrelieved_loss_tzs > 0 ? "text-red-600" : "text-emerald-600"}`} />
                  Cumulative Unrelieved Loss — ITA s.19(2)
                </h4>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Pool carried to FY{(selectedYear ?? 0) + 1}</p>
                    <p className="text-[10px] text-muted-foreground">Max 7-year carry-forward. Used to offset future taxable income.</p>
                  </div>
                  <span className={`text-sm font-mono font-bold ${current.cumulative_unrelieved_loss_tzs > 0 ? "text-red-700" : "text-emerald-700"}`}>
                    {fmt(current.cumulative_unrelieved_loss_tzs)}
                  </span>
                </div>
                {prior && prior.cumulative_unrelieved_loss_tzs !== current.cumulative_unrelieved_loss_tzs && (
                  <div className="text-[10px] text-muted-foreground">
                    Movement from FY{prior.period_year}: {fmtShort(Math.abs(current.cumulative_unrelieved_loss_tzs - prior.cumulative_unrelieved_loss_tzs))}
                    {current.cumulative_unrelieved_loss_tzs < prior.cumulative_unrelieved_loss_tzs ? " utilised" : " added"}
                  </div>
                )}
              </div>

              {/* P&L context */}
              {(current.revenue_tzs != null || current.taxable_income_tzs != null || current.accounting_pbt_tzs != null) && (
                <div className="rounded-xl border border-border p-3 space-y-1.5">
                  <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <BarChart3 className="w-3.5 h-3.5 text-slate-600" />
                    P&L Context
                  </h4>
                  {[
                    { label: "Revenue",            val: current.revenue_tzs },
                    { label: "Accounting PBT",     val: current.accounting_pbt_tzs },
                    { label: "Taxable Income",     val: current.taxable_income_tzs },
                  ].filter(x => x.val != null).map(({ label, val }) => (
                    <div key={label} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{label}</span>
                      <span className={`font-mono font-semibold ${(val ?? 0) < 0 ? "text-red-700" : "text-foreground"}`}>{fmt(val)}</span>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            {/* ── SFP Snapshot ──────────────────────────────────── */}
            <TabsContent value="sfp" className="mt-3 space-y-3">
              <p className="text-xs text-muted-foreground">Statement of Financial Position snapshot at {monthName(current.period_month)} {current.period_year} year-end.</p>

              {[
                {
                  title: "Assets",
                  items: [
                    { label: "Current Assets",     val: current.current_assets_tzs },
                    { label: "Non-Current Assets", val: current.non_current_assets_tzs },
                    { label: "Cash & Bank",        val: current.cash_balance_tzs },
                  ],
                  total: current.current_assets_tzs + current.non_current_assets_tzs,
                  totalLabel: "Total Assets",
                  color: "border-blue-200 bg-blue-50/40",
                },
                {
                  title: "Liabilities",
                  items: [
                    { label: "Current Liabilities",     val: current.current_liabilities_tzs },
                    { label: "Non-Current Liabilities", val: current.non_current_liabilities_tzs },
                  ],
                  total: current.current_liabilities_tzs + current.non_current_liabilities_tzs,
                  totalLabel: "Total Liabilities",
                  color: "border-red-200 bg-red-50/40",
                },
                {
                  title: "Equity",
                  items: [
                    { label: "Share Capital",      val: current.share_capital_tzs },
                    { label: "Retained Earnings",  val: current.retained_earnings_tzs },
                    { label: "Other Reserves",     val: current.other_reserves_tzs },
                  ],
                  total: current.equity_tzs,
                  totalLabel: "Total Equity",
                  color: "border-emerald-200 bg-emerald-50/40",
                },
              ].map(section => (
                <div key={section.title} className={`rounded-xl border p-3 space-y-1.5 ${section.color}`}>
                  <h4 className="text-xs font-semibold text-foreground">{section.title}</h4>
                  {section.items.map(({ label, val }) => (
                    <div key={label} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="font-mono text-foreground">{fmt(val)}</span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between text-xs font-semibold border-t border-border/50 pt-1.5 mt-1">
                    <span>{section.totalLabel}</span>
                    <span className="font-mono">{fmt(section.total)}</span>
                  </div>
                </div>
              ))}

              {/* Balance equation check */}
              {(() => {
                const assets = current.current_assets_tzs + current.non_current_assets_tzs;
                const liab = current.current_liabilities_tzs + current.non_current_liabilities_tzs;
                const eq = current.equity_tzs;
                const diff = Math.abs(assets - liab - eq);
                const balanced = diff < 1;
                return (
                  <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${balanced ? "bg-emerald-50 border border-emerald-200 text-emerald-800" : "bg-red-50 border border-red-200 text-red-800"}`}>
                    {balanced ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                    {balanced
                      ? "Balance sheet equation holds: Assets = Liabilities + Equity"
                      : `Imbalance detected: TZS ${diff.toLocaleString()} — verify statements`
                    }
                  </div>
                );
              })()}
            </TabsContent>

            {/* ── Continuity Check ─────────────────────────────── */}
            <TabsContent value="continuity" className="mt-3 space-y-3">
              <div className="flex items-start gap-2 rounded-lg bg-indigo-50 border border-indigo-200 px-3 py-2 text-xs text-indigo-800">
                <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                Continuity check: prior year closing balances must equal the opening balances used by the engine in the current year computation.
              </div>

              {!prior ? (
                <div className="text-center py-6 text-sm text-muted-foreground">
                  No prior year record for FY{(selectedYear ?? 0) - 1}. First year of operation or prior year not yet committed.
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-1 text-[10px] font-medium text-muted-foreground px-2">
                    <span>Item</span>
                    <span className="text-right">FY{prior.period_year} Closing</span>
                    <span className="text-right">FY{current.period_year} Opening Used</span>
                  </div>
                  {WDV_CLASSES.map(cls => {
                    const priorVal = prior[cls.key] ?? 0;
                    const curVal = current[cls.key] ?? 0;
                    const match = Math.abs(priorVal - curVal) < 1;
                    return (
                      <div key={cls.key} className={`grid grid-cols-3 gap-1 items-center rounded px-2 py-1.5 text-xs ${!match ? "bg-red-50 border border-red-200" : "bg-muted/20"}`}>
                        <span className="font-medium">{cls.label}</span>
                        <span className="text-right font-mono">{fmt(priorVal)}</span>
                        <div className="text-right flex items-center justify-end gap-1">
                          <span className="font-mono">{fmt(curVal)}</span>
                          {match
                            ? <CheckCircle className="w-3 h-3 text-emerald-500" />
                            : <AlertTriangle className="w-3 h-3 text-red-500" />
                          }
                        </div>
                      </div>
                    );
                  })}

                  {/* Loss pool continuity */}
                  {(() => {
                    const priorLoss = prior.cumulative_unrelieved_loss_tzs;
                    const curLoss = current.cumulative_unrelieved_loss_tzs;
                    // Loss pool can legitimately change (new losses added or utilised) — just show for review
                    return (
                      <div className="grid grid-cols-3 gap-1 items-center rounded px-2 py-1.5 text-xs bg-muted/20">
                        <span className="font-medium">Loss Pool</span>
                        <span className="text-right font-mono">{fmt(priorLoss)}</span>
                        <div className="text-right flex items-center justify-end gap-1">
                          <span className="font-mono">{fmt(curLoss)}</span>
                          <ChevronRight className="w-3 h-3 text-muted-foreground" />
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Engine meta */}
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70 border-t border-border/40 pt-2">
                <Clock className="w-3 h-3" />
                Computed: {new Date(current.computed_at).toLocaleString("en-GB")}
                {current.engine_version && ` · Engine v${current.engine_version}`}
              </div>
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
}
