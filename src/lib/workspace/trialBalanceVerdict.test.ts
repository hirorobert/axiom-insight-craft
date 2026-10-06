/**
 * trialBalanceVerdict — one model for every trial-balance surface. The regression at the centre is a synthetic
 * reproduction of the reported defect (neutral company and figures): 180 accounts all classified by deterministic tiers (auto_classified = 0, which counts Tier 4-5 fuzzy matches
 * only), out of balance by 2,500.00. Before, the pre-flight said "all accounts are classified" while the ledger
 * said "180 of 180 still need a mapping decision" and blamed classification for an arithmetic block.
 */
import { describe, expect, it } from "vitest";
import type { PreflightCheck } from "./computePreflight";
import { deriveTrialBalanceSteps } from "@/components/workspace/TrialBalanceProgressLedger";
import {
  deriveTrialBalanceVerdict, formatCents, lifecycleLabel, plainBlockReason, readTrialBalanceTotals, resultLabel, stripEngineCode,
} from "./trialBalanceVerdict";

const SAMPLE_RESULT = {
  summary: { total_accounts: 180, auto_classified: 0 },
  validation_report: {
    mapping_completeness: { total_accounts: 180, mapped_accounts: 180, needs_review: 0 },
    tb_balance_check: { total_debits: 1250000.00, total_credits: 1247500.00, difference: 2500.00 },
  },
};
const layer = (id: string, label: string, state: PreflightCheck["state"], detail: string): PreflightCheck => ({ id, label, state, detail });
const LAYERS_BLOCKED: PreflightCheck[] = [
  layer("l1_structure", "File read and structured", "passed", "Every row in the file was read and totalled."),
  layer("l2_data_quality", "Data quality", "passed", "No data-quality errors raised."),
  layer("l3_arithmetic", "Arithmetic integrity", "failed", "Debits 1250000.00 != Credits 1247500.00 (difference: 2500.00)"),
  layer("l4_classification", "Classification completeness", "passed", "All accounts are classified."),
  layer("l5_supporting_evidence", "Supporting evidence", "pending", "NOT_EVALUATED: no supporting-evidence reconciliation has been run for this upload"),
  layer("l6_prior_period", "Prior-period signal", "pending", "NO_PRIOR: no authoritative certification exists for period 2024"),
];
const passedLayers = LAYERS_BLOCKED.map((c) => (c.id === "l3_arithmetic" ? { ...c, state: "passed" as const, detail: "The trial balance and statement equation both hold." } : c));
const upload = (status: string, extra: Record<string, unknown> = {}) => ({ id: "u1", file_name: "sample_trial_balance_FY2025.xlsx", status, processing_result: SAMPLE_RESULT, ...extra });

