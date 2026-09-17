import { describe, expect, it } from "vitest";
import { indexLatestFacts, resolveLatestFact } from "./provenance";
import { fact, CURRENT } from "./fixtures/builders";
import { money } from "./money";

const v1 = fact("f-1", "100.00", "TZS", 2, CURRENT);
const v2 = { ...fact("f-1", "150.00", "TZS", 2, CURRENT), version: 2, supersedesVersion: 1 };

describe("resolveLatestFact", () => {
  it("returns undefined for an unknown factId", () => {
    expect(resolveLatestFact([v1], "no-such-fact")).toBeUndefined();
  });
  it("returns the single version when only one exists", () => {
    expect(resolveLatestFact([v1], "f-1")).toEqual(v1);
  });
  it("returns the highest version, regardless of array order", () => {
    expect(resolveLatestFact([v2, v1], "f-1")).toEqual(v2);
    expect(resolveLatestFact([v1, v2], "f-1")).toEqual(v2);
  });
  it("never returns a superseded version once a later one exists", () => {
    const resolved = resolveLatestFact([v1, v2], "f-1");
    expect(resolved?.version).toBe(2);
    expect(resolved?.value).toEqual(money("TZS", 2, 15000n));
  });
});

describe("indexLatestFacts", () => {
  it("indexes every distinct factId to its own latest version", () => {
    const other = fact("f-2", "5.00", "TZS", 2, CURRENT);
    const index = indexLatestFacts([v1, v2, other]);
    expect(index.get("f-1")?.version).toBe(2);
    expect(index.get("f-2")?.version).toBe(1);
    expect(index.size).toBe(2);
  });
});
