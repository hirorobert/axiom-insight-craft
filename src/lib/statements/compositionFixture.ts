// statements/compositionFixture.ts — a small composition payload (two years, TZS, 2 dp) shared by tests. Test data only:
// imported by *.test.ts files, never by product code.
import type { Composition } from "./composition";

const CERT = "11111111-1111-4111-8111-111111111111";
const PRIOR = "22222222-2222-4222-8222-222222222222";
const L = (statement: "SFP" | "SCI", section: string, lineId: string, label: string, cur: string, cmp: string) =>
  ({ statement, section, lineId, label, requirementId: "r", current: { amountMinor: cur, accounts: 1 }, comparative: { amountMinor: cmp, accounts: 1, asReportedMinor: cmp, restated: false }, lineage: [] });
const T = (o: Record<string, string>) => ({ state: "complete", ...o });
const acct = (period: string, key: string, name: string, amt: string) => ({ period, accountKey: key, accountCode: key, accountName: name, certificationId: period === "current" ? CERT : PRIOR,
  classification: "non_current_assets", amountMinor: amt, certifiedAmountMinor: amt, adjustmentIds: [], assignmentId: CERT, assignmentSeq: 1, kind: "account", bridgeId: null, restatementId: null });
export const composition = {
  state: "composed", contract: "fs-statement-composition/2",
  pack: { family: "ifrs-for-smes", linesVersion: "1.0.0", packId: "ifrs-for-smes/2015", earlyApplication: false }, inputSha256: "a".repeat(64),
  current: { periodYear: 2026, certificationId: CERT, currency: "TZS", exponent: 2, reportingStart: "2026-01-01", reportingEnd: "2026-12-31" },
  comparative: { state: "available", periodYear: 2025, certificationId: PRIOR, currency: "TZS", bridgeIds: [], restatementIds: [] },
  lines: [
    { ...L("SFP", "non_current_assets", "sfp.property_plant_and_equipment", "Property, plant and equipment", "1400000", "1600000"),
      lineage: [acct("current", "1500", "Equipment at cost", "2000000"), acct("current", "1510", "Accumulated depreciation", "-600000"),
        acct("comparative", "1500", "Equipment at cost", "2000000"), acct("comparative", "1510", "Accumulated depreciation", "-400000")] },
    L("SFP", "current_assets", "sfp.cash_and_cash_equivalents", "Cash and cash equivalents", "1900000", "1280000"),
    L("SFP", "equity", "sfp.equity_attributable_to_owners", "Equity attributable to owners", "1590000", "1350000"),
    L("SFP", "non_current_liabilities", "sfp.other_financial_liabilities", "Borrowings", "800000", "900000"),
    L("SFP", "current_liabilities", "sfp.trade_and_other_payables", "Trade and other payables", "400000", "320000"),
    L("SCI", "sci", "sci.revenue", "Revenue", "3050000", "2540000"),
    L("SCI", "sci", "sci.cost_of_sales", "Cost of sales", "2450000", "2160000"),
    L("SCI", "sci", "sci.tax_expense", "Tax expense", "90000", "70000"),
  ],
  totals: {
    current: T({ nonCurrentAssetsMinor: "1400000", currentAssetsMinor: "1900000", totalAssetsMinor: "3300000", currentLiabilitiesMinor: "400000", nonCurrentLiabilitiesMinor: "800000",
      totalLiabilitiesMinor: "1200000", equityAccountsMinor: "1590000", incomeMinor: "3050000", expensesExcludingTaxMinor: "2450000", profitBeforeTaxMinor: "600000",
      taxExpenseMinor: "90000", profitOrLossMinor: "510000", totalEquityMinor: "2100000", totalEquityAndLiabilitiesMinor: "3300000", balanceDifferenceMinor: "0" }),
    comparative: T({ nonCurrentAssetsMinor: "1600000", currentAssetsMinor: "1280000", totalAssetsMinor: "2880000", currentLiabilitiesMinor: "320000", nonCurrentLiabilitiesMinor: "900000",
      totalLiabilitiesMinor: "1220000", equityAccountsMinor: "1350000", incomeMinor: "2540000", expensesExcludingTaxMinor: "2160000", profitBeforeTaxMinor: "380000",
      taxExpenseMinor: "70000", profitOrLossMinor: "310000", totalEquityMinor: "1660000", totalEquityAndLiabilitiesMinor: "2880000", balanceDifferenceMinor: "0" }),
  },
  accountsNotPresented: [], blockers: [], compositionSha256: "b".repeat(64),
} as unknown as Composition;
export const COMPARATIVE_DATES = { start: "2025-01-01", end: "2025-12-31" };
