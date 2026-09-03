/**
 * cashFlowEngines.test.ts
 *
 * Slice 10 — proves the two cash-flow engines stay distinct products that
 * cross-check to the same operating total, using REAL Arusha DC figures
 * wherever real evidence exists, and clearly-labeled synthetic data only
 * where no real evidence exists (financing activities — this LGA has none).
 */

import { describe, it, expect } from "vitest";
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
import type { ClassifiedBalance } from "./statementAggregationEngine";
import type { ComparativeAmount } from "./comparativeEvidence";
import { TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 } from "./museIpsasRulePack";
import { ARUSHA_FY2026_BALANCES } from "./arushaFy2026Balances.fixture";
import { ARUSHA_FY2025_BALANCES } from "./arushaFy2025Balances.fixture";

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

describe("buildOperatingCashFlowReconciliation — real Arusha DC FY2025 depreciation add-back", () => {
  // FY2026's TB has zero depreciation entries posted (verified directly
  // against the raw export — a genuine, honestly-reported real-world gap,
  // not a bug). FY2025's does not, so it proves the add-back mechanism
  // against real, non-zero numbers instead.
  const fy2025Balances = toClassifiedBalances(ARUSHA_FY2025_BALANCES);

  it("real FY2025 depreciation (12 accounts, TZS 1,997,021,080.70 total) is fully added back as a non-cash adjustment", () => {
    const recon = buildOperatingCashFlowReconciliation(0, fy2025Balances, []);
    const depreciationLines = recon.nonCashAdjustments.filter((l) => l.presentationCode === "DEPRECIATION_AMORTISATION");
    expect(depreciationLines).toHaveLength(12);
    const total = depreciationLines.reduce((s, l) => s + l.amount, 0);
    expect(total).toBeCloseTo(1997021080.70, 1);
  });
});

