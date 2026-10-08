import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { compositionClient, parseComposition, statementViews, type Composition } from "./composition";

const CERT = "11111111-1111-4111-8111-111111111111";
const PRIOR = "22222222-2222-4222-8222-222222222222";
const ASG = "33333333-3333-4333-8333-333333333333";
const lineage = (k: string, amt: string) => [{ period: "current", accountKey: k, accountCode: k, accountName: k, certificationId: CERT, classification: "x",
  amountMinor: amt, certifiedAmountMinor: amt, adjustmentIds: [], assignmentId: ASG, assignmentSeq: 1, kind: "account", bridgeId: null, restatementId: null }];
const L = (statement: "SFP" | "SCI", section: string, lineId: string, label: string, cur: string, cmp: string | null) =>
  ({ statement, section, lineId, label, requirementId: "r", current: { amountMinor: cur, accounts: 1 }, comparative: cmp === null ? null : { amountMinor: cmp, accounts: 1, asReportedMinor: cmp, restated: false }, lineage: lineage(lineId, cur) });

// The server's composition of the proof's trial balances (scripts/db-proof/statementComposition.mjs).
function composed(over: Partial<Composition> = {}): Composition {
  return {
    state: "composed", contract: "fs-statement-composition/2",
    pack: { family: "ifrs-for-smes", linesVersion: "1.0.0", packId: "ifrs-for-smes/2015", earlyApplication: false },
    inputSha256: "a".repeat(64),
    current: { periodYear: 2026, certificationId: CERT, currency: "TZS", exponent: 2, reportingStart: "2026-01-01", reportingEnd: "2026-12-31" },
    comparative: { state: "available", periodYear: 2025, certificationId: PRIOR, currency: "TZS", bridgeIds: [], restatementIds: [] },
    lines: [
      L("SFP", "non_current_assets", "sfp.property_plant_and_equipment", "Property, plant and equipment", "1400000", "1600000"),
      L("SFP", "current_assets", "sfp.cash_and_cash_equivalents", "Cash and cash equivalents", "1250000", "800000"),
      L("SFP", "current_assets", "sfp.trade_and_other_receivables", "Trade and other receivables", "430000", "300000"),
      L("SFP", "current_assets", "sfp.inventories", "Inventories", "220000", "180000"),
      L("SFP", "equity", "sfp.equity_attributable_to_owners", "Equity attributable to owners", "1590000", "1350000"),
      L("SFP", "non_current_liabilities", "sfp.other_financial_liabilities", "Borrowings and other financial liabilities", "800000", "900000"),
      L("SFP", "current_liabilities", "sfp.trade_and_other_payables", "Trade and other payables", "310000", "250000"),
      L("SFP", "current_liabilities", "sfp.current_tax", "Current tax", "90000", "70000"),
      L("SCI", "sci", "sci.revenue", "Revenue", "3000000", "2500000"),
      L("SCI", "sci", "sci.other_income", "Other income", "50000", "40000"),
      L("SCI", "sci", "sci.cost_of_sales", "Cost of sales", "1400000", "1150000"),
      L("SCI", "sci", "sci.operating_expenses_by_function", "Distribution, administrative and other expenses (by function)", "990000", "940000"),
      L("SCI", "sci", "sci.finance_costs", "Finance costs", "60000", "70000"),
      L("SCI", "sci", "sci.tax_expense", "Tax expense", "90000", "70000"),
    ],
    totals: {
      current: { state: "complete", nonCurrentAssetsMinor: "1400000", currentAssetsMinor: "1900000", totalAssetsMinor: "3300000", currentLiabilitiesMinor: "400000",
        nonCurrentLiabilitiesMinor: "800000", totalLiabilitiesMinor: "1200000", equityAccountsMinor: "1590000", incomeMinor: "3050000", expensesExcludingTaxMinor: "2450000",
        profitBeforeTaxMinor: "600000", taxExpenseMinor: "90000", profitOrLossMinor: "510000", totalEquityMinor: "2100000", totalEquityAndLiabilitiesMinor: "3300000", balanceDifferenceMinor: "0" },
      comparative: { state: "complete", nonCurrentAssetsMinor: "1600000", currentAssetsMinor: "1280000", totalAssetsMinor: "2880000", currentLiabilitiesMinor: "320000",
        nonCurrentLiabilitiesMinor: "900000", totalLiabilitiesMinor: "1220000", equityAccountsMinor: "1350000", incomeMinor: "2540000", expensesExcludingTaxMinor: "2160000",
        profitBeforeTaxMinor: "380000", taxExpenseMinor: "70000", profitOrLossMinor: "310000", totalEquityMinor: "1660000", totalEquityAndLiabilitiesMinor: "2880000", balanceDifferenceMinor: "0" },
    },
    accountsNotPresented: [], blockers: [], compositionSha256: "b".repeat(64),
    ...over,
  } as Composition;
}
const rows = (c: Composition, id: "SFP" | "SCI") => statementViews(c).find((v) => v.id === id)!.rows.map((r) => [r.kind, r.label, r.current?.text ?? "", r.comparative?.text ?? ""]);

