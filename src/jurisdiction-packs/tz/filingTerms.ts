/**
 * filingTerms — configuration-driven filing terminology and statutory references.
 *
 * Global surfaces never hard-code a jurisdiction's levy names, rates or statute citations. They ask this registry for
 * the term of the workspace's CONFIGURED filing jurisdiction; with no jurisdiction configured (the default), the neutral
 * wording is used and no citation is shown. A jurisdiction's specifics live here, as data, and nowhere else.
 */

export type FilingTermKey =
  | "sdl" | "nssf" | "service_levy" | "paye" | "vat" | "wht" | "thin_cap" | "entertainment"
  | "management_fee" | "presumptive_tax" | "penalties" | "unknown" | "cit_provisional" | "cit_final";

export interface FilingTerm {
  readonly label: string;
  readonly description: string;
  /** A statutory reference, or null when no jurisdiction is configured. */
  readonly reference: string | null;
}

/** The neutral vocabulary used whenever no filing jurisdiction is configured. */
export const NEUTRAL_FILING_TERMS: Readonly<Record<FilingTermKey, FilingTerm>> = {
  sdl:             { label: "Payroll levy returns & payments", description: "Periodic payroll levy — due by the period deadline.", reference: null },
  nssf:            { label: "Social security contributions", description: "Employee and employer social security contributions.", reference: null },
  service_levy:    { label: "Local levy", description: "Levy payable to the local authority.", reference: null },
  paye:            { label: "Payroll tax remittances", description: "Payroll tax deducted and remitted to the tax authority.", reference: null },
  vat:             { label: "Value-added tax returns", description: "Periodic value-added tax returns.", reference: null },
  wht:             { label: "Withholding tax", description: "Withholding tax on payments — remitted to the tax authority.", reference: null },
  thin_cap:        { label: "Thin capitalisation", description: "Interest limitation under the thin-capitalisation rules.", reference: null },
  entertainment:   { label: "Entertainment disallowance", description: "Disallowance of entertainment expenditure.", reference: null },
  management_fee:  { label: "Management fee cap", description: "Cap on deductible management fees.", reference: null },
  presumptive_tax: { label: "Presumptive tax assessment", description: "Presumptive tax assessment.", reference: null },
  penalties:       { label: "Outstanding tax authority penalties", description: "Penalties on unpaid tax — accruing.", reference: null },
  unknown:         { label: "Other statutory finding", description: "Open finding — review and resolve via the Findings panel.", reference: null },
  cit_provisional: { label: "Corporate income tax provisional return", description: "Periodic instalment payments during the fiscal year.", reference: null },
  cit_final:       { label: "Corporate income tax final return", description: "Annual corporate income tax return.", reference: null },
};

/** Jurisdiction overlays. Data only. */
export const JURISDICTION_FILING_TERMS: Readonly<Record<string, Partial<Record<FilingTermKey, FilingTerm>>>> = {
  TZ: {
    sdl:             { label: "SDL Returns & Payments", description: "Monthly 4.5% of gross emoluments — due by last working day of following month.", reference: "Skills & Development Levy Act s.11" },
    nssf:            { label: "NSSF Contributions", description: "Employee + employer NSSF contributions — 10% + 10% of basic salary.", reference: "NSSF Act s.27" },
    service_levy:    { label: "Service Levy", description: "0.3% of annual turnover — payable to local government authority.", reference: "Local Government Finance Act s.6" },
    paye:            { label: "PAYE Remittances", description: "Pay-As-You-Earn — deducted and remitted monthly to the tax authority.", reference: "ITA Cap.332 s.81" },
    vat:             { label: "VAT Returns", description: "Periodic value-added tax returns.", reference: "VAT Act Cap.148" },
    wht:             { label: "Withholding Tax", description: "WHT on service payments, dividends, or interest — remitted to the tax authority.", reference: "ITA Cap.332 s.82" },
    thin_cap:        { label: "Thin Capitalisation (ITA s.12)", description: "Interest limitation under the thin-capitalisation rules.", reference: "ITA Cap.332 s.12" },
    entertainment:   { label: "Entertainment Disallowance", description: "Disallowance of entertainment expenditure.", reference: "ITA Cap.332 s.11(j)" },
    management_fee:  { label: "Management Fee Cap", description: "Cap on deductible management fees.", reference: "ITA Cap.332 s.33" },
    presumptive_tax: { label: "Presumptive Tax Assessment", description: "Presumptive tax assessment.", reference: "ITA Cap.332 s.67" },
    penalties:       { label: "Outstanding Penalties", description: "5% per month on unpaid tax (TAA 2015 s.76) — accruing daily.", reference: "TAA 2015 s.76" },
    unknown:         { label: "Other Statutory Finding", description: "Open finding — review and resolve via the Findings panel.", reference: "ITA Cap.332" },
    cit_provisional: { label: "CIT Provisional Return (ITA s.88)", description: "Quarterly instalment payments — due 3, 6, 9, 12 months after fiscal year start.", reference: "ITA Cap.332 s.88" },
    cit_final:       { label: "CIT Final Return (ITA s.89)", description: "Annual corporate income tax return — due 6 months after fiscal year end.", reference: "ITA Cap.332 s.89" },
  },
};

export function isFilingTermKey(k: string): k is FilingTermKey {
  return k in NEUTRAL_FILING_TERMS;
}

/** The term for a key under the configured jurisdiction (neutral when none is configured or the overlay lacks the key). */
export function filingTerm(jurisdiction: string | null | undefined, key: FilingTermKey): FilingTerm {
  return (jurisdiction ? JURISDICTION_FILING_TERMS[jurisdiction]?.[key] : undefined) ?? NEUTRAL_FILING_TERMS[key];
}
