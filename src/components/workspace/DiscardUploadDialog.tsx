/**
 * DiscardUploadDialog — removal/replacement of a trial balance upload.
 *
 * Lifecycle-safe safety model (20260923100000_upload_lifecycle_retire_and_replace.sql):
 *  - A genuinely unprocessed run with no dependent records can be hard-discarded (discardUpload). Hard
 *    delete is the correct act here: nothing downstream depends on it and nothing needs preserving.
 *  - A run with ANY processing, certification or derived history can NEVER be hard-deleted.
 *    trial_balance_uploads -> tb_certifications is ON DELETE CASCADE, but tb_certifications is
 *    unconditionally append-only (Iron Dome), so a cascade into it always fails. This is not a bug to
 *    work around. The correct operation is retireUpload() (replace), which preserves the old row and all
 *    of its evidence and creates a brand-new upload row for the replacement file.
 *  - An unprocessed REPLACEMENT is not an ordinary upload. Removing it goes through cancelReplacement(),
 *    which restores the upload it replaced.
 *  - Hard discard is a two-phase saga, not a single call, because Storage and Postgres are two separate
 *    systems this code cannot make atomic. discard_trial_balance_upload() marks the row 'discard_pending';
 *    the trial-balance-storage-cleanup Edge Function then removes the bound file with server authority and
 *    completes the discard. The database deletes the row only when it sees the file is gone; no client claim
 *    is accepted.
 *  - A hard discard is reversible for a short undo window through restore_trial_balance_upload(). A
 *    success toast is shown only when the server answers 'restored' or 'already_restored'.
 *  - Authority is user-based. The workspace owner, or a user explicitly granted manage_source_files for
 *    that workspace, may perform these operations. No firm, membership or job title is required or
 *    consulted. The server enforces this and records auth.uid() as the actor.
 *
 * discard_trial_balance_upload() outcomes:
 *   - deleted_now (never returned directly by begin; see discard_pending) / already_discarded:
 *       idempotent success; never a second delete, never an error.
 *   - discard_pending: eligible; proceed with the Storage removal + finalize steps.
 *   - forbidden: the caller is not an owner/partner of the company. FAILED_TERMINAL.
 *   - dependency_conflict: another record still depends on the upload. FAILED_TERMINAL.
 *   - replacement_required: the upload has processing, certification or derived history. Route to
 *       retireUpload(); this is never a generic retryable failure. The server decides it from
 *       authoritative tables, so it can arrive even when local state believed the upload was unprocessed.
 *   - replacement_cancel_required: the upload is itself an unprocessed replacement. Route to
 *       cancelReplacement().
 *   - stale_version: the caller's expected_version no longer matches. Retryable after a refresh.
 * See the migration's own doc comment for the full root-cause analysis.
 */

import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

/**
 * CountdownUndoToast — live 15-second undo window with a shrinking progress bar
 * and a second-by-second read-out so the user knows exactly how long they have.
 */
