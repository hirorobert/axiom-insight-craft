// Phase 5 — synthetic fixtures. ALL accounts, amounts and headers are INDEPENDENTLY INVENTED for this research.
// NOT from cfoclose_tb_fixtures.zip; no private workbook, source figure, screenshot or customer data. No model is involved.
// The vendor-style blocks imitate the SHAPE of common exports (column headers/ordering) only — synthetic pattern tests,
// NOT vendor certification and NOT real vendor files.
import { sha256Hex } from "../prototype/util.mjs";

export function TB(headers, rows) {
  // rows are already full cell arrays aligned to headers.
  return { headers, dataRows: rows, source_digest: sha256Hex(rows) };
}

// A canonical flat TB (Code, Name, Debit, Credit) — the base case. Invented minor units.
export const FLAT = TB(["Account Code", "Account Name", "Debit", "Credit"], [
  ["4000", "Sales", "", 180000000], ["4100", "Sales", "", 9000000], ["4900", "Other income", "", 1200000],
  ["5000", "Cost of goods sold", 72000000, ""], ["6000", "Salaries and wages", 41000000, ""],
  ["6100", "Rent expense", 12000000, ""], ["6200", "Utilities", 3400000, ""],
  ["1000", "Cash at bank", 15500000, ""], ["1010", "Petty cash", 300000, ""],
  ["1200", "Trade receivables", 28000000, ""], ["1300", "Inventory", 19000000, ""],
  ["2000", "Trade payables", "", 22000000], ["2100", "Supplier payable - Northwind", "", 6500000],
  ["2500", "Bank loan", "", 40000000], ["3000", "Share capital", "", 50000000], ["3100", "Retained earnings", "", 70000000],
  ["1500", "Motor vehicles - cost (opening)", 36000000, ""], ["1510", "Motor vehicles - additions", 9000000, ""],
  ["1520", "Motor vehicles - transfers", 2000000, ""], ["1530", "Accumulated depreciation - motor vehicles", "", 14000000],
  ["9999", "Suspense account", 100000, ""],
]);

// QuickBooks-style: "Account" (name only, no separate code column) + "Debit"/"Credit".
export const QUICKBOOKS = TB(["Account", "Debit", "Credit"], [
  ["Sales", "", 90000000], ["Cost of Goods Sold", 36000000, ""], ["Rent Expense", 6000000, ""],
  ["Checking Account", 12000000, ""], ["Accounts Receivable", 14000000, ""], ["Accounts Payable", "", 11000000],
  ["Opening Balance Equity", "", 20000000], ["Retained Earnings", "", 35000000],
]);

// Odoo-style: "Code", "Account Name", "Debit", "Credit", "Balance".
export const ODOO = TB(["Code", "Account Name", "Debit", "Credit", "Balance"], [
  ["400000", "Product Sales", "", 60000000, -60000000], ["600000", "Purchases", 24000000, "", 24000000],
  ["620000", "Wages and salaries", 15000000, "", 15000000], ["101200", "Bank", 8000000, "", 8000000],
  ["411000", "Customers", 9000000, "", 9000000], ["401000", "Suppliers", "", 7000000, -7000000],
  ["101000", "Capital", "", 20000000, -20000000],
]);

// SunSystems-style: "T/B Code", "Description", "YTD Debit", "YTD Credit" — the code header does NOT match our matcher
// (documented limitation; expected outcome: structure NOT recognised).
export const SUNSYSTEMS = TB(["T/B Code", "Description", "YTD Debit", "YTD Credit"], [
  ["SAL001", "Revenue - services", "", 40000000], ["EXP010", "Office rent", 3000000, ""],
  ["AST100", "Bank current account", 6000000, ""], ["LIA200", "Trade creditors", "", 5000000],
]);

