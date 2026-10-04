/**
 * trialBalanceVerdict — THE presentation model for the trial balance on screen. Every surface that states whether a
 * trial balance is accepted, why it is not, and what to do next reads this module: the Current Trial Balance card, the
 * Trial Balance checks, the technical ledger's failed step, the Overview decision and the workspace state engine's
 * blocked path. Nothing re-derives a verdict on its own, so no two surfaces can disagree.
 *
 * Authority. The verdict comes from the certification readiness (computeCertificationReadiness: the tb_certifications
 * ledger, six layers L1–L6). Upload status only says whether the engine is still running or crashed. Classification
 * coverage is never read from `summary.auto_classified` (Tier 4–5 fuzzy matches only): the certification's L4 layer is
 * the classification verdict, and mapped/needs-review counts come from validation_report.mapping_completeness.
 *
 * Identity. A certification result is only ever applied to the upload it was read for: the reader records the subject
 * (uploadSubjectKey: upload id, version and source-file hash) and the verdict refuses any result whose subject differs
 * from the upload on screen — a late result for a replaced or re-processed upload shows "Checking", never its verdict.
 *
 * Failure precedence (deterministic; first match wins):
 *   1. no upload                                  → none
 *   2. upload status running                      → processing        (no action)
 *   3. upload status "error" (engine failure)     → processing_failed (Retry if active, else Replace)
 *   4. certification subject ≠ upload on screen   → checking          (no action; never a stale verdict)
 *   5. certification verdict:
 *        certified  → accepted     ("Reviewed trial balance": ready for statement preparation; no action. Not an
 *                                   approval of financial statements; supporting-evidence reconciliation is not part of it)
 *        blocked    → blocked      (the failing check, by CHECK_PRECEDENCE: file → amounts → balance → classification;
 *                                   Replace, except a classification-only block → Resolve classifications)
 *        review     → needs_review (Resolve classifications)
 *        superseded → not_current · stale → checking (Retry if active) · unknown → unavailable · otherwise → checking
 *
 * Pure: no I/O, no clock, no randomness. NULL means NOT COMPUTED — never zero, never passed.
 */

import type { PreflightCheck, PreflightCheckState, PreflightVerdict } from "./computePreflight";
import { NOT_AN_APPROVAL, REVIEWED_TRIAL_BALANCE } from "./trialBalanceReadiness";

/**
 * Recorded totals in integer minor units (cents). Every subtraction and comparison is done on these safe integers —
 * never on floating-point amounts. differenceCents = debitCents − creditCents: positive = debit excess, negative =
 * credit excess, zero = equal.
 */
export interface TrialBalanceTotals {
  debitCents: number;
  creditCents: number;
  differenceCents: number;
  /**
   * The tolerance the engine applied when it recorded these totals. Absent (= BALANCE_TOLERANCE_CENTS) for a result
   * from the earlier engine; 0 for a result from the exact ingestion core (processing_result.ingestion), which records
   * exact decimal totals and accepts no difference at all.
   */
  toleranceCents?: number;
  /** ISO 4217 code the exact totals are in, when the engine recorded it. */
  currency?: string;
  /**
   * The currency's minor-unit exponent when it is not 2 (UGX 0, BHD 3, …). When present, debitCents / creditCents /
   * differenceCents are minor units at this exponent, not cents — format with formatTotal().
   */
  exponent?: number;
}

const record = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * One stored amount → integer cents, converted exactly once. Null (refused) unless the value is a finite JSON number
 * (a numeric string is refused, never coerced) whose cents are a non-negative safe integer.
 */
