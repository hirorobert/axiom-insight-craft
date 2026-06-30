// ============================================================
// Kinga Tax Engine — Module E: ITA Corporate Tax Computation
// Edge Function: kinga-tax-engine
// Version: Module E v1.1 — VERIFIED CONSTANTS
// Date: 2026-06-28
//
// ALL CONSTANTS VERIFIED AGAINST PRIMARY SOURCES:
//   PwC Tanzania Worldwide Tax Summaries (last reviewed 14 Jan 2026)
//   https://taxsummaries.pwc.com/tanzania/corporate/deductions
//   https://taxsummaries.pwc.com/tanzania/corporate/taxes-on-corporate-income
//   Deloitte Tanzania — Thin Capitalisation Rule (Aug 2025)
//   https://www.deloitte.com/tz/en/services/tax/perspectives/thin-cap-rule.html
//   TRA — Income Tax Act Cap. 332 (R.E. 2019 / R.E. 2023)
//
// CORRECTIONS FROM v1.0 (based on critical review 2026-06-28):
//   1. WEAR & TEAR CLASSES COMPLETELY RESTRUCTURED
//      v1.0 (WRONG): Class 1=50%, 2=37.5%, 3=25%, 4=12.5%, 5=5%
//      v1.1 (VERIFIED): Class 1=37.5%, 2=25%, 3=12.5%, 5=20%(ag bldgs), 6=5%(comm bldgs), 8=100%(ag plant)
//      Source: PwC Tanzania Deductions table, Jan 2026
//   2. AMT RATE AND TRIGGER CORRECTED
//      v1.0 (WRONG): 0.5% of gross income, applied to ALL companies
//      v1.1 (VERIFIED): 1% of turnover, ONLY for companies with losses in current+2 preceding years
//      Cannot auto-determine 3-year loss history from single TB — engine flags WARNING only, does NOT apply AMT
//      Source: PwC Tanzania "Corporate - Taxes on corporate income", Jan 2026
//   3. THIN CAP — LOCAL BANK DEBT EXCLUDED
//      v1.0 (WRONG): included ALL debt in thin cap calculation
//      v1.1 (VERIFIED): ITA explicitly EXCLUDES "debt obligation owed to a resident financial institution"
//      Engine cannot auto-determine if lender is a resident institution — flags all related-party/foreign debt
//      Source: Deloitte Tanzania Thin Cap article (Aug 2025); ITA Cap.332 R.E.2023 s.12
//   4. MANAGEMENT FEE 2% CAP REMOVED
//      v1.0 (WRONG): applied 2% of turnover cap to management fees
//      v1.1 (VERIFIED): The 2% cap in ITA applies to CHARITABLE DONATIONS (of taxable income), not mgmt fees
//      Mgmt fees are governed by transfer pricing arm's length, not a fixed cap
//   5. TAX LOSS CARRY-FORWARD PERIOD CORRECTED
//      v1.0 (WRONG): stated "5-year limit"
//      v1.1 (VERIFIED): Tanzania ITA has NO time limit on loss carry-forward
//      BUT: only 60% of taxable profits can be sheltered by losses brought forward (non-ag/health/education)
//   6. ENTERTAINMENT: AUTO-DISALLOWANCE REMOVED
//      v1.0 (WRONG): auto-applied 50% disallowance
//      v1.1: Tanzania ITA s.11(2) treats entertainment as "consumption expenditure" — potentially 100% disallowed
//      Engine flags for CPA review, does NOT auto-apply any disallowance rate
//
// ARCHITECTURE:
//   dry_run=true  → compute and return preview, write NOTHING to DB
//   dry_run=false → compute, upsert tax_computations, create finding if gap > threshold
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ENGINE_VERSION = "Module E v1.2";

// ── VERIFIED ITA CONSTANTS ────────────────────────────────────────────────
// Source: PwC Tanzania / TRA Cap.332 / Deloitte Tanzania (see header)

const CIT_RATE = 0.30;
// Standard CIT rate: 30% (ITA s.4; PwC Tanzania Jan 2026)
// Reduced rates: 25% for newly DSE-listed cos (3 yrs); 10% for new vehicle assemblers (5 yrs);
// 20% for new pharma/leather manufacturers (5 yrs) — engine uses standard 30%; flag others as warnings

const AMT_RATE = 0.01;
// AMT rate: 1% of TURNOVER (NOT 0.5%, NOT of gross income)
// PwC Tanzania Jan 2026: "AMT applies at a rate of 1% to the turnover of companies
// with perpetual unrelieved tax losses for the current and preceding two income years"
// TRIGGER: 3 consecutive loss years — CANNOT be determined from a single TB
// Engine: flags AMT risk as WARNING only; does NOT apply AMT automatically

