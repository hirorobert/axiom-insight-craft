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

export function DiscardUploadDialog({
  target,
  open,
  onOpenChange,
  onDiscarded,
}: {
  target: DiscardTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscarded: (id: string) => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setConfirmText("");
  }, [open, target?.id]);

  const isCertified = target?.status === "complete" || target?.is_valid === true;
  const gateSatisfied = !isCertified || confirmText.trim().toUpperCase() === "DISCARD";

  const handleDiscard = async () => {
    if (!target || busy || !gateSatisfied) return;
    setBusy(true);
    try {
      if (target.file_path) {
        await supabase.storage.from("trial-balance-files").remove([target.file_path]);
      }
      const { error } = await supabase
        .from("trial_balance_uploads")
        .delete()
        .eq("id", target.id);
      if (error) throw error;

      toast.success("Trial balance discarded. You can upload a fresh file now.");
      onDiscarded(target.id);
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
            This removes the file and every result derived from it. Nothing is kept.
            {isCertified
              ? " This run is certified evidence — statements and tax outputs built on it will lose their source."
              : " No later stage has used this run yet, so nothing downstream is affected."}
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
              "Discard and start fresh"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default DiscardUploadDialog;