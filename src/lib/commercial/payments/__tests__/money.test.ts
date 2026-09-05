/**
 * Ω2 Test Matrix — Section 1: Integer Money
 * Iron Dome: no floats as authority; TZS exponent=0; bigint throughout.
 */

import { describe, it, expect } from "vitest";
import {
  moneyFromMinorUnits,
  moneyFromProviderDecimal,
  moneyToDisplay,
  moneyEquals,
  moneyMatchesExpected,
  CURRENCY_EXPONENTS,
} from "../money";

describe("CURRENCY_EXPONENTS", () => {
  it("TZS exponent is 0 — 1 TZS = 1 minor unit", () => {
    expect(CURRENCY_EXPONENTS["TZS"]).toBe(0);
  });
  it("USD exponent is 2", () => {
    expect(CURRENCY_EXPONENTS["USD"]).toBe(2);
  });
});

describe("moneyFromMinorUnits", () => {
  it("accepts bigint for TZS", () => {
    const r = moneyFromMinorUnits(450_000n, "TZS");
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.money.amountMinor).toBe(450_000n);
      expect(r.money.currencyCode).toBe("TZS");
      expect(r.money.exponent).toBe(0);
    }
  });
  it("accepts number and converts to bigint", () => {
    const r = moneyFromMinorUnits(450000, "TZS");
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.money.amountMinor).toBe(450_000n);
  });
  it("rejects negative amount", () => {
    const r = moneyFromMinorUnits(-1n, "TZS");
    expect(r.valid).toBe(false);
  });
  it("rejects unknown currency", () => {
    const r = moneyFromMinorUnits(100n, "ZZZ");
    expect(r.valid).toBe(false);
  });
  it("rejects float (non-integer number)", () => {
    const r = moneyFromMinorUnits(1.5, "TZS");
    expect(r.valid).toBe(false);
  });

  // ── Ω2-G money authority repair: hostile inputs must return {valid:false},
  //    never throw. moneyFromMinorUnits() previously called BigInt(1.5)
  //    directly, which throws a RangeError before any validation could run —
  //    a real, previously-undetected defect. Every case below must resolve
  //    to a controlled invalid result with zero thrown exceptions.

  it("does not throw for any hostile input (1.5, NaN, Infinity, -Infinity, unsafe integer)", () => {
    const hostileInputs = [1.5, -1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1];
    for (const input of hostileInputs) {
      expect(() => moneyFromMinorUnits(input, "TZS")).not.toThrow();
    }
  });

  it("rejects NaN", () => {
    expect(moneyFromMinorUnits(NaN, "TZS").valid).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(moneyFromMinorUnits(Infinity, "TZS").valid).toBe(false);
  });

  it("rejects -Infinity", () => {
    expect(moneyFromMinorUnits(-Infinity, "TZS").valid).toBe(false);
  });

  it("rejects an unsafe integer (beyond Number.isSafeInteger range)", () => {
    const r = moneyFromMinorUnits(Number.MAX_SAFE_INTEGER + 2, "TZS");
    expect(r.valid).toBe(false);
  });

  it("accepts the largest safe integer as a valid number input", () => {
    const r = moneyFromMinorUnits(Number.MAX_SAFE_INTEGER, "TZS");
    expect(r.valid).toBe(true);
  });

  it("rejects negative float without throwing", () => {
    expect(() => moneyFromMinorUnits(-1.5, "TZS")).not.toThrow();
    expect(moneyFromMinorUnits(-1.5, "TZS").valid).toBe(false);
  });

  it("bigint path remains exact for a very large in-domain value", () => {
    const large = 9223372036854775807n;
    const r = moneyFromMinorUnits(large, "TZS");
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.money.amountMinor).toBe(large);
  });

  it("rejects bigint overflow beyond BIGINT domain", () => {
    const tooLarge = 9223372036854775807n + 1n;
    const r = moneyFromMinorUnits(tooLarge, "TZS");
    expect(r.valid).toBe(false);
  });

  it("exact integer number within safe range for USD cents", () => {
    const r = moneyFromMinorUnits(49900, "USD");
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.money.amountMinor).toBe(49900n);
      expect(r.money.exponent).toBe(2);
    }
  });

  it("exact bigint path for TZS", () => {
    const r = moneyFromMinorUnits(450_000n, "TZS");
    expect(r.valid).toBe(true);
    if (r.valid) expect(typeof r.money.amountMinor).toBe("bigint");
  });

  it("supports GBP and EUR structurally — new currency needs no schema redesign", () => {
    expect(CURRENCY_EXPONENTS["GBP"]).toBe(2);
    expect(CURRENCY_EXPONENTS["EUR"]).toBe(2);
    const gbp = moneyFromMinorUnits(49900, "GBP");
    expect(gbp.valid).toBe(true);
    const eur = moneyFromMinorUnits(45000, "EUR");
    expect(eur.valid).toBe(true);
  });
});

