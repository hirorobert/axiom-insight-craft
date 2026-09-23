/**
 * DiscardUploadDialog — removal/replacement of a trial balance upload.
 *
 * Lifecycle-safe safety model (20260923100000_upload_lifecycle_retire_and_replace.sql):
 *  - A genuinely unprocessed, dependency-free run can be hard-discarded (discardUpload): hard
 *    delete is the correct act because nothing downstream depends on it and nothing needs
 *    preserving.
 *  - A run with ANY processing/certification history (Processing, Processed, Blocked, Needs
 *    review) or a dependent record can NEVER be hard-deleted — trial_balance_uploads ->
 *    tb_certifications is ON DELETE CASCADE, but tb_certifications is unconditionally append-only
 *    (Iron Dome), so a cascade into it always fails. This is not a bug to work around: the correct
 *    operation for this case is retireUpload() (replace), which preserves the old row and every
 *    one of its certifications/derived results exactly as they are, and creates a brand-new upload
 *    row for the replacement file. discard_trial_balance_upload() itself is the authority: it
 *    returns 'replacement_required' for any such upload rather than attempting (and failing) a
 *    delete — never a generic retryable failure.
 *  - Hard discard is a two-phase saga, not a single call, because Storage and Postgres are two
 *    separate systems this code cannot make atomic: discard_trial_balance_upload() marks the row
 *    'discard_pending' and returns an operation id; complete_trial_balance_discard() only deletes
 *    the row after THIS call has confirmed Storage removal succeeded — "success" is never reported
 *    while Storage cleanup is unknown, and a lost response resumes the SAME pending operation on
 *    retry rather than starting a new one.
 *  - A hard discard is reversible for a short undo window (Undo only ever applies here — a
 *    replacement destroys nothing, so there is nothing to undo; the original stays fully available
 *    through the retirement link, not through a toast).
 *
 * discard_trial_balance_upload() outcomes:
 *   - deleted_now (never returned directly by begin; see discard_pending) / already_discarded →
 *                            idempotent success, never a second delete, never an error;
 *   - discard_pending      → eligible; proceed with the Storage removal + finalize steps;
 *   - forbidden            → no accepted membership in the company — FAILED_TERMINAL;
 *   - dependency_conflict  → another record still depends on it — FAILED_TERMINAL;
 *   - replacement_required → has processing/certification history — route to retireUpload(), never
 *                            a generic retryable failure;
 *   - stale_version        → the caller's expected_version no longer matches — retryable after a refresh.
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
}

/**
 * True when a run has processing/certification history and must go through retireUpload()
 * (replace) rather than discardUpload() (hard delete) — discard_trial_balance_upload() itself is
 * the final authority (returns 'replacement_required' either way), this is only for choosing which
 * UI/function to call first. lifecycle_state is authoritative when present; the status/is_valid
 * check is the pre-lifecycle-migration fallback for a caller that hasn't been updated to select it.
 */
export function isCertifiedRun(target: DiscardTarget | null | undefined): boolean {
  if (target?.lifecycle_state) return target.lifecycle_state !== "active_unprocessed";
  return target?.status === "complete" || target?.is_valid === true;
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
   * for a transport-level failure). "replacement_required" and "stale_version" are never generic
   * retryable failures — callers that need to route to the Replace flow specifically should check
   * this rather than parsing `message`. */
  readonly code?: "forbidden" | "dependency_conflict" | "replacement_required" | "stale_version";
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

/** How long a discard stays reversible. */
export const UNDO_WINDOW_MS = 15000;

/**
 * Everything needed to put a discarded run back exactly as it was: the full
 * row snapshot plus the stored file bytes.
 */
export interface DiscardReceipt {
  id: string;
  fileName: string;
  row: Record<string, unknown> | null;
  filePath: string | null;
  fileBlob: Blob | null;
}

