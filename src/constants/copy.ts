import {
  ENTRY_PAID_PLAN,
  CATALOGUE_CURRENCY,
  annualSavingMinor,
  formatCatalogueAmount,
  planByCode,
  ADDITIONAL_SEAT_PRICE,
} from "@/lib/commercial/pricingCatalogue";

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
  // Persona-neutral: this platform serves an individual accountant or
  // finance professional closing their own books just as directly as an
  // audit/bookkeeping firm running an engagement for a client — the
  // workflow underneath is identical either way, so the copy must never
  // assume "you work on someone else's accounts."
  tagline: "Financial statement workflow for accountants, finance teams, and firms.",
} as const;

export const CTA = {
  primary:     "Start free",
  secondary:   "See how it works",
  primaryHref: "/auth",
} as const;

export const HERO = {
  eyebrow:  "CFOClose · Financial close workspace",
  headline: "From trial balance to decisions you can defend.",
  subhead:
    "Clean the trial balance, prepare statements, assess tax or analyse risk—inside one controlled workspace that reveals only the work your engagement requires.",
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
    value:  "Scoped workflow",
    detail: "The engagement opens only the stages required for the selected outcome.",
  },
  {
    key:    "Output",
    value:  "Reviewable deliverables",
    detail: "Prepared statements, workpapers, findings and close evidence as applicable.",
  },
] as const;

// Global footing — no jurisdiction-specific statutory citations.
export const HERO_FOOTING =
  "Framework-aware financial preparation. Jurisdiction-specific tax and compliance capabilities are shown only where configured and validated.";

export const METHOD = [
  {
    number: "01",
    title: "Declare the outcome",
    detail: "Choose the deliverable required by the engagement. Unrelated stages remain outside the active path.",
  },
  {
    number: "02",
    title: "Establish the source",
    detail: "Import the trial balance and supporting evidence. Exceptions remain visible until reviewed.",
  },
  {
    number: "03",
    title: "Make controlled decisions",
    detail: "Resolve classifications, review computations and record the professional judgement behind each conclusion.",
  },
  {
    number: "04",
    title: "Issue the deliverable",
    detail: "Produce the applicable statements, workpapers or review outputs with their provenance intact.",
  },
] as const;

export const DELIVERABLES = [
  ["Reviewed trial balance", "Account decisions and unresolved exceptions retained"],
  ["Financial statements", "Framework-aware presentation and validation record"],
  ["Tax workpapers", "Structured computation and supporting evidence"],
  ["Compliance review", "Findings, readiness checks and client summary"],
  ["Performance review", "Comparative movement, variance, cash and risk signals"],
  ["Close file", "A traceable record of source, decisions and produced outputs"],
] as const;

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
      "Structured corporate income-tax workpapers",
      "Wear-and-tear schedules where configured",
      "Evidence-linked findings for professional review",
    ],
    basis: "Jurisdiction packs are enabled per workspace as each is validated",
  },
  {
    module: "Filing Package",
    name:   "Prepared Output",
    functions: [
      "Filing readiness checklist per jurisdiction requirements",
      "Tax computation PDF",
      "Financial statement and disclosure-note export",
      "Multi-company filing calendar and deadline tracker",
    ],
    basis: "Preparation and readiness support; external submission remains outside the platform",
  },
  {
    module: "Analytics",
    name:   "Portfolio Intelligence",
    functions: [
      "Comparative financial statements — current vs prior period",
      "Variance analysis with configurable materiality thresholds",
      "Cash outlook where a completed analysis run is available",
      "Evidence-linked portfolio monitoring",
    ],
    basis: "IAS 1.38 — comparative information requirements",
  },
] as const;

// ─────────────────────────────────────────────────────────────
// Financial Integrity Guarantees
// ─────────────────────────────────────────────────────────────

export const TRUST_GUARANTEES = [
  "Controlled workflow transitions carry actor attribution wherever the server command boundary applies",
  "Reviewer identity is always read from the authenticated server session — never trusted from the request",
  "Commercial and computation transitions use explicit server-side operations rather than browser-supplied authority",
  "Budget rows are immutable after approval — enforced at the database trigger level, not application code",
  "AI-generated insights carry numeric citations — no unsourced claim is stored",
  "Unavailable or unresolved inputs remain visible — the interface does not invent certainty",
  "Management decision engine outputs require explicit human confirmation before any action executes",
] as const;