function CountdownUndoToast({ receipt }: { receipt: DiscardReceipt }) {
  const [remaining, setRemaining] = useState(UNDO_WINDOW_MS);

  useEffect(() => {
    const start = Date.now();
    const tick = setInterval(() => {
      const left = Math.max(0, UNDO_WINDOW_MS - (Date.now() - start));
      setRemaining(left);
      if (left <= 0) clearInterval(tick);
    }, 50);
    return () => clearInterval(tick);
  }, []);

  const seconds = Math.ceil(remaining / 1000);
  const pct = (remaining / UNDO_WINDOW_MS) * 100;

  return (
    <div className="w-full min-w-[16rem]">
      <div className="flex items-center justify-between text-[13px]">
        <span className="text-muted-foreground">Undo window</span>
        <span className="tabular-nums font-medium">{seconds}s</span>
      </div>
      <div className="mt-2 h-1 w-full bg-secondary overflow-hidden rounded-full">
        <div
          className="h-full bg-primary transition-[width] duration-75 ease-linear rounded-full"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export interface DiscardTarget {
  id: string;
  file_name: string;
  file_path?: string | null;
  status?: string | null;
  is_valid?: boolean | null;
  /** 20260923100000_upload_lifecycle_retire_and_replace.sql. Preferred over status/is_valid when present. */
  lifecycle_state?: string | null;
  version?: number | null;
  /** Set when this upload replaced an earlier one (retire_trial_balance_upload). */
  replaces_upload_id?: string | null;
}

/**
 * True when a run has processing/certification history and must go through retireUpload()
 * (replace) rather than discardUpload() (hard delete). This is only a hint for choosing which
 * UI/function to call first. discard_trial_balance_upload() is the final authority: it answers
 * 'replacement_required' from the authoritative tables regardless, and every caller handles that.
 * lifecycle_state is preferred when present; status/is_valid is the pre-lifecycle fallback.
 */
export function isCertifiedRun(target: DiscardTarget | null | undefined): boolean {
  if (target?.lifecycle_state) return target.lifecycle_state !== "active_unprocessed";
  return target?.status === "complete" || target?.is_valid === true;
}

/** True when an unprocessed upload is itself a replacement, so removing it means cancelling the replacement. */
export function isUnprocessedReplacement(target: DiscardTarget | null | undefined): boolean {
  return !!target?.replaces_upload_id && !isCertifiedRun(target);
}

/**
 * DiscardError — thrown only in place of a raw Supabase/Postgres error. Carries a plain-language, privacy-safe
 * reason (never a raw constraint/table name or SQL fragment) and a short reference id the person can quote to
 * support; the original error is logged to the console (not the toast) for diagnosis. `retryable` distinguishes a
 * transient problem (network, a lock held elsewhere — safe to try again) from one that will not resolve on its own.
 */
export class DiscardError extends Error {
  readonly reference: string;
  readonly retryable: boolean;
  /** The RPC outcome this error represents, when it corresponds to one exactly (never fabricated
   * for a transport-level failure). "replacement_required", "replacement_cancel_required" and
   * "stale_version" are never generic retryable failures. Callers that need to route to the Replace
   * or Cancel-replacement flow should check this code rather than parsing `message`. */
  readonly code?: "forbidden" | "dependency_conflict" | "replacement_required" | "replacement_cancel_required" | "stale_version";
  constructor(reason: string, opts: { retryable: boolean; cause?: unknown; code?: DiscardError["code"] }) {
    super(reason);
    this.name = "DiscardError";
    this.reference = generateDiscardReference();
    this.retryable = opts.retryable;
    this.code = opts.code;
    if (opts.cause !== undefined) {
      console.error(`[discardUpload ${this.reference}]`, opts.cause);
    }
  }
  /** The full message: safe reason + reference id, ready to show verbatim in a toast. */
  get safeMessage(): string {
    return `${this.message} (reference ${this.reference})${this.retryable ? " — safe to try again." : ""}`;
  }
}

function generateDiscardReference(): string {
  return `DSC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/** How long a discard stays reversible in the UI. The server keeps its own, longer window (10 minutes). */
export const UNDO_WINDOW_MS = 15000;

/**
 * Everything needed to ask the server to put a discarded run back: the discard operation id (the
 * server's own record, which holds the row snapshot), plus the stored file bytes for Storage.
 */
export interface DiscardReceipt {
  id: string;
  fileName: string;
  /** trial_balance_upload_operations.id of the completed discard; null when this call discarded nothing. */
  operationId: string | null;
  row: Record<string, unknown> | null;
  filePath: string | null;
  fileBlob: Blob | null;
}

/**
 * The SECURITY DEFINER RPCs in 20260923100000_upload_lifecycle_retire_and_replace.sql, behind a narrow,
 * single-purpose typed adapter. It follows the same sole-cast-boundary pattern as
 * src/lib/commercial/commercialRpc.ts. The migration is committed but not yet applied to any live database
 * (CLAUDE.md §11: `supabase db push` is the owner's own action), so the generated
 * `Database["public"]["Functions"]` union does not know these functions exist yet. The cast below is
 * scoped to exactly these call signatures, which were hand-verified against the migration's RETURNS TABLE
 * shapes; nothing else in this module is untyped. Delete the cast once types.ts is regenerated.
 */
type DiscardOutcome =
  | "deleted_now" | "already_discarded" | "forbidden" | "dependency_conflict"
  | "replacement_required" | "replacement_cancel_required" | "stale_version" | "discard_pending" | "replaced";
export type RestoreOutcome =
  | "restored" | "already_restored" | "conflict_new_active_upload" | "expired" | "forbidden"
  | "stale_operation" | "storage_restore_required" | "terminal_failure";
type CancelOutcome =
  | "cancelled" | "already_cancelled" | "forbidden" | "not_a_replacement" | "replacement_processed"
  | "stale_version" | "lineage_conflict";
/** trial-balance-storage-cleanup Edge Function outcomes (supabase/functions/_shared/storageCleanup.ts). */
type CleanupOutcome =
  | "completed" | "already_completed" | "storage_cleanup_pending" | "replacement_required"
  | "forbidden" | "stale_operation" | "unauthenticated" | "invalid_request" | "completion_failed";
interface BeginDiscardRpcRow {
  outcome: DiscardOutcome;
  operation_id: string | null;
  row_snapshot: Record<string, unknown> | null;
  file_path: string | null;
  detail: string | null;
}
interface RetireRpcRow { outcome: DiscardOutcome; new_upload_id: string | null; retired_upload_id: string | null; detail: string | null }
interface RestoreRpcRow { outcome: RestoreOutcome; upload_id: string | null; detail: string | null }
interface CancelRpcRow { outcome: CancelOutcome; operation_id: string | null; restored_upload_id: string | null; file_path: string | null; detail: string | null }
type RpcError = { message: string; code?: string } | null;
interface LifecycleRpcClient {
  rpc(name: "discard_trial_balance_upload", args: { p_upload_id: string; p_expected_version: number }):
    Promise<{ data: BeginDiscardRpcRow[] | null; error: RpcError }>;
  rpc(name: "retire_trial_balance_upload", args: {
    p_old_upload_id: string; p_expected_version: number;
    p_new_file_name: string; p_new_file_path: string; p_new_file_size: number; p_reason?: string;
  }): Promise<{ data: RetireRpcRow[] | null; error: RpcError }>;
  rpc(name: "restore_trial_balance_upload", args: { p_operation_id: string }):
    Promise<{ data: RestoreRpcRow[] | null; error: RpcError }>;
  rpc(name: "cancel_trial_balance_replacement", args: { p_replacement_upload_id: string; p_expected_version: number }):
    Promise<{ data: CancelRpcRow[] | null; error: RpcError }>;
}
const lifecycleRpc = () => supabase as unknown as LifecycleRpcClient;

/**
 * Asks the trial-balance-storage-cleanup Edge Function to remove the operation's bound file and complete the
 * operation. It sends ONLY the operation id: the function resolves the workspace and path server-side,
 * authorizes the caller (workspace owner or manage_source_files), deletes with server authority, verifies the
 * file is gone and completes the operation as the caller. That is why an authorized user can remove a file
 * another authorized user uploaded, which Storage RLS alone forbids. Returns null when no outcome could be read.
 */
async function invokeStorageCleanup(operationId: string): Promise<CleanupOutcome | null> {
  const { data, error } = await supabase.functions.invoke("trial-balance-storage-cleanup", { body: { operation_id: operationId } });
  if (!error) return (data as { outcome?: CleanupOutcome } | null)?.outcome ?? null;
  try {
    const body = await (error as { context?: { json?: () => Promise<unknown> } }).context?.json?.();
    return (body as { outcome?: CleanupOutcome } | undefined)?.outcome ?? null;
  } catch {
    return null;
  }
}

function throwForBeginOutcome(target: DiscardTarget, outcome: DiscardOutcome, detail: string | null): never {
  if (outcome === "forbidden") {
    throw new DiscardError(detail ?? "You don't have permission to manage this workspace's source files.", { retryable: false, code: "forbidden", cause: new Error(`discard forbidden for id=${target.id}`) });
  }
  if (outcome === "dependency_conflict") {
    throw new DiscardError(detail ?? "This trial balance could not be discarded because other records in this workspace still depend on it.", { retryable: false, code: "dependency_conflict", cause: new Error(`discard dependency_conflict for id=${target.id}`) });
  }
  if (outcome === "replacement_required") {
    throw new DiscardError(detail ?? "This trial balance has validation history and cannot be deleted. Upload a replacement instead.", { retryable: false, code: "replacement_required", cause: new Error(`discard replacement_required for id=${target.id}`) });
  }
  if (outcome === "replacement_cancel_required") {
    throw new DiscardError(detail ?? "This trial balance replaced an earlier one. Cancel the replacement to restore the earlier trial balance.", { retryable: false, code: "replacement_cancel_required", cause: new Error(`discard replacement_cancel_required for id=${target.id}`) });
  }
  if (outcome === "stale_version") {
    throw new DiscardError(detail ?? "This trial balance changed since you last viewed it. Refresh and try again.", { retryable: true, code: "stale_version", cause: new Error(`discard stale_version for id=${target.id}`) });
  }
  throw new DiscardError("Could not discard this trial balance.", { retryable: true, cause: new Error(`unexpected begin-discard outcome: ${outcome}`) });
}

/**
 * discardUpload — hard-delete saga for a genuinely unprocessed upload with no dependent records ONLY.
 * discard_trial_balance_upload() is the sole eligibility authority; nothing is inferred client-side.
 * It authorizes the caller, locks the row, and checks the evidence tables and the optimistic-concurrency
 * version. It refuses with 'replacement_required' for anything that has ever been processed or certified,
 * or has a derived record; retireUpload() is the only path for those.
 *
 * This is a two-phase saga rather than a single call, because Storage and Postgres are two separate
 * systems this code cannot make atomic:
 *   1. discard_trial_balance_upload() marks the row 'discard_pending' and returns an operation id.
 *   2. The trial-balance-storage-cleanup Edge Function removes the bound file with server authority and
 *      completes the discard; the database deletes the row only when it sees the file is gone. "Success" is
 *      never reported while Storage cleanup is unknown.
 * If phase 2 is never reached (a crash, a lost response), the next discardUpload() call for the SAME
 * upload resumes the SAME pending operation rather than starting a new one.
 */
export async function discardUpload(target: DiscardTarget): Promise<DiscardReceipt> {
  const { data: beginRows, error: beginError } = await lifecycleRpc().rpc("discard_trial_balance_upload", {
    p_upload_id: target.id,
    p_expected_version: target.version ?? 1,
  });
  if (beginError) {
    throw new DiscardError("Could not discard this trial balance.", { retryable: true, cause: beginError });
  }
  const begin = beginRows?.[0];
  if (!begin) {
    throw new DiscardError("Could not discard this trial balance.", { retryable: true, cause: new Error("discard_trial_balance_upload returned no result") });
  }
  if (begin.outcome === "already_discarded") {
    return { id: target.id, fileName: target.file_name, operationId: null, row: null, filePath: target.file_path ?? null, fileBlob: null };
  }
  if (begin.outcome !== "discard_pending" || !begin.operation_id) {
    throwForBeginOutcome(target, begin.outcome, begin.detail);
  }

  // Best-effort file capture for the undo receipt. It works for the caller's own files; for a file another
  // user uploaded, Storage RLS refuses the download, and Undo then honestly reports 'storage_restore_required'.
  let fileBlob: Blob | null = null;
  const filePath = begin.file_path ?? null;
  if (filePath) {
    const { data } = await supabase.storage.from("trial-balance-files").download(filePath);
    fileBlob = data ?? null;
  }
  const cleanup = await invokeStorageCleanup(begin.operation_id);
  if (cleanup === "replacement_required") {
    throw new DiscardError("This trial balance acquired processing history during the discard. Upload a replacement instead.", { retryable: false, code: "replacement_required", cause: new Error(`cleanup replacement_required for id=${target.id}`) });
  }
  if (cleanup === "forbidden") {
    throw new DiscardError("You don't have permission to manage this workspace's source files.", { retryable: false, code: "forbidden", cause: new Error(`cleanup forbidden for id=${target.id}`) });
  }
  if (cleanup !== "completed" && cleanup !== "already_completed") {
    throw new DiscardError("The file could not be confirmed removed from storage, so the discard is still pending. Safe to try again — it resumes, not repeats.", { retryable: true, cause: new Error(`storage cleanup outcome: ${cleanup}`) });
  }

  return {
    id: target.id,
    fileName: target.file_name,
    operationId: begin.operation_id,
    row: begin.row_snapshot,
    filePath,
    fileBlob,
  };
}

/**
 * retireUpload — the ONLY path for an upload with processing, certification or dependent records.
 * retire_trial_balance_upload() never deletes anything: the old upload row, its certifications and every
 * derived result stay exactly as they are. This function uploads the replacement file to Storage under
 * its own new path, then links the two rows server-side. The new upload starts genuinely empty
 * (active_unprocessed, no copied results); it is a fresh upload that remembers what it replaces, not a
 * copy. There is no Undo toast for a replacement because nothing was destroyed. While the replacement is
 * still unprocessed it can be cancelled (cancelReplacement), which restores the original.
 */
export async function retireUpload(
  target: DiscardTarget & { company_id?: string | null },
  file: File,
  reason?: string,
): Promise<{ newUploadId: string }> {
  const ownerId = (await supabase.auth.getUser()).data.user?.id;
  if (!ownerId) throw new DiscardError("You must be signed in to replace this trial balance.", { retryable: false, code: "forbidden", cause: new Error("no authenticated user") });

  const newFilePath = `${ownerId}/${Date.now()}-${file.name}`;
  const { error: uploadError } = await supabase.storage.from("trial-balance-files").upload(newFilePath, file, { upsert: false });
  if (uploadError) {
    throw new DiscardError("Could not upload the replacement file. Nothing was changed.", { retryable: true, cause: uploadError });
  }

  const { data: rows, error: rpcError } = await lifecycleRpc().rpc("retire_trial_balance_upload", {
    p_old_upload_id: target.id,
    p_expected_version: target.version ?? 1,
    p_new_file_name: file.name,
    p_new_file_path: newFilePath,
    p_new_file_size: file.size,
    p_reason: reason,
  });
  if (rpcError) {
    // The RPC failed after the file was already uploaded, so remove the orphaned object rather than
    // leave it dangling with nothing pointing to it.
    await supabase.storage.from("trial-balance-files").remove([newFilePath]).catch(() => {});
    throw new DiscardError("Could not replace this trial balance.", { retryable: true, cause: rpcError });
  }
  const result = rows?.[0];
  if (result?.outcome === "replaced" && result.new_upload_id) {
    return { newUploadId: result.new_upload_id };
  }
  // No other outcome creates anything that points at the new object, so remove it.
  await supabase.storage.from("trial-balance-files").remove([newFilePath]).catch(() => {});
  if (result?.outcome === "forbidden") {
    throw new DiscardError(result.detail ?? "You don't have permission to manage this workspace's source files.", { retryable: false, code: "forbidden", cause: new Error(`retire forbidden for id=${target.id}`) });
  }
  if (result?.outcome === "stale_version") {
    throw new DiscardError(result.detail ?? "This trial balance changed since you last viewed it. Refresh and try again.", { retryable: true, code: "stale_version", cause: new Error(`retire stale_version for id=${target.id}`) });
  }
  throw new DiscardError(result?.detail ?? "Could not replace this trial balance.", { retryable: result?.outcome !== "already_discarded", cause: new Error(`unexpected retire outcome: ${result?.outcome}`) });
}

/**
 * cancelReplacement — removes an UNPROCESSED replacement and restores the upload it replaced, leaving that
 * upload's certifications untouched. cancel_trial_balance_replacement() does this atomically in the database.
 * The replacement's Storage object is removed afterwards, and the removal is recorded through
 * trial-balance-storage-cleanup Edge Function (server authority, server-verified). If removal fails, the operation stays pending server-side and
 * this function returns `storageCleanupPending`, so the failure is never hidden. Storage and the database
 * are not updated atomically.
 */
export async function cancelReplacement(target: DiscardTarget): Promise<{ restoredUploadId: string | null; storageCleanupPending: boolean }> {
  const { data, error } = await lifecycleRpc().rpc("cancel_trial_balance_replacement", {
    p_replacement_upload_id: target.id,
    p_expected_version: target.version ?? 1,
  });
  if (error) {
    throw new DiscardError("Could not cancel this replacement.", { retryable: true, cause: error });
  }
  const r = data?.[0];
  if (!r || (r.outcome !== "cancelled" && r.outcome !== "already_cancelled")) {
    const outcome = r?.outcome;
    if (outcome === "forbidden") {
      throw new DiscardError(r?.detail ?? "You don't have permission to manage this workspace's source files.", { retryable: false, code: "forbidden", cause: new Error(`cancel forbidden for id=${target.id}`) });
    }
    if (outcome === "replacement_processed") {
      throw new DiscardError(r?.detail ?? "The replacement has already been processed, so it cannot be cancelled. Replace it with another upload instead.", { retryable: false, code: "replacement_required", cause: new Error(`cancel replacement_processed for id=${target.id}`) });
    }
    if (outcome === "stale_version") {
      throw new DiscardError(r?.detail ?? "This trial balance changed since you last viewed it. Refresh and try again.", { retryable: true, code: "stale_version", cause: new Error(`cancel stale_version for id=${target.id}`) });
    }
    throw new DiscardError(r?.detail ?? "Could not cancel this replacement.", { retryable: false, cause: new Error(`unexpected cancel outcome: ${outcome}`) });
  }

  let storageCleanupPending = false;
  if (r.operation_id) {
    const cleanup = await invokeStorageCleanup(r.operation_id);
    storageCleanupPending = cleanup !== "completed" && cleanup !== "already_completed";
  }
  return { restoredUploadId: r.restored_upload_id, storageCleanupPending };
}

/** Plain-language message for each non-success Undo outcome. */
export function restoreOutcomeMessage(outcome: RestoreOutcome, detail?: string | null): string {
  switch (outcome) {
    case "conflict_new_active_upload":
      return "Undo can't proceed because a new trial balance is now active for this period. The new upload was left unchanged.";
    case "expired":
      return "The undo window for this discard has closed.";
    case "forbidden":
      return "You don't have permission to manage this workspace's source files.";
    case "storage_restore_required":
      return "The original file could not be put back, so the trial balance was not restored.";
    case "stale_operation":
      return "This discard can no longer be undone.";
    case "terminal_failure":
      return detail ?? "The trial balance could not be restored.";
    default:
      return "The trial balance could not be restored.";
  }
}

/**
 * restoreUpload — asks the server to put a discarded run back (restore_trial_balance_upload) and
 * returns its explicit outcome. The file is re-uploaded first so the server can be told truthfully
 * whether Storage holds it again. If the server then refuses, that re-uploaded object is removed again,
 * because nothing references it. This function never interprets a SQLSTATE; it acts only on the server's
 * named outcome.
 */
export async function restoreUpload(receipt: DiscardReceipt): Promise<{ outcome: RestoreOutcome; message: string | null }> {
  if (!receipt.operationId) {
    return { outcome: "stale_operation", message: restoreOutcomeMessage("stale_operation") };
  }
  let reuploaded = false;
  if (receipt.filePath && receipt.fileBlob) {
    const { error: upErr } = await supabase.storage
      .from("trial-balance-files")
      .upload(receipt.filePath, receipt.fileBlob, { upsert: true });
    reuploaded = !upErr;
  }
  // The server checks Storage itself; nothing about the upload above is claimed to it.
  const { data, error } = await lifecycleRpc().rpc("restore_trial_balance_upload", { p_operation_id: receipt.operationId });
  const outcome: RestoreOutcome = error ? "terminal_failure" : data?.[0]?.outcome ?? "terminal_failure";
  if (outcome === "restored" || outcome === "already_restored") {
    return { outcome, message: null };
  }
  if (reuploaded && receipt.filePath) {
    await supabase.storage.from("trial-balance-files").remove([receipt.filePath]).catch(() => {});
  }
  if (error) console.error("[restoreUpload]", error);
  return { outcome, message: restoreOutcomeMessage(outcome, data?.[0]?.detail ?? null) };
}

/**
 * offerUndo — the toast that holds the undo window open. A success toast appears ONLY when the server
 * reports 'restored' or 'already_restored'; every other outcome is shown as what it is.
 */
export function offerUndo(receipt: DiscardReceipt, onRestored?: () => void) {
  const toastId = toast.success(
    <div className="flex flex-col gap-1">
      <span className="font-medium">Discarded {receipt.fileName}</span>
      <CountdownUndoToast receipt={receipt} />
    </div>,
    {
      duration: UNDO_WINDOW_MS,
      action: {
        label: "Undo",
        onClick: () => {
          toast.dismiss(toastId);
          void (async () => {
            try {
              const result = await restoreUpload(receipt);
              if (result.outcome === "restored" || result.outcome === "already_restored") {
                toast.success(`${receipt.fileName} restored.`);
                onRestored?.();
              } else {
                toast.error(result.message ?? "Could not restore this trial balance.");
              }
            } catch (err) {
              console.error("[offerUndo]", err);
              toast.error("Could not restore this trial balance.");
            }
          })();
        },
      },
      cancel: {
        label: "Dismiss",
        onClick: () => toast.dismiss(toastId),
      },
    },
  );
}

export function DiscardUploadDialog({
  target,
  open,
  onOpenChange,
  onDiscarded,
  onReplacementCancelled,
  replacementFileName,
}: {
  target: DiscardTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscarded: (id: string, receipt: DiscardReceipt) => void;
  /** Called after an unprocessed replacement was cancelled and its predecessor restored. */
  onReplacementCancelled?: (cancelledId: string, restoredUploadId: string | null) => void;
  /** Set when the user already picked the file that replaces this run. */
  replacementFileName?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  // Kept inline (not just a toast, which can be missed or dismissed) so the reason, whether it's
  // safe to retry, and the reference id stay on screen for as long as the dialog does.
  const [lastError, setLastError] = useState<DiscardError | string | null>(null);
  // Set when the server reports that this upload is an unprocessed replacement, even if local state
  // did not know it (a stale row). From then on the only offered action is Cancel replacement.
  const [serverSaysReplacement, setServerSaysReplacement] = useState(false);

  useEffect(() => {
    if (open) {
      setLastError(null);
      setServerSaysReplacement(false);
    }
  }, [open, target?.id]);

  const isCertified = isCertifiedRun(target);
  const isReplacement = !isCertified && (isUnprocessedReplacement(target) || serverSaysReplacement);
  // Certified/processed uploads never reach a hard-delete action at all, because there is nothing to
  // confirm one's way past: discard_trial_balance_upload() would refuse it with 'replacement_required'
  // regardless. Use "Replace trial balance" instead.
  const gateSatisfied = !isCertified;

  const handleDiscard = async () => {
    if (!target || busy || !gateSatisfied) return;
    setBusy(true);
    setLastError(null);
    try {
      const receipt = await discardUpload(target);
      if (replacementFileName) {
        toast.success(`Discarded. Uploading ${replacementFileName}…`);
      }
      onDiscarded(target.id, receipt);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof DiscardError && err.code === "replacement_cancel_required") {
        setServerSaysReplacement(true);
      }
      const message =
        err instanceof DiscardError ? err.safeMessage : "Could not discard this trial balance. Please try again.";
      toast.error(message);
      setLastError(err instanceof DiscardError ? err : message);
    } finally {
      setBusy(false);
    }
  };

  const handleCancelReplacement = async () => {
    if (!target || busy) return;
    setBusy(true);
    setLastError(null);
    try {
      const result = await cancelReplacement(target);
      toast.success(
        result.storageCleanupPending
          ? "Replacement cancelled and the earlier trial balance restored. The replacement file could not be removed from storage yet; this is recorded for cleanup."
          : "Replacement cancelled. The earlier trial balance is active again.",
      );
      onReplacementCancelled?.(target.id, result.restoredUploadId);
      onOpenChange(false);
    } catch (err) {
      const message =
        err instanceof DiscardError ? err.safeMessage : "Could not cancel this replacement. Please try again.";
      toast.error(message);
      setLastError(err instanceof DiscardError ? err : message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md rounded-none border-border">
        <AlertDialogHeader className="space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            {isReplacement ? "Cancel replacement" : "Discard trial balance"}
          </p>
          <AlertDialogTitle className="text-lg leading-snug tracking-tight">
            {target?.file_name ?? "This upload"}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[13px] leading-relaxed">
            {isCertified ? (
              "This upload has validation history and cannot be deleted from the engagement record. Uploading a replacement retires it from the active workflow while preserving its evidence."
            ) : isReplacement ? (
              "This upload replaced an earlier trial balance and has not been processed. Cancelling it removes it and makes the earlier trial balance active again, with its validation history unchanged."
            ) : (
              <>
                Permanently removes this unprocessed upload.
                {replacementFileName ? ` Once removed, ${replacementFileName} is uploaded straight away.` : ""}
                {" A short Undo window is available only after complete removal succeeds."}
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {isCertified && (
          <p className="text-[12px] text-muted-foreground" data-testid="discard-replacement-required-notice">
            Use <span className="font-medium text-foreground">Replace trial balance</span> instead — this dialog cannot remove it.
          </p>
        )}

        {lastError && (
          <div
            role="alert"
            className="space-y-1 border border-destructive/30 bg-destructive/5 p-3 text-[12px] text-destructive"
            data-testid="discard-error"
          >
            <p className="leading-snug">{lastError instanceof DiscardError ? lastError.message : lastError}</p>
            {lastError instanceof DiscardError && (
              <p className="text-[11px] text-destructive/80">
                Reference <span className="font-mono" data-testid="discard-error-reference">{lastError.reference}</span>
                {" · "}
                <span data-testid="discard-error-retryable">
                  {lastError.retryable ? "Safe to try again." : "Retrying will not change this outcome."}
                </span>
              </p>
            )}
          </div>
        )}

        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel className="rounded-none" disabled={busy}>
            Keep current upload
          </AlertDialogCancel>
          {!isCertified && isReplacement && (
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleCancelReplacement();
              }}
              disabled={busy}
              className="rounded-none bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="cancel-replacement-action"
            >
              {busy ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Cancelling…
                </span>
              ) : (
                "Cancel replacement"
              )}
            </AlertDialogAction>
          )}
          {/* Never rendered for a certified/processed upload — see the notice above instead. */}
          {!isCertified && !isReplacement && (
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDiscard();
              }}
              disabled={busy}
              className="rounded-none bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Removing…
                </span>
              ) : (
                "Discard upload"
              )}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default DiscardUploadDialog;