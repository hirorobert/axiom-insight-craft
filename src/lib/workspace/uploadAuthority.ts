/**
 * uploadAuthority — why one upload's result is, or is not, the period's authoritative trial balance (F2).
 *
 * Read from public.tb_upload_authority(upload) (S2, 20261008100000): the database computes authority at read time — the
 * upload's current processing attempt completed, its source unchanged, its certification not invalidated, every input it
 * used still at the revision it used, and the run an S2 attempt (results recorded before S2 are history: "Needs re-check").
 * This module only reads that answer and turns it into one plain notice with at most one action:
 *   check_again  a new check through tbu_request_reprocess (the one browser path; it invalidates first);
 *   retry_now    the same request, offered when a check stopped responding or was requested but never started — the
 *                database preempts a running attempt for an authorized request, so the worker can never finish.
 * An answer that cannot be read is never treated as current: it is "unknown" and offers nothing.
 */

export const AUTHORITY_REASONS = [
  "current", "attempt_running", "attempt_failed", "attempt_abandoned", "not_certified", "legacy_certification",
  "superseded_attempt", "invalidated", "source_changed", "dependency_changed", "blocked", "needs_review", "upload_not_active",
] as const;
export type AuthorityReason = (typeof AUTHORITY_REASONS)[number];

export interface UploadAuthority {
  uploadId: string;
  authoritative: boolean;
  reason: AuthorityReason;
  certificationId: string | null;
  attemptStatus: "running" | "completed" | "failed" | "abandoned" | null;
  attemptCode: string | null;
  attemptLeaseExpired: boolean;
  processingAttempt: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

/** The database's answer, or null when it cannot be read (never assumed current). */
export function parseUploadAuthority(raw: unknown): UploadAuthority | null {
  if (!isObj(raw)) return null;
  const reason = raw.reason;
  if (typeof reason !== "string" || !(AUTHORITY_REASONS as readonly string[]).includes(reason)) return null;
  if (typeof raw.authoritative !== "boolean" || raw.authoritative !== (reason === "current")) return null;
  const status = raw.current_attempt_status;
  if (status !== null && status !== undefined && !["running", "completed", "failed", "abandoned"].includes(status as string)) return null;
  const attempt = raw.processing_attempt;
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 0) return null;
  const uploadId = str(raw.upload_id);
  if (!uploadId) return null;
  return {
    uploadId,
    authoritative: raw.authoritative,
    reason: reason as AuthorityReason,
    certificationId: str(raw.certification_id),
    attemptStatus: (status ?? null) as UploadAuthority["attemptStatus"],
    attemptCode: str(raw.current_attempt_code),
    attemptLeaseExpired: raw.current_attempt_lease_expired === true,
    processingAttempt: attempt,
  };
}

export type AuthorityAction = "check_again" | "retry_now";
export interface AuthorityNotice {
  tone: "neutral" | "warning" | "error";
  /** "Needs re-check", "Processing stopped", … — the state in two or three words. */
  label: string;
  detail: string;
  action: AuthorityAction | null;
}

export const ACTION_LABEL: Readonly<Record<AuthorityAction, string>> = Object.freeze({ check_again: "Check again", retry_now: "Retry now" });

const STOPPED: Readonly<Record<string, string>> = Object.freeze({
  INVARIANT_VIOLATION: "An internal consistency check failed, so nothing was accepted. Check again; if it happens again, contact support.",
  UNHANDLED_EXCEPTION: "The check could not finish, so nothing was accepted. Check again.",
  DEPENDENCY_CHANGED: "A mapping, decision or setting this check used changed while it ran, so nothing was accepted. Check again.",
  LEASE_EXPIRED: "The check stopped responding and was closed. Check again.",
  DRAINED_AT_CUTOVER: "The check was closed during a system update. Check again.",
});

/**
 * The one notice for an upload's authority, or null when there is nothing to add to the trial balance verdict (a current
 * result, or a state the verdict already explains: never checked, blocked, needs review, no longer in active use).
 */
