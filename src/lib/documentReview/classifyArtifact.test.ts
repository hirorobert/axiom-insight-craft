import { describe, expect, it } from "vitest";
import {
  classifyArtifact,
  hasAcceptedExtension,
  STATEMENT_REVIEW_ACCEPTED_EXTENSIONS,
  type ArtifactInput,
} from "./classifyArtifact";

function file(overrides: Partial<ArtifactInput>): ArtifactInput {
  return {
    fileName: "file.bin",
    mimeType: "",
    byteSize: 1024,
    ...overrides,
  };
}

describe("classifyArtifact — CSV is never accepted as financial statements", () => {
  it("classifies a .csv extension as trial_balance regardless of intake context", () => {
    const byExt = classifyArtifact(file({ fileName: "tb.csv", mimeType: "" }), "trial-balance-intake");
    expect(byExt.artifactClass).toBe("trial_balance");
    const inReviewContext = classifyArtifact(file({ fileName: "tb.csv" }), "statement-review-intake");
    expect(inReviewContext.artifactClass).toBe("trial_balance");
    expect(inReviewContext.artifactClass).not.toBe("financial_statements");
  });

  it("classifies text/csv mime type as trial_balance even with a misleading file name", () => {
    const result = classifyArtifact(
      file({ fileName: "statements.txt", mimeType: "text/csv" }),
      "statement-review-intake",
    );
    expect(result.artifactClass).toBe("trial_balance");
  });

  it("never produces financial_statements for CSV under any workbookHint/scannedHint combination", () => {
    const result = classifyArtifact(
      file({
        fileName: "data.csv",
        workbookHint: { hasDebitCreditColumns: false, hasNarrativeText: true },
        scannedHint: true,
      }),
      "statement-review-intake",
    );
    expect(result.artifactClass).toBe("trial_balance");
  });
});