describe("statement view: the server's figures, laid out (hand-written expected text)", () => {
  it("statement of financial position, both years", () => {
    expect(rows(parseComposition(composed()) as Composition, "SFP")).toEqual([
      ["heading", "Non-current assets", "", ""],
      ["line", "Property, plant and equipment", "14,000.00", "16,000.00"],
      ["subtotal", "Total non-current assets", "14,000.00", "16,000.00"],
      ["heading", "Current assets", "", ""],
      ["line", "Cash and cash equivalents", "12,500.00", "8,000.00"],
      ["line", "Trade and other receivables", "4,300.00", "3,000.00"],
      ["line", "Inventories", "2,200.00", "1,800.00"],
      ["subtotal", "Total current assets", "19,000.00", "12,800.00"],
      ["total", "Total assets", "33,000.00", "28,800.00"],
      ["heading", "Equity", "", ""],
      ["line", "Equity attributable to owners", "15,900.00", "13,500.00"],
      ["line", "Profit or loss for the period (not yet transferred to equity accounts)", "5,100.00", "3,100.00"],
      ["subtotal", "Total equity", "21,000.00", "16,600.00"],
      ["heading", "Non-current liabilities", "", ""],
      ["line", "Borrowings and other financial liabilities", "8,000.00", "9,000.00"],
      ["subtotal", "Total non-current liabilities", "8,000.00", "9,000.00"],
      ["heading", "Current liabilities", "", ""],
      ["line", "Trade and other payables", "3,100.00", "2,500.00"],
      ["line", "Current tax", "900.00", "700.00"],
      ["subtotal", "Total current liabilities", "4,000.00", "3,200.00"],
      ["subtotal", "Total liabilities", "12,000.00", "12,200.00"],
      ["total", "Total equity and liabilities", "33,000.00", "28,800.00"],
    ]);
  });
  it("statement of comprehensive income: expenses in parentheses, profit before tax and profit or loss from the server", () => {
    expect(rows(composed(), "SCI")).toEqual([
      ["line", "Revenue", "30,000.00", "25,000.00"],
      ["line", "Other income", "500.00", "400.00"],
      ["line", "Cost of sales", "(14,000.00)", "(11,500.00)"],
      ["line", "Distribution, administrative and other expenses (by function)", "(9,900.00)", "(9,400.00)"],
      ["line", "Finance costs", "(600.00)", "(700.00)"],
      ["subtotal", "Profit before tax", "6,000.00", "3,800.00"],
      ["line", "Tax expense", "(900.00)", "(700.00)"],
      ["total", "Profit or loss for the period", "5,100.00", "3,100.00"],
    ]);
  });
  it("an incomplete period shows its totals as missing with the reason — never zero; its lines still show", () => {
    const c = composed({ totals: { current: { state: "incomplete", notPresented: 2 }, comparative: composed().totals.comparative } });
    const sfp = statementViews(c).find((v) => v.id === "SFP")!.rows;
    const total = sfp.find((r) => r.label === "Total assets")!;
    expect([total.current!.text, total.current!.state, total.current!.description]).toEqual(["—", "missing", "Not available: 2 account(s) not presented"]);
    expect(total.comparative!.text).toBe("28,800.00");
    expect(sfp.find((r) => r.label === "Inventories")!.current!.text).toBe("2,200.00");
  });
  it("a prior year in another currency: every comparative is missing with the translation reason", () => {
    const c = composed({ comparative: { state: "different_currency", periodYear: 2025, certificationId: PRIOR, currency: "USD", bridgeIds: [], restatementIds: [] },
      lines: composed().lines.map((l) => ({ ...l, comparative: null })), totals: { current: composed().totals.current } });
    for (const v of statementViews(c)) for (const r of v.rows.filter((x) => x.kind !== "heading")) {
      expect([r.comparative!.text, r.comparative!.description], r.label).toEqual(["—", "Not available: the prior year is in another currency (translation is deferred)"]);
    }
  });
  it("a restated comparative shows the presented figure and, beside it, the as-reported one (hand-written: 15,500.00 / 16,000.00)", () => {
    const base = composed();
    const lines = base.lines.map((l) => (l.lineId === "sfp.property_plant_and_equipment" ? { ...l, comparative: { amountMinor: "1550000", accounts: 2, asReportedMinor: "1600000", restated: true } } : l));
    const r = statementViews(composed({ lines }))[0].rows.find((x) => x.label === "Property, plant and equipment")!;
    expect([r.comparative!.text, r.comparativeAsReported!.text]).toEqual(["15,500.00", "16,000.00"]);
    expect(statementViews(base)[0].rows.find((x) => x.label === "Property, plant and equipment")!.comparativeAsReported).toBeUndefined();
  });
  it("a zero line is 0.00 (zero), distinct from missing", () => {
    const c = composed({ lines: [L("SFP", "current_assets", "sfp.inventories", "Inventories", "0", "180000")] });
    const r = statementViews(c)[0].rows.find((x) => x.label === "Inventories")!;
    expect([r.current!.text, r.current!.state]).toEqual(["0.00", "zero"]);
  });
});