export function authorityNotice(a: UploadAuthority | null): AuthorityNotice | null {
  if (a === null) return { tone: "neutral", label: "Status unknown", detail: "The current status of this result could not be read. Refresh to try again.", action: null };
  switch (a.reason) {
    case "current": case "not_certified": case "blocked": case "needs_review": case "upload_not_active":
      return null;
    case "attempt_running":
      return a.attemptLeaseExpired
        ? { tone: "warning", label: "Processing stopped", detail: "The check stopped responding before it finished. Retry now to start a new one.", action: "retry_now" }
        : { tone: "neutral", label: "Checking", detail: "This trial balance is being checked. The result appears here when it finishes.", action: null };
    case "attempt_failed":
      if (a.attemptCode === "INGESTION_REFUSED") return null; // the file's own reasons are shown by the verdict
      return { tone: a.attemptCode === "DEPENDENCY_CHANGED" ? "warning" : "error", label: a.attemptCode === "DEPENDENCY_CHANGED" ? "Needs re-check" : "Processing stopped",
               detail: STOPPED[a.attemptCode ?? ""] ?? "The check did not finish, so nothing was accepted. Check again.", action: "check_again" };
    case "attempt_abandoned":
      if (a.attemptCode === "PREEMPTED") {
        return { tone: "neutral", label: "New check requested", detail: "A newer check replaced the one that was running. Start it now if it has not begun.", action: "retry_now" };
      }
      if (a.attemptCode?.startsWith("UPLOAD_")) return null;
      return { tone: "warning", label: "Processing stopped", detail: STOPPED[a.attemptCode ?? ""] ?? "The check was closed before it finished. Check again.", action: "check_again" };
    case "invalidated":
      return { tone: "neutral", label: "New check requested", detail: "A new check of this trial balance was requested. Start it now if it has not begun.", action: "retry_now" };
    case "legacy_certification":
      return { tone: "warning", label: "Needs re-check", detail: "This result was recorded by an earlier version of the checks. Check it again before relying on it.", action: "check_again" };
    case "dependency_changed":
      return { tone: "warning", label: "Needs re-check", detail: "A mapping, classification decision or setting this result used has changed since it was recorded.", action: "check_again" };
    case "source_changed":
      return { tone: "warning", label: "Needs re-check", detail: "The file changed after this result was recorded.", action: "check_again" };
    case "superseded_attempt":
      return { tone: "warning", label: "Needs re-check", detail: "This result is not from the latest check of this trial balance.", action: "check_again" };
  }
}

/** One processing attempt, newest first (public.tb_upload_attempts). */
export interface AttemptHistoryEntry {
  attemptNo: number;
  status: "running" | "completed" | "failed" | "abandoned";
  code: string | null;
  startedAt: string;
  completedAt: string | null;
}

export function parseAttemptHistory(raw: unknown): AttemptHistoryEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AttemptHistoryEntry[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.attempt_no !== "number" || !["running", "completed", "failed", "abandoned"].includes(r.status as string) || !str(r.started_at)) return null;
    out.push({ attemptNo: r.attempt_no, status: r.status as AttemptHistoryEntry["status"], code: str(r.code), startedAt: r.started_at as string, completedAt: str(r.completed_at) });
  }
  return out;
}

const OUTCOME: Readonly<Record<string, string>> = Object.freeze({
  PREEMPTED: "replaced by a newer check", LEASE_EXPIRED: "stopped responding", DRAINED_AT_CUTOVER: "closed during a system update",
  INVARIANT_VIOLATION: "stopped: an internal consistency check failed", DEPENDENCY_CHANGED: "stopped: an input changed while it ran",
  UNHANDLED_EXCEPTION: "could not finish", INGESTION_REFUSED: "the file could not be read as a trial balance",
});

/** "Check 3 — completed", "Check 2 — replaced by a newer check", … */
export function attemptLabel(e: AttemptHistoryEntry): string {
  const what = e.status === "completed" ? "completed" : e.status === "running" ? "running"
    : e.code?.startsWith("UPLOAD_") ? "closed when the trial balance left active use"
    : OUTCOME[e.code ?? ""] ?? (e.status === "failed" ? "did not finish" : "closed");
  return `Check ${e.attemptNo} — ${what}`;
}