describe("moneyFromProviderDecimal — TZS", () => {
  it("parses 450000 correctly", () => {
    const r = moneyFromProviderDecimal("450000", "TZS");
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.money.amountMinor).toBe(450_000n);
  });
  it("parses 450000.00 correctly (TZS — zero decimal permitted)", () => {
    const r = moneyFromProviderDecimal("450000.00", "TZS");
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.money.amountMinor).toBe(450_000n);
  });
  it("rejects 450000.50 for TZS (non-zero fractional part)", () => {
    const r = moneyFromProviderDecimal("450000.50", "TZS");
    expect(r.valid).toBe(false);
  });
  it("rejects empty string", () => {
    expect(moneyFromProviderDecimal("", "TZS").valid).toBe(false);
  });
  it("rejects non-numeric string", () => {
    expect(moneyFromProviderDecimal("abc", "TZS").valid).toBe(false);
  });
});

describe("moneyToDisplay", () => {
  it("formats TZS without decimal", () => {
    const r = moneyFromMinorUnits(450_000n, "TZS");
    if (!r.valid) throw new Error("setup failed");
    expect(moneyToDisplay(r.money)).toContain("450");
  });
});

describe("moneyEquals", () => {
  it("equal amounts return true", () => {
    const a = moneyFromMinorUnits(100n, "TZS");
    const b = moneyFromMinorUnits(100n, "TZS");
    if (!a.valid || !b.valid) throw new Error("setup failed");
    expect(moneyEquals(a.money, b.money)).toBe(true);
  });
  it("different amounts return false", () => {
    const a = moneyFromMinorUnits(100n, "TZS");
    const b = moneyFromMinorUnits(200n, "TZS");
    if (!a.valid || !b.valid) throw new Error("setup failed");
    expect(moneyEquals(a.money, b.money)).toBe(false);
  });
  it("different currencies return false", () => {
    const a = moneyFromMinorUnits(100n, "TZS");
    const b = moneyFromMinorUnits(100n, "USD");
    if (!a.valid || !b.valid) throw new Error("setup failed");
    expect(moneyEquals(a.money, b.money)).toBe(false);
  });
});

describe("moneyMatchesExpected", () => {
  it("matches when amount and currency align", () => {
    const expected = moneyFromMinorUnits(450_000n, "TZS");
    if (!expected.valid) throw new Error("setup failed");
    expect(moneyMatchesExpected(450_000n, "TZS", expected.money)).toBe(true);
  });
  it("does not match on tampered amount", () => {
    const expected = moneyFromMinorUnits(450_000n, "TZS");
    if (!expected.valid) throw new Error("setup failed");
    expect(moneyMatchesExpected(1n, "TZS", expected.money)).toBe(false);
  });
  it("does not match on currency mismatch", () => {
    const expected = moneyFromMinorUnits(450_000n, "TZS");
    if (!expected.valid) throw new Error("setup failed");
    expect(moneyMatchesExpected(450_000n, "USD", expected.money)).toBe(false);
  });
});
