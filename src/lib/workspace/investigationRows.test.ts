/** The stored-rows read (strict) and exact minor-unit formatting. Invented data only. */
import { describe, expect, it, vi } from "vitest";
import { fetchInvestigationRows, formatMinor } from "./investigationRows";

const row = (extra: Record<string, unknown> = {}) => ({ ordinal: 1, row_number: 3, included: true, disposition: "account", account_code: "1000",
  account_name: "Bank", debit_minor: "150025", credit_minor: null, reason: null, ...extra });

describe("fetchInvestigationRows", () => {
  it("sends the keyset page request and reads a page strictly", async () => {
    const rpc = vi.fn(async () => ({ data: { outcome: "ok", rows: [row()], next_after: 1, total: 4 }, error: null }));
    expect(await fetchInvestigationRows(rpc, "inv", "included", 0, 1)).toEqual({ kind: "ok", total: 4, nextAfter: 1,
      rows: [{ ordinal: 1, rowNumber: 3, included: true, disposition: "account", accountCode: "1000", accountName: "Bank", debitMinor: "150025", creditMinor: null, reason: null }] });
    expect(rpc).toHaveBeenCalledWith("get_tb_investigation_rows", { p_investigation_id: "inv", p_filter: "included", p_after: 0, p_limit: 1 });
  });
  it("a refusal is named; a non-integer amount, a missing field, more rows than asked or a transport error is unavailable", async () => {
    expect(await fetchInvestigationRows(async () => ({ data: { outcome: "refused", code: "NOT_COMPLETED" }, error: null }), "i", "all", 0)).toEqual({ kind: "refused", code: "NOT_COMPLETED" });
    for (const bad of [row({ debit_minor: "1500.25" }), row({ debit_minor: 1500 }), row({ included: "yes" }), (({ reason: _r, ...r }) => r)(row())]) {
      expect(await fetchInvestigationRows(async () => ({ data: { outcome: "ok", rows: [bad], next_after: null, total: 1 }, error: null }), "i", "all", 0)).toEqual({ kind: "unavailable" });
    }
    expect(await fetchInvestigationRows(async () => ({ data: { outcome: "ok", rows: [row(), row({ ordinal: 2 })], next_after: null, total: 2 }, error: null }), "i", "all", 0, 1)).toEqual({ kind: "unavailable" });
    expect(await fetchInvestigationRows(async () => ({ data: null, error: { message: "down" } }), "i", "all", 0)).toEqual({ kind: "unavailable" });
  });
});

describe("formatMinor", () => {
  it("formats exact minor units without a float, at the currency's exponent", () => {
    expect(formatMinor("150025", 2)).toBe("1,500.25");
    expect(formatMinor("5", 2)).toBe("0.05");
    expect(formatMinor("-12000", 2)).toBe("-120.00");
    expect(formatMinor("123456789012345678", 2)).toBe("1,234,567,890,123,456.78");
    expect(formatMinor("1500", 0)).toBe("1,500");
    expect(formatMinor(null, 2)).toBe("");
  });
});
