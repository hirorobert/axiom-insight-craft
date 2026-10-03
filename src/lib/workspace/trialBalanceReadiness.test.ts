import { describe, expect, it } from "vitest";
import { evidenceState, reconciliationEvaluated, trialBalanceReadiness, type ReconciliationEvidence } from "./trialBalanceReadiness";

const none = { pending: 0, approved: 0, rejected: 0, escalated: 0, approvedTbLines: 0 };
/** 14 trial-balance lines: 12 matched, 2 exceptions approved by a reviewer — complete. */
const complete: ReconciliationEvidence = { status: "clean", matched_count: 12, exception_count: 2, total_tb_lines: 14, exceptions: { ...none, approved: 2, approvedTbLines: 2 } };
const ready = (reconciliation: unknown, safishaStatus = "clean", certificationVerdict = "certified") =>
  trialBalanceReadiness({ certificationVerdict, safishaStatus, reconciliation: reconciliation as never });

describe("trialBalanceReadiness — ready needs checks, confirmed classifications AND a COMPLETE required reconciliation", () => {
  it("is ready only when every trial-balance line is matched or approved and all three checks hold", () => {
    const r = ready(complete);
    expect(r.ready).toBe(true);
    expect(r.evidenceState).toBe("complete");
    expect(r.checks.map((c) => [c.id, c.met])).toEqual([["checks", true], ["classifications", true], ["evidence", true]]);
    expect(r.checks[2].detail).toBe("All 14 trial-balance lines are matched to evidence or approved by a reviewer (12 matched, 2 approved).");
  });

  it("one matched line is NOT enough: every line in the reconciliation must be accounted for", () => {
    const partial = { status: "clean", matched_count: 1, exception_count: 0, total_tb_lines: 14, exceptions: none };
    expect(ready(partial)).toMatchObject({ ready: false, evidenceState: "incomplete", nextStep: "1 of 14 trial-balance lines are matched or approved; 13 still need evidence." });
  });

  it("a 'clean' status with an escalated, rejected or pending exception is not complete", () => {
    expect(ready({ ...complete, exceptions: { ...complete.exceptions!, escalated: 1 } })).toMatchObject({ ready: false, nextStep: "1 exception is escalated and not yet resolved." });
    expect(ready({ ...complete, exceptions: { ...complete.exceptions!, rejected: 2 } }).nextStep).toMatch(/^2 exceptions were rejected/);
    expect(ready({ ...complete, exceptions: { ...complete.exceptions!, pending: 3 } }).nextStep).toBe("3 exceptions still need a decision.");
  });

  it("a clean status over an empty comparison is not reconciliation", () => {
    expect(ready({ status: "clean", matched_count: 0, exception_count: 0, total_tb_lines: 0, exceptions: none })).toMatchObject({ ready: false, nextStep: "No trial-balance line has been matched to evidence yet." });
  });

  it("arithmetic balance alone is never ready", () => {
    expect(ready(null, null as never).ready).toBe(false);
    const review = ready(complete, "clean", "review");
    expect(review.ready).toBe(false);
    expect(review.nextStep).toBe("Some accounts need a reviewer's confirmation.");
  });

  it("unknown, missing or contradictory state is not ready", () => {
    for (const verdict of [undefined, null, "pending", "stale", "unknown", "blocked", "superseded"]) {
      expect(trialBalanceReadiness({ certificationVerdict: verdict, safishaStatus: "clean", reconciliation: complete }).ready).toBe(false);
    }
    expect(ready({ ...complete, status: "needs_review" }).ready).toBe(false);
    expect(ready(complete, "needs_review").ready).toBe(false);
    expect(ready({ ...complete, exceptions: undefined }).evidenceState).toBe("unreadable"); // exceptions not read → cannot prove complete
    expect(reconciliationEvaluated(complete)).toBe(true);
    expect(reconciliationEvaluated({ ...complete, matched_count: 1, exceptions: none })).toBe(false);
  });
});

describe("evidence unavailable to this viewer is distinguished from evidence that is incomplete", () => {
  it("no readable record although the upload says a reconciliation exists → not_visible (may be complete; cannot be confirmed here)", () => {
    const e = evidenceState("clean", { state: "read", evidence: null });
    expect(e.state).toBe("not_visible");
    expect(e.detail).toMatch(/You can't view that reconciliation/);
    expect(ready({ state: "read", evidence: null }).ready).toBe(false);
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
