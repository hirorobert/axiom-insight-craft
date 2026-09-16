import { describe, expect, it } from "vitest";
import { canonicalStringify, sha256Hex, withoutCreatedAt } from "./serialization";

describe("canonicalStringify", () => {
  it("produces identical output regardless of key insertion order", () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { a: 2, c: { y: 2, z: 1 }, b: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("renders bigint exactly, distinguishable from a string of the same digits", () => {
    expect(canonicalStringify({ n: 123n })).toBe('{"n":{"__bigint__":"123"}}');
    expect(canonicalStringify({ n: 123n })).not.toBe(canonicalStringify({ n: "123" }));
  });

  it("is byte-identical across repeated calls on structurally-equal input", () => {
    const build = () => ({ x: [1, 2, { y: "z" }], w: 9007199254740993n });
    expect(canonicalStringify(build())).toBe(canonicalStringify(build()));
  });

  it("distinguishes structurally different values", () => {
    expect(canonicalStringify({ a: 1 })).not.toBe(canonicalStringify({ a: 2 }));
  });

  it("reordering array elements is NOT canonicalized — array order is preserved as meaningful", () => {
    expect(canonicalStringify([1, 2])).not.toBe(canonicalStringify([2, 1]));
  });
});

describe("sha256Hex — verified against the standard FIPS 180-4 / NIST test vectors", () => {
  it('sha256("") matches the known empty-string digest', () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it('sha256("abc") matches the canonical NIST test vector', () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it('sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") matches the two-block NIST test vector', () => {
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("handles multi-byte UTF-8 input deterministically (not byte length == character length)", () => {
    const emoji = sha256Hex("héllo 🌍");
    expect(emoji).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("héllo 🌍")).toBe(emoji);
  });

  it("is a pure function: identical input always produces identical output", () => {
    const input = canonicalStringify({ rulePackId: "x", ruleId: "y", discriminator: "z" });
    const first = sha256Hex(input);
    for (let i = 0; i < 20; i++) {
      expect(sha256Hex(input)).toBe(first);
    }
  });

  it("produces different hashes for different inputs (no trivial collisions in these cases)", () => {
    const hashes = new Set(["a", "b", "aa", "ab", "ba", ""].map(sha256Hex));
    expect(hashes.size).toBe(6);
  });

  it("returns a fixed-width, lowercase, 256-bit hex digest", () => {
    expect(sha256Hex("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles input crossing multiple 512-bit blocks", () => {
    const long = "x".repeat(1000);
    expect(sha256Hex(long)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(long)).toBe(sha256Hex(long));
  });
});

describe("withoutCreatedAt", () => {
  it("strips createdAt and leaves every other field untouched", () => {
    const value = { findingId: "f-1", outcome: "PASS" as const, createdAt: "2026-01-01T00:00:00.000Z" };
    const stripped = withoutCreatedAt(value);
    expect(stripped).toEqual({ findingId: "f-1", outcome: "PASS" });
    expect("createdAt" in stripped).toBe(false);
  });

  it("two objects differing only in createdAt become identical after stripping", () => {
    const a = { id: "1", createdAt: "2026-01-01T00:00:00.000Z" };
    const b = { id: "1", createdAt: "2099-12-31T23:59:59.999Z" };
    expect(canonicalStringify(withoutCreatedAt(a))).toBe(canonicalStringify(withoutCreatedAt(b)));
  });
});
