// ─────────────────────────────────────────────────────────────
// CFOClose — Marketing Copy
// Ω3-BRAND · LOCKED
//
// §0  THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR ALL MARKETING STRINGS.
//     Edit here. Never hard-code copy in components.
//
// §1  ENGINE NAMES (SAFISHA, HESABU, KINGA, MAONO) MUST NOT APPEAR HERE.
//     Users see professional accounting stage names only.
//
// §2  Tanzania statutory citations belong inside jurisdiction-scoped
//     workspace context, NOT in global marketing surfaces.
// ─────────────────────────────────────────────────────────────

export const BRAND = {
  name:    "CFOClose",
  domain:  "cfoclose.com",
  tagline: "Financial statement workflow for professional firms.",
} as const;

export const CTA = {
  primary:     "Start free",
  secondary:   "See how it works",
  primaryHref: "/auth",
} as const;

export const HERO = {
  eyebrow:  "CFOClose",
  headline: "Your client's accounts. Review-ready. Every stage traceable.",
  subhead:
    "Move from trial balance to IFRS-oriented financial statements through a controlled workflow with review evidence, audit history and jurisdiction-aware compliance.",
} as const;

// Above-the-fold proof ledger — what goes in, what is enforced, what comes out.
export const HERO_LEDGER = [
  {
    key:    "Input",
    value:  "One trial balance",
    detail: "CSV or XLSX. Balance-checked and duplicate-screened on ingest.",
  },
  {
    key:    "Enforcement",
    value:  "Seven gated stages",
    detail: "Each stage requires evidence before advancing. Nothing moves on unverified data.",
  },
  {
    key:    "Output",
    value:  "Statements and filings",
    detail: "IFRS-oriented financial statements and jurisdiction-specific compliance output.",
  },
] as const;

// Global footing — no jurisdiction-specific statutory citations.
export const HERO_FOOTING =
  "IFRS-oriented reporting workflow available globally. Jurisdiction-specific compliance packs are applied per engagement configuration.";

// Marketing pipeline — 5 steps for public tour, not the 7-stage workspace sequence.
// Do not reference stageMetadata.ts — this is presentation copy only.
export const PIPELINE = [
  "Upload",
  "Review",
  "Reconcile",
  "Report",
  "File",
] as const;

// ─────────────────────────────────────────────────────────────
// Platform Capability Table
// "Basis" column uses capability language, not jurisdiction-specific statute.
// Tanzania statutory detail lives in the workspace, not here.
// ─────────────────────────────────────────────────────────────

