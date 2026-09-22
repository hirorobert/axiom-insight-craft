/**
 * classificationPresentation.ts — pure, deterministic presentation model for the Prepare Data classification outcome.
 *
 * Converts an upload's DB `status` column and its raw `processing_result` JSON into one typed, exhaustive presentation
 * result. This is the ONLY place that interprets those two inputs into a classification narrative — WorkspaceOverview
 * (and anything else) reads the result, it never re-derives the meaning itself (see countUnresolved(), removed).
 *
 * Contract: no React, no Supabase, no navigation, no side effects, no mutation, no `any`, no silent normalisation of
 * corrupt input. NULL (or an absent field) always means NOT COMPUTED — it is never substituted with 0.
 *
 * ── DATA LINEAGE (independently verified against supabase/functions/process-trial-balance/index.ts) ─────────────────
 * `summary.requires_review` and `summary.unclassified` — named in earlier product notes for this feature — do not exist
 * anywhere in this codebase; they are not real fields. The real, load-bearing fields are:
 *
 *   trial_balance_uploads.status                                 "processing" | "needs_review" | "blocked" | "error"
 *                                                                 | "complete" (the DB row's own column; index.ts:1453,
 *                                                                 1553/1676/1724, 1933-1939, 2020-2027). Never "validating"
 *                                                                 by the time a result is readable here — see below.
 *   processing_result.summary.total_accounts                     rawAccounts.length — every parsed row (index.ts:1990,
 *                                                                 1907, 1892). Includes classified, needs-review AND
 *                                                                 non-reporting (suppressed) accounts.
 *   processing_result.summary.auto_classified                    Tier 4-5 ONLY (index.ts:1855: `if (result.confidence_source
 *                                                                 !== "mapping") autoClassifiedCount++`). Excludes every
 *                                                                 Tier 1-3 account_mappings hit — including a mapping a
 *                                                                 professional just approved in Account Review and that was
 *                                                                 picked up on THIS reprocess. Proven NOT auto-only-safe as a
 *                                                                 "total classified" figure: never use it as one.
 *   processing_result.validation_report.mapping_completeness
 *     .mapped_accounts                                           resolvedMappings.size — every Tier 1-5 account, i.e. every
 *                                                                 account that reached a real classification, mapped OR
 *                                                                 auto (index.ts:1893, 1972). THIS is "classified" for the
 *                                                                 UI. Computed identically whether the run ends
 *                                                                 needs_review or clean (rawAccounts.length - needsReview -
 *                                                                 nonReporting === resolvedMappings.size by construction —
 *                                                                 those three sets partition every parsed account).
 *     .needs_review                                               needsReviewAccounts.length (index.ts:1894) — the same
 *                                                                  number as the `needs_review_accounts` array's length.
 *   processing_result.needs_review_accounts (array)                Present, and non-empty, on every row whose DB status is
 *                                                                   "needs_review" — the ONLY code path that sets that
 *                                                                   status guards it with `needsReviewAccounts.length > 0`
 *                                                                   (index.ts:1879). Its .length is the authoritative
 *                                                                   review count when present.
 *
 * Answers to the six required questions (traced end-to-end, not merely inspected):
 *   1. Does auto_classified count only accounts classified WITHOUT human intervention?
 *        Yes for THIS run — it is incremented only for confidence_source !== "mapping" (Tier 4-5).
 *   2. Are manual review decisions ever added to it?
 *        No. resolve_account_review_batch() (20260816120000_account_review_authority.sql) writes only to
 *        account_mappings / account_review_decisions / its own audit trail — never to trial_balance_uploads or any
 *        processing_result field. A saved review decision is picked up on the NEXT engine run (AccountReviewPanel.tsx:
 *        "Save & Reprocess" sets status:"processing", processing_result:null, then re-invokes process-trial-balance) and,
 *        once picked up, classifies via Tier 1 (confidence_source "mapping") — so it lands in mapped_accounts but is
 *        explicitly EXCLUDED from auto_classified by the same `!== "mapping"` guard.
 *   3. Is it immutable after engine processing?
 *        Each run's summary is an atomic snapshot written in one `.update()` (index.ts:1933 / 2020) — immutable for
 *        that run, but a later run overwrites the whole object, which is correct (not a mutation of the same fact).
 *   4. Can retries overwrite it?
 *        Yes, and every retry path this repository has clears it in the SAME write as the status flip to "processing" —
 *        WorkspaceOverview.tsx's own handleRetryProcessing, AccountReviewPanel.tsx's Save & Reprocess, and
 *        UploadsStatusPanel.tsx's retry — so a reader can never observe status:"processing" alongside a stale non-null
 *        processing_result from a currently-in-flight run. This module still treats PROCESSING as overriding any counts
 *        regardless (see precedence), so a legacy or hand-edited row that violates this invariant still fails safe.
 *   5. Can legacy rows omit it, or mean something else?
 *        mapping_completeness.mapped_accounts is preferred; computePreflight.ts's own existing fallback
 *        (`mc?.mapped_accounts ?? mc?.auto_classified`) proves older rows can omit mapped_accounts. This module does NOT
 *        borrow that fallback: auto_classified has different (narrower) semantics, so silently substituting it here would
 *        under-count and mislabel Tier 1-3 accounts as unclassified. A row missing mapped_accounts fails closed to
 *        NOT_COMPUTED instead.
 *   6. Is it authoritative or merely informational?
 *        auto_classified is informational only everywhere it is read outside this engine (an "Auto-classified: N" diagnostic
 *        line in UploadsStatusPanel/CertificationSummaryStrip/ExportStatements/TrialBalanceProgressLedger) — nothing gates
 *        on it. mapped_accounts and needs_review_accounts ARE authoritative: they are exactly what determines whether the
 *        DB row's own status is "needs_review", and what the review screen itself reads.
 *
 * RULE APPLIED: because "classified" here means mapped_accounts (Tier 1-5, mapped AND auto), never auto_classified alone,
 * every string in this module says "classified" — never "automatically classified" or "auto-classified".
 */

