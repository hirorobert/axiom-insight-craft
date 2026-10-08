import { describe, expect, it } from "vitest";
import { safeValidateCanonicalReport } from "@/lib/canonicalStatement/validation";
import { CANONICAL_SCHEMA_VERSION, composedStatements, lineFactId, totalFactId } from "./canonicalDocument";
import type { Composition } from "./composition";

const CERT = "11111111-1111-4111-8111-111111111111";
const PRIOR = "22222222-2222-4222-8222-222222222222";
const L = (statement: "SFP" | "SCI", section: string, lineId: string, label: string, cur: string, cmp: string) =>
  ({ statement, section, lineId, label, requirementId: "r", current: { amountMinor: cur, accounts: 1 }, comparative: { amountMinor: cmp, accounts: 1, asReportedMinor: cmp, restated: false }, lineage: [] });
const T = (o: Record<string, string>) => ({ state: "complete", ...o });
const acct = (period: string, key: string, name: string, amt: string) => ({ period, accountKey: key, accountCode: key, accountName: name, certificationId: period === "current" ? CERT : PRIOR,
  classification: "non_current_assets", amountMinor: amt, certifiedAmountMinor: amt, adjustmentIds: [], assignmentId: CERT, assignmentSeq: 1, kind: "account", bridgeId: null, restatementId: null });
const composition = {
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
const DATES = { start: "2025-01-01", end: "2025-12-31" };

describe("composed statements: exactly the server's figures under the fixed fact identities", () => {
  const out = composedStatements(composition, DATES);
  it("one fact per composed line and period, and per total of each complete period — the ids the sign-off checks", () => {
    const ids = out.facts.map((f) => f.factId);
    expect(ids).toContain(lineFactId("current", "non_current_assets", "sfp.property_plant_and_equipment"));
    expect(ids).toContain(totalFactId("comparative", "totalAssetsMinor"));
    expect(ids.filter((i) => i.includes(":total:")).length).toBe(30); // 15 totals × 2 periods
    expect(ids.length).toBe(8 * 2 + 30 + 4); // + PPE's two accounts in two periods
    expect(new Set(ids).size).toBe(ids.length);
    // Amounts copied, never computed (hand-written expectations).
    const v = (id: string) => out.facts.find((f) => f.factId === id)!.value!.minorUnits;
    expect([v(lineFactId("current", "sci", "sci.revenue")), v(totalFactId("current", "profitOrLossMinor")), v(totalFactId("comparative", "totalEquityAndLiabilitiesMinor"))])
      .toEqual([3050000n, 510000n, 2880000n]);
    // Every fact carries the reporting input's identity as its trial-balance source (the readiness stale check).
    expect(new Set(out.facts.map((f) => f.provenance.source.sourceHash))).toEqual(new Set(["a".repeat(64)]));
  });
  it("each composed line casts its accounts: PPE is a SUBTOTAL of line:detail:sfp:1500 and :1510, whose facts are the lineage amounts", () => {
    const sfp = out.statements.find((s) => s.type === "STATEMENT_OF_FINANCIAL_POSITION")!;
    const lines = sfp.sections.flatMap((s) => s.lines);
    const ppe = lines.find((l) => l.lineId === "line:non_current_assets:sfp.property_plant_and_equipment")!;
    expect([ppe.role, ppe.castingChildLineIds]).toEqual(["SUBTOTAL", ["line:detail:sfp:1500", "line:detail:sfp:1510"]]);
    const v = (id: string) => out.facts.find((f) => f.factId === id)!.value!.minorUnits;
    expect([v("fact:current:account:1500"), v("fact:current:account:1510"), v("fact:comparative:account:1510")]).toEqual([2000000n, -600000n, -400000n]);
    expect(lines.find((l) => l.lineId === "line:detail:sfp:1510")!.factBindings).toEqual([{ periodId: "CURRENT", factId: "fact:current:account:1510" }, { periodId: "COMPARATIVE_1", factId: "fact:comparative:account:1510" }]);
  });
  it("the comparative period's dates are the input's; without them, a composed comparative is refused", () => {
    expect(out.comparativePeriods).toEqual([{ periodId: "COMPARATIVE_1", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025, isRestated: false }]);
    expect(() => composedStatements(composition, null)).toThrow(/period dates were not supplied/);
  });
  it("the assembled statements validate against the canonical model", () => {
    const doc = {
      schemaVersion: CANONICAL_SCHEMA_VERSION, reportIdentity: { reportId: "r", companyId: "c", reportVersion: 1 }, entity: { legalName: "Synthetic SME" },
      period: { periodId: "CURRENT", startDate: "2026-01-01", endDate: "2026-12-31", periodYear: 2026 }, comparativePeriods: out.comparativePeriods,
      framework: { kind: "IFRS_FOR_SMES" }, presentationCurrency: { currency: "TZS", scale: 2, roundingPolicy: { mode: "HALF_UP", scale: 2 }, presentationMultiplier: 1n },
      statements: out.statements, notes: [], noteReferences: [], accountingPolicies: [], textualDisclosures: [], facts: out.facts, provenanceOrigin: "TRIAL_BALANCE_DERIVED",
    };
    const r = safeValidateCanonicalReport(doc);
    expect(r.status === "VALID" ? [] : r.issues.slice(0, 5)).toEqual([]);
  });
});
