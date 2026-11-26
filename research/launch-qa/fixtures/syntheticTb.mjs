// Launch-acceptance QA — INVENTED synthetic fixtures. No customer data. Amounts are exact whole-number units (integer
// arithmetic; no float). Expected debit/credit totals are computed here, INDEPENDENTLY of the app under test, so a journey
// asserts against a figure the implementation did not produce.
//
// Columns match the uploader's supported shape (Account Code, Account Name, Debit, Credit). Distinct source rows and codes
// are preserved — never merged.

const HEADERS = ["Account Code", "Account Name", "Debit", "Credit"];

function toCsv(rows) {
  const line = (cells) => cells.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(",");
  return [line(HEADERS), ...rows.map((r) => line([r.code, r.name, r.debit || "", r.credit || ""]))].join("\n") + "\n";
}
export function totals(rows) {
  let debit = 0, credit = 0;
  for (const r of rows) { debit += Number(r.debit || 0); credit += Number(r.credit || 0); }
  return { debit, credit, difference: debit - credit, balanced: debit === credit };
}

// A balanced single-entity TB (debits 101,500,000 = credits 101,500,000). Distinct codes & names.
export const BALANCED_ROWS = [
  { code: "4000", name: "Revenue — product sales", credit: 60000000 },
  { code: "4100", name: "Revenue — service fees", credit: 18000000 },
  { code: "5000", name: "Cost of goods sold", debit: 32000000 },
  { code: "6000", name: "Salaries and wages", debit: 21000000 },
  { code: "6100", name: "Office rent", debit: 7500000 },
  { code: "1000", name: "Cash at bank", debit: 14000000 },
  { code: "1200", name: "Trade receivables", debit: 15000000 },
  { code: "1300", name: "Inventory", debit: 12000000 },
  { code: "2000", name: "Trade payables", credit: 9500000 },
  { code: "3000", name: "Share capital", credit: 14000000 },
];
// debits: 32+21+7.5+14+15+12 = 101.5M ; credits: 60+18+9.5+14 = 101.5M
export const BALANCED = { headers: HEADERS, rows: BALANCED_ROWS, csv: toCsv(BALANCED_ROWS), expected: totals(BALANCED_ROWS) };

// A genuinely IMBALANCED TB (debits 70,000,000 vs credits 100,000,000 → difference −30,000,000). The imbalance must stay
// VISIBLE — never silently plugged (scenario F).
export const IMBALANCED_ROWS = [
  { code: "4000", name: "Revenue — product sales", credit: 100000000 },
  { code: "5000", name: "Cost of goods sold", debit: 40000000 },
  { code: "1000", name: "Cash at bank", debit: 30000000 },
];
export const IMBALANCED = { headers: HEADERS, rows: IMBALANCED_ROWS, csv: toCsv(IMBALANCED_ROWS), expected: totals(IMBALANCED_ROWS) };

// Two accounts, SAME name, DIFFERENT codes (scenario G — only after NORMAL's constraint/lookup repair). Source identity
// preserved; distinct codes kept.
export const SAME_NAME_ROWS = [
  { code: "4000", name: "Sales", credit: 50000000 },
  { code: "4100", name: "Sales", credit: 10000000 },
  { code: "1000", name: "Cash at bank", debit: 60000000 },
];
export const SAME_NAME = { headers: HEADERS, rows: SAME_NAME_ROWS, csv: toCsv(SAME_NAME_ROWS), expected: totals(SAME_NAME_ROWS) };

// An UNSUPPORTED file (not a trial balance). NOTE: the OVER-LIMIT and the exact unsupported-type policy are NORMAL's to set
// (scenario F uses NORMAL's final policy/fixtures); this is only an obviously-not-a-TB sample for the refusal path.
export const UNSUPPORTED = { name: "not-a-trial-balance.txt", content: "This is a plain note, not a trial balance.\nNo columns, no accounts.\n" };
