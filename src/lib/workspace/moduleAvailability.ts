/**
 * moduleAvailability — the ONE customer-facing availability boundary for product modules. Pure.
 *
 * The customer-facing application exposes exactly one proven workflow: TRIAL BALANCE REVIEW — upload and validate a trial
 * balance, review and confirm its account classifications, and reach a reviewed trial balance ready for statement
 * preparation. Supporting-evidence reconciliation is NOT part of it (it stays the tax gate's prerequisite, enforced by
 * deriveWorkspaceState, and MAONO's, enforced by the server). Everything else is withheld until its authority is complete:
 *
 *   · Statements — statement validation (hesabu-validate) requires a tax computation and is started only from the Tax
 *     panel; the evidence-based FINAL / official-pack workspace is switched off in production; and the server does not
 *     yet recompute what a client submits (SERVER_AUTHORITATIVE_STATEMENT_COMPILER_REQUIRED, CLAUDE.md §9.2).
 *   · Tax computation; Compliance review and Filing package (their gates require signed Tax output).
 *   · Monitoring — the dashboard only reads existing variance runs; nothing in the interface starts one.
 *
 * Every route, navigation item, service chooser, engagement list, next action, public outcome and claim derives from
 * this module; nothing else may hard-code its own check. It fails closed: UNPROVEN_MODULES_CUSTOMER_VISIBLE is a
 * reviewed source constant — never an environment variable, a query parameter, browser storage or server data — so no
 * build, deployment or visitor can turn it on. Only a code change can.
 *
 * Presentation and routing only. The backend (edge functions, tables, RPCs, migrations, jurisdiction packs, records,
 * entitlements, audit history) is untouched, and this never decides an accounting gate: deriveWorkspaceState still
 * computes every mission exactly as before; withheld ones are simply never shown or mounted. FINANCIAL_STATEMENTS stays
 * the authority for Prepare and Reconcile, presented to customers as "Trial balance review". Tax-related ACCOUNTS
 * (income tax expense, deferred tax, VAT or payroll taxes payable, withholding tax) are accounting data, not a module,
 * and are never filtered.
 */

import type { EngagementCapability } from "./mandate";
import type { WorkspaceMission } from "./types";
import type { OutcomeId } from "@/lib/product/outcomes";
import { NOT_AN_APPROVAL, REVIEWED_TRIAL_BALANCE } from "./trialBalanceReadiness";

/** Every module beyond trial balance review. `false`: absent from the customer-facing application. */
export const UNPROVEN_MODULES_CUSTOMER_VISIBLE: boolean = false;

const WITHHELD = !UNPROVEN_MODULES_CUSTOMER_VISIBLE;

/** Engagement services withheld from customers. FINANCIAL_STATEMENTS is kept: it grants Prepare and Reconcile. */
export const CUSTOMER_HIDDEN_CAPABILITIES: ReadonlySet<EngagementCapability> = new Set<EngagementCapability>(
  WITHHELD ? ["TAX_COMPUTATION", "COMPLIANCE_REVIEW", "FILING_PREPARATION", "MONITORING"] : [],
);

/** Workspace stages withheld from customers (never listed, never mounted). Prepare and Reconcile remain. */
export const CUSTOMER_HIDDEN_STAGES: ReadonlySet<WorkspaceMission> = new Set<WorkspaceMission>(
  WITHHELD ? ["statements", "tax", "compliance", "filing", "monitor"] : [],
);

/** Public landing outcomes withheld from customers (never offered, never accepted from a link or storage). */
export const CUSTOMER_HIDDEN_OUTCOMES: ReadonlySet<OutcomeId> = new Set<OutcomeId>(
  WITHHELD ? ["prepare-statements", "review-statements", "tax-compliance", "performance-risk", "full-close"] : [],
);

/** Sign-up service intents withheld from customers. Only "prepare-review" (Trial balance review) remains. */
export const CUSTOMER_HIDDEN_SERVICE_INTENTS: ReadonlySet<string> = new Set<string>(
  WITHHELD ? ["close-certification", "reporting-pack", "close-insights"] : [],
);

/**
 * Surfaces of withheld modules rendered OUTSIDE their own stages (Settings' period sign-off controls, plan-feature
 * lines). One flag, derived — never decided separately.
 */
export const WITHHELD_SERVICE_SURFACES_VISIBLE: boolean = !WITHHELD;

/**
 * Workspace sub-routes (/workspace/:companyId/:periodYear/<segment>) that render the neutral unavailable boundary and
 * never mount or load a module component. Legacy aliases (hesabu → statements, kinga → tax, issues → compliance,
 * analytics → monitor) redirect here (App.tsx).
 */
export const WITHHELD_WORKSPACE_ROUTE_SEGMENTS: readonly string[] = WITHHELD
  ? ["statements", "statements/review", "tax", "compliance", "filing", "monitor"]
  : [];

/** How the one customer service is presented (the capability identity underneath is unchanged). */
export const TRIAL_BALANCE_REVIEW = {
  title: "Trial balance review",
  description: "Upload, check and review the accounts in your trial balance.",
  workflow: ["Upload and validate trial balance", "Review and confirm account classifications", "Trial balance ready for statement preparation"],
  /** The outcome: checks passed and every classification confirmed (trialBalanceReadiness). */
  ready: REVIEWED_TRIAL_BALANCE,
  notApproval: NOT_AN_APPROVAL,
} as const;

export function isCapabilityCustomerVisible(cap: EngagementCapability): boolean {
  return !CUSTOMER_HIDDEN_CAPABILITIES.has(cap);
}

export function isStageCustomerVisible(stage: WorkspaceMission): boolean {
  return !CUSTOMER_HIDDEN_STAGES.has(stage);
}

export function isOutcomeCustomerVisible(id: OutcomeId): boolean {
  return !CUSTOMER_HIDDEN_OUTCOMES.has(id);
}

export function isServiceIntentCustomerVisible(id: string): boolean {
  return !CUSTOMER_HIDDEN_SERVICE_INTENTS.has(id);
}

/** The granted services a customer may see. The persisted mandate itself is never changed. */
export function customerVisibleCapabilities(granted: readonly EngagementCapability[]): EngagementCapability[] {
  return granted.filter(isCapabilityCustomerVisible);
}

/**
 * An engagement whose services are ALL withheld (e.g. an existing Tax-only or Monitoring-only engagement) is withheld
 * as a whole: kept in the database untouched, excluded from active-service lists, and its workspace never mounts. An
 * engagement with no service declared yet is not withheld — it still needs its launchpad.
 */
export function isEngagementWithheld(granted: readonly EngagementCapability[] | null | undefined): boolean {
  return !!granted && granted.length > 0 && customerVisibleCapabilities(granted).length === 0;
}
