// canonicalStatement/fixtures/ipsasAccrualFixture.ts — an IPSAS accrual-basis
// golden fixture for a government entity: SFP + cash flow + an
// infrastructure-assets movement note that exercises the `otherMovements`
// (ADD) branch left untested by the IFRS fixture's simpler PPE note.

import { CANONICAL_CONCEPTS } from "../concepts";
import { CANONICAL_SCHEMA_VERSION } from "../types";
import type { CanonicalFinancialStatementReport } from "../types";
import { COMPARATIVE_1, CURRENT, fact, line } from "./builders";

const CCY = "TZS";
const SCALE = 0; // whole currency units — this fixture presents in thousands (see presentationMultiplier below)

const infraCur = fact("ips-infra-cur", "6000000", CCY, SCALE, CURRENT);
const infraCmp = fact("ips-infra-cmp", "5000000", CCY, SCALE, COMPARATIVE_1);
const cashCur = fact("ips-cash-cur", "1000000", CCY, SCALE, CURRENT);
const cashCmp = fact("ips-cash-cmp", "900000", CCY, SCALE, COMPARATIVE_1);
const totalAssetsCur = fact("ips-total-assets-cur", "7000000", CCY, SCALE, CURRENT);
const totalAssetsCmp = fact("ips-total-assets-cmp", "5900000", CCY, SCALE, COMPARATIVE_1);

const payablesCur = fact("ips-payables-cur", "500000", CCY, SCALE, CURRENT);
const payablesCmp = fact("ips-payables-cmp", "450000", CCY, SCALE, COMPARATIVE_1);
const totalLiabilitiesCur = fact("ips-total-liabilities-cur", "500000", CCY, SCALE, CURRENT);
const totalLiabilitiesCmp = fact("ips-total-liabilities-cmp", "450000", CCY, SCALE, COMPARATIVE_1);

const accumulatedSurplusCur = fact("ips-surplus-cur", "6500000", CCY, SCALE, CURRENT);
const accumulatedSurplusCmp = fact("ips-surplus-cmp", "5450000", CCY, SCALE, COMPARATIVE_1);
const totalEquityCur = fact("ips-total-equity-cur", "6500000", CCY, SCALE, CURRENT);
const totalEquityCmp = fact("ips-total-equity-cmp", "5450000", CCY, SCALE, COMPARATIVE_1);

const infraLine = line("ips-sfp-infra", "Infrastructure assets", "infrastructure_assets", "DETAIL", infraCur.factId, {
  comparativeFactId: infraCmp.factId,
});
const cashLine = line("ips-sfp-cash", "Cash and cash equivalents", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP, "DETAIL", cashCur.factId, {
  comparativeFactId: cashCmp.factId,
});
const totalAssetsLine = line("ips-sfp-total-assets", "Total assets", CANONICAL_CONCEPTS.TOTAL_ASSETS, "TOTAL", totalAssetsCur.factId, {
  comparativeFactId: totalAssetsCmp.factId,
  castingChildLineIds: [infraLine.lineId, cashLine.lineId],
});

const payablesLine = line("ips-sfp-payables", "Payables", "payables", "DETAIL", payablesCur.factId, {
  comparativeFactId: payablesCmp.factId,
  normalBalance: "CREDIT_NORMAL",
});
const totalLiabilitiesLine = line("ips-sfp-total-liabilities", "Total liabilities", CANONICAL_CONCEPTS.TOTAL_LIABILITIES, "TOTAL", totalLiabilitiesCur.factId, {
  comparativeFactId: totalLiabilitiesCmp.factId,
  normalBalance: "CREDIT_NORMAL",
  castingChildLineIds: [payablesLine.lineId],
});

