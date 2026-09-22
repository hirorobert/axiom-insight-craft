import { describe, expect, it } from "vitest";
import { deriveClassificationPresentation, type ClassificationState } from "./classificationPresentation";

const summary = (over: Record<string, unknown> = {}) => ({ total_accounts: 97, processed_at: "x", parser_version: "v2.2", columns_detected: {}, auto_classified: 5, ...over });
const mc = (over: Record<string, unknown> = {}) => ({ passed: true, total_accounts: 97, mapped_accounts: 85, needs_review: 12, non_reporting: 0, auto_classified: 5, ...over });
const pr = (over: { summaryOver?: Record<string, unknown>; mcOver?: Record<string, unknown>; needsReviewAccounts?: unknown; extra?: Record<string, unknown> } = {}) => ({
  status: "needs_review",
  statements: null,
  validation_report: { mapping_completeness: mc(over.mcOver) },
  errors: [],
  summary: summary(over.summaryOver),
  ...(over.needsReviewAccounts !== undefined ? { needs_review_accounts: over.needsReviewAccounts } : {}),
  ...over.extra,
});
const state = (uploadStatus: string | null | undefined, processingResult: unknown): ClassificationState => deriveClassificationPresentation(uploadStatus, processingResult).state;

describe("deriveClassificationPresentation — FAILED and PROCESSING override any counts", () => {
  it("blocked / error is FAILED regardless of processingResult, including complete-looking counts", () => {
    const completeLooking = pr({ needsReviewAccounts: undefined, mcOver: { mapped_accounts: 97, needs_review: 0 } });
    for (const s of ["blocked", "error"]) {
      const r = deriveClassificationPresentation(s, completeLooking);
      expect(r.state).toBe("FAILED");
      expect(r.headline).toBe("The trial balance could not be processed.");
      expect(r.detail).toBe("Re-run processing, or replace the file in Prepare Data.");
      expect(r.primaryAction).toBe("RETRY_PROCESSING");
      expect(r.secondaryAction).toBe("REPLACE_FILE");
      expect(r.counts).toBeNull();
    }
    expect(state("blocked", null)).toBe("FAILED");
  });

  it("FAILED never echoes a raw backend error string", () => {
    const withError = { ...pr(), errors: [{ code: "SOME_RAW_ENGINE_ERROR", message: "raw stack trace leak" }] };
    const r = deriveClassificationPresentation("blocked", withError);
    expect(r.headline + r.detail).not.toMatch(/SOME_RAW_ENGINE_ERROR|stack trace/);
  });

  it("processing / pending / queued is PROCESSING regardless of stale counts, and invents no percentage or ETA", () => {
    const staleComplete = pr({ needsReviewAccounts: undefined, mcOver: { mapped_accounts: 97, needs_review: 0 } });
    for (const s of ["processing", "pending", "queued"]) {
      const r = deriveClassificationPresentation(s, staleComplete);
      expect(r.state).toBe("PROCESSING");
      expect(r.headline).toBe("Trial balance is processing.");
      expect(r.headline + r.detail).not.toMatch(/%|percent|second|minute|ETA/i);
      expect(r.primaryAction).toBe("NONE");
      expect(r.counts).toBeNull();
    }
  });
});