// ─────────────────────────────────────────────────────────────
// Security Architecture Table
// ─────────────────────────────────────────────────────────────

// The single most important sentence on the marketing site.
// Used as the section H2.
export const SECURITY_HEADLINE =
  "Control belongs at the system boundary, not behind a button.";

export const SECURITY_SUBHEAD =
  "CFOClose treats identity, tenant isolation, evidence and workflow authority as server and database responsibilities. A capability is presented as controlled only after its boundary tests pass.";

export const SECURITY_TABLE = [
  {
    constraint: "Session Identity",
    spec: "Every write is bound to a verified firm-member identity from the server session. Client-supplied identity claims are never trusted.",
  },
  {
    constraint: "Firm Isolation",
    spec: "Workspace access is bound to authenticated membership. Sensitive engine paths remain subject to continuing database-policy verification before production claims are expanded.",
  },
  {
    constraint: "Append-only Records",
    spec: "Audit and computation records cannot be deleted or silently altered. Reversals create new rows with full attribution.",
  },
  {
    constraint: "Period Sign-off",
    spec: "Sign-off is recorded as an explicit workflow event. Final role-separation enforcement is treated as a production activation gate, not a marketing assumption.",
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
        "Framework-aware presentation contexts are supported. The exact IFRS or IPSAS workflow shown to a firm depends on its configured and verified reporting path.",
    },
    {
      label: "Jurisdiction compliance packs",
      detail:
        "Structured corporate income-tax workpapers, wear-and-tear schedules, fiscal-device reconciliation, findings review and filing-readiness support are available within configured jurisdiction engagements. Professional review remains required.",
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

// Pricing copy is DERIVED from the one catalogue (src/lib/commercial/pricingCatalogue.ts), which mirrors the
// plans and offers seeded by 20260925100000. No price is written here or in any component.
const ENTRY_PLAN = planByCode(ENTRY_PAID_PLAN)!;
export const PRICING = {
  FREE_NAME:            "Free",
  ENTRY_PLAN_NAME:      ENTRY_PLAN.name,
  ENTRY_MONTHLY:        formatCatalogueAmount(ENTRY_PLAN.monthlyMinor!),
  ENTRY_ANNUAL:         formatCatalogueAmount(ENTRY_PLAN.annualMinor!),
  ENTRY_ANNUAL_SAVING:  formatCatalogueAmount(annualSavingMinor(ENTRY_PLAN)!),
  CURRENCY_CODE:        CATALOGUE_CURRENCY.code,
  TAX_DISCLAIMER:       "Applicable taxes, if any, are shown before payment.",
  CHECKOUT_DISABLED_MSG: "Self-service upgrades are not open yet. Contact us to upgrade.",
} as const;

export const PRICING_TABLE = [
  { term: "Plans",     value: "Free, Practice, Firm and Enterprise. Plans differ by entity capacity, named users and paid actions." },
  { term: "Named users", value: `Every plan includes 1 named user. Practice and Firm can add named users at ${formatCatalogueAmount(ADDITIONAL_SEAT_PRICE.monthlyMinor)} per user per month or ${formatCatalogueAmount(ADDITIONAL_SEAT_PRICE.annualMinor)} per user per year. Free cannot add users; Enterprise is negotiated.` },
  { term: "Sign-in",   value: "Each named user is one person with their own sign-in, so every action is attributed and audited. Accounts are never shared." },
  { term: "Included",  value: "Every plan includes preparation, validation, statement preview and comparative reporting." },
  { term: "Paid",      value: "Close Certification, Reporting Pack and Close Insights from Practice upwards." },
  { term: "History",   value: "Certified closes, packs and insights you created stay accessible if your plan changes." },
  { term: "Storage",   value: "Encrypted at rest. Hosted on enterprise-grade infrastructure." },
  { term: "Support",   value: "Standard on Practice, priority on Firm, contractual on Enterprise." },
] as const;

// Pricing section landing-page teaser (links to /pricing for full detail).
export const PRICING_SECTION = {
  headline: "Simple, transparent pricing.",
  subhead:
    "Start free. Practice and Firm plans add certified closes, reporting packs and insights, monthly or annually. Enterprise on request.",
  cta:     "See plans",
  ctaHref: "/pricing",
} as const;

// ─────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────

export const NAV = [
  { label: "Outcomes",  href: "#outcomes"  },
  { label: "Method",    href: "#method"  },
  { label: "Controls",  href: "#security"  },
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
