// Ω∞ Phase 0 — SAFISHA canonical contracts.
//
// Distinguishes concepts that Gate 1's hardening review found were at risk
// of being collapsed:
//   - a SafishaCertificationResult is immutable provenance evidence, created
//     for EVERY completed engine_run regardless of outcome.
//   - "downstream eligible" is a DERIVED predicate over that result
//     (isDownstreamEligible below) — never a second, competing record.
//   - source identity (sourceFileHash) and computation identity
//     (normalizedInputHash) are separate facts, never merged.
//
// Does NOT implement Phase 3's 8-tier Evidence Ladder or Phase 4's full
// comparative semantics — evidenceTier reflects the CURRENT 6-tier
// classifier (process-trial-balance's classifyAccountTiered), not a future
// ladder. No `overallConfidence`/`confidence` field exists — that remains
// Phase 3 DESIGN-UNRESOLVED per the directive, not invented here.

export type SourceSystem =
  | "muse" | "gacs" | "quickbooks" | "sage" | "tally" | "excel_manual" | "unknown";

export type AccountNature = "asset" | "liability" | "equity" | "income" | "expense";

/**
 * The minimal, deterministic identity of one parsed TB row — the fields
 * that genuinely affect accounting computation. Deliberately excludes
 * `balance` (derivable from debit-credit — hashing it too would be
 * redundant and could mask an inconsistency) and `source_row_number` (a
 * file-structure artifact, not accounting content). Used ONLY to build
 * normalizedInputHash — see normalizedInputHash.ts.
 */
export interface NormalizedInputRow {
  accountCode: string | null;
  accountName: string;
  debit: number;
  credit: number;
}

export interface SafishaException {
  code: string;
  layer: 1 | 2 | 3 | 4 | 5 | 6;
  severity: "error" | "warning" | "info";
  accountCode?: string | null;
  message: string;
  resolution?: string;
}

/**
 * One classified row as it appears in a certification's immutable snapshot.
 * evidenceTier reflects the CURRENT classifier's tiers 1-6
 * (process-trial-balance's classifyAccountTiered + the Phase 2A
 * non-reporting pre-classifier gate), not the future 8-tier ladder.
 */
export interface CertifiedTBRow {
  accountCode: string | null;
  accountName: string;
  nature: AccountNature;
  subNature: string;
  debitBalance: number;
  creditBalance: number;
  netBalance: number;
  evidenceTier: 1 | 2 | 3 | 4 | 5 | 6;
  ruleId: string | null;
  requiresReview: boolean;
}

/**
 * The immutable SAFISHA computation result. Created for every completed
 * engine_run — including one whose classification/math outcome is
 * blocking. This is provenance evidence, not an authority decision; see
 * isDownstreamEligible for the eligibility question.
 */
export interface SafishaCertificationResult {
  certificationId: string;
  companyId: string;
  uploadId: string;
  periodYear: number | null;

  /** Server-observed fingerprint of the exact Storage bytes at certification time. */
  sourceFileHash: string;
  /** Fingerprint of the canonical, normalized accounting input actually processed. */
  normalizedInputHash: string;

  engineRunId: string;
  certifiedAt: string;

  /** L3 (or any hard-block layer) failed — the computation completed, its answer was negative. */
  isBlocking: boolean;
  /** L4 has unresolved accounts — a data-completeness fact, not an organizational approval gate. */
  requiresReview: boolean;

  exceptions: SafishaException[];
  rows: CertifiedTBRow[];

  sourceSystem: SourceSystem;
}

/**
 * Downstream eligibility is DERIVED, never stored as a separate record —
 * exactly one authoritative table (SafishaCertificationResult rows), one
 * predicate over it. A blocking or review-required result is real,
 * persisted, immutable evidence that SAFISHA ran — it is simply not yet
 * usable as input to HESABU/KINGA/MAONO.
 *
 * requires_review is an ACCOUNTING CLASSIFICATION completeness fact
 * (unresolved accounts), not organizational bureaucracy — resolving it
 * means running Phase 2A's existing resolve_account_review_batch, not
 * inventing a competing review workflow.
 */
export function isDownstreamEligible(
  result: Pick<SafishaCertificationResult, "isBlocking" | "requiresReview">,
): boolean {
  return !result.isBlocking && !result.requiresReview;
}
