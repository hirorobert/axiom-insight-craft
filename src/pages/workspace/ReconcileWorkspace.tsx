/**
 * ReconcileWorkspace — EFDMS reconciliation and adjusting journal review.
 *
 * Phase A placeholder: route resolves, content arrives in Phase C when
 * EFDMSReconciliationPanel and AdjustingJournalPanel are re-homed here.
 */

import { GitCompare } from "lucide-react";

export default function ReconcileWorkspace() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[40vh] text-center gap-4">
      <GitCompare className="w-8 h-8 text-muted-foreground/40" />
      <div>
        <p className="text-sm font-medium text-foreground">Reconcile</p>
        <p className="text-xs text-muted-foreground mt-1">
          EFDMS reconciliation and adjusting journal review — coming in Phase C.
        </p>
      </div>
    </div>
  );
}
