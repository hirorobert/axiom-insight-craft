/**
 * unavailableService — an EXISTING open engagement whose every granted service is withheld from customers
 * (moduleAvailability.ts), e.g. a historical Tax-only engagement. It is modelled as what it is: an existing company with
 * an open engagement whose service is currently unavailable — never as "no engagement" and never as archived.
 *
 * The one offered remedy is explicit and user-initiated: add Trial balance review (FINANCIAL_STATEMENTS) to THAT SAME
 * engagement through the existing authorized server command `grant_engagement_capability`. No new engagement, no other
 * period, no change to the historical mandate (the grant is an appended event). The server decides authority and plan.
 */
import type { EngagementCapability } from "./mandate";
import { isEngagementWithheld } from "./moduleAvailability";
import type { RpcClient } from "./workspaceSetupClient";

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

export type AddReviewOutcome =
  | { ok: true }
  | { ok: false; kind: "NOT_AUTHORISED" | "PLAN_REQUIRED" | "UNAVAILABLE" | "UNKNOWN"; message: string };

export const ADD_REVIEW_REASON = "Trial balance review added from the account home";

/** Explicit, user-selected grant on the existing engagement. Idempotent: an already-granted service counts as success. */
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
  const err = res.error;
  if (!err) return { ok: true };
  const code = err.code ?? "";
  const msg = err.message ?? "";
  // 23001 restrict_violation: "already part of this engagement" — a repeat click or a concurrent success.
  if (code === "23001" || /already part of this engagement/i.test(msg)) return { ok: true };
  if (code === "PT402") return { ok: false, kind: "PLAN_REQUIRED", message: "A current plan is needed to start Trial balance review." };
  if (code === "42501") return { ok: false, kind: "NOT_AUTHORISED", message: "You do not have permission to add a service to this engagement. Ask the workspace owner." };
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
