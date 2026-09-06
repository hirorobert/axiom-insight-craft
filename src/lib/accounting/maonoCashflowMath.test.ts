/**
 * PPG-1 Finding 4 / PPG-1R HIGH-2 — MAONO cash-forecast semantic
 * contamination repair.
 *
 * Tests the ACTUAL edge-function shared module directly (no Deno-only
 * imports — plain TS, same technique already used by edgeMoney.test.ts /
 * edgeFlutterwaveGateB.test.ts for other supabase/functions/_shared files).
 *
 * PPG-1 fixed only the one confirmed defect fixable with existing data
 * (the PAYE/VAT/SDL/WHT double-count) and otherwise disclosed the
 * remaining class-level approximation in prose. Codex correctly rejected
 * that: a disclosure string does not make "every non-cash current_assets
 * balance is AR" or "every current_liabilities balance is AP" safe
 * arithmetic. These tests now prove the FAIL-CLOSED contract: no row is
 * ever classified as anything but UNKNOWN (besides CASH) given today's
 * repository-evidence-confirmed absence of any finer classification
 * authority, and no unclassified balance is ever swept into a forecast
 * figure — only a genuinely empty set of such rows resolves to a KNOWN
 * (not approximated) zero.
 */

import { describe, it, expect } from "vitest";
import {
  bucketCurrentBalances,
  classifyCashBehavior,
  assessArAp,
  excludeScheduledTaxFromCurrentLiabilities,
  RECEIVABLE_CLASSIFICATION_LIMITATION,
  PAYABLE_CLASSIFICATION_LIMITATION,
  type ClassifiableRow,
  type CashState,
  type BucketResult,
} from "../../../supabase/functions/_shared/maonoCashflowMath";

function row(overrides: Partial<ClassifiableRow>): ClassifiableRow {
  return {
    accountCode: "1000",
    accountName: "Test Account",
    subNature: "current_assets",
    debitBalance: 0,
    creditBalance: 0,
    ...overrides,
  };
}

function emptyBucket(overrides: Partial<BucketResult> = {}): BucketResult {
  return {
    cashBalance: 0,
    tradeReceivableBalance: 0,
    unknownCurrentAssetCount: 0,
    unknownCurrentAssetBalance: 0,
    tradePayableBalance: 0,
    unknownCurrentLiabilityCount: 0,
    unknownCurrentLiabilityBalance: 0,
    undecidedCashAccounts: [],
    ...overrides,
  };
}

describe("classifyCashBehavior — fails closed given today's evidence (repository-confirmed)", () => {
  it("classifies a current_assets row the professional marked CASH as CASH", () => {
    expect(classifyCashBehavior(row({ subNature: "current_assets" }), "CASH")).toBe("CASH");
  });

  it("classifies a non-cash current_assets row as UNKNOWN — no evidence distinguishes trade receivable from inventory/prepayment/tax receivable", () => {
    expect(classifyCashBehavior(row({ subNature: "current_assets" }), "NOT_CASH")).toBe("UNKNOWN");
  });

  it("classifies a current_assets row with UNDECIDED cash state as UNKNOWN, never CASH or a receivable", () => {
    expect(classifyCashBehavior(row({ subNature: "current_assets" }), "UNKNOWN")).toBe("UNKNOWN");
  });

  it("classifies every current_liabilities row as UNKNOWN — no evidence distinguishes trade payable from statutory/non-trade liability", () => {
    expect(classifyCashBehavior(row({ subNature: "current_liabilities" }), "NOT_CASH")).toBe("UNKNOWN");
  });

  it("never returns TRADE_RECEIVABLE, TRADE_PAYABLE, STATUTORY_RECEIVABLE, STATUTORY_PAYABLE, NON_CASH_CURRENT_ASSET, or NON_TRADE_CURRENT_LIABILITY for ANY input today", () => {
    const forbidden = new Set([
      "TRADE_RECEIVABLE", "TRADE_PAYABLE", "STATUTORY_RECEIVABLE",
      "STATUTORY_PAYABLE", "NON_CASH_CURRENT_ASSET", "NON_TRADE_CURRENT_LIABILITY",
    ]);
    const subNatures = ["current_assets", "current_liabilities", "non_current_assets", "equity"];
    const cashStates: CashState[] = ["CASH", "NOT_CASH", "UNKNOWN"];
    for (const subNature of subNatures) {
      for (const cashState of cashStates) {
        const result = classifyCashBehavior(row({ subNature }), cashState);
        expect(forbidden.has(result)).toBe(false);
      }
    }
  });
});

