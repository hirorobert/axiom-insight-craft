// Builds src/lib/ingestion/__fixtures__/tally/tally-detailed-fy2025.xlsx — a SYNTHETIC Tally-style workbook (see that
// folder's README). The same detailed report as tally-detailed-fy2025.csv, with the two-row header ("Closing Balance"
// over Debit / Credit) and NUMBER cells. Run from the repository root:  node scripts/dev/make-tally-fixture.mjs
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";

const rows = [
  ["Mfano Traders Limited", null, null],
  ["Trial Balance", null, null],
  ["1-Jan-2025 to 31-Dec-2025", null, null],
  [null, null, null],
  ["Particulars", "Closing Balance", null],
  [null, "Debit", "Credit"],
  ["Capital Account", null, 5000000],
  ["  Share Capital", null, 5000000],
  ["Current Liabilities", null, 1250000],
  ["  Duties & Taxes", null, 250000],
  ["    VAT Payable", null, 250000],
  ["  Sundry Creditors", null, 1000000],
  ["    Kariakoo Suppliers Ltd", null, 700000],
  ["    Mlimani Wholesalers", null, 300000],
  ["Current Assets", 4800000, null],
  ["  Bank Accounts", 3000000, null],
  ["    CRDB Bank - Current A/c", 3000000, null],
  ["  Cash-in-hand", 100000, null],
  ["    Cash", 100000, null],
  ["  Sundry Debtors", 1700000, null],
  ["    Azania Retail", 1200000, null],
  ["    Kigamboni Stores", 500000, null],
  ["Fixed Assets", 2000000, null],
  ["  Office Equipment", 2000000, null],
  ["Sales Accounts", null, 8500000],
  ["  Sales - Local", null, 8500000],
  ["Purchase Accounts", 6000000, null],
  ["  Purchases - Local", 6000000, null],
  ["Indirect Expenses", 1950000, null],
  ["  Rent", 1200000, null],
  ["  Salaries", 750000, null],
  ["Grand Total", 14750000, 14750000],
];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Trial Balance");
const out = path.resolve("src/lib/ingestion/__fixtures__/tally/tally-detailed-fy2025.xlsx");
fs.writeFileSync(out, Buffer.from(XLSX.write(wb, { type: "array", bookType: "xlsx" })));
console.log("wrote", out);