// ── Public types ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Required precedence (checked in this order — a higher-precedence state always wins): */
export type ClassificationState =
  | "FAILED" // 1 — terminal engine failure; overrides any counts, even complete-looking ones
  | "PROCESSING" // 2 — engine currently running; overrides any stale counts
  | "INCONSISTENT" // 3 — impossible values or an impossible status/count combination; fails closed
  | "COMPLETE_WITH_REVIEW" // 4 — every account processed; the DB status confirms review items remain
  | "PARTIAL" // 5 — a known, positive review count exists, but the DB status does not itself confirm it
  | "COMPLETE_NO_REVIEW" // 6 — every known account is classified; nothing is known to need review
  | "NOT_COMPUTED"; // 7 — no authoritative result yet (the fail-closed default)

export type ClassificationPrimaryAction =
  | "RETRY_PROCESSING"
  | "REVIEW_ACCOUNTS"
  | "OPEN_PREPARE_DATA"
  | "NONE";

export type ClassificationSecondaryAction = "REPLACE_FILE" | "NONE";

/** Internal diagnostic tag, safe to log — never shown to the person using the product. Populated for the three
 *  non-terminal-success states only; the four count-bearing states need no explanation beyond their own numbers. */
export type ClassificationReasonCode =
  | "UPLOAD_STATUS_FAILED"
  | "UPLOAD_STATUS_PROCESSING"
  | "MALFORMED_FIELD_TYPE"
  | "IMPOSSIBLE_COUNTS"
  | "STATUS_NEEDS_REVIEW_BUT_REVIEW_COUNT_IS_ZERO"
  | "STATUS_COMPLETE_BUT_REVIEW_COUNT_IS_POSITIVE"
  | "NO_AUTHORITATIVE_RESULT";

export interface ClassificationCounts {
  /** Every parsed account (summary.total_accounts): classified + review-required + non-reporting. */
  readonly total: number;
  /** Accounts with a confirmed Tier 1-5 classification (validation_report.mapping_completeness.mapped_accounts). */
  readonly classified: number;
  /** Accounts known to require professional review. Never a guess — see module doc. */
  readonly reviewRequired: number;
}

export interface ClassificationPresentation {
  readonly state: ClassificationState;
  /** The primary status sentence. Never invents a percentage, an ETA, or a claim of finality/certification. */
  readonly headline: string;
  /** A supplementary sentence — the call to action, or "" when the headline needs none. */
  readonly detail: string;
  readonly primaryAction: ClassificationPrimaryAction;
  readonly secondaryAction: ClassificationSecondaryAction;
  readonly reasonCode: ClassificationReasonCode | null;
  /** Populated only for the three states whose headline reports real numbers. Null everywhere else — never a fabricated 0. */
  readonly counts: ClassificationCounts | null;
}

// ── Formatting ────────────────────────────────────────────────────────────────────────────────────────────────────────

const fmt = (n: number): string => n.toLocaleString("en-US");
const noun = (n: number): string => (n === 1 ? "account" : "accounts");

// ── Field extraction — "absent" (NULL/missing ⇒ NOT COMPUTED) is kept distinct from "invalid" (present but corrupt) ────

