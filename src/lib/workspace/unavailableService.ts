/**
 * unavailableService — an EXISTING open engagement whose every granted service is withheld from customers
 * (moduleAvailability.ts), e.g. a historical Tax-only engagement. It is modelled as what it is: an existing company with
 * an open engagement whose service is currently unavailable — never as "no engagement" and never as archived.
 *
 * The one offered remedy is explicit and user-initiated: add Trial balance review (FINANCIAL_STATEMENTS) to THAT SAME
 * engagement through the existing authorized server command `grant_engagement_capability`. No new engagement, no other
 * period, no change to the historical mandate (the grant is an appended event). The server decides authority and plan;
 * the browser only narrows (reviewActionGate) and confirms the result by an authoritative re-read (fold_engagement_mandate).
 */
import type { EngagementCapability } from "./mandate";
import { isEngagementWithheld } from "./moduleAvailability";
import type { RpcClient } from "./workspaceSetupClient";
import type { MyWorkspaceCapabilities } from "@/lib/auth/workspaceCapabilities";

export interface UnavailableServiceEngagement {
  engagementId: string;
  companyId: string;
  companyName: string;
  periodYear: number;
}

interface Partitionable {
  engagementId: string;
  companyId: string;
  companyName: string;
  periodYear: number;
  capabilities: EngagementCapability[];
}

/** Splits resolved open engagements into visible ones and unavailable-service ones. Pure; order preserved. */
export function partitionEngagements<T extends Partitionable>(resolved: readonly T[]): { visible: T[]; unavailable: UnavailableServiceEngagement[] } {
  const visible: T[] = [];
  const unavailable: UnavailableServiceEngagement[] = [];
  for (const e of resolved) {
    if (isEngagementWithheld(e.capabilities)) {
      unavailable.push({ engagementId: e.engagementId, companyId: e.companyId, companyName: e.companyName, periodYear: e.periodYear });
    } else visible.push(e);
  }
  return { visible, unavailable };
}

/** Where Trial balance review starts for this SAME entity and period. */
export function trialBalanceReviewPath(u: Pick<UnavailableServiceEngagement, "companyId" | "periodYear">): string {
  return `/workspace/${u.companyId}/${u.periodYear}/prepare`;
}

// ── Permission-aware presentation (narrowing only; the server still decides) ───────────────────────────────────────

/** Adding a service is a `review_close` write (open_engagement_with_scope / assert_engagement_write_authority). */
export const REVIEW_ACTION_CAPABILITY = "review_close" as const;

export type ReviewActionGate =
  | { state: "checking"; reason: string }
  | { state: "allowed" }
  | { state: "blocked"; reason: string };

export const GATE_COPY = {
  checking: "Checking your access…",
  unknown: "We couldn't confirm your access to this company. Reload to try again.",
  noAccess: "You don't have access to this company.",
  noPlan: "This company's account has no current plan, so new work can't start.",
  noPermission: "Your access doesn't include starting services for this company. Ask the workspace owner.",
} as const;

/** Loading never implies permission; an unknown or malformed answer is treated as not permitted. */
export function reviewActionGate(loading: boolean, caps: MyWorkspaceCapabilities | null | undefined): ReviewActionGate {
  if (loading) return { state: "checking", reason: GATE_COPY.checking };
  if (!caps) return { state: "blocked", reason: GATE_COPY.unknown };
  if (!caps.access) return { state: "blocked", reason: GATE_COPY.noAccess };
  if (!caps.held.includes(REVIEW_ACTION_CAPABILITY)) return { state: "blocked", reason: GATE_COPY.noPermission };
  if (caps.hasCurrentPlan !== true || !caps.allowed.includes(REVIEW_ACTION_CAPABILITY)) return { state: "blocked", reason: GATE_COPY.noPlan };
  return { state: "allowed" };
}

// ── The command ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type AddReviewOutcome =
  | { ok: true }
  | { ok: false; kind: "NOT_AUTHORISED" | "PLAN_REQUIRED" | "UNAVAILABLE" | "UNCONFIRMED" | "UNKNOWN"; message: string };

export const ADD_REVIEW_REASON = "Trial balance review added from the account home";
/** SQLSTATE restrict_violation — grant_engagement_capability's "already part of this engagement" refusal. */
const ALREADY_GRANTED = "23001";

async function confirmGranted(client: RpcClient, engagementId: string): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("fold_engagement_mandate", { p_engagement_id: engagementId });
    if (error || !Array.isArray(data)) return false;
    return (data as { capability?: unknown; granted?: unknown }[]).some((r) => r.capability === "FINANCIAL_STATEMENTS" && r.granted === true);
  } catch {
    return false;
  }
}

/**
 * Explicit, user-selected grant on the existing engagement. Success — including an "already granted" answer from a
 * repeat or concurrent request — is reported ONLY after an authoritative re-read confirms FINANCIAL_STATEMENTS.
 * Every other error stays an error.
 */
export async function addTrialBalanceReview(client: RpcClient, engagementId: string): Promise<AddReviewOutcome> {
  let res: Awaited<ReturnType<RpcClient["rpc"]>>;
  try {
    res = await client.rpc("grant_engagement_capability", {
      p_engagement_id: engagementId,
      p_capability: "FINANCIAL_STATEMENTS",
      p_reason: ADD_REVIEW_REASON,
    });
  } catch {
    return { ok: false, kind: "UNKNOWN", message: "Could not reach the server. Try again." };
  }
  const code = res.error?.code ?? "";
  if (!res.error || code === ALREADY_GRANTED) {
    return (await confirmGranted(client, engagementId))
      ? { ok: true }
      : { ok: false, kind: "UNCONFIRMED", message: "We couldn't confirm Trial balance review was added. Reload to check." };
  }
  if (code === "PT402") return { ok: false, kind: "PLAN_REQUIRED", message: GATE_COPY.noPlan };
  if (code === "42501") return { ok: false, kind: "NOT_AUTHORISED", message: GATE_COPY.noPermission };
  if (code === "PT422") return { ok: false, kind: "UNAVAILABLE", message: "Trial balance review is not available for this engagement right now." };
  return { ok: false, kind: "UNKNOWN", message: "Trial balance review could not be added. Try again." };
}

/**
 * One request at a time: while a call is in flight, further calls (repeated clicks) return `null` without calling `fn`.
 * A failure releases the guard so the user can retry.
 */
export function singleFlight<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R | null> {
  let busy = false;
  return async (...args: A) => {
    if (busy) return null;
    busy = true;
    try {
      return await fn(...args);
    } finally {
      busy = false;
    }
  };
}