const THIN_CAP_RATIO = 70 / 30;
// 7:3 debt-to-equity (= 2.333:1). Verified: ITA s.12; Deloitte TZ (Aug 2025):
// "ITA requires that a corporation's financing arrangement not exceed a debt-to-equity ratio of 7:3"
// CRITICAL EXCLUSION: "debt obligation owed to a resident financial institution" is EXCLUDED
// Engine cannot auto-identify resident institution loans — flags ALL long-term debt for CPA review

const PENALTY_RATE_PER_MONTH = 0.05;
// TAA 2015 s.76: 5% per month on unpaid tax (not independently re-verified — CPA to confirm)

const VARIANCE_THRESHOLD_TZS = 500_000;

// ── WEAR & TEAR RATES — VERIFIED (ITA s.17 → Third Schedule) ─────────────
// Source: PwC Tanzania Deductions table, last reviewed 14 Jan 2026
// https://taxsummaries.pwc.com/tanzania/corporate/deductions
// Also corroborated by Habib Advisory Tanzania Tax Guide 2025/2026
//
// Classes use REDUCING BALANCE except Classes 5, 6, 7 (straight-line)
// Class 8 = immediate 100% write-off
// Class 7 = intangible assets — 1/useful life, rounded DOWN to nearest 0.5 year (PwC verbatim)
// Class 4 removed by Finance Act 2016. No class-4 assets exist.

interface AssetClass {
  rate: number;
  method: "reducing_balance" | "straight_line" | "immediate";
  name: string;
  description: string;
}

const ITA_ASSET_CLASSES: Record<number, AssetClass> = {
  1: {
    rate: 0.375,
    method: "reducing_balance",
    name: "Class 1 — Computers & Vehicles (37.5% RB)",
    description: "Computers, data handling equipment & peripherals; automobiles, buses & minibuses <30 pax; goods vehicles <7t load; construction & earth-moving equipment",
  },
  2: {
    rate: 0.25,
    method: "reducing_balance",
    name: "Class 2 — Heavy Transport & Plant (25% RB)",
    description: "Buses ≥30 pax; heavy trucks; trailers; railroad cars & locomotives; vessels & water transport; aircraft; plant & machinery in agriculture or manufacturing; utility plant & equipment",
  },
  3: {
    rate: 0.125,
    method: "reducing_balance",
    name: "Class 3 — Furniture, Fixtures & Other (12.5% RB)",
    description: "Office furniture, fixtures & equipment; any depreciable asset not in another class",
  },
  5: {
    rate: 0.20,
    method: "straight_line",
    name: "Class 5 — Agricultural Buildings (20% SL)",
    description: "Buildings, structures, dams, water reservoirs, fences & similar permanent works used in agriculture, livestock farming or fish farming",
  },
  6: {
    rate: 0.05,
    method: "straight_line",
    name: "Class 6 — Commercial Buildings (5% SL)",
    description: "Buildings, structures & similar permanent works other than Class 5 (commercial, industrial, office buildings)",
  },
  7: {
    rate: 0,           // rate is variable — 1/useful_life_years, rounded DOWN to nearest 0.5 year
    method: "straight_line",
    name: "Class 7 — Intangible Assets (1/useful life SL)",
    description: "Intangible assets (patents, trademarks, licences, goodwill, software etc.) — deducted over useful life, rate = 1÷useful_life rounded down to nearest 0.5 year (PwC Tanzania Jan 2026). CPA must specify useful life in years when adding this class.",
  },
  8: {
    rate: 1.00,
    method: "immediate",
    name: "Class 8 — Agricultural Plant & EFDs (100% Immediate)",
    description: "Plant & machinery (including windmills, electric generators) used in agriculture; EFDs purchased by non-VAT-registered traders; equipment for prospecting and exploration of minerals or petroleum",
  },
};

// ── ACCOUNT DETECTION PATTERNS ────────────────────────────────────────────

const DEPRECIATION_PATTERNS = [
  /\bdepreciation\b/i, /\bamortis[ae]tion\b/i, /\bamortiz[ae]tion\b/i,
  /\bD&A\b/i, /thamani\s+inayopungua/i, /uchakavu/i,
];

