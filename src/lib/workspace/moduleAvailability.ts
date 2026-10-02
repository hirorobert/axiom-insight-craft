/**
 * moduleAvailability — the ONE customer-facing availability boundary for product modules. Pure.
 *
 * The Tax computation module is withheld from every customer-facing surface, and with it the two services that cannot
 * complete without signed Tax output: Compliance review and Filing package (deriveWorkspaceState keeps both locked until
 * a tax computation is signed; those accounting gates are NOT weakened here — the services are withheld instead). Every route, navigation item, service
 * chooser, engagement list, next-action and outcome decision derives from TAX_MODULE_CUSTOMER_VISIBLE through the
 * helpers below; nothing else may hard-code its own check.
 *
 * It fails closed: the value is a reviewed source constant — never an environment variable, a query parameter, browser
 * storage or server data — so no build, deployment or visitor can turn it on. Only a code change can.
 *
 * Presentation and routing only. The backend (edge functions, tables, RPCs, migrations, jurisdiction packs, tax
 * records, entitlements, audit history) is untouched, and this never decides an accounting gate: deriveWorkspaceState
 * still computes the tax mission exactly as before; it is simply never shown or mounted. Tax-related ACCOUNTS (income
 * tax expense, deferred tax, VAT or payroll taxes payable, withholding tax) are accounting data, not this module, and
 * are never filtered here.
 */

import type { EngagementCapability } from "./mandate";
import type { WorkspaceMission } from "./types";
import type { OutcomeId } from "@/lib/product/outcomes";

/** The Tax computation product module. `false`: absent from the customer-facing application. */
export const TAX_MODULE_CUSTOMER_VISIBLE: boolean = false;

const WITHHELD = !TAX_MODULE_CUSTOMER_VISIBLE;

/**
 * Engagement services withheld from customers: Tax computation, and the services whose workflow gates require its
 * signed output (Compliance review, Filing package). Their stages, routes and surfaces follow.
 */
export const CUSTOMER_HIDDEN_CAPABILITIES: ReadonlySet<EngagementCapability> = new Set<EngagementCapability>(
  WITHHELD ? ["TAX_COMPUTATION", "COMPLIANCE_REVIEW", "FILING_PREPARATION"] : [],
);

/** Workspace stages withheld from customers (never listed, never mounted). */
export const CUSTOMER_HIDDEN_STAGES: ReadonlySet<WorkspaceMission> = new Set<WorkspaceMission>(WITHHELD ? ["tax", "compliance", "filing"] : []);

/**
 * Public landing outcomes withheld from customers (never offered, never accepted from a link or storage): the tax and
 * compliance outcome, and the complete close, which promises compliance and filing outputs.
 */
export const CUSTOMER_HIDDEN_OUTCOMES: ReadonlySet<OutcomeId> = new Set<OutcomeId>(WITHHELD ? ["tax-compliance", "full-close"] : []);

/**
 * Surfaces of the withheld services that are rendered on OTHER stages (e.g. Monitor's compliance scorecard, filing
 * calendar and tax payment ledger). One flag, derived — never decided separately.
 */
export const WITHHELD_SERVICE_SURFACES_VISIBLE: boolean = !WITHHELD;

/**
 * Workspace sub-routes (/workspace/:companyId/:periodYear/<segment>) that render the neutral unavailable boundary and
 * never mount or load a module component. Legacy aliases (kinga → tax, issues → compliance) redirect here (App.tsx).
 */
export const WITHHELD_WORKSPACE_ROUTE_SEGMENTS: readonly string[] = [...CUSTOMER_HIDDEN_STAGES];

export function isCapabilityCustomerVisible(cap: EngagementCapability): boolean {
  return !CUSTOMER_HIDDEN_CAPABILITIES.has(cap);
}

export function isStageCustomerVisible(stage: WorkspaceMission): boolean {
  return !CUSTOMER_HIDDEN_STAGES.has(stage);
}

export function isOutcomeCustomerVisible(id: OutcomeId): boolean {
  return !CUSTOMER_HIDDEN_OUTCOMES.has(id);
}

/** The granted services a customer may see. The persisted mandate itself is never changed. */
export function customerVisibleCapabilities(granted: readonly EngagementCapability[]): EngagementCapability[] {
  return granted.filter(isCapabilityCustomerVisible);
}

/**
 * An engagement whose services are ALL withheld (e.g. an existing Tax-only engagement) is withheld as a whole: kept in
 * the database untouched, excluded from active-service lists, and its workspace never mounts. An engagement with no
 * service declared yet is not withheld — it still needs its launchpad.
 */
export function isEngagementWithheld(granted: readonly EngagementCapability[] | null | undefined): boolean {
  return !!granted && granted.length > 0 && customerVisibleCapabilities(granted).length === 0;
}
