// canonicalStatement/reviewerDecisions.ts — the append-only reviewer
// decision log. Decisions are never mutated or removed once appended;
// `appendDecision` always returns a new array. A duplicate `decisionId` is
// refused rather than silently overwriting the original decision.
//
// `appendDecision`'s type deliberately EXCLUDES `CorrectFactDecision` — a
// fact correction must always be recorded atomically with its ledger
// append via `reviewState.ts`'s `recordFactCorrection`, the only public way
// to do that. Appending a bare CORRECT_FACT decision here (with no
// corresponding fact version ever created) is a compile-time type error,
// not just a documented convention.

import type { ReviewerDecision, ReviewerDecisionLog } from "./types";

export type StandaloneReviewerDecision = Exclude<ReviewerDecision, { decisionType: "CORRECT_FACT" | "CORRECT_EVIDENCE" }>;

export class DuplicateDecisionIdError extends Error {
  constructor(decisionId: string) {
    super(`A decision with decisionId "${decisionId}" was already recorded — decisions are append-only`);
    this.name = "DuplicateDecisionIdError";
  }
}

export function appendDecision(log: ReviewerDecisionLog, decision: StandaloneReviewerDecision): ReviewerDecisionLog {
  if (log.some((existing) => existing.decisionId === decision.decisionId)) {
    throw new DuplicateDecisionIdError(decision.decisionId);
  }
  return [...log, decision];
}

function targetsFinding(decision: ReviewerDecision): decision is Extract<ReviewerDecision, { target?: unknown }> {
  return decision.decisionType === "ACCEPT_FINDING" || decision.decisionType === "REJECT_FINDING" || decision.decisionType === "REQUEST_EVIDENCE" || decision.decisionType === "DEFER";
}

/** Matches a decision whose `target` names this exact findingKey or evaluationId. */
export function decisionsForFinding(log: ReviewerDecisionLog, target: { readonly findingKey?: string; readonly evaluationId?: string }): readonly ReviewerDecision[] {
  return log.filter((decision) => {
    if (!targetsFinding(decision) || !decision.target) return false;
    if (decision.target.kind === "FINDING_KEY") return decision.target.findingKey === target.findingKey;
    return decision.target.evaluationId === target.evaluationId;
  });
}

export function decisionsForFact(log: ReviewerDecisionLog, factId: string): readonly ReviewerDecision[] {
  return log.filter(
    (decision) =>
      (decision.decisionType === "ACCEPT_FACT" && decision.factId === factId) ||
      (decision.decisionType === "CORRECT_FACT" && decision.factId === factId) ||
      ((decision.decisionType === "REQUEST_EVIDENCE" || decision.decisionType === "DEFER") && decision.factId === factId),
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
  target: { readonly findingKey?: string; readonly evaluationId?: string },
): "ACCEPTED" | "REJECTED" | "AWAITING_EVIDENCE" | "DEFERRED" | "OPEN" {
  const relevant = decisionsForFinding(log, target);
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
