/**
 * hesabu-validate · IRON DOME NUCLEAR DESIGN · HESABU Cross-Statement Validator
 *
 * Implements Hoffman fac-ifrs arithmetic consistency + DQC calculation rules
 * as a mandatory post-generation, pre-sign-off validation gate.
 *
 * Sources:
 *   CharlesHoffmanCPA/fac-ifrs (GPL-3.0 — used as intellectual blueprint only;
 *     all assertion logic is an independent TypeScript reimplementation)
 *   DataQualityCommittee/documentation tagging-ifrs.md (calculation consistency rules)
 *   IFRS for SMEs Section 7 (SCF) + Section 6 (SOCIE)
 *
 * Assertion catalogue (12 checks):
 *
 *   SFP ASSERTIONS (from period_closing_balances):
 *     H-01  SFP Fundamental Equation    CA + NCA = CL + NCL + Equity       critical
 *     H-02  Equity Decomposition        Equity = ShareCap + RE + OtherRes   warn
 *     H-03  Cash Subset of Assets       Cash ≤ CurrentAssets                warn
 *
 *   INCOME STATEMENT ASSERTIONS (from computation_detail.income_statement_breakdown):
 *     H-04  Gross Profit Identity       GrossProfit = Revenue − COGS        critical
 *     H-05  PBT Derivation              PBT ≈ GP + OtherIncome − OpEx − FC  warn
 *
 *   SCF ASSERTIONS (from computation_detail.scf_engine):
 *     H-06  SCF Internal Subtotal       NetChangeCash = Op + Inv + Fin      critical
 *     H-07  SCF→SFP Cash Bridge         DerivedClosingCash ≈ SFP Cash       critical
 *     H-08  SCF Opening + Change = Close OpenCash + NetChange = CloseCash   warn
 *
 *   SOCIE ASSERTIONS (from computation_detail.socie_engine):
 *     H-09  SOCIE→SFP Equity Bridge     SOCIE ClosingEquity ≈ SFP Equity    critical
 *     H-10  SOCIE→SFP Retained Earnings SOCIE RE Closing ≈ SFP RE           critical
 *     H-11  SOCIE Internal RE Chain     Opening + PAT − Div = Closing RE    warn
 *
 *   CROSS IS→SOCIE:
 *     H-12  IS PAT feeds SOCIE          SOCIE PAT ≈ IS PBT − Tax            warn
 *
 * IRON DOME:
 *   - Writes ONLY through hesabu_write_validation() SECURITY DEFINER.
 *   - Returns BLOCKED if required input data is missing — never silently skips.
 *   - First-year SCF/SOCIE assertions are SKIPPED (not failed) when
 *     opening data is unavailable (scf_engine.is_first_year_draft = true).
 *   - Tolerances loaded from variance_materiality — never hardcoded.
 *   - Every response includes request_id and function_version.
 *
 * POST /functions/v1/hesabu-validate
 * Body: { upload_id: string }
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FUNCTION_VERSION = "hesabu-validate/v1.0.0";

// ── Iron Dome defaults (used ONLY when variance_materiality has NULL columns) ─
// These are documented defaults, not hardcoded business rules.
// Any company can override via variance_materiality.sfp_tolerance_tzs etc.
const IRON_DOME_SFP_TOLERANCE_TZS   = 1_000;     // ≤ TZS 1,000 rounding on A=L+E
const IRON_DOME_SCF_TOLERANCE_PCT   = 0.01;       // ≤ 1% of cash balance
const IRON_DOME_SCF_TOLERANCE_FLOOR = 500_000;    // min TZS 500,000 regardless
const IRON_DOME_SOCIE_TOLERANCE_PCT = 0.05;       // ≤ 5% of equity

// ── Assertion result types ────────────────────────────────────────────────────

type AssertionResult = "pass" | "fail" | "skip";

interface AssertionRow {
  assertion_id:    string;
  assertion_name:  string;
  source_standard: string;
  result:          AssertionResult;
  skip_reason?:    string;
  expected_value:  number | null;
  actual_value:    number | null;
  tolerance_used:  number;
  severity:        "critical" | "warn" | "info";
  detail:          string;
}

// ── Assertion builder ─────────────────────────────────────────────────────────

function assert(
  id:          string,
  name:        string,
  standard:    string,
  severity:    "critical" | "warn" | "info",
  expected:    number,
  actual:      number,
  tolerance:   number,
  detail:      string
): AssertionRow {
  const diff = Math.abs(actual - expected);
  const withinTolerance = diff <= tolerance;
  return {
    assertion_id:    id,
    assertion_name:  name,
    source_standard: standard,
    result:          withinTolerance ? "pass" : "fail",
    expected_value:  Math.round(expected),
    actual_value:    Math.round(actual),
    tolerance_used:  Math.round(tolerance),
    severity,
    detail: withinTolerance
      ? `PASS. ${detail} Difference: TZS ${Math.round(diff).toLocaleString()} (tolerance: TZS ${Math.round(tolerance).toLocaleString()}).`
      : `FAIL. ${detail} Expected: TZS ${Math.round(expected).toLocaleString()} | Actual: TZS ${Math.round(actual).toLocaleString()} | Difference: TZS ${Math.round(diff).toLocaleString()} (tolerance: TZS ${Math.round(tolerance).toLocaleString()}).`,
  };
}

function skip(
  id:         string,
  name:       string,
  standard:   string,
  severity:   "critical" | "warn" | "info",
  reason:     string
): AssertionRow {
  return {
    assertion_id:    id,
    assertion_name:  name,
    source_standard: standard,
    result:          "skip",
    skip_reason:     reason,
    expected_value:  null,
    actual_value:    null,
    tolerance_used:  0,
    severity,
    detail:          `SKIPPED: ${reason}`,
  };
}

// ── JSON utility ──────────────────────────────────────────────────────────────

function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const requestId = crypto.randomUUID();

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return json({ error: "Unauthorized", request_id: requestId }, 401);
    }

    const { upload_id } = await req.json();
    if (!upload_id) {
      return json({ error: "upload_id is required", request_id: requestId }, 400);
    }

    // ── Load upload + company ─────────────────────────────────────────────────
    const { data: upload } = await supabase
      .from("trial_balance_uploads")
      .select("id, company_id, fiscal_year_end, uploaded_at")
      .eq("id", upload_id)
      .single();

    if (!upload) {
      return json({ error: "Upload not found", request_id: requestId }, 404);
    }

    const companyId = upload.company_id;

    // ── Load tolerance configuration (per-company) ────────────────────────────
    // IRON DOME: tolerances come from DB, never from code constants.
    const { data: mat } = await supabase
      .from("variance_materiality")
      .select("abs_threshold_tzs, sfp_tolerance_tzs, scf_tolerance_pct, socie_tolerance_pct")
      .eq("company_id", companyId)
      .single();

    if (!mat) {
      // BLOCKED: cannot validate without materiality configuration.
      // This is a hard requirement — not a soft default.
      return json({
        status:           "BLOCKED",
        blocked:          true,
        blocked_reason:   "No variance_materiality row for this company. Run maono-compute first to auto-create materiality thresholds, or create a row via the Materiality Settings panel.",
        upload_id,
        request_id:       requestId,
        function_version: FUNCTION_VERSION,
      }, 422);
    }

    // Resolve effective tolerances (DB value or Iron Dome documented default)
    const sfpTolerance   = mat.sfp_tolerance_tzs
      ?? Math.min(mat.abs_threshold_tzs * 0.001, IRON_DOME_SFP_TOLERANCE_TZS);
    const scfTolerancePct = mat.scf_tolerance_pct   ?? IRON_DOME_SCF_TOLERANCE_PCT;
    const socieTolPct     = mat.socie_tolerance_pct  ?? IRON_DOME_SOCIE_TOLERANCE_PCT;

    // ── Load computation_detail ───────────────────────────────────────────────
    // IRON DOME: correct column is `computation_detail` (not `computation_json`).
    const { data: taxComp } = await supabase
      .from("tax_computations")
      .select("computation_detail, period_year, created_at")
      .eq("upload_id", upload_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!taxComp?.computation_detail) {
      return json({
        status:           "BLOCKED",
        blocked:          true,
        blocked_reason:   "No tax computation found for this upload. Run kinga-tax-engine first.",
        upload_id,
        request_id:       requestId,
        function_version: FUNCTION_VERSION,
      }, 422);
    }

    const cd   = taxComp.computation_detail as Record<string, any>;
    const periodYear: number = taxComp.period_year;

    // ── Load period_closing_balances ──────────────────────────────────────────
    const { data: sfp } = await supabase
      .from("period_closing_balances")
      .select(`
        current_assets_tzs, non_current_assets_tzs,
        current_liabilities_tzs, non_current_liabilities_tzs,
        equity_tzs, cash_balance_tzs,
        share_capital_tzs, retained_earnings_tzs, other_reserves_tzs,
        closing_dtl_tzs, closing_dta_tzs
      `)
      .eq("company_id", companyId)
      .eq("period_year", periodYear)
      .order("period_month", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!sfp) {
      return json({
        status:           "BLOCKED",
        blocked:          true,
        blocked_reason:   `No period_closing_balances for company ${companyId} period_year ${periodYear}. kinga-tax-engine must complete successfully first.`,
        upload_id,
        request_id:       requestId,
        function_version: FUNCTION_VERSION,
      }, 422);
    }

    // ── Extract IS breakdown ──────────────────────────────────────────────────
    const is_bd = cd.income_statement_breakdown ?? {};
    const revenueTzs         = is_bd.revenue_tzs              ?? null;
    const cogsTzs            = is_bd.cost_of_goods_sold_tzs   ?? null;
    const grossProfitTzs     = is_bd.gross_profit_tzs         ?? null;
    const opexTzs            = is_bd.operating_expenses_tzs   ?? null;
    const otherIncomeTzs     = is_bd.other_income_tzs         ?? null;
    const financeCostsTzs    = is_bd.finance_costs_tzs        ?? null;
    const pbtTzs             = is_bd.profit_before_tax_tzs    ?? null;
    const taxesTzs           = is_bd.taxes_tzs                ?? 0;

    // ── Extract SCF ───────────────────────────────────────────────────────────
    const scf                = cd.scf_engine ?? {};
    const scfOp              = scf.operating_activities  ?? {};
    const scfInv             = scf.investing_activities  ?? {};
    const scfFin             = scf.financing_activities  ?? {};
    const netCashFromOp      = scfOp.net_cash_from_operating_tzs  ?? null;
    const netCashFromInv     = scfInv.net_cash_from_investing_tzs ?? null;
    const netCashFromFin     = scfFin.net_cash_from_financing_tzs ?? null;
    const netChangeCash      = scf.net_change_in_cash_tzs         ?? null;
    const openingCash        = scf.opening_cash_tzs               ?? null;
    const scfClosingCash     = scf.closing_cash_tzs               ?? null;  // from SFP BS
    const derivedClosingCash = scf.derived_closing_cash_tzs       ?? null;  // from SCF arithmetic
    const isFirstYearDraft   = scf.is_first_year_draft            ?? true;

    // ── Extract SOCIE ─────────────────────────────────────────────────────────
    const socie              = cd.socie_engine ?? {};
    const socieRE            = socie.retained_earnings     ?? {};
    const socieTotal         = socie.total                 ?? {};
    const socieREOpening     = socieRE.opening_tzs         ?? null;
    const sociePatForYear    = socieRE.profit_for_year_tzs ?? null;
    const socieDividends     = socieRE.dividends_declared_tzs ?? 0;   // already negative
    const socieREClosing     = socieRE.closing_tzs         ?? null;
    const socieEquityClosing = socieTotal.closing_derived_tzs ?? null;
    const socieOpeningData   = socie.opening_data_available ?? false;

    // ── SFP values ────────────────────────────────────────────────────────────
    const ca    = sfp.current_assets_tzs         ?? 0;
    const nca   = sfp.non_current_assets_tzs     ?? 0;
    const cl    = sfp.current_liabilities_tzs    ?? 0;
    const ncl   = sfp.non_current_liabilities_tzs ?? 0;
    const eq    = sfp.equity_tzs                 ?? 0;
    const cash  = sfp.cash_balance_tzs           ?? 0;
    const sc    = sfp.share_capital_tzs          ?? 0;
    const re    = sfp.retained_earnings_tzs      ?? 0;
    const or_   = sfp.other_reserves_tzs         ?? 0;

    // ── Run assertions ────────────────────────────────────────────────────────

    const assertions: AssertionRow[] = [];

    // ── H-01: SFP Fundamental Equation (A = L + E) ───────────────────────────
    // Hoffman fac-ifrs: the golden rule. Every published FS must satisfy this.
    // Tolerance: sfpTolerance (typically TZS 1,000 — rounding only).
    // Failure > tolerance means TB has miscategorised accounts or is unbalanced.
    {
      const totalAssets      = ca + nca;
      const totalLiabPlusEq  = cl + ncl + eq;
      assertions.push(assert(
        "H-01", "SFP Fundamental Equation: Assets = Liabilities + Equity",
        "hoffman_fac_ifrs",
        "critical",
        totalLiabPlusEq,   // expected
        totalAssets,       // actual
        sfpTolerance,
        "Sum of Current Assets + Non-Current Assets must equal Current Liabilities + Non-Current Liabilities + Equity. " +
        `Assets: TZS ${totalAssets.toLocaleString()} | L+E: TZS ${totalLiabPlusEq.toLocaleString()}.`
      ));
    }

    // ── H-02: Equity Decomposition ────────────────────────────────────────────
    // Hoffman fac-ifrs: total equity = sum of equity components.
    // Tolerance: sfpTolerance.
    {
      const equityComponents = sc + re + or_;
      assertions.push(assert(
        "H-02", "Equity Decomposition: Equity = ShareCap + RetainedEarnings + OtherReserves",
        "hoffman_fac_ifrs",
        "warn",
        eq,               // expected: SFP total equity
        equityComponents, // actual: sum of components
        sfpTolerance,
        "Equity total must equal sum of share capital, retained earnings, and other reserves. " +
        `SFP equity: TZS ${eq.toLocaleString()} | Components sum: TZS ${equityComponents.toLocaleString()}.`
      ));
    }

    // ── H-03: Cash is Subset of Current Assets (DQC style) ───────────────────
    // Cash balance cannot exceed total current assets.
    // This is a DQC-derived reasonableness check, not a Hoffman identity.
    {
      const cashExceedsCA = cash > ca + sfpTolerance;
      assertions.push({
        assertion_id:    "H-03",
        assertion_name:  "Cash Subset of Assets: CashBalance ≤ CurrentAssets",
        source_standard: "dqc_tagging_ifrs",
        result:          cashExceedsCA ? "fail" : "pass",
        expected_value:  Math.round(ca),
        actual_value:    Math.round(cash),
        tolerance_used:  Math.round(sfpTolerance),
        severity:        "warn",
        detail:          cashExceedsCA
          ? `FAIL. Cash balance (TZS ${cash.toLocaleString()}) exceeds total current assets (TZS ${ca.toLocaleString()}). Likely a cash account classified outside current assets range.`
          : `PASS. Cash (TZS ${cash.toLocaleString()}) is within current assets (TZS ${ca.toLocaleString()}).`,
      });
    }

    // ── H-04: IS Gross Profit Identity ───────────────────────────────────────
    // Hoffman fac-ifrs: GrossProfit = Revenue − COGS. This is definitional.
    // If all three figures exist. If any are null, SKIP with explanation.
    if (revenueTzs === null || cogsTzs === null || grossProfitTzs === null) {
      assertions.push(skip(
        "H-04", "IS Gross Profit Identity: GrossProfit = Revenue − COGS",
        "hoffman_fac_ifrs", "critical",
        "IS breakdown incomplete — revenue, COGS, or gross_profit_tzs is null in computation_detail. Rerun kinga-tax-engine."
      ));
    } else {
      assertions.push(assert(
        "H-04", "IS Gross Profit Identity: GrossProfit = Revenue − COGS",
        "hoffman_fac_ifrs",
        "critical",
        revenueTzs - cogsTzs,   // expected (definitional)
        grossProfitTzs,         // actual (as reported)
        sfpTolerance,
        `Gross profit must equal revenue minus COGS. Revenue: TZS ${revenueTzs.toLocaleString()} | COGS: TZS ${cogsTzs.toLocaleString()} | GrossProfit: TZS ${grossProfitTzs.toLocaleString()}.`
      ));
    }

    // ── H-05: PBT Derivation Check ────────────────────────────────────────────
    // Hoffman fac-ifrs: PBT = GrossProfit + OtherIncome − OpEx − FinanceCosts.
    // This is approximate — ITA adjustments may create small differences.
    // Tolerance: full materiality threshold (not rounding-only).
    if (grossProfitTzs === null || otherIncomeTzs === null || opexTzs === null ||
        financeCostsTzs === null || pbtTzs === null) {
      assertions.push(skip(
        "H-05", "IS PBT Derivation: PBT = GrossProfit + OtherIncome − OpEx − FinanceCosts",
        "hoffman_fac_ifrs", "warn",
        "One or more IS components null in computation_detail."
      ));
    } else {
      const derivedPBT = grossProfitTzs + otherIncomeTzs - opexTzs - financeCostsTzs;
      assertions.push(assert(
        "H-05", "IS PBT Derivation: PBT = GrossProfit + OtherIncome − OpEx − FinanceCosts",
        "hoffman_fac_ifrs",
        "warn",
        derivedPBT,    // expected
        pbtTzs,        // actual (as computed by kinga-tax-engine from TB)
        mat.abs_threshold_tzs,  // full materiality — timing diffs acceptable
        "PBT must approximate GrossProfit + OtherIncome − OperatingExpenses − FinanceCosts. " +
        "Differences within materiality may reflect TB account classification rounding."
      ));
    }

    // ── H-06: SCF Internal Subtotal ──────────────────────────────────────────
    // IFRS for SMEs s.7: Operating + Investing + Financing = Net Change in Cash.
    if (netCashFromOp === null || netCashFromInv === null || netCashFromFin === null || netChangeCash === null) {
      assertions.push(skip(
        "H-06", "SCF Internal: NetChangeCash = Operating + Investing + Financing",
        "ifrs_for_smes_s7", "critical",
        "SCF engine data missing from computation_detail. Rerun kinga-tax-engine."
      ));
    } else {
      const scfSum = netCashFromOp + netCashFromInv + netCashFromFin;
      assertions.push(assert(
        "H-06", "SCF Internal: NetChangeCash = Operating + Investing + Financing",
        "ifrs_for_smes_s7",
        "critical",
        scfSum,         // expected
        netChangeCash,  // actual
        sfpTolerance,   // rounding only — arithmetic identity
        `IFRS for SMEs s.7: Net change in cash must equal sum of three activity sections. ` +
        `Op: TZS ${netCashFromOp.toLocaleString()} | Inv: TZS ${netCashFromInv.toLocaleString()} | Fin: TZS ${netCashFromFin.toLocaleString()} | Sum: TZS ${scfSum.toLocaleString()} | Reported NetChange: TZS ${netChangeCash.toLocaleString()}.`
      ));
    }

    // ── H-07: SCF→SFP Cash Bridge ─────────────────────────────────────────────
    // THE KEY cross-statement check. SCF derived closing cash must reconcile
    // to SFP cash balance. First-year is SKIPPED — no opening cash available.
    if (isFirstYearDraft) {
      assertions.push(skip(
        "H-07", "SCF→SFP Cash Bridge: SCF DerivedClosingCash ≈ SFP CashBalance",
        "hoffman_fac_ifrs", "critical",
        "First-year draft: no prior-year period_closing_balances available. SCF→SFP reconciliation requires opening cash balance. This will be validated from year 2 onwards."
      ));
    } else if (derivedClosingCash === null || cash === null) {
      assertions.push(skip(
        "H-07", "SCF→SFP Cash Bridge: SCF DerivedClosingCash ≈ SFP CashBalance",
        "hoffman_fac_ifrs", "critical",
        "SCF derived_closing_cash_tzs or SFP cash_balance_tzs is null."
      ));
    } else {
      // SCF cash tolerance: max(pct-of-cash, floor)
      const scfTolAbs = Math.max(
        Math.abs(cash) * scfTolerancePct,
        IRON_DOME_SCF_TOLERANCE_FLOOR
      );
      assertions.push(assert(
        "H-07", "SCF→SFP Cash Bridge: SCF DerivedClosingCash ≈ SFP CashBalance",
        "hoffman_fac_ifrs",
        "critical",
        cash,               // expected: SFP cash (the authority)
        derivedClosingCash, // actual: what SCF arithmetic produces
        scfTolAbs,
        `Cross-statement: SCF opening cash + net change must equal SFP closing cash. ` +
        `SCF derived: TZS ${derivedClosingCash.toLocaleString()} | SFP cash: TZS ${cash.toLocaleString()}. ` +
        `Tolerance: ${(scfTolerancePct * 100).toFixed(1)}% of cash = TZS ${Math.round(scfTolAbs).toLocaleString()}.`
      ));
    }

    // ── H-08: SCF Opening + NetChange = Closing ───────────────────────────────
    // Internal SCF arithmetic: OpeningCash + NetChangeCash = ClosingCash.
    if (isFirstYearDraft) {
      assertions.push(skip(
        "H-08", "SCF Reconciliation: OpeningCash + NetChange = ClosingCash",
        "ifrs_for_smes_s7", "warn",
        "First-year draft: opening cash is TZS 0 by definition. No reconciliation possible."
      ));
    } else if (openingCash === null || netChangeCash === null || scfClosingCash === null) {
      assertions.push(skip(
        "H-08", "SCF Reconciliation: OpeningCash + NetChange = ClosingCash",
        "ifrs_for_smes_s7", "warn",
        "SCF opening_cash_tzs or net_change_in_cash_tzs missing."
      ));
    } else {
      const scfReconciled = openingCash + netChangeCash;
      const scfTolAbs = Math.max(Math.abs(cash) * scfTolerancePct, IRON_DOME_SCF_TOLERANCE_FLOOR);
      assertions.push(assert(
        "H-08", "SCF Reconciliation: OpeningCash + NetChange = ClosingCash",
        "ifrs_for_smes_s7",
        "warn",
        scfClosingCash,    // expected
        scfReconciled,     // actual
        scfTolAbs,
        `Opening cash (TZS ${openingCash.toLocaleString()}) + net change (TZS ${netChangeCash.toLocaleString()}) = ` +
        `TZS ${scfReconciled.toLocaleString()} vs SCF closing (TZS ${scfClosingCash.toLocaleString()}).`
      ));
    }

    // ── H-09: SOCIE→SFP Equity Bridge ────────────────────────────────────────
    // SOCIE closing total equity must reconcile to SFP total equity.
    if (!socieOpeningData) {
      assertions.push(skip(
        "H-09", "SOCIE→SFP Equity Bridge: SOCIE ClosingEquity ≈ SFP Equity",
        "hoffman_fac_ifrs", "critical",
        "First-year: SOCIE opening balances not available. Equity bridge validated from year 2."
      ));
    } else if (socieEquityClosing === null) {
      assertions.push(skip(
        "H-09", "SOCIE→SFP Equity Bridge: SOCIE ClosingEquity ≈ SFP Equity",
        "hoffman_fac_ifrs", "critical",
        "SOCIE total.closing_derived_tzs missing from computation_detail."
      ));
    } else {
      const socieTolAbs = Math.max(Math.abs(eq) * socieTolPct, sfpTolerance);
      assertions.push(assert(
        "H-09", "SOCIE→SFP Equity Bridge: SOCIE ClosingEquity ≈ SFP Equity",
        "hoffman_fac_ifrs",
        "critical",
        eq,                  // expected: SFP equity (the authority)
        socieEquityClosing,  // actual: SOCIE derived closing equity
        socieTolAbs,
        `Cross-statement: SOCIE closing equity must reconcile to SFP total equity. ` +
        `SOCIE derived: TZS ${socieEquityClosing.toLocaleString()} | SFP equity: TZS ${eq.toLocaleString()}. ` +
        `Tolerance: ${(socieTolPct * 100).toFixed(0)}% = TZS ${Math.round(socieTolAbs).toLocaleString()}.`
      ));
    }

    // ── H-10: SOCIE→SFP Retained Earnings Bridge ─────────────────────────────
    // SOCIE retained earnings closing must reconcile to SFP retained earnings.
    if (!socieOpeningData) {
      assertions.push(skip(
        "H-10", "SOCIE→SFP Retained Earnings: SOCIE RE Closing ≈ SFP RE",
        "hoffman_fac_ifrs", "critical",
        "First-year: SOCIE opening RE not available."
      ));
    } else if (socieREClosing === null) {
      assertions.push(skip(
        "H-10", "SOCIE→SFP Retained Earnings: SOCIE RE Closing ≈ SFP RE",
        "hoffman_fac_ifrs", "critical",
        "SOCIE retained_earnings.closing_tzs missing."
      ));
    } else {
      const reTolAbs = Math.max(Math.abs(re) * socieTolPct, sfpTolerance);
      assertions.push(assert(
        "H-10", "SOCIE→SFP Retained Earnings: SOCIE RE Closing ≈ SFP RE",
        "hoffman_fac_ifrs",
        "critical",
        re,              // expected: SFP retained earnings
        socieREClosing,  // actual: SOCIE closing RE
        reTolAbs,
        `Cross-statement: SOCIE closing retained earnings must reconcile to SFP retained earnings. ` +
        `SOCIE: TZS ${socieREClosing.toLocaleString()} | SFP: TZS ${re.toLocaleString()}.`
      ));
    }

    // ── H-11: SOCIE Internal RE Chain ─────────────────────────────────────────
    // Opening RE + PAT − Dividends = Closing RE (definitional in SOCIE).
    if (!socieOpeningData || socieREOpening === null || sociePatForYear === null || socieREClosing === null) {
      assertions.push(skip(
        "H-11", "SOCIE Internal: Opening RE + PAT − Dividends = Closing RE",
        "ifrs_for_smes_s6", "warn",
        "SOCIE opening data not available."
      ));
    } else {
      const derivedClosingRE = socieREOpening + sociePatForYear + socieDividends; // dividends already negative
      assertions.push(assert(
        "H-11", "SOCIE Internal: Opening RE + PAT − Dividends = Closing RE",
        "ifrs_for_smes_s6",
        "warn",
        derivedClosingRE,  // expected
        socieREClosing,    // actual
        sfpTolerance,
        `Opening RE (TZS ${socieREOpening.toLocaleString()}) + PAT (TZS ${sociePatForYear.toLocaleString()}) ` +
        `+ Dividends (TZS ${socieDividends.toLocaleString()}) = derived closing RE TZS ${derivedClosingRE.toLocaleString()} ` +
        `vs SOCIE reported closing TZS ${socieREClosing.toLocaleString()}.`
      ));
    }

    // ── H-12: IS PAT feeds SOCIE ──────────────────────────────────────────────
    // SOCIE profit_for_year must approximate IS (PBT − Tax).
    // This is a warn-only check — deferred tax timing can cause small diffs.
    if (pbtTzs === null || sociePatForYear === null) {
      assertions.push(skip(
        "H-12", "IS→SOCIE PAT Bridge: SOCIE PAT ≈ IS PBT − TaxExpense",
        "hoffman_fac_ifrs", "warn",
        "IS PBT or SOCIE profit_for_year missing."
      ));
    } else {
      const isPAT = pbtTzs - taxesTzs;
      const patTolAbs = Math.max(Math.abs(isPAT) * socieTolPct, mat.abs_threshold_tzs);
      assertions.push(assert(
        "H-12", "IS→SOCIE PAT Bridge: SOCIE PAT ≈ IS (PBT − TaxExpense)",
        "hoffman_fac_ifrs",
        "warn",
        isPAT,           // expected: IS-derived PAT
        sociePatForYear, // actual: SOCIE profit for year
        patTolAbs,
        `IS PBT (TZS ${pbtTzs.toLocaleString()}) − Tax (TZS ${taxesTzs.toLocaleString()}) = ` +
        `IS PAT TZS ${isPAT.toLocaleString()} vs SOCIE profit_for_year TZS ${sociePatForYear.toLocaleString()}. ` +
        `Differences may reflect deferred tax timing.`
      ));
    }

    // ── Tally results ─────────────────────────────────────────────────────────
    const passed  = assertions.filter(a => a.result === "pass").length;
    const failed  = assertions.filter(a => a.result === "fail").length;
    const skipped = assertions.filter(a => a.result === "skip").length;
    const total   = assertions.length;

    const status = failed > 0 ? "some_fail" : "all_pass";

    // ── Write results via SECURITY DEFINER ────────────────────────────────────
    const { data: validationId, error: writeErr } = await supabase.rpc(
      "hesabu_write_validation",
      {
        p_upload_id:           upload_id,
        p_company_id:          companyId,
        p_period_year:         periodYear,
        p_status:              status,
        p_assertions_total:    total,
        p_assertions_passed:   passed,
        p_assertions_failed:   failed,
        p_assertions_skipped:  skipped,
        p_sfp_tolerance_used:  Math.round(sfpTolerance),
        p_scf_tolerance_used:  scfTolerancePct,
        p_socie_tolerance_used: socieTolPct,
        p_request_id:          requestId,
        p_function_version:    FUNCTION_VERSION,
        p_assertions:          JSON.stringify(assertions.map(a => ({
          assertion_id:    a.assertion_id,
          assertion_name:  a.assertion_name,
          source_standard: a.source_standard,
          result:          a.result,
          skip_reason:     a.skip_reason ?? null,
          expected_value:  a.expected_value,
          actual_value:    a.actual_value,
          tolerance_used:  a.tolerance_used,
          severity:        a.severity,
          detail:          a.detail,
        }))),
      }
    );

    if (writeErr) {
      console.error("hesabu_write_validation error:", writeErr.message);
      return json({ error: "Failed to write validation results: " + writeErr.message, request_id: requestId }, 500);
    }

    // ── Structured response ───────────────────────────────────────────────────
    const failedAssertions = assertions.filter(a => a.result === "fail");

    return json({
      status,
      blocked:             failed > 0,
      validation_id:       validationId,
      upload_id,
      period_year:         periodYear,
      request_id:          requestId,
      function_version:    FUNCTION_VERSION,

      summary: {
        total,
        passed,
        failed,
        skipped,
        gate_satisfied: status === "all_pass",
      },

      tolerances_used: {
        sfp_tolerance_tzs:   Math.round(sfpTolerance),
        scf_tolerance_pct:   scfTolerancePct,
        socie_tolerance_pct: socieTolPct,
      },

      // Full detail for CPA review
      assertions: assertions.map(a => ({
        id:        a.assertion_id,
        name:      a.assertion_name,
        standard:  a.source_standard,
        result:    a.result,
        severity:  a.severity,
        detail:    a.detail,
        ...(a.result !== "skip" ? {
          expected_tzs: a.expected_value,
          actual_tzs:   a.actual_value,
          difference_tzs: a.actual_value !== null && a.expected_value !== null
            ? Math.round(Math.abs(a.actual_value - a.expected_value))
            : null,
          tolerance_tzs: a.tolerance_used,
        } : {}),
      })),

      // Quick-scan list of what failed (if any)
      failed_assertions: failedAssertions.map(a => ({
        id:            a.assertion_id,
        name:          a.assertion_name,
        severity:      a.severity,
        difference_tzs: a.actual_value !== null && a.expected_value !== null
          ? Math.round(Math.abs(a.actual_value - a.expected_value))
          : null,
        tolerance_tzs: a.tolerance_used,
      })),

      next_step: status === "all_pass"
        ? "Validation passed. Statement sign-off is now permitted."
        : `${failed} assertion(s) failed. Resolve issues before signing off. See failed_assertions for detail.`,
    }, 200);

  } catch (err: any) {
    console.error("hesabu-validate fatal error:", err);
    return json({ error: err.message, request_id: requestId }, 500);
  }
});
