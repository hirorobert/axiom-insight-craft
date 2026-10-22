/**
 * trialBalanceTask — "where am I in Trial balance review, and what is the one thing to do now". Pure.
 *
 * Derived only from the trial-balance verdict (trialBalanceVerdict.ts), so the step shown at the top of Prepare can never
 * disagree with the card's status and primary action beneath it. The three steps are the service's own workflow
 * (moduleAvailability TRIAL_BALANCE_REVIEW). An accepted verdict IS readiness (trialBalanceReadiness: certified = checks
 * passed and every classification confirmed); supporting-evidence reconciliation is not a step of this service.
 */

import { TRIAL_BALANCE_REVIEW } from "./moduleAvailability";
import { reviewedScope, type TrialBalanceVerdict } from "./trialBalanceVerdict";

export interface TrialBalanceTask {
  service: string;
  step: 1 | 2 | 3;
  of: 3;
  label: string;
  /** One sentence: what to do now (or that nothing is needed). */
  instruction: string;
}

const STEP_LABELS = TRIAL_BALANCE_REVIEW.workflow;

function task(step: 1 | 2 | 3, instruction: string): TrialBalanceTask {
  return { service: TRIAL_BALANCE_REVIEW.title, step, of: 3, label: STEP_LABELS[step - 1], instruction };
}

/**
 * The classification step for someone whose access does not include account review (a Prepare-only grant): the review
 * list is not on their page, so "the accounts listed below" would point at nothing. The step says what blocks it and who
 * can resolve it; access itself is unchanged.
 */
export const CLASSIFICATION_NEEDS_REVIEW_ACCESS =
  "Some accounts need a classification decision. Account review requires separate access to this workspace, so a workspace member with review access needs to confirm them.";

/**
 * The card's verdict as a viewer can act on it: without review access the account review is not on the page, so the
 * "Resolve account classifications" action would lead nowhere and is withdrawn. The step text explains instead
 * (CLASSIFICATION_NEEDS_REVIEW_ACCESS). Nothing about the server's gate changes.
 */
export function cardVerdictForAccess<V extends { primaryAction: { kind: string } | null }>(verdict: V, reviewAccess: boolean): V {
  return !reviewAccess && verdict.primaryAction?.kind === "review_classifications" ? { ...verdict, primaryAction: null } : verdict;
}

export function currentTrialBalanceTask(
  verdict: Pick<TrialBalanceVerdict, "status" | "failedCheckId" | "issues"> & { equationExact?: boolean; statusLabel?: string },
  options: { reviewAccess?: boolean } = {},
): TrialBalanceTask {
  const classify = options.reviewAccess === false ? CLASSIFICATION_NEEDS_REVIEW_ACCESS : "Confirm the classification of the accounts listed below.";
  switch (verdict.status) {
    case "none":
      return task(1, "Upload the trial balance for this period.");
    // Derived from the actual processing state: only a running check is "being checked".
    case "processing":
      return task(1, "The file is being checked. This page updates itself.");
    case "checking":
      // A result was read for another file version, or not yet confirmed: nothing is running.
      return task(1, "The result for this file is being confirmed. This page updates itself.");
    case "needs_recheck":
      // An input changed after the last check (for example a newly confirmed file layout): nothing is running.
      return task(1, "The last result is out of date because an input changed (for example the file's layout). Run the check again.");
    case "processing_failed":
      return task(1, "The check stopped before it finished. Run it again.");
    case "not_current":
      return task(1, "This is an earlier upload. Open the current trial balance for this period.");
    case "unavailable":
      // A failed read, or recorded findings that cannot be read: the card states which.
      return task(1, "The result could not be confirmed. The reason is shown below.");
    case "blocked":
      // A file recorded as another entity's: the next step is moving it, not correcting it.
      if (verdict.issues.some((i) => i.code === "ENTITY_WRONG_DESTINATION")) {
        return task(1, "You recorded that this file belongs to another entity. Remove it from this engagement and upload it to the right one.");
      }
      return verdict.failedCheckId === "l4_classification"
        ? task(2, classify)
        : task(1, verdict.issues.length > 0
          ? `Correct ${verdict.issues.length === 1 ? "the issue" : `the ${verdict.issues.length} issues`} shown below in your file, then replace it.`
          : "Correct the file, then replace it.");
    case "needs_review":
      // Findings that need a recorded decision (and no classification): decide each one; the file is then checked again.
      if (verdict.statusLabel === "Needs your decision") {
        return task(1, "Record a decision on each finding listed below. The file is then checked again with your decisions.");
      }
      // Held by an arithmetic check (debits/credits, statement equation or an unknown check), not a classification.
      return verdict.failedCheckId === "l3_arithmetic"
        ? task(1, "An arithmetic check needs attention before this trial balance can be reviewed. See the checks below.")
        : task(2, classify);
    case "accepted":
      return task(3, `${TRIAL_BALANCE_REVIEW.ready}. ${reviewedScope(verdict.equationExact === true)} ${TRIAL_BALANCE_REVIEW.notApproval}`);
  }
}
