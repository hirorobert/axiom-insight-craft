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
  "outputs",
  "plans",
  "faq",
] as const;

export type LandingSectionId = (typeof LANDING_SECTION_IDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Hero — one proposition, two actions
// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_HERO = {
  eyebrow: "FINANCIAL CLOSE WORKSPACE",
  headline: "Close the books. Produce review-ready financial statements.",
  supporting:
    "Import a trial balance, resolve the accounts that need a decision and prepare framework-aware statements, with a traceable source and attributed decisions.",
  primaryCta: { label: "Create account", href: "/auth?mode=signup" },
  secondaryCta: { label: "Explore a sample close", href: "#services" },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Services — the OUTCOME decision (what the customer needs). Plans are a separate decision (capacity) below.
// Identifiers are the closed service-intent registry (src/lib/commercial/serviceIntent.ts); availability labels are
// derived there from the plan × capability matrix, never written here.
// ─────────────────────────────────────────────────────────────────────────────

export interface LandingServiceOutput {
  readonly name: string;
  /** Formats reachable from the current interface, or "On screen". */
  readonly formats: string;
  /** Condition under which the output appears, when there is one. */
  readonly condition?: string;
}

export interface LandingService {
  readonly id: "prepare-review" | "close-certification" | "reporting-pack" | "close-insights";
  readonly name: string;
  /** One sentence: the outcome. */
  readonly outcome: string;
  /** One short business benefit. */
  readonly value: string;
  /** At most three, shown by default. */
  readonly primaryOutputs: readonly LandingServiceOutput[];
  /** Shown only behind "See all included outputs". */
  readonly moreOutputs: readonly LandingServiceOutput[];
  /** A scope statement in registered wording, when the outcome needs one. */
  readonly note?: string;
}

export const LANDING_SERVICES: readonly LandingService[] = [
  {
    id: "prepare-review",
    name: "Prepare & Review",
    outcome: "Turn an imported trial balance into a reviewed one, with a decision recorded on every account that needs one.",
    value: "Statements start from a trial balance you have already reviewed.",
    primaryOutputs: [
      { name: "Account mapping schedule", formats: "XLSX · CSV" },
      { name: "Preparation check summary", formats: "On screen" },
      { name: "Decision history", formats: "On screen" },
    ],
    moreOutputs: [],
  },
  {
    id: "close-certification",
    name: "Close Certification",
    outcome: "Record a preparation certification once the required checks and outstanding classification decisions are resolved.",
    value: "Reviewers can see that preparation was complete before statements were issued.",
    primaryOutputs: [{ name: "Preparation certification record", formats: "On screen" }],
    moreOutputs: [],
    note: "It is not an external audit, an audit opinion, or any form of statutory assurance.",
  },
  {
    id: "reporting-pack",
    name: "Reporting Pack",
    outcome: "Prepare framework-aware statements with supporting schedules, then export them for review and circulation.",
    value: "Statements reach reviewers in the formats they already use.",
    primaryOutputs: [
      { name: "Statement of financial position", formats: "XLSX · PDF" },
      { name: "Statement of profit or loss and other comprehensive income", formats: "XLSX · PDF" },
      { name: "Statement of cash flows", formats: "XLSX · PDF", condition: "Where prior-period balances are present" },
    ],
    moreOutputs: [
      { name: "Statement of changes in equity", formats: "XLSX · PDF", condition: "Where opening balances are present" },
      { name: "Disclosure notes", formats: "On screen" },
      { name: "Comparative presentation", formats: "XLSX · PDF", condition: "Where a prior period is present" },
      { name: "Canonical report data", formats: "JSON · CSV" },
    ],
  },
  {
    id: "close-insights",
    name: "Close Insights",
    outcome: "Compare a reporting period with a prior one: movement, variance and cash indicators.",
    value: "See what moved between periods before the close is reviewed.",
    primaryOutputs: [
      { name: "Period movement and variance", formats: "On screen", condition: "Where prior-period data is present" },
      { name: "Cash indicators", formats: "On screen", condition: "Where prior-period data is present" },
    ],
    moreOutputs: [],
  },
];

export const LANDING_SERVICES_COPY = {
  eyebrow: "Services",
  heading: "Choose your outcome.",
  intro: "A plan is required. Every plan includes all four services; plans differ in capacity.",
  outputsHeading: "What you receive",
  seeAll: "See all included outputs",
  startPrefix: "Start with",
  signInPrompt: "Already have an account?",
  signInLabel: "Sign in",
  frameworks: "Frameworks: IFRS for SMEs, IFRS, IPSAS accrual and IPSAS cash.",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Plans — the CAPACITY decision. Every figure is derived from PRICING_CATALOGUE in ./proposedPlans.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_PLANS_COPY = {
  eyebrow: "Plans",
  heading: "Choose your capacity.",
  intro: "Plans differ in how many entities and named users they cover. One 12-month term; pricing shown is proposed.",
  columns: { plan: "Plan", bestFor: "Best for", entities: "Entities", users: "Named users", price: "Proposed price", action: "Action" },
  choosePrefix: "Choose",
  /** Enterprise is never self-activated: it opens the enquiry page when that surface is enabled. */
  enterpriseAction: "Discuss Enterprise",
  /** Shown instead when the enquiry surface is off: no link, no activation implied. */
  enterpriseUnavailable: "Terms are agreed directly with our team.",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Trust — three assurances, each in its registered wording (publicClaimRegistry)
// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_TRUST: readonly { readonly title: string; readonly text: string }[] = [
  { title: "Traceable source", text: "A SHA-256 fingerprint is recorded for supported trial-balance imports." },
  { title: "Attributed decisions", text: "Review decisions are associated with authenticated user accounts." },
  { title: "Protected history", text: "Supported historical outputs remain readable under the defined lifecycle and subscription rules." },
];

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
      "A workspace can be set to IFRS for SMEs, IFRS, IPSAS accrual or IPSAS cash. The selected framework governs how prepared statements are presented and which preparation checks apply.",
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
// Final call to action
// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_FINAL_CTA = {
  heading: "Bring your financial close under control.",
  supporting: "Plans are activated by our team. Online payment is not available yet.",
  primaryCta: { label: "Create account", href: "/auth?mode=signup" },
  secondaryCta: { label: "View plans", href: "#plans" },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Footer — the disclosures, stated once, at the foot of the page
// ─────────────────────────────────────────────────────────────────────────────

export const COMMERCIAL_NOTICE =
  "Entity limits, named-user capacity and self-serve payment activation are undergoing final enforcement verification. This preview is not a public commercial offer." as const;

export const LANDING_FOOTER_NOTE =
  "CFOCLOSE is a financial close preparation and review workspace. It does not provide an audit, an audit opinion or legal advice." as const;
