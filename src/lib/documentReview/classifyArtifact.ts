/**
 * classifyArtifact — deterministic, framework-independent file-type
 * classification for the statement-review intake surface.
 *
 * Pure. No React, no DOM, no network, no OCR/AI. Operates only on file
 * metadata (name/type/size) plus two optional, caller-supplied structural
 * hints (`workbookHint` for XLSX, `scannedHint` for PDF) that a caller may
 * derive from a lightweight local inspection (e.g. SheetJS header scan, a
 * PDF text-layer probe) before invoking this module — this file itself never
 * parses file contents.
 *
 * This module answers ONE question: "what kind of thing is this file, and
 * does it belong on this intake surface?" It never produces an accounting
 * conclusion and never decides whether a file may be uploaded — that is a
 * server-side authorization concern (see supabase/functions/_shared and the
 * financial-statement-intake Edge Function design).
 */

export type ArtifactClass =
  | "trial_balance"
  | "financial_statements"
  | "mixed_workbook"
  | "scanned_document"
  | "structured_xbrl"
  | "unsupported"
  | "ambiguous";

export type ClassificationConfidence = "high" | "medium" | "low";

/** Which intake surface is asking — determines which corrective route (if any) is suggested on a mismatch. */
export type IntakeContext = "trial-balance-intake" | "statement-review-intake";

export interface WorkbookHint {
  /** Column headers matching debit/credit/balance-style trial-balance columns. */
  hasDebitCreditColumns: boolean;
  /** Long paragraph-like cells, statement/disclosure-style headings (e.g. "Notes to the financial statements"). */
  hasNarrativeText: boolean;
}

export interface ArtifactInput {
  fileName: string;
  /** Browser-reported or server-sniffed MIME type. May be empty/unreliable — extension is the fallback. */
  mimeType: string;
  byteSize: number;
  /** XLSX only: a structural hint from a lightweight local inspection. Absent → workbook is ambiguous by default (never assumed to be a trial balance). */
  workbookHint?: WorkbookHint;
  /** PDF only: true when a caller's own lightweight text-layer probe found no extractable text (image-only pages). Absent/false → assumed to have a text layer. */
  scannedHint?: boolean;
  /** HTML/XHTML only: a sample of the document's text content, used only to detect XBRL markup — never to extract accounting facts. */
  contentSample?: string;
}

export interface RouteSuggestion {
  message: string;
  suggestedRoute: "prepare-data" | "statement-review" | "confirm-workbook-contents";
}

export interface ClassificationResult {
  artifactClass: ArtifactClass;
  confidence: ClassificationConfidence;
  reason: string;
  /** Present only when the detected class does not match what this intake context expects. */
  suggestion?: RouteSuggestion;
}

const XBRL_MARKERS = [
  "xmlns:xbrli",
  "xmlns:ix",
  "<ix:",
  "<xbrli:",
  "http://www.xbrl.org",
];

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

function looksLikeXbrl(contentSample: string | undefined): boolean {
  if (!contentSample) return false;
  return XBRL_MARKERS.some((marker) => contentSample.includes(marker));
}

/** The single source of truth for what a class means on each intake surface. */
function suggestionFor(
  artifactClass: ArtifactClass,
  context: IntakeContext,
): RouteSuggestion | undefined {
  if (context === "trial-balance-intake") {
    if (artifactClass === "financial_statements" || artifactClass === "structured_xbrl") {
      return {
        message: "You selected financial statements. Review them instead.",
        suggestedRoute: "statement-review",
      };
    }
    return undefined;
  }

  // context === "statement-review-intake"
  if (artifactClass === "trial_balance") {
    return {
      message: "This appears to be a trial balance. Open Prepare Data.",
      suggestedRoute: "prepare-data",
    };
  }
  if (artifactClass === "ambiguous") {
    return {
      message: "We could not determine the workbook type. Choose what it contains.",
      suggestedRoute: "confirm-workbook-contents",
    };
  }
  return undefined;
}

/**
 * Classifies a single file by name/type/size and optional structural hints.
 * Deterministic: the same input always produces the same output.
 */
