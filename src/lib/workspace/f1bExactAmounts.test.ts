/**
 * F1b — readers of the exact amounts the engine records since E1 (processing_result.amounts, "tb-amounts/1").
 *
 *   1. A valid document whose equation is balanced is the ONLY thing shown as "holds exactly" (card, layer-3 detail,
 *      verdict note, preflight), with figures formatted from the minor-unit strings (BigInt, beyond 2^53 included).
 *   2. A valid document whose equation failed is a failure everywhere: held for review, never reviewed.
 *   3. A malformed document (grammar or any recomputed relationship) is "Result unavailable": held, never a pass, and never
 *      a fallback to the legacy figures in the same result.
 *   4. A legacy result (no amounts) keeps F1a's conservative display exactly: its floats are never converted.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TbCertificationRow } from "./computeCertificationReadiness";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), functions: { invoke: vi.fn() } } }));
const { computeCertificationReadiness, readRecordedEquation, LAYER3_PASSED_EXACT_DETAIL } = await import("./computeCertificationReadiness");
const { deriveTrialBalanceVerdict, STATEMENT_EQUATION_NOTE_ID, EQUATION_HOLDS_EXACTLY, EQUATION_VERIFICATION_UNAVAILABLE } = await import("./trialBalanceVerdict");
const { computePreflight } = await import("./computePreflight");
const { BalanceSheetEquationCard, EQUATION_HOLDS_EXACTLY_TEXT, EQUATION_RESULT_UNAVAILABLE_TEXT, EQUATION_NOT_EXACTLY_VERIFIED_TEXT } =
  await import("@/components/certification/BalanceSheetEquationCard");

const U = "33333333-3333-4333-8333-333333333333";
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const cleanCert = { id: "c", sequence_no: 1, company_id: "c", upload_id: U, period_year: 2025, is_blocking: false, requires_review: false, exceptions: [], certified_at: "now" } as TbCertificationRow;

const amounts = (over: Record<string, unknown> = {}) => ({
  contract: "tb-amounts/1", currency: "TZS", exponent: 2,
  source: { debit_total_minor: "190025", credit_total_minor: "190025", difference_minor: "0" },
  classes: { assets_minor: "150025", liabilities_minor: "0", equity_minor: "100000", income_minor: "90025", expenses_minor: "40000" },
  equation: { lhs_minor: "150025", rhs_minor: "150025", difference_minor: "0", status: "balanced" },
  cash: { reported_minor: "150025", credit_balances_minor: "0", overdraft_minor: "0", net_position_minor: "150025", accounts: 1 },
  reconciliation: { status: "not_checked" },
  ...over,
});
const LEGACY_EQ = { passed: true, assets: 1500.25, liabilities: 0, equity: 1000, net_income: 500.25, closing_equity: 1500.25, difference: 0 };
const pr = (a: unknown, legacy: object | null = LEGACY_EQ) => ({
  ...(a === undefined ? {} : { amounts: a }),
  validation_report: { tb_balance_check: { passed: true, difference: 0 }, mapping_completeness: { total_accounts: 4, mapped_accounts: 4 }, ...(legacy ? { balance_sheet_equation: legacy } : {}) },
});
const FAILED = amounts({ classes: { assets_minor: "150026", liabilities_minor: "0", equity_minor: "100000", income_minor: "90025", expenses_minor: "40000" },
  equation: { lhs_minor: "150026", rhs_minor: "150025", difference_minor: "1", status: "failed" } });
const MALFORMED = amounts({ equation: { lhs_minor: "150025", rhs_minor: "150025", difference_minor: "0", status: "failed" } }); // status ≠ difference

const readiness = (processing_result: unknown) => computeCertificationReadiness({
  uploadExists: true, currentUploadId: U, authoritative: cleanCert, latestForUpload: cleanCert, recordedEquation: readRecordedEquation(processing_result),
});
const verdict = (processing_result: unknown) => deriveTrialBalanceVerdict({ upload: { id: U, status: "complete", processing_result }, readiness: readiness(processing_result), canRetry: false });
const cardText = (processing_result: unknown) => text(renderToStaticMarkup(createElement(BalanceSheetEquationCard, { upload: { processing_result } as never })));
const preflightEq = (processing_result: unknown) => computePreflight({ status: "complete", processedAt: "now", processingResult: processing_result as never, accountingErrors: [] })
  .checks.find((c) => c.id === "bs_equation");

describe("readRecordedEquation", () => {
  it("exact amounts decide when present; legacy is read as before", () => {
    expect(readRecordedEquation(pr(amounts()))).toBe("exact");
    expect(readRecordedEquation(pr(FAILED))).toBe("failed");
    expect(readRecordedEquation(pr(MALFORMED))).toBe("unreadable");
    expect(readRecordedEquation(pr(undefined))).toBe("not_failed");
  });
  it("a malformed document never falls back to a legacy pass in the same result", () => {
    expect(readRecordedEquation(pr(MALFORMED, LEGACY_EQ))).toBe("unreadable");
    expect(readRecordedEquation(pr(null, LEGACY_EQ))).toBe("unreadable");
  });
});

describe("readiness and verdict", () => {
  it("balanced exact amounts: reviewed, and the equation holds exactly", () => {
    const r = readiness(pr(amounts()));
    expect(r.verdict).toBe("certified");
    expect(r.checks.find((c) => c.id === "l3_arithmetic")?.detail).toBe(LAYER3_PASSED_EXACT_DETAIL);
    const note = verdict(pr(amounts())).informational.find((c) => c.id === STATEMENT_EQUATION_NOTE_ID);
    expect(note).toMatchObject({ state: "passed", detail: EQUATION_HOLDS_EXACTLY });
  });
  it("failed exact amounts: held for review, never reviewed", () => {
    const r = readiness(pr(FAILED));
    expect(r.verdict).toBe("review");
    expect(r.checks.find((c) => c.id === "l3_arithmetic")?.state).toBe("review");
    expect(verdict(pr(FAILED)).status).not.toBe("reviewed");
  });
  it("malformed amounts: held as unreadable", () => {
    const r = readiness(pr(MALFORMED));
    expect(r.verdict).toBe("review");
    expect(r.blocker).toMatch(/could not be read/);
  });
  it("legacy result: unchanged — the equation is listed as not exactly verified", () => {
    const r = readiness(pr(undefined));
    expect(r.checks.find((c) => c.id === "l3_arithmetic")?.detail).not.toBe(LAYER3_PASSED_EXACT_DETAIL);
    const note = verdict(pr(undefined)).informational.find((c) => c.id === STATEMENT_EQUATION_NOTE_ID);
    expect(note).toMatchObject({ state: "pending", detail: EQUATION_VERIFICATION_UNAVAILABLE });
  });
});

describe("BalanceSheetEquationCard", () => {
  it("exact: holds exactly, with the recorded figures formatted from minor units", () => {
    const t = cardText(pr(amounts()));
    expect(t).toContain(EQUATION_HOLDS_EXACTLY_TEXT);
    expect(t).toContain("1,500.25");
    expect(t).toContain("900.25");
    expect(t).not.toContain(EQUATION_NOT_EXACTLY_VERIFIED_TEXT);
  });
  it("exact beyond 2^53: every digit shown", () => {
    const big = amounts({
      source: { debit_total_minor: "9007199254740993", credit_total_minor: "9007199254740993", difference_minor: "0" },
      classes: { assets_minor: "9007199254740993", liabilities_minor: "0", equity_minor: "9007199254740993", income_minor: "0", expenses_minor: "0" },
      equation: { lhs_minor: "9007199254740993", rhs_minor: "9007199254740993", difference_minor: "0", status: "balanced" },
      cash: { reported_minor: "0", credit_balances_minor: "0", overdraft_minor: "0", net_position_minor: "0", accounts: 0 },
    });
    expect(cardText(pr(big))).toContain("90,071,992,547,409.93");
  });
  it("failed: does not hold, with the exact difference", () => {
    const t = cardText(pr(FAILED));
    expect(t).toMatch(/Does not hold/);
    expect(t).toContain("0.01");
    expect(t).not.toContain(EQUATION_HOLDS_EXACTLY_TEXT);
  });
  it("malformed: result unavailable — no figures, no pass, no legacy fallback", () => {
    const t = cardText(pr(MALFORMED));
    expect(t).toContain(EQUATION_RESULT_UNAVAILABLE_TEXT);
    expect(t).not.toContain(EQUATION_HOLDS_EXACTLY_TEXT);
    expect(t).not.toContain("1,500.25");
  });
  it("legacy: unchanged conservative display", () => {
    expect(cardText(pr(undefined))).toContain(EQUATION_NOT_EXACTLY_VERIFIED_TEXT);
  });
});

describe("computePreflight", () => {
  it("passes the equation only on balanced exact amounts; failed and malformed are review", () => {
    expect(preflightEq(pr(amounts()))?.state).toBe("passed");
    expect(preflightEq(pr(FAILED))).toMatchObject({ state: "review" });
    expect(preflightEq(pr(FAILED))?.detail).toContain("0.01 TZS");
    expect(preflightEq(pr(MALFORMED))).toMatchObject({ state: "review", detail: expect.stringMatching(/Result unavailable/) });
  });
});