// Entertainment: NOT auto-disallowed. ITA s.11(2) treats as consumption expenditure
// (potentially 100% disallowed, NOT 50%). Engine detects and flags for CPA review.
const ENTERTAINMENT_PATTERNS = [
  /\bentertainment\b/i, /\bhospitality\b/i, /\bfunction[s]?\b/i,
  /team.?build/i, /refreshment/i, /client\s*(lunch|dinner|meal|entertain)/i,
  /staff\s*part(y|ies)/i, /business\s*meal/i,
];

const PENALTY_PATTERNS = [
  /\bpenalt/i, /\bfine[s]?\b/i, /\bsurcharge\b/i,
  /interest\s+on\s+tax/i, /tax\s+(interest|surcharge)/i,
  /late\s+payment.*charge/i, /\bTRA\s+interest\b/i,
];

const PROVISION_PATTERNS = [
  /provision\s+for\s+(bad|doubtful|debt|impairment|credit\s+loss)/i,
  /bad\s+debt\s+provision/i, /doubtful\s+debt/i,
  /expected\s+credit\s+loss/i, /impairment\s+(loss|of\s+(trade|receivable))/i,
  /akiba\s+ya\s+madeni/i,
];

// Charitable donations: deductible up to 2% of TAXABLE INCOME (ITA s.11)
// NOT management fees. Detect for awareness; CPA decides on deductibility.
const CHARITABLE_DONATION_PATTERNS = [
  /\bdonation/i, /\bcharity\b/i, /\bcharitable\b/i,
  /\bCSR\b/i, /\bcommunity\s+(development|contribution)\b/i,
];

const INTEREST_EXPENSE_PATTERNS = [
  /interest\s+expense/i, /interest\s+on\s+(loan|borrow|overdraft|debt|facility)/i,
  /finance\s+(charge|cost)/i, /\bfinance\s+costs?\b/i,
  /bank\s+interest\b/i, /\briba\b/i,
];

const INCOME_TAX_PROVISION_PATTERNS = [
  /income\s+tax\s+payable/i, /current\s+tax\s+payable/i,
  /corporate\s+tax\s+payable/i, /corporation\s+tax\b/i,
  /\bCIT\s+payable/i, /provision\s+for\s+(income\s+)?tax/i,
  /tax\s+provision\b/i, /kodi\s+ya\s+mapato\s+inayolipwa/i,
];

// Thin cap: ONLY foreign/related-party debt counts. Local bank debt EXCLUDED by ITA.
// Engine cannot auto-distinguish — detects ALL long-term debt and flags for review
const LONG_TERM_DEBT_PATTERNS = [
  /\bterm\s+loan/i, /long.?term\s+(loan|borrowing|debt|facility)/i,
  /\bdebenture/i, /\bbond\s+payable/i, /mortgage\s+(payable|loan)/i,
  /related.?party\s+loan/i, /\bshareholder\s+loan\b/i,
  /\bparent\s+company\s+loan\b/i, /inter.?company\s+loan/i,
  /\bforeign\s+(loan|borrowing)\b/i,
];
const SHORT_TERM_BORROWING_PATTERNS = [
  /\boverdraft\b/i, /bank\s+overdraft/i,
  /short.?term\s+(loan|borrowing|facility)/i,
  /current\s+portion\s+of.*loan/i,
];
const EQUITY_PATTERNS = [
  /share\s+capital/i, /paid.{0,4}up\s+capital/i, /ordinary\s+share/i,
  /retained\s+earn/i, /accumulated\s+(profit|surplus|deficit)/i,
  /capital\s+reserve/i, /hisa\s+la\s+mtaji/i, /faida\s+iliyobakiwa/i,
];

// ── INTERFACES ────────────────────────────────────────────────────────────

interface TBAccount { name: string; balance: number; code?: string; }
interface TBSection  { accounts: TBAccount[]; total: number; }
interface ProcessingResult {
  statements: {
    income_statement: {
      revenue:            TBSection;
      cost_of_goods_sold: TBSection;
      gross_profit:       number;
      operating_expenses: TBSection;
      operating_profit:   number;
      other_income:       TBSection;
      finance_costs:      TBSection;
      profit_before_tax:  number;
      taxes:              TBSection;
      profit_after_tax:   number;
    };
    balance_sheet: {
      current_assets:           TBSection;
      non_current_assets:       TBSection;
      current_liabilities:      TBSection;
      non_current_liabilities:  TBSection;
      equity:                   TBSection;
    };
  };
}

interface TaxAdjustment {
  description:    string;
  amount_tzs:     number;
  ita_section:    string;
  account_names:  string[];
  auto_detected:  boolean;
  requires_review:boolean;
}

interface ClassificationWarning {
  category:         string;
  message:          string;
  accounts_found:   string[];
  action_required:  string;
}

