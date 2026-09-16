import { describe, expect, it } from "vitest";
import { canonicalStringify, hashDeterministic, withoutCreatedAt } from "./serialization";

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
});

describe("hashDeterministic", () => {
  it("is a pure function of its input — same input, same output, every time", () => {
    const input = canonicalStringify({ rulePackId: "x", ruleId: "y", discriminator: "z" });
    const first = hashDeterministic(input);
    for (let i = 0; i < 20; i++) {
      expect(hashDeterministic(input)).toBe(first);
    }
  });

  it("produces different hashes for different inputs (no trivial collisions in these cases)", () => {
    const hashes = new Set(["a", "b", "aa", "ab", "ba", ""].map(hashDeterministic));
    expect(hashes.size).toBe(6);
  });

  it("returns a fixed-width lowercase hex string", () => {
    expect(hashDeterministic("anything")).toMatch(/^[0-9a-f]{16}$/);
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
