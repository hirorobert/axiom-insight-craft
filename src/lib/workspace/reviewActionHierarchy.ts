/**
 * reviewActionHierarchy — which ONE action leads on the trial-balance page when the account review is open. Pure.
 *
 * The page carries two actions for the review task: the result card's "Resolve account classifications" (it leads to
 * and focuses the review section) and the review panel's "Save & reprocess" (it submits the decisions). Exactly one is
 * emphasised, chosen from the panel's own review state — the decisions the reviewer has made, never a guess:
 *
 *   incomplete  some account still needs a decision        → the card's Resolve leads (Save stays secondary and disabled)
 *   ready       every account has a valid, unsaved decision → Save & reprocess leads; Resolve is secondary
 *   failed      the last save was refused; decisions kept    → Save & reprocess leads again (retry), with the reason shown
 *   submitting  saving or reprocessing                       → Save & reprocess stays emphasised, disabled, with progress
 *   nothing     nothing to submit (no accounts left)         → the card's own next action leads; Save is not promoted
 *
 * A card action that is not about classification (Replace, Retry) keeps the lead: the file must change, or the check
 * must run, before a classification decision can count. Nothing here changes what any action does or may do.
 */

export type ReviewSubmissionState = "nothing" | "incomplete" | "ready" | "failed" | "submitting";
export type ActionEmphasis = "primary" | "secondary";

export interface ReviewSubmissionInput {
  /** Accounts still in the review (needing a decision and not excluded). */
  pendingCount: number;
  /** Of those, how many still have no valid decision. */
  undecidedCount: number;
  /** Accounts the reviewer marked as not reporting (a decision in itself). */
  excludedCount: number;
  saving: boolean;
  reprocessing: boolean;
  /** The last save attempt was refused (nothing was saved; the decisions on screen are kept). */
  lastSaveFailed: boolean;
}

export function deriveReviewSubmission(i: ReviewSubmissionInput): ReviewSubmissionState {
  if (i.saving || i.reprocessing) return "submitting";
  const anything = i.pendingCount > 0 || i.excludedCount > 0;
  if (!anything) return "nothing";
  if (i.pendingCount > 0 && i.undecidedCount > 0) return "incomplete";
  return i.lastSaveFailed ? "failed" : "ready";
}

export function reviewActionHierarchy(
  cardAction: "replace" | "retry" | "review_classifications" | null,
  review: ReviewSubmissionState | null,
): { card: ActionEmphasis; save: ActionEmphasis } {
  // No review panel on screen: the card's action (if any) is the only action.
  if (review === null) return { card: "primary", save: "secondary" };
  // The file or the check comes first.
  if (cardAction === "replace" || cardAction === "retry") return { card: "primary", save: "secondary" };
  if (review === "ready" || review === "failed" || review === "submitting") return { card: "secondary", save: "primary" };
  // incomplete, or nothing to submit: the card leads (Resolve, or no card action at all).
  return { card: "primary", save: "secondary" };
}
