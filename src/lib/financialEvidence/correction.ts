// financialEvidence/correction.ts — a correction to source evidence is a NEW evidence
// version, never an edit.
//
// One cell of one row of a latest, valid batch is changed; the whole batch is then pushed
// through the SAME intake contract as an upload (ingestRecords), so a corrected value that
// would not have been accepted as an upload is not accepted as a correction either. The result
// is a new immutable batch (same series, next version) whose content hash covers the previous
// batch's hash and the change, so a replay of the identical correction is an exact replay.
//
// This module covers every family whose content a reviewer may need to fix: transaction
// classifications (activity / cash_flow_line), equity movements, budget figures, cash-basis
// figures, schedule figures, cash account maps and note/disclosure text. Extracted candidates
// and trial balances are not correctable here (candidates are review-only; a trial balance is
// corrected through its own fact-correction command).

import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import { ingestRecords } from "./intake";
import type { EvidenceBatch, EvidenceDiagnostic } from "./types";

export interface EvidenceCellCorrection {
  /** 1-based data row. */
  readonly rowNumber: number;
  readonly column: string;
  readonly newValue: string;
  readonly rationale: string;
}

export type EvidenceCorrectionResult =
  | {
      readonly ok: true;
      readonly batch: EvidenceBatch;
      readonly previousValue: string;
      readonly supersedesBatchId: string;
    }
  | { readonly ok: false; readonly reason: string; readonly diagnostics: readonly EvidenceDiagnostic[] };

const refuse = (reason: string, diagnostics: readonly EvidenceDiagnostic[] = []): EvidenceCorrectionResult => ({ ok: false, reason, diagnostics });

export function correctEvidenceCell(batch: EvidenceBatch, c: EvidenceCellCorrection, ctx: { readonly periodStart?: string; readonly periodEnd?: string } = {}): EvidenceCorrectionResult {
  if (batch.evidenceType === "EXTRACTED_CANDIDATES" || batch.evidenceType === "TRIAL_BALANCE") return refuse(`${batch.evidenceType} evidence cannot be corrected here.`);
  if (batch.validationStatus === "INVALID" || batch.validationStatus === "REQUIRES_REVIEW") return refuse("Only a validated batch can be corrected; replace an invalid batch by uploading a corrected file.");
  if (c.rationale.trim().length < 8) return refuse("A correction needs a rationale of at least 8 characters.");
  const columns = batch.document.columns;
  const ci = columns.indexOf(c.column);
  if (ci < 0) return refuse(`Column "${c.column}" does not exist in this evidence.`);
  if (!Number.isInteger(c.rowNumber) || c.rowNumber < 1 || c.rowNumber > batch.document.rows.length) return refuse(`Row ${c.rowNumber} does not exist (the batch has ${batch.document.rows.length} data rows).`);
  const previousValue = batch.document.rows[c.rowNumber - 1][ci];
  if (previousValue === c.newValue) return refuse("The corrected value is identical to the current value.");

  const rows = batch.document.rows.map((r, i) => (i === c.rowNumber - 1 ? r.map((cell, j) => (j === ci ? c.newValue : cell)) : [...r]));
  const records: string[][] = [[...columns], ...rows];
  const contentHash = sha256Hex(canonicalStringify({ format: "CORRECTION", of: batch.contentHash, records }));
  const result = ingestRecords(
    { companyId: batch.companyId, evidenceType: batch.evidenceType, periodRole: batch.periodRole, reportingPeriodId: batch.reportingPeriodId, seriesKey: batch.seriesKey, currency: batch.currency ?? undefined, scale: batch.scale ?? undefined, periodStart: ctx.periodStart, periodEnd: ctx.periodEnd },
    records,
    {
      contentHash,
      format: "CORRECTION",
      fileName: batch.sourceFileName ? `${batch.sourceFileName.replace(/ \(corrected\)$/, "")} (corrected)` : `${batch.evidenceType} (corrected)`,
      sheet: batch.document.sourceSheet,
      rowLocators: batch.document.rowLocators,
      fileSha256: batch.document.sourceFileSha256,
    },
  );
  if (result.outcome !== "PARSED") return refuse("The corrected evidence was refused.", result.diagnostics);
  if (result.batch.validationStatus === "INVALID" || result.batch.validationStatus === "REQUIRES_REVIEW") {
    return refuse("The corrected value does not satisfy the evidence contract, so no new version was created.", result.batch.diagnostics.filter((d) => d.severity === "ERROR"));
  }
  return { ok: true, batch: result.batch, previousValue, supersedesBatchId: batch.evidenceBatchId };
}
