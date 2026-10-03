import { describe, expect, it } from "vitest";
import { reconciliationEvaluated, trialBalanceReadiness } from "./trialBalanceReadiness";

const evaluated = { status: "clean", matched_count: 14, exception_count: 2, total_tb_lines: 14 };

describe("trialBalanceReadiness — ready needs checks, confirmed classifications AND evaluated evidence", () => {
  it("is ready only when all three checks hold", () => {
    const r = trialBalanceReadiness({ certificationVerdict: "certified", safishaStatus: "clean", reconciliation: evaluated });
    expect(r.ready).toBe(true);
    expect(r.checks.map((c) => [c.id, c.met])).toEqual([["checks", true], ["classifications", true], ["evidence", true]]);
    expect(r.nextStep).toBeNull();
  });

  it("arithmetic balance alone is never ready", () => {
    // Balanced and certified, but no reconciliation at all.
    expect(trialBalanceReadiness({ certificationVerdict: "certified", safishaStatus: null, reconciliation: null }).ready).toBe(false);
    // Balanced, but classifications still awaiting a reviewer (verdict "review").
    const review = trialBalanceReadiness({ certificationVerdict: "review", safishaStatus: "clean", reconciliation: evaluated });
    expect(review.ready).toBe(false);
    expect(review.checks.find((c) => c.id === "classifications")).toMatchObject({ met: false });
    expect(review.nextStep).toBe("Some accounts need a reviewer's confirmation.");
  });

  it("a clean status over an empty comparison is not reconciliation", () => {
    expect(reconciliationEvaluated({ status: "clean", matched_count: 0, exception_count: 0, total_tb_lines: 0 })).toBe(false);
    expect(reconciliationEvaluated({ status: "clean", matched_count: 0, exception_count: 0, total_tb_lines: 5 })).toBe(false);
    const r = trialBalanceReadiness({ certificationVerdict: "certified", safishaStatus: "clean", reconciliation: { status: "clean", matched_count: 0, exception_count: 0, total_tb_lines: 0 } });
    expect(r.ready).toBe(false);
    expect(r.nextStep).toBe("No trial-balance line has been matched to evidence yet.");
  });

  it("unknown, missing or contradictory state is not ready", () => {
    for (const verdict of [undefined, null, "pending", "stale", "unknown", "blocked", "superseded"]) {
      expect(trialBalanceReadiness({ certificationVerdict: verdict, safishaStatus: "clean", reconciliation: evaluated }).ready).toBe(false);
    }
    // The upload says clean but the reconciliation record does not (or the other way round).
    expect(trialBalanceReadiness({ certificationVerdict: "certified", safishaStatus: "clean", reconciliation: { ...evaluated, status: "needs_review" } }).ready).toBe(false);
    expect(trialBalanceReadiness({ certificationVerdict: "certified", safishaStatus: "needs_review", reconciliation: evaluated }).ready).toBe(false);
    expect(trialBalanceReadiness({ certificationVerdict: "certified", safishaStatus: "clean", reconciliation: undefined }).ready).toBe(false);
  });
});