const accumulatedSurplusLine = line("ips-sfp-surplus", "Accumulated surplus", "accumulated_surplus", "DETAIL", accumulatedSurplusCur.factId, {
  comparativeFactId: accumulatedSurplusCmp.factId,
  normalBalance: "CREDIT_NORMAL",
});
const totalEquityLine = line("ips-sfp-total-equity", "Net assets/equity", CANONICAL_CONCEPTS.TOTAL_EQUITY, "TOTAL", totalEquityCur.factId, {
  comparativeFactId: totalEquityCmp.factId,
  normalBalance: "CREDIT_NORMAL",
  castingChildLineIds: [accumulatedSurplusLine.lineId],
});

const closingCashLine = line("ips-cf-closing-cash", "Cash and cash equivalents at end of period", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF, "DETAIL", cashCur.factId, {
  comparativeFactId: cashCmp.factId,
});

export const IPSAS_ACCRUAL_FIXTURE: CanonicalFinancialStatementReport = {
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  reportIdentity: { reportId: "fixture-ipsas-accrual", companyId: "company-ipsas-accrual", reportVersion: 1 },
  entity: { legalName: "Example Government Agency" },
  period: { periodId: "CURRENT", startDate: "2026-07-01", endDate: "2027-06-30", periodYear: 2026 },
  comparativePeriods: [{ periodId: "COMPARATIVE_1", startDate: "2025-07-01", endDate: "2026-06-30", periodYear: 2025, isRestated: false }],
  framework: { kind: "IPSAS_ACCRUAL" },
  presentationCurrency: { currency: CCY, scale: SCALE, roundingPolicy: { mode: "HALF_UP", scale: SCALE }, presentationMultiplier: 1000n },
  statements: [
    {
      statementId: "ips-stmt-sfp",
      type: "STATEMENT_OF_FINANCIAL_POSITION",
      title: "Statement of Financial Position",
      sections: [
        { sectionId: "ips-sfp-assets", label: "Assets", lines: [infraLine, cashLine, totalAssetsLine] },
        { sectionId: "ips-sfp-liabilities", label: "Liabilities", lines: [payablesLine, totalLiabilitiesLine] },
        { sectionId: "ips-sfp-equity", label: "Net assets/equity", lines: [accumulatedSurplusLine, totalEquityLine] },
      ],
    },
    {
      statementId: "ips-stmt-cf",
      type: "STATEMENT_OF_CASH_FLOWS",
      title: "Statement of Cash Flows",
      sections: [{ sectionId: "ips-cf-body", label: "Cash flow", lines: [closingCashLine] }],
    },
  ],
  notes: [
    {
      noteId: "ips-note-infra",
      noteNumber: "8",
      title: "Infrastructure assets",
      monetaryFactIds: ["ips-infra-opening", "ips-infra-additions", "ips-infra-disposals", "ips-infra-revaluation", infraCur.factId],
      movementSchedule: {
        scheduleId: "ips-infra-movement",
        openingBalanceFactId: "ips-infra-opening",
        additionFactIds: ["ips-infra-additions"],
        disposalFactIds: ["ips-infra-disposals"],
        otherMovements: [{ factId: "ips-infra-revaluation", sign: "ADD" }],
        closingBalanceFactId: infraCur.factId,
      },
    },
  ],
  noteReferences: [{ noteReferenceId: "ips-nr-infra", fromLineId: infraLine.lineId, toNoteId: "ips-note-infra" }],
  accountingPolicies: [],
  textualDisclosures: [],
  facts: [
    infraCur, infraCmp, cashCur, cashCmp, totalAssetsCur, totalAssetsCmp,
    payablesCur, payablesCmp, totalLiabilitiesCur, totalLiabilitiesCmp,
    accumulatedSurplusCur, accumulatedSurplusCmp, totalEquityCur, totalEquityCmp,
    fact("ips-infra-opening", "5000000", CCY, SCALE, CURRENT),
    fact("ips-infra-additions", "800000", CCY, SCALE, CURRENT),
    fact("ips-infra-disposals", "200000", CCY, SCALE, CURRENT),
    fact("ips-infra-revaluation", "400000", CCY, SCALE, CURRENT),
  ],
  provenanceOrigin: "TRIAL_BALANCE_DERIVED",
};