type FieldReading = { readonly kind: "absent" } | { readonly kind: "invalid" } | { readonly kind: "value"; readonly n: number };

function readNumberField(container: unknown, key: string): FieldReading {
  if (typeof container !== "object" || container === null) return { kind: "absent" };
  const obj = container as Record<string, unknown>;
  const v = obj[key];
  if (v === undefined || v === null) return { kind: "absent" };
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) return { kind: "invalid" };
  return { kind: "value", n: v };
}

interface ExtractedFields {
  readonly total: FieldReading;
  readonly classified: FieldReading;
  readonly reviewRequired: FieldReading;
}

function extract(processingResult: unknown): ExtractedFields {
  if (typeof processingResult !== "object" || processingResult === null) {
    return { total: { kind: "absent" }, classified: { kind: "absent" }, reviewRequired: { kind: "absent" } };
  }
  const pr = processingResult as Record<string, unknown>;
  const total = readNumberField(pr.summary, "total_accounts");

  const validationReport = typeof pr.validation_report === "object" && pr.validation_report !== null ? (pr.validation_report as Record<string, unknown>) : null;
  const mappingCompleteness = validationReport && typeof validationReport.mapping_completeness === "object" && validationReport.mapping_completeness !== null ? (validationReport.mapping_completeness as Record<string, unknown>) : null;
  const classified = readNumberField(mappingCompleteness, "mapped_accounts");

  // The authoritative review array wins when present (it is what the review screen itself reads); its length is a
  // structurally-guaranteed non-negative integer, never "invalid". Fall back to the numeric field only when the array
  // itself is absent from the payload (an older/legacy shape).
  const reviewRequired: FieldReading = Array.isArray(pr.needs_review_accounts) ? { kind: "value", n: pr.needs_review_accounts.length } : readNumberField(mappingCompleteness, "needs_review");

  return { total, classified, reviewRequired };
}

// ── Result builders ───────────────────────────────────────────────────────────────────────────────────────────────────

const FAILED_RESULT: ClassificationPresentation = {
  state: "FAILED",
  headline: "The trial balance could not be processed.",
  detail: "Re-run processing, or replace the file in Prepare Data.",
  primaryAction: "RETRY_PROCESSING",
  secondaryAction: "REPLACE_FILE",
  reasonCode: "UPLOAD_STATUS_FAILED",
  counts: null,
};

const PROCESSING_RESULT: ClassificationPresentation = {
  state: "PROCESSING",
  headline: "Trial balance is processing.",
  detail: "This screen updates itself. The run continues on the server if you leave the page.",
  primaryAction: "NONE",
  secondaryAction: "NONE",
  reasonCode: "UPLOAD_STATUS_PROCESSING",
  counts: null,
};

const NOT_COMPUTED_RESULT: ClassificationPresentation = {
  state: "NOT_COMPUTED",
  headline: "Classification results are not available yet.",
  detail: "",
  primaryAction: "OPEN_PREPARE_DATA",
  secondaryAction: "NONE",
  reasonCode: "NO_AUTHORITATIVE_RESULT",
  counts: null,
};

function inconsistent(reasonCode: ClassificationReasonCode): ClassificationPresentation {
  return {
    state: "INCONSISTENT",
    headline: "Classification status is unavailable.",
    detail: "Review the uploaded file.",
    primaryAction: "OPEN_PREPARE_DATA",
    secondaryAction: "REPLACE_FILE",
    reasonCode,
    counts: null,
  };
}

function completeWithReview(classified: number, total: number, review: number): ClassificationPresentation {
  return {
    state: "COMPLETE_WITH_REVIEW",
    headline: `${fmt(classified)} of ${fmt(total)} ${noun(total)} classified.`,
    detail: `Review ${fmt(review)} flagged ${noun(review)} to continue.`,
    primaryAction: "REVIEW_ACCOUNTS",
    secondaryAction: "REPLACE_FILE",
    reasonCode: null,
    counts: { total, classified, reviewRequired: review },
  };
}

function partial(classified: number, total: number, review: number): ClassificationPresentation {
  return {
    state: "PARTIAL",
    headline: `${fmt(classified)} of ${fmt(total)} ${noun(total)} classified.`,
    detail: `Review the remaining ${fmt(review)} ${noun(review)}.`,
    primaryAction: "REVIEW_ACCOUNTS",
    secondaryAction: "REPLACE_FILE",
    reasonCode: null,
    counts: { total, classified, reviewRequired: review },
  };
}

