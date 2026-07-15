/**
 * StatementsWorkspace — Financial Statement Validation.
 *
 * Re-homes from Dashboard:
 *   HesabuAssurancePanel, PeriodClosingBalancesPanel
 *
 * Gate: upload must be complete + valid.
 * Prepare gate does NOT block Statements draft validation.
 */

import { useWorkspace } from "@/contexts/WorkspaceContext";
import { HesabuAssurancePanel } from "@/components/HesabuAssurancePanel";
import { PeriodClosingBalancesPanel } from "@/components/PeriodClosingBalancesPanel";
import { WorkspaceGate } from "@/components/workspace/WorkspaceGate";

export default function StatementsWorkspace() {
  const { upload, workspaceState } = useWorkspace();

  const mission = workspaceState.missions.statements;

  if (mission.status === "locked") {
    return (
      <WorkspaceGate
        mission="Prepare Statements"
        blocker={mission.blocker ?? "Complete prerequisites first"}
        prerequisiteHref={workspaceState.missions.prepare.href}
        prerequisiteLabel="Go to Prepare Data"
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
          mission="Prepare Statements"
          blocker="No trial balance found for this period"
          prerequisiteHref={workspaceState.missions.prepare.href}
          prerequisiteLabel="Import Trial Balance"
        />
      )}
    </div>
  );
}
