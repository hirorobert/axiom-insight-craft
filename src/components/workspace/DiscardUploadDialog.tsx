/**
 * DiscardUploadDialog — irreversible removal of a trial balance upload.
 *
 * Safety model:
 *  - A run that is still Processing, Blocked or Needs review can be discarded
 *    with a single confirmation: nothing downstream depends on it yet.
 *  - A Certified run is evidence. Discarding it requires typing DISCARD so it
 *    can never happen by accident.
 *  - Storage object removal is best effort; the authoritative act is deleting
 *    the row, which happens entirely inside discard_trial_balance_upload() — a
 *    SECURITY DEFINER RPC (20260922180000_discard_trial_balance_authority.sql), never a raw
 *    client-side `.delete()`.
 *  - A discard is reversible for a short undo window: the file is captured *before* the RPC call,
 *    and the row snapshot the RPC itself returns is used for undo, so a mis-tap can be undone
 *    exactly (same id, same file, same results) from the toast.
 *
 * Post-merge hardening (fix/post-merge-workspace-release-blockers) — explicit outcomes, each
 * authoritatively decided server-side, never inferred client-side:
 *
 *   IDLE -> (best-effort file capture) -> RPC DECIDES -> DISCARDED | UNDO_AVAILABLE | FAILED
 *
 * The gap this closes (two layers):
 *
 *   1. `.delete().eq("id", target.id)` alone reports success with NO error even when RLS filtered
 *      the row out of the WHERE clause (zero rows actually affected) or the row was already gone —
 *      PostgREST does not treat "matched nothing" as an error.
 *   2. Distinguishing WHY zero rows were affected by issuing a follow-up `.select()` from the
 *      client is itself unreliable under RLS: RLS filters a row out of visibility rather than
 *      raising a distinguishable error, so a row this caller is not authorized to see is
 *      indistinguishable, from this caller's own RLS-scoped SELECT, from a row that genuinely does
 *      not exist. A client-side "select after zero-row delete" check can misclassify a genuine
 *      FORBIDDEN outcome as ALREADY_DISCARDED whenever the caller's SELECT visibility is narrower
 *      than their (attempted) DELETE authority.
 *
 * discard_trial_balance_upload() resolves both: it reads and authorizes with full visibility
 * (SECURITY DEFINER intentionally bypasses RLS — the function itself IS the authorization
 * boundary, checked explicitly inside its own body) and returns exactly one of four outcomes:
 *   - deleted_now          → this call performed the delete — genuine success;
 *   - already_discarded    → the row genuinely does not exist, checked with full visibility —
 *                             idempotent success, never a second delete, never an error;
 *   - forbidden             → the row exists but this caller has no accepted membership in its
 *                             company — FAILED_TERMINAL, never retryable;
 *   - dependency_conflict   → a foreign key elsewhere in the schema refused the delete —
 *                             FAILED_TERMINAL, never retryable.
 * See the migration's own doc comment for the full root-cause analysis and scope notes (STALE_VERSION
 * is deliberately not a distinct outcome — no optimistic-concurrency column exists on this table).
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
import { Input } from "@/components/ui/input";
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
}

/** True when a run is certified evidence and must not be discarded casually. */
export function isCertifiedRun(target: DiscardTarget | null | undefined): boolean {
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
  constructor(reason: string, opts: { retryable: boolean; cause?: unknown }) {
    super(reason);
    this.name = "DiscardError";
    this.reference = generateDiscardReference();
    this.retryable = opts.retryable;
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
 * discard_trial_balance_upload(uuid) — the SECURITY DEFINER RPC in
 * 20260922180000_discard_trial_balance_authority.sql. Narrow, single-purpose typed adapter
 * following the same sole-cast-boundary pattern as src/lib/commercial/commercialRpc.ts: the
 * migration is committed but not yet applied to any live database (CLAUDE.md §11 — `supabase db
 * push` is the owner's own action), so the generated `Database["public"]["Functions"]` union does
 * not know this function exists yet. The cast below is scoped to exactly this one call signature,
 * hand-verified against the migration's RETURNS TABLE shape; nothing else in this module is
 * untyped. Delete the cast once types.ts is regenerated after the migration is applied.
 */
type DiscardOutcome = "deleted_now" | "already_discarded" | "forbidden" | "dependency_conflict";
interface DiscardRpcRow {
  outcome: DiscardOutcome;
  row_snapshot: Record<string, unknown> | null;
  file_path: string | null;
  detail: string | null;
}
interface DiscardRpcClient {
  rpc: (
    name: "discard_trial_balance_upload",
    args: { p_upload_id: string },
  ) => Promise<{ data: DiscardRpcRow[] | null; error: { message: string } | null }>;
}

/**
 * discardUpload — the single authoritative removal act, shared by the
 * confirmation dialog and the one-tap replace flow.
 *
 * The authoritative existence + authorization decision is made entirely inside
 * discard_trial_balance_upload(), a SECURITY DEFINER function that reads with full visibility
 * (bypassing RLS deliberately, then checking authorization explicitly) — never inferred from what
 * this caller's own RLS-scoped SELECT would or wouldn't return. That is the fix for the case a
 * client-side "select after zero-row delete" check cannot safely resolve: RLS filters an
 * unauthorized row out of visibility rather than raising a distinguishable error, so a caller-side
 * existence check alone cannot tell "genuinely gone" apart from "exists, but I can't see it" — see
 * the migration's own doc comment for the full analysis. Storage cleanup remains client-side and
 * best-effort (Postgres has no access to Supabase Storage); deleting the row is the authoritative
 * act and is never claimed to be atomic with the storage removal.
 */
export async function discardUpload(target: DiscardTarget): Promise<DiscardReceipt> {
  // Best-effort file capture BEFORE the authoritative delete — this is what makes undo exact for a
  // genuine deleted_now. A download failure here does not block the discard and does not affect
  // undo (undo re-uploads fileBlob only when present).
  let fileBlob: Blob | null = null;
  if (target.file_path) {
    const { data } = await supabase.storage.from("trial-balance-files").download(target.file_path);
    fileBlob = data ?? null;
  }

  const rpcClient = supabase as unknown as DiscardRpcClient;
  const { data: rpcRows, error: rpcError } = await rpcClient.rpc("discard_trial_balance_upload", {
    p_upload_id: target.id,
  });
  if (rpcError) {
    throw new DiscardError("Could not discard this trial balance.", { retryable: true, cause: rpcError });
  }
  const result = rpcRows?.[0];
  if (!result) {
    throw new DiscardError("Could not discard this trial balance.", {
      retryable: true,
      cause: new Error("discard_trial_balance_upload returned no result"),
    });
  }

  if (result.outcome === "forbidden") {
    throw new DiscardError(
      result.detail ?? "You are not authorised to discard this trial balance.",
      { retryable: false, cause: new Error(`discard forbidden for id=${target.id}`) },
    );
  }
  if (result.outcome === "dependency_conflict") {
    throw new DiscardError(
      result.detail ?? "This trial balance could not be discarded because other records in this workspace still depend on it.",
      { retryable: false, cause: new Error(`discard dependency_conflict for id=${target.id}`) },
    );
  }

  // deleted_now or already_discarded: both mean the row is (now) gone under the authoritative
  // server check — idempotent success either way (a concurrent duplicate request, or a retry after
  // a prior success whose response never reached this client, resolves the same way).
  const filePath = result.outcome === "deleted_now" ? result.file_path : (target.file_path ?? null);
  if (filePath) {
    // Best-effort — see module doc. Does not affect the outcome already decided above.
    await supabase.storage.from("trial-balance-files").remove([filePath]);
  }

  return {
    id: target.id,
    fileName: target.file_name,
    // already_discarded never carries a snapshot from THIS call (the row was already gone before
    // this call ever asked) — returning null here is correct: restoreUpload() refuses without one,
    // and fabricating a receipt for a row this call never actually deleted would be dishonest.
    row: result.outcome === "deleted_now" ? result.row_snapshot : null,
    filePath,
    fileBlob: result.outcome === "deleted_now" ? fileBlob : null,
  };
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
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  // Kept inline (not just a toast, which can be missed or dismissed) so the reason, whether it's
  // safe to retry, and the reference id stay on screen for as long as the dialog does.
  const [lastError, setLastError] = useState<DiscardError | string | null>(null);

  useEffect(() => {
    if (open) {
      setConfirmText("");
      setLastError(null);
    }
  }, [open, target?.id]);

  const isCertified = isCertifiedRun(target);
  const gateSatisfied = !isCertified || confirmText.trim().toUpperCase() === "DISCARD";

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
            This removes the file and every result derived from it.
            {isCertified
              ? " This run is certified evidence — statements and tax outputs built on it will lose their source."
              : " No later stage has used this run yet, so nothing downstream is affected."}
            {replacementFileName
              ? ` Once discarded, ${replacementFileName} is uploaded straight away.`
              : ""}
            {" You get a short undo window afterwards in case this was a mis-tap."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {isCertified && (
          <div className="space-y-2">
            <label className="text-[11px] font-medium text-foreground">
              Type <span className="font-mono font-semibold">DISCARD</span> to confirm
            </label>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="DISCARD"
              className="h-9 font-mono tracking-widest"
              autoFocus
            />
          </div>
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
            Keep it
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleDiscard();
            }}
            disabled={busy || !gateSatisfied}
            className="rounded-none bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Discarding…
              </span>
            ) : (
              replacementFileName ? "Discard and upload fresh file" : "Discard and start fresh"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default DiscardUploadDialog;