/**
 * StatementReviewWorkspace — document-driven statement review intake.
 *
 * A fundamentally different job from StatementsWorkspace (which prepares
 * statements FROM a trial balance). This screen accepts financial
 * statements that already exist as documents (PDF/DOCX/XLSX/iXBRL) and
 * checks them for internal consistency, framework coverage, presentation
 * quality and audit readiness. It never routes through the trial-balance
 * upload path and never writes to trial balance, account mappings, or any
 * prepared-statement table.
 *
 * Honest-capability discipline (North-Star Phase 11, hardened by the
 * document-review-acceptance-repair pass Phase 2): extraction and
 * validation do not exist yet. While DOCUMENT_REVIEW_ENABLED is false, this
 * screen never presents a working "Start review" CTA — direct/shared-link
 * access to this route shows only an honest "not available yet" notice.
 * Once real intake is enabled, the screen still never fabricates a finding
 * or claims a document was assessed before the server says so.
 *
 * Supporting-trial-balance upload was removed in the acceptance-repair pass
 * (Phase 3): the prior slice accepted a second file, read it server-side,
 * and then silently discarded it — never validated, stored, linked, or
 * processed. Silently discarding an uploaded financial file is prohibited.
 * The feature will return only once it is fully wired end to end.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  FileText,
  FileSpreadsheet,
  Upload,
  X,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ArrowRight,
  Clock,
} from "lucide-react";
import {
  classifyArtifact,
  hasAcceptedExtension,
  STATEMENT_REVIEW_ACCEPTED_EXTENSIONS,
  type ArtifactInput,
  type ClassificationResult,
} from "@/lib/documentReview/classifyArtifact";
import { DOCUMENT_REVIEW_ENABLED } from "@/lib/product/outcomes";

type ReviewStatus =
  | "SELECTED"
  | "UPLOADING"
  | "STORED"
  | "CLASSIFYING"
  | "EXTRACTING"
  | "READY_FOR_REVIEW"
  | "UPLOAD_FAILED"
  | "CLASSIFICATION_FAILED"
  | "EXTRACTION_FAILED"
  | "QUARANTINED";

const ACCEPT_ATTRIBUTE = STATEMENT_REVIEW_ACCEPTED_EXTENSIONS.join(",");
const MAX_BYTES = 50 * 1024 * 1024; // 50MB ceiling — mirrored by the server's own hard cap.

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(fileName: string) {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "xlsx" || ext === "xls") return FileSpreadsheet;
  return FileText;
}

interface SelectedFile {
  file: File;
  classification: ClassificationResult;
}

/** Rendered for every visitor while DOCUMENT_REVIEW_ENABLED is false — no file picker, no CTA. */
function NotYetAvailable() {
  return (
    <div className="max-w-2xl">
      <div className="border border-border p-6">
        <div className="flex items-start gap-3">
          <Clock className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-foreground">Statement review is not available yet</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Document-based statement review is still being built. No file intake, extraction,
              or review is available on this screen today — nothing here has been assessed, and
              nothing can be uploaded yet.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function StatementReviewWorkspace() {
  const { companyId, periodYear } = useWorkspace();
  const primaryInputRef = useRef<HTMLInputElement>(null);

  const [primary, setPrimary] = useState<SelectedFile | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  // User's own answer when classifyArtifact could not determine the
  // workbook type ("ambiguous"). Never inferred — only ever set by an
  // explicit click on one of the two confirmation buttons.
  const [confirmedAmbiguousAs, setConfirmedAmbiguousAs] = useState<"financial_statements" | "trial_balance" | null>(null);
  const [status, setStatus] = useState<ReviewStatus | "IDLE">("IDLE");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [resuming, setResuming] = useState(true);

  // ── Reload recovery ─────────────────────────────────────────────────────
  // If a document already exists for this company/period, resume showing
  // its persisted state rather than re-asking the upload question. Fails
  // open to the empty intake state on any error (including, today, the
  // expected "relation does not exist" error while the schema in Phase 7's
  // migration remains unapplied) — never crashes the page.
  useEffect(() => {
    let cancelled = false;
    async function resume() {
      if (!DOCUMENT_REVIEW_ENABLED || !companyId || !periodYear) {
        setResuming(false);
        return;
      }
      try {
        const { data, error } = await supabase
          .from("financial_statement_documents" as never)
          .select("id, status, original_file_name")
          .eq("company_id", companyId)
          .eq("period_year", periodYear)
          .is("superseded_at", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (cancelled) return;
        if (!error && data) {
          const row = data as unknown as { id: string; status: ReviewStatus; original_file_name: string };
          setDocumentId(row.id);
          setStatus(row.status);
          setStatusDetail(row.original_file_name);
        }
      } catch {
        // Table not yet provisioned, or network error — resume silently to
        // the empty intake state. Never surfaces a crash for this.
      } finally {
        if (!cancelled) setResuming(false);
      }
    }
    resume();
    return () => {
      cancelled = true;
    };
  }, [companyId, periodYear]);

  const classifySelection = useCallback((f: File): ClassificationResult => {
    const input: ArtifactInput = {
      fileName: f.name,
      mimeType: f.type,
      byteSize: f.size,
    };
    return classifyArtifact(input, "statement-review-intake");
  }, []);

  const handlePrimarySelect = useCallback(
    (fileList: FileList | null) => {
      setPickerError(null);
      const f = fileList?.[0];
      if (!f) return;
      if (f.size <= 0) {
        setPickerError("That file is empty and can't be reviewed.");
        return;
      }
      if (f.size > MAX_BYTES) {
        setPickerError(`That file is ${formatBytes(f.size)}, above the ${formatBytes(MAX_BYTES)} limit.`);
        return;
      }
      if (!hasAcceptedExtension(f.name)) {
        setPickerError(
          `"${f.name}" is not a supported format. Choose a PDF, DOCX, XLSX, XHTML or HTML file.`,
        );
        return;
      }
      const classification = classifySelection(f);
      if (classification.artifactClass === "unsupported") {
        setPickerError(classification.reason);
        return;
      }
      setPrimary({ file: f, classification });
      setStatus("SELECTED");
    },
    [classifySelection],
  );

  const removePrimary = () => {
    setPrimary(null);
    setPickerError(null);
    setConfirmedAmbiguousAs(null);
    setStatus("IDLE");
    if (primaryInputRef.current) primaryInputRef.current.value = "";
  };

  // Effective classification after an explicit user confirmation on an
  // ambiguous workbook. The original (unconfirmed) classification is never
  // discarded — it is still sent to the server as the client hint, which
  // the server independently re-verifies and never treats as authoritative.
  const effectiveSuggestion =
    primary && primary.classification.artifactClass === "ambiguous" && confirmedAmbiguousAs
      ? undefined
      : primary?.classification.suggestion;
  const isAwaitingAmbiguousConfirmation =
    primary?.classification.artifactClass === "ambiguous" && !confirmedAmbiguousAs;

  const startReview = async () => {
    // Synchronous double-submit guard — disabled={} alone does not prevent a
    // second click/Enter from reaching this handler before React commits
    // the disabled-button render (same pattern as Auth.tsx's handleSubmit).
    if (status === "UPLOADING") return;
    if (!primary || !companyId || !periodYear) return;
    setStatus("UPLOADING");
    setStatusDetail(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Your session has expired. Sign in again to continue.");

      const form = new FormData();
      form.append("companyId", companyId);
      form.append("periodYear", String(periodYear));
      form.append("artifactClassHint", confirmedAmbiguousAs ?? primary.classification.artifactClass);
      form.append("file", primary.file);

      const { data, error } = await supabase.functions.invoke("financial-statement-intake", {
        body: form,
      });

      if (error) throw error;
      const result = data as { documentId: string; status: ReviewStatus };
      setDocumentId(result.documentId);
      setStatus(result.status);
      toast.success("Document received.");
    } catch (err) {
      setStatus("UPLOAD_FAILED");
      setStatusDetail(
        err instanceof Error
          ? err.message
          : "We couldn't reach the review service. Try again, or contact support if this continues.",
      );
    }
  };

  const Icon = primary ? iconFor(primary.file.name) : Upload;

  if (!DOCUMENT_REVIEW_ENABLED) {
    return <NotYetAvailable />;
  }

  if (resuming) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground max-w-2xl">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading review status…
      </div>
    );
  }

  // ── A document already exists for this period: show its persisted state ──
  if (documentId && status !== "IDLE" && status !== "SELECTED" && status !== "UPLOADING" && status !== "UPLOAD_FAILED") {
    return (
      <div className="max-w-2xl space-y-6">
        <div className="border border-border p-6">
          <p className="text-[11px] font-mono uppercase tracking-wide text-muted-foreground/70">
            Statement review
          </p>
          <p className="mt-2 text-sm font-semibold text-foreground">{statusDetail ?? "Document received"}</p>
          <div className="mt-4 flex items-start gap-3 border border-border bg-muted/30 p-4">
            <CheckCircle2 className="w-4 h-4 text-success mt-0.5 shrink-0" />
            <p className="text-sm leading-6 text-muted-foreground">
              Document received — automated review is not available for this format yet.
              We never manufacture findings or claim a document has been assessed before that
              pipeline is connected.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <p className="text-[11px] font-mono uppercase tracking-wide text-muted-foreground/70">
          Statement review
        </p>
        <h1 className="mt-2 text-xl font-semibold text-foreground">
          Upload the financial statements you want reviewed
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Draft or issued statements — checked for internal consistency, framework coverage,
          presentation quality and audit readiness.
        </p>
      </div>

      {!primary ? (
        <div className="border border-dashed border-border p-10 text-center">
          <Upload className="w-6 h-6 mx-auto text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">PDF, DOCX, XLSX, XHTML or HTML</p>
          <input
            ref={primaryInputRef}
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            className="sr-only"
            onChange={(e) => handlePrimarySelect(e.target.files)}
            id="statement-review-primary-input"
          />
          <Button
            variant="hero"
            size="lg"
            className="mt-5"
            onClick={() => primaryInputRef.current?.click()}
          >
            Choose statements
          </Button>
          {pickerError && (
            <p role="alert" className="mt-4 flex items-center justify-center gap-2 text-sm text-destructive">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {pickerError}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="border border-border p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0">
                <Icon className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{primary.file.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {primary.file.name.split(".").pop()?.toUpperCase()} · {formatBytes(primary.file.size)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={removePrimary}
                aria-label="Remove selected file"
                className="shrink-0 p-1 text-muted-foreground hover:text-foreground min-h-[44px] min-w-[44px] flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isAwaitingAmbiguousConfirmation ? (
              <div className="mt-4 space-y-3 border border-border bg-muted/30 p-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                  <p className="text-xs leading-5 text-muted-foreground">
                    {primary.classification.reason} Choose what it contains.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => setConfirmedAmbiguousAs("financial_statements")}>
                    It's a financial statement
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmedAmbiguousAs("trial_balance")}>
                    It's a trial balance
                  </Button>
                </div>
              </div>
            ) : confirmedAmbiguousAs === "trial_balance" ? (
              <div className="mt-4 flex items-start gap-2 border border-border bg-muted/30 p-3">
                <AlertCircle className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                <p className="text-xs leading-5 text-muted-foreground">
                  This appears to be a trial balance. Open Prepare Data.
                </p>
              </div>
            ) : effectiveSuggestion ? (
              <div className="mt-4 flex items-start gap-2 border border-border bg-muted/30 p-3">
                <AlertCircle className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                <p className="text-xs leading-5 text-muted-foreground">{effectiveSuggestion.message}</p>
              </div>
            ) : (
              <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
                Recognized as {(confirmedAmbiguousAs ?? primary.classification.artifactClass).replace(/_/g, " ")}
              </div>
            )}
          </div>

          {status === "UPLOAD_FAILED" && statusDetail && (
            <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {statusDetail}
            </p>
          )}

          <Button
            variant="hero"
            size="lg"
            className="w-full sm:w-auto gap-2"
            disabled={
              status === "UPLOADING" ||
              isAwaitingAmbiguousConfirmation ||
              confirmedAmbiguousAs === "trial_balance" ||
              (!confirmedAmbiguousAs && !!primary.classification.suggestion)
            }
            onClick={startReview}
          >
            {status === "UPLOADING" ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Uploading…
              </>
            ) : (
              <>
                Start review
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
