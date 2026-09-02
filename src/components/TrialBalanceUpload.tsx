import React, { useState, useRef, useCallback, useEffect } from "react";
import { ensureFreshSession } from "@/lib/ensureFreshSession";
import { Link, useNavigate } from "react-router-dom";
import { Upload, FileSpreadsheet, CheckCircle, AlertCircle, X, ArrowRight, Loader2, Trash2, Building2, ChevronDown, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { Progress } from "@/components/ui/progress";
import { useAuditLog } from "@/hooks/useAuditLog";
import SafishaGate from "@/components/safisha/SafishaGate";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** A real TRA TIN is 9 or 11 digits — anything else (including "PUT-REAL-TRA-TIN-HERE") is missing */
function isTinMissing(tin: string | null | undefined): boolean {
  if (!tin) return true;
  if (/PUT-REAL|placeholder/i.test(tin)) return true;
  return !/^\d{9,12}$/.test(tin.replace(/-/g, ""));
}

interface FileUpload {
  id: string;
  file: File;
  status: "queued" | "uploading" | "processing" | "complete" | "error";
  progress: number;
  uploadId?: string;
  errorMessage?: string;
}

interface Company {
  id: string;
  name: string;
  code: string | null;
  tin: string | null;
}

export interface TrialBalanceUploadProps {
  /** Render as an in-workspace panel: no marketing header, no company picker. */
  embedded?: boolean;
  /** Force uploads to this company — hides the selector entirely. */
  lockedCompanyId?: string;
  lockedCompanyName?: string;
  /** Financial year the upload belongs to (written to period_year). */
  periodYear?: number;
  /**
   * Engagement the upload belongs to. Uploads attach to the professional
   * engagement, not only the reporting period. A DB trigger rejects an
   * engagement that belongs to a different company or reporting period.
   */
  engagementId?: string | null;
  /** Reporting period of record for the engagement (fiscal_periods.id). */
  periodId?: string | null;
  /**
   * Seed the queue with a file the user already picked elsewhere
   * (one-tap discard-and-reupload). Queued, not uploaded, unless autoProcess.
   */
  initialFile?: File | null;
  /** Start processing the seeded file immediately — no second click. */
  autoProcess?: boolean;
  /** Called after a batch finishes so the parent can refresh. */
  onUploaded?: () => void;
}

export const TrialBalanceUpload = ({
  embedded = false,
  lockedCompanyId,
  lockedCompanyName,
  periodYear,
  engagementId = null,
  periodId = null,
  initialFile = null,
  autoProcess = false,
  onUploaded,
}: TrialBalanceUploadProps = {}) => {
  const [files, setFiles] = useState<FileUpload[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [loadingCompanies, setLoadingCompanies] = useState(false);
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  // Safisha gate: set when a TB upload completes and needs verification
  const [safishaUpload, setSafishaUpload] = useState<{ uploadId: string; fileName: string } | null>(null);
  // Duplicate filename warning — list of duplicates found + the files waiting to be processed.
  // Shown as a confirmation banner before re-uploading an already-processed file.
  const [duplicateWarning, setDuplicateWarning] = useState<{
    duplicates: Array<{ fileName: string; existingDate: string }>;
    pendingFiles: FileUpload[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { user } = useAuth();
  const navigate = useNavigate();
  const { logAction } = useAuditLog();

  // Fetch companies when user is authenticated
  useEffect(() => {
    const fetchCompanies = async () => {
      if (!user) return;
      setLoadingCompanies(true);
      const { data, error } = await supabase
        .from("companies")
        .select("id, name, code, tin")
        .eq("is_active", true)
        .order("name");

      if (!error && data) {
        setCompanies(data);
        // Locked company (workspace context) always wins.
        if (lockedCompanyId) {
          setSelectedCompanyId(lockedCompanyId);
        } else if (data.length === 1) {
          // Auto-select the only active company so uploads are never unassigned.
          setSelectedCompanyId(data[0].id);
        }
      }
      setLoadingCompanies(false);
    };

    fetchCompanies();
  }, [user, lockedCompanyId]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const validateFile = (file: File): boolean => {
    const validExtensions = [".csv", ".xlsx", ".xls"];
    const extension = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
    return validExtensions.includes(extension);
  };

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const validFiles: FileUpload[] = [];
    
    Array.from(newFiles).forEach((file) => {
      if (validateFile(file)) {
        validFiles.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file,
          status: "queued",
          progress: 0,
        });
      } else {
        toast.error(`Invalid file format: ${file.name}`);
      }
    });

    if (validFiles.length > 0) {
      setFiles((prev) => [...prev, ...validFiles]);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        addFiles(e.target.files);
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [addFiles]
  );

  const removeFile = useCallback((fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== fileId));
  }, []);

  const updateFileStatus = useCallback((fileId: string, updates: Partial<FileUpload>) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, ...updates } : f))
    );
  }, []);

  const processFile = async (fileUpload: FileUpload) => {
    const { id, file } = fileUpload;

    try {
      updateFileStatus(id, { status: "uploading", progress: 10 });

      // Generate unique file path
      const timestamp = Date.now();
      const filePath = `${user!.id}/${timestamp}_${file.name}`;

      // Upload file to storage
      const { error: uploadError } = await supabase.storage
        .from("trial-balance-files")
        .upload(filePath, file);

      if (uploadError) throw new Error(uploadError.message);

      updateFileStatus(id, { progress: 40 });

      // Get selected company name for the record
      const targetCompanyId = lockedCompanyId ?? selectedCompanyId;
      const selectedCompany = companies.find((c) => c.id === targetCompanyId);

      // Create database record
      const { data: uploadRecord, error: dbError } = await supabase
        .from("trial_balance_uploads")
        .insert({
          file_name: file.name,
          file_path: filePath,
          file_size: file.size,
          status: "processing",
          user_id: user!.id,
          company_id: targetCompanyId,
          company_name: selectedCompany?.name || lockedCompanyName || null,
          ...(periodYear ? { period_year: periodYear } : {}),
          ...(periodId ? { period_id: periodId } : {}),
          ...(engagementId ? { engagement_id: engagementId } : {}),
        })
        .select()
        .single();

      if (dbError) throw new Error(dbError.message);

      updateFileStatus(id, { status: "processing", progress: 60, uploadId: uploadRecord.id });

      // Log the upload action
      logAction({
        action: "upload_trial_balance",
        entityType: "trial_balance_upload",
        entityId: uploadRecord.id,
        metadata: { fileName: file.name, fileSize: file.size },
      });

      // Call edge function to process with AI
      await ensureFreshSession();
      // Generated once, immediately before the call (no retry wrapper
      // exists here) — reused only if this exact request is retried, never
      // regenerated server-side.
      const clientRequestId = crypto.randomUUID();
      const { error: processError } = await supabase.functions.invoke(
        "process-trial-balance",
        { body: { uploadId: uploadRecord.id, clientRequestId } }
      );

      if (processError) throw new Error(processError.message || "AI processing failed");

      // Log the processing action
      logAction({
        action: "process_trial_balance",
        entityType: "trial_balance_upload",
        entityId: uploadRecord.id,
        metadata: { fileName: file.name },
      });

      updateFileStatus(id, { status: "complete", progress: 100 });

      // SAFISHA GATE: open the evidence verification gate for this upload
      // The tax engine is locked until Safisha clears it (safisha_status = 'clean')
      setSafishaUpload({ uploadId: uploadRecord.id, fileName: file.name });
    } catch (error) {
      console.error("Upload error:", error);
      updateFileStatus(id, {
        status: "error",
        errorMessage: error instanceof Error ? error.message : "Upload failed",
      });
    }
  };

  // Run a batch of files through the pipeline (called after duplicate confirmation too)
  const runBatch = async (queuedFiles: FileUpload[]) => {
    toast.info(`Processing ${queuedFiles.length} file(s)...`);
    const batchSize = 3;
    for (let i = 0; i < queuedFiles.length; i += batchSize) {
      const batch = queuedFiles.slice(i, i + batchSize);
      await Promise.all(batch.map(processFile));
    }
    const done = queuedFiles.filter((f) => f.status !== "error").length;
    if (done > 0) {
      toast.success(`${done} file(s) processed successfully!`);
    }
    onUploaded?.();
  };

  const startProcessing = async () => {
    if (!user) {
      toast.error("Please sign in to upload files");
      navigate("/auth");
      return;
    }

    if (!lockedCompanyId && companies.length > 1 && !selectedCompanyId) {
      toast.error("Select a company before uploading.");
      return;
    }

    // ── Fix 2: TIN gate ───────────────────────────────────────────────────────
    // A real TRA TIN is required before any trial balance can be submitted.
    // If the company has no TIN (or still has the placeholder), block the upload
    // and direct the user to Settings so they can enter the real number.
    const selectedCompany = companies.find(
      (c) => c.id === (lockedCompanyId ?? selectedCompanyId ?? companies[0]?.id),
    );
    if (isTinMissing(selectedCompany?.tin)) {
      toast.error("Enter the company's TRA TIN in Settings before uploading.", {
        action: {
          label: "Open Settings",
          onClick: () => navigate("/settings"),
        },
      });
      return;
    }

    const queuedFiles = files.filter((f) => f.status === "queued");
    if (queuedFiles.length === 0) {
      toast.error("No files to process");
      return;
    }

    // ── Fix 8: Duplicate filename detection ───────────────────────────────────
    // Before processing, check whether any queued file has already been
    // successfully uploaded for this company. Show a confirmation banner so
    // the user can decide — don't silently re-process or silently block.
    const companyId = lockedCompanyId ?? selectedCompanyId ?? companies[0]?.id ?? null;
    if (companyId) {
      const fileNames = queuedFiles.map((f) => f.file.name);

      const { data: existing } = await supabase
        .from("trial_balance_uploads")
        .select("file_name, uploaded_at")
        .eq("company_id", companyId)
        .in("file_name", fileNames)
        .in("status", ["complete", "valid"])
        .order("uploaded_at", { ascending: false });

      if (existing && existing.length > 0) {
        // Deduplicate by filename — only the most recent match per name
        const seen = new Set<string>();
        const duplicates: Array<{ fileName: string; existingDate: string }> = [];
        for (const row of existing) {
          if (!seen.has(row.file_name)) {
            seen.add(row.file_name);
            duplicates.push({
              fileName: row.file_name,
              existingDate: row.uploaded_at,
            });
          }
        }
        // Pause — let the user confirm before re-processing
        setDuplicateWarning({ duplicates, pendingFiles: queuedFiles });
        return;
      }
    }

    await runBatch(queuedFiles);
  };

  const clearCompleted = useCallback(() => {
    setFiles((prev) => prev.filter((f) => f.status !== "complete" && f.status !== "error"));
  }, []);

  // ── One-tap reupload ───────────────────────────────────────────────────────
  // A file picked on the prep screen (right after discarding the prior run) is
  // seeded here and, when autoProcess is set, submitted without a second click.
  const seededFileRef = useRef<File | null>(null);
  const autoStartRef = useRef(false);

  useEffect(() => {
    if (!initialFile || seededFileRef.current === initialFile) return;
    seededFileRef.current = initialFile;
    setFiles([]);
    addFiles([initialFile]);
    autoStartRef.current = autoProcess;
  }, [initialFile, autoProcess, addFiles]);

  useEffect(() => {
    if (!autoStartRef.current) return;
    if (!files.some((f) => f.status === "queued")) return;
    if (!user || loadingCompanies) return;
    autoStartRef.current = false;
    void startProcessing();
  }, [files, user, loadingCompanies]);

  const clearAll = useCallback(() => {
    setFiles([]);
  }, []);

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const getStatusIcon = (status: FileUpload["status"]) => {
    switch (status) {
      case "complete":
        return <CheckCircle className="w-5 h-5 text-accent" />;
      case "error":
        return <AlertCircle className="w-5 h-5 text-destructive" />;
      case "uploading":
      case "processing":
        return <Loader2 className="w-5 h-5 text-primary animate-spin" />;
      default:
        return <FileSpreadsheet className="w-5 h-5 text-muted-foreground" />;
    }
  };

  const getStatusLabel = (status: FileUpload["status"]) => {
    switch (status) {
      case "queued":
        return "Queued";
      case "uploading":
        return "Uploading...";
      case "processing":
        return "Processing with AI...";
      case "complete":
        return "Complete";
      case "error":
        return "Failed";
    }
  };

  const queuedCount = files.filter((f) => f.status === "queued").length;
  const processingCount = files.filter((f) => f.status === "uploading" || f.status === "processing").length;
  const completedCount = files.filter((f) => f.status === "complete").length;
  const isProcessing = processingCount > 0;

  const lockedCompany = lockedCompanyId
    ? companies.find((c) => c.id === lockedCompanyId)
    : undefined;

  return (
    <section
      id="upload"
      className={embedded ? "relative" : "py-10 px-6 relative overflow-hidden"}
    >
      {!embedded && <div className="absolute inset-0 bg-gradient-glow pointer-events-none" />}

      <div className={embedded ? "relative z-10" : "max-w-4xl mx-auto relative z-10"}>
        {/* Section header — marketing surface only */}
        {!embedded && (
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
              Upload Multiple Trial Balances
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Upload CSV or Excel. SAFF ERP validates, classifies every account, and produces statutory-grade output.
            </p>
          </div>
        )}

        {/* Destination is already stated once in the workspace bar — the only
            thing worth saying here is a blocking gap. */}
        {embedded && lockedCompanyId && isTinMissing(lockedCompany?.tin) && (
          <p className="mb-4 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-3 h-3 shrink-0" />
            TRA TIN not set —{" "}
            <Link to="/settings" className="underline underline-offset-2">add it in Settings</Link>{" "}
            before uploading.
          </p>
        )}

        {/* Company Selector */}
        {!lockedCompanyId && user && companies.length > 0 && (
          <div className="mb-6">
            <label className="block text-sm font-medium text-foreground mb-2">
              Select Company{companies.length > 1 ? " (Required)" : ""}
            </label>
            <Select
              value={selectedCompanyId || "none"}
              onValueChange={(val) => setSelectedCompanyId(val === "none" ? null : val)}
            >
              <SelectTrigger className="w-full md:w-80">
                <div className="flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-primary" />
                  <SelectValue placeholder="Select a company" />
                </div>
              </SelectTrigger>
              <SelectContent>
                {companies.length > 1 && (
                  <SelectItem value="none">
                    <span className="text-muted-foreground">No company selected</span>
                  </SelectItem>
                )}
                {companies.map((company) => (
                  <SelectItem key={company.id} value={company.id}>
                    {company.name}
                    {company.code && (
                      <span className="text-muted-foreground ml-2">({company.code})</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {companies.length > 1 && !selectedCompanyId ? (
              <p className="text-xs text-destructive mt-1">
                Select a company before uploading.
              </p>
            ) : (() => {
              const sel = companies.find((c) => c.id === (selectedCompanyId ?? companies[0]?.id));
              return isTinMissing(sel?.tin) ? (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  TRA TIN not set.{" "}
                  <Link to="/settings" className="underline underline-offset-2 hover:text-amber-700">
                    Add it in Settings
                  </Link>{" "}
                  before uploading.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground mt-1">
                  Associate uploads with a company for better organization
                </p>
              );
            })()}
          </div>
        )}

        {/* Formatting guide — collapsed by default.
            Suppressed when embedded: the workspace shows one authoritative
            file-requirements surface beside the uploader, never two. */}
        {!embedded && (
        <div className="mb-6">
          <button
            onClick={() => setIsGuideOpen(!isGuideOpen)}
            className="flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${isGuideOpen ? "rotate-180" : ""}`} />
            {isGuideOpen ? "Hide formatting guide" : "Show formatting guide"}
          </button>

          {isGuideOpen && (
            <div className="mt-3 p-4 rounded-xl border border-border bg-card/80 text-sm space-y-4">
              <p className="font-semibold text-foreground">How to format your trial balance file</p>

              <div>
                <p className="font-medium text-foreground mb-1">Accepted formats</p>
                <ul className="space-y-0.5 text-muted-foreground">
                  <li>✓ Excel (.xlsx, .xls) or CSV (.csv)</li>
                  <li>✓ One row per account</li>
                  <li>✓ Column headers in the first row</li>
                </ul>
              </div>

              <div>
                <p className="font-medium text-foreground mb-2">Required columns</p>
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-1 pr-4 font-medium text-foreground">Column</th>
                      <th className="text-left py-1 font-medium text-foreground">Accepted header names</th>
                    </tr>
                  </thead>
                  <tbody className="text-muted-foreground">
                    <tr className="border-b border-border/50">
                      <td className="py-1 pr-4 font-medium text-foreground">Account Code</td>
                      <td className="py-1">Account Code, Code, GL Code, Account No</td>
                    </tr>
                    <tr className="border-b border-border/50">
                      <td className="py-1 pr-4 font-medium text-foreground">Account Name</td>
                      <td className="py-1">Account Name, Name, Description, Particulars</td>
                    </tr>
                    <tr className="border-b border-border/50">
                      <td className="py-1 pr-4 font-medium text-foreground">Debit</td>
                      <td className="py-1">Debit, Dr, Debit (TZS), Debit Amount</td>
                    </tr>
                    <tr>
                      <td className="py-1 pr-4 font-medium text-foreground">Credit</td>
                      <td className="py-1">Credit, Cr, Credit (TZS), Credit Amount</td>
                    </tr>
                  </tbody>
                </table>
                <p className="text-xs text-muted-foreground mt-2">
                  Column headers are not case-sensitive. You may also use a single{" "}
                  <span className="font-medium text-foreground">Balance</span>{" "}
                  column instead of separate Debit and Credit columns.
                </p>
              </div>

              <div>
                <p className="font-medium text-foreground mb-2">Example row</p>
                <div className="overflow-x-auto">
                  <table className="text-xs border-collapse border border-border rounded">
                    <thead>
                      <tr className="bg-secondary">
                        <th className="border border-border px-3 py-1 text-left text-foreground">Account Code</th>
                        <th className="border border-border px-3 py-1 text-left text-foreground">Account Name</th>
                        <th className="border border-border px-3 py-1 text-right text-foreground">Debit</th>
                        <th className="border border-border px-3 py-1 text-right text-foreground">Credit</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="border border-border px-3 py-1 text-muted-foreground">6040</td>
                        <td className="border border-border px-3 py-1 text-muted-foreground">Skills Development Levy</td>
                        <td className="border border-border px-3 py-1 text-right text-muted-foreground">103,072,691</td>
                        <td className="border border-border px-3 py-1 text-right text-muted-foreground">—</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <p className="font-medium text-foreground mb-1">What happens next</p>
                <p className="text-muted-foreground">
                  SAFF ERP will validate every account, check that Debits = Credits,
                  classify each account automatically, and block export until all checks pass.
                </p>
              </div>
            </div>
          )}
        </div>
        )}

        {/* Upload area */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`
            relative rounded-2xl border-2 border-dashed transition-all duration-300 overflow-hidden
            ${isDragging ? "border-primary bg-primary/5 scale-[1.02]" : "border-border bg-card/50 hover:border-primary/50 hover:bg-card"}
          `}
        >
          <div className="p-8 text-center">
            <div
              className={`
                w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center transition-all duration-300
                ${isDragging ? "bg-primary/20 scale-110" : "bg-secondary"}
              `}
            >
              <Upload
                className={`w-8 h-8 transition-all duration-300 ${
                  isDragging ? "text-primary animate-bounce" : "text-muted-foreground"
                }`}
              />
            </div>

            <h3 className="text-lg font-semibold text-foreground mb-2">
              {isDragging ? "Drop files here" : "Drag & drop trial balances"}
            </h3>
            <p className="text-muted-foreground mb-4 text-sm">
              Supports CSV, XLS, and XLSX • Multiple files allowed
            </p>

            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="gap-2"
            >
              Browse Files
            </Button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>
        </div>

        {/* File Queue */}
        {files.length > 0 && (
          <div className="mt-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">
                Files ({files.length})
                {completedCount > 0 && (
                  <span className="ml-2 text-accent">• {completedCount} complete</span>
                )}
              </h3>
              <div className="flex items-center gap-2">
                {(completedCount > 0 || files.some((f) => f.status === "error")) && (
                  <Button variant="ghost" size="sm" onClick={clearCompleted} className="text-xs">
                    Clear Finished
                  </Button>
                )}
                {files.length > 0 && !isProcessing && (
                  <Button variant="ghost" size="sm" onClick={clearAll} className="text-xs text-destructive">
                    Clear All
                  </Button>
                )}
              </div>
            </div>

            <div className="space-y-2 max-h-80 overflow-y-auto">
              {files.map((fileUpload) => (
                <div
                  key={fileUpload.id}
                  className={`
                    flex items-center gap-3 p-3 rounded-xl border transition-all
                    ${fileUpload.status === "complete" ? "bg-accent/5 border-accent/20" : ""}
                    ${fileUpload.status === "error" ? "bg-destructive/5 border-destructive/20" : ""}
                    ${fileUpload.status === "queued" ? "bg-card border-border" : ""}
                    ${fileUpload.status === "uploading" || fileUpload.status === "processing" ? "bg-primary/5 border-primary/20" : ""}
                  `}
                >
                  {getStatusIcon(fileUpload.status)}
                  
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {fileUpload.file.name}
                    </p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{formatFileSize(fileUpload.file.size)}</span>
                      <span>•</span>
                      <span className={fileUpload.status === "error" ? "text-destructive" : ""}>
                        {fileUpload.status === "error" ? fileUpload.errorMessage : getStatusLabel(fileUpload.status)}
                      </span>
                    </div>
                    {(fileUpload.status === "uploading" || fileUpload.status === "processing") && (
                      <Progress value={fileUpload.progress} className="h-1 mt-2" />
                    )}
                  </div>

                  {fileUpload.status === "queued" && (
                    <button
                      onClick={() => removeFile(fileUpload.id)}
                      className="p-1.5 rounded-lg hover:bg-secondary transition-colors"
                    >
                      <X className="w-4 h-4 text-muted-foreground" />
                    </button>
                  )}
                  
                  {fileUpload.status === "error" && (
                    <button
                      onClick={() => removeFile(fileUpload.id)}
                      className="p-1.5 rounded-lg hover:bg-destructive/10 transition-colors"
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* ── Fix 8: Duplicate filename confirmation banner ────────────────
                 Appears when startProcessing() detects a file already uploaded
                 for this company. The user can cancel or proceed anyway.
            ──────────────────────────────────────────────────────────────── */}
            {duplicateWarning && (
              <div className="border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 rounded-xl p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                      {duplicateWarning.duplicates.length === 1
                        ? "This file was already uploaded"
                        : `${duplicateWarning.duplicates.length} files were already uploaded`}
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {duplicateWarning.duplicates.map((d) => (
                        <li key={d.fileName} className="text-xs text-amber-700 dark:text-amber-400 font-mono truncate">
                          {d.fileName}
                          <span className="font-sans ml-2 opacity-70">
                            — previously uploaded {new Date(d.existingDate).toLocaleDateString("en-TZ", {
                              day: "numeric", month: "short", year: "numeric"
                            })}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-1.5">
                      Re-uploading will create a new version. The previous upload will remain in history.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    onClick={() => setDuplicateWarning(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs border-amber-400 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                    onClick={async () => {
                      const pending = duplicateWarning.pendingFiles;
                      setDuplicateWarning(null);
                      await runBatch(pending);
                    }}
                  >
                    Upload anyway
                  </Button>
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex items-center justify-center gap-4 pt-4">
              {queuedCount > 0 && !duplicateWarning && (
                <Button
                  variant="hero"
                  onClick={startProcessing}
                  disabled={isProcessing}
                  className="gap-2"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Processing {processingCount} file(s)...
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4" />
                      Process {queuedCount} File{queuedCount !== 1 ? "s" : ""}
                    </>
                  )}
                </Button>
              )}
              
              {completedCount > 0 && (
                <Button variant="outline" className="gap-2" asChild>
                  <Link to="/dashboard">
                    View Dashboard
                    <ArrowRight className="w-4 h-4" />
                  </Link>
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ── SAFISHA GATE ─────────────────────────────────────────────────────
             Appears immediately after a TB upload completes.
             The tax engine is locked until this gate clears.
             Iron Dome: this panel cannot be skipped or dismissed.
        ──────────────────────────────────────────────────────────────────── */}
        {safishaUpload && (
          <div className="mt-6 p-5 rounded-xl border-2 border-[#0E6B55]/40 bg-card shadow-sm">
            <SafishaGate
              uploadId={safishaUpload.uploadId}
              fileName={safishaUpload.fileName}
              onCleared={() => {
                toast.success("TB verified — tax engine unlocked for " + safishaUpload.fileName);
              }}
              onBlocked={() => {
                toast.error("Reconciliation blocked — re-upload a corrected TB to proceed.");
              }}
            />
          </div>
        )}

        {/* Trust indicator — one fact that is true at import time.
            Tax-output claims belong to the Tax stage, not to this screen. */}
        <div className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <CheckCircle className="w-3.5 h-3.5 text-accent" />
          <span>Encrypted storage · your file is never shared</span>
        </div>
      </div>
    </section>
  );
};