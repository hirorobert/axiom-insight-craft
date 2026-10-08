/**
 * Trial balance › Intake (workbench, I1-A A3). Registered only when WORKBENCH_NAVIGATION_ENABLED; the existing Prepare
 * route is unchanged while the gate is off.
 *
 *   1. Reporting period — explicit dates and currency (open_engagement_with_period); no defaults.
 *   2. Upload — the ONE upload surface stays the Prepare/Review page (firstRunFlow guard); Intake links to it.
 *   3. File layout — when the automatic reading is not right, the person states the layout, checks it against the whole
 *      file on the server, confirms it for this file (or reuses a saved template, re-checked), then runs a new check.
 *
 * Reads only. Every write is a server function: the setup RPC, the trial-balance-layout function and the existing
 * re-check path (tbu_request_reprocess → process-trial-balance).
 */
import { useMemo, useState } from "react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { supabase } from "@/integrations/supabase/client";
import { ensureFreshSession } from "@/lib/ensureFreshSession";
import { Link, useLocation } from "react-router-dom";
import { parseReportVersion, withContext } from "@/lib/workbench/context";
import { PeriodSetup } from "@/components/workbench/intake/PeriodSetup";
import { LayoutEditor, type LayoutTemplateRow } from "@/components/workbench/intake/LayoutEditor";
import { useGuardedRequest } from "@/components/workbench/useGuardedRequest";
import { layoutClient, type LayoutInvoke } from "@/lib/workbench/intake/layoutClient";
import { LAYOUT_ASSIST_ENABLED, layoutAssistClient, type LayoutAssistInvoke } from "@/lib/workbench/intake/layoutAssistClient";
import { latestTemplateVersions, type TemplateReadRow } from "@/lib/workbench/intake/templates";
import { requestReprocess, ReprocessRefusedError, type ReprocessClient } from "@/lib/workspace/requestReprocess";
import type { RpcClient } from "@/lib/workspace/workspaceSetupClient";

async function readTemplates(companyId: string): Promise<LayoutTemplateRow[]> {
  const { data, error } = await (supabase as unknown as {
    from(t: "layout_templates"): { select(c: string): { eq(c: "company_id", v: string): PromiseLike<{ data: TemplateReadRow[] | null; error: { code?: string } | null }> } };
  }).from("layout_templates").select("id, template_key, version, name, profile").eq("company_id", companyId);
  // A database without the layout tables: no templates (the feature is shown as unavailable by the editor).
  if (error) { if (error.code === "PGRST205" || error.code === "42P01") return []; throw error; }
  return latestTemplateVersions(data ?? []);
}

export default function TrialBalanceIntake() {
  const { companyId, periodYear, upload, refreshUpload } = useWorkspace();
  const client = useMemo(() => layoutClient(((name, opts) => supabase.functions.invoke(name, opts)) as LayoutInvoke), []);
  // AI-assisted suggestions only when released (I1-C); otherwise the editor is exactly as before.
  const assist = useMemo(() => (LAYOUT_ASSIST_ENABLED ? layoutAssistClient(((name, opts) => supabase.functions.invoke(name, opts)) as LayoutAssistInvoke) : undefined), []);
  const templates = useGuardedRequest<LayoutTemplateRow[]>("layout-templates", companyId, () => readTemplates(companyId));
  const [confirmedNo, setConfirmedNo] = useState<number | null>(null);
  const [recheck, setRecheck] = useState<{ busy: boolean; text: string | null }>({ busy: false, text: null });
  const periodLabel = `FY${periodYear}`;
  // Navigation keeps the workbench context: company and period are in the path, the report version travels as ?v=.
  const { search } = useLocation();
  const reviewHref = withContext(`/workspace/${companyId}/${periodYear}/trial-balance/review`, { reportVersion: parseReportVersion(search) });

  const checkAgain = async () => {
    if (!upload?.id) return;
    setRecheck({ busy: true, text: null });
    try {
      await requestReprocess(supabase as unknown as ReprocessClient, upload.id, { ensureFreshSession });
      setRecheck({ busy: false, text: "A new check has started with the confirmed layout." });
      refreshUpload();
    } catch (e) {
      setRecheck({ busy: false, text: e instanceof ReprocessRefusedError ? e.message : "The new check could not be started. Nothing was changed." });
    }
  };

  return (
    <div className="space-y-8 p-4">
      <h1 className="text-lg font-semibold">Trial balance — Intake</h1>
      <PeriodSetup client={supabase as unknown as RpcClient} companyId={companyId} />
      <section aria-labelledby="tb-intake-upload" className="space-y-2">
        <h2 id="tb-intake-upload" className="text-base font-semibold">Upload</h2>
        <p className="text-sm">
          {upload?.id ? `Current file: ${upload.file_name ?? "trial balance"}.` : "No trial balance uploaded for this period yet."}{" "}
          <Link className="underline" to={reviewHref}>Upload or replace the file</Link>
        </p>
      </section>
      {upload?.id ? (
        <>
          <LayoutEditor client={client} companyId={companyId} uploadId={upload.id} periodLabel={periodLabel}
            templates={templates.state.status === "ready" ? templates.state.value : []} onConfirmed={setConfirmedNo} assist={assist} />
          {confirmedNo !== null ? (
            <div className="space-y-1">
              <button type="button" className="rounded-md border border-input bg-background px-3 py-1.5 text-sm" disabled={recheck.busy} onClick={() => void checkAgain()}>
                {recheck.busy ? "Starting…" : "Run a new check with this layout"}
              </button>
              <p role="status" className="text-sm">{recheck.text ?? ""}</p>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Upload a trial balance to set its layout.</p>
      )}
    </div>
  );
}
