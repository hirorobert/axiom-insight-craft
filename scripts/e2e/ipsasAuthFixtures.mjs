// Pure fixtures for the authenticated IPSAS journey (scripts/e2e/ipsasAuthJourney.mjs). Nothing here touches a network or a database;
// the arithmetic is unit-tested in src/lib/__tests__/ipsasAuthJourney.test.ts. Everything is invented.
//
// An IPSAS accrual entity on the CALENDAR year (so FY2026 begins 2026-01-01 and the grants use the IPSAS 47 vocabulary), with distinct,
// non-round account codes: the reviewed equipment figures (cost 20,000.00; accumulated depreciation 6,000.00 / 4,000.00; depreciation
// expense 2,000.00 — carrying 14,000.00 closing, 16,000.00 opening) plus grant accounts that carry exactly the figures the grants steps
// expect (2026: revenue 6,500,000.00, unfulfilled obligations 5,500,000.00, receivable 4,500,000.00).
import { CODES, TB as BASE_TB } from "./localStackFixtures.mjs";

export const G = { grantsBank: "10458", receivable: "13307", liability: "23318", revenue: "43309" };
// code, name, classification, statement, normal balance, FY2026 debit, FY2026 credit, FY2025 debit, FY2025 credit (major units)
const GRANT_ROWS = [
  [G.grantsBank, "Bank - grants account", "current_assets", "balance_sheet", "debit", "7500000.00", "", "6400000.00", ""],
  [G.receivable, "Grant receivable", "current_assets", "balance_sheet", "debit", "4500000.00", "", "600000.00", ""],
  [G.liability, "Unfulfilled grant obligations", "current_liabilities", "balance_sheet", "credit", "", "5500000.00", "", "3600000.00"],
  [G.revenue, "Grant revenue", "revenue", "income_statement", "credit", "", "6500000.00", "", "3400000.00"],
];
export const TB = [...BASE_TB, ...GRANT_ROWS];
export const CURRENT = 5, PRIOR = 7;
export const tbCsv = (col) => "Account code,Account name,Debit,Credit\n" + TB.map((r) => `${r[0]},${r[1]},${r[col]},${r[col + 1]}`).join("\n") + "\n";
export const PERIODS = { current: { year: 2026, start: "2026-01-01", end: "2026-12-31" }, prior: { year: 2025, start: "2025-01-01", end: "2025-12-31" } };
export const reviewDecisions = () => TB.map(([code, name, cls, st, nb]) => ({ account_code: code, account_name: name, proposal_type: "NONE",
  decision_action: "USER_MANUAL_CLASSIFICATION", statement: st, classification: cls, normal_balance: nb, is_cash_account: code === CODES.bank || code === G.grantsBank }));
/** The trial-balance account keys the journey's steps map (the certified rows are read by these codes). */
export const ACCOUNTS = { ppe: [CODES.equipment, CODES.depreciationAcc], dep: [CODES.depreciation], rev: [G.revenue], liab: [G.liability], recv: [G.receivable] };

const minor = (s) => (s === "" ? 0n : BigInt(s.replace(".", "")));
/** Net of the chosen accounts, in minor units: positive = the stated side. */
export function sumOf(col, codes, side) {
  let t = 0n;
  for (const r of TB) if (codes.includes(r[0])) t += side === "credit" ? minor(r[col + 1]) - minor(r[col]) : minor(r[col]) - minor(r[col + 1]);
  return t;
}
export function imbalance(col) { let d = 0n, c = 0n; for (const r of TB) { d += minor(r[col]); c += minor(r[col + 1]); } return d - c; }
