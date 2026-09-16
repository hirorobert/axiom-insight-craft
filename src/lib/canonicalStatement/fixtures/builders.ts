// canonicalStatement/fixtures/builders.ts — small factories to keep golden
// fixtures readable. These are test/fixture helpers only — never imported
// by production rule or model code.

import { moneyFromDecimalString, type CurrencyCode } from "../money";
import type {
  ExtractionConfidence,
  ExtractionMethod,
  MonetaryFact,
  NormalBalance,
  ProvenanceRecord,
  ReportingPeriodRef,
  SignConvention,
  SourceArtifact,
  SourceLocator,
  StatementLine,
} from "../types";

export const FIXTURE_SOURCE: SourceArtifact = {
  sourceDocumentId: "fixture-source-1",
  sourceHash: "0".repeat(64),
  artifactKind: "TRIAL_BALANCE",
  originalFileName: "fixture.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function provenance(originalText: string, locator: SourceLocator = { kind: "MANUAL", note: "fixture" }, method: ExtractionMethod = "TRIAL_BALANCE_DERIVED", confidence: ExtractionConfidence = { kind: "CERTAIN" }): ProvenanceRecord {
  return { source: FIXTURE_SOURCE, locator, extractionMethod: method, extractionConfidence: confidence, originalText };
}

export const CURRENT: ReportingPeriodRef = { periodId: "CURRENT", isComparative: false };
export const COMPARATIVE_1: ReportingPeriodRef = { periodId: "COMPARATIVE_1", isComparative: true };

let factCounter = 0;
/** Deterministic, human-legible factIds — resets per fixture module via resetFactCounter(). */
export function nextFactId(prefix: string): string {
  factCounter += 1;
  return `${prefix}-${factCounter}`;
}

export function resetFactCounter(): void {
  factCounter = 0;
}

export function fact(
  factId: string,
  amount: string | null,
  currency: CurrencyCode,
  scale: number,
  period: ReportingPeriodRef = CURRENT,
  sign: SignConvention = "NATURAL",
  originalText?: string,
): MonetaryFact {
  return {
    factId,
    version: 1,
    value: amount === null ? null : moneyFromDecimalString(currency, scale, amount),
    reportingPeriod: period,
    signConvention: sign,
    // Locator defaults to a per-fact identity (keyed by factId) so two
    // fixture facts that happen to share a value never collide in the
    // duplicate-fact-fingerprint rule (Rule 8b) merely because they were
    // both built through this helper — a real extracted fact always has a
    // distinct source locator even when its value coincidentally matches
    // another fact's. Pass an explicit locator to `provenance()` yourself
    // (see defectiveFixture.ts) to construct a genuine fixture-level
    // duplicate for that rule's own test.
    provenance: provenance(originalText ?? amount ?? "MISSING", { kind: "MANUAL", note: `fixture:${factId}` }),
    supersedesVersion: null,
  };
}

export function line(
  lineId: string,
  label: string,
  concept: string,
  role: StatementLine["role"],
  currentFactId: string,
  options: {
    comparativeFactId?: string | null;
    normalBalance?: NormalBalance;
    isContra?: boolean;
    noteReferenceIds?: readonly string[];
    castingChildLineIds?: readonly string[];
  } = {},
): StatementLine {
  return {
    lineId,
    label,
    concept,
    role,
    normalBalance: options.normalBalance ?? "DEBIT_NORMAL",
    isContra: options.isContra ?? false,
    currentFactId,
    comparativeFactId: options.comparativeFactId ?? null,
    noteReferenceIds: options.noteReferenceIds ?? [],
    castingChildLineIds: options.castingChildLineIds ?? [],
  };
}
