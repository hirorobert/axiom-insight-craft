/**
 * landingContent — the single source of truth for every word rendered on the public
 * landing page (src/pages/Index.tsx and the components under src/components/landing/).
 *
 * Discipline enforced by src/content/landing/__tests__/landingCopyDiscipline.test.ts:
 *   - strict per-item word limits (hero 35, capability 30, process step 30, control 24,
 *     FAQ answer 80, final CTA 25);
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
  "sample-close",
  "capabilities",
  "process",
  "deliverables",
  "commercial",
  "faq",
] as const;

export type LandingSectionId = (typeof LANDING_SECTION_IDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Hero
// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_HERO = {
  eyebrow: "CONTROLLED FINANCIAL CLOSE WORKSPACE",
  headline: "From trial balance to reviewable financial statements.",
  supporting:
    "Import a trial balance, review classification exceptions and prepare framework-aware financial statements with traceable checks and attributable user decisions.",
  primaryCta: { label: "Request access", href: "/request-access" },
  secondaryCta: { label: "Explore a sample close", href: "#sample-close" },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic status preview — illustrative only, no customer information
// ─────────────────────────────────────────────────────────────────────────────

export const SYNTHETIC_PREVIEW = {
  entityLabel: "Entity",
  entity: "Meridian Holdings",
  periodLabel: "Period",
  period: "FY2025",
  frameworkLabel: "Framework",
  framework: "IFRS for SMEs",
  notice: "Illustrative synthetic data—no customer information",
  caption: "Preparation status",
} as const;

export type SyntheticStepState = "completed" | "current";

export interface SyntheticStep {
  readonly index: string;
  readonly title: string;
  readonly detail: string;
  readonly state: SyntheticStepState;
}

export const SYNTHETIC_PREVIEW_STEPS: readonly SyntheticStep[] = [
  { index: "01", title: "Trial balance received", detail: "Source recorded", state: "completed" },
  { index: "02", title: "Two exceptions identified", detail: "Review required", state: "completed" },
  { index: "03", title: "Two review decisions recorded", detail: "Attributed to a named user", state: "completed" },
  { index: "04", title: "Required preparation checks completed", detail: "Preparation status updated", state: "completed" },
  { index: "05", title: "Statements ready for review", detail: "Draft outputs available", state: "current" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Core capabilities
// ─────────────────────────────────────────────────────────────────────────────

export interface LandingCapability {
  readonly index: string;
  readonly title: string;
  readonly description: string;
  /** Plain-language availability note. Never a promise of enforcement. */
  readonly availability: string;
}

