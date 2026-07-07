/* Canonical Financial Model:
   production axiom/kinga_canonical_financial_model.md
   All financial data consumed by this module must conform
   to that contract.
   Key correction: statutory_rules audit field is 'notes', not 'source_note'.
   canonical_financial_records is a transaction ingestion table, not
   an account-balance table. Account balances live in trial_balance_uploads
   and account_mappings. */
// ============================================================
// Kinga Tax Engine — Module E: ITA Corporate Tax Computation
// Edge Function: kinga-tax-engine
// Version: Module E v1.3 — Finance Act 2026 (enacted)
// Date: 2026-07-01
//
// ── PRIMARY SOURCES ──────────────────────────────────────────
//   Income Tax Act, Cap. 332 R.E. 2023 (TRA)
//   Finance Act, 2026 — No. 3 of 2026, Gazette Vol. 107 No. 6,
//     15 June 2026, assented to and effective 1 July 2026
//   PwC Tanzania Worldwide Tax Summaries (last reviewed 14 Jan 2026)
//   Deloitte Tanzania — Thin Capitalisation Rule (Aug 2025)
//
// ── CHANGES IN v1.3 vs v1.2 (Finance Act 2026 — FA2026) ─────
//
//   1. DEEMED RETAINED EARNINGS FRACTION — ITA s.33A (FA2026 s.23)
//      v1.2: 30% deemed distributed; v1.3: 15%
//      Excluded: DSE-listed companies, financial institutions (BAFIA),
//        insurance companies, mining companies with Framework Agreement
//      Engine: exposes constant FA2026_DEEMED_DISTRIBUTION_RATE = 0.15
//      Not auto-applied in CIT waterfall (separate WHT obligation)
//
//   2. NON-RESIDENT DIGITAL SERVICE TAX — ITA s.116(1) (FA2026 s.26)
//      v1.2: 2%; v1.3: 3%
//      Engine: constant FA2026_NONRESIDENT_DIGITAL_WHT = 0.03
//      Reported in fa2026_provisions output block for CPA awareness
//
//   3. TRANSFER PRICING PENALTY — TAA Cap.438 s.90(2)(c) (FA2026 s.82)
//      v1.2: 100% of tax shortfall
//      v1.3: 30% of the TP adjustment amount (NOT of the tax shortfall)
//      Engine: updates TP penalty constant; reported in warnings
//
//   4. PRESUMPTIVE TAX THRESHOLD — ITA First Schedule Item 2 (FA2026 s.31)
//      v1.2: TZS 100,000,000 ceiling
//      v1.3: TZS 200,000,000 ceiling
//      Top band rate: 3.5% → 4.5% (turnover 11,000,001–200,000,000)
//      Engine: constants updated; flagged in fa2026_provisions
//
//   5. NEW — WHT ON CROPS/LIVESTOCK/FISHERIES — ITA new s.109A (FA2026 s.25)
//      Resident corporations must withhold 1% on payments for crops,
//        livestock products (incl. live animals, unprocessed milk),
//        fishery products (incl. unprocessed fish, fish maws)
//      Engine: constant FA2026_WHT_CROPS_LIVESTOCK_FISHERIES = 0.01
//      Reported as awareness warning when payroll/purchase accounts detected
//
//   6. NEW — SINGLE INSTALMENT ON FOOD CROPS — ITA new s.116B (FA2026 s.28)
//      1% on value of food crop purchases (farm gate / purchase price, higher)
//      Does NOT apply to: sesame, sugarcane, tobacco, tea, cashew, coffee,
//        cotton, pyrethrum, sisal; or quantities < 1 tonne
//      Engine: constant FA2026_SINGLE_INSTALMENT_FOOD_CROPS = 0.01
//
//   7. FOREST PRODUCE INSTALMENT — ITA s.116A (FA2026 s.27) — SCOPE ONLY
//      Rate unchanged at 2%. Definition of "forest produce" expanded to
//        include natural varnish, latex, resin, sap, gums
//      Engine: FA2026_FOREST_PRODUCE_INSTALMENT_RATE = 0.02 (unchanged)
//
//   8. SDL (VET Act Cap.82 s.19) — NO RATE CHANGE
//      FA2026 Part XXVI (s.102) only clarifies Government institution
//        exemption wording. SDL rate remains 4.5% of gross emoluments.
//
//   9. CIT RATE — NO CHANGE. Remains 30%.
//  10. PAYE — NO CHANGE.
//  11. WEAR & TEAR — NO CHANGE (Third Schedule rates unchanged).
//  12. AMT — NO CHANGE. Remains 1% of turnover; 3-year consecutive loss trigger.
//
// ── CORRECTIONS FROM v1.0→v1.2 (retained for audit trail) ───
//   v1.1: Wear & tear classes restructured; AMT rate corrected to 1%/turnover;
//         Thin cap local bank debt exclusion added; mgmt fee 2% cap removed;
//         Loss carry-forward period corrected (no time limit, 60% cap);
//         Entertainment auto-disallowance removed
//
// ── ARCHITECTURE ─────────────────────────────────────────────
//   dry_run=true  → compute and return preview, write NOTHING to DB
//   dry_run=false → compute, upsert tax_computations, create finding if gap > threshold
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ENGINE_VERSION = "Module E v1.3 — FA2026";