// Balanced overall but one account WRONGLY described for its balance side: "Rent income" sitting on the debit side with a
// large balance (expected: recognised as revenue by keyword but its abnormal debit side is consequential uncertainty).
export const WRONGLY_MAPPED = TB(["Account Code", "Account Name", "Debit", "Credit"], [
  ["4000", "Sales", "", 50000000], ["4200", "Rent income", 50000000, ""], // abnormal: income on debit side
  ["1000", "Cash at bank", 50000000, ""], ["2000", "Trade payables", "", 50000000],
]);

// Unexpected balance on a CORRECTLY-IDENTIFIED account: an overdrawn bank/cash account legitimately shows a CREDIT balance.
// The account IS the bank account (identity/mapping correct), yet the abnormal-sign check fires. Used to prove that
// "unexpected balance detected" does NOT establish "incorrect mapping" — a true-positive signal on a correct mapping.
// Balanced: debits 40,000,000 (COGS 20M + receivables 20M) vs credits 40,000,000 (sales 30M + overdraft 10M).
export const OVERDRAFT = TB(["Account Code", "Account Name", "Debit", "Credit"], [
  ["4000", "Sales", "", 30000000], ["5000", "Cost of goods sold", 20000000, ""],
  ["1200", "Trade receivables", 20000000, ""], ["1000", "Bank overdraft", "", 10000000],
]);

// Balanced AND incorrectly mapped, but every sign looks NORMAL — the prototype CANNOT detect it.
// "Prepaid rent" is TRULY a current asset (a prepayment, debit-normal), but the deterministic keyword rule recognises the
// word "rent" as an EXPENSE (also debit-normal). Because both the proposed role (expense) and the true role (asset) are
// debit-normal, the balance sits on the expected side, the abnormal-sign SIGNAL does NOT fire, and the account is grouped
// as an operating expense with no uncertainty. Only a reviewer or corroborating evidence can catch this class of error.
// Balanced: debits 50,000,000 (prepaid 20M + cash 30M) vs credits 50,000,000 (sales).
export const WRONGLY_MAPPED_NORMAL_SIGN = TB(["Account Code", "Account Name", "Debit", "Credit"], [
  ["4000", "Sales", "", 50000000],
  ["1400", "Prepaid rent", 20000000, ""], // TRUE: current asset (prepayment). Prototype recognises -> operating expense. Both DEBIT-normal.
  ["1000", "Cash at bank", 30000000, ""],
]);

// Several UNRECOGNISED / uncertain accounts — for the deliberate manual multi-account selection path. No deterministic
// meaning attaches to these names, so every one is routed to INDIVIDUAL review and never auto-grouped by inferred
// equivalence. A reviewer may select some of them and assign one common treatment explicitly. Balanced: debits 180,000 = credit 180,000.
export const UNCERTAIN = TB(["Account Code", "Account Name", "Debit", "Credit"], [
  ["9000", "Suspense account", 100000, ""], ["9100", "Clearing account", 50000, ""],
  ["9200", "Miscellaneous", 30000, ""], ["9300", "Sundry balances", "", 180000],
]);

// Genuinely IMBALANCED (debits != credits).
export const IMBALANCED = TB(["Account Code", "Account Name", "Debit", "Credit"], [
  ["4000", "Sales", "", 100000000], ["5000", "Cost of goods sold", 40000000, ""], ["1000", "Cash at bank", 30000000, ""],
  // total debit 70,000,000 vs total credit 100,000,000 -> out of balance by 30,000,000.
]);

/** total debit/credit minor units of a TB's data rows (for imbalance checks). Columns: [code,name,debit,credit] or vendor. */
export function totals(tb) {
  const di = tb.headers.findIndex((h) => /debit/i.test(h));
  const ci = tb.headers.findIndex((h) => /credit/i.test(h));
  let d = 0, c = 0;
  for (const r of tb.dataRows) { d += Math.round(Number(r[di] || 0)); c += Math.round(Number(r[ci] || 0)); }
  return { debit: d, credit: c, difference: d - c };
}
