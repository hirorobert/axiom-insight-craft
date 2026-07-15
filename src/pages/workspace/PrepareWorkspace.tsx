/**
 * SafishaWorkspace — TB Verification & EFDMS Reconciliation.
 *
 * Re-homes from Dashboard:
 *   UploadsStatusPanel, CertificationHeader, CertificationSummaryStrip,
 *   TrialBalanceIntegrityCard, BalanceSheetEquationCard, ClassificationBreakdown,
 *   ValidationReport, AccountReviewPanel, Account Classifications card,
 *   EFDMSReconciliationPanel
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

import { UploadsStatusPanel } from "@/components/UploadsStatusPanel";
import { CertificationHeader } from "@/components/certification/CertificationHeader";
import { CertificationSummaryStrip } from "@/components/certification/CertificationSummaryStrip";
import { TrialBalanceIntegrityCard } from "@/components/certification/TrialBalanceIntegrityCard";
import { BalanceSheetEquationCard } from "@/components/certification/BalanceSheetEquationCard";
import { ClassificationBreakdown } from "@/components/certification/ClassificationBreakdown";
import { ValidationReport } from "@/components/ValidationReport";
import { AccountReviewPanel } from "@/components/AccountReviewPanel";
import { EFDMSReconciliationPanel } from "@/components/EFDMSReconciliationPanel";
import { EmptyCertificationState } from "@/components/certification/EmptyCertificationState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Eye,
  BarChart3,
  TrendingUp,
  PieChart,
} from "lucide-react";
import { AccountMappingModal } from "@/components/AccountMappingModal";
import type { WorkspaceUpload } from "@/hooks/useWorkspaceData";

// ── deriveFiscalPeriod (local copy — same logic as Dashboard) ────────────────
function deriveFiscalPeriod(
  upload: WorkspaceUpload,
  fiscalYearEnd: string | null,
): { periodYear: number; periodEndMonth: number } {
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

export default function PrepareWorkspace() {
  const { upload, uploads, company, companyId, periodYear, refreshUpload } = useWorkspace();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [mappingModalOpen, setMappingModalOpen] = useState(false);

  const { periodYear: fpYear, periodEndMonth: fpMonth } = upload
    ? deriveFiscalPeriod(upload, company?.fiscal_year_end ?? null)
    : { periodYear, periodEndMonth: 12 };

  const handleProcessAsAuditedAccounts = async () => {
    if (!upload) return;
    toast.info("Re-processing as Audited Financial Statements…");
    try {
      const { error } = await supabase.functions.invoke("process-trial-balance", {
        body: { uploadId: upload.id, mode: "audited_accounts" },
      });
      if (error) throw error;
      toast.success("Processing started — results will appear shortly.");
    } catch {
      toast.error("Failed to start processing. Please try again.");
    }
  };

  const mapping = upload?.processing_result?.mapping;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Uploads sidebar */}
        <div className="lg:col-span-1">
          <UploadsStatusPanel
            uploads={uploads}
            selectedId={upload?.id ?? null}
            onSelect={(u) => {
              // Navigate to the period year of the selected upload
              const selected = u as WorkspaceUpload;
              const { periodYear: newPY } = deriveFiscalPeriod(selected, company?.fiscal_year_end ?? null);
              navigate(`/workspace/${companyId}/${newPY}/prepare`);
            }}
            onRefresh={async () => { await refreshUpload(); }}
          />
        </div>

        {/* Main content */}
        <div className="lg:col-span-3 space-y-6">
          {upload ? (
            <>
              <div>
                <CertificationHeader upload={upload} />
                <CertificationSummaryStrip upload={upload} />
              </div>

              <TrialBalanceIntegrityCard upload={upload} />
              <BalanceSheetEquationCard upload={upload} />
              <ClassificationBreakdown upload={upload} />

              <ValidationReport
                report={upload.validation_report}
                errors={upload.accounting_errors || []}
                isValid={upload.is_valid}
                status={upload.status}
                fileName={upload.file_name}
                onProcessAsAuditedAccounts={handleProcessAsAuditedAccounts}
                onUploadNew={() => navigate(`/workspace/${companyId}/${periodYear}/prepare`)}
              />

              {/* Account review — only when classifier has unresolved accounts */}
              {upload.status === "needs_review" &&
                Array.isArray(upload.processing_result?.needs_review_accounts) &&
                upload.processing_result.needs_review_accounts.length > 0 &&
                upload.company_id &&
                user && (
                  <AccountReviewPanel
                    uploadId={upload.id}
                    companyId={upload.company_id}
                    userId={user.id}
                    needsReviewAccounts={upload.processing_result.needs_review_accounts}
                    onReprocessed={refreshUpload}
                  />
                )}

              {/* Account Classifications */}
              {mapping && (
                <Card className="bg-card border-border">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle className="text-base">Account Classifications</CardTitle>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setMappingModalOpen(true)}
                      className="gap-2"
                    >
                      <Eye className="w-4 h-4" />
                      View Details
                    </Button>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    {/* Balance Sheet */}
                    <div>
                      <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                        <BarChart3 className="w-4 h-4 text-primary" />
                        Balance Sheet
                      </h3>
                      <div className="grid grid-cols-3 gap-4">
                        {["Assets", "Liabilities", "Equity"].map((label) => {
                          const key = label.toLowerCase() as "assets" | "liabilities" | "equity";
                          const bs = mapping.balanceSheet;
                          const count =
                            key === "equity"
                              ? (bs?.equity?.length ?? 0)
                              : (bs?.[key]?.current?.length ?? 0) + (bs?.[key]?.nonCurrent?.length ?? 0);
                          return (
                            <div key={label} className="p-4 border border-border bg-secondary/20">
                              <p className="text-xs text-muted-foreground mb-1">{label}</p>
                              <p className="text-lg font-semibold text-foreground tabular-nums">{count}</p>
                              {key !== "equity" && (
                                <p className="text-xs text-muted-foreground mt-1">
                                  {bs?.[key]?.current?.length ?? 0} current · {bs?.[key]?.nonCurrent?.length ?? 0} non-current
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {/* Income Statement */}
                    <div>
                      <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                        <TrendingUp className="w-4 h-4 text-accent" />
                        Income Statement
                      </h3>
                      <div className="grid grid-cols-5 gap-3">
                        {[
                          ["Revenue", mapping.incomeStatement?.revenue?.length ?? 0],
                          ["COGS", mapping.incomeStatement?.costOfGoodsSold?.length ?? 0],
                          ["OpEx", mapping.incomeStatement?.operatingExpenses?.length ?? 0],
                          ["Other", mapping.incomeStatement?.otherIncome?.length ?? 0],
                          ["Taxes", mapping.incomeStatement?.taxes?.length ?? 0],
                        ].map(([label, count]) => (
                          <div key={label as string} className="p-3 border border-border bg-secondary/20">
                            <p className="text-xs text-muted-foreground">{label}</p>
                            <p className="text-lg font-semibold text-foreground tabular-nums">{count}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                    {/* Cash Flow */}
                    <div>
                      <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                        <PieChart className="w-4 h-4 text-muted-foreground" />
                        Cash Flow Statement
                      </h3>
                      <div className="grid grid-cols-3 gap-3">
                        {[
                          ["Operating", mapping.cashFlow?.operating?.length ?? 0],
                          ["Investing", mapping.cashFlow?.investing?.length ?? 0],
                          ["Financing", mapping.cashFlow?.financing?.length ?? 0],
                        ].map(([label, count]) => (
                          <div key={label as string} className="p-3 border border-border bg-secondary/20">
                            <p className="text-xs text-muted-foreground">{label}</p>
                            <p className="text-lg font-semibold text-foreground tabular-nums">{count}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* EFDMS Reconciliation */}
              {upload.status === "complete" && upload.is_valid === true && upload.company_id && (
                <EFDMSReconciliationPanel
                  companyId={upload.company_id}
                  uploadId={upload.id}
                  periodYear={fpYear}
                  periodMonth={fpMonth}
                  companyName={upload.company_name ?? undefined}
                  userId={user?.id ?? ""}
                  isVatRegistered={true}
                />
              )}
            </>
          ) : (
            <EmptyCertificationState />
          )}
        </div>
      </div>

      {upload && (
        <AccountMappingModal
          uploadId={upload.id}
          open={mappingModalOpen}
          onOpenChange={setMappingModalOpen}
          mapping={(upload.processing_result as any)?.mapping ?? null}
        />
      )}
    </div>
  );
}
