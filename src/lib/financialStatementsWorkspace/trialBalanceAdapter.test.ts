import { describe, expect, it } from "vitest";
import { createTrialBalanceAdapter, type ReviewedTrialBalanceAccountLine } from "./trialBalanceAdapter";
import { AdapterRejectedError } from "./adapterContract";
import { validateCanonicalReport } from "@/lib/canonicalStatement/validation";
import { buildRuleContext } from "@/lib/canonicalStatement/rules/ruleEngine";
import { runCanonicalRulePackV1 } from "@/lib/canonicalStatement/rules/rulePack";
import { ZERO_TOLERANCE } from "@/lib/canonicalStatement/money";
import { CANONICAL_SCHEMA_VERSION, type CanonicalFinancialStatementReport } from "@/lib/canonicalStatement/types";

const SOURCE_HASH = "a".repeat(64);
const UPLOAD_ID = "upload-1";

function row(overrides: Partial<ReviewedTrialBalanceAccountLine> & Pick<ReviewedTrialBalanceAccountLine, "accountKey" | "accountName" | "statement" | "classification" | "normalBalance" | "balance">): ReviewedTrialBalanceAccountLine {
  return {
    currency: "TZS",
    scale: 2,
    periodId: "CURRENT",
    isComparative: false,
    isCashAccount: false,
    isRetainedEarnings: false,
    isPayrollAccount: false,
    sourceUploadId: UPLOAD_ID,
    sourceHash: SOURCE_HASH,
    ...overrides,
  };
}

/** A small, realistic, balanced SME trial balance: assets = liabilities + equity, current period only. */
function balancedCurrentPeriodLines(): ReviewedTrialBalanceAccountLine[] {
  return [
    row({ accountKey: "1000", accountCode: "1000", accountName: "Cash at Bank", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 5_000_000, isCashAccount: true }),
    row({ accountKey: "1100", accountCode: "1100", accountName: "Trade Receivables", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 2_000_000 }),
    row({ accountKey: "1500", accountCode: "1500", accountName: "Property, Plant & Equipment", statement: "balance_sheet", classification: "non_current_assets", normalBalance: "debit", balance: 8_000_000 }),
    row({ accountKey: "2000", accountCode: "2000", accountName: "Trade Payables", statement: "balance_sheet", classification: "current_liabilities", normalBalance: "credit", balance: 3_000_000 }),
    row({ accountKey: "2500", accountCode: "2500", accountName: "Long-term Loan", statement: "balance_sheet", classification: "non_current_liabilities", normalBalance: "credit", balance: 4_000_000 }),
    row({ accountKey: "3000", accountCode: "3000", accountName: "Share Capital", statement: "balance_sheet", classification: "equity", normalBalance: "credit", balance: 6_000_000 }),
    row({ accountKey: "3100", accountCode: "3100", accountName: "Retained Earnings", statement: "balance_sheet", classification: "equity", normalBalance: "credit", balance: 2_000_000, isRetainedEarnings: true }),
    row({ accountKey: "4000", accountCode: "4000", accountName: "Sales Revenue", statement: "income_statement", classification: "revenue", normalBalance: "credit", balance: 12_000_000 }),
    row({ accountKey: "5000", accountCode: "5000", accountName: "Cost of Sales", statement: "income_statement", classification: "cost_of_goods_sold", normalBalance: "debit", balance: 6_000_000 }),
    row({ accountKey: "6000", accountCode: "6000", accountName: "Operating Expenses", statement: "income_statement", classification: "operating_expenses", normalBalance: "debit", balance: 3_000_000 }),
  ];
}
// Assets: 5,000,000 + 2,000,000 + 8,000,000 = 15,000,000
// Liabilities: 3,000,000 + 4,000,000 = 7,000,000
// Equity: 6,000,000 + 2,000,000 = 8,000,000
// Liabilities + Equity = 15,000,000 = Assets ✓

async function buildValidatedReport(lines: readonly ReviewedTrialBalanceAccountLine[]): Promise<CanonicalFinancialStatementReport> {
  const adapter = createTrialBalanceAdapter();
  const extraction = await adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: lines });
  const report: CanonicalFinancialStatementReport = {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    reportIdentity: { reportId: "report-1", companyId: "company-1", reportVersion: 1 },
    entity: { legalName: "Test Company Ltd" },
    period: { periodId: "CURRENT", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025 },
    comparativePeriods: [],
    framework: { kind: "IFRS_FOR_SMES" },
    presentationCurrency: { currency: "TZS", scale: 2, roundingPolicy: { mode: "HALF_UP", scale: 2 }, presentationMultiplier: 1n },
    statements: extraction.statements,
    notes: extraction.notes,
    noteReferences: [],
    accountingPolicies: extraction.accountingPolicies,
    textualDisclosures: extraction.textualDisclosures,
    facts: extraction.facts,
    provenanceOrigin: "TRIAL_BALANCE_DERIVED",
  };
  return validateCanonicalReport(report);
}

