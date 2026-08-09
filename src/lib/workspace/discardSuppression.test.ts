/**
 * Regression checks for the discard/undo state rule:
 *  - discarding clears every derived surface in the same render
 *  - undo restores them all, and never produces an empty intermediate state
 */
import { describe, it, expect } from "vitest";
import {
  applyDiscardSuppression,
  suppressUpload,
  restoreUploadId,
  isSuppressed,
} from "../discardSuppression";

const run = (id: string, reviewCount = 0) => ({
  id,
  status: reviewCount > 0 ? "needs_review" : "complete",
  company_id: "co-1",
  processing_result: {
    needs_review_accounts: Array.from({ length: reviewCount }, (_, i) => ({
      account_name: `A${i}`,
    })),
  },
});

describe("discard suppression", () => {
  it("clears active upload, history entry and review queue together", () => {
    const a = run("u1", 3);
    const b = run("u2");
    const suppressed = suppressUpload([], "u1");

    const out = applyDiscardSuppression({ upload: a, uploads: [a, b], suppressed });
    expect(out.upload).toBeNull();
    expect(out.uploads.map((u) => u.id)).toEqual(["u2"]);
    expect(out.reviewAccounts).toEqual([]);
  });

  it("leaves other runs untouched", () => {
    const a = run("u1", 2);
    const b = run("u2", 5);
    const out = applyDiscardSuppression({
      upload: b,
      uploads: [a, b],
      suppressed: suppressUpload([], "u1"),
    });
    expect(out.upload?.id).toBe("u2");
    expect(out.reviewAccounts).toHaveLength(5);
  });

  it("undo restores the full state, including the review queue", () => {
    const a = run("u1", 4);
    const afterDiscard = suppressUpload([], "u1");
    const afterUndo = restoreUploadId(afterDiscard, "u1");

    expect(isSuppressed(afterUndo, "u1")).toBe(false);
    const out = applyDiscardSuppression({ upload: a, uploads: [a], suppressed: afterUndo });
    expect(out.upload?.id).toBe("u1");
    expect(out.uploads).toHaveLength(1);
    expect(out.reviewAccounts).toHaveLength(4);
  });

  it("no flicker: unsuppressing before the refetch keeps the run visible", () => {
    const a = run("u1", 1);
    // Undo happens first, stale data is still in hand → run already visible.
    const suppressed = restoreUploadId(suppressUpload([], "u1"), "u1");
    const stale = applyDiscardSuppression({ upload: a, uploads: [a], suppressed });
    expect(stale.upload).not.toBeNull();
    // Fresh data arrives with the same shape → identical, so nothing blanks.
    const fresh = applyDiscardSuppression({ upload: a, uploads: [a], suppressed });
    expect(fresh.upload?.id).toBe(stale.upload?.id);
    expect(fresh.reviewAccounts).toHaveLength(1);
  });

  it("suppress and restore are idempotent", () => {
    let s = suppressUpload([], "u1");
    s = suppressUpload(s, "u1");
    expect(s).toEqual(["u1"]);
    s = restoreUploadId(restoreUploadId(s, "u1"), "u1");
    expect(s).toEqual([]);
  });

  it("tolerates a missing or malformed processing_result", () => {
    const odd = { id: "u9", processing_result: null };
    const out = applyDiscardSuppression({ upload: odd, uploads: [odd], suppressed: [] });
    expect(out.reviewAccounts).toEqual([]);
    expect(out.upload?.id).toBe("u9");
  });
});