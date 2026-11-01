// Presentation only: never changes server applicability, blockers or readiness.
import type { CompositionResult } from "@/lib/statements/composition";
import { IFRS_FOR_SMES_PACKS } from "@/lib/frameworkPacks/ifrsForSmes";
import type { NotesStatus, RequirementState } from "@/lib/notes/notesStatus";

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

/** Resolve only the edition named by the server; a taxonomy package never selects a reporting framework. */
export function preparationPack(notes: NotesStatus, composition: CompositionResult | null) {
  const pack = IFRS_FOR_SMES_PACKS.find((p) => p.id === notes.packId);
  if (!pack) return null;
  if (composition?.state === "composed" && (composition.pack.packId !== pack.id
    || composition.current.periodYear !== notes.periodYear
    || composition.compositionSha256 !== notes.compositionSha256)) return null;
  return pack;
}

export const PREPARATION_CONTEXT_MISMATCH = "The statement and preparation edition, period or source revision do not agree. Refresh the reporting workspace before entering notes or schedules.";
export const SCHEDULE_DENOMINATION_MISSING = "Schedule amounts need the currency and decimal places from the current statements. Review the trial balance and statement presentation, then refresh this workspace. No currency or decimal places have been assumed.";
