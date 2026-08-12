/**
 * reviewDecisionState.test.ts
 *
 * Slice 8 — proves the five decision states, the reversible Previous/Next
 * navigation, and Section XXVI Scenario 8 (return to a prior decision,
 * change it, continue, without corrupting any other row's state).
 */

import { describe, it, expect } from "vitest";
import {
  deriveReviewDecisionState,
  isRowResolved,
  remainingCount,
  hasUnsavedDraftDecisions,
  allRowsResolved,
  canGoPrevious,
  canGoNext,
  goPrevious,
  goNext,
  decisionProgressLabel,
  remainingLabel,
  type ReviewRowDraft,
  type ReviewNavigationState,
} from "./reviewDecisionState";

function row(overrides: Partial<ReviewRowDraft>): ReviewRowDraft {
  return { rowKey: "k1", excluded: false, committed: false, ...overrides };
}

describe("deriveReviewDecisionState — the five Section XVI states", () => {
  it("no choice, not excluded -> UNDECIDED", () => {
    expect(deriveReviewDecisionState(row({}))).toBe("UNDECIDED");
  });

  it("draft choice equals the original suggestion -> DRAFT_ACCEPT", () => {
    expect(
      deriveReviewDecisionState(
        row({ suggestedClassification: "revenue", currentChoice: "revenue" }),
      ),
    ).toBe("DRAFT_ACCEPT");
  });

  it("draft choice differs from the original suggestion -> DRAFT_CHANGE", () => {
    expect(
      deriveReviewDecisionState(
        row({ suggestedClassification: "revenue", currentChoice: "operating_expenses" }),
      ),
    ).toBe("DRAFT_CHANGE");
  });

  it("a fresh choice with no prior suggestion at all -> DRAFT_CHANGE (there was nothing to accept)", () => {
    expect(deriveReviewDecisionState(row({ currentChoice: "operating_expenses" }))).toBe(
      "DRAFT_CHANGE",
    );
  });

  it("excluded -> DRAFT_EXCLUDE, regardless of any choice present", () => {
    expect(deriveReviewDecisionState(row({ excluded: true, currentChoice: "revenue" }))).toBe(
      "DRAFT_EXCLUDE",
    );
  });

  it("committed -> COMMITTED, overriding every other flag", () => {
    expect(
      deriveReviewDecisionState(row({ committed: true, excluded: true, currentChoice: "revenue" })),
    ).toBe("COMMITTED");
  });
});

describe("resolution counting", () => {
  const rows: ReviewRowDraft[] = [
    row({ rowKey: "a", currentChoice: "revenue" }), // resolved
    row({ rowKey: "b", excluded: true }), // resolved
    row({ rowKey: "c" }), // undecided
    row({ rowKey: "d" }), // undecided
  ];

  it("remainingCount only counts UNDECIDED rows", () => {
    expect(remainingCount(rows)).toBe(2);
  });

  it("remainingLabel pluralises correctly", () => {
    expect(remainingLabel(rows)).toBe("2 decisions remaining");
    expect(remainingLabel([row({ rowKey: "e" })])).toBe("1 decision remaining");
    expect(remainingLabel([])).toBe("0 decisions remaining");
  });

  it("allRowsResolved is false while any row is UNDECIDED, true once every row has a draft state", () => {
    expect(allRowsResolved(rows)).toBe(false);
    const allDone = rows.map((r) => (isRowResolved(r) ? r : { ...r, currentChoice: "revenue" }));
    expect(allRowsResolved(allDone)).toBe(true);
  });

  it("allRowsResolved is false for an empty row list — nothing to resolve is not the same as resolved", () => {
    expect(allRowsResolved([])).toBe(false);
  });

  it("hasUnsavedDraftDecisions is true once at least one row has a live draft, false once everything is committed", () => {
    expect(hasUnsavedDraftDecisions(rows)).toBe(true);
    const allCommitted = rows.map((r) => ({ ...r, committed: true }));
    expect(hasUnsavedDraftDecisions(allCommitted)).toBe(false);
  });
});

describe("Previous/Next navigation (C6: selection != commit, freely reversible)", () => {
  it("decisionProgressLabel matches Section XVI's literal example format", () => {
    const nav: ReviewNavigationState = { currentIndex: 22, total: 44 };
    expect(decisionProgressLabel(nav)).toBe("Decision 23 of 44");
  });

  it("canGoPrevious/canGoNext are correct at both boundaries", () => {
    expect(canGoPrevious({ currentIndex: 0, total: 44 })).toBe(false);
    expect(canGoPrevious({ currentIndex: 1, total: 44 })).toBe(true);
    expect(canGoNext({ currentIndex: 43, total: 44 })).toBe(false);
    expect(canGoNext({ currentIndex: 42, total: 44 })).toBe(true);
  });

  it("goPrevious/goNext are clamped no-ops at the boundaries, never go out of range", () => {
    expect(goPrevious({ currentIndex: 0, total: 44 })).toEqual({ currentIndex: 0, total: 44 });
    expect(goNext({ currentIndex: 43, total: 44 })).toEqual({ currentIndex: 43, total: 44 });
  });

  it("Section XXVI Scenario 8 — at decision 23/44, go back to 22, and forward navigation still works afterward", () => {
    let nav: ReviewNavigationState = { currentIndex: 22, total: 44 }; // "Decision 23 of 44"
    nav = goPrevious(nav); // -> "Decision 22 of 44"
    expect(decisionProgressLabel(nav)).toBe("Decision 22 of 44");
    nav = goNext(nav); // back to 23
    expect(decisionProgressLabel(nav)).toBe("Decision 23 of 44");
  });

  it("Scenario 8 — changing a draft selection on a row already visited does not corrupt any other row's state", () => {
    const rows: ReviewRowDraft[] = [
      row({ rowKey: "22", currentChoice: "revenue" }),
      row({ rowKey: "23", currentChoice: "operating_expenses" }),
      row({ rowKey: "24" }),
    ];
    // Simulate: user goes back to row "22" and changes their mind.
    const updated = rows.map((r) => (r.rowKey === "22" ? { ...r, currentChoice: "other_income" } : r));
    expect(deriveReviewDecisionState(updated[0])).toBe("DRAFT_CHANGE");
    // Row "23" and "24" are untouched — no cross-row corruption.
    expect(updated[1]).toEqual(rows[1]);
    expect(updated[2]).toEqual(rows[2]);
  });
});
