// canonicalStatement/fixtures/isolatedBaseline.ts — the clean, runtime-valid
// baseline every isolated rule-defect mutation in isolatedMutations.ts
// starts from. Deliberately small (one SFP, one P&L, one cash flow
// statement, one note with both a totalFactId AND a movement schedule) but
// complete enough to exercise all ten rules independently, PASSing every
// one of them. Every figure was chosen so that mutating one fact for one
// rule's defect does not, by construction, also perturb any other rule's
// evaluation — see isolatedMutations.ts's own comments for exactly which
// fact each mutation touches and why nothing else moves.

import { CANONICAL_CONCEPTS } from "../concepts";
import { CANONICAL_SCHEMA_VERSION } from "../types";
import type { CanonicalFinancialStatementReport } from "../types";
import { COMPARATIVE_1, CURRENT, fact, line } from "./builders";

export const CCY = "TZS";
export const SCALE = 2;

// ─── SFP facts ───────────────────────────────────────────────────────────
export const ppeCur = fact("iso-ppe-cur", "500000.00", CCY, SCALE, CURRENT);
export const ppeCmp = fact("iso-ppe-cmp", "450000.00", CCY, SCALE, COMPARATIVE_1);
export const cashCur = fact("iso-cash-cur", "300000.00", CCY, SCALE, CURRENT);
export const cashCmp = fact("iso-cash-cmp", "250000.00", CCY, SCALE, COMPARATIVE_1);
export const totalAssetsCur = fact("iso-total-assets-cur", "800000.00", CCY, SCALE, CURRENT);
export const totalAssetsCmp = fact("iso-total-assets-cmp", "700000.00", CCY, SCALE, COMPARATIVE_1);

export const payablesCur = fact("iso-payables-cur", "200000.00", CCY, SCALE, CURRENT);
export const payablesCmp = fact("iso-payables-cmp", "180000.00", CCY, SCALE, COMPARATIVE_1);
export const totalLiabilitiesCur = fact("iso-total-liabilities-cur", "200000.00", CCY, SCALE, CURRENT);
export const totalLiabilitiesCmp = fact("iso-total-liabilities-cmp", "180000.00", CCY, SCALE, COMPARATIVE_1);

export const capitalCur = fact("iso-capital-cur", "600000.00", CCY, SCALE, CURRENT);
export const capitalCmp = fact("iso-capital-cmp", "520000.00", CCY, SCALE, COMPARATIVE_1);
export const totalEquityCur = fact("iso-total-equity-cur", "600000.00", CCY, SCALE, CURRENT);
export const totalEquityCmp = fact("iso-total-equity-cmp", "520000.00", CCY, SCALE, COMPARATIVE_1);

// ─── P&L facts ───────────────────────────────────────────────────────────
export const revenueCur = fact("iso-revenue-cur", "1000000.00", CCY, SCALE, CURRENT);
export const revenueCmp = fact("iso-revenue-cmp", "900000.00", CCY, SCALE, COMPARATIVE_1);
export const expensesCur = fact("iso-expenses-cur", "-600000.00", CCY, SCALE, CURRENT);
export const expensesCmp = fact("iso-expenses-cmp", "-550000.00", CCY, SCALE, COMPARATIVE_1);
export const profitCur = fact("iso-profit-cur", "400000.00", CCY, SCALE, CURRENT);
export const profitCmp = fact("iso-profit-cmp", "350000.00", CCY, SCALE, COMPARATIVE_1);

// ─── Cash flow facts (deliberately separate factIds from SFP cash, same values) ──
export const closingCashCfCur = fact("iso-closing-cash-cf-cur", "300000.00", CCY, SCALE, CURRENT);
export const closingCashCfCmp = fact("iso-closing-cash-cf-cmp", "250000.00", CCY, SCALE, COMPARATIVE_1);

// ─── PPE note facts — a separate totalFactId AND a separate movement-schedule
// closingBalanceFactId, both independently equal to the face ppe value, so
// Rule 3 (note-to-face) and Rule 7 (movement reconciliation) can each be
// mutated without disturbing the other. ──────────────────────────────────
export const ppeNoteTotal = fact("iso-ppe-note-total", "500000.00", CCY, SCALE, CURRENT);
export const ppeOpening = fact("iso-ppe-opening", "400000.00", CCY, SCALE, CURRENT);
export const ppeAdditions = fact("iso-ppe-additions", "150000.00", CCY, SCALE, CURRENT);
export const ppeDisposals = fact("iso-ppe-disposals", "50000.00", CCY, SCALE, CURRENT);
export const ppeNoteClosing = fact("iso-ppe-note-closing", "500000.00", CCY, SCALE, CURRENT); // 400,000 + 150,000 - 50,000

// ─── Lines ───────────────────────────────────────────────────────────────
export const ppeLine = line("iso-sfp-ppe", "Property, plant and equipment", "ppe_net", "DETAIL", ppeCur.factId, { comparativeFactId: ppeCmp.factId });
export const cashLine = line("iso-sfp-cash", "Cash and cash equivalents", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP, "DETAIL", cashCur.factId, {
  comparativeFactId: cashCmp.factId,
});
export const totalAssetsLine = line("iso-sfp-total-assets", "Total assets", CANONICAL_CONCEPTS.TOTAL_ASSETS, "TOTAL", totalAssetsCur.factId, {
  comparativeFactId: totalAssetsCmp.factId,
  castingChildLineIds: [ppeLine.lineId, cashLine.lineId],
});

