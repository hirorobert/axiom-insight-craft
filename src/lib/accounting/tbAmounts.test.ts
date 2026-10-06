/**
 * The browser reader of "tb-amounts/1" (F1b) against the engine's copy (E1): same currency table, same verdict on every
 * document in the corpus (valid, each grammar break, each broken relationship), exact formatting at and beyond 2^53 and at
 * exponents 0, 2 and 3, and the absent / malformed / exact reading of a stored result.
 */
import { describe, expect, it } from "vitest";
import { formatMinorString, readRecordedAmounts, TB_CURRENCY_EXPONENTS, validateTbAmounts, type TbAmounts } from "./tbAmounts";
import { buildTbAmounts, validateTbAmounts as engineValidate } from "../../../supabase/functions/_shared/tbAmounts";
import { CURRENCY_EXPONENTS } from "../../../supabase/functions/_shared/tbIngestion";

const base = (): TbAmounts => buildTbAmounts({
  currency: "TZS", exponent: 2, debitTotalMinor: 190025n, creditTotalMinor: 190025n,
  accounts: [
    { classification: "current_assets", isCash: true, debitMinor: 150025n, creditMinor: 0n },
    { classification: "current_liabilities", isCash: true, debitMinor: 0n, creditMinor: 0n },
    { classification: "equity", isCash: false, debitMinor: 0n, creditMinor: 100000n },
    { classification: "revenue", isCash: false, debitMinor: 0n, creditMinor: 90025n },
    { classification: "operating_expenses", isCash: false, debitMinor: 40000n, creditMinor: 0n },
  ],
}) as TbAmounts;

type Doc = Record<string, unknown>;
const clone = (d: unknown) => JSON.parse(JSON.stringify(d)) as Doc;
const at = (d: Doc, path: string[], v: unknown) => { let o = d; for (const k of path.slice(0, -1)) o = o[k] as Doc; o[path.at(-1)!] = v; return d; };

// Each entry: a name and a mutation of a valid document that must make it malformed.
const BROKEN: [string, (d: Doc) => Doc][] = [
  ["contract", (d) => at(d, ["contract"], "tb-amounts/2")],
  ["unknown currency", (d) => at(d, ["currency"], "XXX")],
  ["exponent differs from the table", (d) => at(d, ["exponent"], 3)],
  ["missing key", (d) => { delete (d.cash as Doc).accounts; return d; }],
  ["unknown key", (d) => at(d, ["classes", "other_minor"], "0")],
  ["unknown top-level key", (d) => at(d, ["extra"], 1)],
  ["-0", (d) => at(d, ["equation", "difference_minor"], "-0")],
  ["leading zero", (d) => at(d, ["classes", "equity_minor"], "0100000")],
  ["plus sign", (d) => at(d, ["source", "debit_total_minor"], "+190025")],
  ["decimal point", (d) => at(d, ["classes", "assets_minor"], "1500.25")],
  ["a number, not a string", (d) => at(d, ["classes", "assets_minor"], 150025)],
  ["status disagrees with the difference", (d) => at(d, ["equation", "status"], "failed")],
  ["source difference not recomputed", (d) => at(d, ["source", "difference_minor"], "1")],
  ["lhs ≠ assets", (d) => at(d, ["equation", "lhs_minor"], "150026")],
  ["rhs ≠ L + E + I − X", (d) => at(d, ["equation", "rhs_minor"], "150024")],
  ["difference ≠ lhs − rhs", (d) => at(d, ["equation", "difference_minor"], "5")],
  ["net cash ≠ reported − overdraft", (d) => at(d, ["cash", "net_position_minor"], "1")],
  ["negative credit balances", (d) => at(d, ["cash", "credit_balances_minor"], "-1")],
  ["cash figures without cash accounts", (d) => at(d, ["cash", "accounts"], 0)],
  ["fractional account count", (d) => at(d, ["cash", "accounts"], 1.5)],
  ["reconciliation claimed", (d) => at(d, ["reconciliation", "status"], "passed")],
];

describe("tb-amounts/1 — browser reader equals the engine's", () => {
  it("uses the engine's currency table exactly", () => {
    expect(TB_CURRENCY_EXPONENTS).toEqual(CURRENCY_EXPONENTS);
  });
  it("accepts the engine's document, and both validators agree on it", () => {
    expect(validateTbAmounts(base()).ok).toBe(true);
    expect(engineValidate(base()).ok).toBe(true);
  });
  for (const [name, mutate] of BROKEN) {
    it(`malformed: ${name} (both validators refuse)`, () => {
      const doc = mutate(clone(base()));
      expect(validateTbAmounts(doc).ok).toBe(false);
      expect(engineValidate(doc).ok).toBe(false);
    });
  }
  it("a failed equation is a valid document when its figures are consistent (status failed, difference recomputed)", () => {
    const d = clone(base());
    at(d, ["classes", "assets_minor"], "150026"); at(d, ["equation", "lhs_minor"], "150026");
    at(d, ["equation", "difference_minor"], "1"); at(d, ["equation", "status"], "failed");
    expect(validateTbAmounts(d).ok).toBe(true);
    expect(engineValidate(d).ok).toBe(true);
  });
  it("values beyond 2^53 are validated exactly (BigInt), and a one-unit inconsistency there is caught", () => {
    const big = "90071992547409930"; // > 2^53, not representable exactly as a double
    const d = clone(base());
    for (const p of [["source", "debit_total_minor"], ["source", "credit_total_minor"]]) at(d, p, big);
    expect(validateTbAmounts(d).ok).toBe(true);
    at(d, ["source", "credit_total_minor"], "90071992547409931");
    expect(validateTbAmounts(d).ok).toBe(false); // the difference would be −1, recorded as 0
  });
});

describe("formatMinorString", () => {
  it("formats exactly at exponents 0, 2 and 3, with separators and sign", () => {
    expect(formatMinorString("0", 2)).toBe("0.00");
    expect(formatMinorString("-5", 2)).toBe("-0.05");
    expect(formatMinorString("123456", 2)).toBe("1,234.56");
    expect(formatMinorString("1235", 3)).toBe("1.235");
    expect(formatMinorString("-1234567", 0)).toBe("-1,234,567");
  });
  it("is exact beyond 2^53", () => {
    expect(formatMinorString("9007199254740993", 2)).toBe("90,071,992,547,409.93");
    expect(formatMinorString("-123456789012345678901234567890", 3)).toBe("-123,456,789,012,345,678,901,234,567.890");
  });
  it("refuses a value that is not a minor-unit string", () => {
    expect(() => formatMinorString("1.5", 2)).toThrow();
    expect(() => formatMinorString("-0", 2)).toThrow();
  });
});

describe("readRecordedAmounts", () => {
  it("absent: a legacy result without amounts", () => {
    expect(readRecordedAmounts({ status: "valid" })).toEqual({ state: "absent" });
    expect(readRecordedAmounts(null)).toEqual({ state: "absent" });
  });
  it("malformed: present but invalid (including null) — never read as absent or exact", () => {
    expect(readRecordedAmounts({ amounts: null }).state).toBe("malformed");
    expect(readRecordedAmounts({ amounts: at(clone(base()), ["equation", "status"], "failed") }).state).toBe("malformed");
  });
  it("exact: a valid document", () => {
    const r = readRecordedAmounts({ amounts: base() });
    expect(r.state).toBe("exact");
  });
});
