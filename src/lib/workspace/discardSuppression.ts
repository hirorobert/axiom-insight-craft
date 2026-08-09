/**
 * discardSuppression — the pure state rule behind "discard clears the screen
 * instantly, undo restores it without flicker".
 *
 * A discarded upload id is suppressed locally the moment the server call
 * succeeds, so every derived surface (active upload, history list, review
 * queue, evidence drawers) empties in the same render. Undo removes the id
 * again *before* the refetch lands, so the restored run is already visible
 * when fresh data arrives — no empty frame in between.
 *
 * No side effects, no async, no writes. Presentation state only.
 */

export interface SuppressibleUpload {
  id: string;
  status?: string | null;
  company_id?: string | null;
  processing_result?: { needs_review_accounts?: unknown } | null;
}

/** Mark a discarded upload as gone. Idempotent. */
export function suppressUpload(suppressed: readonly string[], id: string): string[] {
  return suppressed.includes(id) ? [...suppressed] : [...suppressed, id];
}

/** Undo: the run exists again. Idempotent. */
export function restoreUploadId(suppressed: readonly string[], id: string): string[] {
  return suppressed.filter((s) => s !== id);
}

export function isSuppressed(suppressed: readonly string[], id: string | null | undefined): boolean {
  return !!id && suppressed.includes(id);
}

/**
 * Apply suppression to everything the Prepare screen reads from. Returned in
 * one object so no surface can be updated out of step with another.
 */
export function applyDiscardSuppression<T extends SuppressibleUpload>(input: {
  upload: T | null | undefined;
  uploads: readonly T[];
  suppressed: readonly string[];
}): { upload: T | null; uploads: T[]; reviewAccounts: unknown[] } {
  const { upload, uploads, suppressed } = input;
  const activeUpload = upload && !isSuppressed(suppressed, upload.id) ? upload : null;
  const raw = activeUpload?.processing_result?.needs_review_accounts;
  return {
    upload: activeUpload,
    uploads: uploads.filter((u) => !isSuppressed(suppressed, u.id)),
    reviewAccounts: Array.isArray(raw) ? raw : [],
  };
}
