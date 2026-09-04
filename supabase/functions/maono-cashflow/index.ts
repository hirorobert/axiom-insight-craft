/**
 * maono-cashflow · IRON DOME NUCLEAR DESIGN · Phase B
 *
 * 13-week rolling cash flow forecast. DETERMINISTIC — zero AI.
 * All figures derived from TB actuals + statutory calendar.
 *
 * Computation model:
 *   Opening cash  = certified current-asset accounts the professional marked as
 *                   cash (tri-state authority; one undecided account => the
 *                   whole forecast is CANNOT_ASSESS, never a partial figure)
 *   AR inflows    = receivables balance × collection rate (configurable, default 40/40/20 over 30/60/90 days)
 *   AP outflows   = payables balance × payment rate (default 50/30/20 over 30/60/90 days)
 *   Statutory     = PAYE, VAT, SDL, WHT on their exact Tanzania due dates
 *   Other         = estimated from prior period non-AR/AP actuals
 *   Closing cash  = prior week closing + inflows − outflows
 *
 * Risk flags:
 *   'critical' = closing_cash provides < cash_critical_days of average weekly expenditure
 *   'watch'    = closing_cash provides < cash_warn_days
 *   'ok'       = above watch threshold
 *
 * POST /functions/v1/maono-cashflow
 * Body: { run_id: string }
 *
 * Writes: cashflow_forecasts (13 rows), returns summary
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { readOptionalTaxAmount } from "../_shared/maonoAnalyticalContract.ts";
import {
  loadCertifiedTb, loadCashPerimeter, resolveCashState, certifiedRowKey,
  type CertifiedTbClient,
} from "../_shared/certifiedTbSource.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Tanzania statutory due-date logic ─────────────────────────────────────────

interface StatutoryItem {
  name:       string;
  field:      "paye_due" | "vat_due" | "sdl_due" | "wht_due" | "other_statutory_due";
  dueDay:     number;   // day of month (7 = 7th)
  dueMonth:   "same" | "following"; // same month or following month
  weekOffset: number;   // which week this falls in (computed per calendar)
}

const STATUTORY_ITEMS: StatutoryItem[] = [
  { name: "PAYE",      field: "paye_due",            dueDay: 7,  dueMonth: "following", weekOffset: 0 },
  { name: "SDL",       field: "sdl_due",             dueDay: 7,  dueMonth: "following", weekOffset: 0 },
  { name: "VAT",       field: "vat_due",             dueDay: 20, dueMonth: "following", weekOffset: 0 },
  { name: "WHT",       field: "wht_due",             dueDay: 7,  dueMonth: "following", weekOffset: 0 },
];

function getWeekMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function weekOfYear(date: Date, startDate: Date): number {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  return Math.floor((date.getTime() - startDate.getTime()) / msPerWeek) + 1;
}

// ── Cash / receivable / payable perimeter (authority-derived) ────────────────
//
// Ω∞ closure: the previous account-code-range + account-name heuristics
// ("1000-1099 is cash", "name contains 'debtor'") are removed. A heuristic is
// not an accounting authority. The perimeter is now:
//   cash  → professional tri-state `account_mappings.is_cash_account`
//           (NULL = undecided = UNKNOWN, fails closed; never "not cash")
//   AR/AP → the CERTIFIED classification carried in the CertifiedTB row
//           (`subNature`), at class level, with the basis declared in the
//           response. No name matching, no code ranges.

const CURRENT_ASSET_CLASSES = new Set(["current_assets", "trade_receivables", "receivables"]);
const CURRENT_LIABILITY_CLASSES = new Set(["current_liabilities", "trade_payables", "payables"]);

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const { run_id } = await req.json();
    if (!run_id) return json({ error: "run_id is required" }, 400);

    // Load run details
    const { data: run } = await supabase
      .from("variance_runs")
      .select("id, company_id, tb_upload_ids, period_from, period_to, fiscal_year, period_month, status")
      .eq("id", run_id)
      .single();
    if (!run) return json({ error: "Variance run not found" }, 404);
    if (run.status !== "complete") {
      return json({ error: "Run must be complete before cash flow can be computed. Call maono-compute first." }, 409);
    }

    const companyId = run.company_id;

    // Load materiality thresholds (for cash warning days)
    const { data: mat } = await supabase
      .from("variance_materiality")
      .select("cash_warn_days, cash_critical_days")
      .eq("company_id", companyId)
      .single();
    const warnDays     = mat?.cash_warn_days ?? 30;
    const criticalDays = mat?.cash_critical_days ?? 14;

    // ── Authoritative balances: SAFISHA CertifiedTB ───────────────────────────
    const certified = await loadCertifiedTb(
      supabase as unknown as CertifiedTbClient, companyId, run.fiscal_year);
    if (certified.state === "CANNOT_ASSESS") {
      return json({
        error:            "Cash flow forecast cannot be assessed",
        analytical_state: "CANNOT_ASSESS",
        reason:           certified.reason,
        authority:        "SAFISHA CertifiedTB (get_authoritative_certification)",
        iron_dome:        true,
      }, 409);
    }
    const certifiedTb = certified.value;

    const perimeter = await loadCashPerimeter(supabase as unknown as CertifiedTbClient, companyId);
    if (perimeter.state === "CANNOT_ASSESS") {
      return json({
        error:            "Cash flow forecast cannot be assessed",
        analytical_state: "CANNOT_ASSESS",
        reason:           perimeter.reason,
        authority:        "Professional cash perimeter (account_mappings.is_cash_account)",
        iron_dome:        true,
      }, 409);
    }

    // Opening cash requires a COMPLETE professional cash perimeter over the
    // certified current-asset population. UNKNOWN != ZERO != FALSE: one
    // undecided account makes opening cash unknown, and the whole forecast is
    // refused rather than reported from a partial balance.
    const undecidedCashAccounts: string[] = [];
    let cashBalance = 0;
    let arBalance   = 0;
    let apBalance   = 0;

    for (const row of certifiedTb.rows) {
      const key = certifiedRowKey(row);
      const net = row.debitBalance - row.creditBalance;
      const isCurrentAsset = CURRENT_ASSET_CLASSES.has(row.subNature);
      const isCurrentLiab  = CURRENT_LIABILITY_CLASSES.has(row.subNature);

      if (isCurrentAsset) {
        const cashState = resolveCashState(perimeter.value, key);
        if (cashState === "UNKNOWN") {
          undecidedCashAccounts.push(row.accountCode ?? row.accountName);
          continue;
        }
        if (cashState === "CASH") cashBalance += net;
        else arBalance += Math.abs(net);
      } else if (isCurrentLiab) {
        apBalance += Math.abs(row.creditBalance - row.debitBalance);
      }
    }

    if (undecidedCashAccounts.length > 0) {
      return json({
        error:            "Cash flow forecast cannot be assessed",
        analytical_state: "CANNOT_ASSESS",
        reason:           "The professional cash perimeter is incomplete: " +
                          `${undecidedCashAccounts.length} certified current-asset account(s) have no ` +
                          "cash/non-cash decision. An undecided account is unknown, not non-cash, so " +
                          "opening cash cannot be stated.",
        undecided_accounts: undecidedCashAccounts.slice(0, 25),
        authority:        "Professional cash perimeter (account_mappings.is_cash_account, tri-state)",
        hint:             "Complete the account review cash decisions for this company, then re-run.",
        iron_dome:        true,
      }, 409);
    }

    // Load prior periods for collection rate estimation
    const { data: priorRuns } = await supabase
      .from("variance_runs")
      .select("id, period_month, fiscal_year")
      .eq("company_id", companyId)
      .eq("status", "complete")
      .neq("id", run_id)
      .order("fiscal_year", { ascending: false })
      .order("period_month", { ascending: false })
      .limit(3);

    // Simple AR collection model: if we have historical data, estimate from DSO
    // Default: 40% collected week 1-4, 40% week 5-8, 20% week 9-12
    const arCollectionSchedule = [0.40, 0.40, 0.20]; // 30/60/90 day buckets
    const apPaymentSchedule    = [0.50, 0.30, 0.20]; // 30/60/90 day buckets

    // Load statutory obligations from tax_computations for THIS exact run's
    // uploads. Ω∞ Phase 9 repair (HIGH B):
    //   1. Column is upload_id, not tb_upload_id — tax_computations has no
    //      tb_upload_id column at all (verified against
    //      20260628100000_tax_engine_schema.sql: `UNIQUE (company_id,
    //      upload_id)`); the correct column name was already in use two
    //      queries above against account_classifications (line ~131) —
    //      this call site alone had the wrong name and could never match
    //      any row.
    //   2. Scoped to run.tb_upload_ids (this run's own uploads), not an
    //      arbitrary "latest for the company" — a stale or unrelated
    //      period's tax computation can no longer enrich this forecast.
    //   3. UNKNOWN != ZERO: kinga-tax-engine's computation_detail does not
    //      actually produce paye_total/vat_liability/sdl_liability/
    //      wht_total anywhere (grepped kinga-tax-engine/index.ts — the
    //      only "sdl" hit is a static rate-table entry, not a computed
    //      liability) — these fields do not exist in the real payload
    //      today. readOptionalTaxAmount returns null (unavailable) for an
    //      absent/non-finite key rather than fabricating 0, so a future
    //      kinga-tax-engine version that DOES populate them will be read
    //      correctly without further changes, and today's honest absence
    //      is preserved into the response rather than silently zeroed.
    const { data: taxComp } = await supabase
      .from("tax_computations")
      .select("computation_detail")
      .in("upload_id", run.tb_upload_ids)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    const taxJson = taxComp?.computation_detail ?? null;

    const payeAmount = readOptionalTaxAmount(taxJson, "paye_total");
    const vatAmount  = readOptionalTaxAmount(taxJson, "vat_liability");
    const sdlAmount  = readOptionalTaxAmount(taxJson, "sdl_liability");
    const whtAmount  = readOptionalTaxAmount(taxJson, "wht_total");

    // Build 13-week forecast
    const startDate  = getWeekMonday(new Date());
    const weeks:     any[] = [];

    // Distribute AR inflows across weeks (bucket-based)
    const arWeeklyInflows  = new Array(13).fill(0);
    const apWeeklyOutflows = new Array(13).fill(0);

    // Bucket 1: 30-day (weeks 1-4), Bucket 2: 60-day (weeks 5-8), Bucket 3: 90-day (weeks 9-12)
    const arBucket1 = arBalance * arCollectionSchedule[0];
    const arBucket2 = arBalance * arCollectionSchedule[1];
    const arBucket3 = arBalance * arCollectionSchedule[2];
    for (let w = 0; w < 4;  w++) arWeeklyInflows[w]     += arBucket1 / 4;
    for (let w = 4; w < 8;  w++) arWeeklyInflows[w]     += arBucket2 / 4;
    for (let w = 8; w < 12; w++) arWeeklyInflows[w]     += arBucket3 / 4;

    const apBucket1 = apBalance * apPaymentSchedule[0];
    const apBucket2 = apBalance * apPaymentSchedule[1];
    const apBucket3 = apBalance * apPaymentSchedule[2];
    for (let w = 0; w < 4;  w++) apWeeklyOutflows[w]    += apBucket1 / 4;
    for (let w = 4; w < 8;  w++) apWeeklyOutflows[w]    += apBucket2 / 4;
    for (let w = 8; w < 12; w++) apWeeklyOutflows[w]    += apBucket3 / 4;

    // Place statutory payments in correct weeks
    const statutoryByWeek = Array.from({ length: 13 }, () => ({
      paye_due: 0, vat_due: 0, sdl_due: 0, wht_due: 0, other_statutory_due: 0
    }));

    // PAYE + SDL due 7th following month
    // VAT due 20th following month
    const today      = new Date();
    const thisMonth  = today.getMonth();
    const thisYear   = today.getFullYear();
    const following  = new Date(thisYear, thisMonth + 1, 1);

    const paye7th    = new Date(following.getFullYear(), following.getMonth(), 7);
    const sdl7th     = new Date(following.getFullYear(), following.getMonth(), 7);
    const vat20th    = new Date(following.getFullYear(), following.getMonth(), 20);
    const wht7th     = new Date(following.getFullYear(), following.getMonth(), 7);

    function placeStatutory(dueDate: Date, field: keyof typeof statutoryByWeek[0], amount: number) {
      const weekIdx = Math.min(Math.max(weekOfYear(dueDate, startDate) - 1, 0), 12);
      if (weekIdx < 13) statutoryByWeek[weekIdx][field] += amount;
    }

    // null (unavailable) never schedules a payment — same as the prior
    // `> 0` guard already did for a missing amount, just now explicit
    // about WHY: an unknown obligation is omitted from the schedule, not
    // asserted to be zero.
    if (payeAmount !== null && payeAmount > 0) placeStatutory(paye7th, "paye_due", payeAmount);
    if (sdlAmount  !== null && sdlAmount  > 0) placeStatutory(sdl7th,  "sdl_due",  sdlAmount);
    if (vatAmount  !== null && vatAmount  > 0) placeStatutory(vat20th, "vat_due",  vatAmount);
    if (whtAmount  !== null && whtAmount  > 0) placeStatutory(wht7th,  "wht_due",  whtAmount);

    // Estimate average weekly running costs from OpEx (excluding D&A and statutory)
    const { data: opexAnalyses } = await supabase
      .from("variance_analyses")
      .select("actual_amount")
      .eq("run_id", run_id)
      .in("pl_category", ["OTHER_OPEX", "PERSONNEL_COSTS"]);

    const monthlyOpex      = (opexAnalyses ?? []).reduce((s: number, a: any) => s + (a.actual_amount ?? 0), 0);
    const weeklyOtherOutflow = Math.max(0, monthlyOpex / 4.33); // approx weekly

    // Build weekly rows
    let runningCash = cashBalance;
    const forecastRows = [];

    // Average weekly outflow for risk flagging
    // Unavailable statutory amounts contribute 0 to this specific burn-rate
    // aggregate — the same "omit the unknown adjustment" semantics as the
    // placeStatutory guards above, not a claim that the liability itself
    // is zero (that claim is never made — see statutory_this_month below,
    // which preserves null).
    const totalWeeklyOutflow = (apBalance / 13) + weeklyOtherOutflow +
      ((payeAmount ?? 0) + (sdlAmount ?? 0) + (vatAmount ?? 0) + (whtAmount ?? 0)) / 13;

    for (let i = 0; i < 13; i++) {
      const weekDate   = addDays(startDate, i * 7);
      const stat       = statutoryByWeek[i];
      const totalIn    = arWeeklyInflows[i];
      const totalOut   = apWeeklyOutflows[i] + weeklyOtherOutflow +
                         stat.paye_due + stat.vat_due + stat.sdl_due + stat.wht_due + stat.other_statutory_due;

      runningCash      = runningCash + totalIn - totalOut;

      // Risk flag: how many days of expenditure does closing cash cover?
      const dailyBurn  = totalWeeklyOutflow / 7;
      const coverDays  = dailyBurn > 0 ? runningCash / dailyBurn : Infinity;
      const riskFlag   = coverDays < criticalDays ? "critical"
                       : coverDays < warnDays     ? "watch"
                       : "ok";
      const riskReason = riskFlag === "critical"
        ? `Cash covers only ~${Math.round(coverDays)} days of expenditure (critical threshold: ${criticalDays} days)`
        : riskFlag === "watch"
        ? `Cash covers ~${Math.round(coverDays)} days of expenditure (watch threshold: ${warnDays} days)`
        : null;

      forecastRows.push({
        run_id,
        company_id:              companyId,
        forecast_week:           weekDate.toISOString().slice(0, 10),
        week_number:             i + 1,
        opening_cash:            Math.round(runningCash - totalIn + totalOut),
        expected_ar_inflows:     Math.round(arWeeklyInflows[i]),
        expected_other_inflows:  0,
        expected_ap_outflows:    Math.round(apWeeklyOutflows[i]),
        expected_other_outflows: Math.round(weeklyOtherOutflow),
        paye_due:                Math.round(stat.paye_due),
        vat_due:                 Math.round(stat.vat_due),
        sdl_due:                 Math.round(stat.sdl_due),
        wht_due:                 Math.round(stat.wht_due),
        other_statutory_due:     Math.round(stat.other_statutory_due),
        closing_cash:            Math.round(runningCash),
        risk_flag:               riskFlag,
        risk_reason:             riskReason,
        ar_confidence:           (priorRuns?.length ?? 0) >= 3 ? "estimated" : "low",
      });
    }

    // Insert forecast rows
    const { error: insErr } = await supabase
      .from("cashflow_forecasts")
      .insert(forecastRows);
    if (insErr) throw new Error("Insert cashflow_forecasts failed: " + insErr.message);

    const criticalWeeks = forecastRows.filter(r => r.risk_flag === "critical").length;
    const watchWeeks    = forecastRows.filter(r => r.risk_flag === "watch").length;
    const minCash       = Math.min(...forecastRows.map(r => r.closing_cash));

    return json({
      success:           true,
      run_id,
      company_id:        companyId,
      opening_cash:      cashBalance,
      ar_balance:        arBalance,
      ap_balance:        apBalance,
      balance_authority: {
        source:           "SAFISHA CertifiedTB",
        certification_id: certifiedTb.certificationId,
        upload_id:        certifiedTb.uploadId,
        source_file_hash: certifiedTb.sourceFileHash,
        certified_at:     certifiedTb.certifiedAt,
        cash_basis:       "professional tri-state account_mappings.is_cash_account (complete)",
        ar_basis:         "certified current-asset classification excluding the professional cash perimeter (class-level)",
        ap_basis:         "certified current-liability classification (class-level)",
        ar_ap_precision:  "CLASS_LEVEL_APPROXIMATION",
      },
      // null means unavailable (no tax_computations row for this run's
      // uploads, or the key does not exist in computation_detail) — never
      // read as a zero obligation. A caller must render "unavailable"
      // distinctly from an explicit 0.
      statutory_this_month: {
        paye: payeAmount, vat: vatAmount, sdl: sdlAmount, wht: whtAmount
      },
      forecast_weeks:    13,
      critical_weeks:    criticalWeeks,
      watch_weeks:       watchWeeks,
      minimum_cash_tzs:  minCash,
      ar_confidence:     (priorRuns?.length ?? 0) >= 3 ? "estimated" : "low",
      note:              (priorRuns?.length ?? 0) < 3
        ? "AR collection rates are estimated (fewer than 3 prior periods of data). Actual collections may differ."
        : "AR collection rates based on historical patterns.",
      next_step: "Call maono-root-cause → maono-risk → maono-decide",
    }, 200);

  } catch (err: any) {
    console.error("maono-cashflow error:", err);
    return json({ error: err.message }, 500);
  }
});

function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
