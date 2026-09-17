// canonicalStatement/fixtures/ipsasCashFixture.ts — an IPSAS cash-basis
// golden fixture: a single Statement of Cash Receipts and Payments, no
// statement of financial position at all. This is a genuine, honest
// structural absence for a cash-basis entity — Rules 1 and 6 (both of which
// depend on an SFP existing) should both resolve NOT_APPLICABLE rather than
// FAIL or INSUFFICIENT_EVIDENCE.

import { CANONICAL_CONCEPTS } from "../concepts";
import { CANONICAL_SCHEMA_VERSION } from "../types";
import type { CanonicalFinancialStatementReport } from "../types";
import { COMPARATIVE_1, CURRENT, fact, line } from "./builders";

const CCY = "TZS";
const SCALE = 2;

const taxReceiptsCur = fact("cash-tax-receipts-cur", "900000.00", CCY, SCALE, CURRENT);
const taxReceiptsCmp = fact("cash-tax-receipts-cmp", "800000.00", CCY, SCALE, COMPARATIVE_1);
const grantsReceivedCur = fact("cash-grants-cur", "100000.00", CCY, SCALE, CURRENT);
const grantsReceivedCmp = fact("cash-grants-cmp", "100000.00", CCY, SCALE, COMPARATIVE_1);
const totalReceiptsCur = fact("cash-total-receipts-cur", "1000000.00", CCY, SCALE, CURRENT);
const totalReceiptsCmp = fact("cash-total-receipts-cmp", "900000.00", CCY, SCALE, COMPARATIVE_1);

const salariesPaidCur = fact("cash-salaries-cur", "-600000.00", CCY, SCALE, CURRENT);
const salariesPaidCmp = fact("cash-salaries-cmp", "-550000.00", CCY, SCALE, COMPARATIVE_1);
const totalPaymentsCur = fact("cash-total-payments-cur", "-600000.00", CCY, SCALE, CURRENT);
const totalPaymentsCmp = fact("cash-total-payments-cmp", "-550000.00", CCY, SCALE, COMPARATIVE_1);

const netCashFlowCur = fact("cash-net-cur", "400000.00", CCY, SCALE, CURRENT);
const netCashFlowCmp = fact("cash-net-cmp", "350000.00", CCY, SCALE, COMPARATIVE_1);

const closingCashCur = fact("cash-closing-cur", "1000000.00", CCY, SCALE, CURRENT);
const closingCashCmp = fact("cash-closing-cmp", "600000.00", CCY, SCALE, COMPARATIVE_1);

const taxReceiptsLine = line("crp-tax-receipts", "Tax receipts", "tax_receipts", "DETAIL", taxReceiptsCur.factId, { comparativeFactId: taxReceiptsCmp.factId, normalBalance: "CREDIT_NORMAL" });
const grantsReceivedLine = line("crp-grants", "Grants received", "grants_received", "DETAIL", grantsReceivedCur.factId, { comparativeFactId: grantsReceivedCmp.factId, normalBalance: "CREDIT_NORMAL" });
const totalReceiptsLine = line("crp-total-receipts", "Total receipts", "total_receipts", "TOTAL", totalReceiptsCur.factId, {
  comparativeFactId: totalReceiptsCmp.factId,
  normalBalance: "CREDIT_NORMAL",
  castingChildLineIds: [taxReceiptsLine.lineId, grantsReceivedLine.lineId],
});

const salariesPaidLine = line("crp-salaries", "Salaries paid", "salaries_paid", "DETAIL", salariesPaidCur.factId, { comparativeFactId: salariesPaidCmp.factId, isContra: true });
const totalPaymentsLine = line("crp-total-payments", "Total payments", "total_payments", "TOTAL", totalPaymentsCur.factId, {
  comparativeFactId: totalPaymentsCmp.factId,
  isContra: true,
  castingChildLineIds: [salariesPaidLine.lineId],
});

const netCashFlowLine = line("crp-net", "Net increase in cash and cash equivalents", "net_cash_flow", "TOTAL", netCashFlowCur.factId, {
  comparativeFactId: netCashFlowCmp.factId,
  castingChildLineIds: [totalReceiptsLine.lineId, totalPaymentsLine.lineId],
});

const closingCashLine = line("crp-closing-cash", "Cash and cash equivalents at end of period", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF, "DETAIL", closingCashCur.factId, {
  comparativeFactId: closingCashCmp.factId,
});

export const IPSAS_CASH_FIXTURE: CanonicalFinancialStatementReport = {
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  reportIdentity: { reportId: "fixture-ipsas-cash", companyId: "company-ipsas-cash", reportVersion: 1 },
  entity: { legalName: "Example Cash-Basis Government Unit" },
  period: { periodId: "CURRENT", startDate: "2026-07-01", endDate: "2027-06-30", periodYear: 2026 },
  comparativePeriods: [{ periodId: "COMPARATIVE_1", startDate: "2025-07-01", endDate: "2026-06-30", periodYear: 2025, isRestated: false }],
  framework: { kind: "IPSAS_CASH" },
  presentationCurrency: { currency: CCY, scale: SCALE, roundingPolicy: { mode: "HALF_UP", scale: SCALE }, presentationMultiplier: 1n },
  statements: [
    {
      statementId: "crp-stmt",
      type: "STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS",
      title: "Statement of Cash Receipts and Payments",
      sections: [
        { sectionId: "crp-receipts", label: "Receipts", lines: [taxReceiptsLine, grantsReceivedLine, totalReceiptsLine] },
        { sectionId: "crp-payments", label: "Payments", lines: [salariesPaidLine, totalPaymentsLine] },
        { sectionId: "crp-summary", label: "Summary", lines: [netCashFlowLine, closingCashLine] },
      ],
    },
  ],
  notes: [],
  noteReferences: [],
  accountingPolicies: [],
  textualDisclosures: [],
  facts: [
    taxReceiptsCur, taxReceiptsCmp, grantsReceivedCur, grantsReceivedCmp, totalReceiptsCur, totalReceiptsCmp,
    salariesPaidCur, salariesPaidCmp, totalPaymentsCur, totalPaymentsCmp,
    netCashFlowCur, netCashFlowCmp, closingCashCur, closingCashCmp,
  ],
  provenanceOrigin: "TRIAL_BALANCE_DERIVED",
};
