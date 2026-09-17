import { describe, expect, it } from "vitest";
import {
  absoluteDifference,
  addMoney,
  compareMoney,
  equalsMoney,
  equalsWithinTolerance,
  formatMoney,
  isValidCurrencyCode,
  isZeroMoney,
  money,
  moneyFromDecimalString,
  MoneyDenominationMismatchError,
  negateMoney,
  sameDenomination,
  subtractMoney,
  sumMoney,
  ZERO_TOLERANCE,
  type Money,
} from "./money";

describe("isValidCurrencyCode", () => {
  it("accepts exactly three uppercase letters", () => {
    expect(isValidCurrencyCode("TZS")).toBe(true);
    expect(isValidCurrencyCode("USD")).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isValidCurrencyCode("tzs")).toBe(false);
    expect(isValidCurrencyCode("TZ")).toBe(false);
    expect(isValidCurrencyCode("TZSS")).toBe(false);
    expect(isValidCurrencyCode("")).toBe(false);
  });
});

describe("money() construction", () => {
  it("rejects an invalid currency code", () => {
    expect(() => money("tzs", 2, 100n)).toThrow(RangeError);
  });
  it("rejects a negative or non-integer scale", () => {
    expect(() => money("TZS", -1, 100n)).toThrow(RangeError);
    expect(() => money("TZS", 1.5, 100n)).toThrow(RangeError);
  });
});

describe("moneyFromDecimalString — never routes through a binary float", () => {
  it("parses a plain positive decimal exactly", () => {
    expect(moneyFromDecimalString("TZS", 2, "1234.56")).toEqual(money("TZS", 2, 123456n));
  });
  it("parses a negative decimal exactly", () => {
    expect(moneyFromDecimalString("TZS", 2, "-0.50")).toEqual(money("TZS", 2, -50n));
  });
  it("parses a whole number with no fractional part", () => {
    expect(moneyFromDecimalString("TZS", 2, "1000")).toEqual(money("TZS", 2, 100000n));
  });
  it("pads a shorter fractional part to the target scale", () => {
    expect(moneyFromDecimalString("TZS", 2, "1.5")).toEqual(money("TZS", 2, 150n));
  });
  it("refuses a value with more fractional digits than the scale allows, rather than truncating", () => {
    expect(() => moneyFromDecimalString("TZS", 2, "1.005")).toThrow(RangeError);
  });
  it("rejects a non-decimal string", () => {
    expect(() => moneyFromDecimalString("TZS", 2, "abc")).toThrow(RangeError);
    expect(() => moneyFromDecimalString("TZS", 2, "1.2.3")).toThrow(RangeError);
  });
  it("a famous floating-point trap (0.1 + 0.2) is exact here", () => {
    const a = moneyFromDecimalString("TZS", 2, "0.10");
    const b = moneyFromDecimalString("TZS", 2, "0.20");
    expect(addMoney(a, b)).toEqual(moneyFromDecimalString("TZS", 2, "0.30"));
  });
});

describe("denomination safety", () => {
  const tzs = money("TZS", 2, 100n);
  const usd = money("USD", 2, 100n);
  const tzsScale0 = money("TZS", 0, 100n);

  it("sameDenomination is true only for matching currency and scale", () => {
    expect(sameDenomination(tzs, money("TZS", 2, 999n))).toBe(true);
    expect(sameDenomination(tzs, usd)).toBe(false);
    expect(sameDenomination(tzs, tzsScale0)).toBe(false);
  });

  it("addMoney/subtractMoney/compareMoney/equalsWithinTolerance all refuse mixed denominations", () => {
    expect(() => addMoney(tzs, usd)).toThrow(MoneyDenominationMismatchError);
    expect(() => subtractMoney(tzs, usd)).toThrow(MoneyDenominationMismatchError);
    expect(() => compareMoney(tzs, usd)).toThrow(MoneyDenominationMismatchError);
    expect(() => equalsWithinTolerance(tzs, usd, ZERO_TOLERANCE)).toThrow(MoneyDenominationMismatchError);
    expect(() => absoluteDifference(tzs, usd)).toThrow(MoneyDenominationMismatchError);
  });

  it("equalsMoney is false (not throwing) across denominations — a plain boolean predicate", () => {
    expect(equalsMoney(tzs, usd)).toBe(false);
  });
});

