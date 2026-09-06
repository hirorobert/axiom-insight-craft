/**
 * Ω2-GR1 — Money-authority exactness repair (BLOCKER-1).
 *
 * Tests the ACTUAL Edge Function copy (supabase/functions/_shared/payments/
 * money.ts) directly — it has no Deno-only imports, so it is safe to import
 * from a Vitest test exactly like certifiedTbSource.test.ts and
 * normalizeAccountName.test.ts already do for other _shared modules. This
 * is deliberate: the Codex-demonstrated defect (USD "1.239" silently
 * truncating to 123 minor units instead of being rejected) lived in THIS
 * file, not the frontend mirror — so the fix must be proven against the
 * exact file that runs in production, not only its frontend twin.
 *
 * Exact truth table per the Ω2-GR1 mission (zero tolerance for truncation):
 *   USD (exponent 2): 1->100, 1.2->120, 1.23->123, 1.230->123 (extra digit
 *     is zero), 1.239->INVALID, 1.231->INVALID, 0.001->INVALID,
 *     -1.23->INVALID.
 *   TZS (exponent 0): 1000->1000, 1000.0->1000, 1000.00->1000 (extra
 *     digits are zero), 1000.1->INVALID, 1000.01->INVALID.
 */

import { describe, it, expect } from "vitest";
import {
  moneyFromProviderDecimal,
  parseCurrencyExponent,
  SUPPORTED_CURRENCIES,
} from "../../../../../supabase/functions/_shared/payments/money";

describe("edge function moneyFromProviderDecimal — USD exactness truth table", () => {
  it("1 -> 100 VALID", () => {
    expect(moneyFromProviderDecimal("1", "USD")).toBe(100n);
  });
  it("1.2 -> 120 VALID", () => {
    expect(moneyFromProviderDecimal("1.2", "USD")).toBe(120n);
  });
  it("1.23 -> 123 VALID", () => {
    expect(moneyFromProviderDecimal("1.23", "USD")).toBe(123n);
  });
  it("1.230 -> 123 VALID (extra digit is exactly zero)", () => {
    expect(moneyFromProviderDecimal("1.230", "USD")).toBe(123n);
  });
  it("1.239 -> INVALID (non-zero excess precision, ZERO truncation)", () => {
    expect(moneyFromProviderDecimal("1.239", "USD")).toBeNull();
  });
  it("1.231 -> INVALID (non-zero excess precision)", () => {
    expect(moneyFromProviderDecimal("1.231", "USD")).toBeNull();
  });
  it("0.001 -> INVALID (non-zero excess precision)", () => {
    expect(moneyFromProviderDecimal("0.001", "USD")).toBeNull();
  });
  it("-1.23 -> INVALID (negative amounts are rejected)", () => {
    expect(moneyFromProviderDecimal("-1.23", "USD")).toBeNull();
  });
  it("999999999999.99 -> VALID, exact, no float precision loss", () => {
    expect(moneyFromProviderDecimal("999999999999.99", "USD")).toBe(99999999999999n);
  });
});

describe("edge function moneyFromProviderDecimal — TZS exactness truth table (exponent 0)", () => {
  it("1000 -> 1000 VALID", () => {
    expect(moneyFromProviderDecimal("1000", "TZS")).toBe(1000n);
  });
  it("1000.0 -> 1000 VALID (fractional digit is zero)", () => {
    expect(moneyFromProviderDecimal("1000.0", "TZS")).toBe(1000n);
  });
  it("1000.00 -> 1000 VALID (fractional digits are zero)", () => {
    expect(moneyFromProviderDecimal("1000.00", "TZS")).toBe(1000n);
  });
  it("1000.1 -> INVALID", () => {
    expect(moneyFromProviderDecimal("1000.1", "TZS")).toBeNull();
  });
  it("1000.01 -> INVALID", () => {
    expect(moneyFromProviderDecimal("1000.01", "TZS")).toBeNull();
  });
});

describe("edge function moneyFromProviderDecimal — hostile inputs", () => {
  it("rejects NaN", () => {
    expect(moneyFromProviderDecimal("NaN", "USD")).toBeNull();
  });
  it("rejects Infinity", () => {
    expect(moneyFromProviderDecimal("Infinity", "USD")).toBeNull();
  });
  it("rejects -Infinity", () => {
    expect(moneyFromProviderDecimal("-Infinity", "USD")).toBeNull();
  });
  it("rejects scientific notation (explicit contract: never authoritative)", () => {
    expect(moneyFromProviderDecimal("1e3", "USD")).toBeNull();
    expect(moneyFromProviderDecimal("1.5e2", "USD")).toBeNull();
  });
  it("rejects empty string", () => {
    expect(moneyFromProviderDecimal("", "USD")).toBeNull();
  });
  it("rejects whitespace-only string", () => {
    expect(moneyFromProviderDecimal("   ", "USD")).toBeNull();
  });
  it("rejects garbage / non-numeric string", () => {
    expect(moneyFromProviderDecimal("abc", "USD")).toBeNull();
  });
  it("rejects malformed decimal with two dots", () => {
    expect(moneyFromProviderDecimal("1.2.3", "USD")).toBeNull();
  });
  it("rejects a bare decimal point with no leading digit", () => {
    expect(moneyFromProviderDecimal(".5", "USD")).toBeNull();
  });
  it("accepts thousands separators before validation (e.g. \"1,234.56\")", () => {
    expect(moneyFromProviderDecimal("1,234.56", "USD")).toBe(123456n);
  });
  it("rejects an unsupported currency — fails closed, never defaults to exponent 2", () => {
    expect(moneyFromProviderDecimal("1.23", "XYZ")).toBeNull();
  });
});

describe("edge function parseCurrencyExponent — fail closed", () => {
  it("returns the declared exponent for every supported currency", () => {
    for (const [code, exponent] of Object.entries(SUPPORTED_CURRENCIES)) {
      expect(parseCurrencyExponent(code)).toBe(exponent);
    }
  });
  it("returns null (never a silent default of 2) for an unsupported currency", () => {
    expect(parseCurrencyExponent("XYZ")).toBeNull();
    expect(parseCurrencyExponent("")).toBeNull();
  });
});
