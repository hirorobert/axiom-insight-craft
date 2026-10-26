/**
 * Close Review › Findings (workbench page `close-findings`). Registered only when the page is released
 * (RELEASED_WORKBENCH_PAGES) — after its migrations are applied and the company is allow-listed in the
 * financial-statements rollout. Reads only; every write is a server function.
 */
import { useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAuth } from "@/contexts/AuthContext";
import { useWorkspaceCapabilities } from "@/hooks/useWorkspaceCapabilities";
import { supabase } from "@/integrations/supabase/client";
import { FindingsView } from "@/components/closeReview/FindingsView";
import { findingsClient } from "@/lib/closeReview/findings";
import { timelineClient, type TimelineDb } from "@/lib/closeReview/timeline";
import { parseReportVersion, withContext } from "@/lib/workbench/context";
import { correctionHref, FINDING_PARAM, parseFocusFinding } from "@/lib/workspace/accountCorrection";

export default function CloseFindings() {
  const { companyId, periodYear } = useWorkspace();
  const { user } = useAuth();
  const { state: caps } = useWorkspaceCapabilities(companyId);
  const { search, pathname } = useLocation();
  const navigate = useNavigate();
  const reportVersion = parseReportVersion(search);
  // The opened finding is kept in the address (replace, not push): Back from the account returns to it, and so does a reload.
  const onSelectFinding = useCallback((key: string | null) => {
    const q = new URLSearchParams([...new URLSearchParams(search)].filter(([k]) => k !== FINDING_PARAM));
    if (key) q.set(FINDING_PARAM, key);
    navigate({ pathname, search: q.toString() ? `?${q.toString()}` : "" }, { replace: true });
  }, [navigate, pathname, search]);
  const db = supabase as unknown as Parameters<typeof findingsClient>[0] & TimelineDb;
  const client = useMemo(() => findingsClient(db), [db]);
  const timeline = useMemo(() => timelineClient(db), [db]);
  return (
    <div className="space-y-6 p-4">
      <h1 className="text-lg font-semibold">Close Review — Findings · FY{periodYear}</h1>
      <FindingsView companyId={companyId} periodYear={periodYear} client={client} timeline={timeline} allowed={caps?.allowed ?? []}
        currentUserId={user?.id ?? null} reviewHref={withContext(`/workspace/${companyId}/${periodYear}/trial-balance/review`, { reportVersion })}
        correctionHref={(f) => correctionHref(companyId, periodYear, f, reportVersion)}
        focusFindingKey={parseFocusFinding(search)} onSelectFinding={onSelectFinding} />
    </div>
  );
}