describe("arithmetic — negative and contra-account values", () => {
  it("addMoney handles a negative operand correctly", () => {
    const revenue = moneyFromDecimalString("TZS", 2, "5000000.00");
    const contraExpense = moneyFromDecimalString("TZS", 2, "-3500000.00");
    expect(addMoney(revenue, contraExpense)).toEqual(moneyFromDecimalString("TZS", 2, "1500000.00"));
  });
  it("negateMoney flips the sign exactly", () => {
    const a = moneyFromDecimalString("TZS", 2, "42.00");
    expect(negateMoney(a)).toEqual(moneyFromDecimalString("TZS", 2, "-42.00"));
    expect(negateMoney(negateMoney(a))).toEqual(a);
  });
  it("subtractMoney can produce a negative result", () => {
    const a = moneyFromDecimalString("TZS", 2, "100.00");
    const b = moneyFromDecimalString("TZS", 2, "150.00");
    expect(subtractMoney(a, b)).toEqual(moneyFromDecimalString("TZS", 2, "-50.00"));
  });
});

describe("zero vs missing", () => {
  it("a Money of minorUnits 0n is a genuine zero, not a missing value — isZeroMoney is true", () => {
    const zero = money("TZS", 2, 0n);
    expect(isZeroMoney(zero)).toBe(true);
    expect(zero).not.toBeNull();
  });
  it("this module never produces null — missing is represented one level up (MonetaryFact.value: null), never as a Money", () => {
    expect(moneyFromDecimalString("TZS", 2, "0.00")).not.toBeNull();
  });
});

describe("sumMoney", () => {
  it("returns null for an empty list — an empty sum has no denomination to report", () => {
    expect(sumMoney([])).toBeNull();
  });
  it("sums a non-empty list exactly", () => {
    const values = ["100.00", "200.00", "-50.00"].map((s) => moneyFromDecimalString("TZS", 2, s));
    expect(sumMoney(values)).toEqual(moneyFromDecimalString("TZS", 2, "250.00"));
  });
  it("refuses to sum mixed denominations", () => {
    expect(() => sumMoney([money("TZS", 2, 1n), money("USD", 2, 1n)])).toThrow(MoneyDenominationMismatchError);
  });
});

describe("compareMoney / equalsMoney", () => {
  it("orders correctly including negative values", () => {
    expect(compareMoney(money("TZS", 2, -100n), money("TZS", 2, 100n))).toBe("LESS_THAN");
    expect(compareMoney(money("TZS", 2, 100n), money("TZS", 2, -100n))).toBe("GREATER_THAN");
    expect(compareMoney(money("TZS", 2, 5n), money("TZS", 2, 5n))).toBe("EQUAL");
  });
});

describe("rounding tolerances", () => {
  const a = money("TZS", 2, 10000n);
  it("exact equality requires zero tolerance to distinguish from a near match", () => {
    const b = money("TZS", 2, 10001n);
    expect(equalsWithinTolerance(a, b, ZERO_TOLERANCE)).toBe(false);
    expect(equalsWithinTolerance(a, b, { absoluteMinorUnits: 1n })).toBe(true);
  });
  it("tolerance is symmetric regardless of which side is larger", () => {
    const b = money("TZS", 2, 9999n);
    expect(equalsWithinTolerance(a, b, { absoluteMinorUnits: 1n })).toBe(true);
    expect(equalsWithinTolerance(b, a, { absoluteMinorUnits: 1n })).toBe(true);
  });
  it("a difference beyond tolerance is not accepted", () => {
    const b = money("TZS", 2, 10100n);
    expect(equalsWithinTolerance(a, b, { absoluteMinorUnits: 1n })).toBe(false);
  });
});

