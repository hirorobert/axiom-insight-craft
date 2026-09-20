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
import type { WorkspaceMission } from "@/lib/workspace/types";

export default function StageScopeGate({
  stage,
  children,
}: {
  stage: WorkspaceMission;
  children: React.ReactNode;
}) {
  const { missionViews, loading, mandate } = useEngagement();
  const { companyId, periodYear, uploads } = useWorkspace();

  if (loading) return <>{children}</>;

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