export const PLATFORM_TABLE = [
  {
    module: "Data Preparation",
    name:   "Import & Verify",
    functions: [
      "CSV / XLSX trial balance import with guided field mapping",
      "Bank statement and sub-ledger reconciliation",
      "Duplicate detection and data quality exception queue",
      "Confidence scoring — every account classification is graded",
    ],
    basis: "IFRS-oriented classification workflow",
  },
  {
    module: "Financial Statements",
    name:   "IFRS Preparation",
    functions: [
      "Statement of Financial Position (IAS 1)",
      "Statement of Comprehensive Income (IAS 1)",
      "Statement of Cash Flows (IAS 7)",
      "Disclosure notes generated from account mapping",
    ],
    basis: "IFRS / IPSAS framework-aware",
  },
  {
    module: "Tax Computation",
    name:   "Jurisdiction Pack",
    functions: [
      "Wear & tear at jurisdiction-specific asset class rates",
      "Thin capitalisation limit computation",
      "Minimum tax gate with loss carry-forward",
      "Tax workpapers with line-by-line statute tracing",
    ],
    basis: "Jurisdiction pack — Tanzania available; others in validation",
  },
  {
    module: "Filing Package",
    name:   "Submission Ready",
    functions: [
      "Filing readiness checklist per jurisdiction requirements",
      "Tax computation PDF",
      "XBRL instance document generation",
      "Multi-company filing calendar and deadline tracker",
    ],
    basis: "Jurisdiction-specific submission requirements",
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

// The single most important sentence on the marketing site.
// Used as the section H2.
export const SECURITY_HEADLINE =
  "Controls that cannot be bypassed by changing the interface.";

export const SECURITY_SUBHEAD =
  "Critical identity, tenant-isolation, append-only and privileged-operation rules are enforced at the database and server boundary — not merely hidden behind buttons.";

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
// Jurisdiction Coverage Section
// Honest, factual. No claim of unsupported jurisdictions.
// ─────────────────────────────────────────────────────────────

export const JURISDICTION_SECTION = {
  headline: "Jurisdiction coverage",
  items: [
    {
      label: "IFRS-oriented reporting",
      detail:
        "The financial statement workflow — upload, classification, mapping, statements, and comparative analytics — is available globally for firms working under IFRS or IPSAS frameworks.",
    },
    {
      label: "Tanzania compliance pack",
      detail:
        "Full statutory compliance for Tanzania engagements: corporate income tax, wear and tear at ITA rates, thin capitalisation, minimum tax gate, EFDMS reconciliation, TRA filing package and XBRL output.",
    },
    {
      label: "Additional jurisdictions",
      detail:
        "Further jurisdiction packs are introduced only after their rules and controls are independently validated. No jurisdiction pack is activated until it is ready.",
    },
  ],
} as const;

// ─────────────────────────────────────────────────────────────
// Pricing
// ─────────────────────────────────────────────────────────────

// Canonical pricing constants. Arithmetic is verified by regression tests.
// Monthly: USD 49.  Annual: USD 499.  Annual saving vs 12×monthly: USD 89.
// 49 × 12 = 588.  588 − 499 = 89.  These values match commercial_offers
// amount_minor: 4900 (monthly) / 49900 (annual), exponent 2, currency USD.
export const PRICING = {
  FREE_NAME:           "Free",
  PAID_NAME:           "CFOClose Professional",
  MONTHLY_USD:         49,
  ANNUAL_USD:          499,
  ANNUAL_FULL_USD:     588,   // 49 × 12
  ANNUAL_SAVING_USD:   89,    // 588 − 499
  CURRENCY_CODE:       "USD",
  TAX_DISCLAIMER:      "Applicable taxes, if any, are shown before payment.",
  CHECKOUT_DISABLED_MSG: "Secure self-service checkout is being activated.",
} as const;

// Verify arithmetic at module load time (caught at build, not runtime).
const _pricingArithmeticCheck = (() => {
  if (PRICING.MONTHLY_USD * 12 !== PRICING.ANNUAL_FULL_USD)
    throw new Error("PRICING: ANNUAL_FULL_USD must equal MONTHLY_USD × 12");
  if (PRICING.ANNUAL_FULL_USD - PRICING.ANNUAL_USD !== PRICING.ANNUAL_SAVING_USD)
    throw new Error("PRICING: ANNUAL_SAVING_USD must equal ANNUAL_FULL_USD − ANNUAL_USD");
})();
void _pricingArithmeticCheck;

export const PRICING_TABLE = [
  { term: "Licence",   value: "Firm licence — unlimited companies, unlimited periods." },
  { term: "Modules",   value: "All capabilities included. No per-module pricing." },
  { term: "Users",     value: "Unlimited firm members. Role-based access control included." },
  { term: "Storage",   value: "Encrypted at rest. Hosted on enterprise-grade infrastructure." },
  { term: "Updates",   value: "Jurisdiction pack updates deployed promptly after regulatory enactment." },
  { term: "Support",   value: "Implementation support included." },
] as const;

// Pricing section landing-page teaser (links to /pricing for full detail).
export const PRICING_SECTION = {
  headline: "Simple, transparent pricing.",
  subhead:
    "One professional licence covers your entire firm. No per-module fees. No per-company limits. Monthly or annual billing.",
  cta:     "See plans",
  ctaHref: "/pricing",
} as const;

// ─────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────

export const NAV = [
  { label: "Product",   href: "#features"  },
  { label: "Security",  href: "#security"  },
  { label: "Pricing",   href: "/pricing"   },
] as const;

// ─────────────────────────────────────────────────────────────
// Upload section (legacy — kept for any residual reference)
// ─────────────────────────────────────────────────────────────

export const UPLOAD_SECTION = {
  headline: "Start with a trial balance",
  subhead:  "CSV, XLS, and XLSX supported. IFRS-oriented statements in minutes.",
  security: ["Encrypted storage", "Jurisdiction-aware output"],
} as const;

export const FOOTER = {
  description: BRAND.tagline,
  legal: [
    { label: "Privacy Policy", href: "/privacy" },
    { label: "Terms of Service", href: "/terms" },
  ],
} as const;
