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
import { ExportStatements } from "@/components/ExportStatements";
import { NoteSynth } from "@/components/NoteSynth";
import { KingaFindingsPanel } from "@/components/KingaFindingsPanel";
import { KingaTaxPanel } from "@/components/KingaTaxPanel";
import { KingaComparativePanel } from "@/components/KingaComparativePanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DashboardAnalytics } from "@/components/DashboardAnalytics";
import { PolicyCompass } from "@/components/PolicyCompass";
import { AuditTrail } from "@/components/AuditTrail";
import { CompanySelector } from "@/components/CompanySelector";
import { CompanyManager } from "@/components/CompanyManager";
import { DashboardSkeleton } from "@/components/DashboardSkeleton";
import { NoUploadsEmptyState } from "@/components/EmptyState";
import { ValidationReport } from "@/components/ValidationReport";
import { MappingCoverageIndicator } from "@/components/MappingCoverageIndicator";
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
          setSelectedUpload(data as any);
          await fetchUploads();
          setIsRegenerating(false);
          toast.success("Regeneration complete with corrections applied!");
        } else if (data && data.status === "error") {
          clearInterval(pollInterval);
          setIsRegenerating(false);
          toast.error("Regeneration failed. Please try again.");
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
      setUploads(data as any);
      if (data.length > 0 && !selectedUpload) {
        setSelectedUpload(data[0] as any);
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
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-primary-foreground font-bold text-sm shadow-lg">
                AX
              </div>
              <div>
                <h1 className="text-base font-semibold text-foreground">Results Dashboard</h1>
                <p className="text-xs text-muted-foreground">AI-Generated Financial Mappings</p>
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
                processingResult={selectedUpload.processing_result as any}
                uploadId={selectedUpload.id}
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
            {/* Analytics Section */}
            <DashboardAnalytics uploads={uploads as any} />
            
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
              {/* Sidebar - Upload List */}
              <div className="lg:col-span-1 space-y-3">
                <h2 className="text-sm font-semibold text-foreground mb-4">Recent Uploads</h2>
                {uploads.map((upload) => (
                  <div
                    key={upload.id}
                    className={`relative group p-4 rounded-xl border transition-all ${
                      selectedUpload?.id === upload.id
                        ? "bg-primary/10 border-primary/30"
                        : "bg-card border-border hover:border-primary/20"
                    }`}
                  >
                    <button
                      onClick={() => setSelectedUpload(upload)}
                      className="w-full text-left"
                    >
                      <div className="flex items-start gap-3">
                        <FileSpreadsheet className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {upload.file_name}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {formatDate(upload.uploaded_at)}
                          </p>
                          <div className="flex items-center gap-2 mt-2">
                            {getStatusIcon(upload.status)}
                            <span className="text-xs text-muted-foreground capitalize">
                              {upload.status}
                            </span>
                          </div>
                        </div>
                      </div>
                    </button>
                    
                    {/* Delete button */}
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete Upload</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to delete "{upload.file_name}"? This will permanently remove the file and all associated data including any corrections.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDeleteUpload(upload)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            disabled={isDeleting}
                          >
                            {isDeleting ? "Deleting..." : "Delete"}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                ))}
              </div>

            {/* Main Content */}
            <div className="lg:col-span-3 space-y-6">
              {selectedUpload ? (
                <>
                  {/* File Info */}
                  <Card className="bg-card border-border">
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-lg flex items-center gap-2">
                          <FileSpreadsheet className="w-5 h-5 text-primary" />
                          {selectedUpload.file_name}
                        </CardTitle>
                        <div className="flex items-center gap-2">
                          {getStatusIcon(selectedUpload.status)}
                          <span className="text-sm text-muted-foreground capitalize">
                            {selectedUpload.status}
                          </span>
                          {selectedUpload.is_valid === true && (
                            <Badge className="bg-accent/20 text-accent border-accent/30">VALID</Badge>
                          )}
                          {selectedUpload.is_valid === false && (
                            <Badge className="bg-destructive/20 text-destructive border-destructive/30">BLOCKED</Badge>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div>
                          <p className="text-muted-foreground">File Size</p>
                          <p className="font-medium text-foreground">
                            {formatFileSize(selectedUpload.file_size)}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Uploaded</p>
                          <p className="font-medium text-foreground">
                            {formatDate(selectedUpload.uploaded_at)}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Processed</p>
                          <p className="font-medium text-foreground">
                            {selectedUpload.processed_at
                              ? formatDate(selectedUpload.processed_at)
                              : "—"}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Total Accounts</p>
                          <p className="font-medium text-foreground">
                            {summary?.totalAccounts || "—"}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Mapping Coverage Indicator */}
                  {selectedUpload.processing_result && (
                    <MappingCoverageIndicator
                      uploadId={selectedUpload.id}
                      processingResult={selectedUpload.processing_result}
                      onOpenMappingManager={handleOpenMappingManager}
                    />
                  )}

                  {/* AXIOM Validation Report */}
                  <div ref={validationReportRef}>
                    <ValidationReport 
                      report={selectedUpload.validation_report}
                      errors={selectedUpload.accounting_errors || []}
                      isValid={selectedUpload.is_valid}
                      status={selectedUpload.status}
                    />
                  </div>

                  {/* Confidence Score & Corrections */}
                  {summary && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <Card className="bg-card border-border">
                        <CardHeader className="pb-3">
                          <CardTitle className="text-lg flex items-center gap-2">
                            <TrendingUp className="w-5 h-5 text-accent" />
                            AI Confidence Score
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="flex items-center gap-4">
                            <div className="flex-1">
                              <Progress
                                value={summary.confidenceScore}
                                className="h-3"
                              />
                            </div>
                            <span className="text-2xl font-bold text-accent">
                              {summary.confidenceScore}%
                            </span>
                          </div>
                          <p className="text-sm text-muted-foreground mt-3">
                            MapNet AI analyzed {summary.totalAccounts} accounts.
                          </p>
                        </CardContent>
                      </Card>

                      <Card className={`bg-card border-border ${correctionCount > 0 ? 'ring-2 ring-accent/50' : ''}`}>
                        <CardHeader className="pb-3">
                          <CardTitle className="text-lg flex items-center gap-2">
                            <UserCheck className="w-5 h-5 text-accent" />
                            User-Verified Corrections
                            {correctionCount > 0 && (
                              <Badge variant="secondary" className="bg-accent/20 text-accent border-accent/30">
                                Active
                              </Badge>
                            )}
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="flex items-center gap-4">
                            <span className="text-3xl font-bold text-foreground">
                              {correctionCount}
                            </span>
                            <span className="text-muted-foreground">
                              account{correctionCount !== 1 ? 's' : ''} corrected
                            </span>
                          </div>
                          <p className="text-sm text-muted-foreground mt-3">
                            {correctionCount > 0 
                              ? "These corrections will be applied when regenerating statements."
                              : "No manual corrections applied yet."}
                          </p>
                        </CardContent>
                      </Card>
                    </div>
                  )}

                  {/* Statement Breakdown */}
                  {summary && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <Card className="bg-card border-border">
                        <CardContent className="pt-6">
                          <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center">
                              <BarChart3 className="w-5 h-5 text-primary" />
                            </div>
                            <div>
                              <p className="text-sm text-muted-foreground">Balance Sheet</p>
                              <p className="text-2xl font-bold text-foreground">
                                {summary.balanceSheetAccounts}
                              </p>
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">accounts mapped</p>
                        </CardContent>
                      </Card>

                      <Card className="bg-card border-border">
                        <CardContent className="pt-6">
                          <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-accent/20 flex items-center justify-center">
                              <TrendingUp className="w-5 h-5 text-accent" />
                            </div>
                            <div>
                              <p className="text-sm text-muted-foreground">Income Statement</p>
                              <p className="text-2xl font-bold text-foreground">
                                {summary.incomeStatementAccounts}
                              </p>
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">accounts mapped</p>
                        </CardContent>
                      </Card>

                      <Card className="bg-card border-border">
                        <CardContent className="pt-6">
                          <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center">
                              <PieChart className="w-5 h-5 text-foreground" />
                            </div>
                            <div>
                              <p className="text-sm text-muted-foreground">Cash Flow</p>
                              <p className="text-2xl font-bold text-foreground">
                                {summary.cashFlowAccounts}
                              </p>
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">accounts mapped</p>
                        </CardContent>
                      </Card>
                    </div>
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

                  {/* Kinga — Statutory Compliance Analysis */}
                  {selectedUpload.status === "complete" && selectedUpload.is_valid === true && selectedUpload.company_id && (
                    <KingaFindingsPanel
                      companyId={selectedUpload.company_id}
                      uploadId={selectedUpload.id}
                      periodYear={new Date(selectedUpload.uploaded_at).getFullYear()}
                      periodMonth={new Date(selectedUpload.uploaded_at).getMonth() + 1}
                      companyName={selectedUpload.company_name ?? undefined}
                      userId={user?.id ?? ""}
                    />
                  )}

                  {/* Kinga — Tax + Comparative tabs */}
                  {selectedUpload.status === "complete" && selectedUpload.is_valid === true && selectedUpload.company_id && (
                    <Tabs defaultValue="tax" className="w-full">
                      <TabsList>
                        <TabsTrigger value="tax">Corporate Tax (ITA)</TabsTrigger>
                        <TabsTrigger value="comparative">Comparative Analysis</TabsTrigger>
                      </TabsList>
                      <TabsContent value="tax">
                        <KingaTaxPanel
                          companyId={selectedUpload.company_id}
                          uploadId={selectedUpload.id}
                          periodYear={new Date(selectedUpload.uploaded_at).getFullYear()}
                          companyName={selectedUpload.company_name ?? undefined}
                          userId={user?.id ?? ""}
                        />
                      </TabsContent>
                      <TabsContent value="comparative">
                        <KingaComparativePanel
                          companyId={selectedUpload.company_id}
                        />
                      </TabsContent>
                    </Tabs>
                  )}

                  {/* AI Processing Notes */}
                  {result?.notes && result.notes.length > 0 && (
                    <Card className="bg-card border-border">
                      <CardHeader>
                        <CardTitle className="text-lg">AI Processing Notes</CardTitle>
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
                <Card className="bg-card border-border">
                  <CardContent className="py-16">
                    <div className="text-center">
                      <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center mx-auto mb-4">
                        <Eye className="w-8 h-8 text-muted-foreground" />
                      </div>
                      <h3 className="text-lg font-semibold text-foreground mb-2">No Upload Selected</h3>
                      <p className="text-muted-foreground text-sm">
                        Select an upload from the list to view its processing results and financial mappings.
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>

          {/* Policy Compass Section */}
          <PolicyCompass 
            financialData={mapping ? {
              accounts: [
                ...(mapping.balanceSheet?.assets?.current || []),
                ...(mapping.balanceSheet?.assets?.nonCurrent || []),
                ...(mapping.balanceSheet?.liabilities?.current || []),
                ...(mapping.balanceSheet?.liabilities?.nonCurrent || []),
                ...(mapping.balanceSheet?.equity || []),
              ],
              totals: summary ? {
                assets: summary.balanceSheetAccounts,
                liabilities: summary.balanceSheetAccounts,
                equity: summary.balanceSheetAccounts
              } : undefined
            } : undefined}
          />
          
          {/* Audit Trail Section */}
          <AuditTrail />
          </div>
        )}
      </main>

      {/* Account Mapping Modal */}
      {selectedUpload && (
        <AccountMappingModal
          open={mappingModalOpen}
          onOpenChange={setMappingModalOpen}
          uploadId={selectedUpload.id}
          mapping={mapping}
          onSaveCorrections={(corrections) => {
            console.log("Corrections saved:", corrections);
            if (selectedUpload) {
              fetchCorrectionCount(selectedUpload.id);
            }
          }}
        />
      )}
    </div>
  );
}