// ── ITA CONSTANTS — VERIFIED + FA2026 UPDATED ────────────────────────────
// Source: ITA Cap.332 R.E.2023 / PwC Tanzania Jan 2026 / Deloitte TZ Aug 2025
//         Finance Act 2026 (No. 3, effective 1 July 2026)

const CIT_RATE = 0.30;
// Standard CIT rate: 30% (ITA s.4). UNCHANGED by FA2026.
// Reduced rates: 25% for newly DSE-listed cos (3 yrs); 10% for new vehicle assemblers (5 yrs);
// 20% for new pharma/leather manufacturers (5 yrs) — engine uses standard 30%; flag others as warnings

const AMT_RATE = 0.01;
// AMT rate: 1% of TURNOVER. UNCHANGED by FA2026.
// Trigger: 3 consecutive years of tax losses (current + 2 preceding) — cannot auto-determine from single TB
// Exemptions: agriculture, health, education, tea processing sectors
// Engine: flags AMT risk as WARNING only; does NOT apply AMT automatically

/* Loss carry-forward annual shelter cap: 70%.
   Source: Income Tax Act Cap. 332 R.E. 2023, section 19,
   subsection (2). FA 2020 amendment.
   Verified 2026-07-02 by cpahumphrey@gmail.com. */
const LOSS_CARRYFORWARD_SHELTER = 0.70;
// Maximum proportion of income that may be sheltered by unrelieved losses in any year.
// Income after loss deduction shall not fall below 30% of pre-deduction income (s.19(2)).
// Exception: agricultural business, health, education services corporations (s.19(2) proviso).

const THIN_CAP_RATIO = 70 / 30;
// 7:3 debt-to-equity (= 2.333:1). UNCHANGED by FA2026.
// Verified: ITA Cap.332 s.12; Deloitte TZ (Aug 2025)
// CRITICAL EXCLUSION: "debt obligation owed to a resident financial institution" is EXCLUDED (s.12(5)(ii))
// Engine cannot auto-identify resident institution loans — flags ALL long-term debt for CPA review

const PENALTY_RATE_PER_MONTH = 0.05;
// TAA Cap.438 s.76: 5% per month on unpaid tax. UNCHANGED by FA2026.

const VARIANCE_THRESHOLD_TZS = 500_000;

// ── FINANCE ACT 2026 CONSTANTS (effective 1 July 2026) ───────────────────
// Source: Finance Act 2026, No. 3 of 2026, Gazette Vol. 107 No. 6, 15 June 2026

const FA2026_DEEMED_DISTRIBUTION_RATE = 0.15;
// ITA s.33A amended by FA2026 s.23: deemed retained earnings fraction 30% → 15%
// WHT on deemed amount (10%) is unchanged and is a SEPARATE obligation
// Excluded entities: DSE-listed companies; financial institutions (BAFIA); insurance companies;
//   mining companies with Government Framework Agreement
// This constant is for INFORMATION / CPA AWARENESS only — not applied in CIT waterfall

const FA2026_NONRESIDENT_DIGITAL_WHT = 0.03;
// ITA s.116(1) amended by FA2026 s.26: non-resident digital service provider tax 2% → 3%
// Applies to payments to non-resident providers of digital/electronic services
// Withheld by the payer at time of payment

