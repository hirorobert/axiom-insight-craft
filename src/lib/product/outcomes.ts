export const OUTCOME_STORAGE_KEY = "cfoclose:selected-outcome:v1";

export const OUTCOME_IDS = [
  "clean-trial-balance",
  "prepare-statements",
  "review-statements",
  "tax-compliance",
  "performance-risk",
  "full-close",
] as const;

export type OutcomeId = (typeof OUTCOME_IDS)[number];

/**
 * What kind of source material an outcome is built to accept. Drives client
 * routing and (for "financial_statements") the document-review intake
 * surface rather than the trial-balance upload surface. Never used to infer
 * an accounting conclusion — purely a UI/intake routing signal.
 */
export type OutcomeInputKind = "trial_balance" | "financial_statements";

/**
 * Optional, explicit hint for where the authenticated destination should
 * point once the relevant engagement capability is granted. `null`/absent
 * means "the stage's default screen" — never inferred, only ever a literal
 * value set here. See src/pages/workspace/WorkspaceOverview.tsx for the one
 * place this is consulted.
 */
export type OutcomeRouteIntent = "review-existing-statements";

export interface ProductOutcome {
  id: OutcomeId;
  number: string;
  title: string;
  shortTitle: string;
  promise: string;
  input: string;
  deliverable: string;
  scope: string;
  availability: "Workflow available" | "Data dependent";
  /** Explicit action label for the public selector's CTA — never generic "Select". */
  ctaLabel: string;
  /** What kind of source material this outcome accepts. */
  inputKind: OutcomeInputKind;
  /** Where the authenticated flow should land once capability is granted. */
  routeIntent?: OutcomeRouteIntent;
}

export const PRODUCT_OUTCOMES: readonly ProductOutcome[] = [
  {
    id: "clean-trial-balance",
    number: "01",
    title: "Review a trial balance",
    shortTitle: "Trial balance review",
    promise: "Import, structure, balance-check and resolve account-classification exceptions without entering the full close workflow.",
    input: "CSV or XLSX trial balance",
    deliverable: "Reviewed trial balance and exception record",
    scope: "Prepare",
    availability: "Workflow available",
    ctaLabel: "Review trial balance",
    inputKind: "trial_balance",
  },
  {
    id: "prepare-statements",
    number: "02",
    title: "Prepare financial statements",
    shortTitle: "Financial statements",
    promise: "Build a complete, framework-aware statement set from a reviewed trial balance.",
    input: "Reviewed trial balance or CSV/XLSX trial balance",
    deliverable: "Financial statements, notes and validation record",
    scope: "Prepare · Statements · Filing output",
    availability: "Workflow available",
    ctaLabel: "Prepare statements",
    inputKind: "trial_balance",
  },
  {
    id: "review-statements",
    number: "03",
    title: "Review existing financial statements",
    shortTitle: "Statement review",
    promise: "Upload draft or issued financial statements to check internal consistency, framework coverage, presentation quality and audit readiness.",
    input: "PDF, DOCX, XLSX or iXBRL financial statements",
    deliverable: "Reconciliation findings, disclosure gaps and annotated review report",
    scope: "Statements",
    availability: "Workflow available",
    ctaLabel: "Review statements",
    inputKind: "financial_statements",
    routeIntent: "review-existing-statements",
  },
  {
    id: "tax-compliance",
    number: "04",
    title: "Assess tax and compliance",
    shortTitle: "Tax and compliance",
    promise: "Build a controlled tax computation, inspect findings and assemble the evidence needed for professional review.",
    input: "Reviewed trial balance and jurisdiction context",
    deliverable: "Tax workpapers, findings and readiness checklist",
    scope: "Prepare · Tax · Compliance",
    availability: "Workflow available",
    ctaLabel: "Assess tax and compliance",
    inputKind: "trial_balance",
  },
  {
    id: "performance-risk",
    number: "05",
    title: "Analyse performance and risk",
    shortTitle: "Performance and risk",
    promise: "Examine comparative movement, material variance, cash outlook and unresolved financial risks from prepared data.",
    input: "Prepared current and comparative financial data",
    deliverable: "Variance, cash and risk review",
    scope: "Prepare · Monitor",
    availability: "Data dependent",
    ctaLabel: "Analyse performance",
    inputKind: "trial_balance",
  },
  {
    id: "full-close",
    number: "06",
    title: "Run the complete financial close",
    shortTitle: "Complete financial close",
    promise: "Coordinate the full evidence-led path from trial balance through reconciliation, statements, tax, compliance and final outputs.",
    input: "Trial balance, evidence and engagement context",
    deliverable: "Controlled close file with traceable outputs",
    scope: "Complete workflow",
    availability: "Workflow available",
    ctaLabel: "Run the complete close",
    inputKind: "trial_balance",
  },
] as const;

/**
 * Honest-capability gate (North-Star Phase 2). Extraction and validation for
 * document-based statement review do not exist yet — publicly presenting
 * "Review existing financial statements" as available would claim an
 * operational capability that isn't there. A plain source-code constant,
 * NOT a browser-controlled VITE_ env var: flipping it requires a code
 * change and review, never something a client can toggle, and it carries
 * no commercial or security authority — it only controls whether this one
 * outcome renders in the public selector. The route, StageScopeGate
 * protection and OutcomeId itself all continue to exist regardless of this
 * flag; a visitor with a direct/shared link still reaches an honest
 * "not available yet" boundary, never a working intake screen, while this
 * is false.
 */
export const DOCUMENT_REVIEW_ENABLED = false;

export function isOutcomeId(value: string | null | undefined): value is OutcomeId {
  return !!value && (OUTCOME_IDS as readonly string[]).includes(value);
}

export function getOutcome(value: string | null | undefined): ProductOutcome | null {
  return isOutcomeId(value) ? PRODUCT_OUTCOMES.find((outcome) => outcome.id === value) ?? null : null;
}

export function rememberOutcome(id: OutcomeId): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(OUTCOME_STORAGE_KEY, id);
  } catch {
    // Storage may be unavailable in privacy-restricted browsers. The URL
    // still carries the same intent into authentication.
  }
}

export function readRememberedOutcome(): ProductOutcome | null {
  if (typeof window === "undefined") return null;
  try {
    return getOutcome(window.sessionStorage.getItem(OUTCOME_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function outcomeAuthHref(id: OutcomeId): string {
  return `/auth?mode=signup&intent=${encodeURIComponent(id)}`;
}

/**
 * The outcomes safe to render on the public landing selector. Identical to
 * PRODUCT_OUTCOMES except review-statements is withheld while
 * DOCUMENT_REVIEW_ENABLED is false. PRODUCT_OUTCOMES itself is untouched —
 * getOutcome()/isOutcomeId() still recognize review-statements everywhere
 * else (Auth.tsx's "Selected outcome" recap, WorkspaceOverview's routing),
 * since a previously-shared link or a flipped flag must not orphan
 * already-in-flight state.
 */
export const PUBLIC_PRODUCT_OUTCOMES: readonly ProductOutcome[] = DOCUMENT_REVIEW_ENABLED
  ? PRODUCT_OUTCOMES
  : PRODUCT_OUTCOMES.filter((outcome) => outcome.id !== "review-statements");
