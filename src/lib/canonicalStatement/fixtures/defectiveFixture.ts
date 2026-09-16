// canonicalStatement/fixtures/defectiveFixture.ts — an adversarial fixture
// that deliberately trips every one of the ten canonical rules into a real
// FAIL (or, where a defect legitimately produces one, INSUFFICIENT_EVIDENCE)
// in one place, so the FAIL path of the whole rule pack is exercised
// end-to-end. See defectiveFixture.test.ts for the exact expectations this
// fixture is built to satisfy.
//
// Deliberate defects, each isolated to its own fact/line where practical:
//   1. SFP equation:            total_assets fact is wrong (2,850,000 vs the true 2,800,000).
//   2. Subtotal casting:        total_assets's declared children sum to 2,800,000, not the reported 2,850,000.
//   3. Note-to-face:            the PPE note's reported closing balance (2,100,000) != the face PPE line (2,000,000).
//   4. Comparative alignment:   the cash line's comparative fact uses an undeclared period id.
//   5. Currency/scale:          "Other financial assets" is booked in USD while the report presents in TZS.
//   6. Cash-flow closing cash:  the cash-flow statement's closing cash (550,000) != SFP cash (500,000).
//   7. Movement reconciliation: the PPE note's own roll-forward doesn't sum to its own reported closing balance.
//   8. Duplicate detection:     a second "total_assets" TOTAL line, and two facts sharing one fingerprint.
//   9. Missing comparative:     total_assets has no comparative fact at all.
//  10. Broken/orphaned notes:   one reference to a non-existent note, one from a non-existent line.

import { CANONICAL_CONCEPTS } from "../concepts";
import { CANONICAL_SCHEMA_VERSION } from "../types";
import type { CanonicalFinancialStatementReport, ReportingPeriodRef } from "../types";
import { COMPARATIVE_1, CURRENT, fact, line, provenance } from "./builders";

const CCY = "TZS";
const SCALE = 2;
const ROGUE_PERIOD: ReportingPeriodRef = { periodId: "COMPARATIVE_ROGUE", isComparative: true };

const ppeNetCur = fact("defect-ppe-cur", "2000000.00", CCY, SCALE, CURRENT);
const ppeNetCmp = fact("defect-ppe-cmp", "1800000.00", CCY, SCALE, COMPARATIVE_1);
const cashCur = fact("defect-cash-cur", "500000.00", CCY, SCALE, CURRENT);
const cashCmp = { ...fact("defect-cash-cmp", "400000.00", CCY, SCALE, COMPARATIVE_1), reportingPeriod: ROGUE_PERIOD }; // defect 4: undeclared period
const receivablesCur = fact("defect-receivables-cur", "300000.00", CCY, SCALE, CURRENT);
const totalAssetsCur = fact("defect-total-assets-cur", "2850000.00", CCY, SCALE, CURRENT); // defects 1 & 2: should be 2,800,000

const otherFinancialAssetsCur = fact("defect-other-fin-assets-cur", "50000.00", "USD", SCALE, CURRENT); // defect 5: wrong currency

const payablesCur = fact("defect-payables-cur", "300000.00", CCY, SCALE, CURRENT);
const payablesCmp = fact("defect-payables-cmp", "250000.00", CCY, SCALE, COMPARATIVE_1);
const totalLiabilitiesCur = fact("defect-total-liabilities-cur", "300000.00", CCY, SCALE, CURRENT);
const totalLiabilitiesCmp = fact("defect-total-liabilities-cmp", "250000.00", CCY, SCALE, COMPARATIVE_1);

const shareCapitalCur = fact("defect-share-capital-cur", "1000000.00", CCY, SCALE, CURRENT);
const shareCapitalCmp = fact("defect-share-capital-cmp", "1000000.00", CCY, SCALE, COMPARATIVE_1);
const retainedEarningsCur = fact("defect-retained-earnings-cur", "1500000.00", CCY, SCALE, CURRENT);
const retainedEarningsCmp = fact("defect-retained-earnings-cmp", "1200000.00", CCY, SCALE, COMPARATIVE_1);
const totalEquityCur = fact("defect-total-equity-cur", "2500000.00", CCY, SCALE, CURRENT);
const totalEquityCmp = fact("defect-total-equity-cmp", "2200000.00", CCY, SCALE, COMPARATIVE_1);