describe("NOT_COMPUTED — NULL/absent means not computed, never zero", () => {
  it("no processing_result at all", () => {
    expect(state("needs_review", null)).toBe("NOT_COMPUTED");
    expect(state(undefined, undefined)).toBe("NOT_COMPUTED");
    expect(state(null, {})).toBe("NOT_COMPUTED");
  });

  it("missing summary object entirely", () => {
    const r = pr();
    delete (r as Record<string, unknown>).summary;
    expect(state("needs_review", r)).toBe("NOT_COMPUTED");
  });

  it("null total_accounts", () => {
    expect(state("needs_review", pr({ summaryOver: { total_accounts: null } }))).toBe("NOT_COMPUTED");
  });

  it("null mapped_accounts (classified)", () => {
    expect(state("needs_review", pr({ mcOver: { mapped_accounts: null } }))).toBe("NOT_COMPUTED");
  });

  it("zero total_accounts is degenerate, not a computed result", () => {
    expect(state("complete", pr({ summaryOver: { total_accounts: 0 }, mcOver: { mapped_accounts: 0, needs_review: 0 }, needsReviewAccounts: [] }))).toBe("NOT_COMPUTED");
  });

  it("legacy shape missing both mapping_completeness and needs_review_accounts", () => {
    expect(state("complete", { status: "valid", summary: summary() })).toBe("NOT_COMPUTED");
  });

  it("status 'needs_review' with total and classified known but the review count entirely unknowable — never guesses", () => {
    const legacy = { status: "needs_review", summary: summary(), validation_report: { mapping_completeness: { total_accounts: 97, mapped_accounts: 85 } } };
    expect(state("needs_review", legacy)).toBe("NOT_COMPUTED");
  });

  it("classified < total, review known-zero-or-absent, and a status this module does not recognise as complete or needs_review", () => {
    const r = pr({ needsReviewAccounts: [], mcOver: { mapped_accounts: 90, needs_review: 0 } });
    expect(state("validating", r)).toBe("NOT_COMPUTED");
    expect(state("some_future_status", r)).toBe("NOT_COMPUTED");
  });

  it("the exact required copy, and no action beyond opening Prepare Data", () => {
    const r = deriveClassificationPresentation("needs_review", null);
    expect(r.headline).toBe("Classification results are not available yet.");
    expect(r.detail).toBe("");
    expect(r.counts).toBeNull();
  });
});

describe("INCONSISTENT — impossible or corrupt values fail closed, never silently normalised", () => {
  const cases: [string, unknown][] = [
    ["negative total", pr({ summaryOver: { total_accounts: -1 } })],
    ["negative classified", pr({ mcOver: { mapped_accounts: -1 } })],
    ["negative review (numeric field, no array)", pr({ needsReviewAccounts: undefined, mcOver: { needs_review: -1 } })],
    ["fractional total", pr({ summaryOver: { total_accounts: 97.5 } })],
    ["fractional classified", pr({ mcOver: { mapped_accounts: 85.25 } })],
    ["non-finite total (Infinity)", pr({ summaryOver: { total_accounts: Infinity } })],
    ["non-finite classified (NaN)", pr({ mcOver: { mapped_accounts: Number.NaN } })],
    ["classified greater than total", pr({ mcOver: { mapped_accounts: 200 }, needsReviewAccounts: [] })],
    ["review greater than total (numeric field)", pr({ needsReviewAccounts: undefined, mcOver: { mapped_accounts: 10, needs_review: 200 } })],
    ["classified + review greater than total", pr({ mcOver: { mapped_accounts: 90 }, needsReviewAccounts: new Array(20).fill({ account_code: "1", account_name: "x" }) })],
    ["total_accounts is a string", pr({ summaryOver: { total_accounts: "97" as unknown as number } })],
    ["mapped_accounts is a boolean", pr({ mcOver: { mapped_accounts: true as unknown as number } })],
    ["mapped_accounts is an object", pr({ mcOver: { mapped_accounts: {} as unknown as number } })],
  ];
  it.each(cases)("%s", (_label, input) => {
    const r = deriveClassificationPresentation("needs_review", input);
    expect(r.state).toBe("INCONSISTENT");
    expect(r.headline).toBe("Classification status is unavailable.");
    expect(r.detail).toBe("Review the uploaded file.");
    expect(r.counts).toBeNull();
    expect(r.secondaryAction).toBe("REPLACE_FILE");
  });

  it("status says needs_review but the authoritative review count is exactly zero — the producer's own invariant is violated", () => {
    const r = deriveClassificationPresentation("needs_review", pr({ needsReviewAccounts: [], mcOver: { mapped_accounts: 97, needs_review: 0 } }));
    expect(r.state).toBe("INCONSISTENT");
  });

  it("status says complete but a positive review count is still present (stale/contradictory shape)", () => {
    const r = deriveClassificationPresentation(
      "complete",
      pr({ needsReviewAccounts: [{ account_code: "1", account_name: "x" }], mcOver: { mapped_accounts: 96, needs_review: 1 } }),
    );
    expect(r.state).toBe("INCONSISTENT");
  });

  it("never fabricates a number when it fails closed", () => {
    const r = deriveClassificationPresentation("needs_review", pr({ summaryOver: { total_accounts: -5 } }));
    expect(r.headline).not.toMatch(/-5|\d/);
  });
});

