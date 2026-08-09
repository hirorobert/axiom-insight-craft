/**
 * Deterministic IPSAS/GFRS vocabulary for Tanzanian public-sector ledgers.
 *
 * This is deliberately framework-scoped. These terms must never influence an
 * IFRS/private-sector engagement, and ambiguous names still go to review.
 */

export interface PublicSectorClassification {
  statement: "balance_sheet" | "income_statement";
  classification:
    | "current_assets"
    | "non_current_assets"
    | "current_liabilities"
    | "non_current_liabilities"
    | "equity"
    | "revenue"
    | "operating_expenses";
  normal_balance: "debit" | "credit";
  line_item: string;
  is_cash?: boolean;
}

const PUBLIC_SECTOR_FRAMEWORKS = new Set(["ipsas_accrual", "gfrs"]);

const RULES: Array<{ patterns: RegExp[]; result: PublicSectorClassification }> = [
  // Exchange and non-exchange revenue under IPSAS presentation.
  {
    patterns: [
      /\bgovernment\s+grant\b/i,
      /\bsubvention\b/i,
      /\bdevelopment\s+grant/i,
      /\bcapital\s+grant/i,
      /\bcapitation\s+grant/i,
      /\btransfer(?:s)?\s+from\s+(?:central\s+)?government/i,
    ],
    result: { statement: "income_statement", classification: "revenue", normal_balance: "credit", line_item: "Transfers and grants" },
  },
  {
    patterns: [
      /\buser\s+fee/i,
      /\bfees?\s+(?:and|&)\s+charges\b/i,
      /\bfee[s]?[-\s]+exchange\b/i,
      /\bmarket\s+fees?/i,
      /\bparking\s+fees?/i,
      /\bapplication\s+fees?/i,
      /\btuition\s+fees?/i,
      /\bbillboards?\b/i,
      /\broyalt(?:y|ies)\b/i,
      /\bagriculture\s+and\s+farm\s+produce\b/i,
      /\breproduction\s+services?\b/i,
      /\bcommunity\s+health\s+fund\b/i,
      /\bdrug\s+revolving\s+fund\b/i,
      /\bservice\s+levy\b/i,
    ],
    result: { statement: "income_statement", classification: "revenue", normal_balance: "credit", line_item: "Fees, levies and exchange revenue" },
  },

  // Public-sector employee and service-delivery costs.
  {
    patterns: [
      /\bpersonal\s+emolument/i,
      /\bcivil\s+servants?\b/i,
      /\bcasual\s+labour/i,
      /\bextra[-\s]?duty\b/i,
      /\bhonoraria\b/i,
      /\bmedical\s+and\s+dental\s+refund/i,
    ],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Employee costs" },
  },
  {
    patterns: [
      /\bteaching\s+suppl/i,
      /\bmedical\s+suppl/i,
      /\bdental\s+suppl/i,
      /\bhospital\s+suppl/i,
      /\bdrugs?\s+and\s+medicines?\b/i,
      /\bfood\s+and\s+(?:supply|refreshment)/i,
      /\bfoodstuffs?\b/i,
      /\bexamination\s+expenses?\b/i,
      /\bagriculture\s+and\s+livestock\s+extension/i,
      /\bdisabled\s+group\s+development/i,
      /\bassistant\s+to\s+person\s+with\s+disability/i,
      /\bcapitation\s+cost/i,
      /\bagency\s+fees?\b/i,
      /\badvertising\s+and\s+publication/i,
      /\bgifts?\s+and\s+prizes?\b/i,
      /\bexhibition.*celebration/i,
    ],
    result: { statement: "income_statement", classification: "operating_expenses", normal_balance: "debit", line_item: "Public service delivery costs" },
  },

  // GFRS asset register labels commonly carry valuation-basis suffixes.
  {
    patterns: [
      /\b(?:bridges?|roads?|hospitals?|clinics?|health\s+facilities|houses?|cottages?|condos?)\b.*\b(?:opening|monetary|non\s+monetary)\b/i,
      /\bconstruction\s+materials?\b/i,
    ],
    result: { statement: "balance_sheet", classification: "non_current_assets", normal_balance: "debit", line_item: "Property, plant and infrastructure" },
  },
  {
    patterns: [
      /\bbot\s+own\s*source\s+collection\s+account\b/i,
      /\bcollection\s+account\b/i,
    ],
    result: { statement: "balance_sheet", classification: "current_assets", normal_balance: "debit", line_item: "Cash and collection accounts", is_cash: true },
  },
];

export function classifyPublicSectorAccount(
  name: string,
  reportingFramework: string | null | undefined,
): PublicSectorClassification | null {
  if (!reportingFramework || !PUBLIC_SECTOR_FRAMEWORKS.has(reportingFramework.toLowerCase())) return null;
  const normalized = name.trim();
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) return rule.result;
  }
  return null;
}