const FA2026_TP_PENALTY_RATE = 0.30;
// TAA s.90(2)(c) amended by FA2026 s.82: transfer pricing penalty changed from
// "100% of tax shortfall" to "30% of the TP ADJUSTMENT AMOUNT" (not of the tax shortfall)
// This is a significant reduction in TP penalty exposure

const FA2026_PRESUMPTIVE_THRESHOLD = 200_000_000;
// ITA First Schedule Item 2 amended by FA2026 s.31: ceiling raised 100M → 200M TZS
// Taxpayers below this ceiling may elect self-assessment and maintain books of account

const FA2026_PRESUMPTIVE_TOP_RATE = 0.045;
// FA2026 s.31: top band rate 3.5% → 4.5% for turnover 11,000,001–200,000,000 TZS
// Full replacement table (all 5 bands) effective 1 July 2026:
//   Band 1: ≤ 4,000,000         → NIL
//   Band 2: new TIN, any amount → NIL (first year)
//   Band 3: 4,000,001–7,000,000 → TZS 100,000 (non-compliant) / 3% of excess over 4M (compliant)
//   Band 4: 7,000,001–11,000,000→ TZS 250,000 (non-compliant) / TZS 90,000 + 3% excess over 7M (compliant)
//   Band 5: 11,000,001–200,000,000 → 4.5% of turnover (compliant) [changed from 3.5%]

const FA2026_WHT_CROPS_LIVESTOCK_FISHERIES = 0.01;
// ITA new s.109A added by FA2026 s.25: 1% WHT by resident corporations on payments for:
//   crops; livestock products (incl. live animals, unprocessed milk);
//   fishery products (incl. unprocessed fish, fish maws)
// First Schedule para 4(d) encodes the rate

const FA2026_SINGLE_INSTALMENT_FOOD_CROPS = 0.01;
// ITA new s.116B added by FA2026 s.28: 1% single instalment on food crop purchases
// Does NOT apply to: sesame, sugarcane, tobacco, tea, cashew nuts, coffee, cotton, pyrethrum, sisal
// Does NOT apply if quantity < 1 tonne

const FA2026_FOREST_PRODUCE_INSTALMENT_RATE = 0.02;
// ITA s.116A amended by FA2026 s.27: rate UNCHANGED at 2%
// Scope EXPANDED: "forest produce" now includes natural varnish, latex, resin, sap, gums

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

interface TBAccount {
  // process-trial-balance v2+ writes account_name (snake_case).
  // Older snapshots may have name (camelCase). Support both.
  account_name?: string;
  name?:         string;
  balance:       number;
  account_code?: string;
  code?:         string;
}
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

function matchesAny(name: string | undefined, pats: RegExp[]): boolean {
  if (!name) return false;
  return pats.some(p => p.test(name));
}

/** Resolve the human-readable account name from either field convention. */
function accountLabel(a: TBAccount): string {
  return a.account_name ?? a.name ?? "(unnamed)";
}

