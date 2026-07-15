/**
 * FilingWorkspace — Regulatory Filing Package.
 *
 * Re-homes from Dashboard:
 *   NoteSynth, MgmtLetterPanel, ExportStatements,
 *   TRAFilingChecklist, TRAAuditReadinessPanel, ClientSummaryPanel
 */

import { useState } from "react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAuth } from "@/contexts/AuthContext";
import { WorkspaceGate } from "@/components/workspace/WorkspaceGate";
import { NoteSynth } from "@/components/NoteSynth";
import { MgmtLetterPanel } from "@/components/MgmtLetterPanel";
import { ExportStatements, type ProcessingResult, type TaxResultForExport } from "@/components/ExportStatements";
import { TRAFilingChecklist } from "@/components/TRAFilingChecklist";
import { TRAAuditReadinessPanel } from "@/components/TRAAuditReadinessPanel";
import { ClientSummaryPanel } from "@/components/ClientSummaryPanel";
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
  const { user } = useAuth();
  const [taxResult] = useState<TaxResultForExport | null>(null);

  const mission = workspaceState.missions.filing;

  if (mission.status === "locked") {
    return (
      <WorkspaceGate
        mission="Prepare Filing"
        blocker={mission.blocker ?? "Complete prerequisites first"}
        prerequisiteHref={workspaceState.missions.tax.href}
        prerequisiteLabel="Go to Compute Tax"
      />
    );
  }

  if (!upload || !upload.company_id || upload.status !== "complete" || upload.is_valid !== true) {
    return (
      <WorkspaceGate
        mission="Prepare Filing"
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
  const isBlocked =
    upload.status === "blocked" ||
    upload.status === "error" ||
    upload.is_valid === false;

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Export Statements */}
      {!isBlocked ? (
        <div className="border border-border p-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-foreground">Export 6-Page Financial Statements</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              SFP · SCI · SOCIE · SCF · Disclosure Notes · Tax Computation
            </p>
          </div>
          <ExportStatements
            fileName={upload.file_name}
            processingResult={upload.processing_result as ProcessingResult | null}
            uploadId={upload.id}
            reportingFramework={company?.reporting_framework ?? null}
            companyName={upload.company_name ?? ""}
            companyTin={company?.tin ?? ""}
            periodYearEnd={company?.fiscal_year_end ?? ""}
            companyCurrency={company?.currency ?? "TZS"}
            taxResult={taxResult}
          />
        </div>
      ) : null}

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
          existingLetter={result?.managementLetter ?? null}
          onLetterGenerated={refreshUpload}
        />
      )}

      {/* TRA Filing Checklist */}
      <TRAFilingChecklist
        uploadId={upload.id}
        companyId={upload.company_id}
        periodYear={fpYear}
        periodMonth={fpMonth}
        companyName={upload.company_name ?? undefined}
      />

      {/* TRA Audit Readiness */}
      <TRAAuditReadinessPanel
        companyId={upload.company_id}
        uploadId={upload.id}
        periodYear={fpYear}
        periodMonth={fpMonth}
        companyName={upload.company_name ?? undefined}
        userId={user?.id ?? ""}
      />

      {/* Client Summary Report */}
      <ClientSummaryPanel
        companyId={upload.company_id}
        uploadId={upload.id}
        periodYear={fpYear}
        companyName={upload.company_name ?? undefined}
        userId={user?.id ?? ""}
      />
    </div>
  );
}
