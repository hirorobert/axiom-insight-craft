import { describe, expect, it } from "vitest";
import { numberToMoneyExact, UnsafeMagnitudeError, UnsupportedPrecisionError } from "./moneyConversion";

describe("numberToMoneyExact", () => {
  it("converts a clean two-decimal amount exactly", () => {
    const m = numberToMoneyExact(1234.56, "TZS", 2);
    expect(m).toEqual({ currency: "TZS", scale: 2, minorUnits: 123456n });
  });

  it("converts a whole number at scale 0", () => {
    expect(numberToMoneyExact(42, "USD", 0)).toEqual({ currency: "USD", scale: 0, minorUnits: 42n });
  });

  it("converts a negative amount", () => {
    expect(numberToMoneyExact(-99.9, "TZS", 2)).toEqual({ currency: "TZS", scale: 2, minorUnits: -9990n });
  });

  it("absorbs genuine IEEE-754 representation drift (0.1 + 0.2 style noise)", () => {
    // 10.1 - 10 = 0.09999999999999964 in IEEE-754 — this must NOT be rejected.
    const drifted = 10.1 - 10 + 10;
    expect(() => numberToMoneyExact(drifted, "TZS", 2)).not.toThrow();
  });

  it("rejects genuine sub-scale precision rather than rounding", () => {
    expect(() => numberToMoneyExact(10.125, "TZS", 2)).toThrow(UnsupportedPrecisionError);
  });

  it("rejects non-finite input", () => {
    expect(() => numberToMoneyExact(NaN, "TZS", 2)).toThrow(RangeError);
    expect(() => numberToMoneyExact(Infinity, "TZS", 2)).toThrow(RangeError);
  });

  it("rejects a magnitude beyond the safe-integer range", () => {
    expect(() => numberToMoneyExact(Number.MAX_SAFE_INTEGER, "TZS", 2)).toThrow(UnsafeMagnitudeError);
  });

  it("is deterministic — same input always produces the same minorUnits", () => {
    const a = numberToMoneyExact(555555.55, "TZS", 2);
    const b = numberToMoneyExact(555555.55, "TZS", 2);
    expect(a).toEqual(b);
  });
});
