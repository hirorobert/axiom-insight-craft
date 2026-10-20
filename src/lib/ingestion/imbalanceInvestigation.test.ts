import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";
import { MAX_ROWS_PER_LEAD, investigateImbalance } from "../../../supabase/functions/_shared/tbInvestigation";

// Imbalance investigation (20261118100000): leads in the FILE, bounded, never a plug and never a claim about the ledger.
// Invented data only.
function read(rows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "TB");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
  return readTrialBalanceSource(bytes, { fileName: "synthetic.xlsx", periodYear: 2026, currency: "TZS" }, XLSX as unknown as XlsxLike);
}
const H = ["Account Code", "Account Name", "Debit", "Credit"];
const kinds = (r: ReturnType<typeof investigateImbalance>) => r?.leads.map((l) => [l.kind, l.rows]);

describe("investigateImbalance", () => {
  it("a balanced file has nothing to investigate", () => {
    expect(investigateImbalance(read([H, ["1000", "Bank", 500, null], ["3000", "Capital", null, 500]]))).toBeNull();
  });
  it("names the row whose amount equals the difference, and states the difference and the larger side", () => {
    const r = investigateImbalance(read([H, ["1000", "Bank", 500, null], ["1100", "Debtors", 120, null], ["3000", "Capital", null, 500]]));
    expect(r?.difference).toBe("120.00");
    expect(r?.larger).toBe("debits");
    expect(kinds(r)).toContainEqual(["amount_equals_difference", [3]]);
  });
  it("an amount entered on the wrong side: half the difference", () => {
    // Rent 75 posted as a credit instead of a debit: debits 500, credits 500 + 75 + 75 → difference 150.
    const r = investigateImbalance(read([H, ["1000", "Bank", 500, null], ["6000", "Rent", null, 75], ["3000", "Capital", null, 575]]));
    expect(r?.difference).toBe("150.00");
    expect(r?.larger).toBe("credits");
    expect(kinds(r)).toContainEqual(["amount_equals_half_difference", [3]]);
  });
  it("two transposed digits: a difference divisible by nine, and the row whose swap explains it", () => {
    // 1,234.00 typed as 1,324.00: a difference of 90.00 (9,000 minor units).
    const r = investigateImbalance(read([H, ["1000", "Bank", 1324, null], ["3000", "Capital", null, 1234]]));
    expect(r?.difference).toBe("90.00");
    // Either figure may be the mistyped one: swapping 1,324 → 1,234 or 1,234 → 1,324 both explain it, so both rows are named.
    expect(r?.leads.find((l) => l.kind === "digit_transposition")?.rows).toEqual([2, 3]);
  });
  it("rows with amounts that were not read as accounts are a lead, and the rows named are bounded", () => {
    const unreadRows = Array.from({ length: 15 }, () => [null, null, 20, null]);
    const r = investigateImbalance(read([H, ["1000", "Bank", 500, null], ...unreadRows, ["3000", "Capital", null, 480]]));
    expect(r?.difference).toBe("20.00");
    const unread = r?.leads.find((l) => l.kind === "rows_with_amounts_not_read");
    expect(unread?.rows).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(unread?.rows.length).toBe(MAX_ROWS_PER_LEAD);
  });
  it("never proposes a figure to add, and never claims the ledger itself is unbalanced", () => {
    const r = investigateImbalance(read([H, ["1000", "Bank", 500, null], ["1100", "Debtors", 120, null], ["3000", "Capital", null, 500]]))!;
    const text = [r.statement, ...r.leads.map((l) => l.check)].join(" ");
    expect(text).not.toMatch(/\b(plug|suspense entry|post an adjustment|add an entry|journal to)\b/i);
    expect(text).not.toMatch(/ledger (is|was) (out of balance|unbalanced)/i);
    expect(r.statement).toMatch(/not conclusions/);
    expect(r.statement).toMatch(/do not show whether the ledger itself balances/);
  });
});
