import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";
import { MAX_ROWS_PER_LEAD, investigateImbalance } from "../../../supabase/functions/_shared/tbInvestigation";

// Imbalance investigation (20261118100000): what the processing reader saw in the FILE — included and excluded rows with
// exact amounts, the reading compared with the file's printed totals, bounded leads — never a plug and never a claim
// about the ledger. Invented data only.
function read(rows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "TB");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
  return readTrialBalanceSource(bytes, { fileName: "synthetic.xlsx", periodYear: 2026, currency: "TZS" }, XLSX as unknown as XlsxLike);
}
const H = ["Account Code", "Account Name", "Debit", "Credit"];
const inv = (rows: unknown[][]) => investigateImbalance(read(rows));
const kinds = (r: ReturnType<typeof inv>) => r?.result.leads.map((l) => [l.kind, l.rows]);

describe("investigateImbalance", () => {
  it("a balanced file has nothing to investigate", () => {
    expect(inv([H, ["1000", "Bank", 500, null], ["3000", "Capital", null, 500]])).toBeNull();
  });
  it("names the row whose amount equals the difference, and states the difference, the larger side and the reading's totals", () => {
    const r = inv([H, ["1000", "Bank", 500, null], ["1100", "Debtors", 120, null], ["3000", "Capital", null, 500]]);
    expect(r?.result).toMatchObject({ difference: "120.00", larger: "debits", read: { debit: "620.00", credit: "500.00" }, cause: "no_printed_totals" });
    expect(kinds(r)).toContainEqual(["amount_equals_difference", [3]]);
  });
  it("an amount entered on the wrong side: half the difference", () => {
    const r = inv([H, ["1000", "Bank", 500, null], ["6000", "Rent", null, 75], ["3000", "Capital", null, 575]]);
    expect(r?.result.difference).toBe("150.00");
    expect(kinds(r)).toContainEqual(["amount_equals_half_difference", [3]]);
  });
  it("two transposed digits: both rows that could explain it are named", () => {
    const r = inv([H, ["1000", "Bank", 1324, null], ["3000", "Capital", null, 1234]]);
    expect(r?.result.difference).toBe("90.00");
    expect(r?.result.leads.find((l) => l.kind === "digit_transposition")?.rows).toEqual([2, 3]);
  });
  it("every row the reader saw is stored with its disposition and exact minor amounts; excluded rows say why", () => {
    const unreadRows = Array.from({ length: 15 }, () => [null, null, 20, null]);
    const r = inv([H, ["1000", "Bank", 500, null], ...unreadRows, ["3000", "Capital", null, 480]])!;
    expect(r.result.difference).toBe("20.00");
    expect(r.result.leads.find((l) => l.kind === "rows_with_amounts_not_read")?.rows.length).toBe(MAX_ROWS_PER_LEAD);
    expect(r.result.row_count).toBe(r.rows.length);
    expect(r.result.included_count).toBe(2);
    expect(r.result.excluded_count).toBe(r.rows.length - 2);
    const bank = r.rows.find((x) => x.row_number === 2)!;
    expect(bank).toMatchObject({ included: true, disposition: "account", account_code: "1000", debit_minor: "50000", credit_minor: "0" });
    const excluded = r.rows.find((x) => x.row_number === 3)!;
    expect(excluded).toMatchObject({ included: false, disposition: "rejected", debit_minor: "2000", reason: "amounts without an account code or name" });
    expect(r.rows.map((x) => x.ordinal)).toEqual(r.rows.map((_, i) => i + 1));
  });
  it("LAYOUT-CAUSED: the printed totals balance but the rows read do not add up to them — the reading differs (check excluded rows and the layout)", () => {
    // The report prints balanced totals; one amount row lost its account code in the export, so the reader excluded it.
    const r = inv([H, ["1000", "Bank", 500, null], [null, null, 120, null], ["3000", "Capital", null, 620], [null, "Total", 620, 620]])!;
    expect(r.result.cause).toBe("reading_differs_from_printed_totals");
    expect(r.result.printed).toEqual([{ row: 5, debit: "620.00", credit: "620.00" }]);
    expect(r.result.causeText).toMatch(/read differently/);
  });
  it("INCONSISTENT EXPORT: the file's own printed totals differ by the same amount and match the reading — the export itself does not balance", () => {
    const r = inv([H, ["1000", "Bank", 500, null], ["1100", "Debtors", 120, null], ["3000", "Capital", null, 500], [null, "Total", 620, 500]])!;
    expect(r.result.cause).toBe("export_totals_do_not_balance");
    expect(r.result.causeText).toMatch(/export itself does not balance/);
    expect(r.result.causeText).toMatch(/does not show whether the ledger itself balances/);
  });
  it("never proposes a figure to add, and never claims the ledger itself is unbalanced", () => {
    for (const rows of [
      [H, ["1000", "Bank", 500, null], ["1100", "Debtors", 120, null], ["3000", "Capital", null, 500]],
      [H, ["1000", "Bank", 500, null], ["1100", "Debtors", 120, null], ["3000", "Capital", null, 500], [null, "Total", 620, 500]],
    ]) {
      const r = inv(rows)!.result;
      const text = [r.statement, r.causeText, ...r.leads.map((l) => l.check)].join(" ");
      expect(text).not.toMatch(/\b(plug|suspense entry|post an adjustment|add an entry|journal to)\b/i);
      expect(text).not.toMatch(/ledger (is|was) (out of balance|unbalanced)/i);
      expect(r.statement).toMatch(/not conclusions/);
    }
  });
});
