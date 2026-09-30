/**
 * trialBalanceVerdict — one model for every trial-balance surface. The regression at the centre is the live Arusha Dc
 * case: 252 accounts all classified by deterministic tiers (auto_classified = 0, which counts Tier 4-5 fuzzy matches
 * only), out of balance by 99,647,448.71. Before, the pre-flight said "all accounts are classified" while the ledger
 * said "252 of 252 still need a mapping decision" and blamed classification for an arithmetic block.
 */
import { describe, expect, it } from "vitest";
import type { PreflightCheck } from "./computePreflight";
import { deriveTrialBalanceSteps } from "@/components/workspace/TrialBalanceProgressLedger";
import {
  deriveTrialBalanceVerdict, formatAmount, lifecycleLabel, plainBlockReason, readTrialBalanceTotals, resultLabel, stripEngineCode,
} from "./trialBalanceVerdict";

const ARUSHA_RESULT = {
  summary: { total_accounts: 252, auto_classified: 0 },
  validation_report: {
    mapping_completeness: { total_accounts: 252, mapped_accounts: 252, needs_review: 0 },
    tb_balance_check: { total_debits: 174776903504.08, total_credits: 174677256055.37, difference: 99647448.71 },
  },
};
const layer = (id: string, label: string, state: PreflightCheck["state"], detail: string): PreflightCheck => ({ id, label, state, detail });
const LAYERS_BLOCKED: PreflightCheck[] = [
  layer("l1_structure", "File read and structured", "passed", "Every row in the file was read and totalled."),
  layer("l2_data_quality", "Data quality", "passed", "No data-quality errors raised."),
  layer("l3_arithmetic", "Arithmetic integrity", "failed", "Debits 174776903504.08 != Credits 174677256055.37 (difference: 99647448.71)"),
  layer("l4_classification", "Classification completeness", "passed", "All accounts are classified."),
  layer("l5_supporting_evidence", "Supporting evidence", "pending", "NOT_EVALUATED: no supporting-evidence reconciliation has been run for this upload"),
  layer("l6_prior_period", "Prior-period signal", "pending", "NO_PRIOR: no authoritative certification exists for period 2024"),
];
const passedLayers = LAYERS_BLOCKED.map((c) => (c.id === "l3_arithmetic" ? { ...c, state: "passed" as const, detail: "The trial balance and statement equation both hold." } : c));
const upload = (status: string, extra: Record<string, unknown> = {}) => ({ id: "u1", file_name: "ArushaDC_TrialBalance_30Jun2025.xlsx", status, processing_result: ARUSHA_RESULT, ...extra });

describe("the Arusha Dc contradiction is resolved at the source — every surface agrees", () => {
  const verdict = deriveTrialBalanceVerdict({ upload: upload("blocked"), readiness: { verdict: "blocked", blocker: LAYERS_BLOCKED[2].detail, checks: LAYERS_BLOCKED }, canRetry: true });

  it("status, reason, totals and the one action", () => {
    expect(verdict.status).toBe("blocked");
    expect(verdict.statusLabel).toBe("Blocked");
    expect(verdict.reason).toBe("Debits exceed credits by 99,647,448.71. Correct the file and replace it.");
    expect(verdict.totals).toEqual({ debits: 174776903504.08, credits: 174677256055.37, difference: 99647448.71 });
    expect(verdict.primaryAction).toEqual({ kind: "replace", label: "Replace with corrected Trial Balance" });
    expect(verdict.failedCheckId).toBe("l3_arithmetic");
    expect(verdict.evidenceUnlocked).toBe(false);   // no evidence verification on a trial balance that does not balance
  });

  it("the checks: classification PASSED (from the certification), arithmetic FAILED with formatted figures", () => {
    const byId = Object.fromEntries(verdict.checks.map((c) => [c.id, c]));
    expect(byId.l4_classification).toMatchObject({ label: "Every account classified", state: "passed", detail: "Every account has a classification." });
    expect(byId.l3_arithmetic).toMatchObject({ label: "Debits equal credits", state: "failed", detail: "Debits 174,776,903,504.08 and credits 174,677,256,055.37 differ by 99,647,448.71." });
    expect(verdict.checks.map((c) => c.id)).toEqual(["l1_structure", "l2_data_quality", "l3_arithmetic", "l4_classification"]);
  });

  it("the technical ledger says the same: 252 of 252 classified (never auto_classified = 0), the balance step failed — not classification", () => {
    const steps = deriveTrialBalanceSteps(upload("blocked") as never, { failedCheckId: verdict.failedCheckId });
    const step = (k: string) => steps.find((s) => s.key === k)!;
    expect(step("classified")).toMatchObject({ state: "done", detail: "252 of 252 accounts classified" });
    expect(step("balanced")).toMatchObject({ state: "failed", detail: "Debits and credits differ by 99,647,448.71" });
    expect(steps.filter((s) => s.state === "failed").map((s) => s.key)).toEqual(["balanced"]);
    expect(JSON.stringify(steps)).not.toMatch(/need a (mapping|classification) decision/);
  });

  it("no engine code or raw 'x != y' text reaches the person", () => {
    const text = JSON.stringify([verdict.reason, verdict.checks, verdict.informational]);
    expect(text).not.toMatch(/NOT_EVALUATED|NO_PRIOR|!=/);
    expect(verdict.informational.map((c) => [c.label, c.detail])).toEqual([
      ["Bank and mobile-money evidence", "Matched after the trial balance is accepted."],
      ["Comparison with the prior year", "No accepted prior-year trial balance to compare with."],
    ]);
  });
});