describe("bucketCurrentBalances — cash exclusion (Iron Dome: sign is evidence only)", () => {
  it("routes a current-asset row the professional marked CASH into cashBalance, not any unclassified/receivable bucket", () => {
    const result = bucketCurrentBalances(
      [row({ accountCode: "1010", subNature: "current_assets", debitBalance: 500_000, creditBalance: 0 })],
      () => "CASH" as CashState,
      (r) => r.accountCode ?? r.accountName,
    );
    expect(result.cashBalance).toBe(500_000);
    expect(result.tradeReceivableBalance).toBe(0);
    expect(result.unknownCurrentAssetCount).toBe(0);
  });

  it("routes a current-asset row marked NOT_CASH into the UNKNOWN bucket, never a trade-receivable bucket (HIGH-2)", () => {
    const result = bucketCurrentBalances(
      [row({ accountCode: "1100", subNature: "current_assets", debitBalance: 300_000, creditBalance: 0 })],
      () => "NOT_CASH" as CashState,
      (r) => r.accountCode ?? r.accountName,
    );
    expect(result.cashBalance).toBe(0);
    expect(result.tradeReceivableBalance).toBe(0);
    expect(result.unknownCurrentAssetCount).toBe(1);
    expect(result.unknownCurrentAssetBalance).toBe(300_000);
  });

  it("surfaces an UNKNOWN cash decision as an undecided account (stronger than classified-UNKNOWN — fails the whole forecast closed), never guessing CASH or NOT_CASH", () => {
    const result = bucketCurrentBalances(
      [row({ accountCode: "1200", subNature: "current_assets", debitBalance: 100_000, creditBalance: 0 })],
      () => "UNKNOWN" as CashState,
      (r) => r.accountCode ?? r.accountName,
    );
    expect(result.undecidedCashAccounts).toEqual(["1200"]);
    expect(result.cashBalance).toBe(0);
    expect(result.tradeReceivableBalance).toBe(0);
    // Undecided accounts are reported separately, not double-counted as
    // classified-unknown too.
    expect(result.unknownCurrentAssetCount).toBe(0);
  });
});

describe("bucketCurrentBalances — current-liability bucketing (HIGH-2: never trade-payable by default)", () => {
  it("sums current_liabilities rows into the UNKNOWN bucket, never tradePayableBalance", () => {
    const result = bucketCurrentBalances(
      [
        row({ subNature: "current_liabilities", debitBalance: 0, creditBalance: 200_000 }),
        row({ subNature: "current_liabilities", debitBalance: 0, creditBalance: 50_000 }),
      ],
      () => "CASH" as CashState,
      (r) => r.accountCode ?? r.accountName,
    );
    expect(result.tradePayableBalance).toBe(0);
    expect(result.unknownCurrentLiabilityCount).toBe(2);
    expect(result.unknownCurrentLiabilityBalance).toBe(250_000);
  });
});

describe("bucketCurrentBalances — non-current and non-balance-sheet rows excluded", () => {
  it("excludes non_current_assets from every bucket", () => {
    const result = bucketCurrentBalances(
      [row({ subNature: "non_current_assets", debitBalance: 1_000_000, creditBalance: 0 })],
      () => "NOT_CASH" as CashState,
      (r) => r.accountCode ?? r.accountName,
    );
    expect(result.tradeReceivableBalance).toBe(0);
    expect(result.unknownCurrentAssetCount).toBe(0);
    expect(result.cashBalance).toBe(0);
  });

  it("excludes non_current_liabilities from every liability bucket", () => {
    const result = bucketCurrentBalances(
      [row({ subNature: "non_current_liabilities", debitBalance: 0, creditBalance: 1_000_000 })],
      () => "NOT_CASH" as CashState,
      (r) => r.accountCode ?? r.accountName,
    );
    expect(result.tradePayableBalance).toBe(0);
    expect(result.unknownCurrentLiabilityCount).toBe(0);
  });

  it("excludes equity/revenue/expense/cash-flow-statement classifications entirely", () => {
    for (const subNature of [
      "equity", "revenue", "cost_of_goods_sold", "operating_expenses",
      "other_income", "taxes", "operating_activities", "investing_activities", "financing_activities",
    ]) {
      const result = bucketCurrentBalances(
        [row({ subNature, debitBalance: 999_999, creditBalance: 0 })],
        () => "NOT_CASH" as CashState,
        (r) => r.accountCode ?? r.accountName,
      );
      expect(result.tradeReceivableBalance).toBe(0);
      expect(result.tradePayableBalance).toBe(0);
      expect(result.unknownCurrentAssetCount).toBe(0);
      expect(result.unknownCurrentLiabilityCount).toBe(0);
      expect(result.cashBalance).toBe(0);
    }
  });
});