export function classifyArtifact(
  input: ArtifactInput,
  context: IntakeContext,
): ClassificationResult {
  const ext = extensionOf(input.fileName);
  const mime = (input.mimeType || "").toLowerCase();

  const finish = (
    artifactClass: ArtifactClass,
    confidence: ClassificationConfidence,
    reason: string,
  ): ClassificationResult => ({
    artifactClass,
    confidence,
    reason,
    suggestion: suggestionFor(artifactClass, context),
  });

  if (input.byteSize <= 0) {
    return finish("unsupported", "high", "The selected file is empty.");
  }

  // CSV: structurally tabular, never a financial-statement document — this
  // rule is absolute and never overridden by any hint.
  if (ext === "csv" || mime === "text/csv") {
    return finish("trial_balance", "high", "CSV is a plain tabular format used for trial balance import.");
  }

  // PDF
  if (ext === "pdf" || mime === "application/pdf") {
    if (input.scannedHint) {
      return finish(
        "scanned_document",
        "medium",
        "This PDF has no extractable text layer — it appears to be a scan or image export.",
      );
    }
    return finish("financial_statements", "high", "PDF documents route to statement review.");
  }

  // DOCX
  if (
    ext === "docx" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return finish("financial_statements", "high", "DOCX documents route to statement review.");
  }

  // Legacy .doc — supported for intake classification, but flagged lower
  // confidence since binary legacy Word format cannot be signature-verified
  // as reliably as OOXML.
  if (ext === "doc" || mime === "application/msword") {
    return finish("financial_statements", "medium", "Legacy Word document — treated as statement review input.");
  }

  // XHTML / HTML — check for XBRL markers first (structured_xbrl outranks
  // plain financial_statements classification).
  if (ext === "xhtml" || ext === "html" || mime === "application/xhtml+xml" || mime === "text/html") {
    if (looksLikeXbrl(input.contentSample)) {
      return finish("structured_xbrl", "high", "Document contains inline XBRL markers.");
    }
    return finish("financial_statements", "medium", "HTML/XHTML document — treated as statement review input.");
  }

  // XLSX — must be inspected; never assumed to be a trial balance.
  if (
    ext === "xlsx" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    if (!input.workbookHint) {
      return finish(
        "ambiguous",
        "low",
        "Workbook contents were not inspected — the type cannot be determined from the file name alone.",
      );
    }
    const { hasDebitCreditColumns, hasNarrativeText } = input.workbookHint;
    if (hasDebitCreditColumns && hasNarrativeText) {
      return finish(
        "mixed_workbook",
        "medium",
        "Workbook contains both trial-balance-style columns and narrative/disclosure text.",
      );
    }
    if (hasDebitCreditColumns) {
      return finish("trial_balance", "high", "Workbook has debit/credit/balance-style columns.");
    }
    if (hasNarrativeText) {
      return finish("financial_statements", "high", "Workbook contains narrative/disclosure-style content.");
    }
    return finish(
      "ambiguous",
      "low",
      "Workbook contents did not clearly match a trial balance or a statement layout.",
    );
  }

  // Legacy .xls — same treatment as .xlsx, one confidence tier lower.
  if (ext === "xls" || mime === "application/vnd.ms-excel") {
    if (!input.workbookHint) {
      return finish("ambiguous", "low", "Legacy workbook contents were not inspected.");
    }
    const { hasDebitCreditColumns, hasNarrativeText } = input.workbookHint;
    if (hasDebitCreditColumns && hasNarrativeText) {
      return finish("mixed_workbook", "medium", "Legacy workbook mixes trial-balance columns and narrative text.");
    }
    if (hasDebitCreditColumns) {
      return finish("trial_balance", "medium", "Legacy workbook has debit/credit/balance-style columns.");
    }
    if (hasNarrativeText) {
      return finish("financial_statements", "medium", "Legacy workbook contains narrative/disclosure-style content.");
    }
    return finish("ambiguous", "low", "Legacy workbook contents did not clearly match a known layout.");
  }

  return finish(
    "unsupported",
    "high",
    `"${ext || mime || "unknown"}" is not a supported format for this intake surface.`,
  );
}

/** The extensions accepted at the file-picker level for statement-review intake (Phase 5). */
export const STATEMENT_REVIEW_ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".xhtml", ".html"] as const;

export function hasAcceptedExtension(fileName: string): boolean {
  const ext = `.${extensionOf(fileName)}`;
  return (STATEMENT_REVIEW_ACCEPTED_EXTENSIONS as readonly string[]).includes(ext);
}
