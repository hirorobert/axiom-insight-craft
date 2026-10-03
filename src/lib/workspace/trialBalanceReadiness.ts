/**
 * trialBalanceReadiness — the ONE definition of "Trial balance ready". Pure.
 *
 * Arithmetic balance alone is never enough. A trial balance is ready only when all three checks hold:
 *
 *   1. Checks passed — the authoritative certification for this upload is "certified": the file was read in full,
 *      every amount is exact in the period's currency, there is no ambiguous identity, and debits equal credits to the
 *      last minor unit (process-trial-balance / _shared/tbIngestion.ts).
 *   2. Classifications confirmed — "certified" is only ever committed once no account needs review, and every machine
 *      suggestion (shared chart, dictionary, naming rule, fuzzy match) needs a reviewer's confirmation first.
 *   3. Required reconciliation COMPLETE — the upload's reconciliation finished clean and EVERY trial-balance line in it
 *      is accounted for: matched to evidence, or its exception approved by a reviewer. One matched line is not enough;
 *      a pending, rejected or escalated exception is not complete (the database marks a reconciliation "clean" once no
 *      exception is pending and none is rejected, so an escalated one would otherwise slip through); a "clean" status
 *      over an empty comparison is not reconciliation.
 *
 * Evidence this viewer cannot read is NOT the same as incomplete evidence, and neither is ready:
 *   · not_visible — the upload says a reconciliation exists, but none is readable for this viewer (row-level access:
 *     reconciliation records are visible to firm members, not to a Prepare-only grant). Readiness cannot be confirmed
 *     HERE; it may be complete.
 *   · unreadable — the read itself failed. Try again.
 *   · incomplete — the reconciliation is readable and not complete; the detail says what is missing.
 */

export interface ReconciliationExceptionSummary {
  pending: number;
  approved: number;
  rejected: number;
  escalated: number;
  /** Distinct trial-balance lines whose exception a reviewer approved. */
  approvedTbLines: number;
}

export interface ReconciliationEvidence {
  status: string | null;
  matched_count: number | null;
  exception_count: number | null;
  total_tb_lines: number | null;
  /** The reconciliation's exceptions by reviewer action. Absent = not read (completeness cannot be proven). */
  exceptions?: ReconciliationExceptionSummary | null;
}

/** How the reconciliation read went for THIS viewer. */
export type EvidenceRead =
  | { state: "read"; evidence: ReconciliationEvidence | null }
  | { state: "failed" };

export interface ReadinessInput {
  /** computeCertificationReadiness verdict for the CURRENT upload. */
  certificationVerdict: string | null | undefined;
  /** trial_balance_uploads.safisha_status. */
  safishaStatus: string | null | undefined;
  /**
   * The upload's latest reconciliation record as read by this viewer. A bare record (or null) is accepted for callers
   * that only hold the record; `undefined` means it was never read.
   */
  reconciliation: ReconciliationEvidence | EvidenceRead | null | undefined;
}

export type EvidenceState = "complete" | "none" | "in_progress" | "incomplete" | "not_visible" | "unreadable";

export type ReadinessCheckId = "checks" | "classifications" | "evidence";

export interface ReadinessCheck {
  id: ReadinessCheckId;
  label: string;
  met: boolean;
  detail: string;
}

export interface TrialBalanceReadiness {
  ready: boolean;
  checks: ReadinessCheck[];
  evidenceState: EvidenceState;
  /** The first unmet check, in plain language — null when ready. */
  nextStep: string | null;
}