describe("assessArAp — the fail-closed decision point (PPG-1R HIGH-2 core contract)", () => {
  it("inventory ambiguity -> CANNOT_ASSESS: a single unclassifiable current_assets row makes AR CANNOT_ASSESS", () => {
    const bucketed = emptyBucket({ unknownCurrentAssetCount: 1, unknownCurrentAssetBalance: 400_000 });
    const result = assessArAp(bucketed);
    expect(result.arState).toBe("CANNOT_ASSESS");
    expect(result.arKnownAmount).toBe(0);
  });

  it("prepayment ambiguity -> CANNOT_ASSESS: same mechanism — no distinguishing evidence exists, so any non-cash current asset makes AR CANNOT_ASSESS", () => {
    // This system has no way to tell a prepayment apart from any other
    // non-cash current asset — it is exactly the same unknownCurrentAssetCount
    // path as every other undistinguishable category.
    const bucketed = emptyBucket({ unknownCurrentAssetCount: 1, unknownCurrentAssetBalance: 120_000 });
    expect(assessArAp(bucketed).arState).toBe("CANNOT_ASSESS");
  });

  it("tax-receivable ambiguity -> CANNOT_ASSESS: identical mechanism on the asset side", () => {
    const bucketed = emptyBucket({ unknownCurrentAssetCount: 1, unknownCurrentAssetBalance: 50_000 });
    expect(assessArAp(bucketed).arState).toBe("CANNOT_ASSESS");
  });

  it("unknown current asset -> CANNOT_ASSESS (explicit, direct)", () => {
    const bucketed = emptyBucket({ unknownCurrentAssetCount: 3 });
    expect(assessArAp(bucketed).arState).toBe("CANNOT_ASSESS");
  });

  it("unknown current liability -> CANNOT_ASSESS (explicit, direct)", () => {
    const bucketed = emptyBucket({ unknownCurrentLiabilityCount: 2 });
    expect(assessArAp(bucketed).apState).toBe("CANNOT_ASSESS");
  });

  it("broad current_assets NEVER becomes trade AR without authority — CANNOT_ASSESS regardless of magnitude", () => {
    const bucketed = emptyBucket({ unknownCurrentAssetCount: 1, unknownCurrentAssetBalance: 999_999_999 });
    const result = assessArAp(bucketed);
    expect(result.arState).toBe("CANNOT_ASSESS");
    expect(result.arKnownAmount).toBe(0); // never leaks the unclassified magnitude as if it were AR
  });

  it("broad current_liabilities NEVER becomes trade AP without authority — CANNOT_ASSESS regardless of magnitude", () => {
    const bucketed = emptyBucket({ unknownCurrentLiabilityCount: 1, unknownCurrentLiabilityBalance: 999_999_999 });
    const result = assessArAp(bucketed);
    expect(result.apState).toBe("CANNOT_ASSESS");
    expect(result.apKnownAmount).toBe(0);
  });

  it("a company with literally zero non-cash current assets and zero current liabilities gets a genuine KNOWN zero, not CANNOT_ASSESS — an empty set is a fact, not a gap", () => {
    const bucketed = emptyBucket();
    const result = assessArAp(bucketed);
    expect(result.arState).toBe("KNOWN");
    expect(result.arKnownAmount).toBe(0);
    expect(result.apState).toBe("KNOWN");
    expect(result.apKnownAmount).toBe(0);
  });

  it("known-zero remains distinguishable from unknown: KNOWN 0 and CANNOT_ASSESS 0 are different states, never conflated", () => {
    const known = assessArAp(emptyBucket());
    const unknown = assessArAp(emptyBucket({ unknownCurrentAssetCount: 1 }));
    expect(known.arState).not.toBe(unknown.arState);
    expect(known.arKnownAmount).toBe(unknown.arKnownAmount); // both numerically 0
    expect(known.arState).toBe("KNOWN");
    expect(unknown.arState).toBe("CANNOT_ASSESS");
  });

  it("AR and AP are assessed independently — one side can be CANNOT_ASSESS while the other is KNOWN", () => {
    const bucketed = emptyBucket({ unknownCurrentAssetCount: 1 }); // only AR ambiguous
    const result = assessArAp(bucketed);
    expect(result.arState).toBe("CANNOT_ASSESS");
    expect(result.apState).toBe("KNOWN");
  });
});

