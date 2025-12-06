import React, { useState, useRef, useCallback } from "react";
import { Upload, FileSpreadsheet, CheckCircle, AlertCircle, X, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface UploadState {
  status: "idle" | "dragging" | "uploading" | "processing" | "complete" | "error";
  progress: number;
  fileName?: string;
  fileSize?: number;
}

export const TrialBalanceUpload = () => {
  const [uploadState, setUploadState] = useState<UploadState>({
    status: "idle",
    progress: 0,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setUploadState((prev) => ({ ...prev, status: "dragging" }));
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setUploadState((prev) => ({ ...prev, status: "idle" }));
  }, []);

  const simulateUpload = useCallback((file: File) => {
    setUploadState({
      status: "uploading",
      progress: 0,
      fileName: file.name,
      fileSize: file.size,
    });

    // Simulate upload progress
    let progress = 0;
    const uploadInterval = setInterval(() => {
      progress += Math.random() * 15;
      if (progress >= 100) {
        progress = 100;
        clearInterval(uploadInterval);
        setUploadState((prev) => ({ ...prev, status: "processing", progress: 100 }));

        // Simulate processing
        setTimeout(() => {
          setUploadState((prev) => ({ ...prev, status: "complete" }));
        }, 1500);
      } else {
        setUploadState((prev) => ({ ...prev, progress: Math.min(progress, 100) }));
      }
    }, 200);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file && (file.name.endsWith(".csv") || file.name.endsWith(".xlsx") || file.name.endsWith(".xls"))) {
        simulateUpload(file);
      } else {
        setUploadState({ status: "error", progress: 0, fileName: file?.name });
      }
    },
    [simulateUpload]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        simulateUpload(file);
      }
    },
    [simulateUpload]
  );

  const handleReset = useCallback(() => {
    setUploadState({ status: "idle", progress: 0 });
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const processingSteps = [
    { label: "Parsing trial balance", delay: 0 },
    { label: "Mapping accounts to GAAP/IFRS", delay: 0.3 },
    { label: "Generating financial statements", delay: 0.6 },
    { label: "Creating compliance notes", delay: 0.9 },
  ];

  return (
    <section className="py-24 px-6 relative overflow-hidden">
      {/* Background glow */}
      <div className="absolute inset-0 bg-gradient-glow pointer-events-none" />

      <div className="max-w-4xl mx-auto relative z-10">
        {/* Section header */}
        <div className="text-center mb-12">
          <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-primary text-sm font-medium mb-4">
            <FileSpreadsheet className="w-4 h-4" />
            Try It Now
          </span>
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            Upload Your Trial Balance
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            Drop your CSV or Excel file and watch Axiom transform it into audit-ready financial statements in seconds.
          </p>
        </div>

        {/* Upload area */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`
            relative rounded-2xl border-2 border-dashed transition-all duration-300 overflow-hidden
            ${uploadState.status === "idle" ? "border-border bg-card/50 hover:border-primary/50 hover:bg-card" : ""}
            ${uploadState.status === "dragging" ? "border-primary bg-primary/5 scale-[1.02]" : ""}
            ${uploadState.status === "uploading" || uploadState.status === "processing" ? "border-primary/50 bg-card" : ""}
            ${uploadState.status === "complete" ? "border-accent bg-accent/5" : ""}
            ${uploadState.status === "error" ? "border-destructive bg-destructive/5" : ""}
          `}
        >
          {/* Idle/Dragging state */}
          {(uploadState.status === "idle" || uploadState.status === "dragging") && (
            <div className="p-12 text-center">
              <div
                className={`
                  w-20 h-20 mx-auto mb-6 rounded-2xl flex items-center justify-center transition-all duration-300
                  ${uploadState.status === "dragging" ? "bg-primary/20 scale-110" : "bg-secondary"}
                `}
              >
                <Upload
                  className={`w-10 h-10 transition-all duration-300 ${
                    uploadState.status === "dragging" ? "text-primary animate-bounce" : "text-muted-foreground"
                  }`}
                />
              </div>

              <h3 className="text-xl font-semibold text-foreground mb-2">
                {uploadState.status === "dragging" ? "Drop your file here" : "Drag & drop your trial balance"}
              </h3>
              <p className="text-muted-foreground mb-6">
                Supports CSV, XLS, and XLSX formats up to 50MB
              </p>

              <div className="flex items-center justify-center gap-4">
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  className="gap-2"
                >
                  Browse Files
                </Button>
                <span className="text-muted-foreground text-sm">or drag a file</span>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={handleFileSelect}
                className="hidden"
              />

              {/* Sample formats */}
              <div className="mt-8 pt-8 border-t border-border">
                <p className="text-sm text-muted-foreground mb-3">Sample trial balance templates:</p>
                <div className="flex items-center justify-center gap-3">
                  {["GAAP Template", "IFRS Template", "Custom Format"].map((template) => (
                    <button
                      key={template}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors"
                    >
                      {template}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Uploading state */}
          {uploadState.status === "uploading" && (
            <div className="p-12">
              <div className="flex items-start gap-4 mb-8">
                <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center flex-shrink-0">
                  <FileSpreadsheet className="w-6 h-6 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg font-semibold text-foreground truncate">
                    {uploadState.fileName}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {uploadState.fileSize && formatFileSize(uploadState.fileSize)}
                  </p>
                </div>
                <button
                  onClick={handleReset}
                  className="p-2 rounded-lg hover:bg-secondary transition-colors"
                >
                  <X className="w-5 h-5 text-muted-foreground" />
                </button>
              </div>

              {/* Progress bar */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-foreground font-medium">Uploading...</span>
                  <span className="text-muted-foreground">{Math.round(uploadState.progress)}%</span>
                </div>
                <div className="h-2 bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-primary to-accent rounded-full transition-all duration-300"
                    style={{ width: `${uploadState.progress}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Processing state */}
          {uploadState.status === "processing" && (
            <div className="p-12">
              <div className="flex items-center gap-4 mb-8">
                <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center animate-pulse">
                  <FileSpreadsheet className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-foreground">Processing with MapNet AI</h3>
                  <p className="text-sm text-muted-foreground">{uploadState.fileName}</p>
                </div>
              </div>

              {/* Processing steps */}
              <div className="space-y-3">
                {processingSteps.map((step, index) => (
                  <div
                    key={step.label}
                    className="flex items-center gap-3 animate-fade-in"
                    style={{ animationDelay: `${step.delay}s` }}
                  >
                    <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center">
                      <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                    </div>
                    <span className="text-sm text-foreground">{step.label}</span>
                    {index < 2 && (
                      <CheckCircle className="w-4 h-4 text-accent ml-auto animate-scale-in" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Complete state */}
          {uploadState.status === "complete" && (
            <div className="p-12 text-center">
              <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-accent/20 flex items-center justify-center animate-scale-in">
                <CheckCircle className="w-10 h-10 text-accent" />
              </div>

              <h3 className="text-xl font-semibold text-foreground mb-2">
                Statements Generated Successfully!
              </h3>
              <p className="text-muted-foreground mb-6">
                Your trial balance has been transformed into audit-ready financial statements.
              </p>

              {/* Generated outputs */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
                {["Balance Sheet", "Income Statement", "Cash Flow", "Notes Package"].map((doc, index) => (
                  <div
                    key={doc}
                    className="p-3 rounded-xl bg-secondary/50 border border-border animate-fade-in"
                    style={{ animationDelay: `${index * 0.1}s` }}
                  >
                    <FileSpreadsheet className="w-5 h-5 text-accent mx-auto mb-2" />
                    <p className="text-xs font-medium text-foreground">{doc}</p>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-center gap-4">
                <Button variant="hero" className="gap-2">
                  View Dashboard
                  <ArrowRight className="w-4 h-4" />
                </Button>
                <Button variant="outline" onClick={handleReset}>
                  Upload Another
                </Button>
              </div>
            </div>
          )}

          {/* Error state */}
          {uploadState.status === "error" && (
            <div className="p-12 text-center">
              <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-destructive/20 flex items-center justify-center">
                <AlertCircle className="w-10 h-10 text-destructive" />
              </div>

              <h3 className="text-xl font-semibold text-foreground mb-2">
                Invalid File Format
              </h3>
              <p className="text-muted-foreground mb-6">
                Please upload a CSV, XLS, or XLSX file containing your trial balance data.
              </p>

              <Button variant="outline" onClick={handleReset}>
                Try Again
              </Button>
            </div>
          )}
        </div>

        {/* Trust indicators */}
        <div className="mt-8 flex items-center justify-center gap-8 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-accent" />
            <span>256-bit encryption</span>
          </div>
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-accent" />
            <span>SOC 2 compliant</span>
          </div>
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-accent" />
            <span>Auto-deleted after 24h</span>
          </div>
        </div>
      </div>
    </section>
  );
};
