/**
 * IssuesWorkspace — Findings & Evidence Requests.
 *
 * Re-homes from Dashboard:
 *   EvidenceRequestPanel, KingaFindingsPanel (issues mode)
 *
 * Always available — findings can be raised at any time.
 */

import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAuth } from "@/contexts/AuthContext";
import { KingaFindingsPanel } from "@/components/KingaFindingsPanel";
import { Inbox } from "lucide-react";
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

export default function IssuesWorkspace() {
  const { upload, company } = useWorkspace();
  const { user } = useAuth();

  const { periodYear: fpYear, periodEndMonth: fpMonth } = upload
    ? deriveFiscalPeriod(upload, company?.fiscal_year_end ?? null)
    : { periodYear: 0, periodEndMonth: 12 };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Compliance findings — read-only view */}
      {upload?.company_id &&
        upload.status === "complete" &&
        upload.is_valid === true && (
          <KingaFindingsPanel
            companyId={upload.company_id}
            uploadId={upload.id}
            periodYear={fpYear}
            periodMonth={fpMonth}
            companyName={upload.company_name ?? undefined}
            userId={user?.id ?? ""}
          />
        )}

      {!upload?.company_id && (
        <div className="border border-border p-8 flex flex-col items-center gap-3 text-center max-w-sm mx-auto">
          <Inbox className="w-8 h-8 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No active engagement</p>
          <p className="text-xs text-muted-foreground">
            Import a trial balance to track findings and evidence requests for this period.
          </p>
        </div>
      )}
    </div>
  );
}
