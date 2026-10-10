/**
 * landingContent — the single source of truth for every word rendered on the public
 * landing page (src/pages/Index.tsx and the components under src/components/landing/).
 *
 * The commercial structure:
 *   Software       Trial balance review — a 12-month software subscription. Financial reporting — a pilot by invitation,
 *                  not generally available, its accounting not independently validated.
 *   Plans          capacity, from the reviewed catalogue. What each plan card says about price and payment is decided by
 *                  the server at runtime (src/lib/commercial/planOffers.ts): a price the team has approved and online
 *                  payment that is open → the price and "Choose <plan>"; otherwise the catalogue figure marked "Proposed"
 *                  and "Request activation". Every sentence below is therefore true in BOTH states.
 *   Specialist     forecasting, budgeting, financial analysis, accounting policies and close support: enquiries for work
 *                  delivered by people and quoted separately — never presented as automated features.
 *
 * Discipline enforced by src/components/landing/__tests__/landingPage.test.ts:
 *   - strict word limits; no assurance or acquisition vocabulary; no "buy now", "subscribe" or trial wording;
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
// Hero — one proposition, one primary action (the plans), one product screenshot
// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_HERO = {
  eyebrow: "Trial balance review software",
  headline: "Check every trial balance before the statements are prepared.",
  supporting:
    "Import a trial balance, run the checks and record a classification decision for every account. The software performs the checks and records the decisions; professional judgement stays with you.",
  primaryCta: { label: "Explore plans", href: "#plans" },
  secondaryCta: { label: "Request activation" },
  /** A genuine screenshot of the product (local real-application run), with a fictitious demonstration company. */
  screenshot: {
    src: "/landing/trial-balance-review.png",
    width: 1280,
    height: 900,
    alt: "The CFOCLOSE trial balance page for a demonstration company: reviewed status, debit and credit totals of 64,400.00 that agree, and the list of trial balance checks, all passed.",
    caption: "Product screenshot · a reviewed trial balance · demonstration company and figures",
  },
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
  heading: "One subscription for trial balance review.",
  intro: "Every plan includes Trial balance review. Plans differ in capacity.",
  /** What goes in and what comes out — only what the current interface does. */
  formats: "Imports trial balances from CSV and XLSX files exported from your accounting system; there is no direct connection to accounting systems. Checks, account decisions and the reviewed status are shown in the workspace.",
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
  intro: "Plans differ in how many entities and named users they cover. Every plan is a 12-month term and does not renew automatically.",
  columns: { plan: "Plan", bestFor: "Best for", entities: "Entities", users: "Named users", price: "Price per year", action: "Action" },
  /** Stated once, under the table, when a plan is shown with a proposed price. */
  activationNote: "A price marked Proposed is confirmed with you before our team activates the plan.",
  /** Stated once, under the table, when a plan can be paid online. */
  onlineNote: "Paid plans start once the payment is verified. Card payments are processed by our merchant of record, which may add sales tax; the total is shown before you pay.",
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
      "Choose a plan. Where online payment is open for it, pay by card or by mobile money (M-Pesa, Airtel Money, Mixx by Yas or Halotel); the plan starts when the payment is verified, not when you return from the payment page. Otherwise send an activation request naming the plan: we reply by email to agree terms, then activate it on your CFOCLOSE account; nothing is activated by sending a request.",
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
      "Amounts marked Proposed are not final; they are confirmed with you before the plan is activated. An amount shown without that mark is what a 12-month term costs. Any sales tax added to a card payment is shown before you pay.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Final call to action
// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_FINAL_CTA = {
  heading: "Ready to review your next trial balance?",
  supporting: "Choose the plan that fits your entities and users, or ask us to activate one for you.",
  primaryCta: { label: "Explore plans", href: "#plans" },
  secondaryCta: { label: "Sign in", href: "/auth" },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Footer — the disclosures, stated once, at the foot of the page
// ─────────────────────────────────────────────────────────────────────────────

export const COMMERCIAL_NOTICE =
  "Plans run for 12 months and do not renew automatically. Specialist services are quoted separately and are not included in any plan. Financial reporting is a pilot and is not generally available." as const;

export const LANDING_FOOTER_NOTE =
  "CFOCLOSE is a trial balance preparation and review workspace. It does not provide an audit, an audit opinion or legal advice." as const;
