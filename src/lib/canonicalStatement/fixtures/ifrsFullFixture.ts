// canonicalStatement/fixtures/ifrsFullFixture.ts — a full IFRS golden
// fixture: SFP + P&L + cash flow, with comparatives, a PPE movement note, a
// face line referenced by two different notes, a contra P&L line, a genuine
// zero, and a genuinely MISSING (not zero) disclosure. Every one of the ten
// rules should PASS or legitimately NOT_APPLICABLE against this fixture —
// see ifrsFullFixture.test.ts.

import { CANONICAL_CONCEPTS } from "../concepts";
import { CANONICAL_SCHEMA_VERSION } from "../types";
import type { CanonicalFinancialStatementReport } from "../types";
import { COMPARATIVE_1, CURRENT, fact, line, provenance } from "./builders";

const CCY = "TZS";
const SCALE = 2;

// SFP — assets
const ppeNetCur = fact("ppe-net-cur", "2000000.00", CCY, SCALE, CURRENT);
const ppeNetCmp = fact("ppe-net-cmp", "1800000.00", CCY, SCALE, COMPARATIVE_1);
const cashCur = fact("cash-cur", "500000.00", CCY, SCALE, CURRENT);
const cashCmp = fact("cash-cmp", "400000.00", CCY, SCALE, COMPARATIVE_1);
const receivablesCur = fact("receivables-cur", "300000.00", CCY, SCALE, CURRENT);
const receivablesCmp = fact("receivables-cmp", "250000.00", CCY, SCALE, COMPARATIVE_1);
const contingentLiabilitiesCur = fact("contingent-liabilities-cur", null, CCY, SCALE, CURRENT); // genuinely not disclosed this period — MISSING, never a zero
const totalAssetsCur = fact("total-assets-cur", "2800000.00", CCY, SCALE, CURRENT);
const totalAssetsCmp = fact("total-assets-cmp", "2450000.00", CCY, SCALE, COMPARATIVE_1);

// SFP — liabilities
const payablesCur = fact("payables-cur", "300000.00", CCY, SCALE, CURRENT);
const payablesCmp = fact("payables-cmp", "250000.00", CCY, SCALE, COMPARATIVE_1);
const totalLiabilitiesCur = fact("total-liabilities-cur", "300000.00", CCY, SCALE, CURRENT);
const totalLiabilitiesCmp = fact("total-liabilities-cmp", "250000.00", CCY, SCALE, COMPARATIVE_1);

// SFP — equity
const shareCapitalCur = fact("share-capital-cur", "1000000.00", CCY, SCALE, CURRENT);
const shareCapitalCmp = fact("share-capital-cmp", "1000000.00", CCY, SCALE, COMPARATIVE_1);
const retainedEarningsCur = fact("retained-earnings-cur", "1500000.00", CCY, SCALE, CURRENT);
const retainedEarningsCmp = fact("retained-earnings-cmp", "1200000.00", CCY, SCALE, COMPARATIVE_1);
const dividendsDeclaredCur = fact("dividends-declared-cur", "0.00", CCY, SCALE, CURRENT); // a genuine reported zero — never confused with the MISSING contingent-liabilities fact above
const totalEquityCur = fact("total-equity-cur", "2500000.00", CCY, SCALE, CURRENT);
const totalEquityCmp = fact("total-equity-cmp", "2200000.00", CCY, SCALE, COMPARATIVE_1);
const totalLiabilitiesAndEquityCur = fact("total-liab-equity-cur", "2800000.00", CCY, SCALE, CURRENT);
const totalLiabilitiesAndEquityCmp = fact("total-liab-equity-cmp", "2450000.00", CCY, SCALE, COMPARATIVE_1);

// P&L
const revenueCur = fact("revenue-cur", "5000000.00", CCY, SCALE, CURRENT);
const revenueCmp = fact("revenue-cmp", "4000000.00", CCY, SCALE, COMPARATIVE_1);
const expensesCur = fact("expenses-cur", "-3500000.00", CCY, SCALE, CURRENT); // contra: a genuine negative value, never coerced positive
const expensesCmp = fact("expenses-cmp", "-3000000.00", CCY, SCALE, COMPARATIVE_1);
const profitCur = fact("profit-cur", "1500000.00", CCY, SCALE, CURRENT);
const profitCmp = fact("profit-cmp", "1000000.00", CCY, SCALE, COMPARATIVE_1);

// Cash flow — closing cash equals the SFP cash line by construction (same underlying fact).
const closingCashCur = cashCur;
const closingCashCmp = cashCmp;

