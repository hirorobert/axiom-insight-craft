// ─────────────────────────────────────────────────────────────
// SAFF ERP — Marketing Copy
// IRON DOME NUCLEAR SPEC · v2 · LOCKED
//
// §0  THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR ALL MARKETING STRINGS.
//     Edit here. Never hard-code copy in components.
// ─────────────────────────────────────────────────────────────

export const BRAND = {
  tagline: "Financial Trust Infrastructure",
} as const;

export const CTA = {
  primary: "Upload Trial Balance",   // THE ONLY label for the start action
  secondary: "See How It Works",
} as const;

export const HERO = {
  eyebrow: "SAFF Platform",
  headline: "Financial Trust Infrastructure",
  subhead:
    "Every financial statement, tax computation, filing package, and management decision begins with one verifiable source of financial truth.",
} as const;

export const PIPELINE = [
  "Upload Data",
  "Clean & Reconcile",
  "Validate",
  "Statements",
  "Tax",
  "Filing",
  "Monitor",
  "Decisions",
] as const;

export const FEATURES = {
  sectionKicker: "Financial Missions",
  sectionSub:
    "Each mission runs on a dedicated verification engine. Work flows forward. Nothing is approximated.",
  items: [
    {
      title: "Prepare Financial Statements",
      engine: "Powered by HESABU",
      summary:
        "Upload a trial balance. HESABU validates the balance sheet equation, classifies every account, and produces IFRS-compliant financial statements with full disclosure notes.",
      detail:
        "Auto-classification of 46+ account types · Assets = Liabilities + Closing Equity · Imbalance detected to TZS 1 · IAS 1 disclosure notes auto-generated",
    },
    {
      title: "Compute Corporate Tax",
      engine: "Powered by KINGA",
      summary:
        "KINGA reads the validated accounts and computes income tax — depreciation add-backs, interest deduction limits, minimum tax gate, loss carry-forward — with statutory citations on every line.",
      detail:
        "All 6 ITA asset classes (37.5% to 5% SL) · Thin capitalisation: resident bank exclusion applied · Minimum tax gate: 3-year loss history (ITA s.65) · Finance Act 2026 enacted",
    },
    {
      title: "Assess Compliance Exposure",
      engine: "Powered by KINGA Findings",
      summary:
        "Findings engine scans every account for statutory gaps — SDL, employer contributions, TRA exposure items — and surfaces each risk with the TZS amount and the statutory basis.",
      detail:
        "SDL, PAYE-proxy, service levy checks · TRA exposure quantified in TZS · Evidence-linked findings trail · No silent status changes",
    },
    {
      title: "Analyse Period Performance",
      engine: "Powered by MAONO",
      summary:
        "Link two fiscal years. MAONO generates a comparative income statement and balance sheet, identifies material variances, and surfaces the underlying drivers for management review.",
      detail:
        "Current vs prior year side-by-side · RE reconciliation per IAS 1.106 · ECL and AMT risk flags · Board-pack PDF with narrative",
    },
  ],
} as const;

export const TRUST_GUARANTEES = [
  "No silent state changes — every transition is logged with actor identity",
  "Reviewer identity always from server-side session — never from the request body",
  "Append-only audit records — no row can be deleted or silently altered",
  "Budget rows immutable after approval — enforced at trigger level",
  "AI insights carry numeric citations — no un-sourced claims stored",
  "Materiality thresholds configurable per company — no hardcoded numbers",
  "Scheduled operations write through SECURITY DEFINER only",
  "All SECURITY DEFINER functions pin search_path to block injection",
  "Actions from decision engines require human confirmation — never auto-execute",
] as const;

export const UPLOAD_SECTION = {
  headline: CTA.primary,
  subhead: "Drag and drop, or browse. CSV, XLS, and XLSX supported.",
  security: ["AES-256 encrypted storage", "ITA Cap.332 validated output"],
} as const;

export const FOOTER = {
  description: BRAND.tagline,
  legal: ["Privacy Policy", "Terms of Service"],
} as const;
