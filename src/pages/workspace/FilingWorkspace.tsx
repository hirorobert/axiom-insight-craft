/**
 * FilingWorkspace — Engagement Outputs.
 *
 * Re-homes from Dashboard:
 *   NoteSynth, MgmtLetterPanel, TRAFilingChecklist
 *
 * TRAAuditReadinessPanel and ClientSummaryPanel moved to ComplianceWorkspace
 * (Phase C) — audit readiness and client-facing summaries are stage-5
 * compliance review artefacts, not stage-6 filing-pack artefacts.
 */

import { useWorkspace } from "@/contexts/WorkspaceContext";
import { WorkspaceGate } from "@/components/workspace/WorkspaceGate";
import { NoteSynth } from "@/components/NoteSynth";
import { MgmtLetterPanel } from "@/components/MgmtLetterPanel";
import { JurisdictionGate, JurisdictionPanel } from "@/components/jurisdiction/JurisdictionPanel";
import { useEngagement } from "@/contexts/EngagementContext";
import { serviceAvailability } from "@/lib/jurisdiction/registry";
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

export default function FilingWorkspace() {
  const { upload, company, workspaceState, refreshUpload } = useWorkspace();
  const mission = workspaceState.missions.filing;

  if (mission.status === "locked") {
    return (
      <WorkspaceGate
        mission="Prepare Outputs"
        blocker={mission.blocker ?? "Complete prerequisites first"}
        prerequisiteHref={workspaceState.missions.tax.href}
        prerequisiteLabel="Go to Compute Tax"
      />
    );
  }

  if (!upload || !upload.company_id || upload.status !== "complete" || upload.is_valid !== true) {
    return (
      <WorkspaceGate
        mission="Prepare Outputs"
        blocker="Valid processed trial balance required"
        prerequisiteHref={workspaceState.missions.prepare.href}
        prerequisiteLabel="Go to Prepare Data"
      />
    );
  }

  const { periodYear: fpYear, periodEndMonth: fpMonth } = deriveFiscalPeriod(
    upload,
    company?.fiscal_year_end ?? null,
  );

  const mapping = upload.processing_result?.mapping;
  const result = upload.processing_result;
  return (
    <div className="space-y-6 max-w-5xl">
      {/* Disclosure Notes */}
      {mapping && (
        <NoteSynth
          uploadId={upload.id}
          existingNotes={result?.disclosureNotes}
          onNotesGenerated={refreshUpload}
        />
      )}

      {/* Management Letter */}
      {mapping && (
        <MgmtLetterPanel
          uploadId={upload.id}
          companyId={upload.company_id}
          existingLetter={result?.managementLetter ?? null}
          onLetterGenerated={refreshUpload}
        />
      )}

      {/* TRA Filing Checklist */}
      <JurisdictionPanel
        jurisdiction={company?.filing_jurisdiction ?? null}
        panel="filingChecklist"
        companyId={upload.company_id}
        uploadId={upload.id}
        periodYear={fpYear}
        periodMonth={fpMonth}
        companyName={upload.company_name ?? undefined}
        userId=""
      />
    </div>
  );
}
