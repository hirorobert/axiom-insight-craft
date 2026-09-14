export const OUTCOME_STORAGE_KEY = "cfoclose:selected-outcome:v1";

export const OUTCOME_IDS = [
  "clean-trial-balance",
  "prepare-statements",
  "tax-compliance",
  "performance-risk",
  "full-close",
] as const;

export type OutcomeId = (typeof OUTCOME_IDS)[number];

export interface ProductOutcome {
  id: OutcomeId;
  number: string;
  title: string;
  shortTitle: string;
  promise: string;
  input: string;
  deliverable: string;
  scope: string;
  availability: "Workflow available" | "Tanzania workflow" | "Data dependent";
}

export const PRODUCT_OUTCOMES: readonly ProductOutcome[] = [
  {
    id: "clean-trial-balance",
    number: "01",
    title: "Clean and review a trial balance",
    shortTitle: "Trial balance review",
    promise: "Import, structure, balance-check and resolve account-classification exceptions without entering the full close workflow.",
    input: "CSV or XLSX trial balance",
    deliverable: "Reviewed trial balance and exception record",
    scope: "Prepare",
    availability: "Workflow available",
  },
  {
    id: "prepare-statements",
    number: "02",
    title: "Prepare financial statements",
    shortTitle: "Financial statements",
    promise: "Move a reviewed trial balance into framework-aware statements, validation and professional review.",
    input: "Reviewed trial balance and reporting framework",
    deliverable: "Financial statements and validation record",
    scope: "Prepare · Statements · Filing output",
    availability: "Workflow available",
  },
  {
    id: "tax-compliance",
    number: "03",
    title: "Assess tax and compliance",
    shortTitle: "Tax and compliance",
    promise: "Build a controlled tax computation, inspect findings and assemble the evidence needed for professional review.",
    input: "Reviewed trial balance and jurisdiction context",
    deliverable: "Tax workpapers, findings and readiness checklist",
    scope: "Prepare · Tax · Compliance",
    availability: "Tanzania workflow",
  },
  {
    id: "performance-risk",
    number: "04",
    title: "Analyse performance and risk",
    shortTitle: "Performance and risk",
    promise: "Examine comparative movement, material variance, cash outlook and unresolved financial risks from prepared data.",
    input: "Prepared current and comparative financial data",
    deliverable: "Variance, cash and risk review",
    scope: "Prepare · Monitor",
    availability: "Data dependent",
  },
  {
    id: "full-close",
    number: "05",
    title: "Run the complete financial close",
    shortTitle: "Complete financial close",
    promise: "Coordinate the full evidence-led path from trial balance through reconciliation, statements, tax, compliance and final outputs.",
    input: "Trial balance, evidence and engagement context",
    deliverable: "Controlled close file with traceable outputs",
    scope: "Complete workflow",
    availability: "Workflow available",
  },
] as const;

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
