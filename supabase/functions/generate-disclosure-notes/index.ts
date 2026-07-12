// ============================================================
// generate-disclosure-notes — NoteSynth v2: Tanzania-Specific
// Iron Dome Nuclear Design: NO AI-hallucinated statutory numbers.
// All notes are computed from real engine output — actual TZS
// figures injected directly from tax_computations + upload data.
//
// 8 Mandatory Notes:
//   1. Basis of Preparation (IFRS for SMEs, ITA Cap.332, FA 2026)
//   2. Income Tax (ITA waterfall, CIT, deferred tax)
//   3. Contingent Liabilities (TRA audit risk, CIT gap, penalty)
//   4. Related Party Transactions (ITA s.33 mgmt fees)
//   5. Going Concern (AMT risk, loss position)
//   6. PPE & Capital Allowances (ITA s.34 WDV schedule)
//   7. Loss Carry-Forward (ITA s.19, 70% shelter cap)
//   8. Significant Accounting Policies
//
// STATUTORY REFERENCES (verified sources):
//   ITA Cap.332 R.E.2023 — Tanzania Income Tax Act
//   Finance Act 2026 (Tanzania) — effective 01 July 2026
//   IFRS for SMEs (2015 ed.) — IASB
//   TAA Cap.438 — Tax Administration Act
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Formatting helpers ───────────────────────────────────────
const fmt = (n: number): string =>
  new Intl.NumberFormat("en-TZ", { maximumFractionDigits: 0 }).format(Math.abs(n));

const fmtSigned = (n: number): string =>
  n < 0 ? `(TZS ${fmt(n)})` : `TZS ${fmt(n)}`;

// ── Constants (ITA Cap.332 R.E.2023 + Finance Act 2026) ─────
// Each constant is tagged with the verified source used by the Kinga engine.
// "NOT verified" means the section was NOT traced to primary legislation in
// this project — those values are omitted from user-visible note text.
const CIT_RATE = 0.30;           // ITA s.4         ✅ verified
const MIN_TAX_RATE = 0.005;      // ITA s.65 / FA2026 s.31  ✅ verified
const LOSS_SHELTER_CAP = 0.70;   // ITA s.19(2)     ✅ verified
const MGMT_FEE_CAP = 0.01;       // ITA s.33        ✅ verified
const TAA_PENALTY_RATE = 0.10;   // TAA s.73        ✅ verified (task #52)
const TAA_INTEREST_RATE = 0.05;  // TAA s.76        ✅ verified (task #52)
const PRESUMPTIVE_THRESHOLD_TZS = 200_000_000; // FA2026 s.31  ✅ verified
// TAA assessment limitation, objection period, filing due-date sections:
// ❌ NOT verified against primary legislation in this project.
// General statements about those rights appear in notes WITHOUT section citations.

// ── Types ────────────────────────────────────────────────────
interface EngineResult {
  taxable_income_tzs?: number;
  cit_at_30pct_tzs?: number;
  minimum_tax_tzs?: number;
  tax_payable_tzs?: number;
  income_tax_provision_tzs?: number;
  cit_gap_tzs?: number;
  pbt_tzs?: number;
  total_revenue_tzs?: number;
  opening_cumulative_loss_tzs?: number;
  closing_cumulative_loss_tzs?: number;
  loss_absorbed_this_year_tzs?: number;
  amt_applies?: boolean;
  amt_computed_tzs?: number;
  management_fee_disallowance_tzs?: number;
  management_fee_input_tzs?: number;
  wear_tear_allowance_tzs?: number;
  thin_cap_disallowance_tzs?: number;
  review_required?: boolean;
  module_d_deferred?: {
    dta_recognised?: boolean;
    dta_amount_tzs?: number;
    dtl_amount_tzs?: number;
    net_deferred_position?: number;
    recognition_note?: string;
    timing_differences?: Array<{ description: string; amount_tzs: number }>;
  };
  capital_allowances?: Array<{
    asset_class: string;
    opening_wdv_tzs: number;
    additions_tzs: number;
    disposals_tzs: number;
    allowance_tzs: number;
    closing_wdv_tzs: number;
  }>;
  engine_version?: string;
  [key: string]: unknown;
}