export const payablesLine = line("iso-sfp-payables", "Trade payables", "trade_payables", "DETAIL", payablesCur.factId, {
  comparativeFactId: payablesCmp.factId,
  normalBalance: "CREDIT_NORMAL",
});
export const totalLiabilitiesLine = line("iso-sfp-total-liabilities", "Total liabilities", CANONICAL_CONCEPTS.TOTAL_LIABILITIES, "TOTAL", totalLiabilitiesCur.factId, {
  comparativeFactId: totalLiabilitiesCmp.factId,
  normalBalance: "CREDIT_NORMAL",
  castingChildLineIds: [payablesLine.lineId],
});

export const capitalLine = line("iso-sfp-capital", "Share capital", "share_capital", "DETAIL", capitalCur.factId, {
  comparativeFactId: capitalCmp.factId,
  normalBalance: "CREDIT_NORMAL",
});
export const totalEquityLine = line("iso-sfp-total-equity", "Total equity", CANONICAL_CONCEPTS.TOTAL_EQUITY, "TOTAL", totalEquityCur.factId, {
  comparativeFactId: totalEquityCmp.factId,
  normalBalance: "CREDIT_NORMAL",
  castingChildLineIds: [capitalLine.lineId],
});

export const revenueLine = line("iso-pnl-revenue", "Revenue", "revenue", "DETAIL", revenueCur.factId, { comparativeFactId: revenueCmp.factId, normalBalance: "CREDIT_NORMAL" });
export const expensesLine = line("iso-pnl-expenses", "Expenses", "operating_expenses", "DETAIL", expensesCur.factId, { comparativeFactId: expensesCmp.factId, isContra: true });
export const profitLine = line("iso-pnl-profit", "Profit for the year", "profit_for_the_year", "TOTAL", profitCur.factId, {
  comparativeFactId: profitCmp.factId,
  castingChildLineIds: [revenueLine.lineId, expensesLine.lineId],
});

export const closingCashLine = line(
  "iso-cf-closing-cash",
  "Cash and cash equivalents at end of period",
  CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF,
  "DETAIL",
  closingCashCfCur.factId,
  { comparativeFactId: closingCashCfCmp.factId },
);

export const PPE_NOTE_ID = "iso-note-ppe";
export const PPE_NOTE_REFERENCE_ID = "iso-nr-ppe";

export const ISOLATED_BASELINE: CanonicalFinancialStatementReport = {
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  reportIdentity: { reportId: "fixture-isolated-baseline", companyId: "company-isolated-baseline", reportVersion: 1 },
  entity: { legalName: "Example Isolated-Mutation Baseline Ltd" },
  period: { periodId: "CURRENT", startDate: "2026-01-01", endDate: "2026-12-31", periodYear: 2026 },
  comparativePeriods: [{ periodId: "COMPARATIVE_1", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025, isRestated: false }],
  framework: { kind: "IFRS" },
  presentationCurrency: { currency: CCY, scale: SCALE, roundingPolicy: { mode: "HALF_UP", scale: SCALE }, presentationMultiplier: 1n },
  statements: [
    {
      statementId: "iso-stmt-sfp",
      type: "STATEMENT_OF_FINANCIAL_POSITION",
      title: "Statement of Financial Position",
      sections: [
        { sectionId: "iso-sfp-assets", label: "Assets", lines: [ppeLine, cashLine, totalAssetsLine] },
        { sectionId: "iso-sfp-liabilities", label: "Liabilities", lines: [payablesLine, totalLiabilitiesLine] },
        { sectionId: "iso-sfp-equity", label: "Equity", lines: [capitalLine, totalEquityLine] },
      ],
    },
    {
      statementId: "iso-stmt-pnl",
      type: "STATEMENT_OF_PROFIT_OR_LOSS",
      title: "Statement of Profit or Loss",
      sections: [{ sectionId: "iso-pnl-body", label: "Profit or loss", lines: [revenueLine, expensesLine, profitLine] }],
    },
    {
      statementId: "iso-stmt-cf",
      type: "STATEMENT_OF_CASH_FLOWS",
      title: "Statement of Cash Flows",
      sections: [{ sectionId: "iso-cf-body", label: "Cash flow", lines: [closingCashLine] }],
    },
  ],
  notes: [
    {
      noteId: PPE_NOTE_ID,
      noteNumber: "5",
      title: "Property, plant and equipment",
      monetaryFactIds: [ppeOpening.factId, ppeAdditions.factId, ppeDisposals.factId, ppeNoteClosing.factId, ppeNoteTotal.factId],
      totalFactId: ppeNoteTotal.factId,
      movementSchedule: {
        scheduleId: "iso-ppe-movement",
        openingBalanceFactId: ppeOpening.factId,
        additionFactIds: [ppeAdditions.factId],
        disposalFactIds: [ppeDisposals.factId],
        otherMovements: [],
        closingBalanceFactId: ppeNoteClosing.factId,
      },
    },
  ],
  noteReferences: [{ noteReferenceId: PPE_NOTE_REFERENCE_ID, fromLineId: ppeLine.lineId, toNoteId: PPE_NOTE_ID }],
  accountingPolicies: [],
  textualDisclosures: [],
  facts: [
    ppeCur, ppeCmp, cashCur, cashCmp, totalAssetsCur, totalAssetsCmp,
    payablesCur, payablesCmp, totalLiabilitiesCur, totalLiabilitiesCmp,
    capitalCur, capitalCmp, totalEquityCur, totalEquityCmp,
    revenueCur, revenueCmp, expensesCur, expensesCmp, profitCur, profitCmp,
    closingCashCfCur, closingCashCfCmp,
    ppeNoteTotal, ppeOpening, ppeAdditions, ppeDisposals, ppeNoteClosing,
  ],
  provenanceOrigin: "TRIAL_BALANCE_DERIVED",
};
