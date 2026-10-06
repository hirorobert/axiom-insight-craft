/**
 * requestReprocess — the ONE browser path for starting a new check of a trial balance upload
 * (20261006100000_mapping_and_processing_authority.sql).
 *
 * The browser never writes an upload's processing fields (status, is_valid, processing_result, validation_report,
 * accounting_errors, processed_at): they are server-owned. Instead:
 *   1. tbu_request_reprocess(upload, operation id, expected source hash) — the server authorizes the caller
 *      (prepare_close + the processing entitlement), checks the upload under its row lock, and in one transaction
 *      invalidates the current certification and marks the upload for a new check. Idempotent per operation id.
 *   2. process-trial-balance is invoked with the SAME operation id as its clientRequestId — and only when step 1
 *      answered accepted or replayed. Any other outcome stops here with a named reason.
 */

import { canExercise, type MyWorkspaceCapabilities } from "@/lib/auth/workspaceCapabilities";
import { canReprocessUpload } from "@/lib/workspace/resolveActiveUpload";
import type { WorkspaceCommercialState } from "@/lib/commercial/paidActions";

export type ReprocessOutcome = "accepted" | "replayed" | "conflict" | "refused";

/**
 * Whether to OFFER Retry: the same authority tbu_request_reprocess checks for a workspace upload —
 *   1. an active upload;
 *   2. the WORKSPACE capability prepare_close, exercisable now (get_my_workspace_capabilities().allowed: held through
 *      an accepted membership, on an account with a current plan);
 *   3. the processing entitlement: get_workspace_commercial_state().capabilities.CLOSE_ASSURANCE — computed by
 *      _authorize_paid_action(user, company, 'CLOSE_ASSURANCE'), the exact check authorize_trial_balance_processing
 *      makes for a workspace upload.
 * An engagement's service scope (e.g. Trial Balance Review being in the engagement) is NOT a workspace capability and
 * never makes Retry available. Anything unknown → not offered (fail closed). The server still decides.
 */
export function mayRequestReprocess(
  upload: { lifecycle_state?: string | null } | null | undefined,
  capabilities: MyWorkspaceCapabilities | null | undefined,
  commercial: WorkspaceCommercialState | null | undefined,
): boolean {
  const entitled = !!commercial && commercial.access && commercial.capabilities.CLOSE_ASSURANCE?.allowed === true
    && commercial.capabilities.CLOSE_ASSURANCE.code === "ALLOWED";
  return canReprocessUpload(upload) && canExercise(capabilities, "prepare_close") && entitled;
}

export interface ReprocessResponse {
  outcome: ReprocessOutcome;
  code: string;
  upload_id: string | null;
  operation_id: string | null;
  invalidated_certification_id: string | null;
}

const REFUSAL_MESSAGES: Record<string, string> = {
  NOT_A_MEMBER_OF_COMPANY: "You are not a member of this workspace.",
  CAPABILITY_REQUIRED: "Your role cannot start a new check of this trial balance.",
  ENTITLEMENT_REQUIRED: "Checking a trial balance needs a current plan.",
  UPLOAD_NOT_ACTIVE: "This trial balance is no longer in active use.",
  SOURCE_NOT_BOUND: "This trial balance's source file is not bound to it.",
  SOURCE_CHANGED: "The source file changed since it was last read. Refresh and try again.",
  IN_PROGRESS: "This trial balance is already being checked.",
  IDEMPOTENCY_KEY_REUSED: "This request was already used for a different check. Try again.",
};

/** Only an accepted or replayed request may go on to invoke processing. */
export function mayInvokeProcessing(response: ReprocessResponse | null | undefined): boolean {
  return response?.outcome === "accepted" || response?.outcome === "replayed";
}

export function reprocessRefusalMessage(code: string | null | undefined): string {
  return (code && REFUSAL_MESSAGES[code]) || "A new check could not be started.";
}

/** Reads the server's answer strictly: anything that is not a recognised outcome is treated as a refusal. */
export function parseReprocessResponse(data: unknown): ReprocessResponse {
  const d = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  const outcome = d.outcome;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  if (outcome === "accepted" || outcome === "replayed" || outcome === "conflict" || outcome === "refused") {
    return {
      outcome,
      code: str(d.code) ?? "UNKNOWN",
      upload_id: str(d.upload_id),
      operation_id: str(d.operation_id),
      invalidated_certification_id: str(d.invalidated_certification_id),
    };
  }
  return { outcome: "refused", code: "UNKNOWN", upload_id: null, operation_id: null, invalidated_certification_id: null };
}

type RpcError = { message: string; code?: string } | null;

export interface ReprocessClient {
  from(table: "trial_balance_uploads"): {
    select(columns: "source_file_hash"): {
      eq(column: "id", value: string): { maybeSingle(): PromiseLike<{ data: { source_file_hash: string | null } | null; error: RpcError }> };
    };
  };
  rpc(name: "tbu_request_reprocess", args: { p_upload_id: string; p_operation_id: string; p_expected_source_hash: string | null }):
    PromiseLike<{ data: unknown; error: RpcError }>;
  functions: {
    invoke(name: "process-trial-balance", options: { body: { uploadId: string; clientRequestId: string } }):
      Promise<{ error: unknown }>;
  };
}

export class ReprocessRefusedError extends Error {
  readonly code: string;
  readonly outcome: ReprocessOutcome;
  constructor(response: ReprocessResponse) {
    super(reprocessRefusalMessage(response.code));
    this.name = "ReprocessRefusedError";
    this.code = response.code;
    this.outcome = response.outcome;
  }
}

/**
 * Requests a new check and, only when the server accepted it, invokes processing with the same operation id.
 * Throws ReprocessRefusedError for a refusal or conflict (processing is NOT invoked), and the transport error for a
 * failed request or invocation.
 */
export async function requestReprocess(
  client: ReprocessClient,
  uploadId: string,
  deps: { ensureFreshSession: () => Promise<unknown>; newOperationId?: () => string },
): Promise<ReprocessResponse> {
  const operationId = (deps.newOperationId ?? (() => crypto.randomUUID()))();
  // The source this request names: the hash stored now. The server compares it under the upload lock
  // (SOURCE_CHANGED), so a change between this read and the request is refused, never silently accepted.
  const { data: current, error: readError } = await client.from("trial_balance_uploads").select("source_file_hash").eq("id", uploadId).maybeSingle();
  if (readError) throw readError;
  const { data, error } = await client.rpc("tbu_request_reprocess", {
    p_upload_id: uploadId,
    p_operation_id: operationId,
    p_expected_source_hash: current?.source_file_hash ?? null,
  });
  if (error) throw error;
  const response = parseReprocessResponse(data);
  if (!mayInvokeProcessing(response)) throw new ReprocessRefusedError(response);

  await deps.ensureFreshSession();
  const { error: fnError } = await client.functions.invoke("process-trial-balance", {
    body: { uploadId, clientRequestId: operationId },
  });
  if (fnError) throw fnError;
  return response;
}
