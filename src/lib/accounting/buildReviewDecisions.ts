// Ω∞ Phase 2A — pure decision-payload construction for AccountReviewPanel's
// Save & Reprocess action. Extracted so the proposal/decision vocabulary
// split (professional intent vs. machine provenance) is independently
// testable without a DOM or a live RPC. The RPC (resolve_account_review_batch,
// migration 20260816120000) is the actual authority — this function only
// decides what intent gets sent; it has no write capability of its own.

export type ReviewProposalType = "NONE" | "MACHINE_SUGGESTION" | "AUTO_MAPPED_RULE";
export type ReviewDecisionAction =
  | "USER_ACCEPTED_SUGGESTION"
  | "USER_MANUAL_CLASSIFICATION"
  | "MARK_NON_REPORTING_ACCOUNT";

export interface ReviewDecisionAccount {
  account_code: string | null;
  account_name: string;
  suggested_classification?: string;
}

/**
 * Ω∞ Phase 6: explicit professional overrides for the three authoritative
 * account_mappings flags (is_cash_account / is_retained_earnings /
 * is_payroll_account). Each field is tri-state by omission, not by value:
 *   - key absent from this object     → not reviewed this decision. The
 *     built payload OMITS the corresponding key entirely, so
 *     resolve_account_review_batch's ON CONFLICT UPDATE preserves whatever
 *     value the account_mappings row already carries. This is what stops a
 *     routine classification decision from silently erasing a previously
 *     professionally-set flag.
 *   - key present, true or false      → the professional explicitly
 *     reviewed this dimension and recorded that decision. Sent through
 *     verbatim; becomes the new authoritative value.
 * There is no machine-suggested value for any of these three flags
 * anywhere in this codebase (process-trial-balance's classifier never
 * surfaces a suggested is_cash/is_retained_earnings/is_payroll signal into
 * needsReviewAccounts) — so unlike statement classification, there is no
 * USER_ACCEPTED_SUGGESTION path for these three; every non-omitted value
 * here is, by construction, an explicit professional override.
 */
export interface ReviewFlagDecisions {
  is_cash_account?: boolean;
  is_retained_earnings?: boolean;
  is_payroll_account?: boolean;
}

export interface ReviewDecisionPayload {
  account_code: string | null;
  account_name: string;
  proposal_type: ReviewProposalType;
  decision_action: ReviewDecisionAction;
  statement?: string;
  classification?: string;
  line_item?: string;
  normal_balance?: "debit" | "credit";
  is_cash_account?: boolean;
  is_retained_earnings?: boolean;
  is_payroll_account?: boolean;
  reason?: string;
}

/**
 * Builds one review-decision payload for a single account.
 *
 * proposal_type describes what the machine offered (independent of what the
 * professional did with it); decision_action describes what the professional
 * actually did. This function never emits proposal_type "AUTO_MAPPED_RULE" —
 * that value exists in the vocabulary for a future phase only.
 */
export function buildReviewDecision(
  account: ReviewDecisionAccount,
  isExcluded: boolean,
  classification: string | undefined,
  classificationMeta: (cls: string) => { statement: string; normal_balance: "debit" | "credit" },
  flagDecisions?: ReviewFlagDecisions,
): ReviewDecisionPayload {
  if (isExcluded) {
    // Exclusion is itself a complete professional decision (MARK_NON_
    // REPORTING_ACCOUNT deletes the account_mappings row entirely — see
    // resolve_account_review_batch). Flag overrides on an account being
    // removed from the mapping are meaningless; never forwarded.
    return {
      account_code: account.account_code,
      account_name: account.account_name,
      proposal_type: "NONE",
      decision_action: "MARK_NON_REPORTING_ACCOUNT",
      reason: "Excluded from import",
    };
  }

  const meta = classificationMeta(classification ?? "");
  const hadSuggestion = Boolean(account.suggested_classification);
  const accepted = hadSuggestion && account.suggested_classification === classification;

  const payload: ReviewDecisionPayload = {
    account_code: account.account_code,
    account_name: account.account_name,
    proposal_type: hadSuggestion ? "MACHINE_SUGGESTION" : "NONE",
    decision_action: accepted ? "USER_ACCEPTED_SUGGESTION" : "USER_MANUAL_CLASSIFICATION",
    statement: meta.statement,
    classification,
    line_item: account.account_name,
    normal_balance: meta.normal_balance,
  };

  // Only a dimension the professional actually decided is included. An
  // omitted key is not sent as false — resolve_account_review_batch reads
  // absence as "not reviewed" and preserves the current projection value.
  if (flagDecisions?.is_cash_account !== undefined) {
    payload.is_cash_account = flagDecisions.is_cash_account;
  }
  if (flagDecisions?.is_retained_earnings !== undefined) {
    payload.is_retained_earnings = flagDecisions.is_retained_earnings;
  }
  if (flagDecisions?.is_payroll_account !== undefined) {
    payload.is_payroll_account = flagDecisions.is_payroll_account;
  }

  return payload;
}
