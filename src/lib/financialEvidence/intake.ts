// financialEvidence/intake.ts — controlled intake of one evidence file.
//
// Pure and synchronous: text in, an EvidenceBatch (or an exact rejection) out.
// It performs no I/O, holds no clock, and never invents a value: a blank optional
// cell stays blank, an unparseable amount is an ERROR naming the row, column and
// value, and nothing that fails validation can ever be presented as usable evidence.

import { moneyFromDecimalString } from "@/lib/canonicalStatement/money";
import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import { hasControlCharacter, hasHiddenCharacter, isBlankRecord, isFormulaLike, parseCsv } from "./csv";
import { FAMILY_SCHEMAS, type CellKind, type ColumnSpec, type RowAccess } from "./schemas";
import { EVIDENCE_SCHEMA_VERSION, type EvidenceBatch, type EvidenceBatchDocument, type EvidenceDiagnostic, type EvidenceType, type PeriodRole, type ReplayStatus, type ValidationStatus } from "./types";

/** The content identity of evidence: a hash of its canonical records (header + rows as exact strings), independent of file format. */
export const canonicalIdentityOf = (records: readonly (readonly string[])[]): string => sha256Hex(canonicalStringify({ records }));

export const INTAKE_LIMITS = { maxChars: 2_000_000, maxRows: 20_000, maxColumns: 40, maxTextChars: 500, maxLongTextChars: 20_000, maxAmountDigits: 30 } as const;

export interface IntakeCommon {
  readonly companyId: string;
  readonly evidenceType: EvidenceType;
  readonly periodRole: PeriodRole;
  readonly reportingPeriodId: string;
  readonly seriesKey?: string;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly currency?: string;
  readonly scale?: number;
  /** ISO dates. When supplied, ledger rows outside them are refused. */
  readonly periodStart?: string;
  readonly periodEnd?: string;
}

export interface IntakeRequest extends IntakeCommon {
  /** The file's text. Binary content must be rejected by the caller before decoding; a NUL character here is rejected too. */
  readonly text: string;
}

/** Where a set of already-tokenised records came from. Everything downstream (validation, replay, provenance) is source-agnostic. */
export interface RecordSource {
  /** Identity of the CONTENT (not of the file container): the replay identity is built from it. */
  readonly contentHash: string;
  readonly format: "CSV" | "XLSX" | "CORRECTION";
  readonly sheet?: string;
  /** One locator per DATA row (aligned), e.g. "Ledger!A5:H5". */
  readonly rowLocators?: readonly string[];
  /** sha256 of the container bytes; provenance only — never part of the replay identity. */
  readonly fileSha256?: string;
  readonly fileName?: string | null;
  readonly extraDiagnostics?: readonly EvidenceDiagnostic[];
}

export type IntakeResult =
  | { readonly outcome: "REJECTED"; readonly diagnostics: readonly EvidenceDiagnostic[] }
  | { readonly outcome: "PARSED"; readonly batch: EvidenceBatch };

const err = (code: string, message: string, extra: Partial<EvidenceDiagnostic> = {}): EvidenceDiagnostic => ({ code, severity: "ERROR", message, ...extra });
const warn = (code: string, message: string, extra: Partial<EvidenceDiagnostic> = {}): EvidenceDiagnostic => ({ code, severity: "WARNING", message, ...extra });
const clip = (v: string) => (v.length > 120 ? `${v.slice(0, 117)}...` : v);

const SPREADSHEET_NAME = /\.(xlsx|xlsm|xlsb|xls|ods)$/i;
const SPREADSHEET_MIME = /spreadsheet|ms-excel|opendocument/i;
const NON_CSV_NAME = /\.(pdf|docx?|png|jpe?g|gif|zip|exe|html?|js|svg)$/i;
const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/;
const KEY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/;
const CODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

function isRealIsoDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function validateCell(kind: CellKind, spec: ColumnSpec, value: string, row: number, currency: string | null, scale: number | null): EvidenceDiagnostic[] {
  const at = { row, column: spec.name, value: clip(value) };
  if (value.trim() === "") return spec.required ? [err("REQUIRED_VALUE_MISSING", `${spec.name} is required and was blank on row ${row}. A blank is never treated as zero or as a default.`, at)] : [];

  const out: EvidenceDiagnostic[] = [];
  if (hasControlCharacter(value)) out.push(err("CONTROL_CHARACTER", `${spec.name} on row ${row} contains a control character.`, at));
  if (hasHiddenCharacter(value)) out.push(err("HIDDEN_CHARACTER", `${spec.name} on row ${row} contains an invisible or direction-override character.`, at));

  if (kind === "DECIMAL") {
    const v = value.trim();
    if (/[,\u00a0\u202f ]/.test(v) && /\d/.test(v)) out.push(err("AMOUNT_HAS_SEPARATOR", `${spec.name} on row ${row} contains a thousands separator or space ("${clip(v)}"); provide a plain decimal such as 1234567.89.`, at));
    else if (/^\(.*\)$/.test(v)) out.push(err("AMOUNT_PARENTHESIS_NEGATIVE", `${spec.name} on row ${row} uses parentheses for a negative ("${clip(v)}"); provide a leading minus sign instead.`, at));
    else if (!PLAIN_DECIMAL.test(v)) out.push(err("AMOUNT_NOT_PLAIN_DECIMAL", `${spec.name} on row ${row} is not a plain decimal number ("${clip(v)}").`, at));
    else if (v.replace(/[-.]/g, "").length > INTAKE_LIMITS.maxAmountDigits) out.push(err("AMOUNT_TOO_LARGE", `${spec.name} on row ${row} has more than ${INTAKE_LIMITS.maxAmountDigits} digits.`, at));
    else if (currency !== null && scale !== null) {
      try {
        moneyFromDecimalString(currency, scale, v);
      } catch {
        out.push(err("AMOUNT_PRECISION_EXCEEDS_SCALE", `${spec.name} on row ${row} ("${clip(v)}") has more decimal places than the declared scale of ${scale}; it was not rounded.`, at));
      }
    }
    return out;
  }
  if (kind === "DATE") {
    if (!isRealIsoDate(value.trim())) out.push(err("DATE_NOT_ISO", `${spec.name} on row ${row} must be a real calendar date in YYYY-MM-DD form ("${clip(value)}").`, at));
    return out;
  }
  if (kind === "KEY") {
    if (!KEY_SHAPE.test(value)) out.push(err("KEY_MALFORMED", `${spec.name} on row ${row} must be 1-120 letters, digits and . _ : / - only ("${clip(value)}").`, at));
    return out;
  }
  if (kind === "CODE") {
    if (!CODE_SHAPE.test(value)) out.push(err("CODE_MALFORMED", `${spec.name} on row ${row} must be 1-40 letters, digits and . _ - only ("${clip(value)}").`, at));
    return out;
  }
  if (kind === "YESNO") {
    if (!/^(y|n|yes|no)$/i.test(value.trim())) out.push(err("YESNO_INVALID", `${spec.name} on row ${row} must be Y or N ("${clip(value)}").`, at));
    return out;
  }
  if (typeof kind === "object") {
    if (!kind.oneOf.includes(value.trim())) out.push(err("VALUE_NOT_ALLOWED", `${spec.name} on row ${row} must be one of ${kind.oneOf.join(", ")} ("${clip(value)}").`, at));
    return out;
  }
  // TEXT / LONGTEXT
  const max = kind === "LONGTEXT" ? INTAKE_LIMITS.maxLongTextChars : INTAKE_LIMITS.maxTextChars;
  if (value.length > max) out.push(err("TEXT_TOO_LONG", `${spec.name} on row ${row} exceeds ${max} characters.`, at));
  if (kind === "TEXT" && /[\r\n]/.test(value)) out.push(err("TEXT_HAS_LINE_BREAK", `${spec.name} on row ${row} must be a single line.`, at));
  if (isFormulaLike(value)) out.push(err("FORMULA_INJECTION", `${spec.name} on row ${row} begins like a spreadsheet formula ("${clip(value)}"); it was refused rather than stored.`, at));
  if (/<\s*[a-zA-Z!/]/.test(value)) out.push(warn("MARKUP_IN_TEXT", `${spec.name} on row ${row} contains markup-like text; it is stored and displayed as plain text only.`, at));
  return out;
}

