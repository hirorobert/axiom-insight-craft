// canonicalStatement/adapters.ts — the adapter boundary.
//
// These interfaces are the ONLY contract a future format-specific extractor
// must satisfy. None are implemented in this branch (no OCR, no PDF/DOCX/
// XLSX parsing, no Arelle). Every adapter returns exclusively canonical
// types (MonetaryFact, Statement, Note, ...) — a format-specific object
// (e.g. an Arelle fact object, a PDF text-run object) must never leak past
// `extract`/`normalize` into the canonical domain model. This is enforced
// by the return type below, not by convention: AdapterExtractionResult is
// built entirely from ./types.

import type {
  AccountingPolicy,
  MonetaryFact,
  Note,
  Statement,
  TextualDisclosure,
} from "./types";

export interface AdapterExtractionResult {
  readonly facts: readonly MonetaryFact[];
  readonly statements: readonly Statement[];
  readonly notes: readonly Note[];
  readonly accountingPolicies: readonly AccountingPolicy[];
  readonly textualDisclosures: readonly TextualDisclosure[];
  /** Non-fatal extraction warnings (e.g. a low-confidence OCR region) — never silently dropped. */
  readonly warnings: readonly string[];
}

export interface SourceInput {
  readonly sourceDocumentId: string;
  readonly sourceHash: string;
  readonly bytes: Uint8Array;
  readonly originalFileName?: string;
  readonly mimeType?: string;
}

export interface IxbrlAdapter {
  readonly adapterKind: "IXBRL";
  /**
   * A future implementation runs Arelle as an isolated service/process and
   * translates its output into AdapterExtractionResult here — Arelle's own
   * object model must never be returned or stored directly.
   */
  extract(input: SourceInput): Promise<AdapterExtractionResult>;
}

export interface PdfAdapter {
  readonly adapterKind: "PDF";
  extract(input: SourceInput): Promise<AdapterExtractionResult>;
}

export interface DocxAdapter {
  readonly adapterKind: "DOCX";
  extract(input: SourceInput): Promise<AdapterExtractionResult>;
}

export interface XlsxAdapter {
  readonly adapterKind: "XLSX";
  extract(input: SourceInput): Promise<AdapterExtractionResult>;
}

/** Input shape for Workflow A is deliberately abstract here — normalize() takes whatever HESABU/account_mappings authority already resolved, never raw trial-balance rows. */
export interface TrialBalanceNormalizationInput {
  readonly companyId: string;
  readonly periodYear: number;
  readonly reviewedAccountLines: readonly unknown[];
}

export interface TrialBalanceAdapter {
  readonly adapterKind: "TRIAL_BALANCE";
  normalize(input: TrialBalanceNormalizationInput): Promise<AdapterExtractionResult>;
}

export type Adapter = IxbrlAdapter | PdfAdapter | DocxAdapter | XlsxAdapter | TrialBalanceAdapter;