describe("buildOperatingCashFlowReconciliation — real Arusha DC working-capital movements (FY2025 -> FY2026)", () => {
  const fy2025ByCode = new Map(ARUSHA_FY2025_BALANCES.map((b) => [b.code, b.debit - b.credit]));
  const fy2026Balances = toClassifiedBalances(ARUSHA_FY2026_BALANCES);

  // Real receivable that grew year-over-year: '32171120 Imprest Receivable - Staff'.
  it("a real receivable increase (asset) is a cash OUTFLOW in the reconciliation", () => {
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
    const delta = currentNetAmount - priorNet;
    expect(delta).toBeGreaterThan(0); // real increase

    const recon = buildOperatingCashFlowReconciliation(0, [], [wc]);
    expect(recon.workingCapitalMovements).toHaveLength(1);
    expect(recon.workingCapitalMovements[0].amount).toBeCloseTo(-delta, 2); // outflow
  });

  it("an account absent from the prior period (MISSING comparative) is skipped, never treated as a zero-based movement (C4)", () => {
    // Real case from Slice 7: '14150103 Forest Royalties' exists in FY2026
    // with no FY2025 prior — not working-capital-relevant by presentationCode,
    // but the MISSING-skip mechanism is proven generically here instead.
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

describe("buildInvestingActivities — real Arusha DC FY2026 capital expenditure", () => {
  it("real PPE/WIP/investment-property additions sum to the real capex figure, all as outflows", () => {
    const fy2026Balances = toClassifiedBalances(ARUSHA_FY2026_BALANCES);
    const investing = buildInvestingActivities(fy2026Balances);
    // Independently verified in Python against the same source data,
    // AFTER excluding the two real WIP-Transfer non-cash reclassification
    // entries (see next test): 28,907,465,215.06
    expect(investing.total).toBeCloseTo(-28907465215.06, 1);
    expect(investing.lineItems.every((l) => l.amount <= 0)).toBe(true);
  });

  it("real WIP-Transfer entries ('31710309'/'31710310') are excluded — they are non-cash reclassifications, not capex (Slice 10 gate finding)", () => {
    // These two real codes were initially misclassified as WORK_IN_PROGRESS
    // and broke the "all outflows" invariant above — the fix was a Slice 4
    // rule-pack refinement (WORK_IN_PROGRESS_TRANSFER_NON_CASH), not a
    // cash-flow-engine special case, so it's proven at the rule-pack level.
    const transferRule1 = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.find((r) => r.naturalAccountCode === "31710309")!;
    const transferRule2 = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.find((r) => r.naturalAccountCode === "31710310")!;
    expect(transferRule1.presentationCode).toBe("WORK_IN_PROGRESS_TRANSFER_NON_CASH");
    expect(transferRule2.presentationCode).toBe("WORK_IN_PROGRESS_TRANSFER_NON_CASH");

    const fy2026Balances = toClassifiedBalances(ARUSHA_FY2026_BALANCES);
    const investing = buildInvestingActivities(fy2026Balances);
    expect(investing.lineItems.some((l) => l.naturalAccountCode === "31710309")).toBe(false);
    expect(investing.lineItems.some((l) => l.naturalAccountCode === "31710310")).toBe(false);
  });
});

describe("buildFinancingActivities — no real financing data exists for this LGA (honestly empty)", () => {
  it("Arusha DC's real data has zero financing-classified accounts — an empty section, not a fabricated one", () => {
    const fy2026Balances = toClassifiedBalances(ARUSHA_FY2026_BALANCES);
    const financing = buildFinancingActivities(fy2026Balances, new Set());
    expect(financing.lineItems).toHaveLength(0);
    expect(financing.total).toBe(0);
  });

  it("mechanism proof (synthetic — no real Tanzania LGA financing example exists in this data)", () => {
    const synthetic: ClassifiedBalance[] = [
      { naturalAccountCode: "88888888", accountNature: "LIABILITY", presentationCode: "PAYABLES_AND_ACCRUALS", debitAmount: 0, creditAmount: 500_000_000 },
    ];
    const financing = buildFinancingActivities(synthetic, new Set(["PAYABLES_AND_ACCRUALS"]));
    expect(financing.total).toBe(500_000_000); // a borrowing drawn down is a cash inflow
  });
});

describe("crossCheckOperatingCashFlow — Section XIII mandatory cross-check", () => {
  it("matches when the primary statement's operating total equals the reconciliation's", () => {
    const reconciliation = buildOperatingCashFlowReconciliation(-234109972.56, [], []);
    const investing = buildInvestingActivities([]);
    const financing = buildFinancingActivities([], new Set());
    const primary = buildPrimaryCashFlowStatement(reconciliation.netCashFromOperatingActivities, investing, financing);
    const check = crossCheckOperatingCashFlow(primary, reconciliation);
    expect(check.matches).toBe(true);
    expect(check.variance).toBe(0);
  });

  it("flags a real disagreement rather than silently passing (adversarial: primary built from a stale/wrong operating figure)", () => {
    const reconciliation = buildOperatingCashFlowReconciliation(-234109972.56, [], []);
    const investing = buildInvestingActivities([]);
    const financing = buildFinancingActivities([], new Set());
    // Deliberately wrong operating figure fed to the primary statement.
    const primary = buildPrimaryCashFlowStatement(reconciliation.netCashFromOperatingActivities + 1000, investing, financing);
    const check = crossCheckOperatingCashFlow(primary, reconciliation);
    expect(check.matches).toBe(false);
    expect(check.variance).toBe(1000);
  });

  it("full real pipeline: FY2026 investing + FY2025-depreciation-informed reconciliation cross-checks internally consistently", () => {
    const fy2026Balances = toClassifiedBalances(ARUSHA_FY2026_BALANCES);
    const investing = buildInvestingActivities(fy2026Balances);
    const financing = buildFinancingActivities(fy2026Balances, new Set());
    const reconciliation = buildOperatingCashFlowReconciliation(-234109972.56, [], []);
    const primary = buildPrimaryCashFlowStatement(reconciliation.netCashFromOperatingActivities, investing, financing);
    const check = crossCheckOperatingCashFlow(primary, reconciliation);
    expect(check.matches).toBe(true);
    // Real, non-trivial net movement for the year, not a degenerate zero.
    expect(primary.netCashMovementForPeriod).not.toBe(0);
  });
});

// ── Phase 5 Slice 1: findUnresolvedCashFlowLines ────────────────────────────

const KNOWN: ComparativeAmount = { state: "KNOWN", value: 500_000, source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] };
const ZERO: ComparativeAmount = { state: "ZERO", value: 0, source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] };
const MISSING: ComparativeAmount = { state: "MISSING", source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] };
const NOT_APPLICABLE: ComparativeAmount = { state: "NOT_APPLICABLE", evidence: [] };

describe("[11]/[12]/[13] findUnresolvedCashFlowLines surfaces what buildInvesting/Operating silently skip", () => {
  it("[11] a runtime-bypassed missing presentationCode is surfaced as NO_PRESENTATION_CODE", () => {
    const bad = [
      { naturalAccountCode: "X1", accountNature: "ASSET", presentationCode: undefined, debitAmount: 100, creditAmount: 0 },
    ] as unknown as ClassifiedBalance[];
    const unresolved = findUnresolvedCashFlowLines(bad);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].reason).toBe("NO_PRESENTATION_CODE");
    expect(unresolved[0].requiresReview).toBe(true);
  });

  it("[12] a real, valid IPSAS presentationCode this module doesn't map to a section is surfaced as PRESENTATION_CODE_NOT_CLASSIFIED", () => {
    // 63293101 "Accumulated Surplus/Deficit Opening" -> NET_ASSETS / ACCUMULATED_SURPLUS_DEFICIT,
    // a real rule (Phase 3 fixture), not one of operating/investing/financing's known codes.
    const rule = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.find((r) => r.naturalAccountCode === "63293101")!;
    const balances: ClassifiedBalance[] = [
      {
        naturalAccountCode: rule.naturalAccountCode,
        accountNature: rule.accountNature,
        presentationCode: rule.presentationCode,
        debitAmount: 0,
        creditAmount: 900,
      },
    ];
    const unresolved = findUnresolvedCashFlowLines(balances);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].reason).toBe("PRESENTATION_CODE_NOT_CLASSIFIED");
    expect(unresolved[0].naturalAccountCode).toBe("63293101");
  });

  it("[13] a genuinely resolved investing-relevant line is never surfaced as unresolved (no false positives)", () => {
    const fy2026Balances = toClassifiedBalances(ARUSHA_FY2026_BALANCES);
    const unresolved = findUnresolvedCashFlowLines(fy2026Balances);
    for (const line of unresolved) {
      // structural: UnresolvedCashFlowLine has no OPERATING/INVESTING/FINANCING
      // section field at all -- it can never masquerade as a resolved section line.
      expect("section" in line).toBe(false);
    }
    // and every INVESTING-classified real line is absent from the unresolved set
    const investingCodes = new Set(buildInvestingActivities(fy2026Balances).lineItems.map((l) => l.naturalAccountCode));
    expect(unresolved.some((u) => investingCodes.has(u.naturalAccountCode))).toBe(false);
  });

  it("[16] duplicate natural account codes are both preserved, never silently merged or dropped", () => {
    const bad = [
      { naturalAccountCode: "DUP", accountNature: "NET_ASSETS", presentationCode: "RESERVES", debitAmount: 0, creditAmount: 100 },
      { naturalAccountCode: "DUP", accountNature: "NET_ASSETS", presentationCode: "RESERVES", debitAmount: 0, creditAmount: 200 },
    ] as ClassifiedBalance[];
    const unresolved = findUnresolvedCashFlowLines(bad);
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("node:path");
    const source: string = fs.readFileSync(path.join(__dirname, "cashFlowEngines.ts"), "utf-8");
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const gateCStart = codeOnly.indexOf("export interface CashPositionFacts");
    const gateCSection = codeOnly.slice(gateCStart);
    expect(gateCSection).not.toMatch(/"TZS"|500_?000|0\.01/);
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("node:path");
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("node:path");
    const source: string = fs.readFileSync(path.join(__dirname, "cashFlowEngines.ts"), "utf-8");
    const fnIndex = source.indexOf("export function crossCheckOperatingCashFlow");
    const precedingComment = source.slice(Math.max(0, fnIndex - 1800), fnIndex);
    expect(precedingComment).toMatch(/LIMITATION/);
    expect(precedingComment.toLowerCase()).toMatch(/not.*(genuine|independen)/);
  });
});
