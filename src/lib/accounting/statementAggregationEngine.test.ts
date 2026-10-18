/**
 * statementAggregationEngine.test.ts
 *
 * Slice 9 — proves the accounting equation against a complete, balanced
 * trial balance: the independently invented synthetic LGA FY2026 fixture
 * (50 accounts), classified through the real rule pack. Every expected
 * figure below was computed by hand from the fixture, outside this code.
 */

import { describe, it, expect } from "vitest";
import { aggregateStatementPresentation, assessStatementReadiness, type ClassifiedBalance } from "./statementAggregationEngine";
import { TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 } from "./museIpsasRulePack";
import { classifyMuseAccount } from "./museClassifier";
import { SYNTHETIC_LGA_FY2026_BALANCES } from "./syntheticLgaFy2026Balances.fixture";

const RULE_BY_CODE = new Map(TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.map((r) => [r.naturalAccountCode, r]));

function buildClassifiedBalances(): ClassifiedBalance[] {
  return SYNTHETIC_LGA_FY2026_BALANCES.map((b) => {
    const rule = RULE_BY_CODE.get(b.code);
    if (!rule) throw new Error(`No rule for code ${b.code} — fixture/rule-pack drift`);
    return {
      naturalAccountCode: b.code,
      accountNature: rule.accountNature,
      presentationCode: rule.presentationCode,
      debitAmount: b.debit,
      creditAmount: b.credit,
    };
  });
}

describe("aggregateStatementPresentation — synthetic LGA FY2026 (all 50 accounts)", () => {
  const balances = buildClassifiedBalances();
  const result = aggregateStatementPresentation(balances);

  it("every account was classified — fixture and rule pack agree on all 50 codes", () => {
    expect(balances).toHaveLength(50);
  });

  it("the accounting equation holds exactly on a balanced trial balance", () => {
    // Hand-computed: assets 29,536,000,000 - liabilities 2,230,640,000 - net assets 20,646,310,000
    // - surplus 6,659,050,000 = 0.
    expect(result.accountingEquationHolds).toBe(true);
    expect(result.accountingEquationVariance).toBe(0);
  });

  it("the computed surplus/(deficit) equals revenue less expenses computed independently from the fixture", () => {
    // Revenue 26,097,800,000 - expenses 19,438,750,000 = 6,659,050,000.
    expect(result.surplusForPeriod).toBe(6_659_050_000);
  });

  it("section totals equal the hand-computed, normal-balance-signed totals (contra accounts net against their section)", () => {
    expect(result.sectionTotals).toEqual({
      ASSET: 29_536_000_000,
      LIABILITY: 2_230_640_000,
      NET_ASSETS: 20_646_310_000,
      REVENUE: 26_097_800_000,
      EXPENSE: 19_438_750_000,
    });
  });

  it("line items aggregate per presentation code — 28 distinct codes, with accounts counted per line", () => {
    expect(result.lineItems).toHaveLength(28);
    const ppeOpening = result.lineItems.find((l) => l.presentationCode === "PROPERTY_PLANT_EQUIPMENT_OPENING")!;
    expect(ppeOpening.accountCount).toBe(4);
    expect(ppeOpening.netAmount).toBe(31_500_000_000); // 9.6bn + 14.2bn + 5.3bn + 2.4bn
    const contra = result.lineItems.find((l) => l.presentationCode === "PPE_ACCUMULATED_DEPRECIATION_CONTRA")!;
    expect(contra.netAmount).toBe(-9_810_000_000); // credit-side contra reduces assets
  });
});

describe("aggregateStatementPresentation — synthetic edge cases", () => {
  it("an empty input aggregates to all-zero totals, not an error", () => {
    const result = aggregateStatementPresentation([]);
    expect(result.sectionTotals.ASSET).toBe(0);
    expect(result.accountingEquationHolds).toBe(true); // 0 = 0 - 0 - 0
  });

  it("a contrived unbalanced set correctly reports accountingEquationHolds=false with the actual variance, never silently passes", () => {
    const unbalanced: ClassifiedBalance[] = [
      { naturalAccountCode: "1", accountNature: "ASSET", presentationCode: "CASH_AND_CASH_EQUIVALENTS", debitAmount: 1000, creditAmount: 0 },
      // No offsetting liability/net-assets/revenue — deliberately broken.
    ];
    const result = aggregateStatementPresentation(unbalanced);
    expect(result.accountingEquationHolds).toBe(false);
    expect(result.accountingEquationVariance).toBe(1000);
  });
});

describe("assessStatementReadiness — Section XII: never mark ready over a material gap", () => {
  it("a material UNRESOLVED account blocks readiness with an explicit reason", () => {
    const outcomes = [classifyMuseAccount({ naturalAccountCode: "00000000", accountName: "Unseen", balance: 0 })];
    const balanceByCode = new Map([["00000000", 5_000_000]]);
    const readiness = assessStatementReadiness(outcomes, balanceByCode, 1_000_000);
    expect(readiness.ready).toBe(false);
    expect(readiness.unresolvedCount).toBe(1);
    expect(readiness.blockingReason).toContain("exceed the materiality threshold");
  });

  it("an immaterial UNRESOLVED account does not block — zero UNNECESSARY review, not zero review", () => {
    const outcomes = [classifyMuseAccount({ naturalAccountCode: "00000000", accountName: "Unseen", balance: 0 })];
    const balanceByCode = new Map([["00000000", 500]]);
    const readiness = assessStatementReadiness(outcomes, balanceByCode, 1_000_000);
    expect(readiness.ready).toBe(true);
    expect(readiness.blockingReason).toBeUndefined();
  });

  it("all fixture accounts resolved (0 UNRESOLVED) means readiness is trivially true regardless of threshold", () => {
    const outcomes = SYNTHETIC_LGA_FY2026_BALANCES.map((b) =>
      classifyMuseAccount({ naturalAccountCode: b.code, accountName: "", balance: 0 }),
    );
    const readiness = assessStatementReadiness(outcomes, new Map(), 0);
    expect(readiness.unresolvedCount).toBe(0);
    expect(readiness.ready).toBe(true);
  });
});
