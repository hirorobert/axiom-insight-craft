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
): ReviewDecisionPayload {
  if (isExcluded) {
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

  return {
    account_code: account.account_code,
    account_name: account.account_name,
    proposal_type: hadSuggestion ? "MACHINE_SUGGESTION" : "NONE",
    decision_action: accepted ? "USER_ACCEPTED_SUGGESTION" : "USER_MANUAL_CLASSIFICATION",
    statement: meta.statement,
    classification,
    line_item: account.account_name,
    normal_balance: meta.normal_balance,
    is_cash_account: false,
    is_retained_earnings: false,
    is_payroll_account: false,
  };
}
