/**
 * HesabuWorkspace — Financial Statement Validation.
 *
 * Re-homes from Dashboard:
 *   HesabuAssurancePanel, PeriodClosingBalancesPanel
 *
 * Gate: upload must be complete + valid.
 * Safisha gate does NOT block HESABU draft validation.
 */

import { useWorkspace } from "@/contexts/WorkspaceContext";
import { HesabuAssurancePanel } from "@/components/HesabuAssurancePanel";
import { PeriodClosingBalancesPanel } from "@/components/PeriodClosingBalancesPanel";
import { WorkspaceGate } from "@/components/workspace/WorkspaceGate";

export default function HesabuWorkspace() {
  const { upload, workspaceState } = useWorkspace();

  const mission = workspaceState.missions.hesabu;

  if (mission.status === "locked") {
    return (
      <WorkspaceGate
        mission="HESABU"
        blocker={mission.blocker ?? "Complete prerequisites first"}
        prerequisiteHref={workspaceState.missions.safisha.href}
        prerequisiteLabel="Go to SAFISHA"
      />
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      {upload?.company_id && (
        <>
          <HesabuAssurancePanel uploadId={upload.id} companyId={upload.company_id} />
          <PeriodClosingBalancesPanel
            companyId={upload.company_id}
            companyName={upload.company_name ?? undefined}
          />
        </>
      )}

      {!upload && (
        <WorkspaceGate
          mission="HESABU"
          blocker="No trial balance found for this period"
          prerequisiteHref={workspaceState.missions.safisha.href}
          prerequisiteLabel="Import Trial Balance"
        />
      )}
    </div>
  );
}