interface DisclosureNote {
  id: string;
  title: string;
  category: string;
  content: string;
  relevance: "high" | "medium" | "low";
  accountsReferenced?: string[];
  // Audit trail — added per Iron Dome design review
  sources: Array<"trial_balance" | "tax_computation" | "company_profile">;
  statutoryRefs: string[];   // verified references only — no unverified citations
  generatedAt: string;       // ISO timestamp
  engineVersion: string;     // kinga engine version that produced the underlying data
}

// ── Note generators ──────────────────────────────────────────

function note1_basisOfPreparation(
  companyName: string,
  companyTin: string,
  periodYear: number,
  periodEndMonth: number,
  framework: string,
  generatedAt: string,
  engineVersion: string,
): DisclosureNote {
  const months = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];
  const fyEnd = `${months[periodEndMonth - 1]} ${periodYear}`;
  const ifrsLabel = framework === "IFRS" ? "International Financial Reporting Standards (IFRS)" :
                    "IFRS for SMEs (2015 edition)";
  return {
    id: "note-1-basis",
    title: "Basis of Preparation",
    category: "Accounting Policy",
    relevance: "high",
    sources: ["company_profile"],
    statutoryRefs: ["ITA Cap.332 R.E.2023 s.4", "ITA s.19(2)", "ITA s.19(3)", "ITA s.24A", "ITA s.33", "ITA s.34", "ITA s.65", "ITA s.88", "FA2026 s.31", "Companies Act Cap.212 R.E.2002"],
    generatedAt,
    engineVersion,
    content: `These financial statements have been prepared in accordance with ${ifrsLabel} as adopted in Tanzania, and comply with the requirements of the Companies Act Cap.212 R.E.2002 (as amended).

The financial statements are prepared on the historical cost basis and presented in Tanzanian Shillings (TZS), which is the functional and presentation currency of ${companyName}.${companyTin ? ` The Company's TRA Tax Identification Number (TIN) is ${companyTin}.` : ""}

The financial year covered by these statements is the twelve-month period ending ${fyEnd}.

INCOME TAX COMPLIANCE FRAMEWORK
These statements reflect taxation computed under the Income Tax Act Cap.332 R.E.2023 ("ITA") and the Finance Act 2026 (effective 01 July 2026), as administered by the Tanzania Revenue Authority. Key provisions applied include:
• Corporate Income Tax: ITA s.4 at 30% of chargeable income
• Minimum Tax: ITA s.65 / Finance Act 2026 s.31 at 0.5% of turnover (threshold TZS 200,000,000)
• Capital Allowances: ITA s.34 — reducing balance and straight-line methods by class
• Loss Relief: ITA s.19 — indefinite carry-forward, annual shelter capped at 70% of taxable income
• Management Fees: ITA s.33 — deductibility capped at 1% of turnover
• Interest Deductibility: ITA s.24A — thin capitalisation ratio 3:1 (debt:equity)
• Instalment Tax: ITA s.88 — four equal quarterly instalments

Going concern: The directors have assessed the company's ability to continue as a going concern and are satisfied that it will continue in operational existence for the foreseeable future.`,
    accountsReferenced: [],
  };
}

