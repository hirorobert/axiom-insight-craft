/**
 * ReconcileWorkspace — the jurisdiction reconciliation panel, and adjusting entries as a READ-ONLY history.
 *
 * One adjustment path. The retired journal panel wrote adjusting entries from the browser (and recorded the signed-in user
 * as approver); 20261026100000 closes that write path in the database. Adjustments are proposed, reviewed and approved
 * only in Close Review › Adjustments (server functions, separation of duties). This page links there when it is offered
 * for the workspace and keeps earlier entries visible, read-only (LegacyAdjustmentsHistory).
 *
 * Mission status is "not_applicable" (always available) at the ENGINE level — deriveWorkspaceState
 * deliberately never gates this stage (see its own doc comment: "reconcile and compliance are na()
 * in all paths"). That is a scope decision, not a licence to reconcile against an unproven trial
 * balance: this page's OWN readiness check additionally requires the SAME certification authority
 * PATH 6B established for Statements/Tax (workspaceState.nextAction) — reconciling figures that
 * have not been certified would risk reconciling against numbers that are simply wrong.
 *
 * When not ready, this renders the SAME <WorkspaceGate> every other locked stage uses — one
 * dominant "Go to Prepare Data" CTA, the exact authoritative blocker text, no irrelevant controls —
 * rather than a bespoke, CTA-less message.
 */

import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAuth } from "@/contexts/AuthContext";
import { JurisdictionPanel } from "@/components/jurisdiction/JurisdictionPanel";
import { LegacyAdjustmentsHistory } from "@/components/LegacyAdjustmentsHistory";
import { RELEASED_WORKBENCH_PAGES } from "@/lib/workbench/routes";
import { WORKBENCH_NAVIGATION_ENABLED } from "@/lib/workbench/gate";
import { useReportingAccess } from "@/hooks/useReportingAccess";
import { WorkspaceGate } from "@/components/workspace/WorkspaceGate";
import type { WorkspaceUpload } from "@/hooks/useWorkspaceData";

function deriveFiscalPeriod(upload: WorkspaceUpload, fiscalYearEnd: string | null) {
  if (upload.period_year && upload.period_year > 2000) {
    const fyeStr = upload.fiscal_year_end ?? fiscalYearEnd;
    const month = fyeStr ? new Date(fyeStr).getMonth() + 1 : 12;
    return { periodYear: upload.period_year, periodEndMonth: isNaN(month) ? 12 : month };
  }
  if (upload.fiscal_year_end) {
    const d = new Date(upload.fiscal_year_end);
    if (!isNaN(d.getTime())) return { periodYear: d.getFullYear(), periodEndMonth: d.getMonth() + 1 };
  }
  if (fiscalYearEnd) {
    const d = new Date(fiscalYearEnd);
    if (!isNaN(d.getTime())) return { periodYear: d.getFullYear(), periodEndMonth: d.getMonth() + 1 };
  }
  const uploadDate = new Date(upload.uploaded_at);
  const uploadMonth = uploadDate.getMonth() + 1;
  const uploadYear = uploadDate.getFullYear();
  return { periodYear: uploadMonth <= 9 ? uploadYear - 1 : uploadYear, periodEndMonth: 12 };
}

export default function ReconcileWorkspace() {
  const { upload, company, workspaceState, companyId, periodYear } = useWorkspace();
  const { user } = useAuth();
  // Close Review › Adjustments is offered exactly where its route is registered and its gate admits (App.tsx).
  const reporting = useReportingAccess(companyId);
  const adjustmentsHref = WORKBENCH_NAVIGATION_ENABLED && RELEASED_WORKBENCH_PAGES.has("close-adjustments") && reporting.state === "enabled"
    ? `/workspace/${companyId}/${periodYear}/close/adjustments` : null;

  // The same certification-blocked signal PATH 6B computes (workspaceState.nextAction) — never a
  // second, independently-derived readiness check. See stageLockGate.test.ts for the identical
  // pattern on Statements/Tax/Filing.
  const certificationBlocked =
    workspaceState.nextAction.id === "fix-certification-failure" || workspaceState.nextAction.id === "await-certification";
  const ready =
    upload && upload.company_id && upload.status === "complete" && upload.is_valid === true && !certificationBlocked;

  if (!ready) {
    const prepareHref = workspaceState.missions.prepare.href || `/workspace/${companyId}/${periodYear}/prepare`;
    const blocker = certificationBlocked
      ? (workspaceState.missions.prepare.blocker ?? workspaceState.nextAction.description)
      : !upload
        ? "No trial balance found for this period."
        : "Reconciliation and adjusting journal review require a validated, certified trial balance.";
    return (
      <WorkspaceGate
        mission="Reconcile"
        blocker={blocker}
        prerequisiteHref={prepareHref}
        prerequisiteLabel="Go to Prepare Data"
      />
    );
  }

  const { periodYear: fpYear, periodEndMonth: fpMonth } = deriveFiscalPeriod(
    upload,
    company?.fiscal_year_end ?? null,
  );

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Jurisdiction extension: renders only when the workspace explicitly selected a jurisdiction whose pack ships one. */}
      <JurisdictionPanel
        jurisdiction={company?.filing_jurisdiction ?? null}
        panel="reconciliation"
        companyId={upload.company_id}
        uploadId={upload.id}
        periodYear={fpYear}
        periodMonth={fpMonth}
        companyName={upload.company_name ?? undefined}
        userId={user?.id ?? ""}
      />

      {/* One adjustment path: Close Review › Adjustments. Earlier entries stay visible here, read-only. */}
      <LegacyAdjustmentsHistory companyId={upload.company_id} periodYear={fpYear} adjustmentsHref={adjustmentsHref} />
    </div>
  );
}
