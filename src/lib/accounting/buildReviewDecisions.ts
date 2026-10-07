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
  | "MARK_NON_REPORTING_ACCOUNT"
  | "CONFIRM_ACCOUNT_TREATMENT";

export interface ReviewDecisionAccount {
  account_code: string | null;
  account_name: string;
  suggested_classification?: string;
}

/**
 * Ω∞ Phase 6: explicit professional overrides for the three authoritative,
 * tri-state account_mappings flags (is_cash_account / is_retained_earnings /
 * is_payroll_account — each column is nullable BOOLEAN as of migration
 * 20260904120000, NULL meaning no professional decision exists for that
 * dimension). Each field here is tri-state by omission, not by value:
 *   - key absent from this object     → not reviewed this decision. The
 *     built payload OMITS the corresponding key entirely. In
 *     resolve_account_review_batch: a brand-new account_mappings row gets
 *     NULL for it (never a manufactured false); an existing row PRESERVES
 *     whatever value it already carries (NULL stays NULL, true stays true,
 *     false stays false). This is what stops a routine classification
 *     decision from silently erasing or fabricating a flag the professional
 *     never reviewed.
 *   - key present, true or false      → the professional explicitly
 *     reviewed this dimension and recorded that decision. Sent through
 *     verbatim; becomes the new authoritative value (NULL → that value on
 *     a new row, latest-decision-wins overwrite on an existing row).
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
  /** CONFIRM_ACCOUNT_TREATMENT only (20261007100000): the engine's treatment request and the treatment kept. */
  treatment_request_id?: string;
  treatment?: "keep_as_mapped";
}

/** A treatment reason must be 3–500 characters after trimming (the RPC refuses anything else). */
export function isTreatmentReasonValid(reason: string | undefined): boolean {
  const n = (reason ?? "").trim().length;
  return n >= 3 && n <= 500;
}

/**
 * Confirms that an account flagged by the engine for a treatment decision is KEPT AS MAPPED, with a recorded reason
 * (CONFIRM_ACCOUNT_TREATMENT, 20261007100000). The server binds the decision to the engine's request — company, upload,
 * source bytes, account facts, mapping decision and rule version — and accepts it only for that exact, current request.
 * It never changes the mapping; changing the classification is an ordinary review decision instead.
 */
export function buildTreatmentConfirmation(
  account: ReviewDecisionAccount,
  treatmentRequestId: string,
  reason: string,
): ReviewDecisionPayload {
  if (!/^[0-9a-f]{64}$/.test(treatmentRequestId)) throw new Error("treatment request id must be a 64-character hex digest");
  if (!isTreatmentReasonValid(reason)) throw new Error("a treatment confirmation needs a reason of 3–500 characters");
  return {
    account_code: account.account_code,
    account_name: account.account_name,
    proposal_type: "NONE",
    decision_action: "CONFIRM_ACCOUNT_TREATMENT",
    treatment_request_id: treatmentRequestId,
    treatment: "keep_as_mapped",
    reason: reason.trim(),
  };
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

/** The "keep as mapped" choice value for a treatment row (never a classification). */
export const KEEP_AS_MAPPED_CHOICE = "__keep_as_mapped__";

export interface BatchAccount extends ReviewDecisionAccount {
  /** Set only on rows the engine flagged for a treatment decision. */
  treatment_request_id?: string;
}

/**
 * The whole batch the panel submits, one payload per account:
 *   excluded                         → MARK_NON_REPORTING_ACCOUNT (buildReviewDecision)
 *   "keep as mapped" on a flagged row → CONFIRM_ACCOUNT_TREATMENT with the RECORDED reason (buildTreatmentConfirmation)
 *   any classification               → USER_ACCEPTED_SUGGESTION / USER_MANUAL_CLASSIFICATION (buildReviewDecision)
 * A "keep as mapped" choice on a row without a treatment request, or without a valid recorded reason, is refused here —
 * the panel never submits it.
 */
export function buildBatchDecisions(
  accounts: { key: string; account: BatchAccount }[],
  excluded: ReadonlySet<string>,
  choices: Readonly<Record<string, string>>,
  keepReasons: Readonly<Record<string, string>>,
  flagChoices: Readonly<Record<string, ReviewFlagDecisions>>,
  classificationMeta: (cls: string) => { statement: string; normal_balance: "debit" | "credit" },
): ReviewDecisionPayload[] {
  return accounts.map(({ key, account }) => {
    const identity: ReviewDecisionAccount = { account_code: account.account_code, account_name: account.account_name, suggested_classification: account.suggested_classification };
    if (!excluded.has(key) && choices[key] === KEEP_AS_MAPPED_CHOICE) {
      if (!account.treatment_request_id) throw new Error(`"keep as mapped" is only available for an account the engine flagged (${account.account_name})`);
      return buildTreatmentConfirmation(identity, account.treatment_request_id, keepReasons[key] ?? "");
    }
    return buildReviewDecision(identity, excluded.has(key), choices[key], classificationMeta, flagChoices[key]);
  });
}
