/**
 * findingDecisions — the ONLY browser path to trial-balance finding decisions (20261118100000).
 *
 * The browser offers a decision only where the server would accept one: a finding that takes a decision
 * (tb_decision_actions), carrying the identity the engine recorded (code + subject), on the upload's current evaluation.
 * Whether it MUST be decided is the server's rule (decision_required on the finding): the entity always; a clearing
 * balance only under the workspace's recorded policy; amount-free trailing text never (it may be acknowledged).
 * record_tb_finding_decision decides everything else — the actor and their authority, the finding's identity against
 * the certification's own findings, the required confirmations and evidence, stale/version/replay outcomes — and
 * invalidates the evaluation it was made against at once. The page then checks the file again through the one
 * reprocess path. Nothing here changes an amount.
 */
import type { TrialBalanceIssue } from "@/lib/workspace/trialBalanceVerdict";

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

export type DecisionCode = "ENTITY_NAME_DIFFERS" | "UNRECOGNISED_TRAILING_TEXT" | "CLEARING_ACCOUNT_BALANCE";
export interface DecisionChoice { action: string; label: string; resolves: boolean; consequence: string }

/** What each finding can be decided as (mirrors tb_decision_actions; the server refuses anything else). */
export const DECISION_CHOICES: Readonly<Record<DecisionCode, readonly DecisionChoice[]>> = {
  ENTITY_NAME_DIFFERS: [
    { action: "same_entity", label: "Same entity", resolves: true, consequence: "The file is accepted as this entity's. It applies to this file only; a replacement file, or a change to the entity's details, is asked about again." },
    { action: "different_entity", label: "Different entity", resolves: false, consequence: "The file is blocked here. Remove it and upload it to the right engagement." },
  ],
  UNRECOGNISED_TRAILING_TEXT: [
    { action: "not_part_of_trial_balance", label: "Not part of the trial balance", resolves: true, consequence: "The rows stay out of the accounts (they carry no amounts), and your acknowledgement is recorded with the result." },
    { action: "part_of_trial_balance", label: "Part of the trial balance", resolves: false, consequence: "The file is blocked until its layout or content is corrected, because those rows have no amounts this check can read." },
  ],
  CLEARING_ACCOUNT_BALANCE: [
    { action: "explained", label: "Explain this balance", resolves: true, consequence: "Your explanation and evidence reference are recorded with the result. The reference is not matched to a bank transaction, and the balance itself is not changed." },
  ],
};
export const isDecisionCode = (code: string): code is DecisionCode => code in DECISION_CHOICES;

/** A finding the page may offer a decision for: a decision-taking code carrying the engine's identity. */
export function decidable(issue: TrialBalanceIssue): issue is TrialBalanceIssue & { code: DecisionCode; subject: string } {
  return isDecisionCode(issue.code) && typeof issue.subject === "string" && issue.subject.length > 0;
}

export interface CurrentDecisionView {
  decisionId: string; code: string; subject: string; action: string; resolves: boolean; revision: number;
  reason: string; createdAt: string;
}
/** The newest revision recorded for each finding (current or not): the expected revision of the next decision. */
export type LatestRevisions = ReadonlyMap<string, number>;
export const revisionKey = (code: string, subject: string) => `${code}\u0000${subject}`;
export type DecisionsRead = { kind: "ok"; decisions: CurrentDecisionView[]; latest: LatestRevisions } | { kind: "unavailable" };

