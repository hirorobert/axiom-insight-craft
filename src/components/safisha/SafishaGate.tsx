/**
 * SafishaGate.tsx · IRON DOME NUCLEAR DESIGN · Stage 6 v2
 *
 * The hard gate inserted inside the upload flow between TB upload and Trial Balance
 * Validation. Appears immediately after a TB file is successfully processed.
 *
 * Flow inside this component:
 *   STEP 0 — "Upload evidence" (drag-drop bank/momo/subledger files)
 *             → CSV/Excel → calls safisha-ingest
 *             → PDF       → calls safisha-pdf-extract (→ Cloud Run → safisha-ingest)
 *             → if needs_mapping → shows FieldMappingModal → re-calls ingest
 *   STEP 1 — "Matching" (auto) → calls safisha-match → safisha-categorize → safisha-score
 *   STEP 2 — "Review exceptions" → ExceptionQueue (human reviews each item)
 *   STEP 3 — "Gate result" → clean (unlocked) or blocked
 *
 * IRON DOME:
 *   - This component NEVER calls the tax engine directly.
 *   - "Skip" is NOT an option. The only path forward is clean or blocked.
 *   - The parent (TrialBalanceUpload) must not render the "Analyse" / "Run Tax Engine"
 *     button unless safisha_status = 'clean' on this upload.
 *   - A blocked upload shows a permanent red gate — the user must fix the TB and
 *     re-upload to get a new reconciliation.
 *   - PDFs never reach the DB as raw bytes — only extracted canonical rows do.
 *
 * Task #178 — liteparse complexity detection:
 *   Before routing a PDF to safisha-pdf-extract, run a lightweight client-side
 *   heuristic (no WASM, no extra deps) to detect whether the PDF has a usable
 *   text layer or appears to be a scanned image-only PDF.
 *   Scanned PDFs are blocked at the gate with a plain-language explanation.
 *   This prevents the Python worker from returning empty rows silently.
 *
 * Props:
 *   uploadId   — the trial_balance_uploads.id that just completed
 *   fileName   — for display only
 *   onCleared  — called when safisha_status becomes 'clean'
 *   onBlocked  — called when safisha_status becomes 'blocked'
 */

import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button }   from "@/components/ui/button";
import { Badge }    from "@/components/ui/badge";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import {
  Shield, CheckCircle2, XCircle, Upload, Loader2,
  ArrowRight, AlertTriangle, FileCheck,
} from "lucide-react";
import { toast } from "sonner";
import ConfidenceScoreBar from "./ConfidenceScoreBar";
import ExceptionQueue     from "./ExceptionQueue";
import FieldMappingModal  from "./FieldMappingModal";

// ── Task #178: liteparse PDF complexity detector ──────────────────────────────
//
// Pure JS heuristic — no WASM, no extra deps.
// Reads raw PDF bytes and counts PDF text-layer markers:
//   BT...ET (Begin Text / End Text content stream blocks)
//   Tj, TJ, ' operators (text-showing PDF operators)
//
// A PDF with fewer than TEXT_OPERATOR_MIN text operators is almost certainly
// a scanned image embedded in a PDF container — pdfplumber will return no rows.
//
// This runs entirely in the browser before any network call. ~5ms on a 2MB PDF.

const TEXT_OPERATOR_MIN = 20; // text operator occurrences required for text-layer