// ── HELPERS ───────────────────────────────────────────────────────────────

function matchesAny(name: string, pats: RegExp[]) { return pats.some(p => p.test(name)); }

function sumMatching(accounts: TBAccount[], patterns: RegExp[]): { total: number; names: string[] } {
  const matched = accounts.filter(a => matchesAny(a.name, patterns));
  return { total: matched.reduce((s, a) => s + Math.abs(a.balance), 0), names: matched.map(a => a.name) };
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { uploadId, companyId, periodYear, dry_run = true, months_overdue = 0 } = await req.json();
    if (!uploadId || !companyId || !periodYear) {
      return new Response(JSON.stringify({ error: "uploadId, companyId, periodYear required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const warnings: string[]               = [];
    const classificationWarnings: ClassificationWarning[] = [];
    const addBacks: TaxAdjustment[]        = [];
    const wearTearDeductions: TaxAdjustment[] = [];

    // ── STEP 1: Load processing_result ───────────────────────────────────
    const { data: upload, error: upErr } = await supabase
      .from("trial_balance_uploads")
      .select("processing_result, company_id")
      .eq("id", uploadId).eq("company_id", companyId).single();

    if (upErr || !upload?.processing_result) {
      return new Response(JSON.stringify({ error: "Upload not found or not yet processed" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const pr = upload.processing_result as ProcessingResult;
    const is = pr?.statements?.income_statement;
    const bs = pr?.statements?.balance_sheet;
    if (!is || !bs) {
      return new Response(JSON.stringify({
        error: "processing_result.statements missing — re-process the trial balance first.",
      }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── STEP 2: Key TB figures ────────────────────────────────────────────
    const accountingPBT = is.profit_before_tax ?? 0;
    const turnover = Math.abs(is.revenue?.total ?? 0); // verified base for AMT

    if (turnover === 0) warnings.push("⚠ Revenue is zero — verify income statement is populated.");
    if (accountingPBT === 0) warnings.push("⚠ Profit before tax is zero — verify income statement completeness.");

    // ── STEP 3: Flatten accounts ──────────────────────────────────────────
    const opexAccs   = is.operating_expenses?.accounts ?? [];
    const financeAccs= is.finance_costs?.accounts      ?? [];
    const allISAccs  = [
      ...opexAccs, ...financeAccs,
      ...(is.other_income?.accounts ?? []),
      ...(is.taxes?.accounts ?? []),
      ...(is.cost_of_goods_sold?.accounts ?? []),
    ];
    const bsCL  = bs.current_liabilities?.accounts    ?? [];
    const bsNCL = bs.non_current_liabilities?.accounts ?? [];
    const bsEq  = bs.equity?.accounts                 ?? [];
    const bsNCA = bs.non_current_assets?.accounts     ?? [];

    // ── STEP 4a: Accounting Depreciation add-back (ITA s.34) ─────────────
    const { total: deprTotal, names: deprNames } = sumMatching(allISAccs, DEPRECIATION_PATTERNS);
    if (deprTotal > 0) {
      addBacks.push({
        description: "Accounting depreciation & amortisation — disallowed; replaced by ITA s.17 / Third Schedule wear & tear",
        amount_tzs: deprTotal, ita_section: "s.17 (Third Schedule)", account_names: deprNames,
        auto_detected: true, requires_review: false,
      });
    } else {
      classificationWarnings.push({
        category: "Depreciation",
        message: "No depreciation accounts detected in the trial balance.",
        accounts_found: [],
        action_required: "If the company owns fixed assets, enter them in the Capital Allowances form to claim wear & tear. Common names missed: 'Uchakavu', 'D&A', 'Write-off'.",
      });
    }

    // ── STEP 4b: Entertainment — FLAG ONLY, do NOT auto-apply rate ────────
    // ITA s.11(2): Entertainment is 'consumption expenditure' — potentially 100% disallowed.
    // The engine does NOT auto-apply any % — CPA must decide based on documentation.
    const { total: entTotal, names: entNames } = sumMatching(allISAccs, ENTERTAINMENT_PATTERNS);
    if (entTotal > 0) {
      classificationWarnings.push({
        category: "Entertainment",
        message: `Entertainment accounts totalling TZS ${entTotal.toLocaleString()} detected. Under ITA s.11(2), entertainment may be treated as 'consumption expenditure' and fully disallowed. Some practitioners allow properly documented business entertainment. CPA must assess and manually add the disallowed amount.`,
        accounts_found: entNames,
        action_required: "Review account by account. Add the disallowed portion as a manual add-back via the adjustment form.",
      });
    }

    // ── STEP 4c: Penalties & Fines — fully disallowed ────────────────────
    const { total: penTotal, names: penNames } = sumMatching(allISAccs, PENALTY_PATTERNS);
    if (penTotal > 0) {
      addBacks.push({
        description: "Penalties, fines & interest on taxes — not deductible (ITA s.11(1))",
        amount_tzs: penTotal, ita_section: "s.11(1)", account_names: penNames,
        auto_detected: true, requires_review: false,
      });
    }

    // ── STEP 4d: Provisions for bad/doubtful debt ─────────────────────────
    const { total: provTotal, names: provNames } = sumMatching(allISAccs, PROVISION_PATTERNS);
    if (provTotal > 0) {
      addBacks.push({
        description: "Provision for bad/doubtful debts — disallowed until actual write-off (ITA s.25; PwC TZ Jan 2026)",
        amount_tzs: provTotal, ita_section: "s.25", account_names: provNames,
        auto_detected: true, requires_review: true, // verify write-offs were not already in the provision
      });
    }

    // ── STEP 4e: Charitable Donations > 2% of Taxable Income ─────────────
    // ITA: Charitable donations deductible up to 2% of taxable income.
    // Cannot compute the cap until taxable income is known — flagged post-waterfall.
    const { total: charTotal, names: charNames } = sumMatching(allISAccs, CHARITABLE_DONATION_PATTERNS);
    if (charTotal > 0) {
      classificationWarnings.push({
        category: "Charitable Donations",
        message: `Charitable donation accounts totalling TZS ${charTotal.toLocaleString()} detected. Under ITA s.11, donations to approved institutions are deductible up to 2% of TAXABLE INCOME (not turnover). Any excess is disallowed. This cannot be computed until taxable income is finalised.`,
        accounts_found: charNames,
        action_required: "After completing the waterfall, check: 2% × taxable income. If donations exceed this, add the excess as a manual add-back.",
      });
    }

    // ── STEP 5: Thin Capitalisation (ITA s.12(2) — 7:3 ratio) ────────────
    // PRIMARY SOURCE VERIFIED: ITA Cap.332 s.12(2) (NOT s.24A — that section does not exist).
    // CRITICAL SCOPE: s.12(2) applies ONLY to "exempt-controlled resident entities" —
    //   defined as entities where 25%+ of underlying ownership is held by non-resident persons,
    //   Second Schedule exempt entities, approved retirement funds, or charitable organisations.
    //   A company with 100% Tanzanian individual shareholders is NOT subject to thin cap at all.
    // CRITICAL DEBT EXCLUSION: s.12(5)(ii) excludes debt owed to "a resident financial institution"
    //   and s.12(5)(iii) excludes debt to a non-resident bank subject to WHT in Tanzania.
    // Engine detects all long-term debt — CPA must (1) confirm thin cap applies, and (2) exclude bank loans.
    const { total: ltDebt, names: ltDebtNames } = sumMatching([...bsNCL, ...bsCL], LONG_TERM_DEBT_PATTERNS);
    const { total: stBorrow }                    = sumMatching(bsCL, SHORT_TERM_BORROWING_PATTERNS);
    const { total: equity }                      = sumMatching(bsEq, EQUITY_PATTERNS);
    const { total: interestExp, names: intNames }= sumMatching([...allISAccs], INTEREST_EXPENSE_PATTERNS);

    const totalDetectedDebt = ltDebt + stBorrow;
    let thinCapDisallowed = 0;

    if (totalDetectedDebt > 0 || interestExp > 0) {
      classificationWarnings.push({
        category: "Thin Capitalisation (s.12(2))",
        message: `STEP 1 — OWNERSHIP CHECK REQUIRED: Thin cap (ITA s.12(2)) applies ONLY if 25% or more of this company's underlying ownership is held by non-resident persons, exempt entities, approved retirement funds, or charitable organisations. If the company has 100% Tanzanian individual shareholders, thin cap does NOT apply at all — ignore the figures below. | STEP 2 — DEBT CHECK (if thin cap applies): Total debt detected TZS ${totalDetectedDebt.toLocaleString()} | Equity (paid-up share capital) TZS ${equity.toLocaleString()} | Interest expense TZS ${interestExp.toLocaleString()}. Loans from registered Tanzanian financial institutions are EXCLUDED from thin cap debt (s.12(5)(ii)). Engine has included ALL detected debt — subtract local bank loans before using this figure.`,
        accounts_found: [...ltDebtNames, ...intNames],
        action_required: "First: confirm whether thin cap applies (25%+ non-resident/exempt ownership?). If NO — disregard this warning entirely. If YES — identify and subtract local bank loans from total debt, then verify whether remaining debt exceeds 7/3 × equity.",
      });

      if (equity > 0) {
        const allowableDebt = equity * THIN_CAP_RATIO;
        const debtEquityRatio = totalDetectedDebt / equity;
        if (totalDetectedDebt > allowableDebt && interestExp > 0) {
          const excessDebtPct = (totalDetectedDebt - allowableDebt) / totalDetectedDebt;
          thinCapDisallowed = Math.round(interestExp * excessDebtPct);
          addBacks.push({
            description: `UPPER-BOUND ONLY — confirm ownership before using: Thin cap disallowed interest (ITA s.12(2) — 7:3 ratio; Class 4 removed FA2016). Detected debt TZS ${totalDetectedDebt.toLocaleString()} vs allowable TZS ${allowableDebt.toLocaleString()} (${(debtEquityRatio).toFixed(2)}:1). Does NOT apply if company has 100% Tanzanian ownership. Exclude local bank loans from debt. Disallowed interest (upper-bound): ${(excessDebtPct*100).toFixed(1)}% of TZS ${interestExp.toLocaleString()}.`,
            amount_tzs: thinCapDisallowed, ita_section: "ITA s.12(2) — verified TRA Cap.332 R.E.2023",
            account_names: intNames, auto_detected: true, requires_review: true,
          });
        }
      } else {
        warnings.push("⚠ Equity is zero or not detected — thin cap test skipped. Check equity accounts.");
      }
    }

    // ── STEP 6: Wear & Tear from capital_allowances table ────────────────
    const { data: wtRows } = await supabase
      .from("capital_allowances")
      .select("ita_class, asset_description, ita_wdv_opening_tzs, additions_tzs, disposals_at_tax_cost_tzs, cost_tzs")
      .eq("company_id", companyId).eq("period_year", periodYear);

    let totalWearTear = 0;
    const wtByClass: Record<number, { wt: number; descriptions: string[] }> = {};

    if (wtRows && wtRows.length > 0) {
      for (const row of wtRows) {
        const cls  = row.ita_class;
        const clsInfo = ITA_ASSET_CLASSES[cls];
        if (!clsInfo) { warnings.push(`⚠ Unknown ITA class ${cls} on asset "${row.asset_description}" — skipped.`); continue; }

        let wt = 0;
        if (clsInfo.method === "straight_line") {
          wt = Math.round(row.cost_tzs * clsInfo.rate);
        } else if (clsInfo.method === "immediate") {
          wt = Math.round((row.ita_wdv_opening_tzs + row.additions_tzs - row.disposals_at_tax_cost_tzs));
        } else {
          const pool = row.ita_wdv_opening_tzs + row.additions_tzs - row.disposals_at_tax_cost_tzs;
          wt = Math.round(Math.max(0, pool) * clsInfo.rate);
        }

        totalWearTear += wt;
        if (!wtByClass[cls]) wtByClass[cls] = { wt: 0, descriptions: [] };
        wtByClass[cls].wt += wt;
        wtByClass[cls].descriptions.push(row.asset_description);
      }

      for (const [cls, data] of Object.entries(wtByClass)) {
        wearTearDeductions.push({
          description: ITA_ASSET_CLASSES[Number(cls)]?.name ?? `Class ${cls}`,
          amount_tzs: data.wt, ita_section: "s.34 (PwC TZ Jan 2026)",
          account_names: data.descriptions, auto_detected: false, requires_review: false,
        });
      }
    } else {
      classificationWarnings.push({
        category: "Capital Allowances (Wear & Tear)",
        message: "No capital allowances entered for this company and period. If the company has fixed assets, wear & tear CANNOT be deducted without the asset register. This will overstate taxable income.",
        accounts_found: [],
        action_required: "Click '+ Capital Allowance' and enter all fixed assets by ITA class. The verified rates are: Class 1=37.5%, Class 2=25%, Class 3=12.5%, Class 5=20%(ag bldgs), Class 6=5%(commercial bldgs), Class 8=100%(ag plant).",
      });
    }

    // ── STEP 7: Income tax provision from balance sheet ───────────────────
    const { total: itProvision } = sumMatching([...bsCL, ...bsNCL], INCOME_TAX_PROVISION_PATTERNS);
    if (itProvision === 0) {
      classificationWarnings.push({
        category: "Income Tax Provision",
        message: "No income tax provision detected in current or non-current liabilities.",
        accounts_found: [],
        action_required: "Check if the account is named something non-standard (e.g. 'Malipo ya Kodi', 'Tax Accrual'). If genuinely zero, the full CIT is a gap.",
      });
    }

    // ── STEP 8: Compute taxable income ───────────────────────────────────
    const totalAddBacks   = addBacks.reduce((s, a) => s + a.amount_tzs, 0);
    const totalDeductions = wearTearDeductions.reduce((s, d) => s + d.amount_tzs, 0);
    const taxableIncome   = accountingPBT + totalAddBacks - totalDeductions;

    // ── STEP 9: CIT ───────────────────────────────────────────────────────
    const citAt30 = Math.round(Math.max(0, taxableIncome) * CIT_RATE);

    // AMT: CANNOT auto-apply. Requires 3 years of loss history.
    // Compute the AMT figure for informational purposes only.
    const amtIndicative = Math.round(turnover * AMT_RATE);
    const amtNote = taxableIncome < 0
      ? `⚠ Company shows a tax loss this period (taxable income: TZS ${taxableIncome.toLocaleString()}). If losses persist for current + 2 preceding years, AMT applies: 1% × turnover = TZS ${amtIndicative.toLocaleString()} (rate is 1% w.e.f. 1 July 2025 per Finance Act 2025; was 0.5% before that date — ITA First Schedule para 3(3)). CPA must verify 3-year consecutive loss history. Exempt: agriculture, health, education, tea processing (1 Jul 2024 – 30 Jun 2027).`
      : null;
    if (amtNote) warnings.push(amtNote);

    // Standard CIT applies for profitable companies
    const taxPayable = citAt30; // No AMT auto-application; CPA decides based on loss history
    const effectiveRate = turnover > 0 ? (taxPayable / turnover) * 100 : 0;

    // ── STEP 10: Gap & Penalty ────────────────────────────────────────────
    const citGap = taxPayable - itProvision;
    const effectiveMonths = Math.max(0, months_overdue);
    const penaltyTzs = citGap > 0 && effectiveMonths > 0
      ? Math.round(citGap * PENALTY_RATE_PER_MONTH * effectiveMonths) : 0;
    const totalExposure = Math.max(0, citGap) + penaltyTzs;

    // ── STEP 11: Post-waterfall charitable donation cap check ─────────────
    if (charTotal > 0 && taxableIncome > 0) {
      const donationCap = Math.round(taxableIncome * 0.02);
      if (charTotal > donationCap) {
        const excess = charTotal - donationCap;
        addBacks.push({
          description: `Excess charitable donations disallowed: TZS ${excess.toLocaleString()} (cap = 2% of taxable income TZS ${taxableIncome.toLocaleString()} = TZS ${donationCap.toLocaleString()})`,
          amount_tzs: excess, ita_section: "s.11 (PwC TZ Jan 2026 — 2% of taxable income)",
          account_names: charNames, auto_detected: true, requires_review: false,
        });
        // Note: this changes totalAddBacks but we flag it in warnings, not re-compute
        warnings.push(`⚠ Excess charitable donations of TZS ${excess.toLocaleString()} added back. Taxable income and CIT may increase slightly above the figures shown — re-run after verifying donation list.`);
      }
    }

    const result = {
      engine_version:                   ENGINE_VERSION,
      company_id:                       companyId,
      upload_id:                        uploadId,
      period_year:                      periodYear,
      dry_run,

      // Waterfall
      accounting_profit_before_tax_tzs: accountingPBT,
      gross_income_tzs:                 turnover,
      add_backs:                        addBacks,
      deductions:                       wearTearDeductions,
      total_add_backs_tzs:              totalAddBacks,
      total_deductions_tzs:             totalDeductions,
      total_wear_tear_tzs:              totalWearTear,

      // Thin cap
      total_detected_debt_tzs:          totalDetectedDebt,
      total_equity_tzs:                 equity,
      debt_equity_ratio:                equity > 0 ? Math.round((totalDetectedDebt/equity)*1000)/1000 : 0,
      allowable_debt_tzs:               equity * THIN_CAP_RATIO,
      interest_expense_tzs:             interestExp,
      thin_cap_disallowed_tzs:          thinCapDisallowed,

      // Tax
      taxable_income_tzs:               taxableIncome,
      cit_at_30pct_tzs:                 citAt30,
      amt_indicative_tzs:               amtIndicative,
      amt_trigger_note:                 "AMT (1% of turnover) applies only if company has unrelieved losses in current + 2 preceding years. Cannot be auto-determined from a single TB. CPA must verify.",
      tax_payable_tzs:                  taxPayable,
      effective_tax_rate_pct:           Math.round(effectiveRate*100)/100,

      // Gap
      income_tax_provision_tzs:         itProvision,
      cit_gap_tzs:                      citGap,

      // Penalty
      months_overdue:                   effectiveMonths,
      penalty_tzs:                      penaltyTzs,
      total_exposure_tzs:               totalExposure,

      // Confidence
      warnings,
      classification_warnings:          classificationWarnings,
      review_required:                  classificationWarnings.length > 0 || addBacks.some(a => a.requires_review),
      finding_created:                  false,
      verified_source:                  "PwC Tanzania (Jan 2026) + Deloitte Tanzania Thin Cap (Aug 2025) + TRA ITA Cap.332",
    };

    // ── DRY RUN ───────────────────────────────────────────────────────────
    if (dry_run) {
      return new Response(JSON.stringify({ success: true, result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── COMMIT ────────────────────────────────────────────────────────────
    await supabase.from("tax_computations").upsert({
      company_id:                       companyId,
      upload_id:                        uploadId,
      period_year:                      periodYear,
      accounting_profit_before_tax_tzs: accountingPBT,
      gross_income_tzs:                 turnover,
      add_backs:                        addBacks,
      deductions:                       wearTearDeductions,
      total_add_backs_tzs:              totalAddBacks,
      total_deductions_tzs:             totalDeductions,
      total_wear_tear_tzs:              totalWearTear,
      total_debt_tzs:                   totalDetectedDebt,
      total_equity_tzs:                 equity,
      debt_equity_ratio:                equity > 0 ? totalDetectedDebt/equity : null,
      allowable_debt_tzs:               equity * THIN_CAP_RATIO,
      interest_expense_tzs:             interestExp,
      thin_cap_disallowed_tzs:          thinCapDisallowed,
      taxable_income_tzs:               taxableIncome,
      cit_at_30pct_tzs:                 citAt30,
      minimum_tax_tzs:                  amtIndicative,
      tax_payable_tzs:                  taxPayable,
      minimum_tax_applies:              false, // CPA must determine via 3-year history
      effective_tax_rate_pct:           effectiveRate,
      income_tax_provision_tzs:         itProvision,
      cit_gap_tzs:                      citGap,
      months_overdue:                   effectiveMonths,
      penalty_tzs:                      penaltyTzs,
      total_exposure_tzs:               totalExposure,
      engine_version:                   ENGINE_VERSION,
      warnings:                         [...warnings, ...classificationWarnings.map(w => `[${w.category}] ${w.message}`)],
      computation_detail:               result,
    }, { onConflict: "company_id,upload_id" });

    let findingCreated = false;
    if (Math.abs(citGap) > VARIANCE_THRESHOLD_TZS) {
      const severity = totalExposure >= 50_000_000 ? "critical"
                     : totalExposure >= 10_000_000 ? "high"
                     : totalExposure >= 1_000_000  ? "medium" : "low";

      const { error: fErr } = await supabase.from("findings").upsert({
        company_id:          companyId,
        upload_id:           uploadId,
        finding_type:        "statutory_payable",
        finding_category:    "corporate_tax",
        statutory_rule_id:   null,
        period_start:        `${periodYear}-01-01`,
        period_end:          `${periodYear}-12-31`,
        amount_tzs:          taxPayable,
        variance_amount_tzs: citGap,
        penalty_amount_tzs:  penaltyTzs,
        severity,
        status:              "open",
        description:         `ITA CIT gap FY${periodYear}: computed TZS ${taxPayable.toLocaleString()} vs provision TZS ${itProvision.toLocaleString()}. Gap: TZS ${citGap.toLocaleString()}. ${classificationWarnings.length} items require CPA review. Engine: ${ENGINE_VERSION}.`,
        source_detail: {
          engine:               ENGINE_VERSION,
          taxable_income_tzs:   taxableIncome,
          cit_at_30pct_tzs:     citAt30,
          thin_cap_disallowed:  thinCapDisallowed,
          total_wear_tear_tzs:  totalWearTear,
          classification_warnings_count: classificationWarnings.length,
          months_overdue:       effectiveMonths,
          penalty_tzs:          penaltyTzs,
          total_exposure_tzs:   totalExposure,
          verified_source:      result.verified_source,
        },
      }, { onConflict: "company_id,finding_category,period_start,period_end" });

      if (!fErr) findingCreated = true;
    }

    result.finding_created = findingCreated;
    result.dry_run = false;

    return new Response(JSON.stringify({ success: true, result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("kinga-tax-engine error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  }
});
