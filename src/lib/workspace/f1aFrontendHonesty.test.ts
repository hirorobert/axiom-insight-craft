/**
 * F1a — frontend honesty. Regression tests for the two false assurances the Trial balance review screens showed, and the
 * rules that remove them without inventing anything stored results cannot support:
 *
 *   1. A stored cash reconciliation (the engine compared a figure with itself) is never a PASS: "Not checked".
 *   2. A recorded statement-equation failure is never "Reviewed", and its recorded reason is shown.
 *   3. A legacy equation success is "Not exactly verified" — never "Balanced", never inferred from rounded figures or
 *      the old passed boolean — and no surface claims that every check passed.
 *   4. Debit/credit parity and confirmed classifications keep their outcome; an unverified equation is not a failure.
 *   5. Layer 3 keeps its stored check id (l3_arithmetic); debit/credit imbalance (TRIAL_BALANCE_IMBALANCE, legacy
 *      L3_TB_IMBALANCE) and statement-equation failure (BALANCE_SHEET_EQUATION_FAILED) are told apart by code; an unknown
 *      code keeps its recorded message and blocking/review status and is never read as clear.
 *
 * The first five tests are the UI evidence PINs of tb-review-evidence-v3 (ui/uiAuthority.test.ts, baseline 1b478625),
 * inverted: they asserted the defective output; these assert the corrected one.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { TbCertificationExceptionRecord, TbCertificationRow } from "./computeCertificationReadiness";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), functions: { invoke: vi.fn() } } }));
const { computeCertificationReadiness, classifyLayer3, layer3Reason } = await import("./computeCertificationReadiness");
const { deriveTrialBalanceVerdict, REVIEWED_SCOPE, STATEMENT_EQUATION_NOTE_ID } = await import("./trialBalanceVerdict");
const { currentTrialBalanceTask } = await import("./trialBalanceTask");
const { deriveWorkspaceState } = await import("./deriveWorkspaceState");
const { deriveOrientationSummary, trialBalanceReviewStep } = await import("./deriveOrientationSummary");
const { presentReadiness, certificationRowForDisplay } = await import("./certificationCheckPresentation");
const { BalanceSheetEquationCard } = await import("@/components/certification/BalanceSheetEquationCard");
const { ValidationReport } = await import("@/components/ValidationReport");
const { CurrentTrialBalanceCard } = await import("@/components/workspace/CurrentTrialBalanceCard");
const { TrialBalanceChecks } = await import("@/components/workspace/TrialBalanceChecks");
const { deriveTrialBalanceSteps } = await import("@/components/workspace/TrialBalanceProgressLedger");

const U = "33333333-3333-4333-8333-333333333333";
const cert = (exceptions: unknown[], review = false, blocking = false): TbCertificationRow =>
  ({ id: "c", sequence_no: 7, company_id: "c", upload_id: U, period_year: 2025, is_blocking: blocking, requires_review: review, exceptions, certified_at: "now" }) as TbCertificationRow;
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const render = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, null, node));
const EQ_FAIL = { code: "BALANCE_SHEET_EQUATION_FAILED", layer: 3, severity: "warning", accountCode: null, message: "Assets (10000.00) != Liabilities + Closing Equity (8000.00). Difference: 2000.00" };
const BALANCED_EXACT = { validation_report: { tb_balance_check: { passed: true, total_debits: 60500, total_credits: 60500, difference: 0, exact: { currency: "TZS", currency_exponent: 2, total_debits: "60500.00", total_credits: "60500.00", difference: "0.00" } } } };
const BLAMING_WORDS = /every check passed|checks passed|checks have passed|Balanced|VALID\b/;

const authoritative = (row: TbCertificationRow) => computeCertificationReadiness({ uploadExists: true, currentUploadId: U, authoritative: row, latestForUpload: row });
const latestOnly = (row: TbCertificationRow) => computeCertificationReadiness({ uploadExists: true, currentUploadId: U, authoritative: null, latestForUpload: row });
const verdictFor = (readiness: ReturnType<typeof authoritative>, status = "complete", processing_result: unknown = BALANCED_EXACT) =>
  deriveTrialBalanceVerdict({ upload: { id: U, status, processing_result }, readiness, canRetry: true });
const card = (v: ReturnType<typeof verdictFor>) => text(render(createElement(CurrentTrialBalanceCard, { fileName: "tb.csv", uploadedAt: "2026-10-06T08:00:00Z", fileSize: 1200, verdict: v, onPrimary: () => {} })));
const checksList = (v: ReturnType<typeof verdictFor>) => text(render(createElement(TrialBalanceChecks, { verdict: v })));

describe("tb-review-evidence-v3 UI PINs, inverted", () => {
  it("D-PIN: an authoritative certification carrying an equation failure is NOT Reviewed; the checks name the statement equation", () => {
    const readiness = authoritative(cert([EQ_FAIL]));
    expect(readiness.verdict).toBe("review");
    expect(readiness.blocker).toBe("The statement equation does not hold: Assets (10000.00) does not equal Liabilities + Closing Equity (8000.00). Difference: 2000.00");
    const l3 = readiness.checks.find((c) => c.id === "l3_arithmetic")!;
    expect([l3.label, l3.state]).toEqual(["Statement equation", "review"]);
    const v = verdictFor(readiness);
    expect([v.status, v.statusLabel, v.tone]).toEqual(["needs_review", "Needs review", "warning"]);
    expect(v.reason).toMatch(/^The statement equation does not hold: Assets \(10000\.00\) does not equal Liabilities/);
    expect(v.reason).not.toMatch(BLAMING_WORDS);
    expect(v.failedCheckId).toBe("l3_arithmetic");
    expect(v.checks.find((c) => c.id === "l3_arithmetic")).toMatchObject({ label: "Statement equation", state: "review" });
    // Debit/credit parity still holds and is still stated (the equation is a separate fact).
    expect(v.balanceStatement).toBe("Balanced");
    // A review held only by an arithmetic check does not send the user to classify accounts that need no decision.
    expect(v.primaryAction).toBeNull();
  });

  it("D-REVIEW-ROUTE: a requires_review row with only a layer-3 exception names the statement equation, not the generic classification text", () => {
    const readiness = latestOnly(cert([EQ_FAIL], true));
    expect(readiness.verdict).toBe("review");
    expect(readiness.blocker).toMatch(/^The statement equation does not hold: /);
    expect(readiness.blocker).not.toBe("Some accounts still need a classification decision.");
    // With a classification item too, both are named, the equation first.
    const both = latestOnly(cert([EQ_FAIL, { code: "NEEDS_REVIEW", layer: 4, severity: "warning", accountCode: "1200", message: "Account 1200 needs a decision." }], true));
    expect(both.blocker).toBe(`${layer3Reason(EQ_FAIL as TbCertificationExceptionRecord)} Account 1200 needs a decision.`);
    expect(verdictFor(both).primaryAction).toEqual({ kind: "review_classifications", label: "Resolve account classifications" });
  });

  it("D-BLOCK-ROUTE: a blocking row with a layer-3 equation error states the equation as the reason", () => {
    const readiness = latestOnly(cert([{ ...EQ_FAIL, severity: "error" }], false, true));
    const v = verdictFor(readiness, "blocked");
    expect(v.status).toBe("blocked");
    expect(v.reason).toMatch(/^The statement equation does not hold: /);
    expect(v.checks.find((c) => c.id === "l3_arithmetic")).toMatchObject({ label: "Statement equation", state: "failed" });
  });

  it("E-PIN: a BHD equation failure (engine passed:false, difference 0.005) is shown as a failure at three decimals, never 'Balanced'", () => {
    const upload = { processing_result: { ingestion: { currency_exponent: 3 }, validation_report: { balance_sheet_equation: { passed: false, assets: 10.005, liabilities: 3, equity: 7, net_income: 0, closing_equity: 7, difference: 0.005000000000000782 } } } };
    const t = text(renderToStaticMarkup(createElement(BalanceSheetEquationCard, { upload } as never)));
    expect(t).not.toMatch(/Balanced/);
    expect(t).toMatch(/Does not hold — recorded failure/);
    expect(t).toMatch(/Assets \(recorded\) 10\.005/);
    expect(t).toMatch(/Recorded difference 0\.005/);
    expect(t).not.toMatch(/10\.01|Total 10\.00/);
  });

  it("B-PIN: a stored self-comparison cash_reconciliation renders 'Not checked' — no VALID badge, no pass styling", () => {
    const report = { tb_balance_check: { passed: true, total_debits: 60500, total_credits: 60500, difference: 0 }, mapping_completeness: { passed: true }, balance_sheet_equation: { passed: true }, profit_equity_linkage: null, cash_reconciliation: { passed: true, cf_ending_cash: 10000, bs_cash: 10000 } };
    const html = renderToStaticMarkup(createElement(ValidationReport as never, { report, errors: [], isValid: true, status: "complete", fileName: "tb.csv" }));
    expect(text(html)).toMatch(/Cash reconciliation: Not checked/);
    expect(text(html)).not.toMatch(/\bVALID\b|Cash flow ending balance = Balance sheet cash/);
    expect(html).not.toMatch(/bg-accent\/5|bg-accent\/20/);
    expect(html).toMatch(/data-testid="cash-reconciliation-row" data-state="not_checked"/);
    // Whatever was stored — a recorded false too — the row is "Not checked", never a pass or a fail.
    const failedStored = renderToStaticMarkup(createElement(ValidationReport as never, { report: { ...report, cash_reconciliation: { passed: false, cf_ending_cash: 1, bs_cash: 2 } }, errors: [], isValid: true, status: "complete" }));
    expect(text(failedStored)).toMatch(/Cash reconciliation: Not checked/);
    expect(failedStored).not.toMatch(/bg-destructive\/5 border-destructive\/20/);
  });
});

describe("legacy equation success: 'Not exactly verified', never 'Balanced', never 'every check passed'", () => {
  const certified = authoritative(cert([]));
  const v = verdictFor(certified);

  it("readiness stays certified (debit/credit parity, classifications) but never claims the equation holds", () => {
    expect(certified.verdict).toBe("certified");
    const l3 = certified.checks.find((c) => c.id === "l3_arithmetic")!;
    expect(l3.state).toBe("passed");
    expect(l3.detail).toBe("Total debits equal total credits. Statement equation: not exactly verified (recorded by an earlier engine).");
    expect(l3.detail).not.toMatch(/statement equation both hold/);
  });

  it("the verdict is Reviewed, the equation is listed for information as not exactly verified, and no reason says every check passed", () => {
    expect([v.status, v.statusLabel]).toEqual(["accepted", "Reviewed"]);
    expect(v.reason).toBe(`Reviewed trial balance. ${REVIEWED_SCOPE} It is ready for statement preparation. This is not an approval of financial statements.`);
    expect(v.reason).not.toMatch(/every check passed|checks passed/i);
    expect(v.checks.find((c) => c.id === "l3_arithmetic")).toMatchObject({ label: "Debits equal credits", state: "passed" });
    expect(v.informational[0]).toEqual({ id: STATEMENT_EQUATION_NOTE_ID, label: "Statement equation", state: "pending", detail: "Not exactly verified — recorded by an earlier engine; re-check after the engine update." });
    expect(v.checks.map((c) => c.id)).toEqual(["l1_structure", "l2_data_quality", "l3_arithmetic", "l4_classification"]); // stored ids unchanged
  });

  it("the equation card shows 'Not exactly verified' for passed:true and for a missing passed, and no float comparison decides anything", () => {
    for (const eq of [
      { passed: true, assets: 100, liabilities: 40, equity: 60, net_income: 0, closing_equity: 60, difference: 0 },
      { assets: 100, liabilities: 40, equity: 60 },
      { passed: true, assets: 100.004, liabilities: 40, equity: 60, difference: 0.004 }, // within the old 0.01 TOLERANCE
    ]) {
      const t = text(renderToStaticMarkup(createElement(BalanceSheetEquationCard, { upload: { processing_result: { validation_report: { balance_sheet_equation: eq } } } } as never)));
      expect(t).toMatch(/Not exactly verified — recorded by an earlier engine; re-check after the engine update/);
      expect(t).not.toMatch(/Balanced|Does not hold|Recorded difference/);
    }
  });

  it("the user-facing summary agrees: the card, the checks list, the Prepare step, the Overview / hub and the certification presentation", () => {
    expect(card(v)).toMatch(/REVIEWED|Reviewed/);
    expect(card(v)).not.toMatch(/every check passed/i);
    const list = checksList(v);
    expect(list).toMatch(/Statement equation Not checked yet Not exactly verified/);
    expect(list).not.toMatch(/every check passed/i);
    const task = currentTrialBalanceTask(v);
    expect(task).toMatchObject({ step: 3 });
    expect(task.instruction).not.toMatch(/checks passed/i);
    expect(task.instruction).toContain("The statement equation is not exactly verified");
    const state = deriveWorkspaceState("c", "Co", 2025, { id: U, companyId: "c", companyName: "Co", periodYear: 2025, status: "complete", isValid: true, safishaStatus: null, uploadedAt: "2026-01-01T00:00:00Z", processedAt: "2026-01-01T00:00:00Z", hasMapping: false, hesabuPassedAt: null, kingaSignedAt: null, filingSubmittedAt: null, certificationVerdict: certified.verdict, certificationBlocker: certified.blocker });
    const step = trialBalanceReviewStep(state)!;
    expect(step.detail).not.toMatch(/checks have passed|checks passed/i);
    expect(step.detail).toContain("The statement equation is not exactly verified");
    expect(deriveOrientationSummary(state, ["FINANCIAL_STATEMENTS"]).currentStatusLabel).toBe("Reviewed trial balance");
    const input = { uploadExists: true, currentUploadId: U, authoritative: cert([]), latestForUpload: cert([]) };
    const p = presentReadiness(computeCertificationReadiness(input), "Checking", certificationRowForDisplay(input));
    expect(p.countLabel).toBe("Reviewed · 4/4");
    expect(p.countLabel).not.toMatch(/checks passed/i);
  });
});

describe("contradictory results are never Reviewed", () => {
  it("a stored passed:false with no certification exception: the layer-3 row shows the statement equation and the verdict is not Reviewed", () => {
    const certified = authoritative(cert([]));
    const v = verdictFor(certified, "complete", { ...BALANCED_EXACT, validation_report: { ...BALANCED_EXACT.validation_report, balance_sheet_equation: { passed: false, assets: 10, liabilities: 3, equity: 6, difference: 1 } } });
    expect(v.statusLabel).not.toBe("Reviewed");
    expect(v.status).toBe("needs_review");
    expect(v.checks.find((c) => c.id === "l3_arithmetic")).toMatchObject({ label: "Statement equation", state: "review" });
    expect(v.reason).toBe("The statement equation does not hold: the engine recorded a failure in this result.");
    expect(v.informational.some((c) => c.id === STATEMENT_EQUATION_NOTE_ID)).toBe(false);
    expect(currentTrialBalanceTask(v).step).toBe(1);
  });

  it("a 'certified' readiness with any check in review or failed is never shown as Reviewed (defence in depth)", () => {
    const readiness = { verdict: "certified" as const, blocker: null, checks: [
      { id: "l1_structure", label: "", state: "passed" as const, detail: "" },
      { id: "l2_data_quality", label: "Data quality", state: "review" as const, detail: "Row 4 amount is unusual." },
      { id: "l3_arithmetic", label: "", state: "passed" as const, detail: "" },
      { id: "l4_classification", label: "", state: "passed" as const, detail: "" },
    ] };
    const v = deriveTrialBalanceVerdict({ upload: { id: U, status: "complete", processing_result: BALANCED_EXACT }, readiness, canRetry: true });
    expect([v.status, v.statusLabel]).toEqual(["needs_review", "Needs review"]);
    expect(v.reason).toBe("Amounts are valid: Row 4 amount is unusual.");
  });

  it("the Overview / hub follow the certification: an equation failure is not a passed Prepare and has no reviewed step", () => {
    const readiness = authoritative(cert([EQ_FAIL]));
    const state = deriveWorkspaceState("c", "Co", 2025, { id: U, companyId: "c", companyName: "Co", periodYear: 2025, status: "complete", isValid: true, safishaStatus: null, uploadedAt: "2026-01-01T00:00:00Z", processedAt: "2026-01-01T00:00:00Z", hasMapping: false, hesabuPassedAt: null, kingaSignedAt: null, filingSubmittedAt: null, certificationVerdict: readiness.verdict, certificationBlocker: readiness.blocker });
    expect(state.missions.prepare.status).not.toBe("passed");
    expect(state.missions.prepare.blocker).toMatch(/^The statement equation does not hold/);
    expect(trialBalanceReviewStep(state)).toBeNull();
    expect(deriveOrientationSummary(state, ["FINANCIAL_STATEMENTS"]).currentStatusLabel).not.toBe("Reviewed trial balance");
  });

  it("the collapsed ledger puts an equation problem on 'Validation complete', never on 'Debits equal credits'", () => {
    const v = verdictFor(authoritative(cert([EQ_FAIL])));
    const steps = deriveTrialBalanceSteps({ status: "complete", processing_result: BALANCED_EXACT, file_name: "tb.csv" } as never, { failedCheckId: v.failedCheckId });
    expect(steps.find((s) => s.key === "balanced")).toMatchObject({ state: "done" });
    expect(steps.find((s) => s.key === "complete")).toMatchObject({ state: "attention" });
    const blockedSteps = deriveTrialBalanceSteps({ status: "blocked", processing_result: BALANCED_EXACT, file_name: "tb.csv" } as never, { failedCheckId: "l3_arithmetic" });
    expect(blockedSteps.find((s) => s.key === "balanced")!.state).toBe("done");
    expect(blockedSteps.find((s) => s.key === "complete")!.state).toBe("failed");
  });
});

describe("layer-3 codes: known, legacy and unknown", () => {
  it("classifyLayer3 groups by recorded code only (never by message text) and ignores other layers", () => {
    const g = classifyLayer3([
      { code: "TRIAL_BALANCE_IMBALANCE", layer: 3, severity: "error", accountCode: null, message: "the statement equation" },
      { code: "L3_TB_IMBALANCE", layer: 3, severity: "error", accountCode: null, message: "x" },
      { code: "BALANCE_SHEET_EQUATION_FAILED", layer: 3, severity: "warning", accountCode: null, message: "debits and credits" },
      { code: "L3_SOMETHING_NEW", layer: 3, severity: "warning", accountCode: null, message: "y" },
      { code: "BALANCE_SHEET_EQUATION_FAILED", layer: 4, severity: "warning", accountCode: null, message: "z" },
    ] as TbCertificationExceptionRecord[]);
    expect([g.parity.length, g.equation.length, g.unknown.length]).toEqual([2, 1, 1]);
  });

  it("legacy L3_TB_IMBALANCE is a debit/credit imbalance: blocked, 'Debits equal credits' failed, its reason stated", () => {
    const readiness = latestOnly(cert([{ code: "L3_TB_IMBALANCE", layer: 3, severity: "error", accountCode: null, message: "L3_TB_IMBALANCE: Debits 100.00 != Credits 90.00" }], false, true));
    expect(readiness.verdict).toBe("blocked");
    expect(readiness.blocker).toBe("Debits and credits do not agree: Debits 100.00 does not equal Credits 90.00");
    const v = verdictFor(readiness, "blocked", {});
    expect(v.checks.find((c) => c.id === "l3_arithmetic")).toMatchObject({ label: "Debits equal credits", state: "failed" });
    expect(v.reason).toBe("Debits and credits do not agree: Debits 100.00 does not equal Credits 90.00");
    expect(v.primaryAction).toEqual({ kind: "replace", label: "Replace with corrected Trial Balance" });
    // Even if it ever arrived on an "authoritative" row, it is never certified.
    expect(authoritative(cert([{ code: "L3_TB_IMBALANCE", layer: 3, severity: "error", accountCode: null, message: "x" }])).verdict).toBe("blocked");
  });

  it("an unknown layer-3 code keeps its recorded message and severity; it is never certified and never read as clear", () => {
    const unknown = (severity: string) => ({ code: "L3_FUTURE_CHECK", layer: 3, severity, accountCode: null, message: "Retained earnings roll-forward differs by 12.00." });
    for (const [severity, verdict, state] of [["warning", "review", "review"], ["error", "blocked", "failed"], ["info", "review", "review"], ["bogus", "review", "review"]] as const) {
      const r = authoritative(cert([unknown(severity)]));
      expect(r.verdict, severity).toBe(verdict);
      expect(r.blocker, severity).toBe("Retained earnings roll-forward differs by 12.00.");
      const v = verdictFor(r, verdict === "blocked" ? "blocked" : "complete");
      expect(v.statusLabel, severity).not.toBe("Reviewed");
      expect(v.checks.find((c) => c.id === "l3_arithmetic"), severity).toMatchObject({ label: "Arithmetic check", state, detail: "Retained earnings roll-forward differs by 12.00." });
    }
  });

  it("missing fields never become clear: no code, no message, no severity, no exceptions array", () => {
    const bare = authoritative(cert([{ layer: 3 }]));
    expect(bare.verdict).toBe("review");
    expect(bare.blocker).toBe("An arithmetic check recorded an unidentified exception.");
    expect(verdictFor(bare).statusLabel).not.toBe("Reviewed");
    const noArray = computeCertificationReadiness({ uploadExists: true, currentUploadId: U, authoritative: null, latestForUpload: { ...cert([]), exceptions: null as never, requires_review: true } });
    expect(noArray.verdict).toBe("review");
    // A result with no processing_result and no equation record shows no card and no stored-failure override.
    expect(renderToStaticMarkup(createElement(BalanceSheetEquationCard, { upload: { processing_result: null } } as never))).toBe("");
    expect(verdictFor(authoritative(cert([])), "complete", null).statusLabel).toBe("Reviewed");
    // A cash reconciliation missing its fields is still only "Not checked".
    const html = renderToStaticMarkup(createElement(ValidationReport as never, { report: { tb_balance_check: { passed: true, total_debits: 1, total_credits: 1, difference: 0 }, mapping_completeness: { passed: true }, balance_sheet_equation: null, profit_equity_linkage: null, cash_reconciliation: {} }, errors: [], isValid: null, status: "complete" }));
    expect(text(html)).toMatch(/Cash reconciliation: Not checked/);
    expect(text(html)).not.toMatch(/\bVALID\b|PENDING/);
  });
});

describe("valid outcomes are unaffected", () => {
  it("a certified result with no layer-3 exception keeps every outcome: certified, Reviewed, parity Balanced, classifications passed, no action", () => {
    const v = verdictFor(authoritative(cert([])));
    expect([v.status, v.statusLabel, v.tone, v.primaryAction, v.failedCheckId]).toEqual(["accepted", "Reviewed", "success", null, null]);
    expect(v.balanceStatement).toBe("Balanced");
    expect(v.checks.every((c) => c.state === "passed")).toBe(true);
    expect(v.checks.find((c) => c.id === "l4_classification")).toMatchObject({ label: "Every account classified", state: "passed" });
  });

  it("outstanding classifications still route to the classification review (step 2), unchanged", () => {
    const readiness = latestOnly(cert([{ code: "NEEDS_REVIEW", layer: 4, severity: "warning", accountCode: "1200", message: "2 accounts still need a classification decision." }], true));
    const v = verdictFor(readiness, "needs_review");
    expect([v.status, v.reason]).toEqual(["needs_review", "2 accounts still need a classification decision."]);
    expect(v.primaryAction).toEqual({ kind: "review_classifications", label: "Resolve account classifications" });
    expect(currentTrialBalanceTask(v)).toMatchObject({ step: 2 });
  });

  it("a debit/credit imbalance (TRIAL_BALANCE_IMBALANCE) still blocks with the recorded totals and the replace action", () => {
    const readiness = latestOnly(cert([{ code: "TRIAL_BALANCE_IMBALANCE", layer: 3, severity: "error", accountCode: null, message: "Debits 100.00 != Credits 90.00" }], false, true));
    const v = verdictFor(readiness, "blocked", { validation_report: { tb_balance_check: { total_debits: 100, total_credits: 90, difference: 10 } } });
    expect(v.reason).toBe("Debits exceed credits by 10.00. Correct the file and replace it.");
    expect(v.checks.find((c) => c.id === "l3_arithmetic")).toMatchObject({ label: "Debits equal credits", state: "failed", detail: "Debits 100.00 and credits 90.00 differ by 10.00." });
    expect(v.primaryAction).toEqual({ kind: "replace", label: "Replace with corrected Trial Balance" });
    expect(v.informational.some((c) => c.id === STATEMENT_EQUATION_NOTE_ID)).toBe(false);
  });

  it("a ValidationReport with recorded errors still says INVALID and lists them", () => {
    const html = renderToStaticMarkup(createElement(ValidationReport as never, { report: { tb_balance_check: { passed: false, total_debits: 1, total_credits: 2, difference: 1 }, mapping_completeness: { passed: true }, balance_sheet_equation: null, profit_equity_linkage: null, cash_reconciliation: null }, errors: [{ code: "X_ERROR", message: "Something recorded." }], isValid: false, status: "blocked" }));
    expect(text(html)).toMatch(/INVALID/);
    expect(text(html)).toMatch(/X_ERROR Something recorded\./);
  });
});
