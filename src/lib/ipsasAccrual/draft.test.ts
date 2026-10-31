import { describe, expect, it } from "vitest";
import { carrying, denominationWords, fromMinor, knownPresentation, sameDenomination, stableJson, toMinor } from "./draft";
import { afterFailure, afterReceipt, ipsasClient, refusalWords, UnknownOutcome } from "./ipsasClient";

describe("decimal ↔ minor units", () => {
  it("converts exactly, with thousands separators", () => {
    expect(toMinor("1,234.50", 2)).toBe("123450");
    expect(toMinor("0.05", 2)).toBe("5");
    expect(toMinor("12", 2)).toBe("1200");
    expect(toMinor("-10.5", 2)).toBe("-1050");
    expect(toMinor("0", 2)).toBe("0");
    expect(toMinor("000.10", 2)).toBe("10");
  });
  it("never coerces: extra decimals, text and blanks are not amounts", () => {
    for (const bad of ["", " ", "1.234", "abc", "1e5", "--1", "1.2.3", "TZS 10", "."]) expect(toMinor(bad, 2)).toBeNull();
  });
  it("formats back without loss", () => {
    for (const m of ["0", "5", "123450", "-1050", "99999999999999999999"]) expect(toMinor(fromMinor(m, 2), 2)).toBe(m);
    expect(fromMinor("123450", 2)).toBe("1,234.50");
    expect(fromMinor(null, 2)).toBe("");
    expect(fromMinor("not-minor", 2)).toBe("");
  });
  it("derives a carrying amount only from exact columns", () => {
    expect(carrying("2000000", "600000", "0")).toBe("1400000");
    expect(carrying("2000000", "", "0")).toBe("");
  });
  it("stableJson is independent of key order", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe("the server's denomination, not an assumed one (independent review of #229, finding 4)", () => {
  // [exponent, typed text, exact minor units, how those minor units read back]
  const FIXTURES: [number, string, string, string][] = [
    [0, "14,000", "14000", "14,000"],                    // JPY: 14,000 yen. Under the old assumed TZS/2 this was read as 140.00 (and typed 14,000 stored as 1,400,000)
    [0, "-250", "-250", "-250"], [0, "0", "0", "0"],
    [1, "12.5", "125", "12.5"],
    [2, "1,234.50", "123450", "1,234.50"], [2, "-0.05", "-5", "-0.05"], [2, "0", "0", "0.00"], [2, "12", "1200", "12.00"],
    [3, "14,000.000", "14000000", "14,000.000"],         // KWD / BHD / OMR
    [3, "12.345", "12345", "12.345"], [3, "-0.005", "-5", "-0.005"], [3, "0", "0", "0.000"], [3, "0.5", "500", "0.500"],
  ];
  it.each(FIXTURES)("exponent %i: %s is exactly %s minor units and reads back as %s", (exponent, typed, minor, readBack) => {
    expect(toMinor(typed, exponent)).toBe(minor);
    expect(fromMinor(minor, exponent)).toBe(readBack);
    expect(toMinor(fromMinor(minor, exponent), exponent)).toBe(minor);   // the round trip loses nothing
  });
  it("the same minor units read differently under different denominations, which is exactly why the server's must be used", () => {
    expect(fromMinor("14000", 0)).toBe("14,000");
    expect(fromMinor("14000", 2)).toBe("140.00");                       // the old page's reading of a JPY balance
    expect(toMinor("14,000", 0)).toBe("14000");
    expect(toMinor("14,000", 2)).toBe("1400000");                       // the old page's storage of a typed JPY amount
  });
  it("more decimals than the unit has is never rounded or truncated: it is not an amount", () => {
    expect(toMinor("14,000.5", 0)).toBeNull();
    expect(toMinor("1.234", 2)).toBeNull();
    expect(toMinor("1.2345", 3)).toBeNull();
    expect(toMinor("0.1", 0)).toBeNull();
  });
  it("magnitudes stay exact beyond the safe-integer range", () => {
    expect(toMinor("99,999,999,999,999,999.999", 3)).toBe("99999999999999999999");
    expect(fromMinor("99999999999999999999", 3)).toBe("99,999,999,999,999,999.999");
  });
  it("only the server's confirmed state counts: an ISO code with exponent 0-3", () => {
    expect(knownPresentation({ state: "known", currency: "JPY", exponent: 0 })).toEqual({ currency: "JPY", exponent: 0 });
    for (const bad of [null, undefined, { state: "unknown" }, { state: "unsupported", currency: "XTS", exponent: 4 }, { state: "known", currency: "jpy", exponent: 0 }, { state: "known", currency: "JPY", exponent: 4 }, { state: "known", currency: "JPY", exponent: "2" }, { state: "known", currency: "JPYY", exponent: 2 }, {}]) {
      expect(knownPresentation(bad as never)).toBeNull();
    }
  });
  it("two denominations are the same only when currency and exponent both match; the words state the units", () => {
    expect(sameDenomination({ currency: "TZS", exponent: 2 }, { currency: "TZS", exponent: 2 })).toBe(true);
    expect(sameDenomination({ currency: "TZS", exponent: 2 }, { currency: "TZS", exponent: 0 })).toBe(false);
    expect(sameDenomination({ currency: "TZS", exponent: 2 }, { currency: "USD", exponent: 2 })).toBe(false);
    expect(sameDenomination(null, { currency: "TZS", exponent: 2 })).toBe(false);
    expect(denominationWords({ currency: "JPY", exponent: 0 })).toBe("JPY (whole units, no decimals)");
    expect(denominationWords({ currency: "BHD", exponent: 3 })).toBe("BHD (3 decimal places)");
    expect(denominationWords({ currency: "XXX", exponent: 1 })).toBe("XXX (1 decimal place)");
  });
});

describe("save outcomes are never merged", () => {
  const rid = "11111111-1111-4111-8111-111111111111";
  it("a recorded receipt is saved; a replay is marked; a refusal is refused; a lost answer is unknown with the SAME identity", () => {
    expect(afterReceipt(rid, { outcome: "recorded", revisionId: "22222222-2222-4222-8222-222222222222" })).toMatchObject({ kind: "saved", replay: false });
    expect(afterReceipt(rid, { outcome: "recorded", revisionId: "22222222-2222-4222-8222-222222222222", replay: true })).toMatchObject({ kind: "saved", replay: true });
    expect(afterReceipt(rid, { outcome: "stale" })).toEqual({ kind: "refused", outcome: "stale" });
    expect(afterReceipt(rid, { outcome: "recorded" })).toEqual({ kind: "refused", outcome: "recorded" }); // a "success" with no receipt id is not a save
    expect(afterFailure(rid)).toEqual({ kind: "unknown", requestId: rid });
  });
  it("every named refusal has plain words and none claims a save", () => {
    for (const o of ["stale", "request_reused", "forbidden", "feature_disabled", "framework_not_ipsas_accrual", "invalid_request", "source_mismatch", "not_confirmable", "unknown_subject"]) expect(refusalWords(o)).toMatch(/\w{4}/);
    expect(refusalWords("stale")).toContain("kept");
  });
});

describe("client treats a transport failure or an unreadable answer as UNKNOWN", () => {
  const fail = ipsasClient({ rpc: async () => ({ data: null, error: { message: "network" } }) } as never);
  const junk = ipsasClient({ rpc: async () => ({ data: { surprise: true }, error: null }) } as never);
  it("transport error", async () => { await expect(fail.save("c", 2026, "ppe_workpaper", {}, null, "r")).rejects.toBeInstanceOf(UnknownOutcome); });
  it("malformed success", async () => {
    await expect(junk.save("c", 2026, "ppe_workpaper", {}, null, "r")).rejects.toBeInstanceOf(UnknownOutcome);
    await expect(junk.context("c", 2026)).rejects.toBeInstanceOf(UnknownOutcome);
  });
  it("a named refusal of the context is a refusal, not an error", async () => {
    const c = ipsasClient({ rpc: async () => ({ data: { outcome: "forbidden" }, error: null }) } as never);
    await expect(c.context("c", 2026)).resolves.toEqual({ outcome: "forbidden" });
  });
});