describe("excludeScheduledTaxFromCurrentLiabilities — PPG-1R §5: tax double-count protection remains fixed", () => {
  it("excludes the full scheduled tax total from a generic AP bucket", () => {
    const { apBalanceExTax, scheduledTaxTotal } = excludeScheduledTaxFromCurrentLiabilities(
      1_000_000,
      { paye: 100_000, sdl: 50_000, vat: 200_000, wht: 30_000 },
    );
    expect(scheduledTaxTotal).toBe(380_000);
    expect(apBalanceExTax).toBe(620_000);
  });

  it("treats null (unavailable) tax amounts as excluded-zero, never as a $0 liability claim", () => {
    const { apBalanceExTax, scheduledTaxTotal } = excludeScheduledTaxFromCurrentLiabilities(
      500_000,
      { paye: null, sdl: null, vat: 100_000, wht: null },
    );
    expect(scheduledTaxTotal).toBe(100_000);
    expect(apBalanceExTax).toBe(400_000);
  });

  it("floors at zero — the exclusion can never make the generic liability balance negative", () => {
    const { apBalanceExTax, scheduledTaxTotal } = excludeScheduledTaxFromCurrentLiabilities(
      100_000,
      { paye: 200_000, sdl: 0, vat: 0, wht: 0 },
    );
    expect(scheduledTaxTotal).toBe(200_000);
    expect(apBalanceExTax).toBe(0);
  });

  it("with all tax amounts unavailable, the generic liability balance passes through unchanged", () => {
    const { apBalanceExTax, scheduledTaxTotal } = excludeScheduledTaxFromCurrentLiabilities(
      777_000,
      { paye: null, sdl: null, vat: null, wht: null },
    );
    expect(scheduledTaxTotal).toBe(0);
    expect(apBalanceExTax).toBe(777_000);
  });

  it("proves the double-count is actually gone: a liability balance that IS exactly the tax total nets to zero generic AP, leaving the tax fully represented once via its own statutory schedule", () => {
    const vatControlAccountBalance = 450_000;
    const { apBalanceExTax, scheduledTaxTotal } = excludeScheduledTaxFromCurrentLiabilities(
      vatControlAccountBalance,
      { paye: null, sdl: null, vat: 450_000, wht: null },
    );
    expect(apBalanceExTax).toBe(0);
    expect(scheduledTaxTotal).toBe(450_000);
  });

  it("remains correct on the KNOWN (zero) path exercised in maono-cashflow/index.ts today — applying it to a known-zero AP balance is a safe no-op", () => {
    const { apBalanceExTax, scheduledTaxTotal } = excludeScheduledTaxFromCurrentLiabilities(
      0, // arAp.apKnownAmount when apState === "KNOWN" is always 0 today
      { paye: 50_000, sdl: null, vat: null, wht: null },
    );
    expect(apBalanceExTax).toBe(0);
    expect(scheduledTaxTotal).toBe(50_000);
  });
});

describe("classification limitation disclosures — honest, never fabricated precision", () => {
  it("the receivable limitation names the actual undistinguishable categories and disclaims verified precision", () => {
    expect(RECEIVABLE_CLASSIFICATION_LIMITATION).toMatch(/inventory/i);
    expect(RECEIVABLE_CLASSIFICATION_LIMITATION).toMatch(/prepayment/i);
    expect(RECEIVABLE_CLASSIFICATION_LIMITATION).toMatch(/tax receivable/i);
    expect(RECEIVABLE_CLASSIFICATION_LIMITATION).toMatch(/CANNOT_ASSESS/);
  });

  it("the payable limitation names the statutory exclusion mechanism and its own residual limit", () => {
    expect(PAYABLE_CLASSIFICATION_LIMITATION).toMatch(/PAYE\/VAT\/SDL\/WHT/);
    expect(PAYABLE_CLASSIFICATION_LIMITATION).toMatch(/trade payable/i);
    expect(PAYABLE_CLASSIFICATION_LIMITATION).toMatch(/CANNOT_ASSESS/);
  });
});
