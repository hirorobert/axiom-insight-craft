/**
 * ReconcileWorkspace — EFDMS reconciliation and adjusting journal review.
 *
 * Re-homed in Phase C:
 *   EFDMSReconciliationPanel (from PrepareWorkspace)
 *   AdjustingJournalPanel (from TaxWorkspace)
 *
 * Mission status is "not_applicable" (always available) — no WorkspaceGate.
 * Panels themselves require a validated trial balance to render meaningfully.
 */

import { GitCompare } from "lucide-react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAuth } from "@/contexts/AuthContext";
import { EFDMSReconciliationPanel } from "@/components/EFDMSReconciliationPanel";
import { AdjustingJournalPanel } from "@/components/AdjustingJournalPanel";
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
  const { upload, company } = useWorkspace();
  const { user } = useAuth();

  const ready =
    upload && upload.company_id && upload.status === "complete" && upload.is_valid === true;

  if (!ready) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh] text-center gap-4">
        <GitCompare className="w-8 h-8 text-muted-foreground/40" />
        <div>
          <p className="text-sm font-medium text-foreground">Reconcile</p>
          <p className="text-xs text-muted-foreground mt-1">
            EFDMS reconciliation and adjusting journal review require a validated trial balance.
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
      <EFDMSReconciliationPanel
        companyId={upload.company_id}
        uploadId={upload.id}
        periodYear={fpYear}
        periodMonth={fpMonth}
        companyName={upload.company_name ?? undefined}
        userId={user?.id ?? ""}
        isVatRegistered={true}
      />

      <AdjustingJournalPanel
        companyId={upload.company_id}
        uploadId={upload.id}
        periodYear={fpYear}
        companyName={upload.company_name ?? undefined}
        userId={user?.id ?? ""}
      />
    </div>
  );
}
