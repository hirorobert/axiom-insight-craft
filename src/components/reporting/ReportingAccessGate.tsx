/**
 * ReportingAccessGate — the route guard of the reporting pages (Financial Statements; Sign-off & Exports).
 *
 * A page renders only for a member whose server-granted access opens the Statements stage AND whose company the server
 * reports as enabled for reporting (financial_statements_workspace_access: rollout allow-list, kill switch). Everyone
 * else sees the same neutral unavailable boundary as before activation. Every write is still authorized by the server.
 */
import type { ReactNode } from "react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import WorkspaceUnavailable from "@/components/workspace/WorkspaceUnavailable";
import { useReportingAccess } from "@/hooks/useReportingAccess";
import { canOpenStage } from "@/lib/workspace/workspaceAccess";

/** `prepareStage`: a page of the Prepare stage that ships with reporting (Close Review › Findings) — the stage scope is
 * already checked by its StageScopeGate; this gate adds the company's reporting access. */
export default function ReportingAccessGate({ children, prepareStage = false }: { children: ReactNode; prepareStage?: boolean }) {
  const { companyId, access } = useWorkspace();
  const reporting = useReportingAccess(companyId);
  if (!prepareStage && !canOpenStage(access, "statements")) return <WorkspaceUnavailable />;
  if (reporting.state === "loading") return null;
  if (reporting.state !== "enabled") return <WorkspaceUnavailable />;
  return <>{children}</>;
}