const grandTotalAssetsDuplicateCur = fact("defect-grand-total-assets-cur", "2850000.00", CCY, SCALE, CURRENT); // defect 8a

const closingCashCfCur = fact("defect-closing-cash-cf-cur", "550000.00", CCY, SCALE, CURRENT); // defect 6: should equal SFP cash (500,000)

const ppeOpening = fact("defect-ppe-opening", "1800000.00", CCY, SCALE, CURRENT);
const ppeAdditions = fact("defect-ppe-additions", "200000.00", CCY, SCALE, CURRENT);
const ppeDisposals = fact("defect-ppe-disposals", "100000.00", CCY, SCALE, CURRENT);
const ppeNoteClosing = fact("defect-ppe-note-closing", "2100000.00", CCY, SCALE, CURRENT); // defects 3 & 7: != face (2,000,000) and != its own roll-forward (1,900,000)

const duplicateFingerprintLocator = { kind: "MANUAL" as const, note: "duplicate-source-cell" };
const duplicateFactA = { ...fact("defect-dup-a", "777000.00", CCY, SCALE, CURRENT), provenance: provenance("777,000.00", duplicateFingerprintLocator) };
const duplicateFactB = { ...fact("defect-dup-b", "777000.00", CCY, SCALE, CURRENT), provenance: provenance("777,000.00", duplicateFingerprintLocator) }; // defect 8b: identical fingerprint, different factId

const ppeLine = line("defect-sfp-ppe", "Property, plant and equipment", "ppe_net", "DETAIL", ppeNetCur.factId, {
  comparativeFactId: ppeNetCmp.factId,
  noteReferenceIds: ["nr-ppe-valid", "nr-broken"],
});
const cashLine = line("defect-sfp-cash", "Cash and cash equivalents", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP, "DETAIL", cashCur.factId, {
  comparativeFactId: cashCmp.factId,
});
const receivablesLine = line("defect-sfp-receivables", "Trade receivables", "trade_receivables", "DETAIL", receivablesCur.factId);
const otherFinancialAssetsLine = line("defect-sfp-other-fin-assets", "Other financial assets", "other_financial_assets", "DETAIL", otherFinancialAssetsCur.factId);
const totalAssetsLine = line("defect-sfp-total-assets", "Total assets", CANONICAL_CONCEPTS.TOTAL_ASSETS, "TOTAL", totalAssetsCur.factId, {
  // defect 9: no comparativeFactId, even though this report declares comparatives.
  castingChildLineIds: [ppeLine.lineId, cashLine.lineId, receivablesLine.lineId],
});
const grandTotalAssetsDuplicateLine = line(
  "defect-sfp-total-assets-duplicate",
  "Grand total assets",
  CANONICAL_CONCEPTS.TOTAL_ASSETS, // defect 8a: same concept + role as totalAssetsLine
  "TOTAL",
  grandTotalAssetsDuplicateCur.factId,
);

const payablesLine = line("defect-sfp-payables", "Trade payables", "trade_payables", "DETAIL", payablesCur.factId, {
  comparativeFactId: payablesCmp.factId,
  normalBalance: "CREDIT_NORMAL",
});
const totalLiabilitiesLine = line("defect-sfp-total-liabilities", "Total liabilities", CANONICAL_CONCEPTS.TOTAL_LIABILITIES, "TOTAL", totalLiabilitiesCur.factId, {
  comparativeFactId: totalLiabilitiesCmp.factId,
  normalBalance: "CREDIT_NORMAL",
  castingChildLineIds: [payablesLine.lineId],
});

const shareCapitalLine = line("defect-sfp-share-capital", "Share capital", "share_capital", "DETAIL", shareCapitalCur.factId, {
  comparativeFactId: shareCapitalCmp.factId,
  normalBalance: "CREDIT_NORMAL",
});
const retainedEarningsLine = line("defect-sfp-retained-earnings", "Retained earnings", "retained_earnings", "DETAIL", retainedEarningsCur.factId, {
  comparativeFactId: retainedEarningsCmp.factId,
  normalBalance: "CREDIT_NORMAL",
});
const totalEquityLine = line("defect-sfp-total-equity", "Total equity", CANONICAL_CONCEPTS.TOTAL_EQUITY, "TOTAL", totalEquityCur.factId, {
  comparativeFactId: totalEquityCmp.factId,
  normalBalance: "CREDIT_NORMAL",
  castingChildLineIds: [shareCapitalLine.lineId, retainedEarningsLine.lineId],
});

