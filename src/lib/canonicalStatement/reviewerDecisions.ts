// canonicalStatement/reviewerDecisions.ts — the append-only reviewer
// decision log. Decisions are never mutated or removed once appended;
// `appendDecision` always returns a new array. A duplicate `decisionId` is
// refused rather than silently overwriting the original decision.

import type { ReviewerDecision, ReviewerDecisionLog } from "./types";

export class DuplicateDecisionIdError extends Error {
  constructor(decisionId: string) {
    super(`A decision with decisionId "${decisionId}" was already recorded — decisions are append-only`);
    this.name = "DuplicateDecisionIdError";
  }
}

export function appendDecision(log: ReviewerDecisionLog, decision: ReviewerDecision): ReviewerDecisionLog {
  if (log.some((existing) => existing.decisionId === decision.decisionId)) {
    throw new DuplicateDecisionIdError(decision.decisionId);
  }
  return [...log, decision];
}

export function decisionsForFinding(log: ReviewerDecisionLog, findingId: string): readonly ReviewerDecision[] {
  return log.filter(
    (decision) =>
      (decision.decisionType === "ACCEPT_FINDING" && decision.findingId === findingId) ||
      (decision.decisionType === "REJECT_FINDING" && decision.findingId === findingId) ||
      ((decision.decisionType === "REQUEST_EVIDENCE" || decision.decisionType === "DEFER") &&
        decision.findingId === findingId),
  );
}

export function decisionsForFact(log: ReviewerDecisionLog, factId: string): readonly ReviewerDecision[] {
  return log.filter(
    (decision) =>
      (decision.decisionType === "ACCEPT_FACT" && decision.factId === factId) ||
      (decision.decisionType === "CORRECT_FACT" && decision.factId === factId) ||
      ((decision.decisionType === "REQUEST_EVIDENCE" || decision.decisionType === "DEFER") &&
        decision.factId === factId),
  );
}

/**
 * Derives a finding's current status from the decision log, most-recent
 * decision wins. Returns "OPEN" when no decision references the finding —
 * the finding's own recorded status at creation time is the fallback the
 * caller should use in that case.
 */
export function deriveFindingStatus(
  log: ReviewerDecisionLog,
  findingId: string,
): "ACCEPTED" | "REJECTED" | "AWAITING_EVIDENCE" | "DEFERRED" | "OPEN" {
  const relevant = decisionsForFinding(log, findingId);
  if (relevant.length === 0) return "OPEN";
  const last = relevant[relevant.length - 1];
  switch (last.decisionType) {
    case "ACCEPT_FINDING":
      return "ACCEPTED";
    case "REJECT_FINDING":
      return "REJECTED";
    case "REQUEST_EVIDENCE":
      return "AWAITING_EVIDENCE";
    case "DEFER":
      return "DEFERRED";
    default:
      return "OPEN";
  }
}
