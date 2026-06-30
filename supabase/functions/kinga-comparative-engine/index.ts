// ============================================================
// Axiom — kinga-comparative-engine Edge Function
// Version: Module F v1.0 — 2026-06-30
// Standards: IAS 1 / IPSAS 1 Comparability, ITA Cap.332
//
// PURPOSE:
//   Compares the current fiscal period TB against the prior fiscal
//   period TB for the same company. Produces:
//     1. Line-by-line movement table (amount, TZS change, % change)
//     2. Retained earnings reconciliation (IAS 1.106 / IPSAS 1.89)
//     3. Revenue trend + AMT 3-year risk assessment (ITA s.65)
//     4. ECL movement (IFRS 9 — receivables adequacy flag)
//     5. Deferred tax IS-vs-BS consistency check (IAS 12 / IPSAS 29)
//     6. Gross margin movement alert
//
// CALL SIGNATURE:
//   POST /functions/v1/kinga-comparative-engine
//   Body: { company_id, current_period_id, prior_period_id? }
//   If prior_period_id is omitted, the engine resolves it from
//   fiscal_periods.prior_period_id automatically.
//
// RESPONSE:
//   { status, comparative_report, findings[] }
//   where findings[] are auto-generated for the findings table.
// ============================================================

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ENGINE_VERSION = "Module F v1.0";

// ── Interfaces ─────────────────────────────────────────────────────────────────

interface PeriodTotals {
  revenue:      number;
  cogs:         number;
  gross_profit: number;
  op_expenses:  number;
  ebitda:       number;
  depreciation: number;
  ebit:         number;
  finance_cost: number;
  pbt:          number;
  tax_charge:   number;
  pat:          number;   // profit after tax
  // BS
  total_assets:       number;
  current_assets:     number;
  non_current_assets: number;
  trade_receivables:  number;
  cash_and_bank:      number;
  inventories:        number;
  total_liabilities:  number;
  current_liabilities:number;
  non_current_liabilities: number;
  total_equity:       number;
  retained_earnings_opening: number;
}

interface MovementRow {
  line_item:       string;
  current_tzs:     number;
  prior_tzs:       number;
  change_tzs:      number;
  change_pct:      number | null;
  flag:            "material" | "watch" | "ok" | "new" | "gone";
}

interface ComparativeReport {
  company_id:        string;
  current_period_id: string;
  prior_period_id:   string;
  current_year_end:  string;
  prior_year_end:    string;
  reporting_currency:string;

  // Movement tables
  income_statement:  MovementRow[];
  balance_sheet:     MovementRow[];

  // Key ratios — both years
  ratios: {
    gross_margin_pct:        { current: number | null; prior: number | null };
    net_margin_pct:          { current: number | null; prior: number | null };
    current_ratio:           { current: number | null; prior: number | null };
    debt_to_equity:          { current: number | null; prior: number | null };
    revenue_growth_pct:      number | null;
    receivables_days:        { current: number | null; prior: number | null };
  };

  // Retained earnings reconciliation (IAS 1.106 / IPSAS 1.89)
  retained_earnings_rec: {
    opening_re_per_current_tb: number;
    closing_re_per_prior_tb:   number;
    pat_from_prior_tb:         number;
    dividends_implied:         number;   // = prior closing RE + prior PAT - current opening RE
    reconciliation_ok:         boolean;
    difference:                number;
  };

  // AMT 3-year risk
  amt_risk: {
    current_year_loss:   boolean;
    prior_year_loss:     boolean;
    loss_years_tracked:  number;
    amt_applies:         boolean;
    minimum_tax_tzs:     number | null;
  };

  // ECL movement
  ecl: {
    current_receivables: number;
    prior_receivables:   number;
    movement_pct:        number | null;
    flag:                "adequate" | "deteriorating" | "improving" | "unknown";
  };

  // Deferred tax
  deferred_tax: {
    is_charge_current:   number;
    is_charge_prior:     number;
    flag:                "consistent" | "movement_unreconciled" | "unknown";
  };