function asRead(r: ReadinessInput["reconciliation"]): EvidenceRead | undefined {
  if (r === undefined) return undefined;
  if (r !== null && typeof r === "object" && "state" in r) return r as EvidenceRead;
  return { state: "read", evidence: (r as ReconciliationEvidence | null) ?? null };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Classifies the reconciliation evidence for this viewer, with one plain sentence. */
export function evidenceState(safishaStatus: string | null | undefined, read: ReadinessInput["reconciliation"]): { state: EvidenceState; detail: string } {
  const r = asRead(read);
  if (!r || r.state === "failed") {
    return { state: "unreadable", detail: "The reconciliation could not be read just now, so readiness cannot be confirmed. Refresh to try again." };
  }
  const e = r.evidence;
  if (!e) {
    // The upload carries a reconciliation status, but no record is readable for this viewer.
    if (safishaStatus) {
      return { state: "not_visible", detail: "Supporting evidence was reconciled by someone with Reconcile access. You can't view that reconciliation, so readiness can't be confirmed here — ask them to check it." };
    }
    return { state: "none", detail: "Match the trial balance to bank statements, mobile-money exports or subledgers." };
  }
  if (e.status === "processing") return { state: "in_progress", detail: "The reconciliation is still running." };
  const total = e.total_tb_lines ?? 0;
  const matched = e.matched_count ?? 0;
  if (total <= 0) return { state: "incomplete", detail: "No trial-balance line has been matched to evidence yet." };
  const x = e.exceptions;
  if (!x) return { state: "unreadable", detail: "The reconciliation's exceptions could not be read, so completeness cannot be confirmed. Refresh to try again." };
  if (x.pending > 0) return { state: "incomplete", detail: `${plural(x.pending, "exception")} still need${x.pending === 1 ? "s" : ""} a decision.` };
  if (x.rejected > 0) return { state: "incomplete", detail: `${plural(x.rejected, "exception")} ${x.rejected === 1 ? "was" : "were"} rejected — the trial balance does not agree with its evidence. Correct it and reconcile again.` };
  if (x.escalated > 0) return { state: "incomplete", detail: `${plural(x.escalated, "exception")} ${x.escalated === 1 ? "is" : "are"} escalated and not yet resolved.` };
  const accounted = matched + x.approvedTbLines;
  if (accounted < total) return { state: "incomplete", detail: `${accounted} of ${total} trial-balance lines are matched or approved; ${total - accounted} still need evidence.` };
  if (e.status !== "clean" || safishaStatus !== "clean") return { state: "incomplete", detail: "The reconciliation has not been completed." };
  return { state: "complete", detail: `All ${total} trial-balance lines are matched to evidence or approved by a reviewer (${matched} matched, ${x.approvedTbLines} approved).` };
}

/**
 * The status the workspace state engine may act on. The upload's raw `safisha_status` says "clean" whenever the
 * database found nothing pending and nothing rejected — including when an exception was only ESCALATED, or lines are
 * still unaccounted for. When the viewer CAN read the reconciliation and it is not complete, "clean" unlocks nothing:
 * it is treated as still under review. Evidence the viewer cannot read leaves the raw status as it is (readiness then
 * says it cannot be confirmed); nothing here ever upgrades a status to "clean".
 */
export function effectiveSafishaStatus(raw: string | null, read: ReadinessInput["reconciliation"]): string | null {
  if (raw !== "clean") return raw;
  return evidenceState(raw, read).state === "incomplete" ? "needs_review" : raw;
}

/** Exceptions by reviewer action. Anything not approved / rejected / escalated is pending — never counted as resolved. */
export function summarizeExceptions(rows: readonly { reviewer_action: string | null; tb_txn_id: string | null }[]): ReconciliationExceptionSummary {
  const x: ReconciliationExceptionSummary = { pending: 0, approved: 0, rejected: 0, escalated: 0, approvedTbLines: 0 };
  const approvedLines = new Set<string>();
  for (const e of rows) {
    if (e.reviewer_action === "approved") { x.approved++; if (e.tb_txn_id) approvedLines.add(e.tb_txn_id); }
    else if (e.reviewer_action === "rejected") x.rejected++;
    else if (e.reviewer_action === "escalated") x.escalated++;
    else x.pending++;
  }
  x.approvedTbLines = approvedLines.size;
  return x;
}

type ReadAnswer = { data: unknown; error: unknown };
interface EvidenceQuery extends PromiseLike<ReadAnswer> {
  select(columns: string): EvidenceQuery;
  eq(column: string, value: unknown): EvidenceQuery;
  order(column: string, opts: { ascending: boolean }): EvidenceQuery;
  limit(n: number): EvidenceQuery;
  maybeSingle(): PromiseLike<ReadAnswer>;
}
/** The two reads below, against whatever client the caller holds (the browser's Supabase client; a proof's SQL client). */
export interface EvidenceReadClient {
  from(table: "safisha_reconciliations" | "safisha_exceptions"): EvidenceQuery;
}

/**
 * The upload's latest reconciliation for THIS viewer, with its exceptions by reviewer action — what readiness needs to
 * prove completeness. Row-level access decides what is visible: a failed read is "failed" (never "no reconciliation");
 * an empty answer means none exists or none is visible to this viewer; unreadable exceptions leave completeness
 * unprovable (exceptions: null).
 */
export async function readReconciliationEvidence(client: EvidenceReadClient, uploadId: string): Promise<EvidenceRead> {
  const recon = await client.from("safisha_reconciliations")
    .select("id, status, matched_count, exception_count, total_tb_lines")
    .eq("tb_upload_id", uploadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recon.error) return { state: "failed" };
  const row = recon.data as (ReconciliationEvidence & { id: string }) | null;
  if (!row) return { state: "read", evidence: null };
  const { id, ...evidence } = row;
  const ex = await client.from("safisha_exceptions").select("reviewer_action, tb_txn_id").eq("reconciliation_id", id);
  if (ex.error || !Array.isArray(ex.data)) return { state: "read", evidence: { ...evidence, exceptions: null } };
  return { state: "read", evidence: { ...evidence, exceptions: summarizeExceptions(ex.data as { reviewer_action: string | null; tb_txn_id: string | null }[]) } };
}

/** True only for a complete required reconciliation (kept for callers that need the boolean). */
export function reconciliationEvaluated(r: ReconciliationEvidence | null | undefined, safishaStatus: string | null | undefined = "clean"): boolean {
  return evidenceState(safishaStatus, r ?? null).state === "complete";
}

export function trialBalanceReadiness(input: ReadinessInput): TrialBalanceReadiness {
  const certified = input.certificationVerdict === "certified";
  const review = input.certificationVerdict === "review";
  const ev = evidenceState(input.safishaStatus, input.reconciliation);
  const checks: ReadinessCheck[] = [
    {
      id: "checks",
      label: "File checks passed",
      met: certified || review,
      detail: certified || review ? "Read in full; amounts exact; debits equal credits." : "The file has not passed its checks yet.",
    },
    {
      id: "classifications",
      label: "Account classifications confirmed",
      met: certified,
      detail: certified ? "Every account is on a reviewed classification." : review ? "Some accounts need a reviewer's confirmation." : "Waiting for the file checks.",
    },
    { id: "evidence", label: "Required reconciliation complete", met: ev.state === "complete", detail: ev.detail },
  ];
  const firstUnmet = checks.find((c) => !c.met) ?? null;
  return { ready: !firstUnmet, checks, evidenceState: ev.state, nextStep: firstUnmet ? firstUnmet.detail : null };
}
