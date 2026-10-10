// Pure fixtures and guards for the real-application journey on a LOCAL Supabase stack (scripts/e2e/localStackJourney.mjs).
// Unit-tested in src/lib/__tests__/localStackJourney.test.ts. Nothing here touches a network or a database.
//
// The company reports on a NON-CALENDAR year (1 July – 30 June) with DISTINCT, non-round account codes, so nothing in the
// journey can pass by accident on a calendar-year or a demo-code assumption (no "1000 = bank", no 91000).

import { PRODUCTION_PROJECT_REF } from "../ci/stagingGuard.mjs";

/** Refuses anything that is not the local stack: loopback host, no production reference anywhere. */
export function assertLocalStack({ apiUrl, anonKey, serviceRoleKey }) {
  let u;
  try { u = new URL(apiUrl); } catch { throw new Error("LOCAL_STACK_REFUSED: the API URL is not a URL"); }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname)) throw new Error("LOCAL_STACK_REFUSED: the API is not on loopback");
  for (const v of [apiUrl, anonKey, serviceRoleKey]) {
    if (typeof v !== "string" || v.length < 10) throw new Error("LOCAL_STACK_REFUSED: a key is missing");
    if (v.includes(PRODUCTION_PROJECT_REF)) throw new Error("LOCAL_STACK_REFUSED: a production reference was supplied");
  }
  return { origin: u.origin };
}

/** A built bundle may name the local API and must not name production. */
export function verifyLocalBundle(texts, apiOrigin) {
  const problems = [];
  if (texts.some((t) => t.includes(PRODUCTION_PROJECT_REF))) problems.push("PRODUCTION_REF_IN_BUNDLE");
  if (!texts.some((t) => t.includes(apiOrigin))) problems.push("LOCAL_API_NOT_IN_BUNDLE");
  return problems;
}

// Account code, name, classification, statement, normal balance, FY2026 debit, FY2026 credit, FY2025 debit, FY2025 credit.
// Amounts are those of the reviewed reporting fixture (scripts/db-proof/lib/reportingKit.mjs, balanced in both years);
// only the codes and the period dates differ.
export const CODES = { bank: "10457", receivables: "11263", inventory: "12318", equipment: "15502", depreciationAcc: "15519",
  payables: "20734", tax: "21186", loan: "25541", capital: "30019", retained: "31027", sales: "40088", interestIncome: "41093",
  costOfSales: "50061", salaries: "60142", rent: "61175", depreciation: "62204", interestExpense: "63311", taxExpense: "70096" };
const C = CODES;
export const TB = [
  [C.bank, "Operating bank account", "current_assets", "balance_sheet", "debit", "12500.00", "", "8000.00", ""],
  [C.receivables, "Trade receivables", "current_assets", "balance_sheet", "debit", "4300.00", "", "3000.00", ""],
  [C.inventory, "Inventory", "current_assets", "balance_sheet", "debit", "2200.00", "", "1800.00", ""],
  [C.equipment, "Equipment at cost", "non_current_assets", "balance_sheet", "debit", "20000.00", "", "20000.00", ""],
  [C.depreciationAcc, "Accumulated depreciation", "non_current_assets", "balance_sheet", "credit", "", "6000.00", "", "4000.00"],
  [C.payables, "Trade payables", "current_liabilities", "balance_sheet", "credit", "", "3100.00", "", "2500.00"],
  [C.tax, "Income tax payable", "current_liabilities", "balance_sheet", "credit", "", "900.00", "", "700.00"],
  [C.loan, "Bank loan", "non_current_liabilities", "balance_sheet", "credit", "", "8000.00", "", "9000.00"],
  [C.capital, "Share capital", "equity", "balance_sheet", "credit", "", "10000.00", "", "10000.00"],
  [C.retained, "Retained earnings", "equity", "balance_sheet", "credit", "", "5900.00", "", "3500.00"],
  [C.sales, "Sales", "revenue", "income_statement", "credit", "", "30000.00", "", "25000.00"],
  [C.interestIncome, "Interest income", "other_income", "income_statement", "credit", "", "500.00", "", "400.00"],
  [C.costOfSales, "Cost of sales", "cost_of_goods_sold", "income_statement", "debit", "14000.00", "", "11500.00", ""],
  [C.salaries, "Salaries", "operating_expenses", "income_statement", "debit", "5500.00", "", "5000.00", ""],
  [C.rent, "Rent", "operating_expenses", "income_statement", "debit", "2400.00", "", "2400.00", ""],
  [C.depreciation, "Depreciation", "operating_expenses", "income_statement", "debit", "2000.00", "", "2000.00", ""],
  [C.interestExpense, "Interest expense", "operating_expenses", "income_statement", "debit", "600.00", "", "700.00", ""],
  [C.taxExpense, "Income tax expense", "taxes", "income_statement", "debit", "900.00", "", "700.00", ""],
];
export const CURRENT = 5, PRIOR = 7;
export const tbCsv = (col) => "Account code,Account name,Debit,Credit\n" + TB.map((r) => `${r[0]},${r[1]},${r[col]},${r[col + 1]}`).join("\n") + "\n";

