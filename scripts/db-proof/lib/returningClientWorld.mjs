// A returning client, synthetic: three consecutive years in ONE engagement (FY2024, FY2025, FY2026), built through the real
// functions (real trial-balance engine, real Close Review, real notes/evidence/compilation). Numbers are hand-set so every
// tie holds, and the prior-year accrual is exactly 100.00 (minor 10000) with no settlement and no other activity on its two
// accounts (the accrual is booked on the existing two-period accounts 6100 Professional fees / 2000 Trade payables: an account that exists in one period only blocks sign-off, DEFECT-FS-NEW-ACCOUNT-COMPARATIVE-CASTING-001). Nothing here asserts.
//
//   FY2024 = the kit's FY2025 numbers; FY2025 = the kit's FY2026 numbers (so its evidence is the kit's, re-dated);
//   FY2026 = a new set that continues FY2025 (same balance sheet, same profit, no dividend).
//   The SOURCE LEDGER (what the accounting system exports) never carries the accrual: FY2025 profit 5,100.00 and retained
//   earnings 11,000.00 at its close. The accrual is a reporting adjustment: Dr 6100 100.00 / Cr 2000 100.00 in FY2025.

export const ACCOUNTS = [
  ["1000", "Bank", "current_assets", "balance_sheet", "debit"],
  ["1100", "Trade receivables", "current_assets", "balance_sheet", "debit"],
  ["1200", "Inventory", "current_assets", "balance_sheet", "debit"],
  ["1500", "Equipment at cost", "non_current_assets", "balance_sheet", "debit"],
  ["1510", "Accumulated depreciation", "non_current_assets", "balance_sheet", "credit"],
  ["2000", "Trade payables", "current_liabilities", "balance_sheet", "credit"],
  ["2100", "Income tax payable", "current_liabilities", "balance_sheet", "credit"],
  ["2500", "Bank loan", "non_current_liabilities", "balance_sheet", "credit"],
  ["3000", "Share capital", "equity", "balance_sheet", "credit"],
  ["3100", "Retained earnings", "equity", "balance_sheet", "credit"],
  ["4000", "Sales", "revenue", "income_statement", "credit"],
  ["4100", "Interest income", "other_income", "income_statement", "credit"],
  ["5000", "Cost of sales", "cost_of_goods_sold", "income_statement", "debit"],
  ["6000", "Salaries", "operating_expenses", "income_statement", "debit"],
  ["6100", "Professional fees", "operating_expenses", "income_statement", "debit"],
  ["6200", "Depreciation", "operating_expenses", "income_statement", "debit"],
  ["6300", "Interest expense", "operating_expenses", "income_statement", "debit"],
  ["7000", "Income tax expense", "taxes", "income_statement", "debit"],
];

const D = (n) => [`${n}.00`, ""], C = (n) => ["", `${n}.00`];
export const LEDGER = {
  2024: { 1000: D(8000), 1100: D(3000), 1200: D(1800), 1500: D(20000), 1510: C(4000), 2000: C(2500), 2100: C(700), 2500: C(9000), 3000: C(10000), 3100: C(3500), 4000: C(25000), 4100: C(400), 5000: D(11500), 6000: D(5000), 6100: D(2400), 6200: D(2000), 6300: D(700), 7000: D(700) },
  2025: { 1000: D(12500), 1100: D(4300), 1200: D(2200), 1500: D(20000), 1510: C(6000), 2000: C(3100), 2100: C(900), 2500: C(8000), 3000: C(10000), 3100: C(5900), 4000: C(30000), 4100: C(500), 5000: D(14000), 6000: D(5500), 6100: D(2400), 6200: D(2000), 6300: D(600), 7000: D(900) },
  // FY2026: the balance sheet of FY2025, the same profit, no dividend; retained earnings is the ledger's (it never saw the accrual).
  2026: { 1000: D(19600), 1100: D(4300), 1200: D(2200), 1500: D(20000), 1510: C(8000), 2000: C(3100), 2100: C(900), 2500: C(8000), 3000: C(10000), 3100: C(11000), 4000: C(30000), 4100: C(500), 5000: D(14000), 6000: D(5500), 6100: D(2400), 6200: D(2000), 6300: D(600), 7000: D(900) },
};

