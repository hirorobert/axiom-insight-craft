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
