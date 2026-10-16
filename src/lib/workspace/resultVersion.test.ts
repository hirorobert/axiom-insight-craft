/**
 * Phase 1 §3.2 — a result recorded before the processing milestones is labelled as an earlier version on every
 * surface, its history unchanged, and it is never presented as passing the current check set.
 */
import { describe, expect, it } from "vitest";
import { EARLIER_VERSION_LABEL, EARLIER_VERSION_REASON, hasMilestoneRecord } from "./resultVersion";
import { deriveTrialBalanceVerdict } from "./trialBalanceVerdict";
import { deriveWorkspaceState } from "./deriveWorkspaceState";
import { trialBalanceReviewStep } from "./deriveOrientationSummary";
import type { PreflightCheck } from "./computePreflight";
import type { UploadSnapshot } from "./types";

const passed = (id: string): PreflightCheck => ({ id, label: id, state: "passed", detail: "recorded detail" });
const CHECKS = ["l1_structure", "l2_data_quality", "l3_arithmetic", "l4_classification"].map(passed);
const CURRENT = { milestones: ["read", "columns", "rows", "amounts", "balance", "classification", "recorded"].map((id) => ({ id, status: "passed" })) };
const TOTALS = { validation_report: { tb_balance_check: { passed: true, total_debits: 10, total_credits: 10, difference: 0 } } };
const verdict = (processing_result: unknown) =>
  deriveTrialBalanceVerdict({ upload: { id: "u1", status: "complete", processing_result }, readiness: { verdict: "certified", blocker: null, checks: CHECKS }, canRetry: true });
const snapshot = (hasMilestones: boolean | undefined): UploadSnapshot => ({
  id: "u1", companyId: "c1", companyName: "Synthetic Co", periodYear: 2026, status: "complete", isValid: true, safishaStatus: null,
  uploadedAt: "2026-01-01T00:00:00Z", processedAt: "2026-01-01T00:00:00Z", hasMapping: false, kingaSignedAt: null, filingSubmittedAt: null,
  certificationVerdict: "certified", certificationBlocker: null, hasMilestoneRecord: hasMilestones,
});

describe("hasMilestoneRecord", () => {
  it("is true only for a stored result that records its processing milestones", () => {
    expect(hasMilestoneRecord({ ingestion: CURRENT })).toBe(true);
    expect(hasMilestoneRecord({ ingestion: { milestones: [] } })).toBe(true);
    for (const v of [null, undefined, {}, { ingestion: null }, { ingestion: {} }, { ingestion: { milestones: "x" } }, [], "x"]) expect(hasMilestoneRecord(v)).toBe(false);
  });
});

describe("an earlier version's result", () => {
  it("Prepare: labelled as an earlier version, not Reviewed; passed checks shown without a pass; no balance claim", () => {
    const v = verdict(TOTALS);
    expect([v.status, v.statusLabel, v.tone, v.reason]).toEqual(["accepted", EARLIER_VERSION_LABEL, "neutral", EARLIER_VERSION_REASON]);
    expect(v.checks.map((c) => [c.state, c.neutral, c.detail])).toEqual(CHECKS.map(() => ["passed", true, EARLIER_VERSION_REASON]));
    expect(v.balanceStatement).toBeNull();
    expect(JSON.stringify(v)).not.toMatch(/legacy result|Reviewed trial balance/);
  });
  it("Overview and hub: the same words, from the same fact", () => {
    const state = deriveWorkspaceState("c1", "Synthetic Co", 2026, snapshot(false));
    expect(state.checkedByEarlierVersion).toBe(true);
    expect(trialBalanceReviewStep(state)).toEqual({ ready: true, label: EARLIER_VERSION_LABEL, detail: EARLIER_VERSION_REASON });
  });
  it("its history and authority are unchanged: the certified verdict still drives the same workspace progression", () => {
    const earlier = deriveWorkspaceState("c1", "Synthetic Co", 2026, snapshot(false));
    const current = deriveWorkspaceState("c1", "Synthetic Co", 2026, snapshot(true));
    expect(earlier.missions).toEqual(current.missions);
    expect(earlier.nextAction).toEqual(current.nextAction);
  });
  it("a current result keeps its Reviewed presentation; an unread record is never labelled", () => {
    const v = verdict({ ...TOTALS, ingestion: CURRENT });
    expect(v.statusLabel).toBe("Reviewed");
    expect(v.balanceStatement).toBe("Balanced");
    expect(deriveWorkspaceState("c1", "Synthetic Co", 2026, snapshot(true)).checkedByEarlierVersion).toBeUndefined();
    expect(deriveWorkspaceState("c1", "Synthetic Co", 2026, snapshot(undefined)).checkedByEarlierVersion).toBeUndefined();
  });
  it("a blocked or failing earlier result is still shown as what it recorded (never softened)", () => {
    const blocked = deriveTrialBalanceVerdict({ upload: { id: "u1", status: "blocked", processing_result: TOTALS }, readiness: { verdict: "blocked", blocker: "Debits do not equal credits", checks: CHECKS.map((c) => (c.id === "l3_arithmetic" ? { ...c, state: "failed" as const } : c)) }, canRetry: true });
    expect(blocked.statusLabel).toBe("Blocked");
  });
});