/**
 * discard_trial_balance_upload(uuid, bigint) / complete_trial_balance_discard(uuid, boolean) /
 * retire_trial_balance_upload(uuid, bigint, text, text, integer, text) — the SECURITY DEFINER RPCs
 * in 20260923100000_upload_lifecycle_retire_and_replace.sql. Narrow, single-purpose typed adapter
 * following the same sole-cast-boundary pattern as src/lib/commercial/commercialRpc.ts: these
 * migrations are committed but not yet applied to any live database (CLAUDE.md §11 — `supabase db
 * push` is the owner's own action), so the generated `Database["public"]["Functions"]` union does
 * not know these functions exist yet. The cast below is scoped to exactly these three call
 * signatures, hand-verified against the migration's RETURNS TABLE shapes; nothing else in this
 * module is untyped. Delete the cast once types.ts is regenerated after the migration is applied.
 */
type DiscardOutcome =
  | "deleted_now" | "already_discarded" | "forbidden" | "dependency_conflict"
  | "replacement_required" | "stale_version" | "discard_pending";
interface BeginDiscardRpcRow {
  outcome: DiscardOutcome;
  operation_id: string | null;
  row_snapshot: Record<string, unknown> | null;
  file_path: string | null;
  detail: string | null;
}
interface CompleteDiscardRpcRow { outcome: DiscardOutcome; detail: string | null }
interface RetireRpcRow { outcome: DiscardOutcome; new_upload_id: string | null; retired_upload_id: string | null; detail: string | null }
interface LifecycleRpcClient {
  rpc(name: "discard_trial_balance_upload", args: { p_upload_id: string; p_expected_version: number }):
    Promise<{ data: BeginDiscardRpcRow[] | null; error: { message: string; code?: string } | null }>;
  rpc(name: "complete_trial_balance_discard", args: { p_operation_id: string; p_storage_removed: boolean }):
    Promise<{ data: CompleteDiscardRpcRow[] | null; error: { message: string; code?: string } | null }>;
  rpc(name: "retire_trial_balance_upload", args: {
    p_old_upload_id: string; p_expected_version: number;
    p_new_file_name: string; p_new_file_path: string; p_new_file_size: number; p_reason?: string;
  }): Promise<{ data: RetireRpcRow[] | null; error: { message: string; code?: string } | null }>;
}
const lifecycleRpc = () => supabase as unknown as LifecycleRpcClient;

function throwForBeginOutcome(target: DiscardTarget, outcome: DiscardOutcome, detail: string | null): never {
  if (outcome === "forbidden") {
    throw new DiscardError(detail ?? "You are not authorised to discard this trial balance.", { retryable: false, code: "forbidden", cause: new Error(`discard forbidden for id=${target.id}`) });
  }
  if (outcome === "dependency_conflict") {
    throw new DiscardError(detail ?? "This trial balance could not be discarded because other records in this workspace still depend on it.", { retryable: false, code: "dependency_conflict", cause: new Error(`discard dependency_conflict for id=${target.id}`) });
  }
  if (outcome === "replacement_required") {
    throw new DiscardError(detail ?? "This trial balance has validation history and cannot be deleted. Upload a replacement instead.", { retryable: false, code: "replacement_required", cause: new Error(`discard replacement_required for id=${target.id}`) });
  }
  if (outcome === "stale_version") {
    throw new DiscardError(detail ?? "This trial balance changed since you last viewed it. Refresh and try again.", { retryable: true, code: "stale_version", cause: new Error(`discard stale_version for id=${target.id}`) });
  }
  throw new DiscardError("Could not discard this trial balance.", { retryable: true, cause: new Error(`unexpected begin-discard outcome: ${outcome}`) });
}

