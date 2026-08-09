/**
 * StageScopeGate — scope-aware route guard.
 *
 * In scope (or mandate unknown): render the stage exactly as before.
 * Out of scope: render the restrained boundary instead of the stage.
 *
 * This guard reads the mandate only. It never evaluates an accounting gate and
 * never changes a workflow status.
 */

import { useEngagement } from "@/contexts/EngagementContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { findMissionView } from "@/lib/workspace/mandate";
import EngagementScopeBoundary from "@/components/workspace/EngagementScopeBoundary";
import type { WorkspaceMission } from "@/lib/workspace/types";

export default function StageScopeGate({
  stage,
  children,
}: {
  stage: WorkspaceMission;
  children: React.ReactNode;
}) {
  const { missionViews, loading } = useEngagement();
  const { companyId, periodYear } = useWorkspace();

  if (loading) return <>{children}</>;

  const view = findMissionView(missionViews, stage);
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