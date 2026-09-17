// canonicalStatement/fixtures/ifrsForSmesFixture.ts — a simplified IFRS for
// SMEs golden fixture: SFP + a single combined income statement, no cash
// flow statement and no notes (both legitimately absent, not missing —
// rules 6/7 should resolve NOT_APPLICABLE, and rule 3 contributes zero
// findings since there are no note references to check). The comparative
// period is restated, exercising ComparativePeriod.isRestated.

import { CANONICAL_CONCEPTS } from "../concepts";
import { CANONICAL_SCHEMA_VERSION } from "../types";
import type { CanonicalFinancialStatementReport } from "../types";
import { COMPARATIVE_1, CURRENT, fact, line } from "./builders";

const CCY = "USD";
const SCALE = 2;

const cashCur = fact("sme-cash-cur", "80000.00", CCY, SCALE, CURRENT);
const cashCmp = fact("sme-cash-cmp", "60000.00", CCY, SCALE, COMPARATIVE_1);
const inventoryCur = fact("sme-inventory-cur", "40000.00", CCY, SCALE, CURRENT);
const inventoryCmp = fact("sme-inventory-cmp", "35000.00", CCY, SCALE, COMPARATIVE_1);
const totalAssetsCur = fact("sme-total-assets-cur", "120000.00", CCY, SCALE, CURRENT);
const totalAssetsCmp = fact("sme-total-assets-cmp", "95000.00", CCY, SCALE, COMPARATIVE_1);

const loansPayableCur = fact("sme-loans-cur", "30000.00", CCY, SCALE, CURRENT);
const loansPayableCmp = fact("sme-loans-cmp", "25000.00", CCY, SCALE, COMPARATIVE_1);
const totalLiabilitiesCur = fact("sme-total-liabilities-cur", "30000.00", CCY, SCALE, CURRENT);
const totalLiabilitiesCmp = fact("sme-total-liabilities-cmp", "25000.00", CCY, SCALE, COMPARATIVE_1);

const shareCapitalCur = fact("sme-share-capital-cur", "50000.00", CCY, SCALE, CURRENT);
const shareCapitalCmp = fact("sme-share-capital-cmp", "50000.00", CCY, SCALE, COMPARATIVE_1);
const retainedEarningsCur = fact("sme-retained-earnings-cur", "40000.00", CCY, SCALE, CURRENT);
const retainedEarningsCmp = fact("sme-retained-earnings-cmp", "20000.00", CCY, SCALE, COMPARATIVE_1); // restated from a previously issued 15,000.00
const totalEquityCur = fact("sme-total-equity-cur", "90000.00", CCY, SCALE, CURRENT);
const totalEquityCmp = fact("sme-total-equity-cmp", "70000.00", CCY, SCALE, COMPARATIVE_1);

const revenueCur = fact("sme-revenue-cur", "200000.00", CCY, SCALE, CURRENT);
const revenueCmp = fact("sme-revenue-cmp", "150000.00", CCY, SCALE, COMPARATIVE_1);
const costOfSalesCur = fact("sme-cos-cur", "-120000.00", CCY, SCALE, CURRENT);
const costOfSalesCmp = fact("sme-cos-cmp", "-95000.00", CCY, SCALE, COMPARATIVE_1);
const profitCur = fact("sme-profit-cur", "80000.00", CCY, SCALE, CURRENT);
const profitCmp = fact("sme-profit-cmp", "55000.00", CCY, SCALE, COMPARATIVE_1);

const cashLine = line("sme-sfp-cash", "Cash", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP, "DETAIL", cashCur.factId, { comparativeFactId: cashCmp.factId });
const inventoryLine = line("sme-sfp-inventory", "Inventory", "inventory", "DETAIL", inventoryCur.factId, { comparativeFactId: inventoryCmp.factId });
const totalAssetsLine = line("sme-sfp-total-assets", "Total assets", CANONICAL_CONCEPTS.TOTAL_ASSETS, "TOTAL", totalAssetsCur.factId, {
  comparativeFactId: totalAssetsCmp.factId,
  castingChildLineIds: [cashLine.lineId, inventoryLine.lineId],
});

const loansPayableLine = line("sme-sfp-loans", "Loans payable", "loans_payable", "DETAIL", loansPayableCur.factId, {
  comparativeFactId: loansPayableCmp.factId,
  normalBalance: "CREDIT_NORMAL",
});
const totalLiabilitiesLine = line("sme-sfp-total-liabilities", "Total liabilities", CANONICAL_CONCEPTS.TOTAL_LIABILITIES, "TOTAL", totalLiabilitiesCur.factId, {
  comparativeFactId: totalLiabilitiesCmp.factId,
  normalBalance: "CREDIT_NORMAL",
  castingChildLineIds: [loansPayableLine.lineId],
});