describe("each status has one failure-appropriate action", () => {
  const base = { readiness: { verdict: "pending" as const, blocker: null, checks: [] as PreflightCheck[] }, canRetry: true };
  it("engine failure (error): Retry for an active upload, otherwise Replace; never 'Blocked'", () => {
    expect(deriveTrialBalanceVerdict({ ...base, upload: upload("error") })).toMatchObject({ status: "processing_failed", statusLabel: "Could not be processed", primaryAction: { kind: "retry" } });
    expect(deriveTrialBalanceVerdict({ ...base, canRetry: false, upload: upload("error") }).primaryAction?.kind).toBe("replace");
  });
  it("a blocked trial balance is never offered Retry", () => {
    const v = deriveTrialBalanceVerdict({ upload: upload("blocked"), readiness: { verdict: "blocked", blocker: "x", checks: LAYERS_BLOCKED }, canRetry: true });
    expect(v.primaryAction?.kind).toBe("replace");
  });
  it("processing: no action, the page updates itself", () => {
    for (const s of ["pending", "processing", "queued", "validating"]) expect(deriveTrialBalanceVerdict({ ...base, upload: upload(s) })).toMatchObject({ status: "processing", primaryAction: null });
  });
  it("accepted: evidence verification unlocked (mandatory before tax); once evidence is clean, continue to Reconcile", () => {
    const a = deriveTrialBalanceVerdict({ upload: upload("complete"), readiness: { verdict: "certified", blocker: null, checks: passedLayers }, canRetry: true });
    expect(a).toMatchObject({ status: "accepted", statusLabel: "Accepted", evidenceUnlocked: true, evidenceCleared: false, primaryAction: { kind: "verify_evidence" } });
    const c = deriveTrialBalanceVerdict({ upload: upload("complete", { safisha_status: "clean" }), readiness: { verdict: "certified", blocker: null, checks: passedLayers }, canRetry: true });
    expect(c).toMatchObject({ evidenceCleared: true, primaryAction: { kind: "continue", label: "Continue to Reconcile" } });
  });
  it("needs review: resolve the classifications", () => {
    const v = deriveTrialBalanceVerdict({ upload: upload("needs_review"), readiness: { verdict: "review", blocker: "12 accounts still need a classification decision.", checks: passedLayers }, canRetry: true });
    expect(v).toMatchObject({ status: "needs_review", statusLabel: "Needs review", primaryAction: { kind: "review_classifications" }, evidenceUnlocked: false });
  });
  it("not current, stale, unreadable and still-confirming states never claim acceptance", () => {
    for (const verdict of ["superseded", "stale", "unknown", "pending"] as const) {
      const v = deriveTrialBalanceVerdict({ upload: upload("complete"), readiness: { verdict, blocker: null, checks: passedLayers }, canRetry: true });
      expect(v.status, verdict).not.toBe("accepted");
      expect(v.evidenceUnlocked, verdict).toBe(false);
    }
  });
  it("no upload: nothing to decide", () => {
    expect(deriveTrialBalanceVerdict({ upload: null, readiness: undefined, canRetry: false })).toMatchObject({ status: "none", primaryAction: null, checks: [] });
  });
});

describe("helpers", () => {
  it("reads the recorded totals; missing or non-numeric totals are NOT COMPUTED (null), never zero", () => {
    expect(readTrialBalanceTotals(ARUSHA_RESULT)?.difference).toBe(99647448.71);
    expect(readTrialBalanceTotals({})).toBeNull();
    expect(readTrialBalanceTotals({ validation_report: { tb_balance_check: { total_debits: "x", total_credits: 1 } } })).toBeNull();
  });
  it("states which side is higher, and falls back to the certification's reason without codes", () => {
    expect(plainBlockReason({ blocker: null, totals: { debits: 10, credits: 12.5, difference: -2.5 } })).toBe("Credits exceed debits by 2.50. Correct the file and replace it.");
    expect(plainBlockReason({ blocker: "L2_BAD_NUMBER: Row 14 has a non-numeric amount.", totals: null })).toBe("Row 14 has a non-numeric amount.");
    expect(plainBlockReason({ blocker: "x", totals: { debits: 1, credits: 2, difference: -1 }, failedCheckId: "l2_data_quality" })).toBe("x");
    expect(stripEngineCode("NOT_EVALUATED: no reconciliation")).toBe("no reconciliation");
    expect(formatAmount(1234567.8)).toBe("1,234,567.80");
  });
  it("history rows in words: lifecycle and recorded result", () => {
    expect(lifecycleLabel({ id: "a", file_name: "", uploaded_at: "", lifecycle_state: "superseded" }, "b")).toBe("Replaced");
    expect(lifecycleLabel({ id: "a", file_name: "", uploaded_at: "", lifecycle_state: "retired" }, "b")).toBe("Removed from active use");
    expect(lifecycleLabel({ id: "b", file_name: "", uploaded_at: "", lifecycle_state: "blocked" }, "b")).toBe("Current");
    expect(lifecycleLabel({ id: "a", file_name: "", uploaded_at: "" }, "b")).toBe("Earlier upload");
    expect([resultLabel("complete"), resultLabel("blocked"), resultLabel("needs_review"), resultLabel("error"), resultLabel("processing")])
      .toEqual(["Checks passed", "Blocked", "Needs review", "Could not be processed", "Processing"]);
  });
});
