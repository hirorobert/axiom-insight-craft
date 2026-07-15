/**
 * ComplianceWorkspace — TRA audit readiness, client summaries, evidence packages.
 *
 * Phase A placeholder: route resolves, content arrives in Phase C when
 * TRAAuditReadinessPanel, ClientSummaryPanel, EvidenceRequestPanel,
 * and ComplianceScorecard are re-homed here.
 */

import { ClipboardCheck } from "lucide-react";

export default function ComplianceWorkspace() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[40vh] text-center gap-4">
      <ClipboardCheck className="w-8 h-8 text-muted-foreground/40" />
      <div>
        <p className="text-sm font-medium text-foreground">Compliance Review</p>
        <p className="text-xs text-muted-foreground mt-1">
          TRA audit readiness, client summaries, evidence packages — coming in Phase C.
        </p>
      </div>
    </div>
  );
}
