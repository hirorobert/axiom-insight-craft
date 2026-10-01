/**
 * landingContent — the single source of truth for every word rendered on the public
 * landing page (src/pages/Index.tsx and the components under src/components/landing/).
 *
 * Discipline enforced by src/content/landing/__tests__/landingCopyDiscipline.test.ts:
 *   - strict per-item word limits (hero 35, service outcome 30, FAQ answer 80);
 *   - no forbidden claim vocabulary (see FORBIDDEN_LANDING_PHRASES in the test);
 *   - no internal engine names, no jurisdiction-specific terminology;
 *   - every anchor referenced by navigation exists as a section id below.
 *
 * LANDING_FAQ is also the source the FAQPage structured data in index.html must match
 * exactly — parity is asserted by faqStructuredData.test.ts, so the visible answer and
 * the answer offered to a crawler can never drift apart.
 *
 * Nothing here is authority. It describes only capabilities a reviewer can reach in the
 * current interface; anything unproven is either omitted or explicitly marked unverified.
 */

/** Every section id the page renders, and therefore every valid in-page anchor target. */
export const LANDING_SECTION_IDS = [
  "main-content",
  "services",
  "plans",
  "faq",
] as const;

export type LandingSectionId = (typeof LANDING_SECTION_IDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Hero — one proposition, two actions
// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_HERO = {
  eyebrow: "FINANCIAL CLOSE WORKSPACE",
  headline: "From trial balance to reviewable financial statements.",
  supporting:
    "Import a trial balance, resolve the accounts that need a decision, and prepare framework-aware statements you can review, certify and export.",
  primaryCta: { label: "Create account", href: "/auth?mode=signup" },
  secondaryCta: { label: "Choose a service", href: "#services" },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Services — what CFOCLOSE prepares, what each produces, and how it is charged
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "included": part of every plan, never charged separately (Close Assurance / preparation).
 * "paid":     a paid capability (featureRegistry kind "paid"). Every current plan includes all of them.
 * There is no free plan: every service needs a plan (featureRegistry: "included … but never free").
 */
export type LandingServiceTier = "included" | "paid";

export interface LandingServiceOutput {
  readonly name: string;
  /** Formats reachable from the current interface, or "On screen". */
  readonly formats: string;
  /** Condition under which the output appears, when there is one. */
  readonly condition?: string;
}

export interface LandingService {
  readonly id: "preparation" | "certification" | "reporting" | "insights";
  readonly name: string;
  readonly tier: LandingServiceTier;
  readonly tierLabel: string;
  readonly outcome: string;
  readonly outputs: readonly LandingServiceOutput[];
  /** Controls stated in their registered wording (publicClaimRegistry). */
  readonly controls?: readonly string[];
  readonly note?: string;
}

export const LANDING_SERVICES: readonly LandingService[] = [
  {
    id: "preparation",
    name: "Preparation and review",
    tier: "included",
    tierLabel: "Included in every plan",
    outcome:
      "Import a trial balance, screen for duplicate sources and record a decision on each account the workspace cannot classify confidently.",
    outputs: [
      { name: "Account mapping schedule", formats: "XLSX · CSV" },
      { name: "Preparation check summary", formats: "On screen" },
      { name: "Decision history", formats: "On screen" },
    ],
    controls: [
      "A SHA-256 fingerprint is recorded for supported trial-balance imports.",
      "Review decisions are associated with authenticated user accounts.",
    ],
  },
  {
    id: "certification",
    name: "Close Certification",
    tier: "paid",
    tierLabel: "Paid",
    outcome:
      "Record a preparation certification for a reviewed trial balance once the required checks and outstanding classification decisions are resolved.",
    outputs: [{ name: "Preparation certification record", formats: "On screen" }],
    note: "An internal preparation record. It is not an external audit, an audit opinion, or any form of statutory assurance.",
  },
  {
    id: "reporting",
    name: "Reporting Pack",
    tier: "paid",
    tierLabel: "Paid",
    outcome:
      "Prepare framework-aware statements with supporting schedules, then export them for review and circulation outside the workspace.",
    outputs: [
      { name: "Statement of financial position", formats: "XLSX · PDF" },
      { name: "Statement of profit or loss and other comprehensive income", formats: "XLSX · PDF" },
      { name: "Statement of cash flows", formats: "XLSX · PDF", condition: "Where prior-period balances are present" },
      { name: "Statement of changes in equity", formats: "XLSX · PDF", condition: "Where opening balances are present" },
      { name: "Disclosure notes", formats: "On screen" },
      { name: "Comparative presentation", formats: "XLSX · PDF", condition: "Where a prior period is present" },
      { name: "Canonical report data", formats: "JSON · CSV" },
    ],
  },
  {
    id: "insights",
    name: "Close Insights",
    tier: "paid",
    tierLabel: "Paid",
    outcome:
      "Compare a reporting period with a prior one: movement, variance and cash indicators, shown where the prior-period data is present.",
    outputs: [
      { name: "Period movement and variance", formats: "On screen", condition: "Where prior-period data is present" },
      { name: "Cash indicators", formats: "On screen", condition: "Where prior-period data is present" },
    ],
  },
];

export const LANDING_SERVICES_COPY = {
  eyebrow: "Services",
  heading: "Choose what you need to deliver.",
  intro: "Every plan includes all four services. Plans differ in how many entities and named users they cover.",
  outputsHeading: "What you receive",
  plansHeading: "Proposed plan sizes",
  frameworks: "Frameworks: IFRS for SMEs, IFRS, IPSAS accrual and IPSAS cash.",
  comparePlans: { label: "Compare plans in detail", href: "/pricing" },
} as const;

// The proposed plans are derived from the PR #34 commercial catalogue in ./proposedPlans.ts (this module stays data
// only: no imports, no logic).

// ─────────────────────────────────────────────────────────────────────────────
// FAQ — the one source for both the visible copy and the FAQPage structured data
// ─────────────────────────────────────────────────────────────────────────────

export interface LandingFaqEntry {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
}

export const LANDING_FAQ: readonly LandingFaqEntry[] = [
  {
    id: "what-it-prepares",
    question: "What does CFOCLOSE help prepare?",
    answer:
      "CFOCLOSE takes an imported trial balance through classification review and preparation checks, then prepares framework-aware financial statements and supporting schedules for review. It is a preparation and review workspace: the professional using it remains responsible for the conclusions reached and for anything filed outside the workspace.",
  },
  {
    id: "frameworks",
    question: "Which reporting frameworks can be selected?",
    answer:
      "A workspace can be set to IFRS for SMEs, IFRS, IPSAS accrual or IPSAS cash. The selected framework governs how prepared statements are presented and which preparation checks apply. Jurisdiction-specific tax capabilities appear only in a workspace where that jurisdiction has been configured.",
  },
  {
    id: "professional-judgement",
    question: "Does CFOCLOSE replace professional judgement?",
    answer:
      "No. Classification suggestions are graded, and accounts the workspace cannot resolve confidently are held as exceptions for a recorded decision. Preparation checks report what they find rather than concluding that a set of statements is correct. The professional preparing or reviewing the work remains responsible for it.",
  },
  {
    id: "attribution",
    question: "How are preparation decisions attributed?",
    answer:
      "Review decisions are associated with the authenticated user account that recorded them. CFOCLOSE does not replace an organization's responsibility to define its own approval and professional-review policies.",
  },
  {
    id: "lapsed-subscription",
    question: "What happens to supported historical outputs after a subscription lapses?",
    answer:
      "Supported historical outputs remain readable under the defined lifecycle and subscription rules, so work already prepared does not disappear when a paid capacity ends. Preparing new outputs and exporting again depend on the capacity then in force.",
  },
  {
    id: "formats",
    question: "Which import and export formats are currently available?",
    answer:
      "Trial balances import from CSV and XLSX. Prepared outputs are viewed in the workspace and exported as XLSX, PDF, CSV and structured JSON. Structured regulatory filing formats are not part of this preview.",
  },
  {
    id: "close-certification",
    question: "What is Close Certification?",
    answer:
      "Close Certification records that a reviewed trial balance has passed the required preparation checks and that its outstanding classification decisions were resolved. It is an internal preparation record kept inside the workspace. It is not an external audit, an audit opinion, or any form of statutory assurance.",
  },
  {
    id: "pricing-status",
    question: "Is the displayed pricing already available?",
    answer:
      "No. The plan structure shown is proposed and is undergoing final enforcement verification. Self-serve payment is switched off: there is no online checkout, plans are activated by our team, and nothing on this page can be purchased. Treat it as a preview, not a commercial offer.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// The one closing action — rendered at the foot of the service chooser
// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_FINAL_CTA = {
  heading: "Ready when your next close is.",
  supporting: "Plans are activated by our team. Online payment is not available yet.",
  primaryCta: { label: "Create account", href: "/auth?mode=signup" },
  secondaryCta: { label: "Sign in", href: "/auth" },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Footer — the disclosures, stated once, at the foot of the page
// ─────────────────────────────────────────────────────────────────────────────

export const COMMERCIAL_NOTICE =
  "Entity limits, named-user capacity and self-serve payment activation are undergoing final enforcement verification. This preview is not a public commercial offer." as const;

export const LANDING_FOOTER_NOTE =
  "CFOCLOSE is a financial close preparation and review workspace. It does not provide an audit, an audit opinion or legal advice." as const;