function rejected(...diagnostics: EvidenceDiagnostic[]): IntakeResult {
  return { outcome: "REJECTED", diagnostics };
}

export function replayIdentityOf(input: { companyId: string; reportingPeriodId: string; evidenceType: string; periodRole: string; seriesKey: string; contentHash: string }): string {
  return sha256Hex([input.companyId, input.reportingPeriodId, input.evidenceType, input.periodRole, input.seriesKey, input.contentHash].join("|"));
}

export function ingestEvidence(req: IntakeRequest): IntakeResult {
  if (req.evidenceType === "TRIAL_BALANCE") {
    return rejected(err("USE_TRIAL_BALANCE_IMPORT", "Trial balances are imported and reviewed through the Prepare Data stage; they are not parsed here."));
  }
  if ((req.fileName && SPREADSHEET_NAME.test(req.fileName)) || (req.mimeType && SPREADSHEET_MIME.test(req.mimeType)) || req.text.startsWith("PK\u0003\u0004")) {
    return rejected(err("XLSX_NOT_SUPPORTED", "Spreadsheet files are not accepted for this evidence type. Export the sheet as CSV (UTF-8) and upload that; formulas, macros and hidden sheets are never read."));
  }
  if ((req.fileName && NON_CSV_NAME.test(req.fileName)) || (req.mimeType && /^(image|audio|video)\/|pdf|zip|msword|officedocument|html|javascript/i.test(req.mimeType))) {
    return rejected(err("UNSUPPORTED_FILE_TYPE", "Only CSV text files are accepted for this evidence type."));
  }
  if (req.text.includes("\u0000")) return rejected(err("BINARY_CONTENT", "The file contains binary content and is not a text CSV."));
  if (req.text.length > INTAKE_LIMITS.maxChars) return rejected(err("FILE_TOO_LARGE", `The file exceeds ${INTAKE_LIMITS.maxChars.toLocaleString("en-US")} characters.`));
  if (req.text.trim() === "") return rejected(err("EMPTY_FILE", "The file is empty."));

  const parsed = parseCsv(req.text);
  if (parsed.unterminatedQuoteAtRecord !== null) {
    return rejected(err("CSV_UNTERMINATED_QUOTE", `A quoted field starting in record ${parsed.unterminatedQuoteAtRecord} is never closed.`));
  }
  const records = parsed.rows.filter((r) => !isBlankRecord(r));
  // The identity is that of the CANONICAL RECORDS, not of the container: the same reviewed evidence supplied as CSV or as an
  // .xlsx converges on the same content hash (and therefore the same replay identity). The container's own hash is provenance only.
  return ingestRecords(req, records, { contentHash: canonicalIdentityOf(records), format: "CSV", fileName: req.fileName ?? null, fileSha256: sha256Hex(req.text) });
}

/**
 * Validates already-tokenised records (header + data rows) against the family schema and builds the batch.
 * CSV text, an XLSX sheet and a reviewer's cell correction all end here, so they are held to the identical contract.
 */