async function detectPdfTextLayer(
  file: File
): Promise<{ hasTextLayer: boolean; operatorCount: number }> {
  try {
    // Read first 512 KB — text-layer markers appear early in the content streams
    const slice     = file.slice(0, Math.min(file.size, 512 * 1024));
    const buffer    = await slice.arrayBuffer();
    const bytes     = new Uint8Array(buffer);

    // Decode as Latin-1 (PDF streams use 8-bit chars)
    let raw = "";
    for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);

    // Count text-showing operators: Tj, TJ, ' (apostrophe operator), "
    // Also check for BT blocks (Begin Text)
    const tjCount  = (raw.match(/\bTj\b/g) ?? []).length;
    const TJCount  = (raw.match(/\bTJ\b/g) ?? []).length;
    const btCount  = (raw.match(/\bBT\b/g) ?? []).length;
    const apoCount = (raw.match(/ ' /g) ?? []).length;

    const operatorCount = tjCount + TJCount + btCount + apoCount;

    return {
      hasTextLayer: operatorCount >= TEXT_OPERATOR_MIN,
      operatorCount,
    };
  } catch {
    // If detection fails (e.g., huge PDF), pass through optimistically
    return { hasTextLayer: true, operatorCount: -1 };
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

type GateStep =
  | "upload_evidence"  // Step 0 — drop evidence files
  | "running_match"    // Step 1 — auto-running the pipeline
  | "review"           // Step 2 — exception queue
  | "clean"            // Step 3a — passed
  | "blocked";         // Step 3b — blocked

interface EvidenceFile {
  file:       File;
  sourceType: "bank" | "momo" | "subledger";
  isPdf:      boolean;
  status:     "queued" | "uploading" | "done" | "error";
  error?:     string;
  pdfMeta?:   { pages_parsed: number; rows_extracted: number; warnings: string[] };
}

interface MatchResult {
  reconciliation_id: string;
  matched_count:     number;
  exception_count:   number;
  total_tb_lines:    number;
  confidence_score:  number | null;
  status:            string;
}

interface MappingNeeded {
  reconciliation_id: string;
  detected_headers:  string[];
  source_type:       string;
  file:              File;
}

interface Props {
  uploadId:   string;
  fileName:   string;
  onCleared?: () => void;
  onBlocked?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SafishaGate({ uploadId, fileName, onCleared, onBlocked }: Props) {
  const [step,            setStep]            = useState<GateStep>("upload_evidence");
  const [evidenceFiles,   setEvidenceFiles]   = useState<EvidenceFile[]>([]);
  const [isDragging,      setIsDragging]      = useState(false);
  const [matchResult,     setMatchResult]     = useState<MatchResult | null>(null);
  const [pipelineError,   setPipelineError]   = useState<string | null>(null);
  const [mappingNeeded,   setMappingNeeded]   = useState<MappingNeeded | null>(null);

  // ── Evidence drag-drop ─────────────────────────────────────────────────────

  const addEvidenceFiles = useCallback((fileList: FileList) => {
    const toAdd: EvidenceFile[] = [];
    Array.from(fileList).forEach(f => {
      const lower = f.name.toLowerCase();
      const isCSV  = lower.endsWith(".csv");
      const isXLSX = lower.endsWith(".xlsx") || lower.endsWith(".xls");
      const isPdf  = lower.endsWith(".pdf");
      if (!isCSV && !isXLSX && !isPdf) {
        toast.error(`${f.name}: only CSV, Excel, or PDF files are supported`);
        return;
      }
      const sourceType: "bank" | "momo" | "subledger" =
        lower.includes("momo") || lower.includes("mobile") ? "momo"
        : lower.includes("subledger") || lower.includes("ledger") ? "subledger"
        : "bank";
      toAdd.push({ file: f, sourceType, isPdf, status: "queued" });
    });
    if (toAdd.length > 0) setEvidenceFiles(prev => [...prev, ...toAdd]);
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    addEvidenceFiles(e.dataTransfer.files);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addEvidenceFiles(e.target.files);
    e.target.value = "";
  };

  // ── Ingest one file (CSV/Excel path) ──────────────────────────────────────

  const ingestFile = async (
    ev: EvidenceFile,
    session: { access_token: string },
    mappingOverride?: Record<string, string>
  ): Promise<
    { reconId: string } |
    { needsMapping: MappingNeeded } |
    { error: string }
  > => {
    // PDF takes a different route — caller should use ingestPdf() instead
    if (ev.isPdf) return ingestPdf(ev, session);

    const form = new FormData();
    form.append("upload_id",   uploadId);
    form.append("source_type", ev.sourceType);
    form.append("file",        ev.file);
    if (mappingOverride) form.append("mapping_override", JSON.stringify(mappingOverride));

    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/safisha-ingest`,
      {
        method:  "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
        body:    form,
      }
    );
    const result = await res.json();

    if (result.needs_mapping) {
      return {
        needsMapping: {
          reconciliation_id: result.reconciliation_id,
          detected_headers:  result.detected_headers,
          source_type:       result.source_type,
          file:              ev.file,
        },
      };
    }
    if (!res.ok || result.error) return { error: result.error ?? "Ingest failed" };
    return { reconId: result.reconciliation_id };
  };

  // ── Ingest one PDF file (routes through safisha-pdf-extract) ──────────────

  const ingestPdf = async (
    ev: EvidenceFile,
    session: { access_token: string }
  ): Promise<{ reconId: string } | { error: string }> => {
    // Task #178: liteparse complexity check — block scanned PDFs before upload
    const { hasTextLayer, operatorCount } = await detectPdfTextLayer(ev.file);
    if (!hasTextLayer) {
      const detail = operatorCount >= 0
        ? `Only ${operatorCount} text operators found (minimum ${TEXT_OPERATOR_MIN} required).`
        : "";
      return {
        error:
          `"${ev.file.name}" appears to be a scanned PDF with no text layer. ` +
          `${detail} ` +
          `Please export a digital (text-layer) PDF from your banking system, ` +
          `or convert to CSV/Excel instead. ` +
          `Scanned PDFs require OCR and are not supported in this version.`,
      };
    }

    const form = new FormData();
    form.append("upload_id",   uploadId);
    form.append("source_type", ev.sourceType);
    form.append("file",        ev.file);
    // No FieldMappingModal for PDFs — the Python worker normalises columns

    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/safisha-pdf-extract`,
      {
        method:  "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
        body:    form,
      }
    );
    const result = await res.json();

    if (!res.ok || result.error) {
      const detail = result.worker_error ?? result.error ?? "PDF extraction failed";
      return { error: detail };
    }

    // Attach PDF metadata to the file entry for display
    if (result.pdf_metadata) {
      setEvidenceFiles(prev => prev.map(f =>
        f.file === ev.file ? { ...f, pdfMeta: result.pdf_metadata } : f
      ));
      // Surface any warnings as toasts
      (result.pdf_metadata.warnings ?? []).forEach((w: string) => toast.warning(w));
    }

    return { reconId: result.reconciliation_id };
  };

  // ── Run full pipeline ──────────────────────────────────────────────────────

  const callJson = async (
    fn: string,
    body: object,
    token: string
  ): Promise<any> => {
    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${fn}`,
      {
        method:  "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      }
    );
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error ?? `${fn} failed`);
    return data;
  };

  const runPipeline = async (reconId: string) => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session!.access_token;

    // Match → Categorize → Score (sequential — each depends on prior)
    const matchData = await callJson("safisha-match",      { reconciliation_id: reconId }, token);
    await              callJson("safisha-categorize", { reconciliation_id: reconId }, token);
    const scoreData = await callJson("safisha-score",      { reconciliation_id: reconId }, token);

    // If zero exceptions → auto-clean
    if (matchData.exception_count === 0) {
      setMatchResult({
        reconciliation_id: reconId,
        matched_count:     matchData.matched_count,
        exception_count:   0,
        total_tb_lines:    matchData.total_tb_lines,
        confidence_score:  100,
        status:            "clean",
      });
      setStep("clean");
      onCleared?.();
      return;
    }

    setMatchResult({
      reconciliation_id: reconId,
      matched_count:     matchData.matched_count,
      exception_count:   matchData.exception_count,
      total_tb_lines:    matchData.total_tb_lines,
      confidence_score:  scoreData.confidence_score ?? null,
      status:            matchData.status,
    });
    setStep("review");
  };

  // ── Start ingestion + pipeline ─────────────────────────────────────────────

  const startIngest = async () => {
    if (evidenceFiles.length === 0) {
      toast.error("Add at least one bank statement, MoMo export, or subledger file");
      return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { toast.error("Session expired — please sign in again"); return; }

    setStep("running_match");
    setPipelineError(null);

    let reconId: string | null = null;

    // Ingest each evidence file sequentially (so they share the same reconciliation)
    for (let i = 0; i < evidenceFiles.length; i++) {
      const ev = evidenceFiles[i];
      setEvidenceFiles(prev => prev.map((f, idx) => idx === i ? { ...f, status: "uploading" } : f));

      const result = await ingestFile(ev, session);

      if ("needsMapping" in result) {
        // Pause pipeline, show FieldMappingModal, resume after user maps
        setMappingNeeded(result.needsMapping);
        setStep("upload_evidence"); // bring user back to upload step with modal open
        setEvidenceFiles(prev => prev.map((f, idx) => idx === i ? { ...f, status: "queued" } : f));
        return; // will resume from handleMappingComplete
      }

      if ("error" in result) {
        setEvidenceFiles(prev => prev.map((f, idx) => idx === i ? { ...f, status: "error", error: result.error } : f));
        setPipelineError(`Failed to ingest ${ev.file.name}: ${result.error}`);
        setStep("upload_evidence");
        return;
      }

      reconId = reconId ?? result.reconId;
      setEvidenceFiles(prev => prev.map((f, idx) => idx === i ? { ...f, status: "done" } : f));
    }

    if (!reconId) { setPipelineError("No reconciliation ID returned from ingest"); setStep("upload_evidence"); return; }

    // Run match → categorize → score
    try {
      await runPipeline(reconId);
    } catch (err: any) {
      setPipelineError(err.message);
      setStep("upload_evidence");
    }
  };

  // Called by FieldMappingModal after user saves mapping and ingest completes
  const handleMappingComplete = async (reconId: string) => {
    setMappingNeeded(null);
    setStep("running_match");
    try {
      await runPipeline(reconId);
    } catch (err: any) {
      setPipelineError(err.message);
      setStep("upload_evidence");
    }
  };

  // Called by ExceptionQueue when all exceptions are resolved
  const handleAllResolved = async () => {
    if (!matchResult) return;
    // Re-fetch reconciliation status to confirm
    const { data } = await supabase
      .from("safisha_reconciliations")
      .select("status,confidence_score")
      .eq("id", matchResult.reconciliation_id)
      .single();

    const finalStatus = data?.status ?? "needs_review";
    if (finalStatus === "clean") {
      setMatchResult(prev => prev ? { ...prev, confidence_score: data?.confidence_score ?? prev.confidence_score, status: "clean" } : prev);
      setStep("clean");
      onCleared?.();
    } else if (finalStatus === "blocked") {
      setMatchResult(prev => prev ? { ...prev, status: "blocked" } : prev);
      setStep("blocked");
      onBlocked?.();
    }
  };

  // ── Render helpers ─────────────────────────────────────────────────────────

  const stepIndicator = (
    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-4">
      {[
        { key: "upload_evidence", label: "Evidence" },
        { key: "running_match",   label: "Matching"  },
        { key: "review",          label: "Review"    },
        { key: "clean",           label: "Result"    },
        { key: "blocked",         label: "Result"    },
      ].filter((s, i, arr) => arr.findIndex(x => x.label === s.label) === i).map((s, i, arr) => (
        <div key={s.key} className="flex items-center gap-1">
          <div className={`h-1.5 w-8 rounded-full transition-colors ${
            step === s.key || (s.key === "clean" && step === "blocked")
              ? "bg-[#0E6B55]"
              : i < arr.findIndex(x => x.label === (
                  step === "clean" || step === "blocked" ? "Result"
                  : step === "review"          ? "Review"
                  : step === "running_match"   ? "Matching"
                  : "Evidence"
                ))
                ? "bg-[#0E6B55]/50"
                : "bg-muted"
          }`} />
          <span className={step === s.key ? "text-[#0E6B55] font-medium" : ""}>{s.label}</span>
        </div>
      ))}
    </div>
  );

  // ── Step 0: Upload evidence ────────────────────────────────────────────────

  if (step === "upload_evidence") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-[#0E6B55]" />
          <div>
            <h3 className="text-sm font-semibold text-[#0E1D30]">Safisha TB Verification</h3>
            <p className="text-xs text-muted-foreground">
              Upload evidence for <span className="font-mono">{fileName}</span> before running the tax engine.
            </p>
          </div>
        </div>

        {stepIndicator}

        {pipelineError && (
          <div className="p-3 rounded bg-red-50 border border-red-200 text-red-800 text-xs flex items-start gap-2">
            <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {pipelineError}
          </div>
        )}

        {/* Drop zone */}
        <div
          className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${
            isDragging ? "border-[#0E6B55] bg-[#0E6B55]/5" : "border-muted hover:border-[#0E6B55]/50"
          }`}
          onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => document.getElementById("safisha-file-input")?.click()}
        >
          <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm font-medium text-[#0E1D30]">Drop bank statements, MoMo exports, or subledgers here</p>
          <p className="text-xs text-muted-foreground mt-1">CSV · Excel · PDF (digital text-layer) · Multiple files allowed</p>
          <input
            id="safisha-file-input"
            type="file"
            className="hidden"
            multiple
            accept=".csv,.xlsx,.xls,.pdf"
            onChange={handleFileSelect}
          />
        </div>

        {/* File list */}
        {evidenceFiles.length > 0 && (
          <div className="space-y-1.5">
            {evidenceFiles.map((ev, i) => (
              <div key={i} className="flex items-center gap-2 p-2 rounded bg-muted/50 text-xs">
                <FileCheck className="h-4 w-4 text-[#0E6B55] shrink-0" />
                <span className="flex-1 font-mono truncate">{ev.file.name}</span>
                {ev.isPdf && (
                  <Badge className="text-[10px] shrink-0 bg-violet-100 text-violet-700 border-violet-200">
                    PDF
                  </Badge>
                )}
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {ev.sourceType}
                </Badge>
                {ev.pdfMeta && (
                  <span className="text-muted-foreground shrink-0">
                    {ev.pdfMeta.pages_parsed}p · {ev.pdfMeta.rows_extracted} rows
                  </span>
                )}
                {ev.status === "error" && (
                  <span className="text-red-500 shrink-0 truncate max-w-[120px]" title={ev.error}>
                    {ev.error}
                  </span>
                )}
                <button
                  className="text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => setEvidenceFiles(prev => prev.filter((_, idx) => idx !== i))}
                >×</button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button
            className="flex-1 bg-[#0E6B55] hover:bg-[#0E6B55]/90"
            onClick={startIngest}
            disabled={evidenceFiles.length === 0}
          >
            Verify TB against evidence
            <ArrowRight className="h-4 w-4 ml-1.5" />
          </Button>
        </div>

        <p className="text-[10px] text-muted-foreground text-center">
          Iron Dome: the tax engine is locked until Safisha clears this TB.
        </p>

        {/* FieldMappingModal shown as overlay when column mapping needed */}
        {mappingNeeded && (
          <FieldMappingModal
            open
            detectedHeaders={mappingNeeded.detected_headers}
            sourceType={mappingNeeded.source_type}
            reconciliationId={mappingNeeded.reconciliation_id}
            fileToIngest={mappingNeeded.file}
            uploadId={uploadId}
            onComplete={(reconId, _rows) => handleMappingComplete(reconId)}
            onCancel={() => setMappingNeeded(null)}
          />
        )}
      </div>
    );
  }

  // ── Step 1: Running pipeline ───────────────────────────────────────────────

  if (step === "running_match") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-[#0E6B55]" />
          <h3 className="text-sm font-semibold text-[#0E1D30]">Safisha TB Verification</h3>
        </div>
        {stepIndicator}
        <div className="py-8 flex flex-col items-center gap-3 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-[#0E6B55]" />
          <p className="text-sm font-medium text-[#0E1D30]">Running matching engine…</p>
          <p className="text-xs text-muted-foreground">
            Comparing TB lines against evidence · This takes a few seconds
          </p>
        </div>
      </div>
    );
  }

  // ── Step 2: Exception review ───────────────────────────────────────────────

  if (step === "review" && matchResult) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-amber-500" />
            <h3 className="text-sm font-semibold text-[#0E1D30]">Safisha TB Verification</h3>
          </div>
          <div className="w-36">
            <ConfidenceScoreBar score={matchResult.confidence_score ?? 0} size="sm" />
          </div>
        </div>

        {stepIndicator}

        <div className="flex gap-3 text-xs text-muted-foreground">
          <span>{matchResult.matched_count}/{matchResult.total_tb_lines} matched</span>
          <span>·</span>
          <span>{matchResult.exception_count} exception(s)</span>
        </div>

        <ExceptionQueue
          reconciliationId={matchResult.reconciliation_id}
          confidenceScore={matchResult.confidence_score}
          onAllResolved={handleAllResolved}
        />
      </div>
    );
  }

  // ── Step 3a: Clean ─────────────────────────────────────────────────────────

  if (step === "clean") {
    return (
      <Card className="border-[#0E6B55]/40 bg-[#0E6B55]/5">
        <CardContent className="py-8 text-center space-y-3">
          <CheckCircle2 className="h-10 w-10 text-[#0E6B55] mx-auto" />
          <div>
            <p className="font-semibold text-[#0E6B55]">TB verified — gate cleared</p>
            <p className="text-xs text-muted-foreground mt-1">
              {matchResult?.matched_count ?? "All"} TB lines reconciled to evidence.
              The tax engine is now unlocked for <span className="font-mono">{fileName}</span>.
            </p>
          </div>
          {matchResult?.confidence_score !== null && (
            <div className="mx-auto w-40">
              <ConfidenceScoreBar score={matchResult?.confidence_score ?? 100} />
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // ── Step 3b: Blocked ───────────────────────────────────────────────────────

  if (step === "blocked") {
    return (
      <Card className="border-red-300 bg-red-50">
        <CardContent className="py-8 text-center space-y-3">
          <XCircle className="h-10 w-10 text-red-500 mx-auto" />
          <div>
            <p className="font-semibold text-red-700">Reconciliation blocked</p>
            <p className="text-xs text-red-600 mt-1">
              One or more 'investigate' exceptions were rejected. The tax engine is blocked
              for <span className="font-mono">{fileName}</span> until the underlying discrepancies
              are corrected and a fresh TB is re-uploaded.
            </p>
          </div>
          <div className="flex items-center justify-center gap-1.5 text-xs text-red-500">
            <AlertTriangle className="h-3.5 w-3.5" />
            Re-upload a corrected trial balance to start a new reconciliation.
          </div>
        </CardContent>
      </Card>
    );
  }

  return null;
}