describe("COMPLETE_WITH_REVIEW — status confirms review is required and the count is authoritatively known", () => {
  it("uses the exact required copy pattern and correct grammar for plural counts", () => {
    const r = deriveClassificationPresentation("needs_review", pr({ needsReviewAccounts: new Array(12).fill({ account_code: "1", account_name: "x" }), mcOver: { mapped_accounts: 85 }, summaryOver: { total_accounts: 97 } }));
    expect(r.state).toBe("COMPLETE_WITH_REVIEW");
    expect(r.headline).toBe("85 of 97 accounts classified.");
    expect(r.detail).toBe("Review 12 flagged accounts to continue.");
    expect(r.primaryAction).toBe("REVIEW_ACCOUNTS");
    expect(r.secondaryAction).toBe("REPLACE_FILE");
    expect(r.counts).toEqual({ total: 97, classified: 85, reviewRequired: 12 });
  });

  it("singular grammar: 1 of 1 accounts is not shown as 'account' for the denominator when total > 1, and singular review reads '1 account'", () => {
    const r = deriveClassificationPresentation("needs_review", pr({ needsReviewAccounts: [{ account_code: "1", account_name: "x" }], mcOver: { mapped_accounts: 96 }, summaryOver: { total_accounts: 97 } }));
    expect(r.headline).toBe("96 of 97 accounts classified.");
    expect(r.detail).toBe("Review 1 flagged account to continue.");
  });

  it("true singular total: 1 of 1 account classified", () => {
    const r = deriveClassificationPresentation("needs_review", pr({ needsReviewAccounts: [{ account_code: "1", account_name: "x" }], mcOver: { mapped_accounts: 0 }, summaryOver: { total_accounts: 1 } }));
    expect(r.headline).toBe("0 of 1 account classified.");
  });

  it("large counts use thousands separators", () => {
    const r = deriveClassificationPresentation("needs_review", pr({ needsReviewAccounts: new Array(1200).fill({ account_code: "1", account_name: "x" }), mcOver: { mapped_accounts: 8800 }, summaryOver: { total_accounts: 10000 } }));
    expect(r.headline).toBe("8,800 of 10,000 accounts classified.");
    expect(r.detail).toBe("Review 1,200 flagged accounts to continue.");
  });

  it("never describes the outcome as final, certified, approved or auditor-ready", () => {
    const r = deriveClassificationPresentation("needs_review", pr());
    for (const forbidden of [/\bfinal\b/i, /certified/i, /\bapproved\b/i, /auditor-ready/i, /instantly/i]) expect(r.headline + r.detail).not.toMatch(forbidden);
  });
});

describe("PARTIAL — a positive review count is known, but the status does not itself confirm needs_review", () => {
  it("uses the exact required copy pattern (status 'valid' does not itself confirm needs_review, unlike 'complete' which is provably review-free)", () => {
    const r = deriveClassificationPresentation("valid", pr({ needsReviewAccounts: new Array(15).fill({ account_code: "1", account_name: "x" }), mcOver: { mapped_accounts: 82 }, summaryOver: { total_accounts: 97 } }));
    expect(r.state).toBe("PARTIAL");
    expect(r.headline).toBe("82 of 97 accounts classified.");
    expect(r.detail).toBe("Review the remaining 15 accounts.");
    expect(r.primaryAction).toBe("REVIEW_ACCOUNTS");
    expect(r.counts).toEqual({ total: 97, classified: 82, reviewRequired: 15 });
  });

  it("fires for an unrecognised/legacy status when the numbers positively show unresolved review items", () => {
    const r = deriveClassificationPresentation("valid", pr({ needsReviewAccounts: new Array(3).fill({ account_code: "1", account_name: "x" }), mcOver: { mapped_accounts: 94 }, summaryOver: { total_accounts: 97 } }));
    expect(r.state).toBe("PARTIAL");
  });

  it("singular remaining account", () => {
    const r = deriveClassificationPresentation("valid", pr({ needsReviewAccounts: [{ account_code: "1", account_name: "x" }], mcOver: { mapped_accounts: 96 }, summaryOver: { total_accounts: 97 } }));
    expect(r.detail).toBe("Review the remaining 1 account.");
  });

  it("status 'complete' with a positive review count is INCONSISTENT, not PARTIAL — 'complete' is provably never written by the engine alongside a pending review item", () => {
    const r = deriveClassificationPresentation("complete", pr({ needsReviewAccounts: [{ account_code: "1", account_name: "x" }], mcOver: { mapped_accounts: 96 }, summaryOver: { total_accounts: 97 } }));
    expect(r.state).toBe("INCONSISTENT");
  });
});

