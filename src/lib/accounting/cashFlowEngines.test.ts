/**
 * cashFlowEngines.test.ts
 *
 * Slice 10 — proves the two cash-flow engines stay distinct products that
 * cross-check to the same operating total. Account-level cases run on the
 * independently invented synthetic LGA trial balances
 * (syntheticLgaFy2025/2026Balances.fixture.ts), classified through the real
 * rule pack; every expected figure below was computed by hand from those
 * fixtures, outside this code. Financing activities use a separate, clearly
 * labelled synthetic case (the fixtures, like a typical LGA chart, carry no
 * financing-classified account).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildOperatingCashFlowReconciliation,
  buildInvestingActivities,
  buildFinancingActivities,
  buildPrimaryCashFlowStatement,
  crossCheckOperatingCashFlow,
  findUnresolvedCashFlowLines,
  verifyCashPositionReconciliation,
  type WorkingCapitalComparative,
  type CashPositionFacts,
  type MaterialityThreshold,
} from "./cashFlowEngines";
import { aggregateStatementPresentation, type ClassifiedBalance } from "./statementAggregationEngine";
import type { ComparativeAmount } from "./comparativeEvidence";
import { TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 } from "./museIpsasRulePack";
import { SYNTHETIC_LGA_FY2026_BALANCES } from "./syntheticLgaFy2026Balances.fixture";
import { SYNTHETIC_LGA_FY2025_BALANCES } from "./syntheticLgaFy2025Balances.fixture";

const RULE_BY_CODE = new Map(TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.map((r) => [r.naturalAccountCode, r]));

function toClassifiedBalances(rows: Array<{ code: string; debit: number; credit: number }>): ClassifiedBalance[] {
  return rows.map((b) => {
    const rule = RULE_BY_CODE.get(b.code);
    if (!rule) throw new Error(`No rule for ${b.code}`);
    return {
      naturalAccountCode: b.code,
      accountNature: rule.accountNature,
      presentationCode: rule.presentationCode,
      debitAmount: b.debit,
      creditAmount: b.credit,
    };
  });
}

describe("buildOperatingCashFlowReconciliation — synthetic FY2025 depreciation add-back", () => {
  // The synthetic FY2026 trial balance deliberately posts no depreciation
  // (the "charge not posted" case); FY2025 posts four depreciation lines,
  // so the add-back mechanism is proven against non-zero figures.
  const fy2025Balances = toClassifiedBalances(SYNTHETIC_LGA_FY2025_BALANCES);

  it("FY2025 depreciation (4 accounts, TZS 883,500,000.00 total) is fully added back as a non-cash adjustment", () => {
    // 23110101 96,000,000 + 23120102 288,000,000 + 23120103 426,000,000 + 23130102 73,500,000 = 883,500,000
    const recon = buildOperatingCashFlowReconciliation(0, fy2025Balances, []);
    const depreciationLines = recon.nonCashAdjustments.filter((l) => l.presentationCode === "DEPRECIATION_AMORTISATION");
    expect(depreciationLines.map((l) => l.naturalAccountCode).sort()).toEqual(["23110101", "23120102", "23120103", "23130102"]);
    expect(depreciationLines.every((l) => l.amount > 0)).toBe(true);
    const total = depreciationLines.reduce((s, l) => s + l.amount, 0);
    expect(total).toBe(883_500_000);
  });

  it("FY2026 posts no depreciation, so no depreciation add-back is fabricated", () => {
    const recon = buildOperatingCashFlowReconciliation(0, toClassifiedBalances(SYNTHETIC_LGA_FY2026_BALANCES), []);
    expect(recon.nonCashAdjustments.filter((l) => l.presentationCode === "DEPRECIATION_AMORTISATION")).toHaveLength(0);
  });
});

describe("buildOperatingCashFlowReconciliation — synthetic working-capital movements (FY2025 -> FY2026)", () => {
  const fy2025ByCode = new Map(SYNTHETIC_LGA_FY2025_BALANCES.map((b) => [b.code, b.debit - b.credit]));
  const fy2026Balances = toClassifiedBalances(SYNTHETIC_LGA_FY2026_BALANCES);

  // '32171120 Imprest Receivable - Staff' grows from 31,200,000 to 47,500,000.
  it("a receivable increase (asset) is a cash OUTFLOW in the reconciliation", () => {
    const code = "32171120";
    const rule = RULE_BY_CODE.get(code)!;
    const currentNetAmount = fy2026Balances.find((b) => b.naturalAccountCode === code)!.debitAmount
      - fy2026Balances.find((b) => b.naturalAccountCode === code)!.creditAmount;
    const priorNet = fy2025ByCode.get(code)!;
    const wc: WorkingCapitalComparative = {
      naturalAccountCode: code,
      presentationCode: rule.presentationCode,
      accountNature: rule.accountNature,
      currentNetAmount,
      priorNetAmount: { state: "KNOWN", value: priorNet, source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] },
    };
    expect(rule.presentationCode).toBe("RECEIVABLES");
    expect(currentNetAmount).toBe(47_500_000);
    expect(priorNet).toBe(31_200_000);

    const recon = buildOperatingCashFlowReconciliation(0, [], [wc]);
    expect(recon.workingCapitalMovements).toHaveLength(1);
    expect(recon.workingCapitalMovements[0].amount).toBe(-16_300_000); // 47,500,000 - 31,200,000, as an outflow
  });

  it("an account absent from the prior period (MISSING comparative) is skipped, never treated as a zero-based movement (C4)", () => {
    // The MISSING-skip mechanism is proven generically, on a code no rule covers.
    const wc: WorkingCapitalComparative = {
      naturalAccountCode: "99999999",
      presentationCode: "RECEIVABLES",
      accountNature: "ASSET",
      currentNetAmount: 5000,
      priorNetAmount: { state: "MISSING", source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] },
    };
    const recon = buildOperatingCashFlowReconciliation(0, [], [wc]);
    expect(recon.workingCapitalMovements).toHaveLength(0);
    expect(recon.workingCapitalSkipped).toEqual([
      { naturalAccountCode: "99999999", reason: expect.stringContaining("MISSING") },
    ]);
  });
});

describe("buildInvestingActivities — synthetic FY2026 capital expenditure", () => {
  it("PPE/WIP/investment-property additions sum to the capex figure, all as outflows", () => {
    const fy2026Balances = toClassifiedBalances(SYNTHETIC_LGA_FY2026_BALANCES);
    const investing = buildInvestingActivities(fy2026Balances);
    // PPE additions 410,000,000 + 1,275,000,000 + 365,000,000; WIP 2,140,000,000 + 520,000,000;
    // investment property 450,000,000 = 5,160,000,000 (the two WIP-transfer credits are excluded).
    expect(investing.lineItems.map((l) => l.naturalAccountCode).sort()).toEqual(
      ["31112102", "31112103", "31113102", "31510203", "31710109", "31710110"],
    );
    expect(investing.total).toBe(-5_160_000_000);
    expect(investing.lineItems.every((l) => l.amount <= 0)).toBe(true);
  });

  it("WIP-Transfer entries ('31710309'/'31710310') are excluded — they are non-cash reclassifications, not capex (Slice 10 gate finding)", () => {
    // These two codes were initially misclassified as WORK_IN_PROGRESS and
    // broke the "all outflows" invariant above — the fix was a Slice 4
    // rule-pack refinement (WORK_IN_PROGRESS_TRANSFER_NON_CASH), not a
    // cash-flow-engine special case, so it's proven at the rule-pack level.
    // The synthetic FY2026 TB carries credit balances on both, so including
    // them would show up as inflows.
    const transferRule1 = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.find((r) => r.naturalAccountCode === "31710309")!;
    const transferRule2 = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.find((r) => r.naturalAccountCode === "31710310")!;
    expect(transferRule1.presentationCode).toBe("WORK_IN_PROGRESS_TRANSFER_NON_CASH");
    expect(transferRule2.presentationCode).toBe("WORK_IN_PROGRESS_TRANSFER_NON_CASH");

    const fy2026Balances = toClassifiedBalances(SYNTHETIC_LGA_FY2026_BALANCES);
    expect(fy2026Balances.filter((b) => b.presentationCode === "WORK_IN_PROGRESS_TRANSFER_NON_CASH").map((b) => b.creditAmount)).toEqual([600_000_000, 150_000_000]);
    const investing = buildInvestingActivities(fy2026Balances);
    expect(investing.lineItems.some((l) => l.naturalAccountCode === "31710309")).toBe(false);
    expect(investing.lineItems.some((l) => l.naturalAccountCode === "31710310")).toBe(false);
  });
});

describe("buildFinancingActivities — no financing-classified account in the fixture (honestly empty)", () => {
  it("the synthetic LGA trial balance has zero financing-classified accounts — an empty section, not a fabricated one", () => {
    const fy2026Balances = toClassifiedBalances(SYNTHETIC_LGA_FY2026_BALANCES);
    const financing = buildFinancingActivities(fy2026Balances, new Set());
    expect(financing.lineItems).toHaveLength(0);
    expect(financing.total).toBe(0);
  });

  it("mechanism proof (synthetic financing case)", () => {
    const synthetic: ClassifiedBalance[] = [
      { naturalAccountCode: "88888888", accountNature: "LIABILITY", presentationCode: "PAYABLES_AND_ACCRUALS", debitAmount: 0, creditAmount: 500_000_000 },
    ];
    const financing = buildFinancingActivities(synthetic, new Set(["PAYABLES_AND_ACCRUALS"]));
    expect(financing.total).toBe(500_000_000); // a borrowing drawn down is a cash inflow
  });
});

describe("crossCheckOperatingCashFlow — Section XIII mandatory cross-check", () => {
  // An arbitrary invented operating starting figure for the two mechanism cases.
  const OPERATING_SURPLUS = -187_450_000.25;

  it("matches when the primary statement's operating total equals the reconciliation's", () => {
    const reconciliation = buildOperatingCashFlowReconciliation(OPERATING_SURPLUS, [], []);
    const investing = buildInvestingActivities([]);
    const financing = buildFinancingActivities([], new Set());
    const primary = buildPrimaryCashFlowStatement(reconciliation.netCashFromOperatingActivities, investing, financing);
    const check = crossCheckOperatingCashFlow(primary, reconciliation);
    expect(check.matches).toBe(true);
    expect(check.variance).toBe(0);
  });

  it("flags a real disagreement rather than silently passing (adversarial: primary built from a stale/wrong operating figure)", () => {
    const reconciliation = buildOperatingCashFlowReconciliation(OPERATING_SURPLUS, [], []);
    const investing = buildInvestingActivities([]);
    const financing = buildFinancingActivities([], new Set());
    // Deliberately wrong operating figure fed to the primary statement.
    const primary = buildPrimaryCashFlowStatement(reconciliation.netCashFromOperatingActivities + 1000, investing, financing);
    const check = crossCheckOperatingCashFlow(primary, reconciliation);
    expect(check.matches).toBe(false);
    expect(check.variance).toBe(1000);
  });

  it("full synthetic pipeline: FY2026 surplus + FY2026 investing cross-checks internally consistently", () => {
    const fy2026Balances = toClassifiedBalances(SYNTHETIC_LGA_FY2026_BALANCES);
    // Surplus from the aggregation engine: revenue 26,097,800,000 - expenses 19,438,750,000 = 6,659,050,000.
    const surplus = aggregateStatementPresentation(fy2026Balances).surplusForPeriod;
    expect(surplus).toBe(6_659_050_000);
    const investing = buildInvestingActivities(fy2026Balances);
    const financing = buildFinancingActivities(fy2026Balances, new Set());
    const reconciliation = buildOperatingCashFlowReconciliation(surplus, [], []);
    const primary = buildPrimaryCashFlowStatement(reconciliation.netCashFromOperatingActivities, investing, financing);
    const check = crossCheckOperatingCashFlow(primary, reconciliation);
    expect(check.matches).toBe(true);
    // Operating 6,659,050,000 + investing -5,160,000,000 + financing 0 = 1,499,050,000.
    expect(primary.netCashMovementForPeriod).toBe(1_499_050_000);
  });
});

// ── Phase 5 Slice 1: findUnresolvedCashFlowLines ────────────────────────────

const KNOWN: ComparativeAmount = { state: "KNOWN", value: 500_000, source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] };
const ZERO: ComparativeAmount = { state: "ZERO", value: 0, source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] };
const MISSING: ComparativeAmount = { state: "MISSING", source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] };
const NOT_APPLICABLE: ComparativeAmount = { state: "NOT_APPLICABLE", evidence: [] };

// Rule-pack examples: an equity/net-assets line and a genuine cash line,
// neither of which is in ALL_KNOWN_CASHFLOW_PRESENTATION_CODES (operating
// non-cash-adjustment/working-capital codes, or investing codes).
const ACCUMULATED_SURPLUS_RULE = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.find((r) => r.naturalAccountCode === "63293101")!; // ACCUMULATED_SURPLUS_DEFICIT
const CASH_LINE_RULE = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.find((r) => r.naturalAccountCode === "62123115")!; // CASH_AND_CASH_EQUIVALENTS

describe("[P5S1-HIGH-001] findUnresolvedCashFlowLines requires caller-declared cash-flow relevance -- never infers it", () => {
  it("[11] a runtime-bypassed missing presentationCode is surfaced as NO_PRESENTATION_CODE regardless of the relevance set", () => {
    const bad = [
      { naturalAccountCode: "X1", accountNature: "ASSET", presentationCode: undefined, debitAmount: 100, creditAmount: 0 },
    ] as unknown as ClassifiedBalance[];
    const unresolved = findUnresolvedCashFlowLines(bad, new Set());
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].reason).toBe("NO_PRESENTATION_CODE");
    expect(unresolved[0].requiresReview).toBe(true);
  });

  it("ACCUMULATED_SURPLUS_DEFICIT is NOT automatically unresolved when the caller has not declared it cash-flow relevant", () => {
    const balances: ClassifiedBalance[] = [
      {
        naturalAccountCode: ACCUMULATED_SURPLUS_RULE.naturalAccountCode,
        accountNature: ACCUMULATED_SURPLUS_RULE.accountNature,
        presentationCode: ACCUMULATED_SURPLUS_RULE.presentationCode,
        debitAmount: 0,
        creditAmount: 900,
      },
    ];
    // Relevance set declares only what the operating/investing sections
    // actually use -- ACCUMULATED_SURPLUS_DEFICIT (an equity line) is
    // deliberately absent, matching real upstream authority: it was never
    // a cash-flow item to begin with.
    const unresolved = findUnresolvedCashFlowLines(balances, new Set(["DEPRECIATION_AMORTISATION", "RECEIVABLES"]));
    expect(unresolved).toHaveLength(0);
  });

  it("a legitimate cash/cash-equivalent line is NOT automatically unresolved merely because it is outside the O/I/F sets", () => {
    const balances: ClassifiedBalance[] = [
      {
        naturalAccountCode: CASH_LINE_RULE.naturalAccountCode,
        accountNature: CASH_LINE_RULE.accountNature,
        presentationCode: CASH_LINE_RULE.presentationCode,
        debitAmount: 500,
        creditAmount: 0,
      },
    ];
    const unresolved = findUnresolvedCashFlowLines(balances, new Set(["RECEIVABLES"]));
    expect(unresolved).toHaveLength(0);
  });

  it("a caller-declared cash-flow-relevant but unclassified item IS surfaced as PRESENTATION_CODE_NOT_CLASSIFIED", () => {
    const balances: ClassifiedBalance[] = [
      {
        naturalAccountCode: ACCUMULATED_SURPLUS_RULE.naturalAccountCode,
        accountNature: ACCUMULATED_SURPLUS_RULE.accountNature,
        presentationCode: ACCUMULATED_SURPLUS_RULE.presentationCode,
        debitAmount: 0,
        creditAmount: 900,
      },
    ];
    // This time the caller's own authority DOES declare it cash-flow
    // relevant (e.g. a future financing/other-movement category this
    // module hasn't been extended to map yet) -- now it is genuinely unresolved.
    const unresolved = findUnresolvedCashFlowLines(balances, new Set(["ACCUMULATED_SURPLUS_DEFICIT"]));
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].reason).toBe("PRESENTATION_CODE_NOT_CLASSIFIED");
    expect(unresolved[0].naturalAccountCode).toBe("63293101");
  });

  it("[13] unresolved never defaults to OPERATING -- no section field exists on UnresolvedCashFlowLine at all", () => {
    const fy2026Balances = toClassifiedBalances(SYNTHETIC_LGA_FY2026_BALANCES);
    const relevantCodes = new Set(["DEPRECIATION_AMORTISATION", "IMPAIRMENT_EXPECTED_CREDIT_LOSS", "RECEIVABLES", "PREPAYMENTS", "INVENTORIES", "PAYABLES_AND_ACCRUALS", "DEPOSITS_HELD", "DEFERRED_REVENUE_INCOME", "WITHHOLDING_TAX_PAYABLE", "PROPERTY_PLANT_EQUIPMENT_ADDITIONS", "WORK_IN_PROGRESS", "INVESTMENT_PROPERTY"] as const);
    const unresolved = findUnresolvedCashFlowLines(fy2026Balances, new Set(relevantCodes));
    for (const line of unresolved) {
      expect("section" in line).toBe(false);
    }
    const investingCodes = new Set(buildInvestingActivities(fy2026Balances).lineItems.map((l) => l.naturalAccountCode));
    expect(unresolved.some((u) => investingCodes.has(u.naturalAccountCode))).toBe(false);
  });

  it("no exclusion-list hack: a genuinely resolved investing-relevant line is never surfaced (no false positives) when it is declared relevant", () => {
    const fy2026Balances = toClassifiedBalances(SYNTHETIC_LGA_FY2026_BALANCES);
    const unresolved = findUnresolvedCashFlowLines(
      fy2026Balances,
      new Set(["PROPERTY_PLANT_EQUIPMENT_ADDITIONS", "WORK_IN_PROGRESS", "INVESTMENT_PROPERTY"]),
    );
    const investingCodes = new Set(buildInvestingActivities(fy2026Balances).lineItems.map((l) => l.naturalAccountCode));
    expect(unresolved.some((u) => investingCodes.has(u.naturalAccountCode))).toBe(false);
  });

  it("[16] duplicate natural account codes are both preserved, never silently merged or dropped", () => {
    const bad = [
      { naturalAccountCode: "DUP", accountNature: "NET_ASSETS", presentationCode: "RESERVES", debitAmount: 0, creditAmount: 100 },
      { naturalAccountCode: "DUP", accountNature: "NET_ASSETS", presentationCode: "RESERVES", debitAmount: 0, creditAmount: 200 },
    ] as ClassifiedBalance[];
    const unresolved = findUnresolvedCashFlowLines(bad, new Set(["RESERVES"]));
    expect(unresolved).toHaveLength(2);
    expect(unresolved.filter((u) => u.naturalAccountCode === "DUP")).toHaveLength(2);
  });
});

// ── Phase 5 Slice 1: verifyCashPositionReconciliation (Gate C) ─────────────

const TZS_MATERIALITY: MaterialityThreshold = { currencyCode: "TZS", percentageThreshold: 0.01, absoluteThreshold: 500_000 };

describe("[1]/[2]/[3] Gate C: opening + movement = closing, visibly", () => {
  it("[1] opening + movement = actual closing -> RECONCILED", () => {
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: KNOWN, actualClosingCash: 500_000 + 250_000 };
    const result = verifyCashPositionReconciliation(cashPosition, 250_000, TZS_MATERIALITY);
    expect(result.status).toBe("RECONCILED");
    expect(result.derivedClosingCash).toBe(750_000);
    expect(result.difference).toBe(0);
  });

  it("[2] a material mismatch -> UNRECONCILED with a visible, non-zero difference (never plugged)", () => {
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: KNOWN, actualClosingCash: 999_999_999 };
    const result = verifyCashPositionReconciliation(cashPosition, 250_000, TZS_MATERIALITY);
    expect(result.status).toBe("UNRECONCILED");
    expect(result.derivedClosingCash).toBe(750_000);
    expect(result.difference).toBe(750_000 - 999_999_999);
    expect(result.actualClosingCash).toBe(999_999_999); // never overwritten by the derived figure
  });

  it("[3]/[6] missing opening cash -> CANNOT_ASSESS, never fabricated as zero", () => {
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: MISSING, actualClosingCash: 750_000 };
    const result = verifyCashPositionReconciliation(cashPosition, 250_000, TZS_MATERIALITY);
    expect(result.status).toBe("CANNOT_ASSESS");
    expect(result.derivedClosingCash).toBeNull();
    expect(result.difference).toBeNull();
    expect(result.openingCashState).toBe("MISSING");
  });

  it("[22] NOT_APPLICABLE opening cash also -> CANNOT_ASSESS", () => {
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: NOT_APPLICABLE, actualClosingCash: 750_000 };
    const result = verifyCashPositionReconciliation(cashPosition, 250_000, TZS_MATERIALITY);
    expect(result.status).toBe("CANNOT_ASSESS");
    expect(result.openingCashState).toBe("NOT_APPLICABLE");
  });
});

describe("[4]/[5] genuine zero is preserved, distinct from missing", () => {
  it("[4] a genuine ZERO opening cash still computes (0 is a real fact, not an absence)", () => {
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: ZERO, actualClosingCash: 250_000 };
    const result = verifyCashPositionReconciliation(cashPosition, 250_000, TZS_MATERIALITY);
    expect(result.status).toBe("RECONCILED");
    expect(result.derivedClosingCash).toBe(250_000);
  });

  it("[5] a genuine zero actual closing cash is preserved, not treated as missing", () => {
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: KNOWN, actualClosingCash: 0 };
    const result = verifyCashPositionReconciliation(cashPosition, -500_000, TZS_MATERIALITY);
    expect(result.actualClosingCash).toBe(0);
    expect(result.status).toBe("RECONCILED");
  });
});

describe("[7]/[8] materiality: both percentage and absolute thresholds are honored (max of the two)", () => {
  it("[7] a small-cash-balance company: the absolute floor dominates the percentage", () => {
    // 1% of 10,000 = 100; absolute floor 500,000 -- floor wins.
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: KNOWN, actualClosingCash: 10_000 };
    const result = verifyCashPositionReconciliation(cashPosition, 10_000 - 500_000 + 400_000, TZS_MATERIALITY);
    expect(result.thresholdApplied).toBe(500_000);
  });

  it("[8] a large-cash-balance company: the percentage threshold dominates the absolute floor", () => {
    // 1% of 100,000,000 = 1,000,000 > absolute floor 500,000 -- percentage wins.
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: KNOWN, actualClosingCash: 100_000_000 };
    const materiality: MaterialityThreshold = { currencyCode: "TZS", percentageThreshold: 0.01, absoluteThreshold: 500_000 };
    const result = verifyCashPositionReconciliation(cashPosition, 100_000_000 - 500_000 + 900_000, materiality);
    expect(result.thresholdApplied).toBe(1_000_000);
  });
});

describe("[9]/[10]/[25] materiality and cash position are fully caller-supplied, never hardcoded", () => {
  it("[9] a non-TZS currency works identically -- the engine is currency-neutral", () => {
    const kesMateriality: MaterialityThreshold = { currencyCode: "KES", percentageThreshold: 0.01, absoluteThreshold: 5_000 };
    const cashPosition: CashPositionFacts = { currencyCode: "KES", openingCash: KNOWN, actualClosingCash: 750_000 };
    const result = verifyCashPositionReconciliation(cashPosition, 250_000, kesMateriality);
    expect(result.status).toBe("RECONCILED");
    expect(result.currencyCode).toBe("KES");
  });

  it("mismatched currencies between cashPosition and materiality fail closed", () => {
    const usdMateriality: MaterialityThreshold = { currencyCode: "USD", percentageThreshold: 0.01, absoluteThreshold: 200 };
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: KNOWN, actualClosingCash: 750_000 };
    expect(() => verifyCashPositionReconciliation(cashPosition, 250_000, usdMateriality)).toThrow(/currency/i);
  });

  it("[10]/[25] the Gate C / materiality source contains no hardcoded currency or amount (TZS, 500000, 500_000, 0.01) in executable code", () => {
    const source: string = fs.readFileSync(path.join(__dirname, "cashFlowEngines.ts"), "utf-8");
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const gateCStart = codeOnly.indexOf("export interface CashPositionFacts");
    const gateCSection = codeOnly.slice(gateCStart);
    expect(gateCSection).not.toMatch(/"TZS"|500_?000|0\.01/);
  });
});

// ── P5S1-HIGH-002: materiality contract validation ──────────────────────────

describe("[P5S1-HIGH-002] MaterialityThreshold and currencyCode fail closed on every malformed input", () => {
  const validPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: KNOWN, actualClosingCash: 750_000 };

  it("empty cash currency rejects", () => {
    const bad: CashPositionFacts = { ...validPosition, currencyCode: "" };
    expect(() => verifyCashPositionReconciliation(bad, 250_000, TZS_MATERIALITY)).toThrow(/currencyCode/);
  });

  it("whitespace-only cash currency rejects", () => {
    const bad: CashPositionFacts = { ...validPosition, currencyCode: "   " };
    expect(() => verifyCashPositionReconciliation(bad, 250_000, TZS_MATERIALITY)).toThrow(/currencyCode/);
  });

  it("empty materiality currency rejects", () => {
    const bad: MaterialityThreshold = { ...TZS_MATERIALITY, currencyCode: "" };
    expect(() => verifyCashPositionReconciliation(validPosition, 250_000, bad)).toThrow(/currencyCode/);
  });

  it("whitespace-only materiality currency rejects", () => {
    const bad: MaterialityThreshold = { ...TZS_MATERIALITY, currencyCode: "  " };
    expect(() => verifyCashPositionReconciliation(validPosition, 250_000, bad)).toThrow(/currencyCode/);
  });

  it("negative percentage rejects", () => {
    const bad: MaterialityThreshold = { ...TZS_MATERIALITY, percentageThreshold: -0.01 };
    expect(() => verifyCashPositionReconciliation(validPosition, 250_000, bad)).toThrow(/percentageThreshold/);
  });

  it("negative absolute threshold rejects", () => {
    const bad: MaterialityThreshold = { ...TZS_MATERIALITY, absoluteThreshold: -1 };
    expect(() => verifyCashPositionReconciliation(validPosition, 250_000, bad)).toThrow(/absoluteThreshold/);
  });

  it("NaN percentage/absolute rejects", () => {
    const bad: MaterialityThreshold = { ...TZS_MATERIALITY, percentageThreshold: NaN };
    expect(() => verifyCashPositionReconciliation(validPosition, 250_000, bad)).toThrow();
  });

  it("Infinity percentage/absolute rejects", () => {
    const bad: MaterialityThreshold = { ...TZS_MATERIALITY, absoluteThreshold: Infinity };
    expect(() => verifyCashPositionReconciliation(validPosition, 250_000, bad)).toThrow();
  });

  it("currency mismatch (trimmed, case-sensitive) rejects", () => {
    const bad: MaterialityThreshold = { ...TZS_MATERIALITY, currencyCode: "tzs" };
    expect(() => verifyCashPositionReconciliation(validPosition, 250_000, bad)).toThrow(/currency mismatch/);
  });

  it("zero percentage is accepted (a valid, explicit 'no percentage tolerance' choice)", () => {
    const materiality: MaterialityThreshold = { currencyCode: "TZS", percentageThreshold: 0, absoluteThreshold: 500_000 };
    const result = verifyCashPositionReconciliation(validPosition, 0, materiality);
    expect(result.thresholdApplied).toBe(500_000);
  });

  it("zero absolute threshold is accepted (a valid, explicit 'percentage only' choice)", () => {
    const materiality: MaterialityThreshold = { currencyCode: "TZS", percentageThreshold: 0.01, absoluteThreshold: 0 };
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: KNOWN, actualClosingCash: 1_000_000 };
    const result = verifyCashPositionReconciliation(cashPosition, 500_000 - 1_000_000, materiality);
    expect(result.thresholdApplied).toBe(10_000); // 1% of 1,000,000
  });

  it("a valid threshold computes correctly end to end", () => {
    const materiality: MaterialityThreshold = { currencyCode: "TZS", percentageThreshold: 0.02, absoluteThreshold: 100_000 };
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: KNOWN, actualClosingCash: 2_000_000 };
    const result = verifyCashPositionReconciliation(cashPosition, 1_500_000, materiality);
    // max(2% of 2,000,000 = 40,000; absolute floor 100,000) -> absolute floor wins.
    expect(result.thresholdApplied).toBe(100_000);
  });

  // ── P5S1R-LOW-001 (registered debt, closed by this test): the exact
  // difference === thresholdApplied boundary must resolve RECONCILED,
  // proving the implementation's inclusive `<=` behaviorally, not merely
  // by code inspection.
  it("[P5S1R-LOW-001] difference === thresholdApplied EXACTLY -> RECONCILED (inclusive <=)", () => {
    const materiality: MaterialityThreshold = { currencyCode: "TZS", percentageThreshold: 0, absoluteThreshold: 100_000 };
    // openingCash 500,000 (KNOWN) + netCashMovement 0 = derivedClosingCash 500,000.
    // actualClosingCash 400,000 -> difference = 500,000 - 400,000 = 100,000 exactly.
    // thresholdApplied = max(0 * |400,000|, 100,000) = 100,000 exactly. difference === thresholdApplied.
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: KNOWN, actualClosingCash: 400_000 };
    const result = verifyCashPositionReconciliation(cashPosition, 0, materiality);
    expect(result.difference).toBe(100_000);
    expect(result.thresholdApplied).toBe(100_000);
    expect(result.difference).toBe(result.thresholdApplied);
    expect(result.status).toBe("RECONCILED");
  });

  it("[P5S1R-LOW-001 companion] difference one unit past thresholdApplied -> UNRECONCILED", () => {
    const materiality: MaterialityThreshold = { currencyCode: "TZS", percentageThreshold: 0, absoluteThreshold: 100_000 };
    // Same setup, but actualClosingCash is 1 further away -> difference = 100,001 > threshold 100,000.
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: KNOWN, actualClosingCash: 399_999 };
    const result = verifyCashPositionReconciliation(cashPosition, 0, materiality);
    expect(result.difference).toBe(100_001);
    expect(result.thresholdApplied).toBe(100_000);
    expect(result.status).toBe("UNRECONCILED");
  });
});

// ── P5S1-HIGH-003: ComparativeAmount runtime exhaustiveness ────────────────

describe("[P5S1-HIGH-003] Gate C validates ComparativeAmount at runtime, never trusting TypeScript alone", () => {
  const materiality = TZS_MATERIALITY;

  it("an unrecognized runtime state throws (bypassing compile-time safety intentionally)", () => {
    const bad = { state: "BOGUS", value: 100 } as unknown as ComparativeAmount;
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: bad, actualClosingCash: 750_000 };
    expect(() => verifyCashPositionReconciliation(cashPosition, 250_000, materiality)).toThrow();
  });

  it("KNOWN with a NaN value throws", () => {
    const bad = { state: "KNOWN", value: NaN, source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] } as unknown as ComparativeAmount;
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: bad, actualClosingCash: 750_000 };
    expect(() => verifyCashPositionReconciliation(cashPosition, 250_000, materiality)).toThrow();
  });

  it("KNOWN with an Infinity value throws", () => {
    const bad = { state: "KNOWN", value: Infinity, source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] } as unknown as ComparativeAmount;
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: bad, actualClosingCash: 750_000 };
    expect(() => verifyCashPositionReconciliation(cashPosition, 250_000, materiality)).toThrow();
  });

  it("a malformed ZERO (value !== 0) fails closed rather than silently substituting the real value", () => {
    const bad = { state: "ZERO", value: 5, source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] } as unknown as ComparativeAmount;
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: bad, actualClosingCash: 750_000 };
    expect(() => verifyCashPositionReconciliation(cashPosition, 250_000, materiality)).toThrow();
  });

  it("MISSING can never reach arithmetic -- derivedClosingCash/difference stay null, CANNOT_ASSESS", () => {
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: MISSING, actualClosingCash: 750_000 };
    const result = verifyCashPositionReconciliation(cashPosition, 250_000, materiality);
    expect(result.status).toBe("CANNOT_ASSESS");
    expect(result.derivedClosingCash).toBeNull();
  });

  it("NOT_APPLICABLE can never reach arithmetic -- derivedClosingCash/difference stay null, CANNOT_ASSESS", () => {
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: NOT_APPLICABLE, actualClosingCash: 750_000 };
    const result = verifyCashPositionReconciliation(cashPosition, 250_000, materiality);
    expect(result.status).toBe("CANNOT_ASSESS");
    expect(result.derivedClosingCash).toBeNull();
  });

  it("a genuinely well-formed ZERO remains exactly 0 through the arithmetic", () => {
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: ZERO, actualClosingCash: 250_000 };
    const result = verifyCashPositionReconciliation(cashPosition, 250_000, materiality);
    expect(result.derivedClosingCash).toBe(250_000);
    expect(result.status).toBe("RECONCILED");
  });
});

describe("[14]/[15] Gate C fails closed on malformed numeric input", () => {
  const validPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: KNOWN, actualClosingCash: 750_000 };

  it("[14] NaN netCashMovement throws", () => {
    expect(() => verifyCashPositionReconciliation(validPosition, NaN, TZS_MATERIALITY)).toThrow();
  });

  it("[15] Infinity actualClosingCash throws", () => {
    const bad: CashPositionFacts = { ...validPosition, actualClosingCash: Infinity };
    expect(() => verifyCashPositionReconciliation(bad, 250_000, TZS_MATERIALITY)).toThrow();
  });

  it("non-finite materiality thresholds throw", () => {
    const bad: MaterialityThreshold = { currencyCode: "TZS", percentageThreshold: NaN, absoluteThreshold: 500_000 };
    expect(() => verifyCashPositionReconciliation(validPosition, 250_000, bad)).toThrow();
  });
});

describe("[17]/[18] determinism and purity", () => {
  it("[17] the same inputs produce a deep-equal result across repeated calls", () => {
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: KNOWN, actualClosingCash: 750_000 };
    const first = verifyCashPositionReconciliation(cashPosition, 250_000, TZS_MATERIALITY);
    const second = verifyCashPositionReconciliation(cashPosition, 250_000, TZS_MATERIALITY);
    expect(first).toEqual(second);
  });

  it("[18] no Date/random/Supabase/DB/network dependency anywhere in the module", () => {
    const source: string = fs.readFileSync(path.join(__dirname, "cashFlowEngines.ts"), "utf-8");
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/Date\.now\(\)|new Date\(|randomUUID|supabase|fetch\(|localStorage|sessionStorage/i);
  });
});

describe("[23]/[24] Gate C and crossCheckOperatingCashFlow are honestly scoped -- neither claims dual-engine independence", () => {
  it("[23] CashPositionReconciliationResult carries no field claiming an independently-derived operating-CF number", () => {
    const cashPosition: CashPositionFacts = { currencyCode: "TZS", openingCash: KNOWN, actualClosingCash: 750_000 };
    const result = verifyCashPositionReconciliation(cashPosition, 250_000, TZS_MATERIALITY);
    expect("primaryOperatingCashFlow" in result).toBe(false);
    expect("reconciliationOperatingCashFlow" in result).toBe(false);
    expect("engineAOperatingCashFlow" in result).toBe(false);
    expect("engineBOperatingCashFlow" in result).toBe(false);
  });

  it("[24] crossCheckOperatingCashFlow's own doc comment explicitly documents its independence limitation", () => {
    const source: string = fs.readFileSync(path.join(__dirname, "cashFlowEngines.ts"), "utf-8");
    const fnIndex = source.indexOf("export function crossCheckOperatingCashFlow");
    const precedingComment = source.slice(Math.max(0, fnIndex - 1800), fnIndex);
    expect(precedingComment).toMatch(/LIMITATION/);
    expect(precedingComment.toLowerCase()).toMatch(/not.*(genuine|independen)/);
  });
});
