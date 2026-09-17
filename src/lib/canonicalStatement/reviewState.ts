// canonicalStatement/reviewState.ts — the atomic review-correction command.
//
// `CanonicalReviewState` pairs a report with its decision log as one
// immutable aggregate. `recordFactCorrection` is the ONLY public way to
// correct a fact: it appends the corrected MonetaryFact version, appends
// its CorrectFactDecision, AND advances `reportIdentity.reportVersion` by
// exactly 1 — all three, or none. There is no exported primitive that
// performs any subset of these — see reviewerDecisions.ts's
// `StandaloneReviewerDecision` type, which excludes CorrectFactDecision
// from the general-purpose `appendDecision`, and provenance.ts's module
// comment, which does not export a bare fact-ledger-append function.
//
// `reportVersion` advancing is what makes `evaluationId` (rules/ruleEngine.ts)
// meaningful across corrections: two materially different report states
// must never share one reportVersion, or two different evaluated results
// for the "same" version could exist, which would break replay and audit
// semantics. `CorrectFactDecision.expectedReportVersion` is an optimistic-
// concurrency guard — the reportVersion the caller last read the report
// at. This is a pure in-memory domain command: it guarantees the guard is
// checked correctly, but the actual compare-and-swap against concurrent
// writers is a future persistence layer's responsibility, not this
// function's — nothing here claims database-level concurrency safety.
//
// Every failure mode throws BEFORE any append happens — this function
// never returns a state with some-but-not-all of {fact, decision,
// reportVersion bump} applied, and it never mutates the `state` it was
// given (every success path returns a brand-new object; `state.report`/
// `state.decisions` are structurally untouched).

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
 * Atomically applies a fact correction. On success, the returned state's
 * `report.facts` gains exactly one new MonetaryFact version, `decisions`
 * gains exactly one CorrectFactDecision, and
 * `report.reportIdentity.reportVersion` is exactly
 * `state.report.reportIdentity.reportVersion + 1`. On any rejection,
 * throws `FactCorrectionRejectedError` (or `CanonicalValidationError` from
 * the initial or final validation pass) and returns nothing — `state`
 * itself is never mutated and no partial result is ever observable.
 */
export function recordFactCorrection(
  state: CanonicalReviewState,
  decision: CorrectFactDecision,
  provenance: ProvenanceRecord,
): CanonicalReviewState {
  // 0. The input report itself must already be a valid aggregate — a
  // correction is never the first line of defense against a corrupt input.
  validateCanonicalReport(state.report);

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

  // 3. Optimistic-concurrency guard: the command must have been formed
  // against the report's CURRENT version, not a stale one.
  if (decision.expectedReportVersion !== state.report.reportIdentity.reportVersion) {
    throw new FactCorrectionRejectedError(
      `expectedReportVersion=${decision.expectedReportVersion} is stale — the report is currently at reportVersion=${state.report.reportIdentity.reportVersion}; re-read the report before correcting it`,
    );
  }

  // 4. The fact must exist.
  const latest = resolveLatestFact(state.report.facts, decision.factId);
  if (!latest) {
    throw new FactCorrectionRejectedError(`fact "${decision.factId}" does not exist in this report`);
  }

  // 5. supersedesVersion must be the CURRENT latest version — never a stale one.
  if (decision.supersedesVersion !== latest.version) {
    throw new FactCorrectionRejectedError(
      `supersedesVersion=${decision.supersedesVersion} is stale — the latest known version of "${decision.factId}" is ${latest.version}; re-read the fact before correcting it`,
    );
  }

  // 6. newVersion must be exactly supersedesVersion + 1.
  if (decision.newVersion !== decision.supersedesVersion + 1) {
    throw new FactCorrectionRejectedError(`newVersion (${decision.newVersion}) must equal supersedesVersion + 1 (${decision.supersedesVersion + 1})`);
  }

  // 7. The corrected Money, if present, must share the prior value's denomination — a correction fixes an amount, it does not smuggle in a currency/scale change.
  if (latest.value !== null && decision.correctedValue !== null && !sameDenomination(latest.value, decision.correctedValue)) {
    throw new FactCorrectionRejectedError(
      `corrected value's denomination (${decision.correctedValue.currency}@${decision.correctedValue.scale}) does not match the prior value's denomination (${latest.value.currency}@${latest.value.scale})`,
    );
  }
  if (!decision.rationale.trim()) {
    throw new FactCorrectionRejectedError("a fact correction requires a non-empty rationale");
  }

  // 8, 9 & the version bump: append the corrected fact, append the
  // decision, and advance reportVersion by exactly 1 — together.
  const correctedFact: MonetaryFact = {
    factId: decision.factId,
    version: decision.newVersion,
    value: decision.correctedValue,
    reportingPeriod: latest.reportingPeriod,
    signConvention: latest.signConvention,
    provenance,
    supersedesVersion: decision.supersedesVersion,
  };
  const nextReport: CanonicalFinancialStatementReport = {
    ...state.report,
    reportIdentity: { ...state.report.reportIdentity, reportVersion: state.report.reportIdentity.reportVersion + 1 },
    facts: [...state.report.facts, correctedFact],
  };
  const nextDecisions: ReviewerDecisionLog = [...state.decisions, decision];

  // 10. Return only a re-validated aggregate — never a state whose report has silently drifted out of validity.
  const validatedReport = validateCanonicalReport(nextReport);
  return { report: validatedReport, decisions: nextDecisions };
}