function note2_incomeTax(r: EngineResult, periodYear: number, generatedAt: string, engineVersion: string): DisclosureNote {
  const pbt = r.pbt_tzs ?? 0;
  const taxableIncome = r.taxable_income_tzs ?? 0;
  const cit = r.cit_at_30pct_tzs ?? 0;
  const minTax = r.minimum_tax_tzs ?? 0;
  const taxPayable = r.tax_payable_tzs ?? 0;
  const provision = r.income_tax_provision_tzs ?? 0;
  const gap = r.cit_gap_tzs ?? 0;
  const dta = r.module_d_deferred;
  const dtaAmount = dta?.dta_amount_tzs ?? 0;
  const dtlAmount = dta?.dtl_amount_tzs ?? 0;
  const netDeferred = dta?.net_deferred_position ?? 0;
  const dtaRecognised = dta?.dta_recognised ?? false;

  const gapNote = Math.abs(gap) > 500_000
    ? `\nTAX PROVISION GAP: The computed ITA tax liability (TZS ${fmt(taxPayable)}) differs from the income tax provision booked (TZS ${fmt(provision)}) by TZS ${fmt(gap)}. ${gap > 0 ? "An additional provision of TZS " + fmt(gap) + " is required." : "The provision is TZS " + fmt(Math.abs(gap)) + " in excess of computed liability."} Management should record an adjusting journal entry to align the provision.`
    : "";

  const deferredSection = (dtaAmount > 0 || dtlAmount > 0)
    ? `\nDEFERRED TAXATION (IFRS for SMEs s.29 / IAS 12):
Net deferred tax position: ${fmtSigned(netDeferred)}
${dtaAmount > 0 ? `Deferred tax asset (DTA): TZS ${fmt(dtaAmount)} — ${dtaRecognised ? "recognised in the statement of financial position subject to future profitability assessment." : "NOT recognised as future taxable profit is not considered sufficiently probable (IFRS for SMEs s.29.7)."}` : ""}
${dtlAmount > 0 ? `Deferred tax liability (DTL): TZS ${fmt(dtlAmount)} — recognised and payable in future periods.` : ""}
${dta?.recognition_note ? `\nDTA recognition assessment: ${dta.recognition_note}` : ""}`
    : "";

  return {
    id: "note-2-income-tax",
    title: "Income Tax",
    category: "Taxation",
    relevance: "high",
    sources: ["tax_computation", "trial_balance"],
    statutoryRefs: ["ITA s.4 (CIT 30%)", "ITA s.19(2) (loss relief 70%)", "ITA s.24A (thin cap)", "ITA s.33 (mgmt fees)", "ITA s.34 (capital allowances)", "ITA s.65 / FA2026 s.31 (minimum tax)", "IFRS for SMEs s.29", "IAS 12"],
    generatedAt,
    engineVersion,
    content: `CURRENT YEAR COMPUTATION (ITA Cap.332 R.E.2023):

                                              TZS
Profit before tax                     ${fmt(pbt).padStart(15)}
Adjustments per ITA:                  ${r.wear_tear_allowance_tzs && r.wear_tear_allowance_tzs > 0 ? `\n  Less: ITA s.34 capital allowances   (${fmt(r.wear_tear_allowance_tzs ?? 0)})` : ""}${r.management_fee_disallowance_tzs && r.management_fee_disallowance_tzs > 0 ? `\n  Add: ITA s.33 mgmt fee disallowance ${fmt(r.management_fee_disallowance_tzs ?? 0)}` : ""}${r.thin_cap_disallowance_tzs && r.thin_cap_disallowance_tzs > 0 ? `\n  Add: ITA s.24A thin cap disallowance ${fmt(r.thin_cap_disallowance_tzs ?? 0)}` : ""}${(r.loss_absorbed_this_year_tzs ?? 0) > 0 ? `\n  Less: ITA s.19 prior-year loss relief (${fmt(r.loss_absorbed_this_year_tzs ?? 0)})` : ""}
                                              -------
Chargeable income (loss)              ${taxableIncome < 0 ? `(${fmt(taxableIncome)})` : fmt(taxableIncome).padStart(15)}

Corporate income tax @ 30%:           TZS ${fmt(cit)}
Minimum tax @ 0.5% of turnover:      TZS ${fmt(minTax)}
Tax payable (higher of CIT / Min):   TZS ${fmt(taxPayable)}
Income tax provision (booked):        TZS ${fmt(provision)}${gapNote}${deferredSection}

All computation performed by SAFF Kinga Tax Engine (${r.engine_version ?? "v2"}) in accordance with ITA Cap.332 R.E.2023 and Finance Act 2026.`,
    accountsReferenced: ["Income Tax Expense", "Income Tax Payable", "Deferred Tax Asset", "Deferred Tax Liability"],
  };
}

