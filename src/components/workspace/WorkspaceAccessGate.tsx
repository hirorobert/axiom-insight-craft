/**
 * WorkspaceAccessGate — the workspace shell's access boundary (PR #32 access bridge).
 *
 * Access is decided by the server (get_workspace_access; see src/lib/workspace/workspaceAccess.ts). These
 * components only render that decision:
 *   WorkspaceAccessShell   no access → a plain refusal (nothing of the workspace is read or shown);
 *                          a failed check → a retry, never a guess in either direction.
 *   OverviewAccessGate     Prepare-only access skips the Overview (its service decisions are not theirs) and
 *                          lands on Prepare Data.
 *   StageAccessBoundary    a stage outside the caller's access, reached by URL.
 */

import { Link, Navigate } from "react-router-dom";
import { Lock, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { isPrepareOnly, type WorkspaceAccessState } from "@/lib/workspace/workspaceAccess";
import { STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import type { WorkspaceMission } from "@/lib/workspace/types";

export function WorkspaceAccessShell({
  accessState,
  onRetry,
  children,
}: {
  accessState: WorkspaceAccessState;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  if (accessState.status === "loading") {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-3" role="status" aria-live="polite">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-3 w-40" />
        <span className="sr-only">Checking your access to this workspace…</span>
      </div>
    );
  }
  if (accessState.status === "denied") {
    return (
      <div data-testid="workspace-access-denied" className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 px-5 text-center">
        <ShieldAlert className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-base font-semibold text-foreground">You don't have access to this workspace</h1>
        <p className="max-w-sm text-[13px] text-muted-foreground">
          Ask the user who created this workspace to grant you access. If they already did, the access may have been removed.
        </p>
        <Button asChild className="h-10 px-5 text-[13px] font-semibold rounded-none shadow-none">
          <Link to="/dashboard" state={{ forceHub: true }}>Go to your workspaces</Link>
        </Button>
      </div>
    );
  }
  if (accessState.status === "error") {
    return (
      <div data-testid="workspace-access-error" className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 px-5 text-center">
        <p className="max-w-sm text-[13px] text-muted-foreground">
          Could not check your access to this workspace. This is a connection problem, not a change to your access.
        </p>
        <Button onClick={onRetry} className="h-10 px-5 text-[13px] font-semibold rounded-none shadow-none">Try again</Button>
      </div>
    );
  }
  return <>{children}</>;
}

export function OverviewAccessGate({ children }: { children: React.ReactNode }) {
  const { access, companyId, periodYear } = useWorkspace();
  if (isPrepareOnly(access)) return <Navigate to={`/workspace/${companyId}/${periodYear}/prepare`} replace />;
  return <>{children}</>;
}

export function StageAccessBoundary({ stage, prepareHref }: { stage: WorkspaceMission; prepareHref: string }) {
  return (
    <div data-testid="stage-access-boundary" className="mx-auto max-w-lg py-16 text-center space-y-4">
      <Lock className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden="true" />
      <h1 className="text-base font-semibold text-foreground">{STAGE_CONFIGS[stage].label} isn't shared with you</h1>
      <p className="text-[13px] text-muted-foreground">
        You have access to Prepare Data only. Additional stages require explicit access from a user authorized to administer this workspace.
      </p>
      <Button asChild className="h-10 px-5 text-[13px] font-semibold rounded-none shadow-none">
        <Link to={prepareHref}>Go to Prepare Data</Link>
      </Button>
    </div>
  );
}
