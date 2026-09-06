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

// Ω2-GR1 — Money-authority exactness repair (BLOCKER-1). Codex demonstrated
// that USD "1.239" silently truncated to 123 minor units instead of being
// rejected. ZERO tolerance for truncation/rounding of non-zero excess
// precision from here on — exact truth table below.
describe("moneyFromProviderDecimal — USD exactness truth table (Ω2-GR1)", () => {
  it("1 -> 100 VALID", () => {
    const r = moneyFromProviderDecimal("1", "USD");
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.money.amountMinor).toBe(100n);
  });
  it("1.2 -> 120 VALID", () => {
    const r = moneyFromProviderDecimal("1.2", "USD");
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.money.amountMinor).toBe(120n);
  });
  it("1.23 -> 123 VALID", () => {
    const r = moneyFromProviderDecimal("1.23", "USD");
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.money.amountMinor).toBe(123n);
  });
  it("1.230 -> 123 VALID (extra digit is exactly zero)", () => {
    const r = moneyFromProviderDecimal("1.230", "USD");
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.money.amountMinor).toBe(123n);
  });
  it("1.239 -> INVALID (non-zero excess precision — was silently truncated to 123 before this repair)", () => {
    expect(moneyFromProviderDecimal("1.239", "USD").valid).toBe(false);
  });
  it("1.231 -> INVALID (non-zero excess precision)", () => {
    expect(moneyFromProviderDecimal("1.231", "USD").valid).toBe(false);
  });
  it("0.001 -> INVALID (non-zero excess precision)", () => {
    expect(moneyFromProviderDecimal("0.001", "USD").valid).toBe(false);
  });
  it("-1.23 -> INVALID (negative amounts rejected)", () => {
    expect(moneyFromProviderDecimal("-1.23", "USD").valid).toBe(false);
  });
  it("999999999999.99 -> VALID, exact, no float precision loss", () => {
    const r = moneyFromProviderDecimal("999999999999.99", "USD");
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.money.amountMinor).toBe(99999999999999n);
  });
  it("rejects scientific notation (explicit contract: never authoritative)", () => {
    expect(moneyFromProviderDecimal("1e3", "USD").valid).toBe(false);
    expect(moneyFromProviderDecimal("1.5e2", "USD").valid).toBe(false);
  });
  it("rejects NaN / Infinity / -Infinity string forms", () => {
    expect(moneyFromProviderDecimal("NaN", "USD").valid).toBe(false);
    expect(moneyFromProviderDecimal("Infinity", "USD").valid).toBe(false);
    expect(moneyFromProviderDecimal("-Infinity", "USD").valid).toBe(false);
  });
  it("rejects malformed decimal with two dots", () => {
    expect(moneyFromProviderDecimal("1.2.3", "USD").valid).toBe(false);
  });
  it("rejects a bare decimal point with no leading digit", () => {
    expect(moneyFromProviderDecimal(".5", "USD").valid).toBe(false);
  });
  it("accepts thousands separators before validation", () => {
    const r = moneyFromProviderDecimal("1,234.56", "USD");
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.money.amountMinor).toBe(123456n);
  });
  it("rejects an unsupported currency", () => {
    expect(moneyFromProviderDecimal("1.23", "XYZ").valid).toBe(false);
  });
});

describe("moneyFromProviderDecimal — TZS exactness truth table (Ω2-GR1, exponent 0)", () => {
  it("1000 -> 1000 VALID", () => {
    const r = moneyFromProviderDecimal("1000", "TZS");
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.money.amountMinor).toBe(1000n);
  });
  it("1000.0 -> 1000 VALID (fractional digit is zero)", () => {
    const r = moneyFromProviderDecimal("1000.0", "TZS");
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.money.amountMinor).toBe(1000n);
  });
  it("1000.00 -> 1000 VALID (fractional digits are zero)", () => {
    const r = moneyFromProviderDecimal("1000.00", "TZS");
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.money.amountMinor).toBe(1000n);
  });
  it("1000.1 -> INVALID", () => {
    expect(moneyFromProviderDecimal("1000.1", "TZS").valid).toBe(false);
  });
  it("1000.01 -> INVALID", () => {
    expect(moneyFromProviderDecimal("1000.01", "TZS").valid).toBe(false);
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
