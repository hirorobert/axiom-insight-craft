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
  eyebrow: "TRIAL BALANCE REVIEW",
  headline: "A trial balance you can stand behind.",
  supporting:
    "Upload a trial balance, check it and confirm the classification of every account, with a traceable source and attributed decisions.",
  primaryCta: { label: "Create account", href: "/auth?mode=signup" },
  secondaryCta: { label: "See how it works", href: "#services" },
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

/**
 * Only the service a customer can complete today is described here (src/lib/workspace/moduleAvailability.ts withholds the
 * rest). Withheld services are not kept as copy: they return with their own reviewed wording when their engines are
 * complete.
 */
export const LANDING_SERVICES: readonly LandingService[] = [
  {
    id: "prepare-review",
    name: "Trial balance review",
    outcome: "Upload, check and review the accounts in your trial balance.",
    value: "A reviewed trial balance: checks passed, every classification confirmed, each decision recorded.",
    primaryOutputs: [
      { name: "Trial balance checks", formats: "On screen" },
      { name: "Account review decisions", formats: "On screen" },
      { name: "Reviewed trial balance status", formats: "On screen" },
    ],
    moreOutputs: [],
  },
];

/** The three steps of the one customer workflow (moduleAvailability TRIAL_BALANCE_REVIEW.workflow). */
export const LANDING_WORKFLOW: readonly string[] = [
  "Upload and validate trial balance",
  "Review and confirm account classifications",
  "Trial balance ready for statement preparation",
];

export const LANDING_SERVICES_COPY = {
  eyebrow: "Services",
  heading: "Start with your trial balance.",
  intro: "A plan is required. Every plan includes Trial balance review; plans differ in capacity.",
  outputsHeading: "What you receive",
  workflowHeading: "How it works",
  seeAll: "See all included outputs",
  startPrefix: "Start with",
  signInPrompt: "Already have an account?",
  signInLabel: "Sign in",
  frameworks: "A workspace records its reporting framework: IFRS for SMEs, IFRS, IPSAS accrual or IPSAS cash.",
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
    question: "What does CFOCLOSE do today?",
    answer:
      "CFOCLOSE checks an imported trial balance and holds the accounts that need a classification decision for review, until it is a reviewed trial balance ready for statement preparation. A reviewed trial balance is not reconciled to supporting evidence, audited or approved. It is a preparation and review workspace: the professional using it remains responsible for the conclusions reached.",
  },
  {
    id: "frameworks",
    question: "Which reporting frameworks can be selected?",
    answer:
      "A workspace records its reporting framework: IFRS for SMEs, IFRS, IPSAS accrual or IPSAS cash.",
  },
  {
    id: "professional-judgement",
    question: "Does CFOCLOSE replace professional judgement?",
    answer:
      "No. Classification suggestions are graded, and accounts the workspace cannot resolve confidently are held as exceptions for a recorded decision. Checks report what they find rather than concluding that the accounts are correct. The professional preparing or reviewing the work remains responsible for it.",
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
      "Supported historical outputs remain readable under the defined lifecycle and subscription rules, so work already prepared does not disappear when a paid capacity ends. Preparing new work depends on the capacity then in force.",
  },
  {
    id: "formats",
    question: "Which import formats are currently available?",
    answer:
      "Trial balances import from CSV and XLSX. Checks and review decisions are shown in the workspace.",
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
  heading: "Start with a trial balance you can stand behind.",
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
  "CFOCLOSE is a trial balance preparation and review workspace. It does not provide an audit, an audit opinion or legal advice." as const;