describe("the reported contradiction is resolved at the source — every surface agrees", () => {
  const verdict = deriveTrialBalanceVerdict({ upload: upload("blocked"), readiness: { verdict: "blocked", blocker: LAYERS_BLOCKED[2].detail, checks: LAYERS_BLOCKED }, canRetry: true });

  it("status, reason, totals and the one action", () => {
    expect(verdict.status).toBe("blocked");
    expect(verdict.statusLabel).toBe("Blocked");
    expect(verdict.reason).toBe("Debits exceed credits by 2,500.00. Correct the file and replace it.");
    expect(verdict.totals).toEqual({ debitCents: 125_000_000, creditCents: 124_750_000, differenceCents: 250_000 });
    expect(verdict.primaryAction).toEqual({ kind: "replace", label: "Replace with corrected Trial Balance" });
    expect(verdict.failedCheckId).toBe("l3_arithmetic");
    expect(verdict.statusLabel).not.toBe("Reviewed");   // a trial balance that does not balance is never a reviewed one
  });

  it("the checks: classification PASSED (from the certification), arithmetic FAILED with formatted figures", () => {
    const byId = Object.fromEntries(verdict.checks.map((c) => [c.id, c]));
    expect(byId.l4_classification).toMatchObject({ label: "Every account classified", state: "passed", detail: "Every account has a classification." });
    expect(byId.l3_arithmetic).toMatchObject({ label: "Debits equal credits", state: "failed", detail: "Debits 1,250,000.00 and credits 1,247,500.00 differ by 2,500.00." });
    expect(verdict.checks.map((c) => c.id)).toEqual(["l1_structure", "l2_data_quality", "l3_arithmetic", "l4_classification"]);
  });

  it("the technical ledger says the same: 180 of 180 classified (never auto_classified = 0), the balance step failed — not classification", () => {
    const steps = deriveTrialBalanceSteps(upload("blocked") as never, { failedCheckId: verdict.failedCheckId });
    const step = (k: string) => steps.find((s) => s.key === k)!;
    expect(step("classified")).toMatchObject({ state: "done", detail: "180 of 180 accounts classified" });
    expect(step("balanced")).toMatchObject({ state: "failed", detail: "Debits and credits differ by 2,500.00" });
    expect(steps.filter((s) => s.state === "failed").map((s) => s.key)).toEqual(["balanced"]);
    expect(JSON.stringify(steps)).not.toMatch(/need a (mapping|classification) decision/);
  });

  it("non-reporting accounts are not unresolved classification work (certified path)", () => {
    // Engine certified path: total includes non-reporting rows, mapped excludes them, needs_review = 0.
    const certified = upload("complete", {
      processing_result: {
        summary: { total_accounts: 240, auto_classified: 0 },
        validation_report: {
          mapping_completeness: { passed: true, total_accounts: 240, mapped_accounts: 234, non_reporting: 6, unmapped: [], auto_classified: 0 },
          tb_balance_check: { total_debits: 100, total_credits: 100, difference: 0 },
        },
        statements: { balance_sheet: {} },
      },
      processed_at: "2026-01-01T00:00:00Z",
    });
    const steps = deriveTrialBalanceSteps(certified as never, {});
    const classified = steps.find((s) => s.key === "classified")!;
    expect(classified.state).toBe("done");
    expect(JSON.stringify(steps)).not.toMatch(/need a classification decision/);
  });

  it("no engine code or raw 'x != y' text reaches the person", () => {
    const text = JSON.stringify([verdict.reason, verdict.checks, verdict.informational]);
    expect(text).not.toMatch(/NOT_EVALUATED|NO_PRIOR|!=/);
    expect(verdict.informational.map((c) => [c.label, c.detail])).toEqual([
      ["Bank and mobile-money evidence", "Not required for a reviewed trial balance."],
      ["Comparison with the prior year", "No accepted prior-year trial balance to compare with."],
    ]);
  });

  it("supporting evidence that was never evaluated reads 'not checked', never 'Passed', whatever severity the layer carries", () => {
    for (const [state, detail] of [["pending", "NOT_EVALUATED: x"], ["passed", "NOT_EVALUATED: no supporting-evidence reconciliation has been run"], ["passed", "NO_EVIDENCE: nothing compared"]] as const) {
      const v = deriveTrialBalanceVerdict({ upload: upload("complete"), readiness: { verdict: "certified", blocker: null, checks: [layer("l5_supporting_evidence", "Supporting evidence", state, detail)] }, canRetry: true });
      expect(v.informational[0]).toMatchObject({ state: "pending", detail: "Not required for a reviewed trial balance." });
    }
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
  it("accepted: a Reviewed trial balance, ready for statement preparation — no action, never reconciled, never an approval", () => {
    const a = deriveTrialBalanceVerdict({ upload: upload("complete"), readiness: { verdict: "certified", blocker: null, checks: passedLayers }, canRetry: true });
    expect(a).toMatchObject({ status: "accepted", statusLabel: "Reviewed", tone: "success", primaryAction: null });
    // F1a: no blanket "every check passed"; the statement equation is stated as not exactly verified.
    expect(a.reason).toBe("Reviewed trial balance. Debit and credit totals agree and every account classification is confirmed. The statement equation is not exactly verified for this result. It is ready for statement preparation. This is not an approval of financial statements.");
    // F1a: the reason now states that the equation is NOT exactly verified; only a positive "verified" claim is banned.
    expect(`${a.statusLabel} ${a.reason}`).not.toMatch(/reconciled|audited|assured|signed off|(?<!not exactly )verified/i);
    expect(a.reason).toContain("The statement equation is not exactly verified");
    // The reconciliation is not an input: an open, partial or escalated one changes nothing about this outcome.
    for (const extra of [{}, { safisha_status: "needs_review" }, { safisha_status: "blocked" }, { safisha_status: "clean" }]) {
      expect(deriveTrialBalanceVerdict({ upload: upload("complete", extra), readiness: { verdict: "certified", blocker: null, checks: passedLayers }, canRetry: true })).toEqual(a);
    }
  });
  it("needs review: resolve the classifications", () => {
    const v = deriveTrialBalanceVerdict({ upload: upload("needs_review"), readiness: { verdict: "review", blocker: "12 accounts still need a classification decision.", checks: passedLayers }, canRetry: true });
    expect(v).toMatchObject({ status: "needs_review", statusLabel: "Needs review", primaryAction: { kind: "review_classifications" } });
  });
  it("not current, stale, unreadable and still-confirming states never claim acceptance", () => {
    for (const verdict of ["superseded", "stale", "unknown", "pending"] as const) {
      const v = deriveTrialBalanceVerdict({ upload: upload("complete"), readiness: { verdict, blocker: null, checks: passedLayers }, canRetry: true });
      expect(v.status, verdict).not.toBe("accepted");
      expect(v.statusLabel, verdict).not.toBe("Reviewed");
    }
  });
  it("no upload: nothing to decide", () => {
    expect(deriveTrialBalanceVerdict({ upload: null, readiness: undefined, canRetry: false })).toMatchObject({ status: "none", primaryAction: null, checks: [] });
  });
});

describe("helpers", () => {
  it("reads the recorded totals; missing or non-numeric totals are NOT COMPUTED (null), never zero", () => {
    expect(readTrialBalanceTotals(SAMPLE_RESULT)?.differenceCents).toBe(250_000);
    expect(readTrialBalanceTotals({})).toBeNull();
    expect(readTrialBalanceTotals({ validation_report: { tb_balance_check: { total_debits: "x", total_credits: 1 } } })).toBeNull();
  });
  it("states which side is higher, and falls back to the certification's reason without codes", () => {
    expect(plainBlockReason({ blocker: null, totals: { debitCents: 1_000, creditCents: 1_250, differenceCents: -250 } })).toBe("Credits exceed debits by 2.50. Correct the file and replace it.");
    expect(plainBlockReason({ blocker: "L2_BAD_NUMBER: Row 14 has a non-numeric amount.", totals: null })).toBe("Row 14 has a non-numeric amount.");
    expect(plainBlockReason({ blocker: "x", totals: { debitCents: 100, creditCents: 300, differenceCents: -200 }, failedCheckId: "l2_data_quality" })).toBe("x");
    expect(stripEngineCode("NOT_EVALUATED: no reconciliation")).toBe("no reconciliation");
    expect(formatCents(123_456_780)).toBe("1,234,567.80");
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
