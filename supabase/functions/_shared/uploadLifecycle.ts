// Upload lifecycle rules shared by Edge Functions (PR #32, F-01). Pure; unit-tested in Node
// (src/lib/workspace/uploadLifecycleRefusal.test.ts).
//
// Only an ACTIVE upload may be processed. A retired, superseded, discarded or discard_pending upload is history:
// reprocessing it would overwrite its results and could make it a period's active upload again. The database refuses
// the same writes (trg_tbu_history_immutable, 20260923140000); this refusal happens before anything is touched.

export const ACTIVE_UPLOAD_LIFECYCLE_STATES = ["active_unprocessed", "active_processing", "active_processed", "blocked"] as const;

export function isActiveUploadLifecycle(state: unknown): boolean {
  return typeof state === "string" && (ACTIVE_UPLOAD_LIFECYCLE_STATES as readonly string[]).includes(state);
}

/** The 409 body for an upload that may not be processed, or null when it may. Missing/unknown state fails closed. */
export function processingRefusal(state: unknown): { status: "not_active"; error: "Conflict"; lifecycle_state: string | null; message: string } | null {
  if (isActiveUploadLifecycle(state)) return null;
  const s = typeof state === "string" ? state : null;
  return {
    status: "not_active",
    error: "Conflict",
    lifecycle_state: s,
    message: "This trial balance is no longer the active one for its period, so it cannot be processed again. Replace the active trial balance instead.",
  };
}

/**
 * N-02: the 409 body for an upload whose source path is not canonically bound to it (tbu_upload_source_bound), or
 * null when it is. Anything but an explicit `true` fails closed. The body never says whether any object exists.
 */
export function sourceBindingRefusal(bound: unknown): { status: "source_not_bound"; error: "Conflict"; message: string } | null {
  if (bound === true) return null;
  return {
    status: "source_not_bound",
    error: "Conflict",
    message: "This trial balance's source file is not registered to it, so it cannot be processed. Upload the file again.",
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The single 403 body for "you may not process this upload": identical for a missing row and for someone else's
 *  personal upload, so the answer never reveals whether an upload (or its file) exists or whose it is. */
export const PROCESSING_FORBIDDEN = {
  error: "Forbidden",
  message: "You don't have permission to process this trial balance.",
} as const;

/**
 * P-01: a PERSONAL upload (company_id NULL) is processed only for its own uploader. The owner is the row's
 * `user_id`; both it and the caller must be well-formed UUIDs and equal. A NULL / malformed owner, a malformed
 * caller, or any other user fails closed with PROCESSING_FORBIDDEN. Returns null when processing may continue.
 */
export function personalUploadRefusal(ownerUserId: unknown, callerUserId: unknown): typeof PROCESSING_FORBIDDEN | null {
  if (typeof ownerUserId !== "string" || typeof callerUserId !== "string") return PROCESSING_FORBIDDEN;
  if (!UUID_RE.test(ownerUserId) || !UUID_RE.test(callerUserId)) return PROCESSING_FORBIDDEN;
  return ownerUserId.toLowerCase() === callerUserId.toLowerCase() ? null : PROCESSING_FORBIDDEN;
}