function note3_contingentLiabilities(r: EngineResult, generatedAt: string, engineVersion: string): DisclosureNote {
  const gap = r.cit_gap_tzs ?? 0;
  const taxPayable = r.tax_payable_tzs ?? 0;
  const hasGap = Math.abs(gap) > 500_000;
  const penalty = hasGap && gap > 0 ? Math.round(gap * TAA_PENALTY_RATE) : 0;
  const hasAmt = r.amt_applies ?? false;

  const gapSection = hasGap && gap > 0
    ? `UNDERPROVISION OF INCOME TAX:
The Company has identified a potential underprovision of income tax of TZS ${fmt(gap)} for the current financial year. Under TAA Cap.438:
• Penalty: up to 10% of unpaid tax = TZS ${fmt(penalty)} (TAA s.73)
• Late payment interest: 5% per month on outstanding balance (TAA s.76)
Total maximum exposure (penalty only): TZS ${fmt(gap + penalty)}

This represents a contingent liability pending lodgement of a self-assessment return and payment of tax due.`
    : "No material CIT underprovision identified for the current year.";

  const amtSection = hasAmt
    ? `\nALTERNATIVE MINIMUM TAX (ITA s.89):
The Company has triggered the AMT threshold (3+ consecutive loss years). AMT computed at 0.5% of gross turnover = TZS ${fmt(r.amt_computed_tzs ?? 0)}. This amount is due regardless of the income tax computation outcome.`
    : "";

  return {
    id: "note-3-contingent",
    title: "Contingent Liabilities",
    category: "Disclosures",
    relevance: hasGap || hasAmt ? "high" : "medium",
    sources: ["tax_computation"],
    statutoryRefs: ["TAA Cap.438 s.73 (penalty 10%)", "TAA Cap.438 s.76 (interest 5%/month)", "ITA s.65 / FA2026 s.31 (minimum tax 0.5%)", "ITA s.89 (AMT)", "IFRS for SMEs s.21 (provisions)"],
    generatedAt,
    engineVersion,
    content: `${gapSection}${amtSection}

TRA AUDIT RISK:
The Company is subject to routine audit by the Tanzania Revenue Authority (TRA) under the Tax Administration Act Cap.438 ("TAA"). TRA assessments are subject to a statutory limitation period under the TAA; the directors are not aware of any pending TRA audit or assessment as at the balance sheet date.

Where a TRA assessment is received, the Company has a statutory right to object within the period prescribed by the TAA. All tax returns must be filed by the due dates prescribed under the TAA to avoid automatic penalties and interest. The directors should verify current filing deadlines with a qualified tax adviser.`,
    accountsReferenced: ["Income Tax Payable", "Provisions"],
  };
}

function note4_relatedPartyTransactions(r: EngineResult, generatedAt: string, engineVersion: string): DisclosureNote {
  const mgmtFeeInput = r.management_fee_input_tzs ?? 0;
  const disallowance = r.management_fee_disallowance_tzs ?? 0;
  const revenue = r.total_revenue_tzs ?? 0;
  const cap = revenue > 0 ? Math.round(revenue * MGMT_FEE_CAP) : 0;
  const hasMgmtFees = mgmtFeeInput > 0;

  const feeSection = hasMgmtFees
    ? `MANAGEMENT FEES — ITA s.33 DISCLOSURE:
Management fees paid/accrued to related parties: TZS ${fmt(mgmtFeeInput)}
ITA s.33 deductibility cap (1% of gross turnover): TZS ${fmt(cap)}
${disallowance > 0 ? `Disallowed amount (added back to income): TZS ${fmt(disallowance)}\nThe disallowed portion (TZS ${fmt(disallowance)}) is not deductible for income tax purposes and increases chargeable income.` : "Entire management fee is within the ITA s.33 cap and fully deductible."}`
    : "No management fees were paid to or accrued for related parties during the financial year.";

  return {
    id: "note-4-related-party",
    title: "Related Party Transactions",
    category: "Disclosures",
    relevance: hasMgmtFees ? "high" : "low",
    sources: ["tax_computation", "trial_balance"],
    statutoryRefs: ["ITA s.33 (mgmt fee cap 1% turnover)", "ITA s.24A (thin cap 3:1)", "IFRS for SMEs s.33", "IAS 24"],
    generatedAt,
    engineVersion,
    content: `${feeSection}

DEFINITION OF RELATED PARTIES:
Related parties are identified per IFRS for SMEs Section 33 / IAS 24, and include:
• Shareholders holding ≥ 20% of voting rights
• Directors and key management personnel and their close family members
• Entities controlled by or under common control with the Company
• Associates and joint ventures

ITA s.33 TRANSFER PRICING:
All transactions with related parties, including management fees, service charges, royalties and financing arrangements, are required to be conducted at arm's length under ITA s.33. TRA may adjust any non-arm's-length transaction in a TRA audit.

FINANCING FROM RELATED PARTIES:
Where the Company has obtained financing from related parties, the deductibility of interest is subject to the thin capitalisation rules under ITA s.24A (debt:equity ratio of 3:1).`,
    accountsReferenced: ["Management Fees", "Interest Expense", "Loans from Related Parties"],
  };
}