export async function readFindingDecisions(rpc: Rpc, uploadId: string): Promise<DecisionsRead> {
  const { data, error } = await rpc("get_tb_finding_decisions", { p_upload_id: uploadId });
  const d = data as { outcome?: string; decisions?: unknown } | null;
  if (error || d?.outcome !== "ok" || !Array.isArray(d.decisions)) return { kind: "unavailable" };
  const decisions = d.decisions.flatMap((x): CurrentDecisionView[] => {
    const r = x as Record<string, unknown>;
    if (typeof r.decision_id !== "string" || typeof r.code !== "string" || typeof r.subject !== "string" || typeof r.action !== "string"
      || typeof r.resolves !== "boolean" || typeof r.revision !== "number") return [];
    return [{ decisionId: r.decision_id, code: r.code, subject: r.subject, action: r.action, resolves: r.resolves, revision: r.revision,
      reason: typeof r.reason === "string" ? r.reason : "", createdAt: typeof r.created_at === "string" ? r.created_at : "" }];
  });
  const raw = (d as { latest_revisions?: unknown }).latest_revisions;
  const latest = new Map<string, number>((Array.isArray(raw) ? raw : []).flatMap((x) => {
    const r = x as Record<string, unknown>;
    return typeof r.code === "string" && typeof r.subject === "string" && typeof r.revision === "number" ? [[revisionKey(r.code, r.subject), r.revision] as [string, number]] : [];
  }));
  return { kind: "ok", decisions, latest };
}

export interface DecisionInput {
  uploadId: string; certificationId: string; code: DecisionCode; subject: string; action: string;
  payload: Record<string, unknown>; reason: string; expectedRevision: number; requestId: string;
}
export type DecisionOutcome =
  | { kind: "recorded"; decisionId: string; revision: number; replay: boolean }
  | { kind: "unchanged" }
  | { kind: "refused"; code: string; message: string };

const REFUSAL_TEXT: Record<string, string> = {
  STALE_EVALUATION: "This result was replaced by a newer check. Reload the page to decide on the current result.",
  VERSION_CONFLICT: "Someone recorded a decision on this finding meanwhile. Reload the page to see it.",
  FORBIDDEN: "You don't have permission to record decisions in this workspace.",
  UPLOAD_NOT_FOUND: "You don't have permission to record decisions in this workspace.",
  UNAUTHENTICATED: "Your session has ended. Sign in again.",
  CONFIRMATION_REQUIRED: "Confirm the statement shown before recording this decision.",
  EVIDENCE_REQUIRED: "Give an explanation (at least 10 characters) and a reference to the evidence (at least 3 characters).",
  REASON_REQUIRED: "Give a reason of at least 3 characters.",
  IN_PROGRESS: "This trial balance is being checked right now. Record the decision when the check has finished.",
  UPLOAD_NOT_ACTIVE: "This trial balance is no longer in use, so decisions cannot be recorded on it.",
  FINDING_NOT_FOUND: "This result was made before decisions could be recorded. Check the file again, then decide.",
  ACTION_NOT_AVAILABLE: "That decision is not available for this finding.",
  IDEMPOTENCY_KEY_REUSED: "This request was already used for a different decision. Try again.",
};
export const decisionRefusalText = (code: string) => REFUSAL_TEXT[code] ?? "The decision was not recorded. Try again.";

/** Records one decision. A transport failure throws (the caller says so and lets the person retry the same request). */
export async function recordFindingDecision(rpc: Rpc, i: DecisionInput): Promise<DecisionOutcome> {
  const { data, error } = await rpc("record_tb_finding_decision", {
    p_upload_id: i.uploadId, p_certification_id: i.certificationId, p_code: i.code, p_subject: i.subject, p_action: i.action,
    p_payload: i.payload, p_reason: i.reason, p_expected_revision: i.expectedRevision, p_request_id: i.requestId,
  });
  if (error) throw new Error("record_tb_finding_decision failed");
  const d = (data ?? {}) as { outcome?: string; code?: string; decision_id?: string; revision?: number; replay?: boolean };
  if (d.outcome === "recorded" && typeof d.decision_id === "string" && typeof d.revision === "number") {
    return { kind: "recorded", decisionId: d.decision_id, revision: d.revision, replay: d.replay === true };
  }
  if (d.outcome === "unchanged") return { kind: "unchanged" };
  const code = typeof d.code === "string" ? d.code : "REFUSED";
  return { kind: "refused", code, message: decisionRefusalText(code) };
}

