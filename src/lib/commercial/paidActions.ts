/**
 * Locked-action presentation for CFO Close paid capabilities. Explanatory only — the database decides
 * (authorize_paid_action, the walls in 20260925100000); a locked screen never replaces the server refusal.
 *
 * Everything here reads STRUCTURED fields only: the JSON returned by get_workspace_commercial_state, the PostgREST
 * error code PT402 with the capability code in `details`, and the Edge Functions' JSON refusal body. Message text is
 * never parsed.
 */
import { CAPABILITIES, canonicalCapability, type CapabilityCode } from "./featureRegistry";
import { ADDITIONAL_SEAT_PRICE, ENTRY_PAID_PLAN, displayCataloguePlanName, formatCatalogueAmount, planByCode } from "./pricingCatalogue";

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

// ── Named-user seats ──────────────────────────────────────────────────────────────────────────────────────────
// Every plan includes one named user; Practice and Firm add purchased seats. The database seat wall decides
// (named_user_seat_wall); these helpers only explain its structured state (get_workspace_seat_capacity,
// accept_workspace_invitations, the invitation function's 402 body). No message text is read.

export interface SeatCapacityState {
  readonly determined: boolean;
  readonly planCode: string | null;
  readonly includedSeats: number | null;
  readonly additionalSeats: number | null;
  readonly allowedNamedUsers: number | null;
  readonly activeNamedUsers: number;
  readonly reservedNamedUsers: number;
  readonly additionalSeatsPurchasable: boolean;
}

const nonNegInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** Strict parse of get_workspace_seat_capacity(); anything malformed or without access → null (fail closed). */
export function parseSeatCapacity(raw: unknown): SeatCapacityState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.access !== true || typeof r.determined !== "boolean") return null;
  const active = nonNegInt(r.active_named_users);
  const reserved = nonNegInt(r.reserved_named_users);
  if (active === null || reserved === null) return null;
  const allowed = nonNegInt(r.allowed_named_users);
  return {
    determined: r.determined && allowed !== null,
    planCode: typeof r.plan_code === "string" ? r.plan_code : null,
    includedSeats: nonNegInt(r.included_seats),
    additionalSeats: nonNegInt(r.additional_seats),
    allowedNamedUsers: r.determined ? allowed : null,
    activeNamedUsers: active,
    reservedNamedUsers: reserved,
    additionalSeatsPurchasable: r.additional_seats_purchasable === true,
  };
}

/** Whether one more person could be invited now. Unknown → false. */
export function canInviteAnother(state: SeatCapacityState | null): boolean {
  return !!state && state.determined && state.allowedNamedUsers !== null && state.reservedNamedUsers < state.allowedNamedUsers;
}

/** Customer copy when no one else can be invited (null when an invitation is possible). */
export function seatCopy(state: SeatCapacityState | null): LockedCopy | null {
  if (canInviteAnother(state)) return null;
  const seat = ADDITIONAL_SEAT_PRICE;
  const seatPrice = `${formatCatalogueAmount(seat.monthlyMinor)} / month or ${formatCatalogueAmount(seat.annualMinor)} / year`;
  if (!state || !state.determined) {
    return {
      title: "Named-user seats need confirming",
      unavailable: "Your plan's named-user seats have not been recorded yet, so no one new can be invited.",
      remains: "Everyone who already has access keeps it.",
      history: "Contact us to confirm the named users in your agreement.",
    };
  }
  if (state.planCode === "FREE") {
    return {
      title: `Available with ${planName(ENTRY_PAID_PLAN)}`,
      unavailable: "The Free plan includes one named user: you. Inviting other people is available with Practice or Firm.",
      remains: `On Practice and Firm, each additional named user is ${seatPrice}.`,
      history: "Everyone who already has access keeps it, and nobody is removed when a plan changes.",
    };
  }
  const plan = displayCataloguePlanName(state.planCode) ?? "current";
  const n = state.allowedNamedUsers ?? 0;
  return {
    title: "All named-user seats are in use",
    unavailable: `Your ${plan} plan has ${n} named ${n === 1 ? "user" : "users"}${
      state.includedSeats !== null && state.additionalSeats !== null ? ` (${state.includedSeats} included + ${state.additionalSeats} additional)` : ""
    }, and every seat is in use or held by a pending invitation.`,
    remains: state.additionalSeatsPurchasable
      ? `Additional named users are ${seatPrice} each. Contact us to add seats.`
      : "Contact us to change the named users in your agreement.",
    history: "Existing members keep their access. Removing a member or a pending invitation frees a seat.",
  };
}

export interface AcceptInvitationsResult {
  readonly accepted: readonly string[];
  readonly blocked: readonly { readonly companyId: string; readonly code: "SEAT_LIMIT_REACHED" | "SEAT_CAPACITY_UNDETERMINED" }[];
}

/** Strict parse of accept_workspace_invitations(); malformed → null. */
export function parseAcceptInvitations(raw: unknown): AcceptInvitationsResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.outcome !== "ok" || !Array.isArray(r.accepted) || !Array.isArray(r.blocked)) return null;
  const accepted = r.accepted.filter((x): x is string => typeof x === "string");
  const blocked: { companyId: string; code: "SEAT_LIMIT_REACHED" | "SEAT_CAPACITY_UNDETERMINED" }[] = [];
  for (const b of r.blocked) {
    const o = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
    if (typeof o.company_id === "string" && (o.code === "SEAT_LIMIT_REACHED" || o.code === "SEAT_CAPACITY_UNDETERMINED")) blocked.push({ companyId: o.company_id, code: o.code });
  }
  return { accepted, blocked };
}

/** The invitation function's structured seat refusal (HTTP 402 body), or null for any other failure. */
export async function functionSeatRefusal(error: unknown): Promise<"seat_limit_reached" | "seat_capacity_undetermined" | null> {
  const ctx = error && typeof error === "object" ? (error as { context?: unknown }).context : undefined;
  if (!ctx || typeof (ctx as { clone?: unknown }).clone !== "function") return null;
  try {
    const body = (await (ctx as Response).clone().json()) as Record<string, unknown>;
    if (body?.capability !== "NAMED_USER_SEATS") return null;
    return body.status === "seat_limit_reached" || body.status === "seat_capacity_undetermined" ? body.status : null;
  } catch {
    return null;
  }
}
