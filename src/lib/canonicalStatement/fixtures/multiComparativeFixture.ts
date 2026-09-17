// canonicalStatement/fixtures/multiComparativeFixture.ts — a report with one
// current period and TWO comparative periods, each with genuinely distinct
// figures. This is the fixture section B's acceptance repair explicitly
// requires: proof that replacing the old singular `comparativeFactId` with
// `factBindings` actually lets the SFP, casting, alignment, and
// missing-comparative rules evaluate the correct fact for each period,
// exactly once — never silently reusing one comparative fact for every
// comparative column, and never conflating one comparative period's figure
// with another's.

import { CANONICAL_CONCEPTS } from "../concepts";
import { CANONICAL_SCHEMA_VERSION } from "../types";
import type { CanonicalFinancialStatementReport } from "../types";
import { CURRENT, fact, line } from "./builders";

const CCY = "TZS";
const SCALE = 2;

const P0 = { periodId: "CURRENT", isComparative: false };
const P1 = { periodId: "COMPARATIVE_1", isComparative: true };
const P2 = { periodId: "COMPARATIVE_2", isComparative: true };

// Three genuinely distinct sets of figures — chosen so that accidentally
// reusing one comparative period's fact for the other would be caught by
// simple inequality assertions in the test file.
const assetsCur = fact("mc-assets-cur", "3000000.00", CCY, SCALE, P0);
const assetsP1 = fact("mc-assets-p1", "2500000.00", CCY, SCALE, P1);
const assetsP2 = fact("mc-assets-p2", "2000000.00", CCY, SCALE, P2);

const liabilitiesCur = fact("mc-liabilities-cur", "1000000.00", CCY, SCALE, P0);
const liabilitiesP1 = fact("mc-liabilities-p1", "900000.00", CCY, SCALE, P1);
const liabilitiesP2 = fact("mc-liabilities-p2", "800000.00", CCY, SCALE, P2);

const equityCur = fact("mc-equity-cur", "2000000.00", CCY, SCALE, P0);
const equityP1 = fact("mc-equity-p1", "1600000.00", CCY, SCALE, P1);
const equityP2 = fact("mc-equity-p2", "1200000.00", CCY, SCALE, P2);

// Assets are cast from two children so the casting rule has something to check per period.
const cashCur = fact("mc-cash-cur", "1800000.00", CCY, SCALE, P0);
const cashP1 = fact("mc-cash-p1", "1500000.00", CCY, SCALE, P1);
const cashP2 = fact("mc-cash-p2", "1200000.00", CCY, SCALE, P2);
const receivablesCur = fact("mc-receivables-cur", "1200000.00", CCY, SCALE, P0);
const receivablesP1 = fact("mc-receivables-p1", "1000000.00", CCY, SCALE, P1);
const receivablesP2 = fact("mc-receivables-p2", "800000.00", CCY, SCALE, P2);

const cashLine = line("mc-cash", "Cash", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP, "DETAIL", cashCur.factId, {
  extraBindings: [
    { periodId: "COMPARATIVE_1", factId: cashP1.factId },
    { periodId: "COMPARATIVE_2", factId: cashP2.factId },
  ],
});
const receivablesLine = line("mc-receivables", "Trade receivables", "trade_receivables", "DETAIL", receivablesCur.factId, {
  extraBindings: [
    { periodId: "COMPARATIVE_1", factId: receivablesP1.factId },
    { periodId: "COMPARATIVE_2", factId: receivablesP2.factId },
  ],
});
const assetsLine = line("mc-assets", "Total assets", CANONICAL_CONCEPTS.TOTAL_ASSETS, "TOTAL", assetsCur.factId, {
  extraBindings: [
    { periodId: "COMPARATIVE_1", factId: assetsP1.factId },
    { periodId: "COMPARATIVE_2", factId: assetsP2.factId },
  ],
  castingChildLineIds: [cashLine.lineId, receivablesLine.lineId],
});
const liabilitiesLine = line("mc-liabilities", "Total liabilities", CANONICAL_CONCEPTS.TOTAL_LIABILITIES, "TOTAL", liabilitiesCur.factId, {
  extraBindings: [
    { periodId: "COMPARATIVE_1", factId: liabilitiesP1.factId },
    { periodId: "COMPARATIVE_2", factId: liabilitiesP2.factId },
  ],
  normalBalance: "CREDIT_NORMAL",
  castingChildLineIds: [], // deliberately no children declared — INSUFFICIENT_EVIDENCE is expected for casting here, not a defect in this fixture's purpose
});
const equityLine = line("mc-equity", "Total equity", CANONICAL_CONCEPTS.TOTAL_EQUITY, "TOTAL", equityCur.factId, {
  extraBindings: [
    { periodId: "COMPARATIVE_1", factId: equityP1.factId },
    { periodId: "COMPARATIVE_2", factId: equityP2.factId },
  ],
  normalBalance: "CREDIT_NORMAL",
  castingChildLineIds: [],
});

export const MULTI_COMPARATIVE_FIXTURE: CanonicalFinancialStatementReport = {
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  reportIdentity: { reportId: "fixture-multi-comparative", companyId: "company-multi-comparative", reportVersion: 1 },
  entity: { legalName: "Example Three-Period Preparer Ltd" },
  period: { periodId: "CURRENT", startDate: "2026-01-01", endDate: "2026-12-31", periodYear: 2026 },
  comparativePeriods: [
    { periodId: "COMPARATIVE_1", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025, isRestated: false },
    { periodId: "COMPARATIVE_2", startDate: "2024-01-01", endDate: "2024-12-31", periodYear: 2024, isRestated: false },
  ],
  framework: { kind: "IFRS" },
  presentationCurrency: { currency: CCY, scale: SCALE, roundingPolicy: { mode: "HALF_UP", scale: SCALE }, presentationMultiplier: 1n },
  statements: [
    {
      statementId: "mc-stmt-sfp",
      type: "STATEMENT_OF_FINANCIAL_POSITION",
      title: "Statement of Financial Position",
      sections: [
        { sectionId: "mc-assets-section", label: "Assets", lines: [cashLine, receivablesLine, assetsLine] },
        { sectionId: "mc-liabilities-section", label: "Liabilities", lines: [liabilitiesLine] },
        { sectionId: "mc-equity-section", label: "Equity", lines: [equityLine] },
      ],
    },
  ],
  notes: [],
  noteReferences: [],
  accountingPolicies: [],
  textualDisclosures: [],
  facts: [
    assetsCur, assetsP1, assetsP2,
    liabilitiesCur, liabilitiesP1, liabilitiesP2,
    equityCur, equityP1, equityP2,
    cashCur, cashP1, cashP2,
    receivablesCur, receivablesP1, receivablesP2,
  ],
  provenanceOrigin: "TRIAL_BALANCE_DERIVED",
};