/** The period dates: FY2026 is 1 July 2025 – 30 June 2026; FY2025 the year before. */
export const PERIODS = { current: { year: 2026, start: "2025-07-01", end: "2026-06-30" }, prior: { year: 2025, start: "2024-07-01", end: "2025-06-30" } };

/** Review decisions for every account, exactly as the account review records them; the bank is the one cash account. */
export const reviewDecisions = () => TB.map(([code, name, cls, st, nb]) => ({ account_code: code, account_name: name, proposal_type: "NONE",
  decision_action: "USER_MANUAL_CLASSIFICATION", statement: st, classification: cls, normal_balance: nb, is_cash_account: code === C.bank }));

export const ASSIGN = {
  [C.bank]: "sfp.cash_and_cash_equivalents", [C.receivables]: "sfp.trade_and_other_receivables", [C.inventory]: "sfp.inventories",
  [C.equipment]: "sfp.property_plant_and_equipment", [C.depreciationAcc]: "sfp.property_plant_and_equipment",
  [C.payables]: "sfp.trade_and_other_payables", [C.tax]: "sfp.current_tax", [C.loan]: "sfp.other_financial_liabilities",
  [C.capital]: "sfp.equity_attributable_to_owners", [C.retained]: "sfp.equity_attributable_to_owners",
  [C.sales]: "sci.revenue", [C.interestIncome]: "sci.other_income", [C.costOfSales]: "sci.cost_of_sales",
  [C.salaries]: "sci.operating_expenses_by_function", [C.rent]: "sci.operating_expenses_by_function", [C.depreciation]: "sci.operating_expenses_by_function",
  [C.interestExpense]: "sci.finance_costs", [C.taxExpense]: "sci.tax_expense",
};

