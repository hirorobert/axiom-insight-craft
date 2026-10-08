/**
 * Close Review › Findings (workbench page `close-findings`). Registered only when the page is released
 * (RELEASED_WORKBENCH_PAGES) — after its migrations are applied and the company is allow-listed in the
 * financial-statements rollout. Reads only; every write is a server function.
 */
import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAuth } from "@/contexts/AuthContext";
import { useWorkspaceCapabilities } from "@/hooks/useWorkspaceCapabilities";
import { supabase } from "@/integrations/supabase/client";
import { FindingsView } from "@/components/closeReview/FindingsView";
import { findingsClient } from "@/lib/closeReview/findings";
import { timelineClient, type TimelineDb } from "@/lib/closeReview/timeline";
import { parseReportVersion, withContext } from "@/lib/workbench/context";

export default function CloseFindings() {
  const { companyId, periodYear } = useWorkspace();
  const { user } = useAuth();
  const { state: caps } = useWorkspaceCapabilities(companyId);
  const { search } = useLocation();
  const db = supabase as unknown as Parameters<typeof findingsClient>[0] & TimelineDb;
  const client = useMemo(() => findingsClient(db), [db]);
  const timeline = useMemo(() => timelineClient(db), [db]);
  return (
    <div className="space-y-6 p-4">
      <h1 className="text-lg font-semibold">Close Review — Findings · FY{periodYear}</h1>
      <FindingsView companyId={companyId} periodYear={periodYear} client={client} timeline={timeline} allowed={caps?.allowed ?? []}
        currentUserId={user?.id ?? null} reviewHref={withContext(`/workspace/${companyId}/${periodYear}/trial-balance/review`, { reportVersion: parseReportVersion(search) })} />
    </div>
  );
}
