// Paid-action gate for Edge Functions (CFO Close capabilities, 20260925100000).
//
// The database is the authority: authorize_paid_action_for_user(user, workspace, capability) combines the verified
// user (from the JWT, never the request body), workspace access (creator, accepted member or active grant — never
// an occupational title) and the WORKSPACE account's entitlement. This module only asks it and turns the structured
// answer into a stable, non-sensitive HTTP refusal. Pure except for the injected rpc; unit-tested in Node
// (src/lib/commercial/paidAction.test.ts).

// Every capability an action can need. There is no free plan (20260925130000): Close Assurance and Comparative
// Reporting are included in every plan, and the plan features (filing packs, management letters) come from the one
// plan x capability matrix. Without a current plan every one of them is refused.
export const PAID_CAPABILITIES = [
  "STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS", "CLOSE_ASSURANCE", "COMPARATIVE_REPORTING", "FILING_PACKS", "MANAGEMENT_LETTERS",
] as const;
export type PaidCapability = (typeof PAID_CAPABILITIES)[number];

export interface PaidActionRefusal {
  httpStatus: 401 | 402 | 403 | 500;
  body: { status: string; error: string; capability: PaidCapability; required_plan?: string; message: string };
}

const MESSAGES: Record<PaidCapability, string> = {
  STATEMENT_CERTIFICATION: "Creating a certified close needs a current plan. Existing records remain readable.",
  REPORTING_PACK_EXPORT: "Issuing a formal Reporting Pack needs a current plan. Existing records remain readable.",
  CLOSE_INSIGHTS: "Close Insights analysis needs a current plan. Existing records remain readable.",
  CLOSE_ASSURANCE: "Preparing and validating a close needs a current plan. Existing records remain readable.",
  COMPARATIVE_REPORTING: "Comparative reporting is included in every plan and needs a current plan. Existing records remain readable.",
  FILING_PACKS: "Filing packs need a current plan. Existing records remain readable.",
  MANAGEMENT_LETTERS: "Management letters need a current plan. Existing records remain readable.",
};

/** Maps the authority's answer to a refusal, or null when the action may proceed. Anything unexpected fails closed. */
export function paidActionRefusal(capability: PaidCapability, answer: unknown): PaidActionRefusal | null {
  const a = (answer && typeof answer === "object" ? answer : {}) as { allowed?: unknown; code?: unknown; required_plan?: unknown };
  if (a.allowed === true && a.code === "ALLOWED") return null;
  switch (a.code) {
    case "ENTITLEMENT_REQUIRED":
      return { httpStatus: 402, body: { status: "entitlement_required", error: "Entitlement Required", capability,
        required_plan: typeof a.required_plan === "string" ? a.required_plan : "SOLO", message: MESSAGES[capability] } };
    case "WORKSPACE_ACCESS_DENIED":
      return { httpStatus: 403, body: { status: "workspace_access_denied", error: "Forbidden", capability, message: "You don't have access to this workspace." } };
    case "UNAUTHENTICATED":
      return { httpStatus: 401, body: { status: "unauthenticated", error: "Unauthorized", capability, message: "Sign in to continue." } };
    default:
      return { httpStatus: 500, body: { status: "entitlement_unavailable", error: "Entitlement Unavailable", capability,
        message: "Your plan could not be confirmed right now, so this action was not started. Try again shortly." } };
  }
}

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