export function toMinorUnits(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const cents = Math.round(v * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

/**
 * The engine's own balance tolerance (process-trial-balance STEP 4: TOLERANCE = 1.00 TZS): a difference of at most
 * 100 cents is balanced, more than 100 cents is out of balance. Matched exactly so the explanation can never disagree
 * with the engine. This arithmetic only EXPLAINS the server's certification verdict — it never grants acceptance and
 * never overrides a refusal (the verdict's status comes from the certification readiness alone).
 */
export const BALANCE_TOLERANCE_CENTS = 100;

/** Independent rounding of the recorded difference may disagree with the cents derived here by at most one cent. */
const RECORDED_DIFFERENCE_SLACK_CENTS = 1;

/**
 * Debit / credit totals as the engine recorded them (processing_result.validation_report.tb_balance_check), in cents.
 * Fail closed — null (NOT COMPUTED) unless: the path is objects all the way; total_debits and total_credits convert
 * to non-negative safe-integer cents (toMinorUnits); and a recorded difference, when present, is a JSON number whose
 * magnitude converts likewise and is within one cent of |debitCents − creditCents| (the engine records it unsigned).
 * One normalisation is recognised: the engine's accepted path records difference: 0 whenever the calculated
 * difference is within its tolerance, so a recorded 0 is valid when |debitCents − creditCents| ≤ 100. An absent
 * difference is derived. Every other mismatch means the totals are unavailable and the certification's own reason is
 * used.
 */
export function readTrialBalanceTotals(processingResult: unknown): TrialBalanceTotals | null {
  const tb = record(record(record(processingResult)?.validation_report)?.tb_balance_check);
  if (!tb) return null;
  // A result from the exact ingestion core is read ONLY from its exact totals (never from the rounded doubles beside them).
  if (tb.exact !== undefined && tb.exact !== null) return readExactTotals(record(tb.exact));
  const debitCents = toMinorUnits(tb.total_debits);
  const creditCents = toMinorUnits(tb.total_credits);
  if (debitCents === null || creditCents === null) return null;
  const differenceCents = debitCents - creditCents;
  if (tb.difference !== undefined && tb.difference !== null) {
    const recordedCents = typeof tb.difference === "number" ? toMinorUnits(Math.abs(tb.difference)) : null;
    const consistent = recordedCents !== null && Math.abs(recordedCents - Math.abs(differenceCents)) <= RECORDED_DIFFERENCE_SLACK_CENTS;
    const acceptedWithinTolerance = recordedCents === 0 && Math.abs(differenceCents) <= BALANCE_TOLERANCE_CENTS;
    if (!consistent && !acceptedWithinTolerance) return null;
  }
  return { debitCents, creditCents, differenceCents };
}

/**
 * "1234.567" at exponent 3 → 1234567 minor units, exactly. The decimal places must not exceed the exponent (the
 * ingestion core never records more); null for anything else or for a value too large to hold exactly.
 */
export function decimalToMinor(v: unknown, exponent: number): number | null {
  if (typeof v !== "string" || !Number.isInteger(exponent) || exponent < 0 || exponent > 6) return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v);
  if (!m || (m[3] ?? "").length > exponent) return null;
  const minor = Number(m[2]) * 10 ** exponent + Number((m[3] ?? "").padEnd(exponent, "0") || "0");
  if (!Number.isSafeInteger(minor)) return null;
  return m[1] === "-" ? -minor : minor;
}

/**
 * Exact totals recorded by the ingestion core (tb_balance_check.exact: decimal strings, currency and its ISO 4217
 * exponent). These carry no tolerance, and are held in the currency's own minor units — 0, 2 or 3 decimal places —
 * so a three-decimal currency is shown exactly, never rounded to cents. A result without a recorded exponent is read
 * at two places only if every value has at most two; otherwise it is refused (null) and the certification's own
 * reason is used instead.
 */
function readExactTotals(exact: Record<string, unknown> | null): TrialBalanceTotals | null {
  if (!exact) return null;
  const recorded = exact.currency_exponent;
  const exponent = typeof recorded === "number" && Number.isInteger(recorded) ? recorded : 2;
  const debitCents = decimalToMinor(exact.total_debits, exponent);
  const creditCents = decimalToMinor(exact.total_credits, exponent);
  if (debitCents === null || creditCents === null || debitCents < 0 || creditCents < 0) return null;
  const totals: TrialBalanceTotals = { debitCents, creditCents, differenceCents: debitCents - creditCents, toleranceCents: 0 };
  if (exponent !== 2) totals.exponent = exponent;
  if (typeof exact.currency === "string" && /^[A-Z]{3}$/.test(exact.currency)) totals.currency = exact.currency;
  return totals;
}

/**
 * Minor units → grouped decimal text at the given exponent, e.g. (1234567, 3) → "1,234.567"; (1500, 0) → "1,500".
 * Integer arithmetic only; a non-safe-integer input is refused rather than rounded.
 */
export function formatMinorUnits(minor: number, exponent: number): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError("formatMinorUnits: not a safe integer");
  const abs = Math.abs(minor);
  const scale = 10 ** exponent;
  const whole = String((abs - (abs % scale)) / scale).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = exponent > 0 ? `.${String(abs % scale).padStart(exponent, "0")}` : "";
  return `${minor < 0 ? "-" : ""}${whole}${fraction}`;
}

