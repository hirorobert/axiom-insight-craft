/**
 * Close Review adjustments (I3): the browser's model and client. Every write is a server function
 * (close_review_propose_adjustment, close_review_decide_adjustment, close_review_set_approval_policy); the browser never
 * writes a financial table. Amounts are exact: typed text → minor units (BigInt) → decimal strings, never floats.
 */

export interface AdjustmentLine { lineNo: number; accountKey: string; accountCode: string | null; accountName: string; classification: string; debitMinor: string; creditMinor: string; memo: string | null }
export interface AdjustmentView {
  id: string; number: number; kind: "adjustment" | "reversal"; reverses: string | null;
  status: "proposed" | "approved" | "rejected" | "withdrawn"; current: boolean; totalMinor: string; proposer: string;
  reason: string; evidenceRef: string | null; findingIds: string[]; selfApproved: boolean; reversedBy: string | null; lines: AdjustmentLine[];
}
export type AdjustmentsSummary =
  | { state: "unavailable" }
  | { state: "no_authority" | "current"; certificationId: string | null; currency: string | null; exponent: number | null;
      policy: "two_person" | "owner_self_approval"; selfApprovalAvailable: boolean; approvers: number; adjustments: AdjustmentView[] };

export interface AdjustedRow {
  account_key: string; account_code: string | null; account_name: string; classification: string;
  certified_debit_minor: string; certified_credit_minor: string; adjustment_debit_minor: string; adjustment_credit_minor: string;
  adjusted_debit_minor: string; adjusted_credit_minor: string;
}

/** "1,234.56" at exponent 2 → 123456n. Refuses more decimals than the currency has, signs and anything else (null). */
export function parseAmountToMinor(text: string, exponent: number): bigint | null {
  const t = text.trim().replace(/,/g, "");
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(t);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > exponent) return null;
  return BigInt(m[1] + frac.padEnd(exponent, "0"));
}

export interface DraftLine { accountKey: string; side: "debit" | "credit"; amount: string; memo: string }
export interface DraftCheck {
  ok: boolean;
  /** The lines to send (only meaningful when ok). */
  lines: { accountKey: string; debitMinor: string; creditMinor: string; memo?: string }[];
  debitMinor: bigint;
  creditMinor: bigint;
  problems: string[];
}

/** The same rules as the server (which decides): ≥2 lines, every line an account and a positive exact amount, balanced. */
export function checkDraft(lines: readonly DraftLine[], exponent: number): DraftCheck {
  const problems: string[] = [];
  let dr = 0n, cr = 0n;
  const out: { accountKey: string; debitMinor: string; creditMinor: string; memo?: string }[] = [];
  if (lines.length < 2) problems.push("An adjustment needs at least two lines.");
  lines.forEach((l, i) => {
    const v = parseAmountToMinor(l.amount, exponent);
    if (!l.accountKey) problems.push(`Line ${i + 1}: choose an account.`);
    if (v === null || v <= 0n) problems.push(`Line ${i + 1}: enter an amount above zero with at most ${exponent} decimals.`);
    else if (l.side === "debit") dr += v; else cr += v;
    if (v !== null && v > 0n && l.accountKey) out.push({ accountKey: l.accountKey, debitMinor: l.side === "debit" ? v.toString() : "0", creditMinor: l.side === "credit" ? v.toString() : "0", ...(l.memo.trim() ? { memo: l.memo.trim() } : {}) });
  });
  if (problems.length === 0 && dr !== cr) problems.push("Debits and credits must be equal.");
  return { ok: problems.length === 0, lines: problems.length === 0 ? out : [], debitMinor: dr, creditMinor: cr, problems };
}

export type ProposeOutcome = "proposed" | "forbidden" | "feature_disabled" | "no_authority" | "invalid_request" | "unbalanced" | "unknown_account" | "finding_not_current" | "not_reversible" | "request_reused";
export type DecideOutcome = "recorded" | "forbidden" | "feature_disabled" | "not_found" | "already_decided" | "stale_authority" | "self_approval_not_allowed" | "acknowledgement_required" | "invalid_request" | "request_reused";
export const PROPOSE_WORDS: Record<Exclude<ProposeOutcome, "proposed">, string> = {
  forbidden: "Proposing adjustments needs Prepare in this workspace. Nothing was recorded.",
  feature_disabled: "Close Review is not enabled for this workspace. Nothing was recorded.",
  no_authority: "There is no reviewed trial balance for this period, so nothing can be adjusted yet.",
  invalid_request: "Some lines are not valid. Nothing was recorded.",
  unbalanced: "Debits and credits are not equal. Nothing was recorded.",
  unknown_account: "An account is not classified in this workspace. Classify it in Account review first.",
  finding_not_current: "A linked finding belongs to an earlier check. Reload the findings.",
  not_reversible: "Only an approved adjustment on the current trial balance can be reversed, once.",
  request_reused: "This was already sent with different content. Reload and try again.",
};
export const DECIDE_WORDS: Record<Exclude<DecideOutcome, "recorded">, string> = {
  forbidden: "You can't take this decision on this adjustment.",
  feature_disabled: "Close Review is not enabled for this workspace. Nothing was recorded.",
  not_found: "This adjustment is no longer available.",
  already_decided: "Someone already decided this adjustment. Reload to see the decision.",
  stale_authority: "The trial balance changed since this adjustment was proposed. Propose it again on the current trial balance.",
  self_approval_not_allowed: "You can't approve your own adjustment here: another member must approve it.",
  acknowledgement_required: "Confirm that this self-approval will be disclosed.",
  invalid_request: "Give a reason (3 to 2,000 characters).",
  request_reused: "This was already sent with different content. Reload and try again.",
};

type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
export function adjustmentsClient(db: { rpc: Rpc }) {
  const call = async <T>(name: string, args: Record<string, unknown>, what: string): Promise<T> => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw new Error(`${what} could not be completed. Nothing was recorded.`);
    return data as T;
  };
  return {
    summary: (companyId: string, periodYear: number) => call<AdjustmentsSummary>("close_review_adjustments_summary", { p_company_id: companyId, p_period_year: periodYear }, "Reading the adjustments"),
    adjusted: (companyId: string, periodYear: number) => call<AdjustedRow[]>("close_review_adjusted_trial_balance", { p_company_id: companyId, p_period_year: periodYear }, "Reading the adjusted trial balance"),
    propose: (companyId: string, periodYear: number, reason: string, evidenceRef: string | null, lines: unknown[], findingIds: string[], requestId: string, reverses: string | null = null) =>
      call<{ outcome: ProposeOutcome; adjustmentId?: string; number?: number }>("close_review_propose_adjustment", { p_company_id: companyId, p_period_year: periodYear, p_reason: reason, p_evidence_ref: evidenceRef, p_lines: lines, p_finding_ids: findingIds, p_request_id: requestId, p_reverses: reverses }, "The proposal"),
    decide: (adjustmentId: string, decision: "approve" | "reject" | "withdraw", reason: string, acknowledgeSelfApproval: boolean, requestId: string) =>
      call<{ outcome: DecideOutcome; status?: string; selfApproved?: boolean }>("close_review_decide_adjustment", { p_adjustment_id: adjustmentId, p_decision: decision, p_reason: reason, p_acknowledge_self_approval: acknowledgeSelfApproval, p_request_id: requestId }, "The decision"),
  };
}
export type AdjustmentsClient = ReturnType<typeof adjustmentsClient>;