describe("payload validation", () => {
  it("accepts the non-composed states and refuses anything malformed (a float amount, a wrong contract)", () => {
    expect(parseComposition({ state: "edition_unresolved", reason: "PERIOD_START_UNKNOWN", periodYear: 2026 }).state).toBe("edition_unresolved");
    expect(() => parseComposition({ ...composed(), lines: [{ ...composed().lines[0], current: { amountMinor: "14000.5", accounts: 1 } }] })).toThrow();
    expect(() => parseComposition({ ...composed(), contract: "other/1" })).toThrow();
    expect(() => parseComposition({ ...composed(), contract: "fs-statement-composition/1" })).toThrow(); // a superseded contract is refused, not half-read
  });
});

describe("client: server RPCs only, the caller's own session", () => {
  it("calls fs_statement_composition / fs_assign_presentation / fs_elect_early_application with exactly these arguments", async () => {
    const rpc = vi.fn(async (fn: string) => ({ data: fn === "fs_statement_composition" ? composed() : { outcome: "recorded", count: 1 }, error: null }));
    const c = compositionClient({ rpc });
    await c.compose("co", 2026);
    await c.assign("co", [{ accountKey: "1000", lineId: "sfp.inventories" }], "Reason here", "req");
    await c.electEarlyApplication("co", 2026, true, "Ref 1", "Board decision");
    expect(rpc.mock.calls).toEqual([
      ["fs_statement_composition", { p_company_id: "co", p_period_year: 2026 }],
      ["fs_assign_presentation", { p_company_id: "co", p_assignments: [{ accountKey: "1000", lineId: "sfp.inventories" }], p_reason: "Reason here", p_request_id: "req" }],
      ["fs_elect_early_application", { p_company_id: "co", p_period_year: 2026, p_elect: true, p_jurisdiction_confirmation: "Ref 1", p_reason: "Board decision" }],
    ]);
  });
  it("the module writes no table and reaches no withheld service", () => {
    const src = fs.readFileSync(path.join(__dirname, "composition.ts"), "utf8");
    expect(src).not.toMatch(/\.from\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
    expect(src).not.toMatch(/kinga|generate-disclosure-notes|generate-management-letter|generate-xbrl/i);
  });
});
