/**
 * StageScopeGate — scope-aware route guard.
 *
 * In scope (or mandate unknown): render the stage exactly as before.
 * Out of scope: render the restrained boundary instead of the stage.
 *
 * This guard reads the mandate only. It never evaluates an accounting gate and
 * never changes a workflow status.
 */

import { Navigate } from "react-router-dom";
import { useEngagement } from "@/contexts/EngagementContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { findMissionView, stageHasWork } from "@/lib/workspace/mandate";
import EngagementScopeBoundary from "@/components/workspace/EngagementScopeBoundary";
import { StageAccessBoundary } from "@/components/workspace/WorkspaceAccessGate";
import { canOpenStage, isPrepareOnly } from "@/lib/workspace/workspaceAccess";
import type { WorkspaceMission } from "@/lib/workspace/types";

export default function StageScopeGate({
  stage,
  children,
}: {
  stage: WorkspaceMission;
  children: React.ReactNode;
}) {
  const { missionViews, loading, mandate } = useEngagement();
  const { companyId, periodYear, uploads, access } = useWorkspace();

  // Access comes first (PR #32 access bridge): a stage outside what the server granted this user never renders,
  // whatever the mandate says. A Prepare-only grant holder cannot read the engagement mandate, so Prepare is
  // decided by their grant alone; every action inside it is authorized again by the server.
  if (!canOpenStage(access, stage)) {
    return <StageAccessBoundary stage={stage} prepareHref={`/workspace/${companyId}/${periodYear}/prepare`} />;
  }
  if (isPrepareOnly(access)) return <>{children}</>;

  // useEngagementMandate.ts's own `loading` now stays true until user/company/period AND the
  // actual mandate read have all genuinely settled (fixed there — it previously flipped loading
  // false prematurely while auth session restoration was still in flight on a fresh full-page
  // load, which is what let this guard observe loading=false with mandate still null and redirect
  // to Overview before the real mandate ever arrived). A deterministic loading state here, never a
  // redirect, while that resolution is in flight; the authoritative scope decision below only ever
  // runs once loading is genuinely false.
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground" role="status" aria-live="polite">
        Checking what's in scope for this workspace…
      </div>
    );
  }

  const view = findMissionView(missionViews, stage);

  // No services are in scope yet: a stage URL cannot bypass the launchpad. A workspace that already carries work in
  // this stage keeps its route (nothing existing is hidden); anything else returns to the Overview, where the launchpad
  // is the one decision. Navigation is derived from persisted scope, never from the URL.
  const scopeDeclared = !!mandate && mandate.granted.length > 0;
  const hasWork = (view && stageHasWork(view.workflowStatus)) || (stage === "prepare" && uploads.length > 0);
  if (!scopeDeclared && !hasWork) {
    return <Navigate to={`/workspace/${companyId}/${periodYear}`} replace />;
  }
  if (view && !view.visible) {
    return (
      <EngagementScopeBoundary
        stage={stage}
        overviewHref={`/workspace/${companyId}/${periodYear}`}
      />
    );
  }

  return <>{children}</>;
}