describe("trialBalanceAdapter — happy path", () => {
  it("produces a validation-passing report from a balanced trial balance", async () => {
    const report = await buildValidatedReport(balancedCurrentPeriodLines());
    expect(report.statements.map((s) => s.type)).toEqual(["STATEMENT_OF_FINANCIAL_POSITION", "STATEMENT_OF_PROFIT_OR_LOSS"]);
  });

  it("passes the SFP equation and subtotal casting rules for a balanced trial balance", async () => {
    const report = await buildValidatedReport(balancedCurrentPeriodLines());
    const ctx = buildRuleContext(report, ZERO_TOLERANCE);
    const findings = runCanonicalRulePackV1(ctx);

    const equationFindings = findings.filter((f) => f.ruleId === "sfp-equation");
    expect(equationFindings).toHaveLength(1);
    expect(equationFindings[0].outcome).toBe("PASS");

    const castingFindings = findings.filter((f) => f.ruleId === "subtotal-casting");
    expect(castingFindings.length).toBeGreaterThan(0);
    expect(castingFindings.every((f) => f.outcome === "PASS")).toBe(true);
  });

  it("emits a warning and excludes SCF-classified accounts rather than fabricating a cash flow statement", async () => {
    const lines = [...balancedCurrentPeriodLines(), row({ accountKey: "7000", accountName: "Loan Proceeds", statement: "balance_sheet", classification: "financing_activities", normalBalance: "credit", balance: 1_000_000 })];
    const adapter = createTrialBalanceAdapter();
    const extraction = await adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: lines });
    expect(extraction.statements.some((s) => s.type === "STATEMENT_OF_CASH_FLOWS")).toBe(false);
    expect(extraction.warnings.some((w) => w.includes("TB_CASH_FLOW_CLASSIFICATION_SKIPPED"))).toBe(true);
  });

  it("does not fabricate a net-profit line on the P&L", async () => {
    const report = await buildValidatedReport(balancedCurrentPeriodLines());
    const pl = report.statements.find((s) => s.type === "STATEMENT_OF_PROFIT_OR_LOSS")!;
    const allConcepts = pl.sections.flatMap((s) => s.lines.map((l) => l.concept));
    expect(allConcepts.some((c) => c.includes("net"))).toBe(false);
  });

  it("carries a comparative period through to a comparative-period-aware fact binding", async () => {
    const lines = [
      ...balancedCurrentPeriodLines(),
      row({ accountKey: "1000", accountCode: "1000", accountName: "Cash at Bank", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 4_500_000, periodId: "COMPARATIVE_1", isComparative: true }),
    ];
    const adapter = createTrialBalanceAdapter();
    const extraction = await adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: lines });
    const cashLine = extraction.statements[0].sections.flatMap((s) => s.lines).find((l) => l.lineId === "line:detail:sfp:1000")!;
    expect(cashLine.factBindings).toHaveLength(2);
    expect(cashLine.factBindings.map((b) => b.periodId).sort()).toEqual(["COMPARATIVE_1", "CURRENT"]);
  });
});

describe("trialBalanceAdapter — determinism", () => {
  it("produces byte-identical extraction regardless of input row order (permutation invariance)", async () => {
    const adapter = createTrialBalanceAdapter();
    const original = balancedCurrentPeriodLines();
    const shuffled = [...original].reverse();

    const a = await adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: original });
    const b = await adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: shuffled });

    const serialize = (r: typeof a) => JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(serialize(a)).toBe(serialize(b));
  });

  it("is replay-safe — running normalize twice on the same input produces identical output", async () => {
    const adapter = createTrialBalanceAdapter();
    const lines = balancedCurrentPeriodLines();
    const a = await adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: lines });
    const b = await adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: lines });
    const serialize = (r: typeof a) => JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(serialize(a)).toBe(serialize(b));
  });
});

describe("trialBalanceAdapter — malformed and adversarial input", () => {
  it("rejects an empty input", async () => {
    const adapter = createTrialBalanceAdapter();
    await expect(adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: [] })).rejects.toThrow(AdapterRejectedError);
  });

  it("rejects input with no CURRENT period data", async () => {
    const adapter = createTrialBalanceAdapter();
    const lines = balancedCurrentPeriodLines().map((l) => ({ ...l, periodId: "COMPARATIVE_1", isComparative: true }));
    await expect(adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: lines })).rejects.toThrow(AdapterRejectedError);
  });

  it("rejects input with inconsistent currency across rows", async () => {
    const adapter = createTrialBalanceAdapter();
    const lines = [...balancedCurrentPeriodLines()];
    lines[0] = { ...lines[0], currency: "USD" };
    await expect(adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: lines })).rejects.toThrow(AdapterRejectedError);
  });

  it("rejects a duplicate account within the same period", async () => {
    const adapter = createTrialBalanceAdapter();
    const lines = [...balancedCurrentPeriodLines(), row({ accountKey: "1000", accountName: "Cash at Bank (dup)", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 1 })];
    await expect(adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: lines })).rejects.toThrow(AdapterRejectedError);
  });

  it("rejects an amount with unsupported sub-scale precision rather than rounding it", async () => {
    const adapter = createTrialBalanceAdapter();
    const lines = [...balancedCurrentPeriodLines()];
    lines[0] = { ...lines[0], balance: 5_000_000.125 };
    await expect(adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: lines })).rejects.toThrow(AdapterRejectedError);
  });

  it("rejects a row whose classification does not belong on its declared statement", async () => {
    const adapter = createTrialBalanceAdapter();
    const lines = [...balancedCurrentPeriodLines(), row({ accountKey: "9999", accountName: "Bad Row", statement: "balance_sheet", classification: "revenue", normalBalance: "credit", balance: 100 })];
    await expect(adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: lines })).rejects.toThrow(AdapterRejectedError);
  });

  it("rejects structurally malformed rows (schema violation) rather than coercing them", async () => {
    const adapter = createTrialBalanceAdapter();
    const malformed = [{ accountKey: "1", accountName: "X", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: "not-a-number" }];
    await expect(adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: malformed })).rejects.toThrow(AdapterRejectedError);
  });

  it("never partially mutates its own module state between a rejected call and a later valid call", async () => {
    const adapter = createTrialBalanceAdapter();
    await expect(adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: [] })).rejects.toThrow(AdapterRejectedError);
    const extraction = await adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: balancedCurrentPeriodLines() });
    expect(extraction.statements.length).toBeGreaterThan(0);
  });
});