export const rowsFor = (year) => ACCOUNTS.filter(([code]) => LEDGER[year][code]).map(([code, name, cls, st, nb]) => [code, name, cls, st, nb, ...LEDGER[year][code]]);
export const tbCsv = (year) => "Account code,Account name,Debit,Credit\n" + rowsFor(year).map((r) => `${r[0]},${r[1]},${r[5]},${r[6]}`).join("\n") + "\n";
export const ASSIGN_RC = {
  1000: "sfp.cash_and_cash_equivalents", 1100: "sfp.trade_and_other_receivables", 1200: "sfp.inventories", 1500: "sfp.property_plant_and_equipment", 1510: "sfp.property_plant_and_equipment",
  2000: "sfp.trade_and_other_payables", 2100: "sfp.current_tax", 2500: "sfp.other_financial_liabilities",
  3000: "sfp.equity_attributable_to_owners", 3100: "sfp.equity_attributable_to_owners", 4000: "sci.revenue", 4100: "sci.other_income", 5000: "sci.cost_of_sales",
  6000: "sci.operating_expenses_by_function", 6100: "sci.operating_expenses_by_function", 6200: "sci.operating_expenses_by_function", 6300: "sci.finance_costs", 7000: "sci.tax_expense",
};

/** The prior-year accrual: Dr 6100 / Cr 2000, 100.00 (minor units). */
export const ACCRUAL_MINOR = "10000";
export const ACCRUAL_LINES = [{ accountKey: "6100", debitMinor: ACCRUAL_MINOR, creditMinor: "0" }, { accountKey: "2000", debitMinor: "0", creditMinor: ACCRUAL_MINOR }];
/** Its opening-position counterpart in the next year: Dr 3100 (opening equity) / Cr 2000 (payable). */
export const OPENING_LINES = [{ accountKey: "3100", debitMinor: ACCRUAL_MINOR, creditMinor: "0" }, { accountKey: "2000", debitMinor: "0", creditMinor: ACCRUAL_MINOR }];

const ledgerRows = (rows, prefix, y) => ["transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line",
  ...rows.map(([id, md, desc, rec, pay, act, line]) => `${prefix}${id},${y}-${md},1000,${desc},${rec},${pay},${act},${line}`)].join("\n") + "\n";
const MOVES_25 = [["1", "03-31", "Receipts from customers", "28700.00", "", "OPERATING", "Receipts from customers"], ["2", "06-30", "Payments to suppliers and employees", "", "21700.00", "OPERATING", "Payments to suppliers and employees"],
  ["3", "07-15", "Interest received", "500.00", "", "OPERATING", "Interest received"], ["4", "09-30", "Loan repayment", "", "1000.00", "FINANCING", "Repayment of borrowings"],
  ["5", "11-30", "Dividend paid", "", "700.00", "FINANCING", "Dividends paid"], ["6", "12-15", "Income tax paid", "", "700.00", "OPERATING", "Income tax paid"], ["7", "12-20", "Interest paid", "", "600.00", "OPERATING", "Interest paid"]];
const MOVES_26 = [["1", "03-31", "Receipts from customers", "30000.00", "", "OPERATING", "Receipts from customers"], ["2", "06-30", "Payments to suppliers and employees", "", "21900.00", "OPERATING", "Payments to suppliers and employees"],
  ["3", "07-15", "Interest received", "500.00", "", "OPERATING", "Interest received"], ["4", "12-15", "Income tax paid", "", "900.00", "OPERATING", "Income tax paid"], ["5", "12-20", "Interest paid", "", "600.00", "OPERATING", "Interest paid"],
  // The registered control for a line that exists in the other period only: an explicit nil row with the SAME label in both periods.
  ["6", "12-31", "Loan repayment", "", "0.00", "FINANCING", "Repayment of borrowings"], ["7", "12-31", "Dividend paid", "", "0.00", "FINANCING", "Dividends paid"]];
const MOVES_24 = [["1", "03-31", "Receipts from customers", "24600.00", "", "OPERATING", "Receipts from customers"], ["2", "06-30", "Payments to suppliers and employees", "", "19100.00", "OPERATING", "Payments to suppliers and employees"],
  ["3", "07-15", "Interest received", "400.00", "", "OPERATING", "Interest received"], ["4", "09-30", "Loan repayment", "", "1000.00", "FINANCING", "Repayment of borrowings"],
  ["5", "12-15", "Income tax paid", "", "500.00", "OPERATING", "Income tax paid"], ["6", "12-20", "Interest paid", "", "700.00", "OPERATING", "Interest paid"], ["7", "11-30", "Dividend paid", "", "700.00", "FINANCING", "Dividends paid"]];
