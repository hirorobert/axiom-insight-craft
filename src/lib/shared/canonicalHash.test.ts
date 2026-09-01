import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, canonicalHash } from "./canonicalHash";

describe("canonicalJson", () => {
  it("object key order is canonicalized — different insertion order, same output", () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it("array order is preserved — NOT sorted, since order is semantically meaningful", () => {
    const a = canonicalJson([3, 1, 2]);
    const b = canonicalJson([1, 2, 3]);
    expect(a).not.toBe(b);
    expect(a).toBe("[3,1,2]");
  });

  it("nested structures canonicalize recursively", () => {
    const a = canonicalJson({ z: [{ y: 1, x: 2 }], a: "hi" });
    const b = canonicalJson({ a: "hi", z: [{ x: 2, y: 1 }] });
    expect(a).toBe(b);
  });

  it("rejects undefined rather than silently discarding it", () => {
    expect(() => canonicalJson(undefined)).toThrow(/undefined is not permitted/);
  });

  it("rejects undefined nested inside an object rather than dropping the key", () => {
    expect(() => canonicalJson({ a: 1, b: undefined as unknown as null })).toThrow(/undefined is not permitted/);
  });

  it("null is a legitimate, distinct value from undefined", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  it("booleans serialize literally", () => {
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
  });

  it("integers use a fixed, non-scientific-notation representation", () => {
    expect(canonicalJson(1000000)).toBe("1000000");
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-42)).toBe("-42");
  });

  it("does not hide accounting rounding inside canonicalization — same float in, same string out, no rounding applied", () => {
    expect(canonicalJson(1234.5)).toBe("1234.5");
    expect(canonicalJson(1234.567891)).toBe("1234.567891");
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => canonicalJson(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/);
  });

  it("-0 canonicalizes identically to 0 — explicit decision, not an accident", () => {
    expect(canonicalJson(-0)).toBe(canonicalJson(0));
    expect(canonicalJson(-0)).toBe("0");
  });

  it("Number.MAX_SAFE_INTEGER canonicalizes without scientific notation", () => {
    expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
  });

  it("a small realistic accounting decimal canonicalizes without scientific notation", () => {
    expect(canonicalJson(0.01)).toBe("0.01");
  });

  it("rejects a magnitude large enough that JS would render it in scientific notation", () => {
    // 1e21 is exactly the threshold where Number.prototype.toFixed falls
    // back to scientific notation per the ECMAScript spec.
    expect(() => canonicalJson(1e21)).toThrow(/canonical range/);
  });

  it("dates render as ISO 8601, distinct string content from a plain string", () => {
    const d = new Date("2026-09-01T00:00:00.000Z");
    expect(canonicalJson(d)).toBe('"2026-09-01T00:00:00.000Z"');
  });

  it("rejects an invalid Date", () => {
    expect(() => canonicalJson(new Date("not-a-date"))).toThrow(/invalid Date/);
  });

  it("strings are JSON-escaped normally", () => {
    expect(canonicalJson('he said "hi"')).toBe('"he said \\"hi\\""');
  });
});

describe("sha256Hex / canonicalHash", () => {
  it("is deterministic — same canonical input, same hash, across repeated calls", async () => {
    const h1 = await sha256Hex("abc");
    const h2 = await sha256Hex("abc");
    expect(h1).toBe(h2);
  });

  it("matches the known SHA-256 test vector for the empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("matches the known SHA-256 test vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("canonicalHash of key-reordered but semantically identical objects is identical", async () => {
    const h1 = await canonicalHash({ b: 1, a: 2 });
    const h2 = await canonicalHash({ a: 2, b: 1 });
    expect(h1).toBe(h2);
  });

  it("canonicalHash of genuinely different content differs", async () => {
    const h1 = await canonicalHash({ amount: 100 });
    const h2 = await canonicalHash({ amount: 100.01 });
    expect(h1).not.toBe(h2);
  });

  it("canonicalHash of reordered array content differs, since array order is meaningful", async () => {
    const h1 = await canonicalHash([1, 2, 3]);
    const h2 = await canonicalHash([3, 2, 1]);
    expect(h1).not.toBe(h2);
  });
});