  generated_at:  string;
  engine_version:string;
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function safePct(a: number, b: number): number | null {
  if (!b || b === 0) return null;
  return Math.round(((a - b) / Math.abs(b)) * 10000) / 100; // 2dp
}

function flagMovement(pct: number | null, absChange: number): MovementRow["flag"] {
  if (pct === null) return "ok";
  const absPct = Math.abs(pct);
  if (absPct >= 20 || Math.abs(absChange) >= 50_000_000) return "material";
  if (absPct >= 10 || Math.abs(absChange) >= 10_000_000) return "watch";
  return "ok";
}

function extractTotals(pr: Record<string, unknown>): PeriodTotals {
  const stmt = (pr["statements"] as Record<string, unknown>) ?? {};
  const is   = (stmt["income_statement"] as Record<string, Record<string, number>>) ?? {};
  const bs   = (stmt["balance_sheet"]    as Record<string, Record<string, number>>) ?? {};

  const get = (obj: Record<string, Record<string, number>>, key: string): number =>
    (obj[key] as Record<string, number>)?.total ?? 0;

  const revenue   = get(is, "revenue") + get(is, "other_income");
  const cogs      = get(is, "cost_of_goods_sold");
  const op_exp    = get(is, "operating_expenses");
  const tax_chg   = get(is, "taxes");
  const deprec    = 0; // extracted from op_expenses if needed — simplified
  const gross     = revenue - cogs;
  const ebit      = gross - op_exp;
  const finance   = 0; // from is.finance_costs if classified separately
  const pbt       = ebit - finance;
  const pat       = pbt - tax_chg;

  const cur_a  = get(bs, "current_assets");
  const ncur_a = get(bs, "non_current_assets");
  const cur_l  = get(bs, "current_liabilities");
  const ncur_l = get(bs, "non_current_liabilities");
  const equity = get(bs, "equity");

  // Try to find specific line items in BS accounts
  const bsAccounts = [
    ...((bs["current_assets"] as Record<string, unknown>)?.accounts as Record<string, unknown>[] ?? []),
    ...((bs["non_current_assets"] as Record<string, unknown>)?.accounts as Record<string, unknown>[] ?? []),
  ];

  const findBSLine = (patterns: RegExp[]): number => {
    for (const acc of bsAccounts) {
      const name = String(acc["account_name"] ?? "");
      if (patterns.some(p => p.test(name))) {
        return (acc["debit"] as number ?? 0) - (acc["credit"] as number ?? 0);
      }
    }
    return 0;
  };

  const equityAccounts = ((bs["equity"] as Record<string, unknown>)?.accounts as Record<string, unknown>[] ?? []);
  const findRE = (): number => {
    for (const acc of equityAccounts) {
      const name = String(acc["account_name"] ?? "");
      if (/retained\s+earn/i.test(name)) {
        return (acc["credit"] as number ?? 0) - (acc["debit"] as number ?? 0);
      }
    }
    return 0;
  };

  return {
    revenue, cogs, gross_profit: gross, op_expenses: op_exp,
    ebitda: gross - op_exp + deprec, depreciation: deprec,
    ebit, finance_cost: finance, pbt, tax_charge: tax_chg, pat,
    total_assets: cur_a + ncur_a,
    current_assets: cur_a, non_current_assets: ncur_a,
    trade_receivables: findBSLine([/trade\s+receiv/i, /receivable/i, /debtor/i]),
    cash_and_bank:     findBSLine([/cash/i, /bank.*hand/i]),
    inventories:       findBSLine([/inventor/i, /stock/i]),
    total_liabilities: cur_l + ncur_l,
    current_liabilities: cur_l,
    non_current_liabilities: ncur_l,
    total_equity: equity,
    retained_earnings_opening: findRE(),
  };
}

function buildMovementRow(
  lineItem: string,
  current: number,
  prior: number
): MovementRow {
  const change = current - prior;
  const pct    = safePct(current, prior);
  const flag   = prior === 0 && current !== 0 ? "new"
               : current === 0 && prior !== 0 ? "gone"
               : flagMovement(pct, change);
  return { line_item: lineItem, current_tzs: current, prior_tzs: prior,
           change_tzs: change, change_pct: pct, flag };
}

// ── Main handler ───────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { company_id, current_period_id, prior_period_id: priorIdInput }
      = await req.json() as {
          company_id: string;
          current_period_id: string;
          prior_period_id?: string;
        };

