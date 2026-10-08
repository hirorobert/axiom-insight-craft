/**
 * Financial Statements and Sign-off & Exports pages of the workbench (fs-statements, fs-notes, fs-schedules,
 * fs-comparatives, signoff, exports). Registered only once each page is released (routes.ts RELEASED_WORKBENCH_PAGES) —
 * after their migrations are applied, the Statements stage is no longer withheld (moduleAvailability.ts) and the company
 * is allow-listed in the financial-statements rollout. Reads only; every write is a server function.
 */
import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkspaceCapabilities } from "@/hooks/useWorkspaceCapabilities";
import { supabase } from "@/integrations/supabase/client";
import { ReportingWorkbench } from "@/components/reporting/ReportingWorkbench";
import type { ReportingPage } from "@/components/reporting/shared";
import { supabaseReportingDb } from "@/lib/reporting/supabaseDb";
import { WORKBENCH_GROUPS } from "@/lib/workbench/routes";
import { parseReportVersion, withContext } from "@/lib/workbench/context";

const SEGMENT = Object.fromEntries(WORKBENCH_GROUPS.flatMap((g) => g.pages.map((p) => [p.id, p.segment]))) as Record<string, string>;

export default function ReportingWorkbenchPage({ page }: { page: ReportingPage }) {
  const { companyId, periodYear, company } = useWorkspace();
  const { state: caps } = useWorkspaceCapabilities(companyId);
  const { search } = useLocation();
  const db = useMemo(() => supabaseReportingDb(supabase), []);
  const base = `/workspace/${companyId}/${periodYear}`;
  return (
    <ReportingWorkbench page={page} companyId={companyId} periodYear={periodYear} legalName={company?.name ?? "The company"} db={db}
      allowed={caps?.allowed ?? []} reportVersion={parseReportVersion(search)}
      hrefFor={(p, v) => withContext(`${base}/${SEGMENT[p]}`, { reportVersion: v })} />
  );
}
