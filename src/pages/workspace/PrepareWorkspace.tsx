/**
 * SafishaWorkspace — TB Verification & EFDMS Reconciliation.
 *
 * Re-homes from Dashboard:
 *   UploadsStatusPanel, CertificationHeader, CertificationSummaryStrip,
 *   TrialBalanceIntegrityCard, BalanceSheetEquationCard, ClassificationBreakdown,
 *   ValidationReport, AccountReviewPanel, Account Classifications card,
 *   EFDMSReconciliationPanel
 */

import { useEffect, useRef, useState } from "react";
import { ensureFreshSession } from "@/lib/ensureFreshSession";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { buildPrepareUploadRoute } from "@/lib/workspace/resolveActiveUpload";
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
import { TrialBalanceUpload } from "@/components/TrialBalanceUpload";
import { TrialBalancePreflight } from "@/components/workspace/TrialBalancePreflight";
import TrialBalanceProgressLedger from "@/components/workspace/TrialBalanceProgressLedger";
import {
  DiscardUploadDialog,
  discardUpload,
  isCertifiedRun,
  offerUndo,
} from "@/components/workspace/DiscardUploadDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  SurfaceCard,
  SurfaceCardHeader,
  SurfaceCardBody,
} from "@/components/workspace/ui/Surface";
import {
  Eye,
  BarChart3,
  TrendingUp,
  PieChart,
  Trash2,
  RefreshCw,
  Loader2,
  ChevronDown,
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
  const [searchParams] = useSearchParams();
  // Deep link from the Overview exception count: land directly on the
  // unresolved accounts, no second hunt.
  const focusUnresolved = searchParams.get("review") === "unresolved";
  const reviewRef = useRef<HTMLDivElement>(null);
  const [processingOpen, setProcessingOpen] = useState(false);
  const [mappingModalOpen, setMappingModalOpen] = useState(false);
  const [showUploader, setShowUploader] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<WorkspaceUpload | null>(null);
  // One-tap replace: the file the user picked to take over from the prior run.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [replacing, setReplacing] = useState(false);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  // Set when the dialog discard succeeded, so closing it does not drop the
  // replacement file that is about to be uploaded.
  const keepPendingFileRef = useRef(false);

  /**
   * One tap: pick a file → the prior trial balance is discarded and the new
   * file is uploaded immediately. Certified runs still pass the DISCARD gate.
   */
  const handleReplacePicked = async (file: File | undefined) => {
    if (!file || !upload) return;
    setPendingFile(file);

    if (isCertifiedRun(upload)) {
      setDiscardTarget(upload);
      return;
    }

    setReplacing(true);
    try {
      const receipt = await discardUpload(upload);
      toast.success(`Prior trial balance discarded. Uploading ${file.name}…`);
      offerUndo(receipt, () => {
        setPendingFile(null);
        setShowUploader(false);
        navigate(buildPrepareUploadRoute(companyId, periodYear, receipt.id), { replace: true });
        refreshUpload();
      });
      navigate(buildPrepareUploadRoute(companyId, periodYear), { replace: true });
      setShowUploader(true);
      refreshUpload();
    } catch (err) {
      setPendingFile(null);
      toast.error(
        err instanceof Error
          ? `Could not discard the prior trial balance: ${err.message}`
          : "Could not discard the prior trial balance.",
      );
    } finally {
      setReplacing(false);
    }
  };

  const { periodYear: fpYear, periodEndMonth: fpMonth } = upload
    ? deriveFiscalPeriod(upload, company?.fiscal_year_end ?? null)
    : { periodYear, periodEndMonth: 12 };

  const handleProcessAsAuditedAccounts = async () => {
    if (!upload) return;
    toast.info("Re-processing as Audited Financial Statements…");
    try {
      await ensureFreshSession();
      const { error } = await supabase.functions.invoke("process-trial-balance", {
        body: { uploadId: upload.id, mode: "audited_accounts" },
      });
      if (error) throw error;
      toast.success("Processing started — results will appear shortly.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start processing. Please try again.");
    }
  };

  const mapping = upload?.processing_result?.mapping;

  const reviewAccounts = Array.isArray(upload?.processing_result?.needs_review_accounts)
    ? upload!.processing_result!.needs_review_accounts
    : [];
  const showReviewPanel =
    upload?.status === "needs_review" &&
    reviewAccounts.length > 0 &&
    !!upload?.company_id &&
    !!user;

  useEffect(() => {
    if (!focusUnresolved || !showReviewPanel) return;
    const t = window.setTimeout(() => {
      reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    return () => window.clearTimeout(t);
  }, [focusUnresolved, showReviewPanel]);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Uploads sidebar */}
        <div className="lg:col-span-1">
          <UploadsStatusPanel
            uploads={uploads}
            selectedId={upload?.id ?? null}
            onSelect={(u) => {
              // Navigate to the selected upload's period AND pin the exact
              // record via ?upload=<id>. Without the id, clicking a sibling
              // upload in the same year was a no-op (the row appeared to
              // "disappear" instead of loading its certification ledger).
              const selected = u as WorkspaceUpload;
              const { periodYear: newPY } = deriveFiscalPeriod(selected, company?.fiscal_year_end ?? null);
              setShowUploader(false);
              navigate(buildPrepareUploadRoute(companyId, newPY, selected.id));
            }}
            onRefresh={async () => { await refreshUpload(); }}
            onDiscard={(u) => setDiscardTarget(u as WorkspaceUpload)}
          />
        </div>

        {/* Main content */}
        <div className="lg:col-span-3 space-y-6">
          {/* Upload surface — the one thing to do when nothing is here yet. */}
          {(!upload || showUploader) && (
            <SurfaceCard>
              <SurfaceCardHeader
                label="Upload trial balance"
                action={
                  upload ? (
                    <Button variant="ghost" size="sm" onClick={() => setShowUploader(false)}>
                      Close
                    </Button>
                  ) : undefined
                }
              />
              <SurfaceCardBody>
                <TrialBalanceUpload
                  embedded
                  lockedCompanyId={companyId}
                  lockedCompanyName={company?.name ?? undefined}
                  periodYear={periodYear}
                  initialFile={pendingFile}
                  autoProcess={!!pendingFile}
                  onUploaded={() => {
                    setShowUploader(false);
                    setPendingFile(null);
                    // Drop any pinned ?upload=<id> so the newest upload shows.
                    navigate(buildPrepareUploadRoute(companyId, periodYear), { replace: true });
                    refreshUpload();
                  }}
                />
              </SurfaceCardBody>
            </SurfaceCard>
          )}

          {upload ? (
            <>
              {!showUploader && (
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-2">
                  <input
                    ref={replaceInputRef}
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      void handleReplacePicked(file);
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDiscardTarget(upload)}
                    className="text-muted-foreground hover:text-destructive w-full sm:w-auto justify-center"
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                    Discard this trial balance
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowUploader(true)}
                    className="w-full sm:w-auto justify-center"
                  >
                    Upload another trial balance
                  </Button>
                  <Button
                    size="sm"
                    disabled={replacing}
                    onClick={() => replaceInputRef.current?.click()}
                    title="Discard this trial balance and upload a fresh file in one step"
                    className="w-full sm:w-auto justify-center"
                  >
                    {replacing ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    {replacing ? "Replacing…" : "Replace with fresh file"}
                  </Button>
                </div>
              )}
              <div data-testid="certification-ledger" data-active-upload-id={upload.id}>
                <CertificationHeader upload={upload} />
                <CertificationSummaryStrip upload={upload} />
              </div>

              {/* Machine telemetry — evidence, not first-screen content. Closed
                  by default so the accountant sees it only when it is useful. */}
              <SurfaceCard>
                <button
                  type="button"
                  onClick={() => setProcessingOpen((v) => !v)}
                  aria-expanded={processingOpen}
                  className="w-full flex items-center justify-between gap-4 px-5 py-3 text-left group"
                >
                  <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground group-hover:text-foreground transition-colors">
                    Processing details
                  </span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${processingOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {processingOpen && (
                  <div className="border-t border-border px-5 py-4 [&>section]:mb-0">
                    <TrialBalanceProgressLedger upload={upload} />
                  </div>
                )}
              </SurfaceCard>

              {/* SAFISHA pre-flight — certification comes BEFORE classification
                  is trusted downstream. One verdict, top of the stack. */}
              <TrialBalancePreflight upload={upload} />

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
              {showReviewPanel && upload.company_id && user && (
                <div ref={reviewRef}>
                  <AccountReviewPanel
                    uploadId={upload.id}
                    companyId={upload.company_id}
                    userId={user.id}
                    needsReviewAccounts={reviewAccounts}
                    focusUnresolved={focusUnresolved}
                    onReprocessed={refreshUpload}
                  />
                </div>
              )}

              {/* Account Classifications */}
              {mapping && (
                <SurfaceCard>
                  <SurfaceCardHeader
                    label="Account classifications"
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setMappingModalOpen(true)}
                        className="gap-2 rounded-none"
                      >
                        <Eye className="w-4 h-4" />
                        View details
                      </Button>
                    }
                  />
                  <SurfaceCardBody className="space-y-5">
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
                  </SurfaceCardBody>
                </SurfaceCard>
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
          ) : null}
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

      <DiscardUploadDialog
        target={discardTarget}
        open={!!discardTarget}
        replacementFileName={discardTarget?.id === upload?.id ? pendingFile?.name ?? null : null}
        onOpenChange={(o) => {
          if (!o) {
            setDiscardTarget(null);
            if (keepPendingFileRef.current) {
              keepPendingFileRef.current = false;
            } else {
              setPendingFile(null);
            }
          }
        }}
        onDiscarded={(_id, receipt) => {
          keepPendingFileRef.current = !!pendingFile;
          setDiscardTarget(null);
          offerUndo(receipt, () => {
            setPendingFile(null);
            setShowUploader(false);
            navigate(buildPrepareUploadRoute(companyId, periodYear, receipt.id), { replace: true });
            refreshUpload();
          });
          // Drop any pinned ?upload=<id> so the list resolves to what remains,
          // then open the uploader — the one next action after a discard.
          navigate(buildPrepareUploadRoute(companyId, periodYear), { replace: true });
          setShowUploader(true);
          refreshUpload();
        }}
      />
    </div>
  );
}
