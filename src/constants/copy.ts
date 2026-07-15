// ─────────────────────────────────────────────────────────────
// SAFF ERP — Marketing Copy
// IRON DOME NUCLEAR SPEC · v3 · LOCKED
//
// §0  THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR ALL MARKETING STRINGS.
//     Edit here. Never hard-code copy in components.
//
// §1  ENGINE NAMES (SAFISHA, HESABU, KINGA, MAONO) MUST NOT APPEAR HERE.
//     Users see professional accounting stage names only.
// ─────────────────────────────────────────────────────────────

export const BRAND = {
  tagline: "Financial Trust Infrastructure",
} as const;

export const CTA = {
  primary:     "Get Started",
  secondary:   "See How It Works",
  primaryHref: "/auth",
} as const;

export const HERO = {
  eyebrow:  "SAFF Platform",
  headline: "Financial Trust Infrastructure",
  subhead:
    "Every financial statement, tax computation, and filing package produced from one verified source of financial truth. No spreadsheets. No estimates. No surprises.",
} as const;

// Accounting lifecycle shown in hero — 7 stages, no engine names, no dead links.
export const PIPELINE = [
  "Upload Data",
  "Reconcile",
  "Statements",
  "Tax",
  "Compliance",
  "Filing",
  "Monitor",
] as const;

// ─────────────────────────────────────────────────────────────
// Platform Capability Table (replaces engine-name table)
// ─────────────────────────────────────────────────────────────

export const PLATFORM_TABLE = [
  {
    module: "Data Preparation",
    name:   "Import & Verify",
    functions: [
      "CSV / XLSX trial balance import with guided field mapping",
      "EFDMS Z-Report reconciliation — VAT and SDL",
      "Duplicate detection and data quality exception queue",
      "Confidence scoring — every account classification is graded",
    ],
    basis: "Income Tax Act Cap.332 s.31 — record-keeping obligations",
  },
  {
    module: "Financial Statements",
    name:   "IFRS Preparation",
    functions: [
      "IAS 1 Statement of Financial Position",
      "IAS 1 Statement of Comprehensive Income",
      "IAS 7 Statement of Cash Flows",
      "IFRS disclosure notes — auto-generated from account mapping",
    ],
    basis: "IFRS as adopted in Tanzania (NBAA Act Cap.286)",
  },
  {
    module: "Tax Computation",
    name:   "Corporate Income Tax",
    functions: [
      "Wear & tear — 6 ITA asset classes, enacted Finance Act 2026 rates",
      "Thin capitalisation limit — ITA s.24A, resident bank exclusion",
      "Minimum tax gate — 3-year loss history (ITA s.65)",
      "Tax loss carry-forward and comparative workpapers",
    ],
    basis: "Income Tax Act Cap.332 + Finance Act 2026",
  },
  {
    module: "Filing Package",
    name:   "TRA Submission",
    functions: [
      "e-Filing readiness checklist (TRA IDRAS)",
      "Tax computation PDF — TRA-accepted format",
      "XBRL instance document generation",
      "Multi-company filing calendar and deadline tracker",
    ],
    basis: "TAA Cap.399 s.38 — return filing obligations",
  },
  {
    module: "Analytics",
    name:   "Portfolio Intelligence",
    functions: [
      "Comparative financial statements — current vs prior period",
      "Variance analysis with configurable materiality thresholds",
      "Cash flow forecast — AR/AP aging plus statutory calendar",
      "Board-pack PDF with management narrative",
    ],
    basis: "IAS 1.38 — comparative information requirements",
  },
] as const;

// ─────────────────────────────────────────────────────────────
// Financial Integrity Guarantees
// ─────────────────────────────────────────────────────────────

export const TRUST_GUARANTEES = [
  "No silent state changes — every transition is recorded with the identity of the actor who made it",
  "Reviewer identity is always read from the authenticated server session — never trusted from the request",
  "Audit and computation records are append-only — no row can be deleted or silently altered",
  "Budget rows are immutable after approval — enforced at the database trigger level, not application code",
  "AI-generated insights carry numeric citations — no unsourced claim is stored",
  "Materiality thresholds are configurable per company — no hardcoded numbers",
  "Management decision engine outputs require explicit human confirmation before any action executes",
] as const;

// ─────────────────────────────────────────────────────────────
// Security Architecture Table
// ─────────────────────────────────────────────────────────────

export const SECURITY_TABLE = [
  {
    constraint: "Session Identity",
    spec: "Every write is bound to a verified firm-member identity from the server session. Client-supplied identity claims are never trusted.",
  },
  {
    constraint: "Firm Isolation",
    spec: "Data access is enforced at the database row level for every table. Firm isolation is structural — it cannot be bypassed by application code.",
  },
  {
    constraint: "Append-only Records",
    spec: "Audit and computation records cannot be deleted or silently altered. Reversals create new rows with full attribution.",
  },
  {
    constraint: "Period Sign-off",
    spec: "Period sign-off requires dual-role enforcement. Locked periods block all upload and recomputation paths.",
  },
  {
    constraint: "Privileged Operations",
    spec: "All privileged database operations are schema-pinned to prevent injection attacks, regardless of how they are invoked.",
  },
  {
    constraint: "API Authentication",
    spec: "Every API call validates the authenticated session token before any database write is permitted.",
  },
] as const;

// ─────────────────────────────────────────────────────────────
// License Terms Table
// ─────────────────────────────────────────────────────────────

export const PRICING_TABLE = [
  { term: "Base",     value: "Annual firm licence — unlimited companies, unlimited periods." },
  { term: "Modules",  value: "All capabilities included. No per-module pricing." },
  { term: "Users",    value: "Unlimited firm members. Role-based access control included." },
  { term: "Storage",  value: "Encrypted at rest. Hosted on enterprise-grade infrastructure." },
  { term: "Updates",  value: "Finance Act updates deployed within 30 days of enactment." },
  { term: "Support",  value: "Implementation support and TRA query assistance included." },
] as const;

// ─────────────────────────────────────────────────────────────
// Pricing Section copy
// ─────────────────────────────────────────────────────────────

export const PRICING_SECTION = {
  headline: "One annual licence. Full platform access.",
  subhead:
    "No per-module fees. No per-company limits. No Finance Act update charges. One price covers the entire firm.",
  cta:     "Get Started",
  ctaHref: "/auth",
} as const;

// ─────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────

export const NAV = [
  { label: "Platform",  href: "#features"   },
  { label: "Integrity", href: "#integrity"  },
  { label: "Security",  href: "#security"   },
  { label: "Pricing",   href: "#pricing"    },
] as const;

// ─────────────────────────────────────────────────────────────
// Upload section (legacy — kept for any residual reference)
// ─────────────────────────────────────────────────────────────

export const UPLOAD_SECTION = {
  headline: "Start with a trial balance",
  subhead:  "CSV, XLS, and XLSX supported. IFRS statements and tax computation in minutes.",
  security: ["AES-256 encrypted storage", "ITA Cap.332 validated output"],
} as const;

export const FOOTER = {
  description: BRAND.tagline,
  legal:       ["Privacy Policy", "Terms of Service"],
} as const;
