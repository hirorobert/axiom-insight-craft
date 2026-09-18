// financialStatementsWorkspace/reviewerDecisionCommands.ts — turns a reviewer's
// UI intent into a canonical append-only decision, with every guard that can
// be checked before anything is recorded.
//
// The four review outcomes map onto the canonical decision model (nothing in
// canonicalStatement is extended):
//
//   CORRECTED               -> CORRECT_FACT   (atomic fact correction: new fact
//                              version + new reportVersion, guarded by
//                              expectedReportVersion; the only path that can
//                              change an evaluated outcome)
//   ACCEPT_WITH_JUDGEMENT   -> ACCEPT_FINDING (requires a documented rationale;
//                              the defect stays visible — see findingsView)
//   NOT_APPLICABLE          -> REJECT_FINDING (requires a rationale)
//   UNRESOLVED              -> DEFER          (records that it remains open)
//
// A rationale is mandatory for all four: a decision without a documented
// reason is not accepted, even where the canonical type would allow it.

import { moneyFromDecimalString, sameDenomination } from "@/lib/canonicalStatement/money";
import { resolveLatestFact } from "@/lib/canonicalStatement/provenance";
import type {
  AcceptFindingDecision,
  CanonicalFinancialStatementReport,
  CorrectFactDecision,
  DeferDecision,
  ProvenanceRecord,
  RejectFindingDecision,
  RuleEvaluationRecord,
} from "@/lib/canonicalStatement/types";

export type ReviewOutcome = "CORRECTED" | "ACCEPT_WITH_JUDGEMENT" | "NOT_APPLICABLE" | "UNRESOLVED";

export const REVIEW_OUTCOME_LABELS: Readonly<Record<ReviewOutcome, string>> = {
  CORRECTED: "Correct a figure",
  ACCEPT_WITH_JUDGEMENT: "Accept with documented judgement",
  NOT_APPLICABLE: "Not applicable",
  UNRESOLVED: "Leave unresolved",
};

export class DecisionCommandError extends Error {
  constructor(readonly code: "RATIONALE_REQUIRED" | "NOT_ACTIONABLE" | "FACT_REQUIRED" | "FACT_NOT_IN_FINDING" | "FACT_NOT_FOUND" | "INVALID_AMOUNT" | "DENOMINATION_MISMATCH" | "NO_CHANGE", message: string) {
    super(message);
    this.name = "DecisionCommandError";
  }
}

export interface DecisionInput {
  readonly outcome: ReviewOutcome;
  readonly finding: RuleEvaluationRecord;
  readonly rationale: string;
  readonly report: CanonicalFinancialStatementReport;
  readonly decisionId: string;
  readonly decidedAt: string;
  /** firm_members.id when known locally. The server replaces this with the JWT-derived actor when persisting. */
  readonly reviewerId: string;
  /** Required for CORRECTED. */
  readonly correction?: { readonly factId: string; readonly correctedAmount: string };
}

export type DecisionCommand =
  | { readonly kind: "STANDALONE"; readonly decision: AcceptFindingDecision | RejectFindingDecision | DeferDecision }
  | { readonly kind: "CORRECTION"; readonly decision: CorrectFactDecision; readonly provenance: ProvenanceRecord };

export function buildDecisionCommand(input: DecisionInput): DecisionCommand {
  const rationale = input.rationale.trim();
  if (!rationale) throw new DecisionCommandError("RATIONALE_REQUIRED", "A documented reason is required for every review decision.");
  if (!input.finding.actionable) throw new DecisionCommandError("NOT_ACTIONABLE", "A passed or not-applicable control has nothing to decide.");

  const base = { decisionId: input.decisionId, reviewerId: input.reviewerId, decidedAt: input.decidedAt, rationale } as const;
  const target = { kind: "FINDING_KEY", findingKey: input.finding.findingKey } as const;

  switch (input.outcome) {
    case "ACCEPT_WITH_JUDGEMENT":
      return { kind: "STANDALONE", decision: { ...base, decisionType: "ACCEPT_FINDING", target } };
    case "NOT_APPLICABLE":
      return { kind: "STANDALONE", decision: { ...base, decisionType: "REJECT_FINDING", target, rationale } };
    case "UNRESOLVED":
      return { kind: "STANDALONE", decision: { ...base, decisionType: "DEFER", target } };
    case "CORRECTED": {
      if (!input.correction) throw new DecisionCommandError("FACT_REQUIRED", "Choose the figure to correct and enter the corrected amount.");
      const { factId, correctedAmount } = input.correction;
      if (!input.finding.evidenceReferences.some((e) => e.factId === factId)) {
        throw new DecisionCommandError("FACT_NOT_IN_FINDING", "That figure is not part of this finding's evidence.");
      }
      const latest = resolveLatestFact(input.report.facts, factId);
      if (!latest) throw new DecisionCommandError("FACT_NOT_FOUND", "That figure no longer exists in this report version.");
      let corrected;
      try {
        const denom = latest.value ?? { currency: input.report.presentationCurrency.currency, scale: input.report.presentationCurrency.scale };
        corrected = moneyFromDecimalString(denom.currency, denom.scale, correctedAmount);
      } catch (e) {
        throw new DecisionCommandError("INVALID_AMOUNT", e instanceof Error ? e.message : "The amount is not valid.");
      }
      if (latest.value && !sameDenomination(latest.value, corrected)) throw new DecisionCommandError("DENOMINATION_MISMATCH", "A correction cannot change the currency or decimal places.");
      if (latest.value && latest.value.minorUnits === corrected.minorUnits) throw new DecisionCommandError("NO_CHANGE", "The corrected amount equals the current amount.");
      const decision: CorrectFactDecision = {
        ...base,
        decisionType: "CORRECT_FACT",
        factId,
        supersedesVersion: latest.version,
        newVersion: latest.version + 1,
        correctedValue: corrected,
        expectedReportVersion: input.report.reportIdentity.reportVersion,
      };
      const provenance: ProvenanceRecord = {
        source: latest.provenance.source,
        locator: { kind: "MANUAL", note: `Reviewer correction ${input.decisionId}` },
        extractionMethod: "MANUAL_REVIEWER_ENTRY",
        extractionConfidence: { kind: "CERTAIN" },
        originalText: correctedAmount,
      };
      return { kind: "CORRECTION", decision, provenance };
    }
  }
}

export function isStaleVersionError(err: unknown): boolean {
  return err instanceof Error && /stale/i.test(err.message);
}
