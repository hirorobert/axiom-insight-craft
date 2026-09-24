/**
 * Locked-action presentation for CFO Close paid capabilities. Explanatory only — the database decides
 * (authorize_paid_action, the walls in 20260925100000); a locked screen never replaces the server refusal.
 *
 * Everything here reads STRUCTURED fields only: the JSON returned by get_workspace_commercial_state, the PostgREST
 * error code PT402 with the capability code in `details`, and the Edge Functions' JSON refusal body. Message text is
 * never parsed.
 */
import { CAPABILITIES, canonicalCapability, type CapabilityCode } from "./featureRegistry";
import { ENTRY_PAID_PLAN, displayCataloguePlanName, planByCode } from "./pricingCatalogue";

export type PaidCapabilityCode = "STATEMENT_CERTIFICATION" | "REPORTING_PACK_EXPORT" | "CLOSE_INSIGHTS";
export const PAID_ACTIONS: readonly PaidCapabilityCode[] = ["STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS"];

export interface CapabilityAnswer {
  readonly allowed: boolean;
  readonly code: string;
}
export interface WorkspaceCommercialState {
  readonly access: boolean;
  readonly planCode: string | null;
  readonly capabilities: Readonly<Partial<Record<CapabilityCode, CapabilityAnswer>>>;
}

/** Strict parse of get_workspace_commercial_state(); anything malformed → null (callers fail closed). */
export function parseWorkspaceCommercialState(raw: unknown): WorkspaceCommercialState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.access === false) return { access: false, planCode: null, capabilities: {} };
  if (r.access !== true || typeof r.capabilities !== "object" || r.capabilities === null) return null;
  const caps: Partial<Record<CapabilityCode, CapabilityAnswer>> = {};
  for (const [k, v] of Object.entries(r.capabilities as Record<string, unknown>)) {
    const code = canonicalCapability(k);
    if (!code || code !== k || !v || typeof v !== "object") continue;
    const a = v as Record<string, unknown>;
    if (typeof a.allowed !== "boolean" || typeof a.code !== "string") continue;
    caps[code] = { allowed: a.allowed, code: a.code };
  }
  return { access: true, planCode: typeof r.plan_code === "string" ? r.plan_code : null, capabilities: caps };
}

export type PaidActionState =
  | { readonly status: "loading" }
  | { readonly status: "allowed" }
  | { readonly status: "locked"; readonly capability: PaidCapabilityCode; readonly requiredPlan: string }
  | { readonly status: "no_access" }
  | { readonly status: "unknown" };

/** The UI state of one paid action. Only an explicit server "allowed" is allowed; everything else fails closed. */
export function paidActionState(state: WorkspaceCommercialState | null | undefined, capability: PaidCapabilityCode, loading = false): PaidActionState {
  if (loading) return { status: "loading" };
  if (!state) return { status: "unknown" };
  if (!state.access) return { status: "no_access" };
  const a = state.capabilities[capability];
  if (a?.allowed === true && a.code === "ALLOWED") return { status: "allowed" };
  if (a?.code === "ENTITLEMENT_REQUIRED") return { status: "locked", capability, requiredPlan: ENTRY_PAID_PLAN };
  if (a?.code === "WORKSPACE_ACCESS_DENIED") return { status: "no_access" };
  return { status: "unknown" };
}

/**
 * A server refusal for a paid capability, from either boundary:
 *   PostgREST / RPC error   { code: "PT402", details: "<CAPABILITY>" }            (database walls)
 *   Edge Function body      { status: "entitlement_required", capability: "<CAPABILITY>" }
 * Returns the capability, or null when the error is anything else.
 */
export function entitlementRefusal(error: unknown): CapabilityCode | null {
  if (!error || typeof error !== "object") return null;
  const e = error as Record<string, unknown>;
  if (e.code === "PT402" && typeof e.details === "string") return canonicalCapability(e.details);
  if (e.status === "entitlement_required" && typeof e.capability === "string") return canonicalCapability(e.capability);
  return null;
}

export interface LockedCopy {
  readonly title: string;
  readonly unavailable: string;
  readonly remains: string;
  readonly history: string;
}

const planName = (code: string) => planByCode(code)?.name ?? "a paid plan";

/** Customer copy for a locked paid action: what is unavailable, which plan enables it, what remains, what is kept. */
export function lockedCopy(capability: PaidCapabilityCode, requiredPlan: string = ENTRY_PAID_PLAN): LockedCopy {
  const plan = planName(requiredPlan);
  switch (capability) {
    case "STATEMENT_CERTIFICATION":
      return {
        title: "Upgrade to create a certified close",
        unavailable: `Signing off statements and marking a report version final are available with ${plan}.`,
        remains: "Preparation, validation and statement preview remain available.",
        history: "Sign-offs and final versions you already created stay accessible.",
      };
    case "REPORTING_PACK_EXPORT":
      return {
        title: `Available with ${plan}`,
        unavailable: `Issuing a formal ${CAPABILITIES.REPORTING_PACK_EXPORT.name} (PDF, spreadsheet, filing or client pack) is available with ${plan}.`,
        remains: "Preview remains available.",
        history: "Your existing reports remain accessible.",
      };
    case "CLOSE_INSIGHTS":
      return {
        title: `Available with ${plan}`,
        unavailable: `Running new ${CAPABILITIES.CLOSE_INSIGHTS.name} analysis is available with ${plan}.`,
        remains: "Validation, reconciliation and readiness checks remain available.",
        history: "Insights you already generated stay accessible.",
      };
  }
}

export interface CapacityAnswer {
  readonly capacity: number | null;
  readonly used: number | null;
  readonly planCode: string | null;
  readonly determined: boolean;
}

/** Customer copy when a new entity cannot be created (structured outcome of create_entity). */
export function capacityCopy(answer: CapacityAnswer): LockedCopy {
  const plan = displayCataloguePlanName(answer.planCode) ?? "current";
  if (!answer.determined || answer.capacity === null) {
    return {
      title: "Entity capacity needs confirming",
      unavailable: "Your plan's entity capacity has not been recorded yet, so a new entity can't be created.",
      remains: "Every existing entity stays fully accessible.",
      history: "Our team records the capacity agreed in your contract.",
    };
  }
  const n = answer.capacity;
  return {
    title: "Entity limit reached",
    unavailable: `Your ${plan} plan includes ${n} active ${n === 1 ? "entity" : "entities"}${answer.used !== null ? `, and ${answer.used} ${answer.used === 1 ? "is" : "are"} in use` : ""}.`,
    remains: "Every existing entity stays fully accessible. Upgrade, or deactivate an entity you no longer need, to add another.",
    history: "Nothing is deleted, hidden or moved when a plan changes.",
  };
}

/**
 * The structured refusal carried by a failed Edge Function call (supabase.functions.invoke puts the HTTP response on
 * `error.context`). Reads the JSON body's fields only; returns null for any other failure.
 */
export async function functionEntitlementRefusal(error: unknown): Promise<CapabilityCode | null> {
  const ctx = error && typeof error === "object" ? (error as { context?: unknown }).context : undefined;
  if (ctx && typeof (ctx as { clone?: unknown }).clone === "function") {
    try {
      return entitlementRefusal(await (ctx as Response).clone().json());
    } catch {
      return null;
    }
  }
  return entitlementRefusal(error);
}
