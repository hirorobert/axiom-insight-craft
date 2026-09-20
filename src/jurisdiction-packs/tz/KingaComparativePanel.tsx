import { useEffect, useState } from "react";
import { Loader2, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface Props {
  companyId: string;
  currentPeriodId?: string;
}

interface Movement {
  line_item: string;
  current: number;
  prior: number;
  change: number;
  change_pct: number | null;
  flag: "green" | "amber" | "red";
}

interface Period {
  id: string;
  period_label: string;
  fiscal_year_end: string;
}

const fmtTZS = (n: number) =>
  `TZS ${Math.round(n).toLocaleString("en-US")}`;

const flagClass = (f: Movement["flag"]) =>
  f === "red"
    ? "bg-destructive/15 text-destructive border-destructive/30"
    : f === "amber"
      ? "bg-yellow-500/15 text-yellow-600 border-yellow-500/30"
      : "bg-accent/15 text-accent border-accent/30";

export function KingaComparativePanel({ companyId, currentPeriodId }: Props) {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [currentId, setCurrentId] = useState<string>(currentPeriodId ?? "");
  const [priorId, setPriorId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [result, setResult] = useState<any>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("fiscal_periods")
        .select("id, period_label, fiscal_year_end")
        .eq("company_id", companyId)
        .order("fiscal_year_end", { ascending: false });
      if (data) setPeriods(data);
    })();
  }, [companyId]);

  const run = async () => {
    if (!currentId || !priorId) {
      toast.error("Select both current and prior periods");
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        "kinga-comparative-engine",
        {
          body: {
            company_id: companyId,
            current_period_id: currentId,
            prior_period_id: priorId,
          },
        },
      );
      if (error) throw error;
      setResult(data);
      toast.success("Comparative analysis complete");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setLoading(false);
    }
  };

  const renderRows = (rows: Movement[], heading: string) => (
    <>
      <tr className="bg-muted/40">
        <td colSpan={5} className="px-3 py-2 text-sm font-semibold text-foreground">
          {heading}
        </td>
      </tr>
      {rows.map((r) => (
        <tr key={`${heading}-${r.line_item}`} className="border-t border-border">
          <td className="px-3 py-2 text-sm">{r.line_item}</td>
          <td className="px-3 py-2 text-right text-sm">{fmtTZS(r.current)}</td>
          <td className="px-3 py-2 text-right text-sm">{fmtTZS(r.prior)}</td>
          <td className="px-3 py-2 text-right text-sm">{fmtTZS(r.change)}</td>
          <td className="px-3 py-2 text-right">
            <Badge variant="outline" className={flagClass(r.flag)}>
              {r.change_pct === null ? "n/a" : `${r.change_pct.toFixed(1)}%`}
            </Badge>
          </td>
        </tr>
      ))}
    </>
  );

  const ratioRows = result
    ? [
        ["Gross margin %", result.ratios.current.gross_margin_pct, result.ratios.prior.gross_margin_pct],
        ["Net margin %", result.ratios.current.net_margin_pct, result.ratios.prior.net_margin_pct],
        ["Current ratio", result.ratios.current.current_ratio, result.ratios.prior.current_ratio],
        ["Debt-to-equity", result.ratios.current.debt_to_equity, result.ratios.prior.debt_to_equity],
        ["Receivable days", result.ratios.current.receivable_days, result.ratios.prior.receivable_days],
      ]
    : [];

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-primary" />
          Kinga — Comparative Analysis (Module F)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label>Current period</Label>
            <Select value={currentId} onValueChange={setCurrentId}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                {periods.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.period_label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Prior period</Label>
            <Select value={priorId} onValueChange={setPriorId}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                {periods.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.period_label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button onClick={run} disabled={loading} className="w-full">
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Run Comparative Analysis
            </Button>
          </div>
        </div>

        {result && (
          <>
            <div className="overflow-x-auto border border-border rounded-lg">
              <table className="w-full">
                <thead className="bg-muted/60">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Line Item</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Current Year</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Prior Year</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Change</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Change %</th>
                  </tr>
                </thead>
                <tbody>
                  {renderRows(result.income_statement_movements, "Income Statement")}
                  {renderRows(result.balance_sheet_movements, "Balance Sheet")}
                  <tr className="bg-muted/40">
                    <td colSpan={5} className="px-3 py-2 text-sm font-semibold">Key Ratios</td>
                  </tr>
                  {ratioRows.map(([label, c, p]) => (
                    <tr key={String(label)} className="border-t border-border">
                      <td className="px-3 py-2 text-sm">{label}</td>
                      <td className="px-3 py-2 text-right text-sm">{c === null || c === undefined ? "n/a" : Number(c).toFixed(2)}</td>
                      <td className="px-3 py-2 text-right text-sm">{p === null || p === undefined ? "n/a" : Number(p).toFixed(2)}</td>
                      <td className="px-3 py-2 text-right text-sm">—</td>
                      <td className="px-3 py-2 text-right text-sm">—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Accordion type="multiple" className="w-full">
              <AccordionItem value="re">
                <AccordionTrigger>Retained Earnings Reconciliation (IAS 1.106)</AccordionTrigger>
                <AccordionContent>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>Opening RE</div><div className="text-right">{fmtTZS(result.retained_earnings_reconciliation.opening_re)}</div>
                    <div>Prior closing RE</div><div className="text-right">{fmtTZS(result.retained_earnings_reconciliation.prior_closing_re)}</div>
                    <div>PAT</div><div className="text-right">{fmtTZS(result.retained_earnings_reconciliation.pat)}</div>
                    <div>Implied dividends</div><div className="text-right">{fmtTZS(result.retained_earnings_reconciliation.implied_dividends)}</div>
                    <div>Reconciles?</div>
                    <div className="text-right">
                      <Badge variant="outline" className={result.retained_earnings_reconciliation.reconciles ? flagClass("green") : flagClass("red")}>
                        {result.retained_earnings_reconciliation.reconciles ? "Yes" : "No"}
                      </Badge>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="amt">
                <AccordionTrigger>AMT 3-Year Risk (ITA s.65)</AccordionTrigger>
                <AccordionContent>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>Consecutive loss years</div><div className="text-right">{result.amt_risk.consecutive_loss_years}</div>
                    <div>Minimum tax applies</div>
                    <div className="text-right">
                      <Badge variant="outline" className={result.amt_risk.minimum_tax_applies ? flagClass("red") : flagClass("green")}>
                        {result.amt_risk.minimum_tax_applies ? "Yes (confirm 3rd year)" : "No"}
                      </Badge>
                    </div>
                    {result.amt_risk.minimum_tax_applies && (
                      <>
                        <div>Indicative minimum tax</div>
                        <div className="text-right">{fmtTZS(result.amt_risk.minimum_tax_amount_tzs)}</div>
                      </>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="ecl">
                <AccordionTrigger>ECL Adequacy (IFRS 9)</AccordionTrigger>
                <AccordionContent>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>Current receivables</div><div className="text-right">{fmtTZS(result.ecl_adequacy.current_receivables)}</div>
                    <div>Prior receivables</div><div className="text-right">{fmtTZS(result.ecl_adequacy.prior_receivables)}</div>
                    <div>Receivables movement %</div>
                    <div className="text-right">{result.ecl_adequacy.receivables_movement_pct === null ? "n/a" : `${result.ecl_adequacy.receivables_movement_pct.toFixed(1)}%`}</div>
                    <div>ECL coverage %</div>
                    <div className="text-right">{result.ecl_adequacy.ecl_coverage_pct === null ? "n/a" : `${result.ecl_adequacy.ecl_coverage_pct.toFixed(2)}%`}</div>
                    <div>Adequacy</div>
                    <div className="text-right">
                      <Badge variant="outline" className={result.ecl_adequacy.adequacy_flag === "adequate" ? flagClass("green") : result.ecl_adequacy.adequacy_flag === "review" ? flagClass("amber") : flagClass("red")}>
                        {result.ecl_adequacy.adequacy_flag}
                      </Badge>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </>
        )}
      </CardContent>
    </Card>
  );
}