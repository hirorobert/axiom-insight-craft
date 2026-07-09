// ─────────────────────────────────────────────────────────────
// SAFF ERP — Marketing Copy
// IRON DOME NUCLEAR SPEC · v1 · LOCKED
//
// §0  THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR ALL MARKETING STRINGS.
//     Edit here. Never hard-code copy in components.
// ─────────────────────────────────────────────────────────────

export const BRAND = {
  tagline: "Audit-Ready FS & Tax Reporting",
} as const;

export const CTA = {
  primary: "Upload Trial Balance", // THE ONLY label for the start action
  secondary: "See How It Works",
} as const;

export const HERO = {
  eyebrow: BRAND.tagline,
  headline: "Tanzania Tax Compliance, Automated",
  // Statutory citations deliberately removed from first-visit copy.
  subhead:
    "Upload a trial balance. SAFF ERP validates it, classifies every account, computes corporate income tax, and surfaces compliance findings — in seconds.",
} as const;

export const FEATURES = {
  sectionKicker: "What SAFF ERP does",
  sectionSub: "Four engines. Each one does exactly what it says.",
  items: [
    {
      title: "Trial Balance Validation",
      summary:
        "Upload your trial balance. SAFF ERP checks that debits equal credits, classifies every account, and validates the balance sheet equation — before anything else runs.",
      detail:
        "Auto-classification of 46+ account types · Assets = Liabilities + Closing Equity · Imbalance detected to TZS 1",
    },
    {
      title: "Corporate Tax Computation",
      summary:
        "Computes your company's income tax from the mapped accounts — covering depreciation add-backs, interest deduction limits, and the minimum tax gate.",
      detail:
        "All 6 ITA asset classes (37.5% to 5% SL) · Thin capitalisation: resident bank exclusion applied · Minimum tax gate: 3-year loss history (ITA s.65)",
    },
    {
      title: "Compliance Findings",
      summary:
        "Kinga scans your accounts and surfaces compliance gaps — payroll levies, employer contributions, and TRA exposure items — with the amount at risk in TZS.",
      detail:
        "SDL, PAYE, service levy checks · TRA exposure quantified in TZS · Evidence-linked findings trail",
    },
    {
      title: "Comparative Analysis",
      summary:
        "Link two fiscal years and generate a side-by-side comparative income statement and balance sheet with retained earnings movement.",
      detail:
        "Current vs prior year side-by-side · RE reconciliation per IAS 1.106 · ECL and AMT risk flags",
    },
  ],
} as const;

export const UPLOAD_SECTION = {
  headline: CTA.primary,
  subhead: "Drag and drop, or browse. CSV, XLS, and XLSX supported.",
  security: ["AES-256 encrypted storage", "ITA Cap.332 validated output"],
} as const;

export const FOOTER = {
  description: BRAND.tagline,
  legal: ["Privacy Policy", "Terms of Service"],
  // "Data stored on Supabase" — REMOVED (vendor name must not appear in footer)
} as const;