/** Asks the database authority. Returns a Response to send back when refused, or null to proceed. */
export async function requirePaidAction(
  rpc: Rpc, userId: string, companyId: string, capability: PaidCapability, corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const { data, error } = await rpc("authorize_paid_action_for_user", { p_user: userId, p_company_id: companyId, p_capability: capability });
  const refusal = paidActionRefusal(capability, error ? null : data);
  if (!refusal) return null;
  return new Response(JSON.stringify(refusal.body), { status: refusal.httpStatus, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

/** For scheduled, system-initiated work with no user: is the workspace's account entitled? Fails closed. */
export async function workspaceEntitled(rpc: Rpc, companyId: string, capability: PaidCapability): Promise<boolean> {
  const { data, error } = await rpc("workspace_capability_entitled", { p_company_id: companyId, p_capability: capability });
  return !error && data === true;
}

/**
 * Same gate for functions whose client is bound to the caller's JWT: the database derives the user itself
 * (authorize_paid_action uses auth.uid()), so no user id is passed at all.
 */
export async function requirePaidActionAsCaller(
  rpc: Rpc, companyId: string, capability: PaidCapability, corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const { data, error } = await rpc("authorize_paid_action", { p_company_id: companyId, p_capability: capability });
  const refusal = paidActionRefusal(capability, error ? null : data);
  if (!refusal) return null;
  return new Response(JSON.stringify(refusal.body), { status: refusal.httpStatus, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ── Named-user seats (NAMED_USER_SEATS) ────────────────────────────────────────────────────────────────────────
// Every plan includes one named user; Practice and Firm may add purchased seats. The database seat wall
// (named_user_seat_wall) is the authority; seat_check_for_invitation is asked BEFORE an invitation email is sent
// or an account is created, so an invitation that could never be recorded is never sent.

export interface SeatRefusal {
  httpStatus: number;
  body: { status: string; error: string; capability: "NAMED_USER_SEATS"; message: string };
}

/** Maps seat_check_for_invitation's structured answer to a refusal, or null when the invitation may proceed. */
export function seatRefusal(answer: unknown): SeatRefusal | null {
  const a = (answer && typeof answer === "object" ? answer : {}) as { allowed?: unknown; code?: unknown };
  if (a.allowed === true && (a.code === "ALLOWED" || a.code === "ALREADY_A_NAMED_USER")) return null;
  switch (a.code) {
    case "SEAT_LIMIT_REACHED":
      return { httpStatus: 402, body: { status: "seat_limit_reached", error: "Seat Limit Reached", capability: "NAMED_USER_SEATS",
        message: "Every named-user seat on this plan is in use. Additional named users are available on Practice and Firm. Existing members are not affected." } };
    case "NAMED_USER_SUSPENDED":
      return { httpStatus: 402, body: { status: "named_user_suspended", error: "Named User Suspended", capability: "NAMED_USER_SEATS",
        message: "This person is billing-suspended on this account. The account holder can reactivate them by choosing who is active; a new invitation is not needed." } };
    case "SEAT_CAPACITY_UNDETERMINED":
      return { httpStatus: 402, body: { status: "seat_capacity_undetermined", error: "Seat Capacity Undetermined", capability: "NAMED_USER_SEATS",
        message: "This plan's named-user seats have not been recorded yet, so no one new can be invited. Existing members are not affected." } };
    default:
      return { httpStatus: 500, body: { status: "seat_check_unavailable", error: "Seat Check Unavailable", capability: "NAMED_USER_SEATS",
        message: "Seat availability could not be confirmed right now, so no invitation was sent. Try again shortly." } };
  }
}

/** Asks the database before inviting. Returns a Response to send back when refused, or null to proceed. */
export async function requireSeatForInvitation(
  rpc: Rpc, companyId: string, inviteeUserId: string | null, corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const { data, error } = await rpc("seat_check_for_invitation", { p_company_id: companyId, p_invitee: inviteeUserId });
  const refusal = seatRefusal(error ? null : data);
  if (!refusal) return null;
  return new Response(JSON.stringify(refusal.body), { status: refusal.httpStatus, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

/** A PostgREST error from the seat wall itself (SQLSTATE PT402, DETAIL NAMED_USER_SEATS). Reads structured fields only. */
export function isSeatWallError(error: unknown): boolean {
  const e = (error && typeof error === "object" ? error : {}) as { code?: unknown; details?: unknown };
  return e.code === "PT402" && e.details === "NAMED_USER_SEATS";
}
