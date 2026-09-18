// financialGeneration/common.ts — shared plumbing for the deterministic
// evidence-driven statement generators. Nothing here decides an accounting
// treatment: it converts validated evidence rows into canonical facts with
// exact provenance, and reports gaps as gaps.

import { moneyFromDecimalString, type Money } from "@/lib/canonicalStatement/money";
import { sha256Hex } from "@/lib/canonicalStatement/serialization";
import type { MonetaryFact, ReportingPeriodRef, Statement } from "@/lib/canonicalStatement/types";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";

export type GenerationSeverity = "ERROR" | "WARNING" | "INFO";

export interface GenerationDiagnostic {
  readonly code: string;
  readonly severity: GenerationSeverity;
  readonly message: string;
}

/** Which evidence rows fed a statement line — the drill-down index (evidence -> line), kept beside the canonical report, never inside it. */
export interface EvidenceRowRef {
  readonly batchId: string;
  readonly rowNumbers: readonly number[];
}

export type GenerationResult =
  | {
      readonly status: "GENERATED";
      readonly statement: Statement;
      readonly facts: readonly MonetaryFact[];
      /** lineId -> the evidence rows behind it. */
      readonly evidenceIndex: Readonly<Record<string, readonly EvidenceRowRef[]>>;
      readonly diagnostics: readonly GenerationDiagnostic[];
    }
  | { readonly status: "EVIDENCE_GAP"; readonly reasons: readonly string[]; readonly diagnostics: readonly GenerationDiagnostic[] };

export const gap = (reasons: readonly string[], diagnostics: readonly GenerationDiagnostic[] = []): GenerationResult => ({ status: "EVIDENCE_GAP", reasons, diagnostics });

export const slug = (label: string): string => sha256Hex(label).slice(0, 10);

export const periodRef = (periodId: string, isComparative: boolean): ReportingPeriodRef => ({ periodId, isComparative });

/** Parses one evidence amount exactly. The batch is already validated, so a failure here is a defect and must surface, not be swallowed. */
export function amountOf(batch: EvidenceBatch, text: string): Money {
  if (batch.currency === null || batch.scale === null) throw new Error(`Evidence batch ${batch.evidenceBatchId} carries no currency/scale`);
  return moneyFromDecimalString(batch.currency, batch.scale, text.trim());
}

/** A fact whose provenance is one or more rows of a controlled evidence batch. */
/** `firstRow` 0 marks a COMPUTED fact (a total): it is located at row 1 with an explicit derivation so its provenance is unique. */
export function evidenceFact(batch: EvidenceBatch, factId: string, value: Money, period: ReportingPeriodRef, firstRow: number, originalText: string): MonetaryFact {
  const computed = firstRow === 0;
  return {
    factId,
    version: 1,
    value,
    reportingPeriod: period,
    signConvention: "NATURAL",
    provenance: {
      source: { sourceDocumentId: batch.evidenceBatchId, sourceHash: batch.contentHash, artifactKind: "EVIDENCE_BATCH", ...(batch.sourceFileName ? { originalFileName: batch.sourceFileName } : {}) },
      locator: { kind: "EVIDENCE_ROW", batchId: batch.evidenceBatchId, rowNumber: computed ? 1 : firstRow, ...(computed ? { derivation: factId } : {}) },
      extractionMethod: "EVIDENCE_BATCH_DERIVED",
      extractionConfidence: { kind: "CERTAIN" },
      originalText,
    },
    supersedesVersion: null,
  };
}

/** Column accessor over a batch document. */
export function columnReader(batch: EvidenceBatch): (row: number, name: string) => string {
  const idx = new Map(batch.document.columns.map((c, i) => [c, i] as const));
  return (row, name) => {
    const i = idx.get(name);
    return i === undefined ? "" : (batch.document.rows[row - 1]?.[i] ?? "").trim();
  };
}

/** "3 rows: 1, 4, 9" — bounded so a huge aggregate never bloats provenance text. */
export function describeRows(rows: readonly number[]): string {
  const shown = rows.slice(0, 20).join(", ");
  return `${rows.length} evidence row${rows.length === 1 ? "" : "s"}: ${shown}${rows.length > 20 ? ", ..." : ""}`;
}

export function sameDenomination(batches: readonly EvidenceBatch[]): boolean {
  return batches.every((b) => b.currency === batches[0].currency && b.scale === batches[0].scale);
}

/** Deterministic, locale-independent string ordering. */
export const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