const shareCapitalLine = line("sme-sfp-share-capital", "Share capital", "share_capital", "DETAIL", shareCapitalCur.factId, {
  comparativeFactId: shareCapitalCmp.factId,
  normalBalance: "CREDIT_NORMAL",
});
const retainedEarningsLine = line("sme-sfp-retained-earnings", "Retained earnings", "retained_earnings", "DETAIL", retainedEarningsCur.factId, {
  comparativeFactId: retainedEarningsCmp.factId,
  normalBalance: "CREDIT_NORMAL",
});
const totalEquityLine = line("sme-sfp-total-equity", "Total equity", CANONICAL_CONCEPTS.TOTAL_EQUITY, "TOTAL", totalEquityCur.factId, {
  comparativeFactId: totalEquityCmp.factId,
  normalBalance: "CREDIT_NORMAL",
  castingChildLineIds: [shareCapitalLine.lineId, retainedEarningsLine.lineId],
});

const revenueLine = line("sme-pnl-revenue", "Revenue", "revenue", "DETAIL", revenueCur.factId, { comparativeFactId: revenueCmp.factId, normalBalance: "CREDIT_NORMAL" });
const costOfSalesLine = line("sme-pnl-cos", "Cost of sales", "cost_of_sales", "DETAIL", costOfSalesCur.factId, {
  comparativeFactId: costOfSalesCmp.factId,
  isContra: true,
});
const profitLine = line("sme-pnl-profit", "Profit for the year", "profit_for_the_year", "TOTAL", profitCur.factId, {
  comparativeFactId: profitCmp.factId,
  castingChildLineIds: [revenueLine.lineId, costOfSalesLine.lineId],
});

export const IFRS_FOR_SMES_FIXTURE: CanonicalFinancialStatementReport = {
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  reportIdentity: { reportId: "fixture-ifrs-for-smes", companyId: "company-ifrs-for-smes", reportVersion: 1 },
  entity: { legalName: "Example SME Ltd" },
  period: { periodId: "CURRENT", startDate: "2026-01-01", endDate: "2026-12-31", periodYear: 2026 },
  comparativePeriods: [
    {
      periodId: "COMPARATIVE_1",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      periodYear: 2025,
      isRestated: true,
      restatementReason: "Prior period error correction under Section 10 (Accounting Policies, Estimates and Errors)",
    },
  ],
  framework: { kind: "IFRS_FOR_SMES" },
  presentationCurrency: { currency: CCY, scale: SCALE, roundingPolicy: { mode: "HALF_UP", scale: SCALE }, presentationMultiplier: 1n },
  statements: [
    {
      statementId: "sme-stmt-sfp",
      type: "STATEMENT_OF_FINANCIAL_POSITION",
      title: "Statement of Financial Position",
      sections: [
        { sectionId: "sme-sfp-assets", label: "Assets", lines: [cashLine, inventoryLine, totalAssetsLine] },
        { sectionId: "sme-sfp-liabilities", label: "Liabilities", lines: [loansPayableLine, totalLiabilitiesLine] },
        { sectionId: "sme-sfp-equity", label: "Equity", lines: [shareCapitalLine, retainedEarningsLine, totalEquityLine] },
      ],
    },
    {
      statementId: "sme-stmt-income",
      type: "STATEMENT_OF_PROFIT_OR_LOSS",
      title: "Combined Statement of Income and Retained Earnings",
      sections: [{ sectionId: "sme-income-body", label: "Income", lines: [revenueLine, costOfSalesLine, profitLine] }],
    },
  ],
  notes: [],
  noteReferences: [],
  accountingPolicies: [],
  textualDisclosures: [],
  facts: [
    cashCur, cashCmp, inventoryCur, inventoryCmp, totalAssetsCur, totalAssetsCmp,
    loansPayableCur, loansPayableCmp, totalLiabilitiesCur, totalLiabilitiesCmp,
    shareCapitalCur, shareCapitalCmp, retainedEarningsCur, retainedEarningsCmp, totalEquityCur, totalEquityCmp,
    revenueCur, revenueCmp, costOfSalesCur, costOfSalesCmp, profitCur, profitCmp,
  ],
  provenanceOrigin: "TRIAL_BALANCE_DERIVED",
};
