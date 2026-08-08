/**
 * DiscardUploadDialog — irreversible removal of a trial balance upload.
 *
 * Safety model:
 *  - A run that is still Processing, Blocked or Needs review can be discarded
 *    with a single confirmation: nothing downstream depends on it yet.
 *  - A Certified run is evidence. Discarding it requires typing DISCARD so it
 *    can never happen by accident.
 *  - Storage object removal is best effort; the authoritative act is deleting
 *    the row (RLS scopes it to the uploader).
 *  - A discard is reversible for a short undo window: the row snapshot and the
 *    stored file are captured *before* deletion, so a mis-tap can be undone
 *    exactly (same id, same file, same results) from the toast.
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
 * discardUpload — the single authoritative removal act, shared by the
 * confirmation dialog and the one-tap replace flow.
 * Storage cleanup is best effort; deleting the row is what counts.
 * Returns a receipt that makes the act reversible for the undo window.
 */
export async function discardUpload(target: DiscardTarget): Promise<DiscardReceipt> {
  // Capture before destroying — this is what makes undo exact.
  const { data: row } = await supabase
    .from("trial_balance_uploads")
    .select("*")
    .eq("id", target.id)
    .maybeSingle();

  let fileBlob: Blob | null = null;
  if (target.file_path) {
    const { data } = await supabase.storage
      .from("trial-balance-files")
      .download(target.file_path);
    fileBlob = data ?? null;
    await supabase.storage.from("trial-balance-files").remove([target.file_path]);
  }
  const { error } = await supabase
    .from("trial_balance_uploads")
    .delete()
    .eq("id", target.id);
  if (error) throw error;

  return {
    id: target.id,
    fileName: target.file_name,
    row: (row as Record<string, unknown> | null) ?? null,
    filePath: target.file_path ?? null,
    fileBlob,
  };
}

/**
 * restoreUpload — puts a discarded run back: the file first (so processing can
 * re-read it), then the row with its original id and results.
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
  if (error) throw error;
}

/**
 * offerUndo — the toast that holds the undo window open. One action, one
 * outcome: the prior trial balance is back, or the toast expires and the
 * discard is final.
 */
export function offerUndo(receipt: DiscardReceipt, onRestored?: () => void) {
  toast.success(`Discarded ${receipt.fileName}`, {
    description: "You have a few seconds to put it back.",
    duration: UNDO_WINDOW_MS,
    action: {
      label: "Undo",
      onClick: () => {
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
  });
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

  useEffect(() => {
    if (open) setConfirmText("");
  }, [open, target?.id]);

  const isCertified = isCertifiedRun(target);
  const gateSatisfied = !isCertified || confirmText.trim().toUpperCase() === "DISCARD";

  const handleDiscard = async () => {
    if (!target || busy || !gateSatisfied) return;
    setBusy(true);
    try {
      const receipt = await discardUpload(target);
      if (replacementFileName) {
        toast.success(`Discarded. Uploading ${replacementFileName}…`);
      }
      onDiscarded(target.id, receipt);
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `Could not discard: ${err.message}`
          : "Could not discard this trial balance.",
      );
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