/**
 * Regression tests for the workbench activation findings (PR #75, Lovable's preview evidence):
 *   1. a missing prior-year comparison reads "Not evaluated", never "Passed";
 *   2. the header is derived from the actual processing state: only a running check is "being checked"; a stale result
 *      (for example after a newly confirmed layout) asks for a new check; the only step count is the approved three-step
 *      journey (the processing ledger counts processing checks, not steps).
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TrialBalanceChecks } from "@/components/workspace/TrialBalanceChecks";
import { TRIAL_BALANCE_REVIEW } from "./moduleAvailability";
import { currentTrialBalanceTask } from "./trialBalanceTask";
import { deriveTrialBalanceVerdict, type TrialBalanceVerdict } from "./trialBalanceVerdict";
import type { PreflightCheck } from "./computePreflight";

const ROOT = path.resolve(__dirname, "../../..");
const upload = (status: string) => ({ id: "u1", status, version: 1, source_file_hash: "f".repeat(64), processing_result: null }) as never;
const l6 = (state: PreflightCheck["state"], detail: string): PreflightCheck => ({ id: "l6_prior_period", label: "Prior-period signal", state, detail });

describe("prior-year comparison", () => {
  it("renders 'Not evaluated' (never 'Passed') when there is no accepted prior year", () => {
    const v = deriveTrialBalanceVerdict({ upload: upload("complete"), readiness: { verdict: "certified", blocker: null, checks: [l6("passed", "NO_PRIOR: no authoritative certification exists for period 2024")] }, canRetry: true });
    const html = renderToStaticMarkup(h(TrialBalanceChecks, { verdict: v }));
    const row = html.slice(html.indexOf('data-testid="check-l6_prior_period"'));
    expect(row).toContain('data-state="not_evaluated"');
    expect(row).toContain("Not evaluated");
    expect(row.slice(0, row.indexOf("</li>"))).not.toContain("Passed");
  });
});

describe("the header follows the actual processing state", () => {
  const verdictFor = (status: string, readiness: { verdict: "certified" | "stale" | "pending"; blocker: null; checks: PreflightCheck[] }) =>
    deriveTrialBalanceVerdict({ upload: upload(status), readiness, canRetry: true });
  it("a running check is 'being checked'", () => {
    const v = verdictFor("validating", { verdict: "pending", blocker: null, checks: [] });
    expect(v.status).toBe("processing");
    expect(currentTrialBalanceTask(v).instruction).toMatch(/being checked/);
  });
  it("a stale result (e.g. after a newly confirmed layout) asks for a new check — never 'being checked'", () => {
    const v = verdictFor("complete", { verdict: "stale", blocker: null, checks: [] });
    expect([v.status, v.statusLabel]).toEqual(["needs_recheck", "Needs re-check"]);
    const t = currentTrialBalanceTask(v);
    expect(t.instruction).not.toMatch(/being checked/);
    expect(t.instruction).toMatch(/Run the check again/);
    expect(v.primaryAction).toEqual({ kind: "retry", label: "Retry processing" });
  });
  it("no non-running state ever says 'being checked'", () => {
    const states: TrialBalanceVerdict["status"][] = ["none", "checking", "needs_recheck", "processing_failed", "blocked", "needs_review", "accepted", "not_current", "unavailable"];
    for (const status of states) {
      const t = currentTrialBalanceTask({ status, failedCheckId: null, issues: [] });
      expect(t.instruction, status).not.toMatch(/being checked/);
    }
  });
  it("the only step count is the approved three-step journey", () => {
    expect(TRIAL_BALANCE_REVIEW.workflow).toHaveLength(3);
    for (const status of ["none", "processing", "needs_recheck", "needs_review", "accepted"] as const) {
      const t = currentTrialBalanceTask({ status, failedCheckId: null, issues: [] });
      expect(t.of).toBe(3);
      expect(t.label).toBe(TRIAL_BALANCE_REVIEW.workflow[t.step - 1]);
    }
    const ledger = fs.readFileSync(path.join(ROOT, "src/components/workspace/TrialBalanceProgressLedger.tsx"), "utf8");
    expect(ledger).toContain('label="Processing checks (technical)"');
    expect(ledger).toContain("{doneCount} of {steps.length} processing checks");
  });
});
