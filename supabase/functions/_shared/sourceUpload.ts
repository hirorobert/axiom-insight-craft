// Server-authoritative upload of a trial balance source into WORKSPACE-scoped storage (PR #32).
//
// Pure orchestration with injected dependencies. It is unit-tested in Node (src/lib/workspace/sourceUpload.test.ts)
// and runs unchanged in the trial-balance-source-signer Edge Function. The rules:
//   * The request carries ONE thing: a reservation id, which reserve_trial_balance_source() issued after
//     authorizing the caller. A bucket, path, workspace or user in the body is refused, never read.
//   * The caller is authenticated from their JWT. The workspace and the canonical object path
//     (workspaces/<workspace>/<source>/<name>) are resolved server-side from the reservation.
//   * A reservation is personal and single-use: only the user it was issued to may sign it, it must not have
//     expired or been consumed, and the caller must STILL hold authority (a revocation takes effect at once).
//   * Authority is can_user_act_on_workspace(user, workspace, 'manage_source_files'): the workspace owner or an
//     explicit grant, never a title or a firm membership.
//   * The response is a signed upload URL for that exact object, which cannot overwrite an existing one. The
//     service-role key never leaves the function, and no client Storage policy is widened.

export const SOURCE_CAPABILITY = "manage_source_files";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SourceUploadOutcome =
  | "signed" | "stale_reservation" | "expired" | "already_registered"
  | "forbidden" | "unauthenticated" | "invalid_request" | "signing_failed";

export interface ReservationTarget {
  company_id: string;
  object_path: string;
  actor_user_id: string;
  expired: boolean;
  consumed: boolean;
}

export interface SourceUploadDeps {
  authenticate(): Promise<string | null>;
  resolveReservation(reservationId: string): Promise<ReservationTarget | null>;
  canManage(userId: string, companyId: string): Promise<boolean>;
  /** Service-role createSignedUploadUrl for exactly this path (no overwrite). */
  signUpload(path: string): Promise<{ path: string; token: string } | null>;
}

export interface SourceUploadResult { status: number; outcome: SourceUploadOutcome; path?: string; token?: string }

export function parseSourceUploadRequest(body: unknown): { reservationId: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "reservation_id") return null;
  const id = (body as Record<string, unknown>).reservation_id;
  return typeof id === "string" && UUID.test(id) ? { reservationId: id } : null;
}

export async function runSourceUpload(deps: SourceUploadDeps, reservationId: string): Promise<SourceUploadResult> {
  const userId = await deps.authenticate();
  if (!userId) return { status: 401, outcome: "unauthenticated" };

  const r = await deps.resolveReservation(reservationId);
  if (!r) return { status: 404, outcome: "stale_reservation" };
  if (r.actor_user_id !== userId) return { status: 403, outcome: "forbidden" };
  if (r.consumed) return { status: 409, outcome: "already_registered" };
  if (r.expired) return { status: 410, outcome: "expired" };
  if (!(await deps.canManage(userId, r.company_id))) return { status: 403, outcome: "forbidden" };

  const expectedPrefix = `workspaces/${r.company_id}/`;
  if (!r.object_path.startsWith(expectedPrefix) || r.object_path.includes("..")) return { status: 500, outcome: "signing_failed" };

  const signed = await deps.signUpload(r.object_path);
  if (!signed || signed.path !== r.object_path) return { status: 502, outcome: "signing_failed" };
  return { status: 200, outcome: "signed", path: signed.path, token: signed.token };
}
