import { describe, expect, it } from "vitest";
import { formatMinorAmount, presentAmount } from "./amounts";

describe("amount presentation", () => {
  it("shows zero as 0 / 0.00 — never a dash", () => {
    expect(presentAmount({ kind: "amount", minor: 0n, exponent: 0 })).toMatchObject({ text: "0", state: "zero" });
    expect(presentAmount({ kind: "amount", minor: 0n, exponent: 2 })).toMatchObject({ text: "0.00", state: "zero" });
    expect(presentAmount({ kind: "amount", minor: 0n, exponent: 2, decimals: 0 }).text).toBe("0");
  });
  it("shows missing as — with its reason, distinct from zero", () => {
    const m = presentAmount({ kind: "missing", reason: "not computed" });
    expect(m).toEqual({ text: "—", state: "missing", description: "Not available: not computed" });
    expect(m.text).not.toBe(presentAmount({ kind: "amount", minor: 0n, exponent: 2 }).text);
  });
  it("shows negatives in parentheses, grouped, exactly", () => {
    expect(formatMinorAmount(-123456n, 2)).toBe("(1,234.56)");
    expect(formatMinorAmount(118345670n, 2)).toBe("1,183,456.70");
    expect(formatMinorAmount(11235n, 3)).toBe("11.235");
    expect(formatMinorAmount(7n, 2)).toBe("0.07");
    expect(formatMinorAmount(9007199254740993n, 2)).toBe("90,071,992,547,409.93"); // beyond 2^53: exact (BigInt)
  });
  it("never rounds: dropping a non-zero digit is refused", () => {
    expect(formatMinorAmount(150000n, 2, 0)).toBe("1,500");
    expect(() => formatMinorAmount(150050n, 2, 0)).toThrow(/round/);
  });
  it("marks stale and reference-only figures explicitly", () => {
    expect(presentAmount({ kind: "stale", minor: 100n, exponent: 2, reason: "account 6000 changed" })).toMatchObject({ text: "1.00", state: "stale", description: "Stale: account 6000 changed" });
    expect(presentAmount({ kind: "reference", minor: -100n, exponent: 2 })).toMatchObject({ text: "(1.00)", state: "reference" });
  });
});
