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
  primaryHref: "/auth",
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

// ─────────────────────────────────────────────────────────────
// Platform Reference Table (used in Features section 01)
// ─────────────────────────────────────────────────────────────

export const PLATFORM_TABLE = [
  {
    module: "SAFISHA",
    name: "Data Integrity Layer",
    functions: [
      "CSV/XLSX trial balance import with field mapping",
      "EFDMS Z-Report reconciliation (VAT + SDL)",
      "Duplicate detection and exception queue",
      "Confidence score and DQC validation",
    ],
    basis: "Income Tax Act Cap.332 s.31 — record keeping obligations",
  },
  {
    module: "HESABU",
    name: "Statement Engine",
    functions: [
      "IAS 1 Statement of Financial Position",
      "IAS 1 Statement of Comprehensive Income",
      "IAS 7 Statement of Cash Flows",
      "IFRS disclosure notes — auto-generated",
    ],
    basis: "IFRS as adopted in Tanzania (NBAA Act Cap.286)",
  },
  {
    module: "KINGA",
    name: "Tax Computation Engine",
    functions: [
      "ITA s.34 wear & tear — 6 asset classes",
      "ITA s.24A thin capitalisation limit",
      "ITA s.65 minimum tax gate (3-year loss history)",
      "Finance Act 2026 — all enacted rates applied",
    ],
    basis: "Income Tax Act Cap.332 + Finance Act 2026",
  },
  {
    module: "FILING",
    name: "TRA Submission Pack",
    functions: [
      "e-Filing readiness checklist (TRA IDRAS)",
      "Tax computation PDF (TRA format)",
      "XBRL instance document generation",
      "Multi-company filing calendar",
    ],
    basis: "TAA Cap.399 s.38 — return filing obligations",
  },
  {
    module: "MAONO",
    name: "Analytics Engine",
    functions: [
      "Comparative financial statements (current vs prior)",
      "Variance analysis with materiality thresholds",
      "Cash flow forecast (AR/AP aging + statutory calendar)",
      "Board-pack PDF with management narrative",
    ],
    basis: "IAS 1.38 — comparative information requirements",
  },
] as const;

// ─────────────────────────────────────────────────────────────
// Security Architecture Table (used in Features section 03)
// ─────────────────────────────────────────────────────────────

export const SECURITY_TABLE = [
  {
    constraint: "Identity",
    spec: "JWT-derived firm-member identity on every write. Server session only — no trust of request body claims.",
  },
  {
    constraint: "Row-Level Security",
    spec: "Supabase RLS enforced on all tables. Firm isolation is structural — not application-layer configuration.",
  },
  {
    constraint: "Append-only Records",
    spec: "Audit and computation records cannot be deleted or silently altered. Reversals create new rows.",
  },
  {
    constraint: "Sign-off Controls",
    spec: "Period sign-off requires dual role enforcement. Locked periods block all upload and recompute paths.",
  },
  {
    constraint: "SECURITY DEFINER",
    spec: "All privileged functions pin search_path to pg_catalog to block schema injection.",
  },
  {
    constraint: "Edge Function Auth",
    spec: "Every edge function validates the Supabase auth token before any database write.",
  },
] as const;

// ─────────────────────────────────────────────────────────────
// License Terms Table (used in Features section 04)
// ─────────────────────────────────────────────────────────────

export const PRICING_TABLE = [
  { term: "Base",        value: "Annual firm licence — unlimited companies, unlimited periods." },
  { term: "Engines",     value: "All 5 engines included. No per-module pricing." },
  { term: "Users",       value: "Unlimited firm members. Role-based access control included." },
  { term: "Storage",     value: "AES-256 encrypted. Hosted on Supabase infrastructure." },
  { term: "Updates",     value: "Finance Act updates deployed within 30 days of enactment." },
  { term: "Support",     value: "Implementation support and TRA query assistance included." },
] as const;

// ─────────────────────────────────────────────────────────────
// Pricing / CTA section copy (used in Features section 04)
// ─────────────────────────────────────────────────────────────

export const PRICING_SECTION = {
  headline: "One annual licence. Full platform access.",
  subhead:
    "No per-engine fees. No per-company limits. No Finance Act update charges. One price for the whole firm.",
  cta: "Get Started",
  ctaHref: "/auth",
} as const;