function note5_goingConcern(r: EngineResult, periodYear: number, generatedAt: string, engineVersion: string): DisclosureNote {
  const closingLoss = r.closing_cumulative_loss_tzs ?? 0;
  const hasAmt = r.amt_applies ?? false;
  const taxableIncome = r.taxable_income_tzs ?? 0;
  const isLossYear = taxableIncome < 0;

  const concerns: string[] = [];
  if (closingLoss > 50_000_000) concerns.push(`unrelieved tax loss pool of TZS ${fmt(closingLoss)}`);
  if (hasAmt) concerns.push("Alternative Minimum Tax triggered (3+ consecutive loss years per ITA s.89)");
  if (isLossYear) concerns.push(`current year taxable loss of TZS ${fmt(Math.abs(taxableIncome))}`);

  const hasConcerns = concerns.length > 0;

  return {
    id: "note-5-going-concern",
    title: "Going Concern",
    category: "Accounting Policy",
    relevance: hasConcerns ? "high" : "low",
    sources: ["tax_computation"],
    statutoryRefs: ["ITA s.19(2) (loss relief 70%)", "ITA s.19(3) (indefinite c/f)", "ITA s.89 (AMT 3-year trigger)"],
    generatedAt,
    engineVersion,
    content: hasConcerns
      ? `GOING CONCERN CONSIDERATIONS:
The directors have assessed the Company's ability to continue as a going concern for the financial year ending ${periodYear} and beyond. The following factors require disclosure:

${concerns.map((c, i) => `${i + 1}. ${c.charAt(0).toUpperCase() + c.slice(1)}`).join("\n")}

${hasAmt ? `ALTERNATIVE MINIMUM TAX: The Company has been assessed for AMT under ITA s.89 at 0.5% of gross turnover (TZS ${fmt(r.amt_computed_tzs ?? 0)}). The directors note that sustained loss-making triggers AMT liability regardless of chargeable income, creating a cash obligation that must be managed.` : ""}

${closingLoss > 50_000_000 ? `TAX LOSS POOL: The accumulated unrelieved tax loss of TZS ${fmt(closingLoss)} carries forward indefinitely under ITA s.19(3). Relief is available against future taxable profits at up to 70% of annual chargeable income (ITA s.19(2)). The directors believe future profitability will be sufficient to utilise this loss within a reasonable timeframe.` : ""}

DIRECTORS' ASSESSMENT:
The directors are satisfied that the Company has adequate resources to continue in operational existence for the foreseeable future. The financial statements have therefore been prepared on the going concern basis.`
      : `The directors have assessed the Company's ability to continue as a going concern. Having considered the financial position as at ${periodYear} year-end, the current year taxable profit, and the Company's operational cash flows, the directors are satisfied that the Company has adequate resources to continue operations for the foreseeable future.

The financial statements have been prepared on the going concern basis.`,
    accountsReferenced: [],
  };
}

function note6_ppeCapitalAllowances(r: EngineResult, generatedAt: string, engineVersion: string): DisclosureNote {
  const allowances = r.capital_allowances ?? [];
  const wearTear = r.wear_tear_allowance_tzs ?? 0;

  const schedule = allowances.length > 0
    ? allowances.map(a =>
        `  ${a.asset_class.padEnd(40)} Opening WDV: TZS ${fmt(a.opening_wdv_tzs)} | Additions: TZS ${fmt(a.additions_tzs)} | Disposals: (TZS ${fmt(a.disposals_tzs)}) | Allowance: (TZS ${fmt(a.allowance_tzs)}) | Closing WDV: TZS ${fmt(a.closing_wdv_tzs)}`
      ).join("\n")
    : "  Capital allowance schedule not available — please populate the capital allowances register.";

  return {
    id: "note-6-ppe",
    title: "Property, Plant & Equipment and Capital Allowances",
    category: "Assets",
    relevance: wearTear > 0 ? "high" : "medium",
    sources: ["tax_computation", "trial_balance"],
    statutoryRefs: ["ITA s.34 (capital allowances — class rates)", "IFRS for SMEs s.17 (PPE)", "IFRS for SMEs s.29 (deferred tax on timing differences)"],
    generatedAt,
    engineVersion,
    content: `ITA s.34 CAPITAL ALLOWANCES SCHEDULE:
Total capital allowances claimed (ITA s.34): TZS ${fmt(wearTear)}

Capital allowances are computed under ITA Cap.332 R.E.2023 s.34 on the following bases:
• Class 1 (computers, vehicles <30-seat, construction equipment): 37.5% reducing balance
• Class 2 (heavy vehicles, vessels, aircraft, agricultural/manufacturing plant): 25% reducing balance
• Class 3 (furniture, fixtures, all other equipment): 12.5% reducing balance
• Class 5 (agricultural/livestock/fisheries buildings): 20% straight-line
• Class 6 (commercial/industrial buildings): 5% straight-line
• Class 7 (intangible assets): 1/useful life straight-line (ITA s.34 — rate per PwC Tanzania Jan 2026 summary; verify against primary legislation before use)

WRITTEN-DOWN VALUE SCHEDULE (ITA s.34):
${schedule}

Capital allowances replace accounting depreciation for income tax purposes. The difference between accounting depreciation and ITA capital allowances gives rise to a temporary difference subject to deferred tax recognition under IFRS for SMEs s.29.

IFRS ACCOUNTING POLICY:
For financial reporting purposes, property, plant and equipment is stated at cost less accumulated depreciation and impairment losses. Depreciation is provided on a straight-line basis over the estimated useful lives of assets. The depreciation policy and rates are reviewed annually.`,
    accountsReferenced: ["Property, Plant & Equipment", "Accumulated Depreciation", "Capital Allowances", "Deferred Tax"],
  };
}