/** One of a totals' amounts, formatted at the totals' own exponent (two decimal places unless recorded otherwise). */
export function formatTotal(totals: TrialBalanceTotals, minor: number): string {
  return formatMinorUnits(minor, totals.exponent ?? 2);
}

/** The identity a certification result is bound to: upload id, optimistic-concurrency version and source-file hash. */
export function uploadSubjectKey(upload: { id: string; version?: number | null; source_file_hash?: string | null } | null | undefined): string | null {
  return upload ? `${upload.id}|${upload.version ?? ""}|${upload.source_file_hash ?? ""}` : null;
}

/** The order in which a failing check is named (earlier = more fundamental). */
export const CHECK_PRECEDENCE = ["l1_structure", "l2_data_quality", "l3_arithmetic", "l4_classification"] as const;

/**
 * 1,250,000.00 from 125000000 cents — grouped, two decimals, no currency symbol (the workspace currency is shown
 * elsewhere). Integer string arithmetic only; a non-safe-integer input is refused rather than rounded.
 */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError("formatCents: not a safe integer number of cents");
  const abs = Math.abs(cents);
  const whole = String((abs - (abs % 100)) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

export const WITHIN_TOLERANCE_TEXT = "Accepted — within the TZS 1.00 tolerance";

/**
 * How the difference reads when the totals are within the engine's tolerance: exactly zero → "Balanced"; 1–100 cents
 * → "Accepted — within the TZS 1.00 tolerance". Null when the totals are unknown or out of balance.
 */
export function balanceStatement(totals: TrialBalanceTotals | null): string | null {
  if (!totals || isOutOfBalance(totals)) return null;
  return totals.differenceCents === 0 ? "Balanced" : WITHIN_TOLERANCE_TEXT;
}

/** True when the recorded totals differ by more than the tolerance the engine applied (none for exact totals). */
export function isOutOfBalance(totals: TrialBalanceTotals | null): boolean {
  return !!totals && Math.abs(totals.differenceCents) > (totals.toleranceCents ?? BALANCE_TOLERANCE_CENTS);
}

// ── What the ingestion core recorded (processing_result.ingestion) ────────────────────────────────────────────────────

export interface TrialBalanceIssue {
  code: string;
  message: string;
  rows: number[];
}

/** The blocking issues the server recorded for this file, each already a plain sentence naming its rows. */
export function readIngestionIssues(processingResult: unknown): TrialBalanceIssue[] {
  const issues = record(record(processingResult)?.ingestion)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((i) => {
    const r = record(i);
    if (!r || r.severity !== "blocking" || typeof r.code !== "string" || typeof r.message !== "string") return [];
    const rows = Array.isArray(r.rows) ? r.rows.filter((n): n is number => Number.isInteger(n)) : [];
    return [{ code: r.code, message: r.message, rows }];
  });
}

export type MilestoneState = "passed" | "failed" | "needs_review" | "not_reached";

export interface TrialBalanceMilestone {
  id: string;
  label: string;
  status: MilestoneState;
  detail: string | null;
}

const MILESTONE_STATES = new Set<MilestoneState>(["passed", "failed", "needs_review", "not_reached"]);

/** The milestones the check actually reached, in order, as the server recorded them. Empty for an earlier engine. */
export function readMilestones(processingResult: unknown): TrialBalanceMilestone[] {
  const list = record(record(processingResult)?.ingestion)?.milestones;
  if (!Array.isArray(list)) return [];
  return list.flatMap((m) => {
    const r = record(m);
    if (!r || typeof r.id !== "string" || typeof r.label !== "string" || !MILESTONE_STATES.has(r.status as MilestoneState)) return [];
    return [{ id: r.id, label: r.label, status: r.status as MilestoneState, detail: typeof r.detail === "string" ? r.detail : null }];
  });
}

/** Removes engine codes ("NOT_EVALUATED: …", "L3_TB_IMBALANCE: …") from a message; never invents text. */
export function stripEngineCode(message: string): string {
  return message.replace(/^[A-Z][A-Z0-9_]{2,}:\s*/, "").trim();
}

/**
 * The one plain-English sentence for a blocked trial balance. An arithmetic imbalance is stated from the recorded
 * totals; anything else uses the certification's own reason, without engine codes.
 */
export function plainBlockReason(args: { blocker: string | null | undefined; totals: TrialBalanceTotals | null; failedCheckId?: string | null }): string {
  const arithmetic = args.failedCheckId === undefined || args.failedCheckId === null || args.failedCheckId === "l3_arithmetic";
  if (arithmetic && args.totals && isOutOfBalance(args.totals)) {
    const higher = args.totals.differenceCents > 0 ? "Debits" : "Credits";
    return `${higher} exceed ${higher === "Debits" ? "credits" : "debits"} by ${formatTotal(args.totals, Math.abs(args.totals.differenceCents))}. Correct the file and replace it.`;
  }
  if (args.blocker && args.blocker.trim()) return stripEngineCode(args.blocker);
  return "The trial balance did not pass its checks.";
}

export type TrialBalanceStatus =
  | "none"
  | "processing"
  | "checking"
  | "processing_failed"
  | "blocked"
  | "needs_review"
  | "accepted"
  | "not_current"
  | "unavailable";

export type TrialBalanceTone = "neutral" | "danger" | "warning" | "success";

export type TrialBalancePrimaryAction =
  | { kind: "replace"; label: "Replace with corrected Trial Balance" }
  | { kind: "retry"; label: "Retry processing" }
  | { kind: "review_classifications"; label: "Resolve account classifications" };

export interface TrialBalanceCheck {
  id: string;
  label: string;
  state: PreflightCheckState;
  detail: string;
}

export interface TrialBalanceVerdict {
  status: TrialBalanceStatus;
  /** Accounting words only: Accepted, Blocked, Needs review, Processing, Could not be processed, … */
  statusLabel: string;
  tone: TrialBalanceTone;
  /** One plain-English sentence: why, or what happens next. */
  reason: string;
  totals: TrialBalanceTotals | null;
  /** The four checks that decide acceptance, in order (file, amounts, balance, classification). */
  checks: TrialBalanceCheck[];
  /** For information only; they never decide acceptance. */
  informational: TrialBalanceCheck[];
  /** The first check that failed or needs review, or null. */
  failedCheckId: string | null;
  /**
   * "Balanced" / "Accepted — within the TZS 1.00 tolerance", stated only when the certification's own arithmetic check
   * (L3) passed for this upload — the local cents never state balance on their own. Null otherwise.
   */
  balanceStatement: string | null;
  primaryAction: TrialBalancePrimaryAction | null;
  /** What to correct in the file, row by row — shown when the trial balance is blocked. */
  issues: TrialBalanceIssue[];
  /** What the check actually did, as the server recorded it (empty for an earlier engine). */
  milestones: TrialBalanceMilestone[];
}

export interface TrialBalanceVerdictInput {
  upload: {
    id?: string;
    version?: number | null;
    source_file_hash?: string | null;
    status?: string | null;
    processing_result?: unknown;
  } | null;
  /** computeCertificationReadiness(...) for the upload on screen (undefined while no upload). */
  readiness: { verdict: PreflightVerdict; blocker: string | null; checks: PreflightCheck[] } | undefined;
  /**
   * uploadSubjectKey() of the upload the readiness was READ for (useCertificationReadiness().subjectKey). When given and
   * different from the upload on screen, the readiness is refused (a late or stale result). Omitted only where the
   * readiness and the upload come from one atomic read (the workspace snapshot).
   */
  readinessSubject?: string | null;
  /** canReprocessUpload(upload): only an active upload may be re-run. */
  canRetry: boolean;
}

const RUNNING = new Set(["pending", "processing", "queued", "validating"]);

const CHECK_TEXT: Record<string, { label: string; passed: string }> = {
  l1_structure: { label: "File read", passed: "Every row was read and totalled." },
  l2_data_quality: { label: "Amounts are valid", passed: "Every amount is a valid number." },
  l3_arithmetic: { label: "Debits equal credits", passed: "Total debits equal total credits." },
  l4_classification: { label: "Every account classified", passed: "Every account has a classification." },
};
const INFO_TEXT: Record<string, string> = {
  l5_supporting_evidence: "Bank and mobile-money evidence",
  l6_prior_period: "Comparison with the prior year",
};

function plainCheck(c: PreflightCheck, totals: TrialBalanceTotals | null): TrialBalanceCheck {
  const text = CHECK_TEXT[c.id];
  const label = text?.label ?? INFO_TEXT[c.id] ?? c.label;
  let detail = c.detail;
  if (c.state === "passed" && c.id === "l3_arithmetic" && totals && totals.differenceCents !== 0 && !isOutOfBalance(totals)) detail = `${WITHIN_TOLERANCE_TEXT}.`;
  else if (c.state === "passed" && text) detail = text.passed;
  else if (/NO_PRIOR/.test(c.detail)) detail = "No accepted prior-year trial balance to compare with.";
  else if (c.id === "l5_supporting_evidence" && (c.state === "pending" || /NOT_EVALUATED|NO_EVIDENCE/.test(c.detail))) detail = "Not required for a reviewed trial balance.";
  else if (c.state === "pending" || /NOT_EVALUATED/.test(c.detail)) detail = "Waiting for processing to finish.";
  else if (c.id === "l3_arithmetic" && totals && isOutOfBalance(totals)) {
    detail = `Debits ${formatTotal(totals, totals.debitCents)} and credits ${formatTotal(totals, totals.creditCents)} differ by ${formatTotal(totals, Math.abs(totals.differenceCents))}.`;
  } else detail = stripEngineCode(c.detail);
  // Supporting evidence that was never evaluated is shown as not checked — never "Passed" — and is not required for a
  // reviewed trial balance (the layer is informational; it never decides acceptance).
  const unevaluatedEvidence = c.id === "l5_supporting_evidence" && (c.state === "pending" || /NOT_EVALUATED|NO_EVIDENCE/.test(c.detail));
  return { id: c.id, label, state: unevaluatedEvidence ? "pending" : c.state, detail };
}

export function deriveTrialBalanceVerdict(input: TrialBalanceVerdictInput): TrialBalanceVerdict {
  const upload = input.upload;
  const totals = upload ? readTrialBalanceTotals(upload.processing_result) : null;
  const subjectMismatch = !!upload?.id && input.readinessSubject !== undefined
    && input.readinessSubject !== uploadSubjectKey({ id: upload.id, version: upload.version, source_file_hash: upload.source_file_hash });
  // A result read for another upload (or an earlier version of this one) is never shown as this upload's checks.
  const layerChecks = subjectMismatch ? [] : input.readiness?.checks ?? [];
  const checks = CHECK_PRECEDENCE.flatMap((id) => layerChecks.filter((c) => c.id === id)).map((c) => plainCheck(c, totals));
  const informational = layerChecks.filter((c) => c.id in INFO_TEXT).map((c) => plainCheck(c, totals));
  const failed = checks.find((c) => c.state === "failed") ?? checks.find((c) => c.state === "review") ?? null;
  const l3Passed = checks.some((c) => c.id === "l3_arithmetic" && c.state === "passed");
  const issues = upload ? readIngestionIssues(upload.processing_result) : [];
  const milestones = upload ? readMilestones(upload.processing_result) : [];
  const base = { totals, checks, informational, failedCheckId: failed?.id ?? null, balanceStatement: l3Passed ? balanceStatement(totals) : null, issues: [] as TrialBalanceIssue[], milestones };

  if (!upload) {
    return { ...base, status: "none", statusLabel: "No trial balance", tone: "neutral", reason: "Upload a trial balance to begin.", primaryAction: null };
  }
  const status = upload.status ?? "";
  if (RUNNING.has(status)) {
    return { ...base, status: "processing", statusLabel: "Processing", tone: "neutral", reason: "The checks are running. This page updates itself.", primaryAction: null };
  }
  if (status === "error") {
    return {
      ...base, status: "processing_failed", statusLabel: "Could not be processed", tone: "danger",
      reason: "Processing stopped before the checks could finish. Nothing about the figures has been decided.",
      primaryAction: input.canRetry ? { kind: "retry", label: "Retry processing" } : { kind: "replace", label: "Replace with corrected Trial Balance" },
    };
  }

  if (subjectMismatch) {
    return { ...base, status: "checking", statusLabel: "Checking", tone: "neutral", reason: "The result for this file is being confirmed.", primaryAction: null };
  }

  const verdict = input.readiness?.verdict;
  switch (verdict) {
    case "certified":
      return {
        ...base, status: "accepted", statusLabel: "Reviewed", tone: "success",
        reason: `${REVIEWED_TRIAL_BALANCE}: every check passed and every account classification is confirmed. It is ready for statement preparation. ${NOT_AN_APPROVAL}`,
        primaryAction: null,
      };
    case "blocked":
      return {
        ...base, status: "blocked", statusLabel: "Blocked", tone: "danger", issues,
        reason: plainBlockReason({ blocker: input.readiness?.blocker, totals, failedCheckId: failed?.id ?? null }),
        // A block that is only about classification is fixed by classification decisions, not by a new file.
        primaryAction: failed?.id === "l4_classification"
          ? { kind: "review_classifications", label: "Resolve account classifications" }
          : { kind: "replace", label: "Replace with corrected Trial Balance" },
      };
    case "review":
      return {
        ...base, status: "needs_review", statusLabel: "Needs review", tone: "warning",
        reason: stripEngineCode(input.readiness?.blocker ?? "Some accounts need a classification decision."),
        primaryAction: { kind: "review_classifications", label: "Resolve account classifications" },
      };
    case "superseded":
      return { ...base, status: "not_current", statusLabel: "Not current", tone: "neutral", reason: "An older trial balance. Another upload is the current one for this period.", primaryAction: null };
    case "stale":
      return {
        ...base, status: "checking", statusLabel: "Needs re-check", tone: "warning",
        reason: "This trial balance has no current certification. Re-run processing to check it again.",
        primaryAction: input.canRetry ? { kind: "retry", label: "Retry processing" } : null,
      };
    case "unknown":
      return { ...base, status: "unavailable", statusLabel: "Status unavailable", tone: "warning", reason: "The result could not be read. Refresh to try again.", primaryAction: null };
    default:
      return { ...base, status: "checking", statusLabel: "Checking", tone: "neutral", reason: "The result is being confirmed.", primaryAction: null };
  }
}

// ── Upload history (read-only list in Prepare Data) ─────────────────────────────────────────────────────────────────

export interface HistoryUpload {
  id: string;
  file_name: string;
  uploaded_at: string;
  status?: string | null;
  lifecycle_state?: string | null;
}

const ACTIVE = new Set(["active_unprocessed", "active_processing", "active_processed", "blocked"]);

/** Lifecycle in words. Unknown lifecycle is never guessed as "current". */
export function lifecycleLabel(u: HistoryUpload, currentId: string | null): string {
  if (u.lifecycle_state === "superseded") return "Replaced";
  if (u.lifecycle_state === "retired") return "Removed from active use";
  if (u.lifecycle_state === "discard_pending") return "Being removed";
  if (u.lifecycle_state && ACTIVE.has(u.lifecycle_state)) return u.id === currentId ? "Current" : "Active";
  return u.id === currentId ? "Current" : "Earlier upload";
}

/** The engine's recorded result for the row, in accounting words. */
export function resultLabel(status: string | null | undefined): string {
  switch (status) {
    case "complete": return "Checks passed";
    case "blocked": return "Blocked";
    case "needs_review": return "Needs review";
    case "error": return "Could not be processed";
    case "pending": case "processing": case "queued": case "validating": return "Processing";
    default: return "Not processed";
  }
}