    if (!company_id || !current_period_id) {
      return new Response(
        JSON.stringify({ error: "company_id and current_period_id are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── STEP 1: Resolve periods ────────────────────────────────────────────────
    const { data: pairRows, error: pairErr } = await supabase
      .from("v_period_pairs")
      .select("*")
      .eq("current_period_id", current_period_id)
      .single();

    if (pairErr || !pairRows) {
      return new Response(
        JSON.stringify({ error: `Period not found: ${pairErr?.message}` }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const resolvedPriorId: string | null =
      priorIdInput ?? pairRows.prior_period_id ?? null;

    if (!resolvedPriorId) {
      return new Response(
        JSON.stringify({
          status: "no_prior_period",
          message: "No prior period linked for this company. Upload the prior-year TB first.",
          engine_version: ENGINE_VERSION,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── STEP 2: Load processing_results for both periods ──────────────────────
    const { data: curUpload } = await supabase
      .from("trial_balance_uploads")
      .select("processing_result, company_name")
      .eq("id", pairRows.current_upload_id)
      .single();

    const { data: priUpload } = await supabase
      .from("trial_balance_uploads")
      .select("processing_result, company_name")
      .eq("id", pairRows.prior_upload_id)
      .single();

    if (!curUpload?.processing_result || !priUpload?.processing_result) {
      return new Response(
        JSON.stringify({ error: "One or both periods have no processed TB. Ensure both uploads are VALID." }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const curPR  = curUpload.processing_result as Record<string, unknown>;
    const priPR  = priUpload.processing_result as Record<string, unknown>;

    const cur    = extractTotals(curPR);
    const pri    = extractTotals(priPR);

    // ── STEP 3: Income statement movements ────────────────────────────────────
    const isMovement: MovementRow[] = [
      buildMovementRow("Revenue / Turnover",       cur.revenue,     pri.revenue),
      buildMovementRow("Cost of Goods Sold",        cur.cogs,        pri.cogs),
      buildMovementRow("Gross Profit",              cur.gross_profit,pri.gross_profit),
      buildMovementRow("Operating Expenses",        cur.op_expenses, pri.op_expenses),
      buildMovementRow("EBIT",                      cur.ebit,        pri.ebit),
      buildMovementRow("Finance Costs",             cur.finance_cost,pri.finance_cost),
      buildMovementRow("Profit Before Tax",         cur.pbt,         pri.pbt),
      buildMovementRow("Income Tax Charge",         cur.tax_charge,  pri.tax_charge),
      buildMovementRow("Profit After Tax",          cur.pat,         pri.pat),
    ];

    // ── STEP 4: Balance sheet movements ───────────────────────────────────────
    const bsMovement: MovementRow[] = [
      buildMovementRow("Total Assets",              cur.total_assets,          pri.total_assets),
      buildMovementRow("Current Assets",            cur.current_assets,        pri.current_assets),
      buildMovementRow("  Trade Receivables",       cur.trade_receivables,     pri.trade_receivables),
      buildMovementRow("  Inventories",             cur.inventories,           pri.inventories),
      buildMovementRow("  Cash & Bank",             cur.cash_and_bank,         pri.cash_and_bank),
      buildMovementRow("Non-Current Assets",        cur.non_current_assets,    pri.non_current_assets),
      buildMovementRow("Total Liabilities",         cur.total_liabilities,     pri.total_liabilities),
      buildMovementRow("Current Liabilities",       cur.current_liabilities,   pri.current_liabilities),
      buildMovementRow("Non-Current Liabilities",   cur.non_current_liabilities,pri.non_current_liabilities),
      buildMovementRow("Total Equity",              cur.total_equity,          pri.total_equity),
    ];

    // ── STEP 5: Key ratios ─────────────────────────────────────────────────────
    const ratios = {
      gross_margin_pct: {
        current: cur.revenue  > 0 ? Math.round((cur.gross_profit / cur.revenue)  * 10000) / 100 : null,
        prior:   pri.revenue  > 0 ? Math.round((pri.gross_profit / pri.revenue)  * 10000) / 100 : null,
      },
      net_margin_pct: {
        current: cur.revenue  > 0 ? Math.round((cur.pat          / cur.revenue)  * 10000) / 100 : null,
        prior:   pri.revenue  > 0 ? Math.round((pri.pat          / pri.revenue)  * 10000) / 100 : null,
      },
      current_ratio: {
        current: cur.current_liabilities > 0 ? Math.round((cur.current_assets / cur.current_liabilities) * 100) / 100 : null,
        prior:   pri.current_liabilities > 0 ? Math.round((pri.current_assets / pri.current_liabilities) * 100) / 100 : null,
      },
      debt_to_equity: {
        current: cur.total_equity > 0 ? Math.round((cur.total_liabilities / cur.total_equity) * 100) / 100 : null,
        prior:   pri.total_equity > 0 ? Math.round((pri.total_liabilities / pri.total_equity) * 100) / 100 : null,
      },
      revenue_growth_pct: safePct(cur.revenue, pri.revenue),
      receivables_days: {
        current: cur.revenue > 0 ? Math.round((cur.trade_receivables / cur.revenue) * 365) : null,
        prior:   pri.revenue > 0 ? Math.round((pri.trade_receivables / pri.revenue) * 365) : null,
      },
    };

    // ── STEP 6: Retained earnings reconciliation (IAS 1.106) ──────────────────
    // Opening RE in current TB should equal: prior closing RE
    // prior closing RE = prior opening RE + prior PAT - dividends paid
    // We can cross-check: if opening RE (current) ≠ prior PAT + prior opening RE → dividends or restatement
    const priClosingRE_implied = pri.retained_earnings_opening + pri.pat;
    const dividendsImplied     = priClosingRE_implied - cur.retained_earnings_opening;
    const reDiff               = Math.abs(dividendsImplied) < 1 ? 0 : dividendsImplied;

    const reRec = {
      opening_re_per_current_tb: cur.retained_earnings_opening,
      closing_re_per_prior_tb:   priClosingRE_implied,
      pat_from_prior_tb:         pri.pat,
      dividends_implied:         Math.max(0, dividendsImplied),
      reconciliation_ok:         Math.abs(reDiff) <= 1_000,
      difference:                reDiff,
    };

    // ── STEP 7: AMT 3-year risk (ITA s.65) ────────────────────────────────────
    const { data: lossRows } = await supabase
      .from("tax_losses")
      .select("period_year, current_year_result_tzs, consecutive_loss_years, amt_3yr_trigger")
      .eq("company_id", company_id)
      .order("period_year", { ascending: false })
      .limit(5);

    const currentYearLoss = cur.pat < 0;
    const priorYearLoss   = pri.pat < 0;
    const lossYearsTracked = lossRows?.[0]?.consecutive_loss_years ?? (currentYearLoss ? 1 : 0);
    const amtApplies      = lossYearsTracked >= 3;
    const grossIncome     = cur.revenue;

    const amtRisk = {
      current_year_loss:   currentYearLoss,
      prior_year_loss:     priorYearLoss,
      loss_years_tracked:  lossYearsTracked,
      amt_applies:         amtApplies,
      minimum_tax_tzs:     amtApplies && grossIncome > 0 ? Math.round(grossIncome * 0.01) : null,
    };

    // ── STEP 8: ECL movement (IFRS 9 / IPSAS 29) ──────────────────────────────
    const recvMovPct = safePct(cur.trade_receivables, pri.trade_receivables);
    const revMovPct  = safePct(cur.revenue, pri.revenue);
    const ecl = {
      current_receivables: cur.trade_receivables,
      prior_receivables:   pri.trade_receivables,
      movement_pct:        recvMovPct,
      flag: (recvMovPct === null || revMovPct === null) ? "unknown"
          : recvMovPct > (revMovPct + 15) ? "deteriorating"  // receivables growing faster than revenue
          : recvMovPct < (revMovPct - 15) ? "improving"
          : "adequate",
    } as ComparativeReport["ecl"];

    // ── STEP 9: Deferred tax consistency (IAS 12) ─────────────────────────────
    const curTaxCharge = cur.tax_charge;
    const priTaxCharge = pri.tax_charge;
    const dtFlag: ComparativeReport["deferred_tax"]["flag"] = "unknown"; // full check needs DT accounts

    const deferredTax = {
      is_charge_current: curTaxCharge,
      is_charge_prior:   priTaxCharge,
      flag:              dtFlag,
    };

    // ── STEP 10: Auto-generate findings ───────────────────────────────────────
    const findings: Record<string, unknown>[] = [];

    // Revenue growth finding
    if (ratios.revenue_growth_pct !== null && Math.abs(ratios.revenue_growth_pct) >= 20) {
      findings.push({
        category:    "COMPARATIVE_MOVEMENT",
        severity:    "info",
        title:       `Revenue ${ratios.revenue_growth_pct > 0 ? "grew" : "declined"} ${Math.abs(ratios.revenue_growth_pct)}% year-on-year`,
        description: `Revenue moved from TZS ${pri.revenue.toLocaleString()} to TZS ${cur.revenue.toLocaleString()}. ` +
                     `A movement ≥20% warrants explanation in the notes per IAS 1.122.`,
        ita_section: "IAS 1.122",
        auto_detected: true,
      });
    }

    // AMT risk finding
    if (amtRisk.amt_applies) {
      findings.push({
        category:    "AMT_RISK",
        severity:    "high",
        title:       "Minimum tax (AMT) may apply — 3 consecutive loss years",
        description: `Company has unrelieved losses for ${lossYearsTracked} consecutive years. ` +
                     `ITA s.65(2) minimum tax = 1% × gross income = TZS ${amtRisk.minimum_tax_tzs?.toLocaleString()}. ` +
                     `CPA must confirm sector exemption (agriculture, health, education) before applying.`,
        ita_section: "ITA Cap.332 s.65(2)",
        auto_detected: true,
      });
    }

    // RE reconciliation failure
    if (!reRec.reconciliation_ok) {
      findings.push({
        category:    "RE_RECONCILIATION",
        severity:    "high",
        title:       `Retained earnings opening balance does not reconcile (gap: TZS ${Math.abs(reRec.difference).toLocaleString()})`,
        description: `Prior year closing RE + PAT = TZS ${reRec.closing_re_per_prior_tb.toLocaleString()} ` +
                     `but current opening RE = TZS ${reRec.opening_re_per_current_tb.toLocaleString()}. ` +
                     `Unexplained difference = TZS ${reRec.difference.toLocaleString()}. ` +
                     `Could indicate: dividends paid, prior-period restatement, or error. IAS 1.106 requires disclosure.`,
        ita_section: "IAS 1.106",
        auto_detected: true,
      });
    }

    // Gross margin deterioration
    if (ratios.gross_margin_pct.current !== null && ratios.gross_margin_pct.prior !== null) {
      const gmChange = ratios.gross_margin_pct.current - ratios.gross_margin_pct.prior;
      if (gmChange < -5) {
        findings.push({
          category:    "GROSS_MARGIN",
          severity:    "watch",
          title:       `Gross margin declined ${Math.abs(gmChange).toFixed(1)}pp year-on-year`,
          description: `Gross margin: ${ratios.gross_margin_pct.prior}% → ${ratios.gross_margin_pct.current}%. ` +
                       `A decline of more than 5 percentage points may indicate cost pressures or pricing weakness.`,
          ita_section: "IAS 1.85",
          auto_detected: true,
        });
      }
    }

    // ECL deterioration
    if (ecl.flag === "deteriorating") {
      findings.push({
        category:    "ECL_ADEQUACY",
        severity:    "watch",
        title:       "Trade receivables growing faster than revenue — ECL provision may be inadequate",
        description: `Receivables grew ${recvMovPct}% vs revenue growth ${revMovPct}%. ` +
                     `IFRS 9 requires an ECL provision based on expected loss rates. ` +
                     `If days-receivable has increased, the ECL provision should be reviewed.`,
        ita_section: "IFRS 9.5.5",
        auto_detected: true,
      });
    }

    // ── STEP 11: Build and return report ──────────────────────────────────────
    const report: ComparativeReport = {
      company_id,
      current_period_id,
      prior_period_id:    resolvedPriorId,
      current_year_end:   pairRows.current_year_end,
      prior_year_end:     pairRows.prior_year_end,
      reporting_currency: pairRows.reporting_currency ?? "TZS",
      income_statement:   isMovement,
      balance_sheet:      bsMovement,
      ratios,
      retained_earnings_rec: reRec,
      amt_risk:           amtRisk,
      ecl,
      deferred_tax:       deferredTax,
      generated_at:       new Date().toISOString(),
      engine_version:     ENGINE_VERSION,
    };

    return new Response(
      JSON.stringify({ status: "ok", comparative_report: report, findings }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[KCE] Fatal error:", msg);
    return new Response(
      JSON.stringify({ error: msg, engine_version: ENGINE_VERSION }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