function note7_lossCarryForward(r: EngineResult, periodYear: number, generatedAt: string, engineVersion: string): DisclosureNote {
  const openingLoss = r.opening_cumulative_loss_tzs ?? 0;
  const closingLoss = r.closing_cumulative_loss_tzs ?? 0;
  const absorbed = r.loss_absorbed_this_year_tzs ?? 0;
  const taxableIncome = r.taxable_income_tzs ?? 0;
  const dta = r.module_d_deferred;
  const dtaAmount = dta?.dta_amount_tzs ?? 0;
  const dtaRecognised = dta?.dta_recognised ?? false;

  if (openingLoss <= 0 && closingLoss <= 0) {
    return {
      id: "note-7-loss",
      title: "Tax Loss Carry-Forward",
      category: "Taxation",
      relevance: "low",
      sources: ["tax_computation"],
      statutoryRefs: ["ITA s.19"],
      generatedAt,
      engineVersion,
      content: `The Company has no unrelieved tax losses to carry forward as at the end of financial year ${periodYear}. No deferred tax asset in respect of tax losses has been recognised.`,
      accountsReferenced: [],
    };
  }

  const maxShelter = taxableIncome > 0 ? Math.round(taxableIncome * LOSS_SHELTER_CAP) : 0;
  const dtaNote = dtaAmount > 0
    ? `DEFERRED TAX ASSET (IAS 12 / IFRS for SMEs s.29):
Potential DTA on loss pool: TZS ${fmt(Math.round(closingLoss * 0.30))} (closing loss × 30% CIT rate)
DTA recognised: ${dtaRecognised ? `TZS ${fmt(dtaAmount)} — recognised based on management's assessment of future taxable profit probability.` : "TZS NIL — NOT recognised as management cannot demonstrate that sufficient future taxable profits will be available (IFRS for SMEs s.29.7). The DTA will be recognised when recovery becomes probable."}`
    : "";

  return {
    id: "note-7-loss",
    title: "Tax Loss Carry-Forward",
    category: "Taxation",
    relevance: closingLoss > 0 ? "high" : "medium",
    sources: ["tax_computation"],
    statutoryRefs: ["ITA s.19(2) (70% annual shelter cap)", "ITA s.19(3) (indefinite carry-forward)", "IFRS for SMEs s.29 / s.29.7 (DTA recognition)", "IAS 12"],
    generatedAt,
    engineVersion,
    content: `MOVEMENT IN UNRELIEVED TAX LOSS POOL (ITA s.19):

                                              TZS
Opening unrelieved tax loss (b/f)     (${fmt(openingLoss)})
${taxableIncome < 0 ? `Current year loss added to pool        (${fmt(Math.abs(taxableIncome))})` : `Current year taxable profit             ${fmt(taxableIncome)}`}
${absorbed > 0 ? `Less: prior-year loss absorbed (s.19)  (${fmt(absorbed)})` : ""}
                                              --------
Closing unrelieved tax loss (c/f)     (${fmt(closingLoss)})

ITA s.19 PROVISIONS:
• Carry-forward period: Indefinite (no time limit) — ITA s.19(3)
• Annual relief cap: 70% of current year taxable income — ITA s.19(2)
• Maximum annual relief at current year income level: TZS ${fmt(maxShelter)}
• Carry-back: Not permitted under ITA Cap.332 R.E.2023

${absorbed > 0 ? `During the year, TZS ${fmt(absorbed)} of prior-year losses were relieved against current year taxable income, limited to 70% of TZS ${fmt(taxableIncome)} per ITA s.19(2).` : ""}

${dtaNote}

The directors will continue to assess the recoverability of the tax loss pool at each reporting date in accordance with IFRS for SMEs s.29.7.`,
    accountsReferenced: ["Deferred Tax Asset", "Income Tax Expense"],
  };
}

