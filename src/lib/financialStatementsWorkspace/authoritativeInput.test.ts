/**
 * The financial-statements workspace's authoritative reporting input (fs_reporting_input, 20261016100000): strict
 * parsing, exact conversion to the canonical adapter, the adjusted (as-reported) figures, the comparative states (never
 * a substitute), account lineage, and the full canonical pipeline on authoritative figures. The database side is proven
 * on real PostgreSQL by scripts/db-proof/closeReviewAuthority.mjs ("Reporting input").
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { comparativeFromInput, lineageByAccount, minorToDecimalText, parseReportingInput, periodToReviewedLines, type CurrentReportingInput } from "./authoritativeInput";
import { numberToMoneyExact } from "./moneyConversion";
import { evaluateReport, prepareTrialBalanceReport } from "./evaluationOrchestrator";
import { InMemoryFinancialStatementReportRepository } from "./reportRepository";

const acct = (o: Record<string, unknown>) => ({
  accountCode: null, statement: "balance_sheet", normalBalance: "debit", isCashAccount: null, isRetainedEarnings: null, isPayrollAccount: null,
  certifiedDebitMinor: "0", certifiedCreditMinor: "0", adjustmentDebitMinor: "0", adjustmentCreditMinor: "0", debitMinor: "0", creditMinor: "0", adjustmentIds: [], ...o,
});
const period = (accounts: unknown[], o: Record<string, unknown> = {}) => ({
  certificationId: "cert-1", uploadId: "upl-1", periodYear: 2025, certifiedAt: "2026-01-10T00:00:00Z", periodId: "p1", currency: "TZS", exponent: 2,
  reportingStart: "2025-01-01", reportingEnd: "2025-12-31", accounts, ...o,
});
const ACCOUNTS = [
  acct({ accountKey: "1000", accountCode: "1000", accountName: "Bank", classification: "current_assets", isCashAccount: true, certifiedDebitMinor: "500000", debitMinor: "500000" }),
  acct({ accountKey: "2000", accountCode: "2000", accountName: "Trade payables", classification: "current_liabilities", normalBalance: "credit", certifiedCreditMinor: "300000", adjustmentCreditMinor: "15000", creditMinor: "315000", adjustmentIds: ["adj-1"] }),
  acct({ accountKey: "3000", accountCode: "3000", accountName: "Share capital", classification: "equity", normalBalance: "credit", certifiedCreditMinor: "100000", creditMinor: "100000" }),
  acct({ accountKey: "4000", accountCode: "4000", accountName: "Sales", statement: "income_statement", classification: "revenue", normalBalance: "credit", certifiedCreditMinor: "900000", creditMinor: "900000" }),
  acct({ accountKey: "6000", accountCode: "6000", accountName: "Rent", statement: "income_statement", classification: "operating_expenses", certifiedDebitMinor: "800000", adjustmentDebitMinor: "15000", debitMinor: "815000", adjustmentIds: ["adj-1"] }),
];
const INPUT = {
  state: "current", contract: "fs-reporting-input/1", current: period(ACCOUNTS), comparative: { state: "missing", periodYear: 2024 },
  adjustments: [{ id: "adj-1", number: 1, kind: "adjustment", reverses: null, totalMinor: "15000", reason: "Accrue rent", selfApproved: false, selfRevalidated: false }],
  findings: { state: "current", unresolvedBlocking: 0 }, adjustmentsRequiringRevalidation: 0, inputSha256: "a".repeat(64),
};

describe("parsing", () => {
  it("accepts exactly fs-reporting-input/1; refuses anything else (never partially used)", () => {
    expect(parseReportingInput(INPUT)?.state).toBe("current");
    expect(parseReportingInput({ ...INPUT, contract: "fs-reporting-input/2" })).toBeNull();
    expect(parseReportingInput({ ...INPUT, inputSha256: "x" })).toBeNull();
    expect(parseReportingInput({ ...INPUT, adjustmentsRequiringRevalidation: undefined })).toBeNull();
    expect(parseReportingInput({ ...INPUT, current: period([acct({ accountKey: "1", accountName: "x", classification: "equity", debitMinor: "1.5" })]) })).toBeNull();
    expect(parseReportingInput({ state: "no_authority", periodYear: 2025 })).toEqual({ state: "no_authority", periodYear: 2025 });
    expect(parseReportingInput(null)).toBeNull();
  });
});

describe("exact conversion", () => {
  it("minor units to decimal text, and the adapter recovers them exactly (or refuses)", () => {
    expect(minorToDecimalText(-12345n, 2)).toBe("-123.45");
    expect(minorToDecimalText(5n, 3)).toBe("0.005");
    expect(minorToDecimalText(0n, 2)).toBe("0.00");
    expect(minorToDecimalText(7n, 0)).toBe("7");
    for (const m of [1n, 999999999999n, 123456789012345n, -98765n]) {
      const v = Number(minorToDecimalText(m, 2));
      expect(numberToMoneyExact(v, "TZS", 2).minorUnits).toBe(m);
    }
  });
  it("reviewed lines carry the ADJUSTED natural-direction amounts, the placement, the certified upload and the input identity", () => {
    const r = periodToReviewedLines(parseReportingInput(INPUT)!.state === "current" ? (INPUT as unknown as CurrentReportingInput).current : null!, INPUT.inputSha256, "CURRENT");
    const byKey = Object.fromEntries(r.lines.map((l) => [l.accountKey, l]));
    expect(byKey["2000"]).toMatchObject({ balance: 3150, normalBalance: "credit", statement: "balance_sheet", sourceUploadId: "upl-1", sourceHash: "a".repeat(64), scale: 2, currency: "TZS" });
    expect(byKey["6000"].balance).toBe(8150);
    expect(byKey["1000"].isCashAccount).toBe(true);
    expect(r.unmappedAccounts).toEqual([]);
  });
  it("an account without a reviewed placement is reported unmapped, never guessed; a credit-normal account in debit is negative", () => {
    const r = periodToReviewedLines(period([acct({ accountKey: "9", accountName: "Suspense", statement: null, normalBalance: null, classification: "current_assets", debitMinor: "1" }),
      acct({ accountKey: "3", accountName: "Capital", classification: "equity", normalBalance: "credit", debitMinor: "500" })]) as never, "b".repeat(64), "CURRENT");
    expect(r.unmappedAccounts).toEqual([{ accountCode: "9", accountName: "Suspense" }]);
    expect(r.lines[0].balance).toBe(-5);
  });
});

describe("comparative and lineage", () => {
  const cur = INPUT as unknown as CurrentReportingInput;
  it("missing / not authoritative: MISSING with the exact reason (never another period's upload)", () => {
    expect(comparativeFromInput(cur, "co")).toMatchObject({ state: "MISSING", periodYear: 2024 });
    expect(comparativeFromInput({ ...cur, comparative: { state: "not_authoritative", periodYear: 2024 } }, "co")).toMatchObject({ state: "MISSING", reason: expect.stringMatching(/not reviewed/) });
  });
  it("available: the certified upload is the provenance; legacy: ineligible with the reason", () => {
    const avail = { ...cur, comparative: { ...period(ACCOUNTS, { certificationId: "cert-0", uploadId: "upl-0", periodYear: 2024 }), state: "available", adjustments: [] } } as CurrentReportingInput;
    expect(comparativeFromInput(avail, "co")).toMatchObject({ state: "AVAILABLE", periodYear: 2024, upload: { id: "upl-0", status: "certified" } });
    const legacy = { ...cur, comparative: { ...period(ACCOUNTS, { periodYear: 2024 }), state: "legacy_certification", adjustments: [] } } as CurrentReportingInput;
    expect(comparativeFromInput(legacy, "co")).toMatchObject({ state: "INELIGIBLE", reason: expect.stringMatching(/exact amounts/) });
  });
  it("every account's figures trace to the certification, its upload and each approved adjustment", () => {
    const l = lineageByAccount(cur.current);
    expect(l.get("6000")).toEqual({ certificationId: "cert-1", uploadId: "upl-1", adjustmentIds: ["adj-1"] });
    expect(l.get("1000")!.adjustmentIds).toEqual([]);
  });
});

describe("the canonical pipeline on authoritative figures", () => {
  it("builds and evaluates a report from the adjusted lines (statements balance: assets = liabilities + equity + result)", async () => {
    const repo = new InMemoryFinancialStatementReportRepository();
    const { lines } = periodToReviewedLines(cur().current, INPUT.inputSha256, "CURRENT");
    const { snapshot } = await prepareTrialBalanceReport({ companyId: "co", periodYear: 2025, entityLegalName: "Acme Ltd", framework: "full_ifrs", currency: "TZS",
      currentPeriod: { startDate: "2025-01-01", endDate: "2025-12-31" }, reviewedAccountLines: lines }, repo);
    const evaluation = await evaluateReport(snapshot, repo);
    expect(snapshot.report).toBeTruthy();
    const json = JSON.stringify(evaluation, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(json).toMatch(/PASS/i);
    function cur() { return INPUT as unknown as CurrentReportingInput; }
  });
  it("when supplied, the hook reads figures only from the authoritative input (never processing_result) and no tax engine output", () => {
    const hook = fs.readFileSync(path.resolve(__dirname, "../../hooks/useFinancialStatementsWorkspace.ts"), "utf8");
    expect(hook).toMatch(/if \(ri && ri\.state === "current"\) \{\s*\/\/ The authoritative route/);
    expect(hook).toMatch(/\} else if \(ri === undefined && current && currentStatements\) \{/);
    const mod = fs.readFileSync(path.resolve(__dirname, "authoritativeInput.ts"), "utf8");
    expect(mod).not.toMatch(/\.processing_result\b/);
    expect(mod).not.toMatch(/kinga|tax_computations|generate-disclosure-notes/i);
  });
});