/** Evidence for both years, dated inside the July–June periods. Ties to the trial balances exactly as the reviewed fixture. */
export const EVIDENCE = {
  current: {
    TRANSACTION_LEDGER: ["transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line",
      `T1,2025-09-30,${C.bank},Receipts from customers,28700.00,,OPERATING,Receipts from customers`,
      `T2,2025-12-31,${C.bank},Payments to suppliers and employees,,21700.00,OPERATING,Payments to suppliers and employees`,
      `T3,2026-01-15,${C.bank},Interest received,500.00,,OPERATING,Interest received`,
      `T4,2026-03-31,${C.bank},Loan repayment,,1000.00,FINANCING,Repayment of borrowings`,
      `T5,2026-05-31,${C.bank},Dividend paid,,700.00,FINANCING,Dividends paid`,
      `T6,2026-06-15,${C.bank},Income tax paid,,700.00,OPERATING,Income tax paid`,
      `T7,2026-06-20,${C.bank},Interest paid,,600.00,OPERATING,Interest paid`].join("\n") + "\n",
    EQUITY_MOVEMENTS: ["component,movement_type,amount,description", "Share capital,OPENING_BALANCE,10000.00,", "Share capital,CLOSING_BALANCE,10000.00,",
      "Retained earnings,OPENING_BALANCE,6600.00,", "Retained earnings,PROFIT_OR_LOSS,5100.00,", "Retained earnings,DIVIDENDS_OR_DISTRIBUTIONS,-700.00,Final dividend",
      "Retained earnings,CLOSING_BALANCE,11000.00,"].join("\n") + "\n",
    CASH_ACCOUNT_MAP: `account_key,category,effect,include_in_cash_flow,note\n${C.bank},BANK_ACCOUNT,ADD,Y,Main operating account\n`,
  },
  prior: {
    TRANSACTION_LEDGER: ["transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line",
      `P1,2024-09-30,${C.bank},Receipts from customers,24600.00,,OPERATING,Receipts from customers`,
      `P2,2024-12-31,${C.bank},Payments to suppliers and employees,,19100.00,OPERATING,Payments to suppliers and employees`,
      `P3,2025-01-15,${C.bank},Interest received,400.00,,OPERATING,Interest received`,
      `P4,2025-03-31,${C.bank},Loan repayment,,1000.00,FINANCING,Repayment of borrowings`,
      `P5,2025-06-15,${C.bank},Income tax paid,,500.00,OPERATING,Income tax paid`,
      `P6,2025-06-20,${C.bank},Interest paid,,700.00,OPERATING,Interest paid`,
      `P7,2025-05-31,${C.bank},Dividend paid,,700.00,FINANCING,Dividends paid`].join("\n") + "\n",
    EQUITY_MOVEMENTS: ["component,movement_type,amount,description", "Share capital,OPENING_BALANCE,10000.00,", "Share capital,CLOSING_BALANCE,10000.00,",
      "Retained earnings,OPENING_BALANCE,4200.00,", "Retained earnings,PROFIT_OR_LOSS,3100.00,", "Retained earnings,DIVIDENDS_OR_DISTRIBUTIONS,-700.00,Final dividend",
      "Retained earnings,CLOSING_BALANCE,6600.00,"].join("\n") + "\n",
    PRIOR_PERIOD_STATEMENTS: "statement_type,line_key,line_label,amount\nCASH_FLOWS,cash_and_cash_equivalents_opening_cf,Cash and cash equivalents at 1 July 2024,5000.00\n",
  },
};
/** The evidence file inputs on Financial Statements › Statements (data-slot) and the fixture each receives. */
export const EVIDENCE_SLOTS = [
  ["TRANSACTION_LEDGER|CURRENT", "current", "TRANSACTION_LEDGER"], ["EQUITY_MOVEMENTS|CURRENT", "current", "EQUITY_MOVEMENTS"],
  ["CASH_ACCOUNT_MAP|CURRENT", "current", "CASH_ACCOUNT_MAP"], ["TRANSACTION_LEDGER|COMPARATIVE", "prior", "TRANSACTION_LEDGER"],
  ["EQUITY_MOVEMENTS|COMPARATIVE", "prior", "EQUITY_MOVEMENTS"], ["PRIOR_PERIOD_STATEMENTS|COMPARATIVE", "prior", "PRIOR_PERIOD_STATEMENTS"],
];

/** Notes wording and decisions for the 2015 edition (period starts before 2027), as a preparer records them. */
export const NOTES = {
  "smes.note.compliance": "Prepared in accordance with the IFRS for SMEs (2015 edition).",
  "smes.note.identification": "Mto Holdings Limited; year ended 30 June 2026; TZS.",
  "smes.note.policies": "Historical cost.", "smes.note.judgements": "None beyond estimates.", "smes.note.estimates": "Useful lives of equipment.",
  "smes.note.subclassifications": "All receivables from third parties.", "smes.note.share_capital": "10,000 ordinary shares, fully paid.",
};
export const NOT_APPLICABLE = ["smes.sci.5_5_e", "smes.sci.5_5_g", "smes.sci.5_5_h"];
export const PPE_SCHEDULE = [{ classLabel: "Equipment", openingMinor: "1600000", closingMinor: "1400000", movements: [{ kind: "depreciation", amountMinor: "-200000" }] }];