const equity = (open, profit, div, close) => ["component,movement_type,amount,description", "Share capital,OPENING_BALANCE,10000.00,", "Share capital,CLOSING_BALANCE,10000.00,",
  `Retained earnings,OPENING_BALANCE,${open},`, `Retained earnings,PROFIT_OR_LOSS,${profit},`, `Retained earnings,DIVIDENDS_OR_DISTRIBUTIONS,${div ? `-${div}` : "0.00"},Final dividend`, `Retained earnings,CLOSING_BALANCE,${close},`].join("\n") + "\n";
const CASHMAP = "account_key,category,effect,include_in_cash_flow,note\n1000,BANK_ACCOUNT,ADD,Y,Main operating account\n";
const prior = (y, opening) => `statement_type,line_key,line_label,amount\nCASH_FLOWS,cash_and_cash_equivalents_opening_cf,Cash and cash equivalents at 1 January ${y},${opening}\n`;

/**
 * The evidence of a report year, CURRENT and COMPARATIVE role. `accrualInPriorYear`: the FY2025 profit and closing retained
 * earnings AS REPORTED include the approved accrual (profit 5,000.00; closing 10,900.00) - FY2026's opening equity and its
 * comparative follow it.
 */
export function evidenceFor(year, { accrualInPriorYear }) {
  const p25 = accrualInPriorYear ? "5000.00" : "5100.00", c25 = accrualInPriorYear ? "10900.00" : "11000.00";
  if (year === 2025) return {
    CURRENT: { TRANSACTION_LEDGER: ledgerRows(MOVES_25, "T", 2025), EQUITY_MOVEMENTS: equity("6600.00", p25, "700.00", c25), CASH_ACCOUNT_MAP: CASHMAP },
    COMPARATIVE: { TRANSACTION_LEDGER: ledgerRows(MOVES_24, "P", 2024), EQUITY_MOVEMENTS: equity("4200.00", "3100.00", "700.00", "6600.00"), PRIOR_PERIOD_STATEMENTS: prior(2024, "5000.00") },
  };
  return {
    CURRENT: { TRANSACTION_LEDGER: ledgerRows(MOVES_26, "T", 2026), EQUITY_MOVEMENTS: equity(c25, "5100.00", null, accrualInPriorYear ? "16000.00" : "16100.00"), CASH_ACCOUNT_MAP: CASHMAP },
    COMPARATIVE: { TRANSACTION_LEDGER: ledgerRows(MOVES_25, "P", 2025), EQUITY_MOVEMENTS: equity("6600.00", p25, "700.00", c25), PRIOR_PERIOD_STATEMENTS: prior(2025, "8000.00") },
  };
}

export const WORDS = (y) => ({
  "smes.note.going_concern": "Management assessed the entity's ability to continue as a going concern for at least twelve months from the authorisation date and identified no material uncertainties.",
  "smes.note.authorisation": `These financial statements were authorised for issue by the board of directors on 28 February ${y + 1}.`,
  "smes.note.kmp_compensation": `Key management personnel compensation for the year totalled TZS 1,800.00 (${y - 1}: TZS 1,700.00), all short-term employee benefits.`,
  "smes.note.cash_components": "Cash and cash equivalents comprise the balance at Synthetic Bank; there are no restricted balances or overdrafts.",
  "smes.note.income_tax": `Tax expense of TZS 900.00 (${y - 1}: TZS 900.00) is current tax at the statutory rate; there is no deferred tax.`,
  "smes.note.revenue": `Revenue is recognised when goods are delivered; all revenue is from the sale of goods: TZS 30,000.00 (${y - 1}: TZS 30,000.00).`,
  "smes.note.compliance": "Prepared in accordance with the IFRS for SMEs (2015 edition).", "smes.note.identification": `Returning Client Limited; year ended 31 December ${y}; TZS.`,
  "smes.note.policies": "Historical cost.", "smes.note.judgements": "None beyond estimates.", "smes.note.estimates": "Useful lives.", "smes.note.subclassifications": "All receivables from third parties.",
  "smes.note.share_capital": "10,000 ordinary shares, fully paid.",
});
export const PPE = (y) => (y === 2025 ? [{ classLabel: "Equipment", openingMinor: "1600000", closingMinor: "1400000", movements: [{ kind: "depreciation", amountMinor: "-200000" }] }]
  : [{ classLabel: "Equipment", openingMinor: "1400000", closingMinor: "1200000", movements: [{ kind: "depreciation", amountMinor: "-200000" }] }]);
