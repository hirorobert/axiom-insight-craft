// kinga-comparative-engine — Module F v1.0
// Cross-period comparative analysis (movements, ratios, RE recon, AMT risk, ECL adequacy)
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ENGINE_VERSION = "Module F v1.0";

interface ReqBody {
  company_id: string;
  current_period_id: string;
  prior_period_id: string;
}

function num(v: any): number {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function pct(curr: number, prior: number): number | null {
  if (!prior) return null;
  return ((curr - prior) / Math.abs(prior)) * 100;
}

function flagBand(absChange: number, p: number | null): "green" | "amber" | "red" {
  if (Math.abs(absChange) >= 50_000_000) return "red";
  if (p === null) return "amber";
  const a = Math.abs(p);
  if (a >= 20) return "red";
  if (a >= 10) return "amber";
  return "green";
}

// Extract a flat line-items map from a processing_result statement section.
function flattenStatement(section: any): Record<string, number> {
  const out: Record<string, number> = {};
  if (!section || typeof section !== "object") return out;
  // Common shapes: { items: [{name, balance/amount}], total }; or { categories: {...} }
  const walk = (node: any, path: string) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        const name = item?.name || item?.label || item?.account || item?.category;
        const val = item?.balance ?? item?.amount ?? item?.value ?? item?.total;
        if (name && typeof val !== "undefined") {
          out[String(name)] = (out[String(name)] || 0) + num(val);
        }
        if (item?.items || item?.children || item?.accounts) {
          walk(item.items || item.children || item.accounts, name || path);
        }
      }
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === "number") {
          out[k] = (out[k] || 0) + v;
        } else if (v && typeof v === "object") {
          walk(v, k);
        }
      }
    }
  };
  walk(section, "");
  return out;
}

function buildMovements(
  current: Record<string, number>,
  prior: Record<string, number>,
) {
  const keys = Array.from(new Set([...Object.keys(current), ...Object.keys(prior)]));
  return keys.map((k) => {
    const c = num(current[k]);
    const p = num(prior[k]);
    const change = c - p;
    const changePct = pct(c, p);
    return {
      line_item: k,
      current: c,
      prior: p,
      change,
      change_pct: changePct,
      flag: flagBand(change, changePct),
    };
  });
}

function safeDiv(a: number, b: number): number | null {
  if (!b) return null;
  return a / b;
}