const ppeLine = line("sfp-ppe", "Property, plant and equipment", "ppe_net", "DETAIL", ppeNetCur.factId, {
  comparativeFactId: ppeNetCmp.factId,
  noteReferenceIds: ["nr-ppe"],
});
const cashLine = line("sfp-cash", "Cash and cash equivalents", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP, "DETAIL", cashCur.factId, {
  comparativeFactId: cashCmp.factId,
});
const receivablesLine = line("sfp-receivables", "Trade receivables", "trade_receivables", "DETAIL", receivablesCur.factId, {
  comparativeFactId: receivablesCmp.factId,
  noteReferenceIds: ["nr-ageing", "nr-related-party"],
});
const contingentLiabilitiesLine = line("sfp-contingent", "Contingent liabilities", "contingent_liabilities", "DETAIL", contingentLiabilitiesCur.factId);
const totalAssetsLine = line("sfp-total-assets", "Total", CANONICAL_CONCEPTS.TOTAL_ASSETS, "TOTAL", totalAssetsCur.factId, {
  comparativeFactId: totalAssetsCmp.factId,
  castingChildLineIds: [ppeLine.lineId, cashLine.lineId, receivablesLine.lineId],
});

const payablesLine = line("sfp-payables", "Trade payables", "trade_payables", "DETAIL", payablesCur.factId, {
  comparativeFactId: payablesCmp.factId,
  normalBalance: "CREDIT_NORMAL",
});
const totalLiabilitiesLine = line("sfp-total-liabilities", "Total liabilities", CANONICAL_CONCEPTS.TOTAL_LIABILITIES, "TOTAL", totalLiabilitiesCur.factId, {
  comparativeFactId: totalLiabilitiesCmp.factId,
  normalBalance: "CREDIT_NORMAL",
  castingChildLineIds: [payablesLine.lineId],
});

const shareCapitalLine = line("sfp-share-capital", "Share capital", "share_capital", "DETAIL", shareCapitalCur.factId, {
  comparativeFactId: shareCapitalCmp.factId,
  normalBalance: "CREDIT_NORMAL",
});
const retainedEarningsLine = line("sfp-retained-earnings", "Retained earnings", "retained_earnings", "DETAIL", retainedEarningsCur.factId, {
  comparativeFactId: retainedEarningsCmp.factId,
  normalBalance: "CREDIT_NORMAL",
});
const dividendsDeclaredLine = line("sfp-dividends", "Dividends declared", "dividends_declared", "DETAIL", dividendsDeclaredCur.factId, {
  normalBalance: "CREDIT_NORMAL",
});
const totalEquityLine = line("sfp-total-equity", "Total", CANONICAL_CONCEPTS.TOTAL_EQUITY, "TOTAL", totalEquityCur.factId, {
  comparativeFactId: totalEquityCmp.factId,
  normalBalance: "CREDIT_NORMAL",
  castingChildLineIds: [shareCapitalLine.lineId, retainedEarningsLine.lineId],
});
const totalLiabilitiesAndEquityLine = line(
  "sfp-total-liab-equity",
  "Total",
  CANONICAL_CONCEPTS.TOTAL_LIABILITIES_AND_EQUITY,
  "TOTAL",
  totalLiabilitiesAndEquityCur.factId,
  {
    comparativeFactId: totalLiabilitiesAndEquityCmp.factId,
    normalBalance: "CREDIT_NORMAL",
    castingChildLineIds: [totalLiabilitiesLine.lineId, totalEquityLine.lineId],
  },
);

const revenueLine = line("pnl-revenue", "Revenue", "revenue", "DETAIL", revenueCur.factId, { comparativeFactId: revenueCmp.factId, normalBalance: "CREDIT_NORMAL" });
const expensesLine = line("pnl-expenses", "Operating expenses", "operating_expenses", "DETAIL", expensesCur.factId, {
  comparativeFactId: expensesCmp.factId,
  isContra: true,
});
const profitLine = line("pnl-profit", "Profit for the year", "profit_for_the_year", "TOTAL", profitCur.factId, {
  comparativeFactId: profitCmp.factId,
  castingChildLineIds: [revenueLine.lineId, expensesLine.lineId],
});

const closingCashLine = line("cf-closing-cash", "Cash and cash equivalents at end of period", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF, "DETAIL", closingCashCur.factId, {
  comparativeFactId: closingCashCmp.factId,
});

