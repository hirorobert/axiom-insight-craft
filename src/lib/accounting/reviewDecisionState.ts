/**
 * reviewDecisionState.ts — Ω∞ public-sector / framework intelligence engine,
 * Slice 8: AccountReviewPanel reversible Previous/Next draft-decision
 * workflow (Section XVI).
 *
 * Pure state model only — no React, no Supabase I/O. AccountReviewPanel.tsx
 * imports this to derive what to render and whether Save is enabled; this
 * module has no opinion on rendering or persistence.
 *
 * Scope note: the EXISTING AccountReviewPanel.tsx (PHASE-0 audit §14)
 * already does draft-then-save correctly — a choice lives in local React
 * state, nothing hits account_mappings until "Save & Reprocess" is clicked.
 * That save contract is UNCHANGED by this slice. What was missing was the
 * Previous/Next one-at-a-time navigation and the five named decision states
 * — this module adds exactly that, as pure, testable logic.
 */

export type ReviewDecisionState =
  | "UNDECIDED"
  | "DRAFT_ACCEPT"
  | "DRAFT_CHANGE"
  | "DRAFT_EXCLUDE"
  | "COMMITTED";

export interface ReviewRowDraft {
  rowKey: string;
  /** The classifier's original suggestion for this row, if any. */
  suggestedClassification?: string;
  /** The user's current draft choice, if any (pre-Save, never yet written). */
  currentChoice?: string;
  excluded: boolean;
  /** True only after a successful Save & Reprocess for this row's upload. */
  committed: boolean;
}

/**
 * Section XVI's five states, derived (never stored redundantly) from the
 * row's actual draft data — so there is exactly one source of truth per row,
 * not a state flag that can drift out of sync with the choice/excluded data.
 */
export function deriveReviewDecisionState(row: ReviewRowDraft): ReviewDecisionState {
  if (row.committed) return "COMMITTED";
  if (row.excluded) return "DRAFT_EXCLUDE";
  if (!row.currentChoice) return "UNDECIDED";
  if (row.suggestedClassification && row.currentChoice === row.suggestedClassification) {
    return "DRAFT_ACCEPT";
  }
  return "DRAFT_CHANGE";
}

export function isRowResolved(row: ReviewRowDraft): boolean {
  const state = deriveReviewDecisionState(row);
  return state !== "UNDECIDED";
}

export function remainingCount(rows: ReviewRowDraft[]): number {
  return rows.filter((r) => deriveReviewDecisionState(r) === "UNDECIDED").length;
}

export function hasUnsavedDraftDecisions(rows: ReviewRowDraft[]): boolean {
  // Any row with a live draft (accepted/changed/excluded) that hasn't been
  // committed yet counts as "unsaved" — used to gate the navigate-away warning.
  return rows.some((r) => {
    const state = deriveReviewDecisionState(r);
    return state === "DRAFT_ACCEPT" || state === "DRAFT_CHANGE" || state === "DRAFT_EXCLUDE";
  });
}

export function allRowsResolved(rows: ReviewRowDraft[]): boolean {
  if (rows.length === 0) return false;
  return rows.every((r) => isRowResolved(r));
}

// ── Previous/Next navigation (Section XVI: "[← Previous] Decision 23 of 44 [Next →]") ──

export interface ReviewNavigationState {
  /** 0-based index into the row list. */
  currentIndex: number;
  total: number;
}

export function canGoPrevious(nav: ReviewNavigationState): boolean {
  return nav.currentIndex > 0;
}

export function canGoNext(nav: ReviewNavigationState): boolean {
  return nav.currentIndex < nav.total - 1;
}

/** Clamped — moving "previous" from index 0 is a no-op, never negative. */
export function goPrevious(nav: ReviewNavigationState): ReviewNavigationState {
  return canGoPrevious(nav) ? { ...nav, currentIndex: nav.currentIndex - 1 } : nav;
}

/** Clamped — moving "next" past the last row is a no-op, never out of range. */
export function goNext(nav: ReviewNavigationState): ReviewNavigationState {
  return canGoNext(nav) ? { ...nav, currentIndex: nav.currentIndex + 1 } : nav;
}

/** "Decision 23 of 44" — 1-based for display, per Section XVI's literal example. */
export function decisionProgressLabel(nav: ReviewNavigationState): string {
  return `Decision ${nav.currentIndex + 1} of ${nav.total}`;
}

/** "22 decisions remaining" — Section XVI's footer copy. */
export function remainingLabel(rows: ReviewRowDraft[]): string {
  const n = remainingCount(rows);
  return `${n} decision${n === 1 ? "" : "s"} remaining`;
}
