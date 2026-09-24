// Paid-action gate for Edge Functions (CFO Close capabilities, 20260925100000).
//
// The database is the authority: authorize_paid_action_for_user(user, workspace, capability) combines the verified
// user (from the JWT, never the request body), workspace access (creator, accepted member or active grant — never
// an occupational title) and the WORKSPACE account's entitlement. This module only asks it and turns the structured
// answer into a stable, non-sensitive HTTP refusal. Pure except for the injected rpc; unit-tested in Node
// (src/lib/commercial/paidAction.test.ts).

export const PAID_CAPABILITIES = ["STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS"] as const;
export type PaidCapability = (typeof PAID_CAPABILITIES)[number];

export interface PaidActionRefusal {
  httpStatus: 401 | 402 | 403 | 500;
  body: { status: string; error: string; capability: PaidCapability; required_plan?: string; message: string };
}

const MESSAGES: Record<PaidCapability, string> = {
  STATEMENT_CERTIFICATION: "Creating a certified close is available with Practice. Preparation and preview remain available.",
  REPORTING_PACK_EXPORT: "Issuing a formal Reporting Pack is available with Practice. Statement preview remains available.",
  CLOSE_INSIGHTS: "Close Insights analysis is available with Practice. Validation and readiness checks remain available.",
};

/** Maps the authority's answer to a refusal, or null when the action may proceed. Anything unexpected fails closed. */
export function paidActionRefusal(capability: PaidCapability, answer: unknown): PaidActionRefusal | null {
  const a = (answer && typeof answer === "object" ? answer : {}) as { allowed?: unknown; code?: unknown; required_plan?: unknown };
  if (a.allowed === true && a.code === "ALLOWED") return null;
  switch (a.code) {
    case "ENTITLEMENT_REQUIRED":
      return { httpStatus: 402, body: { status: "entitlement_required", error: "Entitlement Required", capability,
        required_plan: typeof a.required_plan === "string" ? a.required_plan : "PRACTICE", message: MESSAGES[capability] } };
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