export const IFRS_FULL_FIXTURE: CanonicalFinancialStatementReport = {
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  reportIdentity: { reportId: "fixture-ifrs-full", companyId: "company-ifrs-full", reportVersion: 1 },
  entity: { legalName: "Example IFRS Preparer Ltd" },
  period: { periodId: "CURRENT", startDate: "2026-01-01", endDate: "2026-12-31", periodYear: 2026 },
  comparativePeriods: [{ periodId: "COMPARATIVE_1", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025, isRestated: false }],
  framework: { kind: "IFRS" },
  presentationCurrency: { currency: CCY, scale: SCALE, roundingPolicy: { mode: "HALF_UP", scale: SCALE }, presentationMultiplier: 1n },
  statements: [
    {
      statementId: "stmt-sfp",
      type: "STATEMENT_OF_FINANCIAL_POSITION",
      title: "Statement of Financial Position",
      sections: [
        { sectionId: "sfp-assets", label: "Assets", lines: [ppeLine, cashLine, receivablesLine, contingentLiabilitiesLine, totalAssetsLine] },
        { sectionId: "sfp-liabilities", label: "Liabilities", lines: [payablesLine, totalLiabilitiesLine] },
        { sectionId: "sfp-equity", label: "Equity", lines: [shareCapitalLine, retainedEarningsLine, dividendsDeclaredLine, totalEquityLine, totalLiabilitiesAndEquityLine] },
      ],
    },
    {
      statementId: "stmt-pnl",
      type: "STATEMENT_OF_PROFIT_OR_LOSS",
      title: "Statement of Profit or Loss",
      sections: [{ sectionId: "pnl-body", label: "Profit or loss", lines: [revenueLine, expensesLine, profitLine] }],
    },
    {
      statementId: "stmt-cf",
      type: "STATEMENT_OF_CASH_FLOWS",
      title: "Statement of Cash Flows",
      sections: [{ sectionId: "cf-body", label: "Cash flow", lines: [closingCashLine] }],
    },
  ],
  notes: [
    {
      noteId: "note-ppe",
      noteNumber: "5",
      title: "Property, plant and equipment",
      monetaryFactIds: ["ppe-opening", "ppe-additions", "ppe-disposals", ppeNetCur.factId],
      movementSchedule: {
        scheduleId: "ppe-movement",
        openingBalanceFactId: "ppe-opening",
        additionFactIds: ["ppe-additions"],
        disposalFactIds: ["ppe-disposals"],
        otherMovements: [],
        closingBalanceFactId: ppeNetCur.factId,
      },
    },
    { noteId: "note-ageing", noteNumber: "6", title: "Trade receivables ageing", monetaryFactIds: [] },
    { noteId: "note-related-party", noteNumber: "7", title: "Related party balances", monetaryFactIds: [] },
  ],
  noteReferences: [
    { noteReferenceId: "nr-ppe", fromLineId: ppeLine.lineId, toNoteId: "note-ppe" },
    { noteReferenceId: "nr-ageing", fromLineId: receivablesLine.lineId, toNoteId: "note-ageing" },
    { noteReferenceId: "nr-related-party", fromLineId: receivablesLine.lineId, toNoteId: "note-related-party" },
  ],
  accountingPolicies: [
    {
      policyId: "policy-revenue",
      topic: "Revenue recognition",
      text: "Revenue is recognized when control of goods or services transfers to the customer.",
      provenance: provenance("Revenue is recognized when control of goods or services transfers to the customer."),
    },
  ],
  textualDisclosures: [],
  facts: [
    ppeNetCur, ppeNetCmp, cashCur, cashCmp, receivablesCur, receivablesCmp, contingentLiabilitiesCur,
    totalAssetsCur, totalAssetsCmp, payablesCur, payablesCmp, totalLiabilitiesCur, totalLiabilitiesCmp,
    shareCapitalCur, shareCapitalCmp, retainedEarningsCur, retainedEarningsCmp, dividendsDeclaredCur,
    totalEquityCur, totalEquityCmp, totalLiabilitiesAndEquityCur, totalLiabilitiesAndEquityCmp,
    revenueCur, revenueCmp, expensesCur, expensesCmp, profitCur, profitCmp,
    fact("ppe-opening", "1800000.00", CCY, SCALE, CURRENT),
    fact("ppe-additions", "300000.00", CCY, SCALE, CURRENT),
    fact("ppe-disposals", "100000.00", CCY, SCALE, CURRENT),
  ],
  provenanceOrigin: "TRIAL_BALANCE_DERIVED",
};