// ── Payloads (the confirmations the server requires, built only from what the person confirmed) ──────────────────────

export const entityPayload = (fileEntity: string, workspaceEntity: string, confirmed: boolean) =>
  ({ confirmed, file_entity: fileEntity, workspace_entity: workspaceEntity });
export const rowsPayload = (rows: readonly number[], confirmed: boolean) => ({ confirmed, rows: [...rows] });
export type ClearingNature = "in_transit" | "timing" | "other";
export type EvidenceKind = "reconciliation" | "document";
export function clearingPayload(nature: ClearingNature | null, explanation: string, evidence: EvidenceKind | null, reference: string) {
  if (!nature || !evidence || explanation.trim().length < 10 || reference.trim().length < 3) return null;
  return { nature, explanation: explanation.trim(), evidence: { kind: evidence, reference: reference.trim() } };
}

// ── The workspace's review policy for clearing and in-transit balances (set_tb_finding_policy) ──────────────────────────

export type ClearingPolicyMode = "review" | "require_decision";
export interface ClearingPolicy { mode: ClearingPolicyMode; revision: number; reason: string | null; mayChange: boolean }

export async function readClearingPolicy(rpc: Rpc, companyId: string): Promise<ClearingPolicy | null> {
  const { data, error } = await rpc("get_tb_finding_policies", { p_company_id: companyId });
  const d = data as { outcome?: string; may_change?: unknown; policies?: unknown } | null;
  if (error || d?.outcome !== "ok" || !Array.isArray(d.policies)) return null;
  const p = (d.policies as Record<string, unknown>[]).find((x) => x.code === "CLEARING_ACCOUNT_BALANCE");
  if (!p || (p.mode !== "review" && p.mode !== "require_decision") || typeof p.revision !== "number") return null;
  return { mode: p.mode, revision: p.revision, reason: typeof p.reason === "string" ? p.reason : null, mayChange: d.may_change === true };
}

const POLICY_REFUSAL: Record<string, string> = {
  FORBIDDEN: "Only someone who reviews this workspace's close can change this policy.",
  VERSION_CONFLICT: "Someone changed this policy meanwhile. Reload to see it.",
  REASON_REQUIRED: "Give a reason of at least 3 characters.",
};
export async function setClearingPolicy(rpc: Rpc, companyId: string, mode: ClearingPolicyMode, reason: string, expectedRevision: number, requestId: string):
  Promise<{ ok: true; revision: number } | { ok: false; message: string }> {
  const { data, error } = await rpc("set_tb_finding_policy", { p_company_id: companyId, p_code: "CLEARING_ACCOUNT_BALANCE", p_mode: mode,
    p_reason: reason, p_expected_revision: expectedRevision, p_request_id: requestId });
  if (error) return { ok: false, message: "The policy could not be saved (connection problem). Try again." };
  const d = (data ?? {}) as { outcome?: string; code?: string; revision?: number };
  if ((d.outcome === "recorded" || d.outcome === "unchanged") && typeof d.revision === "number") return { ok: true, revision: d.revision };
  return { ok: false, message: POLICY_REFUSAL[d.code ?? ""] ?? "The policy was not changed. Try again." };
}

/**
 * The certification a decision binds to for the upload on screen: the authoritative one when it is this upload's (the
 * readiness read does not fetch the upload's latest then — it IS the latest), otherwise the upload's latest. Without this
 * an ACCEPTED result would offer no decision, no optional explanation and no investigation.
 */
export function evaluationCertification<T extends { id: string; upload_id: string }>(
  reads: { authoritative: T | null; latestForUpload: T | null }, uploadId: string | null | undefined,
): T | null {
  if (!uploadId) return null;
  if (reads.authoritative && reads.authoritative.upload_id === uploadId) return reads.authoritative;
  return reads.latestForUpload && reads.latestForUpload.upload_id === uploadId ? reads.latestForUpload : null;
}
