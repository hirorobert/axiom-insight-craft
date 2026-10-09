/**
 * landingContent — the single source of truth for every word rendered on the public
 * landing page (src/pages/Index.tsx and the components under src/components/landing/).
 *
 * The commercial structure (approved for the commercial milestone):
 *   Software       Trial balance review — a software subscription sold by agreement and activated manually by our
 *                  team; no online payment. Financial reporting — a pilot by invitation, not generally available, its
 *                  accounting not independently validated.
 *   Plans          capacity, from the reviewed catalogue (prices stay "Proposed"); every action is "Request activation".
 *   Specialist     forecasting, budgeting, financial analysis, accounting policies and close support: enquiries for work
 *                  delivered by people and quoted separately — never presented as automated features.
 *
 * Discipline enforced by src/components/landing/__tests__/landingPage.test.ts:
 *   - strict word limits; no assurance or acquisition vocabulary; no checkout, buy or subscribe wording;
 *   - no internal engine names, no jurisdiction-specific terminology;
 *   - every anchor referenced by navigation exists as a section id below.
 *
 * LANDING_FAQ is also the source the FAQPage structured data in index.html must match exactly (faqStructuredData.test.ts).
 * Nothing here is authority. It describes only what a reviewer can reach in the current interface.
 */

/** Every section id the page renders, and therefore every valid in-page anchor target. */
export const LANDING_SECTION_IDS = [
  "main-content",
  "software",
  "plans",
  "specialist-services",
  "faq",
] as const;

export type LandingSectionId = (typeof LANDING_SECTION_IDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Hero — one proposition, one request
// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_HERO = {
  eyebrow: "Trial balance review software",
  headline: "Check every trial balance before the statements are prepared.",
  supporting:
    "Import a trial balance, run the checks and record a classification decision for every account. Software you operate; it does not prepare, review or audit your accounts for you.",
  primaryCta: { label: "Request activation" },
  secondaryCta: { label: "See the plans", href: "#plans" },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Software — what the subscription includes, and the one pilot
// ─────────────────────────────────────────────────────────────────────────────

export interface LandingServiceOutput {
  readonly name: string;
  /** Formats reachable from the current interface, or "On screen". */
  readonly formats: string;
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
}

/** The software a customer can complete today (src/lib/workspace/moduleAvailability.ts withholds the rest). */
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
  eyebrow: "Software",
  heading: "One subscription, activated by our team.",
  intro: "Every plan includes Trial balance review. Plans differ in capacity.",
  outputsHeading: "What you receive",
  workflowHeading: "How it works",
  seeAll: "See all included outputs",
  includedLabel: "Included in every plan",
  frameworks: "A workspace records its reporting framework: IFRS for SMEs, IFRS, IPSAS accrual or IPSAS cash. Recording a framework does not generate statements.",
} as const;

/** The one pilot. Not for sale, not generally available, and never described as validated. */
export const LANDING_PILOT = {
  name: "Financial reporting",
  label: "Pilot · by invitation",
  text: "Statements, notes and sign-off for IFRS for SMEs are being piloted with selected users. Not generally available. The accounting has not been independently validated.",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Plans — the CAPACITY decision. Every figure is derived from PRICING_CATALOGUE in ./proposedPlans.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_PLANS_COPY = {
  eyebrow: "Plans",
  heading: "Choose your capacity.",
  intro: "Plans differ in how many entities and named users they cover. One 12-month term; pricing shown is proposed.",
  columns: { plan: "Plan", bestFor: "Best for", entities: "Entities", users: "Named users", price: "Proposed price", action: "Action" },
  /** Beside every plan action. */
  activationNote: "Sold by agreement; activated by our team. No online payment.",
  enterpriseAction: "Discuss Enterprise",
  /** Shown instead when the enquiry surface is off: no link, no activation implied. */
  enterpriseUnavailable: "Terms are agreed directly with our team.",
  requestUnavailable: "Plans are activated by our team.",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Specialist services — enquiries, not features
// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_SPECIALIST_COPY = {
  eyebrow: "Specialist services",
  heading: "Work delivered by people, quoted separately.",
  intro: "Ask for a quote. These are not features of the software and are not included in any plan.",
  tag: "Specialist enquiry",
  action: "Ask for a quote",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Trust — three assurances, each in its registered wording (publicClaimRegistry)
// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_TRUST: readonly { readonly title: string; readonly text: string }[] = [
  { title: "Traceable source", text: "A SHA-256 fingerprint is recorded for supported trial-balance imports." },
  { title: "Attributed decisions", text: "Review decisions are associated with authenticated user accounts." },
  { title: "Protected history", text: "Supported historical outputs remain readable under the defined lifecycle and subscription rules." },
];

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
    id: "activation",
    question: "How is a subscription activated?",
    answer:
      "Send an activation request naming the plan you need. We reply by email to agree terms, then activate the plan on the CFOCLOSE account registered to the email address in your request. There is no online payment, and nothing is activated by sending a request.",
  },
  {
    id: "specialist-services",
    question: "Are forecasting, budgeting and the other specialist services part of the software?",
    answer:
      "No. Forecasting, budgeting, financial analysis, accounting policies and close support are delivered by people and quoted separately. They are not features of the software and are not included in any plan.",
  },
  {
    id: "frameworks",
    question: "Which reporting frameworks can be selected?",
    answer:
      "A workspace records its reporting framework: IFRS for SMEs, IFRS, IPSAS accrual or IPSAS cash. Recording a framework does not generate statements. Financial reporting for IFRS for SMEs is a pilot by invitation and is not generally available.",
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
    question: "Is the displayed pricing final?",
    answer:
      "No. The displayed pricing is proposed. The terms of a subscription are agreed with you before it is activated, and there is no online checkout.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Final call to action
// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_FINAL_CTA = {
  heading: "Ready to review your next trial balance?",
  supporting: "Request activation of the plan you need. We reply to agree terms; there is no online payment.",
  primaryCta: { label: "Request activation" },
  secondaryCta: { label: "Sign in", href: "/auth" },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Footer — the disclosures, stated once, at the foot of the page
// ─────────────────────────────────────────────────────────────────────────────

export const COMMERCIAL_NOTICE =
  "Subscriptions are sold by agreement and activated by our team; there is no online checkout. Specialist services are quoted separately. Financial reporting is a pilot and is not generally available." as const;

export const LANDING_FOOTER_NOTE =
  "CFOCLOSE is a trial balance preparation and review workspace. It does not provide an audit, an audit opinion or legal advice." as const;
