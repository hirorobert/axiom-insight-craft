import { describe, expect, it } from "vitest";
import { evidenceState, reconciliationEvaluated, trialBalanceReadiness, type ReconciliationEvidence } from "./trialBalanceReadiness";

const none = { pending: 0, approved: 0, rejected: 0, escalated: 0, approvedTbLines: 0 };
/** 14 trial-balance lines: 12 matched, 2 exceptions approved by a reviewer — complete. */
const complete: ReconciliationEvidence = { status: "clean", matched_count: 12, exception_count: 2, total_tb_lines: 14, exceptions: { ...none, approved: 2, approvedTbLines: 2 } };
const recon = (reconciliation: unknown, safishaStatus: string | null = "clean") => evidenceState(safishaStatus, reconciliation as never);

describe("trialBalanceReadiness — a Reviewed trial balance needs passed checks AND confirmed classifications, nothing else", () => {
  it("is ready only when certified: checks passed and every classification confirmed", () => {
    const r = trialBalanceReadiness({ certificationVerdict: "certified" });
    expect(r.ready).toBe(true);
    expect(r.checks.map((c) => [c.id, c.met])).toEqual([["checks", true], ["classifications", true]]);
    expect(r.nextStep).toBeNull();
  });

  it("supporting-evidence reconciliation is not one of its conditions", () => {
    expect(trialBalanceReadiness({ certificationVerdict: "certified" }).checks.map((c) => c.id)).not.toContain("evidence");
  });

  it("outstanding classifications are never ready", () => {
    const review = trialBalanceReadiness({ certificationVerdict: "review" });
    expect(review.ready).toBe(false);
    expect(review.checks.map((c) => [c.id, c.met])).toEqual([["checks", true], ["classifications", false]]);
    expect(review.nextStep).toBe("Some accounts need a reviewer's confirmation.");
  });

  it("failed validation, and unknown, missing or contradictory state, are never ready", () => {
    for (const verdict of [undefined, null, "pending", "stale", "unknown", "blocked", "superseded"]) {
      const r = trialBalanceReadiness({ certificationVerdict: verdict });
      expect(r.ready).toBe(false);
      expect(r.nextStep).toBe("The file has not passed its checks yet.");
    }
  });
});

describe("reconciliation completeness (unchanged) — every trial-balance line matched or approved", () => {
  it("is complete only when every trial-balance line is matched or approved", () => {
    expect(recon(complete)).toEqual({ state: "complete", detail: "All 14 trial-balance lines are matched to evidence or approved by a reviewer (12 matched, 2 approved)." });
    expect(reconciliationEvaluated(complete)).toBe(true);
  });

  it("one matched line is NOT enough: every line in the reconciliation must be accounted for", () => {
    const partial = { status: "clean", matched_count: 1, exception_count: 0, total_tb_lines: 14, exceptions: none };
    expect(recon(partial)).toEqual({ state: "incomplete", detail: "1 of 14 trial-balance lines are matched or approved; 13 still need evidence." });
    expect(reconciliationEvaluated({ ...complete, matched_count: 1, exceptions: none })).toBe(false);
  });

  it("a 'clean' status with an escalated, rejected or pending exception is not complete", () => {
    expect(recon({ ...complete, exceptions: { ...complete.exceptions!, escalated: 1 } })).toEqual({ state: "incomplete", detail: "1 exception is escalated and not yet resolved." });
    expect(recon({ ...complete, exceptions: { ...complete.exceptions!, rejected: 2 } }).detail).toMatch(/^2 exceptions were rejected/);
    expect(recon({ ...complete, exceptions: { ...complete.exceptions!, pending: 3 } }).detail).toBe("3 exceptions still need a decision.");
  });

  it("a clean status over an empty comparison is not reconciliation", () => {
    expect(recon({ status: "clean", matched_count: 0, exception_count: 0, total_tb_lines: 0, exceptions: none })).toEqual({ state: "incomplete", detail: "No trial-balance line has been matched to evidence yet." });
  });

  it("missing or contradictory state is not complete", () => {
    expect(recon({ ...complete, status: "needs_review" }).state).toBe("incomplete");
    expect(recon(complete, "needs_review").state).toBe("incomplete");
    expect(recon({ ...complete, exceptions: undefined }).state).toBe("unreadable"); // exceptions not read → cannot prove complete
  });
});

describe("evidence unavailable to this viewer is distinguished from evidence that is incomplete", () => {
  it("no readable record although the upload says a reconciliation exists → not_visible (may be complete; cannot be confirmed here)", () => {
    const e = evidenceState("clean", { state: "read", evidence: null });
    expect(e.state).toBe("not_visible");
    expect(e.detail).toMatch(/You can't view that reconciliation/);
    expect(reconciliationEvaluated(null)).toBe(false);
  });
  it("a failed read → unreadable (try again), never 'no reconciliation'", () => {
    expect(evidenceState("clean", { state: "failed" }).state).toBe("unreadable");
    expect(evidenceState(null, undefined).state).toBe("unreadable");
  });
  it("no record and no reconciliation status → none (start reconciling)", () => {
    expect(evidenceState(null, { state: "read", evidence: null }).state).toBe("none");
  });
  it("a readable but incomplete reconciliation → incomplete, with what is missing", () => {
    expect(evidenceState("needs_review", { state: "read", evidence: { ...complete, status: "needs_review", exceptions: { ...none, pending: 1 } } }))
      .toEqual({ state: "incomplete", detail: "1 exception still needs a decision." });
  });
});
