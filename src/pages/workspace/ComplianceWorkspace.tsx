/**
 * ComplianceWorkspace — TRA audit readiness, client summaries, findings review.
 *
 * Re-homed in Phase C:
 *   KingaFindingsPanel (from TaxWorkspace "Compliance Analysis" tab — matches
 *     Architecture v3.1's stage-5 "KINGA findings" engine assignment; also
 *     carries EvidenceRequestPanel, which is nested inside KingaFindingsPanel's
 *     evidence-request dialog rather than a standalone top-level panel)
 *   TRAAuditReadinessPanel (from FilingWorkspace)
 *   ClientSummaryPanel (from FilingWorkspace)
 *
 * ComplianceScorecard intentionally NOT moved here — it renders an all-company
 * portfolio rollup (see ComplianceScorecard.tsx), not a single-engagement view,
 * so it stays in MonitorWorkspace alongside the other portfolio-level panels.
 *
 * Mission status is "not_applicable" (always available) — no WorkspaceGate.
 * Panels themselves require a validated trial balance to render meaningfully.
 */

import { ClipboardCheck } from "lucide-react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAuth } from "@/contexts/AuthContext";
import { JurisdictionGate, JurisdictionPanel } from "@/components/jurisdiction/JurisdictionPanel";
import { useEngagement } from "@/contexts/EngagementContext";
import { serviceAvailability } from "@/lib/jurisdiction/registry";
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

export default function ComplianceWorkspace() {
  const { upload, company, companyId } = useWorkspace();
  const { user } = useAuth();
  const { canAmend } = useEngagement();
  const jurisdiction = company?.filing_jurisdiction ?? null;

  // Compliance review is unavailable until a filing jurisdiction is selected — and only for one that ships a pack.
  if (!serviceAvailability("COMPLIANCE_REVIEW", jurisdiction).available) {
    return <JurisdictionGate capability="COMPLIANCE_REVIEW" jurisdiction={jurisdiction} companyId={companyId} canChange={canAmend} />;
  }

  const ready =
    upload && upload.company_id && upload.status === "complete" && upload.is_valid === true;

  if (!ready) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh] text-center gap-4">
        <ClipboardCheck className="w-8 h-8 text-muted-foreground/40" />
        <div>
          <p className="text-sm font-medium text-foreground">Compliance Review</p>
          <p className="text-xs text-muted-foreground mt-1">
            Audit readiness, client summaries, and evidence packages require a validated trial balance.
          </p>
        </div>
      </div>
    );
  }

  const { periodYear: fpYear, periodEndMonth: fpMonth } = deriveFiscalPeriod(
    upload,
    company?.fiscal_year_end ?? null,
  );

  return (
    <div className="space-y-6 max-w-5xl">
      <JurisdictionPanel
        jurisdiction={jurisdiction}
        panel="findings"
        companyId={upload.company_id}
        uploadId={upload.id}
        periodYear={fpYear}
        periodMonth={fpMonth}
        companyName={upload.company_name ?? undefined}
        userId={user?.id ?? ""}
      />

      <JurisdictionPanel
        jurisdiction={jurisdiction}
        panel="auditReadiness"
        companyId={upload.company_id}
        uploadId={upload.id}
        periodYear={fpYear}
        periodMonth={fpMonth}
        companyName={upload.company_name ?? undefined}
        userId={user?.id ?? ""}
      />

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