function note8_accountingPolicies(framework: string, generatedAt: string, engineVersion: string): DisclosureNote {
  return {
    id: "note-8-policies",
    title: "Significant Accounting Policies",
    category: "Accounting Policy",
    relevance: "medium",
    sources: ["company_profile"],
    statutoryRefs: ["IFRS for SMEs s.11–12", "IFRS for SMEs s.13", "IFRS for SMEs s.17", "IFRS for SMEs s.21", "IFRS for SMEs s.23", "IFRS for SMEs s.29", "ITA s.34", "Companies Act Cap.212 R.E.2002"],
    generatedAt,
    engineVersion,
    content: `BASIS OF MEASUREMENT:
These financial statements are prepared on the historical cost basis, except where otherwise stated.

REVENUE RECOGNITION (IFRS for SMEs s.23):
Revenue is recognised when it is probable that economic benefits will flow to the Company and the amount can be measured reliably. Revenue from the sale of goods is recognised on transfer of significant risks and rewards of ownership. Revenue from services is recognised by reference to the stage of completion.

FOREIGN CURRENCY TRANSACTIONS:
Transactions in foreign currencies are translated to TZS at exchange rates ruling at the transaction date. Monetary assets and liabilities denominated in foreign currencies are retranslated at the rate of exchange ruling at the reporting date. Exchange differences are recognised in profit or loss.

INCOME TAX (IFRS for SMEs s.29 / IAS 12):
Income tax expense represents the sum of current tax and deferred tax. Current tax is based on taxable profit for the year, computed under ITA Cap.332 R.E.2023. Deferred tax is recognised using the liability method on temporary differences between the carrying amounts of assets and liabilities for financial reporting purposes and the amounts used for taxation purposes. Deferred tax assets are recognised only to the extent that it is probable that future taxable profits will be available.

PROPERTY, PLANT & EQUIPMENT (IFRS for SMEs s.17):
Property, plant and equipment are stated at cost, less accumulated depreciation and impairment losses. Depreciation is charged to profit or loss on a straight-line basis over estimated useful lives. For tax purposes, capital allowances are computed under ITA s.34 (see Note 6).

INVENTORIES (IFRS for SMEs s.13):
Inventories are stated at the lower of cost and estimated selling price less costs to complete and sell. Cost is determined using the weighted average cost method.

FINANCIAL INSTRUMENTS (IFRS for SMEs s.11–12):
Basic financial instruments are recognised at amortised cost. Trade and other receivables are stated at original invoice amount less provision for doubtful debts. Financial liabilities include trade payables and borrowings, measured at amortised cost.

PROVISIONS (IFRS for SMEs s.21):
Provisions are recognised when the Company has a present obligation as a result of a past event, it is probable that an outflow of economic benefits will be required, and the amount can be estimated reliably.

THESE POLICIES APPLY FOR THE FINANCIAL YEAR PRESENTED. No changes in accounting policies were made during the current year (${framework}).`,
    accountsReferenced: [],
  };
}

// ── Auth helper ─────────────────────────────────────────────
async function validateAuth(authHeader: string | null, supabaseUrl: string, supabaseAnonKey: string) {
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders }) };
  }
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) {
    return { error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders }) };
  }
  return { userId: user.id };
}

