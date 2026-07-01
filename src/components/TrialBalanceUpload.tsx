import React, { useState, useRef, useCallback, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Upload, FileSpreadsheet, CheckCircle, AlertCircle, X, ArrowRight, Loader2, Trash2, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { Progress } from "@/components/ui/progress";
import { useAuditLog } from "@/hooks/useAuditLog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
}

export const TrialBalanceUpload = () => {
  const [files, setFiles] = useState<FileUpload[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [loadingCompanies, setLoadingCompanies] = useState(false);
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
        .select("id, name, code")
        .eq("is_active", true)
        .order("name");

      if (!error && data) {
        setCompanies(data);
      }
      setLoadingCompanies(false);
    };

    fetchCompanies();
  }, [user]);

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

  const addFiles = useCallback((newFiles: FileList) => {
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
      const selectedCompany = companies.find((c) => c.id === selectedCompanyId);

      // Create database record
      const { data: uploadRecord, error: dbError } = await supabase
        .from("trial_balance_uploads")
        .insert({
          file_name: file.name,
          file_path: filePath,
          file_size: file.size,
          status: "processing",
          user_id: user!.id,
          company_id: selectedCompanyId,
          company_name: selectedCompany?.name || null,
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
      const { error: processError } = await supabase.functions.invoke(
        "process-trial-balance",
        { body: { uploadId: uploadRecord.id } }
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
    } catch (error) {
      console.error("Upload error:", error);
      updateFileStatus(id, {
        status: "error",
        errorMessage: error instanceof Error ? error.message : "Upload failed",
      });
    }
  };

  const startProcessing = async () => {
    if (!user) {
      toast.error("Please sign in to upload files");
      navigate("/auth");
      return;
    }

    const queuedFiles = files.filter((f) => f.status === "queued");
    if (queuedFiles.length === 0) {
      toast.error("No files to process");
      return;
    }

    toast.info(`Processing ${queuedFiles.length} file(s)...`);

    // Process files in parallel (max 3 at a time)
    const batchSize = 3;
    for (let i = 0; i < queuedFiles.length; i += batchSize) {
      const batch = queuedFiles.slice(i, i + batchSize);
      await Promise.all(batch.map(processFile));
    }

    const completedCount = files.filter((f) => f.status === "complete").length + 
      queuedFiles.filter((f) => f.status !== "error").length;
    
    if (completedCount > 0) {
      toast.success(`${completedCount} file(s) processed successfully!`);
    }
  };

  const clearCompleted = useCallback(() => {
    setFiles((prev) => prev.filter((f) => f.status !== "complete" && f.status !== "error"));
  }, []);

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

  return (
    <section id="upload" className="py-10 px-6 relative overflow-hidden">
      {/* Background glow */}
      <div className="absolute inset-0 bg-gradient-glow pointer-events-none" />

      <div className="max-w-4xl mx-auto relative z-10">
        {/* Section header */}
        <div className="text-center mb-12">

          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            Upload Multiple Trial Balances
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            Upload CSV or Excel. SAFF ERP validates, classifies every account, and produces statutory-grade output.
          </p>
        </div>

        {/* Company Selector */}
        {user && companies.length > 0 && (
          <div className="mb-6">
            <label className="block text-sm font-medium text-foreground mb-2">
              Select Company (Optional)
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
                <SelectItem value="none">
                  <span className="text-muted-foreground">No company selected</span>
                </SelectItem>
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
            <p className="text-xs text-muted-foreground mt-1">
              Associate uploads with a company for better organization
            </p>
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

            {/* Action Buttons */}
            <div className="flex items-center justify-center gap-4 pt-4">
              {queuedCount > 0 && (
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

        {/* Trust indicators */}
        <div cl