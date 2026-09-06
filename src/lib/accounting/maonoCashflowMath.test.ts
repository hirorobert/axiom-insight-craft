/**
 * PPG-1 Finding 4 — MAONO cash-forecast semantic contamination repair.
 *
 * Tests the ACTUAL edge-function shared module directly (no Deno-only
 * imports — plain TS, same technique already used by edgeMoney.test.ts /
 * edgeFlutterwaveGateB.test.ts for other supabase/functions/_shared files).
 *
 * Repository-evidence finding (not assumed): the live account_classification
 * enum has exactly two current-balance buckets (current_assets,
 * current_liabilities) with no further split, and account_mappings has no
 * tri-state flag distinguishing inventory/prepayment/tax-receivable/
 * tax-payable from trade receivables/payables. So "inventory excluded from
 * AR" and "prepayment excluded" cannot be tested as data-level exclusions —
 * there is no authoritative signal in this system today that would let the
 * code tell an inventory account apart from a trade-receivable account
 * (both are certified as plain "current_assets"). What CAN be, and is,
 * verified: (1) the one CONFIRMED, fully fixable defect — PAYE/VAT/SDL/WHT
 * amounts being counted through the generic AP bucket AND their own
 * statutory schedule — is now excluded exactly once; (2) cash is excluded
 * from the non-cash bucket; (3) non-current/equity/P&L balances never enter
 * either bucket; (4) an undecided cash account is surfaced, never guessed;
 * (5) the classification-limitation disclosures exist and are honest, never
 * silently claiming a "trade receivable"/"trade payable" precision this
 * system cannot prove.
 */

import { describe, it, expect } from "vitest";
import {
  bucketCurrentBalances,
  excludeScheduledTaxFromCurrentLiabilities,
  RECEIVABLE_CLASSIFICATION_LIMITATION,
  PAYABLE_CLASSIFICATION_LIMITATION,
  type ClassifiableRow,
  type CashState,
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

describe("bucketCurrentBalances — cash exclusion (Iron Dome: sign is evidence only)", () => {
  it("routes a current-asset row the professional marked CASH into cashBalance, not the non-cash bucket", () => {
    const result = bucketCurrentBalances(
      [row({ accountCode: "1010", subNature: "current_assets", debitBalance: 500_000, creditBalance: 0 })],
      () => "CASH" as CashState,
      (r) => r.accountCode ?? r.accountName,
    );
    expect(result.cashBalance).toBe(500_000);
    expect(result.nonCashCurrentAssetBalance).toBe(0);
  });

  it("routes a current-asset row marked NOT_CASH into the non-cash bucket", () => {
    const result = bucketCurrentBalances(
      [row({ accountCode: "1100", subNature: "current_assets", debitBalance: 300_000, creditBalance: 0 })],
      () => "NOT_CASH" as CashState,
      (r) => r.accountCode ?? r.accountName,
    );
    expect(result.cashBalance).toBe(0);
    expect(result.nonCashCurrentAssetBalance).toBe(300_000);
  });

  it("surfaces an UNKNOWN cash decision as an undecided account, never guessing CASH or NOT_CASH", () => {
    const result = bucketCurrentBalances(
      [row({ accountCode: "1200", subNature: "current_assets", debitBalance: 100_000, creditBalance: 0 })],
      () => "UNKNOWN" as CashState,
      (r) => r.accountCode ?? r.accountName,
    );
    expect(result.undecidedCashAccounts).toEqual(["1200"]);
    expect(result.cashBalance).toBe(0);
    expect(result.nonCashCurrentAssetBalance).toBe(0);
  });
});

describe("bucketCurrentBalances — current-liability bucketing", () => {
  it("sums current_liabilities rows by their net credit balance", () => {
    const result = bucketCurrentBalances(
      [
        row({ subNature: "current_liabilities", debitBalance: 0, creditBalance: 200_000 }),
        row({ subNature: "current_liabilities", debitBalance: 0, creditBalance: 50_000 }),
      ],
      () => "CASH" as CashState,
      (r) => r.accountCode ?? r.accountName,
    );
    expect(result.currentLiabilityBalanceGross).toBe(250_000);
  });
});

describe("bucketCurrentBalances — non-current and non-balance-sheet rows excluded", () => {
  it("excludes non_current_assets from every bucket", () => {
    const result = bucketCurrentBalances(
      [row({ subNature: "non_current_assets", debitBalance: 1_000_000, creditBalance: 0 })],
      () => "NOT_CASH" as CashState,
      (r) => r.accountCode ?? r.accountName,
    );
    expect(result.nonCashCurrentAssetBalance).toBe(0);
    expect(result.cashBalance).toBe(0);
  });

  it("excludes non_current_liabilities from currentLiabilityBalanceGross", () => {
    const result = bucketCurrentBalances(
      [row({ subNature: "non_current_liabilities", debitBalance: 0, creditBalance: 1_000_000 })],
      () => "NOT_CASH" as CashState,
      (r) => r.accountCode ?? r.accountName,
    );
    expect(result.currentLiabilityBalanceGross).toBe(0);
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
      expect(result.nonCashCurrentAssetBalance).toBe(0);
      expect(result.currentLiabilityBalanceGross).toBe(0);
      expect(result.cashBalance).toBe(0);
    }
  });
});

describe("excludeScheduledTaxFromCurrentLiabilities — PPG-1 Finding 4 confirmed defect, now fixed", () => {
  it("excludes the full scheduled tax total from the generic AP bucket", () => {
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
    // Simulates a company whose ENTIRE current-liability balance is a single
    // VAT payable control account — before this fix, that balance would be
    // BOTH spread across the generic 30/60/90 AP curve AND placed on its
    // exact statutory due date. After this fix, the generic curve carries 0
    // for it, and only the statutory placement represents it.
    const vatControlAccountBalance = 450_000;
    const { apBalanceExTax, scheduledTaxTotal } = excludeScheduledTaxFromCurrentLiabilities(
      vatControlAccountBalance,
      { paye: null, sdl: null, vat: 450_000, wht: null },
    );
    expect(apBalanceExTax).toBe(0);
    expect(scheduledTaxTotal).toBe(450_000);
  });
});

describe("classification limitation disclosures — honest, never fabricated precision", () => {
  it("the receivable limitation names the actual undistinguishable categories", () => {
    expect(RECEIVABLE_CLASSIFICATION_LIMITATION).toMatch(/inventory/i);
    expect(RECEIVABLE_CLASSIFICATION_LIMITATION).toMatch(/prepayment/i);
    expect(RECEIVABLE_CLASSIFICATION_LIMITATION).toMatch(/tax receivable/i);
    // Must explicitly disclaim verified precision, never merely assert it.
    expect(RECEIVABLE_CLASSIFICATION_LIMITATION).toMatch(/not a verified/i);
  });

  it("the payable limitation names the tax-exclusion mechanism and its own residual limit", () => {
    expect(PAYABLE_CLASSIFICATION_LIMITATION).toMatch(/PAYE\/VAT\/SDL\/WHT/);
    expect(PAYABLE_CLASSIFICATION_LIMITATION).toMatch(/trade payable/i);
  });
});