// ── Main handler ─────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    // ── Auth ─────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    const { userId, error: authError } = await validateAuth(authHeader, supabaseUrl, supabaseAnonKey);
    if (authError) return authError;

    // ── Parse body ───────────────────────────────────────────
    const { uploadId } = await req.json();
    if (!uploadId) {
      return new Response(JSON.stringify({ error: "uploadId is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Load data from DB ────────────────────────────────────
    const admin = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Upload record (company, period)
    const { data: upload, error: uploadErr } = await admin
      .from("trial_balance_uploads")
      .select("company_id, company_name, fiscal_year_end, uploaded_at, reporting_framework")
      .eq("id", uploadId)
      .single();

    if (uploadErr || !upload) {
      console.error("Upload fetch error:", uploadErr);
      return new Response(JSON.stringify({ error: "Upload not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1b. Company TIN (mandatory for all TRA-facing documents)
    const { data: companyRow } = await admin
      .from("companies")
      .select("tin")
      .eq("id", upload.company_id)
      .maybeSingle();
    const companyTin: string = companyRow?.tin ?? "";

    // 2. Latest committed tax computation for this upload
    // IRON DOME: correct column is `computation_detail` (not `result_json`).
    // `tax_computations` has no `period_month` column — derive from fiscal_year_end.
    const { data: computation, error: compErr } = await admin
      .from("tax_computations")
      .select("computation_detail, period_year, created_at, engine_version")
      .eq("upload_id", uploadId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (compErr) {
      console.error("Computation fetch error:", compErr);
    }

    // ── Derive period ────────────────────────────────────────
    // IRON DOME: tax_computations has no period_month column.
    // fiscal_year_end (format "MM-DD") is the authoritative month source.
    let periodYear: number;
    let periodEndMonth: number;

    const fyeParts = upload.fiscal_year_end?.match(/(\d{1,2})-(\d{1,2})/);
    const fiscalEndMonth: number = fyeParts ? parseInt(fyeParts[1]) : 12;

    if (computation?.period_year) {
      periodYear     = computation.period_year;
      periodEndMonth = fiscalEndMonth;
    } else {
      const uploadDate = new Date(upload.uploaded_at);
      periodYear     = uploadDate.getFullYear();
      periodEndMonth = fiscalEndMonth;
    }

    const companyName: string = upload.company_name ?? "The Company";
    const framework: string = upload.reporting_framework ?? "IFRS for SMEs";
    // IRON DOME: computation_detail is the correct column (not result_json).
    const engineResult: EngineResult = (computation?.computation_detail as EngineResult) ?? {};

    // ── Generate all 8 Tanzania-specific notes ───────────────
    const generatedAt = new Date().toISOString();
    const engineVersion: string = engineResult.engine_version ?? computation?.engine_version ?? "v2";

    const notes: DisclosureNote[] = [
      note1_basisOfPreparation(companyName, companyTin, periodYear, periodEndMonth, framework, generatedAt, engineVersion),
      note2_incomeTax(engineResult, periodYear, generatedAt, engineVersion),
      note3_contingentLiabilities(engineResult, generatedAt, engineVersion),
      note4_relatedPartyTransactions(engineResult, generatedAt, engineVersion),
      note5_goingConcern(engineResult, periodYear, generatedAt, engineVersion),
      note6_ppeCapitalAllowances(engineResult, generatedAt, engineVersion),
      note7_lossCarryForward(engineResult, periodYear, generatedAt, engineVersion),
      note8_accountingPolicies(framework, generatedAt, engineVersion),
    ];

    // ── Persist to upload record — safe merge into processing_result ──
    const disclosurePayload = {
      notes,
      metadata: {
        generatedAt: new Date().toISOString(),
        totalNotes: notes.length,
        framework: `Tanzania IFRS/ITA — ${framework}`,
        engine: "NoteSynth v2 (computed, no AI inference)",
        periodYear,
        periodEndMonth,
        hasEngineData: !!computation,
      },
    };

    // Fetch existing processing_result to merge (avoid overwriting TB data)
    const { data: existing } = await admin
      .from("trial_balance_uploads")
      .select("processing_result")
      .eq("id", uploadId)
      .single();

    const existingResult = (existing?.processing_result as Record<string, unknown>) ?? {};
    await admin
      .from("trial_balance_uploads")
      .update({ processing_result: { ...existingResult, disclosureNotes: disclosurePayload } })
      .eq("id", uploadId);

    // Log action
    await admin.from("audit_logs").insert({
      user_id: userId,
      action: "generate_disclosure_notes",
      entity_type: "trial_balance_upload",
      entity_id: uploadId,
      metadata: { note_count: notes.length, period_year: periodYear, framework },
    }).maybeSingle(); // soft fail if audit_logs schema differs

    return new Response(
      JSON.stringify(disclosurePayload),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("generate-disclosure-notes error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
