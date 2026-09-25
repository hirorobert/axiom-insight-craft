// Named-user activity for Edge Functions that check workspace membership with the SERVICE ROLE (20260925110000).
//
// The service role bypasses RLS, so a membership row alone no longer proves access: a person whose account is over
// its named-user allowance, or who is billing-suspended, keeps their membership row (history, attribution) but is
// not an active named user. named_user_access_active(workspace, user) is the database's answer. Anything other than
// an explicit `true` fails closed. Callers return the SAME 403 an outsider gets, so a suspended person learns
// nothing more than an unrelated user would. Unit-tested in src/lib/commercial/paidAction.test.ts.

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

/** Workspace capabilities (20260925140000): the authority is the stored capability, never a job title. */
export type WorkspaceCapability = "prepare_close" | "review_close" | "approve_certification" | "issue_reporting_pack" | "manage_members";

/**
 * Does this person hold the workspace capability? (workspace_capability_allowed also requires a current plan for the
 * operational capabilities.) Asked with the service role and the user id from the verified JWT. Fails closed.
 */
export async function hasWorkspaceCapability(rpc: Rpc, companyId: string, userId: string, capability: WorkspaceCapability): Promise<boolean> {
  const { data, error } = await rpc("has_workspace_capability", { p_company_id: companyId, p_user: userId, p_capability: capability });
  return !error && data === true;
}

export async function isNamedUserActive(rpc: Rpc, companyId: string, userId: string): Promise<boolean> {
  if (!companyId || !userId) return false;
  const { data, error } = await rpc("named_user_access_active", { p_company_id: companyId, p_user: userId });
  return !error && data === true;
}
