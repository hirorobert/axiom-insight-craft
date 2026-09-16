// canonicalStatement/reviewState.ts — the atomic review-correction command.
//
// `CanonicalReviewState` pairs a report with its decision log as one
// immutable aggregate. `recordFactCorrection` is the ONLY public way to
// correct a fact: it appends the corrected MonetaryFact version and its
// CorrectFactDecision together, or neither. There is no exported primitive
// that appends one without the other — see reviewerDecisions.ts's
// `StandaloneReviewerDecision` type, which excludes CorrectFactDecision
// from the general-purpose `appendDecision`, and provenance.ts's module
// comment, which does not export a bare fact-ledger-append function.
//
// Every failure mode throws BEFORE either append happens — this function
// never returns a state with one appended and not the other, and it never
// mutates the `state` it was given (every success path returns a brand-new
// object; `state.report`/`state.decisions` are structurally untouched).

import type { CanonicalFinancialStatementReport, CorrectFactDecision, MonetaryFact, ProvenanceRecord, ReviewerDecisionLog } from "./types";
import { resolveLatestFact } from "./provenance";
import { sameDenomination } from "./money";
import { validateCanonicalReport } from "./validation";

export interface CanonicalReviewState {
  readonly report: CanonicalFinancialStatementReport;
  readonly decisions: ReviewerDecisionLog;
}

export class FactCorrectionRejectedError extends Error {
  constructor(reason: string) {
    super(`Fact correction rejected: ${reason}`);
    this.name = "FactCorrectionRejectedError";
  }
}

/**
 * Atomically applies a fact correction: validates the decision and the
 * fact it targets, then appends both the corrected fact version and the
 * decision, then re-validates the resulting report. Throws
 * `FactCorrectionRejectedError` (or `CanonicalValidationError` from the
 * final re-validation step) and changes nothing if any check fails.
 */
export function recordFactCorrection(
  state: CanonicalReviewState,
  decision: CorrectFactDecision,
  provenance: ProvenanceRecord,
): CanonicalReviewState {
  // 1. Decision identity must be non-empty and not already recorded.
  if (!decision.decisionId.trim()) {
    throw new FactCorrectionRejectedError("decisionId must not be empty");
  }
  if (state.decisions.some((existing) => existing.decisionId === decision.decisionId)) {
    throw new FactCorrectionRejectedError(`decisionId "${decision.decisionId}" was already recorded — decisions are append-only`);
  }

  // 2. Reviewer identity must be non-empty.
  if (!decision.reviewerId.trim()) {
    throw new FactCorrectionRejectedError("reviewerId must not be empty");
  }

  // 3. The fact must exist.
  const latest = resolveLatestFact(state.report.facts, decision.factId);
  if (!latest) {
    throw new FactCorrectionRejectedError(`fact "${decision.factId}" does not exist in this report`);
  }

  // 4. supersedesVersion must be the CURRENT latest version — never a stale one.
  if (decision.supersedesVersion !== latest.version) {
    throw new FactCorrectionRejectedError(
      `supersedesVersion=${decision.supersedesVersion} is stale — the latest known version of "${decision.factId}" is ${latest.version}; re-read the fact before correcting it`,
    );
  }

  // 5. newVersion must be exactly supersedesVersion + 1.
  if (decision.newVersion !== decision.supersedesVersion + 1) {
    throw new FactCorrectionRejectedError(`newVersion (${decision.newVersion}) must equal supersedesVersion + 1 (${decision.supersedesVersion + 1})`);
  }

  // 6. The corrected Money, if present, must share the prior value's denomination — a correction fixes an amount, it does not smuggle in a currency/scale change.
  if (latest.value !== null && decision.correctedValue !== null && !sameDenomination(latest.value, decision.correctedValue)) {
    throw new FactCorrectionRejectedError(
      `corrected value's denomination (${decision.correctedValue.currency}@${decision.correctedValue.scale}) does not match the prior value's denomination (${latest.value.currency}@${latest.value.scale})`,
    );
  }
  if (!decision.rationale.trim()) {
    throw new FactCorrectionRejectedError("a fact correction requires a non-empty rationale");
  }

  // 7 & 8. Append the corrected fact and the decision together.
  const correctedFact: MonetaryFact = {
    factId: decision.factId,
    version: decision.newVersion,
    value: decision.correctedValue,
    reportingPeriod: latest.reportingPeriod,
    signConvention: latest.signConvention,
    provenance,
    supersedesVersion: decision.supersedesVersion,
  };
  const nextReport: CanonicalFinancialStatementReport = { ...state.report, facts: [...state.report.facts, correctedFact] };
  const nextDecisions: ReviewerDecisionLog = [...state.decisions, decision];

  // 9. Return only a re-validated aggregate — never a state whose report has silently drifted out of validity.
  const validatedReport = validateCanonicalReport(nextReport);
  return { report: validatedReport, decisions: nextDecisions };
}