describe("formatMoney", () => {
  it("renders positive, negative, zero, and sub-unit values exactly", () => {
    expect(formatMoney(money("TZS", 2, 123456n))).toBe("1234.56");
    expect(formatMoney(money("TZS", 2, -123456n))).toBe("-1234.56");
    expect(formatMoney(money("TZS", 2, 0n))).toBe("0.00");
    expect(formatMoney(money("TZS", 2, 5n))).toBe("0.05");
    expect(formatMoney(money("TZS", 2, -5n))).toBe("-0.05");
  });
  it("round-trips through moneyFromDecimalString", () => {
    for (const s of ["1234.56", "-1234.56", "0.00", "0.01", "-0.01", "999999999999.99"]) {
      expect(formatMoney(moneyFromDecimalString("TZS", 2, s))).toBe(s);
    }
  });
});

// ── Property tests for arithmetic invariants ────────────────────────────
// No fast-check dependency is installed in this repo; a small seeded PRNG
// gives the same reproducibility (a fixed seed always generates the same
// case sequence) without adding a new dependency.

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMinorUnits(rand: () => number): bigint {
  const magnitude = BigInt(Math.floor(rand() * 1_000_000_000));
  return rand() < 0.5 ? -magnitude : magnitude;
}

describe("property tests — arithmetic invariants (seeded, 500 cases each)", () => {
  const rand = mulberry32(20260916);
  const CASES = 500;

  it("addition is commutative: a + b = b + a", () => {
    for (let i = 0; i < CASES; i++) {
      const a = money("TZS", 2, randomMinorUnits(rand));
      const b = money("TZS", 2, randomMinorUnits(rand));
      expect(addMoney(a, b)).toEqual(addMoney(b, a));
    }
  });

  it("addition is associative: (a + b) + c = a + (b + c)", () => {
    for (let i = 0; i < CASES; i++) {
      const a = money("TZS", 2, randomMinorUnits(rand));
      const b = money("TZS", 2, randomMinorUnits(rand));
      const c = money("TZS", 2, randomMinorUnits(rand));
      expect(addMoney(addMoney(a, b), c)).toEqual(addMoney(a, addMoney(b, c)));
    }
  });

  it("zero is the additive identity", () => {
    const zero = money("TZS", 2, 0n);
    for (let i = 0; i < CASES; i++) {
      const a = money("TZS", 2, randomMinorUnits(rand));
      expect(addMoney(a, zero)).toEqual(a);
    }
  });

  it("negation is its own inverse: -(-a) = a, and a + (-a) = 0", () => {
    for (let i = 0; i < CASES; i++) {
      const a = money("TZS", 2, randomMinorUnits(rand));
      expect(negateMoney(negateMoney(a))).toEqual(a);
      expect(addMoney(a, negateMoney(a))).toEqual(money("TZS", 2, 0n));
    }
  });

  it("subtraction is addition of the negation: a - b = a + (-b)", () => {
    for (let i = 0; i < CASES; i++) {
      const a = money("TZS", 2, randomMinorUnits(rand));
      const b = money("TZS", 2, randomMinorUnits(rand));
      expect(subtractMoney(a, b)).toEqual(addMoney(a, negateMoney(b)));
    }
  });

  it("equalsMoney agrees with compareMoney's EQUAL", () => {
    for (let i = 0; i < CASES; i++) {
      const a = money("TZS", 2, randomMinorUnits(rand));
      const b: Money = rand() < 0.5 ? a : money("TZS", 2, randomMinorUnits(rand));
      expect(equalsMoney(a, b)).toBe(compareMoney(a, b) === "EQUAL");
    }
  });
});
