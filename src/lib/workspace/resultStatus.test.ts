/**
 * Phase 1 §3.5 — one result model and one status vocabulary: the sidebar, the Overview and the Prepare page show the
 * same words for the same stored result; findings are ordered blocking → needs confirmation → review; review-only
 * findings never change what the certification unlocks.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FINDING_HEADING, findingKind, openFindingKind, prepareStatusWord, STATUS_WORDS } from "./resultStatus";
import { deriveTrialBalanceVerdict, readIngestionIssues } from "./trialBalanceVerdict";
import { deriveWorkspaceState } from "./deriveWorkspaceState";
import { trialBalanceReviewStep } from "./deriveOrientationSummary";
import { CurrentTrialBalanceCard } from "@/components/workspace/CurrentTrialBalanceCard";
import type { PreflightCheck } from "./computePreflight";
import type { UploadSnapshot } from "./types";

const MILESTONES = ["read", "columns", "rows", "amounts", "balance", "classification", "recorded"].map((id) => ({ id, status: "passed" }));
const CONFIRM = { code: "ENTITY_NAME_DIFFERS", severity: "review", rows: [1], message: "This file names Mfano Traders Ltd; this workspace is Kilele Ltd. Same entity? (From your file: “Mfano Traders Ltd”, cell A1.)" };
const REVIEW = { code: "CLEARING_ACCOUNT_BALANCE", severity: "review", rows: [7], message: "Clearing, suspense or in-transit account on row 7 has a balance. It needs reconciliation evidence." };
const BLOCK = { code: "TRIAL_BALANCE_IMBALANCE", severity: "blocking", message: "Debits (10.00) do not equal credits (9.00); the difference is 1.00." };
const result = (issues: unknown[]) => ({ ingestion: { milestones: MILESTONES, issues, rules_generation: 7 }, validation_report: { tb_balance_check: { passed: true, total_debits: 10, total_credits: 10, difference: 0 } } });
const check = (id: string, state: PreflightCheck["state"]): PreflightCheck => ({ id, label: id, state, detail: "recorded" });
// A certified row carrying the ingestion review findings as layer-2 warnings (process-trial-balance, §3.1 wiring).
const certifiedWithFindings = [check("l1_structure", "passed"), check("l2_data_quality", "review"), check("l3_arithmetic", "passed"), check("l4_classification", "passed")];
const certifiedClean = certifiedWithFindings.map((c) => ({ ...c, state: "passed" as const }));
const page = (issues: unknown[], checks = certifiedWithFindings) =>
  deriveTrialBalanceVerdict({ upload: { id: "u1", status: "complete", processing_result: result(issues) }, readiness: { verdict: "certified", blocker: null, checks }, canRetry: true });
const workspace = (issues: unknown[]) => deriveWorkspaceState("c1", "Synthetic Co", 2026, {
  id: "u1", companyId: "c1", companyName: "Synthetic Co", periodYear: 2026, status: "complete", isValid: true, safishaStatus: null,
  uploadedAt: "2026-01-01T00:00:00Z", processedAt: "2026-01-01T00:00:00Z", hasMapping: false, kingaSignedAt: null, filingSubmittedAt: null,
  certificationVerdict: "certified", certificationBlocker: null, hasMilestoneRecord: true, openFinding: openFindingKind(result(issues)),
} as UploadSnapshot);
const sidebar = (issues: unknown[]) => { const s = workspace(issues); return prepareStatusWord(s.missions.prepare.status, s.openFinding); };
const overview = (issues: unknown[]) => trialBalanceReviewStep(workspace(issues))?.label;

describe("the same words on every surface", () => {
  it.each([
    ["a confirmation and a review finding", [REVIEW, CONFIRM], STATUS_WORDS.needsConfirmation],
    ["a review finding only", [REVIEW], STATUS_WORDS.needsReview],
  ])("%s: page, Overview and sidebar agree", (_name, issues, word) => {
    expect(page(issues).statusLabel).toBe(word);
    expect(overview(issues)).toBe(word);
    expect(sidebar(issues)).toBe(word);
  });
  it("no finding: Reviewed everywhere", () => {
    expect(page([], certifiedClean).statusLabel).toBe(STATUS_WORDS.reviewed);
    expect(overview([])).toBe("Reviewed trial balance");
    expect(sidebar([])).toBe(STATUS_WORDS.reviewed);
  });
});

describe("findings never change what the result unlocks", () => {
  it("the workspace progression is identical with or without review findings", () => {
    expect(workspace([REVIEW, CONFIRM]).missions).toEqual(workspace([]).missions);
    expect(workspace([REVIEW, CONFIRM]).nextAction).toEqual(workspace([]).nextAction);
  });
});

describe("order and grouping", () => {
  it("findings are read blocking → needs confirmation → review, whatever order they were stored in", () => {
    expect(readIngestionIssues(result([REVIEW, CONFIRM, BLOCK])).map((i) => i.kind)).toEqual(["blocking", "needs_confirmation", "review"]);
  });
  it("the card shows each group under its own heading, in order, with the confirmation question first", () => {
    const html = renderToStaticMarkup(createElement(CurrentTrialBalanceCard, { fileName: "tb.xlsx", uploadedAt: "2026-01-01T00:00:00Z", fileSize: 1000, verdict: page([REVIEW, CONFIRM]), onPrimary: () => {} }));
    const confirmAt = html.indexOf(FINDING_HEADING.needs_confirmation);
    const reviewAt = html.indexOf(FINDING_HEADING.review);
    expect(confirmAt).toBeGreaterThan(-1);
    expect(reviewAt).toBeGreaterThan(confirmAt);
    expect(html).toContain("Same entity?");
    expect(html).not.toMatch(/legacy result|tb-ingest|ENTITY_NAME_DIFFERS<|CLEARING_ACCOUNT_BALANCE</);
  });
  it("findingKind: blocking, confirmation and review; anything else is not a finding", () => {
    expect([findingKind("blocking", "X"), findingKind("review", "ENTITY_NAME_DIFFERS"), findingKind("review", "X"), findingKind("info", "X"), findingKind(undefined, "X")])
      .toEqual(["blocking", "needs_confirmation", "review", null, null]);
  });
});