export const LANDING_CAPABILITIES: readonly LandingCapability[] = [
  {
    index: "01",
    title: "Preparation and review",
    description:
      "Import a trial balance, screen for duplicate sources, work through graded classification suggestions and record a decision on each account that needs one.",
    availability: "Available on every plan",
  },
  {
    index: "02",
    title: "Close Certification",
    description:
      "Record a preparation certification for a reviewed trial balance once the required checks and outstanding classification decisions are resolved.",
    availability: "Proposed for paid capacity",
  },
  {
    index: "03",
    title: "Reporting Pack",
    description:
      "Prepare framework-aware statements with supporting schedules, then export them for review and circulation outside the workspace.",
    availability: "Proposed for paid capacity",
  },
  {
    index: "04",
    title: "Close Insights",
    description:
      "Compare a reporting period with a prior one: movement, variance and cash indicators, shown where the prior-period data is present.",
    availability: "Proposed for paid capacity",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Controlled-close process
// ─────────────────────────────────────────────────────────────────────────────

export interface LandingProcessStep {
  readonly index: string;
  readonly title: string;
  readonly description: string;
}

export const LANDING_PROCESS: readonly LandingProcessStep[] = [
  {
    index: "01",
    title: "Establish the source",
    description:
      "Import a CSV or XLSX trial balance. A fingerprint is recorded for the file and a repeated source name is flagged before the import is accepted.",
  },
  {
    index: "02",
    title: "Resolve exceptions",
    description:
      "Accounts the workspace cannot classify confidently are held as exceptions. Each waits for a recorded decision before preparation continues.",
  },
  {
    index: "03",
    title: "Prepare outputs",
    description:
      "Framework rules and preparation checks run against the reviewed balances, producing draft statements and supporting schedules for review.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Close Assurance — the baseline control layer, present on every plan
// ─────────────────────────────────────────────────────────────────────────────

export const CLOSE_ASSURANCE_INTRO =
  "Close Assurance is the control layer the workspace applies throughout. It is not a separate product and not a paid upgrade." as const;

export interface AssuranceControl {
  readonly title: string;
  readonly description: string;
}

export const CLOSE_ASSURANCE_CONTROLS: readonly AssuranceControl[] = [
  {
    title: "Controlled access",
    description: "Access decisions are evaluated through authenticated workspace permissions.",
  },
  {
    title: "Workspace separation",
    description: "Workspace access rules separate entity and engagement data.",
  },
  {
    title: "Source-file fingerprinting",
    description: "A SHA-256 fingerprint is recorded for supported trial-balance imports.",
  },
  {
    title: "Attributable decisions",
    description: "Review decisions are associated with authenticated user accounts.",
  },
  {
    title: "Controlled upload lifecycle",
    description: "Uploads follow defined active, replacement, retirement, discard and recovery states.",
  },
  {
    title: "Historical-output protection",
    description: "Supported historical outputs remain readable under defined lifecycle and subscription rules.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Verified deliverables — reachable in the current interface only
// ─────────────────────────────────────────────────────────────────────────────

export interface LandingDeliverable {
  readonly name: string;
  /** How it is reached today: on screen, or exported. */
  readonly access: string;
  /** Export formats reachable from the current interface, or a plain note. */
  readonly formats: string;
  readonly note: string;
}

export const LANDING_DELIVERABLES: readonly LandingDeliverable[] = [
  {
    name: "Statement of financial position",
    access: "On screen and export",
    formats: "XLSX · PDF",
    note: "Prepared from the reviewed trial balance.",
  },
  {
    name: "Statement of profit or loss and other comprehensive income",
    access: "On screen and export",
    formats: "XLSX · PDF",
    note: "Prepared from the reviewed trial balance.",
  },
  {
    name: "Statement of cash flows",
    access: "On screen and export",
    formats: "XLSX · PDF",
    note: "Shown where the required prior-period balances are present.",
  },
  {
    name: "Statement of changes in equity",
    access: "On screen and export",
    formats: "XLSX · PDF",
    note: "Shown where the required opening balances are present.",
  },
  {
    name: "Disclosure notes",
    access: "On screen",
    formats: "Screen only",
    note: "Prepared alongside the statements for review.",
  },
  {
    name: "Account mapping schedule",
    access: "On screen and export",
    formats: "XLSX · CSV",
    note: "Lists each account with its classification and decision state.",
  },
  {
    name: "Preparation check summary",
    access: "On screen",
    formats: "Screen only",
    note: "Lists the preparation checks and their current result.",
  },
  {
    name: "Decision history",
    access: "On screen",
    formats: "Screen only",
    note: "Lists recorded review decisions with their user account.",
  },
  {
    name: "Comparative presentation",
    access: "On screen and export",
    formats: "XLSX · PDF",
    note: "Current against prior period, where a prior period is present.",
  },
  {
    name: "Canonical report data",
    access: "Export",
    formats: "JSON · CSV",
    note: "The structured report data behind a prepared output.",
  },
];

export const LANDING_DELIVERABLES_NOTE =
  "Reporting frameworks selectable today: IFRS for SMEs, IFRS, IPSAS accrual and IPSAS cash. Structured regulatory filing formats are not part of this preview." as const;

// ─────────────────────────────────────────────────────────────────────────────
// Commercial structure — under final enforcement verification
// ─────────────────────────────────────────────────────────────────────────────

export const COMMERCIAL_HEADING = "Commercial structure under final enforcement verification" as const;

export const COMMERCIAL_NOTICE =
  "Entity limits, named-user capacity and self-serve payment activation are undergoing final enforcement verification. This preview is not a public commercial offer." as const;

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
// Final call to action
// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_FINAL_CTA = {
  heading: "Bring greater control to your next financial close.",
  supporting: "Workspaces are activated by our team because online payment is not yet available.",
  primaryCta: { label: "Request access", href: "/request-access" },
  secondaryCta: { label: "Sign in", href: "/auth" },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Footer supporting note
// ─────────────────────────────────────────────────────────────────────────────

export const LANDING_FOOTER_NOTE =
  "CFOCLOSE is a financial close preparation and review workspace. It does not provide an audit, an audit opinion or legal advice." as const;