describe("COMPLETE_NO_REVIEW — every known account is classified, or the run is explicitly complete", () => {
  it("uses the exact required copy pattern when classified === total", () => {
    const r = deriveClassificationPresentation("complete", pr({ needsReviewAccounts: undefined, mcOver: { mapped_accounts: 97, needs_review: 0 }, summaryOver: { total_accounts: 97 } }));
    expect(r.state).toBe("COMPLETE_NO_REVIEW");
    expect(r.headline).toBe("97 of 97 accounts classified. No review required.");
    expect(r.detail).toBe("");
    expect(r.primaryAction).toBe("OPEN_PREPARE_DATA");
    expect(r.secondaryAction).toBe("NONE");
    expect(r.counts).toEqual({ total: 97, classified: 97, reviewRequired: 0 });
  });

  it("status 'complete' with classified < total is still COMPLETE_NO_REVIEW — the gap is non-reporting exclusions, not pending review", () => {
    const r = deriveClassificationPresentation("complete", pr({ needsReviewAccounts: undefined, mcOver: { mapped_accounts: 90, needs_review: 0, non_reporting: 7 }, summaryOver: { total_accounts: 97 } }));
    expect(r.state).toBe("COMPLETE_NO_REVIEW");
    expect(r.headline).toBe("90 of 97 accounts classified. No review required.");
  });

  it("classified === total wins even under a status this module does not otherwise special-case", () => {
    const r = deriveClassificationPresentation("valid", pr({ needsReviewAccounts: undefined, mcOver: { mapped_accounts: 97, needs_review: 0 }, summaryOver: { total_accounts: 97 } }));
    expect(r.state).toBe("COMPLETE_NO_REVIEW");
  });

  it("singular account", () => {
    const r = deriveClassificationPresentation("complete", pr({ needsReviewAccounts: undefined, mcOver: { mapped_accounts: 1, needs_review: 0 }, summaryOver: { total_accounts: 1 } }));
    expect(r.headline).toBe("1 of 1 account classified. No review required.");
  });

  it("never overclaims certification or finality", () => {
    const r = deriveClassificationPresentation("complete", pr({ needsReviewAccounts: undefined, mcOver: { mapped_accounts: 97, needs_review: 0 }, summaryOver: { total_accounts: 97 } }));
    for (const forbidden of [/\bfinal\b/i, /certified/i, /\bapproved\b/i, /auditor-ready/i]) expect(r.headline).not.toMatch(forbidden);
  });
});

describe("terminology: 'classified', never 'automatically classified' or 'auto-classified'", () => {
  it("across every count-bearing state", () => {
    const fixtures: [string, unknown][] = [
      ["needs_review", pr()],
      ["valid", pr({ needsReviewAccounts: new Array(15).fill({ account_code: "1", account_name: "x" }), mcOver: { mapped_accounts: 82 } })],
      ["complete", pr({ needsReviewAccounts: undefined, mcOver: { mapped_accounts: 97, needs_review: 0 } })],
    ];
    for (const [s, p] of fixtures) {
      const r = deriveClassificationPresentation(s, p);
      expect(r.headline + r.detail).not.toMatch(/automatically classified|auto-classified|auto classified/i);
      expect(r.headline).toMatch(/classified/);
    }
  });
});

describe("retries / stale result shapes", () => {
  it("a row mid-reprocess (status flipped to processing, result cleared to null) reads as PROCESSING, not a stale success", () => {
    expect(state("processing", null)).toBe("PROCESSING");
  });

  it("a retried run's fresh, clean result reads as a genuine COMPLETE_NO_REVIEW, unaffected by the prior failed/needs_review run", () => {
    const fresh = pr({ needsReviewAccounts: undefined, mcOver: { mapped_accounts: 97, needs_review: 0 }, summaryOver: { total_accounts: 97, parser_version: "v2.2" } });
    expect(state("complete", fresh)).toBe("COMPLETE_NO_REVIEW");
  });
});
