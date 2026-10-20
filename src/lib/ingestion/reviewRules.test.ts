import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";

// Phase 1 §3.6: review-only rules report applicability and outcome; none blocks or adjusts by itself. Invented data.
function read(rows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "TB");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
  return readTrialBalanceSource(bytes, { fileName: "synthetic.xlsx", periodYear: 2026, currency: "TZS" }, XLSX as unknown as XlsxLike);
}
const check = (r: ReturnType<typeof read>, id: string) => r.reviewChecks.find((c) => c.id === id);
const H = ["Account Code", "Account Name", "Debit", "Credit"];

describe("every rule reports applicability and outcome", () => {
  it("a clean file: duplicates and clearing pass; residual and unexpected-side say why they did not run; no issues", () => {
    const r = read([H, ["1000", "Cash at bank", 500, null], ["3000", "Capital", null, 500]]);
    expect(r.reviewChecks.map((c) => [c.id, c.outcome])).toEqual([
      ["duplicate_identities", "passed"], ["residual_balances", "not_run"], ["unexpected_side_balances", "not_run"],
      ["clearing_account_balances", "passed"], ["opening_and_movement_columns", "passed"],
    ]);
    for (const c of r.reviewChecks.filter((x) => x.outcome === "not_run")) expect(c.reason).toMatch(/\S/);
    expect(r.issues).toEqual([]);
  });
});

describe("duplicates", () => {
  it("the same description under different codes is not a duplicate", () => {
    const r = read([H, ["5001", "Service charges", 100, null], ["5002", "Service charges", 50, null], ["3000", "Capital", null, 150]]);
    expect(check(r, "duplicate_identities")?.outcome).toBe("passed");
    expect(r.blocking).toBe(false);
  });
  it("the same code with a different dimension is not a duplicate; the same code and dimension is", () => {
    const D = ["Account Code", "Account Name", "Cost Centre", "Debit", "Credit"];
    const split = read([D, ["5001", "Fuel", "North", 100, null], ["5001", "Fuel", "South", 50, null], ["3000", "Capital", "", null, 150]]);
    expect(check(split, "duplicate_identities")?.outcome).toBe("passed");
    const dup = read([D, ["5001", "Fuel", "North", 100, null], ["5001", "Fuel", "North", 50, null], ["3000", "Capital", "", null, 150]]);
    expect(check(dup, "duplicate_identities")).toMatchObject({ outcome: "blocked", rows: [2, 3] });
  });
});

describe("clearing, suspense and in-transit accounts", () => {
  it("a balance needs reconciliation evidence: review only, never blocking, amounts unchanged", () => {
    const r = read([H, ["1000", "Cash at bank", 400, null], ["1190", "Suspense account", 100, null], ["1195", "Cash in transit", null, 0], ["3000", "Capital", null, 500]]);
    expect(r.issues.map((i) => [i.code, i.severity, i.rows])).toEqual([["CLEARING_ACCOUNT_BALANCE", "review", [3]]]);
    expect(check(r, "clearing_account_balances")).toMatchObject({ outcome: "review", reason: "Needs reconciliation evidence.", rows: [3] });
    expect(r.blocking).toBe(false);
    expect(r.totals).toEqual({ debitMinor: 50000n, creditMinor: 50000n, differenceMinor: 0n });
  });
  it("one finding per account, each with the account's identity as its subject (each is explained on its own)", () => {
    const r = read([H, ["1190", "Suspense account", 100, null], ["1195", "Cash in transit", 50, null], ["3000", "Capital", null, 150]]);
    expect(r.issues.map((i) => [i.code, i.rows, i.subject, i.accountCode])).toEqual([
      ["CLEARING_ACCOUNT_BALANCE", [2], "code:1190", "1190"],
      ["CLEARING_ACCOUNT_BALANCE", [3], "code:1195", "1195"],
    ]);
    expect(r.blocking).toBe(false);
  });
});

describe("opening and movement content", () => {
  it("is a notice with evidence; nothing is combined and no closing balance is derived", () => {
    const r = read([["Account Code", "Account Name", "Debit", "Credit", "Opening note", "Movement note"], ["1000", "Cash at bank", 500, null, "b/f", "x"], ["3000", "Capital", null, 500, "", ""]]);
    expect(check(r, "opening_and_movement_columns")).toMatchObject({ outcome: "notice" });
    expect(check(r, "opening_and_movement_columns")?.reason).toMatch(/not combined/);
    expect(r.totals).toEqual({ debitMinor: 50000n, creditMinor: 50000n, differenceMinor: 0n });
    expect(r.blocking).toBe(false);
  });
});