export function ingestRecords(req: IntakeCommon, records: readonly (readonly string[])[], source: RecordSource): IntakeResult {
  const seriesKey = req.seriesKey && req.seriesKey.trim() !== "" ? req.seriesKey.trim() : "default";
  if (req.evidenceType === "TRIAL_BALANCE") {
    return rejected(err("USE_TRIAL_BALANCE_IMPORT", "Trial balances are imported and reviewed through the Prepare Data stage; they are not parsed here."));
  }
  const schema = FAMILY_SCHEMAS[req.evidenceType];
  const diagnostics: EvidenceDiagnostic[] = [...(source.extraDiagnostics ?? [])];

  let currency: string | null = null;
  let scale: number | null = null;
  if (schema.hasAmounts) {
    if (!req.currency || !/^[A-Z]{3}$/.test(req.currency)) return rejected(err("CURRENCY_REQUIRED", "This evidence type carries amounts, so an ISO 4217 currency code must be declared explicitly; none is assumed."));
    if (req.scale === undefined || !Number.isInteger(req.scale) || req.scale < 0 || req.scale > 6) return rejected(err("SCALE_REQUIRED", "This evidence type carries amounts, so the number of decimal places (0-6) must be declared explicitly; none is assumed."));
    currency = req.currency;
    scale = req.scale;
  }

  if (records.length === 0) return rejected(err("EMPTY_FILE", "The file contains no data."));
  if (records.length - 1 > INTAKE_LIMITS.maxRows) return rejected(err("TOO_MANY_ROWS", `The file has more than ${INTAKE_LIMITS.maxRows.toLocaleString("en-US")} data rows.`));

  const header = records[0].map((h) => h.trim().toLowerCase());
  if (header.length > INTAKE_LIMITS.maxColumns) return rejected(err("TOO_MANY_COLUMNS", `The header has more than ${INTAKE_LIMITS.maxColumns} columns.`));
  if (header.length === 1 && /[;\t|]/.test(records[0][0])) {
    return rejected(err("UNSUPPORTED_DELIMITER", "The header looks semicolon-, tab- or pipe-delimited. Only comma-delimited CSV is accepted."));
  }
  const dupHeader = header.filter((h, i) => h !== "" && header.indexOf(h) !== i);
  for (const d of new Set(dupHeader)) diagnostics.push(err("DUPLICATE_COLUMN", `Column "${d}" appears more than once in the header.`, { column: d }));

  const indexOf = new Map<string, number>();
  header.forEach((h, i) => { if (!indexOf.has(h)) indexOf.set(h, i); });
  const known = new Set(schema.columns.map((c) => c.name));
  for (const h of header) if (h !== "" && !known.has(h)) diagnostics.push(warn("UNKNOWN_COLUMN", `Column "${h}" is not part of this evidence type and was ignored.`, { column: h }));
  for (const c of schema.columns) if (c.required && !indexOf.has(c.name)) diagnostics.push(err("REQUIRED_COLUMN_MISSING", `Required column "${c.name}" is missing from the header.`, { column: c.name }));

  const dataRecords = records.slice(1);
  const columns = schema.columns.map((c) => c.name);
  const rows: string[][] = [];
  const hasHeaderErrors = diagnostics.some((d) => d.severity === "ERROR");

  const misaligned = new Set<number>();
  dataRecords.forEach((rec, idx) => {
    const rowNo = idx + 1;
    if (rec.length !== header.length) {
      misaligned.add(idx);
      diagnostics.push(err("ROW_COLUMN_COUNT", `Row ${rowNo} has ${rec.length} cells but the header has ${header.length}.`, { row: rowNo }));
    }
    rows.push(columns.map((name) => (indexOf.has(name) ? (rec[indexOf.get(name)!] ?? "") : "")));
  });

  if (dataRecords.length === 0) diagnostics.push(err("NO_DATA_ROWS", "The file has a header but no data rows."));

  if (!hasHeaderErrors) {
    rows.forEach((cells, idx) => {
      if (misaligned.has(idx)) return; // cells cannot be attributed to columns; ROW_COLUMN_COUNT already explains why
      schema.columns.forEach((spec, ci) => {
        diagnostics.push(...validateCell(spec.kind, spec, cells[ci], idx + 1, currency, scale));
      });
    });
  }

  const cellErrors = diagnostics.some((d) => d.severity === "ERROR");
  if (!cellErrors && schema.crossRow) {
    const access: RowAccess = {
      count: rows.length,
      cell: (i, name) => {
        const ci = columns.indexOf(name);
        return ci < 0 ? "" : (rows[i]?.[ci] ?? "").trim();
      },
    };
    diagnostics.push(...schema.crossRow(access, { periodStart: req.periodStart, periodEnd: req.periodEnd }));
  }

  if (req.evidenceType === "EXTRACTED_CANDIDATES") {
    diagnostics.push({ code: "CANDIDATES_ARE_NOT_ACCEPTED_EVIDENCE", severity: "INFO", message: "Extracted candidates are stored for review only. They can never feed a statement, note or comparative until a reviewer enters the figure through an accepted evidence type." });
  }

  const contentHash = source.contentHash;
  const replayIdentity = replayIdentityOf({ companyId: req.companyId, reportingPeriodId: req.reportingPeriodId, evidenceType: req.evidenceType, periodRole: req.periodRole, seriesKey, contentHash });
  const document: EvidenceBatchDocument = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceType: req.evidenceType,
    periodRole: req.periodRole,
    reportingPeriodId: req.reportingPeriodId,
    seriesKey,
    currency,
    scale: scale === null ? null : String(scale),
    columns,
    rows,
    sourceFormat: source.format,
    ...(source.sheet !== undefined ? { sourceSheet: source.sheet } : {}),
    ...(source.rowLocators ? { rowLocators: source.rowLocators } : {}),
    ...(source.fileSha256 ? { sourceFileSha256: source.fileSha256 } : {}),
  };

  const hasError = diagnostics.some((d) => d.severity === "ERROR");
  const hasWarning = diagnostics.some((d) => d.severity === "WARNING");
  const validationStatus: ValidationStatus = hasError ? "INVALID" : req.evidenceType === "EXTRACTED_CANDIDATES" ? "REQUIRES_REVIEW" : hasWarning ? "VALID_WITH_WARNINGS" : "VALID";

  return {
    outcome: "PARSED",
    batch: {
      evidenceBatchId: `eb-${replayIdentity.slice(0, 32)}`,
      companyId: req.companyId,
      evidenceType: req.evidenceType,
      periodRole: req.periodRole,
      reportingPeriodId: req.reportingPeriodId,
      seriesKey,
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      sourceFileName: source.fileName ?? req.fileName ?? null,
      contentHash,
      replayIdentity,
      currency,
      scale,
      document,
      diagnostics,
      validationStatus,
    },
  };
}

