import { describe, expect, it } from "vitest";
import { deriveReviewSubmission, reviewActionHierarchy, type ReviewSubmissionInput } from "./reviewActionHierarchy";

const base: ReviewSubmissionInput = { pendingCount: 3, undecidedCount: 0, excludedCount: 0, saving: false, reprocessing: false, lastSaveFailed: false };

describe("deriveReviewSubmission — the panel's own review state", () => {
  it("incomplete while any account has no valid decision", () => {
    expect(deriveReviewSubmission({ ...base, undecidedCount: 1 })).toBe("incomplete");
  });
  it("ready when every account has a valid, unsaved decision", () => {
    expect(deriveReviewSubmission(base)).toBe("ready");
  });
  it("ready when every remaining account was excluded (an exclusion is a decision)", () => {
    expect(deriveReviewSubmission({ ...base, pendingCount: 0, excludedCount: 2 })).toBe("ready");
  });
  it("failed after a refused save, with the decisions kept", () => {
    expect(deriveReviewSubmission({ ...base, lastSaveFailed: true })).toBe("failed");
  });
  it("submitting while saving or reprocessing, whatever else holds", () => {
    expect(deriveReviewSubmission({ ...base, saving: true })).toBe("submitting");
    expect(deriveReviewSubmission({ ...base, reprocessing: true, undecidedCount: 2 })).toBe("submitting");
  });
  it("nothing when no account is left to decide (saved, unchanged)", () => {
    expect(deriveReviewSubmission({ ...base, pendingCount: 0 })).toBe("nothing");
  });
});

describe("reviewActionHierarchy — exactly one action leads", () => {
  const one = (h: { card: string; save: string }) => [h.card, h.save].filter((e) => e === "primary").length;

  it("incomplete: Review leads, Save is secondary", () => {
    expect(reviewActionHierarchy("review_classifications", "incomplete")).toEqual({ card: "primary", save: "secondary" });
  });
  it("ready but not saved: the classifications still block completion, so Review keeps the lead", () => {
    expect(reviewActionHierarchy("review_classifications", "ready")).toEqual({ card: "primary", save: "secondary" });
  });
  it("after a failed save: Save & reprocess leads again (retry)", () => {
    expect(reviewActionHierarchy("review_classifications", "failed")).toEqual({ card: "secondary", save: "primary" });
  });
  it("submitting: Save keeps the emphasis (disabled, with progress by the panel)", () => {
    expect(reviewActionHierarchy("review_classifications", "submitting")).toEqual({ card: "secondary", save: "primary" });
  });
  it("nothing to submit: an unnecessary save is never promoted", () => {
    expect(reviewActionHierarchy(null, "nothing")).toEqual({ card: "primary", save: "secondary" });
    expect(reviewActionHierarchy("review_classifications", "nothing").save).toBe("secondary");
  });
  it("a file or check action (Replace, Retry) keeps the lead even with ready decisions", () => {
    expect(reviewActionHierarchy("replace", "ready")).toEqual({ card: "primary", save: "secondary" });
    expect(reviewActionHierarchy("retry", "submitting")).toEqual({ card: "primary", save: "secondary" });
  });
  it("no review panel: only the card's action", () => {
    expect(reviewActionHierarchy("replace", null)).toEqual({ card: "primary", save: "secondary" });
  });
  it("never two leads, for every combination", () => {
    for (const a of ["replace", "retry", "review_classifications", null] as const)
      for (const r of ["nothing", "incomplete", "ready", "failed", "submitting", null] as const) expect(one(reviewActionHierarchy(a, r))).toBe(1);
  });
});
