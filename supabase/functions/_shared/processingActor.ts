// Who may validate (process) a workspace's trial balance, and as which ledger actor (PR #32, 20260923120000).
//
// The decision is made in the database by tbu_resolve_processing_actor(user, workspace) (service_role only):
//   * an accepted firm member of the workspace        -> actorType "user", firmMemberId set (unchanged boundary);
//   * otherwise the workspace owner, or the holder of an explicit prepare_trial_balance / manage_source_files
//     grant                                             -> actorType "workspace_user", no firm membership at all.
// Anyone else gets no row and is refused. The user is always the JWT-derived id; nothing in the request body is
// read. No firm_members row is ever created or implied for a workspace_user.
//
// Pure (no imports), so the exact mapping is unit-tested in Node (src/lib/workspace/processingActor.test.ts).

export interface WorkspaceUserActor {
  userId: string;
  companyId: string;
  authorityBasis: "workspace_owner" | "explicit_capability";
  authorityCapability: string | null;
}

export type ProcessingActor =
  | { actorType: "user"; firmMemberId: string; userId: string; companyId: string; role: string; authorityBasis: string }
  | ({ actorType: "workspace_user" } & WorkspaceUserActor);

interface ResolverRow {
  actor_type?: unknown;
  firm_member_id?: unknown;
  firm_member_role?: unknown;
  authority_basis?: unknown;
  authority_capability?: unknown;
}

type Rpc = (name: "tbu_resolve_processing_actor", args: { p_user_id: string; p_company_id: string }) =>
  PromiseLike<{ data: unknown; error: unknown }>;

/** Maps the resolver's row to an actor. Anything malformed fails closed (null). */
export function toProcessingActor(row: ResolverRow | null | undefined, userId: string, companyId: string): ProcessingActor | null {
  if (!row || !userId || !companyId) return null;
  const basis = typeof row.authority_basis === "string" ? row.authority_basis : null;
  const capability = typeof row.authority_capability === "string" ? row.authority_capability : null;
  if (row.actor_type === "user" && typeof row.firm_member_id === "string" && row.firm_member_id && basis
      && typeof row.firm_member_role === "string") {
    return { actorType: "user", firmMemberId: row.firm_member_id, userId, companyId, role: row.firm_member_role, authorityBasis: basis };
  }
  if (row.actor_type === "workspace_user" && row.firm_member_id == null
      && (basis === "workspace_owner" || basis === "explicit_capability")) {
    return { actorType: "workspace_user", userId, companyId, authorityBasis: basis, authorityCapability: capability };
  }
  return null;
}

export async function resolveProcessingActor(rpc: Rpc, userId: string, companyId: string): Promise<ProcessingActor | null> {
  if (!userId || !companyId) return null;
  const { data, error } = await rpc("tbu_resolve_processing_actor", { p_user_id: userId, p_company_id: companyId });
  if (error) throw new Error("processing authority could not be resolved");
  const row = (Array.isArray(data) ? data[0] : data) as ResolverRow | undefined;
  return toProcessingActor(row, userId, companyId);
}
