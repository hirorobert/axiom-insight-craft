// Server-authoritative Storage cleanup for trial balance upload operations (PR #32).
//
// Pure orchestration with injected dependencies, so the exact decision sequence is unit-tested in Node
// (src/lib/workspace/storageCleanup.test.ts) and runs unchanged in the trial-balance-storage-cleanup Edge
// Function. The rules:
//   * The request carries ONE thing: an opaque operation id. A path, workspace, user, role or deletion claim in
//     the body is refused, never read.
//   * The caller is authenticated from their JWT. Everything else (operation kind and state, workspace, bound
//     Storage path) is resolved server-side from the operation record.
//   * Authority is the single database predicate can_user_act_on_workspace(user, workspace,
//     'manage_source_files'): the workspace owner or an explicit grant. No occupational title, and no
//     firm membership.
//   * Service-role Storage access is used only after authorization, and only on the operation-bound path.
//   * Absence is verified before completion. Completion runs AS THE CALLER, so the database re-checks authority
//     and re-reads Storage itself. Every failure leaves a recoverable pending state, and a retry is idempotent.

export const CLEANUP_CAPABILITY = "manage_source_files";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CleanupOutcome =
  | "completed" | "already_completed" | "storage_cleanup_pending" | "replacement_required"
  | "forbidden" | "stale_operation" | "unauthenticated" | "invalid_request" | "completion_failed";

export interface CleanupTarget {
  kind: "discard" | "cancel_replacement";
  state: string;
  company_id: string;
  file_path: string | null;
  deletion_eligible: boolean;
}

export interface CleanupDeps {
  /** The caller's user id, verified from their JWT, or null. */
  authenticate(): Promise<string | null>;
  /** The operation, resolved server-side (service role). */
  resolveTarget(operationId: string): Promise<CleanupTarget | null>;
  /** can_user_act_on_workspace(user, company, capability), evaluated in the database. */
  canManage(userId: string, companyId: string): Promise<boolean>;
  /** Service-role Storage removal of exactly one path. */
  removeObject(path: string): Promise<{ ok: boolean }>;
  /** The server's own view of Storage (storage.objects). */
  objectExists(path: string): Promise<boolean>;
  /** The completion RPC, executed with the CALLER's JWT (the database re-authorizes and re-reads Storage). */
  completeAsCaller(kind: CleanupTarget["kind"], operationId: string): Promise<{ outcome: string } | null>;
}

export interface CleanupResult { status: number; outcome: CleanupOutcome }

/** Accepts exactly { operation_id: <uuid> }. Anything else, including an extra path/company/user field, is refused. */
export function parseCleanupRequest(body: unknown): { operationId: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "operation_id") return null;
  const id = (body as Record<string, unknown>).operation_id;
  return typeof id === "string" && UUID.test(id) ? { operationId: id } : null;
}

const COMPLETION_MAP: Record<string, CleanupResult> = {
  deleted_now: { status: 200, outcome: "completed" },
  completed: { status: 200, outcome: "completed" },
  already_discarded: { status: 200, outcome: "already_completed" },
  already_completed: { status: 200, outcome: "already_completed" },
  discard_pending: { status: 409, outcome: "storage_cleanup_pending" },
  storage_cleanup_pending: { status: 409, outcome: "storage_cleanup_pending" },
  replacement_required: { status: 409, outcome: "replacement_required" },
  forbidden: { status: 403, outcome: "forbidden" },
  stale_operation: { status: 404, outcome: "stale_operation" },
};

export async function runStorageCleanup(deps: CleanupDeps, operationId: string): Promise<CleanupResult> {
  const userId = await deps.authenticate();
  if (!userId) return { status: 401, outcome: "unauthenticated" };

  const target = await deps.resolveTarget(operationId);
  if (!target) return { status: 404, outcome: "stale_operation" };

  if (!(await deps.canManage(userId, target.company_id))) return { status: 403, outcome: "forbidden" };

  const open = target.kind === "discard" ? target.state === "pending" : target.state === "storage_cleanup_pending";
  if (open && target.deletion_eligible && target.file_path) {
    const removed = await deps.removeObject(target.file_path);
    if (!removed.ok || (await deps.objectExists(target.file_path))) {
      return { status: 502, outcome: "storage_cleanup_pending" };
    }
  }

  // Always finish through the database as the caller. For an already-finished operation this is the idempotent
  // answer; for an ineligible discard it is the abort.
  const done = await deps.completeAsCaller(target.kind, operationId);
  if (!done) return { status: 500, outcome: "completion_failed" };
  return COMPLETION_MAP[done.outcome] ?? { status: 500, outcome: "completion_failed" };
}
