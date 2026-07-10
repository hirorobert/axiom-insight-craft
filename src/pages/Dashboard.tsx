import { useEffect, useState, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { AccountMappingModal } from "@/components/AccountMappingModal";
import { AccountMappingManager, AccountMappingManagerRef } from "@/components/AccountMappingManager";
import { ExportStatements, ProcessingResult, TaxResultForExport } from "@/components/ExportStatements";
import { NoteSynth } from "@/components/NoteSynth";
import { MgmtLetterPanel } from "@/components/MgmtLetterPanel";
import { KingaFindingsPanel } from "@/components/KingaFindingsPanel";
import { KingaTaxPanel } from "@/components/KingaTaxPanel";
import { KingaComparativePanel } from "@/components/KingaComparativePanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PolicyCompass } from "@/components/PolicyCompass";
import { CompanySelector } from "@/components/CompanySelector";
import { CompanyManager } from "@/components/CompanyManager";
import { DashboardSkeleton } from "@/components/DashboardSkeleton";
import { NoUploadsEmptyState } from "@/components/EmptyState";
import { ValidationReport } from "@/components/ValidationReport";
import { AccountReviewPanel } from "@/components/AccountReviewPanel";
import { CertificationHeader } from "@/components/certification/CertificationHeader";
import { CertificationSummaryStrip } from "@/components/certification/CertificationSummaryStrip";
import { TrialBalanceIntegrityCard } from "@/components/certification/TrialBalanceIntegrityCard";
import { BalanceSheetEquationCard } from "@/components/certification/BalanceSheetEquationCard";
import { ClassificationBreakdown } from "@/components/certification/ClassificationBreakdown";
import { UploadsStatusPanel } from "@/components/UploadsStatusPanel";
import { EmptyCertificationState } from "@/components/certification/EmptyCertificationState";
import { toast } from "sonner";
import {
  FileSpreadsheet,
  ArrowLeft,
  CheckCircle,
  Clock,
  AlertCircle,
  TrendingUp,
  BarChart3,
  PieChart,
  RefreshCw,
  Eye,
  UserCheck,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useEnhancedAuditLog } from "@/hooks/useEnhancedAuditLog";
import { SaffLogo } from "@/components/SaffLogo";
import { FilingCalendarPanel } from "@/components/FilingCalendarPanel";
import { PaymentLedgerPanel } from "@/components/PaymentLedgerPanel";
import { TRAFilingChecklist } from "@/components/TRAFilingChecklist";
import { TransferPricingPanel } from "@/components/TransferPricingPanel";
import { AdjustingJournalPanel } from "@/components/AdjustingJournalPanel";
import { ComplianceScorecard } from "@/components/ComplianceScorecard";
import { PeriodClosingBalancesPanel } from "@/components/PeriodClosingBalancesPanel";
import { EFDMSReconciliationPanel } from "@/components/EFDMSReconciliationPanel";

interface ValidationReportData {
  tb_balance_check?: {
    passed: boolean;
    total_debits: number;
    total_credits: number;
    difference: number;
  };
  mapping_completeness?: {
    passed: boolean;
    total_accounts: number;
    mapped_accounts: number;
    unmapped: string[];
  };
  balance_sheet_equation?: {
    passed: boolean;
    assets: number;
    liabilities: number;
    equity: number;
    difference: number;
  } | null;
  profit_equity_linkage?: {
    passed: boolean;
    details: string;
  } | null;
  cash_reconciliation?: {
    passed: boolean;
    cf_ending_cash: number;
    bs_cash: number;
  } | null;
}

interface AccountingError {
  code: string;
  message: string;
  field?: string;
  expected?: string | number;
  actual?: string | number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonCompatible = any;

interface TrialBalanceUpload {
  id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  company_id: string | null;
  company_name: string | null;
  status: string;
  uploaded_at: string;
  processed_at: string | null;
  is_valid: boolean | null;
  validation_report: JsonCompatible;
  accounting_errors: JsonCompatible;
  processing_result: JsonCompatible;
  // D1-FIX: fiscal period fields (Phase 5A migration adds these to trial_balance_uploads)
  fiscal_year_end?: string | null;   // DATE as ISO string e.g. "2025-12-31"
  period_year?: number | null;       // Sprint 2 migration: derived from fiscal_year_end
}

// ── D1-FIX + D7-FIX: derive correct period year and year-end month ──────────
// Priority: upload.period_year (DB) → upload.fiscal_year_end → company fiscal_year_end → smart fallback
function deriveFiscalPeriod(
  upload: TrialBalanceUpload,
  companyData: SelectedCompanyData | null
): { periodYear: number; periodEndMonth: number } {
  // 1. DB-stored period_year (most reliable — Sprint 2 migration trigger)
  if (upload.period_year && upload.period_year > 2000) {
    const fyeStr = upload.fiscal_year_end ?? companyData?.fiscal_year_end;
    const month  = fyeStr ? new Date(fyeStr).getMonth() + 1 : 12;
    return { periodYear: upload.period_year, periodEndMonth: isNaN(month) ? 12 : month };
  }
  // 2. Upload's fiscal_year_end date (Phase 5A trigger populates when period_id linked)
  if (upload.fiscal_year_end) {
    const d = new Date(upload.fiscal_year_end);
    if (!isNaN(d.getTime())) return { periodYear: d.getFullYear(), periodEndMonth: d.getMonth() + 1 };
  }
  // 3. Company-level fiscal_year_end
  if (companyData?.fiscal_year_end) {
    const d = new Date(companyData.fiscal_year_end);
    if (!isNaN(d.getTime())) return { periodYear: d.getFullYear(), periodEndMonth: d.getMonth() + 1 };
  }
  // 4. Smart upload-date fallback: uploaded Jan-Sep → prior calendar year (most common case)
  const uploadDate  = new Date(upload.uploaded_at);
  const uploadMonth = uploadDate.getMonth() + 1;
  const uploadYear  = uploadDate.getFullYear();
  return { periodYear: uploadMonth <= 9 ? uploadYear - 1 : uploadYear, periodEndMonth: 12 };
}

interface SelectedCompanyData {
  id: string;
  name: string;
  code: string | null;
  tin: string | null;          // TRA Tax Identification Number (migration 20260707100000)
  reporting_framework: string | null;
  fiscal_year_end: string | null;
  currency: string | null;
}

export default function Dashboard() {
  const [uploads, setUploads] = useState<TrialBalanceUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUpload, setSelectedUpload] = useState<TrialBalanceUpload | null>(null);
  const [mappingModalOpen, setMappingModalOpen] = useState(false);
  const [correctionCount, setCorrectionCount] = useState(0);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedCompanyData, setSelectedCompanyData] = useState<SelectedCompanyData | null>(null);
  const [taxResult, setTaxResult] = useState<TaxResultForExport | null>(null);
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { logAction, logTrialBalanceUpload, logTrialBalanceProcessing } = useEnhancedAuditLog();
  const mappingManagerRef = useRef<AccountMappingManagerRef | null>(null);

  const handleOpenMappingManager = () => {
    mappingManagerRef.current?.openDialog();
  };

  // Fetch correction count for the selected upload
  const fetchCorrectionCount = async (uploadId: string) => {
    const { count, error } = await supabase
      .from("account_corrections")
      .select("*", { count: "exact", head: true })
      .eq("upload_id", uploadId);

    if (!error && count !== null) {
      setCorrectionCount(count);
    } else {
      setCorrectionCount(0);
    }
  };

  useEffect(() => {
    if (selectedUpload) {
      fetchCorrectionCount(selectedUpload.id);
    }
  }, [selectedUpload]);

  const handleRegenerate = async () => {
    if (!selectedUpload || correctionCount === 0) return;

    setIsRegenerating(true);
    toast.info("Regenerating with your corrections...");

    try {
      // Reset status to pending
      await supabase
        .from("trial_balance_uploads")
        .update({ status: "processing", processing_result: null })
        .eq("id", selectedUpload.id);

      // Call the edge function to reprocess
      const { error } = await supabase.functions.invoke("process-trial-balance", {
        body: { uploadId: selectedUpload.id },
      });

      if (error) throw error;

      toast.success("Regeneration started! Results will appear shortly.");
      
      // Poll for completion
      const pollInterval = setInterval(async () => {
        const { data } = await supabase
          .from("trial_balance_uploads")
          .select("*")
          .eq("id", selectedUpload.id)
          .single();

        if (data && data.status === "complete") {
          clearInterval(pollInterval);
          setSelectedUpload(data);
          await fetchUploads();
          setIsRegenerating(false);
          toast.success("Regeneration complete with corrections applied!");
        } else if (data && data.status === "error") {
          clearInterval(pollInterval);
          setIsRegenerating(false);
          toast.error("Regeneration failed. Please try again.");
        } else if (data && data.status === "needs_review") {
          clearInterval(pollInterval);
          setSelectedUpload(data);
          await fetchUploads();
          setIsRegenerating(false);
          toast.warning("Some accounts need manual classification before processing can complete.");
        }
      }, 2000);

      // Timeout after 60 seconds
      setTimeout(() => {
        clearInterval(pollInterval);
        if (isRegenerating) {
          setIsRegenerating(false);
          fetchUploads();
        }
      }, 60000);
    } catch (error) {
      console.error("Regeneration error:", error);
      toast.error("Failed to start regeneration");
      setIsRegenerating(false);
    }
  };

  // Delete an upload and its associated files
  const handleDeleteUpload = async (upload: TrialBalanceUpload) => {
    if (!user) return;

    setIsDeleting(true);
    try {
      // Delete associated corrections first
      await supabase
        .from("account_corrections")
        .delete()
        .eq("upload_id", upload.id);

      // Delete the file from storage
      const { error: storageError } = await supabase.storage
        .from("trial-balance-files")
        .remove([upload.file_path]);

      if (storageError) {
        console.error("Failed to delete file from storage:", storageError);
        // Continue anyway - file might already be deleted
      }

      // Delete the upload record
      const { error: deleteError } = await supabase
        .from("trial_balance_uploads")
        .delete()
        .eq("id", upload.id);

      if (deleteError) throw deleteError;

      // Log the action
      await logAction({
        action: "delete_company",
        entityType: "trial_balance_upload",
        entityId: upload.id,
        metadata: { fileName: upload.file_name },
      });

      // Update local state
      setUploads((prev) => prev.filter((u) => u.id !== upload.id));
      
      // Clear selection if we deleted the selected upload
      if (selectedUpload?.id === upload.id) {
        const remaining = uploads.filter((u) => u.id !== upload.id);
        setSelectedUpload(remaining.length > 0 ? remaining[0] : null);
      }

      toast.success(`Deleted: ${upload.file_name}`);
    } catch (error) {
      console.error("Delete error:", error);
      toast.error("Failed to delete upload");
    } finally {
      setIsDeleting(false);
    }
  };

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [user, authLoading, navigate]);

  // Fetch full company record whenever the selected upload changes,
  // so reporting_framework and fiscal_year_end are available for export.
  useEffect(() => {
    if (!selectedUpload?.company_id) {
      setSelectedCompanyData(null);
      return;
    }
    const fetchCompany = async () => {
      const { data } = await supabase
        .from("companies")
        .select("id, name, code, tin, reporting_framework, fiscal_year_end, currency")
        .eq("id", selectedUpload.company_id)
        .single();
      if (data) setSelectedCompanyData(data as SelectedCompanyData);
    };
    fetchCompany();
  }, [selectedUpload?.company_id]);

  const fetchUploads = async () => {
    if (!user) return;
    
    setLoading(true);
    let query = supabase
      .from("trial_balance_uploads")
      .select("*")
      .order("uploaded_at", { ascending: false });

    if (selectedCompanyId) {
      query = query.eq("company_id", selectedCompanyId);
    }

    const { data, error } = await query;

    if (!error && data) {
      setUploads(data);
      if (data.length > 0 && !selectedUpload) {
        setSelectedUpload(data[0]);
      } else if (data.length === 0) {
        setSelectedUpload(null);
      }
    }
    setLoading(false);
  };

  useEffect(() => {
    if (user) {
      fetchUploads();
    }
  }, [user, selectedCompanyId]);

  // Auto-accept firm invitation — runs once on login.
  // When an invited user logs in for the first time, their firm_members
  // row has accepted_at = null. We update it here so they become active.
  useEffect(() => {
    if (!user) return;
    supabase
      .from("firm_members")
      .update({ accepted_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .is("accepted_at", null)
      .then(({ error }) => {
        if (error) console.warn("firm_members auto-accept:", error.message);
      });
  }, [user?.id]);

  // Real-time subscription for trial balance updates
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel('trial-balance-updates')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'trial_balance_uploads',
        },
        (payload) => {
          console.log('Realtime update received:', payload);
          const updatedUpload = payload.new as TrialBalanceUpload;
          
          // Update the uploads list
          setUploads((prev) =>
            prev.map((upload) =>
              upload.id === updatedUpload.id ? updatedUpload : upload
            )
          );
          
          // Update selected upload if it's the one that changed
          if (selectedUpload?.id === updatedUpload.id) {
            setSelectedUpload(updatedUpload);
          }
          
          // Show toast notification when processing completes
          if (updatedUpload.status === 'complete') {
            toast.success(`Processing complete: ${updatedUpload.file_name}`);
          } else if (updatedUpload.status === 'error') {
            toast.error(`Processing failed: ${updatedUpload.file_name}`);
          } else if (updatedUpload.status === 'needs_review') {
            toast.warning(`Review required: ${updatedUpload.file_name} has unresolved accounts.`);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'trial_balance_uploads',
        },
        (payload) => {
          console.log('New upload detected:', payload);
          const newUpload = payload.new as TrialBalanceUpload;
          
          // Add to uploads list if it matches the current filter
          if (!selectedCompanyId || newUpload.company_id === selectedCompanyId) {
            setUploads((prev) => [newUpload, ...prev]);
            toast.info(`New upload: ${newUpload.file_name}`);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, selectedCompanyId, selectedUpload?.id]);

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "complete":
        return <CheckCircle className="w-4 h-4 text-accent" />;
      case "processing":
      case "validating":
      case "mapping":
      case "calculating":
        return <Clock className="w-4 h-4 text-primary animate-pulse" />;
      case "blocked":
      case "error":
        return <AlertCircle className="w-4 h-4 text-destructive" />;
      default:
        return <Clock className="w-4 h-4 text-muted-foreground" />;
    }
  };

  // AXIOM: Check if upload is blocked (validation failed)
  const isBlocked = selectedUpload?.status === "blocked" || 
                    selectedUpload?.status === "error" ||
                    selectedUpload?.is_valid === false;
  
  // Scroll ref for validation report
  const validationReportRef = useRef<HTMLDivElement>(null);
  
  const scrollToValidation = () => {
    validationReportRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Handle audited-accounts smart routing (from ValidationReport smart card)
  const handleProcessAsAuditedAccounts = async () => {
    if (!selectedUpload) return;
    toast.info("Re-processing as Audited Financial Statements…");
    try {
      const { error } = await supabase.functions.invoke("process-trial-balance", {
        body: { uploadId: selectedUpload.id, mode: "audited_accounts" },
      });
      if (error) throw error;
      toast.success("Processing started — results will appear shortly.");
    } catch (err) {
      console.error("Audited accounts processing error:", err);
      toast.error("Failed to start processing. Please try again.");
    }
  };

  // Clear selection so user can pick a new upload
  const handleUploadNew = () => {
    setSelectedUpload(null);
  };

  const result = selectedUpload?.processing_result;
  const summary = result?.summary;
  const mapping = result?.mapping;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border/50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/" className="gap-2">
                <ArrowLeft className="w-4 h-4" />
                Back
              </Link>
            </Button>
            <div className="flex items-center gap-3">
              <SaffLogo variant="header" className="h-8 w-auto" />
              <div>
                <h1 className="text-base font-semibold text-foreground">Results Dashboard</h1>
                <p className="text-xs text-muted-foreground">Trial Balance Analysis</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <CompanySelector
              value={selectedCompanyId}
              onChange={(id) => {
                setSelectedCompanyId(id);
                setSelectedUpload(null);
              }}
              placeholder="All companies"
              className="w-48"
            />
            <CompanyManager />
            <AccountMappingManager ref={mappingManagerRef} />
            {selectedUpload && correctionCount > 0 && (
              <Button
                variant="default"
                size="sm"
                onClick={handleRegenerate}
                disabled={isRegenerating}
                className="gap-2"
              >
                <RotateCcw className={`w-4 h-4 ${isRegenerating ? 'animate-spin' : ''}`} />
                {isRegenerating ? "Regenerating..." : "Regenerate with Corrections"}
              </Button>
            )}
            {selectedUpload && !isBlocked && (
              <ExportStatements
                fileName={selectedUpload.file_name}
                processingResult={selectedUpload.processing_result as ProcessingResult | null}
                uploadId={selectedUpload.id}
                reportingFramework={selectedCompanyData?.reporting_framework ?? null}
                companyName={selectedUpload.company_name ?? ""}
                companyTin={selectedCompanyData?.tin ?? ""}
                periodYearEnd={selectedCompanyData?.fiscal_year_end ?? ""}
                companyCurrency={selectedCompanyData?.currency ?? "TZS"}
                taxResult={taxResult}
              />
            )}
            {selectedUpload && isBlocked && (
              <Button 
                variant="outline" 
                size="sm" 
                disabled 
                className="gap-2 opacity-50"
                title="Export disabled: validation failed"
              >
                <AlertCircle className="w-4 h-4" />
                Export Blocked
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={fetchUploads} className="gap-2">
              <RefreshCw className="w-4 h-4" />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {loading ? (
          <DashboardSkeleton />
        ) : uploads.length === 0 ? (
          <NoUploadsEmptyState 
            onAction={() => navigate("/#upload")}
          />
        ) : (
          <div className="space-y-8">
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
              {/* Sidebar - Uploads Status Panel (Iron Dome Nuclear Design) */}
              <div className="lg:col-span-1">
                <UploadsStatusPanel
                  uploads={uploads}
                  selectedId={selectedUpload?.id ?? null}
                  onSelect={(u) => { setSelectedUpload(u as typeof selectedUpload); setTaxResult(null); }}
                  onRefresh={fetchUploads}
                />
              </div>

            {/* Main Content */}
            <div className="lg:col-span-3 space-y-6">
              {selectedUpload ? (
                <>
                  {/* Certification Header + Summary Strip */}
                  <div>
                    <CertificationHeader upload={selectedUpload} />
                    <CertificationSummaryStrip upload={selectedUpload} />
                  </div>

                  {/* Integrity + Equation */}
                  <TrialBalanceIntegrityCard upload={selectedUpload} />
                  <BalanceSheetEquationCard upload={selectedUpload} />
                  <ClassificationBreakdown upload={selectedUpload} />

                  {/* SAFF ERP Validation Report */}
                  <div ref={validationReportRef}>
                    <ValidationReport
                      report={selectedUpload.validation_report}
                      errors={selectedUpload.accounting_errors || []}
                      isValid={selectedUpload.is_valid}
                      status={selectedUpload.status}
                      fileName={selectedUpload.file_name}
                      onProcessAsAuditedAccounts={handleProcessAsAuditedAccounts}
                      onUploadNew={handleUploadNew}
                    />
                  </div>

                  {/* Account Review Panel — visible only when classifier has unresolved accounts */}
                  {selectedUpload.status === "needs_review" &&
                    Array.isArray(selectedUpload.processing_result?.needs_review_accounts) &&
                    selectedUpload.processing_result.needs_review_accounts.length > 0 &&
                    selectedUpload.company_id &&
                    user && (
                      <AccountReviewPanel
                        uploadId={selectedUpload.id}
                        companyId={selectedUpload.company_id}
                        userId={user.id}
                        needsReviewAccounts={selectedUpload.processing_result.needs_review_accounts}
                        onReprocessed={fetchUploads}
                      />
                    )}

                  {/* Detailed Mapping */}
                  {mapping && (
                    <Card className="bg-card border-border">
                      <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle className="text-lg">Account Classifications</CardTitle>
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
                      <CardContent className="space-y-6">
                        {/* Balance Sheet Section */}
                        <div>
                          <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                            <BarChart3 className="w-4 h-4 text-primary" />
                            Balance Sheet
                          </h3>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div className="p-4 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground mb-2">Assets</p>
                              <p className="text-lg font-semibold text-foreground">
                                {(mapping.balanceSheet?.assets?.current?.length || 0) +
                                  (mapping.balanceSheet?.assets?.nonCurrent?.length || 0)}
                              </p>
                              <div className="mt-2 text-xs text-muted-foreground">
                                <span>{mapping.balanceSheet?.assets?.current?.length || 0} current</span>
                                <span className="mx-1">•</span>
                                <span>{mapping.balanceSheet?.assets?.nonCurrent?.length || 0} non-current</span>
                              </div>
                            </div>
                            <div className="p-4 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground mb-2">Liabilities</p>
                              <p className="text-lg font-semibold text-foreground">
                                {(mapping.balanceSheet?.liabilities?.current?.length || 0) +
                                  (mapping.balanceSheet?.liabilities?.nonCurrent?.length || 0)}
                              </p>
                              <div className="mt-2 text-xs text-muted-foreground">
                                <span>{mapping.balanceSheet?.liabilities?.current?.length || 0} current</span>
                                <span className="mx-1">•</span>
                                <span>{mapping.balanceSheet?.liabilities?.nonCurrent?.length || 0} non-current</span>
                              </div>
                            </div>
                            <div className="p-4 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground mb-2">Equity</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.balanceSheet?.equity?.length || 0}
                              </p>
                              <div className="mt-2 text-xs text-muted-foreground">accounts</div>
                            </div>
                          </div>
                        </div>

                        {/* Income Statement Section */}
                        <div>
                          <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                            <TrendingUp className="w-4 h-4 text-accent" />
                            Income Statement
                          </h3>
                          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                            <div className="p-3 rounded-xl bg-accent/10 border border-accent/20">
                              <p className="text-xs text-muted-foreground">Revenue</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.incomeStatement?.revenue?.length || 0}
                              </p>
                            </div>
                            <div className="p-3 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground">COGS</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.incomeStatement?.costOfGoodsSold?.length || 0}
                              </p>
                            </div>
                            <div className="p-3 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground">OpEx</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.incomeStatement?.operatingExpenses?.length || 0}
                              </p>
                            </div>
                            <div className="p-3 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground">Other</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.incomeStatement?.otherIncome?.length || 0}
                              </p>
                            </div>
                            <div className="p-3 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground">Taxes</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.incomeStatement?.taxes?.length || 0}
                              </p>
                            </div>
                          </div>
                        </div>

                        {/* Cash Flow Section */}
                        <div>
                          <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                            <PieChart className="w-4 h-4" />
                            Cash Flow Statement
                          </h3>
                          <div className="grid grid-cols-3 gap-3">
                            <div className="p-3 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground">Operating</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.cashFlow?.operating?.length || 0}
                              </p>
                            </div>
                            <div className="p-3 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground">Investing</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.cashFlow?.investing?.length || 0}
                              </p>
                            </div>
                            <div className="p-3 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground">Financing</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.cashFlow?.financing?.length || 0}
                              </p>
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* NoteSynth - Disclosure Notes */}
                  {mapping && (
                    <NoteSynth
                      uploadId={selectedUpload.id}
                      existingNotes={result?.disclosureNotes}
                      onNotesGenerated={fetchUploads}
                    />
                  )}

                  {/* Management Letter */}
                  {mapping && (
                    <MgmtLetterPanel
                      uploadId={selectedUpload.id}
                      existingLetter={result?.managementLetter ?? null}
                      onLetterGenerated={fetchUploads}
                    />
                  )}

                  {/* Kinga — Statutory Compliance Analysis */}
                  {selectedUpload.status === "complete" && selectedUpload.is_valid === true && selectedUpload.company_id && (() => {
                    const { periodYear: fpYear, periodEndMonth: fpMonth } = deriveFiscalPeriod(selectedUpload, selectedCompanyData);
                    return (
                      <KingaFindingsPanel
                        companyId={selectedUpload.company_id}
                        uploadId={selectedUpload.id}
                        periodYear={fpYear}
                        periodMonth={fpMonth}
                        companyName={selectedUpload.company_name ?? undefined}
                        userId={user?.id ?? ""}
                      />
                    );
                  })()}

                  {/* Kinga — Tax + Comparative tabs */}
                  {selectedUpload.status === "complete" && selectedUpload.is_valid === true && selectedUpload.company_id && (
                    <Tabs defaultValue="tax" className="w-full">
                      <TabsList>
                        <TabsTrigger value="tax">Corporate Tax (ITA)</TabsTrigger>
                        <TabsTrigger value="comparative">Comparative Analysis</TabsTrigger>
                      </TabsList>
                      <TabsContent value="tax">
                        {(() => {
                          const { periodYear, periodEndMonth } = deriveFiscalPeriod(selectedUpload, selectedCompanyData);
                          return (
                            <KingaTaxPanel
                              companyId={selectedUpload.company_id}
                              uploadId={selectedUpload.id}
                              periodYear={periodYear}
                              periodEndMonth={periodEndMonth}
                              companyName={selectedUpload.company_name ?? undefined}
                              companyTin={selectedCompanyData?.tin ?? undefined}
                              userId={user?.id ?? ""}
                              onResultChange={(r) => setTaxResult(r)}
                            />
                          );
                        })()}
                      </TabsContent>
                      <TabsContent value="comparative">
                        <KingaComparativePanel
                          companyId={selectedUpload.company_id}
                        />
                      </TabsContent>
                    </Tabs>
                  )}

                  {/* Transfer Pricing Risk Register (5D) */}
                  {selectedUpload.status === "complete" && selectedUpload.is_valid === true && selectedUpload.company_id && (() => {
                    const { periodYear } = deriveFiscalPeriod(selectedUpload, selectedCompanyData);
                    return (
                      <TransferPricingPanel
                        companyId={selectedUpload.company_id}
                        uploadId={selectedUpload.id}
                        periodYear={periodYear}
                        companyName={selectedUpload.company_name ?? undefined}
                        userId={user?.id ?? ""}
                      />
                    );
                  })()}

                  {/* TRA e-Filing Readiness Checklist (5H) */}
                  {selectedUpload.status === "complete" && selectedUpload.is_valid === true && selectedUpload.company_id && (() => {
                    const { periodYear, periodEndMonth } = deriveFiscalPeriod(selectedUpload, selectedCompanyData);
                    return (
                      <TRAFilingChecklist
                        uploadId={selectedUpload.id}
                        companyId={selectedUpload.company_id}
                        periodYear={periodYear}
                        periodMonth={periodEndMonth}
                        companyName={selectedUpload.company_name ?? undefined}
                      />
                    );
                  })()}

                  {/* Adjusting Journal Entries (Sprint 5 Item 1) */}
                  {selectedUpload.status === "complete" && selectedUpload.is_valid === true && selectedUpload.company_id && (() => {
                    const { periodYear } = deriveFiscalPeriod(selectedUpload, selectedCompanyData);
                    return (
                      <AdjustingJournalPanel
                        companyId={selectedUpload.company_id}
                        uploadId={selectedUpload.id}
                        periodYear={periodYear}
                        companyName={selectedUpload.company_name ?? undefined}
                        userId={user?.id ?? ""}
                      />
                    );
                  })()}

                  {/* Period Closing Balances — WDV, DT, Loss Pool (Sprint 6 Item 1) */}
                  {selectedUpload.status === "complete" && selectedUpload.is_valid === true && selectedUpload.company_id && (
                    <PeriodClosingBalancesPanel
                      companyId={selectedUpload.company_id}
                      companyName={selectedUpload.company_name ?? undefined}
                    />
                  )}

                  {/* EFDMS Reconciliation — manual entry + engine gap (Sprint 6 Item 3) */}
                  {selectedUpload.status === "complete" && selectedUpload.is_valid === true && selectedUpload.company_id && (() => {
                    const { periodYear, periodEndMonth } = deriveFiscalPeriod(selectedUpload, selectedCompanyData);
                    return (
                      <EFDMSReconciliationPanel
                        companyId={selectedUpload.company_id}
                        uploadId={selectedUpload.id}
                        periodYear={periodYear}
                        periodMonth={periodEndMonth}
                        companyName={selectedUpload.company_name ?? undefined}
                        userId={user?.id ?? ""}
                      />
                    );
                  })()}

                  {/* Processing Notes */}
                  {result?.notes && result.notes.length > 0 && (
                    <Card className="bg-card border-border">
                      <CardHeader>
                        <CardTitle className="text-lg">Processing Notes</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ul className="space-y-2">
                          {result.notes.map((note, index) => (
                            <li key={index} className="flex items-start gap-2 text-sm">
                              <CheckCircle className="w-4 h-4 text-accent flex-shrink-0 mt-0.5" />
                              <span className="text-muted-foreground">{note}</span>
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                  )}
                </>
              ) : (
                <EmptyCertificationState />
              )}
            </div>
          </div>

          {/* ── Sprint 4 + 5: Cross-Company Panels ───────────────── */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <FilingCalendarPanel />
            <PaymentLedgerPanel />
          </div>

          {/* ── Sprint 5: Compliance Intelligence ────────────────── */}
          <ComplianceScorecard />

          {/* Last Activity strip */}
          {uploads.length > 0 && (
            <div className="flex items-center gap-2 px-1 py-2 text-xs text-foreground/50 border-t border-border/30">
              <Clock className="w-3.5 h-3.5 shrink-0" />
              <span>Last upload: <span className="font-medium text-foreground/70">{uploads[0].file_name}</span></span>
              <span className="text-foreground/30">·</span>
              <span>{formatDate(uploads[0].uploaded_at)}</span>
            </div>
          )}
        </div>
        )}
      </main>
    </div>
  );
}