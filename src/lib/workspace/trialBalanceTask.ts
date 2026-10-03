/**
 * trialBalanceTask — "where am I in Trial balance review, and what is the one thing to do now". Pure.
 *
 * Derived only from the trial-balance verdict (trialBalanceVerdict.ts) and the readiness rule
 * (trialBalanceReadiness.ts), so the step shown at the top of Prepare can never disagree with the card's status and
 * primary action beneath it. The four steps are the service's own workflow (moduleAvailability TRIAL_BALANCE_REVIEW).
 */

import { TRIAL_BALANCE_REVIEW } from "./moduleAvailability";
import { trialBalanceReadiness, type ReconciliationEvidence } from "./trialBalanceReadiness";
import type { TrialBalanceVerdict } from "./trialBalanceVerdict";

export interface TrialBalanceTask {
  service: string;
  step: 1 | 2 | 3 | 4;
  of: 4;
  label: string;
  /** One sentence: what to do now (or that nothing is needed). */
  instruction: string;
}

const STEP_LABELS = TRIAL_BALANCE_REVIEW.workflow;

function task(step: 1 | 2 | 3 | 4, instruction: string): TrialBalanceTask {
  return { service: TRIAL_BALANCE_REVIEW.title, step, of: 4, label: STEP_LABELS[step - 1], instruction };
}

export function currentTrialBalanceTask(
  verdict: Pick<TrialBalanceVerdict, "status" | "failedCheckId" | "issues">,
  evidence: { safishaStatus: string | null | undefined; reconciliation: ReconciliationEvidence | null | undefined },
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
          ? `Correct ${verdict.issues.length === 1 ? "the issue" : `the ${verdict.issues.length} issues`} listed below in your file, then replace it.`
          : "Correct the file, then replace it.");
    case "needs_review":
      return task(2, "Confirm the classification of the accounts listed below.");
    case "accepted": {
      const readiness = trialBalanceReadiness({ certificationVerdict: "certified", safishaStatus: evidence.safishaStatus, reconciliation: evidence.reconciliation });
      return readiness.ready
        ? task(4, "Checks passed, accounts confirmed and evidence reconciled. Nothing more is needed for this period.")
        : task(3, readiness.nextStep ?? "Match the trial balance to supporting evidence.");
    }
  }
}
