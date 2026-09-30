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
 * Pure: no I/O, no clock, no randomness. NULL means NOT COMPUTED — never zero, never passed.
 */

import type { PreflightCheck, PreflightCheckState, PreflightVerdict } from "./computePreflight";

export interface TrialBalanceTotals {
  debits: number;
  credits: number;
  difference: number;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Debit / credit totals exactly as the engine recorded them (validation_report.tb_balance_check). null = not computed. */
export function readTrialBalanceTotals(processingResult: unknown): TrialBalanceTotals | null {
  const pr = processingResult && typeof processingResult === "object" ? (processingResult as Record<string, unknown>) : null;
  const report = pr?.validation_report && typeof pr.validation_report === "object" ? (pr.validation_report as Record<string, unknown>) : null;
  const tb = report?.tb_balance_check && typeof report.tb_balance_check === "object" ? (report.tb_balance_check as Record<string, unknown>) : null;
  if (!tb) return null;
  const debits = finite(tb.total_debits);
  const credits = finite(tb.total_credits);
  if (debits === null || credits === null) return null;
  const difference = finite(tb.difference) ?? Math.round((debits - credits) * 100) / 100;
  return { debits, credits, difference };
}

/** 174,776,903,504.08 — grouped, two decimals, no currency symbol (the workspace currency is shown elsewhere). */
export function formatAmount(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const OUT_OF_BALANCE_TOLERANCE = 0.005;

/** True when the recorded totals show debits and credits do not agree. */
export function isOutOfBalance(totals: TrialBalanceTotals | null): boolean {
  return !!totals && Math.abs(totals.difference) >= OUT_OF_BALANCE_TOLERANCE;
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
    const higher = args.totals.debits > args.totals.credits ? "Debits" : "Credits";
    return `${higher} exceed ${higher === "Debits" ? "credits" : "debits"} by ${formatAmount(Math.abs(args.totals.difference))}. Correct the file and replace it.`;
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
  | { kind: "review_classifications"; label: "Resolve account classifications" }
  | { kind: "verify_evidence"; label: "Verify against bank and mobile-money evidence" }
  | { kind: "continue"; label: "Continue to Reconcile" };

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
  primaryAction: TrialBalancePrimaryAction | null;
  /** Evidence verification may be offered only when the trial balance is accepted (it stays mandatory before tax). */
  evidenceUnlocked: boolean;
  /** Evidence verification is already complete for this upload. */
  evidenceCleared: boolean;
}

export interface TrialBalanceVerdictInput {
  upload: {
    status?: string | null;
    processing_result?: unknown;
    safisha_status?: string | null;
  } | null;
  /** computeCertificationReadiness(...) for the upload on screen (undefined while no upload). */
  readiness: { verdict: PreflightVerdict; blocker: string | null; checks: PreflightCheck[] } | undefined;
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
  if (c.state === "passed" && text) detail = text.passed;
  else if (/NO_PRIOR/.test(c.detail)) detail = "No accepted prior-year trial balance to compare with.";
  else if (c.id === "l5_supporting_evidence" && (c.state === "pending" || /NOT_EVALUATED/.test(c.detail))) detail = "Matched after the trial balance is accepted.";
  else if (c.state === "pending" || /NOT_EVALUATED/.test(c.detail)) detail = "Waiting for processing to finish.";
  else if (c.id === "l3_arithmetic" && totals && isOutOfBalance(totals)) {
    detail = `Debits ${formatAmount(totals.debits)} and credits ${formatAmount(totals.credits)} differ by ${formatAmount(Math.abs(totals.difference))}.`;
  } else detail = stripEngineCode(c.detail);
  return { id: c.id, label, state: c.state, detail };
}

export function deriveTrialBalanceVerdict(input: TrialBalanceVerdictInput): TrialBalanceVerdict {
  const upload = input.upload;
  const totals = upload ? readTrialBalanceTotals(upload.processing_result) : null;
  const layerChecks = input.readiness?.checks ?? [];
  const checks = layerChecks.filter((c) => c.id in CHECK_TEXT).map((c) => plainCheck(c, totals));
  const informational = layerChecks.filter((c) => c.id in INFO_TEXT).map((c) => plainCheck(c, totals));
  const failed = checks.find((c) => c.state === "failed") ?? checks.find((c) => c.state === "review") ?? null;
  const evidenceCleared = upload?.safisha_status === "clean";
  const base = { totals, checks, informational, failedCheckId: failed?.id ?? null, evidenceUnlocked: false, evidenceCleared };

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

  const verdict = input.readiness?.verdict;
  switch (verdict) {
    case "certified":
      return {
        ...base, status: "accepted", statusLabel: "Accepted", tone: "success", evidenceUnlocked: true,
        reason: evidenceCleared
          ? "The trial balance passed every check and its evidence is verified."
          : "The trial balance passed every check. Verify it against bank and mobile-money evidence before tax.",
        primaryAction: evidenceCleared ? { kind: "continue", label: "Continue to Reconcile" } : { kind: "verify_evidence", label: "Verify against bank and mobile-money evidence" },
      };
    case "blocked":
      return {
        ...base, status: "blocked", statusLabel: "Blocked", tone: "danger",
        reason: plainBlockReason({ blocker: input.readiness?.blocker, totals, failedCheckId: failed?.id ?? null }),
        primaryAction: { kind: "replace", label: "Replace with corrected Trial Balance" },
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
