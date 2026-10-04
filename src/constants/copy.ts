import {
  NO_CHECKOUT_NOTICE,
  ENTRY_PAID_PLAN,
  CATALOGUE_CURRENCY,
  annualSavingMinor,
  formatCatalogueAmount,
  planByCode,
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
  tagline: "Trial balance review for accountants, finance teams, and firms.",
} as const;

export const CTA = {
  primary:     "Create account",
  secondary:   "See how it works",
  // No self-serve sign-up reaches a working workspace (there is no free plan and no checkout): the request path.
  primaryHref: "/auth?mode=signup",
} as const;

export const HERO = {
  eyebrow:  "CFOClose · Financial close workspace",
  headline: "From trial balance to decisions you can defend.",
  subhead:
    "Upload, check and review the accounts in your trial balance—inside one controlled workspace.",
} as const;


// Global footing — no jurisdiction-specific statutory citations.
export const HERO_FOOTING =
  "Trial balance preparation and review. Further modules are introduced only after their controls are independently validated.";



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


// TRUST_GUARANTEES was removed with the landing-page rebuild: it was imported by nothing, and its
// wording ("immutable", "always") is the absolute phrasing the public claim registry forbids.
// Substantiated control wording now lives in src/content/landing/landingContent.ts, one claim per
// row in src/content/publicClaimRegistry.ts.



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
        "A workspace records its reporting framework (IFRS or IPSAS).",
    },
    {
      label: "Jurisdiction compliance packs",
      detail:
        "No jurisdiction pack is currently offered to customers. A future pack would apply only within a configured jurisdiction engagement, after independent validation.",
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
// plans and offers seeded by 20260925100000 and 20260925130000. No price is written here or in any component. There is
// no free plan and no trial.
const ENTRY_PLAN = planByCode(ENTRY_PAID_PLAN)!;
export const PRICING = {
  NO_PLAN_NAME:         "No current plan",
  ENTRY_PLAN_NAME:      ENTRY_PLAN.name,
  ENTRY_MONTHLY:        formatCatalogueAmount(ENTRY_PLAN.monthlyMinor!),
  ENTRY_ANNUAL:         formatCatalogueAmount(ENTRY_PLAN.annualMinor!),
  ENTRY_ANNUAL_SAVING:  formatCatalogueAmount(annualSavingMinor(ENTRY_PLAN)!),
  CURRENCY_CODE:        CATALOGUE_CURRENCY.code,
  TAX_DISCLAIMER:       "Applicable taxes, if any, are shown before payment.",
  CHECKOUT_DISABLED_MSG: NO_CHECKOUT_NOTICE,
} as const;


// Pricing section landing-page teaser (links to /pricing for full detail).
export const PRICING_SECTION = {
  headline: "Simple, transparent pricing.",
  subhead:
    "Solo for one entity, Practice and Firm for a portfolio, monthly or annually. Enterprise on request.",
  cta:     "See plans",
  ctaHref: "/pricing",
} as const;

// ─────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────

// Landing-page section anchors. Every href here must match a section id rendered by
// src/pages/Index.tsx — asserted by src/content/landing/__tests__/landingCopyDiscipline.test.ts,
// so a renamed section can never leave a dead navigation link behind.
export const NAV = [
  { label: "Services",  href: "#services" },
  { label: "Plans",     href: "#plans"    },
  { label: "Questions", href: "#faq"      },
] as const;

// UPLOAD_SECTION was removed with the landing-page rebuild: it was imported by nothing and claimed
// "Encrypted storage" (unproven) and "statements in minutes" (a speed promise nothing establishes).
// The public page no longer advertises an upload control at all — importing a trial balance happens
// inside an authenticated workspace.



export const FOOTER = {
  description: BRAND.tagline,
  legal: [
    { label: "Privacy Policy", href: "/privacy" },
    { label: "Terms of Service", href: "/terms" },
  ],
} as const;
