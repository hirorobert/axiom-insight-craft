// Presentation only: never changes server applicability, blockers or readiness.
import type { CompositionResult } from "@/lib/statements/composition";
import type { RequirementState } from "@/lib/notes/notesStatus";

export function presentationPending(c: CompositionResult | null): boolean {
  return !c || c.state !== "composed" || c.blockers.length > 0
    || c.accountsNotPresented.length > 0 || c.totals.current?.state !== "complete"
    || (c.comparative.state === "available" && c.totals.comparative?.state !== "complete");
}

export function provisionalApplicability(r: RequirementState, c: CompositionResult | null): boolean {
  // Only automatic amount-based non-applicability is qualified. Recorded decisions and edition elections stay intact.
  return r.status === "not_applicable" && !r.decisionId && presentationPending(c)
    && (r.kind === "SCHEDULE" || ["smes.note.revenue", "smes.note.income_tax"].includes(r.requirementId));
}

export const PROVISIONAL_APPLICABILITY = "Awaiting complete statement presentation";
export const APPLICABILITY_EXPLANATION = "This automatic assessment depends on presented amounts. Complete the statement assignments and resolve composition blockers before relying on it. Missing presentation is not evidence that this item does not apply.";