describe("classifyArtifact — PDF/DOCX route to statement review", () => {
  it("classifies .pdf as financial_statements by default", () => {
    const result = classifyArtifact(file({ fileName: "annual-report.pdf", mimeType: "application/pdf" }), "statement-review-intake");
    expect(result.artifactClass).toBe("financial_statements");
    expect(result.confidence).toBe("high");
  });

  it("classifies a scanned (no text layer) PDF as scanned_document, not financial_statements", () => {
    const result = classifyArtifact(
      file({ fileName: "scan.pdf", mimeType: "application/pdf", scannedHint: true }),
      "statement-review-intake",
    );
    expect(result.artifactClass).toBe("scanned_document");
  });

  it("classifies .docx as financial_statements", () => {
    const result = classifyArtifact(
      file({
        fileName: "FS-2025.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      "statement-review-intake",
    );
    expect(result.artifactClass).toBe("financial_statements");
  });

  it("classifies legacy .doc as financial_statements at medium confidence", () => {
    const result = classifyArtifact(file({ fileName: "old.doc", mimeType: "application/msword" }), "statement-review-intake");
    expect(result.artifactClass).toBe("financial_statements");
    expect(result.confidence).toBe("medium");
  });
});

describe("classifyArtifact — XHTML/HTML with XBRL markers routes to structured_xbrl", () => {
  it("detects xmlns:ix as an XBRL marker", () => {
    const result = classifyArtifact(
      file({
        fileName: "instance.xhtml",
        mimeType: "application/xhtml+xml",
        contentSample: '<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL">',
      }),
      "statement-review-intake",
    );
    expect(result.artifactClass).toBe("structured_xbrl");
  });

  it("detects <xbrli: as an XBRL marker in a .html file", () => {
    const result = classifyArtifact(
      file({ fileName: "report.html", mimeType: "text/html", contentSample: "<xbrli:xbrl>...</xbrli:xbrl>" }),
      "statement-review-intake",
    );
    expect(result.artifactClass).toBe("structured_xbrl");
  });

  it("plain HTML with no XBRL markers classifies as financial_statements, not structured_xbrl", () => {
    const result = classifyArtifact(
      file({ fileName: "report.html", mimeType: "text/html", contentSample: "<html><body>Statement of Financial Position</body></html>" }),
      "statement-review-intake",
    );
    expect(result.artifactClass).toBe("financial_statements");
  });

  it("XHTML with no content sample provided defaults to financial_statements, not structured_xbrl (never guesses XBRL)", () => {
    const result = classifyArtifact(file({ fileName: "page.xhtml", mimeType: "application/xhtml+xml" }), "statement-review-intake");
    expect(result.artifactClass).toBe("financial_statements");
  });
});

describe("classifyArtifact — XLSX must be inspected; never assumed to be a trial balance", () => {
  it("XLSX with no workbookHint is ambiguous, not trial_balance", () => {
    const result = classifyArtifact(file({ fileName: "workbook.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "statement-review-intake");
    expect(result.artifactClass).toBe("ambiguous");
    expect(result.confidence).toBe("low");
  });

  it("XLSX with debit/credit columns and no narrative text classifies as trial_balance", () => {
    const result = classifyArtifact(
      file({
        fileName: "workbook.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        workbookHint: { hasDebitCreditColumns: true, hasNarrativeText: false },
      }),
      "trial-balance-intake",
    );
    expect(result.artifactClass).toBe("trial_balance");
    expect(result.confidence).toBe("high");
  });

  it("XLSX with narrative text and no debit/credit columns classifies as financial_statements", () => {
    const result = classifyArtifact(
      file({
        fileName: "workbook.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        workbookHint: { hasDebitCreditColumns: false, hasNarrativeText: true },
      }),
      "statement-review-intake",
    );
    expect(result.artifactClass).toBe("financial_statements");
  });

  it("XLSX with both debit/credit columns and narrative text classifies as mixed_workbook", () => {
    const result = classifyArtifact(
      file({
        fileName: "workpaper.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        workbookHint: { hasDebitCreditColumns: true, hasNarrativeText: true },
      }),
      "statement-review-intake",
    );
    expect(result.artifactClass).toBe("mixed_workbook");
  });

  it("XLSX with neither signal present (hint object with both false) is ambiguous", () => {
    const result = classifyArtifact(
      file({
        fileName: "workbook.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        workbookHint: { hasDebitCreditColumns: false, hasNarrativeText: false },
      }),
      "statement-review-intake",
    );
    expect(result.artifactClass).toBe("ambiguous");
  });

  it("legacy .xls follows the same inspection rules as .xlsx, one confidence tier lower", () => {
    const noHint = classifyArtifact(file({ fileName: "old.xls", mimeType: "application/vnd.ms-excel" }), "statement-review-intake");
    expect(noHint.artifactClass).toBe("ambiguous");

    const tb = classifyArtifact(
      file({ fileName: "old.xls", mimeType: "application/vnd.ms-excel", workbookHint: { hasDebitCreditColumns: true, hasNarrativeText: false } }),
      "trial-balance-intake",
    );
    expect(tb.artifactClass).toBe("trial_balance");
    expect(tb.confidence).toBe("medium");
  });
});

describe("classifyArtifact — unsupported formats", () => {
  it("rejects an unrecognized extension as unsupported", () => {
    const result = classifyArtifact(file({ fileName: "photo.jpg", mimeType: "image/jpeg" }), "statement-review-intake");
    expect(result.artifactClass).toBe("unsupported");
  });

  it("rejects an empty file (byteSize 0) as unsupported regardless of extension", () => {
    const result = classifyArtifact(file({ fileName: "empty.pdf", mimeType: "application/pdf", byteSize: 0 }), "statement-review-intake");
    expect(result.artifactClass).toBe("unsupported");
  });

  it("rejects a file with no extension and no recognized mime as unsupported", () => {
    const result = classifyArtifact(file({ fileName: "noextension", mimeType: "" }), "statement-review-intake");
    expect(result.artifactClass).toBe("unsupported");
  });
});

describe("classifyArtifact — corrective route suggestions, not generic errors", () => {
  it("statement-review intake + trial_balance class: suggests Prepare Data", () => {
    const result = classifyArtifact(file({ fileName: "tb.csv" }), "statement-review-intake");
    expect(result.suggestion).toEqual({
      message: "This appears to be a trial balance. Open Prepare Data.",
      suggestedRoute: "prepare-data",
    });
  });

  it("statement-review intake + ambiguous XLSX: suggests user confirmation, not a generic error", () => {
    const result = classifyArtifact(file({ fileName: "workbook.xlsx" }), "statement-review-intake");
    expect(result.suggestion).toEqual({
      message: "We could not determine the workbook type. Choose what it contains.",
      suggestedRoute: "confirm-workbook-contents",
    });
  });

  it("trial-balance intake + a PDF/DOCX (financial_statements class): suggests statement review instead", () => {
    const pdf = classifyArtifact(file({ fileName: "fs.pdf", mimeType: "application/pdf" }), "trial-balance-intake");
    expect(pdf.suggestion).toEqual({
      message: "You selected financial statements. Review them instead.",
      suggestedRoute: "statement-review",
    });
  });

  it("trial-balance intake + structured_xbrl: also suggests statement review", () => {
    const result = classifyArtifact(
      file({ fileName: "instance.xhtml", contentSample: "<ix:nonNumeric>" }),
      "trial-balance-intake",
    );
    expect(result.suggestion?.suggestedRoute).toBe("statement-review");
  });

  it("a correctly-matched class carries no suggestion (no false-positive corrective routing)", () => {
    const csvInTbContext = classifyArtifact(file({ fileName: "tb.csv" }), "trial-balance-intake");
    expect(csvInTbContext.suggestion).toBeUndefined();

    const pdfInReviewContext = classifyArtifact(file({ fileName: "fs.pdf", mimeType: "application/pdf" }), "statement-review-intake");
    expect(pdfInReviewContext.suggestion).toBeUndefined();
  });
});

describe("classifyArtifact — determinism", () => {
  it("the same input always produces the same output", () => {
    const input = file({
      fileName: "workbook.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      workbookHint: { hasDebitCreditColumns: true, hasNarrativeText: false },
    });
    const a = classifyArtifact(input, "statement-review-intake");
    const b = classifyArtifact(input, "statement-review-intake");
    expect(a).toEqual(b);
  });
});

describe("hasAcceptedExtension / STATEMENT_REVIEW_ACCEPTED_EXTENSIONS", () => {
  it("accepts exactly .pdf, .docx, .xlsx, .xhtml, .html", () => {
    expect(STATEMENT_REVIEW_ACCEPTED_EXTENSIONS).toEqual([".pdf", ".docx", ".xlsx", ".xhtml", ".html"]);
    for (const ext of STATEMENT_REVIEW_ACCEPTED_EXTENSIONS) {
      expect(hasAcceptedExtension(`file${ext}`)).toBe(true);
    }
  });

  it("rejects CSV and other non-accepted extensions at the picker level", () => {
    expect(hasAcceptedExtension("file.csv")).toBe(false);
    expect(hasAcceptedExtension("file.jpg")).toBe(false);
    expect(hasAcceptedExtension("file.xls")).toBe(false);
    expect(hasAcceptedExtension("file")).toBe(false);
  });

  it("is case-insensitive on the extension", () => {
    expect(hasAcceptedExtension("Statements.PDF")).toBe(true);
    expect(hasAcceptedExtension("Report.DOCX")).toBe(true);
  });
});
