import { describe, expect, it } from "vitest";
import { carrying, fromMinor, stableJson, toMinor } from "./draft";
import { afterFailure, afterReceipt, ipsasClient, refusalWords, UnknownOutcome } from "./ipsasClient";

describe("decimal ↔ minor units", () => {
  it("converts exactly, with thousands separators", () => {
    expect(toMinor("1,234.50")).toBe("123450");
    expect(toMinor("0.05")).toBe("5");
    expect(toMinor("12")).toBe("1200");
    expect(toMinor("-10.5")).toBe("-1050");
    expect(toMinor("0")).toBe("0");
    expect(toMinor("000.10")).toBe("10");
  });
  it("never coerces: extra decimals, text and blanks are not amounts", () => {
    for (const bad of ["", " ", "1.234", "abc", "1e5", "--1", "1.2.3", "TZS 10", "."]) expect(toMinor(bad)).toBeNull();
  });
  it("formats back without loss", () => {
    for (const m of ["0", "5", "123450", "-1050", "99999999999999999999"]) expect(toMinor(fromMinor(m))).toBe(m);
    expect(fromMinor("123450")).toBe("1,234.50");
    expect(fromMinor(null)).toBe("");
    expect(fromMinor("not-minor")).toBe("");
  });
  it("derives a carrying amount only from exact columns", () => {
    expect(carrying("2000000", "600000", "0")).toBe("1400000");
    expect(carrying("2000000", "", "0")).toBe("");
  });
  it("stableJson is independent of key order", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 2 }, b: 1 }));
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
