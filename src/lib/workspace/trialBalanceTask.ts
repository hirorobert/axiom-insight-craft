/**
 * trialBalanceTask — "where am I in Trial balance review, and what is the one thing to do now". Pure.
 *
 * Derived only from the trial-balance verdict (trialBalanceVerdict.ts), so the step shown at the top of Prepare can never
 * disagree with the card's status and primary action beneath it. The three steps are the service's own workflow
 * (moduleAvailability TRIAL_BALANCE_REVIEW). An accepted verdict IS readiness (trialBalanceReadiness: certified = checks
 * passed and every classification confirmed); supporting-evidence reconciliation is not a step of this service.
 */

import { TRIAL_BALANCE_REVIEW } from "./moduleAvailability";
import { REVIEWED_SCOPE, type TrialBalanceVerdict } from "./trialBalanceVerdict";

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

export function currentTrialBalanceTask(
  verdict: Pick<TrialBalanceVerdict, "status" | "failedCheckId" | "issues">,
): TrialBalanceTask {
  switch (verdict.status) {
    case "none":
      return task(1, "Upload the trial balance for this period.");
    case "processing":
    case "checking":
      return task(1, "The file is being checked. This page updates itself.");
    case "processing_failed":
      return task(1, "The check stopped before it finished. Run it again.");
    case "not_current":
      return task(1, "This is an earlier upload. Open the current trial balance for this period.");
    case "unavailable":
      return task(1, "The result could not be read. Refresh the page.");
    case "blocked":
      return verdict.failedCheckId === "l4_classification"
        ? task(2, "Confirm the classification of the accounts listed below.")
        : task(1, verdict.issues.length > 0
          ? `Correct ${verdict.issues.length === 1 ? "the issue" : `the ${verdict.issues.length} issues`} shown below in your file, then replace it.`
          : "Correct the file, then replace it.");
    case "needs_review":
      // Held by an arithmetic check (debits/credits, statement equation or an unknown check), not a classification.
      return verdict.failedCheckId === "l3_arithmetic"
        ? task(1, "An arithmetic check needs attention before this trial balance can be reviewed. See the checks below.")
        : task(2, "Confirm the classification of the accounts listed below.");
    case "accepted":
      return task(3, `${TRIAL_BALANCE_REVIEW.ready}. ${REVIEWED_SCOPE} ${TRIAL_BALANCE_REVIEW.notApproval}`);
  }
}