/**
 * discardUpload — hard-delete saga for a genuinely unprocessed, dependency-free upload ONLY.
 * discard_trial_balance_upload() is the sole eligibility authority (never inferred client-side):
 * it authorizes, locks the row, checks the optimistic-concurrency version, and refuses with
 * 'replacement_required' for anything that has ever been processed/certified or has a dependent
 * record — retireUpload() is the only path for those. A two-phase saga, not a single call, because
 * Storage and Postgres are two separate systems this code cannot make atomic: phase 1
 * (discard_trial_balance_upload) marks the row 'discard_pending' and returns an operation id;
 * phase 2 only deletes the row (complete_trial_balance_discard) after Storage removal has actually
 * been confirmed by THIS call — never before, so "success" is never reported while Storage cleanup
 * is unknown. If phase 2 is never reached (a crash, a lost response), the SAME upload's next
 * discardUpload() call resumes the SAME pending operation rather than starting a new one.
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
    return { id: target.id, fileName: target.file_name, row: null, filePath: target.file_path ?? null, fileBlob: null };
  }
  if (begin.outcome !== "discard_pending" || !begin.operation_id) {
    throwForBeginOutcome(target, begin.outcome, begin.detail);
  }

  // Best-effort file capture for the undo receipt — a download failure here does not block the
  // discard and does not affect undo (undo re-uploads fileBlob only when present).
  let fileBlob: Blob | null = null;
  const filePath = begin.file_path ?? target.file_path ?? null;
  if (filePath) {
    const { data } = await supabase.storage.from("trial-balance-files").download(filePath);
    fileBlob = data ?? null;
    // Never report success while Storage cleanup is unknown: only call complete_trial_balance_discard
    // (which deletes the row) AFTER this remove() call itself has returned, and only pass
    // p_storage_removed=true when it did not error.
    const { error: removeError } = await supabase.storage.from("trial-balance-files").remove([filePath]);
    const { data: completeRows, error: completeError } = await lifecycleRpc().rpc("complete_trial_balance_discard", {
      p_operation_id: begin.operation_id,
      p_storage_removed: !removeError,
    });
    if (completeError) {
      throw new DiscardError("The file was removed but finishing the discard failed. Safe to try again — it will resume, not repeat.", { retryable: true, cause: completeError });
    }
    const complete = completeRows?.[0];
    if (removeError || complete?.outcome === "discard_pending") {
      throw new DiscardError("Could not confirm the file was removed. Safe to try again.", { retryable: true, cause: removeError ?? new Error("complete_trial_balance_discard reports storage not confirmed") });
    }
  } else {
    // No file recorded on this upload at all (a defensive edge case) — nothing to remove, finalize immediately.
    const { error: completeError } = await lifecycleRpc().rpc("complete_trial_balance_discard", { p_operation_id: begin.operation_id, p_storage_removed: true });
    if (completeError) {
      throw new DiscardError("Could not finish discarding this trial balance. Safe to try again.", { retryable: true, cause: completeError });
    }
  }

  return {
    id: target.id,
    fileName: target.file_name,
    row: begin.row_snapshot,
    filePath,
    fileBlob,
  };
}

/**
 * retireUpload — the ONLY path for a processed/certified/dependent upload. Preserves the old
 * upload row, its certifications and every derived result exactly as they are (retire_trial_balance_upload
 * never deletes anything); uploads the replacement file to Storage under its own new path, then
 * links the two rows server-side. The new upload starts genuinely empty (active_unprocessed, no
 * copied results) — it is a fresh upload that happens to remember what it replaces, not a copy.
 * There is no Undo for a replacement: nothing was destroyed. The original remains fully available
 * (history/audit views), exactly as retire_trial_balance_upload's own guarantee states.
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
    // The RPC failed after the file was already uploaded — clean up the orphaned object rather than
    // leaving it dangling with nothing pointing to it.
    await supabase.storage.from("trial-balance-files").remove([newFilePath]).catch(() => {});
    throw new DiscardError("Could not replace this trial balance.", { retryable: true, cause: rpcError });
  }
  const result = rows?.[0];
  if (!result || result.outcome === "forbidden" || result.outcome === "stale_version" || !result.new_upload_id) {
    await supabase.storage.from("trial-balance-files").remove([newFilePath]).catch(() => {});
    if (result?.outcome === "forbidden") {
      throw new DiscardError(result.detail ?? "You are not authorised to replace this trial balance.", { retryable: false, code: "forbidden", cause: new Error(`retire forbidden for id=${target.id}`) });
    }
    if (result?.outcome === "stale_version") {
      throw new DiscardError(result.detail ?? "This trial balance changed since you last viewed it. Refresh and try again.", { retryable: true, code: "stale_version", cause: new Error(`retire stale_version for id=${target.id}`) });
    }
    throw new DiscardError("Could not replace this trial balance.", { retryable: true, cause: new Error(`unexpected retire outcome: ${result?.outcome}`) });
  }

  return { newUploadId: result.new_upload_id };
}

/**
 * restoreUpload — puts a discarded run back: the file first (so processing can
 * re-read it), then the row with its original id and results.
 *
 * Idempotent against a double-click on Undo: if the row already exists (a prior restore already
 * succeeded, and this is a second, redundant invocation), a plain `.insert()` would fail on the
 * primary-key/unique-id conflict — that failure is recognised here and treated as success, not
 * surfaced as a restore error, since the end state the caller wanted already holds.
 */