const duplicateDisclosureALine = line("defect-dup-disclosure-a", "Duplicate disclosure A", "duplicate_disclosure_a", "DETAIL", duplicateFactA.factId);
const duplicateDisclosureBLine = line("defect-dup-disclosure-b", "Duplicate disclosure B", "duplicate_disclosure_b", "DETAIL", duplicateFactB.factId);

const closingCashLine = line("defect-cf-closing-cash", "Cash and cash equivalents at end of period", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF, "DETAIL", closingCashCfCur.factId);

export const DEFECTIVE_FIXTURE: CanonicalFinancialStatementReport = {
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  reportIdentity: { reportId: "fixture-defective", companyId: "company-defective", reportVersion: 1 },
  entity: { legalName: "Example Defective Preparer Ltd" },
  period: { periodId: "CURRENT", startDate: "2026-01-01", endDate: "2026-12-31", periodYear: 2026 },
  comparativePeriods: [{ periodId: "COMPARATIVE_1", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025, isRestated: false }],
  framework: { kind: "IFRS" },
  presentationCurrency: { currency: CCY, scale: SCALE, roundingPolicy: { mode: "HALF_UP", scale: SCALE }, presentationMultiplier: 1n },
  statements: [
    {
      statementId: "defect-stmt-sfp",
      type: "STATEMENT_OF_FINANCIAL_POSITION",
      title: "Statement of Financial Position",
      sections: [
        {
          sectionId: "defect-sfp-assets",
          label: "Assets",
          lines: [ppeLine, cashLine, receivablesLine, otherFinancialAssetsLine, totalAssetsLine, grandTotalAssetsDuplicateLine, duplicateDisclosureALine, duplicateDisclosureBLine],
        },
        { sectionId: "defect-sfp-liabilities", label: "Liabilities", lines: [payablesLine, totalLiabilitiesLine] },
        { sectionId: "defect-sfp-equity", label: "Equity", lines: [shareCapitalLine, retainedEarningsLine, totalEquityLine] },
      ],
    },
    {
      statementId: "defect-stmt-cf",
      type: "STATEMENT_OF_CASH_FLOWS",
      title: "Statement of Cash Flows",
      sections: [{ sectionId: "defect-cf-body", label: "Cash flow", lines: [closingCashLine] }],
    },
  ],
  notes: [
    {
      noteId: "note-ppe",
      noteNumber: "5",
      title: "Property, plant and equipment",
      monetaryFactIds: [ppeOpening.factId, ppeAdditions.factId, ppeDisposals.factId, ppeNoteClosing.factId],
      movementSchedule: {
        scheduleId: "ppe-movement",
        openingBalanceFactId: ppeOpening.factId,
        additionFactIds: [ppeAdditions.factId],
        disposalFactIds: [ppeDisposals.factId],
        otherMovements: [],
        closingBalanceFactId: ppeNoteClosing.factId,
      },
    },
  ],
  noteReferences: [
    { noteReferenceId: "nr-ppe-valid", fromLineId: ppeLine.lineId, toNoteId: "note-ppe" },
    { noteReferenceId: "nr-broken", fromLineId: ppeLine.lineId, toNoteId: "note-does-not-exist" },
    { noteReferenceId: "nr-orphaned", fromLineId: "line-does-not-exist", toNoteId: "note-ppe" },
  ],
  accountingPolicies: [],
  textualDisclosures: [],
  facts: [
    ppeNetCur, ppeNetCmp, cashCur, cashCmp, receivablesCur, totalAssetsCur, otherFinancialAssetsCur,
    payablesCur, payablesCmp, totalLiabilitiesCur, totalLiabilitiesCmp,
    shareCapitalCur, shareCapitalCmp, retainedEarningsCur, retainedEarningsCmp, totalEquityCur, totalEquityCmp,
    grandTotalAssetsDuplicateCur, closingCashCfCur, ppeOpening, ppeAdditions, ppeDisposals, ppeNoteClosing,
    duplicateFactA, duplicateFactB,
  ],
  provenanceOrigin: "TRIAL_BALANCE_DERIVED",
};