function completeNoReview(classified: number, total: number): ClassificationPresentation {
  return {
    state: "COMPLETE_NO_REVIEW",
    headline: `${fmt(classified)} of ${fmt(total)} ${noun(total)} classified. No review required.`,
    detail: "",
    primaryAction: "OPEN_PREPARE_DATA",
    secondaryAction: "NONE",
    reasonCode: null,
    counts: { total, classified, reviewRequired: 0 },
  };
}

// ── Main export ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Pure, deterministic, exhaustively typed. `uploadStatus` is the trial_balance_uploads.status column exactly as stored
 * (or null/undefined for no upload); `processingResult` is the raw processing_result JSON exactly as stored.
 */
export function deriveClassificationPresentation(uploadStatus: string | null | undefined, processingResult: unknown): ClassificationPresentation {
  // ── 1. FAILED — a terminal engine failure overrides any counts, including stale complete-looking ones. ──────────────
  if (uploadStatus === "blocked" || uploadStatus === "error") return FAILED_RESULT;

  // ── 2. PROCESSING — the engine is currently running; any counts in this read are necessarily stale. ─────────────────
  if (uploadStatus === "processing" || uploadStatus === "pending" || uploadStatus === "queued") return PROCESSING_RESULT;

  const fields = extract(processingResult);

  // ── 3a. INCONSISTENT — a present field with a corrupt type (not a number, fractional, or non-finite). ───────────────
  // Checked before "absent", so a genuinely corrupt value is never swallowed into the "no data yet" reading.
  if (fields.total.kind === "invalid" || fields.classified.kind === "invalid" || fields.reviewRequired.kind === "invalid") {
    return inconsistent("MALFORMED_FIELD_TYPE");
  }

  // ── 7 (early exit). NOT_COMPUTED — no authoritative denominator or numerator to reason about at all. ─────────────────
  if (fields.total.kind === "absent" || fields.classified.kind === "absent") return NOT_COMPUTED_RESULT;

  const total = fields.total.n;
  const classified = fields.classified.n;
  const review = fields.reviewRequired.kind === "value" ? fields.reviewRequired.n : null; // null = genuinely unknown, never treated as 0

  // ── 3b. INCONSISTENT — impossible values or an impossible status/count combination. ────────────────────────────────
  if (
    total < 0 ||
    classified < 0 ||
    (review !== null && review < 0) ||
    classified > total ||
    (review !== null && review > total) ||
    (review !== null && classified + review > total)
  ) {
    return inconsistent("IMPOSSIBLE_COUNTS");
  }
  // The producer only ever sets status "needs_review" when at least one account genuinely needs review; a row claiming
  // that status with an authoritatively-known review count of zero contradicts its own invariant.
  if (uploadStatus === "needs_review" && review === 0) return inconsistent("STATUS_NEEDS_REVIEW_BUT_REVIEW_COUNT_IS_ZERO");
  // Symmetrically, "complete" is only ever written once needsReviewAccounts.length === 0 in that same run.
  if (uploadStatus === "complete" && review !== null && review > 0) return inconsistent("STATUS_COMPLETE_BUT_REVIEW_COUNT_IS_POSITIVE");

  // A zero-account parse is degenerate, not a useful computed result — nothing to classify, nothing to report.
  if (total === 0) return NOT_COMPUTED_RESULT;

  // ── 4. COMPLETE_WITH_REVIEW — the DB status itself confirms review is required, and the count is known (and, by the
  //      contradiction guard above, positive). ─────────────────────────────────────────────────────────────────────
  if (uploadStatus === "needs_review") {
    // review === null here would mean the status claims a review is needed but no source in this payload says how many —
    // an ambiguity this module will not guess through. Fail closed rather than either overclaim completion or invent a count.
    if (review === null) return NOT_COMPUTED_RESULT;
    return completeWithReview(classified, total, review);
  }

  // ── 5. PARTIAL — a positive review count is authoritatively known even though the status string does not itself say
  //      "needs_review" (an older status convention, or a status this module does not specifically recognise). The
  //      number shown is always a number this module actually has — never an inferred gap. ─────────────────────────
  if (review !== null && review > 0) return partial(classified, total, review);

  // ── 6. COMPLETE_NO_REVIEW — every known account is classified, or the status explicitly says the run is complete
  //      (a classified < total gap in that case is accounted for entirely by accounts excluded as non-reporting, never
  //      by anything left to review — see module doc, §"Can legacy rows..."). ────────────────────────────────────────
  if (classified === total || uploadStatus === "complete") return completeNoReview(classified, total);

  // ── 7. NOT_COMPUTED — classified < total, nothing is known to require review, and the status confirms neither
  //      completion nor an outstanding review. Whether this gap is settled cannot be established honestly. ────────────
  return NOT_COMPUTED_RESULT;
}