// ─── replay classification ─────────────────────────────────────────────────

export interface StoredBatchSummary {
  readonly evidenceBatchId: string;
  readonly companyId: string;
  readonly evidenceType: EvidenceType;
  readonly periodRole: PeriodRole;
  readonly reportingPeriodId: string;
  readonly seriesKey: string;
  readonly replayIdentity: string;
  readonly version: number;
  /** Optional: when present, an equal replay identity with a different parsed document is a conflict (the parser changed under the same bytes). */
  readonly documentJson?: string;
}

export function classifyReplay(batch: EvidenceBatch, stored: readonly StoredBatchSummary[]): ReplayStatus {
  const same = stored.find((s) => s.companyId === batch.companyId && s.replayIdentity === batch.replayIdentity);
  if (same) {
    if (same.documentJson !== undefined && same.documentJson !== JSON.stringify(batch.document)) {
      return { kind: "CONFLICTING_REPLAY", existingBatchId: same.evidenceBatchId, reason: "The same source content was already ingested but parses to a different document." };
    }
    return { kind: "EXACT_REPLAY", existingBatchId: same.evidenceBatchId };
  }
  const series = stored
    .filter((s) => s.companyId === batch.companyId && s.evidenceType === batch.evidenceType && s.periodRole === batch.periodRole && s.reportingPeriodId === batch.reportingPeriodId && s.seriesKey === batch.seriesKey)
    .sort((a, b) => b.version - a.version);
  if (series.length === 0) return { kind: "NEW_SERIES" };
  return { kind: "NEW_VERSION", expectedPreviousBatchId: series[0].evidenceBatchId, version: series[0].version + 1 };
}

/** An INVALID or REQUIRES_REVIEW batch can be stored and shown, but is never usable as statement evidence. */
export function isUsableEvidence(batch: Pick<EvidenceBatch, "validationStatus" | "evidenceType">): boolean {
  return (batch.validationStatus === "VALID" || batch.validationStatus === "VALID_WITH_WARNINGS") && batch.evidenceType !== "EXTRACTED_CANDIDATES";
}
