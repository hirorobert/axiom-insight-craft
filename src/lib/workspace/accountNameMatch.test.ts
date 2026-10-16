/**
 * accountNameMatch.test.ts — the name fallback counts candidates (supabase/functions/_shared/accountNameMatch.ts,
 * repair B). Zero, one and several are distinct answers; several is never resolved by order. The database side
 * (coded accounts may share a name; codeless names stay unique) is proven by scripts/db-proof/accountIdentity.mjs.
 */
import { describe, expect, it } from "vitest";
import { editDistance, indexByName, matchByName, namesSharedInUpload } from "../../../supabase/functions/_shared/accountNameMatch";
import { normalizeAccountName } from "@/lib/normalizeAccountName";

type M = { id: string; code: string | null; name: string };
const idx = (rows: M[]) => indexByName(rows, (r) => r.name, normalizeAccountName);

describe("matchByName — zero, one, several", () => {
  it("no candidate: none", () => {
    expect(matchByName("sales", idx([{ id: "a", code: null, name: "Rent" }]))).toEqual({ kind: "none" });
    expect(matchByName("", idx([{ id: "a", code: null, name: "" }]))).toEqual({ kind: "none" });
  });

  it("exactly one exact candidate: one, not fuzzy", () => {
    const r = matchByName("sales", idx([{ id: "a", code: null, name: "Sales" }, { id: "b", code: null, name: "Rent" }]));
    expect(r).toEqual({ kind: "one", mapping: { id: "a", code: null, name: "Sales" }, fuzzy: false });
  });

  it("two candidates under one name are BOTH returned (no Map entry overwritten), in either input order", () => {
    const a = { id: "a", code: null, name: "Sales" }, b = { id: "b", code: null, name: "SALES." };
    for (const rows of [[a, b], [b, a]]) {
      const r = matchByName("sales", idx(rows));
      expect(r.kind).toBe("ambiguous");
      expect(r.kind === "ambiguous" && new Set(r.candidates.map((c) => c.id))).toEqual(new Set(["a", "b"]));
    }
  });

  it("normalisation collision: names distinct in the database (accented letters kept) collide here, and are ambiguous", () => {
    // The SQL normaliser keeps é and è; the JavaScript one drops both, so both stored names reach the same key.
    const r = matchByName(normalizeAccountName("Café sales"), idx([{ id: "e1", code: null, name: "café sales" }, { id: "e2", code: null, name: "cafè sales" }]));
    expect(normalizeAccountName("café sales")).toBe(normalizeAccountName("cafè sales"));
    expect(r.kind).toBe("ambiguous");
  });

  it("fuzzy: the single nearest within distance 2 is one; a tie at the nearest distance is ambiguous, never the first", () => {
    expect(matchByName("sales", idx([{ id: "a", code: null, name: "Saless" }]))).toMatchObject({ kind: "one", fuzzy: true });
    const tie = matchByName("sales", idx([{ id: "a", code: null, name: "Saled" }, { id: "b", code: null, name: "Salex" }]));
    expect(tie).toMatchObject({ kind: "ambiguous", fuzzy: true });
    // The nearer one wins outright (distance 1 over 2): that is one candidate, not a choice among equals.
    expect(matchByName("sales", idx([{ id: "near", code: null, name: "Saless" }, { id: "far", code: null, name: "Salesxx" }]))).toMatchObject({ kind: "one", mapping: { id: "near" } });
    expect(matchByName("sales", idx([{ id: "a", code: null, name: "Salesxxx" }]))).toEqual({ kind: "none" });
  });

  it("an exact candidate is never displaced by fuzzy ones", () => {
    expect(matchByName("sales", idx([{ id: "x", code: null, name: "Sales" }, { id: "y", code: null, name: "Saless" }]))).toMatchObject({ kind: "one", mapping: { id: "x" }, fuzzy: false });
  });

  it("editDistance is the Levenshtein distance", () => {
    expect([editDistance("", "ab"), editDistance("kitten", "sitting"), editDistance("sales", "sales")]).toEqual([2, 3, 0]);
  });
});

describe("namesSharedInUpload — a name carried by several accounts of one file", () => {
  it("finds same-name/different-code accounts (and only those)", () => {
    const s = namesSharedInUpload([
      { account_code: "4000", account_name: "Sales" }, { account_code: "4100", account_name: "sales" },
      { account_code: "5000", account_name: "Rent" },
    ], normalizeAccountName);
    expect([...s]).toEqual(["sales"]);
  });
});
