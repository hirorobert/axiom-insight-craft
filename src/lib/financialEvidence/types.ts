// financialEvidence/types.ts — the immutable financial-evidence model.
//
// Every accounting input to a statement set other than the reviewed trial
// balance's own account balances is an EVIDENCE BATCH: an immutable, versioned,
// replay-identified parse of one source file, with exact diagnostics. Ten
// families exist (A–I). A batch document contains ONLY strings, arrays, objects,
// booleans and null — never a JSON number — so an amount can never pass through
// binary floating point on its way to the database, and the database refuses any
// document that tries.

export const EVIDENCE_SCHEMA_VERSION = "1.0.0";

export const EVIDENCE_TYPES = [
  "TRIAL_BALANCE", // A — referenced, never re-parsed here
  "TRANSACTION_LEDGER", // B — cash ledger for the direct-method cash flow
  "EQUITY_MOVEMENTS", // C
  "BUDGET", // D
  "IPSAS_CASH_RECEIPTS_PAYMENTS", // E
  "SUPPORTING_SCHEDULE", // F
  "NOTES_AND_POLICIES", // G
  "PRIOR_PERIOD_STATEMENTS", // H
  "EXTRACTED_CANDIDATES", // I — gated: may never feed a statement
  "CASH_ACCOUNT_MAP", // J — explicit account → cash-category authority for multi-account cash
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export type PeriodRole = "CURRENT" | "COMPARATIVE";

export type DiagnosticSeverity = "ERROR" | "WARNING" | "INFO";

export interface EvidenceDiagnostic {
  /** Stable machine code, e.g. AMOUNT_NOT_PLAIN_DECIMAL. */
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  /** Exact, human-readable explanation. Never generic. */
  readonly message: string;
  /** 1-based data-row number (the header is row 0). Absent for file-level diagnostics. */
  readonly row?: number;
  readonly column?: string;
  /** The offending raw value, truncated to 120 characters. */
  readonly value?: string;
}

export type ValidationStatus = "VALID" | "VALID_WITH_WARNINGS" | "REQUIRES_REVIEW" | "INVALID";

/**
 * The parsed, persisted document. Numbers are strings everywhere: `scale` is
 * carried as a string, and `rows[i]` is the (i+1)-th data row as an array of
 * cell strings aligned with `columns`.
 */
export interface EvidenceBatchDocument {
  readonly schemaVersion: string;
  readonly evidenceType: EvidenceType;
  readonly periodRole: PeriodRole;
  readonly reportingPeriodId: string;
  readonly seriesKey: string;
  readonly currency: string | null;
  readonly scale: string | null;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** How the rows were obtained. Strings only, like everything in this document. */
  readonly sourceFormat?: "CSV" | "XLSX" | "CORRECTION";
  readonly sourceSheet?: string;
  /** One locator per data row (e.g. "Ledger!A5:H5"), aligned with `rows`. */
  readonly rowLocators?: readonly string[];
  readonly sourceFileSha256?: string;
}

export interface EvidenceBatch {
  /** Deterministic: `eb-` + the first 32 hex characters of the replay identity. */
  readonly evidenceBatchId: string;
  readonly companyId: string;
  readonly evidenceType: EvidenceType;
  readonly periodRole: PeriodRole;
  readonly reportingPeriodId: string;
  readonly seriesKey: string;
  readonly schemaVersion: string;
  readonly sourceFileName: string | null;
  /** sha256 of the canonical records (header + rows as exact strings): identical for the same evidence supplied as CSV or as a workbook. */
  readonly contentHash: string;
  /** sha256(companyId|reportingPeriodId|evidenceType|periodRole|seriesKey|contentHash) — identical to the database's replay identity. */
  readonly replayIdentity: string;
  readonly currency: string | null;
  readonly scale: number | null;
  readonly document: EvidenceBatchDocument;
  readonly diagnostics: readonly EvidenceDiagnostic[];
  readonly validationStatus: ValidationStatus;
}

export type ReplayStatus =
  | { readonly kind: "NEW_SERIES" }
  | { readonly kind: "NEW_VERSION"; readonly expectedPreviousBatchId: string; readonly version: number }
  | { readonly kind: "EXACT_REPLAY"; readonly existingBatchId: string }
  | { readonly kind: "CONFLICTING_REPLAY"; readonly existingBatchId: string; readonly reason: string };

/** Human-readable label for each family, used in the Sources stage. */
export const EVIDENCE_TYPE_LABELS: Readonly<Record<EvidenceType, string>> = {
  TRIAL_BALANCE: "Trial balance",
  TRANSACTION_LEDGER: "Cash transaction ledger",
  EQUITY_MOVEMENTS: "Equity movements",
  BUDGET: "Approved budget",
  IPSAS_CASH_RECEIPTS_PAYMENTS: "Cash receipts and payments",
  SUPPORTING_SCHEDULE: "Supporting schedule",
  NOTES_AND_POLICIES: "Notes and policies",
  PRIOR_PERIOD_STATEMENTS: "Prior-period statements",
  EXTRACTED_CANDIDATES: "Extracted candidates (review only)",
  CASH_ACCOUNT_MAP: "Cash account map",
};