function computeRatios(stmts: any) {
  const is = stmts?.income_statement || {};
  const bs = stmts?.balance_sheet || {};
  const revenue = num(is.revenue ?? is.total_revenue);
  const grossProfit = num(is.gross_profit);
  const netIncome = num(is.net_income ?? is.profit_after_tax ?? is.pat);
  const currentAssets = num(bs.current_assets);
  const currentLiab = num(bs.current_liabilities);
  const totalLiab = num(bs.total_liabilities ?? bs.liabilities);
  const equity = num(bs.total_equity ?? bs.equity);
  const receivables = num(bs.trade_receivables ?? bs.receivables);
  return {
    gross_margin_pct: safeDiv(grossProfit, revenue) === null ? null : safeDiv(grossProfit, revenue)! * 100,
    net_margin_pct: safeDiv(netIncome, revenue) === null ? null : safeDiv(netIncome, revenue)! * 100,
    current_ratio: safeDiv(currentAssets, currentLiab),
    debt_to_equity: safeDiv(totalLiab, equity),
    receivable_days: safeDiv(receivables * 365, revenue),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = (await req.json()) as ReqBody;
    if (!body.company_id || !body.current_period_id || !body.prior_period_id) {
      return new Response(
        JSON.stringify({ error: "company_id, current_period_id, prior_period_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Load both periods with their active uploads
    const { data: periods, error: pErr } = await supabase
      .from("fiscal_periods")
      .select("id, period_label, fiscal_year_end, active_upload_id")
      .in("id", [body.current_period_id, body.prior_period_id]);
    if (pErr) throw pErr;

    const currPeriod = periods?.find((p) => p.id === body.current_period_id);
    const priorPeriod = periods?.find((p) => p.id === body.prior_period_id);
    if (!currPeriod?.active_upload_id || !priorPeriod?.active_upload_id) {
      return new Response(
        JSON.stringify({ error: "Both periods must have an active upload" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: uploads, error: uErr } = await supabase
      .from("trial_balance_uploads")
      .select("id, processing_result")
      .in("id", [currPeriod.active_upload_id, priorPeriod.active_upload_id]);
    if (uErr) throw uErr;

    const currPR: any = uploads?.find((u) => u.id === currPeriod.active_upload_id)?.processing_result || {};
    const priorPR: any = uploads?.find((u) => u.id === priorPeriod.active_upload_id)?.processing_result || {};

    const currIS = flattenStatement(currPR?.statements?.income_statement);
    const priorIS = flattenStatement(priorPR?.statements?.income_statement);
    const currBS = flattenStatement(currPR?.statements?.balance_sheet);
    const priorBS = flattenStatement(priorPR?.statements?.balance_sheet);

    const income_statement_movements = buildMovements(currIS, priorIS);
    const balance_sheet_movements = buildMovements(currBS, priorBS);

    const ratios = {
      current: computeRatios(currPR?.statements),
      prior: computeRatios(priorPR?.statements),
    };

    // Retained earnings reconciliation per IAS 1.106
    const openingRE = num(currPR?.statements?.balance_sheet?.opening_retained_earnings);
    const priorClosingRE = num(priorPR?.statements?.balance_sheet?.retained_earnings);
    const pat = num(currPR?.statements?.income_statement?.net_income ?? currPR?.statements?.income_statement?.pat);
    const closingRE = num(currPR?.statements?.balance_sheet?.retained_earnings);
    const impliedDividends = openingRE + pat - closingRE;
    const reReconciles = Math.abs(openingRE - priorClosingRE) < 1;

    const retained_earnings_reconciliation = {
      opening_re: openingRE,
      prior_closing_re: priorClosingRE,
      pat,
      closing_re: closingRE,
      implied_dividends: impliedDividends,
      reconciles: reReconciles,
    };

    // AMT 3-year risk (ITA s.65) — flag if 3 consecutive loss years
    const currLoss = pat < 0;
    const priorPAT = num(priorPR?.statements?.income_statement?.net_income ?? priorPR?.statements?.income_statement?.pat);
    const priorLoss = priorPAT < 0;
    const turnover = num(currPR?.statements?.income_statement?.revenue ?? currPR?.statements?.income_statement?.total_revenue);
    const amt_risk = {
      consecutive_loss_years: (currLoss ? 1 : 0) + (priorLoss ? 1 : 0),
      requires_third_year_check: currLoss && priorLoss,
      minimum_tax_applies: currLoss && priorLoss, // tentative — needs 3rd year
      minimum_tax_amount_tzs: currLoss && priorLoss ? turnover * 0.01 : 0,
      basis: "ITA s.65 — 1% of turnover if 3 consecutive loss years",
    };

    // ECL adequacy per IFRS 9
    const currRecv = num(currPR?.statements?.balance_sheet?.trade_receivables ?? currPR?.statements?.balance_sheet?.receivables);
    const priorRecv = num(priorPR?.statements?.balance_sheet?.trade_receivables ?? priorPR?.statements?.balance_sheet?.receivables);
    const currECL = num(currPR?.statements?.balance_sheet?.ecl_provision ?? currPR?.statements?.balance_sheet?.allowance_for_doubtful_debts);
    const recvMovementPct = pct(currRecv, priorRecv);
    const eclCoveragePct = currRecv ? (currECL / currRecv) * 100 : null;
    const ecl_adequacy = {
      current_receivables: currRecv,
      prior_receivables: priorRecv,
      receivables_movement_pct: recvMovementPct,
      current_ecl_provision: currECL,
      ecl_coverage_pct: eclCoveragePct,
      adequacy_flag:
        eclCoveragePct === null
          ? "unknown"
          : eclCoveragePct < 1
            ? "inadequate"
            : eclCoveragePct < 3
              ? "review"
              : "adequate",
    };

    // Auto-generate findings for material movements
    const findings: any[] = [];
    const periodEnd = currPeriod.fiscal_year_end;
    const periodStart = priorPeriod.fiscal_year_end;

    for (const m of [...income_statement_movements, ...balance_sheet_movements]) {
      if (m.flag === "red") {
        findings.push({
          company_id: body.company_id,
          finding_type: "statutory_payable",
          finding_category: "comparative_movement",
          title: `Material movement: ${m.line_item}`,
          description: `${m.line_item} moved from TZS ${m.prior.toLocaleString()} to TZS ${m.current.toLocaleString()} (${m.change_pct?.toFixed(1) ?? "n/a"}%).`,
          severity: "high",
          period_start: periodStart,
          period_end: periodEnd,
          metadata: { line_item: m.line_item, change: m.change, change_pct: m.change_pct },
        });
      }
    }

    if (!reReconciles) {
      findings.push({
        company_id: body.company_id,
        finding_type: "statutory_payable",
        finding_category: "retained_earnings_break",
        title: "Opening retained earnings does not match prior year closing",
        description: `Opening RE ${openingRE.toLocaleString()} ≠ prior closing RE ${priorClosingRE.toLocaleString()}. Investigate restatement or correction per IAS 8.`,
        severity: "high",
        period_start: periodStart,
        period_end: periodEnd,
      });
    }

    if (amt_risk.minimum_tax_applies) {
      findings.push({
        company_id: body.company_id,
        finding_type: "statutory_payable",
        finding_category: "amt_risk",
        title: "Alternative Minimum Tax risk (ITA s.65)",
        description: `Two consecutive loss years detected. Confirm 3rd year history; if confirmed, AMT applies at 1% of turnover ≈ TZS ${amt_risk.minimum_tax_amount_tzs.toLocaleString()}.`,
        severity: "medium",
        period_start: periodStart,
        period_end: periodEnd,
      });
    }

    if (ecl_adequacy.adequacy_flag === "inadequate") {
      findings.push({
        company_id: body.company_id,
        finding_type: "statutory_payable",
        finding_category: "ecl_inadequate",
        title: "ECL provision may be inadequate (IFRS 9)",
        description: `ECL coverage of ${eclCoveragePct?.toFixed(2)}% on receivables of TZS ${currRecv.toLocaleString()} is below the 1% review threshold.`,
        severity: "medium",
        period_start: periodStart,
        period_end: periodEnd,
      });
    }

    // Best-effort persist (ignore if trigger blocks)
    if (findings.length) {
      const { error: fErr } = await supabase.from("findings").insert(findings);
      if (fErr) console.warn("findings insert warning:", fErr.message);
    }

    return new Response(
      JSON.stringify({
        engine_version: ENGINE_VERSION,
        current_period: currPeriod,
        prior_period: priorPeriod,
        income_statement_movements,
        balance_sheet_movements,
        ratios,
        retained_earnings_reconciliation,
        amt_risk,
        ecl_adequacy,
        findings,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    console.error("kinga-comparative-engine error:", e);
    return new Response(
      JSON.stringify({ error: e?.message || String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});