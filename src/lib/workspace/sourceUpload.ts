/**
 * sourceUpload — the ONE browser path for putting a trial balance source into workspace-scoped storage
 * (20260923100000 + the trial-balance-source-signer Edge Function).
 *
 *   1. reserve_trial_balance_source(workspace, file name): the server authorizes the caller (workspace owner or
 *      an explicit manage_source_files grant; never a title or firm membership) and derives the object path
 *      workspaces/<workspace>/<source>/<name>.
 *   2. trial-balance-source-signer { reservation_id } returns a single-object signed upload URL for exactly that
 *      path. The browser never chooses a bucket or a path, and no Storage policy is widened.
 *   3. register_trial_balance_upload(reservation, …) turns the object into a trial balance, but only once the
 *      server sees it in storage. retire_trial_balance_upload(…, reservation, …) does the same for a replacement.
 *
 * Because the object belongs to the workspace, any authorized user can later discard, restore or replace it,
 * whoever uploaded it.
 */

import { supabase } from "@/integrations/supabase/client";

export type RegisterOutcome =
  | "registered" | "already_registered" | "forbidden" | "stale_reservation" | "expired"
  | "object_missing" | "active_upload_exists" | "rejected" | "invalid_request";

export class SourceUploadError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(message: string, code: string, retryable: boolean) {
    super(message);
    this.name = "SourceUploadError";
    this.code = code;
    this.retryable = retryable;
  }
}

type RpcError = { message: string; code?: string } | null;
interface SourceRpcClient {
  rpc(name: "reserve_trial_balance_source", args: { p_company_id: string; p_file_name: string }):
    Promise<{ data: { outcome: string; reservation_id: string | null; object_path: string | null }[] | null; error: RpcError }>;
  rpc(name: "register_trial_balance_upload", args: {
    p_reservation_id: string; p_file_size: number; p_period_year: number | null; p_period_id: string | null; p_engagement_id: string | null;
  }): Promise<{ data: { outcome: RegisterOutcome; upload_id: string | null; detail: string | null }[] | null; error: RpcError }>;
}
// The migration is committed but not yet applied to any live database, so the generated types do not know these
// functions. This cast is scoped to exactly these two signatures.
const sourceRpc = () => supabase as unknown as SourceRpcClient;

const NO_PERMISSION = "You don't have permission to manage this workspace's source files.";

async function readFunctionOutcome(error: unknown): Promise<{ outcome?: string; path?: string; token?: string } | null> {
  try {
    return ((await (error as { context?: { json?: () => Promise<unknown> } }).context?.json?.()) ?? null) as never;
  } catch {
    return null;
  }
}

/** Steps 1 and 2: reserve a workspace-scoped object and upload the bytes to it through a signed URL. */
export async function uploadWorkspaceSource(companyId: string, file: File): Promise<{ reservationId: string; objectPath: string }> {
  const { data, error } = await sourceRpc().rpc("reserve_trial_balance_source", { p_company_id: companyId, p_file_name: file.name });
  const reserved = data?.[0];
  if (error || !reserved) throw new SourceUploadError("Could not start the upload.", "reserve_failed", true);
  if (reserved.outcome === "forbidden") throw new SourceUploadError(NO_PERMISSION, "forbidden", false);
  if (reserved.outcome !== "reserved" || !reserved.reservation_id) throw new SourceUploadError("Could not start the upload.", reserved.outcome, false);

  const signed = await supabase.functions.invoke("trial-balance-source-signer", { body: { reservation_id: reserved.reservation_id } });
  const body = (signed.error ? await readFunctionOutcome(signed.error) : signed.data) as { outcome?: string; path?: string; token?: string } | null;
  if (body?.outcome === "forbidden") throw new SourceUploadError(NO_PERMISSION, "forbidden", false);
  if (body?.outcome !== "signed" || !body.path || !body.token) throw new SourceUploadError("Could not prepare the upload. Please try again.", body?.outcome ?? "signing_failed", true);

  const { error: upErr } = await supabase.storage.from("trial-balance-files").uploadToSignedUrl(body.path, body.token, file);
  if (upErr) throw new SourceUploadError("The file could not be uploaded. Please try again.", "upload_failed", true);
  return { reservationId: reserved.reservation_id, objectPath: body.path };
}

/** Step 3 for an initial upload: the server registers the trial balance once it sees the object. */
export async function registerWorkspaceUpload(args: {
  reservationId: string; fileSize: number; periodYear?: number | null; periodId?: string | null; engagementId?: string | null;
}): Promise<string> {
  const { data, error } = await sourceRpc().rpc("register_trial_balance_upload", {
    p_reservation_id: args.reservationId, p_file_size: args.fileSize, p_period_year: args.periodYear ?? null,
    p_period_id: args.periodId ?? null, p_engagement_id: args.engagementId ?? null,
  });
  const r = data?.[0];
  if (error || !r) throw new SourceUploadError("Could not register the trial balance.", "register_failed", true);
  if ((r.outcome === "registered" || r.outcome === "already_registered") && r.upload_id) return r.upload_id;
  if (r.outcome === "forbidden") throw new SourceUploadError(NO_PERMISSION, "forbidden", false);
  if (r.outcome === "active_upload_exists") throw new SourceUploadError(r.detail ?? "A trial balance is already active for this period. Use Replace trial balance to swap it.", r.outcome, false);
  throw new SourceUploadError(r.detail ?? "Could not register the trial balance.", r.outcome, r.outcome === "object_missing");
}