export async function restoreUpload(receipt: DiscardReceipt): Promise<void> {
  if (!receipt.row) {
    throw new Error("This discard can no longer be undone.");
  }
  if (receipt.filePath && receipt.fileBlob) {
    const { error: upErr } = await supabase.storage
      .from("trial-balance-files")
      .upload(receipt.filePath, receipt.fileBlob, { upsert: true });
    if (upErr) throw upErr;
  }
  const { error } = await supabase
    .from("trial_balance_uploads")
    .insert(receipt.row as never);
  if (error) {
    // 23505 = unique_violation (Postgres). The row is already back — a redundant second Undo click,
    // not a genuine failure.
    if (error.code === "23505") return;
    throw error;
  }
}

/**
 * offerUndo — the toast that holds the undo window open. One action, one
 * outcome: the prior trial balance is back, or the toast expires and the
 * discard is final.
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
              await restoreUpload(receipt);
              toast.success(`${receipt.fileName} restored.`);
              onRestored?.();
            } catch (err) {
              toast.error(
                err instanceof Error
                  ? `Could not restore: ${err.message}`
                  : "Could not restore this trial balance.",
              );
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
  replacementFileName,
}: {
  target: DiscardTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscarded: (id: string, receipt: DiscardReceipt) => void;
  /** Set when the user already picked the file that replaces this run. */
  replacementFileName?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  // Kept inline (not just a toast, which can be missed or dismissed) so the reason, whether it's
  // safe to retry, and the reference id stay on screen for as long as the dialog does.
  const [lastError, setLastError] = useState<DiscardError | string | null>(null);

  useEffect(() => {
    if (open) {
      setLastError(null);
    }
  }, [open, target?.id]);

  const isCertified = isCertifiedRun(target);
  // Certified/processed uploads never reach a typed-DISCARD hard-delete gate at all — there is
  // nothing to confirm one's way past; discard_trial_balance_upload() would refuse it with
  // 'replacement_required' regardless. Use "Replace trial balance" instead.
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
      const message =
        err instanceof DiscardError ? err.safeMessage : "Could not discard this trial balance. Please try again.";
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
            Discard trial balance
          </p>
          <AlertDialogTitle className="text-lg leading-snug tracking-tight">
            {target?.file_name ?? "This upload"}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[13px] leading-relaxed">
            {isCertified ? (
              "This upload has validation history and cannot be deleted from the engagement record. Uploading a replacement retires it from the active workflow while preserving its evidence."
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
          {/* Never rendered for a certified/processed upload — see the notice above instead. */}
          {!isCertified && (
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