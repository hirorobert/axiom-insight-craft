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

// D10-FIX: Management and professional fees to related parties (ITA s.33)
// Cap: 1% of gross income for management fees to foreign related parties.
// Engine detects, computes cap, adds excess as flagged add-back.
const MGMT_FEE_PATTERNS = [
  /management\s+fee/i, /management\s+charge/i, /\bmanagement\s+service/i,
  /\bhead\s*office\s*(fee|charge|levy|allocation)/i,
  /\bgroup\s*(service|support|management)\s*(fee|charge)/i,
  /\bparent\s+company\s+(fee|charge|allocation)/i,
  /technical\s+service\s+fee/i, /\bfranchise\s+fee\b/i,
  /royalt(y|ies)/i,
  /\bconsultancy\s+fee\b/i, /\badvisory\s+fee\b/i,
];
// ITA s.33 cap rate: 1% of gross income (verified ITA Cap.332 R.E.2023)
// Note: A 2% figure circulates in some summaries but the Act specifies 1%.
// Engine applies 1%; CPA must confirm current TRA interpretation.
const MGMT_FEE_CAP_RATE = 0.01;

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
    // ── Authentication: require valid JWT ─────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const authToken = authHeader.replace("Bearer ", "");
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: claims, error: claimsErr } = await authClient.auth.getClaims(authToken);
    const callerId = claims?.claims?.sub as string | undefined;
    if (claimsErr || !callerId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const {
      uploadId, companyId, periodYear, dry_run = true,
      months_overdue = 0, userId = null,
      periodEndMonth = 12,   // D7-FIX: fiscal year-end month (1-12). Pass from Dashboard.
    } = await req.json();
    if (!uploadId || !companyId || !periodYear) {
      return new Response(JSON.stringify({ error: "uploadId, companyId, periodYear required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Authorization: caller must be a firm_member of companyId ──────
    {
      const { data: member } = await supabase
        .from("firm_members")
        .select("id")
        .eq("user_id", callerId)
        .eq("company_id", companyId)
        .not("accepted_at", "is", null)
        .limit(1)
        .maybeSingle();
      if (!member) {
        return new Response(
          JSON.stringify({ error: "Forbidden", message: "Not a member of this company" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

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

    // ── BS SECTION TOTALS (for SCF + SOCIE) ──────────────────────────────
    // Extracted here — before STEP 3 — so they're available to SCF/SOCIE engines.
    const closingCA_total    = Math.abs(bs.current_assets?.total          ?? 0);
    const closingNCA_total   = Math.abs(bs.non_current_assets?.total      ?? 0);
    const closingCL_total    = Math.abs(bs.current_liabilities?.total     ?? 0);
    const closingNCL_total   = Math.abs(bs.non_current_liabilities?.total  ?? 0);
    const closingEquity_total= Math.abs(bs.equity?.total                  ?? 0);

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

    // ── CASH + EQUITY COMPONENT DETECTION (for SCF + SOCIE) ──────────────
    const CASH_PATTERNS_SCF = [
      /\bcash\s*(and\s*(bank|equivalent|cash))?/i, /cash\s+at\s+(bank|hand)/i,
      /\bbank\b/i, /\bbenki\b/i, /\bnakdi\b/i, /petty\s+cash/i,
    ];
    const SHARE_CAPITAL_PATS = [
      /share\s+capital/i, /paid.{0,4}up\s+capital/i, /ordinary\s+share/i, /hisa\s+la\s+mtaji/i,
    ];
    const RETAINED_EARNINGS_PATS = [
      /retained\s+earn/i, /accumulated\s+(profit|surplus|deficit)/i, /faida\s+iliyobakiwa/i,
    ];
    const { total: cashBalance }        = sumMatching(bs.current_assets?.accounts ?? [], CASH_PATTERNS_SCF);
    const { total: bsShareCapital }     = sumMatching(bsEq, SHARE_CAPITAL_PATS);
    const { total: bsRetainedEarnings } = sumMatching(bsEq, RETAINED_EARNINGS_PATS);
    const bsOtherReserves               = Math.max(0, closingEquity_total - bsShareCapital - bsRetainedEarnings);

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

    // ── STEP 4f: Management & professional fees cap (ITA s.33) ── D10-FIX ─
    // ITA s.33: fees paid to foreign related parties for management, technical,
    // professional or consultancy services are deductible only up to 1% of gross income.
    // Cap = 1% of turnover (verified ITA Cap.332 R.E.2023).
    // Engine auto-adds the excess as a requires_review add-back.
    const { total: mgmtFeeTotal, names: mgmtFeeNames } = sumMatching(allISAccs, MGMT_FEE_PATTERNS);
    if (mgmtFeeTotal > 0) {
      const mgmtFeeCap = Math.round(turnover * MGMT_FEE_CAP_RATE);  // 1% of gross income
      if (mgmtFeeTotal > mgmtFeeCap) {
        const mgmtFeeExcess = mgmtFeeTotal - mgmtFeeCap;
        addBacks.push({
          description: `Management/professional fee disallowance: ITA s.33 cap = 1% × TZS ${turnover.toLocaleString()} = TZS ${mgmtFeeCap.toLocaleString()}. ` +
                       `Detected fees TZS ${mgmtFeeTotal.toLocaleString()} exceed cap by TZS ${mgmtFeeExcess.toLocaleString()}. ` +
                       `UPPER-BOUND: applies only to fees paid to FOREIGN related parties. ` +
                       `Fees to Tanzanian entities may be fully deductible — CPA must confirm nature of each payment.`,
          amount_tzs:      mgmtFeeExcess,
          ita_section:     "ITA Cap.332 s.33 (R.E.2023)",
          account_names:   mgmtFeeNames,
          auto_detected:   true,
          requires_review: true,  // CPA must confirm foreign vs domestic recipient
        });
      } else {
        // Under cap — still disclose for CPA awareness
        classificationWarnings.push({
          category: "Management Fees (ITA s.33)",
          message: `Management/professional fee accounts TZS ${mgmtFeeTotal.toLocaleString()} detected. ` +
                   `ITA s.33 cap = 1% × gross income TZS ${turnover.toLocaleString()} = TZS ${mgmtFeeCap.toLocaleString()}. ` +
                   `Detected amount is WITHIN the cap — no add-back required IF paid to a foreign related party. ` +
                   `If paid to a domestic entity, full amount is deductible and no cap applies.`,
          accounts_found:  mgmtFeeNames,
          action_required: "Confirm whether payee is a foreign related party. If domestic, disregard cap entirely.",
        });
      }
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
      .select("ita_class, asset_description, ita_wdv_opening_tzs, additions_tzs, disposals_at_tax_cost_tzs, disposal_proceeds_tzs, cost_tzs")
      .eq("company_id", companyId).eq("period_year", periodYear);
      // D2-FIX: disposal_proceeds_tzs = actual cash received (IFRS SCF investing).
      // Falls back to disposals_at_tax_cost_tzs with warning if CPA has not provided it.

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
    }

    // ── PPE ADDITIONS + DISPOSALS + WDV CLOSING (SCF Investing + period_closing_balances) ─
    // D2-FIX: disposal_proceeds_tzs (IFRS cash received) is now separate from
    // disposals_at_tax_cost_tzs (ITA tax WDV used in wear & tear computation).
    let ppeAdditionsTzs = 0;
    let ppeDisposalsTzs = 0;       // SCF: IFRS cash received on disposal
    let ppeDisposalsMissingProceeds = false;
    const wdvClosingByClass: Record<number, number> = {};
    if (wtRows && wtRows.length > 0) {
      for (const row of wtRows) {
        ppeAdditionsTzs  += row.additions_tzs ?? 0;
        // D2-FIX: prefer IFRS cash proceeds; fallback to tax cost with flag
        if (row.disposals_at_tax_cost_tzs > 0) {
          if (row.disposal_proceeds_tzs != null) {
            ppeDisposalsTzs += row.disposal_proceeds_tzs;
          } else {
            ppeDisposalsTzs += row.disposals_at_tax_cost_tzs; // fallback — imprecise
            ppeDisposalsMissingProceeds = true;
          }
        }
        const clsI = ITA_ASSET_CLASSES[row.ita_class];
        if (!clsI) continue;
        const poolI = (row.ita_wdv_opening_tzs ?? 0) + (row.additions_tzs ?? 0)
                    - (row.disposals_at_tax_cost_tzs ?? 0);
        let wtSingle = 0;
        if (clsI.method === "straight_line")  wtSingle = Math.round((row.cost_tzs ?? 0) * clsI.rate);
        else if (clsI.method === "immediate") wtSingle = Math.round(poolI);
        else                                  wtSingle = Math.round(Math.max(0, poolI) * clsI.rate);
        wdvClosingByClass[row.ita_class] =
          (wdvClosingByClass[row.ita_class] ?? 0) + Math.max(0, poolI - wtSingle);
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

    // ── STEP 11c: Module D — Deferred Tax (IAS 12 / IFRS for SMEs s.29) ────────
    //
    // PRIMARY SOURCES:
    //   IFRS for SMEs (2015 edition / 2019 update) Section 29 — Income Tax
    //   ITA Cap.332 R.E.2023 s.19(2) — 70% annual loss shelter cap (LOSS_CARRYFORWARD_SHELTER)
    //   IAS 12 Income Taxes (for reference; IFRS for SMEs s.29 is the applied standard)
    //
    // TWO CATEGORIES OF TEMPORARY DIFFERENCES:
    //
    //   CATEGORY A — TIMING: Wear & Tear vs Accounting Depreciation
    //     The tax base of PPE ≠ its carrying amount wherever ITA accelerated rates differ from
    //     IFRS useful-life depreciation.  Per IAS 12 / IFRS for SMEs s.29.15, this creates a
    //     taxable temporary difference → DTL (accelerated) or deductible difference → DTA (decelerated).
    //     Source: totalWearTear (STEP 6) minus deprTotal (STEP 4a accounting add-back).
    //
    //   CATEGORY B — LOSS CARRY-FORWARD DTA
    //     Unrelieved tax losses (ITA s.19; no time limit) create a potential DTA.
    //     RECOGNITION CONSTRAINT (IFRS for SMEs s.29.9):
    //       Recognize DTA ONLY when probable future taxable income will absorb it.
    //
    //     S.19(2) INTERACTION — THE KEY NUANCE:
    //       The 70% annual shelter cap throttles absorption speed, extending the recovery period.
    //       A loss of TZS 181M with future profits of TZS 100M/yr is absorbed at:
    //         100M × 70% = 70M/yr → recovery in ~2.6 years (WITHIN foreseeable horizon → full DTA).
    //       But if future profits are only TZS 30M/yr:
    //         30M × 70% = 21M/yr → recovery in ~8.6 years (exceeds horizon → DTA NOT recognizable).
    //       The shelter cap thus DIRECTLY determines whether the DTA can be booked.
    //
    //     ENGINE APPROACH:
    //       Uses turnover × 5% as a conservative future profit proxy (CPA MUST override).
    //       Recognition thresholds (IFRS for SMEs conservative interpretation):
    //         ≤ 3 years  → FULL recognition
    //         3–5 years  → PARTIAL (70% of potential — CPA must assess)
    //         > 5 years  → NOT recognized; disclose in notes
    //
    // OPENING BALANCE (OD-14 open):
    //   Full deferred tax movement = closing DTL − opening DTL (or DTA).
    //   Without a deferred_tax_schedules table, movement is approximated as the closing position.
    //   This is acceptable for first-year Kinga tracking; CPA must provide prior-year schedule.
    //
    // ── Category A: Timing differences ───────────────────────────────────────
    // deprTotal  = accounting depreciation (from IS add-back detection, STEP 4a)
    // totalWearTear = ITA wear & tear from capital_allowances table (STEP 6)
    // Both are positive scalars representing absolute deduction amounts.
    const timingDiff       = totalWearTear - deprTotal;
    // +ve → W&T > depreciation → accelerated tax deduction → future taxable amount → DTL
    // -ve → W&T < depreciation → decelerated tax deduction → future deductible amount → DTA
    // zero → no difference (may mean no capital allowances entered — already warned in STEP 6)

    const dtlTiming = Math.round(Math.max(0,  timingDiff) * CIT_RATE);
    const dtaTiming = Math.round(Math.max(0, -timingDiff) * CIT_RATE);

    // ── Category B: Loss carry-forward DTA (s.19(2) throttled) ─────────────
    // D3-FIX: use TOTAL remaining loss pool (accumulated + current), not just this year.
    // totalLossPool is computed above in the D3-FIX block.
    const currentYearLoss  = totalLossPool;    // full unrelieved pool for DTA
    const dtaPotentialLoss = Math.round(currentYearLoss * CIT_RATE);

    let dtaLossRecognized  = 0;
    let dtaLossRecoveryYrs: number | null = null;
    let dtaLossNote        = "";
    type DtaStatus = "full" | "partial" | "not_recognized" | "nil";
    let dtaLossStatus: DtaStatus = "nil";

    if (dtaPotentialLoss > 0) {
      if (turnover > 0) {
        // Conservative proxy: 5% net margin on current-year turnover.
        // CPA MUST replace with management's forward profit forecast before publishing.
        const estimatedFutureAnnualProfit = turnover * 0.05;
        // ITA s.19(2): max 70% of pre-deduction income absorbed per year
        const annualAbsorption = estimatedFutureAnnualProfit * LOSS_CARRYFORWARD_SHELTER;
        dtaLossRecoveryYrs = annualAbsorption > 0
          ? Math.ceil((currentYearLoss / annualAbsorption) * 10) / 10
          : null; // null = indefinite

        const recoveryLabel = dtaLossRecoveryYrs === null
          ? "indefinite"
          : `~${dtaLossRecoveryYrs.toFixed(1)} years`;

        if (dtaLossRecoveryYrs !== null && dtaLossRecoveryYrs <= 3) {
          dtaLossRecognized = dtaPotentialLoss;
          dtaLossStatus     = "full";
          dtaLossNote =
            `Loss DTA FULLY RECOGNIZED: TZS ${dtaPotentialLoss.toLocaleString()}. ` +
            `Estimated recovery ${recoveryLabel} at 5% margin proxy × 70% annual shelter (ITA s.19(2)). ` +
            `CPA must confirm with management profit forecast before recognizing in financial statements.`;

        } else if (dtaLossRecoveryYrs !== null && dtaLossRecoveryYrs <= 5) {
          dtaLossRecognized = Math.round(dtaPotentialLoss * 0.70);
          dtaLossStatus     = "partial";
          const unrecognized = dtaPotentialLoss - dtaLossRecognized;
          dtaLossNote =
            `Loss DTA PARTIALLY RECOGNIZED: TZS ${dtaLossRecognized.toLocaleString()} of ` +
            `potential TZS ${dtaPotentialLoss.toLocaleString()} (30% haircut applied). ` +
            `Estimated recovery ${recoveryLabel} at 70% annual shelter cap (ITA s.19(2)) — ` +
            `IFRS for SMEs s.29.9 probable-recovery threshold is borderline. ` +
            `Unrecognized DTA TZS ${unrecognized.toLocaleString()} must be disclosed in financial statement notes.`;
          classificationWarnings.push({
            category: "Deferred Tax Asset — Loss Carry-Forward (Partial Recognition)",
            message:  dtaLossNote,
            accounts_found:  [],
            action_required:
              "Obtain management profit forecast for next 3–5 years. " +
              "If forecast supports full recovery within 3 years → recognize full TZS " + dtaPotentialLoss.toLocaleString() + ". " +
              "If recovery extends beyond 5 years → derecognize entirely. " +
              "Disclose TZS " + unrecognized.toLocaleString() + " unrecognized DTA in notes per IFRS for SMEs s.29.9.",
          });

        } else {
          dtaLossRecognized = 0;
          dtaLossStatus     = "not_recognized";
          dtaLossNote =
            `Loss DTA NOT RECOGNIZED (TZS ${dtaPotentialLoss.toLocaleString()} derecognized). ` +
            `Estimated recovery ${recoveryLabel} — exceeds 5-year foreseeable horizon at ` +
            `5% margin proxy + 70% annual shelter cap (ITA s.19(2)). ` +
            `Per IFRS for SMEs s.29.9: probable recovery threshold NOT met at this proxy rate. ` +
            `Full TZS ${dtaPotentialLoss.toLocaleString()} to be disclosed as unrecognized DTA in notes. ` +
            `If management provides a credible recovery forecast reducing horizon to ≤ 5 years, re-assess.`;
          classificationWarnings.push({
            category: "Deferred Tax Asset — Loss Carry-Forward (Not Recognized)",
            message:  dtaLossNote,
            accounts_found:  [],
            action_required:
              "Disclose unrecognized DTA of TZS " + dtaPotentialLoss.toLocaleString() +
              " in notes. Provide management profit forecast. If recovery horizon ≤ 5 years, " +
              "adjust recognition and re-run engine.",
          });
        }
      } else {
        // Zero turnover: future profits not demonstrably probable
        dtaLossStatus    = "not_recognized";
        dtaLossNote =
          `Loss DTA NOT RECOGNIZED — zero revenue this period; ` +
          `future taxable income not demonstrably probable (IFRS for SMEs s.29.9). ` +
          `Potential TZS ${dtaPotentialLoss.toLocaleString()} to be disclosed as unrecognized DTA.`;
        classificationWarnings.push({
          category: "Deferred Tax Asset — Loss Carry-Forward (Zero Revenue)",
          message:  dtaLossNote,
          accounts_found:  [],
          action_required:
            "Entity has zero revenue — loss DTA cannot be recognized without evidence of " +
            "future profitable operations. Disclose unrecognized DTA in financial statement notes.",
        });
      }
    }

    // ── Net Deferred Tax Position (year-end closing) ─────────────────────────
    const netDTL = dtlTiming;
    const netDTA = dtaTiming + dtaLossRecognized;
    // +ve = net liability position (DTL > DTA) → SFP non-current liabilities
    // -ve = net asset position  (DTA > DTL) → SFP non-current assets
    const netDeferredTaxPosition = netDTL - netDTA;

    // ── Deferred Tax Movement on SCI ─────────────────────────────────────────
    // True movement = closing position − opening position.
    // OD-14: no deferred_tax_schedules table yet → movement approximated as closing position.
    // This is conservative and explicitly disclosed. CPA must adjust using prior-year schedule.
    const deferredTaxMovement = netDeferredTaxPosition;
    // +ve → deferred tax CHARGE on SCI (increases tax expense)
    // -ve → deferred tax CREDIT on SCI (reduces tax expense)

    // ── Total Tax Expense (SCI) and PAT ─────────────────────────────────────
    // IFRS for SMEs s.29.1: total income tax = current tax + deferred tax movement.
    // taxPayable is the current-period CIT (from STEP 9).
    const totalTaxExpense     = taxPayable + deferredTaxMovement;
    const profitAfterFullTax  = accountingPBT - totalTaxExpense;

    // ── Module D disclosure object ────────────────────────────────────────────
    const moduleDDeferred = {
      // Category A — timing
      timing_diff_tzs:               timingDiff,
      wear_tear_tzs:                 totalWearTear,
      accounting_depreciation_tzs:   deprTotal,
      dtl_timing_tzs:                dtlTiming,
      dta_timing_tzs:                dtaTiming,
      // Category B — loss carry-forward
      current_year_loss_tzs:         currentYearLoss,
      dta_potential_loss_tzs:        dtaPotentialLoss,
      dta_loss_recognized_tzs:       dtaLossRecognized,
      dta_loss_status:               dtaLossStatus,
      dta_loss_recovery_years:       dtaLossRecoveryYrs,
      dta_loss_note:                 dtaLossNote,
      s19_shelter_rate:              LOSS_CARRYFORWARD_SHELTER,   // 70% — ITA s.19(2)
      // Net position
      net_dtl_tzs:                   netDTL,
      net_dta_tzs:                   netDTA,
      net_deferred_tax_position_tzs: netDeferredTaxPosition,      // +ve=net DTL, -ve=net DTA
      // SCI total tax charge
      deferred_tax_movement_tzs:     deferredTaxMovement,         // approximate (OD-14 open)
      total_tax_expense_tzs:         totalTaxExpense,
      profit_after_full_tax_tzs:     profitAfterFullTax,
      // Compliance & disclosure
      opening_balance_required:      true,
      ifrs_section:                  "IFRS for SMEs s.29 (Income Tax)",
      ita_loss_section:              "ITA Cap.332 R.E.2023 s.19(2) — 70% annual shelter cap",
      note:
        "Deferred tax movement is approximated as closing position because no prior-year " +
        "deferred tax schedule (opening DTL/DTA) is loaded (OD-14 open). " +
        "CPA must verify opening balance before using movement in published SCI. " +
        "Timing DTL/DTA is computed from ITA wear & tear vs TB depreciation. " +
        "Loss DTA uses a 5% net margin proxy — replace with management forecast.",
    };

    // ── STEP 0b: Load opening balances + prior years + management inputs ─────
    // D3-FIX: also load cumulative_unrelieved_loss_tzs from opening balance for DTA pool.
    // D8-FIX: also query period_year-2 to enable AMT 3-year consecutive-loss detection.
    // D4-FIX: also query management_inputs for dividends/share capital/financing items.

    const [openingBalResult, twoYearsAgoResult, mgmtInputResult] = await Promise.all([
      supabase
        .from("period_closing_balances")
        .select("*")
        .eq("company_id", companyId)
        .eq("period_year", periodYear - 1)
        .eq("period_month", periodEndMonth)   // D7-FIX: match correct year-end month
        .maybeSingle(),
      supabase
        .from("period_closing_balances")
        .select("taxable_income_tzs, period_year")
        .eq("company_id", companyId)
        .eq("period_year", periodYear - 2)
        .eq("period_month", periodEndMonth)   // D7-FIX
        .maybeSingle(),
      supabase
        .from("management_inputs")
        .select("*")
        .eq("company_id", companyId)
        .eq("upload_id", uploadId)
        .maybeSingle(),
    ]);

    const openingBal           = openingBalResult.data ?? null;
    const openingDataAvailable = openingBal !== null;
    const priorPriorYearBal    = twoYearsAgoResult.data ?? null;
    const mgmtInputs           = mgmtInputResult.data ?? null;

    // D4-FIX: extract management inputs (CPA-provided) or default to zero
    const mgmtDividendsDeclared   = mgmtInputs?.dividends_declared_tzs   ?? 0;
    const mgmtShareCapIssued      = mgmtInputs?.share_capital_issued_tzs  ?? 0;
    const mgmtOtherEquityMoves    = mgmtInputs?.other_equity_movements_tzs ?? 0;
    const mgmtLoanRepayments      = mgmtInputs?.loan_repayments_tzs       ?? 0;
    const mgmtNewBorrowings       = mgmtInputs?.new_borrowings_tzs        ?? 0;
    const mgmtInputsProvided      = mgmtInputs !== null;

    // ── D3-FIX: Cumulative Loss Pool — correctly maintained across years ─────
    // Prior version: pool only ever grew (never reduced on profit years) — WRONG.
    // Fix: on profit years, pool decreases by (taxableIncome × 70% shelter cap).
    //      DTA computation uses TOTAL remaining pool, not just current year loss.
    const openingCumulativeLoss = openingBal?.cumulative_unrelieved_loss_tzs ?? 0;
    const currentYearNewLoss    = Math.max(0, -taxableIncome);
    const currentYearProfit     = Math.max(0, taxableIncome);

    // When company is profitable, prior losses are absorbed up to 70% annual cap
    const lossAbsorbedThisYear  = Math.min(
      openingCumulativeLoss,
      currentYearProfit * LOSS_CARRYFORWARD_SHELTER
    );
    // Total unrelieved loss pool available for DTA recognition this year
    const totalLossPool         = Math.max(0, openingCumulativeLoss - lossAbsorbedThisYear + currentYearNewLoss);
    // Closing pool saved to period_closing_balances (replaces old running-total)
    const closingLossPool       = totalLossPool;

    // ── D8-FIX: AMT 3-year consecutive-loss detection ─────────────────────
    // AMT (ITA First Schedule para 3(3)): 1% of turnover applies when the entity
    // has unrelieved tax losses in the current AND preceding 2 years.
    // Now possible because period_closing_balances stores taxable_income_tzs.
    const priorYearTaxableIncome     = openingBal?.taxable_income_tzs ?? null;
    const priorPriorYearTaxableIncome = priorPriorYearBal?.taxable_income_tzs ?? null;
    const amtThreeYearLosses =
      taxableIncome < 0 &&
      priorYearTaxableIncome !== null && priorYearTaxableIncome < 0 &&
      priorPriorYearTaxableIncome !== null && priorPriorYearTaxableIncome < 0;
    const amtApplicable = amtThreeYearLosses;
    const amtComputed   = Math.round(turnover * AMT_RATE);  // 1% of turnover
    if (amtApplicable) {
      warnings.push(
        `⚠ AMT APPLIES: Company has recorded tax losses for 3 consecutive years ` +
        `(FY${periodYear}: TZS ${taxableIncome.toLocaleString()}, ` +
        `FY${periodYear - 1}: TZS ${priorYearTaxableIncome!.toLocaleString()}, ` +
        `FY${periodYear - 2}: TZS ${priorPriorYearTaxableIncome!.toLocaleString()}). ` +
        `ITA First Schedule para 3(3): Minimum Tax = 1% × turnover = TZS ${amtComputed.toLocaleString()}. ` +
        `AMT exempt: agriculture, health, education, tea processing. ` +
        `CPA must confirm sector exemption before applying.`
      );
    } else if (taxableIncome < 0 && (priorYearTaxableIncome === null || priorPriorYearTaxableIncome === null)) {
      warnings.push(
        `⚠ AMT RISK: Tax loss this period. Prior 2-year history not yet available in period_closing_balances. ` +
        `AMT check requires 3 years of data. Run engine for FY${periodYear - 1} and FY${periodYear - 2} first to enable auto-detection.`
      );
    }

    // ── TRUE Deferred Tax Movement (OD-14 RESOLVED when opening data available) ─
    const openingNetDTPosition   = openingBal?.net_deferred_tax_position_tzs ?? 0;
    const trueDeferredTaxMovement = netDeferredTaxPosition - openingNetDTPosition;
    // If first year (no opening data): approximate movement as closing (as before)
    const finalDeferredTaxMovement = openingDataAvailable ? trueDeferredTaxMovement : deferredTaxMovement;
    const finalTotalTaxExpense     = taxPayable + finalDeferredTaxMovement;
    const finalProfitAfterFullTax  = accountingPBT - finalTotalTaxExpense;

    // Upgrade moduleDDeferred with precise movement if opening data available
    if (openingDataAvailable) {
      moduleDDeferred.deferred_tax_movement_tzs  = trueDeferredTaxMovement;
      moduleDDeferred.total_tax_expense_tzs      = finalTotalTaxExpense;
      moduleDDeferred.profit_after_full_tax_tzs  = finalProfitAfterFullTax;
      moduleDDeferred.opening_balance_required   = false;
      moduleDDeferred.note =
        `Opening DTL/DTA loaded from period_closing_balances FY${periodYear - 1}. ` +
        `True deferred tax movement = closing TZS ${netDeferredTaxPosition.toLocaleString()} ` +
        `− opening TZS ${openingNetDTPosition.toLocaleString()} ` +
        `= TZS ${trueDeferredTaxMovement.toLocaleString()}. OD-14 resolved.`;
    }

    // ── STEP 11d: Statement of Cash Flows (Indirect Method) ──────────────────
    // IFRS for SMEs Section 7 — mandatory primary statement.
    // Source: PwC Tanzania "Statement of Cash Flows under IFRS for SMEs" guidance.
    //
    // INDIRECT METHOD LAYOUT:
    //   PBT
    //   + Depreciation & amortisation (non-cash add-back)
    //   + Finance costs (reclassified; paid separately below)
    //   − Δ current assets excl. cash (increase = use of cash)
    //   + Δ current liabilities (increase = source of cash)
    //   = Cash generated from operations
    //   − Finance costs paid
    //   − Income taxes paid
    //   = Net cash from operating activities
    //
    //   − PPE additions (capex outflow)
    //   + PPE disposal proceeds (inflow)
    //   = Net cash from investing activities
    //
    //   + Δ long-term debt (financing inflow)
    //   − Dividends paid (management input; 0 by default)
    //   = Net cash from financing activities
    //
    //   + Opening cash → = Closing cash (reconcile to SFP)

    // Operating
    const openingNonCashCA  = openingDataAvailable
      ? Math.max(0, (openingBal!.current_assets_tzs ?? 0) - (openingBal!.cash_balance_tzs ?? 0))
      : (closingCA_total - cashBalance);              // first year: assume no Δ
    const closingNonCashCA  = Math.max(0, closingCA_total - cashBalance);
    const deltaWorkCapAssets = closingNonCashCA - openingNonCashCA;   // +ve = more tied up in WC

    const openingCL_scf     = openingDataAvailable
      ? (openingBal!.current_liabilities_tzs ?? 0)
      : closingCL_total;                              // first year: assume no Δ
    const deltaCL           = closingCL_total - openingCL_scf;        // +ve = payables grew

    const cashGeneratedFromOps = accountingPBT + deprTotal + finCostDeriv
                               - deltaWorkCapAssets + deltaCL;
    const finCostsPaid         = finCostDeriv;        // approximate: all finance costs = paid
    const taxesPaid            = Math.max(0, itProvision); // approximate: provision = cash paid
    const netCashFromOperating = cashGeneratedFromOps - finCostsPaid - taxesPaid;

    // Investing
    const netCashFromInvesting = ppeDisposalsTzs - ppeAdditionsTzs;

    // Financing — D4-FIX: use management inputs for dividends, new borrowings, repayments
    // Prior version: dividends hardcoded to 0, deltaLTD used as proxy for all financing.
    // Fix: use explicit loan movements from mgmtInputs; deltaLTD is now a fallback only.
    const dividendsPaid        = mgmtDividendsDeclared;   // D4-FIX: from management_inputs
    const shareCapRaised       = mgmtShareCapIssued;      // D4-FIX: from management_inputs
    const loanNetMovement = mgmtInputsProvided
      ? (mgmtNewBorrowings - mgmtLoanRepayments)          // D4-FIX: explicit CPA inputs
      : (() => {                                           // Fallback: balance-sheet delta
          const openingLTD_scf = openingDataAvailable
            ? (openingBal!.non_current_liabilities_tzs ?? 0) : closingNCL_total;
          return closingNCL_total - openingLTD_scf;
        })();
    const netCashFromFinancing = loanNetMovement + shareCapRaised - dividendsPaid;

    // Reconciliation
    const netChangeCash         = netCashFromOperating + netCashFromInvesting + netCashFromFinancing;
    const openingCashSCF        = openingDataAvailable ? (openingBal!.cash_balance_tzs ?? 0) : 0;
    const scfDerivedClosingCash = openingCashSCF + netChangeCash;
    // D5-FIX: tolerance tightened from 10% to 1% of cash balance.
    // 10% was a proxy for first-year architecture — never a publishable standard.
    // IFRS for SMEs s.7 requires exact reconciliation. 1% max allows for rounding only.
    const scfTolerance          = Math.max(500_000, Math.abs(cashBalance) * 0.01);
    const scfReconciles         = openingDataAvailable &&
                                  Math.abs(scfDerivedClosingCash - cashBalance) <= scfTolerance;
    // D9: first-year SCF can never reconcile (no opening cash) — explicitly mark as draft.

    const scfEngine = {
      operating_activities: {
        profit_before_tax_tzs:         accountingPBT,
        add_depreciation_amortisation_tzs: deprTotal,
        add_finance_costs_tzs:         finCostDeriv,
        working_capital_changes: {
          delta_current_assets_excl_cash_tzs:  -deltaWorkCapAssets,
          delta_current_liabilities_tzs:        deltaCL,
        },
        cash_generated_from_operations_tzs: cashGeneratedFromOps,
        finance_costs_paid_tzs:         -finCostsPaid,
        income_taxes_paid_tzs:          -taxesPaid,
        net_cash_from_operating_tzs:    netCashFromOperating,
      },
      investing_activities: {
        ppe_additions_tzs:              -ppeAdditionsTzs,
        ppe_disposal_proceeds_tzs:       ppeDisposalsTzs,
        net_cash_from_investing_tzs:    netCashFromInvesting,
      },
      financing_activities: {
        new_borrowings_tzs:             mgmtInputsProvided ? mgmtNewBorrowings : 0,
        loan_repayments_tzs:            mgmtInputsProvided ? -mgmtLoanRepayments : 0,
        net_loan_movement_tzs:          loanNetMovement,
        share_capital_raised_tzs:       shareCapRaised,
        dividends_paid_tzs:            -dividendsPaid,
        net_cash_from_financing_tzs:    netCashFromFinancing,
        management_inputs_provided:     mgmtInputsProvided,
      },
      net_change_in_cash_tzs:           netChangeCash,
      opening_cash_tzs:                 openingCashSCF,
      closing_cash_tzs:                 cashBalance,       // from BS cash detection
      derived_closing_cash_tzs:         Math.round(scfDerivedClosingCash),
      reconciles_to_sfp:                scfReconciles,
      reconciliation_difference_tzs:    Math.round(scfDerivedClosingCash - cashBalance),
      opening_data_available:           openingDataAvailable,
      is_first_year_draft: !openingDataAvailable,   // D9: drives mandatory PDF disclaimer
      note: openingDataAvailable
        ? `Opening cash TZS ${openingCashSCF.toLocaleString()} from period_closing_balances FY${periodYear - 1}. ` +
          (scfReconciles
            ? `SCF reconciles to SFP cash balance within ±1% tolerance (TZS ${scfTolerance.toLocaleString()}).`
            : `SCF does NOT reconcile — difference TZS ${Math.round(Math.abs(scfDerivedClosingCash - cashBalance)).toLocaleString()}. ` +
              `Tolerance (±1%): TZS ${scfTolerance.toLocaleString()}. Review cash classification, dividends, and loan movements.`)
        : "⚠ DRAFT — FIRST YEAR ONLY: No prior-year closing balance. Working capital Δ = nil (overstatement of operating cash). " +
          "Do NOT publish this SCF without CPA adjustment of opening positions. " +
          "This period's closing balance is now saved — next year's SCF will be correct.",
      cpa_note: (ppeDisposalsMissingProceeds
        ? "⚠ IFRS INTEGRITY: One or more assets were disposed of but disposal_proceeds_tzs is not set. " +
          "SCF investing uses ITA tax cost as fallback — may not equal actual cash received. " +
          "Enter actual sale proceeds in Capital Allowances to fix. | "
        : "") +
        (!mgmtInputsProvided && (dividendsPaid > 0 || shareCapRaised > 0)
        ? ""
        : !mgmtInputsProvided
        ? "Management inputs not provided: dividends and share capital changes default to TZS 0. Enter via 'Management Inputs' section if applicable. | "
        : "") +
        "Finance costs paid and taxes paid are approximated from IS figures (timing may differ). " +
        "Finance leases should be presented separately if material.",
      ifrs_section: "IFRS for SMEs Section 7 — Statement of Cash Flows (indirect method)",
    };

    // ── STEP 11e: Statement of Changes in Equity (SOCIE) ─────────────────────
    // IFRS for SMEs Section 6 — required when there are transactions with owners.
    // Proves: Opening Equity + Comprehensive Income + Owner Transactions = Closing Equity.
    // This is the integrity bridge between SCI (PAT) and SFP (closing equity).
    //
    // CPA NOTE: Share capital changes and dividends require management confirmation.
    // The engine uses TZS 0 for undisclosed owner transactions by default.

    const openingShareCap       = openingDataAvailable ? (openingBal!.share_capital_tzs     ?? 0) : bsShareCapital;
    const openingRetEarnings    = openingDataAvailable ? (openingBal!.retained_earnings_tzs  ?? 0) : 0;
    const openingOtherRes       = openingDataAvailable ? (openingBal!.other_reserves_tzs     ?? 0) : bsOtherReserves;
    const openingEquitySOCIE    = openingShareCap + openingRetEarnings + openingOtherRes;

    const sociePatForYear        = finalProfitAfterFullTax;  // SCI PAT incl. deferred tax
    const socieShareCapIssued    = mgmtShareCapIssued;        // D4-FIX: from management_inputs
    const socieDividendsDeclared = mgmtDividendsDeclared;     // D4-FIX: from management_inputs
    const socieOCIMovement       = mgmtOtherEquityMoves;      // D4-FIX: OCI & other

    const closingRetEarnings    = openingRetEarnings + sociePatForYear - socieDividendsDeclared;
    const closingShareCapSOCIE  = openingShareCap + socieShareCapIssued;
    const closingOtherResSOCIE  = openingOtherRes + socieOCIMovement;  // D4: include OCI
    const closingEquitySOCIE    = closingShareCapSOCIE + closingRetEarnings + closingOtherResSOCIE;

    const socieToSFPDiff        = Math.abs(closingEquitySOCIE - closingEquity_total);
    const socieTolerance        = Math.max(1_000_000, closingEquity_total * 0.05);
    const socieReconciles       = openingDataAvailable && (socieToSFPDiff <= socieTolerance);

    const socieEngine = {
      share_capital: {
        opening_tzs:   openingShareCap,
        issued_tzs:    socieShareCapIssued,
        closing_tzs:   closingShareCapSOCIE,
      },
      retained_earnings: {
        opening_tzs:                openingRetEarnings,
        profit_for_year_tzs:        sociePatForYear,
        dividends_declared_tzs:    -socieDividendsDeclared,
        closing_tzs:                closingRetEarnings,
      },
      other_reserves: {
        opening_tzs:   openingOtherRes,
        movement_tzs:  socieOCIMovement,   // D4: OCI movements from management_inputs
        closing_tzs:   closingOtherResSOCIE,
      },
      total: {
        opening_tzs:              openingEquitySOCIE,
        profit_for_year_tzs:      sociePatForYear,
        other_movements_tzs:      socieShareCapIssued - socieDividendsDeclared,
        closing_derived_tzs:      closingEquitySOCIE,
        sfp_closing_tzs:          closingEquity_total,
      },
      reconciles_to_sfp:            socieReconciles,
      reconciliation_difference_tzs: Math.round(closingEquitySOCIE - closingEquity_total),
      opening_data_available:       openingDataAvailable,
      cpa_note: "Share capital issued and dividends declared require management input. " +
                "Other comprehensive income (OCI) not yet computed. " +
                "Large reconciliation differences may indicate undisclosed owner transactions " +
                "or misclassified equity accounts.",
      ifrs_section: "IFRS for SMEs Section 6 — Statement of Changes in Equity",
    };

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

      // ── D8: AMT status ────────────────────────────────────────────────────
      amt_applies:                      amtApplicable,
      amt_computed_tzs:                 amtApplicable ? amtComputed : 0,

      // ── D2: SCF disposal data quality flag ────────────────────────────────
      scf_disposal_proceeds_missing:    ppeDisposalsMissingProceeds,

      // ── D4: Management inputs availability ────────────────────────────────
      management_inputs_provided:       mgmtInputsProvided,

      // ── D3: Loss pool ─────────────────────────────────────────────────────
      opening_cumulative_loss_tzs:      openingCumulativeLoss,
      closing_cumulative_loss_tzs:      Math.round(closingLossPool),
      loss_absorbed_this_year_tzs:      Math.round(lossAbsorbedThisYear),

      // ── MODULE D: Deferred Tax (IFRS for SMEs s.29 / IAS 12) ────────────
      module_d_deferred:                moduleDDeferred,

      // ── MODULE F: Statement of Cash Flows (IFRS for SMEs s.7) ───────────
      scf_engine:                       scfEngine,

      // ── MODULE G: Statement of Changes in Equity (IFRS for SMEs s.6) ────
      socie_engine:                     socieEngine,

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

    // ── STEP 12: Save period closing balances ─────────────────────────────
    // Upsert the closing snapshot so next year's run has opening balances.
    // This is what resolves OD-14 for every subsequent period.
    await supabase.from("period_closing_balances").upsert({
      company_id:                    companyId,
      period_year:                   periodYear,
      period_month:                  periodEndMonth,   // D7-FIX: actual fiscal year-end month
      // SFP snapshot
      current_assets_tzs:            closingCA_total,
      non_current_assets_tzs:        closingNCA_total,
      current_liabilities_tzs:       closingCL_total,
      non_current_liabilities_tzs:   closingNCL_total,
      equity_tzs:                    closingEquity_total,
      cash_balance_tzs:              cashBalance,
      // Equity components
      share_capital_tzs:             bsShareCapital,
      retained_earnings_tzs:         Math.round(closingRetEarnings),
      other_reserves_tzs:            bsOtherReserves,
      // Deferred tax
      closing_dtl_tzs:               netDTL,
      closing_dta_tzs:               netDTA,
      net_deferred_tax_position_tzs: netDeferredTaxPosition,
      // D3-FIX: save corrected closing loss pool (reduced on profit years)
      cumulative_unrelieved_loss_tzs: Math.round(closingLossPool),
      // D8-FIX: save taxable_income_tzs + revenue for AMT 3-year detection
      taxable_income_tzs:             taxableIncome,
      accounting_pbt_tzs:             accountingPBT,
      total_wear_tear_tzs:            totalWearTear,
      revenue_tzs:                    turnover,
      // WDV by class
      wdv_class1_tzs:   Math.round(wdvClosingByClass[1] ?? 0),
      wdv_class2_tzs:   Math.round(wdvClosingByClass[2] ?? 0),
      wdv_class3_tzs:   Math.round(wdvClosingByClass[3] ?? 0),
      wdv_class5_tzs:   Math.round(wdvClosingByClass[5] ?? 0),
      wdv_class6_tzs:   Math.round(wdvClosingByClass[6] ?? 0),
      wdv_class7_tzs:   Math.round(wdvClosingByClass[7] ?? 0),
      wdv_class8_tzs:   Math.round(wdvClosingByClass[8] ?? 0),
      // Provenance
      upload_id:         uploadId,
      engine_version:    ENGINE_VERSION,
      computed_at:       new Date().toISOString(),
    }, { onConflict: "company_id,period_year,period_month" });

    // ── STEP 13: Auto-generate AJEs for CIT gap and DTL ──────────────────
    // AJEs are only written when:
    //   (a) userId is provided (so we have a created_by value), AND
    //   (b) there is a material gap or deferred tax position
    // Each AJE is an upsert keyed on (company_id, upload_id, aje_number)
    // so re-runs are idempotent.
    if (userId) {
      const ajeInserts: object[] = [];

      // AJE-E001: CIT gap → Dr Income Tax Expense / Cr Income Tax Payable
      if (Math.abs(citGap) > VARIANCE_THRESHOLD_TZS) {
        const ajeE001 = {
          company_id:     companyId,
          upload_id:      uploadId,
          period_year:    periodYear,
          aje_number:     "AJE-E001",
          description:    `CIT gap adjustment FY${periodYear}: computed TZS ${taxPayable.toLocaleString()} vs provision TZS ${itProvision.toLocaleString()}. Gap = TZS ${citGap.toLocaleString()}.`,
          aje_type:       "tax",
          source:         "module_e",
          auto_generated: true,
          created_by:     userId,
          status:         "draft",
        };
        const { data: ajeE001Row } = await supabase
          .from("adjusting_journal_entries")
          .upsert(ajeE001, { onConflict: "company_id,upload_id,aje_number" })
          .select("id")
          .single();

        if (ajeE001Row?.id) {
          const lines = citGap > 0
            ? [
                { aje_id: ajeE001Row.id, line_number: 1, account_code: "7000", account_name: "Income Tax Expense", classification: "taxes",              debit_tzs: citGap, credit_tzs: 0, narration: "Additional CIT charge to close gap" },
                { aje_id: ajeE001Row.id, line_number: 2, account_code: "2200", account_name: "Income Tax Payable",  classification: "current_liabilities", debit_tzs: 0, credit_tzs: citGap, narration: "CIT payable balance" },
              ]
            : [
                { aje_id: ajeE001Row.id, line_number: 1, account_code: "2200", account_name: "Income Tax Payable",  classification: "current_liabilities", debit_tzs: Math.abs(citGap), credit_tzs: 0, narration: "Release over-provision" },
                { aje_id: ajeE001Row.id, line_number: 2, account_code: "7000", account_name: "Income Tax Expense", classification: "taxes",              debit_tzs: 0, credit_tzs: Math.abs(citGap), narration: "CIT over-provision credit" },
              ];
          await supabase.from("aje_lines").upsert(lines, { onConflict: "aje_id,line_number" });
          ajeInserts.push(ajeE001Row);
        }
      }

      // AJE-D001: Deferred tax position → Dr/Cr Deferred Tax Expense
      if (Math.abs(netDeferredTaxPosition) > 0) {
        const isNetDTL = netDeferredTaxPosition > 0;
        const dtAmount = Math.abs(finalDeferredTaxMovement);
        if (dtAmount > 0) {
          const ajeD001 = {
            company_id:     companyId,
            upload_id:      uploadId,
            period_year:    periodYear,
            aje_number:     "AJE-D001",
            description:    `Deferred tax ${isNetDTL ? "liability" : "asset"} FY${periodYear}: movement TZS ${finalDeferredTaxMovement.toLocaleString()} (${moduleDDeferred.ifrs_section}).`,
            aje_type:       "deferred_tax",
            source:         "module_d",
            auto_generated: true,
            created_by:     userId,
            status:         "draft",
          };
          const { data: ajeD001Row } = await supabase
            .from("adjusting_journal_entries")
            .upsert(ajeD001, { onConflict: "company_id,upload_id,aje_number" })
            .select("id")
            .single();

          if (ajeD001Row?.id) {
            const lines = isNetDTL
              ? [
                  { aje_id: ajeD001Row.id, line_number: 1, account_code: "7001", account_name: "Deferred Tax Expense", classification: "taxes",                   debit_tzs: dtAmount, credit_tzs: 0, narration: "Deferred tax charge (net DTL position)" },
                  { aje_id: ajeD001Row.id, line_number: 2, account_code: "2500", account_name: "Deferred Tax Liability", classification: "non_current_liabilities", debit_tzs: 0, credit_tzs: dtAmount, narration: "DTL posted to SFP non-current liabilities" },
                ]
              : [
                  { aje_id: ajeD001Row.id, line_number: 1, account_code: "1500", account_name: "Deferred Tax Asset",    classification: "non_current_assets",      debit_tzs: dtAmount, credit_tzs: 0, narration: "DTA posted to SFP non-current assets" },
                  { aje_id: ajeD001Row.id, line_number: 2, account_code: "7001", account_name: "Deferred Tax Income",   classification: "taxes",                   debit_tzs: 0, credit_tzs: dtAmount, narration: "Deferred tax credit (net DTA position)" },
                ];
            await supabase.from("aje_lines").upsert(lines, { onConflict: "aje_id,line_number" });
            ajeInserts.push(ajeD001Row);
          }
        }
      }

      if (ajeInserts.length > 0) {
        result.auto_ajes_created = ajeInserts.length;
      }
    }

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