function sumMatching(accounts: TBAccount[], patterns: RegExp[]): { total: number; names: string[] } {
  // MASTER BUG FIX (2026-07-07): process-trial-balance v2+ writes account_name,
  // not name. Prior code used a.name which was always undefined → all pattern
  // matches returned zero. Use accountLabel() to support both field names.
  const matched = accounts.filter(a => matchesAny(accountLabel(a), patterns));
  return {
    total: matched.reduce((s, a) => s + Math.abs(a.balance), 0),
    names: matched.map(accountLabel),
  };
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
    // process-trial-balance does NOT write profit_before_tax as a scalar —
    // it only writes per-section {accounts, total} objects.  Derive PBT from
    // IS section totals so the waterfall is never force-set to zero.
    //
    // Formula (IFRS/IAS 1): PBT = Revenue − COGS − Opex + OtherIncome − FinanceCosts
    // Note: section totals are POSITIVE for their natural sign:
    //   revenue.total     → positive (credit-normal, credit − debit)
    //   cost_of_goods_sold→ positive net COGS (debit-normal components sum)
    //   operating_expenses→ positive (debit-normal)
    //   other_income.total→ positive (credit-normal)
    //   finance_costs.total→ positive (debit-normal)
    const turnover      = Math.abs(is.revenue?.total ?? 0);
    const cogsDerived   = Math.abs(is.cost_of_goods_sold?.total  ?? 0);
    const opexDerived   = Math.abs(is.operating_expenses?.total  ?? 0);
    const otherIncDeriv = Math.abs(is.other_income?.total        ?? 0);
    const finCostDeriv  = Math.abs(is.finance_costs?.total       ?? 0);

    // Prefer the scalar if it was written (future-proofing); fall back to derived.
    const derivedPBT    = turnover - cogsDerived - opexDerived + otherIncDeriv - finCostDeriv;
    const accountingPBT: number = (is.profit_before_tax != null)
      ? (is.profit_before_tax as number)
      : derivedPBT;

    if (turnover === 0) warnings.push("⚠ Revenue is zero — verify income statement is populated.");
    if (accountingPBT === 0 && turnover > 0) {
      // PBT = 0 with real revenue means either a breakeven company or a classification
      // gap. Set review_required so the green "adequate" banner cannot fire.
      warnings.push("⚠ Profit before tax is zero with non-zero revenue — verify income statement completeness. Tax computation is provisional.");
      classificationWarnings.push({
        category:        "Profit Before Tax",
        message:         `Profit before tax is TZS 0 but revenue is TZS ${turnover.toLocaleString()}. ` +
                         `This may mean income statement accounts are incomplete or misclassified. ` +
                         `The ITA waterfall uses PBT = TZS 0 — taxable income and CIT are provisional.`,
        accounts_found:  [],
        action_required: "Review the income statement section in Account Review. Ensure all revenue, COGS, and expense accounts are correctly classified before committing this computation.",
      });
    }

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

    // ── STEP 7: Income tax provision — read from BOTH balance sheet AND P&L ─
    //
    // Read-TB-first principle: the provision may be booked in one of two places:
    //   (a) Current liabilities — "Corporate Tax Payable" (balance sheet approach)
    //   (b) Income statement taxes section — "Corporate Tax Provision" (P&L approach)
    //
    // Prior version only searched (a), missing companies that book the provision
    // as a P&L tax charge (e.g. Kamanga account 7000 "Corporate Tax Provision"
    // classified under income_statement.taxes). Both are valid IFRS treatments.
    //
    // Use the larger of the two as the provision (they should not double-count;
    // the same amount would only appear in one section).
    const taxesAccs = is.taxes?.accounts ?? [];
    const { total: itProvisionBS, names: provBSNames } = sumMatching([...bsCL, ...bsNCL], INCOME_TAX_PROVISION_PATTERNS);
    const { total: itProvisionIS, names: provISNames } = sumMatching(taxesAccs, INCOME_TAX_PROVISION_PATTERNS);
    const itProvision = itProvisionBS + itProvisionIS; // sum if provision in both sections
    const provisionSources = [...provBSNames, ...provISNames];
    if (itProvision === 0) {
      classificationWarnings.push({
        category: "Income Tax Provision",
        message: "No income tax provision detected in current or non-current liabilities, or in the taxes section of the income statement.",
        accounts_found: [],
        action_required: "Check if the account is named something non-standard (e.g. 'Malipo ya Kodi', 'Tax Accrual', 'Corporate Tax Provision'). The engine searched both balance sheet liabilities and income statement taxes. If genuinely zero, the full CIT is a gap.",
      });
    } else if (itProvisionIS > 0 && itProvisionBS === 0) {
      warnings.push(
        `ℹ Income tax provision TZS ${itProvisionIS.toLocaleString()} found in income statement (taxes section: ${provISNames.join(", ")}). ` +
        `This is the CURRENT YEAR tax charge. If also recording a balance sheet payable separately, ensure no double-count.`
      );
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
      ? `⚠ Company shows a tax loss this period (taxable income: TZS ${taxableIncome.toLocaleString()}). If losses persist for current + 2 preceding years, AMT applies: 1% × turnover = TZS ${amtIndicative.toLocaleString()} (ITA First Schedule para 3(3); rate UNCHANGED by Finance Act 2026). CPA must verify 3-year consecutive loss history. Exempt sectors: agriculture, health, education, tea processing.`
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

    // ── STEP 11b: Income statement breakdown (for transparent waterfall) ─────
    // Uses the same derived values computed in STEP 2 (cogsDerived, opexDerived,
    // otherIncDeriv, finCostDeriv) so the breakdown matches the PBT figure.
    const taxesTzs = Math.abs(is.taxes?.total ?? 0);

    const result = {
      engine_version:                   ENGINE_VERSION,
      company_id:                       companyId,
      upload_id:                        uploadId,
      period_year:                      periodYear,
      dry_run,

      // ── Accounting P&L breakdown (TB-sourced, transparent waterfall) ──
      income_statement_breakdown: {
        revenue_tzs:            turnover,
        cost_of_goods_sold_tzs: cogsDerived,
        gross_profit_tzs:       turnover - cogsDerived,
        operating_expenses_tzs: opexDerived,
        other_income_tzs:       otherIncDeriv,
        finance_costs_tzs:      finCostDeriv,
        taxes_tzs:              taxesTzs,
        profit_before_tax_tzs:  accountingPBT,  // derived from IS totals, not forced zero
      },

      // ── ITA Waterfall ─────────────────────────────────────────────────
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
      verified_source:                  "ITA Cap.332 R.E.2023 + Finance Act 2026 (No. 3, effective 1 Jul 2026) + PwC Tanzania (Jan 2026) + Deloitte Tanzania Thin Cap (Aug 2025)",

      // ── FINANCE ACT 2026 AWARENESS BLOCK ────────────────────
      // These provisions are effective 1 July 2026. The CIT waterfall above
      // is unchanged (CIT rate 30%, wear & tear, thin cap all unchanged).
      // Items below require SEPARATE action by the CPA / payroll team.
      fa2026_provisions: {
        deemed_retained_earnings: {
          ita_section: "s.33A (amended FA2026 s.23)",
          note: "Deemed-distribution fraction reduced from 30% to 15%. WHT on deemed amount (10%) is unchanged. EXCLUDED: DSE-listed companies, financial institutions (BAFIA), insurance companies, mining cos with Framework Agreement.",
          rate: FA2026_DEEMED_DISTRIBUTION_RATE,
        },
        nonresident_digital_service_tax: {
          ita_section: "s.116(1) (amended FA2026 s.26)",
          note: "WHT rate on payments to non-resident digital service providers increased 2% → 3%, effective 1 July 2026. Review any platform/SaaS payments made from 1 Jul 2026.",
          rate: FA2026_NONRESIDENT_DIGITAL_WHT,
        },
        transfer_pricing_penalty: {
          taa_section: "s.90(2)(c) (amended FA2026 s.82)",
          note: "TP penalty basis changed: was 100% of tax shortfall; now 30% of TP adjustment amount. This reduces potential TP penalty exposure materially.",
          rate: FA2026_TP_PENALTY_RATE,
        },
        presumptive_tax: {
          ita_section: "First Schedule Item 2 (amended FA2026 s.31)",
          note: "Presumptive tax ceiling raised 100M → 200M TZS. Top band rate raised 3.5% → 4.5% for turnover 11,000,001–200,000,000 TZS.",
          threshold_tzs: FA2026_PRESUMPTIVE_THRESHOLD,
          top_band_rate: FA2026_PRESUMPTIVE_TOP_RATE,
        },
        wht_crops_livestock_fisheries: {
          ita_section: "new s.109A (FA2026 s.25)",
          note: "Resident corporations must now withhold 1% on payments for crops, livestock products (live animals, unprocessed milk), and fishery products (unprocessed fish, fish maws). First Schedule para 4(d).",
          rate: FA2026_WHT_CROPS_LIVESTOCK_FISHERIES,
        },
        single_instalment_food_crops: {
          ita_section: "new s.116B (FA2026 s.28)",
          note: "1% single instalment on food crop purchases (farm gate / purchase price, whichever higher). Excludes: sesame, sugarcane, tobacco, tea, cashew, coffee, cotton, pyrethrum, sisal; and purchases < 1 tonne.",
          rate: FA2026_SINGLE_INSTALMENT_FOOD_CROPS,
        },
        forest_produce_instalment: {
          ita_section: "s.116A (amended FA2026 s.27)",
          note: "Rate unchanged at 2%. Scope expanded: 'forest produce' now includes natural varnish, latex, resin, sap, gums in addition to timber, logs, mirunda, poles.",
          rate: FA2026_FOREST_PRODUCE_INSTALMENT_RATE,
        },
        sdl_rate: {
          vet_section: "VET Act Cap.82 s.19 (amended FA2026 s.102)",
          note: "SDL rate UNCHANGED at 4.5%. Amendment only clarifies Government institution exemption wording ('through Government subvention'). No change to corporate SDL obligations.",
          rate: 0.045,
        },
      },
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
        finding_typ