/**
 * ManageTrialBalance — the one place a Trial Balance source is replaced or removed, rendered directly under the file
 * header on Prepare Data (never below the pre-flight checklist). The Overview's "Manage file" link lands here and
 * focuses it.
 *
 * What it offers comes from trialBalanceManagement.ts (server reads only); every action is still decided by the
 * database. Remove always asks for explicit confirmation and never hard-deletes accounting evidence.
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { MANAGE_TRIAL_BALANCE_ANCHOR, type RemoveAction, type SourceManagementMode } from "@/lib/workspace/trialBalanceManagement";

export const REMOVE_CONFIRMATION_COPY =
  "Remove this Trial Balance from active use? Existing audit history and evidence records will remain preserved.";

const REMOVE_FOLLOW_UP: Record<"remove" | "discard" | "cancel_replacement", string> = {
  remove: "The period will need a new Trial Balance before work continues.",
  discard: "It has not been processed yet. You can undo this for a short time afterwards.",
  cancel_replacement: "The Trial Balance it replaced becomes the active one again.",
};

export function ManageTrialBalance({
  mode,
  removeAction,
  replacing,
  removing,
  focusRequested,
  onReplace,
  onRemove,
}: {
  mode: SourceManagementMode;
  removeAction: RemoveAction | null;
  replacing: boolean;
  removing: boolean;
  /** The page was opened from "Manage file": bring this area into view and focus it. */
  focusRequested: boolean;
  onReplace: () => void;
  onRemove: () => Promise<void> | void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!focusRequested) return;
    const t = window.setTimeout(() => {
      headingRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      headingRef.current?.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(t);
  }, [focusRequested]);

  const busy = replacing || removing;

  return (
    <section
      id={MANAGE_TRIAL_BALANCE_ANCHOR}
      aria-labelledby={`${MANAGE_TRIAL_BALANCE_ANCHOR}-title`}
      data-testid="manage-trial-balance"
      data-mode={mode}
      className={`mt-3 rounded-md border px-3 py-3 ${focusRequested ? "border-primary/60 ring-2 ring-primary/20" : "border-border"}`}
    >
      <h2
        id={`${MANAGE_TRIAL_BALANCE_ANCHOR}-title`}
        ref={headingRef}
        tabIndex={-1}
        className="text-[12px] font-semibold uppercase tracking-[0.14em] text-muted-foreground outline-none"
      >
        Manage Trial Balance
      </h2>

      {mode === "manage" && (
        <div className="mt-2 flex flex-wrap items-start gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={onReplace} data-testid="replace-trial-balance">
            {replacing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            {replacing ? "Replacing…" : "Replace Trial Balance"}
          </Button>
          {removeAction && removeAction.kind !== "unavailable" && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmOpen(true)}
              data-testid="remove-trial-balance"
              className="text-destructive hover:text-destructive"
            >
              {removing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
              {removing ? "Removing…" : "Remove Trial Balance"}
            </Button>
          )}
          {removeAction?.kind === "unavailable" && (
            <div className="flex flex-col gap-1">
              <Button variant="outline" size="sm" disabled data-testid="remove-trial-balance">
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Remove Trial Balance
              </Button>
              <p className="max-w-md text-[12px] text-muted-foreground" data-testid="remove-unavailable-reason">{removeAction.reason}</p>
            </div>
          )}
        </div>
      )}

      {mode === "view_only" && (
        <p className="mt-2 text-[12px] text-muted-foreground" data-testid="manage-view-only">
          You can view this Trial Balance. Replacing or removing it needs source-file access, which the workspace owner can grant.
        </p>
      )}

      {mode === "archive" && (
        <p className="mt-2 text-[12px] text-muted-foreground" data-testid="manage-archive">
          This workspace is read-only because its account has no current plan. Historical records stay available.{" "}
          <Link to="/plans" className="underline underline-offset-4 hover:text-foreground">View plans</Link>
        </p>
      )}

      {mode === "unknown" && (
        <p className="mt-2 text-[12px] text-muted-foreground" data-testid="manage-checking">Checking what you can change…</p>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={(o) => { if (!removing) setConfirmOpen(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Trial Balance</AlertDialogTitle>
            <AlertDialogDescription>
              {REMOVE_CONFIRMATION_COPY}
              {removeAction && removeAction.kind !== "unavailable" && (
                <span className="mt-2 block">{REMOVE_FOLLOW_UP[removeAction.kind]}</span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-remove-trial-balance"
              disabled={removing}
              onClick={(e) => {
                e.preventDefault();
                void (async () => {
                  await onRemove();
                  setConfirmOpen(false);
                })();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing ? "Removing…" : "Remove Trial Balance"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
